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

  const startedAt = new Date().toISOString();
  const pages = [];
  const errors = [];
  for (const image of images) {
    try {
      const page = await runOcrPage({ image, ocrDir: job.dirs.ocr, provider, minConfidence: options.minConfidence });
      pages.push(page);
      job.pages = upsertPage(job.pages, image.pageNumber, "recorded", `OCR ready: ${page.lineCount} line(s) via ${page.backend}`, {
        ocrPath: page.ocrPath,
        ocrBackend: page.backend,
        textCount: page.lineCount,
        lowConfidenceCount: page.lowConfidenceCount,
        mojibakeCount: page.mojibakeCount || 0,
        quality: page.quality || {}
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
      backend: hints.ocrBackend?.name || hints.backend || provider.provider,
      fallbackBackend: hints.fallbackBackend || provider.fallbackProvider || "",
      ocrBackend: hints.ocrBackend,
      pageCount: pages.length,
      textCount: hints.summary.textCount,
      lowConfidenceCount: hints.summary.lowConfidenceCount,
      mojibakeCount: hints.summary.mojibakeCount,
      quality: hints.summary.quality
    }),
    ocrPages: pages.map((page) => ({
      kind: "ocr_page",
      pageId: page.pageId,
      pageNumber: page.pageNumber,
      path: page.ocrPath,
      relativePath: path.relative(process.cwd(), page.ocrPath),
      backend: page.backend,
      lineCount: page.lineCount,
      lowConfidenceCount: page.lowConfidenceCount,
      mojibakeCount: page.mojibakeCount || 0,
      quality: page.quality || {}
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
    mojibakeCount: hints.summary.mojibakeCount,
    quality: hints.summary.quality,
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

async function runOcrPage({ image, ocrDir, provider, minConfidence }) {
  const providers = buildOcrProviderChain(provider);
  const failures = [];
  for (const providerName of providers) {
    try {
      const page = providerName === "paddleocr-local"
        ? await runPaddleOcrPage({ image, ocrDir, provider, minConfidence })
        : await runRapidOcrPage({ image, ocrDir, provider, minConfidence });
      page.fallbacks = failures;
      if (page.quality?.hasMojibake && providerName !== providers.at(-1)) {
        failures.push({
          provider: providerName,
          reason: `OCR output looks mojibake (${page.mojibakeCount || 0} line(s)); trying fallback.`
        });
        continue;
      }
      return page;
    } catch (error) {
      failures.push({ provider: providerName, reason: error.message || String(error) });
    }
  }
  throw new Error(failures.map((item) => `${item.provider}: ${item.reason}`).join(" | ") || "OCR failed");
}

function buildOcrProviderChain(provider = {}) {
  const selected = [provider.provider || "paddleocr-local", provider.fallbackProvider || "rapidocr-local"]
    .map((item) => cleanString(item))
    .filter(Boolean);
  return [...new Set(selected)].filter((item) => ["paddleocr-local", "rapidocr-local"].includes(item));
}

async function runPaddleOcrPage({ image, ocrDir, provider, minConfidence }) {
  const threshold = Number.isFinite(Number(minConfidence)) ? Number(minConfidence) : 0.35;
  const pageDir = path.join(ocrDir, image.pageId);
  await fs.mkdir(pageDir, { recursive: true });
  const outputPath = path.join(pageDir, "ocr.json");
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
    "        x,y,w,h=[float(v) for v in pts]; pts=[[x,y],[x+w,y],[x+w,y+h],[x,y+h]]",
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
  await execFileAsync(provider.pythonPath, ["-c", script, image.path, outputPath, String(threshold)], {
    timeout: provider.timeoutMs,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    encoding: "utf8"
  });
  return readOcrPageResult({ image, outputPath });
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
  return readOcrPageResult({ image, outputPath });
}

async function readOcrPageResult({ image, outputPath }) {
  const data = JSON.parse(await fs.readFile(outputPath, "utf8"));
  const lines = annotateOcrLines(data.lines || []);
  const quality = summarizeOcrQuality(lines);
  return {
    pageId: image.pageId,
    pageNumber: image.pageNumber,
    imagePath: image.path,
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
      fallback: provider.fallbackProvider || ""
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
      ocrPath: page.ocrPath,
      backend: page.backend,
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
  if (/[€�]/.test(value)) return true;
  if (/[锛绔垫湀鏈哄伐鎶棶窛]/.test(value) && /[涓姹囧窛鎶鏈鍛樺伐鎱棶鎻愭椿哄厛鑷磋繙]/.test(value)) return true;
  const cjk = (value.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (value.match(/[A-Za-z0-9]/g) || []).length;
  const suspicious = (value.match(/[€锛绔垫湀鏈哄伐鎶棶窛]/g) || []).length;
  return cjk >= 3 && suspicious / Math.max(1, cjk + latin) > 0.35;
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
