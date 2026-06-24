import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { imageSize } from "image-size";
import { PDFParse } from "pdf-parse";
import { exportWithPowerPoint } from "./ppt.js";
import { readWorkflowJob, saveWorkflowJob } from "./workflowJobs.js";

const execFileAsync = promisify(execFile);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".svg"]);
const PPT_EXTS = new Set([".pptx", ".ppt"]);
const BRIEF_EXTS = new Set([".md", ".markdown", ".txt"]);

export async function renderWorkflowSource(jobId) {
  const job = await readWorkflowJob(jobId);
  const source = job.artifacts?.source;
  if (!source?.path) throw new Error("Workflow job has no source artifact");
  const sourcePath = path.resolve(source.path);
  if (!fsSync.existsSync(sourcePath)) throw new Error("Workflow source file is missing");

  await fs.mkdir(job.dirs.renderedPages, { recursive: true });
  await clearRenderedPages(job.dirs.renderedPages);

  const ext = path.extname(source.originalName || sourcePath).toLowerCase();
  const startedAt = new Date().toISOString();
  let meta;
  if (PPT_EXTS.has(ext)) {
    meta = await renderPptxSource({ job, source, sourcePath, startedAt });
  } else if (ext === ".pdf") {
    meta = await renderPdfSource({ job, source, sourcePath, startedAt });
  } else if (IMAGE_EXTS.has(ext)) {
    meta = await renderImageSource({ job, source, sourcePath, startedAt });
  } else if (BRIEF_EXTS.has(ext) || source.kind === "brief_source") {
    meta = await renderBriefSource({ job, source, sourcePath, startedAt });
  } else {
    meta = makeFailedMeta({ job, source, renderer: "unsupported", startedAt, error: `Unsupported source type: ${ext || "unknown"}` });
  }

  const metaPath = path.join(job.dirs.source, "source_meta.json");
  await fs.mkdir(job.dirs.source, { recursive: true });
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");

  job.artifacts = {
    ...(job.artifacts || {}),
    sourceMeta: artifactRecord("source_meta", metaPath, { renderer: meta.renderer, pageCount: meta.pageCount || 0, warnings: meta.warnings || [] }),
    renderedPages: meta.pages || []
  };
  job.pages = (meta.pages || []).map((page) => ({
    pageId: page.pageId,
    pageNumber: page.pageNumber,
    status: meta.ok ? "pending" : "failed",
    message: meta.ok ? "rendered page ready" : meta.error || "source render failed",
    details: {
      imagePath: page.path,
      width: page.width || null,
      height: page.height || null,
      renderer: meta.renderer
    },
    updatedAt: new Date().toISOString()
  }));
  if (meta.ok) {
    job.currentStage = "source_rendered";
    job.status = "source_rendered";
    job.stageStatus = "complete";
    job.stages.source_rendered = markStage(job.stages.source_rendered, "complete", `Rendered ${meta.pageCount} source page(s)`, { renderer: meta.renderer, pageCount: meta.pageCount });
  } else {
    job.currentStage = "source_rendered";
    job.status = "failed";
    job.stageStatus = "failed";
    job.stages.source_rendered = markStage(job.stages.source_rendered, "failed", meta.error || "Source render failed", { renderer: meta.renderer, warnings: meta.warnings || [] });
    job.errors = [...(job.errors || []), { stage: "source_rendered", message: meta.error || "Source render failed", createdAt: new Date().toISOString(), details: meta }].slice(-50);
  }
  job.events = [...(job.events || []), {
    id: `evt_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    type: meta.ok ? "source.rendered" : "source.render_failed",
    message: meta.ok ? `Rendered ${meta.pageCount} source page(s)` : meta.error || "Source render failed",
    details: { renderer: meta.renderer, pageCount: meta.pageCount || 0, warnings: meta.warnings || [] },
    createdAt: new Date().toISOString()
  }].slice(-500);

  return saveWorkflowJob(job);
}

async function renderBriefSource({ job, source, sourcePath, startedAt }) {
  const text = await fs.readFile(sourcePath, "utf8");
  const targetPath = path.join(job.dirs.renderedPages, "page_001.md");
  await fs.writeFile(targetPath, text, "utf8");
  const page = await pageRecord({ pageNumber: 1, filePath: targetPath, sourcePath });
  return makeMeta({
    job,
    source,
    startedAt,
    renderer: "brief-source",
    pages: [{
      ...page,
      kind: "brief_page",
      textCharCount: text.length,
      width: null,
      height: null,
      format: "markdown"
    }],
    warnings: ["brief-source-has-no-page-raster"]
  });
}

async function renderPptxSource({ job, source, sourcePath, startedAt }) {
  try {
    const exported = await exportWithPowerPoint(sourcePath, ["png"]);
    const exportedImages = Array.isArray(exported.png) ? exported.png : [];
    if (!exportedImages.length) throw new Error("PowerPoint export produced no PNG pages");
    const pages = [];
    for (const [index, imagePath] of exportedImages.entries()) {
      const pageNumber = index + 1;
      const targetPath = path.join(job.dirs.renderedPages, `page_${String(pageNumber).padStart(3, "0")}.png`);
      await fs.copyFile(imagePath, targetPath);
      pages.push(await pageRecord({ pageNumber, filePath: targetPath, sourcePath: imagePath }));
    }
    return makeMeta({ job, source, startedAt, renderer: "powerpoint-com", pages, extra: { exportResult: exported } });
  } catch (error) {
    return makeFailedMeta({
      job,
      source,
      renderer: "powerpoint-com",
      startedAt,
      error: error.message || "PowerPoint source render failed",
      warnings: ["powerpoint-render-failed"]
    });
  }
}

async function renderPdfSource({ job, source, sourcePath, startedAt }) {
  const command = process.env.PDFTOPPM_PATH || "pdftoppm";
  const argsPrefix = getPdfRendererArgsPrefix();
  const dpi = clampNumber(process.env.PDF_RENDER_DPI, 72, 300, 160);
  const timeout = clampNumber(process.env.PDF_RENDER_TIMEOUT_MS, 10000, 600000, 180000);
  const tempDir = path.join(job.dirs.renderedPages, "_pdf");
  const prefix = path.join(tempDir, "page");
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(tempDir, { recursive: true });
    await execFileAsync(command, [...argsPrefix, "-png", "-r", String(dpi), sourcePath, prefix], {
      timeout,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 8
    });
    const entries = await fs.readdir(tempDir);
    const rendered = entries
      .filter((name) => /^page-\d+\.png$/i.test(name))
      .sort((a, b) => Number(a.match(/-(\d+)\.png$/i)?.[1] || 0) - Number(b.match(/-(\d+)\.png$/i)?.[1] || 0));
    if (!rendered.length) throw new Error("pdftoppm produced no PNG pages");
    const pages = [];
    for (const [index, name] of rendered.entries()) {
      const pageNumber = index + 1;
      const renderedPath = path.join(tempDir, name);
      const targetPath = path.join(job.dirs.renderedPages, `page_${String(pageNumber).padStart(3, "0")}.png`);
      await fs.copyFile(renderedPath, targetPath);
      pages.push(await pageRecord({ pageNumber, filePath: targetPath, sourcePath: renderedPath }));
    }
    await fs.rm(tempDir, { recursive: true, force: true });
    return makeMeta({
      job,
      source,
      startedAt,
      renderer: "pdftoppm",
      pages,
      extra: { dpi, command: path.basename(command) }
    });
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    const missing = error?.code === "ENOENT";
    try {
      return await renderPdfSourceWithPdfParse({
        job,
        source,
        sourcePath,
        startedAt,
        dpi,
        popplerCommand: command,
        popplerError: error,
        popplerMissing: missing
      });
    } catch (fallbackError) {
      return makeFailedMeta({
        job,
        source,
        renderer: "pdf-renderer-failed",
        startedAt,
        error: missing
          ? `PDF rendering requires a working renderer. Poppler pdftoppm is missing and pdf-parse fallback failed: ${fallbackError.message || fallbackError}`
          : `PDF rendering failed in pdftoppm and pdf-parse fallback: ${fallbackError.message || fallbackError}`,
        warnings: [missing ? "pdf-renderer-not-configured" : "pdf-renderer-failed", "pdf-parse-fallback-failed"],
        extra: {
          command: path.basename(command),
          dpi,
          fallback: "pdf-parse",
          fallbackError: fallbackError.message || String(fallbackError || "")
        }
      });
    }
  }
}

async function renderPdfSourceWithPdfParse({ job, source, sourcePath, startedAt, dpi, popplerCommand, popplerError, popplerMissing }) {
  const desiredWidth = clampNumber(process.env.PDF_PARSE_RENDER_WIDTH, 720, 4096, 1600);
  const data = await fs.readFile(sourcePath);
  const parser = new PDFParse({ data });
  let result;
  try {
    result = await parser.getScreenshot({
      desiredWidth,
      imageBuffer: true,
      imageDataUrl: false
    });
  } finally {
    await parser.destroy().catch(() => {});
  }

  const renderedPages = Array.isArray(result?.pages) ? result.pages : [];
  if (!renderedPages.length) throw new Error("pdf-parse produced no PNG pages");

  const pages = [];
  for (const [index, page] of renderedPages.entries()) {
    if (!page?.data) throw new Error(`pdf-parse page ${index + 1} has no image buffer`);
    const pageNumber = page.pageNumber || index + 1;
    const targetPath = path.join(job.dirs.renderedPages, `page_${String(pageNumber).padStart(3, "0")}.png`);
    await fs.writeFile(targetPath, Buffer.from(page.data));
    pages.push(await pageRecord({ pageNumber, filePath: targetPath, sourcePath }));
  }

  return makeMeta({
    job,
    source,
    startedAt,
    renderer: "pdf-parse",
    pages,
    warnings: [popplerMissing ? "pdftoppm-missing-used-pdf-parse" : "pdftoppm-failed-used-pdf-parse"],
    extra: {
      desiredWidth,
      dpi,
      fallbackFrom: "pdftoppm",
      poppler: {
        command: path.basename(popplerCommand || "pdftoppm"),
        error: popplerError?.message || String(popplerError || "")
      }
    }
  });
}

async function renderImageSource({ job, source, sourcePath, startedAt }) {
  const ext = path.extname(sourcePath).toLowerCase() || ".png";
  const targetExt = ext === ".jpeg" ? ".jpg" : ext;
  const targetPath = path.join(job.dirs.renderedPages, `page_001${targetExt}`);
  await fs.copyFile(sourcePath, targetPath);
  const page = await pageRecord({ pageNumber: 1, filePath: targetPath, sourcePath });
  const warnings = targetExt !== ".png" ? ["image-source-kept-original-format"] : [];
  return makeMeta({ job, source, startedAt, renderer: "image-passthrough", pages: [page], warnings });
}

async function pageRecord({ pageNumber, filePath, sourcePath }) {
  const stat = await fs.stat(filePath);
  const dimensions = getImageDimensions(filePath);
  return {
    pageId: `page_${String(pageNumber).padStart(3, "0")}`,
    pageNumber,
    path: filePath,
    relativePath: path.relative(process.cwd(), filePath),
    sourcePath,
    size: stat.size,
    width: dimensions?.width || null,
    height: dimensions?.height || null,
    format: dimensions?.type || path.extname(filePath).replace(/^\./, "").toLowerCase(),
    createdAt: new Date().toISOString()
  };
}

function getImageDimensions(filePath) {
  try {
    return imageSize(filePath);
  } catch {
    return null;
  }
}

function makeMeta({ job, source, startedAt, renderer, pages, warnings = [], extra = {} }) {
  const finishedAt = new Date().toISOString();
  return {
    version: 1,
    ok: true,
    jobId: job.id,
    renderer,
    source: {
      originalName: source.originalName || "",
      path: source.path,
      size: source.size || 0,
      sha256: source.sha256 || ""
    },
    pageCount: pages.length,
    pages,
    warnings,
    startedAt,
    finishedAt,
    ...extra
  };
}

function makeFailedMeta({ job, source, renderer, startedAt, error, warnings = [], extra = {} }) {
  const finishedAt = new Date().toISOString();
  return {
    version: 1,
    ok: false,
    jobId: job.id,
    renderer,
    source: {
      originalName: source.originalName || "",
      path: source.path,
      size: source.size || 0,
      sha256: source.sha256 || ""
    },
    pageCount: 0,
    pages: [],
    warnings,
    error,
    startedAt,
    finishedAt,
    ...extra
  };
}

function markStage(stage = {}, status, message, details = {}) {
  const now = new Date().toISOString();
  return {
    ...stage,
    id: "source_rendered",
    status,
    message,
    details,
    updatedAt: now,
    startedAt: stage.startedAt || now,
    finishedAt: now
  };
}

function artifactRecord(kind, filePath, extra = {}) {
  return {
    kind,
    path: filePath,
    relativePath: path.relative(process.cwd(), filePath),
    createdAt: new Date().toISOString(),
    ...extra
  };
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value || fallback);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function getPdfRendererArgsPrefix() {
  const json = String(process.env.PDFTOPPM_ARGS_PREFIX_JSON || "").trim();
  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed)) return parsed.map((item) => String(item));
    } catch {
      return [];
    }
  }
  const raw = String(process.env.PDFTOPPM_ARGS_PREFIX || "").trim();
  return raw ? splitCommandArgs(raw) : [];
}

function splitCommandArgs(value = "") {
  const matches = String(value).match(/"([^"]*)"|'([^']*)'|[^\s]+/g) || [];
  return matches.map((item) => item.replace(/^["']|["']$/g, ""));
}

async function clearRenderedPages(dir) {
  await fs.mkdir(dir, { recursive: true });
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.map((entry) => fs.rm(path.join(dir, entry.name), { recursive: true, force: true })));
}
