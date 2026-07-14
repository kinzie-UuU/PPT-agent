#!/usr/bin/env node
import "dotenv/config";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { execFile, spawn, spawnSync } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const SKILL_ROOT = process.env.EDITPPT_SKILL_ROOT || path.join(process.env.USERPROFILE || "C:\\Users\\Administrator", ".codex", "skills", "image-to-editable-ppt");
const DEFAULT_EDITPPT_PYTHON = path.join(PROJECT_ROOT, "outputs", "skill-duo-test", "ocr-venv", "Scripts", "python.exe");
const EDITPPT_PYTHON = chooseEditpptPython();
const CLI_PATH = path.join(SKILL_ROOT, "cli");

function chooseEditpptPython() {
  const bundledUserPython = path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "C:\\Users\\Administrator", "AppData", "Local"), "Programs", "Python", "Python313", "python.exe");
  const candidates = [
    process.env.EDITPPT_IMAGE_PYTHON_PATH,
    fsSync.existsSync(bundledUserPython) ? bundledUserPython : "",
    process.env.EDITPPT_PYTHON_PATH,
    process.env.OCR_PYTHON_PATH,
    fsSync.existsSync(DEFAULT_EDITPPT_PYTHON) ? DEFAULT_EDITPPT_PYTHON : "",
    "python"
  ].filter(Boolean);
  const requireOpenAi = Boolean(process.env.OPENAI_API_KEY || process.env.PROVIDER_API_KEY);
  for (const candidate of candidates) {
    if (canImportEditpptRuntime(candidate, { requireOpenAi })) return candidate;
  }
  for (const candidate of candidates) {
    if (canImportEditpptRuntime(candidate, { requireOpenAi: false })) return candidate;
  }
  return candidates[0] || "python";
}

function canImportEditpptRuntime(candidate, { requireOpenAi = false } = {}) {
  const code = requireOpenAi ? "import editppt.cli; import openai" : "import editppt.cli";
  try {
    const result = spawnSync(candidate, ["-c", code], {
      cwd: PROJECT_ROOT,
      windowsHide: true,
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...process.env,
        PYTHONPATH: [CLI_PATH, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
        PYTHONIOENCODING: "utf-8"
      }
    });
    return result.status === 0;
  } catch {
    return false;
  }
}
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
  const maxJobs = clampInteger(args["max-jobs"] || spec.maxJobs || spec.max_jobs || process.env.PPT_EXTERNAL_IMAGE_CALL_BUDGET || process.env.PPT_MAX_VISUAL_ASSET_JOBS, 0, 500, 0);
  const allJobs = normalizeJobs(spec.jobs || spec.assets || []);
  const jobs = maxJobs > 0 ? allJobs.slice(0, maxJobs) : allJobs;
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
  const staleGeneratedIndexes = [];
  for (const job of jobs) {
    const promptFile = path.join(promptDir, `${job.id}.prompt.txt`);
    const outName = job.out || `${job.id}.png`;
    const generated = path.join(outDir, outName);
    const generatedExists = fsSync.existsSync(generated);
    const previousPrompt = fsSync.existsSync(promptFile) ? fsSync.readFileSync(promptFile, "utf8") : "";
    if (generatedExists && previousPrompt !== job.prompt) {
      staleGeneratedIndexes.push(planned.length);
    }
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
      prompt: job.prompt,
      promptFile,
      generated,
      importDest: job.dest,
      sourceBoxPx: coerceAssetJobBox(job),
      processSheet: Boolean(job.processSheet)
    });
  }
  await fs.writeFile(jsonlPath, `${batchLines.join("\n")}\n`, "utf8");

  const staleGenerated = new Set(staleGeneratedIndexes);
  const existingGenerated = planned.map((item, index) => fsSync.existsSync(item.generated) && !staleGenerated.has(index));
  const allGeneratedExist = !dryRun && planned.length > 0 && existingGenerated.every(Boolean);
  const missingGeneratedIndexes = existingGenerated
    .map((exists, index) => exists ? -1 : index)
    .filter((index) => index >= 0);
  const adoptGeneratedAfterMs = parseTimestampMs(args["adopt-generated-after"] || spec.adoptGeneratedAfter || spec.adopt_generated_after);
  if (adoptGeneratedAfterMs > 0) {
    const adopted = planned.filter((item) => wasGeneratedAfter(item.generated, adoptGeneratedAfterMs));
    if (!dryRun) await writeCurrentPromptFiles(adopted);
    const report = {
      ok: true,
      dryRun,
      mode: "adopt-generated-after",
      pageDir,
      spec: specPath,
      adoptGeneratedAfterMs,
      adopted: adopted.map((item) => item.id),
      staleDetected: staleGeneratedIndexes.map((index) => planned[index]?.id).filter(Boolean),
      regenerationRequested: missingGeneratedIndexes.map((index) => planned[index]?.id).filter(Boolean)
    };
    await writeReport(pageDir, args.report || spec.report, report);
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  let runJsonlPath = jsonlPath;
  let partialResume = false;
  if (!dryRun && !force && existingGenerated.some(Boolean) && !allGeneratedExist) {
    partialResume = true;
    runJsonlPath = pathWithinPage(pageDir, args["pending-jsonl"] || spec.pendingJsonl || path.join("prompts", "visual-asset-batch.pending.jsonl"));
    await fs.writeFile(runJsonlPath, `${missingGeneratedIndexes.map((index) => batchLines[index]).join("\n")}\n`, "utf8");
  }
  const shouldForceBatch = force || staleGeneratedIndexes.length > 0;
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
  let batchStartedAtMs = 0;
  try {
    if (allGeneratedExist && !force) {
      reusedExistingOutputs = true;
      console.warn("All visual asset outputs already exist; reusing them for import.");
    } else {
      batchStartedAtMs = Date.now();
      await runEditppt(batchArgs);
    }
  } catch (error) {
    const partiallyGenerated = !dryRun && batchStartedAtMs > 0
      ? planned.filter((item) => wasGeneratedAfter(item.generated, batchStartedAtMs))
      : [];
    if (partiallyGenerated.length) {
      await writeCurrentPromptFiles(partiallyGenerated);
      error.message = [
        error.message || "editppt image asset generation failed",
        `Recorded ${partiallyGenerated.length} successfully regenerated asset prompt sidecar(s); retry will only request remaining stale/missing outputs.`
      ].join("\n");
    }
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
  const postprocessed = [];
  if (!dryRun) {
    await writeCurrentPromptFiles(planned);
    for (const item of planned) {
      const result = await removeCheckerboardTransparencyGrid(item.generated).catch((error) => ({
        ok: false,
        path: item.generated,
        error: error.message || "checkerboard postprocess failed"
      }));
      postprocessed.push(result);
    }
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
    await augmentImagegenJobIndex(pageDir, jobs, planned);
  }

  const report = {
    ok: true,
    dryRun,
    pageDir,
    spec: specPath,
    jsonl: jsonlPath,
    runJsonl: runJsonlPath,
    outDir,
    maxJobs,
    requestedJobs: allJobs.length,
    plannedJobs: jobs.length,
    planned,
    imported,
    processed,
    postprocessed,
    localFallback,
    allowLocalFallback,
    reusedExistingOutputs,
    partialResume,
    staleDetected: staleGeneratedIndexes.map((index) => planned[index]?.id).filter(Boolean),
    regenerationRequested: missingGeneratedIndexes.map((index) => planned[index]?.id).filter(Boolean),
    staleRegenerated: dryRun ? [] : staleGeneratedIndexes.map((index) => planned[index]?.id).filter(Boolean)
  };
  await writeReport(pageDir, args.report || spec.report, report);
  console.log(JSON.stringify(report, null, 2));
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
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

async function writeCurrentPromptFiles(planned = []) {
  for (const item of planned) {
    await fs.writeFile(item.promptFile, item.prompt, "utf8");
  }
}

function wasGeneratedAfter(filePath, startedAtMs) {
  try {
    if (!fsSync.existsSync(filePath)) return false;
    return fsSync.statSync(filePath).mtimeMs >= startedAtMs - 1000;
  } catch {
    return false;
  }
}

function parseTimestampMs(value) {
  if (value === undefined || value === null || value === "") return 0;
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return number;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

async function writeReport(pageDir, reportPath, report) {
  const target = pathWithinPage(pageDir, reportPath || path.join("logs", "visual-asset-helper-report.json"));
  await fs.writeFile(target, JSON.stringify(report, null, 2), "utf8").catch(async () => {
    await fs.mkdir(path.join(pageDir, "logs"), { recursive: true });
    await fs.writeFile(path.join(pageDir, "logs", "visual-asset-helper-report.json"), JSON.stringify(report, null, 2), "utf8");
  });
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

async function augmentImagegenJobIndex(pageDir, jobs = [], planned = []) {
  const file = path.join(pageDir, "imagegen-jobs.json");
  if (!fsSync.existsSync(file)) return;
  let index = {};
  try {
    index = JSON.parse(fsSync.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return;
  }
  const records = Array.isArray(index.jobs) ? index.jobs : [];
  if (!records.length) return;
  const plannedById = new Map(planned.map((item) => [normalizeId(item.id), item]));
  const jobById = new Map(jobs.map((item) => [normalizeId(item.id), item]));
  let changed = false;
  for (const record of records) {
    const id = normalizeId(record.job_id || record.id || "");
    const plannedItem = plannedById.get(id);
    const job = jobById.get(id) || {};
    if (!plannedItem) continue;
    const sourceBox = coerceBox(record.source_box_px)
      || coerceBox(plannedItem.sourceBoxPx)
      || coerceAssetJobBox(job);
    if (sourceBox && !arraysEqual(record.source_box_px, sourceBox)) {
      record.source_box_px = sourceBox;
      changed = true;
    }
    if (!record.prompt_excerpt && plannedItem.prompt) {
      record.prompt_excerpt = String(plannedItem.prompt).replace(/\s+/g, " ").trim().slice(0, 360);
      changed = true;
    }
    const dest = normalizeMaybeRelativePath(job.dest || plannedItem.importDest || record.output || "");
    if (dest && record.output !== dest) {
      record.output = dest;
      changed = true;
    }
  }
  if (changed) {
    index.updated_at = new Date().toISOString();
    await fs.writeFile(file, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  }
}

function normalizeMaybeRelativePath(value) {
  try {
    return value ? normalizeRelativePath(value) : "";
  } catch {
    return "";
  }
}

function coerceBox(value) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const box = value.map(Number);
  return box.every(Number.isFinite) && box[2] > 0 && box[3] > 0 ? box : null;
}

function coerceAssetJobBox(job = {}) {
  return coerceBox(
    job.source_box_px
    || job.source_region_box_px
    || job.source_region_px
    || job.intended_placement_px
    || job.sourceBoxPx
    || job.box_px
    || job.target_box_px
  );
}

function arraysEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((item, index) => Number(item) === Number(right[index]));
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
  await new Promise((resolve, reject) => {
    const child = spawn(EDITPPT_PYTHON, ["-m", "editppt.cli", ...args], {
      cwd: PROJECT_ROOT,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...editpptEnv,
        PYTHONPATH: [CLI_PATH, editpptEnv.PYTHONPATH].filter(Boolean).join(path.delimiter),
        PYTHONIOENCODING: "utf-8"
      }
    });
    let stderrTail = "";
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderrTail = `${stderrTail}${text}`.slice(-2000);
      process.stderr.write(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const error = new Error(`editppt ${args.join(" ")} exited with code ${code ?? ""}${signal ? ` signal ${signal}` : ""}`.trim());
      error.code = code;
      error.signal = signal;
      error.stderr = stderrTail;
      reject(error);
    });
  });
}

async function removeCheckerboardTransparencyGrid(filePath = "") {
  if (!filePath || !fsSync.existsSync(filePath)) return { ok: false, path: filePath, skipped: true, reason: "missing" };
  const code = `
import json, sys
from pathlib import Path
from PIL import Image

path = Path(sys.argv[1])
im = Image.open(path).convert("RGBA")
sample = im.copy()
sample.thumbnail((300, 180))
pixels = sample.load()
sw, sh = sample.size

def grayish(px):
    r, g, b, a = px
    return a > 220 and abs(r - g) < 4 and abs(g - b) < 4 and 175 <= r <= 255

gray = 0
adj = 0
alt = 0
total = max(1, sw * sh)
for y in range(sh):
    for x in range(sw):
        p = pixels[x, y]
        if grayish(p):
            gray += 1
        if x + 1 < sw and grayish(p) and grayish(pixels[x + 1, y]):
            adj += 1
            if abs(p[0] - pixels[x + 1, y][0]) > 12:
                alt += 1
        if y + 1 < sh and grayish(p) and grayish(pixels[x, y + 1]):
            adj += 1
            if abs(p[0] - pixels[x, y + 1][0]) > 12:
                alt += 1

gray_ratio = gray / total
alt_ratio = alt / max(1, adj)
score = gray_ratio * alt_ratio
if not (gray_ratio >= 0.4 and alt_ratio >= 0.09 and score >= 0.045):
    print(json.dumps({"ok": True, "path": str(path), "changed": False, "grayRatio": round(gray_ratio, 3), "alternationRatio": round(alt_ratio, 3), "score": round(score, 3)}, ensure_ascii=False))
    raise SystemExit(0)

data = list(im.getdata())
out = []
changed = 0
for r, g, b, a in data:
    if a > 220 and abs(r - g) < 6 and abs(g - b) < 6 and 175 <= r <= 255:
        out.append((r, g, b, 0))
        changed += 1
    else:
        out.append((r, g, b, a))
im.putdata(out)
im.save(path)
print(json.dumps({"ok": True, "path": str(path), "changed": True, "changedPixels": changed, "totalPixels": len(data), "grayRatio": round(gray_ratio, 3), "alternationRatio": round(alt_ratio, 3), "score": round(score, 3)}, ensure_ascii=False))
`;
  const { stdout } = await execFileAsync(EDITPPT_PYTHON, ["-c", code, filePath], {
    cwd: PROJECT_ROOT,
    windowsHide: true,
    encoding: "utf8",
    timeout: 120000,
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8"
    }
  });
  return JSON.parse(String(stdout || "{}"));
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
  if (next.OPENAI_API_KEY && next.OPENAI_BASE_URL && !next.PPT_TOOL_ALLOW_CODEX_OAUTH_IMAGE_BACKEND) {
    // Keep Route B visual assets on the configured API backend; the desktop OAuth
    // image backend can reject batch image_generation tool calls in this runtime.
    next.CODEX_AUTH_FILE = path.join(PROJECT_ROOT, ".editppt-api-backend-only", "codex-auth.disabled.json");
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
    const box = job.source_box_px || job.source_region_box_px || job.sourceBoxPx || job.box_px;
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
    const box = job.source_box_px || job.source_region_box_px || job.sourceBoxPx || job.box_px;
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
