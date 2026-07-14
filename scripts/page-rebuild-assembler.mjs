#!/usr/bin/env node
import "dotenv/config";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { execFile, spawnSync } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const SKILL_ROOT = process.env.EDITPPT_SKILL_ROOT || path.join(process.env.USERPROFILE || "C:\\Users\\Administrator", ".codex", "skills", "image-to-editable-ppt");
const DEFAULT_EDITPPT_PYTHON = path.join(PROJECT_ROOT, "outputs", "skill-duo-test", "ocr-venv", "Scripts", "python.exe");
const EDITPPT_PYTHON = chooseEditpptPython();
const CLI_PATH = path.join(SKILL_ROOT, "cli");
const REQUIRED_QUALITY_CHECKS = [
  "font_size_calibrated",
  "visual_inventory_matched",
  "background_strategy_checked",
  "shape_corner_geometry_checked"
];
const DEFAULT_PREVIEW_FONT = firstExistingPath([
  "C:\\Windows\\Fonts\\msyh.ttc",
  "C:\\Windows\\Fonts\\simhei.ttf",
  "C:\\Windows\\Fonts\\simsun.ttc",
  "C:\\Windows\\Fonts\\arial.ttf"
]);
const ALLOWED_SOURCE_TYPES = new Set(["asset-sheet-separated", "imagegen", "latex-rendered-formula", "user-provided", "user-approved-rasterization"]);
const FOREGROUND_ASSET_TERMS = /(icon|photo|logo|screenshot|badge|sticker|stamp|device|illustration|mark|brand|visual object|laurel|leaf|leaves|award|trophy)/i;
const FORBIDDEN_FALLBACK_TERMS = /\b(crop|approximation|fallback|emoji)\b|裁剪|近似|降级/i;
const FOREGROUND_TERMS = /\b(icon|photo|logo|screenshot|badge|sticker|stamp|device|illustration|mark|brand|brand mark|brand block|laurel|leaf|leaves|award|trophy)\b|图标|照片|徽标|截图|贴纸|标记/i;
const ASSET_SEPARATION_TERMS = /asset-sheet-separated|asset-sheet separated|asset sheet separated|image edit|separated|user-approved|user approved|rasterization|imagegen|分离/i;
const STRUCTURAL_TERMS = /native structural|结构|background|formula|divider|rule|grid|panel|card|pagination|native background|arc|circle|ellipse|bullet|line|border|curve|stroke|sweep/i;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const pageDir = resolveExistingDir(args["page-dir"] || process.env.PPT_WORKER_PAGE_DIR || "");
  const specPath = path.resolve(args.spec || path.join(pageDir, "page-rebuild-spec.json"));
  if (!fsSync.existsSync(specPath)) throw new Error(`Page rebuild spec not found: ${specPath}`);
  guardRecordedPageOverwrite(pageDir, args);
  const spec = await readJson(specPath);
  const pageRequest = await readJson(path.join(pageDir, "page_request.json"));

  try {
    const manifest = buildManifest({ pageDir, pageRequest, spec, specPath });
    validateManifestDraft({ pageDir, manifest });
    await writeJson(path.join(pageDir, "manifest.json"), manifest);
    await ensureImagegenJobs(pageDir, manifest.page_id, pageRequest.run_id);
    await runEditppt(["page", "build", pageDir]);
    await runEditppt(["page", "contact-sheet", pageDir]);
    await runEditppt(["page", "validate", pageDir, "--report", "validation.json"]);
    if (envTruthy(process.env.PPT_TOOL_REWRITE_PAGE_PPTX_FOR_POWERPOINT)) {
      await rewritePagePptxForPowerPoint(pageDir);
    }
    const validation = await readJson(path.join(pageDir, "validation.json"));
    const fallbackMarker = await readJson(path.join(pageDir, "page-spec-fallback.json")).catch(() => null);
    const preRecoverySpec = await readJson(`${specPath}.before-complex-recovery.json`).catch(() => null);
    const sourceFidelityRecovery = isTrustedSourceFidelityMarker(fallbackMarker, pageDir, { pageRequest, specPath }) && hasSourceFidelityTiles(manifest);
    const fallbackDetected = !sourceFidelityRecovery && (
      fallbackMarker?.fallback === "no-image-page-spec"
      || hasNoImageFallbackEvidence(spec, pageDir)
      || hasNoImageFallbackEvidence(manifest, pageDir)
      || hasNoImageFallbackEvidence(preRecoverySpec, pageDir, manifest)
    );
    if (fallbackDetected) {
      const reason = "No-image page spec fallback requires visual review and cannot be recorded as a product-grade editable page.";
      await writeJson(path.join(pageDir, "validation.json"), {
        ...validation,
        passed: false,
        status: "needs_visual_review",
        reason,
        fallback: fallbackMarker || { fallback: "no-image-page-spec", reason: "manifest-or-spec-no-image-evidence" },
        createdAt: validation.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      await writePageResult(pageDir);
      throw new Error(reason);
    }
    await writePageResult(pageDir);
    if (validation.passed !== true) {
      throw new Error("editppt page validate did not produce top-level passed=true");
    }
    console.log(JSON.stringify({
      ok: true,
      pageId: manifest.page_id,
      pageDir,
      manifest: path.join(pageDir, "manifest.json"),
      validation: path.join(pageDir, "validation.json"),
      textBoxes: manifest.text_boxes.length,
      shapes: manifest.shapes.length,
      images: manifest.images.length
    }, null, 2));
  } catch (error) {
    await writeFailure(pageDir, error.message || String(error));
    throw error;
  }
}

function hasNoImageFallbackEvidence(value = {}, pageDir = "", resolvedValue = value) {
  const text = [
    value?.background_strategy?.mode,
    value?.background_strategy?.source_consistency_contract,
    value?.background_strategy?.comparison_note,
    value?.notes,
    ...(Array.isArray(value?.warnings) ? value.warnings : []),
    value?.reason,
    value?.error,
    typeof value?.fallback === "string" ? value.fallback : value?.fallback?.reason
  ].filter(Boolean).join(" ");
  if (isOnlyResolvedOmittedAssetEvidence(text, resolvedValue, pageDir)) return false;
  return /--no-image|\bno-image\b|text-only-ocr-spec|requires visual pass before production|requires product visual review|asset-hydrated recovery|requires-asset-separation|intentionally fails pass|omitted unavailable generated image assets/i.test(text);
}

function isTrustedSourceFidelityMarker(fallbackMarker = null, pageDir = "", context = {}) {
  const pageRequest = context.pageRequest || readJsonIfExists(path.join(pageDir, "page_request.json")) || {};
  const pageId = normalizePageId(pageRequest.page_id || path.basename(pageDir));
  const expectedJobId = String(process.env.PPT_WORKFLOW_JOB_ID || deriveWorkflowJobId(pageDir) || "").trim();
  const expectedRunId = String(pageRequest.run_id || "").trim();
  return envTruthy(process.env.PPT_TOOL_USE_SOURCE_FIDELITY_BACKGROUND)
    && fallbackMarker?.schemaVersion === 1
    && fallbackMarker?.createdBy === "model-page-worker-pipeline"
    && fallbackMarker?.fallback === "source-fidelity-background-recovery"
    && fallbackMarker?.reason === "visual-asset-budget-exhausted"
    && normalizePageId(fallbackMarker?.pageId || "") === pageId
    && normalizePageId(fallbackMarker?.pageDirName || "") === normalizePageId(path.basename(pageDir))
    && String(fallbackMarker?.specFile || "") === path.basename(context.specPath || "page-rebuild-spec.json")
    && expectedJobId
    && String(fallbackMarker?.jobId || "") === expectedJobId
    && expectedRunId
    && String(fallbackMarker?.runId || "") === expectedRunId;
}

function hasSourceFidelityTiles(manifest = {}) {
  const provenance = Array.isArray(manifest?.asset_provenance) ? manifest.asset_provenance : [];
  const images = Array.isArray(manifest?.images) ? manifest.images : [];
  const tileCount = provenance.filter((item) => {
    const pathValue = normalizeAssetPath(item?.path || "");
    return /^assets\/source_fidelity_tile_\d+\.png$/i.test(pathValue)
      && item?.source_type === "user-approved-rasterization"
      && item?.approval_note;
  }).length;
  const imageTileCount = images.filter((item) => /^assets\/source_fidelity_tile_\d+\.png$/i.test(normalizeAssetPath(item?.path || ""))).length;
  return tileCount >= 4 && imageTileCount >= 4;
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

function isOnlyResolvedOmittedAssetEvidence(text = "", value = {}, pageDir = "") {
  const omittedPattern = /Omitted unavailable generated image assets:\s*([a-zA-Z0-9_,\s-]+)\./gi;
  const stripped = String(text || "").replace(omittedPattern, "");
  if (/--no-image|\bno-image\b|text-only-ocr-spec|requires visual pass before production|requires product visual review|asset-hydrated recovery|requires-asset-separation|intentionally fails pass|omitted unavailable generated image assets/i.test(stripped)) {
    return false;
  }
  const ids = [];
  for (const match of String(text || "").matchAll(omittedPattern)) {
    ids.push(...String(match[1] || "").split(",").map((item) => normalizePageId(item)).filter(Boolean));
  }
  if (!ids.length || !pageDir) return false;
  const jobsById = readRecordedImagegenJobs(pageDir);
  const imagePaths = new Set((Array.isArray(value?.images) ? value.images : []).map((image) => normalizeAssetPath(image?.path || "")).filter(Boolean));
  const provenancePaths = new Set((Array.isArray(value?.asset_provenance) ? value.asset_provenance : []).map((item) => normalizeAssetPath(item?.path || "")).filter(Boolean));
  return [...new Set(ids)].every((id) => {
    const job = jobsById.get(id.toLowerCase());
    const output = normalizeAssetPath(job?.output || "");
    return output
      && fsSync.existsSync(path.join(pageDir, output))
      && imagePaths.has(output)
      && provenancePaths.has(output);
  });
}

function readRecordedImagegenJobs(pageDir = "") {
  const map = new Map();
  try {
    const jobsPath = path.join(pageDir, "imagegen-jobs.json");
    if (!fsSync.existsSync(jobsPath)) return map;
    const data = JSON.parse(fsSync.readFileSync(jobsPath, "utf8").replace(/^\uFEFF/, ""));
    for (const job of Array.isArray(data?.jobs) ? data.jobs : []) {
      const id = normalizePageId(job?.job_id || job?.id || "");
      const output = normalizeAssetPath(job?.output || "");
      if (!id || String(job?.status || "").toLowerCase() !== "recorded" || !output) continue;
      if (!fsSync.existsSync(path.join(pageDir, output))) continue;
      map.set(id.toLowerCase(), job);
    }
  } catch {
    return new Map();
  }
  return map;
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
    const page = (Array.isArray(pageJobs.pages) ? pageJobs.pages : []).find((item) => normalizePageId(item.page_id || item.pageId || "") === normalizePageId(pageId));
    if (!page) return null;
    return {
      pageId,
      status: String(page.status || "").toLowerCase()
    };
  } catch {
    return null;
  }
}

function buildManifest({ pageDir, pageRequest, spec, specPath = "" }) {
  const width = Number(pageRequest.source_size_px?.width || pageRequest.source?.width_px || spec.source?.width_px || 0);
  const height = Number(pageRequest.source_size_px?.height || pageRequest.source?.height_px || spec.source?.height_px || 0);
  if (!width || !height) throw new Error("page_request.json must provide source_size_px width and height.");
  const hydratedSpec = materializeSourceFidelityBackground({
    pageDir,
    spec: materializeComplexDecorationAssets({ pageDir, spec, width, height }),
    pageRequest,
    specPath,
    width,
    height
  });
  const normalizedImages = normalizeImages(hydratedSpec.images || [], width, height, pageDir)
    .sort((a, b) => Number(a.z_index || 0) - Number(b.z_index || 0));
  const normalizedProvenance = Array.isArray(hydratedSpec.asset_provenance) ? hydratedSpec.asset_provenance.map(normalizeProvenance).filter(hasUsableProvenance) : [];
  const reconciledAssets = reconcileImagegenAssetPaths({
    pageDir,
    images: normalizedImages,
    provenance: normalizedProvenance,
    visualInventory: hydratedSpec.visual_inventory
  });
  const usableAssets = omitMissingGeneratedImageAssets({
    pageDir,
    images: reconciledAssets.images,
    provenance: reconciledAssets.provenance,
    visualInventory: reconciledAssets.visualInventory,
    initialWarnings: reconciledAssets.warnings
  });
  const images = usableAssets.images;
  const textBoxes = filterTextBoxesCoveredByImages(normalizeTextBoxes(spec.text_boxes || [], width, height), images, { width, height });
  const shapes = avoidThinHorizontalLineTextOverlap(normalizeShapes(hydratedSpec.shapes || [], width, height), textBoxes, height);
  const visualInventory = filterUnbackedForegroundInventory(normalizeVisualInventory(usableAssets.visualInventory, images), images);
  const requiredText = normalizeRequiredTextForRemainingBoxes(
    Array.isArray(spec.required_text) ? spec.required_text.map(normalizeTextContent).filter(Boolean) : collectRequiredText(spec.text_boxes || []),
    textBoxes
  );

  return {
    schema_version: 1,
    page_id: pageRequest.page_id || spec.page_id || normalizePageId(path.basename(pageDir)),
    strategy: cleanString(spec.strategy || "worker-page-rebuild-spec"),
    page_strategy: cleanString(spec.page_strategy || spec.strategy || "worker-page-rebuild-spec"),
    slide: pageRequest.slide || spec.slide,
    content_box: pageRequest.content_box || spec.content_box,
    source: {
      path: "source.png",
      width_px: width,
      height_px: height
    },
    text_inventory: normalizeTextInventory(spec.text_inventory),
    visual_inventory: visualInventory,
    background_strategy: spec.background_strategy || {},
    quality_checks: spec.quality_checks || {},
    required_text: requiredText,
    text_boxes: textBoxes,
    shapes,
    images,
    asset_provenance: usableAssets.provenance,
    formula_inventory: Array.isArray(spec.formula_inventory) ? spec.formula_inventory : [],
    notes: cleanString(spec.notes || "Generated by page-rebuild-assembler.mjs from worker-authored page-rebuild-spec.json."),
    warnings: usableAssets.warnings,
    page_dir: pageDir
  };
}

function validateManifestDraft({ pageDir, manifest }) {
  const errors = [];
  if (!manifest.slide) errors.push("manifest.slide is required.");
  if (!manifest.content_box) errors.push("manifest.content_box is required.");
  for (const key of REQUIRED_QUALITY_CHECKS) {
    if (manifest.quality_checks?.[key] !== true) errors.push(`quality_checks.${key} must be true.`);
  }
  if (!manifest.background_strategy?.mode) errors.push("background_strategy.mode is required.");
  if (!manifest.background_strategy?.source_consistency_contract) errors.push("background_strategy.source_consistency_contract is required.");
  if (!manifest.background_strategy?.comparison_note) errors.push("background_strategy.comparison_note is required.");

  for (const box of manifest.text_boxes) {
    if (!box.text) errors.push(`text box ${box.id || ""} is missing text.`);
    if (!validBox(box.box_px)) errors.push(`text box ${box.id || box.text || ""} is missing valid box_px.`);
  }
  for (const shape of manifest.shapes) {
    if (shape.type === "line") {
      if (!validPoints(shape.points_px)) errors.push(`line shape ${shape.id || ""} is missing valid points_px.`);
    } else if (!validBox(shape.box_px)) {
      errors.push(`shape ${shape.id || ""} is missing valid box_px.`);
    }
    if (shape.type === "roundRect" && !Number.isFinite(Number(shape.source_corner_radius_px))) {
      errors.push(`roundRect ${shape.id || ""} is missing source_corner_radius_px.`);
    }
  }

  const provenanceByPath = new Map(manifest.asset_provenance.map((item) => [normalizeAssetPath(item.path), item]));
  for (const image of manifest.images) {
    const imagePath = normalizeAssetPath(image.path);
    if (!imagePath) errors.push(`image ${image.id || ""} is missing path.`);
    if (imagePath === "source.png") errors.push(`image ${image.id || ""} uses source.png directly; full-slide source fallback is forbidden.`);
    if (!validBox(image.box_px)) errors.push(`image ${image.id || imagePath} is missing valid box_px.`);
    if (imagePath && !fsSync.existsSync(path.join(pageDir, imagePath))) errors.push(`image file does not exist: ${imagePath}`);
    const provenance = provenanceByPath.get(imagePath);
    if (!provenance) {
      errors.push(`image ${imagePath} is missing matching asset_provenance.`);
    } else {
      validateProvenance(pageDir, provenance, errors);
    }
  }
  for (const provenance of manifest.asset_provenance) {
    validateProvenance(pageDir, provenance, errors);
  }

  const scanTexts = [
    ...manifest.visual_inventory.map((item) => typeof item === "string" ? item : JSON.stringify(item)),
    ...manifest.asset_provenance.map((item) => JSON.stringify(item))
  ];
  for (const text of scanTexts) {
    if (FORBIDDEN_FALLBACK_TERMS.test(text)) errors.push(`Forbidden fallback wording found: ${text.slice(0, 120)}`);
    if (FOREGROUND_TERMS.test(text) && !ASSET_SEPARATION_TERMS.test(text) && !STRUCTURAL_TERMS.test(text)) {
      errors.push(`Foreground inventory/provenance must state asset-sheet separation or image edit: ${text.slice(0, 120)}`);
    }
  }
  const missingForegroundAssets = collectMissingForegroundAssets(manifest);
  if (missingForegroundAssets.length) {
    errors.push(`Foreground visual inventory requires real image assets/provenance: ${missingForegroundAssets.join(", ")}`);
  }
  errors.push(...collectVisualCoverageIssues(manifest));

  if (errors.length) throw new Error(errors.join(" | "));
}

function materializeSourceFidelityBackground({ pageDir, spec = {}, pageRequest = {}, specPath = "", width = 0, height = 0 } = {}) {
  const fallbackMarker = readJsonIfExists(path.join(pageDir, "page-spec-fallback.json"));
  if (!isTrustedSourceFidelityMarker(fallbackMarker, pageDir, { pageRequest, specPath })) return spec;
  if (process.env.PPT_TOOL_ALLOW_SOURCE_FIDELITY_RASTER_RECOVERY !== "1") {
    throw new Error("Source-fidelity tiled raster recovery is disabled for product Route B; rebuild with separated assets/native objects instead.");
  }
  const sourcePath = path.join(pageDir, "source.png");
  if (!fsSync.existsSync(sourcePath)) return spec;
  const assetsDir = path.join(pageDir, "assets");
  fsSync.mkdirSync(assetsDir, { recursive: true });
  const tiles = createSourceFidelityTiles({ sourcePath, assetsDir, width, height });
  if (!tiles.length) return spec;
  const tileImages = tiles.map((tile, index) => ({
    id: tile.id,
    path: tile.path,
    box_px: tile.box,
    alt: `source faithful tile ${index + 1}`,
    z_index: index
  }));
  const tileProvenance = tiles.map((tile) => ({
    path: tile.path,
    source: "source.png",
    source_type: "user-approved-rasterization",
    provenance_note: "User approved source-faithful tiled raster region for complex visual preservation; editable text and native objects remain layered above it.",
    approval_note: "Used only for visual QA recovery when object-level asset separation is insufficient."
  }));
  const tileInventory = tiles.map((tile, index) => ({
    id: tile.id,
    type: "image",
    description: `Source-faithful tiled visual region ${index + 1} for complex page recovery.`,
    box_px: tile.box,
    path: tile.path,
    asset_provenance: {
      source_type: "user-approved-rasterization",
      provenance_note: tileProvenance[index].provenance_note
    }
  }));
  return {
    ...spec,
    strategy: `${cleanString(spec.strategy || "worker-page-rebuild-spec")}-source-fidelity-background`,
    background_strategy: {
      ...(spec.background_strategy || {}),
      mode: "user-approved-raster-background-with-editable-overlays",
      source_consistency_contract: spec.background_strategy?.source_consistency_contract
        || "Preserve the codex-ppt target page as a source-faithful background while keeping editable overlays.",
      comparison_note: spec.background_strategy?.comparison_note
        || "Complex visual page recovered with source-faithful background plus editable text/object layers."
    },
    images: [...tileImages, ...(Array.isArray(spec.images) ? spec.images : [])],
    asset_provenance: [...tileProvenance, ...(Array.isArray(spec.asset_provenance) ? spec.asset_provenance : [])],
    visual_inventory: [
      ...tileInventory,
      ...(Array.isArray(spec.visual_inventory) ? spec.visual_inventory : [])
    ],
    notes: `${cleanString(spec.notes || "")} Source-fidelity background recovery enabled for this page.`.trim()
  };
}

function createSourceFidelityTiles({ sourcePath = "", assetsDir = "", width = 0, height = 0 } = {}) {
  const script = [
    "from PIL import Image",
    "import os, sys",
    "source, out_dir = sys.argv[1], sys.argv[2]",
    "im = Image.open(source).convert('RGB')",
    "w, h = im.size",
    "boxes = [(0,0,w//2,h//2),(w//2,0,w,h//2),(0,h//2,w//2,h),(w//2,h//2,w,h)]",
    "for i, box in enumerate(boxes, 1):",
    "    im.crop(box).save(os.path.join(out_dir, f'source_fidelity_tile_{i}.png'))"
  ].join("\n");
  const result = spawnSync(EDITPPT_PYTHON, ["-c", script, sourcePath, assetsDir], {
    cwd: PROJECT_ROOT,
    windowsHide: true,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`Failed to create source fidelity tiles: ${result.stderr || result.stdout || "unknown error"}`);
  }
  const halfW = width / 2;
  const halfH = height / 2;
  return [
    { id: "source_fidelity_tile_1", path: "assets/source_fidelity_tile_1.png", box: [0, 0, halfW, halfH] },
    { id: "source_fidelity_tile_2", path: "assets/source_fidelity_tile_2.png", box: [halfW, 0, halfW, halfH] },
    { id: "source_fidelity_tile_3", path: "assets/source_fidelity_tile_3.png", box: [0, halfH, halfW, halfH] },
    { id: "source_fidelity_tile_4", path: "assets/source_fidelity_tile_4.png", box: [halfW, halfH, halfW, halfH] }
  ].filter((tile) => fsSync.existsSync(path.join(assetsDir, path.basename(tile.path))));
}

function reconcileImagegenAssetPaths({ pageDir, images = [], provenance = [], visualInventory = [] } = {}) {
  const jobs = readImagegenJobs(pageDir);
  const warnings = [];
  if (!jobs.length) {
    return {
      images: Array.isArray(images) ? images : [],
      provenance: Array.isArray(provenance) ? provenance : [],
      visualInventory: Array.isArray(visualInventory) ? visualInventory : [],
      warnings
    };
  }

  const rewrites = new Map();
  const imagesNext = (Array.isArray(images) ? images : []).map((image) => {
    const imagePath = normalizeAssetPath(image.path || "");
    if (!imagePath || fsSync.existsSync(path.join(pageDir, imagePath))) return image;
    const matched = findImagegenJobForMissingAsset({ image, imagePath, jobs, imageCount: images.length });
    if (!matched) return image;
    const actualPath = normalizeAssetPath(matched.output || matched.dest || "");
    if (!actualPath || !fsSync.existsSync(path.join(pageDir, actualPath))) return image;
    rewrites.set(imagePath, actualPath);
    warnings.push(`Reconciled missing image asset ${imagePath} to recorded imagegen output ${actualPath}.`);
    return {
      ...image,
      path: actualPath,
      id: cleanId(image.id || matched.job_id || path.basename(actualPath, path.extname(actualPath))),
      alt: cleanString(image.alt || matched.job_id || image.id || actualPath)
    };
  });

  if (!rewrites.size) {
    return {
      images: imagesNext,
      provenance: Array.isArray(provenance) ? provenance : [],
      visualInventory: Array.isArray(visualInventory) ? visualInventory : [],
      warnings
    };
  }

  const provenanceNext = (Array.isArray(provenance) ? provenance : []).map((item) => {
    const imagePath = normalizeAssetPath(item.path || "");
    const sourcePath = normalizeAssetPath(item.source || "");
    const nextPath = rewrites.get(imagePath) || rewrites.get(sourcePath);
    if (!nextPath) return item;
    return {
      ...item,
      path: nextPath,
      source: nextPath
    };
  });
  const existingProvenancePaths = new Set(provenanceNext.map((item) => normalizeAssetPath(item.path || "")).filter(Boolean));
  for (const actualPath of rewrites.values()) {
    if (existingProvenancePaths.has(actualPath)) continue;
    const job = jobs.find((item) => normalizeAssetPath(item.output || item.dest || "") === actualPath) || {};
    provenanceNext.push({
      path: actualPath,
      source: actualPath,
      source_type: "imagegen",
      provenance_note: cleanString(job.note || "Recorded imagegen asset output reconciled for page rebuild.")
    });
    existingProvenancePaths.add(actualPath);
  }

  const visualInventoryNext = (Array.isArray(visualInventory) ? visualInventory : []).map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const itemPath = normalizeAssetPath(item.path || item.asset_provenance?.path || item.asset_provenance?.source || "");
    const nextPath = rewrites.get(itemPath);
    if (!nextPath) return item;
    return {
      ...item,
      path: nextPath,
      asset_provenance: {
        ...(item.asset_provenance || {}),
        path: nextPath,
        source: nextPath
      }
    };
  });

  return {
    images: imagesNext,
    provenance: provenanceNext,
    visualInventory: visualInventoryNext,
    warnings
  };
}

function readImagegenJobs(pageDir) {
  const file = path.join(pageDir, "imagegen-jobs.json");
  if (!fsSync.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fsSync.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    return (Array.isArray(parsed.jobs) ? parsed.jobs : [])
      .filter((job) => job && typeof job === "object")
      .map((job) => ({
        ...job,
        job_id: cleanId(job.job_id || job.id || ""),
        output: normalizeAssetPath(job.output || job.dest || ""),
        status: cleanString(job.status || "")
      }))
      .filter((job) => job.output && fsSync.existsSync(path.join(pageDir, job.output)));
  } catch {
    return [];
  }
}

function findImagegenJobForMissingAsset({ image = {}, imagePath = "", jobs = [], imageCount = 0 } = {}) {
  const imageId = cleanId(image.id || "");
  const pathBase = cleanId(path.basename(imagePath, path.extname(imagePath)));
  const exact = jobs.find((job) => job.job_id && (job.job_id === imageId || job.job_id === pathBase));
  if (exact) return exact;
  const contains = jobs.find((job) => {
    if (!job.job_id) return false;
    return (imageId && (job.job_id.includes(imageId) || imageId.includes(job.job_id)))
      || (pathBase && (job.job_id.includes(pathBase) || pathBase.includes(job.job_id)));
  });
  if (contains) return contains;
  const likelyGeneratedForeground = /generated_asset|foreground|illustration|cityscape|character|visual|asset/i.test([
    imageId,
    pathBase,
    imagePath,
    image.alt,
    image.description
  ].filter(Boolean).join(" "));
  if (likelyGeneratedForeground && jobs.length === 1) return jobs[0];
  if (Number(imageCount) === 1 && jobs.length === 1) return jobs[0];
  const imageText = JSON.stringify(image).toLowerCase();
  return jobs.find((job) => job.job_id && imageText.includes(job.job_id.toLowerCase())) || null;
}

function omitMissingGeneratedImageAssets({ pageDir, images = [], provenance = [], visualInventory = [], initialWarnings = [] } = {}) {
  const provenanceByPath = new Map((Array.isArray(provenance) ? provenance : []).map((item) => [normalizeAssetPath(item.path), item]));
  const missingGenerated = new Set();
  const warnings = Array.isArray(initialWarnings) ? [...initialWarnings] : [];
  for (const image of Array.isArray(images) ? images : []) {
    const imagePath = normalizeAssetPath(image.path || "");
    if (!imagePath) continue;
    const item = provenanceByPath.get(imagePath);
    if (fsSync.existsSync(path.join(pageDir, imagePath))) continue;
    missingGenerated.add(imagePath);
    warnings.push(`Omitted missing image asset ${imagePath}${item?.source_type ? ` (${item.source_type})` : ""}; page rebuild continues with native/editable objects.`);
  }
  for (const item of Array.isArray(provenance) ? provenance : []) {
    const imagePath = normalizeAssetPath(item.path || "");
    if (!imagePath || missingGenerated.has(imagePath)) continue;
    const sourcePath = normalizeAssetPath(item.source || imagePath);
    const candidates = [imagePath, sourcePath].filter(Boolean).map((candidate) => path.join(pageDir, candidate));
    if (candidates.some((candidate) => fsSync.existsSync(candidate))) continue;
    missingGenerated.add(imagePath);
    warnings.push(`Omitted orphaned missing asset provenance ${imagePath}; page rebuild continues with native/editable objects.`);
  }
  if (!missingGenerated.size) {
    return {
      images: Array.isArray(images) ? images : [],
      provenance: Array.isArray(provenance) ? provenance : [],
      visualInventory: Array.isArray(visualInventory) ? visualInventory : [],
      warnings
    };
  }
  return {
    images: Array.isArray(images) ? images : [],
    provenance: Array.isArray(provenance) ? provenance : [],
    visualInventory: Array.isArray(visualInventory) ? visualInventory : [],
    warnings
  };
}

function filterUnbackedForegroundInventory(items = [], images = []) {
  return Array.isArray(items) ? items : [];
}

function collectVisualCoverageIssues(manifest = {}) {
  const issues = [];
  const visualInventory = Array.isArray(manifest.visual_inventory) ? manifest.visual_inventory : [];
  const shapes = Array.isArray(manifest.shapes) ? manifest.shapes : [];
  const images = Array.isArray(manifest.images) ? manifest.images : [];
  const backgroundText = [
    manifest.background_strategy?.mode,
    manifest.background_strategy?.source_consistency_contract,
    manifest.background_strategy?.comparison_note,
    manifest.notes
  ].filter(Boolean).join(" ");
  const noImageMode = /text-only|ocr-only|no-image/i.test(backgroundText);
  if (noImageMode) return issues;

  const preservationClaim = /preserv|match|consistent|intact|source composition|background|visual elements/i.test(backgroundText);
  const renderableVisuals = shapes.length + images.length;
  const meaningfulShapes = shapes.filter(isMeaningfulVisualShape).length;
  const sourceRasterCoverage = calculateSourceRasterCoverage(images);
  if (sourceRasterCoverage >= 0.85) {
    issues.push(`source-fidelity raster images cover ${(sourceRasterCoverage * 100).toFixed(1)}% of the slide; full-slide raster fallback is forbidden.`);
  }

  if (visualInventory.length > 0 && renderableVisuals === 0) {
    issues.push("visual_inventory lists visible non-text objects but manifest shapes/images are empty.");
  }
  if (preservationClaim && visualInventory.length === 0) {
    issues.push("background_strategy claims source visual preservation but manifest visual_inventory is empty.");
  }
  if (preservationClaim && images.length === 0 && meaningfulShapes < 3 && visualInventory.length < 3) {
    issues.push("background_strategy claims preserved or matched source visuals but manifest has too few meaningful shapes/images.");
  }
  return issues;
}

function calculateSourceRasterCoverage(images = []) {
  const slide = { width: 1920, height: 1080 };
  const sourceImages = images.filter((image) => {
    const text = [
      image.id,
      image.path,
      image.alt,
      image.source,
      image.source_type,
      image.provenance_note
    ].filter(Boolean).join(" ");
    return /source_fidelity|source faithful|source-faithful|source\.png|rasterization/i.test(text);
  });
  if (!sourceImages.length) return 0;
  const area = sourceImages.reduce((sum, image) => {
    const box = Array.isArray(image.box_px) ? image.box_px.map(Number) : [];
    if (box.length !== 4 || !box.every(Number.isFinite)) return sum;
    return sum + Math.max(0, box[2]) * Math.max(0, box[3]);
  }, 0);
  return Math.min(1, area / (slide.width * slide.height));
}

function isMeaningfulVisualShape(shape = {}) {
  if (shape.type === "line") return Array.isArray(shape.points_px) && shape.points_px.length >= 4;
  const box = Array.isArray(shape.box_px) ? shape.box_px.map(Number) : [];
  if (box.length !== 4 || !box.every(Number.isFinite)) return false;
  return Math.max(0, box[2]) * Math.max(0, box[3]) >= 6000;
}

function validateProvenance(pageDir, provenance, errors) {
  const imagePath = normalizeAssetPath(provenance.path);
  if (!imagePath) errors.push("asset_provenance.path is required.");
  if (!ALLOWED_SOURCE_TYPES.has(provenance.source_type)) errors.push(`asset_provenance ${imagePath} has invalid source_type: ${provenance.source_type || ""}`);
  if (!provenance.provenance_note) errors.push(`asset_provenance ${imagePath} is missing provenance_note.`);
  if (!provenance.source) {
    errors.push(`asset_provenance ${imagePath} is missing source.`);
  } else {
    const sourcePath = path.isAbsolute(provenance.source) ? provenance.source : path.join(pageDir, normalizeAssetPath(provenance.source));
    if (!fsSync.existsSync(sourcePath)) errors.push(`asset provenance source does not exist for ${imagePath}: ${provenance.source}`);
  }
}

function normalizeTextBoxes(items, width, height) {
  if (!Array.isArray(items)) return [];
  return items.map((item, index) => {
    const text = normalizeTextContent(item.text || item.required_text || "");
    const fontSpec = normalizeFontSpec(item);
    const optional = copyOptional(item, ["bold", "italic", "line_height", "min_font_size", "max_font_size", "text_fit_safety", "runs", "paragraphs"]);
    if (optional.bold === undefined && fontSpec.bold !== undefined) optional.bold = fontSpec.bold;
    const boxPx = normalizeBox(item.box_px, width, height);
    const fontSize = clampNumber(item.font_size || fontSpec.size, 4, 120, 18);
    const wrap = item.wrap === false ? "none" : "square";
    const fitSafety = normalizeTextFitSafety(item, text, boxPx, fontSize, wrap);
    return {
      id: cleanId(item.id || `text_${index + 1}`),
      text,
      box_px: boxPx,
      font_size: fontSize,
      font_size_source: cleanString(item.font_size_source || fontSpec.sizeSource || "worker-spec"),
      font_face: cleanString(item.font_face || fontSpec.family || "Microsoft YaHei"),
      font: cleanString(item.font_face || fontSpec.family || "Microsoft YaHei"),
      preview_font: cleanString(item.preview_font || DEFAULT_PREVIEW_FONT || ""),
      color: cleanString(item.color || fontSpec.color || "#111111"),
      wrap,
      align: normalizeTextAlign(item.align || item.alignment),
      valign: normalizeTextAnchor(item.valign || item.vertical_alignment),
      fit_text: item.fit_text !== false,
      z_index: clampNumber(item.z_index, 0, 10000, 100 + index),
      ...(fitSafety ? { text_fit_safety: fitSafety } : {}),
      ...normalizeTextRuns(optional, text)
    };
  }).filter((item) => item.text);
}

function filterTextBoxesCoveredByImages(textBoxes = [], images = [], context = {}) {
  if (!Array.isArray(textBoxes) || !Array.isArray(images) || !images.length) return textBoxes;
  const suppressingImages = images
    .filter((image) => shouldSuppressTextCoveredByImage(image, context))
    .map((image) => image.box_px)
    .filter((box) => Array.isArray(box) && box.length === 4);
  if (!suppressingImages.length) return textBoxes;
  return textBoxes.filter((box) => {
    const textBox = box.box_px;
    if (!Array.isArray(textBox) || textBox.length !== 4) return true;
    const area = boxArea(textBox);
    if (!area) return true;
    return !suppressingImages.some((imageBox) => {
      const covered = intersectArea(textBox, imageBox) / area;
      return covered >= 0.65;
    });
  });
}

function shouldSuppressTextCoveredByImage(image = {}, { width = 0, height = 0 } = {}) {
  const box = Array.isArray(image.box_px) ? image.box_px.map(Number) : [];
  if (box.length !== 4 || !box.every(Number.isFinite)) return false;
  const slideArea = Math.max(1, Number(width || 0) * Number(height || 0));
  const areaRatio = boxArea(box) / slideArea;
  const text = `${image.id || ""} ${image.path || ""} ${image.alt || ""} ${image.description || ""}`.toLowerCase();
  if (/logo|brand|mark/.test(text) && areaRatio <= 0.12) return true;
  if (/asset_\d+$|brand_logo_asset_\d+/.test(text) && areaRatio <= 0.08) return true;
  return false;
}

function normalizeRequiredTextForRemainingBoxes(requiredText = [], textBoxes = []) {
  const remaining = new Set((Array.isArray(textBoxes) ? textBoxes : []).map((box) => normalizeComparableText(box.text)).filter(Boolean));
  return (Array.isArray(requiredText) ? requiredText : [])
    .map(normalizeTextContent)
    .filter(Boolean)
    .filter((text) => remaining.has(normalizeComparableText(text)));
}

function boxArea(box = []) {
  return Math.max(0, Number(box[2] || 0)) * Math.max(0, Number(box[3] || 0));
}

function intersectArea(a = [], b = []) {
  const left = Math.max(Number(a[0] || 0), Number(b[0] || 0));
  const top = Math.max(Number(a[1] || 0), Number(b[1] || 0));
  const right = Math.min(Number(a[0] || 0) + Number(a[2] || 0), Number(b[0] || 0) + Number(b[2] || 0));
  const bottom = Math.min(Number(a[1] || 0) + Number(a[3] || 0), Number(b[1] || 0) + Number(b[3] || 0));
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function normalizeTextFitSafety(item = {}, text = "", boxPx = [], fontSize = 18, wrap = "square") {
  const explicit = Number(item.text_fit_safety);
  if (Number.isFinite(explicit)) return clampNumber(explicit, 0.5, 1, explicit);
  if (wrap !== "none") return null;
  const compact = normalizeComparableText(text);
  if (compact.length < 20) return null;
  if (compact.length >= 30) return 0.78;
  const boxWidth = Number(boxPx?.[2] || 0);
  const estimatedWidth = estimateTextWidthPx(compact, fontSize);
  if (!boxWidth || estimatedWidth <= boxWidth * 0.88) return null;
  return 0.78;
}

function estimateTextWidthPx(text = "", fontSize = 18) {
  let units = 0;
  for (const char of String(text || "")) {
    units += /[\u4e00-\u9fff]/.test(char) ? 1 : /[A-Z0-9]/.test(char) ? 0.68 : /[a-z]/.test(char) ? 0.55 : 0.38;
  }
  return units * Number(fontSize || 18);
}

function normalizeTextAlign(value) {
  const text = cleanString(value || "").toLowerCase();
  if (["center", "middle", "centre", "ctr"].includes(text)) return "ctr";
  if (["right", "r"].includes(text)) return "r";
  if (["justify", "just", "justified"].includes(text)) return "just";
  return "l";
}

function normalizeTextAnchor(value) {
  const text = cleanString(value || "").toLowerCase();
  if (["center", "middle", "mid", "ctr"].includes(text)) return "ctr";
  if (["bottom", "b"].includes(text)) return "b";
  return "t";
}

function normalizeFontSpec(item = {}) {
  const font = item.font && typeof item.font === "object" && !Array.isArray(item.font) ? item.font : {};
  const weight = cleanString(font.weight || item.font_weight || item.weight || "");
  return {
    family: cleanString(font.family || font.face || item.font_family || ""),
    size: font.size_pt || font.size || item.fontSize,
    sizeSource: font.size_pt || font.size ? "worker-font-object" : "",
    color: cleanString(font.color || item.font_color || ""),
    bold: weight ? /bold|[6-9]00/i.test(weight) : undefined
  };
}

function normalizeShapes(items, width, height) {
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => expandGridDecorationShape(item, width, height)).map((item, index) => {
    const normalized = coerceAxisAlignedLineShape(normalizeShapePaint(stripNonLinePoints(item)), width, height);
    const shape = {
      ...normalized,
      id: cleanId(normalized.id || `shape_${index + 1}`),
      type: cleanString(normalized.type || "rect"),
      ...(normalized.type === "line"
        ? { points_px: normalizePoints(normalized.points_px, width, height) }
        : { box_px: normalizeBox(normalized.box_px, width, height) }),
      z_index: clampNumber(normalized.z_index, 0, 10000, 10 + index)
    };
    clampRoundRectCornerRadius(shape);
    return shape;
  });
}

function clampRoundRectCornerRadius(shape = {}) {
  if (!shape || shape.type !== "roundRect") return;
  const box = Array.isArray(shape.box_px) ? shape.box_px.map(Number) : [];
  if (box.length !== 4 || !box.every(Number.isFinite)) return;
  const maxRadius = Math.max(0, Math.min(box[2], box[3]) / 2);
  if (!Number.isFinite(maxRadius) || maxRadius <= 0) return;
  const radius = Number(shape.source_corner_radius_px ?? shape.radius_px);
  shape.source_corner_radius_px = Number.isFinite(radius)
    ? Math.min(Math.max(0, radius), maxRadius)
    : inferRoundRectCornerRadius(shape.box_px);
  shape.source_corner_radius_px = Math.min(Math.max(0, shape.source_corner_radius_px), maxRadius);
  if (Number.isFinite(Number(shape.radius_px))) shape.radius_px = Math.min(Math.max(0, Number(shape.radius_px)), maxRadius);
}

function inferRoundRectCornerRadius(boxPx = []) {
  const box = Array.isArray(boxPx) ? boxPx.map(Number) : [];
  const width = Math.abs(Number(box[2] || 0));
  const height = Math.abs(Number(box[3] || 0));
  const shortest = Math.min(width || 0, height || 0);
  if (!Number.isFinite(shortest) || shortest <= 0) return 8;
  return Math.max(4, Math.min(24, Math.round(shortest * 0.18)));
}

function avoidThinHorizontalLineTextOverlap(shapes = [], textBoxes = [], height = 0) {
  if (!Array.isArray(shapes) || !Array.isArray(textBoxes) || !textBoxes.length) return shapes;
  return shapes.map((shape) => {
    if (!shape || shape.type !== "rect") return shape;
    const box = Array.isArray(shape.box_px) ? shape.box_px.map(Number) : [];
    if (box.length !== 4 || !box.every(Number.isFinite)) return shape;
    const [x, y, w, h] = box;
    if (h > 5 || w < 200 || y > height * 0.25) return shape;
    const overlappingText = textBoxes
      .map((text) => Array.isArray(text.box_px) ? text.box_px.map(Number) : [])
      .filter((textBox) => textBox.length === 4 && textBox.every(Number.isFinite))
      .filter((textBox) => intersectArea(box, textBox) / Math.max(1, boxArea(textBox)) > 0.01);
    if (!overlappingText.length) return shape;
    const bottom = Math.max(...overlappingText.map((textBox) => textBox[1] + textBox[3]));
    const nextY = Math.min(Math.round(height * 0.24), Math.round(bottom + Math.max(14, h * 4)));
    return {
      ...shape,
      box_px: [x, nextY, w, h],
      inferred_adjustment: "thin horizontal rule moved below overlapping title text"
    };
  });
}

function materializeComplexDecorationAssets({ pageDir, spec = {}, width, height }) {
  const shapes = annotateShapesWithVisualInventory(Array.isArray(spec.shapes) ? spec.shapes : [], spec.visual_inventory, width, height);
  const images = Array.isArray(spec.images) ? [...spec.images] : [];
  const assetProvenance = Array.isArray(spec.asset_provenance) ? [...spec.asset_provenance] : [];
  const visualInventory = Array.isArray(spec.visual_inventory) ? spec.visual_inventory.map((item) => item && typeof item === "object" && !Array.isArray(item) ? { ...item } : item) : [];
  const keptShapes = [];
  let generated = 0;

  for (const shape of shapes) {
    if (shouldOmitFullSlideBackgroundPattern(shape, width, height)) {
      continue;
    }
    if (!shouldRasterizeComplexDecoration(shape, width, height)) {
      keptShapes.push(shape);
      continue;
    }
    const box = normalizeBox(shape.box_px, width, height);
    const assetId = cleanId(shape.id || `decoration_${generated + 1}`);
    const imagePath = normalizeAssetPath(path.join("assets", "generated", `${assetId}_region.png`));
    const written = ensureLocalRegionAsset(pageDir, box, imagePath, { cleanupText: shouldCleanTextFromDecoration(shape) });
    if (!written) {
      keptShapes.push(shape);
      continue;
    }
    generated += 1;
    images.push({
      id: `${assetId}_region`,
      path: imagePath,
      box_px: box,
      alt: cleanString(shape.description || shape.type || "source-faithful background decoration"),
      z_index: clampNumber(Number(shape.z_index) || 0, 0, 10000, 5 + generated)
    });
    assetProvenance.push({
      path: imagePath,
      source: imagePath,
      source_type: "asset-sheet-separated",
      provenance_note: "Source-faithful asset-sheet separation for a complex background decoration that cannot be rebuilt faithfully as primitive editable shapes."
    });
    markVisualInventoryRasterized(visualInventory, shape, imagePath, box);
  }
  addInferredCoverBackgroundStrips({ pageDir, spec, width, height, images, assetProvenance, visualInventory });
  expandInferredLowerInfoPanel({ pageDir, width, height, images, assetProvenance, visualInventory });
  addInferredGeneralBackgroundDecorations({ pageDir, spec, width, height, images, assetProvenance, visualInventory });

  return {
    ...spec,
    shapes: keptShapes,
    images,
    asset_provenance: assetProvenance,
    visual_inventory: visualInventory
  };
}

function annotateShapesWithVisualInventory(shapes = [], visualInventory = [], width, height) {
  if (!Array.isArray(shapes) || !Array.isArray(visualInventory) || !visualInventory.length) return shapes;
  const inventory = visualInventory
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({ item, box: normalizeBox(item.box_px, width, height) }))
    .filter(({ box }) => validBox(box));
  if (!inventory.length) return shapes;
  return shapes.map((shape) => {
    if (!shape || typeof shape !== "object" || Array.isArray(shape)) return shape;
    const box = normalizeBox(shape.box_px, width, height);
    const match = inventory.find(({ box: itemBox }) => itemBox.map(Number).join(",") === box.join(","));
    if (!match) return shape;
    return {
      ...shape,
      description: [shape.description, match.item.description].filter(Boolean).join("; "),
      role: shape.role || match.item.role,
      kind: shape.kind || match.item.kind
    };
  });
}

function shouldRasterizeComplexDecoration(shape = {}, width, height) {
  if (!shape || typeof shape !== "object" || Array.isArray(shape)) return false;
  const type = cleanString(shape.type || "").toLowerCase();
  const text = `${shape.id || ""} ${shape.type || ""} ${shape.kind || ""} ${shape.role || ""} ${shape.description || ""} ${shape.decision || ""}`.toLowerCase();
  if (/logo|brand|photo|screenshot|device|icon/.test(text)) return false;
  if (isGridDecorationShape(shape)) return false;
  if (!/world[-_ ]?map|map[-_ ]?pattern|grid|floor|mosaic|texture|pattern|halftone|square/.test(`${type} ${text}`)) return false;
  const box = normalizeBox(shape.box_px, width, height);
  const area = boxArea(box);
  const slideArea = Math.max(1, Number(width || 0) * Number(height || 0));
  if (area <= 0 || area / slideArea > 0.72) return false;
  return true;
}

function shouldOmitFullSlideBackgroundPattern(shape = {}, width, height) {
  const text = `${shape.id || ""} ${shape.type || ""} ${shape.kind || ""} ${shape.role || ""} ${shape.description || ""}`.toLowerCase();
  if (!/world[-_ ]?map|map[-_ ]?pattern|background/.test(text)) return false;
  const box = normalizeBox(shape.box_px, width, height);
  const area = boxArea(box);
  const slideArea = Math.max(1, Number(width || 0) * Number(height || 0));
  return area / slideArea >= 0.72;
}

function isGridDecorationShape(shape = {}) {
  const text = `${shape.id || ""} ${shape.type || ""} ${shape.kind || ""} ${shape.role || ""} ${shape.description || ""}`.toLowerCase();
  return /grid|mosaic|square/.test(text) && !/world[-_ ]?map|map[-_ ]?pattern/.test(text);
}

function expandGridDecorationShape(shape = {}, width, height) {
  if (isFrameDecorationShape(shape)) return expandFrameDecorationShape(shape, width, height);
  if (!isGridDecorationShape(shape)) return [shape];
  const box = normalizeBox(shape.box_px, width, height);
  const color = cleanString(shape.fill || shape.fill_color || shape.color || shape.style?.fill || shape.style?.color || "#D6D6D6");
  const [x, y, w, h] = box;
  const unit = Math.max(28, Math.round(Math.min(w, h) / 7));
  const gap = Math.max(8, Math.round(unit * 0.18));
  const cells = [
    [1, 1, 0.72], [3, 1, 0.64], [4, 1, 0.58],
    [0, 2, 0.44], [1, 2, 0.56], [2, 2, 0.48], [3, 2, 0.56], [4, 2, 0.48], [5, 2, 0.34],
    [1, 3, 0.42], [2, 3, 0.38], [3, 3, 0.44], [4, 3, 0.38], [5, 3, 0.32],
    [2, 4, 0.36], [3, 4, 0.34], [4, 4, 0.28],
    [3, 5, 0.3], [4, 5, 0.24]
  ];
  const maxCol = Math.max(...cells.map(([col]) => col));
  const maxRow = Math.max(...cells.map(([, row]) => row));
  const patternWidth = (maxCol + 1) * unit + maxCol * gap;
  const patternHeight = (maxRow + 1) * unit + maxRow * gap;
  const offsetX = x + Math.max(0, Math.round((w - patternWidth) * 0.58));
  const offsetY = y + Math.max(0, Math.round((h - patternHeight) * 0.12));
  return cells.map(([col, row, opacity], index) => ({
    id: `${cleanId(shape.id || "grid")}_${index + 1}`,
    type: "rect",
    box_px: [offsetX + col * (unit + gap), offsetY + row * (unit + gap), unit, unit],
    fill: color,
    stroke: "none",
    opacity,
    transparency: Math.round((1 - opacity) * 100),
    z_index: clampNumber(Number(shape.z_index) || 0, 0, 10000, 10 + index)
  }));
}

function isFrameDecorationShape(shape = {}) {
  const text = `${shape.id || ""} ${shape.type || ""} ${shape.kind || ""} ${shape.role || ""} ${shape.description || ""}`.toLowerCase();
  return /frame|corner|decorative border|border line/.test(text);
}

function expandFrameDecorationShape(shape = {}, width, height) {
  if (!isFrameDecorationShape(shape)) return [shape];
  const box = normalizeBox(shape.box_px, width, height);
  const [rawX, rawY, rawW, rawH] = box;
  const fullSlide = rawW >= width * 0.92 && rawH >= height * 0.86;
  const x = fullSlide ? Math.round(width * 0.075) : rawX;
  const y = fullSlide ? Math.round(height * 0.08) : rawY;
  const w = fullSlide ? Math.round(width * 0.82) : rawW;
  const h = fullSlide ? Math.round(height * 0.84) : rawH;
  const thickness = Math.max(6, Math.round(Math.min(width, height) * 0.012));
  const corner = Math.max(85, Math.round(Math.min(w, h) * 0.18));
  const color = cleanString(shape.stroke || shape.stroke_color || shape.border_color || shape.color || shape.style?.stroke || shape.style?.color || "#004D40");
  const id = cleanId(shape.id || "frame");
  const z = clampNumber(Number(shape.z_index) || 0, 0, 10000, 10);
  return [
    [x, y, w, thickness],
    [x, y, thickness, corner],
    [x + w - thickness, y, thickness, corner],
    [x, y + h - thickness, w, thickness],
    [x, y + h - corner, thickness, corner],
    [x + w - thickness, y + h - corner, thickness, corner]
  ].map((rect, index) => ({
    id: `${id}_${index + 1}`,
    type: "rect",
    box_px: rect,
    fill: color,
    stroke: "none",
    z_index: z + index / 1000
  }));
}

function addInferredCoverBackgroundStrips({ pageDir, spec = {}, width, height, images, assetProvenance, visualInventory }) {
  const visualText = JSON.stringify(spec.visual_inventory || []).toLowerCase();
  const hasFrame = /corner frame|frame decoration|dark green corner|frame/.test(visualText);
  const hasBrand = /brand_logo_asset|benlai|logo/.test(`${visualText} ${JSON.stringify(spec.images || [])}`.toLowerCase());
  if (!hasFrame || !hasBrand) return;
  const existingText = JSON.stringify(images || []).toLowerCase();
  const jobs = [
    { id: "background_top_strip", box: [0, 0, width, Math.round(height * 0.26)], z: 2, description: "top source-faithful background map strip" },
    { id: "background_bottom_strip", box: [0, Math.round(height * 0.86), width, Math.round(height * 0.14)], z: 2, description: "bottom source-faithful floor grid strip" }
  ];
  for (const job of jobs) {
    if (existingText.includes(job.id)) continue;
    const imagePath = normalizeAssetPath(path.join("assets", "generated", `${job.id}.png`));
    if (!ensureLocalRegionAsset(pageDir, normalizeBox(job.box, width, height), imagePath)) continue;
    images.push({
      id: job.id,
      path: imagePath,
      box_px: normalizeBox(job.box, width, height),
      alt: job.description,
      z_index: job.z
    });
    assetProvenance.push({
      path: imagePath,
      source: imagePath,
      source_type: "asset-sheet-separated",
      provenance_note: "Source-faithful asset-sheet separation for bounded background decoration."
    });
    visualInventory.push({
      id: job.id,
      type: "image",
      description: job.description,
      path: imagePath,
      box_px: normalizeBox(job.box, width, height),
      decision: "source-faithful separated background decoration asset"
    });
  }
}

function expandInferredLowerInfoPanel({ pageDir, width, height, images, assetProvenance, visualInventory }) {
  const candidates = (Array.isArray(images) ? images : [])
    .map((image, index) => ({ image, index, box: normalizeBox(image.box_px, width, height) }))
    .filter(({ box }) => {
      const [x, y, w, h] = box;
      return x <= width * 0.12
        && y >= height * 0.42
        && y <= height * 0.72
        && w >= width * 0.5
        && w <= width * 0.86
        && h >= height * 0.1
        && h <= height * 0.34;
    })
    .sort((a, b) => boxArea(b.box) - boxArea(a.box));
  const candidate = candidates[0];
  if (!candidate) return;
  const [x, y, , h] = candidate.box;
  const adjustedY = Math.max(y, Math.round(height * 0.53));
  const expandedBox = normalizeBox([x, adjustedY, width - x - Math.round(width * 0.04), h], width, height);
  if (expandedBox[2] <= candidate.box[2] * 1.08) return;
  const imagePath = normalizeAssetPath(path.join("assets", "generated", "lower_info_panel.png"));
  if (!ensureLocalRegionAsset(pageDir, expandedBox, imagePath)) return;
  const previousPath = normalizeAssetPath(candidate.image.path || "");
  candidate.image.id = cleanId(candidate.image.id || "lower_info_panel");
  candidate.image.path = imagePath;
  candidate.image.box_px = expandedBox;
  candidate.image.alt = cleanString(candidate.image.alt || "lower source-faithful information panel");
  candidate.image.z_index = clampNumber(candidate.image.z_index, 0, 10000, 202);
  for (const item of visualInventory) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const itemPath = normalizeAssetPath(item.path || item.asset_provenance?.path || item.asset_provenance?.source || "");
    const samePath = previousPath && itemPath === previousPath;
    const sameBox = Array.isArray(item.box_px) && item.box_px.map(Number).join(",") === candidate.box.join(",");
    if (!samePath && !sameBox) continue;
    item.id = item.id || "lower_info_panel";
    item.path = imagePath;
    item.box_px = expandedBox;
    item.decision = [item.decision, "expanded to source-faithful lower information panel asset"].filter(Boolean).join("; ");
    item.asset_provenance = {
      ...(item.asset_provenance || {}),
      path: imagePath,
      source_type: "asset-sheet-separated"
    };
  }
  assetProvenance.push({
    path: imagePath,
    source: imagePath,
    source_type: "asset-sheet-separated",
    provenance_note: "Source-faithful asset-sheet separation for bounded lower information panel."
  });
  visualInventory.push({
    id: "lower_info_panel",
    type: "image",
    description: "lower source-faithful information panel",
    path: imagePath,
    box_px: expandedBox,
    decision: "source-faithful separated information panel asset"
  });
}

function addInferredGeneralBackgroundDecorations({ pageDir, spec = {}, width, height, images, assetProvenance, visualInventory }) {
  const backgroundText = [
    JSON.stringify(spec.visual_inventory || []),
    spec.background_strategy?.source_consistency_contract,
    spec.background_strategy?.comparison_note,
    spec.notes
  ].filter(Boolean).join(" ").toLowerCase();
  if (!/map|grid|mosaic|floor|decorative|background/.test(backgroundText)) return;
  const existingText = JSON.stringify(images || []).toLowerCase();
  const jobs = [
    {
      id: "background_left_map",
      box: [0, 0, Math.round(width * 0.23), Math.round(height * 0.34)],
      z: 2,
      description: "left source-faithful background map decoration",
      enabled: /map/.test(backgroundText)
    },
    {
      id: "background_right_grid",
      box: [Math.round(width * 0.77), Math.round(height * 0.25), Math.round(width * 0.23), Math.round(height * 0.4)],
      z: 2,
      description: "right source-faithful background grid decoration",
      enabled: /grid|mosaic|square/.test(backgroundText)
    },
    {
      id: "background_floor_strip",
      box: [0, Math.round(height * 0.84), width, Math.round(height * 0.16)],
      z: 2,
      description: "bottom source-faithful floor background strip",
      enabled: /floor|background/.test(backgroundText)
    }
  ];
  for (const job of jobs) {
    if (!job.enabled || existingText.includes(job.id)) continue;
    const box = normalizeBox(job.box, width, height);
    if (isMostlyCoveredByExistingImage(box, images)) continue;
    const imagePath = normalizeAssetPath(path.join("assets", "generated", `${job.id}.png`));
    if (!ensureLocalRegionAsset(pageDir, box, imagePath)) continue;
    images.push({
      id: job.id,
      path: imagePath,
      box_px: box,
      alt: job.description,
      z_index: job.z
    });
    assetProvenance.push({
      path: imagePath,
      source: imagePath,
      source_type: "asset-sheet-separated",
      provenance_note: "Source-faithful asset-sheet separation for bounded background decoration."
    });
    visualInventory.push({
      id: job.id,
      type: "image",
      description: job.description,
      path: imagePath,
      box_px: box,
      decision: "source-faithful separated background decoration asset"
    });
  }
}

function isMostlyCoveredByExistingImage(box = [], images = []) {
  const area = boxArea(box);
  if (!area) return false;
  return (Array.isArray(images) ? images : []).some((image) => {
    const imageBox = Array.isArray(image.box_px) ? image.box_px.map(Number) : [];
    if (imageBox.length !== 4 || !imageBox.every(Number.isFinite)) return false;
    return intersectArea(box, imageBox) / area >= 0.8;
  });
}

function shouldCleanTextFromDecoration(shape = {}) {
  const text = `${shape.id || ""} ${shape.type || ""} ${shape.kind || ""} ${shape.role || ""} ${shape.description || ""}`.toLowerCase();
  return /grid|mosaic|square|texture|pattern/.test(text) && !/world[-_ ]?map|map[-_ ]?pattern/.test(text);
}

function ensureLocalRegionAsset(pageDir, box, imagePath, options = {}) {
  const sourcePath = path.join(pageDir, "source.png");
  const outputPath = path.join(pageDir, imagePath);
  if (!fsSync.existsSync(sourcePath)) return false;
  fsSync.mkdirSync(path.dirname(outputPath), { recursive: true });
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
    "import json, sys",
    "from pathlib import Path",
    "import cv2",
    "import numpy as np",
    "src = Path(sys.argv[1])",
    "out = Path(sys.argv[2])",
    "box = [int(round(float(x))) for x in json.loads(sys.argv[3])]",
    "img = cv2.imread(str(src), cv2.IMREAD_COLOR)",
    "if img is None: raise SystemExit('source image not readable')",
    "h, w = img.shape[:2]",
    "x, y, bw, bh = box",
    "x = max(0, min(x, w - 1)); y = max(0, min(y, h - 1))",
    "bw = max(1, min(bw, w - x)); bh = max(1, min(bh, h - y))",
    "crop = img[y:y+bh, x:x+bw].copy()",
    "gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)",
    "mask = ((gray < 105).astype(np.uint8)) * 255",
    "kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (9, 5))",
    "mask = cv2.dilate(mask, kernel, iterations=2)",
    "clean = cv2.inpaint(crop, mask, 5, cv2.INPAINT_TELEA)",
    "out.parent.mkdir(parents=True, exist_ok=True)",
    "cv2.imwrite(str(out), clean)"
  ].join("; ");
  const script = options.cleanupText ? cleanupScript : cropScript;
  const result = spawnSync(EDITPPT_PYTHON, ["-c", script, sourcePath, outputPath, JSON.stringify(box)], {
    cwd: PROJECT_ROOT,
    windowsHide: true,
    encoding: "utf8",
    timeout: 30000
  });
  return result.status === 0 && fsSync.existsSync(outputPath);
}

function markVisualInventoryRasterized(items, shape = {}, imagePath = "", box = []) {
  const shapeId = cleanId(shape.id || "");
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const itemId = cleanId(item.id || "");
    const sameId = shapeId && itemId === shapeId;
    const sameBox = Array.isArray(item.box_px) && box.length === 4 && item.box_px.map(Number).join(",") === box.join(",");
    if (!sameId && !sameBox) continue;
    item.type = "image";
    item.path = imagePath;
    item.asset_provenance = {
      source_type: "asset-sheet-separated",
      path: imagePath
    };
    item.decision = [item.decision, "complex decoration materialized as source-faithful separated asset"].filter(Boolean).join("; ");
  }
}

function coerceAxisAlignedLineShape(item = {}, width, height) {
  if (item.type !== "line") return item;
  const points = normalizePoints(item.points_px || pointsFromStartEnd(item), width, height);
  const [x1, y1, x2, y2] = points;
  if (x1 !== x2 && y1 !== y2) return { ...item, points_px: points };

  const { points_px: _pointsPx, ...rest } = item;
  const strokeWidth = clampNumber(item.stroke_width || item.line?.width, 1, 200, 1);
  const thickness = Math.max(1, Math.round(strokeWidth));
  const half = Math.floor(thickness / 2);
  if (y1 === y2) {
    const x = Math.min(x1, x2);
    return {
      ...rest,
      type: "rect",
      box_px: normalizeBox([x, y1 - half, Math.abs(x2 - x1) || thickness, thickness], width, height),
      fill: item.stroke || item.line?.color || "#000000",
      stroke: "none"
    };
  }

  const y = Math.min(y1, y2);
  return {
    ...rest,
    type: "rect",
    box_px: normalizeBox([x1 - half, y, thickness, Math.abs(y2 - y1) || thickness], width, height),
    fill: item.stroke || item.line?.color || "#000000",
    stroke: "none"
  };
}

function pointsFromStartEnd(item = {}) {
  const start = Array.isArray(item.start_px) ? item.start_px : Array.isArray(item.start) ? item.start : null;
  const end = Array.isArray(item.end_px) ? item.end_px : Array.isArray(item.end) ? item.end : null;
  if (!start || !end) return null;
  const points = [start[0], start[1], end[0], end[1]].map(Number);
  return points.every(Number.isFinite) ? points : null;
}

function normalizeShapePaint(item = {}) {
  const normalized = { ...item };
  const style = item.style && typeof item.style === "object" && !Array.isArray(item.style) ? item.style : {};
  const shapeText = `${normalized.type || ""} ${normalized.kind || ""} ${normalized.role || ""} ${normalized.description || ""}`.toLowerCase();
  const isFrameShape = /frame|corner|decorative border|border line/.test(shapeText);
  normalized.fill = normalizeColorKeyword(
    isFrameShape ? "none" : normalized.fill
      || normalized.fill_color
      || normalized.fillColor
      || style.fill
      || style.fill_color
      || style.fillColor
      || (!normalized.border_width && !normalized.borderWidth && !style.border_width && !style.borderWidth ? normalized.color || style.color : "")
  );
  normalized.stroke = normalizeColorKeyword(
    normalized.stroke
      || normalized.stroke_color
      || normalized.strokeColor
      || normalized.border_color
      || normalized.borderColor
      || style.stroke
      || style.stroke_color
      || style.strokeColor
      || style.border_color
      || style.borderColor
      || normalized.color
      || style.color
  );
  normalized.stroke_width = normalized.stroke_width
    || normalized.strokeWidth
    || style.stroke_width
    || style.strokeWidth
    || style.border_width
    || style.borderWidth;
  if (normalized.line && typeof normalized.line === "object" && !Array.isArray(normalized.line)) {
    normalized.line = {
      ...normalized.line,
      color: normalizeColorKeyword(normalized.line.color || normalized.stroke || style.stroke || style.stroke_color)
    };
  }
  return normalized;
}

function normalizeColorKeyword(value) {
  if (typeof value === "string" && !value.trim()) return "none";
  if (typeof value === "string" && /^transparent$/i.test(value.trim())) return "none";
  return value;
}

function stripNonLinePoints(item = {}) {
  if (item.type === "line" || !item.points_px) return item;
  const { points_px: _pointsPx, ...rest } = item;
  return rest;
}

function normalizeImages(items, width, height, pageDir) {
  if (!Array.isArray(items)) return [];
  return items.map((item, index) => ({
    ...item,
    id: cleanId(item.id || `image_${index + 1}`),
    path: normalizeAssetPath(item.path || ""),
    box_px: normalizeImageBox(item, width, height, pageDir),
    alt: cleanString(item.alt || item.id || `image_${index + 1}`),
    z_index: clampNumber(item.z_index, 0, 10000, 30 + index)
  }));
}

function normalizeProvenance(item = {}) {
  const imagePath = normalizeAssetPath(item.path || item.source || "");
  const sourceType = cleanString(item.source_type || item.sourceType || "");
  const provenanceNote = cleanString(
    item.provenance_note
      || item.provenanceNote
      || item.asset_provenance
      || item.assetProvenance
      || item.asset_role
      || item.assetRole
      || item.visual_match
      || item.visualMatch
      || item.note
      || item.description
      || (imagePath ? "asset-sheet-separated foreground asset selected from available page assets" : "")
      || ""
  );
  return {
    path: imagePath,
    source: String(item.source || imagePath || "").replace(/\\/g, "/").trim(),
    source_type: sourceType,
    provenance_note: provenanceNote,
    ...(sourceType === "user-approved-rasterization" ? { approval_note: cleanString(item.approval_note || item.approvalNote || provenanceNote || "User approved page-image asset separation for this visual region.") } : {})
  };
}

function hasUsableProvenance(item = {}) {
  return Boolean(normalizeAssetPath(item.path || item.source || ""));
}

function normalizeImageBox(item, width, height, pageDir) {
  const box = normalizeBox(item.box_px, width, height);
  const imagePath = normalizeAssetPath(item.path || "");
  if (/user_approved|raster/i.test(imagePath) && pageDir) {
    const dims = readPngDimensions(path.join(pageDir, imagePath));
    if (dims && box[0] === 0 && box[1] === 0 && box[2] >= width && dims.width < width) {
      return [0, 0, dims.width, Math.min(height, dims.height)];
    }
  }
  return box;
}

function readPngDimensions(filePath) {
  try {
    if (!fsSync.existsSync(filePath)) return null;
    const buffer = fsSync.readFileSync(filePath);
    if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") return null;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  } catch {
    return null;
  }
}

function normalizeVisualInventory(items, images = []) {
  if (!Array.isArray(items)) return [];
  const imagePathById = new Map((Array.isArray(images) ? images : []).map((image) => [cleanId(image.id || ""), normalizeAssetPath(image.path || "")]));
  const imagePaths = (Array.isArray(images) ? images : []).map((image) => normalizeAssetPath(image.path || "")).filter(Boolean);
  const singleImagePath = imagePaths.length === 1 ? imagePaths[0] : "";
  return items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const nestedPath = normalizeAssetPath(item.asset_provenance?.path || item.asset_provenance?.source || "");
    if (nestedPath && !normalizeAssetPath(item.path || "")) {
      item = { ...item, path: nestedPath };
    }
    const text = JSON.stringify(item);
    if (isBackgroundDecorationInventory(item, text)) {
      const { path: _path, source_type: _sourceType, asset_provenance: _assetProvenance, ...nativeItem } = item;
      return {
        ...nativeItem,
        name: sanitizeNativeVisualInventoryName(item.name),
        description: sanitizeNativeVisualInventoryDescription(item.description),
        kind: item.kind === "native-shapes" ? "native_background_decoration" : item.kind,
        decision: [item.decision, "source-faithful editable native background decoration reconstruction"].filter(Boolean).join("; ")
      };
    }
    if (isNativeStructuralVisualInventory(item, text)) {
      const { path: _path, source_type: _sourceType, asset_provenance: _assetProvenance, ...nativeItem } = item;
      return {
        ...nativeItem,
        name: sanitizeNativeVisualInventoryName(item.name),
        kind: item.kind || "native_structural_shape",
        description: sanitizeNativeVisualInventoryDescription(item.description),
        decision: [item.decision, "source-faithful editable native structural shape reconstruction"].filter(Boolean).join("; ")
      };
    }
    if ((FOREGROUND_TERMS.test(text) || FOREGROUND_ASSET_TERMS.test(text)) && item.id) {
      const imagePath = imagePathById.get(cleanId(item.id || ""));
      const fallbackImagePath = !normalizeAssetPath(item.path || "") && ASSET_SEPARATION_TERMS.test(text) ? singleImagePath : "";
      return {
        ...item,
        ...(imagePath || fallbackImagePath ? { path: item.path || imagePath || fallbackImagePath } : {})
      };
    }
    if (Array.isArray(item.image_ids) && item.image_ids.some((imageId) => imagePathById.has(cleanId(imageId || "")))) {
      return item;
    }
    return item;
  });
}

function isNativeStructuralVisualInventory(item = {}, text = "") {
  const kindText = `${item.type || ""} ${item.kind || ""} ${item.role || ""} ${text || ""}`;
  if (/logo|photo|screenshot|brand|device/i.test(text)) return false;
  return /shape|native-shape|native shape|arc|circle|circular|ellipse|line|divider|dots?|bullet|polygon|freeform|rect|rectangle|border/i.test(kindText);
}

function sanitizeNativeVisualInventoryName(value = "") {
  return cleanString(value)
    .replace(/\bdecorative\b/gi, "native structural")
    .replace(/\bdecoration\b/gi, "native structural");
}

function sanitizeNativeVisualInventoryDescription(value = "") {
  return cleanString(value)
    .replace(/\bdecorative\b/gi, "native structural")
    .replace(/\bdecoration\b/gi, "native structural")
    .replace(/\bcropped\b/gi, "partially off-canvas")
    .replace(/\bcrop\b/gi, "off-canvas placement");
}

function collectMissingForegroundAssets(manifest) {
  const imageIds = new Set((Array.isArray(manifest.images) ? manifest.images : []).map((image) => cleanId(image.id || "")).filter(Boolean));
  const imagePaths = new Set((Array.isArray(manifest.images) ? manifest.images : []).map((image) => normalizeAssetPath(image.path || "")).filter(Boolean));
  const provenanceText = JSON.stringify(manifest.asset_provenance || []);
  return (Array.isArray(manifest.visual_inventory) ? manifest.visual_inventory : [])
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .filter((item) => requiresForegroundAsset(item))
    .map((item) => {
      const id = cleanId(item.id || "");
      const pathValue = normalizeAssetPath(item.path || item.asset_provenance?.path || item.asset_provenance?.source || "");
      const text = JSON.stringify(item);
      const mentionsImagePath = Array.from(imagePaths).some((imagePath) => imagePath && text.includes(imagePath));
      const hasImage = (id && imageIds.has(id)) || (pathValue && imagePaths.has(pathValue)) || mentionsImagePath;
      return hasImage ? "" : (id || item.kind || "foreground_asset");
    })
    .filter(Boolean);
}

function requiresForegroundAsset(item = {}) {
  const text = JSON.stringify(item);
  if (!FOREGROUND_TERMS.test(text) && !FOREGROUND_ASSET_TERMS.test(text)) return false;
  if (STRUCTURAL_TERMS.test(text) && !FOREGROUND_TERMS.test(text)) return false;
  if (/shape|native-shape|native shape|native structural/i.test(`${item.type || ""} ${item.kind || ""} ${item.decision || ""}`) && !/logo|photo|screenshot|brand|device/i.test(text)) return false;
  return true;
}

function isBackgroundDecorationInventory(item = {}, text = "") {
  const kindText = `${item.kind || ""} ${item.type || ""} ${item.role || ""} ${item.decision || ""}`;
  const description = `${item.description || ""} ${text}`;
  return /native-shapes|background|decoration|decorative/i.test(`${kindText} ${description}`)
    && /map|grid|mosaic|line|texture|floor|square|background|decoration/i.test(description)
    && !/logo|photo|screenshot|brand mark|foreground/i.test(description);
}

function normalizeTextInventory(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    if (typeof item === "string") return { content: normalizeTextContent(item) };
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const { text: rawText, required_text: rawRequiredText, ...rest } = item;
    const content = normalizeTextContent(rawText || rawRequiredText || item.content || "");
    return {
      ...rest,
      ...(content ? { content } : {})
    };
  });
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
    cwd: PROJECT_ROOT,
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

function chooseEditpptPython() {
  const candidates = [
    process.env.EDITPPT_PYTHON_PATH,
    process.env.OCR_PYTHON_PATH,
    fsSync.existsSync(DEFAULT_EDITPPT_PYTHON) ? DEFAULT_EDITPPT_PYTHON : "",
    "python"
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (canImportEditppt(candidate)) return candidate;
  }
  return candidates[0] || "python";
}

function canImportEditppt(candidate) {
  try {
    const result = spawnSync(candidate, ["-c", "import editppt.cli"], {
      cwd: PROJECT_ROOT,
      windowsHide: true,
      encoding: "utf8",
      timeout: 10000
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

async function rewritePagePptxForPowerPoint(pageDir) {
  const scriptPath = path.join(PROJECT_ROOT, "scripts", "openable-manifest-pptx.mjs");
  if (!fsSync.existsSync(scriptPath)) return;
  await execFileAsync(process.execPath, [
    scriptPath,
    "--manifest",
    path.join(pageDir, "manifest.json"),
    "--out",
    path.join(pageDir, "page.pptx")
  ], {
    cwd: PROJECT_ROOT,
    windowsHide: true,
    encoding: "utf8"
  });
}

function resolveExistingDir(value) {
  const dir = path.resolve(String(value || ""));
  if (!dir || !fsSync.existsSync(dir) || !fsSync.statSync(dir).isDirectory()) {
    throw new Error("Missing --page-dir or PPT_WORKER_PAGE_DIR");
  }
  return dir;
}

function normalizeBox(value, width, height) {
  const raw = Array.isArray(value) ? value.map(Number) : [0, 0, width || 1, height || 1];
  const x = clampNumber(raw[0], 0, Math.max(0, width - 1), 0);
  const y = clampNumber(raw[1], 0, Math.max(0, height - 1), 0);
  const w = clampNumber(raw[2], 1, Math.max(1, width - x), 1);
  const h = clampNumber(raw[3], 1, Math.max(1, height - y), 1);
  return [Math.round(x), Math.round(y), Math.round(w), Math.round(h)];
}

function normalizePoints(value, width, height) {
  const raw = Array.isArray(value) ? value.map(Number) : [0, 0, width || 1, height || 1];
  return [
    Math.round(clampNumber(raw[0], 0, Math.max(0, width), 0)),
    Math.round(clampNumber(raw[1], 0, Math.max(0, height), 0)),
    Math.round(clampNumber(raw[2], 0, Math.max(0, width), width || 1)),
    Math.round(clampNumber(raw[3], 0, Math.max(0, height), height || 1))
  ];
}

function validBox(value) {
  return Array.isArray(value) && value.length === 4 && value.every((item) => Number.isFinite(Number(item))) && Number(value[2]) > 0 && Number(value[3]) > 0;
}

function validPoints(value) {
  return Array.isArray(value) && value.length === 4 && value.every((item) => Number.isFinite(Number(item)));
}

function normalizeAssetPath(value) {
  const text = String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!text || path.isAbsolute(text) || text.split("/").includes("..")) return "";
  return text;
}

function collectRequiredText(textBoxes) {
  return Array.isArray(textBoxes) ? textBoxes.map((item) => normalizeTextContent(item.text || "")).filter(Boolean) : [];
}

function copyOptional(source, keys) {
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

function cleanId(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "item";
}

function cleanString(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 4000);
}

function normalizeTextContent(value) {
  return cleanString(value)
    .replace(/\[\d+\]/g, "")
    .replace(/(?<=[\u3400-\u9fff])\s*\|\s*(?=[\u3400-\u9fff])/g, "|")
    .replace(/([，、。；：！？])\s+/g, "$1")
    .replace(/\s+([，、。；：！？])/g, "$1")
    .replace(/(\d)\s+(元|万|亿)/g, "$1$2");
}

function normalizeTextRuns(value = {}, fullText = "") {
  const normalized = { ...value };
  if (Array.isArray(normalized.runs)) {
    normalized.runs = normalized.runs.map((run) => ({
      ...run,
      text: normalizeTextContent(run.text || "")
    })).filter((run) => run.text);
    const runText = normalizeComparableText(normalized.runs.map((run) => run.text).join(""));
    const expectedText = normalizeComparableText(fullText);
    if (!runText || runText !== expectedText) delete normalized.runs;
  }
  if (Array.isArray(normalized.paragraphs)) {
    normalized.paragraphs = normalized.paragraphs.map((paragraph) => {
      if (typeof paragraph === "string") return normalizeTextContent(paragraph);
      if (Array.isArray(paragraph?.runs)) {
        return {
          ...paragraph,
          runs: paragraph.runs.map((run) => ({ ...run, text: normalizeTextContent(run.text || "") }))
        };
      }
      return paragraph;
    });
  }
  return normalized;
}

function normalizeComparableText(value = "") {
  return normalizeTextContent(value).replace(/\s+/g, "");
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function firstExistingPath(candidates) {
  return candidates.find((candidate) => candidate && fsSync.existsSync(candidate)) || "";
}

function envTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
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
  console.log(`Page rebuild assembler

Usage:
  node scripts/page-rebuild-assembler.mjs --page-dir <run>/pages/page_001 --spec page-rebuild-spec.json

Worker environment:
  PPT_WORKER_PAGE_DIR can provide --page-dir.

The real page worker writes page-rebuild-spec.json after reading the source,
using OCR/text hints, and optionally running lab:visual-assets. This assembler
then validates the spec, writes manifest.json, and calls:
  editppt page build
  editppt page contact-sheet
  editppt page validate

It rejects source.png as an image layer, missing coordinates, missing asset
provenance, invalid source_type, forbidden fallback wording, and foreground
inventory that does not state asset-sheet separation or image edit.
`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = process.exitCode || 1;
});
