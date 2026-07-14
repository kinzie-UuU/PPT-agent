#!/usr/bin/env node
import "dotenv/config";
import fsSync from "fs";
import path from "path";
import { execFile, spawn } from "child_process";
import { fileURLToPath } from "url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const STALE_SPEC_BLOCKER_RE = /--no-image|\bno-image\b|text-only-ocr-spec|\bfallback\b|requires visual pass before production|requires product visual review|failed pass|requires-asset-separation|intentionally fails pass|omitted unavailable generated image assets/i;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const pageDir = resolveExistingDir(args["page-dir"] || process.env.PPT_WORKER_PAGE_DIR || "");
  const pageId = args.page || process.env.PPT_WORKER_PAGE_ID || path.basename(pageDir);
  const jobId = args["job-id"] || process.env.PPT_WORKFLOW_JOB_ID || "";
  const specPath = path.join(pageDir, "page-rebuild-spec.json");
  const visualSpecPath = path.join(pageDir, "visual-asset-jobs.json");
  const pageRequest = readJsonIfExists(path.join(pageDir, "page_request.json")) || {};
  const existingSpecIsFallback = isNoImageFallbackSpec(pageDir, specPath);

  if (existingSpecIsFallback && !args.force) {
    console.log("[model-page-worker-pipeline] existing page-rebuild-spec is a no-image fallback; regenerating product spec");
  }

  if (!fsSync.existsSync(specPath) || args.force || existingSpecIsFallback) {
    cleanupStaleSpecRecoveryArtifacts(pageDir, specPath, {
      allowRecordedOverwrite: Boolean(args["allow-recorded-overwrite"] || args.allowRecordedOverwrite)
    });
    const specArgs = [path.join(SCRIPT_DIR, "model-page-spec-worker.mjs"), "--page-dir", pageDir];
    if (pageId) specArgs.push("--page", String(pageId));
    if (jobId) specArgs.push("--job-id", String(jobId));
    if (args.brief) specArgs.push("--brief", String(args.brief));
    if (args["workflow-root"]) specArgs.push("--workflow-root", String(args["workflow-root"]));
    if (args["dry-run"]) specArgs.push("--dry-run");
    if (args["no-image"]) specArgs.push("--no-image");
    if (args["low-complexity-spec"] || args["low-complexity"]) specArgs.push("--low-complexity");
    const specTimeoutMs =
      args["timeout-ms"] ||
      process.env.MODEL_PAGE_SPEC_TIMEOUT_MS ||
      process.env.MODEL_PAGE_WORKER_TIMEOUT_MS ||
      "600000";
    specArgs.push("--timeout-ms", String(specTimeoutMs));
    if (args["max-retries"] !== undefined) specArgs.push("--max-retries", String(args["max-retries"]));
    if (args["max-tokens"]) specArgs.push("--max-tokens", String(args["max-tokens"]));
    removeStaleVisualAssetSpec(visualSpecPath);
    await runModelSpecWithAssetRetry(specArgs, pageDir, visualSpecPath, { pageId, jobId, runId: pageRequest.run_id || "", specPath });
  }

  if (args["dry-run"]) {
    console.log(JSON.stringify({ ok: true, dryRun: true, pageDir, specPath }, null, 2));
    return;
  }

  const pagePipelineArgs = [path.join(SCRIPT_DIR, "page-worker-pipeline.mjs"), "--page-dir", pageDir];
  if (args["skip-visual-assets"]) pagePipelineArgs.push("--skip-visual-assets");
  if (args["require-visual-assets"]) pagePipelineArgs.push("--require-visual-assets");
  await runNode(pagePipelineArgs);
}

async function runModelSpecWithAssetRetry(specArgs, pageDir, visualSpecPath, context = {}) {
  let lastError = null;
  let remainingAssetBudget = clampInteger(process.env.PPT_EXTERNAL_IMAGE_CALL_BUDGET || process.env.PPT_MAX_VISUAL_ASSET_JOBS, 0, 500, 0);
  const maxSpecAttempts = clampInteger(process.env.PPT_PAGE_SPEC_ASSET_RETRY_CYCLES, 3, 12, 6);
  for (let cycle = 0; cycle < maxSpecAttempts; cycle += 1) {
    const startedAtMs = Date.now();
    console.log(`[model-page-worker-pipeline] page spec attempt ${cycle + 1}/${maxSpecAttempts}`);
    try {
      await runNode(specArgs, { pageDir, monitorSpecResponse: true });
      console.log(`[model-page-worker-pipeline] page spec completed on attempt ${cycle + 1}/${maxSpecAttempts}`);
      return;
    } catch (error) {
      lastError = error;
      console.error(`[model-page-worker-pipeline] page spec attempt ${cycle + 1}/${maxSpecAttempts} failed: ${formatChildError(error)}`);
      if ((isTransientSpecProviderError(error) || isAssetMissingSpecError(error))
        && await recoverPageRebuildSpecFromLatestResponse(specArgs, pageDir)) {
        console.log("[model-page-worker-pipeline] recovered page-rebuild-spec.json from latest model response");
        return;
      }
      if (cycle >= maxSpecAttempts - 1) {
        if (isTransientSpecProviderError(error)) break;
        throw error;
      }
      if (!isCurrentVisualAssetSpec(visualSpecPath, startedAtMs)) {
        if (isTransientSpecProviderError(error)) {
          console.log(`[model-page-worker-pipeline] transient page spec provider failure; retrying attempt ${cycle + 2}/${maxSpecAttempts} without regenerating assets`);
          continue;
        }
        if (isRetryableSpecValidationError(error)) {
          console.log(`[model-page-worker-pipeline] retryable page spec validation failure; retrying attempt ${cycle + 2}/${maxSpecAttempts} without regenerating assets`);
          continue;
        }
        if (isAssetMissingSpecError(error) && recoverVisualAssetSpecFromLatestResponse(pageDir, visualSpecPath)) {
          console.log("[model-page-worker-pipeline] recovered visual-asset-jobs.json from latest model response");
        } else {
          throw error;
        }
      }
      if (remainingAssetBudget === 0 && (process.env.PPT_EXTERNAL_IMAGE_CALL_BUDGET || process.env.PPT_MAX_VISUAL_ASSET_JOBS)) {
        if (envTruthy(process.env.PPT_TOOL_USE_SOURCE_FIDELITY_BACKGROUND)) {
          lastError = new Error("Visual asset generation budget is exhausted for this page worker run.");
          break;
        }
        throw new Error("Visual asset generation budget is exhausted for this page worker run.");
      }
      console.log(`[model-page-worker-pipeline] visual assets requested; generating assets before retry ${cycle + 2}/${maxSpecAttempts}`);
      const assetArgs = [path.join(SCRIPT_DIR, "visual-asset-helper.mjs"), "--page-dir", pageDir, "--spec", visualSpecPath];
      if (remainingAssetBudget > 0) assetArgs.push("--max-jobs", String(remainingAssetBudget));
      await runNode(assetArgs);
      if (remainingAssetBudget > 0) {
        const reportPath = path.join(pageDir, "logs", "visual-asset-helper-report.json");
        const report = readJsonIfExists(reportPath);
        remainingAssetBudget = Math.max(0, remainingAssetBudget - Number(report?.plannedJobs || 0));
        console.log(`[model-page-worker-pipeline] visual asset budget remaining=${remainingAssetBudget}`);
      }
      removeStaleVisualAssetSpec(visualSpecPath);
    }
  }
  const noImageFallbackEnabled = envTruthy(process.env.PPT_ALLOW_NO_IMAGE_PAGE_SPEC_FALLBACK);
  const sourceFidelityRecoveryEnabled = envTruthy(process.env.PPT_TOOL_USE_SOURCE_FIDELITY_BACKGROUND);
  if (lastError && isAssetMissingSpecError(lastError) && sourceFidelityRecoveryEnabled && !specArgs.some((arg) => String(arg) === "--no-image")) {
    console.log("[model-page-worker-pipeline] visual asset budget exhausted; trying source-fidelity background recovery once");
    await runNode([...specArgs, "--no-image"], { pageDir, monitorSpecResponse: true });
    writePageSpecFallbackMarker(pageDir, {
      schemaVersion: 1,
      createdBy: "model-page-worker-pipeline",
      pageId: context.pageId || path.basename(pageDir),
      jobId: context.jobId || "",
      runId: context.runId || "",
      pageDirName: path.basename(pageDir),
      specFile: path.basename(context.specPath || "page-rebuild-spec.json"),
      reason: "visual-asset-budget-exhausted",
      originalError: formatChildError(lastError),
      fallback: "source-fidelity-background-recovery",
      createdAt: new Date().toISOString()
    });
    console.log("[model-page-worker-pipeline] source-fidelity background recovery spec completed");
    return;
  }
  if (lastError && isTransientSpecProviderError(lastError) && noImageFallbackEnabled && !specArgs.some((arg) => String(arg) === "--no-image")) {
    console.log("[model-page-worker-pipeline] vision page spec failed after 3 attempts; trying no-image low-complexity fallback once");
    await runNode([...specArgs, "--no-image"], { pageDir, monitorSpecResponse: true });
    writePageSpecFallbackMarker(pageDir, {
      schemaVersion: 1,
      createdBy: "model-page-worker-pipeline",
      pageId: context.pageId || path.basename(pageDir),
      jobId: context.jobId || "",
      runId: context.runId || "",
      pageDirName: path.basename(pageDir),
      specFile: path.basename(context.specPath || "page-rebuild-spec.json"),
      reason: "vision-page-spec-transient-provider-failure",
      originalError: formatChildError(lastError),
      fallback: "no-image-page-spec",
      createdAt: new Date().toISOString()
    });
    console.log("[model-page-worker-pipeline] no-image page spec fallback completed");
    return;
  }
  throw lastError || new Error("model page spec did not complete after asset retry cycles");
}

function isTransientSpecProviderError(error = {}) {
  const text = `${error?.message || ""}\n${error?.stderr || ""}`;
  return /HTTP\s*524|\b524\b|gateway timeout|operation was aborted|AbortError|content was empty|did not contain parseable JSON/i.test(text);
}

function isRetryableSpecValidationError(error = {}) {
  const text = `${error?.message || ""}\n${error?.stderr || ""}`;
  return /forbidden fallback wording found in visual inventory or provenance|visual_inventory lists visible non-text objects but shapes\/images are empty|background_strategy claims preserved or matched source visuals but the rebuild has too few meaningful shapes\/images|uses a placeholder path instead of a real page asset|background_strategy\.(?:mode|source_consistency_contract|comparison_note) is required|quality_checks\.[\w_]+ must be true/i.test(text);
}

function isAssetMissingSpecError(error = {}) {
  const text = `${error?.message || ""}\n${error?.stderr || ""}`;
  return /required assets are missing|visual asset generation budget is exhausted|needed_visual_asset_jobs/i.test(text);
}

async function recoverPageRebuildSpecFromLatestResponse(specArgs = [], pageDir = "") {
  const responsePath = path.join(pageDir, "model-page-spec-response.json");
  const specPath = path.join(pageDir, "page-rebuild-spec.json");
  if (!fsSync.existsSync(responsePath) || fsSync.existsSync(specPath)) return false;
  try {
    await runNode([...specArgs, "--from-response", responsePath], { pageDir, monitorSpecResponse: false });
    return fsSync.existsSync(specPath);
  } catch {
    return false;
  }
}

function recoverVisualAssetSpecFromLatestResponse(pageDir = "", visualSpecPath = "") {
  const response = readJsonIfExists(path.join(pageDir, "model-page-spec-response.json"));
  const jobs = Array.isArray(response?.parsed?.needed_visual_asset_jobs)
    ? response.parsed.needed_visual_asset_jobs
    : [];
  if (!jobs.length) return false;
  const normalizedJobs = jobs
    .map((job, index) => {
      const id = cleanAssetId(job?.id || job?.job_id || job?.jobId || `visual_asset_${index + 1}`);
      const targetPath = normalizeAssetPath(job?.target_asset_path || job?.expected_asset_path || job?.path || path.join("assets", `${id}.png`))
        || normalizeAssetPath(path.join("assets", `${id}.png`));
      const sourceBox = coerceBox(job?.source_box_px || job?.source_region_box_px || job?.sourceBoxPx || job?.box_px || job?.target_box_px);
      return {
        id,
        type: "edit",
        image: "source.png",
        role: "asset",
        prompt: [
          job?.prompt || job?.description || job?.purpose || "Separate the required foreground visual asset from the source slide.",
          "Preserve the source-faithful colors, typography, proportions, strokes, edges, and shadows.",
          "Return only the requested visual object/panel, cleanly separated for reuse in an editable PowerPoint rebuild.",
          "Use real transparent pixels outside the requested object; do not render a gray-white checkerboard, transparency grid, or placeholder background.",
          "If true transparency is unavailable, use one flat high-saturation chroma-key color that does not appear in the object."
        ].filter(Boolean).join(" "),
        out: path.basename(targetPath),
        dest: targetPath,
        note: job?.note || job?.asset_provenance || "asset-sheet-separated",
        ...(sourceBox ? { source_box_px: sourceBox } : {})
      };
    })
    .filter((job) => job.id && job.dest);
  if (!normalizedJobs.length) return false;
  fsSync.writeFileSync(visualSpecPath, `${JSON.stringify({
    schema_version: 1,
    source: "model-page-worker-pipeline-response-recovery",
    concurrency: 1,
    jobs: normalizedJobs
  }, null, 2)}\n`, "utf8");
  return true;
}

function cleanAssetId(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "visual_asset";
}

function normalizeAssetPath(value) {
  const text = String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!text || path.isAbsolute(text) || text.split("/").includes("..")) return "";
  return text;
}

function coerceBox(value) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const box = value.map(Number);
  return box.every(Number.isFinite) && box[2] > 0 && box[3] > 0 ? box : null;
}

function envTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function readJsonIfExists(filePath) {
  try {
    if (!fsSync.existsSync(filePath)) return null;
    return JSON.parse(fsSync.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function writePageSpecFallbackMarker(pageDir = "", marker = {}) {
  if (!pageDir) return;
  try {
    fsSync.writeFileSync(path.join(pageDir, "page-spec-fallback.json"), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  } catch {
    // Best effort marker only; the generated spec remains the source of truth.
  }
}

function isNoImageFallbackSpec(pageDir = "", specPath = "") {
  const fallbackMarker = readJsonIfExists(path.join(pageDir, "page-spec-fallback.json"));
  if (fallbackMarker?.fallback === "no-image-page-spec") return true;
  const spec = readJsonIfExists(specPath);
  if (!spec) return false;
  const text = JSON.stringify({
    page_strategy: spec.page_strategy,
    strategy: spec.strategy,
    background_strategy: spec.background_strategy,
    asset_provenance: spec.asset_provenance,
    notes: spec.notes,
    visual_inventory: spec.visual_inventory
  });
  return STALE_SPEC_BLOCKER_RE.test(text);
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function removeStaleVisualAssetSpec(visualSpecPath) {
  if (!fsSync.existsSync(visualSpecPath)) return;
  fsSync.rmSync(visualSpecPath, { force: true });
}

function cleanupStaleSpecRecoveryArtifacts(pageDir = "", specPath = "", options = {}) {
  const stalePaths = [
    path.join(pageDir, "page-spec-fallback.json"),
    `${specPath}.before-complex-recovery.json`
  ];
  if (options.allowRecordedOverwrite || !hasRecordedOrValidatedPageEvidence(pageDir)) {
    stalePaths.push(path.join(pageDir, "imagegen-jobs.json"));
  }
  for (const stalePath of stalePaths) {
    if (!stalePath || !fsSync.existsSync(stalePath)) continue;
    fsSync.rmSync(stalePath, { force: true });
  }
}

function hasRecordedOrValidatedPageEvidence(pageDir = "") {
  const pageResult = readJsonIfExists(path.join(pageDir, "page_result.json"));
  const validation = readJsonIfExists(path.join(pageDir, "validation.json"));
  if (validation?.passed === true) return true;
  if (pageResult?.manifest === "manifest.json" && pageResult?.pptx === "page.pptx") return true;
  const pageId = path.basename(pageDir || "");
  const pageJobs = readJsonIfExists(path.join(path.dirname(path.dirname(pageDir || "")), "page_jobs.json"));
  const page = (Array.isArray(pageJobs?.pages) ? pageJobs.pages : [])
    .find((item) => String(item?.page_id || item?.pageId || "").toLowerCase() === String(pageId).toLowerCase());
  return ["recorded", "accepted"].includes(String(page?.status || "").toLowerCase());
}

function isCurrentVisualAssetSpec(visualSpecPath, startedAtMs) {
  if (!fsSync.existsSync(visualSpecPath)) return false;
  const stat = fsSync.statSync(visualSpecPath);
  return stat.mtimeMs >= startedAtMs - 1000;
}

async function runNode(args, options = {}) {
  const timeout = getChildTimeout(args);
  const label = path.basename(String(args[0] || "node-script"));
  console.log(`[model-page-worker-pipeline] start ${label} timeout=${timeout}ms`);
  await new Promise((resolve, reject) => {
    const monitorStartedAtMs = Date.now();
    const child = spawn(process.execPath, args, {
      cwd: PROJECT_ROOT,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8"
      }
    });
    let stderrTail = "";
    let settled = false;
    const timer = timeout > 0
      ? setTimeout(() => {
        terminateChildTree(child.pid);
      }, timeout)
      : null;
    const responseMonitor = options.monitorSpecResponse
      ? setInterval(() => {
        const terminalError = readTerminalSpecProviderError(options.pageDir, monitorStartedAtMs);
        if (!terminalError) return;
        const error = new Error(terminalError);
        error.code = "PROVIDER_TERMINAL";
        error.stderr = terminalError;
        terminateChildTree(child.pid);
        if (!settled) {
          if (timer) clearTimeout(timer);
          clearInterval(responseMonitor);
          child.__terminalProviderError = error;
        }
      }, 5000)
      : null;
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderrTail = `${stderrTail}${text}`.slice(-2000);
      process.stderr.write(chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (responseMonitor) clearInterval(responseMonitor);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (responseMonitor) clearInterval(responseMonitor);
      if (child.__terminalProviderError) {
        reject(child.__terminalProviderError);
        return;
      }
      if (code === 0) {
        console.log(`[model-page-worker-pipeline] done ${label}`);
        resolve();
        return;
      }
      const error = new Error(`${label} exited with code ${code ?? ""}${signal ? ` signal ${signal}` : ""}`.trim());
      error.code = code;
      error.signal = signal;
      error.stderr = stderrTail;
      reject(error);
    });
  });
}

function getChildTimeout(args = []) {
  const fromArgs = valueAfterArg(args, "--timeout-ms");
  const value = Number(fromArgs || process.env.MODEL_PAGE_WORKER_TIMEOUT_MS || 1200000);
  return Number.isFinite(value) && value > 0 ? value : 1200000;
}

function valueAfterArg(args = [], key = "") {
  const index = args.findIndex((item) => String(item) === key);
  if (index < 0 || index >= args.length - 1) return "";
  return String(args[index + 1] || "");
}

function readTerminalSpecProviderError(pageDir = "", startedAtMs = 0) {
  if (!pageDir) return "";
  const specPath = path.join(pageDir, "page-rebuild-spec.json");
  if (fsSync.existsSync(specPath)) return "";
  const responsePath = path.join(pageDir, "model-page-spec-response.json");
  try {
    const stat = fsSync.statSync(responsePath);
    if (startedAtMs && stat.mtimeMs < startedAtMs - 1000) return "";
  } catch {
    return "";
  }
  const response = readJsonIfExists(responsePath);
  if (response?.parsed) return "";
  const text = [
    response?.parseError,
    response?.error,
    ...(Array.isArray(response?.attempts) ? response.attempts.map((attempt) => attempt?.error || attempt?.parseError) : [])
  ].filter(Boolean).join("\n");
  if (!/HTTP\s*524|\b524\b|gateway timeout|operation was aborted|AbortError/i.test(text)) return "";
  return text.split(/\r?\n/).find(Boolean) || "model page spec provider failed";
}

function terminateChildTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // Best-effort cleanup; the caller will still observe timeout or exit.
  }
}

function formatChildError(error) {
  const parts = [];
  if (error?.code) parts.push(`code=${error.code}`);
  if (error?.signal) parts.push(`signal=${error.signal}`);
  if (error?.killed) parts.push("killed=true");
  const message = error?.message ? String(error.message).split(/\r?\n/)[0] : "";
  if (message) parts.push(message);
  const stderr = error?.stderr ? String(error.stderr).trim().split(/\r?\n/).slice(-1)[0] : "";
  if (stderr) parts.push(`stderr=${stderr}`);
  return parts.join("; ") || "unknown error";
}

function resolveExistingDir(value) {
  const dir = path.resolve(String(value || ""));
  if (!dir || !fsSync.existsSync(dir) || !fsSync.statSync(dir).isDirectory()) {
    throw new Error("Missing --page-dir or PPT_WORKER_PAGE_DIR");
  }
  return dir;
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

function printHelp() {
  console.log(`Model page worker pipeline

Usage:
  node scripts/model-page-worker-pipeline.mjs --page-dir <run>/pages/page_001 --job-id <workflow_id> --page page_001
  node scripts/model-page-worker-pipeline.mjs --page-dir <run>/pages/page_001 --timeout-ms 180000 --max-retries 0 --max-tokens 2500

Behavior:
  1. If page-rebuild-spec.json is missing, run model-page-spec-worker.
  2. Run page-worker-pipeline to build, contact-sheet, and validate page artifacts.

This command is intended to be used as an external worker command:
  npm.cmd run worker:once -- --job-id <id> --agent-id <worker> --page page_001 --command "npm.cmd run lab:model-page-pipeline"
`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
