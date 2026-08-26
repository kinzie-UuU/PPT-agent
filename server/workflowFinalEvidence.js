import crypto from "crypto";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import zlib from "zlib";
import { readWorkflowJob } from "./workflowJobs.js";
import { inspectEditablePptx, inspectPowerPointOpenability, inspectPowerPointTextLayout } from "./pptxEditability.js";

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
const VISUAL_FIDELITY_CACHE = new Map();
const FILE_HASH_CACHE = new Map();
const POWERPOINT_OPENABILITY_CACHE = new Map();
const POWERPOINT_TEXT_LAYOUT_CACHE = new Map();
const FILE_HASH_CACHE_MAX_ENTRIES = 200;
export const EDITABLE_VISUAL_SIMILARITY_MINIMUM = 0.93;
export const EDITABLE_VISUAL_SIMILARITY_CRITICAL = 0.82;
const BLOCKING_EDITABLE_VISUAL_ISSUES = new Set([
  "target-visual-missing",
  "editable-preview-missing",
  "preview-too-small-simplified",
  "preview-aspect-ratio-mismatch",
  "preview-visual-similarity-critical",
  "preview-structure-loss",
  "visual-comparison-unavailable",
  "asset-checkerboard-background"
]);

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
  const hashesMatch = rawHashesMatch;
  if (finalHash && sourceOutputHash && !hashesMatch) issues.push("final-copy-hash-mismatch");
  if (finalFile.exists && sourceOutputFile.exists && finalFile.size !== sourceOutputFile.size) issues.push("final-copy-size-mismatch");
  const powerPointOpenability = await resolvePowerPointOpenability({
    cached: final.powerPointOpenability,
    final,
    finalFile,
    finalHash,
    finalPath
  });
  if (powerPointOpenability?.available !== true) issues.push("final-pptx-powerpoint-check-unavailable");
  else if (powerPointOpenability.openable !== true) issues.push("final-pptx-powerpoint-open-failed");
  if (expectedPages && Number(powerPointOpenability?.slideCount || 0) !== expectedPages) {
    issues.push("final-pptx-powerpoint-slide-count-mismatch");
  }
  const powerPointTextLayout = await resolvePowerPointTextLayout({
    cached: final.powerPointTextLayout,
    final,
    finalFile,
    finalHash,
    finalPath
  });
  if (powerPointTextLayout?.available !== true) issues.push("final-pptx-powerpoint-text-layout-check-unavailable");
  else if (powerPointTextLayout.passed !== true) issues.push("final-pptx-powerpoint-text-overflow");
  if (expectedPages && Number(powerPointTextLayout?.slideCount || 0) !== expectedPages) {
    issues.push("final-pptx-powerpoint-text-layout-slide-count-mismatch");
  }
  const pptxEditability = finalFile.exists
    ? await inspectEditablePptx(finalPath).catch((error) => ({
        version: 1,
        source: "pptx-openxml-inspection",
        status: "warn",
        editable: false,
        flattenedStructureDeck: false,
        warnings: ["pptx-editability-inspection-failed"],
        error: error.message || "inspection failed"
      }))
    : null;
  if (pptxEditability?.flattenedStructureDeck === true) issues.push("final-pptx-flattened-editable-structure");
  if (pptxEditability && pptxEditability.editable !== true) issues.push("final-pptx-editability-not-passed");
  if (expectedPages && Number(pptxEditability?.slideCount || 0) !== expectedPages) {
    issues.push("final-pptx-openxml-slide-count-mismatch");
  }
  if (Number(pptxEditability?.nativeTextBoxes || 0) > 0 && Number(powerPointTextLayout?.checkedTextFrames || 0) === 0) {
    issues.push("final-pptx-powerpoint-text-layout-empty");
  }

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
    && powerPointOpenability?.available === true
    && powerPointOpenability?.openable === true
    && (!expectedPages || Number(powerPointOpenability?.slideCount || 0) === expectedPages)
    && powerPointTextLayout?.available === true
    && powerPointTextLayout?.passed === true
    && (!expectedPages || Number(powerPointTextLayout?.slideCount || 0) === expectedPages)
    && (Number(pptxEditability?.nativeTextBoxes || 0) === 0 || Number(powerPointTextLayout?.checkedTextFrames || 0) > 0)
    && pptxEditability?.editable === true
    && (!expectedPages || Number(pptxEditability?.slideCount || 0) === expectedPages)
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
      powerPointSlideCount: Number(powerPointOpenability?.slideCount || 0),
      powerPointTextLayoutPassed: powerPointTextLayout?.passed ?? null,
      powerPointTextLayoutSlideCount: Number(powerPointTextLayout?.slideCount || 0),
      powerPointCheckedTextFrames: Number(powerPointTextLayout?.checkedTextFrames || 0),
      overflowingTextFrames: Number(powerPointTextLayout?.overflowingTextFrames || 0),
      openXmlSlideCount: Number(pptxEditability?.slideCount || 0),
      flattenedStructureDeck: pptxEditability?.flattenedStructureDeck ?? null,
      foregroundAssetIssues,
      visualQa
    },
    powerPointOpenability,
    powerPointTextLayout,
    pptxEditability
  };
}

export function inspectFinalVisualQuality(job = {}, runDir = "", pageJobs = {}) {
  const artifacts = job.artifacts || {};
  const final = artifacts.editableFinal || {};
  const manualReviewCurrent = isManualReviewCurrent(artifacts.manualReview, final);
  const visualImages = (Array.isArray(artifacts.visualImages) ? artifacts.visualImages : [])
    .filter((image) => image?.path && image.staleStyleReference !== true);
  const pageIds = collectVisualQaPageIds(visualImages, pageJobs);
  const pages = pageIds.map((pageId) => {
    const target = visualImages.find((image) => cleanPageId(image.pageId || image.page_id || image.pageNumber || image.page) === pageId) || {};
    const visualImagePath = resolveMaybe(target.path);
    const previewPath = runDir ? path.join(runDir, "pages", pageId, "preview.png") : "";
    const contactSheetPath = runDir ? path.join(runDir, "pages", pageId, "split_assets_contact.png") : "";
    const productVisualQa = readCurrentProductVisualQa(runDir, pageId, previewPath);
    const targetPath = productVisualQa.current ? productVisualQa.sourcePath : visualImagePath;
    const targetFile = statFile(targetPath);
    const previewFile = statFile(previewPath);
    const contactSheetFile = statFile(contactSheetPath);
    const targetDimensions = readPngDimensions(targetPath);
    const previewDimensions = readPngDimensions(previewPath);
    const visualSimilarity = productVisualQa.current
      ? productVisualQa.comparison
      : targetFile.exists && previewFile.exists
        ? comparePngVisualFidelity(targetPath, previewPath)
      : { available: false };
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
    issues.push(...evaluateEditableVisualFidelity(visualSimilarity));
    if (productVisualQa.current) issues.push(...productVisualQa.issues);
    if (assetQuality.checkerboardAssets.length) issues.push("asset-checkerboard-background");
    const pageRecord = {
      pageId,
      targetPath,
      visualImagePath: target.path || "",
      previewPath,
      contactSheetPath,
      targetSize: targetFile.size,
      previewSize: previewFile.size,
      targetModifiedAt: targetFile.mtimeMs,
      previewModifiedAt: previewFile.mtimeMs,
      previewToTargetBytes,
      targetDimensions,
      previewDimensions,
      minimumSimilarity: EDITABLE_VISUAL_SIMILARITY_MINIMUM,
      visualSimilarity,
      productVisualQa,
      assetQuality,
      contactSheetExists: contactSheetFile.exists,
      issues
    };
    return {
      ...pageRecord,
      signature: buildEditableVisualQaSignature(pageRecord)
    };
  });
  const pageIssueIds = pages.flatMap((page) => page.issues.map((issue) => `${page.pageId}:${issue}`));
  const blockingPageIssueIds = pages.flatMap((page) => page.issues
    .filter(isBlockingEditableVisualIssue)
    .map((issue) => `${page.pageId}:${issue}`));
  const blockingIssues = [];
  const automatedVisualFailed = blockingPageIssueIds.some((issue) => !issue.endsWith(":asset-checkerboard-background"));
  const automatedAssetFailed = blockingPageIssueIds.some((issue) => issue.endsWith(":asset-checkerboard-background"));
  if (automatedVisualFailed) {
    blockingIssues.push("final-visual-qa-failed");
  }
  if (automatedAssetFailed) {
    blockingIssues.push("final-visual-asset-qa-failed");
  }
  const automatedStatus = automatedVisualFailed || automatedAssetFailed
    ? "failed"
    : pageIds.length
      ? "pass"
      : "not_applicable";
  const manualReviewStatus = !pageIds.length
    ? "not_applicable"
    : manualReviewCurrent
      ? "pass"
      : "pending";
  return {
    status: automatedStatus === "failed" ? "failed" : manualReviewStatus === "pending" ? "review" : automatedStatus,
    automatedStatus,
    manualReviewStatus,
    manualReviewCurrent,
    pageCount: pageIds.length,
    failedPageCount: pages.filter((page) => page.issues.some(isBlockingEditableVisualIssue)).length,
    blockingIssues: [...new Set(blockingIssues)],
    pageIssues: pageIssueIds,
    pages
  };
}

function readCurrentProductVisualQa(runDir = "", pageId = "", previewPath = "") {
  const pageDir = runDir && pageId ? path.join(runDir, "pages", pageId) : "";
  const qaPath = pageDir ? path.join(pageDir, "product-visual-qa.json") : "";
  const qaFile = statFile(qaPath);
  const unavailable = {
    path: qaPath,
    sourcePath: "",
    current: false,
    comparisonMode: "",
    editableTextContractPassed: false,
    comparison: { available: false },
    issues: []
  };
  if (!qaFile.exists) return unavailable;
  let qa = null;
  try {
    qa = JSON.parse(fsSync.readFileSync(qaPath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return unavailable;
  }
  const qaSourcePath = resolveMaybe(qa?.sourcePath);
  const qaPreviewPath = resolveMaybe(qa?.previewPath);
  const sourceFile = statFile(qaSourcePath);
  const previewFile = statFile(previewPath);
  const textBoxes = Array.isArray(qa?.editableTextContract?.boxes) ? qa.editableTextContract.boxes : [];
  const comparisonMode = String(qa?.comparisonMode || "");
  const comparison = qa?.comparison && typeof qa.comparison === "object" ? qa.comparison : { available: false };
  const pathsCurrent = Boolean(
    qaSourcePath
    && qaPreviewPath
    && path.resolve(qaSourcePath) === path.resolve(path.join(pageDir, "source.png"))
    && path.resolve(qaPreviewPath) === path.resolve(previewPath)
    && sourceFile.exists
    && previewFile.exists
    && qaFile.mtimeMs >= sourceFile.mtimeMs
    && qaFile.mtimeMs >= previewFile.mtimeMs
  );
  const contractCurrent = comparisonMode === "non-text-structure-with-validated-editable-text-mask"
    && qa?.editableTextContract?.passed === true
    && comparison?.available === true
    && Number(comparison.ignoredEditableTextBoxCount || 0) === textBoxes.length;
  return {
    path: qaPath,
    sourcePath: qaSourcePath,
    current: Boolean(pathsCurrent && contractCurrent),
    comparisonMode,
    editableTextContractPassed: qa?.editableTextContract?.passed === true,
    checkedAt: qa?.checkedAt || "",
    comparison,
    issues: Array.isArray(qa?.issues) ? qa.issues.map((issue) => String(issue || "")).filter(Boolean) : []
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

export function comparePngVisualFidelity(targetPath = "", previewPath = "", options = {}) {
  const ignoreBoxes = normalizeVisualIgnoreBoxes(options.ignoreBoxes);
  const cacheKey = buildVisualFidelityCacheKey(targetPath, previewPath, ignoreBoxes);
  if (cacheKey && VISUAL_FIDELITY_CACHE.has(cacheKey)) return VISUAL_FIDELITY_CACHE.get(cacheKey);
  const target = readPngPixels(targetPath);
  const preview = readPngPixels(previewPath);
  if (!target || !preview) {
    const unavailable = {
      available: false,
      score: 0,
      pixelSimilarity: 0,
      edgeSimilarity: 0,
      edgeOverlap: 0,
      edgeRetention: 0,
      colorHistogramSimilarity: 0
    };
    rememberVisualFidelity(cacheKey, unavailable);
    return unavailable;
  }

  const gridWidth = 96;
  const gridHeight = 54;
  const targetSamples = sampleNormalizedRgb(target, gridWidth, gridHeight);
  const previewSamples = sampleNormalizedRgb(preview, gridWidth, gridHeight);
  maskValidatedEditableTextRegions(targetSamples, previewSamples, gridWidth, gridHeight, target.width, target.height, ignoreBoxes);
  const targetEdges = buildEdgeMap(targetSamples, gridWidth, gridHeight);
  const previewEdges = buildEdgeMap(previewSamples, gridWidth, gridHeight);
  let pixelDifference = 0;
  let edgeDifference = 0;
  let targetEdgeCount = 0;
  let previewEdgeCount = 0;
  let overlappingEdges = 0;

  for (let index = 0; index < targetSamples.length; index += 3) {
    pixelDifference += Math.abs(targetSamples[index] - previewSamples[index]);
    pixelDifference += Math.abs(targetSamples[index + 1] - previewSamples[index + 1]);
    pixelDifference += Math.abs(targetSamples[index + 2] - previewSamples[index + 2]);
  }
  for (let index = 0; index < targetEdges.length; index += 1) {
    const targetEdge = targetEdges[index];
    const previewEdge = previewEdges[index];
    edgeDifference += Math.abs(targetEdge - previewEdge);
    if (targetEdge >= 24) {
      targetEdgeCount += 1;
      if (previewEdge >= 14) overlappingEdges += 1;
    }
    if (previewEdge >= 24) previewEdgeCount += 1;
  }

  const pixelSimilarity = 1 - pixelDifference / Math.max(1, targetSamples.length * 255);
  const edgeSimilarity = 1 - edgeDifference / Math.max(1, targetEdges.length * 255);
  const edgeOverlap = targetEdgeCount ? overlappingEdges / targetEdgeCount : 1;
  const edgeRetention = targetEdgeCount ? Math.min(1, previewEdgeCount / targetEdgeCount) : 1;
  const colorHistogramSimilarity = compareColorHistograms(targetSamples, previewSamples);
  const tileComparison = compareVisualTiles(targetSamples, previewSamples, targetEdges, previewEdges, gridWidth, gridHeight);
  const score = (
    pixelSimilarity * 0.45
    + edgeSimilarity * 0.2
    + edgeOverlap * 0.2
    + colorHistogramSimilarity * 0.15
  );

  const result = {
    available: true,
    rawScore: score,
    score: roundMetric(score),
    pixelSimilarity: roundMetric(pixelSimilarity),
    edgeSimilarity: roundMetric(edgeSimilarity),
    edgeOverlap: roundMetric(edgeOverlap),
    edgeRetention: roundMetric(edgeRetention),
    colorHistogramSimilarity: roundMetric(colorHistogramSimilarity),
    ...tileComparison,
    targetEdgeCount,
    previewEdgeCount,
    grid: `${gridWidth}x${gridHeight}`,
    ignoredEditableTextBoxCount: ignoreBoxes.length
  };
  rememberVisualFidelity(cacheKey, result);
  return result;
}

function normalizeVisualIgnoreBoxes(boxes = []) {
  return (Array.isArray(boxes) ? boxes : [])
    .map((box) => Array.isArray(box) && box.length === 4 ? box.map(Number) : null)
    .filter((box) => box && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0)
    .map((box) => [box[0] - 10, box[1] - 10, box[2] + 20, box[3] + 20]);
}

function maskValidatedEditableTextRegions(targetSamples, previewSamples, gridWidth, gridHeight, sourceWidth, sourceHeight, boxes = []) {
  if (!boxes.length || !sourceWidth || !sourceHeight) return;
  for (let y = 0; y < gridHeight; y += 1) {
    const sourceY = ((y + 0.5) / gridHeight) * sourceHeight;
    for (let x = 0; x < gridWidth; x += 1) {
      const sourceX = ((x + 0.5) / gridWidth) * sourceWidth;
      if (!boxes.some((box) => sourceX >= box[0] && sourceX <= box[0] + box[2] && sourceY >= box[1] && sourceY <= box[1] + box[3])) continue;
      const offset = (y * gridWidth + x) * 3;
      targetSamples[offset] = 246;
      targetSamples[offset + 1] = 248;
      targetSamples[offset + 2] = 251;
      previewSamples[offset] = 246;
      previewSamples[offset + 1] = 248;
      previewSamples[offset + 2] = 251;
    }
  }
}

function compareVisualTiles(targetSamples, previewSamples, targetEdges, previewEdges, width, height) {
  const tileColumns = 8;
  const tileRows = 6;
  const tileWidth = width / tileColumns;
  const tileHeight = height / tileRows;
  const contentTileScores = [];
  let weakContentTiles = 0;
  for (let tileY = 0; tileY < tileRows; tileY += 1) {
    for (let tileX = 0; tileX < tileColumns; tileX += 1) {
      let pixelDifference = 0;
      let edgeDifference = 0;
      let sampleCount = 0;
      let targetEdgeCount = 0;
      let previewEdgeCount = 0;
      let overlappingEdges = 0;
      const startX = Math.floor(tileX * tileWidth);
      const endX = Math.floor((tileX + 1) * tileWidth);
      const startY = Math.floor(tileY * tileHeight);
      const endY = Math.floor((tileY + 1) * tileHeight);
      for (let y = startY; y < endY; y += 1) {
        for (let x = startX; x < endX; x += 1) {
          const pixelIndex = (y * width + x) * 3;
          const edgeIndex = y * width + x;
          pixelDifference += Math.abs(targetSamples[pixelIndex] - previewSamples[pixelIndex]);
          pixelDifference += Math.abs(targetSamples[pixelIndex + 1] - previewSamples[pixelIndex + 1]);
          pixelDifference += Math.abs(targetSamples[pixelIndex + 2] - previewSamples[pixelIndex + 2]);
          edgeDifference += Math.abs(targetEdges[edgeIndex] - previewEdges[edgeIndex]);
          sampleCount += 1;
          if (targetEdges[edgeIndex] >= 24) {
            targetEdgeCount += 1;
            if (previewEdges[edgeIndex] >= 14) overlappingEdges += 1;
          }
          if (previewEdges[edgeIndex] >= 24) previewEdgeCount += 1;
        }
      }
      if (targetEdgeCount < 5) continue;
      const pixelSimilarity = 1 - pixelDifference / Math.max(1, sampleCount * 3 * 255);
      const edgeSimilarity = 1 - edgeDifference / Math.max(1, sampleCount * 255);
      const edgeOverlap = overlappingEdges / targetEdgeCount;
      const edgeRetention = Math.min(1, previewEdgeCount / targetEdgeCount);
      const score = pixelSimilarity * 0.45 + edgeSimilarity * 0.2 + edgeOverlap * 0.35;
      contentTileScores.push(score);
      if (score < 0.68 || (edgeOverlap < 0.3 && edgeRetention < 0.55)) weakContentTiles += 1;
    }
  }
  const sortedScores = contentTileScores.sort((left, right) => left - right);
  const percentileIndex = Math.min(sortedScores.length - 1, Math.floor(sortedScores.length * 0.15));
  return {
    contentTileCount: sortedScores.length,
    weakContentTileRatio: roundMetric(sortedScores.length ? weakContentTiles / sortedScores.length : 0),
    worstContentTileScore: roundMetric(sortedScores[0] ?? 1),
    lowContentTileScore: roundMetric(sortedScores[percentileIndex] ?? 1),
    tileGrid: `${tileColumns}x${tileRows}`
  };
}

export function evaluateEditableVisualFidelity(comparison = {}) {
  if (comparison?.available !== true) return ["visual-comparison-unavailable"];
  const issues = [];
  const similarityScore = Number.isFinite(Number(comparison.rawScore))
    ? Number(comparison.rawScore)
    : Number(comparison.score || 0);
  if (similarityScore < EDITABLE_VISUAL_SIMILARITY_MINIMUM) issues.push("preview-visual-similarity-low");
  if (similarityScore < EDITABLE_VISUAL_SIMILARITY_CRITICAL) issues.push("preview-visual-similarity-critical");
  if (
    Number(comparison.targetEdgeCount || 0) >= 120
    && Number(comparison.edgeOverlap || 0) < 0.4
    && Number(comparison.edgeRetention || 0) < 0.6
  ) {
    issues.push("preview-structure-loss");
  }
  if (
    Number(comparison.contentTileCount || 0) >= 8
    && Number(comparison.weakContentTileRatio || 0) >= 0.15
    && Number(comparison.lowContentTileScore || 1) < 0.7
  ) {
    issues.push("preview-structure-loss");
  }
  return [...new Set(issues)];
}

export function isBlockingEditableVisualIssue(issue = "") {
  return BLOCKING_EDITABLE_VISUAL_ISSUES.has(String(issue || ""));
}

export function buildEditableVisualQaSignature(page = {}) {
  return [
    page.pageId || "",
    Number(page.targetSize || 0),
    Number(page.previewSize || 0),
    Number(page.targetModifiedAt || 0),
    Number(page.previewModifiedAt || 0),
    Number(page.minimumSimilarity || EDITABLE_VISUAL_SIMILARITY_MINIMUM),
    Number(page.visualSimilarity?.rawScore || 0),
    Number(page.visualSimilarity?.score || 0),
    Number(page.visualSimilarity?.edgeOverlap || 0),
    Number(page.visualSimilarity?.weakContentTileRatio || 0)
  ].join(":");
}

function buildVisualFidelityCacheKey(targetPath = "", previewPath = "", ignoreBoxes = []) {
  const target = statFile(targetPath);
  const preview = statFile(previewPath);
  if (!target.exists || !preview.exists) return "";
  return [path.resolve(targetPath), target.size, target.mtimeMs, path.resolve(previewPath), preview.size, preview.mtimeMs, JSON.stringify(ignoreBoxes)].join("|");
}

function rememberVisualFidelity(cacheKey, result) {
  if (!cacheKey) return;
  VISUAL_FIDELITY_CACHE.set(cacheKey, result);
  while (VISUAL_FIDELITY_CACHE.size > 200) {
    VISUAL_FIDELITY_CACHE.delete(VISUAL_FIDELITY_CACHE.keys().next().value);
  }
}

function sampleNormalizedRgb(image, gridWidth, gridHeight) {
  const samples = new Uint8Array(gridWidth * gridHeight * 3);
  for (let gridY = 0; gridY < gridHeight; gridY += 1) {
    const sourceY = Math.min(image.height - 1, Math.floor(((gridY + 0.5) / gridHeight) * image.height));
    for (let gridX = 0; gridX < gridWidth; gridX += 1) {
      const sourceX = Math.min(image.width - 1, Math.floor(((gridX + 0.5) / gridWidth) * image.width));
      const sourceOffset = (sourceY * image.width + sourceX) * 4;
      const sampleOffset = (gridY * gridWidth + gridX) * 3;
      samples[sampleOffset] = image.data[sourceOffset];
      samples[sampleOffset + 1] = image.data[sourceOffset + 1];
      samples[sampleOffset + 2] = image.data[sourceOffset + 2];
    }
  }
  return samples;
}

function buildEdgeMap(samples, width, height) {
  const edges = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const left = (y * width + x - 1) * 3;
      const right = (y * width + x + 1) * 3;
      const up = ((y - 1) * width + x) * 3;
      const down = ((y + 1) * width + x) * 3;
      let gradient = 0;
      for (let channel = 0; channel < 3; channel += 1) {
        gradient += Math.abs(samples[right + channel] - samples[left + channel]);
        gradient += Math.abs(samples[down + channel] - samples[up + channel]);
      }
      edges[y * width + x] = Math.min(255, Math.round(gradient / 6));
    }
  }
  return edges;
}

function compareColorHistograms(targetSamples, previewSamples) {
  const targetHistogram = new Uint32Array(64);
  const previewHistogram = new Uint32Array(64);
  for (let index = 0; index < targetSamples.length; index += 3) {
    targetHistogram[colorBin(targetSamples, index)] += 1;
    previewHistogram[colorBin(previewSamples, index)] += 1;
  }
  let intersection = 0;
  const total = targetSamples.length / 3;
  for (let index = 0; index < targetHistogram.length; index += 1) {
    intersection += Math.min(targetHistogram[index], previewHistogram[index]);
  }
  return total ? intersection / total : 0;
}

function colorBin(samples, offset) {
  return (samples[offset] >> 6) * 16 + (samples[offset + 1] >> 6) * 4 + (samples[offset + 2] >> 6);
}

function roundMetric(value) {
  return Number(Math.max(0, Math.min(1, value)).toFixed(3));
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
  for (const image of visualImages.filter((item) => item?.staleStyleReference !== true)) {
    const pageId = cleanPageId(image?.pageId || image?.page_id || image?.pageNumber || image?.page || "");
    if (pageId) ids.add(pageId);
  }
  return [...ids].sort();
}

function readPngDimensions(filePath = "") {
  if (!filePath || !fsSync.existsSync(filePath)) return null;
  let fileHandle = null;
  try {
    fileHandle = fsSync.openSync(filePath, "r");
    const buffer = Buffer.alloc(24);
    const bytesRead = fsSync.readSync(fileHandle, buffer, 0, buffer.length, 0);
    const isPng = bytesRead >= 24
      && buffer[0] === 0x89
      && buffer.toString("ascii", 1, 4) === "PNG";
    if (!isPng) return null;
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20)
    };
  } catch {
    return null;
  } finally {
    if (fileHandle !== null) {
      try { fsSync.closeSync(fileHandle); } catch { /* Ignore close errors after a best-effort dimension read. */ }
    }
  }
}

export function isUsableCachedPowerPointOpenability(cached = {}, finalFile = {}, final = {}, finalHash = "") {
  if (!cached || typeof cached !== "object") return false;
  if (cached.available !== true) return false;
  if (cached.openable !== true && cached.openable !== false) return false;
  if (!finalFile.exists) return false;
  if (Number(final.size || 0) && Number(final.size || 0) !== Number(finalFile.size || 0)) return false;
  if (!finalHash || !final.sha256 || final.sha256 !== finalHash) return false;
  if (!cached.finalSha256 || cached.finalSha256 !== finalHash) return false;
  return true;
}

async function resolvePowerPointOpenability({ cached = {}, final = {}, finalFile = {}, finalHash = "", finalPath = "" } = {}) {
  if (isUsableCachedPowerPointOpenability(cached, finalFile, final, finalHash)) return cached;
  if (!finalFile.exists) return null;
  const cacheKey = finalHash ? `${path.resolve(finalPath)}|${finalHash}` : "";
  if (cacheKey && POWERPOINT_OPENABILITY_CACHE.has(cacheKey)) return POWERPOINT_OPENABILITY_CACHE.get(cacheKey);
  const inspected = await inspectPowerPointOpenability(finalPath).catch((error) => ({
    version: 1,
    source: "powerpoint-com-open",
    available: process.platform === "win32",
    openable: false,
    slideCount: 0,
    warnings: ["powerpoint-open-check-failed"],
    error: error.message || "PowerPoint open check failed"
  }));
  const bound = {
    ...inspected,
    finalSha256: finalHash,
    finalSize: Number(finalFile.size || 0)
  };
  if (cacheKey) {
    POWERPOINT_OPENABILITY_CACHE.set(cacheKey, bound);
    if (POWERPOINT_OPENABILITY_CACHE.size > FILE_HASH_CACHE_MAX_ENTRIES) {
      POWERPOINT_OPENABILITY_CACHE.delete(POWERPOINT_OPENABILITY_CACHE.keys().next().value);
    }
  }
  return bound;
}

async function resolvePowerPointTextLayout({ cached = {}, final = {}, finalFile = {}, finalHash = "", finalPath = "" } = {}) {
  const cacheUsable = cached
    && typeof cached === "object"
    && cached.available === true
    && (cached.passed === true || cached.passed === false)
    && finalFile.exists
    && (!Number(final.size || 0) || Number(final.size || 0) === Number(finalFile.size || 0))
    && Boolean(finalHash && final.sha256 && final.sha256 === finalHash)
    && cached.finalSha256 === finalHash;
  if (cacheUsable) return cached;
  if (!finalFile.exists) return null;
  const cacheKey = finalHash ? `${path.resolve(finalPath)}|${finalHash}` : "";
  if (cacheKey && POWERPOINT_TEXT_LAYOUT_CACHE.has(cacheKey)) return POWERPOINT_TEXT_LAYOUT_CACHE.get(cacheKey);
  const inspected = await inspectPowerPointTextLayout(finalPath).catch((error) => ({
    version: 1,
    source: "powerpoint-com-text-layout",
    available: process.platform === "win32",
    passed: false,
    slideCount: 0,
    checkedTextFrames: 0,
    overflowingTextFrames: 0,
    slides: [],
    warnings: ["powerpoint-text-layout-check-failed"],
    error: error.message || "PowerPoint text-layout check failed"
  }));
  const bound = {
    ...inspected,
    finalSha256: finalHash,
    finalSize: Number(finalFile.size || 0)
  };
  if (cacheKey) {
    POWERPOINT_TEXT_LAYOUT_CACHE.set(cacheKey, bound);
    if (POWERPOINT_TEXT_LAYOUT_CACHE.size > FILE_HASH_CACHE_MAX_ENTRIES) {
      POWERPOINT_TEXT_LAYOUT_CACHE.delete(POWERPOINT_TEXT_LAYOUT_CACHE.keys().next().value);
    }
  }
  return bound;
}

function isManualReviewCurrent(manualReview = {}, final = {}) {
  if (!final.path) return false;
  return manualReview?.status === "approved"
    && manualReview.finalPath === final.path
    && Number(manualReview.finalSize || 0) === Number(final.size || 0)
    && Boolean(final.sha256)
    && manualReview.finalSha256 === final.sha256
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

export function collectMissingForegroundAssets(manifest = {}) {
  const images = Array.isArray(manifest.images) ? manifest.images : [];
  const provenance = Array.isArray(manifest.asset_provenance) ? manifest.asset_provenance : [];
  return (Array.isArray(manifest.visual_inventory) ? manifest.visual_inventory : [])
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .filter((item) => requiresForegroundAsset(item))
    .map((item) => {
      const id = cleanToken(item.id || "");
      const pathValue = normalizeAssetPath(item.path || item.asset_provenance?.path || item.asset_provenance?.source || "");
      const matches = images.filter((image) => foregroundImageMatches(item, image));
      const pathMatch = pathValue
        ? images.filter((image) => normalizeAssetPath(image.path || "") === pathValue)
        : [];
      const matchedImages = matches.length ? matches : pathMatch;
      const hasProvenance = matchedImages.length > 0
        && matchedImages.every((image) => provenance.some((entry) => provenanceMatchesImage(entry, image)));
      return hasProvenance ? "" : (id || item.kind || "foreground_asset");
    })
    .filter(Boolean);
}

function requiresForegroundAsset(item = {}) {
  const text = JSON.stringify(item);
  if (/no foreground asset separation required/i.test(text)) return false;
  if (/native structural/i.test(text) && STRUCTURAL_TERMS.test(text)) return false;
  if (/^shape$/i.test(String(item.type || "")) && STRUCTURAL_TERMS.test(text)) return false;
  if (!FOREGROUND_TERMS.test(text) && !FOREGROUND_ASSET_TERMS.test(text)) return false;
  if (STRUCTURAL_TERMS.test(text) && !FOREGROUND_TERMS.test(text)) return false;
  return true;
}

function foregroundImageMatches(item = {}, image = {}) {
  const itemId = cleanToken(item.id || "");
  const imageId = cleanToken(image.id || "");
  if (!itemId || !imageId) return false;
  if (itemId === imageId) return true;
  const groupToken = singularToken(itemId.split("_").at(-1) || "");
  return Boolean(groupToken && imageId.split("_").map(singularToken).includes(groupToken));
}

function provenanceMatchesImage(entry = {}, image = {}) {
  const text = JSON.stringify(entry);
  if (!ASSET_SEPARATION_TERMS.test(text)) return false;
  const normalizedText = cleanToken(text);
  const imageId = cleanToken(image.id || "");
  const imagePath = normalizeAssetPath(image.path || "");
  const imagePathToken = cleanToken(imagePath);
  const imageBaseToken = cleanToken(path.basename(imagePath || "", path.extname(imagePath || "")));
  const entryPath = normalizeAssetPath(entry.path || "");
  return Boolean(
    (imageId && normalizedText.includes(imageId))
    || (imagePathToken && normalizedText.includes(imagePathToken))
    || (imageBaseToken && normalizedText.includes(imageBaseToken))
    || (imagePath && entryPath === imagePath)
  );
}

function singularToken(value = "") {
  const token = cleanToken(value);
  return token.endsWith("s") && token.length > 3 ? token.slice(0, -1) : token;
}

function normalizeAssetPath(value = "") {
  const text = String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!text || path.isAbsolute(text) || text.split("/").includes("..")) return "";
  return text;
}

function statFile(filePath = "") {
  if (!filePath) return { exists: false, size: 0, mtimeMs: 0 };
  if (!fsSync.existsSync(filePath)) return { exists: false, size: 0, mtimeMs: 0 };
  const stat = fsSync.statSync(filePath);
  return stat.isFile() ? { exists: true, size: stat.size, mtimeMs: stat.mtimeMs } : { exists: false, size: 0, mtimeMs: 0 };
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
  const resolved = path.resolve(filePath);
  const stat = await fs.stat(resolved);
  const cacheKey = `${resolved}|${stat.size}|${stat.mtimeMs}`;
  const cached = FILE_HASH_CACHE.get(cacheKey);
  if (cached) return cached;
  const pending = fs.readFile(resolved)
    .then((buffer) => crypto.createHash("sha256").update(buffer).digest("hex"))
    .catch((error) => {
      FILE_HASH_CACHE.delete(cacheKey);
      throw error;
    });
  FILE_HASH_CACHE.set(cacheKey, pending);
  while (FILE_HASH_CACHE.size > FILE_HASH_CACHE_MAX_ENTRIES) {
    FILE_HASH_CACHE.delete(FILE_HASH_CACHE.keys().next().value);
  }
  return pending;
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
