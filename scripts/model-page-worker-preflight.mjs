#!/usr/bin/env node
import "dotenv/config";
import fsSync from "fs";
import path from "path";
import { getProviderConfig, readProviderError, requestOpenAiCompatible, stripEndpoint, testLlmProvider } from "../server/providers.js";

const DEFAULT_WORKFLOW_ROOT = firstExistingPath([
  process.env.PPT_WORKFLOW_ROOT,
  process.env.WORKFLOW_ROOT,
  "E:\\PPT\u5de5\u5177\\workspace\\jobs",
  path.join(process.cwd(), "workspace", "jobs")
]);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const pageDir = resolveDir(args["page-dir"] || process.env.PPT_WORKER_PAGE_DIR || "");
  const pageId = normalizePageId(args.page || process.env.PPT_WORKER_PAGE_ID || path.basename(pageDir));
  const jobId = String(args["job-id"] || process.env.PPT_WORKFLOW_JOB_ID || "").trim();
  const workflowRoot = path.resolve(String(args["workflow-root"] || args.workflowRoot || DEFAULT_WORKFLOW_ROOT));
  const config = getProviderConfig().llm;
  const model = process.env.PAGE_SPEC_MODEL || process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || config.model;
  const apiKey = process.env.OPENAI_API_KEY || process.env.PROVIDER_API_KEY || "";
  const timeoutMs = parseBoundedNumber(args["timeout-ms"] || args.timeoutMs, 5000, 600000, config.timeoutMs);
  const maxRetries = parseBoundedNumber(args["max-retries"] ?? args.maxRetries, 0, 8, config.maxRetries);
  const sourceImage = path.join(pageDir, "source.png");

  const checks = [
    check("pageDir exists", Boolean(pageDir && fsSync.existsSync(pageDir))),
    check("source.png exists", fsSync.existsSync(sourceImage)),
    check("page_request.json exists", fsSync.existsSync(path.join(pageDir, "page_request.json"))),
    check("worker-prompt.md exists", fsSync.existsSync(path.join(pageDir, "worker-prompt.md"))),
    check("brief exists", !jobId || fsSync.existsSync(path.join(workflowRoot, jobId, "worker-briefs", pageId, "worker-brief.json"))),
    check("provider api key configured", Boolean(apiKey)),
    check("model selected", Boolean(model)),
    check("base url selected", Boolean(config.baseUrl))
  ];
  const ok = checks.every((item) => item.ok);
  const result = {
    ok,
    pageId,
    pageDir,
    jobId,
    workflowRoot,
    provider: {
      configured: Boolean(apiKey),
      baseUrl: config.baseUrl,
      model,
      timeoutMs,
      maxRetries
    },
    checks,
    nextCommand: ok
      ? `npm.cmd run worker:once -- --job-id ${jobId || "<workflow_id>"} --agent-id <worker_id> --page ${pageId || "<page_id>"} --command "npm.cmd run lab:model-page-pipeline"`
      : ""
  };
  if (args["live-probe"]) {
    result.liveProbe = await safeTestLlmProvider({ apiKey, baseUrl: config.baseUrl, model, timeoutMs, maxRetries });
    result.ok = result.ok && result.liveProbe.ok;
  }
  if (args["vision-probe"]) {
    result.visionProbe = await testVisionProvider({ apiKey, baseUrl: config.baseUrl, model, timeoutMs, maxRetries, sourceImage });
    result.ok = result.ok && result.visionProbe.ok;
  }

  console.log(JSON.stringify(result, null, 2));
  if (!ok) process.exitCode = 2;
  if (result.ok !== true) process.exitCode = 2;
}

function check(name, ok) {
  return { name, ok: Boolean(ok) };
}

function resolveDir(value) {
  const text = String(value || "").trim();
  return text ? path.resolve(text) : "";
}

function normalizePageId(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d+$/.test(raw)) return `page_${String(Number(raw)).padStart(3, "0")}`;
  return /^page_\d{3}$/i.test(raw) ? raw.toLowerCase() : "";
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

async function testVisionProvider({ apiKey, baseUrl, model, timeoutMs, maxRetries, sourceImage }) {
  if (!apiKey) return { ok: false, configured: false, error: "Missing API key" };
  const imageUrl = imageDataUrl(sourceImage);
  try {
    const result = await requestOpenAiCompatible(baseUrl, "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Return JSON only: {\"ok\":true}" },
            { type: "image_url", image_url: { url: imageUrl } }
          ]
        }],
        response_format: { type: "json_object" },
        max_tokens: 32,
        temperature: 0
      }),
      timeoutMs,
      maxRetries
    });
    if (!result.response.ok) {
      return {
        ok: false,
        configured: true,
        status: result.response.status,
        baseUrl: stripEndpoint(result.url, "/chat/completions"),
        error: await readProviderError(result.response)
      };
    }
    const data = await result.response.json();
    return {
      ok: true,
      configured: true,
      baseUrl: stripEndpoint(result.url, "/chat/completions"),
      imageBytes: fsSync.statSync(sourceImage).size,
      sample: data.choices?.[0]?.message?.content || "",
      usage: data.usage || null
    };
  } catch (error) {
    return { ok: false, configured: Boolean(apiKey), baseUrl, error: error.message || String(error) };
  }
}

async function safeTestLlmProvider(options) {
  try {
    return await testLlmProvider(options);
  } catch (error) {
    return {
      ok: false,
      configured: Boolean(options.apiKey),
      provider: {
        baseUrl: options.baseUrl,
        model: options.model,
        timeoutMs: options.timeoutMs,
        maxRetries: options.maxRetries
      },
      error: error.message || String(error)
    };
  }
}

function imageDataUrl(filePath) {
  if (!filePath || !fsSync.existsSync(filePath)) return "data:image/png;base64,";
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
  return `data:${mime};base64,${fsSync.readFileSync(filePath).toString("base64")}`;
}

function parseBoundedNumber(value, min, max, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function firstExistingPath(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    const resolved = path.resolve(String(candidate));
    if (fsSync.existsSync(resolved)) return resolved;
  }
  return path.join(process.cwd(), "workspace", "jobs");
}

function printHelp() {
  console.log(`Model page worker preflight

Usage:
  node scripts/model-page-worker-preflight.mjs --job-id <workflow_id> --page page_001 --page-dir <run>/pages/page_001
  node scripts/model-page-worker-preflight.mjs --job-id <workflow_id> --page page_001 --page-dir <run>/pages/page_001 --live-probe --vision-probe --timeout-ms 30000 --max-retries 0

This command is read-only. It checks whether a model page worker can be safely
dispatched before worker:once claims a real page task.
`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
