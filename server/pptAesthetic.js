import fs from "fs/promises";
import path from "path";
import JSZip from "jszip";

const EMU_PER_INCH = 914400;
const DEFAULT_W = 13.333;
const DEFAULT_H = 7.5;

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function decodeXml(value = "") {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function emuToInch(value) {
  return Number(value || 0) / EMU_PER_INCH;
}

function round(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function attrs(xml = "") {
  const result = {};
  for (const match of xml.matchAll(/\b([A-Za-z0-9:_-]+)="([^"]*)"/g)) result[match[1]] = decodeXml(match[2]);
  return result;
}

function blocks(xml = "", tag) {
  const escaped = tag.replace(":", "\\:");
  const pattern = new RegExp(`<${escaped}\\b[\\s\\S]*?<\\/${escaped}>`, "g");
  return [...xml.matchAll(pattern)].map((match) => match[0]);
}

function extractTransform(xml = "") {
  const off = xml.match(/<a:off\b([^>]*)\/>/)?.[1] || "";
  const ext = xml.match(/<a:ext\b([^>]*)\/>/)?.[1] || "";
  const a = attrs(off);
  const e = attrs(ext);
  return {
    x: round(emuToInch(a.x)),
    y: round(emuToInch(a.y)),
    w: round(emuToInch(e.cx)),
    h: round(emuToInch(e.cy))
  };
}

function extractText(xml = "") {
  return cleanText([...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map((match) => decodeXml(match[1])).join(" "));
}

function extractFontSizes(xml = "") {
  return [...xml.matchAll(/<a:rPr\b([^>]*)>/g)]
    .map((match) => Number(attrs(match[1]).sz || 0) / 100)
    .filter((value) => Number.isFinite(value) && value > 0);
}

function extractColors(xml = "") {
  const colors = new Set();
  for (const match of xml.matchAll(/<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})"/g)) colors.add(match[1].toUpperCase());
  for (const match of xml.matchAll(/<a:schemeClr\b[^>]*\bval="([^"]+)"/g)) colors.add(`scheme:${match[1]}`);
  return [...colors];
}

function slideSize(zip, presentationXml) {
  const match = presentationXml?.match(/<p:sldSz\b([^>]*)\/>/);
  if (!match) return { width: DEFAULT_W, height: DEFAULT_H };
  const a = attrs(match[1]);
  return {
    width: round(emuToInch(a.cx)) || DEFAULT_W,
    height: round(emuToInch(a.cy)) || DEFAULT_H
  };
}

export async function analyzePptxAesthetic(file) {
  const ext = path.extname(file?.originalName || file?.path || "").toLowerCase();
  if (!file?.path || ext !== ".pptx") return null;
  const buffer = await fs.readFile(file.path);
  const zip = await JSZip.loadAsync(buffer);
  const presentationXml = await zip.file("ppt/presentation.xml")?.async("string");
  const size = slideSize(zip, presentationXml || "");
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/)?.[1] || 0) - Number(b.match(/slide(\d+)/)?.[1] || 0));
  const slides = [];
  for (const [index, name] of slideFiles.entries()) {
    const xml = await zip.file(name).async("string");
    const slide = buildSlideIr(xml, index, size);
    slides.push(slide);
  }
  return buildAestheticReport({
    deckName: file.originalName || path.basename(file.path),
    slideCount: slides.length,
    slides
  });
}

function buildSlideIr(xml, index, size) {
  const elements = [];
  for (const [shapeIndex, block] of blocks(xml, "p:sp").entries()) {
    const text = extractText(block);
    const pos = extractTransform(block);
    const colors = extractColors(block);
    const fontSizes = extractFontSizes(block);
    const fill = block.match(/<a:solidFill>[\s\S]*?<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})"/)?.[1]?.toUpperCase() || "";
    if (text) {
      elements.push({
        id: `s${index + 1}-t${shapeIndex + 1}`,
        type: "text",
        text,
        ...pos,
        fontSize: fontSizes[0] || null,
        maxFontSize: fontSizes.length ? Math.max(...fontSizes) : null,
        color: colors[0] || "",
        fill
      });
    } else if (pos.w || pos.h || fill) {
      elements.push({
        id: `s${index + 1}-sh${shapeIndex + 1}`,
        type: "shape",
        ...pos,
        fill,
        color: colors[0] || ""
      });
    }
  }
  for (const [imageIndex, block] of blocks(xml, "p:pic").entries()) {
    elements.push({
      id: `s${index + 1}-i${imageIndex + 1}`,
      type: "image",
      ...extractTransform(block)
    });
  }
  const rawText = cleanText(elements.filter((item) => item.type === "text").map((item) => item.text).join("\n"));
  const colors = [...new Set(elements.flatMap((item) => [item.color, item.fill]).filter(Boolean))];
  const classification = classifySlide({ index, rawText, elements });
  const diagnosis = diagnoseSlide({ index, rawText, elements, colors, width: size.width, height: size.height });
  return {
    slideId: String(index + 1),
    index,
    page: index + 1,
    width: size.width,
    height: size.height,
    rawText,
    elements,
    metrics: {
      textCount: rawText.replace(/\s/g, "").length,
      elementCount: elements.length,
      textBoxes: elements.filter((item) => item.type === "text").length,
      imageCount: elements.filter((item) => item.type === "image").length,
      shapeCount: elements.filter((item) => item.type === "shape").length,
      colorCount: colors.length
    },
    classification,
    diagnosis,
    redesign: createRedesignPlan(rawText, classification.type)
  };
}

function classifySlide({ index, rawText, elements }) {
  const text = cleanText(rawText).toLowerCase();
  const compact = text.replace(/\s+/g, "");
  const rules = [
    ["thanks", ["谢谢", "thanks"]],
    ["category_matrix", ["户外运动类", "电子类", "办公类", "家纺类", "玩具类", "文具类", "健康类", "家电类", "品类"]],
    ["creative_custom", ["创意定制", "原创设计", "打样", "工艺", "pk", "客户认可"]],
    ["light_custom", ["轻定制", "现货", "logo", "水晶贴", "二次定制"]],
    ["project_review", ["投诉", "交货周期", "临时增加", "现场盯货", "免检", "风险"]],
    ["product_cost", ["预估", "元", "礼盒另算", "报价", "成本", "价格"]],
    ["company_case", ["中标", "集团", "网点", "员工", "合作", "案例介绍", "公司"]]
  ];
  const scored = rules.map(([type, keywords]) => {
    const matched = keywords.filter((keyword) => compact.includes(keyword.toLowerCase()));
    return { type, matched, score: matched.length / keywords.length };
  }).sort((a, b) => b.score - a.score || b.matched.length - a.matched.length);
  const best = scored[0];
  if (best?.matched.length) return { type: best.type, confidence: round(Math.min(0.95, 0.45 + best.score)), matched: best.matched };
  if (index === 0 || (text.length < 80 && elements.filter((item) => item.type === "text").length <= 3)) return { type: "cover", confidence: 0.58, matched: [] };
  if (/目录|agenda|contents/.test(compact)) return { type: "agenda", confidence: 0.76, matched: ["目录"] };
  return { type: "unknown", confidence: 0.3, matched: [] };
}

function diagnoseSlide({ rawText, elements, colors, width, height }) {
  const textCount = rawText.replace(/\s/g, "").length;
  const elementCount = elements.length;
  const textElements = elements.filter((item) => item.type === "text");
  const imageElements = elements.filter((item) => item.type === "image");
  const problems = [];
  let score = 100;
  if (textCount > 220) {
    problems.push({ level: "high", type: "density", message: `正文约 ${textCount} 字，信息密度过高，建议压缩为 3-5 个要点。` });
    score -= 18;
  } else if (textCount > 140) {
    problems.push({ level: "medium", type: "density", message: `正文约 ${textCount} 字，建议拆分层级。` });
    score -= 10;
  }
  if (elementCount > 18) {
    problems.push({ level: "high", type: "density", message: `页面元素 ${elementCount} 个，视觉负担过重。` });
    score -= 12;
  }
  if (colors.length > 5) {
    problems.push({ level: "medium", type: "color", message: `页面颜色约 ${colors.length} 种，建议收敛到主色/辅色/强调色。` });
    score -= 8;
  }
  const fontSizes = textElements.map((item) => item.maxFontSize || item.fontSize || 14).filter(Boolean);
  if (fontSizes.length > 3) {
    const max = Math.max(...fontSizes);
    const min = Math.max(1, Math.min(...fontSizes));
    if (max / min < 1.5) {
      problems.push({ level: "medium", type: "hierarchy", message: "标题与正文层级差异不足。" });
      score -= 10;
    }
  }
  const occupied = elements.reduce((sum, item) => sum + Math.max(0, item.w || 0) * Math.max(0, item.h || 0), 0);
  const occupancy = occupied / Math.max(1, width * height);
  if (occupancy > 0.72) {
    problems.push({ level: "medium", type: "alignment", message: "页面占用面积过高，留白不足。" });
    score -= 8;
  }
  if (imageElements.some((item) => item.w > 0 && item.h > 0 && (item.w / item.h > 4 || item.h / item.w > 4))) {
    problems.push({ level: "medium", type: "image", message: "存在极端比例图片框，需检查是否被拉伸或裁切过重。" });
    score -= 8;
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score,
    problems,
    suggestions: problems.map((item) => item.message),
    metrics: {
      textCount,
      elementCount,
      colorCount: colors.length,
      imageCount: imageElements.length,
      occupancy: round(occupancy)
    }
  };
}

function createRedesignPlan(rawText, type) {
  const lines = cleanText(rawText).split(/[\n。；;]+/).map(cleanText).filter(Boolean);
  const title = lines[0]?.slice(0, 32) || "页面标题";
  const strategyMap = {
    cover: "cover_hero",
    agenda: "agenda_cards",
    company_case: "case_summary",
    product_cost: "cost_cards",
    project_review: "review_four_blocks",
    light_custom: "product_story",
    creative_custom: "product_story",
    category_matrix: "category_matrix",
    thanks: "thanks_minimal",
    unknown: "structured_summary"
  };
  return {
    layoutStrategy: strategyMap[type] || "structured_summary",
    title,
    sections: buildPlanSections(lines, type),
    cards: buildPlanCards(lines, type)
  };
}

function buildPlanSections(lines, type) {
  if (type === "project_review") return ["问题", "原因", "动作", "经验"].map((label) => ({ label, items: lines.filter((line) => /投诉|交货|免检|临时|现场|风险|确认|周期/.test(line)).slice(0, 3) }));
  if (type === "company_case") return [
    { label: "客户背景", items: lines.filter((line) => /公司|集团|网点|员工|上市|城市|业务/.test(line)).slice(0, 4) },
    { label: "合作关系", items: lines.filter((line) => /中标|项目|合作|案例|服务/.test(line)).slice(0, 3) }
  ];
  if (type === "category_matrix") return ["户外运动", "电子类", "办公类", "家居家纺", "文具文创", "食品健康"].map((label) => ({ label, items: [] }));
  return [{ label: "核心内容", items: lines.slice(0, 5) }];
}

function buildPlanCards(lines, type) {
  if (type === "product_cost" || type === "light_custom" || type === "creative_custom") {
    return lines
      .filter((line) => /预估|报价|成本|元|左右|礼盒/.test(line))
      .slice(0, 8)
      .map((line, index) => ({
        title: line.replace(/(\d+\s*-\s*\d+元|\d+元|\d+\s*左右)/g, "").replace(/预估|报价|成本|左右/g, "").trim().slice(0, 24) || `产品项 ${index + 1}`,
        value: line.match(/(\d+\s*-\s*\d+元|\d+元|\d+\s*左右)/)?.[0] || "",
        note: line.slice(0, 72)
      }));
  }
  return lines.filter((line) => /\d/.test(line)).slice(0, 4).map((line, index) => ({
    title: `关键数据 ${index + 1}`,
    value: line.match(/[\d,.]+[万亿千百余+]*[个家人元]*/)?.[0] || "",
    note: line.slice(0, 56)
  }));
}

function buildAestheticReport(report) {
  const slides = report.slides || [];
  const overallScore = Math.round(slides.reduce((sum, slide) => sum + (slide.diagnosis?.score || 0), 0) / Math.max(1, slides.length));
  const lowScoreSlides = slides.filter((slide) => (slide.diagnosis?.score || 0) < 72).map((slide) => slide.page);
  const highDensitySlides = slides.filter((slide) => slide.diagnosis?.problems?.some((item) => item.type === "density")).map((slide) => slide.page);
  return {
    version: 1,
    deckName: report.deckName,
    slideCount: report.slideCount,
    overallScore,
    lowScoreSlides,
    highDensitySlides,
    slides,
    summary: `${report.slideCount} 页 / 美学诊断 ${overallScore} 分 / 低分页 ${lowScoreSlides.length} 页`
  };
}

export function compactAestheticReport(report) {
  if (!report) return null;
  return {
    version: report.version,
    deckName: report.deckName,
    slideCount: report.slideCount,
    overallScore: report.overallScore,
    lowScoreSlides: report.lowScoreSlides || [],
    highDensitySlides: report.highDensitySlides || [],
    summary: report.summary,
    slides: (report.slides || []).map((slide) => ({
      page: slide.page,
      title: slide.rawText.split(/\s+/).find(Boolean)?.slice(0, 32) || `第 ${slide.page} 页`,
      type: slide.classification?.type || "unknown",
      confidence: slide.classification?.confidence || 0,
      diagnosisScore: slide.diagnosis?.score || 0,
      layoutStrategy: slide.redesign?.layoutStrategy || "",
      metrics: slide.metrics,
      problems: (slide.diagnosis?.problems || []).slice(0, 4),
      suggestions: (slide.diagnosis?.suggestions || []).slice(0, 4)
    }))
  };
}
