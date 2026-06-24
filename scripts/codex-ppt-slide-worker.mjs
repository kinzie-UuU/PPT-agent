#!/usr/bin/env node
import "dotenv/config";

const DEFAULT_BASE_URL = process.env.PPT_TOOL_BASE_URL || "http://127.0.0.1:4180";

async function main() {
  const [command = "list", jobId = "", pageId = ""] = process.argv.slice(2);
  const args = parseArgs(process.argv.slice(5));
  if (command === "--help" || command === "help" || !jobId) {
    printHelp();
    return;
  }
  const baseUrl = String(args["base-url"] || args.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const routeBase = `/api/workflow-jobs/${encodeURIComponent(jobId)}/codex-ppt/slide-tasks`;
  let result = null;
  if (command === "sync") {
    result = await api(baseUrl, `${routeBase}/sync`, {
      method: "POST",
      body: {
        pages: args.pages || "",
        maxPages: args["max-pages"] || args.maxPages || undefined,
        force: Boolean(args.force)
      }
    });
  } else if (command === "list") {
    result = await api(baseUrl, routeBase);
  } else if (command === "claim") {
    result = await api(baseUrl, `${routeBase}/${encodeURIComponent(pageId)}/claim`, {
      method: "POST",
      body: {
        agentId: required(args["agent-id"] || args.agentId, "--agent-id"),
        workerName: args["worker-name"] || args.workerName || "",
        dispatchMode: args["dispatch-mode"] || args.dispatchMode || "external-slide-worker"
      }
    });
  } else if (command === "heartbeat") {
    result = await api(baseUrl, `${routeBase}/${encodeURIComponent(pageId)}/heartbeat`, {
      method: "POST",
      body: {
        agentId: args["agent-id"] || args.agentId || "",
        message: args.message || ""
      }
    });
  } else if (command === "complete") {
    result = await api(baseUrl, `${routeBase}/${encodeURIComponent(pageId)}/complete`, {
      method: "POST",
      body: {
        agentId: required(args["agent-id"] || args.agentId, "--agent-id"),
        imagePath: required(args["image-path"] || args.imagePath, "--image-path"),
        provider: args.provider || "",
        baseUrl: args["provider-base-url"] || args.providerBaseUrl || "",
        model: args.model || "",
        qaNote: args["qa-note"] || args.qaNote || "",
        allowNonProductVisual: Boolean(args["allow-non-product"]),
        dryRun: Boolean(args["dry-run"]),
        passthrough: Boolean(args.passthrough)
      }
    });
  } else if (command === "reset") {
    result = await api(baseUrl, `${routeBase}/${encodeURIComponent(pageId)}/reset`, {
      method: "POST",
      body: {
        reason: args.reason || "",
        forceRecorded: Boolean(args.force)
      }
    });
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
  console.log(JSON.stringify(result, null, 2));
}

async function api(baseUrl, route, { method = "GET", body = null } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status} ${route}`);
  return data;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function required(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function printHelp() {
  console.log(`Codex-ppt slide worker task CLI

Usage:
  npm.cmd run worker:codex-slide -- sync <workflowId> --pages 1-3
  npm.cmd run worker:codex-slide -- list <workflowId>
  npm.cmd run worker:codex-slide -- claim <workflowId> page_001 --agent-id worker-1
  npm.cmd run worker:codex-slide -- complete <workflowId> page_001 --agent-id worker-1 --image-path C:\\path\\slide.png --provider openai --model gpt-image-2
  npm.cmd run worker:codex-slide -- reset <workflowId> page_001 --force
`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
