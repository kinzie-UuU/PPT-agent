import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { getProviderConfig } from "./providers.js";
import { readWorkflowJob, saveWorkflowJob } from "./workflowJobs.js";

const execFileAsync = promisify(execFile);

export async function runWorkflowOcr(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const images = getOcrInputImages(job, options);
  if (!images.length) throw new Error("No visual images or rendered pages available for OCR");
  await fs.mkdir(job.dirs.ocr, { recursive: true });
  const provider = getProviderConfig().ocr;
  if (!provider.enabled) throw new Error("OCR provider disabled");
  if (provider.provider !== "rapidocr-local") throw new Error(`Unsupported OCR provider: ${provider.provider}`);

  const startedAt = new Date().toISOString();
  const pages = [];
  const errors = [];
  for (const image of images) {
    try {
      const page = await runRapidOcrPage({ image, ocrDir: job.dirs.ocr, provider, minConfidence: options.minConfidence });
      pages.push(page);
      job.pages = upsertPage(job.pages, image.pageNumber, "recorded", `OCR ready: ${page.lineCount} line(s)`, {
        ocrPath: page.ocrPath,
        textCount: page.lineCount,
        lowConfidenceCount: page.lowConfidenceCount
      });
    } catch (error) {
      const failure = {
        pageId: image.pageId,
        pageNumber: image.pageNumber,
        error: error.message || "OCR failed"
      };
      errors.push(failure);
      job.pages = upsertPage(job.pages, image.pageNumber, "failed", failure.error, {});
    }
  }

  const hints = buildTextHints({ job, provider, startedAt, pages, errors });
  const hintsPath = path.join(job.dirs.ocr, "text_hints.json");
  await fs.writeFile(hintsPath, JSON.stringify(hints, null, 2), "utf8");

  job.artifacts = {
    ...(job.artifacts || {}),
    ocrTextHints: artifactRecord("ocr_text_hints", hintsPath, {
      pageCount: pages.length,
      textCount: hints.summary.textCount,
      lowConfidenceCount: hints.summary.lowConfidenceCount
    }),
    ocrPages: pages.map((page) => ({
      kind: "ocr_page",
      pageId: page.pageId,
      pageNumber: page.pageNumber,
      path: page.ocrPath,
      relativePath: path.relative(process.cwd(), page.ocrPath),
      lineCount: page.lineCount,
      lowConfidenceCount: page.lowConfidenceCount
    }))
  };
  await syncRapidOcrHintsToEditableRun(job, hintsPath);
  job.currentStage = "ocr_ready";
  job.status = errors.length ? "failed" : "ocr_ready";
  job.stageStatus = errors.length ? "failed" : "complete";
  job.stages.ocr_ready = markStage(job.stages.ocr_ready, errors.length ? "failed" : "complete", errors.length ? "Some OCR pages failed" : `OCR ready for ${pages.length} page(s)`, {
    provider: provider.provider,
    pageCount: pages.length,
    errors
  });
  job.events = appendEvent(job.events, errors.length ? "ocr.failed" : "ocr.ready", errors.length ? "Some OCR pages failed" : `OCR ready for ${pages.length} page(s)`, {
    pageCount: pages.length,
    textCount: hints.summary.textCount,
    lowConfidenceCount: hints.summary.lowConfidenceCount,
    errors
  });
  if (errors.length) job.errors = [...(job.errors || []), ...errors.map((item) => ({ stage: "ocr_ready", message: item.error, details: item, createdAt: new Date().toISOString() }))].slice(-50);
  return saveWorkflowJob(job);
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
  await syncRapidOcrHintsToEditableRun(job, hintsPath);
  job.events = appendEvent(job.events, "ocr.text_corrected", `Corrected OCR text ${pageId}/${lineId}`, {
    pageId,
    lineId,
    previousText,
    text: nextText
  });
  return saveWorkflowJob(job);
}

async function runRapidOcrPage({ image, ocrDir, provider, minConfidence }) {
  const threshold = Number.isFinite(Number(minConfidence)) ? Number(minConfidence) : 0.35;
  const pageDir = path.join(ocrDir, image.pageId);
  await fs.mkdir(pageDir, { recursive: true });
  const outputPath = path.join(pageDir, "ocr.json");
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
  await execFileAsync(provider.pythonPath, ["-c", script, image.path, outputPath, String(threshold)], {
    timeout: provider.timeoutMs,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    encoding: "utf8"
  });
  const data = JSON.parse(await fs.readFile(outputPath, "utf8"));
  return {
    pageId: image.pageId,
    pageNumber: image.pageNumber,
    imagePath: image.path,
    ocrPath: outputPath,
    backend: data.backend,
    lineCount: data.line_count || 0,
    lowConfidenceCount: data.low_confidence_count || 0,
    lines: data.lines || []
  };
}

function recomputeOcrHints(hints = {}) {
  const pages = Array.isArray(hints.pages) ? hints.pages : [];
  for (const page of pages) {
    const lines = Array.isArray(page.ocrLines) ? page.ocrLines : [];
    page.lineCount = lines.length;
    page.lowConfidenceCount = lines.filter((line) => line.low_confidence).length;
    page.requiredText = lines.filter((line) => !line.low_confidence).map((line) => line.text).filter(Boolean);
  }
  const allLines = pages.flatMap((page) => Array.isArray(page.ocrLines) ? page.ocrLines : []);
  hints.summary = {
    ...(hints.summary || {}),
    pageCount: pages.length,
    textCount: allLines.length,
    lowConfidenceCount: allLines.filter((line) => line.low_confidence).length,
    correctedCount: allLines.filter((line) => line.corrected).length
  };
}

async function syncRapidOcrHintsToEditableRun(job, hintsPath) {
  const runDir = job.artifacts?.editableRun?.path || "";
  const target = job.artifacts?.editableRun?.rapidOcrHintsPath || (runDir ? path.join(runDir, "workflow_rapidocr_text_hints.json") : "");
  if (!target) return;
  const targetDir = path.dirname(target);
  if (!fsSync.existsSync(targetDir)) return;
  await fs.copyFile(hintsPath, target);
}

function buildTextHints({ job, provider, startedAt, pages, errors }) {
  const textCount = pages.reduce((sum, page) => sum + page.lineCount, 0);
  const lowConfidenceCount = pages.reduce((sum, page) => sum + page.lowConfidenceCount, 0);
  const finishedAt = new Date().toISOString();
  return {
    version: 1,
    jobId: job.id,
    backend: provider.provider,
    ocrBackend: {
      name: "rapidocr-onnxruntime",
      mode: "local-open-source",
      pythonPath: provider.pythonPath
    },
    summary: {
      pageCount: pages.length,
      textCount,
      lowConfidenceCount,
      errorCount: errors.length
    },
    pages: pages.map((page) => ({
      pageId: page.pageId,
      pageNumber: page.pageNumber,
      imagePath: page.imagePath,
      ocrPath: page.ocrPath,
      lineCount: page.lineCount,
      lowConfidenceCount: page.lowConfidenceCount,
      requiredText: page.lines.filter((line) => !line.low_confidence).map((line) => line.text),
      ocrLines: page.lines
    })),
    errors,
    startedAt,
    finishedAt
  };
}

function getOcrInputImages(job, options = {}) {
  const visualImages = Array.isArray(job.artifacts?.visualImages) ? job.artifacts.visualImages : [];
  const renderedPages = Array.isArray(job.artifacts?.renderedPages) ? job.artifacts.renderedPages : [];
  const requestedSource = cleanString(options.source || options.ocrSource || "");
  const selectedPages = new Set(normalizePages(options.pages || options.pageIds || options.page || options.pageId || []));
  const maxPages = clampInteger(options.maxPages || options.limit, 1, 500, 500);
  const images = requestedSource === "visual"
    ? (visualImages.length ? visualImages : renderedPages)
    : (renderedPages.length ? renderedPages : visualImages);
  return images
    .filter((item) => item?.path && fsSync.existsSync(item.path))
    .map((item, index) => ({
      pageId: item.pageId || `page_${String(index + 1).padStart(3, "0")}`,
      pageNumber: Number(item.pageNumber || index + 1),
      path: item.path
    }))
    .filter((item) => !selectedPages.size || selectedPages.has(normalizePageId(item.pageId)))
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
