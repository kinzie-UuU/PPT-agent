import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { readWorkflowJob, saveWorkflowJob, workflowRootDir } from "./workflowJobs.js";

const execFileAsync = promisify(execFile);

export async function buildWorkflowWorkerBriefs(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const outDir = path.join(job.rootDir, "worker-briefs");
  await fs.mkdir(outDir, { recursive: true });

  const args = [
    path.join(process.cwd(), "scripts", "build-worker-briefs.mjs"),
    "--job-id",
    job.id,
    "--workflow-root",
    workflowRootDir,
    "--out",
    outDir
  ];
  const pages = normalizePages(options.pages || options.pageIds || options.page || "");
  if (pages) args.push("--pages", pages);
  const agentId = cleanString(options.agentId || "worker-001");
  if (agentId) args.push("--agent-id", agentId);

  const result = await execFileAsync(process.execPath, args, {
    cwd: process.cwd(),
    windowsHide: true,
    encoding: "utf8",
    timeout: clampInteger(options.timeoutMs, 30000, 300000, 120000),
    env: {
      ...process.env,
      PPT_WORKFLOW_ROOT: workflowRootDir,
      PYTHONIOENCODING: "utf-8"
    }
  });
  const index = parseJsonOutput(result.stdout) || await readJson(path.join(outDir, "index.json"));
  const saved = await readWorkflowJob(job.id);
  saved.artifacts = {
    ...(saved.artifacts || {}),
    workerBriefs: artifactRecord("worker_briefs", outDir, {
      indexPath: path.join(outDir, "index.json"),
      readmePath: path.join(outDir, "README.md"),
      pageCount: index.pageCount || 0,
      briefs: index.briefs || [],
      stdout: String(result.stdout || "").slice(-4000),
      stderr: String(result.stderr || "").slice(-4000)
    })
  };
  saved.events = appendEvent(saved.events, "editable.worker_briefs_ready", `Built ${index.pageCount || 0} worker brief(s)`, {
    outDir,
    pages: (index.briefs || []).map((brief) => brief.pageId)
  });
  await saveWorkflowJob(saved);
  return {
    ok: true,
    jobId: job.id,
    outDir,
    index
  };
}

export async function getWorkflowWorkerBriefs(jobId) {
  const job = await readWorkflowJob(jobId);
  const outDir = job.artifacts?.workerBriefs?.path || path.join(job.rootDir, "worker-briefs");
  const indexPath = path.join(outDir, "index.json");
  const index = fsSync.existsSync(indexPath) ? await readJson(indexPath) : null;
  return {
    ok: Boolean(index),
    jobId: job.id,
    outDir,
    index,
    artifact: job.artifacts?.workerBriefs || null
  };
}

function artifactRecord(kind, filePath, extra = {}) {
  const stat = fsSync.existsSync(filePath) ? fsSync.statSync(filePath) : null;
  return {
    kind,
    path: filePath,
    relativePath: path.relative(process.cwd(), filePath),
    size: stat?.size || 0,
    createdAt: new Date().toISOString(),
    ...extra
  };
}

function parseJsonOutput(stdout = "") {
  const text = String(stdout || "").trim();
  if (!text) return null;
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first < 0 || last < first) return null;
  return JSON.parse(text.slice(first, last + 1));
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function appendEvent(events = [], type, message, details = {}) {
  return [...(Array.isArray(events) ? events : []), {
    id: `evt_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    type,
    message,
    details,
    createdAt: new Date().toISOString()
  }].slice(-500);
}

function normalizePages(value = "") {
  if (Array.isArray(value)) return value.join(",");
  return String(value || "").replace(/[^\d,page_\-\s]/gi, "").trim();
}

function cleanString(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 1000);
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}
