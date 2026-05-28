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
import { getThemeRecord } from "./designSystem.js";

const execFileAsync = promisify(execFile);
const MAX_EXTRACTED_CHARS = 18000;

function cleanText(value) {
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
  pptx.theme = {
    headFontFace: "Microsoft YaHei",
    bodyFontFace: "Microsoft YaHei",
    lang: "zh-CN"
  };
  const theme = getTheme(job.input.style);

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

function addChrome(pptx, slide, index, total, theme, job) {
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 0.1, fill: { color: theme.accent }, line: { color: theme.accent } });
  slide.addText(String(index + 1).padStart(2, "0"), { x: 0.48, y: 0.35, w: 0.65, h: 0.25, fontSize: 9, bold: true, color: theme.accent, margin: 0 });
  slide.addText(`${theme.name} · ${String(total).padStart(2, "0")}`, { x: 10.6, y: 6.95, w: 2.1, h: 0.2, fontSize: 7.5, color: theme.muted, align: "right", margin: 0 });
  slide.addText(job.input.projectName || job.deck.title || "PPT Design Tool", { x: 0.48, y: 6.95, w: 4.2, h: 0.2, fontSize: 7.5, color: theme.muted, margin: 0 });
}

function addTitle(slide, item, theme, options = {}) {
  slide.addText(item.title || "未命名页面", {
    x: options.x ?? 0.65,
    y: options.y ?? 0.82,
    w: options.w ?? 8.6,
    h: options.h ?? 0.7,
    fontSize: options.fontSize ?? 27,
    bold: true,
    color: theme.ink,
    breakLine: false,
    fit: "shrink",
    margin: 0.02
  });
  if (item.subtitle) {
    slide.addText(item.subtitle, {
      x: options.x ?? 0.67,
      y: (options.y ?? 0.82) + (options.subOffset ?? 0.78),
      w: options.subW ?? 8.8,
      h: 0.38,
      fontSize: 12.5,
      color: theme.muted,
      fit: "shrink",
      margin: 0.02
    });
  }
}

function renderCover(pptx, slide, item, theme, job) {
  slide.addShape(pptx.ShapeType.rect, { x: 0.58, y: 0.72, w: 0.12, h: 4.95, fill: { color: theme.accent }, line: { color: theme.accent } });
  slide.addText(item.title || job.deck.title, { x: 0.95, y: 1.05, w: 8.4, h: 1.5, fontSize: 36, bold: true, color: theme.ink, fit: "shrink", margin: 0 });
  slide.addText(item.subtitle || job.deck.summary || "结构化生成 · 可编辑交付", { x: 1, y: 2.72, w: 7.8, h: 0.6, fontSize: 15, color: theme.muted, fit: "shrink", margin: 0 });
  slide.addShape(pptx.ShapeType.rect, { x: 9.35, y: 1.05, w: 2.7, h: 3.35, fill: { color: theme.accent, transparency: 8 }, line: { color: theme.accent } });
  const coverImage = getSlideImage(job, item, 0);
  if (coverImage) {
    addImageContain(slide, coverImage.path, 9.5, 1.22, 2.4, 2.55, theme);
    slide.addText(job.input.audience || "目标受众", { x: 9.55, y: 3.95, w: 2.3, h: 0.22, fontSize: 8.5, bold: true, color: theme.bg, align: "center", margin: 0 });
  } else {
    slide.addText(job.input.audience || "目标受众", { x: 9.65, y: 1.42, w: 2.1, h: 0.42, fontSize: 12, bold: true, color: theme.bg, align: "center", margin: 0 });
    slide.addText(job.input.notes || item.visualIntent || "自动整理资料、重构页面叙事，并输出可编辑 PPTX。", { x: 9.65, y: 2.08, w: 2.1, h: 1.35, fontSize: 11, color: theme.bg, fit: "shrink", valign: "mid", align: "center", margin: 0.05 });
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
  slide.addShape(pptx.ShapeType.rect, { x: 6.35, y: 0.78, w: 5.78, h: 4.92, fill: { color: theme.soft }, line: { color: theme.soft } });
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
  const bullets = (item.bullets || []).slice(0, 6);
  bullets.forEach((bullet, i) => {
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
    slide.addShape(pptx.ShapeType.rect, { x, y: 2.35, w: 1.85, h: 2.15, fill: { color: theme.soft }, line: { color: theme.soft } });
    slide.addText(String(i + 1).padStart(2, "0"), { x: x + 0.18, y: 2.55, w: 0.6, h: 0.28, fontSize: 10, bold: true, color: theme.accent, margin: 0 });
    slide.addText(bullet, { x: x + 0.18, y: 3.05, w: 1.45, h: 0.9, fontSize: 12, color: theme.ink, fit: "shrink", margin: 0.02 });
  });
}

function renderPricing(pptx, slide, item, theme) {
  addTitle(slide, item, theme, { x: 0.68, y: 0.72, w: 9.4, subW: 8.6 });
  const entries = normalizePricingEntries(item);
  const max = Math.min(entries.length, 6);
  const cardW = max <= 4 ? 2.55 : 1.72;
  const gap = max <= 4 ? 0.28 : 0.22;
  const totalW = max * cardW + (max - 1) * gap;
  const startX = (13.333 - totalW) / 2;
  entries.slice(0, max).forEach((entry, i) => {
    const x = startX + i * (cardW + gap);
    const y = 2.42 + (i % 2) * 0.18;
    const h = 2.35 + i * 0.08;
    const accented = i === max - 1 || /高端|升级|主推|推荐/.test(entry.label);
    slide.addShape(pptx.ShapeType.roundRect, {
      x,
      y,
      w: cardW,
      h,
      rectRadius: 0.05,
      fill: { color: accented ? theme.accent : theme.soft, transparency: accented ? 2 : 0 },
      line: { color: accented ? theme.accent : theme.soft }
    });
    slide.addText(entry.price, { x: x + 0.16, y: y + 0.35, w: cardW - 0.32, h: 0.45, fontSize: max <= 4 ? 21 : 17, bold: true, color: accented ? theme.bg : theme.accent, align: "center", fit: "shrink", margin: 0 });
    slide.addText(entry.label || `第 ${i + 1} 档`, { x: x + 0.18, y: y + 1.02, w: cardW - 0.36, h: 0.5, fontSize: 10.5, bold: true, color: accented ? theme.bg : theme.ink, align: "center", fit: "shrink", margin: 0.02 });
    slide.addText(entry.note || "预算沟通入口", { x: x + 0.2, y: y + 1.72, w: cardW - 0.4, h: 0.42, fontSize: 8.8, color: accented ? theme.bg : theme.muted, align: "center", fit: "shrink", margin: 0.02 });
  });
  slide.addText(item.visualIntent || "用价格带帮助销售快速判断主推组合和客户预算。", { x: 1.1, y: 5.75, w: 11.1, h: 0.3, fontSize: 10.5, color: theme.muted, align: "center", fit: "shrink", margin: 0 });
}

function renderProductDetail(pptx, slide, item, theme, job, index = 0) {
  addTitle(slide, item, theme, { x: 0.7, y: 0.7, w: 6.8, subW: 6.6 });
  const image = getSlideImage(job, item, index);
  slide.addShape(pptx.ShapeType.rect, { x: 7.8, y: 1.05, w: 4.35, h: 3.65, fill: { color: theme.soft }, line: { color: theme.soft } });
  if (image) addImageContain(slide, image.path, 8.02, 1.28, 3.9, 3.05, theme);
  const bullets = item.bullets || [];
  bullets.slice(0, 5).forEach((bullet, i) => {
    const y = 2.45 + i * 0.55;
    slide.addShape(pptx.ShapeType.rect, { x: 0.78, y, w: 0.09, h: 0.16, fill: { color: theme.accent }, line: { color: theme.accent } });
    slide.addText(bullet, { x: 1.05, y: y - 0.04, w: 5.8, h: 0.28, fontSize: 11.5, color: theme.ink, fit: "shrink", margin: 0 });
  });
  slide.addText(item.speakerNotes || "", { x: 7.95, y: 4.92, w: 4.05, h: 0.55, fontSize: 8.8, color: theme.muted, fit: "shrink", margin: 0.02, align: "center" });
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
  const bullets = (item.bullets || []).slice(0, 6);
  bullets.forEach((bullet, i) => {
    const x = 0.86 + (i % 2) * 5.9;
    const y = 2.18 + Math.floor(i / 2) * 0.92;
    slide.addShape(pptx.ShapeType.roundRect, { x, y, w: 5.1, h: 0.58, rectRadius: 0.04, fill: { color: theme.soft }, line: { color: theme.soft } });
    slide.addText("✓", { x: x + 0.18, y: y + 0.14, w: 0.25, h: 0.2, fontSize: 10, bold: true, color: theme.accent, margin: 0 });
    slide.addText(bullet, { x: x + 0.55, y: y + 0.14, w: 4.3, h: 0.2, fontSize: 10.5, color: theme.ink, fit: "shrink", margin: 0 });
  });
}

function normalizePricingEntries(item = {}) {
  const points = (item.dataPoints || []).filter(Boolean);
  const bullets = (item.bullets || []).filter(Boolean);
  const source = points.length ? points : bullets;
  const entries = source.map((value, index) => {
    const text = cleanText(value);
    const price = text.match(/[¥￥]?\s*\d+(?:\.\d+)?\s*元?/)?.[0]?.replace(/\s+/g, "") || `${index + 1}`;
    const label = text.replace(price, "").replace(/[：:，,。-]/g, " ").trim() || `第 ${index + 1} 档`;
    return { price, label, note: index === 0 ? "入门预算" : index === source.length - 1 ? "高端升级" : "主流选择" };
  });
  return entries.length ? entries : [{ price: "01", label: item.title || "价格梯度", note: "待补充报价" }];
}

function renderCompare(pptx, slide, item, theme) {
  addTitle(slide, item, theme);
  const bullets = item.bullets || [];
  const mid = Math.ceil(bullets.length / 2);
  addCompareColumn(pptx, slide, "方案 A", bullets.slice(0, mid), theme, 0.72, false);
  addCompareColumn(pptx, slide, "方案 B", bullets.slice(mid), theme, 6.8, true);
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
    slide.addShape(pptx.ShapeType.rect, { x: 7.35, y: 2.45, w: 4.7, h: 2.95, fill: { color: theme.soft }, line: { color: theme.soft } });
    addImageContain(slide, image.path, 7.55, 2.62, 4.3, 2.55, theme);
    slide.addText(image.originalName || "上传图片素材", { x: 7.55, y: 5.22, w: 4.3, h: 0.2, fontSize: 8, color: theme.muted, align: "center", fit: "shrink", margin: 0 });
  }
}

function renderQuote(pptx, slide, item, theme) {
  slide.addText("“", { x: 0.75, y: 0.85, w: 1, h: 0.8, fontSize: 50, color: theme.accent, margin: 0 });
  slide.addText(item.title || "核心观点", { x: 1.15, y: 1.58, w: 10.6, h: 1.65, fontSize: 31, bold: true, color: theme.ink, fit: "shrink", margin: 0 });
  slide.addText(item.subtitle || item.visualIntent || "", { x: 1.2, y: 3.55, w: 8.8, h: 0.45, fontSize: 13, color: theme.muted, fit: "shrink", margin: 0 });
  addBulletStrip(pptx, slide, item.bullets, theme, 1.2, 4.45, 9.4);
}

function renderClosing(pptx, slide, item, theme) {
  slide.addShape(pptx.ShapeType.rect, { x: 0.7, y: 0.9, w: 11.9, h: 4.75, fill: { color: theme.soft }, line: { color: theme.soft } });
  slide.addText(item.title || "下一步行动", { x: 1.05, y: 1.35, w: 8.6, h: 0.8, fontSize: 30, bold: true, color: theme.ink, fit: "shrink", margin: 0 });
  slide.addText(item.subtitle || item.visualIntent || "确认版本、补齐素材、进入交付。", { x: 1.08, y: 2.22, w: 8.2, h: 0.38, fontSize: 13, color: theme.muted, fit: "shrink", margin: 0 });
  addBulletStrip(pptx, slide, item.bullets, theme, 1.1, 3.05, 8.8);
  slide.addShape(pptx.ShapeType.rect, { x: 10.35, y: 1.35, w: 1.3, h: 3.25, fill: { color: theme.accent }, line: { color: theme.accent } });
}

function addBulletStrip(pptx, slide, bullets = [], theme, x, y, w) {
  bullets.slice(0, 4).forEach((bullet, index) => {
    slide.addShape(pptx.ShapeType.rect, { x, y: y + index * 0.48, w: 0.08, h: 0.12, fill: { color: theme.accent }, line: { color: theme.accent } });
    slide.addText(bullet, { x: x + 0.22, y: y + index * 0.44, w, h: 0.28, fontSize: 11.5, color: theme.ink, fit: "shrink", margin: 0 });
  });
}

function addCompareColumn(pptx, slide, label, bullets, theme, x, accented) {
  slide.addShape(pptx.ShapeType.rect, { x, y: 2.45, w: 5.45, h: 3.35, fill: { color: accented ? theme.accent : theme.soft, transparency: accented ? 4 : 0 }, line: { color: accented ? theme.accent : theme.soft } });
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
    return result.png || [];
  } catch {
    return [];
  }
}
