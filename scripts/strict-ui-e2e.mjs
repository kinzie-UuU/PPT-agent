#!/usr/bin/env node
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";

const execFileAsync = promisify(execFile);
const session = `ppt-strict-${Date.now()}`;
const root = path.join(process.cwd(), "workspace", "delivery-evidence", "strict-ui-e2e");
const flowPath = path.join(process.cwd(), "scripts", "strict-ui-e2e.playwright.js");
await fs.mkdir(root, { recursive: true });
const startedAt = new Date().toISOString();
await writeLatestState({ status: "running", startedAt, phase: "prepare-ready-fixture" });

async function cli(args, options = {}) {
  const command = ["npx.cmd", "--yes", "--package", "@playwright/cli", "playwright-cli", `-s=${session}`, ...args]
    .map(quoteCmdArgument)
    .join(" ");
  try {
    const result = await execFileAsync(process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe", ["/d", "/s", "/c", command], {
      cwd: process.cwd(),
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
      ...options
    });
    return `${result.stdout || ""}${result.stderr || ""}`;
  } catch (error) {
    const details = [error?.message, error?.stdout, error?.stderr].filter(Boolean).join("\n");
    throw new Error(details || `Playwright CLI command failed: ${command}`, { cause: error });
  }
}

let runOutput = "";
let traceOutput = "";
let readyFixture = null;
try {
  const fixtureRun = await execFileAsync(process.execPath, [path.join(process.cwd(), "scripts", "smoke-workflow-e2e.mjs"), "--delivery-ready-fixture"], {
    cwd: process.cwd(), windowsHide: true, maxBuffer: 20 * 1024 * 1024, timeout: 240000
  });
  readyFixture = JSON.parse(String(fixtureRun.stdout || "").trim());
  if (!readyFixture?.jobId || readyFixture?.delivery?.gate !== "ready") throw new Error("Synthetic ready-state fixture was not created.");
  await writeLatestState({ status: "running", startedAt, phase: "browser-dual-state-e2e", readyJobId: readyFixture.jobId });

  try {
    const bootstrapUrl = `http://127.0.0.1:4180/?readyJobId=${encodeURIComponent(readyFixture.jobId)}`;
    await cli(["open", bootstrapUrl]);
    await cli(["tracing-start"]);
    runOutput = await cli(["run-code", "--filename", flowPath], { timeout: 150000 });
    traceOutput = await cli(["tracing-stop"]);
  } finally {
    await cli(["close"]).catch(() => {});
  }

  const resultMatch = runOutput.match(/### Result\s*\r?\n([\s\S]*?)(?:\r?\n### |$)/);
  if (!resultMatch) throw new Error(`Strict UI E2E did not return structured evidence.\n${runOutput}`);
  const capture = JSON.parse(resultMatch[1].trim());
  const evidenceTracePath = path.join(root, "trace-latest.zip");
  await createTraceArchive(evidenceTracePath);

  capture.readyFixture = readyFixture;
  capture.trace = "workspace/delivery-evidence/strict-ui-e2e/trace-latest.zip";
  capture.runner = "scripts/strict-ui-e2e.mjs";
  capture.flow = "scripts/strict-ui-e2e.playwright.js";
  await fs.writeFile(path.join(root, "capture.json"), `${JSON.stringify(capture, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(root, "playwright-run.log"), runOutput, "utf8");
  await fs.writeFile(path.join(root, "playwright-trace.log"), traceOutput, "utf8");

  const finalizer = await execFileAsync(process.execPath, [path.join(process.cwd(), "scripts", "strict-ui-e2e-evidence.mjs")], {
    cwd: process.cwd(), windowsHide: true, maxBuffer: 10 * 1024 * 1024
  });
  process.stdout.write(finalizer.stdout || "");
  process.stderr.write(finalizer.stderr || "");
} catch (error) {
  await writeLatestState({ status: "fail", startedAt, finishedAt: new Date().toISOString(), phase: "strict-ui-e2e", error: error.message || String(error) });
  throw error;
} finally {
  if (readyFixture?.jobId) {
    await fetch(`http://127.0.0.1:4180/api/workflow-jobs/${encodeURIComponent(readyFixture.jobId)}/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archivedBy: "strict-ui-e2e", reason: "Synthetic ready-state fixture completed" })
    }).catch(() => {});
  }
}

async function exists(filePath) {
  return fs.access(filePath).then(() => true).catch(() => false);
}

function quoteCmdArgument(value) {
  const text = String(value || "");
  if (!/[\s&()^|<>]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

async function createTraceArchive(outputPath) {
  const traceRoot = path.join(process.cwd(), ".playwright-cli", "traces");
  const entries = await fs.readdir(traceRoot, { withFileTypes: true }).catch(() => []);
  const traceFiles = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^trace-.*\.trace$/i.test(entry.name)) continue;
    const absolute = path.join(traceRoot, entry.name);
    traceFiles.push({ name: entry.name, mtimeMs: (await fs.stat(absolute)).mtimeMs });
  }
  const latest = traceFiles.sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
  if (!latest) throw new Error("Strict UI E2E trace was not produced.");
  const stem = latest.name.replace(/\.trace$/i, "");
  const zip = new JSZip();
  const resourceNames = new Set();
  for (const extension of ["trace", "network", "stacks"]) {
    const name = `${stem}.${extension}`;
    const absolute = path.join(traceRoot, name);
    if (await exists(absolute)) {
      const buffer = await fs.readFile(absolute);
      zip.file(name, buffer);
      for (const match of buffer.toString("utf8").matchAll(/"sha1":"([^"]+)"/g)) resourceNames.add(match[1]);
    }
  }
  const resourceRoot = path.join(traceRoot, "resources");
  for (const name of resourceNames) {
    const absolute = path.join(resourceRoot, name);
    if (await exists(absolute)) zip.file(`resources/${name}`, await fs.readFile(absolute));
  }
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await fs.writeFile(outputPath, buffer);
}

async function writeLatestState(state) {
  const payload = { kind: "ppt-agent-strict-ui-e2e", version: 4, ...state };
  await fs.writeFile(path.join(root, "latest.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(root, "latest.md"), `# Strict UI E2E\n\n- Status: ${payload.status}\n- Phase: ${payload.phase || "unknown"}\n- Started: ${payload.startedAt || ""}\n- Error: ${payload.error || "none"}\n`, "utf8");
}
