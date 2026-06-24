#!/usr/bin/env node
import "dotenv/config";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { fileURLToPath } from "url";

const execFileAsync = promisify(execFile);
const DEFAULT_BASE_URL = process.env.PPT_TOOL_BASE_URL || "http://127.0.0.1:4180";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const baseUrl = String(args.baseUrl || args["base-url"] || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const jobId = requireArg(args, "job-id");
  const workerCommand = String(args.command || process.env.PPT_PAGE_WORKER_COMMAND || "").trim();
  const agentPrefix = String(args["agent-prefix"] || args.agentPrefix || "batch-worker").trim();
  const selectedPages = parsePages(args.pages || args.page || "", 200);
  const continueOnError = args["stop-on-error"] !== true;
  const resetOnError = args["no-reset-on-error"] !== true;
  const direct = Boolean(args.direct);
  const acceptOfflineTextHints = Boolean(args["accept-offline-text-hints"] || args.acceptOfflineTextHints || process.env.PPT_ACCEPT_OFFLINE_TEXT_HINTS === "1");
  const offlineTextHintsReason = String(args["offline-text-hints-reason"] || process.env.PPT_OFFLINE_TEXT_HINTS_REASON || "").trim();
  const timeoutMs = clampInteger(args["timeout-ms"] || args.timeoutMs, 30000, 1800000, 600000);
  const maxPages = clampInteger(args["max-pages"] || args.maxPages, 1, 200, 200);

  if (!workerCommand) throw new Error("No worker command configured. Pass --command or set PPT_PAGE_WORKER_COMMAND.");

  const apiClient = direct ? await makeDirectClient() : makeHttpClient(baseUrl);
  const bundle = await apiClient.sync(jobId);
  const allowedPages = selectedPages.length ? new Set(selectedPages) : null;
  const tasks = (bundle.tasks || [])
    .filter((task) => task.status === "ready" || task.status === "failed")
    .filter((task) => !allowedPages || allowedPages.has(task.pageId))
    .slice(0, maxPages);
  if (!tasks.length) throw new Error("No ready or failed worker tasks matched the requested pages.");

  const results = [];
  for (const task of tasks) {
    const agentId = `${agentPrefix}-${task.pageId}`;
    const startedAt = new Date().toISOString();
    try {
      if (direct) await runDirectTask({ apiClient, bundle, jobId, pageId: task.pageId, agentId, workerCommand, timeoutMs, acceptOfflineTextHints, offlineTextHintsReason });
      else await runOnce({ jobId, pageId: task.pageId, agentId, workerCommand, baseUrl, timeoutMs, acceptOfflineTextHints, offlineTextHintsReason });
      results.push({ pageId: task.pageId, agentId, ok: true, startedAt, finishedAt: new Date().toISOString() });
    } catch (error) {
      results.push({ pageId: task.pageId, agentId, ok: false, error: error.message || String(error), startedAt, finishedAt: new Date().toISOString() });
      if (resetOnError) {
        await apiClient.reset(jobId, task.pageId, error.message || String(error)).catch((resetError) => {
          results.push({ pageId: task.pageId, agentId, ok: false, error: `reset after failure failed: ${resetError.message || resetError}`, startedAt, finishedAt: new Date().toISOString() });
        });
      }
      if (!continueOnError) break;
    }
  }

  const finalBundle = await apiClient.list(jobId).catch(() => null);
  const failed = results.filter((result) => !result.ok);
  const summary = {
    ok: failed.length === 0,
    jobId,
    requested: tasks.length,
    succeeded: results.length - failed.length,
    failed: failed.length,
    taskSummary: finalBundle?.summary || null,
    results
  };
  console.log(JSON.stringify(summary, null, 2));
  if (failed.length) process.exitCode = 1;
}

function makeHttpClient(baseUrl) {
  return {
    sync(jobId) {
      return api(baseUrl, `/api/workflow-jobs/${jobId}/editable/worker-tasks/sync`, { method: "POST", body: {} });
    },
    list(jobId) {
      return api(baseUrl, `/api/workflow-jobs/${jobId}/editable/worker-tasks`, { method: "GET" });
    },
    claim(jobId, pageId, options) {
      return api(baseUrl, `/api/workflow-jobs/${jobId}/editable/worker-tasks/${pageId}/claim`, { method: "POST", body: options });
    },
    complete(jobId, pageId, options) {
      return api(baseUrl, `/api/workflow-jobs/${jobId}/editable/worker-tasks/${pageId}/complete`, { method: "POST", body: options });
    },
    reset(jobId, pageId, reason) {
      return api(baseUrl, `/api/workflow-jobs/${jobId}/editable/worker-tasks/${pageId}/reset`, {
        method: "POST",
        body: {
          reason: `batch failure: ${String(reason || "").slice(0, 180)}`,
          allowQueueOnlyReset: true
        }
      });
    }
  };
}

async function makeDirectClient() {
  const queue = await import("../server/workflowWorkerQueue.js");
  return {
    sync(jobId) {
      return queue.syncWorkflowEditableWorkerTasks(jobId, {});
    },
    list(jobId) {
      return queue.listWorkflowEditableWorkerTasks(jobId, {});
    },
    claim(jobId, pageId, options) {
      return queue.claimWorkflowEditableWorkerTask(jobId, pageId, options);
    },
    complete(jobId, pageId, options) {
      return queue.completeWorkflowEditableWorkerTask(jobId, pageId, options);
    },
    reset(jobId, pageId, reason) {
      return queue.resetWorkflowEditableWorkerTask(jobId, pageId, {
        reason: `batch failure: ${String(reason || "").slice(0, 180)}`,
        allowQueueOnlyReset: true
      });
    }
  };
}

async function runDirectTask({ apiClient, bundle, jobId, pageId, agentId, workerCommand, timeoutMs, acceptOfflineTextHints = false, offlineTextHintsReason = "" }) {
  const prompt = (bundle.prompts || []).find((item) => item.pageId === pageId);
  const task = (bundle.tasks || []).find((item) => item.pageId === pageId);
  if (!prompt) throw new Error(`No prompt found for ${pageId}`);
  await apiClient.claim(jobId, pageId, { agentId, workerName: agentId, agentNickname: agentId, acceptOfflineTextHints, offlineTextHintsReason });
  const { stdout, stderr } = await execFileAsync("cmd.exe", ["/d", "/s", "/c", workerCommand], {
    cwd: PROJECT_ROOT,
    windowsHide: true,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 20,
    env: {
      ...process.env,
      PPT_TOOL_BASE_URL: DEFAULT_BASE_URL,
      PPT_WORKFLOW_JOB_ID: jobId,
      PPT_WORKER_AGENT_ID: agentId,
      PPT_WORKER_PAGE_ID: pageId,
      PPT_WORKER_PROMPT_FILE: prompt.promptFile || task?.promptFile || "",
      PPT_WORKER_PAGE_DIR: prompt.pageDir || task?.pageDir || "",
      PPT_WORKER_RUN_DIR: bundle.runDir || "",
      PPT_WORKER_PROMPT_RELATIVE_PATH: prompt.relativePath || task?.relativePath || "",
      PPT_TOOL_PROJECT_ROOT: PROJECT_ROOT,
      PYTHONIOENCODING: "utf-8",
      PPT_ACCEPT_OFFLINE_TEXT_HINTS: acceptOfflineTextHints ? "1" : "",
      PPT_OFFLINE_TEXT_HINTS_REASON: offlineTextHintsReason
    }
  });
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  await apiClient.complete(jobId, pageId, { agentId });
}

async function runOnce({ jobId, pageId, agentId, workerCommand, baseUrl, timeoutMs, acceptOfflineTextHints = false, offlineTextHintsReason = "" }) {
  const args = [
    path.join(SCRIPT_DIR, "page-worker-runner.mjs"),
    "once",
    "--job-id",
    jobId,
    "--agent-id",
    agentId,
    "--page",
    pageId,
    "--base-url",
    baseUrl,
    "--command",
    workerCommand,
    "--heartbeat-ms",
    "30000"
  ];
  if (acceptOfflineTextHints) args.push("--accept-offline-text-hints");
  if (offlineTextHintsReason) args.push("--offline-text-hints-reason", offlineTextHintsReason);
  const { stdout, stderr } = await execFileAsync(process.execPath, args, {
    cwd: PROJECT_ROOT,
    windowsHide: true,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 20,
    env: {
      ...process.env,
      PPT_TOOL_PROJECT_ROOT: PROJECT_ROOT,
      PYTHONIOENCODING: "utf-8"
    }
  });
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
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

function parsePages(value = "", max = 200) {
  const text = String(value || "").trim();
  if (!text) return [];
  const pages = new Set();
  for (const part of text.split(/[,\s，、]+/).filter(Boolean)) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Math.max(1, Number(range[1]));
      const end = Math.min(max, Number(range[2]));
      for (let page = start; page <= end; page += 1) pages.add(formatPageId(page));
    } else {
      const normalized = normalizePageId(part);
      if (normalized) pages.add(normalized);
    }
  }
  return [...pages].sort((a, b) => a.localeCompare(b));
}

function normalizePageId(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d+$/.test(raw)) return formatPageId(Number(raw));
  return /^page_\d{3}$/i.test(raw) ? raw.toLowerCase() : "";
}

function formatPageId(page) {
  return `page_${String(Number(page)).padStart(3, "0")}`;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else if (key === "command") {
      const parts = [];
      while (argv[i + 1] && !argv[i + 1].startsWith("--")) {
        parts.push(argv[i + 1]);
        i += 1;
      }
      args[key] = parts.join(" ");
    }
    else {
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

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function printHelp() {
  console.log(`Page worker batch runner

Usage:
  npm.cmd run worker:batch -- --job-id <workflow_id> --pages 1-15 --command "npm.cmd run lab:page-pipeline"

Options:
  --base-url <url>         PPT tool server. Default: ${DEFAULT_BASE_URL}
  --pages <list>           Pages such as "1,2,5-8". Default: all ready/failed tasks.
  --max-pages <n>          Limit pages in this batch.
  --agent-prefix <text>    Agent id prefix. Default: batch-worker.
  --command <cmd>          External worker command passed to worker:once.
  --timeout-ms <ms>        Timeout per page. Default: 600000.
  --accept-offline-text-hints
                          Confirm offline builtin-ink text hints for this workflow.
  --direct                 Use local server modules instead of HTTP endpoints.
  --stop-on-error          Stop at first failed page.
  --no-reset-on-error      Leave failed pages in their current queue state.

Behavior:
  Calls the existing worker:once command per page, preserving claim, heartbeat,
  complete, and editppt record behavior.
`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
