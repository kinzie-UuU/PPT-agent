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
  guardRecordedPageOverwrite(pageDir, args);

  const ran = [];
  if (!skipVisualAssets && fsSync.existsSync(visualSpec)) {
    if (visualAssetOutputsExist(pageDir, visualSpec)) {
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

  await runNodeScript("page-rebuild-assembler.mjs", ["--page-dir", pageDir, "--spec", rebuildSpec]);
  ran.push("assemble-page");
  verifyOutputs(pageDir);

  console.log(JSON.stringify({
    ok: true,
    pageDir,
    visualSpec: fsSync.existsSync(visualSpec) ? visualSpec : null,
    rebuildSpec,
    ran,
    outputs: REQUIRED_OUTPUTS.map((name) => path.join(pageDir, name))
  }, null, 2));
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
     validation.json, imagegen-jobs.json, and page_result.json exist.

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
