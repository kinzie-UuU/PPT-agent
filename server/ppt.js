import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import JSZip from "jszip";
import pptxgen from "pptxgenjs";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { imageSize } from "image-size";
import { outputDir, rootDir } from "./store.js";
import { getTemplatePack, getThemeRecord } from "./designSystem.js";

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
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]));
  const slides = [];
  for (const name of slideFiles) {
    const xml = await zip.files[name].async("text");
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1]));
    slides.push(cleanText(texts.join(" ")));
  }
  return slides.map((text, index) => `第 ${index + 1} 页：${text}`).join("\n");
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

export async function buildDeck(job) {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "PPT Design Tool";
  pptx.subject = job.mode === "optimize" ? "优化旧 PPT" : "生成新 PPT";
  pptx.title = job.deck.title;
  pptx.company = "Local";
  pptx.lang = "zh-CN";
  pptx.theme = { headFontFace: "Microsoft YaHei", bodyFontFace: "Microsoft YaHei", lang: "zh-CN" };
  const theme = getTheme(job.input.style || job.input.routePlan?.recommendedTheme);
  const templatePack = getTemplatePack(job.input.style || job.input.routePlan?.recommendedTheme);
  theme.templatePack = templatePack;

  job.deck.slides.forEach((item, index) => {
    const slide = pptx.addSlide();
    slide.background = { color: theme.bg };
    if (item.speakerNotes) slide.addNotes(item.speakerNotes);
    renderSlide(pptx, slide, item, index, job.deck.slides.length, theme, job);
  });

  const jobDir = path.join(outputDir, job.id);
  await fs.mkdir(jobDir, { recursive: true });
  const pptxPath = path.join(jobDir, `${safeName(job.deck.title || "deck")}.pptx`);
  await pptx.writeFile({ fileName: pptxPath });
  return pptxPath;
}

function renderSlide(pptx, slide, item, index, total, theme, job) {
  addChrome(pptx, slide, index, total, theme, job);
  const layout = item.layout || (index === 0 ? "cover" : index === total - 1 ? "closing" : "cards");
  const templateRenderer = getTemplateRenderer(theme.templatePack?.slug, layout);
  if (templateRenderer) {
    templateRenderer(pptx, slide, item, theme, job, index);
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

function renderPricing(pptx, slide, item, theme) {
  addTitle(slide, item, theme, { x: 0.68, y: 0.68, w: 9.4, subW: 8.6 });
  const entries = normalizePricingEntries(item).slice(0, 6);
  const max = entries.length;
  const cardW = max <= 3 ? 3.25 : max <= 4 ? 2.65 : 1.85;
  const gap = max <= 3 ? 0.42 : 0.28;
  const totalW = max * cardW + (max - 1) * gap;
  const startX = (SLIDE_W - totalW) / 2;
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

function renderClosing(pptx, slide, item, theme) {
  slide.addShape(pptx.ShapeType.roundRect, { x: 0.7, y: 0.9, w: 11.9, h: 4.75, rectRadius: 0.06, fill: { color: theme.soft }, line: { color: theme.soft } });
  slide.addText(item.title || "下一步行动", { x: 1.05, y: 1.35, w: 8.6, h: 0.8, fontSize: 30, bold: true, color: theme.ink, fit: "shrink", margin: 0 });
  slide.addText(item.subtitle || item.visualIntent || "确认版本、补齐素材、进入交付。", { x: 1.08, y: 2.22, w: 8.2, h: 0.38, fontSize: 13, color: theme.muted, fit: "shrink", margin: 0 });
  addBulletStrip(pptx, slide, item.bullets, theme, 1.1, 3.05, 8.8);
  slide.addShape(pptx.ShapeType.rect, { x: 10.35, y: 1.35, w: 1.3, h: 3.25, fill: { color: theme.accent }, line: { color: theme.accent } });
}

function renderSeasonalCover(pptx, slide, item, theme, job) {
  const image = getSlideImage(job, item, 0);
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: SLIDE_W, h: SLIDE_H, fill: { color: theme.bg }, line: { color: theme.bg } });
  slide.addShape(pptx.ShapeType.rect, { x: 0.62, y: 0.62, w: 12.1, h: 6.25, fill: { color: theme.bg, transparency: 100 }, line: { color: theme.accent, transparency: 42, width: 1.1 } });
  slide.addShape(pptx.ShapeType.rect, { x: 8.55, y: 0.58, w: 3.62, h: 5.15, fill: { color: theme.soft }, line: { color: theme.soft } });
  slide.addShape(pptx.ShapeType.rect, { x: 8.95, y: 0.98, w: 2.82, h: 4.34, fill: { color: "FFFFFF", transparency: 12 }, line: { color: theme.accent, transparency: 58 } });
  if (image) addImageContain(slide, image.path, 8.9, 1.1, 2.95, 3.78, theme);
  else slide.addText("产品主视觉", { x: 9.15, y: 2.8, w: 2.4, h: 0.28, fontSize: 12, bold: true, color: theme.accent, align: "center", margin: 0 });
  slide.addText("节日礼赠方案", { x: 0.98, y: 1.02, w: 2.1, h: 0.24, fontSize: 10, bold: true, color: theme.accent, margin: 0 });
  slide.addText(item.title || job.deck.title, { x: 0.95, y: 1.55, w: 6.85, h: 1.55, fontSize: 35, bold: true, color: theme.ink, fit: "shrink", margin: 0 });
  slide.addText(item.subtitle || job.deck.summary || "围绕场景、预算和体面感生成可编辑 PPT", { x: 1, y: 3.35, w: 6.5, h: 0.52, fontSize: 14, color: theme.muted, fit: "shrink", margin: 0 });
  addBulletStrip(pptx, slide, item.bullets, theme, 1.02, 4.52, 6.8);
}

function renderSeasonalVisual(pptx, slide, item, theme, job, index = 0) {
  const image = getSlideImage(job, item, index) || getSlideImage(job, item, 0);
  slide.addShape(pptx.ShapeType.rect, { x: 0.75, y: 0.75, w: 5.25, h: 5.68, fill: { color: theme.soft }, line: { color: theme.soft } });
  if (image) addImageContain(slide, image.path, 0.98, 0.98, 4.78, 5.02, theme);
  else slide.addText("礼盒 / 产品图", { x: 1.38, y: 3.12, w: 3.9, h: 0.28, fontSize: 14, bold: true, color: theme.accent, align: "center", margin: 0 });
  slide.addText(item.title || "产品主视觉", { x: 6.65, y: 1, w: 5.3, h: 0.88, fontSize: 28, bold: true, color: theme.ink, fit: "shrink", margin: 0 });
  slide.addText(item.subtitle || item.visualIntent || "先用完整包装和质感建立礼赠判断。", { x: 6.68, y: 1.95, w: 4.9, h: 0.5, fontSize: 12.5, color: theme.muted, fit: "shrink", margin: 0 });
  (item.bullets || []).slice(0, 4).forEach((bullet, i) => {
    const y = 2.92 + i * 0.68;
    slide.addShape(pptx.ShapeType.rect, { x: 6.72, y: y + 0.1, w: 0.28, h: 0.04, fill: { color: theme.accent }, line: { color: theme.accent } });
    slide.addText(bullet, { x: 7.18, y, w: 4.55, h: 0.34, fontSize: 11.5, color: theme.ink, fit: "shrink", margin: 0 });
  });
}

function renderSeasonalPricing(pptx, slide, item, theme) {
  addTitle(slide, item, theme, { x: 0.75, y: 0.72, w: 8.6, fontSize: 25, subW: 8.4 });
  const entries = normalizePricingEntries(item).slice(0, 3);
  const labels = ["入门礼", "主推礼", "升级礼"];
  entries.forEach((entry, i) => {
    const x = 0.88 + i * 4.12;
    const accented = i === 1 || entry.accented;
    slide.addShape(pptx.ShapeType.roundRect, { x, y: accented ? 2.05 : 2.35, w: 3.35, h: accented ? 3.25 : 2.95, rectRadius: 0.05, fill: { color: accented ? theme.accent : theme.soft }, line: { color: accented ? theme.accent : theme.soft } });
    slide.addText(labels[i] || entry.tier, { x: x + 0.28, y: accented ? 2.38 : 2.68, w: 1.8, h: 0.25, fontSize: 10.5, bold: true, color: accented ? theme.bg : theme.accent, margin: 0 });
    slide.addText(entry.price, { x: x + 0.35, y: accented ? 3.02 : 3.18, w: 2.65, h: 0.62, fontSize: 27, bold: true, color: accented ? theme.bg : theme.ink, align: "center", fit: "shrink", margin: 0 });
    slide.addText(entry.label, { x: x + 0.35, y: accented ? 3.88 : 3.95, w: 2.62, h: 0.55, fontSize: 11, bold: true, color: accented ? theme.bg : theme.ink, align: "center", fit: "shrink", margin: 0.02 });
    slide.addText(entry.note, { x: x + 0.35, y: accented ? 4.68 : 4.58, w: 2.62, h: 0.38, fontSize: 8.8, color: accented ? theme.bg : theme.muted, align: "center", fit: "shrink", margin: 0.02 });
  });
  slide.addText("建议用三档价格绑定送礼对象：员工福利、客户拜访、重要礼赠。", { x: 1.1, y: 6, w: 10.9, h: 0.28, fontSize: 10.5, color: theme.muted, align: "center", fit: "shrink", margin: 0 });
}

function renderSeasonalProductDetail(pptx, slide, item, theme, job, index = 0) {
  const image = getSlideImage(job, item, index);
  addTitle(slide, item, theme, { x: 0.72, y: 0.72, w: 6.2, fontSize: 25, subW: 6.2 });
  slide.addShape(pptx.ShapeType.roundRect, { x: 7.45, y: 0.98, w: 4.2, h: 4.55, rectRadius: 0.05, fill: { color: theme.soft }, line: { color: theme.soft } });
  if (image) addImageContain(slide, image.path, 7.72, 1.22, 3.66, 3.55, theme);
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
  addTitle(slide, item, theme, { x: 0.75, y: 0.72, w: 8.4, fontSize: 25, subW: 8.3 });
  const bullets = (item.bullets || []).slice(0, 6);
  const labels = ["员工福利", "客户拜访", "重要礼赠"];
  labels.forEach((label, i) => {
    const x = 0.85 + i * 4.05;
    slide.addShape(pptx.ShapeType.rect, { x, y: 2.15, w: 3.28, h: 3.08, fill: { color: i === 1 ? theme.accent : theme.soft, transparency: i === 1 ? 3 : 0 }, line: { color: i === 1 ? theme.accent : theme.soft } });
    slide.addText(label, { x: x + 0.25, y: 2.45, w: 2.55, h: 0.28, fontSize: 11, bold: true, color: i === 1 ? theme.bg : theme.accent, margin: 0 });
    slide.addText(bullets[i] || "待补齐主推组合", { x: x + 0.25, y: 3.05, w: 2.72, h: 0.72, fontSize: 13, bold: true, color: i === 1 ? theme.bg : theme.ink, fit: "shrink", margin: 0.02 });
    slide.addText(bullets[i + 3] || "补齐预算、数量和交期后生成正式版本。", { x: x + 0.25, y: 4.22, w: 2.72, h: 0.46, fontSize: 9.3, color: i === 1 ? theme.bg : theme.muted, fit: "shrink", margin: 0.02 });
  });
}

function renderSeasonalClosing(pptx, slide, item, theme) {
  slide.addShape(pptx.ShapeType.rect, { x: 0.68, y: 0.85, w: 12, h: 5.85, fill: { color: theme.soft }, line: { color: theme.soft } });
  slide.addText(item.title || "确认主推组合", { x: 1.05, y: 1.28, w: 8.2, h: 0.75, fontSize: 28, bold: true, color: theme.ink, fit: "shrink", margin: 0 });
  slide.addText(item.subtitle || item.visualIntent || "补齐报价、交期和图片素材后输出客户版。", { x: 1.08, y: 2.1, w: 7.4, h: 0.4, fontSize: 12.5, color: theme.muted, fit: "shrink", margin: 0 });
  addBulletStrip(pptx, slide, item.bullets, theme, 1.1, 3, 7.8);
  slide.addShape(pptx.ShapeType.rect, { x: 10.12, y: 1.18, w: 1.2, h: 4.12, fill: { color: theme.accent }, line: { color: theme.accent } });
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
    return [".png", ".jpg", ".jpeg", ".svg"].includes(ext) || /^image\/(png|jpe?g|svg\+xml)/i.test(file.mimeType || "");
  }).map((file, index) => ({ ...file, _imageIndex: index, _normalizedName: normalizeForMatch(file.originalName || path.basename(file.path || "")) }));
}

function getSlideImage(job, item = {}, index = 0) {
  const images = getImageFiles(job);
  if (!images.length) return null;
  if (images.length === 1) return images[0];
  const slideText = normalizeForMatch([item.title, item.subtitle, item.visualIntent, ...(item.imageSlots || []), ...(item.bullets || [])].join(" "));
  const scored = images.map((image) => ({ image, score: scoreImageForSlide(image, slideText, item.layout, index) }));
  scored.sort((a, b) => b.score - a.score || a.image._imageIndex - b.image._imageIndex);
  return scored[0]?.image || images[index % images.length];
}

function scoreImageForSlide(image, slideText, layout, index) {
  const name = image._normalizedName || "";
  let score = 0;
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
    slide.addImage({ path: imagePath, ...draw });
  } catch {
    slide.addText("图片素材", { x, y: y + h / 2 - 0.15, w, h: 0.3, fontSize: 10, color: theme.accent, align: "center", margin: 0 });
  }
}

function safeName(name) {
  return cleanText(name).replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) || "deck";
}

export async function exportWithPowerPoint(pptxPath, formats) {
  const script = path.join(rootDir, "server", "scripts", "export-powerpoint.ps1");
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-PptxPath", pptxPath, "-Formats", formats.join(",")];
  const { stdout } = await execFileAsync("powershell.exe", args, { windowsHide: true, timeout: 120000, encoding: "utf8" });
  return JSON.parse(stdout);
}

export async function renderPptxPreview(pptxPath) {
  try {
    const result = await exportWithPowerPoint(pptxPath, ["png"]);
    return { images: result.png || [], error: null };
  } catch (error) {
    return { images: [], error: error.message || "PowerPoint preview export failed" };
  }
}
