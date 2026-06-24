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

  if (!fsSync.existsSync(specPath) || args.force) {
    const specArgs = [path.join(SCRIPT_DIR, "model-page-spec-worker.mjs"), "--page-dir", pageDir];
    if (pageId) specArgs.push("--page", String(pageId));
    if (jobId) specArgs.push("--job-id", String(jobId));
    if (args.brief) specArgs.push("--brief", String(args.brief));
    if (args["workflow-root"]) specArgs.push("--workflow-root", String(args["workflow-root"]));
    if (args["dry-run"]) specArgs.push("--dry-run");
    if (args["no-image"]) specArgs.push("--no-image");
    const specTimeoutMs =
      args["timeout-ms"] ||
      process.env.MODEL_PAGE_SPEC_TIMEOUT_MS ||
      process.env.MODEL_PAGE_WORKER_TIMEOUT_MS ||
      "600000";
    specArgs.push("--timeout-ms", String(specTimeoutMs));
    if (args["max-retries"] !== undefined) specArgs.push("--max-retries", String(args["max-retries"]));
    if (args["max-tokens"]) specArgs.push("--max-tokens", String(args["max-tokens"]));
    await runModelSpecWithAssetRetry(specArgs, pageDir, visualSpecPath);
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

async function runModelSpecWithAssetRetry(specArgs, pageDir, visualSpecPath) {
  try {
    await runNode(specArgs);
    return;
  } catch (error) {
    if (!fsSync.existsSync(visualSpecPath)) throw error;
    await runNode([path.join(SCRIPT_DIR, "visual-asset-helper.mjs"), "--page-dir", pageDir, "--spec", visualSpecPath]);
    await runNode(specArgs);
  }
}

async function runNode(args) {
  const { stdout, stderr } = await execFileAsync(process.execPath, args, {
    cwd: PROJECT_ROOT,
    windowsHide: true,
    encoding: "utf8",
    timeout: Number(process.env.MODEL_PAGE_WORKER_TIMEOUT_MS || 600000),
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8"
    }
  });
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
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
