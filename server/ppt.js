import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import JSZip from "jszip";
import pptxgen from "pptxgenjs";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { imageSize } from "image-size";
import { outputDir, rootDir, uploadDir } from "./store.js";
import { getTemplatePack, getThemeRecord } from "./designSystem.js";
import { ensureSceneGraphForJob } from "./sceneGraph.js";
import { inspectEditablePptx } from "./pptxEditability.js";
import { writeEditableSceneGraphArtifacts } from "./visualProject.js";

const execFileAsync = promisify(execFile);
const MAX_EXTRACTED_CHARS = 18000;
const SLIDE_W = 13.333;
const SLIDE_H = 7.5;

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export async function extractText(file) {
  const ext = path.extname(file.originalName || file.path).toLowerCase();
  if (ext === ".pptx") return limitExtractedText(await extractPptxText(file.path));
  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ path: file.path });
    return limitExtractedText(cleanText(result.value));
  }
  if (ext === ".xlsx") return limitExtractedText(await extractXlsxText(file.path));
  if (ext === ".xls") return "旧版 XLS 已上传。当前可保留文件信息；建议另存为 XLSX 后可抽取表格文本。";
  if (ext === ".pdf") return limitExtractedText(await extractPdfText(file.path));
  if ([".png", ".jpg", ".jpeg", ".webp", ".svg"].includes(ext)) return `图片素材已上传：${file.originalName || path.basename(file.path)}。生成时请为其预留图片槽位。`;
  if ([".txt", ".md", ".csv"].includes(ext)) return limitExtractedText(cleanText(await fs.readFile(file.path, "utf8")));
  return "";
}

async function extractPdfText(filePath) {
  const buffer = await fs.readFile(filePath);
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return cleanText(result.text);
  } finally {
    await parser.destroy?.();
  }
}

async function extractXlsxText(filePath) {
  const buffer = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(buffer);
  const sharedStrings = await readSharedStrings(zip);
  const sheetFiles = Object.keys(zip.files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/sheet(\d+)/)[1]) - Number(b.match(/sheet(\d+)/)[1]));
  const sheets = [];
  for (const [sheetIndex, name] of sheetFiles.entries()) {
    const xml = await zip.files[name].async("text");
    const cells = [...xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].map((match) => {
      const attrs = match[1] || "";
      const body = match[2] || "";
      const type = attrs.match(/\bt="([^"]+)"/)?.[1];
      const value = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] || body.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] || "";
      if (!value) return "";
      if (type === "s") return sharedStrings[Number(value)] || "";
      return decodeXml(value);
    }).map(cleanText).filter(Boolean);
    if (cells.length) sheets.push(`工作表 ${sheetIndex + 1}：${cells.slice(0, 300).join(" / ")}`);
  }
  return sheets.join("\n") || "XLSX 已上传，但未抽取到可读单元格文本。";
}

async function readSharedStrings(zip) {
  const file = zip.files["xl/sharedStrings.xml"];
  if (!file) return [];
  const xml = await file.async("text");
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) => {
    const parts = [...match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((item) => decodeXml(item[1]));
    return cleanText(parts.join(""));
  });
}

export async function extractPptxText(filePath) {
  const buffer = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = await getOrderedSlideFiles(zip);
  const slides = [];
  for (const name of slideFiles) {
    const xml = await zip.files[name].async("text");
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1]));
    slides.push(cleanText(texts.join(" ")));
  }
  return slides.map((text, index) => `-- ${index + 1} of ${slides.length} --\n${text}`).join("\n");
}

export async function extractPptxImages(file) {
  const ext = path.extname(file.originalName || file.path || "").toLowerCase();
  if (ext !== ".pptx") return [];
  const buffer = await fs.readFile(file.path);
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = await getOrderedSlideFiles(zip);
  const mediaDir = path.join(uploadDir, "pptx-media", file.id || safeName(path.basename(file.path || "pptx")));
  await fs.mkdir(mediaDir, { recursive: true });
  const images = [];
  const seen = new Set();
  for (const [index, slideName] of slideFiles.entries()) {
    const slideIndex = index + 1;
    const relsName = slideName.replace("ppt/slides/", "ppt/slides/_rels/") + ".rels";
    const relsFile = zip.files[relsName];
    const slideFile = zip.files[slideName];
    if (!relsFile || !slideFile) continue;
    const [relsXml, slideXml] = await Promise.all([relsFile.async("text"), slideFile.async("text")]);
    const usedRelIds = new Set([...slideXml.matchAll(/(?:r:embed|r:link)="([^"]+)"/g)].map((match) => match[1]));
    for (const rel of parseImageRelationships(relsXml)) {
      if (!usedRelIds.has(rel.id)) continue;
      const mediaPath = resolvePptxTarget(slideName, rel.target);
      const mediaFile = zip.files[mediaPath];
      if (!mediaFile) continue;
      const extName = path.extname(mediaPath).toLowerCase() || ".png";
      const key = `${slideIndex}-${rel.id}-${mediaPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const originalBase = safeName(path.basename(file.originalName || "source.pptx", ext)) || "source";
      const filename = `${originalBase}-slide${String(slideIndex).padStart(2, "0")}-${safeName(path.basename(mediaPath, extName))}${extName}`;
      const outputPath = path.join(mediaDir, filename);
      const bytes = await mediaFile.async("nodebuffer");
      await fs.writeFile(outputPath, bytes);
      images.push({
        id: `${file.id || "pptx"}_slide${slideIndex}_${rel.id}`,
        originalName: filename,
        mimeType: mimeTypeFromExt(extName),
        path: outputPath,
        size: bytes.length,
        createdAt: new Date().toISOString(),
        source: "pptx-media",
        sourceUploadId: file.id || null,
        sourceUploadName: file.originalName || path.basename(file.path || ""),
        sourceSlide: slideIndex,
        sourceSlideFile: slideName,
        sourceRelId: rel.id,
        sourceMediaPath: mediaPath,
        derived: true
      });
    }
  }
  return images;
}

export async function auditPptxIntake(file) {
  const ext = path.extname(file.originalName || file.path || "").toLowerCase();
  if (ext !== ".pptx") return null;
  const buffer = await fs.readFile(file.path);
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = await getOrderedSlideFiles(zip);
  const slides = [];
  const warnings = [];
  let embeddedImageRefs = 0;
  let extractedImageRefs = 0;
  let linkedImageRefs = 0;
  let missingImageRefs = 0;
  for (const [index, slideName] of slideFiles.entries()) {
    const slideFile = zip.files[slideName];
    if (!slideFile) {
      warnings.push(`missing-slide-xml:${index + 1}`);
      continue;
    }
    const slideXml = await slideFile.async("text");
    const relsName = slideName.replace("ppt/slides/", "ppt/slides/_rels/") + ".rels";
    const relsXml = zip.files[relsName] ? await zip.files[relsName].async("text") : "";
    const usedRelIds = new Set([...slideXml.matchAll(/(?:r:embed|r:link)="([^"]+)"/g)].map((match) => match[1]));
    const textParts = [...slideXml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1]));
    const imageRels = parseImageRelationships(relsXml).filter((rel) => usedRelIds.has(rel.id));
    const embedded = [];
    const linked = [];
    const missing = [];
    for (const rel of imageRels) {
      if (/^https?:\/\//i.test(rel.target) || rel.targetMode === "External") {
        linked.push(rel.id);
        continue;
      }
      const mediaPath = resolvePptxTarget(slideName, rel.target);
      if (zip.files[mediaPath]) embedded.push(rel.id);
      else missing.push(rel.id);
    }
    embeddedImageRefs += embedded.length;
    linkedImageRefs += linked.length;
    missingImageRefs += missing.length;
    extractedImageRefs += embedded.length;
    const sourceNumber = slideName.match(/slide(\d+)/)?.[1] || String(index + 1);
    const text = cleanText(textParts.join(" "));
    slides.push({
      page: index + 1,
      slideFile: slideName,
      textChars: text.length,
      textPreview: text.slice(0, 120),
      shapeTextRuns: textParts.length,
      imageRefCount: imageRels.length,
      embeddedImageRefCount: embedded.length,
      linkedImageRefCount: linked.length,
      missingImageRefCount: missing.length,
      hasNotes: Boolean(zip.files[`ppt/notesSlides/notesSlide${sourceNumber}.xml`]),
      hasChartRef: /\/chart/i.test(relsXml),
      hasDiagramRef: /\/diagram/i.test(relsXml)
    });
  }
  if (linkedImageRefs) warnings.push(`linked-images:${linkedImageRefs}`);
  if (missingImageRefs) warnings.push(`missing-embedded-images:${missingImageRefs}`);
  if (slides.some((slide) => slide.hasChartRef)) warnings.push("chart-text-not-fully-extracted");
  if (slides.some((slide) => slide.hasDiagramRef)) warnings.push("smartart-text-may-be-partial");
  if (slides.some((slide) => slide.hasNotes)) warnings.push("speaker-notes-not-used-in-main-text");
  return {
    version: 1,
    deckName: file.originalName || path.basename(file.path || ""),
    slideCount: slideFiles.length,
    textSlideCount: slides.filter((slide) => slide.textChars > 0).length,
    embeddedImageRefs,
    extractedImageRefs,
    linkedImageRefs,
    missingImageRefs,
    confidence: missingImageRefs || linkedImageRefs ? "medium" : "high",
    slides: slides.slice(0, 80),
    warnings
  };
}

function parseImageRelationships(xml = "") {
  return [...xml.matchAll(/<Relationship\b([^>]*)\/?>/g)]
    .map((match) => {
      const attrs = match[1] || "";
      return {
        id: attrs.match(/\bId="([^"]+)"/)?.[1] || "",
        type: attrs.match(/\bType="([^"]+)"/)?.[1] || "",
        target: attrs.match(/\bTarget="([^"]+)"/)?.[1] || "",
        targetMode: attrs.match(/\bTargetMode="([^"]+)"/)?.[1] || ""
      };
    })
    .filter((rel) => rel.id && rel.target && /\/image$/i.test(rel.type));
}

async function getOrderedSlideFiles(zip) {
  const fallback = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]));
  const presentation = zip.files["ppt/presentation.xml"];
  const rels = zip.files["ppt/_rels/presentation.xml.rels"];
  if (!presentation || !rels) return fallback;
  const [presentationXml, relsXml] = await Promise.all([presentation.async("text"), rels.async("text")]);
  const relMap = new Map([...relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)].map((match) => {
    const attrs = match[1] || "";
    const id = attrs.match(/\bId="([^"]+)"/)?.[1] || "";
    const target = attrs.match(/\bTarget="([^"]+)"/)?.[1] || "";
    return [id, path.posix.normalize(path.posix.join("ppt", target))];
  }));
  const ordered = [...presentationXml.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)]
    .map((match) => relMap.get(match[1]))
    .filter((name) => name && zip.files[name] && /^ppt\/slides\/slide\d+\.xml$/.test(name));
  return ordered.length ? ordered : fallback;
}

function resolvePptxTarget(baseSlidePath, target = "") {
  const baseDir = path.posix.dirname(baseSlidePath);
  return path.posix.normalize(path.posix.join(baseDir, target));
}

function mimeTypeFromExt(ext = "") {
  const map = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".emf": "image/x-emf",
    ".wmf": "image/x-wmf"
  };
  return map[String(ext).toLowerCase()] || "application/octet-stream";
}

function decodeXml(value = "") {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function limitExtractedText(text) {
  const clean = cleanText(text);
  if (clean.length <= MAX_EXTRACTED_CHARS) return clean;
  return `${clean.slice(0, MAX_EXTRACTED_CHARS)}\n\n[资料较长，已截取前 ${MAX_EXTRACTED_CHARS} 字用于生成。]`;
}

function getTheme(style = "") {
  const record = getThemeRecord(style);
  return { ...record.colors, name: record.name, slug: record.slug };
}

function getRenderTheme(job = {}) {
  const routePlan = job.input?.routePlan || {};
  const theme = getTheme(job.input?.style || routePlan.recommendedTheme);
  const fingerprint = routePlan.styleReferenceStrategy?.fingerprint || null;
  const styled = applyStyleFingerprintToTheme(theme, fingerprint);
  styled.styleReferenceCount = routePlan.styleReferenceStrategy?.count || 0;
  styled.styleFingerprint = fingerprint;
  return styled;
}

function applyStyleFingerprintToTheme(theme = {}, fingerprint = null) {
  if (!fingerprint?.palette?.length && !fingerprint?.traits?.length) return { ...theme };
  const palette = fingerprint.palette || [];
  const traits = fingerprint.traits || [];
  const next = { ...theme };
  const hasRed = palette.some((item) => /red/.test(item));
  const hasOrange = palette.some((item) => /orange|yellow/.test(item));
  const hasGreen = palette.some((item) => /green|olive|cyan/.test(item));
  const hasBlue = palette.some((item) => /blue/.test(item));
  const dark = fingerprint.brightness === "dark" || palette.some((item) => /^dark/.test(item));
  const highContrast = traits.includes("high-contrast");
  if (hasRed) next.accent = dark ? "9E1F16" : "B73625";
  if (hasOrange) next.accent2 = dark ? "D86B2A" : "C96A2A";
  if (hasGreen) next.olive = dark ? "5F6F50" : "6E765D";
  if (!hasRed && hasBlue) next.accent = "2D74B8";
  if (dark && hasRed) {
    next.bg = "F3EBDD";
    next.paper = "FBF6EA";
    next.soft = "E9D8C3";
    next.ink = "241B16";
    next.muted = "75685C";
  }
  if (highContrast) next.soft = next.soft || "E7D6BF";
  next.styleDriven = true;
  return next;
}

export async function buildDeck(job) {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "PPT Design Tool";
  pptx.subject = job.mode === "optimize" ? "优化旧 PPT" : "生成新 PPT";
  pptx.title = job.deck.title;
  pptx.company = "Local";
  pptx.lang = "zh-CN";
  pptx.theme = { headFontFace: "Microsoft YaHei", bodyFontFace: "Microsoft YaHei", lang: "zh-CN" };
  const theme = getRenderTheme(job);
  const templatePack = getTemplatePack(job.input.routePlan?.templatePack?.slug || job.input.routePlan?.recommendedTheme || job.input.style);
  theme.templatePack = templatePack;
  job.renderReport = { version: 1, createdAt: new Date().toISOString(), imagePlacements: [] };
  ensureSceneGraphForJob(job);

  const sceneSlides = Array.isArray(job.sceneGraph?.slides) ? job.sceneGraph.slides : [];
  if (!sceneSlides.length) {
    throw new Error("SceneGraph has no slides; refusing legacy deck-json renderer");
  }
  job.renderReport.renderMode = "sceneGraph";
  await writeEditableSceneGraphArtifacts(job);
  renderSceneGraphDeck(pptx, job, theme);

  const jobDir = path.join(outputDir, job.id);
  await fs.mkdir(jobDir, { recursive: true });
  const pptxPath = path.join(jobDir, job.mode === "style-preview" ? `${safeName(job.deck.title || "style-preview")}.pptx` : "editable-final.pptx");
  await pptx.writeFile({ fileName: pptxPath });
  const pptxEditability = await inspectEditablePptx(pptxPath).catch((error) => ({
    version: 1,
    source: "pptx-openxml-inspection",
    status: "warn",
    editable: false,
    warnings: ["pptx-editability-inspection-failed"],
    error: error.message || "PPTX editability inspection failed"
  }));
  job.quality = {
    ...(job.quality || {}),
    renderImageQa: summarizeRenderImageQa(job.renderReport),
    sceneGraphQa: job.sceneGraphQa || null,
    visualCompare: job.visualCompare || null,
    pptxEditability
  };
  return pptxPath;
}

function renderSceneGraphDeck(pptx, job, theme) {
  const slides = job.sceneGraph.slides || [];
  slides.forEach((sceneSlide, index) => {
    const slide = pptx.addSlide();
    slide._pptDesignImagePlacements = [];
    slide.background = { color: resolveSceneColor(sceneSlide.background?.color, theme) || theme.bg };
    if (sceneSlide.notes) slide.addNotes(sceneSlide.notes);
    renderSceneSlide(pptx, slide, sceneSlide, theme);
    job.renderReport.imagePlacements.push(...slide._pptDesignImagePlacements.map((placement) => ({
      ...placement,
      slideIndex: index + 1,
      layout: sceneSlide.layout || sceneSlide.role || null,
      title: cleanText(sceneSlide.texts?.find((item) => item.role === "title")?.text || "")
    })));
  });
}

function renderSceneSlide(pptx, slide, sceneSlide = {}, theme = {}) {
  const allShapes = [...(sceneSlide.decorations || []), ...(sceneSlide.shapes || [])];
  for (const shape of allShapes) renderSceneShape(pptx, slide, shape, theme);
  for (const image of sceneSlide.images || []) renderSceneImage(slide, image, theme);
  for (const text of sceneSlide.texts || []) renderSceneText(slide, text, theme);
}

function renderSceneShape(pptx, slide, shape = {}, theme = {}) {
  const box = normalizeSceneBox(shape.box);
  if (!box) return;
  if (shape.type === "textDecor") {
    slide.addText(shape.text || "", {
      ...box,
      fontSize: 42,
      bold: true,
      color: resolveSceneColor(shape.fillRole, theme),
      margin: 0
    });
    return;
  }
  const shapeType = shape.type === "roundRect" ? pptx.ShapeType.roundRect : shape.type === "ellipse" ? pptx.ShapeType.ellipse : pptx.ShapeType.rect;
  slide.addShape(shapeType, {
    ...box,
    rectRadius: shape.radius,
    fill: { color: resolveSceneColor(shape.fill || shape.fillRole, theme), transparency: Number(shape.transparency || 0) },
    line: { color: resolveSceneColor(shape.line || shape.lineRole || shape.fill || shape.fillRole, theme), transparency: Number(shape.lineTransparency || 0), width: Number(shape.lineWidth || 0.75) }
  });
}

function renderSceneText(slide, text = {}, theme = {}) {
  const box = normalizeSceneBox(text.box);
  const value = cleanText(text.text || "");
  if (!box || !value) return;
  const style = text.style || {};
  slide.addText(value, {
    ...box,
    fontFace: style.fontFace || "Microsoft YaHei",
    fontSize: Number(style.fontSize || 11),
    bold: Boolean(style.bold),
    color: resolveSceneColor(style.color || style.colorRole, theme),
    fit: style.fit || "shrink",
    valign: style.valign || "top",
    align: style.align || "left",
    margin: 0.02,
    breakLine: text.role === "bullet"
  });
}

function renderSceneImage(slide, image = {}, theme = {}) {
  const box = normalizeSceneBox(image.box);
  if (!box || !image.path) return;
  if (!fsSync.existsSync(image.path)) {
    slide.addText(image.name || "image missing", { ...box, fontSize: 9, color: theme.accent, align: "center", valign: "mid", margin: 0 });
    return;
  }
  if (image.fit === "cover") addImageCover(slide, image.path, box.x, box.y, box.w, box.h, theme);
  else addImageContain(slide, image.path, box.x, box.y, box.w, box.h, theme);
}

function normalizeSceneBox(box = {}) {
  const x = Number(box.x);
  const y = Number(box.y);
  const w = Number(box.w);
  const h = Number(box.h);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  return {
    x: Math.max(0, Math.min(SLIDE_W, x)),
    y: Math.max(0, Math.min(SLIDE_H, y)),
    w: Math.max(0.05, Math.min(SLIDE_W, w)),
    h: Math.max(0.05, Math.min(SLIDE_H, h))
  };
}

function resolveSceneColor(value, theme = {}) {
  const colorRoles = {
    bg: theme.bg || "F7F8FC",
    paper: theme.paper || theme.bg || "FFFFFF",
    soft: theme.soft || "E8EEF8",
    ink: theme.ink || "172033",
    muted: theme.muted || "647087",
    accent: theme.accent || "2D5BD7",
    accent2: theme.accent2 || theme.accent || "2D5BD7"
  };
  if (!value) return colorRoles.ink;
  if (colorRoles[value]) return colorRoles[value];
  return String(value).replace(/^#/, "").slice(0, 6) || colorRoles.ink;
}

function renderSlide(pptx, slide, item, index, total, theme, job) {
  addChrome(pptx, slide, index, total, theme, job);
  const layout = item.layout || (index === 0 ? "cover" : index === total - 1 ? "closing" : "cards");
  const templateRenderer = getTemplateRenderer(theme.templatePack?.slug, layout);
  if (templateRenderer) {
    templateRenderer(pptx, slide, item, theme, job, index);
    applyCanvasEdits(pptx, slide, item, theme);
    return;
  }
  const renderers = {
    cover: renderCover,
    visual: renderVisual,
    section: renderSection,
    toc: renderToc,
    kpi: renderKpi,
    pricing: renderPricing,
    "product-detail": renderProductDetail,
    bundle: renderBundle,
    "risk-checklist": renderRiskChecklist,
    compare: renderCompare,
    timeline: renderTimeline,
    cards: renderCards,
    quote: renderQuote,
    closing: renderClosing
  };
  (renderers[layout] || renderCards)(pptx, slide, item, theme, job, index);
  applyCanvasEdits(pptx, slide, item, theme);
}

function getTemplateRenderer(slug, layout) {
  const templateRenderers = {
    "sales-proposal": {
      cover: renderSalesCover,
      pricing: renderSalesPricing,
      cards: renderSalesCards,
      quote: renderSalesQuote,
      "risk-checklist": renderSalesRisk,
      closing: renderSalesClosing
    },
    "seasonal-gift": {
      cover: renderSeasonalCover,
      visual: renderSeasonalVisual,
      pricing: renderSeasonalPricing,
      "product-detail": renderSeasonalProductDetail,
      bundle: renderSeasonalBundle,
      closing: renderSeasonalClosing
    },
    "tech-solution": {
      cover: renderTechCover,
      toc: renderTechToc,
      kpi: renderTechKpi,
      compare: renderTechCompare,
      timeline: renderTechTimeline,
      closing: renderTechClosing
    },
    "brand-editorial": {
      cover: renderEditorialCover,
      visual: renderEditorialVisual,
      quote: renderEditorialQuote,
      cards: renderEditorialCards,
      "product-detail": renderEditorialProduct,
      closing: renderEditorialClosing
    },
    "launch-dark": {
      cover: renderLaunchCover,
      section: renderLaunchSection,
      kpi: renderLaunchKpi,
      visual: renderLaunchVisual,
      timeline: renderLaunchTimeline,
      quote: renderLaunchQuote,
      closing: renderLaunchClosing
    }
  };
  return templateRenderers[slug]?.[layout] || null;
}

function addChrome(pptx, slide, index, total, theme, job) {
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: SLIDE_W, h: 0.08, fill: { color: theme.accent }, line: { color: theme.accent } });
  slide.addText(String(index + 1).padStart(2, "0"), { x: 0.48, y: 0.35, w: 0.65, h: 0.25, fontSize: 9, bold: true, color: theme.accent, margin: 0 });
  slide.addText(`${theme.templatePack?.name || theme.name} · ${String(total).padStart(2, "0")} 页`, { x: 9.55, y: 6.95, w: 3.15, h: 0.2, fontSize: 7.5, color: theme.muted, align: "right", margin: 0 });
  slide.addText(job.input.projectName || job.deck.title || "PPT Design Tool", { x: 0.48, y: 6.95, w: 4.8, h: 0.2, fontSize: 7.5, color: theme.muted, margin: 0 });
}

function addTitle(slide, item, theme, options = {}) {
  slide.addText(item.title || "未命名页面", {
    x: options.x ?? 0.65,
    y: options.y ?? 0.78,
    w: options.w ?? 8.8,
    h: options.h ?? 0.72,
    fontSize: options.fontSize ?? 27,
    bold: true,
    color: theme.ink,
    fit: "shrink",
    margin: 0.02
  });
  if (item.subtitle) {
    slide.addText(item.subtitle, {
      x: options.x ?? 0.67,
      y: (options.y ?? 0.78) + (options.subOffset ?? 0.76),
      w: options.subW ?? 8.8,
      h: 0.38,
      fontSize: options.subFontSize ?? 12.3,
      color: theme.muted,
      fit: "shrink",
      margin: 0.02
    });
  }
}

function applyCanvasEdits(pptx, slide, item = {}, theme = {}) {
  const edits = item.canvasEdits && typeof item.canvasEdits === "object" ? item.canvasEdits : null;
  // Do not overlay canvas text on top of rendered template text by default.
  // The browser text layer is currently an editing aid; full coordinate export
  // requires replacing template text per layout, otherwise PPTX gets duplicates.
  if (!item.canvasEditsEnabled) return;
  if (!edits) return;
  for (const [key, edit] of Object.entries(edits)) {
    const field = resolveCanvasEditField(key, item);
    const box = edit?.box;
    const text = cleanText(field.text || "");
    if (!box || !text) continue;
    const x = percentToInch(box.x, SLIDE_W);
    const y = percentToInch(box.y, SLIDE_H);
    const w = percentToInch(box.w, SLIDE_W);
    const h = percentToInch(box.h, SLIDE_H);
    slide.addShape(pptx.ShapeType.rect, {
      x,
      y,
      w,
      h,
      fill: { color: theme.bg || "FFFFFF", transparency: 10 },
      line: { color: theme.accent || "2854D8", transparency: 75 }
    });
    slide.addText(text, {
      x: x + 0.06,
      y: y + 0.04,
      w: Math.max(0.2, w - 0.12),
      h: Math.max(0.2, h - 0.08),
      fontSize: field.fontSize,
      bold: field.bold,
      color: theme.ink || "1F261F",
      fit: "shrink",
      margin: 0.02,
      breakLine: field.breakLine
    });
  }
}

function resolveCanvasEditField(key, item = {}) {
  const bulletMatch = /^bullet_(\d+)$/.exec(key);
  if (bulletMatch) {
    const text = Array.isArray(item.bullets) ? item.bullets[Number(bulletMatch[1])] : "";
    return { key, text, fontSize: 10.5, bold: false, breakLine: false };
  }
  const dataMatch = /^data_(\d+)$/.exec(key);
  if (dataMatch) {
    const text = Array.isArray(item.dataPoints) ? item.dataPoints[Number(dataMatch[1])] : "";
    return { key, text, fontSize: 10.5, bold: false, breakLine: false };
  }
  if (key === "title") return { key, text: item.title, fontSize: 28, bold: true, breakLine: false };
  if (key === "subtitle") return { key, text: item.subtitle, fontSize: 13, bold: false, breakLine: false };
  if (key === "bullets") return { key, text: (item.bullets || []).join("\n"), fontSize: 10.5, bold: false, breakLine: true };
  if (key === "visualIntent") return { key, text: item.visualIntent, fontSize: 9.5, bold: false, breakLine: true };
  if (key === "speakerNotes") return { key, text: item.speakerNotes, fontSize: 8.5, bold: false, breakLine: true };
  return { key, text: item[key], fontSize: 10, bold: false, breakLine: true };
}

function percentToInch(value, size) {
  return Math.max(0, Math.min(size, (Number(value || 0) / 100) * size));
}

function seasonalPalette(theme) {
  return {
    red: theme.accent || "9E1F16",
    orange: theme.accent2 || "D86B2A",
    olive: theme.olive || "6E765D",
    paper: theme.paper || theme.bg || "FBF6EA",
    soft: theme.soft || "EFE1CF"
  };
}

function addSeasonalBackdrop(pptx, slide, theme, variant = "default") {
  const p = seasonalPalette(theme);
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: SLIDE_W, h: SLIDE_H, fill: { color: p.paper }, line: { color: p.paper } });
  slide.addShape(pptx.ShapeType.rect, { x: 0.22, y: 0.2, w: SLIDE_W - 0.44, h: SLIDE_H - 0.4, fill: { color: p.paper, transparency: 100 }, line: { color: p.red, transparency: 58, width: 0.8 } });
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: SLIDE_W, h: 0.12, fill: { color: p.red }, line: { color: p.red } });
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: SLIDE_H - 0.12, w: SLIDE_W, h: 0.12, fill: { color: p.olive, transparency: 12 }, line: { color: p.olive, transparency: 12 } });
  const dots = variant === "dense" ? 10 : 7;
  for (let i = 0; i < dots; i += 1) {
    slide.addShape(pptx.ShapeType.ellipse, {
      x: 11.6 + (i % 3) * 0.22,
      y: 0.72 + Math.floor(i / 3) * 0.24,
      w: 0.045,
      h: 0.045,
      fill: { color: i % 2 ? p.orange : p.red, transparency: 24 },
      line: { color: i % 2 ? p.orange : p.red, transparency: 24 }
    });
  }
  slide.addShape(pptx.ShapeType.arc, { x: 0.72, y: 5.8, w: 1.2, h: 0.36, line: { color: p.orange, transparency: 50, width: 1.2 }, adjustPoint: 0.25 });
  slide.addShape(pptx.ShapeType.rect, { x: 0.86, y: 1.05, w: 0.08, h: 0.58, fill: { color: p.red }, line: { color: p.red } });
}

function addSeasonalSeal(pptx, slide, theme, x, y, label = "礼") {
  const p = seasonalPalette(theme);
  slide.addShape(pptx.ShapeType.roundRect, { x, y, w: 0.42, h: 0.42, rectRadius: 0.02, fill: { color: p.red }, line: { color: p.red } });
  slide.addText(label, { x: x + 0.09, y: y + 0.08, w: 0.24, h: 0.14, fontSize: 8.5, bold: true, color: "FFFFFF", align: "center", margin: 0 });
}

function renderCover(pptx, slide, item, theme, job) {
  const coverImage = getSlideImage(job, item, 0);
  slide.addShape(pptx.ShapeType.rect, { x: 0.58, y: 0.72, w: 0.1, h: 4.95, fill: { color: theme.accent }, line: { color: theme.accent } });
  slide.addText(item.title || job.deck.title, { x: 0.95, y: 1.02, w: 8.25, h: 1.5, fontSize: 36, bold: true, color: theme.ink, fit: "shrink", margin: 0 });
  slide.addText(item.subtitle || job.deck.summary || "结构化生成 · 可编辑交付", { x: 1, y: 2.68, w: 7.95, h: 0.58, fontSize: 15, color: theme.muted, fit: "shrink", margin: 0 });
  slide.addShape(pptx.ShapeType.roundRect, { x: 9.25, y: 1.0, w: 2.9, h: 3.55, rectRadius: 0.06, fill: { color: theme.accent, transparency: 6 }, line: { color: theme.accent } });
  if (coverImage) {
    addImageContain(slide, coverImage.path, 9.45, 1.18, 2.5, 2.64, theme);
    slide.addText(job.input.audience || "目标受众", { x: 9.48, y: 4.02, w: 2.44, h: 0.22, fontSize: 8.5, bold: true, color: theme.bg, align: "center", margin: 0 });
  } else {
    const audience = job.input.audience || "目标受众";
    slide.addText(audience, { x: 9.55, y: 1.42, w: 2.25, h: 0.42, fontSize: 12, bold: true, color: theme.bg, align: "center", margin: 0 });
    slide.addText(item.visualIntent || "自动整理资料，重构页面叙事，并输出可编辑 PPTX。", { x: 9.52, y: 2.05, w: 2.3, h: 1.42, fontSize: 10.8, color: theme.bg, fit: "shrink", valign: "mid", align: "center", margin: 0.05 });
  }
  addBulletStrip(pptx, slide, item.bullets, theme, 1, 4.55, 7.6);
}

function renderSection(pptx, slide, item, theme) {
  slide.addShape(pptx.ShapeType.rect, { x: 0.75, y: 1.2, w: 11.8, h: 0.04, fill: { color: theme.accent }, line: { color: theme.accent } });
  slide.addText(item.title || "章节", { x: 0.75, y: 1.7, w: 10.4, h: 1.2, fontSize: 34, bold: true, color: theme.ink, fit: "shrink", margin: 0 });
  slide.addText(item.subtitle || item.visualIntent || "", { x: 0.8, y: 3.05, w: 8.6, h: 0.56, fontSize: 14, color: theme.muted, fit: "shrink", margin: 0 });
  addBulletStrip(pptx, slide, item.bullets, theme, 0.82, 4.15, 10.2);
}

function renderVisual(pptx, slide, item, theme, job, index = 0) {
  const image = getSlideImage(job, item, index) || getSlideImage(job, item, 0);
  addTitle(slide, item, theme, { x: 0.72, y: 0.72, w: 5.2, subW: 5.2, fontSize: 25 });
  slide.addShape(pptx.ShapeType.roundRect, { x: 6.35, y: 0.78, w: 5.78, h: 4.92, rectRadius: 0.06, fill: { color: theme.soft }, line: { color: theme.soft } });
  if (image) {
    addImageContain(slide, image.path, 6.62, 1.02, 5.24, 4.32, theme);
    slide.addText(image.originalName || "上传图片素材", { x: 6.65, y: 5.4, w: 5.18, h: 0.18, fontSize: 7.5, color: theme.muted, align: "center", fit: "shrink", margin: 0 });
  } else {
    slide.addText("图片槽位", { x: 6.62, y: 3, w: 5.24, h: 0.3, fontSize: 12, color: theme.accent, align: "center", margin: 0 });
  }
  (item.bullets || []).slice(0, 3).forEach((bullet, i) => {
    const y = 3 + i * 0.68;
    slide.addShape(pptx.ShapeType.roundRect, { x: 0.78, y, w: 4.92, h: 0.48, rectRadius: 0.04, fill: { color: theme.soft }, line: { color: theme.soft } });
    slide.addText(bullet, { x: 1, y: y + 0.13, w: 4.45, h: 0.18, fontSize: 10.5, color: theme.ink, fit: "shrink", margin: 0 });
  });
}

function renderToc(pptx, slide, item, theme) {
  addTitle(slide, item, theme, { x: 0.72, y: 0.72, w: 8.6, subW: 8.8 });
  (item.bullets || []).slice(0, 6).forEach((bullet, i) => {
    const y = 2.25 + i * 0.58;
    slide.addText(String(i + 1).padStart(2, "0"), { x: 0.9, y, w: 0.55, h: 0.24, fontSize: 10, bold: true, color: theme.accent, margin: 0 });
    slide.addShape(pptx.ShapeType.rect, { x: 1.62, y: y + 0.12, w: 8.2, h: 0.02, fill: { color: theme.soft }, line: { color: theme.soft } });
    slide.addText(bullet, { x: 2, y: y - 0.02, w: 7.8, h: 0.32, fontSize: 14, color: theme.ink, fit: "shrink", margin: 0 });
  });
}

function renderKpi(pptx, slide, item, theme) {
  addTitle(slide, item, theme);
  const bullets = item.bullets || [];
  const primary = splitMetric((item.dataPoints || [])[0] || bullets[0] || item.subtitle || item.title);
  slide.addText(primary.number, { x: 0.72, y: 2.22, w: 4.7, h: 1.25, fontSize: 48, bold: true, color: theme.accent, fit: "shrink", margin: 0 });
  slide.addText(primary.label, { x: 0.78, y: 3.55, w: 4.5, h: 0.52, fontSize: 14, bold: true, color: theme.ink, fit: "shrink", margin: 0 });
  bullets.slice(1, 4).forEach((bullet, i) => {
    const x = 5.8 + i * 2.25;
    slide.addShape(pptx.ShapeType.roundRect, { x, y: 2.35, w: 1.85, h: 2.15, rectRadius: 0.05, fill: { color: theme.soft }, line: { color: theme.soft } });
    slide.addText(String(i + 1).padStart(2, "0"), { x: x + 0.18, y: 2.55, w: 0.6, h: 0.28, fontSize: 10, bold: true, color: theme.accent, margin: 0 });
    slide.addText(bullet, { x: x + 0.18, y: 3.05, w: 1.45, h: 0.9, fontSize: 12, color: theme.ink, fit: "shrink", margin: 0.02 });
  });
}

function renderPricing(pptx, slide, item, theme, job, index = 0) {
  const image = getSlideImage(job, item, index);
  addTitle(slide, item, theme, { x: 0.68, y: 0.68, w: image ? 7.2 : 9.4, subW: image ? 6.8 : 8.6 });
  const entries = normalizePricingEntries(item).slice(0, 6);
  const max = entries.length;
  const cardW = image ? (max <= 3 ? 2.25 : 1.65) : max <= 3 ? 3.25 : max <= 4 ? 2.65 : 1.85;
  const gap = max <= 3 ? 0.42 : 0.28;
  const totalW = max * cardW + (max - 1) * gap;
  const startX = image ? 0.78 : (SLIDE_W - totalW) / 2;
  if (image) {
    slide.addShape(pptx.ShapeType.roundRect, { x: 8.2, y: 1.32, w: 3.55, h: 4.4, rectRadius: 0.05, fill: { color: theme.soft }, line: { color: theme.soft } });
    addImageCover(slide, image.path, 8.38, 1.5, 3.18, 4.04, theme);
  }
  entries.forEach((entry, i) => {
    const x = startX + i * (cardW + gap);
    const y = i % 2 ? 2.52 : 2.25;
    const accented = entry.accented || i === Math.min(1, max - 1);
    slide.addShape(pptx.ShapeType.roundRect, {
      x,
      y,
      w: cardW,
      h: 2.7,
      rectRadius: 0.06,
      fill: { color: accented ? theme.accent : theme.soft, transparency: accented ? 0 : 0 },
      line: { color: accented ? theme.accent : theme.soft }
    });
    slide.addText(entry.tier, { x: x + 0.22, y: y + 0.22, w: cardW - 0.44, h: 0.2, fontSize: 8.5, bold: true, color: accented ? theme.bg : theme.accent, margin: 0 });
    slide.addText(entry.price, { x: x + 0.2, y: y + 0.72, w: cardW - 0.4, h: 0.55, fontSize: max <= 3 ? 25 : 20, bold: true, color: accented ? theme.bg : theme.accent, align: "center", fit: "shrink", margin: 0 });
    slide.addText(entry.label, { x: x + 0.22, y: y + 1.42, w: cardW - 0.44, h: 0.45, fontSize: 10.2, bold: true, color: accented ? theme.bg : theme.ink, align: "center", fit: "shrink", margin: 0.02 });
    slide.addText(entry.note, { x: x + 0.25, y: y + 2.08, w: cardW - 0.5, h: 0.36, fontSize: 8.6, color: accented ? theme.bg : theme.muted, align: "center", fit: "shrink", margin: 0.02 });
  });
  slide.addText(item.visualIntent || "用价格带帮助销售快速判断主推组合和客户预算。", { x: 1.1, y: 5.85, w: 11.1, h: 0.3, fontSize: 10.5, color: theme.muted, align: "center", fit: "shrink", margin: 0 });
}

function renderProductDetail(pptx, slide, item, theme, job, index = 0) {
  addTitle(slide, item, theme, { x: 0.7, y: 0.68, w: 6.8, subW: 6.6 });
  const image = getSlideImage(job, item, index);
  slide.addShape(pptx.ShapeType.roundRect, { x: 7.65, y: 1.05, w: 4.55, h: 3.75, rectRadius: 0.06, fill: { color: theme.soft }, line: { color: theme.soft } });
  if (image) {
    addImageContain(slide, image.path, 7.9, 1.28, 4.05, 3.08, theme);
  } else {
    const facts = buildProductFacts(item);
    slide.addText("单品信息", { x: 7.95, y: 1.35, w: 3.9, h: 0.28, fontSize: 13, bold: true, color: theme.accent, align: "center", margin: 0 });
    facts.forEach((fact, i) => {
      const y = 1.92 + i * 0.72;
      slide.addShape(pptx.ShapeType.roundRect, { x: 8.0, y, w: 3.85, h: 0.48, rectRadius: 0.04, fill: { color: theme.bg, transparency: 0 }, line: { color: theme.bg } });
      slide.addText(fact.label, { x: 8.18, y: y + 0.09, w: 0.8, h: 0.18, fontSize: 7.5, bold: true, color: theme.muted, margin: 0 });
      slide.addText(fact.value, { x: 8.92, y: y + 0.08, w: 2.68, h: 0.2, fontSize: 10.5, bold: i === 0, color: theme.ink, fit: "shrink", margin: 0 });
    });
  }
  (item.bullets || []).slice(0, 5).forEach((bullet, i) => {
    const y = 2.28 + i * 0.62;
    slide.addShape(pptx.ShapeType.ellipse, { x: 0.78, y: y + 0.02, w: 0.16, h: 0.16, fill: { color: theme.accent }, line: { color: theme.accent } });
    slide.addText(bullet, { x: 1.08, y: y - 0.04, w: 5.95, h: 0.32, fontSize: 11.5, color: theme.ink, fit: "shrink", margin: 0 });
  });
  slide.addShape(pptx.ShapeType.rect, { x: 7.95, y: 5.0, w: 3.95, h: 0.02, fill: { color: theme.accent }, line: { color: theme.accent } });
  slide.addText(item.speakerNotes || "", { x: 7.95, y: 5.16, w: 3.95, h: 0.55, fontSize: 8.8, color: theme.muted, fit: "shrink", margin: 0.02, align: "center" });
}

function buildProductFacts(item = {}) {
  const text = [item.title, item.subtitle, ...(item.bullets || []), ...(item.dataPoints || [])].join(" ");
  const price = text.match(/[¥￥]?\d+(?:\.\d+)?\s*(?:元|块|RMB)?/i)?.[0] || "待确认";
  const spec = text.match(/\d{2,4}\s*[xX×*]\s*\d{2,4}(?:\s*[xX×*]\s*\d{2,4})?\s*(?:mm|cm|毫米|厘米)?/i)?.[0] || "待补齐";
  const scene = (item.bullets || []).find((bullet) => /场景|客户|员工|拜访|礼赠|福利/.test(bullet)) || item.subtitle || "按客户预算匹配";
  return [
    { label: "价格", value: price },
    { label: "规格", value: spec },
    { label: "场景", value: cleanText(scene).slice(0, 28) }
  ];
}

function renderBundle(pptx, slide, item, theme) {
  addTitle(slide, item, theme, { x: 0.7, y: 0.7, w: 8.2, subW: 8.2 });
  const bullets = (item.bullets || []).slice(0, 6);
  const labels = ["入门", "主推", "升级"];
  for (let i = 0; i < 3; i++) {
    const x = 0.78 + i * 4.1;
    const accent = i === 1;
    slide.addShape(pptx.ShapeType.roundRect, { x, y: 2.25, w: 3.45, h: 3.15, rectRadius: 0.05, fill: { color: accent ? theme.accent : theme.soft, transparency: accent ? 3 : 0 }, line: { color: accent ? theme.accent : theme.soft } });
    slide.addText(labels[i], { x: x + 0.2, y: 2.55, w: 0.8, h: 0.24, fontSize: 10, bold: true, color: accent ? theme.bg : theme.accent, margin: 0 });
    slide.addText(bullets[i] || `${labels[i]}组合：待补充`, { x: x + 0.25, y: 3.05, w: 2.9, h: 0.75, fontSize: 13, bold: true, color: accent ? theme.bg : theme.ink, fit: "shrink", margin: 0.02 });
    slide.addText(bullets[i + 3] || "匹配不同预算和客户重要性。", { x: x + 0.25, y: 4.2, w: 2.88, h: 0.52, fontSize: 9.5, color: accent ? theme.bg : theme.muted, fit: "shrink", margin: 0.02 });
  }
}

function renderRiskChecklist(pptx, slide, item, theme) {
  addTitle(slide, item, theme, { x: 0.7, y: 0.72, w: 8.8, subW: 8.8 });
  (item.bullets || []).slice(0, 6).forEach((bullet, i) => {
    const x = 0.86 + (i % 2) * 5.9;
    const y = 2.18 + Math.floor(i / 2) * 0.92;
    slide.addShape(pptx.ShapeType.roundRect, { x, y, w: 5.1, h: 0.58, rectRadius: 0.04, fill: { color: theme.soft }, line: { color: theme.soft } });
    slide.addText("✓", { x: x + 0.18, y: y + 0.13, w: 0.25, h: 0.2, fontSize: 10, bold: true, color: theme.accent, margin: 0 });
    slide.addText(bullet, { x: x + 0.55, y: y + 0.13, w: 4.3, h: 0.22, fontSize: 10.3, color: theme.ink, fit: "shrink", margin: 0 });
  });
}

function normalizePricingEntries(item = {}) {
  const points = (item.dataPoints || []).filter(Boolean);
  const bullets = (item.bullets || []).filter(Boolean);
  const source = points.length ? points : bullets;
  const labels = ["入门预算", "主推档位", "升级档位", "补充档位", "定制档位", "预留档位"];
  const entries = source.map((value, index) => {
    const text = cleanText(value);
    const price = text.match(/[¥￥]?\s*\d+(?:\.\d+)?\s*(?:元|块|RMB)?/i)?.[0]?.replace(/\s+/g, "") || `${index + 1}`;
    const label = cleanText(text.replace(price, "").replace(/[：:，,。；;\-]/g, " ")) || labels[index] || `第 ${index + 1} 档`;
    const note = index === 0 ? "用于基础福利和批量覆盖" : index === source.length - 1 ? "用于高端客户和形象礼赠" : "用于主流预算和重点推荐";
    return { tier: labels[index] || `第 ${index + 1} 档`, price, label, note, accented: /主推|推荐|升级|高端/.test(text) || index === 1 };
  });
  return entries.length ? entries : [{ tier: "价格梯度", price: "01", label: item.title || "待补充报价", note: "补齐报价后自动形成卡片", accented: true }];
}

function renderCompare(pptx, slide, item, theme) {
  addTitle(slide, item, theme);
  const bullets = item.bullets || [];
  const mid = Math.ceil(bullets.length / 2);
  addCompareColumn(pptx, slide, "基础选择", bullets.slice(0, mid), theme, 0.72, false);
  addCompareColumn(pptx, slide, "推荐选择", bullets.slice(mid), theme, 6.8, true);
}

function renderTimeline(pptx, slide, item, theme) {
  addTitle(slide, item, theme);
  const bullets = (item.bullets || []).slice(0, 5);
  slide.addShape(pptx.ShapeType.rect, { x: 1, y: 3.25, w: 10.9, h: 0.05, fill: { color: theme.accent }, line: { color: theme.accent } });
  bullets.forEach((bullet, i) => {
    const x = 0.9 + i * (10.2 / Math.max(bullets.length - 1, 1));
    slide.addShape(pptx.ShapeType.ellipse, { x, y: 3.05, w: 0.38, h: 0.38, fill: { color: theme.bg }, line: { color: theme.accent, width: 2 } });
    slide.addText(String(i + 1), { x: x + 0.03, y: 3.12, w: 0.32, h: 0.14, fontSize: 7, bold: true, color: theme.accent, align: "center", margin: 0 });
    slide.addText(bullet, { x: x - 0.38, y: 3.72, w: 1.42, h: 0.95, fontSize: 10.5, color: theme.ink, fit: "shrink", align: "center", margin: 0.02 });
  });
}

function renderCards(pptx, slide, item, theme, job, index = 0) {
  addTitle(slide, item, theme);
  const image = getSlideImage(job, item, index);
  const bullets = item.bullets || [];
  const maxItems = image ? 4 : 5;
  bullets.slice(0, maxItems).forEach((bullet, i) => {
    const secondRow = i > 2;
    const x = image ? 0.75 + (i % 2) * 3.15 : secondRow ? 0.75 + (i - 3) * 6.05 : 0.75 + i * 4.05;
    const y = secondRow ? 4.27 : 2.55;
    const w = image ? 2.75 : secondRow ? 5.45 : 3.55;
    slide.addShape(pptx.ShapeType.roundRect, { x, y, w, h: 1.22, rectRadius: 0.05, fill: { color: theme.soft }, line: { color: theme.soft } });
    slide.addText(String(i + 1).padStart(2, "0"), { x: x + 0.22, y: y + 0.18, w: 0.48, h: 0.18, fontSize: 8, bold: true, color: theme.accent, margin: 0 });
    slide.addText(bullet, { x: x + 0.22, y: y + 0.5, w: w - 0.44, h: 0.42, fontSize: 12, color: theme.ink, fit: "shrink", margin: 0.02 });
  });
  if (image) {
    slide.addShape(pptx.ShapeType.roundRect, { x: 7.35, y: 2.45, w: 4.7, h: 2.95, rectRadius: 0.06, fill: { color: theme.soft }, line: { color: theme.soft } });
    addImageContain(slide, image.path, 7.55, 2.62, 4.3, 2.55, theme);
    slide.addText(image.originalName || "上传图片素材", { x: 7.55, y: 5.22, w: 4.3, h: 0.2, fontSize: 8, color: theme.muted, align: "center", fit: "shrink", margin: 0 });
  }
}

function renderQuote(pptx, slide, item, theme) {
  slide.addText("\"", { x: 0.75, y: 0.85, w: 1, h: 0.8, fontSize: 50, color: theme.accent, margin: 0 });
  slide.addText(item.title || "核心观点", { x: 1.15, y: 1.58, w: 10.6, h: 1.65, fontSize: 31, bold: true, color: theme.ink, fit: "shrink", margin: 0 });
  slide.addText(item.subtitle || item.visualIntent || "", { x: 1.2, y: 3.55, w: 8.8, h: 0.45, fontSize: 13, color: theme.muted, fit: "shrink", margin: 0 });
  addBulletStrip(pptx, slide, item.bullets, theme, 1.2, 4.45, 9.4);
}

function renderClosing(pptx, slide, item, theme, job, index = 0) {
  const image = getSlideImage(job, item, index);
  slide.addShape(pptx.ShapeType.roundRect, { x: 0.7, y: 0.9, w: 11.9, h: 4.75, rectRadius: 0.06, fill: { color: theme.soft }, line: { color: theme.soft } });
  slide.addText(item.title || "下一步行动", { x: 1.05, y: 1.35, w: image ? 6.1 : 8.6, h: 0.8, fontSize: 30, bold: true, color: theme.ink, fit: "shrink", margin: 0 });
  slide.addText(item.subtitle || item.visualIntent || "确认版本、补齐素材、进入交付。", { x: 1.08, y: 2.22, w: image ? 5.8 : 8.2, h: 0.38, fontSize: 13, color: theme.muted, fit: "shrink", margin: 0 });
  addBulletStrip(pptx, slide, item.bullets, theme, 1.1, 3.05, image ? 5.4 : 8.8);
  if (image) addImageCover(slide, image.path, 7.35, 1.34, 4.45, 3.35, theme);
  else slide.addShape(pptx.ShapeType.rect, { x: 10.35, y: 1.35, w: 1.3, h: 3.25, fill: { color: theme.accent }, line: { color: theme.accent } });
}

function renderSeasonalCover(pptx, slide, item, theme, job) {
  const image = getSlideImage(job, item, 0);
  const p = seasonalPalette(theme);
  if (image) {
    addImageCover(slide, image.path, 0, 0, SLIDE_W, SLIDE_H, theme);
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: SLIDE_W, h: SLIDE_H, fill: { color: "000000", transparency: 84 }, line: { color: "000000", transparency: 100 } });
    slide.addShape(pptx.ShapeType.rect, { x: 6.35, y: 0, w: 6.98, h: SLIDE_H, fill: { color: p.paper, transparency: 7 }, line: { color: p.paper, transparency: 100 } });
  } else {
    addSeasonalBackdrop(pptx, slide, theme, "dense");
    slide.addShape(pptx.ShapeType.rect, { x: 0.62, y: 0.62, w: 5.48, h: 6.18, fill: { color: p.soft }, line: { color: p.red, transparency: 46, width: 0.8 } });
    slide.addText("产品主视觉", { x: 1.5, y: 3.4, w: 3.7, h: 0.28, fontSize: 12, bold: true, color: theme.accent, align: "center", margin: 0 });
  }
  slide.addShape(pptx.ShapeType.rect, { x: 7.05, y: 0.62, w: 5.62, h: 6.18, fill: { color: p.paper, transparency: 100 }, line: { color: p.orange, transparency: 60, width: 0.7 } });
  addSeasonalSeal(pptx, slide, theme, 7.38, 1.0, "礼");
  slide.addText("节日礼赠方案", { x: 7.9, y: 1.08, w: 2.1, h: 0.24, fontSize: 10, bold: true, color: p.red, margin: 0 });
  slide.addText(item.title || job.deck.title, { x: 7.35, y: 1.62, w: 4.82, h: 1.48, fontSize: 32, bold: true, color: theme.ink, fit: "shrink", margin: 0 });
  slide.addText(item.subtitle || job.deck.summary || "围绕场景、预算和体面感生成可编辑 PPT", { x: 7.38, y: 3.36, w: 4.7, h: 0.56, fontSize: 13, color: theme.muted, fit: "shrink", margin: 0 });
  addBulletStrip(pptx, slide, item.bullets, theme, 7.38, 4.62, 4.75);
}

function renderSeasonalVisual(pptx, slide, item, theme, job, index = 0) {
  const image = getSlideImage(job, item, index) || getSlideImage(job, item, 0);
  const p = seasonalPalette(theme);
  addSeasonalBackdrop(pptx, slide, theme);
  slide.addShape(pptx.ShapeType.rect, { x: 0.72, y: 0.75, w: 5.35, h: 5.68, fill: { color: p.soft }, line: { color: p.red, transparency: 54 } });
  if (image) addImageCover(slide, image.path, 0.9, 0.9, 5.0, 5.36, theme);
  else slide.addText("礼盒 / 产品图", { x: 1.38, y: 3.12, w: 3.9, h: 0.28, fontSize: 14, bold: true, color: theme.accent, align: "center", margin: 0 });
  addSeasonalSeal(pptx, slide, theme, 6.68, 0.9, "品");
  slide.addText(item.title || "产品主视觉", { x: 6.65, y: 1, w: 5.3, h: 0.88, fontSize: 28, bold: true, color: theme.ink, fit: "shrink", margin: 0 });
  slide.addText(item.subtitle || item.visualIntent || "先用完整包装和质感建立礼赠判断。", { x: 6.68, y: 1.95, w: 4.9, h: 0.5, fontSize: 12.5, color: theme.muted, fit: "shrink", margin: 0 });
  (item.bullets || []).slice(0, 4).forEach((bullet, i) => {
    const y = 2.92 + i * 0.68;
    slide.addShape(pptx.ShapeType.rect, { x: 6.72, y: y + 0.1, w: 0.28, h: 0.04, fill: { color: theme.accent }, line: { color: theme.accent } });
    slide.addText(bullet, { x: 7.18, y, w: 4.55, h: 0.34, fontSize: 11.5, color: theme.ink, fit: "shrink", margin: 0 });
  });
}

function renderSeasonalPricing(pptx, slide, item, theme, job, index = 0) {
  const image = getSlideImage(job, item, index);
  const p = seasonalPalette(theme);
  addSeasonalBackdrop(pptx, slide, theme);
  addTitle(slide, item, theme, { x: 0.75, y: 0.72, w: image ? 6.7 : 8.6, fontSize: 25, subW: image ? 6.4 : 8.4 });
  const entries = normalizePricingEntries(item).slice(0, 3);
  const labels = ["入门礼", "主推礼", "升级礼"];
  entries.forEach((entry, i) => {
    const x = image ? 0.88 + i * 2.18 : 0.88 + i * 4.12;
    const cardW = image ? 1.86 : 3.35;
    const accented = i === 1 || entry.accented;
    slide.addShape(pptx.ShapeType.roundRect, { x, y: accented ? 2.05 : 2.35, w: cardW, h: accented ? 3.25 : 2.95, rectRadius: 0.05, fill: { color: accented ? p.red : p.soft }, line: { color: accented ? p.red : p.orange, transparency: accented ? 0 : 45 } });
    slide.addText(labels[i] || entry.tier, { x: x + 0.18, y: accented ? 2.38 : 2.68, w: cardW - 0.36, h: 0.25, fontSize: image ? 8.5 : 10.5, bold: true, color: accented ? theme.bg : theme.accent, margin: 0, fit: "shrink" });
    slide.addText(entry.price, { x: x + 0.22, y: accented ? 3.02 : 3.18, w: cardW - 0.44, h: 0.62, fontSize: image ? 22 : 27, bold: true, color: accented ? theme.bg : theme.ink, align: "center", fit: "shrink", margin: 0 });
    slide.addText(entry.label, { x: x + 0.2, y: accented ? 3.88 : 3.95, w: cardW - 0.4, h: 0.55, fontSize: image ? 9.2 : 11, bold: true, color: accented ? theme.bg : theme.ink, align: "center", fit: "shrink", margin: 0.02 });
    slide.addText(entry.note, { x: x + 0.2, y: accented ? 4.68 : 4.58, w: cardW - 0.4, h: 0.38, fontSize: image ? 7.4 : 8.8, color: accented ? theme.bg : theme.muted, align: "center", fit: "shrink", margin: 0.02 });
  });
  if (image) {
    const ratio = safeImageRatio(image.path);
    if (ratio && ratio < 0.8) {
      slide.addShape(pptx.ShapeType.roundRect, { x: 9.15, y: 1.08, w: 2.42, h: 4.75, rectRadius: 0.05, fill: { color: p.soft }, line: { color: p.red, transparency: 50 } });
      addImageCover(slide, image.path, 9.3, 1.28, 2.12, 3.95, theme);
      addSeasonalSeal(pptx, slide, theme, 11.0, 1.28, "选");
      slide.addText(displayCaption(item.visualIntent, "竖版素材保留完整主体，避免横框挤压。"), { x: 7.55, y: 5.48, w: 4.15, h: 0.34, fontSize: 9.2, color: theme.muted, fit: "shrink", margin: 0.02 });
    } else {
      slide.addShape(pptx.ShapeType.roundRect, { x: 7.38, y: 1.28, w: 4.65, h: 3.04, rectRadius: 0.05, fill: { color: p.soft }, line: { color: p.red, transparency: 50 } });
      addImageCover(slide, image.path, 7.55, 1.46, 4.28, 2.4, theme);
      addSeasonalSeal(pptx, slide, theme, 11.22, 1.48, "选");
      slide.addText(displayCaption(item.visualIntent, "保留原图主体，作为价格档位旁的场景证据。"), { x: 7.55, y: 4.55, w: 4.15, h: 0.42, fontSize: 9.5, color: theme.muted, fit: "shrink", margin: 0.02 });
    }
  }
  slide.addText("建议用三档价格绑定送礼对象：员工福利、客户拜访、重要礼赠。", { x: 1.1, y: 6, w: image ? 6.6 : 10.9, h: 0.28, fontSize: 10.5, color: theme.muted, align: image ? "left" : "center", fit: "shrink", margin: 0 });
}

function renderSeasonalProductDetail(pptx, slide, item, theme, job, index = 0) {
  const image = getSlideImage(job, item, index);
  const p = seasonalPalette(theme);
  addSeasonalBackdrop(pptx, slide, theme);
  addTitle(slide, item, theme, { x: 0.72, y: 0.72, w: 6.2, fontSize: 25, subW: 6.2 });
  slide.addShape(pptx.ShapeType.roundRect, { x: 7.45, y: 0.98, w: 4.2, h: 4.55, rectRadius: 0.05, fill: { color: p.soft }, line: { color: p.red, transparency: 48 } });
  if (image) addImageCover(slide, image.path, 7.62, 1.12, 3.96, 4.1, theme);
  else slide.addText("包装质感 / 细节图", { x: 7.95, y: 3, w: 3.22, h: 0.28, fontSize: 12, bold: true, color: theme.accent, align: "center", margin: 0 });
  const facts = buildProductFacts(item);
  facts.forEach((fact, i) => {
    const y = 2.25 + i * 0.68;
    slide.addText(fact.label, { x: 0.85, y, w: 0.78, h: 0.22, fontSize: 8.5, bold: true, color: theme.accent, margin: 0 });
    slide.addText(fact.value, { x: 1.72, y: y - 0.03, w: 4.75, h: 0.28, fontSize: 12.5, color: theme.ink, fit: "shrink", margin: 0 });
  });
  addBulletStrip(pptx, slide, item.bullets, theme, 0.88, 4.55, 5.7);
}

function renderSeasonalBundle(pptx, slide, item, theme) {
  const p = seasonalPalette(theme);
  addSeasonalBackdrop(pptx, slide, theme);
  addTitle(slide, item, theme, { x: 0.75, y: 0.72, w: 8.4, fontSize: 25, subW: 8.3 });
  const bullets = (item.bullets || []).slice(0, 6);
  const labels = ["员工福利", "客户拜访", "重要礼赠"];
  labels.forEach((label, i) => {
    const x = 0.85 + i * 4.05;
    slide.addShape(pptx.ShapeType.rect, { x, y: 2.15, w: 3.28, h: 3.08, fill: { color: i === 1 ? p.red : p.soft, transparency: i === 1 ? 0 : 0 }, line: { color: i === 1 ? p.red : p.orange, transparency: i === 1 ? 0 : 55 } });
    slide.addText(label, { x: x + 0.25, y: 2.45, w: 2.55, h: 0.28, fontSize: 11, bold: true, color: i === 1 ? theme.bg : theme.accent, margin: 0 });
    slide.addText(bullets[i] || "待补齐主推组合", { x: x + 0.25, y: 3.05, w: 2.72, h: 0.72, fontSize: 13, bold: true, color: i === 1 ? theme.bg : theme.ink, fit: "shrink", margin: 0.02 });
    slide.addText(bullets[i + 3] || "补齐预算、数量和交期后生成正式版本。", { x: x + 0.25, y: 4.22, w: 2.72, h: 0.46, fontSize: 9.3, color: i === 1 ? theme.bg : theme.muted, fit: "shrink", margin: 0.02 });
  });
}

function renderSeasonalClosing(pptx, slide, item, theme, job, index = 0) {
  const image = getSlideImage(job, item, index);
  const p = seasonalPalette(theme);
  addSeasonalBackdrop(pptx, slide, theme);
  slide.addShape(pptx.ShapeType.rect, { x: 0.68, y: 0.85, w: 12, h: 5.85, fill: { color: p.soft, transparency: 8 }, line: { color: p.red, transparency: 55 } });
  slide.addText(item.title || "确认主推组合", { x: 1.05, y: 1.28, w: 8.2, h: 0.75, fontSize: 28, bold: true, color: theme.ink, fit: "shrink", margin: 0 });
  slide.addText(item.subtitle || item.visualIntent || "补齐报价、交期和图片素材后输出客户版。", { x: 1.08, y: 2.1, w: 7.4, h: 0.4, fontSize: 12.5, color: theme.muted, fit: "shrink", margin: 0 });
  addBulletStrip(pptx, slide, item.bullets, theme, 1.1, 3, 7.8);
  if (image) addImageCover(slide, image.path, 9.05, 1.18, 2.45, 4.12, theme);
  else slide.addShape(pptx.ShapeType.rect, { x: 10.12, y: 1.18, w: 1.2, h: 4.12, fill: { color: theme.accent }, line: { color: theme.accent } });
}

function renderTechCover(pptx, slide, item, theme, job) {
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: SLIDE_W, h: SLIDE_H, fill: { color: theme.bg }, line: { color: theme.bg } });
  slide.addShape(pptx.ShapeType.rect, { x: 0.72, y: 0.92, w: 11.9, h: 0.04, fill: { color: theme.accent }, line: { color: theme.accent } });
  slide.addShape(pptx.ShapeType.rect, { x: 9.42, y: 1.18, w: 2.18, h: 4.55, fill: { color: theme.accent, transparency: 5 }, line: { color: theme.accent } });
  slide.addText("TECH SOLUTION", { x: 0.78, y: 1.25, w: 2.5, h: 0.22, fontSize: 8.5, bold: true, color: theme.accent, margin: 0 });
  slide.addText(item.title || job.deck.title, { x: 0.78, y: 1.75, w: 7.85, h: 1.42, fontSize: 34, bold: true, color: theme.ink, fit: "shrink", margin: 0 });
  slide.addText(item.subtitle || job.deck.summary || "指标、对比、路径和风险边界", { x: 0.82, y: 3.34, w: 7.1, h: 0.46, fontSize: 13.5, color: theme.muted, fit: "shrink", margin: 0 });
  addBulletStrip(pptx, slide, item.bullets, theme, 0.84, 4.45, 7.4);
  slide.addText(job.input.audience || "目标对象", { x: 9.67, y: 2.08, w: 1.68, h: 0.5, fontSize: 13, bold: true, color: theme.bg, align: "center", fit: "shrink", margin: 0 });
  slide.addText("01 / ANALYSIS", { x: 9.65, y: 4.55, w: 1.72, h: 0.18, fontSize: 7.2, color: theme.bg, align: "center", margin: 0 });
}

function renderTechToc(pptx, slide, item, theme) {
  addTitle(slide, item, theme, { x: 0.7, y: 0.68, w: 8.6, fontSize: 25, subW: 8.6 });
  (item.bullets || []).slice(0, 7).forEach((bullet, i) => {
    const y = 1.95 + i * 0.62;
    slide.addText(String(i + 1).padStart(2, "0"), { x: 0.9, y, w: 0.45, h: 0.2, fontSize: 8.5, bold: true, color: theme.accent, margin: 0 });
    slide.addShape(pptx.ShapeType.rect, { x: 1.58, y: y + 0.1, w: 9.6, h: 0.02, fill: { color: theme.soft }, line: { color: theme.soft } });
    slide.addText(bullet, { x: 1.86, y: y - 0.04, w: 8.8, h: 0.3, fontSize: 12.8, color: theme.ink, fit: "shrink", margin: 0 });
  });
}

function renderTechKpi(pptx, slide, item, theme) {
  addTitle(slide, item, theme, { x: 0.68, y: 0.68, w: 8.8, fontSize: 25, subW: 8.6 });
  const source = [...(item.dataPoints || []), ...(item.bullets || [])].filter(Boolean);
  const metrics = source.length ? source.slice(0, 4) : [item.title || "关键指标", "待补齐数据", "待确认口径", "待验证结果"];
  metrics.forEach((metric, i) => {
    const parsed = splitMetric(metric);
    const x = 0.78 + i * 3.05;
    slide.addShape(pptx.ShapeType.roundRect, { x, y: 2.15, w: 2.55, h: 2.35, rectRadius: 0.04, fill: { color: i === 0 ? theme.accent : theme.soft }, line: { color: i === 0 ? theme.accent : theme.soft } });
    slide.addText(parsed.number, { x: x + 0.22, y: 2.52, w: 2.08, h: 0.58, fontSize: 24, bold: true, color: i === 0 ? theme.bg : theme.accent, align: "center", fit: "shrink", margin: 0 });
    slide.addText(parsed.label, { x: x + 0.25, y: 3.42, w: 2.02, h: 0.42, fontSize: 10.4, color: i === 0 ? theme.bg : theme.ink, align: "center", fit: "shrink", margin: 0.02 });
  });
  slide.addShape(pptx.ShapeType.rect, { x: 0.8, y: 5.38, w: 11.58, h: 0.04, fill: { color: theme.accent }, line: { color: theme.accent } });
  slide.addText(item.visualIntent || "所有指标需保留口径和数据来源，资料不足时标注待验证。", { x: 0.82, y: 5.65, w: 10.8, h: 0.28, fontSize: 10.2, color: theme.muted, fit: "shrink", margin: 0 });
}

function renderTechCompare(pptx, slide, item, theme) {
  addTitle(slide, item, theme, { x: 0.68, y: 0.68, w: 8.8, fontSize: 25, subW: 8.6 });
  const bullets = item.bullets || [];
  const left = bullets.slice(0, Math.ceil(bullets.length / 2));
  const right = bullets.slice(Math.ceil(bullets.length / 2));
  addCompareColumn(pptx, slide, "当前状态 / 方案 A", left, theme, 0.75, false);
  addCompareColumn(pptx, slide, "推荐路径 / 方案 B", right.length ? right : left, theme, 6.72, true);
}

function renderTechTimeline(pptx, slide, item, theme) {
  addTitle(slide, item, theme, { x: 0.68, y: 0.68, w: 8.8, fontSize: 25, subW: 8.6 });
  (item.bullets || []).slice(0, 5).forEach((bullet, i) => {
    const x = 0.9 + i * 2.35;
    slide.addShape(pptx.ShapeType.rect, { x: x + 0.08, y: 2.35, w: 0.04, h: 2.8, fill: { color: theme.accent }, line: { color: theme.accent } });
    slide.addText(String(i + 1).padStart(2, "0"), { x: x - 0.05, y: 2.04, w: 0.35, h: 0.18, fontSize: 8.5, bold: true, color: theme.accent, align: "center", margin: 0 });
    slide.addShape(pptx.ShapeType.roundRect, { x: x - 0.22, y: 2.72, w: 1.55, h: 1.18, rectRadius: 0.03, fill: { color: theme.soft }, line: { color: theme.soft } });
    slide.addText(bullet, { x: x - 0.05, y: 3.02, w: 1.2, h: 0.45, fontSize: 9.6, color: theme.ink, align: "center", fit: "shrink", margin: 0.02 });
  });
}

function renderTechClosing(pptx, slide, item, theme) {
  slide.addShape(pptx.ShapeType.rect, { x: 0.72, y: 0.88, w: 11.85, h: 0.04, fill: { color: theme.accent }, line: { color: theme.accent } });
  slide.addText(item.title || "下一步验证", { x: 0.78, y: 1.45, w: 7.7, h: 0.82, fontSize: 30, bold: true, color: theme.ink, fit: "shrink", margin: 0 });
  slide.addText(item.subtitle || item.visualIntent || "确认指标口径、输入数据和执行边界。", { x: 0.82, y: 2.32, w: 7.3, h: 0.4, fontSize: 12.5, color: theme.muted, fit: "shrink", margin: 0 });
  (item.bullets || []).slice(0, 4).forEach((bullet, i) => {
    const y = 3.12 + i * 0.58;
    slide.addText(String(i + 1).padStart(2, "0"), { x: 0.9, y, w: 0.42, h: 0.18, fontSize: 8, bold: true, color: theme.accent, margin: 0 });
    slide.addText(bullet, { x: 1.48, y: y - 0.05, w: 6.8, h: 0.3, fontSize: 11.3, color: theme.ink, fit: "shrink", margin: 0 });
  });
  slide.addShape(pptx.ShapeType.rect, { x: 9.7, y: 1.35, w: 1.55, h: 3.75, fill: { color: theme.accent }, line: { color: theme.accent } });
  slide.addText("VERIFY", { x: 9.86, y: 3, w: 1.2, h: 0.25, fontSize: 10, bold: true, color: theme.bg, align: "center", margin: 0 });
}

function renderSalesCover(pptx, slide, item, theme, job) {
  slide.addShape(pptx.ShapeType.rect, { x: 0.65, y: 0.86, w: 0.12, h: 4.9, fill: { color: theme.accent }, line: { color: theme.accent } });
  slide.addText("SALES PLAYBOOK", { x: 1.05, y: 0.98, w: 2.3, h: 0.24, fontSize: 9, bold: true, color: theme.accent, margin: 0 });
  slide.addText(item.title || job.deck.title, { x: 1.02, y: 1.45, w: 7.55, h: 1.55, fontSize: 35, bold: true, color: theme.ink, fit: "shrink", margin: 0 });
  slide.addText(item.subtitle || job.deck.summary || "预算入口、主推理由、成交动作", { x: 1.06, y: 3.12, w: 7.2, h: 0.42, fontSize: 13.5, color: theme.muted, fit: "shrink", margin: 0 });
  slide.addShape(pptx.ShapeType.roundRect, { x: 9.25, y: 1.08, w: 2.75, h: 3.9, rectRadius: 0.05, fill: { color: theme.accent }, line: { color: theme.accent } });
  slide.addText(job.input.audience || "客户 / 销售团队", { x: 9.55, y: 1.62, w: 2.15, h: 0.46, fontSize: 13, bold: true, color: theme.bg, align: "center", fit: "shrink", margin: 0 });
  slide.addText("主推\n预算\n行动", { x: 9.8, y: 2.48, w: 1.62, h: 1.28, fontSize: 18, bold: true, color: theme.bg, align: "center", fit: "shrink", margin: 0 });
  addBulletStrip(pptx, slide, item.bullets, theme, 1.08, 4.42, 7.4);
}

function renderSalesPricing(pptx, slide, item, theme) {
  addTitle(slide, item, theme, { x: 0.75, y: 0.72, w: 8.6, fontSize: 25 });
  normalizePricingEntries(item).slice(0, 4).forEach((entry, i) => {
    const y = 2.08 + i * 0.86;
    const accented = entry.accented || i === 1;
    slide.addShape(pptx.ShapeType.roundRect, { x: 0.85, y, w: 11.15, h: 0.62, rectRadius: 0.04, fill: { color: accented ? theme.accent : theme.soft }, line: { color: accented ? theme.accent : theme.soft } });
    slide.addText(entry.tier, { x: 1.12, y: y + 0.16, w: 1.5, h: 0.18, fontSize: 8.5, bold: true, color: accented ? theme.bg : theme.accent, margin: 0 });
    slide.addText(entry.price, { x: 2.72, y: y + 0.08, w: 1.9, h: 0.32, fontSize: 16, bold: true, color: accented ? theme.bg : theme.ink, fit: "shrink", margin: 0 });
    slide.addText(entry.label, { x: 4.95, y: y + 0.13, w: 3.25, h: 0.22, fontSize: 10.5, bold: true, color: accented ? theme.bg : theme.ink, fit: "shrink", margin: 0 });
    slide.addText(entry.note, { x: 8.35, y: y + 0.14, w: 3.2, h: 0.22, fontSize: 8.8, color: accented ? theme.bg : theme.muted, fit: "shrink", margin: 0 });
  });
}

function renderSalesCards(pptx, slide, item, theme) {
  addTitle(slide, item, theme, { x: 0.72, y: 0.7, w: 8.8, fontSize: 25 });
  (item.bullets || []).slice(0, 6).forEach((bullet, i) => {
    const x = 0.78 + (i % 3) * 4.05;
    const y = 2.08 + Math.floor(i / 3) * 1.62;
    slide.addShape(pptx.ShapeType.roundRect, { x, y, w: 3.35, h: 1.18, rectRadius: 0.04, fill: { color: i === 0 ? theme.accent : theme.soft }, line: { color: i === 0 ? theme.accent : theme.soft } });
    slide.addText(String(i + 1).padStart(2, "0"), { x: x + 0.22, y: y + 0.18, w: 0.42, h: 0.18, fontSize: 8, bold: true, color: i === 0 ? theme.bg : theme.accent, margin: 0 });
    slide.addText(bullet, { x: x + 0.22, y: y + 0.48, w: 2.88, h: 0.38, fontSize: 11.2, bold: i === 0, color: i === 0 ? theme.bg : theme.ink, fit: "shrink", margin: 0.02 });
  });
}

function renderSalesQuote(pptx, slide, item, theme) {
  slide.addShape(pptx.ShapeType.roundRect, { x: 0.92, y: 1.1, w: 11.45, h: 4.85, rectRadius: 0.04, fill: { color: theme.accent }, line: { color: theme.accent } });
  slide.addText("成交话术", { x: 1.22, y: 1.42, w: 1.6, h: 0.24, fontSize: 10, bold: true, color: theme.bg, margin: 0 });
  slide.addText(item.title || "核心表达", { x: 1.18, y: 2.05, w: 9.9, h: 1.2, fontSize: 28, bold: true, color: theme.bg, fit: "shrink", margin: 0 });
  slide.addText((item.bullets || [item.subtitle || item.visualIntent || "把主推理由讲成一句客户能听懂的话。"])[0], { x: 1.22, y: 3.68, w: 9.3, h: 0.48, fontSize: 13, color: theme.bg, fit: "shrink", margin: 0 });
}

function renderSalesRisk(pptx, slide, item, theme) {
  addTitle(slide, item, theme, { x: 0.75, y: 0.72, w: 8.6, fontSize: 25 });
  (item.bullets || []).slice(0, 6).forEach((bullet, i) => {
    const y = 2.05 + i * 0.58;
    slide.addText("待确认", { x: 0.92, y, w: 0.85, h: 0.2, fontSize: 7.5, bold: true, color: theme.accent, margin: 0 });
    slide.addShape(pptx.ShapeType.rect, { x: 1.9, y: y + 0.1, w: 8.9, h: 0.02, fill: { color: theme.soft }, line: { color: theme.soft } });
    slide.addText(bullet, { x: 2.18, y: y - 0.05, w: 8.3, h: 0.28, fontSize: 11, color: theme.ink, fit: "shrink", margin: 0 });
  });
}

function renderSalesClosing(pptx, slide, item, theme) {
  slide.addText(item.title || "下一步成交动作", { x: 0.8, y: 1.16, w: 8.4, h: 0.9, fontSize: 31, bold: true, color: theme.ink, fit: "shrink", margin: 0 });
  slide.addShape(pptx.ShapeType.rect, { x: 9.55, y: 1.05, w: 1.6, h: 4.65, fill: { color: theme.accent }, line: { color: theme.accent } });
  addBulletStrip(pptx, slide, item.bullets, theme, 0.86, 2.78, 7.8);
}

function renderEditorialCover(pptx, slide, item, theme, job) {
  const image = getSlideImage(job, item, 0);
  slide.addText(item.title || job.deck.title, { x: 0.92, y: 1.08, w: 6.4, h: 1.55, fontSize: 34, bold: true, color: theme.ink, fit: "shrink", margin: 0 });
  slide.addText(item.subtitle || job.deck.summary || "品牌画册 / 高端产品初稿", { x: 0.95, y: 3.0, w: 5.9, h: 0.38, fontSize: 12.5, color: theme.muted, fit: "shrink", margin: 0 });
  slide.addShape(pptx.ShapeType.rect, { x: 7.58, y: 0.95, w: 4.25, h: 5.2, fill: { color: theme.soft }, line: { color: theme.soft } });
  if (image) addImageContain(slide, image.path, 7.82, 1.2, 3.78, 4.55, theme);
  else slide.addText("IMAGE", { x: 8.48, y: 3.35, w: 2.6, h: 0.28, fontSize: 12, bold: true, color: theme.muted, align: "center", margin: 0 });
}

function renderEditorialVisual(pptx, slide, item, theme, job, index = 0) {
  const image = getSlideImage(job, item, index);
  if (image) addImageContain(slide, image.path, 0.78, 0.9, 6.35, 5.62, theme);
  else slide.addShape(pptx.ShapeType.rect, { x: 0.78, y: 0.9, w: 6.35, h: 5.62, fill: { color: theme.soft }, line: { color: theme.soft } });
  slide.addText(item.title || "视觉页", { x: 7.65, y: 1.2, w: 4.15, h: 0.86, fontSize: 25, bold: true, color: theme.ink, fit: "shrink", margin: 0 });
  slide.addText(item.subtitle || item.visualIntent || "", { x: 7.68, y: 2.2, w: 3.9, h: 0.5, fontSize: 11.5, color: theme.muted, fit: "shrink", margin: 0 });
}

function renderEditorialQuote(pptx, slide, item, theme) {
  slide.addText(item.title || "品牌观点", { x: 1.15, y: 1.45, w: 10.5, h: 1.45, fontSize: 32, bold: true, color: theme.ink, fit: "shrink", margin: 0 });
  slide.addShape(pptx.ShapeType.rect, { x: 1.2, y: 3.25, w: 2.2, h: 0.03, fill: { color: theme.accent }, line: { color: theme.accent } });
  slide.addText((item.bullets || [item.subtitle || item.visualIntent || "克制表达，保留高级感。"])[0], { x: 1.2, y: 3.7, w: 7.8, h: 0.45, fontSize: 13, color: theme.muted, fit: "shrink", margin: 0 });
}

function renderEditorialCards(pptx, slide, item, theme) {
  addTitle(slide, item, theme, { x: 0.78, y: 0.78, w: 8.4, fontSize: 24 });
  (item.bullets || []).slice(0, 4).forEach((bullet, i) => {
    const x = 0.86 + (i % 2) * 5.75;
    const y = 2.35 + Math.floor(i / 2) * 1.45;
    slide.addText(String(i + 1).padStart(2, "0"), { x, y, w: 0.48, h: 0.18, fontSize: 8, bold: true, color: theme.muted, margin: 0 });
    slide.addText(bullet, { x: x + 0.72, y: y - 0.08, w: 4.35, h: 0.42, fontSize: 12.5, color: theme.ink, fit: "shrink", margin: 0 });
    slide.addShape(pptx.ShapeType.rect, { x: x + 0.72, y: y + 0.62, w: 3.75, h: 0.02, fill: { color: theme.soft }, line: { color: theme.soft } });
  });
}

function renderEditorialProduct(pptx, slide, item, theme, job, index = 0) {
  renderEditorialVisual(pptx, slide, item, theme, job, index);
  addBulletStrip(pptx, slide, item.bullets, theme, 7.68, 3.28, 3.8);
}

function renderEditorialClosing(pptx, slide, item, theme) {
  slide.addText(item.title || "下一步", { x: 0.95, y: 1.25, w: 9, h: 1.05, fontSize: 34, bold: true, color: theme.ink, fit: "shrink", margin: 0 });
  slide.addText(item.subtitle || item.visualIntent || "补齐信息，形成正式画册版。", { x: 0.98, y: 2.58, w: 6.8, h: 0.42, fontSize: 12.5, color: theme.muted, fit: "shrink", margin: 0 });
  slide.addShape(pptx.ShapeType.rect, { x: 0.98, y: 3.35, w: 10.8, h: 0.03, fill: { color: theme.accent }, line: { color: theme.accent } });
}

function renderLaunchCover(pptx, slide, item, theme, job) {
  slide.background = { color: theme.bg };
  slide.addShape(pptx.ShapeType.rect, { x: 0.72, y: 0.9, w: 11.9, h: 0.04, fill: { color: theme.accent }, line: { color: theme.accent } });
  slide.addText("LAUNCH / TREND", { x: 0.82, y: 1.22, w: 2.3, h: 0.22, fontSize: 8.5, bold: true, color: theme.accent, margin: 0 });
  slide.addText(item.title || job.deck.title, { x: 0.82, y: 1.76, w: 8.8, h: 1.55, fontSize: 36, bold: true, color: theme.ink, fit: "shrink", margin: 0 });
  slide.addText(item.subtitle || job.deck.summary || "发布叙事、关键指标、下一步行动", { x: 0.86, y: 3.55, w: 7.2, h: 0.46, fontSize: 13, color: theme.muted, fit: "shrink", margin: 0 });
  slide.addShape(pptx.ShapeType.rect, { x: 10.25, y: 1.35, w: 1.25, h: 3.8, fill: { color: theme.accent }, line: { color: theme.accent } });
}

function renderLaunchSection(pptx, slide, item, theme) {
  slide.addText(item.title || "趋势判断", { x: 0.82, y: 1.32, w: 10.2, h: 1.15, fontSize: 34, bold: true, color: theme.ink, fit: "shrink", margin: 0 });
  slide.addText(item.subtitle || item.visualIntent || "", { x: 0.86, y: 2.75, w: 8.2, h: 0.42, fontSize: 12.5, color: theme.muted, fit: "shrink", margin: 0 });
  addBulletStrip(pptx, slide, item.bullets, theme, 0.88, 4.0, 8.6);
}

function renderLaunchKpi(pptx, slide, item, theme) {
  renderTechKpi(pptx, slide, item, theme);
}

function renderLaunchVisual(pptx, slide, item, theme, job, index = 0) {
  renderVisual(pptx, slide, item, theme, job, index);
}

function renderLaunchTimeline(pptx, slide, item, theme) {
  renderTechTimeline(pptx, slide, item, theme);
}

function renderLaunchQuote(pptx, slide, item, theme) {
  slide.addText(item.title || "核心判断", { x: 0.95, y: 1.35, w: 10.6, h: 1.35, fontSize: 34, bold: true, color: theme.ink, fit: "shrink", margin: 0 });
  slide.addText((item.bullets || [item.subtitle || item.visualIntent || "用一句话形成发布会记忆点。"])[0], { x: 1.0, y: 3.25, w: 8.4, h: 0.5, fontSize: 13, color: theme.muted, fit: "shrink", margin: 0 });
  slide.addShape(pptx.ShapeType.rect, { x: 10.45, y: 1.25, w: 0.9, h: 3.9, fill: { color: theme.accent }, line: { color: theme.accent } });
}

function renderLaunchClosing(pptx, slide, item, theme) {
  renderTechClosing(pptx, slide, item, theme);
}

function addBulletStrip(pptx, slide, bullets = [], theme, x, y, w) {
  bullets.slice(0, 4).forEach((bullet, index) => {
    slide.addShape(pptx.ShapeType.rect, { x, y: y + index * 0.48, w: 0.08, h: 0.12, fill: { color: theme.accent }, line: { color: theme.accent } });
    slide.addText(bullet, { x: x + 0.22, y: y + index * 0.44, w, h: 0.28, fontSize: 11.5, color: theme.ink, fit: "shrink", margin: 0 });
  });
}

function addCompareColumn(pptx, slide, label, bullets, theme, x, accented) {
  slide.addShape(pptx.ShapeType.roundRect, { x, y: 2.45, w: 5.45, h: 3.35, rectRadius: 0.06, fill: { color: accented ? theme.accent : theme.soft, transparency: accented ? 4 : 0 }, line: { color: accented ? theme.accent : theme.soft } });
  slide.addText(label, { x: x + 0.28, y: 2.75, w: 1.8, h: 0.25, fontSize: 10, bold: true, color: accented ? theme.bg : theme.accent, margin: 0 });
  bullets.forEach((bullet, i) => {
    slide.addText(`• ${bullet}`, { x: x + 0.35, y: 3.25 + i * 0.54, w: 4.55, h: 0.3, fontSize: 12, color: accented ? theme.bg : theme.ink, fit: "shrink", margin: 0 });
  });
}

function splitMetric(text) {
  const source = cleanText(text);
  const match = source.match(/([¥￥]?\d+(?:\.\d+)?\s*(?:%|％|万|元|天|周|套|份|M|K)?)/i);
  if (!match) return { number: "01", label: source };
  return { number: match[1], label: source.replace(match[1], "").replace(/[：:，,。]/g, "").trim() || source };
}

function getImageFiles(job = {}) {
  return (job.files || []).filter((file) => {
    const ext = path.extname(file.originalName || file.path || "").toLowerCase();
    return [".png", ".jpg", ".jpeg", ".svg", ".webp"].includes(ext) || /^image\/(png|jpe?g|svg\+xml|webp)/i.test(file.mimeType || "");
  }).map((file, index) => ({ ...file, _imageIndex: index, _normalizedName: normalizeForMatch(file.originalName || path.basename(file.path || "")) }));
}

function getSlideImage(job, item = {}, index = 0) {
  const images = getImageFiles(job);
  if (!images.length) return null;
  const preferredSlots = (item.imageSlots || []).map(normalizeForMatch).filter(Boolean);
  const hasExplicitSlots = preferredSlots.length > 0;
  const imageRenderLayouts = new Set(["cover", "visual", "product-detail", "bundle", "closing"]);
  if (!imageRenderLayouts.has(item.layout)) return null;
  if (images.length === 1) return images[0];
  if (preferredSlots.length) {
    for (const slot of preferredSlots) {
      const exact = images.find((image) => image._normalizedName === slot);
      if (exact) return exact;
    }
  }
  const slideText = normalizeForMatch([item.title, item.subtitle, item.visualIntent, ...(item.imageSlots || []), ...(item.bullets || [])].join(" "));
  const scored = images.map((image) => ({ image, score: scoreImageForSlide(image, slideText, item.layout, index) }));
  scored.sort((a, b) => b.score - a.score || a.image._imageIndex - b.image._imageIndex);
  return scored[0]?.image || images[index % images.length];
}

function scoreImageForSlide(image, slideText, layout, index) {
  const name = image._normalizedName || "";
  let score = 0;
  if (Number(image.sourceSlide || 0) === index + 1) score += 30;
  score += imageSizeScore(image);
  for (const token of tokenizeMatchText(slideText)) {
    if (token.length >= 2 && name.includes(token)) score += token.length >= 4 ? 8 : 3;
  }
  if (layout === "cover" && /封面|主图|hero|cover|kv|keyvisual|视觉/.test(name)) score += 18;
  if (layout === "visual" && /产品|包装|礼盒|效果|开盒|实物|外观|细节|product|pack|box|render/.test(name)) score += 18;
  if (layout === "cards" && /卖点|产品|细节|规格|detail|feature/.test(name)) score += 10;
  if (/logo|标志|品牌/.test(name) && layout === "cover") score += 8;
  if (index === 0) score += Math.max(0, 4 - image._imageIndex);
  return score;
}

function imageSizeScore(image = {}) {
  const size = Number(image.size || 0);
  if (size >= 1_000_000) return 34;
  if (size >= 250_000) return 24;
  if (size >= 80_000) return 14;
  if (size >= 20_000) return 6;
  return 0;
}

function tokenizeMatchText(value) {
  const text = normalizeForMatch(value);
  const chinese = text.match(/[\u4e00-\u9fa5]{2,8}/g) || [];
  const latin = text.match(/[a-z0-9]{2,}/g) || [];
  return [...new Set([...chinese, ...latin])].slice(0, 24);
}

function normalizeForMatch(value = "") {
  return String(value).toLowerCase().replace(/\s+/g, "").replace(/[^\u4e00-\u9fa5a-z0-9]/g, "");
}

function addImageContain(slide, imagePath, x, y, w, h, theme) {
  try {
    const dimensions = imageSize(imagePath);
    const imageRatio = dimensions.width / dimensions.height;
    const boxRatio = w / h;
    const draw = imageRatio > boxRatio
      ? { x, y: y + (h - w / imageRatio) / 2, w, h: w / imageRatio }
      : { x: x + (w - h * imageRatio) / 2, y, w: h * imageRatio, h };
    recordImagePlacement(slide, "contain", imagePath, dimensions, { x, y, w, h }, draw);
    slide.addImage({ path: imagePath, ...draw });
  } catch {
    slide.addText("图片素材", { x, y: y + h / 2 - 0.15, w, h: 0.3, fontSize: 10, color: theme.accent, align: "center", margin: 0 });
  }
}

function addImageCover(slide, imagePath, x, y, w, h, theme) {
  try {
    const dimensions = imageSize(imagePath);
    const imageRatio = dimensions.width / dimensions.height;
    const boxRatio = w / h;
    const cropLoss = estimateCoverCropLoss(imageRatio, boxRatio);
    const isLargeHero = w * h >= SLIDE_W * SLIDE_H * 0.55;
    if (cropLoss > 0.42 && !isLargeHero) {
      const draw = imageRatio > boxRatio
        ? { x, y: y + (h - w / imageRatio) / 2, w, h: w / imageRatio }
        : { x: x + (w - h * imageRatio) / 2, y, w: h * imageRatio, h };
      recordImagePlacement(slide, "contain-auto", imagePath, dimensions, { x, y, w, h }, draw);
      slide.addImage({ path: imagePath, ...draw });
      return;
    }
    recordImagePlacement(slide, "cover", imagePath, dimensions, { x, y, w, h }, { x, y, w, h });
    slide.addImage({
      path: imagePath,
      x,
      y,
      w,
      h,
      sizing: { type: "cover", w, h }
    });
  } catch {
    slide.addText("图片素材", { x, y: y + h / 2 - 0.15, w, h: 0.3, fontSize: 10, color: theme.accent, align: "center", margin: 0 });
  }
}

function recordImagePlacement(slide, mode, imagePath, dimensions, box, draw) {
  const imageRatio = dimensions.width / dimensions.height;
  const boxRatio = box.w / box.h;
  const cropLoss = mode === "cover" ? estimateCoverCropLoss(imageRatio, boxRatio) : 0;
  const fillRatio = (mode === "contain" || mode === "contain-auto") ? estimateContainFillRatio(imageRatio, boxRatio) : 1;
  const warnings = [];
  if (mode === "cover" && cropLoss > 0.42) warnings.push("cover-crops-too-much");
  if ((mode === "contain" || mode === "contain-auto") && fillRatio < 0.55) warnings.push("contain-leaves-too-much-empty-space");
  slide._pptDesignImagePlacements?.push({
    mode,
    source: path.basename(imagePath || ""),
    imageWidth: dimensions.width,
    imageHeight: dimensions.height,
    imageRatio: roundMetric(imageRatio),
    box: roundBox(box),
    draw: roundBox(draw),
    boxRatio: roundMetric(boxRatio),
    cropLoss: roundMetric(cropLoss),
    fillRatio: roundMetric(fillRatio),
    warnings
  });
}

function safeImageRatio(imagePath) {
  try {
    const dimensions = imageSize(imagePath);
    return dimensions.width / dimensions.height;
  } catch {
    return null;
  }
}

function displayCaption(value, fallback) {
  const text = cleanText(value);
  if (!text) return fallback;
  if (text.length > 58) return fallback;
  if (/视觉特征|亮度倾向|饱和度|palette|composition|avoid|style|background|foreground/i.test(text)) return fallback;
  return text;
}

function estimateCoverCropLoss(imageRatio, boxRatio) {
  if (!imageRatio || !boxRatio) return 0;
  if (imageRatio > boxRatio) return 1 - boxRatio / imageRatio;
  return 1 - imageRatio / boxRatio;
}

function estimateContainFillRatio(imageRatio, boxRatio) {
  if (!imageRatio || !boxRatio) return 0;
  if (imageRatio > boxRatio) return boxRatio / imageRatio;
  return imageRatio / boxRatio;
}

function summarizeRenderImageQa(renderReport = {}) {
  const placements = renderReport.imagePlacements || [];
  const warnings = [...new Set(placements.flatMap((placement) => placement.warnings || []))];
  return {
    total: placements.length,
    warningCount: placements.filter((placement) => placement.warnings?.length).length,
    warnings,
    maxCropLoss: roundMetric(Math.max(0, ...placements.map((placement) => Number(placement.cropLoss || 0)))),
    minFillRatio: placements.length ? roundMetric(Math.min(...placements.map((placement) => Number(placement.fillRatio ?? 1)))) : 1,
    items: placements.filter((placement) => placement.warnings?.length).slice(0, 12)
  };
}

function roundBox(box = {}) {
  return {
    x: roundMetric(box.x),
    y: roundMetric(box.y),
    w: roundMetric(box.w),
    h: roundMetric(box.h)
  };
}

function roundMetric(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function safeName(name) {
  return cleanText(name).replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) || "deck";
}

export async function exportWithPowerPoint(pptxPath, formats) {
  const script = path.join(rootDir, "server", "scripts", "export-powerpoint.ps1");
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-PptxPath", pptxPath, "-Formats", formats.join(",")];
  const { stdout } = await execFileAsync(resolvePowerShellExecutable(), args, { windowsHide: true, timeout: 120000, encoding: "utf8" });
  return JSON.parse(stdout);
}

function resolvePowerShellExecutable() {
  const windir = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const candidates = [
    process.env.POWERSHELL_EXE,
    path.join(windir, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    path.join(windir, "SysWOW64", "WindowsPowerShell", "v1.0", "powershell.exe"),
    "powershell.exe"
  ].filter(Boolean);
  return candidates.find((candidate) => candidate === "powershell.exe" || fsSync.existsSync(candidate)) || "powershell.exe";
}

export async function renderPptxPreview(pptxPath) {
  try {
    const result = await exportWithPowerPoint(pptxPath, ["png"]);
    return { images: result.png || [], error: null };
  } catch (error) {
    return { images: [], error: error.message || "PowerPoint preview export failed" };
  }
}
