#!/usr/bin/env node
import "dotenv/config";
import fsSync from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const REQUIRED_OUTPUTS = [
  "manifest.json",
  "imagegen-jobs.json",
  "page.pptx",
  "preview.png",
  "split_assets_contact.png",
  "validation.json",
  "page_result.json"
];
const REQUIRED_PAGE_RESULT = {
  page_manifest: "manifest.json",
  imagegen_jobs: "imagegen-jobs.json",
  page_pptx: "page.pptx",
  preview: "preview.png",
  contact_sheet: "split_assets_contact.png",
  validation: "validation.json",
  page_result: "page_result.json"
};
const REQUIRED_QUALITY_CHECKS = [
  "font_size_calibrated",
  "visual_inventory_matched",
  "background_strategy_checked",
  "shape_corner_geometry_checked"
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const pageDir = resolveExistingDir(args["page-dir"] || process.env.PPT_WORKER_PAGE_DIR || "");
  const visualSpec = path.resolve(args["visual-spec"] || path.join(pageDir, "visual-asset-jobs.json"));
  const rebuildSpec = path.resolve(args.spec || args["rebuild-spec"] || path.join(pageDir, "page-rebuild-spec.json"));
  const skipVisualAssets = Boolean(args["skip-visual-assets"]);
  const requireVisualAssets = Boolean(args["require-visual-assets"]);
  const sourceFidelityRecovery = isSourceFidelityRecovery(pageDir, rebuildSpec);
  guardRecordedPageOverwrite(pageDir, args);

  const ran = [];
  if (sourceFidelityRecovery) {
    ran.push("visual-assets:skipped-source-fidelity-recovery");
  } else if (!skipVisualAssets && fsSync.existsSync(visualSpec)) {
    const visualAssetDecision = getVisualAssetDecision(pageDir, visualSpec, rebuildSpec);
    if (visualAssetDecision.skip) {
      ran.push(visualAssetDecision.reason);
    } else if (visualAssetOutputsExist(pageDir, visualSpec)) {
      ran.push("visual-assets:skipped-existing");
    } else {
      await runNodeScript("visual-asset-helper.mjs", ["--page-dir", pageDir, "--spec", visualSpec]);
      ran.push("visual-assets");
    }
  } else if (requireVisualAssets) {
    throw new Error(`Visual asset spec not found: ${visualSpec}`);
  }

  if (!fsSync.existsSync(rebuildSpec)) {
    throw new Error(`Page rebuild spec not found: ${rebuildSpec}. A real page worker must author page-rebuild-spec.json before this pipeline can assemble artifacts.`);
  }

  if (sourceFidelityRecovery) {
    ran.push("recover-complex-spec:skipped-source-fidelity-recovery");
  } else {
    await runNodeScript("recover-complex-page-spec.mjs", ["--page-dir", pageDir, "--spec", rebuildSpec]);
    ran.push("recover-complex-spec");
  }

  const assemblerArgs = ["--page-dir", pageDir, "--spec", rebuildSpec];
  if (args["allow-recorded-overwrite"] || args.allowRecordedOverwrite) assemblerArgs.push("--allow-recorded-overwrite");
  await runNodeScript("page-rebuild-assembler.mjs", assemblerArgs);
  ran.push("assemble-page");
  verifyOutputs(pageDir);
  verifyPageOutputContract(pageDir);

  console.log(JSON.stringify({
    ok: true,
    pageDir,
    visualSpec: fsSync.existsSync(visualSpec) ? visualSpec : null,
    rebuildSpec,
    ran,
    outputs: REQUIRED_OUTPUTS.map((name) => path.join(pageDir, name))
  }, null, 2));
}

function isSourceFidelityRecovery(pageDir = "", specPath = path.join(pageDir, "page-rebuild-spec.json")) {
  const marker = readJsonIfExists(path.join(pageDir, "page-spec-fallback.json"));
  const pageRequest = readJsonIfExists(path.join(pageDir, "page_request.json"));
  const pageId = normalizeId(pageRequest?.page_id || path.basename(pageDir));
  const expectedJobId = String(process.env.PPT_WORKFLOW_JOB_ID || deriveWorkflowJobId(pageDir) || "").trim();
  const expectedRunId = String(pageRequest?.run_id || "").trim();
  return envTruthy(process.env.PPT_TOOL_USE_SOURCE_FIDELITY_BACKGROUND)
    && marker?.schemaVersion === 1
    && marker?.createdBy === "model-page-worker-pipeline"
    && marker?.fallback === "source-fidelity-background-recovery"
    && marker?.reason === "visual-asset-budget-exhausted"
    && normalizeId(marker?.pageId || "") === pageId
    && normalizeId(marker?.pageDirName || "") === normalizeId(path.basename(pageDir))
    && String(marker?.specFile || "") === path.basename(specPath)
    && expectedJobId
    && String(marker?.jobId || "") === expectedJobId
    && expectedRunId
    && String(marker?.runId || "") === expectedRunId;
}

function envTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function readJsonIfExists(filePath = "") {
  try {
    if (!filePath || !fsSync.existsSync(filePath)) return null;
    return JSON.parse(fsSync.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function deriveWorkflowJobId(pageDir = "") {
  const normalized = String(pageDir || "").replace(/\\/g, "/");
  const match = normalized.match(/ppt-tool-editable-runs\/([^/]+)\/[^/]+\/pages\/[^/]+$/i);
  return match ? match[1] : "";
}

function guardRecordedPageOverwrite(pageDir, args = {}) {
  if (args["allow-recorded-overwrite"] || args.allowRecordedOverwrite) return;
  const pageState = readPageRunState(pageDir);
  if (!pageState || !["recorded", "accepted"].includes(pageState.status)) return;
  throw new Error(`Refusing to overwrite ${pageState.pageId} because editppt already marked it ${pageState.status}. Reset/prepare a fresh run before rebuilding, otherwise page evidence hashes become stale.`);
}

function readPageRunState(pageDir) {
  const pageId = path.basename(pageDir);
  const runDir = path.dirname(path.dirname(pageDir));
  const pageJobsPath = path.join(runDir, "page_jobs.json");
  if (!fsSync.existsSync(pageJobsPath)) return null;
  try {
    const pageJobs = JSON.parse(fsSync.readFileSync(pageJobsPath, "utf8").replace(/^\uFEFF/, ""));
    const page = (Array.isArray(pageJobs.pages) ? pageJobs.pages : []).find((item) => normalizeId(item.page_id || item.pageId || "") === normalizeId(pageId));
    if (!page) return null;
    return {
      pageId,
      status: String(page.status || "").toLowerCase()
    };
  } catch {
    return null;
  }
}

async function runNodeScript(scriptName, args) {
  const scriptPath = path.join(SCRIPT_DIR, scriptName);
  if (!fsSync.existsSync(scriptPath)) throw new Error(`Worker script not found: ${scriptPath}`);
  const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, ...args], {
    cwd: PROJECT_ROOT,
    windowsHide: true,
    encoding: "utf8",
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8"
    }
  });
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}

function verifyOutputs(pageDir) {
  const missing = REQUIRED_OUTPUTS.filter((name) => !fsSync.existsSync(path.join(pageDir, name)));
  if (missing.length) throw new Error(`Page pipeline did not create required output(s): ${missing.join(", ")}`);
}

function verifyPageOutputContract(pageDir) {
  const issues = [];
  const validation = readJsonSync(path.join(pageDir, "validation.json"));
  if (validation?.passed !== true) issues.push("validation.json must contain top-level passed=true.");

  const pageResult = readJsonSync(path.join(pageDir, "page_result.json"));
  for (const [key, expected] of Object.entries(REQUIRED_PAGE_RESULT)) {
    if (pageResult?.[key] !== expected) issues.push(`page_result.json ${key} must be ${expected}.`);
    if (!fsSync.existsSync(path.join(pageDir, expected))) issues.push(`page_result.json ${key} target is missing: ${expected}.`);
  }

  const manifest = readJsonSync(path.join(pageDir, "manifest.json"));
  for (const key of ["slide", "content_box", "source", "text_inventory", "visual_inventory", "background_strategy", "quality_checks", "text_boxes", "shapes", "images", "asset_provenance", "page_strategy"]) {
    if (!(key in (manifest || {}))) issues.push(`manifest.json missing ${key}.`);
  }
  for (const key of REQUIRED_QUALITY_CHECKS) {
    if (manifest?.quality_checks?.[key] !== true) issues.push(`manifest.json quality_checks.${key} must be true.`);
  }
  if (!manifest?.background_strategy?.mode) issues.push("manifest.json background_strategy.mode is required.");
  if (!manifest?.background_strategy?.source_consistency_contract) issues.push("manifest.json background_strategy.source_consistency_contract is required.");
  if (!manifest?.background_strategy?.comparison_note) issues.push("manifest.json background_strategy.comparison_note is required.");

  for (const item of Array.isArray(manifest?.text_boxes) ? manifest.text_boxes : []) {
    if (!isValidBox(item?.box_px)) issues.push(`manifest text box ${item?.id || item?.text || ""} missing valid box_px.`);
  }
  for (const item of Array.isArray(manifest?.images) ? manifest.images : []) {
    if (!isValidBox(item?.box_px)) issues.push(`manifest image ${item?.id || item?.path || ""} missing valid box_px.`);
  }
  for (const item of Array.isArray(manifest?.shapes) ? manifest.shapes : []) {
    if (item?.type === "line") {
      if (!Array.isArray(item.points_px) || item.points_px.length !== 4) issues.push(`manifest line ${item?.id || ""} missing points_px.`);
    } else if (!isValidBox(item?.box_px)) {
      issues.push(`manifest shape ${item?.id || ""} missing valid box_px.`);
    }
  }

  if (issues.length) throw new Error(`Page output contract failed: ${issues.join(" | ")}`);
}

function readJsonSync(filePath) {
  try {
    return JSON.parse(fsSync.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`Failed to read JSON ${path.basename(filePath)}: ${error.message || error}`);
  }
}

function isValidBox(value) {
  return Array.isArray(value) && value.length === 4 && value.every((item) => Number.isFinite(Number(item))) && Number(value[2]) > 0 && Number(value[3]) > 0;
}

function visualAssetOutputsExist(pageDir, visualSpec) {
  const jobs = readVisualAssetJobs(visualSpec);
  if (!jobs.length) return false;
  return jobs.every((job, index) => {
    if (job.import === false) {
      const outDir = pageRelativePath(pageDir, job.outDir || job.out_dir || path.join("assets", "generated"));
      const outName = job.out || `${normalizeId(job.id || job.jobId || `asset_${index + 1}`)}.png`;
      return fsSync.existsSync(path.join(outDir, outName));
    }
    const dest = job.dest || path.join("assets", job.out || `${normalizeId(job.id || job.jobId || `asset_${index + 1}`)}.png`);
    return fsSync.existsSync(pageRelativePath(pageDir, dest));
  });
}

function readVisualAssetJobs(visualSpec) {
  try {
    const spec = JSON.parse(fsSync.readFileSync(visualSpec, "utf8").replace(/^\uFEFF/, ""));
    return Array.isArray(spec.jobs) ? spec.jobs : Array.isArray(spec.assets) ? spec.assets : [];
  } catch {
    return [];
  }
}

function getVisualAssetDecision(pageDir, visualSpec, rebuildSpec) {
  if (!fsSync.existsSync(rebuildSpec)) return { skip: false, reason: "" };
  const spec = readJsonSync(rebuildSpec);
  const needed = Array.isArray(spec?.needed_visual_asset_jobs) ? spec.needed_visual_asset_jobs : [];
  if (needed.length) return { skip: false, reason: "" };

  const missing = collectReferencedImagePaths(spec)
    .map((value) => pageRelativePath(pageDir, value))
    .filter((filePath) => !fsSync.existsSync(filePath));
  if (missing.length) return { skip: false, reason: "" };

  const jobs = readVisualAssetJobs(visualSpec);
  if (!jobs.length) return { skip: true, reason: "visual-assets:skipped-empty" };
  if (hasUnresolvedVisualAssetNeed(spec)) return { skip: false, reason: "" };
  return { skip: true, reason: "visual-assets:skipped-unreferenced" };
}

function hasUnresolvedVisualAssetNeed(spec = {}) {
  const text = JSON.stringify({
    visual_inventory: spec.visual_inventory || [],
    asset_provenance: spec.asset_provenance || [],
    background_strategy: spec.background_strategy || null,
    notes: spec.notes || "",
    warnings: spec.warnings || []
  });
  return /requires_separation|requires asset separation|asset separation|needed_visual_asset|product|photo|package|packaging|logo|brand|foreground|omitted unavailable generated image assets|包装|产品|标识|前景/i.test(text);
}

function collectReferencedImagePaths(spec) {
  const values = [];
  for (const item of Array.isArray(spec?.images) ? spec.images : []) {
    for (const key of ["src", "path", "asset", "asset_path", "image", "source"]) {
      const value = item?.[key];
      if (typeof value === "string" && value.trim()) values.push(value.trim());
    }
  }
  return [...new Set(values.filter((value) => !/^https?:\/\//i.test(value)))];
}

function pageRelativePath(pageDir, value) {
  const relative = String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const resolved = path.resolve(pageDir, relative);
  const root = path.resolve(pageDir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path escapes page directory: ${value}`);
  }
  return resolved;
}

function normalizeId(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "asset";
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
  console.log(`Page worker pipeline

Usage:
  node scripts/page-worker-pipeline.mjs --page-dir <run>/pages/page_001

Worker environment:
  PPT_WORKER_PAGE_DIR can provide --page-dir.

Behavior:
  1. If visual-asset-jobs.json exists, run lab:visual-assets.
  2. Require page-rebuild-spec.json.
  3. Run lab:assemble-page.
  4. Verify manifest.json, page.pptx, preview.png, split_assets_contact.png,
     validation.json, imagegen-jobs.json, and page_result.json exist and satisfy
     the image-to-editable-ppt page output contract.

This is intended as the external worker command for page-worker-runner:
  npm.cmd run worker:once -- --job-id <id> --agent-id <worker> --page page_001 --command "npm.cmd run lab:page-pipeline"

The pipeline does not author page-rebuild-spec.json and does not call record.
It refuses to overwrite pages already marked recorded/accepted unless --allow-recorded-overwrite is passed.
`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
