import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { spawn } from "child_process";
import JSZip from "jszip";
import { rootDir } from "./store.js";
import { runProductDoctor } from "./doctor.js";
import { getLatestV1AcceptanceReport, v1AcceptanceRootDir } from "./workflowV1AcceptanceReport.js";
import { readWorkflowJob } from "./workflowJobs.js";

const latestRunPath = path.join(v1AcceptanceRootDir, "latest-run.json");
let activeRun = null;

export async function getV1AcceptanceRunStatus() {
  const state = await normalizeRunState(await readRunState());
  return {
    ok: true,
    active: Boolean(activeRun && !activeRun.exited),
    run: state,
    latestReport: await getLatestV1AcceptanceReport()
  };
}

export async function preflightV1AcceptanceRun(options = {}) {
  const checks = [];
  let sourceCandidate = null;
  try {
    sourceCandidate = await resolveAcceptanceSource(options);
  } catch (error) {
    checks.push(makePreflightCheck("source-resolve", false, error.message || "source resolve failed"));
  }

  const sourcePath = path.resolve(sourceCandidate?.sourcePath || "");
  const sourceExists = Boolean(sourcePath && fsSync.existsSync(sourcePath));
  checks.push(makePreflightCheck("source-exists", sourceExists, sourceExists ? sourcePath : "PPTX source file is missing", {
    sourcePath,
    sourceMode: sourceCandidate?.sourceMode || "",
    workflowJobId: sourceCandidate?.workflowJobId || ""
  }));

  const sourceIsPptx = Boolean(sourceExists && /\.pptx$/i.test(sourcePath));
  checks.push(makePreflightCheck("source-pptx", sourceIsPptx, sourceIsPptx ? "PPTX source accepted" : "Only .pptx source files are accepted"));

  let slideCount = 0;
  if (sourceIsPptx) {
    slideCount = await countPptxSlides(sourcePath).catch(() => 0);
  }
  const targetPages = clampInteger(options.maxPages, 1, 200, 15);
  checks.push(makePreflightCheck("source-page-count", slideCount >= targetPages, slideCount ? `${slideCount} slide(s) found` : "Unable to read PPTX slide count", {
    slideCount,
    targetPages
  }));

  const noActiveRun = !(activeRun && !activeRun.exited);
  checks.push(makePreflightCheck("no-active-run", noActiveRun, noActiveRun ? "No acceptance run is active" : "A real PPT acceptance run is already in progress"));

  const doctor = await runProductDoctor({ editpptTimeoutMs: Number(options.editpptTimeoutMs || 30000) }).catch((error) => ({
    ok: false,
    level: "blocked",
    summary: error.message || "Product doctor failed",
    checks: []
  }));
  const doctorChecks = Array.isArray(doctor.checks) ? doctor.checks : [];
  const requiredDoctorIds = ["node", "workspace-root", "workflow-root", "llm-provider", "image-provider", "ocr-provider", "editppt", "powerpoint"];
  for (const id of requiredDoctorIds) {
    const item = doctorChecks.find((check) => check.id === id);
    checks.push(makePreflightCheck(`doctor-${id}`, Boolean(item?.ok), item?.message || `${id} check missing`, item?.details || {}));
  }

  const failed = checks.filter((check) => !check.ok);
  return {
    ok: true,
    ready: failed.length === 0,
    level: failed.length ? "blocked" : "ready",
    summary: failed.length ? `${failed.length} preflight check(s) failed` : "Real PPT acceptance preflight passed",
    sourcePath,
    sourceMode: sourceCandidate?.sourceMode || "",
    workflowJobId: sourceCandidate?.workflowJobId || "",
    sourceOriginalName: sourceCandidate?.sourceOriginalName || path.basename(sourcePath || ""),
    slideCount,
    targetPages,
    checks,
    doctor: {
      ok: Boolean(doctor.ok),
      level: doctor.level || "",
      summary: doctor.summary || ""
    },
    checkedAt: new Date().toISOString()
  };
}

export async function startV1AcceptanceRun(options = {}) {
  if (activeRun && !activeRun.exited) {
    const state = await readRunState();
    const error = new Error("A real PPT acceptance run is already in progress.");
    error.code = "V1_ACCEPTANCE_RUN_IN_PROGRESS";
    error.status = 409;
    error.run = state;
    throw error;
  }

  const sourceCandidate = await resolveAcceptanceSource(options);
  const sourcePath = path.resolve(sourceCandidate.sourcePath || "");
  if (!sourcePath || !fsSync.existsSync(sourcePath)) {
    const error = new Error("真实验收需要一个存在的本地 PPTX 路径。");
    error.code = "V1_ACCEPTANCE_SOURCE_NOT_FOUND";
    error.status = 400;
    throw error;
  }
  if (!/\.pptx$/i.test(sourcePath)) {
    const error = new Error("真实验收当前只接受 .pptx 文件。");
    error.code = "V1_ACCEPTANCE_SOURCE_NOT_PPTX";
    error.status = 400;
    throw error;
  }

  await fs.mkdir(v1AcceptanceRootDir, { recursive: true });
  const id = `v1_acceptance_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
  const maxPages = clampInteger(options.maxPages, 1, 200, 15);
  const runDir = path.join(v1AcceptanceRootDir, id);
  const stagedSourcePath = path.join(runDir, "source.pptx");
  await fs.mkdir(runDir, { recursive: true });
  await fs.copyFile(sourcePath, stagedSourcePath);
  const logPath = path.join(v1AcceptanceRootDir, `${id}.log`);
  const args = [
    "run",
    "regression:real-ppt",
    "--",
    "--source",
    stagedSourcePath,
    "--max-pages",
    String(maxPages)
  ];
  if (options.skipOcr) args.push("--skip-ocr");
  if (options.skipEditable) args.push("--skip-editable");
  const command = `npm.cmd ${args.map((item) => quoteCommandArg(item)).join(" ")}`;
  const startedAt = new Date().toISOString();
  const initialState = {
    id,
    ok: true,
    status: "running",
    sourcePath,
    stagedSourcePath,
    sourceMode: sourceCandidate.sourceMode,
    workflowJobId: sourceCandidate.workflowJobId || "",
    sourceOriginalName: sourceCandidate.sourceOriginalName || path.basename(sourcePath),
    maxPages,
    skipOcr: Boolean(options.skipOcr),
    skipEditable: Boolean(options.skipEditable),
    command,
    startedAt,
    endedAt: "",
    exitCode: null,
    logPath,
    logRelativePath: path.relative(rootDir, logPath),
    message: "真实 15 页验收正在运行。",
    outputTail: ""
  };
  await writeRunState(initialState);
  await fs.writeFile(logPath, `[${startedAt}] ${command}\n`, "utf8");

  let child = null;
  try {
    child = spawn("cmd.exe", ["/d", "/s", "/c", command], {
      cwd: rootDir,
      env: stringifyEnv({ ...globalThis.process.env, PPT_TOOL_BASE_URL: globalThis.process.env.PPT_TOOL_BASE_URL || "http://127.0.0.1:4180" }),
      windowsHide: true
    });
  } catch (error) {
    await finishRun(initialState, {
      status: "failed",
      exitCode: -1,
      message: error.message || "真实验收启动失败。"
    });
    throw error;
  }
  activeRun = { id, child, exited: false };
  const append = async (chunk) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
    if (!text) return;
    await fs.appendFile(logPath, text, "utf8").catch(() => {});
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.on("error", async (error) => {
    activeRun = { id, child, exited: true };
    await finishRun(initialState, {
      status: "failed",
      exitCode: -1,
      message: error.message || "真实验收启动失败。"
    });
  });
  child.on("close", async (code) => {
    activeRun = { id, child, exited: true };
    await finishRun(initialState, {
      status: code === 0 ? "complete" : "failed",
      exitCode: code,
      message: code === 0 ? "真实 15 页验收已结束，请查看结构化验收结论。" : `真实验收失败，退出码 ${code}。`
    });
  });

  return {
    ok: true,
    active: true,
    run: initialState
  };
}

async function countPptxSlides(filePath) {
  const buffer = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(buffer);
  return Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .length;
}

function makePreflightCheck(id, ok, message = "", details = {}) {
  return {
    id,
    ok: Boolean(ok),
    status: ok ? "pass" : "fail",
    message: String(message || ""),
    details,
    checkedAt: new Date().toISOString()
  };
}

async function resolveAcceptanceSource(options = {}) {
  const workflowJobId = String(options.workflowJobId || "").trim();
  if (workflowJobId) {
    const job = await readWorkflowJob(workflowJobId);
    const source = job.artifacts?.source || {};
    return {
      sourcePath: source.path || "",
      sourceMode: "workflow-source",
      workflowJobId: job.id,
      sourceOriginalName: source.originalName || job.input?.sourceOriginalName || ""
    };
  }
  return {
    sourcePath: String(options.sourcePath || ""),
    sourceMode: "local-path",
    workflowJobId: "",
    sourceOriginalName: ""
  };
}

async function finishRun(initialState, patch) {
  const endedAt = new Date().toISOString();
  const outputTail = await readLogTail(initialState.logPath);
  await writeRunState({
    ...initialState,
    ...patch,
    endedAt,
    outputTail
  });
}

async function readRunState() {
  try {
    return JSON.parse(await fs.readFile(latestRunPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function normalizeRunState(state) {
  if (!state || state.status !== "running" || (activeRun && !activeRun.exited)) return state;
  const normalized = {
    ...state,
    status: "failed",
    endedAt: state.endedAt || new Date().toISOString(),
    exitCode: Number.isFinite(state.exitCode) ? state.exitCode : -1,
    message: "真实验收进程没有处于活动状态，已标记为失败；请重新启动验收。",
    outputTail: await readLogTail(state.logPath)
  };
  await writeRunState(normalized);
  return normalized;
}

async function writeRunState(state) {
  await fs.mkdir(v1AcceptanceRootDir, { recursive: true });
  await fs.writeFile(latestRunPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function readLogTail(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return text.slice(-4000);
  } catch {
    return "";
  }
}

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function stringifyEnv(env = {}) {
  return Object.fromEntries(
    Object.entries(env)
      .filter(([key, value]) => key && value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)])
  );
}

function quoteCommandArg(value) {
  const text = String(value || "");
  return /\s/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}
