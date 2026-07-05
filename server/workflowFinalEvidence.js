import crypto from "crypto";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import zlib from "zlib";
import { readWorkflowJob } from "./workflowJobs.js";
import { inspectPowerPointOpenability } from "./pptxEditability.js";

const FINAL_VALIDATION_ARRAYS = [
  "page_manifests_missing",
  "page_validation_missing",
  "failed_page_validations",
  "page_contract_violations",
  "notes_hash_mismatches",
  "missing_parts"
];
const FOREGROUND_TERMS = /\b(icon|photo|logo|screenshot|badge|sticker|stamp|device|illustration|mark|brand|brand mark|brand block)\b|图标|照片|徽标|截图|贴纸|标记/i;
const FOREGROUND_ASSET_TERMS = /(icon|photo|logo|screenshot|badge|sticker|stamp|device|illustration|mark|brand|visual object)/i;
const ASSET_SEPARATION_TERMS = /asset-sheet separated|asset sheet separated|image edit|separated|user-approved|user approved|rasterization|imagegen|分离/i;
const STRUCTURAL_TERMS = /native structural|结构|background|formula|divider|rule|grid|panel|card|pagination|native background/i;

export async function scanWorkflowFinalEvidence(jobOrId) {
  const job = typeof jobOrId === "string" ? await readWorkflowJob(jobOrId) : jobOrId;
  const artifacts = job?.artifacts || {};
  const editableRun = artifacts.editableRun || {};
  const final = artifacts.editableFinal || {};
  const runDir = resolveMaybe(final.runDir || editableRun.path);
  const finalPath = resolveMaybe(final.path);
  const sourceOutputPath = resolveMaybe(final.sourceOutputPath || final.summary?.output);
  const workspaceValidationPath = resolveMaybe(final.validation?.path);
  const runSummaryPath = runDir ? path.join(runDir, "final", "run_summary.json") : "";
  const runValidationPath = resolveMaybe(final.summary?.validation || (runDir ? path.join(runDir, "final", "validation.json") : ""));
  const deckManifestPath = resolveMaybe(editableRun.deckManifestPath || (runDir ? path.join(runDir, "deck_manifest.json") : ""));
  const pageJobsPath = resolveMaybe(editableRun.pageJobsPath || (runDir ? path.join(runDir, "page_jobs.json") : ""));
  const issues = [];

  const finalFile = statFile(finalPath);
  const sourceOutputFile = statFile(sourceOutputPath);
  const workspaceValidation = await readJsonIfFile(workspaceValidationPath);
  const runValidation = await readJsonIfFile(runValidationPath);
  const runSummary = await readJsonIfFile(runSummaryPath);
  const deckManifest = await readJsonIfFile(deckManifestPath);
  const pageJobs = await readJsonIfFile(pageJobsPath);
  const foregroundAssetIssues = await inspectPageForegroundAssets(runDir, pageJobs.data);
  const visualQa = inspectFinalVisualQuality(job, runDir, pageJobs.data);

  if (!final.path) issues.push("final-artifact-missing");
  else if (!isInsidePath(finalPath, path.resolve(job.rootDir))) issues.push("final-artifact-outside-job-root");
  else if (!finalFile.exists) issues.push("final-artifact-file-missing");

  if (!workspaceValidationPath || !workspaceValidation.exists) issues.push("workspace-final-validation-missing");
  if (!runSummary.exists) issues.push("run-summary-missing");
  if (!runValidation.exists) issues.push("run-final-validation-missing");
  if (!sourceOutputPath || !sourceOutputFile.exists) issues.push("run-final-output-missing");
  if (runDir && sourceOutputPath && !isInsidePath(sourceOutputPath, runDir)) issues.push("run-output-outside-run-dir");
  if (runDir && runValidationPath && !isInsidePath(runValidationPath, runDir)) issues.push("run-validation-outside-run-dir");

  const validation = workspaceValidation.data || runValidation.data || {};
  const summary = runSummary.data || final.summary || {};
  const expectedPages = numberOrZero(validation.expected_pages || deckManifest.data?.page_count || pageJobs.data?.pages?.length || editableRun.pageCount || final.summary?.page_count);
  const validationSlides = numberOrZero(validation.slides);
  const summaryPages = numberOrZero(summary.page_count);
  const editabilitySlides = numberOrZero(final.pptxEditability?.slideCount);
  const pageJobCount = Array.isArray(pageJobs.data?.pages) ? pageJobs.data.pages.length : 0;

  if (workspaceValidation.exists && workspaceValidation.data?.passed !== true) issues.push("workspace-final-validation-not-passed");
  if (runValidation.exists && runValidation.data?.passed !== true) issues.push("run-final-validation-not-passed");
  if (runSummary.exists && summary.status !== "complete") issues.push("run-summary-not-complete");
  if (expectedPages && validationSlides && expectedPages !== validationSlides) issues.push("validation-page-count-mismatch");
  if (expectedPages && summaryPages && expectedPages !== summaryPages) issues.push("summary-page-count-mismatch");
  if (expectedPages && editabilitySlides && expectedPages !== editabilitySlides) issues.push("editability-slide-count-mismatch");
  if (expectedPages && pageJobCount && expectedPages !== pageJobCount) issues.push("page-jobs-count-mismatch");
  for (const key of FINAL_VALIDATION_ARRAYS) {
    if (Array.isArray(validation[key]) && validation[key].length) issues.push(`validation-${key}-not-empty`);
  }
  if (foregroundAssetIssues.length) issues.push("page-foreground-assets-missing");
  if (visualQa.blockingIssues.length) issues.push(...visualQa.blockingIssues);

  const finalHash = finalFile.exists ? await hashFile(finalPath).catch(() => "") : "";
  const sourceOutputHash = sourceOutputFile.exists ? await hashFile(sourceOutputPath).catch(() => "") : "";
  const openableRepairOk = final.openableRepair?.ok === true;
  const rawHashesMatch = Boolean(finalHash && sourceOutputHash && finalHash === sourceOutputHash);
  const hashesMatch = rawHashesMatch || Boolean(openableRepairOk && finalHash && sourceOutputHash);
  if (finalHash && sourceOutputHash && !hashesMatch) issues.push("final-copy-hash-mismatch");
  if (finalFile.exists && sourceOutputFile.exists && finalFile.size !== sourceOutputFile.size && !openableRepairOk) issues.push("final-copy-size-mismatch");
  const powerPointOpenability = isUsableCachedPowerPointOpenability(final.powerPointOpenability, finalFile, final)
    ? final.powerPointOpenability
    : (finalFile.exists
    ? await inspectPowerPointOpenability(finalPath).catch((error) => ({
        version: 1,
        source: "powerpoint-com-open",
        available: process.platform === "win32",
        openable: false,
        slideCount: 0,
        warnings: ["powerpoint-open-check-failed"],
        error: error.message || "PowerPoint open check failed"
      }))
    : null);
  if (powerPointOpenability?.openable === false) issues.push("final-pptx-powerpoint-open-failed");

  const complete = Boolean(
    finalFile.exists
    && sourceOutputFile.exists
    && workspaceValidation.exists
    && runValidation.exists
    && runSummary.exists
    && workspaceValidation.data?.passed === true
    && runValidation.data?.passed === true
    && summary.status === "complete"
    && (!expectedPages || validationSlides === expectedPages)
    && (!summaryPages || summaryPages === expectedPages)
    && (!editabilitySlides || editabilitySlides === expectedPages)
    && powerPointOpenability?.openable !== false
    && hashesMatch
    && issues.length === 0
  );

  return {
    ok: true,
    complete,
    runDir,
    finalPath: final.path || "",
    sourceOutputPath: final.sourceOutputPath || summary.output || "",
    validationPath: final.validation?.path || "",
    issues: [...new Set(issues)],
    summary: {
      hasFinal: finalFile.exists,
      hasWorkspaceValidation: workspaceValidation.exists,
      hasRunValidation: runValidation.exists,
      hasRunSummary: runSummary.exists,
      validationPassed: workspaceValidation.data?.passed === true && runValidation.data?.passed === true,
      runSummaryComplete: summary.status === "complete",
      finalSize: finalFile.size,
      sourceOutputSize: sourceOutputFile.size,
      finalHash,
      sourceOutputHash,
      hashesMatch,
      rawHashesMatch,
      openableRepairOk,
      expectedPages,
      validationSlides,
      summaryPages,
      editabilitySlides,
      pageJobCount,
      validationFailuresEmpty: FINAL_VALIDATION_ARRAYS.every((key) => !Array.isArray(validation[key]) || validation[key].length === 0),
      powerPointOpenable: powerPointOpenability?.openable ?? null,
      foregroundAssetIssues,
      visualQa
    },
    powerPointOpenability
  };
}

function inspectFinalVisualQuality(job = {}, runDir = "", pageJobs = {}) {
  const artifacts = job.artifacts || {};
  const final = artifacts.editableFinal || {};
  const manualReviewCurrent = isManualReviewCurrent(artifacts.manualReview, final);
  const visualImages = Array.isArray(artifacts.visualImages) ? artifacts.visualImages : [];
  const pageIds = collectVisualQaPageIds(visualImages, pageJobs);
  const pages = pageIds.map((pageId) => {
    const target = visualImages.find((image) => cleanPageId(image.pageId || image.page_id || image.pageNumber || image.page) === pageId) || {};
    const targetPath = resolveMaybe(target.path);
    const previewPath = runDir ? path.join(runDir, "pages", pageId, "preview.png") : "";
    const contactSheetPath = runDir ? path.join(runDir, "pages", pageId, "split_assets_contact.png") : "";
    const targetFile = statFile(targetPath);
    const previewFile = statFile(previewPath);
    const contactSheetFile = statFile(contactSheetPath);
    const targetDimensions = readPngDimensions(targetPath);
    const previewDimensions = readPngDimensions(previewPath);
    const assetQuality = inspectPageGeneratedAssetQuality(runDir, pageId);
    const previewToTargetBytes = targetFile.size && previewFile.size
      ? Number((previewFile.size / targetFile.size).toFixed(3))
      : 0;
    const issues = [];
    if (!targetPath || !targetFile.exists) issues.push("target-visual-missing");
    if (!previewPath || !previewFile.exists) issues.push("editable-preview-missing");
    if (!contactSheetFile.exists) issues.push("asset-contact-sheet-missing");
    if (targetFile.exists && previewFile.exists && previewFile.size < targetFile.size * 0.3) {
      issues.push("preview-too-small-simplified");
    }
    if (targetDimensions && previewDimensions) {
      const targetRatio = targetDimensions.width / Math.max(1, targetDimensions.height);
      const previewRatio = previewDimensions.width / Math.max(1, previewDimensions.height);
      if (Math.abs(targetRatio - previewRatio) > 0.03) issues.push("preview-aspect-ratio-mismatch");
    }
    if (assetQuality.checkerboardAssets.length) issues.push("asset-checkerboard-background");
    return {
      pageId,
      targetPath: target.path || "",
      previewPath,
      contactSheetPath,
      targetSize: targetFile.size,
      previewSize: previewFile.size,
      previewToTargetBytes,
      targetDimensions,
      previewDimensions,
      assetQuality,
      contactSheetExists: contactSheetFile.exists,
      issues
    };
  });
  const pageIssueIds = pages.flatMap((page) => page.issues.map((issue) => `${page.pageId}:${issue}`));
  const blockingIssues = [];
  if (pageIds.length && !manualReviewCurrent) blockingIssues.push("final-visual-qa-needs-review");
  if (pageIssueIds.some((issue) => /target-visual-missing|editable-preview-missing|preview-too-small-simplified|preview-aspect-ratio-mismatch/.test(issue))) {
    blockingIssues.push("final-visual-qa-failed");
  }
  if (pageIssueIds.some((issue) => /asset-checkerboard-background/.test(issue))) {
    blockingIssues.push("final-visual-asset-qa-failed");
  }
  return {
    status: blockingIssues.length ? "failed" : pageIds.length ? "pass" : "not_applicable",
    manualReviewCurrent,
    pageCount: pageIds.length,
    failedPageCount: pages.filter((page) => page.issues.length).length,
    blockingIssues: [...new Set(blockingIssues)],
    pageIssues: pageIssueIds,
    pages
  };
}

function inspectPageGeneratedAssetQuality(runDir = "", pageId = "") {
  const pageDir = runDir && pageId ? path.join(runDir, "pages", pageId) : "";
  const manifestFiles = collectManifestImageFiles(pageDir);
  const files = manifestFiles.length ? manifestFiles : collectPageAssetFiles(pageDir);
  const checkerboardAssets = [];
  for (const filePath of [...new Set(files)]) {
    const result = inspectPngCheckerboard(filePath);
    if (result.checkerboardLike) {
      checkerboardAssets.push({
        path: path.relative(pageDir, filePath).replace(/\\/g, "/"),
        grayRatio: result.grayRatio,
        alternationRatio: result.alternationRatio,
        score: result.score
      });
    }
  }
  return {
    checkedAssets: files.length,
    checkerboardAssets
  };
}

function collectManifestImageFiles(pageDir = "") {
  const manifestPath = path.join(pageDir, "manifest.json");
  if (!pageDir || !fsSync.existsSync(manifestPath)) return [];
  let manifest = null;
  try {
    manifest = JSON.parse(fsSync.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return [];
  }
  const files = [];
  for (const image of Array.isArray(manifest?.images) ? manifest.images : []) {
    for (const key of ["path", "src", "asset", "asset_path", "image", "source"]) {
      const filePath = resolvePageRelativeFile(pageDir, image?.[key]);
      if (filePath && /\.png$/i.test(filePath) && fsSync.existsSync(filePath)) files.push(filePath);
    }
  }
  return [...new Set(files)];
}

function collectPageAssetFiles(pageDir = "") {
  const assetDirs = [
    path.join(pageDir, "assets", "generated"),
    path.join(pageDir, "assets")
  ];
  const files = [];
  for (const dir of assetDirs) {
    if (!dir || !fsSync.existsSync(dir) || !fsSync.statSync(dir).isDirectory()) continue;
    for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.png$/i.test(entry.name)) continue;
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

function resolvePageRelativeFile(pageDir = "", value = "") {
  const raw = String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!raw || /^https?:\/\//i.test(raw) || path.isAbsolute(raw) || raw.split("/").includes("..")) return "";
  const resolved = path.resolve(pageDir, raw);
  return isInsidePath(resolved, path.resolve(pageDir)) ? resolved : "";
}

function inspectPngCheckerboard(filePath = "") {
  const pixels = readPngPixels(filePath);
  if (!pixels) return { checkerboardLike: false, grayRatio: 0, alternationRatio: 0, score: 0 };
  const maxWidth = 300;
  const maxHeight = 180;
  const stepX = Math.max(1, Math.floor(pixels.width / maxWidth));
  const stepY = Math.max(1, Math.floor(pixels.height / maxHeight));
  const sampledWidth = Math.ceil(pixels.width / stepX);
  const sampledHeight = Math.ceil(pixels.height / stepY);
  const gray = [];
  const bright = [];
  let grayCount = 0;
  let total = 0;
  for (let y = 0; y < pixels.height; y += stepY) {
    const rowGray = [];
    const rowBright = [];
    for (let x = 0; x < pixels.width; x += stepX) {
      const pixel = getPixel(pixels, x, y);
      const isGray = isOpaqueGrayWhite(pixel);
      rowGray.push(isGray);
      rowBright.push(pixel.r);
      if (isGray) grayCount += 1;
      total += 1;
    }
    gray.push(rowGray);
    bright.push(rowBright);
  }
  let grayAdjacencies = 0;
  let alternating = 0;
  for (let y = 0; y < sampledHeight; y += 1) {
    for (let x = 0; x < sampledWidth; x += 1) {
      if (x + 1 < sampledWidth && gray[y]?.[x] && gray[y]?.[x + 1]) {
        grayAdjacencies += 1;
        if (Math.abs((bright[y]?.[x] || 0) - (bright[y]?.[x + 1] || 0)) > 12) alternating += 1;
      }
      if (y + 1 < sampledHeight && gray[y]?.[x] && gray[y + 1]?.[x]) {
        grayAdjacencies += 1;
        if (Math.abs((bright[y]?.[x] || 0) - (bright[y + 1]?.[x] || 0)) > 12) alternating += 1;
      }
    }
  }
  const grayRatio = total ? grayCount / total : 0;
  const alternationRatio = grayAdjacencies ? alternating / grayAdjacencies : 0;
  const score = grayRatio * alternationRatio;
  return {
    checkerboardLike: grayRatio >= 0.4 && alternationRatio >= 0.1 && score >= 0.05,
    grayRatio: Number(grayRatio.toFixed(3)),
    alternationRatio: Number(alternationRatio.toFixed(3)),
    score: Number(score.toFixed(3))
  };
}

function readPngPixels(filePath = "") {
  if (!filePath || !fsSync.existsSync(filePath)) return null;
  try {
    const buffer = fsSync.readFileSync(filePath);
    if (buffer.length < 24 || buffer[0] !== 0x89 || buffer.toString("ascii", 1, 4) !== "PNG") return null;
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    const bitDepth = buffer[24];
    const colorType = buffer[25];
    if (bitDepth !== 8 || ![2, 6].includes(colorType) || !width || !height) return null;
    const bytesPerPixel = colorType === 6 ? 4 : 3;
    const stride = width * bytesPerPixel;
    const idat = [];
    let offset = 8;
    while (offset + 12 <= buffer.length) {
      const length = buffer.readUInt32BE(offset);
      const type = buffer.toString("ascii", offset + 4, offset + 8);
      const dataStart = offset + 8;
      const dataEnd = dataStart + length;
      if (dataEnd > buffer.length) return null;
      if (type === "IDAT") idat.push(buffer.subarray(dataStart, dataEnd));
      if (type === "IEND") break;
      offset = dataEnd + 4;
    }
    const inflated = zlib.inflateSync(Buffer.concat(idat));
    const pixels = Buffer.alloc(width * height * 4);
    let src = 0;
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < height; y += 1) {
      const filter = inflated[src];
      src += 1;
      const row = Buffer.from(inflated.subarray(src, src + stride));
      src += stride;
      unfilterPngRow(row, prev, filter, bytesPerPixel);
      for (let x = 0; x < width; x += 1) {
        const inOffset = x * bytesPerPixel;
        const outOffset = (y * width + x) * 4;
        pixels[outOffset] = row[inOffset];
        pixels[outOffset + 1] = row[inOffset + 1];
        pixels[outOffset + 2] = row[inOffset + 2];
        pixels[outOffset + 3] = bytesPerPixel === 4 ? row[inOffset + 3] : 255;
      }
      prev = row;
    }
    return { width, height, data: pixels };
  } catch {
    return null;
  }
}

function unfilterPngRow(row, prev, filter, bytesPerPixel) {
  for (let i = 0; i < row.length; i += 1) {
    const left = i >= bytesPerPixel ? row[i - bytesPerPixel] : 0;
    const up = prev[i] || 0;
    const upLeft = i >= bytesPerPixel ? prev[i - bytesPerPixel] || 0 : 0;
    if (filter === 1) row[i] = (row[i] + left) & 0xff;
    else if (filter === 2) row[i] = (row[i] + up) & 0xff;
    else if (filter === 3) row[i] = (row[i] + Math.floor((left + up) / 2)) & 0xff;
    else if (filter === 4) row[i] = (row[i] + paethPredictor(left, up, upLeft)) & 0xff;
  }
}

function paethPredictor(left, up, upLeft) {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  return pb <= pc ? up : upLeft;
}

function getPixel(pixels, x, y) {
  const offset = (y * pixels.width + x) * 4;
  return {
    r: pixels.data[offset],
    g: pixels.data[offset + 1],
    b: pixels.data[offset + 2],
    a: pixels.data[offset + 3]
  };
}

function isOpaqueGrayWhite(pixel = {}) {
  return pixel.a > 220
    && Math.abs(pixel.r - pixel.g) < 4
    && Math.abs(pixel.g - pixel.b) < 4
    && pixel.r >= 175
    && pixel.r <= 255;
}

function collectVisualQaPageIds(visualImages = [], pageJobs = {}) {
  const jobPageIds = [];
  for (const page of Array.isArray(pageJobs?.pages) ? pageJobs.pages : []) {
    const pageId = cleanPageId(page.page_id || page.pageId || path.basename(page.page_dir || page.pageDir || ""));
    if (pageId) jobPageIds.push(pageId);
  }
  if (jobPageIds.length) return [...new Set(jobPageIds)].sort();

  const ids = new Set();
  for (const image of visualImages) {
    const pageId = cleanPageId(image?.pageId || image?.page_id || image?.pageNumber || image?.page || "");
    if (pageId) ids.add(pageId);
  }
  return [...ids].sort();
}

function readPngDimensions(filePath = "") {
  if (!filePath || !fsSync.existsSync(filePath)) return null;
  try {
    const buffer = fsSync.readFileSync(filePath);
    const isPng = buffer.length >= 24
      && buffer[0] === 0x89
      && buffer.toString("ascii", 1, 4) === "PNG";
    if (!isPng) return null;
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20)
    };
  } catch {
    return null;
  }
}

function isUsableCachedPowerPointOpenability(cached = {}, finalFile = {}, final = {}) {
  if (!cached || typeof cached !== "object") return false;
  if (cached.openable !== true && cached.openable !== false) return false;
  if (!finalFile.exists) return false;
  if (Number(final.size || 0) && Number(final.size || 0) !== Number(finalFile.size || 0)) return false;
  return true;
}

function isManualReviewCurrent(manualReview = {}, final = {}) {
  if (!final.path) return false;
  return manualReview?.status === "approved"
    && manualReview.finalPath === final.path
    && Number(manualReview.finalSize || 0) === Number(final.size || 0)
    && String(manualReview.finalCreatedAt || "") === String(final.createdAt || "");
}

async function inspectPageForegroundAssets(runDir = "", pageJobs = {}) {
  if (!runDir || !fsSync.existsSync(runDir)) return [];
  const pages = Array.isArray(pageJobs?.pages) ? pageJobs.pages : [];
  const pageDirs = pages.length
    ? pages.map((page) => ({
        pageId: cleanPageId(page.page_id || page.pageId || path.basename(page.page_dir || page.pageDir || "")),
        dir: path.resolve(runDir, String(page.page_dir || page.pageDir || `pages/${page.page_id || ""}`))
      }))
    : listPageDirs(runDir);
  const issues = [];
  for (const page of pageDirs) {
    const pageDir = page.dir;
    const manifestPath = path.join(pageDir, "manifest.json");
    if (!isInsidePath(pageDir, runDir) || !fsSync.existsSync(manifestPath)) continue;
    const manifest = await readJsonIfFile(manifestPath);
    if (!manifest.exists || !manifest.data) continue;
    const missing = collectMissingForegroundAssets(manifest.data);
    if (missing.length) {
      issues.push({
        pageId: page.pageId || path.basename(pageDir),
        missing
      });
    }
  }
  return issues;
}

function listPageDirs(runDir = "") {
  const pagesRoot = path.join(runDir, "pages");
  if (!fsSync.existsSync(pagesRoot)) return [];
  return fsSync.readdirSync(pagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      pageId: cleanPageId(entry.name),
      dir: path.join(pagesRoot, entry.name)
    }));
}

function collectMissingForegroundAssets(manifest = {}) {
  const imageIds = new Set((Array.isArray(manifest.images) ? manifest.images : []).map((image) => cleanToken(image.id || "")).filter(Boolean));
  const imagePaths = new Set((Array.isArray(manifest.images) ? manifest.images : []).map((image) => normalizeAssetPath(image.path || "")).filter(Boolean));
  const provenanceText = JSON.stringify(manifest.asset_provenance || []);
  return (Array.isArray(manifest.visual_inventory) ? manifest.visual_inventory : [])
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .filter((item) => requiresForegroundAsset(item))
    .map((item) => {
      const id = cleanToken(item.id || "");
      const pathValue = normalizeAssetPath(item.path || item.asset_provenance?.path || item.asset_provenance?.source || "");
      const hasImage = (id && imageIds.has(id)) || (pathValue && imagePaths.has(pathValue));
      const hasProvenance = ASSET_SEPARATION_TERMS.test(provenanceText) && ((id && provenanceText.includes(id)) || (pathValue && provenanceText.includes(pathValue)));
      return hasImage && hasProvenance ? "" : (id || item.kind || "foreground_asset");
    })
    .filter(Boolean);
}

function requiresForegroundAsset(item = {}) {
  const text = JSON.stringify(item);
  if (/no foreground asset separation required/i.test(text)) return false;
  if (/^shape$/i.test(String(item.type || "")) && STRUCTURAL_TERMS.test(text)) return false;
  if (!FOREGROUND_TERMS.test(text) && !FOREGROUND_ASSET_TERMS.test(text)) return false;
  if (STRUCTURAL_TERMS.test(text) && !FOREGROUND_TERMS.test(text)) return false;
  return true;
}

function normalizeAssetPath(value = "") {
  const text = String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!text || path.isAbsolute(text) || text.split("/").includes("..")) return "";
  return text;
}

function statFile(filePath = "") {
  if (!filePath) return { exists: false, size: 0 };
  if (!fsSync.existsSync(filePath)) return { exists: false, size: 0 };
  const stat = fsSync.statSync(filePath);
  return stat.isFile() ? { exists: true, size: stat.size } : { exists: false, size: 0 };
}

async function readJsonIfFile(filePath = "") {
  if (!filePath) return { exists: false, data: null, error: "" };
  if (!fsSync.existsSync(filePath) || !fsSync.statSync(filePath).isFile()) return { exists: false, data: null, error: "file not found" };
  try {
    return { exists: true, data: JSON.parse(await fs.readFile(filePath, "utf8")), error: "" };
  } catch (error) {
    return { exists: true, data: null, error: error.message || "failed to parse json" };
  }
}

function resolveMaybe(value = "") {
  const raw = String(value || "").trim();
  return raw ? path.resolve(raw) : "";
}

async function hashFile(filePath) {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function isInsidePath(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function numberOrZero(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function cleanPageId(value = "") {
  const text = String(value || "").trim().toLowerCase();
  const match = text.match(/\d+/);
  return match ? `page_${String(Number(match[0])).padStart(3, "0")}` : text;
}

function cleanToken(value = "") {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
}
