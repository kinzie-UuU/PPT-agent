#!/usr/bin/env node
import "dotenv/config";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const SKILL_ROOT = process.env.EDITPPT_SKILL_ROOT || path.join(process.env.USERPROFILE || "C:\\Users\\Administrator", ".codex", "skills", "image-to-editable-ppt");
const DEFAULT_EDITPPT_PYTHON = path.join(PROJECT_ROOT, "outputs", "skill-duo-test", "ocr-venv", "Scripts", "python.exe");
const EDITPPT_PYTHON = process.env.EDITPPT_PYTHON_PATH || process.env.OCR_PYTHON_PATH || (fsSync.existsSync(DEFAULT_EDITPPT_PYTHON) ? DEFAULT_EDITPPT_PYTHON : "python");
const CLI_PATH = path.join(SKILL_ROOT, "cli");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const pageDir = resolveExistingDir(args["page-dir"] || process.env.PPT_WORKER_PAGE_DIR || "");
  const specPath = path.resolve(args.spec || path.join(pageDir, "visual-asset-jobs.json"));
  if (!fsSync.existsSync(specPath)) throw new Error(`Visual asset spec not found: ${specPath}`);

  const spec = await readJson(specPath);
  const jobs = normalizeJobs(spec.jobs || spec.assets || []);
  if (!jobs.length) throw new Error("visual-asset-jobs.json must include at least one job.");

  const dryRun = Boolean(args["dry-run"] || spec.dryRun);
  const force = Boolean(args.force || spec.force);
  const allowLocalFallback = Boolean(args["allow-local-fallback"] || spec.allowLocalFallback || truthyEnv(process.env.PPT_TOOL_ALLOW_LOCAL_ASSET_FALLBACK));
  const outDir = pathWithinPage(pageDir, args["out-dir"] || spec.outDir || path.join("assets", "generated"));
  const promptDir = pathWithinPage(pageDir, args["prompt-dir"] || spec.promptDir || path.join("prompts", "image-assets"));
  const jsonlPath = pathWithinPage(pageDir, args.jsonl || spec.jsonl || path.join("prompts", "visual-asset-batch.jsonl"));

  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir(promptDir, { recursive: true });
  await fs.mkdir(path.dirname(jsonlPath), { recursive: true });

  const batchLines = [];
  const planned = [];
  for (const job of jobs) {
    const promptFile = path.join(promptDir, `${job.id}.prompt.txt`);
    await fs.writeFile(promptFile, job.prompt, "utf8");
    const outName = job.out || `${job.id}.png`;
    const batchJob = {
      prompt: job.prompt,
      out: outName,
      ...(job.image ? { image: resolveInputImage(pageDir, job.image) } : {}),
      ...(job.images?.length ? { images: job.images.map((item) => resolveInputImage(pageDir, item)) } : {}),
      ...(job.mask ? { mask: resolveInputImage(pageDir, job.mask) } : {}),
      ...(job.fields ? { fields: job.fields } : {}),
      ...pickDefined({
        n: job.n,
        size: job.size,
        quality: job.quality,
        background: job.background,
        output_format: job.outputFormat || job.output_format,
        output_compression: job.outputCompression || job.output_compression,
        moderation: job.moderation,
        use_case: job.useCase || job.use_case,
        scene: job.scene,
        subject: job.subject,
        style: job.style,
        composition: job.composition,
        lighting: job.lighting,
        palette: job.palette,
        materials: job.materials,
        text: job.text,
        constraints: job.constraints,
        negative: job.negative
      })
    };
    batchLines.push(JSON.stringify(batchJob));
    planned.push({
      id: job.id,
      role: job.role,
      promptFile,
      generated: path.join(outDir, outName),
      importDest: job.dest,
      processSheet: Boolean(job.processSheet)
    });
  }
  await fs.writeFile(jsonlPath, `${batchLines.join("\n")}\n`, "utf8");

  const existingGenerated = planned.map((item) => fsSync.existsSync(item.generated));
  const allGeneratedExist = !dryRun && planned.length > 0 && existingGenerated.every(Boolean);
  const missingGeneratedIndexes = existingGenerated
    .map((exists, index) => exists ? -1 : index)
    .filter((index) => index >= 0);
  let runJsonlPath = jsonlPath;
  let partialResume = false;
  if (!dryRun && !force && existingGenerated.some(Boolean) && !allGeneratedExist) {
    partialResume = true;
    runJsonlPath = pathWithinPage(pageDir, args["pending-jsonl"] || spec.pendingJsonl || path.join("prompts", "visual-asset-batch.pending.jsonl"));
    await fs.writeFile(runJsonlPath, `${missingGeneratedIndexes.map((index) => batchLines[index]).join("\n")}\n`, "utf8");
  }
  const shouldForceBatch = force;
  const imageModel = String(spec.model || args.model || process.env.IMAGE_TO_EDITABLE_PPT_IMAGE_MODEL || process.env.OPENAI_IMAGE_MODEL || process.env.CLOUD_IMAGE_MODEL || "gpt-image-2").trim();
  const defaultSize = imageModel && !imageModel.includes("gpt-image-2") ? "auto" : "";
  const batchArgs = ["image", "batch", "--input", runJsonlPath, "--out-dir", outDir, "--concurrency", String(spec.concurrency || args.concurrency || 2)];
  for (const [flag, value] of [
    ["--size", spec.size || args.size || defaultSize],
    ["--quality", spec.quality || args.quality],
    ["--background", spec.background || args.background],
    ["--output-format", spec.outputFormat || spec.output_format || args["output-format"]],
    ["--model", imageModel]
  ]) {
    if (value) batchArgs.push(flag, String(value));
  }
  if (shouldForceBatch) batchArgs.push("--force");
  if (dryRun) batchArgs.push("--dry-run");
  let localFallback = false;
  let reusedExistingOutputs = false;
  try {
    if (allGeneratedExist && !force) {
      reusedExistingOutputs = true;
      console.warn("All visual asset outputs already exist; reusing them for import.");
    } else {
      await runEditppt(batchArgs);
    }
  } catch (error) {
    if (dryRun || !allowLocalFallback || !canUseLocalAssetSeparation(jobs)) {
      error.message = [
        error.message || "editppt image asset generation failed",
        allowLocalFallback
          ? ""
          : "Local asset fallback is disabled. Re-run with --allow-local-fallback or PPT_TOOL_ALLOW_LOCAL_ASSET_FALLBACK=true only for explicit experimental recovery."
      ].filter(Boolean).join("\n");
      throw error;
    }
    await localAssetSeparation(pageDir, jobs, outDir);
    localFallback = true;
  }

  const imported = [];
  const processed = [];
  if (!dryRun) {
    for (const job of jobs) {
      const generatedPath = path.join(outDir, job.out || `${job.id}.png`);
      if (!fsSync.existsSync(generatedPath)) throw new Error(`Generated image not found for ${job.id}: ${generatedPath}`);
      if (job.import !== false) {
        const dest = normalizeRelativePath(job.dest || path.join("assets", job.out || `${job.id}.png`));
        await runEditppt(["image", "import", pageDir, "--job-id", job.id, "--source-image", generatedPath, "--dest", dest, "--role", job.role || "asset", "--prompt-file", path.join(promptDir, `${job.id}.prompt.txt`), "--note", job.note || "visual asset helper import"]);
        imported.push({ id: job.id, source: generatedPath, dest });
      }
      if (job.processSheet) {
        const sheet = normalizeRelativePath(job.processSheet.assetSheetSource || job.dest || path.join("assets", job.out || `${job.id}.png`));
        const processArgs = ["image", "process-sheet", pageDir, "--job-id", job.id, "--asset-sheet-source", sheet];
        appendProcessSheetArgs(processArgs, job.processSheet);
        await runEditppt(processArgs);
        processed.push({ id: job.id, assetSheetSource: sheet, assetsDir: job.processSheet.assetsDir || job.processSheet.assets_dir || "" });
      }
    }
  }

  const report = {
    ok: true,
    dryRun,
    pageDir,
    spec: specPath,
    jsonl: jsonlPath,
    runJsonl: runJsonlPath,
    outDir,
    planned,
    imported,
    processed,
    localFallback,
    allowLocalFallback,
    reusedExistingOutputs,
    partialResume
  };
  await fs.writeFile(pathWithinPage(pageDir, args.report || spec.report || path.join("logs", "visual-asset-helper-report.json")), JSON.stringify(report, null, 2), "utf8").catch(async () => {
    await fs.mkdir(path.join(pageDir, "logs"), { recursive: true });
    await fs.writeFile(path.join(pageDir, "logs", "visual-asset-helper-report.json"), JSON.stringify(report, null, 2), "utf8");
  });
  console.log(JSON.stringify(report, null, 2));
}

function appendProcessSheetArgs(args, options = {}) {
  const pairs = [
    ["--assets-dir", options.assetsDir || options.assets_dir],
    ["--asset-names", Array.isArray(options.assetNames) ? options.assetNames.join(",") : options.assetNames || options.asset_names],
    ["--split-sort", options.splitSort || options.split_sort],
    ["--split-min-area", options.splitMinArea || options.split_min_area],
    ["--split-merge-gap", options.splitMergeGap || options.split_merge_gap],
    ["--split-merge-union-growth", options.splitMergeUnionGrowth || options.split_merge_union_growth],
    ["--split-manifest", options.splitManifest || options.split_manifest],
    ["--chroma", options.chroma],
    ["--alpha", options.alpha]
  ];
  for (const [flag, value] of pairs) {
    if (value !== undefined && value !== "") args.push(flag, String(value));
  }
  if (options.skipChroma || options.skip_chroma) args.push("--skip-chroma");
  if (options.forceChroma || options.force_chroma) args.push("--force-chroma");
  if (options.despill) args.push("--despill");
  if (options.skipSplit || options.skip_split) args.push("--skip-split");
  if (options.squareAssets || options.square_assets) args.push("--square-assets");
}

function normalizeJobs(jobs) {
  if (!Array.isArray(jobs)) return [];
  return jobs.map((job, index) => {
    const id = normalizeId(job.id || job.jobId || `asset_${index + 1}`);
    const prompt = String(job.prompt || "").trim();
    if (!prompt) throw new Error(`Missing prompt for visual asset job: ${id}`);
    return {
      ...job,
      id,
      prompt,
      role: String(job.role || (job.processSheet ? "asset_sheet" : "asset")).trim(),
      image: job.image || (job.type === "edit" ? "source.png" : ""),
      images: Array.isArray(job.images) ? job.images : []
    };
  });
}

function resolveExistingDir(value) {
  const dir = path.resolve(String(value || ""));
  if (!dir || !fsSync.existsSync(dir) || !fsSync.statSync(dir).isDirectory()) {
    throw new Error("Missing --page-dir or PPT_WORKER_PAGE_DIR");
  }
  return dir;
}

function resolveInputImage(pageDir, value) {
  const input = String(value || "");
  const resolved = path.isAbsolute(input) ? path.resolve(input) : path.resolve(pageDir, input);
  if (!fsSync.existsSync(resolved)) throw new Error(`Input image not found: ${resolved}`);
  return resolved;
}

function pathWithinPage(pageDir, value) {
  const relative = normalizeRelativePath(value);
  const resolved = path.resolve(pageDir, relative);
  const root = path.resolve(pageDir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path escapes page directory: ${value}`);
  }
  return resolved;
}

function normalizeRelativePath(value) {
  const text = String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!text || path.isAbsolute(text) || text.includes("..")) throw new Error(`Expected page-relative path: ${value}`);
  return text;
}

async function runEditppt(args) {
  const editpptEnv = normalizeEditpptApiEnv(process.env);
  const { stdout, stderr } = await execFileAsync(EDITPPT_PYTHON, ["-m", "editppt.cli", ...args], {
    cwd: PROJECT_ROOT,
    windowsHide: true,
    encoding: "utf8",
    env: {
      ...editpptEnv,
      PYTHONPATH: [CLI_PATH, editpptEnv.PYTHONPATH].filter(Boolean).join(path.delimiter),
      PYTHONIOENCODING: "utf-8"
    }
  });
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}

function normalizeEditpptApiEnv(env = {}) {
  const next = { ...env };
  if (!next.OPENAI_API_KEY && next.PROVIDER_API_KEY) next.OPENAI_API_KEY = next.PROVIDER_API_KEY;
  if (!next.IMAGE_TO_EDITABLE_PPT_IMAGE_MODEL) {
    next.IMAGE_TO_EDITABLE_PPT_IMAGE_MODEL = next.OPENAI_IMAGE_MODEL || next.CLOUD_IMAGE_MODEL || "gpt-image-2";
  }
  if (next.OPENAI_BASE_URL) {
    next.OPENAI_BASE_URL = normalizeOpenAiCompatibleBaseUrl(next.OPENAI_BASE_URL);
  } else if (next.PROVIDER_BASE_URL) {
    next.OPENAI_BASE_URL = normalizeOpenAiCompatibleBaseUrl(next.PROVIDER_BASE_URL);
  }
  return next;
}

function normalizeOpenAiCompatibleBaseUrl(value = "") {
  const normalized = String(value || "").trim().replace(/\/+$/, "");
  if (!normalized || /\/v\d+(\/|$)/.test(normalized)) return normalized;
  return `${normalized}/v1`;
}

function canUseLocalAssetSeparation(jobs) {
  return Array.isArray(jobs) && jobs.length > 0 && jobs.every((job) => {
    const box = job.source_box_px || job.sourceBoxPx || job.box_px;
    return job.local_cleanup || (Array.isArray(box) && box.length === 4 && box.every((item) => Number.isFinite(Number(item))));
  });
}

async function localAssetSeparation(pageDir, jobs, outDir) {
  const cropScript = [
    "import json, sys",
    "from pathlib import Path",
    "from PIL import Image",
    "src = Path(sys.argv[1])",
    "out = Path(sys.argv[2])",
    "box = [int(round(float(x))) for x in json.loads(sys.argv[3])]",
    "img = Image.open(src).convert('RGBA')",
    "w, h = img.size",
    "x, y, bw, bh = box",
    "x = max(0, min(x, w - 1))",
    "y = max(0, min(y, h - 1))",
    "bw = max(1, min(bw, w - x))",
    "bh = max(1, min(bh, h - y))",
    "out.parent.mkdir(parents=True, exist_ok=True)",
    "img.crop((x, y, x + bw, y + bh)).save(out)"
  ].join("; ");
  const cleanupScript = [
    "import sys",
    "from pathlib import Path",
    "import cv2",
    "import numpy as np",
    "src = Path(sys.argv[1])",
    "out = Path(sys.argv[2])",
    "img = cv2.imread(str(src), cv2.IMREAD_COLOR)",
    "if img is None: raise SystemExit('source image not readable')",
    "h, w = img.shape[:2]",
    "mask = np.zeros((h, w), dtype=np.uint8)",
    "b, g, r = cv2.split(img)",
    "blue = ((b > 120) & (g > 70) & (r < 120)).astype(np.uint8) * 255",
    "mask = cv2.bitwise_or(mask, blue)",
    "gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)",
    "dark = (gray < 75).astype(np.uint8) * 255",
    "zones = [(50,35,380,205),(0,285,245,380),(35,545,455,650),(700,155,1170,255)]",
    "for x1,y1,x2,y2 in zones:",
    "    x1=max(0,min(x1,w)); x2=max(0,min(x2,w)); y1=max(0,min(y1,h)); y2=max(0,min(y2,h))",
    "    mask[y1:y2, x1:x2] = cv2.bitwise_or(mask[y1:y2, x1:x2], dark[y1:y2, x1:x2])",
    "kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5,5))",
    "mask = cv2.dilate(mask, kernel, iterations=2)",
    "clean = cv2.inpaint(img, mask, 5, cv2.INPAINT_TELEA)",
    "out.parent.mkdir(parents=True, exist_ok=True)",
    "cv2.imwrite(str(out), clean)"
  ].join("\n");
  for (const job of jobs) {
    const source = resolveInputImage(pageDir, job.image || "source.png");
    const outName = job.out || `${job.id}.png`;
    const generatedPath = path.join(outDir, outName);
    const box = job.source_box_px || job.sourceBoxPx || job.box_px;
    const script = job.local_cleanup ? cleanupScript : cropScript;
    const args = job.local_cleanup ? ["-c", script, source, generatedPath] : ["-c", script, source, generatedPath, JSON.stringify(box)];
    await execFileAsync(EDITPPT_PYTHON, args, {
      cwd: PROJECT_ROOT,
      windowsHide: true,
      encoding: "utf8"
    });
    console.log(`Locally separated ${generatedPath}`);
  }
}

function pickDefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== ""));
}

function truthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

async function readJson(file) {
  const raw = await fs.readFile(file, "utf8");
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
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

function normalizeId(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "asset";
}

function printHelp() {
  console.log(`Visual asset helper

Usage:
  node scripts/visual-asset-helper.mjs --page-dir <run>/pages/page_001 --spec visual-asset-jobs.json
  node scripts/visual-asset-helper.mjs --page-dir <run>/pages/page_001 --spec visual-asset-jobs.json --allow-local-fallback

Worker environment:
  PPT_WORKER_PAGE_DIR can provide --page-dir.
  PPT_TOOL_ALLOW_LOCAL_ASSET_FALLBACK=true enables experimental local crop/inpaint fallback.

Spec example:
  {
    "concurrency": 2,
    "jobs": [
      {
        "id": "icon_sheet",
        "type": "edit",
        "image": "source.png",
        "role": "asset_sheet",
        "prompt": "Extract every foreground icon from the source into a magenta chroma-key sheet. Preserve source colors, strokes, proportions, and shadows. No readable text.",
        "out": "icon_sheet.png",
        "dest": "assets/icon_sheet.png",
        "processSheet": {
          "assetsDir": "assets/icons",
          "assetNames": ["icon_1", "icon_2"],
          "splitManifest": "assets/icons/split_manifest.json"
        }
      }
    ]
  }

This helper is worker-side only. It does not write manifest.json, page.pptx,
preview.png, validation.json, or page_result.json, and it does not record a page.

By default this helper follows the image-to-editable-ppt contract and uses
editppt image generation/editing. Local crop/inpaint fallback is experimental
and must be explicitly enabled.
`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
