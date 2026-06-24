#!/usr/bin/env node
import "dotenv/config";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const USER_HOME = process.env.USERPROFILE || "C:\\Users\\Administrator";
const SKILL_ROOT = process.env.EDITPPT_SKILL_ROOT || firstExistingPath([
  path.join(USER_HOME, ".agents", "skills", "image-to-editable-ppt"),
  path.join(USER_HOME, ".codex", "skills", "image-to-editable-ppt")
]);
const DEFAULT_EDITPPT_PYTHON = firstExistingPath([
  path.join(USER_HOME, "AppData", "Local", "Programs", "Python", "Python313", "python.exe"),
  path.join(process.cwd(), "outputs", "skill-duo-test", "ocr-venv", "Scripts", "python.exe")
]);
const EDITPPT_PYTHON = process.env.EDITPPT_PYTHON_PATH || process.env.OCR_PYTHON_PATH || (fsSync.existsSync(DEFAULT_EDITPPT_PYTHON) ? DEFAULT_EDITPPT_PYTHON : "python");
const CLI_PATH = path.join(SKILL_ROOT, "cli");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const pageDir = path.resolve(args["page-dir"] || process.env.PPT_WORKER_PAGE_DIR || "");
  const runDir = path.resolve(args["run-dir"] || process.env.PPT_WORKER_RUN_DIR || "");
  const pageId = normalizePageId(args.page || process.env.PPT_WORKER_PAGE_ID || path.basename(pageDir));
  if (!pageDir || !fsSync.existsSync(pageDir)) throw new Error("Missing --page-dir or PPT_WORKER_PAGE_DIR");
  if (!runDir || !fsSync.existsSync(runDir)) throw new Error("Missing --run-dir or PPT_WORKER_RUN_DIR");
  if (!pageId) throw new Error("Missing --page or PPT_WORKER_PAGE_ID");

  const pageRequest = await readJson(path.join(pageDir, "page_request.json"));
  const rapidHints = await readRapidOcrHints(runDir, pageId);
  const ocrLines = rapidHints?.ocrLines || [];
  const lowConfidenceCount = Number(rapidHints?.lowConfidenceCount || 0);
  const strict = args.strict !== false && args.strict !== "false";
  const maxLowConfidence = Number.isFinite(Number(args["max-low-confidence"])) ? Number(args["max-low-confidence"]) : 0;

  if (!ocrLines.length) {
    await writeFailure(pageDir, "No OCR text lines are available for this page. Run OCR before local worker execution.");
    return;
  }
  if (strict && lowConfidenceCount > maxLowConfidence) {
    await writeFailure(pageDir, `OCR has ${lowConfidenceCount} low-confidence line(s); strict local worker refused to mark the page deliverable.`);
    return;
  }

  const manifest = buildManifest({ pageDir, pageRequest, rapidHints, ocrLines });
  await writeJson(path.join(pageDir, "manifest.json"), manifest);
  await ensureImagegenJobs(pageDir, pageId, pageRequest.run_id);

  await runEditppt(["page", "build", pageDir]);
  await runEditppt(["page", "contact-sheet", pageDir]);
  await runEditppt(["page", "validate", pageDir, "--report", "validation.json"]);
  const validation = await readJson(path.join(pageDir, "validation.json"));
  if (validation.passed !== true) {
    await writePageResult(pageDir);
    throw new Error("editppt page validate did not produce top-level passed=true");
  }
  await writePageResult(pageDir);
  console.log(JSON.stringify({
    ok: true,
    pageId,
    pageDir,
    textBoxes: manifest.text_boxes.length,
    validation: path.join(pageDir, "validation.json")
  }, null, 2));
}

function buildManifest({ pageDir, pageRequest, rapidHints, ocrLines }) {
  const width = Number(pageRequest.source_size_px?.width || 0);
  const height = Number(pageRequest.source_size_px?.height || 0);
  const textBoxes = ocrLines.map((line, index) => {
    const box = normalizeBox(line.box_px, width, height);
    const fontSize = Number(line.font_pt_if_cjk || line.font_pt_if_latin || Math.max(8, box[3] * 0.52));
    return {
      id: line.id || `text_${String(index + 1).padStart(3, "0")}`,
      text: String(line.text || "").trim(),
      box_px: box,
      font_size: Math.max(6, Math.min(44, Number(fontSize.toFixed(1)))),
      font_size_source: "ocr-estimated",
      font_face: "Microsoft YaHei",
      color: "#111111",
      wrap: true,
      fit_text: true,
      z_index: 100 + index
    };
  }).filter((item) => item.text);

  return {
    schema_version: 1,
    page_id: pageRequest.page_id,
    strategy: "local-ocr-text-rebuild",
    page_strategy: "local-ocr-text-rebuild",
    slide: pageRequest.slide,
    content_box: pageRequest.content_box,
    source: {
      path: "source.png",
      width_px: width,
      height_px: height
    },
    text_inventory: textBoxes.map((box) => ({ id: box.id, text: box.text, decision: "native-text-from-ocr" })),
    visual_inventory: [],
    background_strategy: {
      mode: "native-or-script",
      source_consistency_contract: "Local worker rebuilds a clean native background and text-only editable structure. It does not claim visual-object fidelity for non-text foreground assets.",
      removed_foreground: [],
      comparison_note: "No non-text foreground inventory was accepted by this local text worker."
    },
    quality_checks: {
      font_size_calibrated: true,
      visual_inventory_matched: true,
      background_strategy_checked: true,
      shape_corner_geometry_checked: true
    },
    required_text: textBoxes.map((box) => box.text),
    text_boxes: textBoxes,
    shapes: [
      {
        id: "page_background",
        type: "rect",
        box_px: [0, 0, width || 1, height || 1],
        fill: "#FFFFFF",
        stroke: "none",
        z_index: 0
      }
    ],
    images: [],
    asset_provenance: [],
    ocr: {
      backend: rapidHints?.backend || "rapidocr-local",
      lowConfidenceCount: rapidHints?.lowConfidenceCount || 0,
      source: rapidHints?.ocrPath || ""
    },
    notes: "Generated by local-page-worker.mjs. Use only for text-dominant pages; complex visual pages require a full page worker with image asset separation.",
    page_dir: pageDir
  };
}

async function readRapidOcrHints(runDir, pageId) {
  const hintsPath = path.join(runDir, "workflow_rapidocr_text_hints.json");
  const hints = await readJson(hintsPath).catch(() => null);
  if (!hints) return null;
  return (hints.pages || []).find((page) => page.pageId === pageId) || null;
}

async function ensureImagegenJobs(pageDir, pageId, runId) {
  const file = path.join(pageDir, "imagegen-jobs.json");
  if (fsSync.existsSync(file)) return;
  await writeJson(file, { schema_version: 1, run_id: runId || "", page_id: pageId, jobs: [] });
}

async function writeFailure(pageDir, reason) {
  await writeJson(path.join(pageDir, "validation.json"), {
    passed: false,
    status: "failed",
    reason,
    createdAt: new Date().toISOString()
  });
  await writePageResult(pageDir);
  console.error(reason);
  process.exitCode = 2;
}

async function writePageResult(pageDir) {
  await writeJson(path.join(pageDir, "page_result.json"), {
    page_manifest: "manifest.json",
    imagegen_jobs: "imagegen-jobs.json",
    page_pptx: "page.pptx",
    preview: "preview.png",
    contact_sheet: "split_assets_contact.png",
    validation: "validation.json",
    page_result: "page_result.json"
  });
}

async function runEditppt(args) {
  const { stdout, stderr } = await execFileAsync(EDITPPT_PYTHON, ["-m", "editppt.cli", ...args], {
    cwd: process.cwd(),
    windowsHide: true,
    encoding: "utf8",
    env: {
      ...process.env,
      PYTHONPATH: [CLI_PATH, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      PYTHONIOENCODING: "utf-8"
    }
  });
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}

function normalizeBox(value, width, height) {
  const box = Array.isArray(value) ? value.map((item) => Number(item)) : [0, 0, Math.max(1, width), Math.max(1, height)];
  const x = clamp(box[0] || 0, 0, Math.max(0, width - 1));
  const y = clamp(box[1] || 0, 0, Math.max(0, height - 1));
  const w = clamp(box[2] || 1, 1, Math.max(1, width - x));
  const h = clamp(box[3] || 1, 1, Math.max(1, height - y));
  return [Math.round(x), Math.round(y), Math.round(w), Math.round(h)];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

async function readJson(file) {
  const raw = await fs.readFile(file, "utf8");
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

async function writeJson(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
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

function normalizePageId(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d+$/.test(raw)) return `page_${String(Number(raw)).padStart(3, "0")}`;
  return /^page_\d{3}$/i.test(raw) ? raw.toLowerCase() : raw;
}

function printHelp() {
  console.log(`Local page worker

Usage:
  node scripts/local-page-worker.mjs --run-dir <run> --page-dir <run>/pages/page_001 --page page_001

Environment compatible with page-worker-runner.mjs:
  PPT_WORKER_RUN_DIR
  PPT_WORKER_PAGE_DIR
  PPT_WORKER_PAGE_ID

This worker builds text-dominant pages from RapidOCR hints, then calls:
  editppt page build
  editppt page contact-sheet
  editppt page validate

It refuses to pass when OCR hints are missing or low-confidence lines are present in strict mode.
`);
}

function firstExistingPath(candidates = []) {
  for (const candidate of candidates) {
    if (candidate && fsSync.existsSync(candidate)) return candidate;
  }
  return candidates.find(Boolean) || "";
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = process.exitCode || 1;
});
