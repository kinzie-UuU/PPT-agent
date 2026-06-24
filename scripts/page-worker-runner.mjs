#!/usr/bin/env node
import "dotenv/config";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const DEFAULT_BASE_URL = process.env.PPT_TOOL_BASE_URL || "http://127.0.0.1:4180";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "help";
  if (command === "help" || args.help) {
    printHelp();
    return;
  }
  if (command !== "once") {
    throw new Error(`Unknown command: ${command}`);
  }
  await runOnce(args);
}

async function runOnce(args) {
  const baseUrl = String(args.baseUrl || args["base-url"] || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const jobId = requireArg(args, "job-id");
  const agentId = requireArg(args, "agent-id");
  const workerCommand = String(args.command || process.env.PPT_PAGE_WORKER_COMMAND || "").trim();
  const selectedPageId = normalizePageId(args.page || args["page-id"] || "");
  const claimOnly = Boolean(args["claim-only"]);
  const printPrompt = Boolean(args["print-prompt"]);

  const bundle = await api(baseUrl, `/api/workflow-jobs/${jobId}/editable/worker-tasks/sync`, {
    method: "POST",
    body: {}
  });
  const task = pickTask(bundle.tasks || [], selectedPageId);
  if (!task) throw new Error(selectedPageId ? `No task found for ${selectedPageId}` : "No ready worker task found.");
  const prompt = (bundle.prompts || []).find((item) => item.pageId === task.pageId);
  if (!prompt) throw new Error(`No prompt found for ${task.pageId}`);

  if (printPrompt) {
    process.stdout.write(prompt.content || "");
    return;
  }

  if (claimOnly) {
    await claimTask(baseUrl, jobId, task.pageId, agentId, args);
    console.log(JSON.stringify({ ok: true, mode: "claim-only", jobId, pageId: task.pageId, agentId }, null, 2));
    return;
  }

  if (!workerCommand) {
    throw new Error("No worker command configured. Pass --command or set PPT_PAGE_WORKER_COMMAND.");
  }

  const child = spawn(workerCommand, {
    cwd: args.cwd ? path.resolve(String(args.cwd)) : PROJECT_ROOT,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      PPT_TOOL_BASE_URL: baseUrl,
      PPT_WORKFLOW_JOB_ID: jobId,
      PPT_WORKER_AGENT_ID: agentId,
      PPT_WORKER_PAGE_ID: task.pageId,
      PPT_WORKER_PROMPT_FILE: prompt.promptFile || task.promptFile || "",
      PPT_WORKER_PAGE_DIR: prompt.pageDir || task.pageDir || "",
      PPT_WORKER_RUN_DIR: bundle.runDir || "",
      PPT_WORKER_PROMPT_RELATIVE_PATH: prompt.relativePath || task.relativePath || "",
      PPT_TOOL_PROJECT_ROOT: PROJECT_ROOT
    }
  });
  child.stdout?.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
  const exitPromise = waitForExit(child);

  await onceSpawned(child);
  await claimTask(baseUrl, jobId, task.pageId, agentId, args);

  const heartbeat = startHeartbeat(baseUrl, jobId, task.pageId, agentId, Number(args["heartbeat-ms"] || 30000));
  const exitCode = await exitPromise;
  clearInterval(heartbeat);
  if (exitCode !== 0) {
    throw new Error(`Worker command exited with code ${exitCode}. Page artifacts were not recorded.`);
  }

  const complete = await api(baseUrl, `/api/workflow-jobs/${jobId}/editable/worker-tasks/${task.pageId}/complete`, {
    method: "POST",
    body: { agentId, pageResult: args["page-result"] || "" }
  });
  console.log(JSON.stringify({ ok: true, jobId, pageId: task.pageId, agentId, summary: complete.summary }, null, 2));
}

async function claimTask(baseUrl, jobId, pageId, agentId, args) {
  return api(baseUrl, `/api/workflow-jobs/${jobId}/editable/worker-tasks/${pageId}/claim`, {
    method: "POST",
    body: {
      agentId,
      workerName: args["worker-name"] || "",
      agentNickname: args["worker-name"] || "",
      acceptOfflineTextHints: Boolean(args["accept-offline-text-hints"] || args.acceptOfflineTextHints || process.env.PPT_ACCEPT_OFFLINE_TEXT_HINTS === "1"),
      offlineTextHintsReason: args["offline-text-hints-reason"] || process.env.PPT_OFFLINE_TEXT_HINTS_REASON || ""
    }
  });
}

function startHeartbeat(baseUrl, jobId, pageId, agentId, heartbeatMs) {
  const intervalMs = Math.max(5000, Math.min(300000, heartbeatMs || 30000));
  return setInterval(() => {
    api(baseUrl, `/api/workflow-jobs/${jobId}/editable/worker-tasks/${pageId}/heartbeat`, {
      method: "POST",
      body: { agentId, message: "worker command running" }
    }).catch((error) => {
      console.warn(`heartbeat failed: ${error.message}`);
    });
  }, intervalMs);
}

async function api(baseUrl, route, { method = "GET", body = null } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${response.status} ${route}`);
  }
  return data;
}

function pickTask(tasks, selectedPageId) {
  const normalized = normalizePageId(selectedPageId);
  const candidates = tasks.filter((task) => task.status === "ready" || task.status === "failed");
  if (normalized) return tasks.find((task) => task.pageId === normalized) || null;
  return candidates[0] || tasks.find((task) => task.status !== "recorded") || null;
}

function onceSpawned(child) {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.once("exit", (code) => resolve(Number(code || 0)));
  });
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function requireArg(args, name) {
  const value = args[name] || args[name.replace(/-/g, "_")];
  if (!value) throw new Error(`Missing --${name}`);
  return String(value);
}

function normalizePageId(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d+$/.test(raw)) return `page_${String(Number(raw)).padStart(3, "0")}`;
  return /^page_\d{3}$/i.test(raw) ? raw.toLowerCase() : raw;
}

function printHelp() {
  console.log(`Page worker runner

Usage:
  node scripts/page-worker-runner.mjs once --job-id <workflow_id> --agent-id <worker_id> --command "<external worker command>"

Options:
  --base-url <url>        PPT tool server. Default: ${DEFAULT_BASE_URL}
  --page <page_001>      Claim a specific page. Default: first ready task.
  --command <cmd>        External real worker command. Receives PPT_WORKER_* env vars.
  --worker-name <name>   Friendly worker name stored in task state.
  --accept-offline-text-hints
                         Confirm offline builtin-ink text hints for this workflow.
  --claim-only           Only record dispatch. Use only after a real worker is already started.
  --print-prompt         Print selected prompt content and exit without dispatch.
  --heartbeat-ms <ms>    Heartbeat interval while command is running.

Contract:
  This runner does not create manifest.json, page.pptx, preview.png, validation.json,
  or page_result.json. The external worker command must create page artifacts according
  to the image-to-editable-ppt page-worker prompt. Complete calls editppt record.
`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
