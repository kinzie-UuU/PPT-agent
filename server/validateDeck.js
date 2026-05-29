import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const layoutSystem = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "design-system", "layouts.json"), "utf8"));
const layouts = new Map(layoutSystem.layouts.map((layout) => [layout.id, layout]));
const fallbackSequence = ["cover", "section", "cards", "kpi", "compare", "timeline", "quote", "closing"];

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clampText(value, maxLength) {
  const text = cleanText(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function toList(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  return String(value)
    .split(/\r?\n|[。；;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function chooseLayout(slide, index, total) {
  if (index === 0) return "cover";
  if (index === total - 1) return "closing";
  const bullets = toList(slide.bullets);
  const dataPoints = toList(slide.dataPoints);
  const imageSlots = toList(slide.imageSlots);
  const text = [slide.title, slide.subtitle, ...bullets, ...dataPoints, ...imageSlots].join(" ");
  if (imageSlots.length || /图片|包装图|产品图|效果图|开盒图|实物图/.test(text)) return "visual";
  if ((text.match(/[¥￥]?\d+(?:\.\d+)?\s*元/g) || []).length >= 2 || /价格|报价|预算|套餐|梯度/.test(text)) return "pricing";
  if (/目录|章节|阅读路径|toc/i.test(text)) return "toc";
  if (/单品|规格|礼盒详情|包装|主推/.test(text)) return "product-detail";
  if (/组合|入门|主推|升级|套餐/.test(text)) return "bundle";
  if (/风险|检查|库存|交期|报价|素材|口径/.test(text)) return "risk-checklist";
  if (/[0-9]|%|％|¥|￥|元|MOQ|周期|天|周/.test(text)) return "kpi";
  if (/对比|相比|竞品|之前|之后|before|after/i.test(text)) return "compare";
  if (/流程|步骤|节奏|时间|交付|计划|里程碑/.test(text)) return "timeline";
  if (/话术|结论|原则|一句话|takeaway/i.test(text)) return "quote";
  return fallbackSequence[index % fallbackSequence.length] || "cards";
}

export function validateDeck(deck = {}, routePlan = null) {
  const warnings = [];
  const slides = Array.isArray(deck.slides) ? deck.slides : [];
  if (!slides.length) warnings.push("deck.slides 为空，已由 fallback 流程补齐。");

  const normalizedSlides = slides.map((slide, index) => {
    const next = { ...slide };
    const layout = layouts.has(next.layout) ? next.layout : chooseLayout(next, index, slides.length);
    if (next.layout && !layouts.has(next.layout)) warnings.push(`第 ${index + 1} 页使用未知 layout "${next.layout}"，已改为 ${layout}。`);
    if (!next.layout) warnings.push(`第 ${index + 1} 页缺少 layout，已自动推断为 ${layout}。`);

    const title = clampText(next.title, 40) || `第 ${index + 1} 页`;
    if (cleanText(next.title).length > 40) warnings.push(`第 ${index + 1} 页标题过长，已压缩。`);

    const rawBullets = toList(next.bullets);
    const maxBullets = layouts.get(layout)?.maxBullets || 5;
    const bullets = rawBullets
      .map((item) => clampText(item, layout === "cover" || layout === "quote" ? 76 : 92))
      .filter(Boolean)
      .slice(0, maxBullets);
    if (rawBullets.length > maxBullets) warnings.push(`第 ${index + 1} 页 bullet 超过 ${maxBullets} 条，已截断以保护版式。`);

    return {
      ...next,
      title,
      subtitle: clampText(next.subtitle, 88),
      storyRole: clampText(next.storyRole, 28),
      contentSource: clampText(next.contentSource, 40),
      layout,
      visualIntent: cleanText(next.visualIntent),
      speakerNotes: clampText(next.speakerNotes || `讲清「${title}」这一页的核心结论、证据和下一步动作。`, 120),
      dataPoints: toList(next.dataPoints).map((item) => clampText(item, 72)).filter(Boolean).slice(0, 8),
      imageSlots: toList(next.imageSlots).filter(Boolean).slice(0, 8),
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

  const routeReport = buildRouteReport(normalizedSlides, routePlan);
  warnings.push(...routeReport.routingWarnings);

  const nextDeck = {
    title: cleanText(deck.title) || "未命名项目",
    summary: cleanText(deck.summary),
    slides: normalizedSlides
  };

  return {
    deck: nextDeck,
    warnings,
    quality: buildQualityReport(nextDeck, warnings, routeReport)
  };
}

export function buildQualityReport(deck = {}, warnings = [], routeReport = null) {
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
    routeAdherence: routeReport?.routeAdherence || null,
    routingWarnings: routeReport?.routingWarnings || [],
    risks: buildDesignRisks(slides, layoutCounts)
  };
}

function buildRouteReport(slides = [], routePlan = null) {
  if (!routePlan?.layoutSequence?.length) return { routeAdherence: null, routingWarnings: [] };
  const expected = routePlan.layoutSequence.map((step) => step.layout);
  const actual = slides.map((slide) => slide.layout);
  const routingWarnings = [];
  let matched = 0;
  const compared = Math.min(expected.length, actual.length);
  for (let index = 0; index < compared; index += 1) {
    if (expected[index] === actual[index]) matched += 1;
  }
  if (actual.length !== expected.length) routingWarnings.push(`智能路由期望 ${expected.length} 页，当前为 ${actual.length} 页。`);
  expected.forEach((layout, index) => {
    if (actual[index] && actual[index] !== layout) routingWarnings.push(`第 ${index + 1} 页偏离智能路由：期望 ${layout}，实际 ${actual[index]}。`);
  });
  const usedLayouts = new Set(actual);
  if (slides.length >= 8 && usedLayouts.size < 5) routingWarnings.push("智能路由自检：8 页以上建议至少 5 种 layout。");
  for (let index = 2; index < actual.length; index += 1) {
    if (actual[index] === actual[index - 1] && actual[index] === actual[index - 2]) {
      routingWarnings.push(`智能路由自检：第 ${index - 1}-${index + 1} 页连续使用 ${actual[index]}。`);
      break;
    }
  }
  if (routePlan.imageStrategy?.hasImages && !slides.some((slide) => slide.layout === "visual" && toList(slide.imageSlots).length)) {
    routingWarnings.push("智能路由自检：有图片素材，但缺少带 imageSlots 的 visual 页。");
  }
  if (expected.includes("pricing") && !slides.some((slide) => slide.layout === "pricing" && /\d/.test([...toList(slide.bullets), ...toList(slide.dataPoints)].join(" ")))) {
    routingWarnings.push("智能路由自检：路由包含 pricing，但价格页缺少明确数字。");
  }
  return {
    routingWarnings,
    routeAdherence: {
      expectedLayouts: expected,
      actualLayouts: actual,
      matched,
      total: expected.length,
      score: expected.length ? Number((matched / expected.length).toFixed(2)) : 1
    }
  };
}

function buildDesignRisks(slides, layoutCounts) {
  const risks = [];
  if (slides.length >= 10 && !layoutCounts.toc) risks.push("长 deck 建议增加目录页。");
  if ((layoutCounts.visual || 0) > 0 && slides.some((slide) => slide.layout === "visual" && !toList(slide.imageSlots).length)) risks.push("存在主视觉页但缺少图片槽位。");
  if ((layoutCounts.pricing || 0) > 0 && slides.some((slide) => slide.layout === "pricing" && !/[¥￥]?\d/.test([...toList(slide.bullets), ...toList(slide.dataPoints)].join(" ")))) risks.push("价格页缺少明确价格。");
  if (!slides.every((slide) => slide.speakerNotes)) risks.push("部分页面缺少讲稿备注。");
  const maxRepeat = Math.max(0, ...Object.values(layoutCounts));
  if (slides.length >= 8 && maxRepeat > Math.ceil(slides.length / 2)) risks.push("版式重复偏多，建议增加变化。");
  return risks;
}
