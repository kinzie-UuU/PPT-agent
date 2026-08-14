import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import JSZip from "jszip";
import { getProviderConfig } from "./providers.js";
import { readWorkflowJob, saveWorkflowJob } from "./workflowJobs.js";
import { withWorkflowJobLock } from "./workflowJobLock.js";
import { writeWorkflowVisualTextQualityReport } from "./workflowVisualTextQa.js";

const execFileAsync = promisify(execFile);
const SOURCE_TEXT_EXTS = new Set([".md", ".markdown", ".txt"]);
const VISUAL_COORDINATE_MODE_VERSION = "visual-coordinates-v2";

export function getWorkflowOcrCoverage(job = {}, options = {}) {
  const visualEvidenceMode = cleanString(options.source || options.ocrSource || "") === "visual";
  const renderedPages = visualEvidenceMode
    ? (Array.isArray(job.artifacts?.visualImages) ? job.artifacts.visualImages : [])
    : (Array.isArray(job.artifacts?.renderedPages) ? job.artifacts.renderedPages : []);
  const requested = normalizePages(options.pages || options.pageIds || options.page || options.pageId || []);
  const indexedRenderedPages = renderedPages.map((page, index) => ({
    page,
    index,
    pageId: normalizePageId(page.pageId || page.pageNumber || index + 1)
  }));
  const scopedRenderedPages = requested.length
    ? indexedRenderedPages.filter((item) => requested.includes(item.pageId))
    : indexedRenderedPages;
  const renderedByPage = new Map(scopedRenderedPages.map(({ page, index, pageId }) => {
    const sourcePath = cleanString(page.path || "");
    const absolutePath = sourcePath ? path.resolve(sourcePath) : "";
    return [
      pageId,
      {
        path: absolutePath,
        sha256: cleanString(page.sha256 || "") || currentFileSha256Sync(absolutePath)
      }
    ];
  }));
  const targetPageIds = requested.length
    ? requested
    : renderedPages.map((page, index) => normalizePageId(page.pageId || page.pageNumber || index + 1)).filter(Boolean);
  const hintsArtifact = visualEvidenceMode ? job.artifacts?.visualOcrTextHints : job.artifacts?.ocrTextHints;
  const pagesArtifact = visualEvidenceMode ? job.artifacts?.visualOcrPages : job.artifacts?.ocrPages;
  const sourceHints = readOcrHintsSync(hintsArtifact?.path || "");
  const sourcePages = sourceHints.pages?.length ? sourceHints.pages : (Array.isArray(pagesArtifact) ? pagesArtifact : []);
  const coveredPageIds = new Set(sourcePages
    .filter((page) => {
      const pageId = normalizePageId(page.pageId || page.pageNumber);
      const expected = renderedByPage.get(pageId);
      const evidencePath = path.resolve(page.imagePath || "");
      const evidenceSha256 = cleanString(page.imageSha256 || "");
      return pageId
        && expected
        && Boolean(expected.path)
        && Boolean(expected.sha256)
        && evidencePath === expected.path
        && Boolean(evidenceSha256)
        && expected.sha256 === evidenceSha256;
    })
    .map((page) => normalizePageId(page.pageId || page.pageNumber))
    .filter(Boolean));
  const missingPageIds = targetPageIds.filter((pageId) => !coveredPageIds.has(pageId));
  const coordinateModeReady = !visualEvidenceMode
    || hintsArtifact?.coordinateModeVersion === VISUAL_COORDINATE_MODE_VERSION;
  return {
    targetPageIds,
    coveredPageIds: targetPageIds.filter((pageId) => coveredPageIds.has(pageId)),
    missingPageIds,
    targetCount: targetPageIds.length,
    coveredCount: targetPageIds.length - missingPageIds.length,
    complete: coordinateModeReady && targetPageIds.length > 0 && missingPageIds.length === 0
  };
}

function currentFileSha256Sync(filePath = "") {
  if (!filePath) return "";
  try {
    const stat = fsSync.statSync(filePath);
    if (!stat.isFile()) return "";
    return crypto.createHash("sha256").update(fsSync.readFileSync(filePath)).digest("hex");
  } catch {
    return "";
  }
}

export function applyWorkflowOcrResultToJob(job = {}, result = {}) {
  const visualEvidenceMode = result.visualEvidenceMode === true;
  const errors = Array.isArray(result.errors) ? result.errors : [];
  const pageUpdates = Array.isArray(result.pageUpdates) ? result.pageUpdates : [];
  const hints = result.hints || {};
  const summary = hints.summary || {};
  const nextJob = {
    ...job,
    artifacts: {
      ...(job.artifacts || {}),
      ...(visualEvidenceMode
        ? { visualOcrTextHints: result.hintsArtifact, visualOcrPages: result.pageArtifacts || [] }
        : { ocrTextHints: result.hintsArtifact, ocrPages: result.pageArtifacts || [] })
    }
  };
  if (result.preserveWorkflowStage !== true) {
    let pages = Array.isArray(job.pages) ? job.pages : [];
    for (const update of pageUpdates) {
      pages = upsertPage(pages, update.pageNumber, update.status, update.message, update.details || {});
    }
    nextJob.pages = pages;
    nextJob.currentStage = "ocr_ready";
    nextJob.status = errors.length ? "failed" : "ocr_ready";
    nextJob.stageStatus = errors.length ? "failed" : "complete";
    nextJob.stages = {
      ...(job.stages || {}),
      ocr_ready: markStage(job.stages?.ocr_ready, errors.length ? "failed" : "complete", errors.length ? "Some OCR pages failed" : `OCR ready for ${hints.pageCount || 0} page(s)`, {
        provider: result.provider?.provider || "",
        pageCount: hints.pageCount || 0,
        errors
      })
    };
  }
  nextJob.events = appendEvent(job.events, errors.length ? "ocr.failed" : "ocr.ready", errors.length ? "Some OCR pages failed" : `OCR ready for ${hints.pageCount || 0} page(s)`, {
    pageCount: hints.pageCount || 0,
    textCount: summary.textCount || 0,
    lowConfidenceCount: summary.lowConfidenceCount || 0,
    mojibakeCount: summary.mojibakeCount || 0,
    quality: summary.quality || {},
    visualTextQuality: result.visualTextQuality?.report?.summary || null,
    errors
  });
  if (errors.length) {
    nextJob.errors = [...(Array.isArray(job.errors) ? job.errors : []), ...errors.map((item) => ({
      stage: "ocr_ready",
      message: item.error,
      details: item,
      createdAt: new Date().toISOString()
    }))].slice(-50);
  }
  return nextJob;
}

function readOcrHintsSync(filePath = "") {
  if (!filePath || !fsSync.existsSync(filePath)) return {};
  try {
    return JSON.parse(fsSync.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

export async function runWorkflowOcr(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const visualEvidenceMode = cleanString(options.source || options.ocrSource || "") === "visual";
  const images = getOcrInputImages(job, options);
  if (!images.length) throw new Error("No visual images or rendered pages available for OCR");
  await fs.mkdir(job.dirs.ocr, { recursive: true });
  const evidenceOcrDir = visualEvidenceMode ? path.join(job.dirs.ocr, "visual-pages") : job.dirs.ocr;
  await fs.mkdir(evidenceOcrDir, { recursive: true });
  const provider = getProviderConfig().ocr;
  if (!provider.enabled && images.some((image) => !isSourceTextInput(image.path))) {
    throw new Error("OCR provider disabled");
  }

  const startedAt = new Date().toISOString();
  let pages = [];
  const errors = [];
  const pageUpdates = [];
  for (const image of images) {
    try {
      const page = await runOcrPage({
        image,
        ocrDir: evidenceOcrDir,
        provider,
        minConfidence: options.minConfidence
      });
      pages.push(page);
      pageUpdates.push({
        pageNumber: image.pageNumber,
        status: "recorded",
        message: `OCR ready: ${page.lineCount} line(s) via ${page.backend}`,
        details: {
        ocrPath: page.ocrPath,
        ocrBackend: page.backend,
        textCount: page.lineCount,
        lowConfidenceCount: page.lowConfidenceCount,
        mojibakeCount: page.mojibakeCount || 0,
        quality: page.quality || {}
        }
      });
    } catch (error) {
      const failure = {
        pageId: image.pageId,
        pageNumber: image.pageNumber,
        error: error.message || "OCR failed"
      };
      errors.push(failure);
      pageUpdates.push({ pageNumber: image.pageNumber, status: "failed", message: failure.error, details: {} });
    }
  }

  if (!visualEvidenceMode) pages = await mergePptxNativeSourceEvidence(job, pages);

  const hintsPath = path.join(job.dirs.ocr, visualEvidenceMode ? "visual_text_hints.json" : "text_hints.json");
  const previousHints = await readJsonFile(hintsPath).catch(() => null);
  const currentHints = buildTextHints({ job, provider, startedAt, pages, errors });
  const hints = mergeWorkflowOcrTextHints(previousHints, currentHints, images);
  await fs.writeFile(hintsPath, JSON.stringify(hints, null, 2), "utf8");

  const hintsArtifact = artifactRecord(visualEvidenceMode ? "visual_ocr_text_hints" : "ocr_text_hints", hintsPath, {
    backend: hints.ocrBackend?.name || hints.backend || provider.provider,
    fallbackBackend: hints.fallbackBackend || provider.fallbackProvider || "",
    ocrBackend: hints.ocrBackend,
    pageCount: hints.pageCount,
    textCount: hints.summary.textCount,
    lowConfidenceCount: hints.summary.lowConfidenceCount,
    mojibakeCount: hints.summary.mojibakeCount,
    quality: hints.summary.quality,
    evidenceSource: visualEvidenceMode ? "visual" : "rendered-source",
    ...(visualEvidenceMode ? { coordinateModeVersion: VISUAL_COORDINATE_MODE_VERSION } : {})
  });
  const pageArtifacts = hints.pages.map((page) => ({
    kind: visualEvidenceMode ? "visual_ocr_page" : "ocr_page",
    pageId: page.pageId,
    pageNumber: page.pageNumber,
    path: page.ocrPath || "",
    relativePath: page.ocrPath ? path.relative(process.cwd(), page.ocrPath) : "",
    imagePath: page.imagePath || "",
    imageSha256: page.imageSha256 || "",
    ...(visualEvidenceMode ? { coordinateModeVersion: VISUAL_COORDINATE_MODE_VERSION } : {}),
    backend: page.backend,
    providerBackends: page.providerBackends || [page.backend].filter(Boolean),
    lineCount: page.lineCount,
    lowConfidenceCount: page.lowConfidenceCount,
    mojibakeCount: page.mojibakeCount || 0,
    quality: page.quality || {}
  }));
  return withWorkflowJobLock(`workflow-job:${jobId}`, async () => {
    // OCR can run for minutes. Merge its result into the latest job snapshot so
    // approvals, generated pages, and worker updates made meanwhile survive.
    const latestJob = await readWorkflowJob(jobId);
    latestJob.artifacts = {
      ...(latestJob.artifacts || {}),
      ...(visualEvidenceMode
        ? { visualOcrTextHints: hintsArtifact, visualOcrPages: pageArtifacts }
        : { ocrTextHints: hintsArtifact, ocrPages: pageArtifacts })
    };
    const visualTextQuality = visualEvidenceMode
      ? await writeWorkflowVisualTextQualityReport(latestJob, { pageNumberPolicy: options.pageNumberPolicy || "" })
      : null;
    if (shouldSyncOcrHintsToEditableRun({ visualEvidenceMode, syncToEditableRun: options.syncToEditableRun === true })) {
      await syncRapidOcrHintsToEditableRun(latestJob, hintsPath);
    }
    return saveWorkflowJob(applyWorkflowOcrResultToJob(latestJob, {
      visualEvidenceMode,
      hintsArtifact,
      pageArtifacts,
      pageUpdates,
      provider,
      hints,
      errors,
      preserveWorkflowStage: options.preserveWorkflowStage === true,
      visualTextQuality
    }));
  });
}

export async function correctWorkflowOcrTextHint(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const hintsPath = job.artifacts?.ocrTextHints?.path || "";
  if (!hintsPath || !fsSync.existsSync(hintsPath)) throw new Error("OCR text hints are not available for correction.");
  const pageId = normalizePageId(options.pageId || options.page || "");
  const lineId = cleanString(options.lineId || options.id || "");
  const nextText = cleanString(options.text || "");
  if (!pageId) throw new Error("pageId is required");
  if (!lineId) throw new Error("lineId is required");
  if (!nextText) throw new Error("Corrected OCR text is required");

  const hints = JSON.parse(await fs.readFile(hintsPath, "utf8"));
  const page = (Array.isArray(hints.pages) ? hints.pages : []).find((item) => normalizePageId(item.pageId) === pageId);
  if (!page) throw new Error(`OCR page not found: ${pageId}`);
  const line = (Array.isArray(page.ocrLines) ? page.ocrLines : []).find((item) => String(item.id || "") === lineId);
  if (!line) throw new Error(`OCR line not found: ${lineId}`);

  const previousText = line.text || "";
  line.original_text = line.original_text || previousText;
  line.text = nextText;
  line.corrected = true;
  line.corrected_at = new Date().toISOString();
  line.corrected_by = cleanString(options.correctedBy || "operator");
  if (options.markRequired !== false) line.low_confidence = false;
  recomputeOcrHints(hints);
  await fs.writeFile(hintsPath, JSON.stringify(hints, null, 2), "utf8");
  const hintsBuffer = await fs.readFile(hintsPath);
  const hintsStat = await fs.stat(hintsPath);

  const pageArtifact = (Array.isArray(job.artifacts?.ocrPages) ? job.artifacts.ocrPages : []).find((item) => normalizePageId(item.pageId) === pageId);
  if (pageArtifact?.path && fsSync.existsSync(pageArtifact.path)) {
    const pageData = JSON.parse(await fs.readFile(pageArtifact.path, "utf8"));
    const pageLine = (Array.isArray(pageData.lines) ? pageData.lines : []).find((item) => String(item.id || "") === lineId);
    if (pageLine) {
      pageLine.original_text = pageLine.original_text || previousText;
      pageLine.text = nextText;
      pageLine.corrected = true;
      pageLine.corrected_at = line.corrected_at;
      pageLine.corrected_by = line.corrected_by;
      if (options.markRequired !== false) pageLine.low_confidence = false;
      pageData.low_confidence_count = (pageData.lines || []).filter((item) => item.low_confidence).length;
      pageData.line_count = (pageData.lines || []).length;
      await fs.writeFile(pageArtifact.path, JSON.stringify(pageData, null, 2), "utf8");
      pageArtifact.lineCount = pageData.line_count;
      pageArtifact.lowConfidenceCount = pageData.low_confidence_count;
    }
  }

  const summary = hints.summary || {};
  job.artifacts = {
    ...(job.artifacts || {}),
    ocrTextHints: {
      ...(job.artifacts?.ocrTextHints || {}),
      pageCount: summary.pageCount || 0,
      textCount: summary.textCount || 0,
      lowConfidenceCount: summary.lowConfidenceCount || 0,
      correctedCount: summary.correctedCount || 0,
      size: hintsStat.size,
      sha256: crypto.createHash("sha256").update(hintsBuffer).digest("hex"),
      updatedAt: new Date().toISOString()
    },
    ocrCorrections: [...(Array.isArray(job.artifacts?.ocrCorrections) ? job.artifacts.ocrCorrections : []), {
      kind: "ocr_text_correction",
      pageId,
      lineId,
      previousText,
      text: nextText,
      correctedBy: line.corrected_by,
      correctedAt: line.corrected_at
    }].slice(-500)
  };
  const visualTextQuality = job.artifacts?.visualOcrTextHints?.path
    ? await writeWorkflowVisualTextQualityReport(job)
    : null;
  await syncRapidOcrHintsToEditableRun(job, hintsPath);
  job.events = appendEvent(job.events, "ocr.text_corrected", `Corrected OCR text ${pageId}/${lineId}`, {
    pageId,
    lineId,
    previousText,
    text: nextText,
    visualTextQualityEvidenceSha256: visualTextQuality?.artifact?.evidenceSha256 || ""
  });
  return saveWorkflowJob(job);
}

async function runOcrPage({ image, ocrDir, provider, minConfidence }) {
  if (isSourceTextInput(image.path)) {
    return runSourceTextPage({ image, ocrDir });
  }
  const providers = buildOcrProviderChain(provider);
  const failures = [];
  const successfulPages = [];
  for (const providerName of providers) {
    try {
      const page = providerName === "paddleocr-local"
        ? await runPaddleOcrPage({ image, ocrDir, provider, minConfidence, outputName: "paddleocr.json" })
        : await runRapidOcrPage({ image, ocrDir, provider, minConfidence, outputName: "rapidocr.json" });
      if (page.lineCount === 0) {
        failures.push({
          provider: providerName,
          reason: "OCR returned no text lines."
        });
        continue;
      }
      if (page.quality?.hasMojibake) {
        failures.push({
          provider: providerName,
          reason: `OCR output looks mojibake (${page.mojibakeCount || 0} line(s)).`
        });
      }
      successfulPages.push(page);
    } catch (error) {
      failures.push({ provider: providerName, reason: error.message || String(error) });
    }
  }
  if (!successfulPages.length) {
    throw new Error(failures.map((item) => `${item.provider}: ${item.reason}`).join(" | ") || "OCR failed");
  }
  const merged = mergeOcrPageEvidence(successfulPages, { minConfidence });
  const pageDir = path.join(ocrDir, image.pageId);
  const outputPath = path.join(pageDir, "ocr.json");
  await fs.writeFile(outputPath, JSON.stringify({
    backend: merged.backend,
    providers: merged.providerBackends,
    image: image.path,
    min_confidence: Number.isFinite(Number(minConfidence)) ? Number(minConfidence) : 0.35,
    line_count: merged.lineCount,
    low_confidence_count: merged.lowConfidenceCount,
    lines: merged.lines
  }, null, 2), "utf8");
  return {
    ...merged,
    imagePath: image.path,
    imageSha256: image.sha256 || "",
    ocrPath: outputPath,
    fallbacks: failures
  };
}

export function mergeOcrPageEvidence(pages = [], options = {}) {
  const usablePages = (Array.isArray(pages) ? pages : []).filter((page) => Array.isArray(page?.lines));
  if (!usablePages.length) throw new Error("OCR ensemble has no successful page evidence");
  const threshold = Number.isFinite(Number(options.minConfidence)) ? Number(options.minConfidence) : 0.35;
  const mergedLines = [];
  const providerBackends = [...new Set(usablePages.map((page) => cleanString(page.backend)).filter(Boolean))];
  for (const page of usablePages) {
    for (const sourceLine of page.lines) {
      const line = {
        ...sourceLine,
        source: sourceLine.source || page.backend,
        ocr_sources: [...new Set([...(Array.isArray(sourceLine.ocr_sources) ? sourceLine.ocr_sources : []), page.backend].filter(Boolean))]
      };
      const matchIndex = mergedLines.findIndex((candidate) => isSameOcrEvidence(candidate, line));
      if (matchIndex < 0) {
        mergedLines.push(line);
        continue;
      }
      mergedLines[matchIndex] = mergeOcrLineEvidence(mergedLines[matchIndex], line);
    }
  }
  const lines = annotateOcrLines(mergedLines
    .sort((left, right) => Number(left.box_px?.[1] || 0) - Number(right.box_px?.[1] || 0)
      || Number(left.box_px?.[0] || 0) - Number(right.box_px?.[0] || 0))
    .map((line, index) => ({
      ...line,
      id: `O${String(index + 1).padStart(3, "0")}`,
      low_confidence: Number(line.confidence || 0) < threshold || line.low_confidence === true
    })));
  const quality = summarizeOcrQuality(lines);
  const first = usablePages[0];
  return {
    pageId: first.pageId,
    pageNumber: first.pageNumber,
    backend: providerBackends.length > 1 ? "ocr-ensemble" : providerBackends[0] || first.backend || "ocr-local",
    providerBackends,
    lineCount: lines.length,
    lowConfidenceCount: lines.filter((line) => line.low_confidence).length,
    mojibakeCount: lines.filter((line) => line.mojibake_suspect).length,
    quality,
    lines
  };
}

function isSameOcrEvidence(left = {}, right = {}) {
  const leftText = comparableText(left.text);
  const rightText = comparableText(right.text);
  if (!leftText || !rightText || !sameOcrRegion(left.box_px, right.box_px)) return false;
  if (leftText === rightText) return true;
  const shorter = Math.min(leftText.length, rightText.length);
  const longer = Math.max(leftText.length, rightText.length);
  if (shorter >= 4 && shorter / longer >= 0.78 && (leftText.includes(rightText) || rightText.includes(leftText))) return true;
  return longer >= 5 && 1 - editDistance(leftText, rightText) / longer >= 0.84;
}

function mergeOcrLineEvidence(left = {}, right = {}) {
  const leftScore = ocrLineScore(left);
  const rightScore = ocrLineScore(right);
  const preferred = rightScore > leftScore ? right : left;
  const alternative = preferred === left ? right : left;
  const leftText = cleanString(left.text);
  const rightText = cleanString(right.text);
  const ensembleAgreement = comparableText(leftText) === comparableText(rightText);
  return {
    ...preferred,
    confidence: Math.max(Number(left.confidence || 0), Number(right.confidence || 0)),
    low_confidence: Boolean(!ensembleAgreement || (left.low_confidence && right.low_confidence)),
    ocr_sources: [...new Set([
      ...(Array.isArray(left.ocr_sources) ? left.ocr_sources : []),
      ...(Array.isArray(right.ocr_sources) ? right.ocr_sources : [])
    ].filter(Boolean))],
    ocr_alternatives: [...new Set([
      ...(Array.isArray(left.ocr_alternatives) ? left.ocr_alternatives : []),
      ...(Array.isArray(right.ocr_alternatives) ? right.ocr_alternatives : []),
      ...(leftText && rightText && comparableText(leftText) !== comparableText(rightText) ? [alternative.text] : [])
    ].filter(Boolean))],
    ensemble_agreement: ensembleAgreement
  };
}

function sameOcrRegion(leftBox = [], rightBox = []) {
  const left = normalizeOcrBox(leftBox);
  const right = normalizeOcrBox(rightBox);
  if (!left || !right) return false;
  const intersectionWidth = Math.max(0, Math.min(left.x2, right.x2) - Math.max(left.x1, right.x1));
  const intersectionHeight = Math.max(0, Math.min(left.y2, right.y2) - Math.max(left.y1, right.y1));
  const intersection = intersectionWidth * intersectionHeight;
  const smallerArea = Math.min(left.area, right.area);
  if (smallerArea > 0 && intersection / smallerArea >= 0.45) return true;
  const centerDistance = Math.hypot(left.cx - right.cx, left.cy - right.cy);
  return centerDistance <= Math.max(18, Math.max(left.height, right.height) * 0.75);
}

function normalizeOcrBox(box = []) {
  const [x, y, width, height] = (Array.isArray(box) ? box : []).map(Number);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return {
    x1: x,
    y1: y,
    x2: x + width,
    y2: y + height,
    width,
    height,
    area: width * height,
    cx: x + width / 2,
    cy: y + height / 2
  };
}

function ocrLineScore(line = {}) {
  const text = cleanString(line.text);
  const confidence = Number(line.confidence || 0);
  const cleanLength = comparableText(text).length;
  return confidence + Math.min(0.08, cleanLength * 0.002) - (detectMojibake(text) ? 1 : 0);
}

function editDistance(left = "", right = "") {
  const previous = Array.from({ length: right.length + 1 }, (_item, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column];
      previous[column] = Math.min(
        previous[column] + 1,
        previous[column - 1] + 1,
        diagonal + (left[row - 1] === right[column - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

async function runSourceTextPage({ image, ocrDir }) {
  const pageDir = path.join(ocrDir, image.pageId);
  await fs.mkdir(pageDir, { recursive: true });
  const outputPath = path.join(pageDir, "ocr.json");
  const text = await fs.readFile(image.path, "utf8");
  const sourceLines = extractSourceTextLines(text);
  const lines = sourceLines.map((value, index) => ({
    id: `O${String(index + 1).padStart(3, "0")}`,
    text: value,
    confidence: 1,
    low_confidence: false,
    box_px: [72, 72 + index * 48, 1392, 36],
    polygon_px: [[72, 72 + index * 48], [1464, 72 + index * 48], [1464, 108 + index * 48], [72, 108 + index * 48]],
    font_pt_if_cjk: 20.9,
    source: "source-text"
  }));
  await fs.writeFile(outputPath, JSON.stringify({
    backend: "source-text",
    image: image.path,
    min_confidence: 1,
    line_count: lines.length,
    low_confidence_count: 0,
    lines
  }, null, 2), "utf8");
  return readOcrPageResult({ image, outputPath });
}

export function isSourceTextInput(filePath = "") {
  return SOURCE_TEXT_EXTS.has(path.extname(String(filePath || "")).toLowerCase());
}

export async function extractPptxNativeTextByPage(filePath = "") {
  if (path.extname(String(filePath || "")).toLowerCase() !== ".pptx" || !fsSync.existsSync(filePath)) return new Map();
  const archive = await JSZip.loadAsync(await fs.readFile(filePath));
  const byPage = new Map();
  const slideEntries = Object.keys(archive.files)
    .map((name) => ({ name, match: name.match(/^ppt\/slides\/slide(\d+)\.xml$/i) }))
    .filter((entry) => entry.match)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));
  for (const entry of slideEntries) {
    const xml = await archive.file(entry.name)?.async("string");
    const texts = [...String(xml || "").matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gi)]
      .map((match) => decodeXmlText(match[1]))
      .map(cleanString)
      .filter(Boolean);
    byPage.set(Number(entry.match[1]), [...new Set(texts)]);
  }
  return byPage;
}

async function mergePptxNativeSourceEvidence(job = {}, pages = []) {
  const sourcePath = cleanString(job.artifacts?.source?.path || "");
  const nativeByPage = await extractPptxNativeTextByPage(sourcePath).catch(() => new Map());
  if (!nativeByPage.size) return pages;
  return pages.map((page) => {
    const nativeTexts = nativeByPage.get(Number(page.pageNumber || 0)) || [];
    const existingOcrLines = Array.isArray(page.ocrLines) ? page.ocrLines : Array.isArray(page.lines) ? page.lines : [];
    const existing = new Set(existingOcrLines.map((line) => comparableText(line.text)));
    const additions = nativeTexts
      .filter((text) => !existing.has(comparableText(text)))
      .map((text, index) => ({
        id: `N${String(index + 1).padStart(3, "0")}`,
        text,
        confidence: 1,
        low_confidence: false,
        box_px: [0, 0, 0, 0],
        polygon_px: [],
        font_pt_if_cjk: 0,
        source: "pptx-native-text",
        native_text: true
      }));
    const ocrLines = [...existingOcrLines, ...additions];
    const nativeRequired = nativeTexts.filter((text) => /https?:\/\/|www\.|\b\S+@\S+\.\S+\b/i.test(text));
    const quality = summarizeOcrQuality(ocrLines);
    return {
      ...page,
      ocrLines,
      lines: ocrLines,
      lineCount: ocrLines.length,
      lowConfidenceCount: ocrLines.filter((line) => line.low_confidence).length,
      mojibakeCount: ocrLines.filter((line) => line.mojibake_suspect).length,
      quality,
      nativeTextCount: nativeTexts.length,
      requiredText: [...new Set([...(Array.isArray(page.requiredText) ? page.requiredText : []), ...nativeRequired])]
    };
  });
}

function decodeXmlText(value = "") {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function comparableText(value = "") {
  return String(value || "").toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, "");
}

export function extractSourceTextLines(value = "") {
  return String(value || "")
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\r?\n/)
    .map((line) => line
      .replace(/^\s{0,3}#{1,6}\s*/, "")
      .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*)/, "")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*_~`]/g, "")
      .replace(/\s+/g, " ")
      .trim())
    .filter(Boolean)
    .slice(0, 200);
}

function buildOcrProviderChain(provider = {}) {
  const selected = [provider.provider || "paddleocr-local", provider.fallbackProvider || "rapidocr-local"]
    .map((item) => cleanString(item))
    .filter(Boolean);
  return [...new Set(selected)].filter((item) => ["paddleocr-local", "rapidocr-local"].includes(item));
}

async function runPaddleOcrPage({ image, ocrDir, provider, minConfidence, outputName = "ocr.json" }) {
  const threshold = Number.isFinite(Number(minConfidence)) ? Number(minConfidence) : 0.35;
  const pageDir = path.join(ocrDir, image.pageId);
  await fs.mkdir(pageDir, { recursive: true });
  const outputPath = path.join(pageDir, outputName);
  const script = [
    "import json, sys",
    "import os",
    "os.environ.setdefault('PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT', '0')",
    "os.environ.setdefault('PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK', 'True')",
    "os.environ.setdefault('FLAGS_use_mkldnn', '0')",
    "from paddleocr import PaddleOCR",
    "img=sys.argv[1]",
    "out=sys.argv[2]",
    "threshold=float(sys.argv[3])",
    "def make_ocr():",
    "    attempts=[",
    "        {'lang':'ch', 'use_doc_orientation_classify': False, 'use_doc_unwarping': False, 'use_textline_orientation': True},",
    "        {'lang':'ch', 'use_textline_orientation': True},",
    "        {'lang':'ch', 'use_angle_cls': True, 'show_log': False},",
    "        {'lang':'ch'},",
    "    ]",
    "    last=None",
    "    for kwargs in attempts:",
    "        try:",
    "            return PaddleOCR(**kwargs)",
    "        except Exception as exc:",
    "            last=exc",
    "    raise last",
    "ocr=make_ocr()",
    "if hasattr(ocr, 'predict'):",
    "    result=ocr.predict(img)",
    "else:",
    "    result=ocr.ocr(img, cls=True)",
    "lines=[]",
    "def add_line(points, text, score):",
    "    clean=str(text or '').strip()",
    "    if not clean: return",
    "    pts=points",
    "    if pts is None: pts=[]",
    "    if hasattr(pts, 'tolist'): pts=pts.tolist()",
    "    if len(pts)==4 and all(isinstance(v,(int,float)) for v in pts):",
    "        x1,y1,x2,y2=[float(v) for v in pts]",
    "        if x2 > x1 and y2 > y1: pts=[[x1,y1],[x2,y1],[x2,y2],[x1,y2]]",
    "        else: pts=[[x1,y1],[x1+x2,y1],[x1+x2,y1+y2],[x1,y1+y2]]",
    "    if len(pts)==0: pts=[[0,0],[1,0],[1,1],[0,1]]",
    "    xs=[float(p[0]) for p in pts]; ys=[float(p[1]) for p in pts]",
    "    score=float(score or 0)",
    "    box=[int(round(min(xs))), int(round(min(ys))), max(1,int(round(max(xs)-min(xs)))), max(1,int(round(max(ys)-min(ys))))]",
    "    lines.append({'id': f'O{len(lines)+1:03d}', 'text': clean, 'confidence': round(score,4), 'low_confidence': score < threshold, 'box_px': box, 'polygon_px': [[int(round(float(x))), int(round(float(y)))] for x,y in pts], 'font_pt_if_cjk': round(box[3] * 0.58, 1)})",
    "def parse_node(node):",
    "    if isinstance(node, dict):",
    "        texts=node.get('rec_texts') or node.get('texts') or []",
    "        scores=node.get('rec_scores') or node.get('scores') or []",
    "        polys=node.get('rec_polys') or node.get('dt_polys') or node.get('rec_boxes') or node.get('boxes') or []",
    "        for i,text in enumerate(texts): add_line(polys[i] if i < len(polys) else None, text, scores[i] if i < len(scores) else 0)",
    "        return",
    "    if isinstance(node, (list, tuple)):",
    "        if len(node)>=2 and isinstance(node[1], (list, tuple)) and len(node[1])>=2 and isinstance(node[1][0], str):",
    "            add_line(node[0], node[1][0], node[1][1]); return",
    "        for child in node: parse_node(child)",
    "parse_node(result)",
    "lines=sorted(lines, key=lambda item: (item['box_px'][1], item['box_px'][0]))",
    "for idx,line in enumerate(lines, start=1): line['id']=f'O{idx:03d}'",
    "data={'backend':'paddleocr-local','image':img,'min_confidence':threshold,'line_count':len(lines),'low_confidence_count':sum(1 for line in lines if line['low_confidence']),'lines':lines}",
    "open(out,'w',encoding='utf-8').write(json.dumps(data, ensure_ascii=False, indent=2))"
  ].join("\n");
  const stagedInputPath = await stageOcrInputImage(image.path, image.pageId);
  try {
    await execFileAsync(provider.pythonPath, ["-c", script, stagedInputPath, outputPath, String(threshold)], {
      timeout: provider.timeoutMs,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      encoding: "utf8"
    });
  } finally {
    await fs.unlink(stagedInputPath).catch(() => {});
  }
  return readOcrPageResult({ image, outputPath });
}

async function runRapidOcrPage({ image, ocrDir, provider, minConfidence, outputName = "ocr.json" }) {
  const threshold = Number.isFinite(Number(minConfidence)) ? Number(minConfidence) : 0.35;
  const pageDir = path.join(ocrDir, image.pageId);
  await fs.mkdir(pageDir, { recursive: true });
  const outputPath = path.join(pageDir, outputName);
  const script = [
    "import json, sys",
    "try:",
    "    from rapidocr_onnxruntime import RapidOCR",
    "    backend='rapidocr-onnxruntime'",
    "except Exception:",
    "    from rapidocr import RapidOCR",
    "    backend='rapidocr'",
    "img=sys.argv[1]",
    "out=sys.argv[2]",
    "threshold=float(sys.argv[3])",
    "ocr=RapidOCR()",
    "result,_=ocr(img)",
    "lines=[]",
    "for idx,item in enumerate(result or [], start=1):",
    "    points,text,score=item",
    "    clean=str(text).strip()",
    "    if not clean: continue",
    "    score=float(score)",
    "    xs=[float(p[0]) for p in points]; ys=[float(p[1]) for p in points]",
    "    box=[int(round(min(xs))), int(round(min(ys))), max(1,int(round(max(xs)-min(xs)))), max(1,int(round(max(ys)-min(ys))))]",
    "    lines.append({'id': f'O{idx:03d}', 'text': clean, 'confidence': round(score,4), 'low_confidence': score < threshold, 'box_px': box, 'polygon_px': [[int(round(float(x))), int(round(float(y)))] for x,y in points], 'font_pt_if_cjk': round(box[3] * 0.58, 1)})",
    "lines=sorted(lines, key=lambda item: (item['box_px'][1], item['box_px'][0]))",
    "data={'backend':backend,'image':img,'min_confidence':threshold,'line_count':len(lines),'low_confidence_count':sum(1 for line in lines if line['low_confidence']),'lines':lines}",
    "open(out,'w',encoding='utf-8').write(json.dumps(data, ensure_ascii=False, indent=2))"
  ].join("\n");
  const stagedInputPath = await stageOcrInputImage(image.path, image.pageId);
  try {
    await execFileAsync(provider.pythonPath, ["-c", script, stagedInputPath, outputPath, String(threshold)], {
      timeout: provider.timeoutMs,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      encoding: "utf8"
    });
  } finally {
    await fs.unlink(stagedInputPath).catch(() => {});
  }
  return readOcrPageResult({ image, outputPath });
}

async function stageOcrInputImage(imagePath = "", pageId = "page") {
  const extension = path.extname(imagePath).toLowerCase() || ".png";
  const safePageId = cleanString(pageId).replace(/[^a-z0-9_-]+/gi, "-") || "page";
  const stagedPath = path.join(os.tmpdir(), `ppt-agent-ocr-${process.pid}-${safePageId}-${Date.now()}${extension}`);
  await fs.copyFile(imagePath, stagedPath);
  return stagedPath;
}

async function readOcrPageResult({ image, outputPath }) {
  const data = JSON.parse(await fs.readFile(outputPath, "utf8"));
  const lines = annotateOcrLines(data.lines || []);
  const quality = summarizeOcrQuality(lines);
  return {
    pageId: image.pageId,
    pageNumber: image.pageNumber,
    imagePath: image.path,
    imageSha256: image.sha256 || "",
    ocrPath: outputPath,
    backend: data.backend,
    lineCount: lines.length,
    lowConfidenceCount: lines.filter((line) => line.low_confidence).length,
    mojibakeCount: lines.filter((line) => line.mojibake_suspect).length,
    quality,
    lines
  };
}

function recomputeOcrHints(hints = {}) {
  const pages = Array.isArray(hints.pages) ? hints.pages : [];
  for (const page of pages) {
    const lines = Array.isArray(page.ocrLines) ? page.ocrLines : [];
    page.lineCount = lines.length;
    page.lowConfidenceCount = lines.filter((line) => line.low_confidence).length;
    page.mojibakeCount = lines.filter((line) => line.mojibake_suspect).length;
    page.quality = summarizeOcrQuality(lines);
    page.requiredText = lines.filter((line) => !line.low_confidence && !line.mojibake_suspect).map((line) => line.text).filter(Boolean);
  }
  const allLines = pages.flatMap((page) => Array.isArray(page.ocrLines) ? page.ocrLines : []);
  hints.summary = {
    ...(hints.summary || {}),
    pageCount: pages.length,
    textCount: allLines.length,
    lowConfidenceCount: allLines.filter((line) => line.low_confidence).length,
    mojibakeCount: allLines.filter((line) => line.mojibake_suspect).length,
    correctedCount: allLines.filter((line) => line.corrected).length
  };
  hints.summary.quality = summarizeOcrQuality(allLines);
}

async function syncRapidOcrHintsToEditableRun(job, hintsPath) {
  const runDir = job.artifacts?.editableRun?.path || "";
  const target = job.artifacts?.editableRun?.rapidOcrHintsPath || (runDir ? path.join(runDir, "workflow_rapidocr_text_hints.json") : "");
  if (!target) return;
  const targetDir = path.dirname(target);
  if (!fsSync.existsSync(targetDir)) return;
  await fs.copyFile(hintsPath, target);
}

export function shouldSyncOcrHintsToEditableRun(options = {}) {
  return options.visualEvidenceMode !== true || options.syncToEditableRun === true;
}

function buildTextHints({ job, provider, startedAt, pages, errors }) {
  const textCount = pages.reduce((sum, page) => sum + page.lineCount, 0);
  const lowConfidenceCount = pages.reduce((sum, page) => sum + page.lowConfidenceCount, 0);
  const mojibakeCount = pages.reduce((sum, page) => sum + (page.mojibakeCount || 0), 0);
  const allLines = pages.flatMap((page) => page.lines || []);
  const finishedAt = new Date().toISOString();
  return {
    version: 1,
    jobId: job.id,
    backend: provider.provider,
    fallbackBackend: provider.fallbackProvider || "",
    ocrBackend: {
      name: pages.find((page) => page.backend)?.backend || provider.provider,
      mode: "local-open-source",
      pythonPath: provider.pythonPath,
      fallback: provider.fallbackProvider || "",
      providers: [...new Set(pages.flatMap((page) => Array.isArray(page.providerBackends) ? page.providerBackends : [page.backend]).filter(Boolean))]
    },
    pageCount: pages.length,
    textCount,
    lowConfidenceCount,
    mojibakeCount,
    quality: summarizeOcrQuality(allLines),
    summary: {
      pageCount: pages.length,
      textCount,
      lowConfidenceCount,
      mojibakeCount,
      errorCount: errors.length,
      quality: summarizeOcrQuality(allLines)
    },
    pages: pages.map((page) => ({
      pageId: page.pageId,
      pageNumber: page.pageNumber,
      imagePath: page.imagePath,
      imageSha256: page.imageSha256 || "",
      ocrPath: page.ocrPath,
      backend: page.backend,
      providerBackends: page.providerBackends || [page.backend].filter(Boolean),
      lineCount: page.lineCount,
      lowConfidenceCount: page.lowConfidenceCount,
      mojibakeCount: page.mojibakeCount || 0,
      quality: page.quality || {},
      fallbacks: page.fallbacks || [],
      requiredText: page.lines.filter((line) => !line.low_confidence && !line.mojibake_suspect).map((line) => line.text),
      ocrLines: page.lines
    })),
    errors,
    startedAt,
    finishedAt
  };
}

export function mergeWorkflowOcrTextHints(previous = null, current = {}, requestedImages = []) {
  const requestedPageIds = new Set((Array.isArray(requestedImages) ? requestedImages : [])
    .map((image) => normalizePageId(image?.pageId || image?.pageNumber))
    .filter(Boolean));
  const pageMap = new Map();
  for (const page of Array.isArray(previous?.pages) ? previous.pages : []) {
    const pageId = normalizePageId(page?.pageId || page?.pageNumber);
    if (pageId && !requestedPageIds.has(pageId)) pageMap.set(pageId, page);
  }
  for (const page of Array.isArray(current?.pages) ? current.pages : []) {
    const pageId = normalizePageId(page?.pageId || page?.pageNumber);
    if (pageId) pageMap.set(pageId, page);
  }
  const pages = [...pageMap.values()].sort((left, right) => Number(left?.pageNumber || 0) - Number(right?.pageNumber || 0));
  const previousErrors = (Array.isArray(previous?.errors) ? previous.errors : [])
    .filter((item) => !requestedPageIds.has(normalizePageId(item?.pageId || item?.pageNumber)));
  const errors = [...previousErrors, ...(Array.isArray(current?.errors) ? current.errors : [])];
  const allLines = pages.flatMap((page) => Array.isArray(page?.ocrLines) ? page.ocrLines : []);
  const summary = {
    pageCount: pages.length,
    textCount: allLines.length,
    lowConfidenceCount: allLines.filter((line) => line?.low_confidence).length,
    mojibakeCount: allLines.filter((line) => line?.mojibake_suspect).length,
    errorCount: errors.length,
    quality: summarizeOcrQuality(allLines)
  };
  return {
    ...(previous || {}),
    ...current,
    pageCount: summary.pageCount,
    textCount: summary.textCount,
    lowConfidenceCount: summary.lowConfidenceCount,
    mojibakeCount: summary.mojibakeCount,
    quality: summary.quality,
    summary,
    pages,
    errors,
    startedAt: previous?.startedAt || current?.startedAt,
    finishedAt: current?.finishedAt || new Date().toISOString()
  };
}

async function readJsonFile(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function annotateOcrLines(lines = []) {
  return (Array.isArray(lines) ? lines : []).map((line) => {
    const text = cleanString(line.text || "");
    const mojibake = detectMojibake(text);
    return {
      ...line,
      text,
      low_confidence: Boolean(line.low_confidence || mojibake),
      mojibake_suspect: mojibake,
      quality_issue: mojibake ? "mojibake-suspect" : line.quality_issue || ""
    };
  });
}

function summarizeOcrQuality(lines = []) {
  const total = Array.isArray(lines) ? lines.length : 0;
  const lowConfidence = lines.filter((line) => line.low_confidence).length;
  const mojibake = lines.filter((line) => line.mojibake_suspect).length;
  return {
    status: mojibake ? "needs-review" : lowConfidence ? "warning" : "pass",
    lineCount: total,
    lowConfidenceCount: lowConfidence,
    mojibakeCount: mojibake
  };
}

function detectMojibake(text = "") {
  const value = String(text || "");
  if (!value) return false;
  if (/[\uE000-\uF8FF\uFFFD]/.test(value)) return true;
  if (/[€�]/.test(value)) return true;
  if (/[锛绔垫湀鏈哄伐鎶棶窛]/.test(value) && /[涓姹囧窛鎶鏈鍛樺伐鎱棶鎻愭椿哄厛鑷磋繙]/.test(value)) return true;
  const cjk = (value.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (value.match(/[A-Za-z0-9]/g) || []).length;
  const suspicious = (value.match(/[€锛绔垫湀鏈哄伐鎶棶窛]/g) || []).length;
  return cjk >= 3 && suspicious / Math.max(1, cjk + latin) > 0.35;
}

export function getOcrInputImages(job, options = {}) {
  const visualImages = Array.isArray(job.artifacts?.visualImages) ? job.artifacts.visualImages : [];
  const renderedPages = Array.isArray(job.artifacts?.renderedPages) ? job.artifacts.renderedPages : [];
  const requestedSource = cleanString(options.source || options.ocrSource || "");
  const selectedPages = new Set(normalizePages(options.pages || options.pageIds || options.page || options.pageId || []));
  const maxPages = clampInteger(options.maxPages || options.limit, 1, 500, 500);
  const images = requestedSource === "visual"
    ? (visualImages.length ? visualImages : renderedPages)
    : (renderedPages.length ? renderedPages : visualImages);
  return images
    .map((item, index) => ({
      item,
      pageId: item?.pageId || `page_${String(index + 1).padStart(3, "0")}`,
      pageNumber: Number(item?.pageNumber || index + 1)
    }))
    .filter(({ item }) => item?.path && fsSync.existsSync(item.path))
    .filter(({ pageId }) => !selectedPages.size || selectedPages.has(normalizePageId(pageId)))
    .map(({ item, pageId, pageNumber }) => ({
      pageId,
      pageNumber,
      path: item.path,
      sha256: cleanString(item.sha256 || "") || currentFileSha256Sync(path.resolve(item.path))
    }))
    .sort((a, b) => a.pageNumber - b.pageNumber)
    .slice(0, maxPages);
}

function upsertPage(pages = [], pageNumber, status, message, details = {}) {
  const next = Array.isArray(pages) ? [...pages] : [];
  const pageId = `page_${String(pageNumber).padStart(3, "0")}`;
  const index = next.findIndex((page) => page.pageNumber === pageNumber);
  const record = {
    ...(index >= 0 ? next[index] : {}),
    pageId,
    pageNumber,
    status,
    message,
    details: { ...(index >= 0 ? next[index].details || {} : {}), ...details },
    updatedAt: new Date().toISOString()
  };
  if (index >= 0) next[index] = record;
  else next.push(record);
  return next.sort((a, b) => a.pageNumber - b.pageNumber);
}

function markStage(stage = {}, status, message, details = {}) {
  const now = new Date().toISOString();
  return {
    ...stage,
    status,
    message,
    details,
    updatedAt: now,
    startedAt: stage.startedAt || now,
    ...(status === "complete" || status === "failed" ? { finishedAt: now } : {})
  };
}

function appendEvent(events = [], type, message, details = {}) {
  return [...(Array.isArray(events) ? events : []), {
    id: `evt_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    type,
    message,
    details,
    createdAt: new Date().toISOString()
  }].slice(-500);
}

function normalizePageId(value = "") {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (/^\d+$/.test(raw)) return `page_${String(Number(raw)).padStart(3, "0")}`;
  return /^page_\d{3}$/.test(raw) ? raw : "";
}

function normalizePages(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[,\s]+/);
  return raw.map((item) => normalizePageId(item)).filter(Boolean);
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function cleanString(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 1000);
}

function artifactRecord(kind, filePath, extra = {}) {
  const stat = fsSync.existsSync(filePath) ? fsSync.statSync(filePath) : null;
  return {
    kind,
    path: filePath,
    relativePath: path.relative(process.cwd(), filePath),
    size: stat?.size || 0,
    createdAt: new Date().toISOString(),
    ...extra
  };
}
