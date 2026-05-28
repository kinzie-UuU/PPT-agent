import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const layoutSystem = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "design-system", "layouts.json"), "utf8"));

const layouts = new Map(layoutSystem.layouts.map((layout) => [layout.id, layout]));
const fallbackSequence = ["cover", "section", "cards", "kpi", "compare", "timeline", "quote", "closing"];

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clampText(value, maxLength) {
  const text = cleanText(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function chooseLayout(slide, index, total) {
  if (index === 0) return "cover";
  if (index === total - 1) return "closing";
  const text = [slide.title, slide.subtitle, ...(slide.bullets || []), ...(slide.imageSlots || [])].join(" ");
  if ((slide.imageSlots || []).length || /图片|包装图|产品图|效果图|开盒图|实物图/.test(text)) return "visual";
  if ((text.match(/\d+\s*元/g) || []).length >= 3 || /价格梯度|价格带|套餐|预算入口/.test(text)) return "pricing";
  if (/目录|章节|阅读路径|toc/i.test(text)) return "toc";
  if (/单品|规格|礼盒详情|包装|主推礼盒/.test(text)) return "product-detail";
  if (/组合|入门|主推|升级|套餐/.test(text)) return "bundle";
  if (/风险|检查|库存|交期|报价|素材|口径/.test(text)) return "risk-checklist";
  if (/[0-9]|%|％|¥|￥|元|万|MOQ|周期|天|周/.test(text)) return "kpi";
  if (/对比|相比|竞品|之前|之后|before|after/i.test(text)) return "compare";
  if (/流程|步骤|节奏|时间|交付|计划|里程碑/.test(text)) return "timeline";
  if (/话术|结论|原则|一句话|takeaway/i.test(text)) return "quote";
  return fallbackSequence[index % fallbackSequence.length] || "cards";
}

export function validateDeck(deck = {}) {
  const warnings = [];
  const slides = Array.isArray(deck.slides) ? deck.slides : [];
  if (!slides.length) warnings.push("deck.slides 为空，已由 fallback 流程补齐。");

  const normalizedSlides = slides.map((slide, index) => {
    const next = { ...slide };
    const layout = layouts.has(next.layout) ? next.layout : chooseLayout(next, index, slides.length);
    if (next.layout && !layouts.has(next.layout)) warnings.push(`第 ${index + 1} 页使用了未知 layout "${next.layout}"，已改为 ${layout}。`);
    if (!next.layout) warnings.push(`第 ${index + 1} 页缺少 layout，已自动推断为 ${layout}。`);

    const title = clampText(next.title, 40) || `第 ${index + 1} 页`;
    if (title.length > 32) warnings.push(`第 ${index + 1} 页标题偏长，建议继续压缩。`);

    const maxBullets = layouts.get(layout)?.maxBullets || 5;
    const bullets = (Array.isArray(next.bullets) ? next.bullets : [])
      .map((item) => clampText(item, layout === "cover" || layout === "quote" ? 76 : 92))
      .filter(Boolean)
      .slice(0, maxBullets);
    if ((next.bullets || []).length > maxBullets) warnings.push(`第 ${index + 1} 页 bullet 超过 ${maxBullets} 条，已截断以保护版式。`);

    return {
      ...next,
      title,
      subtitle: clampText(next.subtitle, 88),
      layout,
      visualIntent: cleanText(next.visualIntent),
      speakerNotes: clampText(next.speakerNotes || `讲清“${title}”这一页的核心结论、证据和下一步动作。`, 110),
      bullets
    };
  });

  if (normalizedSlides[0] && normalizedSlides[0].layout !== "cover") {
    normalizedSlides[0].layout = "cover";
    warnings.push("首页已强制设为 cover。");
  }
  if (normalizedSlides.length > 1 && !["closing", "quote"].includes(normalizedSlides.at(-1).layout)) {
    normalizedSlides[normalizedSlides.length - 1].layout = "closing";
    warnings.push("末页已强制设为 closing。");
  }

  const usedLayouts = new Set(normalizedSlides.map((slide) => slide.layout));
  if (normalizedSlides.length >= 5 && usedLayouts.size < 3) warnings.push("版式变化偏少，建议至少覆盖 3 种 layout。");

  const nextDeck = {
      title: cleanText(deck.title) || "未命名项目",
      summary: cleanText(deck.summary),
      slides: normalizedSlides
    };

  return {
    deck: nextDeck,
    warnings,
    quality: buildQualityReport(nextDeck, warnings)
  };
}

export function buildQualityReport(deck = {}, warnings = []) {
  const slides = Array.isArray(deck.slides) ? deck.slides : [];
  const layoutCounts = {};
  for (const slide of slides) layoutCounts[slide.layout || "unknown"] = (layoutCounts[slide.layout || "unknown"] || 0) + 1;
  const bulletCount = slides.reduce((sum, slide) => sum + (slide.bullets || []).length, 0);
  const imageSlotCount = slides.reduce((sum, slide) => sum + (slide.imageSlots || []).length, 0);
  return {
    slideCount: slides.length,
    layoutCounts,
    usedLayouts: Object.keys(layoutCounts),
    bulletCount,
    averageBullets: slides.length ? Number((bulletCount / slides.length).toFixed(1)) : 0,
    imageSlotCount,
    warningCount: warnings.length,
    warnings,
    risks: buildDesignRisks(slides, layoutCounts)
  };
}

function buildDesignRisks(slides, layoutCounts) {
  const risks = [];
  if (slides.length >= 10 && !layoutCounts.toc) risks.push("长 deck 建议增加目录页。");
  if ((layoutCounts.visual || 0) > 0 && slides.some((slide) => slide.layout === "visual" && !(slide.imageSlots || []).length)) risks.push("存在主视觉页但缺少图片槽位。");
  if ((layoutCounts.pricing || 0) > 0 && slides.some((slide) => slide.layout === "pricing" && !/元|¥|￥/.test([...(slide.bullets || []), ...(slide.dataPoints || [])].join(" ")))) risks.push("价格页缺少明确价格。");
  if (!slides.every((slide) => slide.speakerNotes)) risks.push("部分页面缺少讲稿备注。");
  const maxRepeat = Math.max(0, ...Object.values(layoutCounts));
  if (slides.length >= 8 && maxRepeat > Math.ceil(slides.length / 2)) risks.push("版式重复偏多，建议增加变化。");
  return risks;
}
