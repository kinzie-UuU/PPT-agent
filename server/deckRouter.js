import { getTemplatePack } from "./designSystem.js";
import { summarizeStyleFingerprints } from "./styleFingerprint.js";
import { buildAestheticPlan } from "./aestheticSystem.js";
import { applyTemplateReusePlan, buildTemplateReusePlan } from "./templateReuse.js";

const EXPLICIT_SLIDE_COUNTS = [
  { pattern: /8/, count: 8 },
  { pattern: /12/, count: 12 },
  { pattern: /19/, count: 19 }
];

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function hasAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function isImageFile(file = {}) {
  return /\.(png|jpe?g|svg|webp)$/i.test(file.originalName || file.path || "") || /^image\//.test(file.mimeType || "");
}

function resolveTargetSlides(pageCount, materialBrief = {}, uploads = []) {
  const text = String(pageCount || "");
  const explicit = EXPLICIT_SLIDE_COUNTS.find((item) => item.pattern.test(text));
  if (explicit) return explicit.count;
  if (materialBrief.inputStrength === "weak") return 9;
  if (materialBrief.inputStrength === "empty") return 8;
  const hasOldDeck = uploads.some((file) => /\.(ppt|pptx)$/i.test(file.originalName || file.path || ""));
  const sourcePageCount = Number(materialBrief.pageCount || 0);
  if (hasOldDeck && sourcePageCount) return Math.max(6, Math.min(24, sourcePageCount));
  if (hasOldDeck || sourcePageCount >= 15) return 19;
  const richMaterial = (materialBrief.products?.length || 0) >= 3
    || (materialBrief.productCandidates?.length || 0) >= 3
    || (materialBrief.prices?.length || 0) >= 3
    || Number(materialBrief.charCount || 0) > 5000;
  return richMaterial ? 12 : 8;
}

function detectDeckType({ mode, input = {}, materialBrief = {}, uploads = [] }) {
  const text = cleanText([input.projectName, input.audience, input.notes, input.copyMode].join(" "));
  const hasOldDeck = mode === "optimize" || uploads.some((file) => /\.(ppt|pptx)$/i.test(file.originalName || file.path || ""));
  if (isDesignLed(input)) return inferDesignLedDeckType({ text, materialBrief, hasOldDeck });
  const productCount = materialBrief.productCandidates?.length || materialBrief.products?.length || 0;
  const priceCount = materialBrief.prices?.length || 0;
  if (hasOldDeck) return "旧稿优化";
  if (materialBrief.inputStrength === "empty") return "轻量资料整理";
  if (materialBrief.inputStrength === "weak") return "轻量资料整理";
  if (hasAny(text, [/客户|提案|方案|汇报给客户/])) return "客户提案";
  if (productCount && priceCount) return "销售战卡";
  if (productCount) return "产品介绍";
  if (priceCount || materialBrief.dimensions?.length || hasAny(text, [/数据|指标|KPI|分析|复盘/])) return "数据汇报";
  return "轻量资料整理";
}

function chooseTheme(input = {}, deckType) {
  if (input.style && !/系统|推荐|auto/i.test(input.style)) return input.style;
  const map = {
    销售战卡: "轻盈渐变风",
    客户提案: "轻盈渐变风",
    产品介绍: "东方自然风",
    数据汇报: "蓝白科技风",
    旧稿优化: "蓝白科技风",
    轻量资料整理: "黑白画册风"
  };
  return map[deckType] || "轻盈渐变风";
}

function isDesignLed(input = {}) {
  return input.designDirectorMode
    || input.designPriority === "visual-first"
    || input.reconstructionMode === "design-led"
    || /设计优先|视觉优先|提案级|高级设计|高设计感|重构/i.test([input.copyMode, input.notes].join(" "));
}

function inferDesignLedDeckType({ text = "", materialBrief = {}, hasOldDeck = false } = {}) {
  const combined = cleanText([text, materialBrief.summary, (materialBrief.pages || []).map((page) => `${page.title || ""} ${page.text || ""}`).join(" ")].join(" "));
  if (/案例|作品集|portfolio|客户|提案|定制|能力展示/i.test(combined)) return "案例作品集 / 销售提案";
  if (/品牌|画册|手册|形象|视觉/i.test(combined)) return "品牌画册 / 视觉手册";
  if (/产品|礼盒|单品|SKU|卖点|价格|报价/i.test(combined)) return "产品提案 / 销售战卡";
  if (/数据|指标|KPI|复盘|分析|报告/i.test(combined)) return "数据汇报 / 分析报告";
  return hasOldDeck ? "旧稿设计重构" : "设计型提案";
}

function makeStep(layout, title, purpose, kind, options = {}) {
  return {
    layout,
    title,
    purpose,
    kind,
    storyRole: options.storyRole || kind,
    required: Boolean(options.required),
    imageSlots: options.imageSlots || [],
    sourceType: options.sourceType || inferStepSourceType(kind, options),
    sourceLabel: options.sourceLabel || inferStepSourceLabel(kind, options),
    evidence: options.evidence || "",
    needsConfirmation: Boolean(options.needsConfirmation),
    sourceSlideType: options.sourceSlideType || "",
    diagnosisScore: Number.isFinite(Number(options.diagnosisScore)) ? Number(options.diagnosisScore) : null,
    layoutStrategy: options.layoutStrategy || ""
  };
}

function inferStepSourceType(kind = "", options = {}) {
  if (options.sourceType) return options.sourceType;
  if (kind === "source") return "original-ppt";
  if (["prices", "products", "productDetail", "visual", "compare", "bundle", "spec"].includes(kind)) return "extracted";
  if (["risks", "assumptions"].includes(kind)) return "needs-confirmation";
  return "inferred";
}

function inferStepSourceLabel(kind = "", options = {}) {
  const sourceType = inferStepSourceType(kind, options);
  if (sourceType === "original-ppt") return "来自原 PPT";
  if (sourceType === "extracted") return "来自资料抽取";
  if (sourceType === "needs-confirmation") return "待人工确认";
  return "AI 推断";
}

function dedupeConsecutive(sequence) {
  const alternates = ["cards", "kpi", "compare", "quote", "timeline", "product-detail", "risk-checklist"];
  return sequence.map((step, index) => {
    if (index < 2) return step;
    const a = sequence[index - 1]?.layout;
    const b = sequence[index - 2]?.layout;
    if (step.layout !== a || step.layout !== b) return step;
    const nextLayout = alternates.find((layout) => layout !== step.layout && layout !== a) || "cards";
    return makeTemplateStep(nextLayout, { includeRisk: true }) || { ...step, layout: nextLayout };
  });
}

function fitSequence(sequence, targetSlides, includeRisk) {
  const extras = [
    makeStep("cards", "适用客群", "拆分客户类型和推荐入口。", "audience", { storyRole: "受众与场景" }),
    makeStep("timeline", "交付节奏", "说明确认、报价、备货和交付节点。", "delivery", { storyRole: "落地路径" }),
    makeStep("quote", "成交话术", "沉淀销售现场能直接复述的一句话。", "deal", { storyRole: "销售表达" }),
    makeStep("compare", "差异抓手", "说明不同档位或竞品之间的关键差异。", "competitor", { storyRole: "差异证明" }),
    makeStep("kpi", "关键规格", "把价格、尺寸、数量或周期抽成可扫读信息。", "spec", { storyRole: "关键证据" }),
    makeStep("section", "资料补齐", "提示后续需要补充的素材和确认项。", "material", { storyRole: "风险补齐" })
  ];
  const closing = sequence.at(-1);
  let middle = sequence.slice(1, -1);
  let extraIndex = 0;
  while (middle.length < targetSlides - 2) {
    const next = extras[extraIndex % extras.length];
    if (next.layout === "risk-checklist" && !includeRisk) {
      extraIndex += 1;
      continue;
    }
    middle.push(next);
    extraIndex += 1;
  }
  if (middle.length > targetSlides - 2) {
    const slots = targetSlides - 2;
    const selected = middle.slice(0, slots);
    const requiredOverflow = middle.slice(slots).filter((step) => step.required);
    for (const requiredStep of requiredOverflow) {
      const replaceIndex = selected.map((step) => Boolean(step.required)).lastIndexOf(false);
      if (replaceIndex === -1) break;
      selected[replaceIndex] = requiredStep;
    }
    middle = selected;
  }
  return dedupeConsecutive([sequence[0], ...middle, closing]).map((step, index) => ({ ...step, index: index + 1 }));
}

function reorderByTemplate(sequence, templatePack, weakOrEmpty) {
  const preferred = weakOrEmpty ? templatePack?.weakSequence : templatePack?.preferredSequence;
  if (!Array.isArray(preferred) || !preferred.length) return sequence;
  const first = sequence.find((step) => step.layout === "cover") || sequence[0];
  const last = sequence.find((step) => step.layout === "closing") || sequence.at(-1);
  const middle = sequence.filter((step) => step !== first && step !== last);
  const ranked = middle
    .map((step, index) => {
      const rank = preferred.indexOf(step.layout);
      return { step, index, rank: rank === -1 ? 999 + index : rank };
    })
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((item) => item.step);
  return [first, ...ranked, last].filter(Boolean);
}

function makeTemplateStep(layout, context = {}) {
  const imageSlots = context.imageHints || [];
  const steps = {
    toc: makeStep("toc", "目录", "为长 deck 提供清晰阅读路径。", "toc", { required: true, storyRole: "阅读路径" }),
    visual: makeStep("visual", "视觉主张", "承接图片、截图或关键视觉素材，建立第一印象。", "visual", { imageSlots, storyRole: "第一印象" }),
    kpi: makeStep("kpi", "关键指标", "把价格、规格、成本、阶段或效果转成可扫读指标。", "spec", { storyRole: "关键证据" }),
    compare: makeStep("compare", "方案对比", "比较不同方案、档位、前后状态或能力差异。", "compare", { storyRole: "差异证明" }),
    timeline: makeStep("timeline", "推进路径", "说明阶段、节奏、交付或验证步骤。", "timeline", { storyRole: "落地路径" }),
    bundle: makeStep("bundle", "组合推荐", "给出入门、主推和升级组合。", "bundle", { storyRole: "推荐方案" }),
    pricing: makeStep("pricing", context.hasPrices ? "价格梯度" : "价格/规格待补齐", context.hasPrices ? "用价格带帮助判断预算入口。" : "明确价格、规格、MOQ、交期等需要人工补齐。", "prices", { storyRole: context.hasPrices ? "预算决策" : "待确认信息" }),
    "product-detail": makeStep("product-detail", "产品详情", "讲清主推产品的规格、卖点、场景和待确认信息。", "productDetail", { storyRole: "方案证据" }),
    cards: makeStep("cards", "核心要点", "把卖点、场景或假设拆成可编辑卡片。", "points", { storyRole: "卖点证明" }),
    quote: makeStep("quote", "核心话术", "沉淀一页可直接复述的销售或汇报表达。", "pitch", { storyRole: "表达锚点" }),
    "risk-checklist": makeStep("risk-checklist", "风险与待确认", "列出数据、价格、素材、授权和交付边界。", "risks", { storyRole: "风险控制" }),
    section: makeStep("section", "资料结论", "先讲清资料里的机会、对象和推荐方向。", "brief", { storyRole: "问题与机会" })
  };
  return steps[layout] || null;
}

function ensureTemplateLayouts(sequence, templatePack, context = {}) {
  const preferred = context.weakOrEmpty ? templatePack?.weakSequence : templatePack?.preferredSequence;
  if (!Array.isArray(preferred) || !preferred.length) return sequence;
  const next = [...sequence];
  const insertBeforeClosing = () => {
    const closingIndex = next.findIndex((step) => step.layout === "closing");
    return closingIndex === -1 ? next.length : closingIndex;
  };
  for (const layout of preferred) {
    if (layout === "cover" || layout === "closing") continue;
    if (layout === "toc" && !context.includeToc) continue;
    if (layout === "risk-checklist" && !context.includeRisk) continue;
    if (next.some((step) => step.layout === layout)) continue;
    const step = makeTemplateStep(layout, context);
    if (step) next.splice(insertBeforeClosing(), 0, step);
  }
  return next;
}

function inferSourceLayout(page = {}, index = 0) {
  const sourceTypeMap = {
    cover: "cover",
    agenda: "toc",
    company_case: "cards",
    product_cost: "pricing",
    project_review: "risk-checklist",
    light_custom: "product-detail",
    creative_custom: "product-detail",
    category_matrix: "compare",
    thanks: "closing"
  };
  if (page.sourceSlideType && sourceTypeMap[page.sourceSlideType]) return sourceTypeMap[page.sourceSlideType];
  const text = cleanText(`${page.title || ""} ${page.text || ""}`);
  if (index === 0) return "cover";
  if (/目录|contents/i.test(text)) return "toc";
  if (/价格|报价|预算|预估|元|MOQ|金额/.test(text)) return "pricing";
  if (/风险|投诉|问题|周期|交付|库存|确认/.test(text)) return "risk-checklist";
  if (/对比|差异|竞品|方案A|方案B/.test(text)) return "compare";
  if (/流程|路径|进度|阶段|时间|交付/.test(text)) return "timeline";
  if (/案例|客户|品牌|背景|介绍/.test(text)) return "cards";
  if (/产品|礼盒|套装|单品|规格|定制/.test(text)) return "product-detail";
  return index % 3 === 0 ? "cards" : "section";
}

function buildSourceOutline(materialBrief = {}, targetSlides = 12, context = {}) {
  const pages = Array.isArray(materialBrief.pages) ? materialBrief.pages.filter((page) => cleanText(`${page.title || ""} ${page.text || ""}`).length > 3) : [];
  if (!context.hasOldDeck && pages.length < 3) return null;
  if (!pages.length) return null;
  const limit = Math.min(targetSlides, pages.length);
  return pages.slice(0, limit).map((page, index) => {
    const layout = inferSourceLayout(page, index);
    const title = cleanText(page.title || `第 ${page.page || index + 1} 页`);
    const purpose = index === 0
      ? "保留原稿主题，重新梳理封面表达和视觉层级。"
      : `基于原稿第 ${page.page || index + 1} 页内容重排，优化文字层级、信息密度和版式。`;
    return makeStep(layout, title, purpose, "source", {
      required: true,
      storyRole: context.hasOldDeck ? "原稿重排" : "资料页提炼",
      sourceType: context.hasOldDeck ? "original-ppt" : "extracted",
      sourceLabel: context.hasOldDeck ? "来自原 PPT" : "来自资料抽取",
      evidence: `第 ${page.page || index + 1} 页${page.title ? `：${page.title}` : ""}`,
      imageSlots: context.imagesBySlide?.[page.page || index + 1] || [],
      sourceSlideType: page.sourceSlideType || "",
      diagnosisScore: page.diagnosisScore,
      layoutStrategy: page.layoutStrategy || ""
    });
  });
}

export function routeDeck({ mode = "generate", input = {}, materialBrief = {}, uploads = [] } = {}) {
  const deckType = detectDeckType({ mode, input, materialBrief, uploads });
  const styleReferences = Array.isArray(input.styleReferences) ? input.styleReferences.slice(0, 12) : [];
  const styleFingerprintSummary = summarizeStyleFingerprints(styleReferences);
  const recommendedTheme = chooseTheme(input, deckType);
  const templatePack = getTemplatePack(recommendedTheme);
  let targetSlides = resolveTargetSlides(input.pageCount, materialBrief, uploads);
  const hasOldDeck = mode === "optimize" || uploads.some((file) => /\.(ppt|pptx)$/i.test(file.originalName || file.path || ""));
  const imageHints = [
    ...(materialBrief.imageHints || []),
    ...uploads.filter(isImageFile).map((file) => file.originalName || "图片素材")
  ].filter(Boolean).slice(0, 12);
  const imagesBySlide = uploads
    .filter((file) => Number(file.sourceSlide || 0) > 0)
    .reduce((map, file) => {
      const slide = Number(file.sourceSlide);
      map[slide] = [...(map[slide] || []), file.originalName || file.path || ""].filter(Boolean);
      return map;
    }, {});
  const hasImages = imageHints.length > 0;
  const hasPrices = (materialBrief.prices || []).length > 0;
  const hasProducts = (materialBrief.productCandidates || []).length > 0 || (materialBrief.products || []).length > 0;
  const manyChoices = (materialBrief.productCandidates?.length || 0) >= 3 || (materialBrief.prices?.length || 0) >= 3;
  const includeRisk = input.includeRiskChecklist !== false;
  const includeToc = targetSlides >= 10 && input.includeToc !== false;
  const inputStrength = materialBrief.inputStrength || "strong";
  const weakOrEmpty = inputStrength === "weak" || inputStrength === "empty";
  const outlineStrategy = input.outlineStrategy || (hasOldDeck ? "keep-source" : "auto");
  const shouldUseSourceOutline = hasOldDeck ? outlineStrategy !== "regenerate" : outlineStrategy === "keep-source";

  const base = weakOrEmpty ? [
    makeStep("cover", "封面", "用一句话说明这份初稿的目标和适用对象。", "cover", { required: true, storyRole: "结论先行" }),
    hasImages ? makeStep("visual", "产品/主视觉", "把上传图片作为第一视觉素材，先建立产品印象。", "visual", { required: true, imageSlots: imageHints, storyRole: "第一印象" }) : null,
    makeStep("section", "初步判断", "基于项目名称和一句话需求，说明系统对主题、对象和场景的初步判断。", "brief", { required: true, storyRole: "问题与机会" }),
    makeStep("cards", "卖点假设", "把可合理推断的卖点写成待确认假设，避免伪造具体事实。", "assumptions", { required: true, storyRole: "系统推断" }),
    makeStep("cards", "适用场景", "拆分可能的客户、使用场景或销售沟通入口。", "audience", { storyRole: "受众与场景" }),
    makeStep("pricing", hasPrices ? "价格梯度" : "价格/规格待补齐", hasPrices ? "用已有价格带帮助判断预算入口。" : "明确价格、规格、MOQ、交期等需要人工补齐。", "prices", { required: true, storyRole: hasPrices ? "预算决策" : "待确认信息" }),
    makeStep("quote", "核心话术", "沉淀一页销售可直接复述的表达。", "pitch", { storyRole: "销售表达" }),
    includeRisk ? makeStep("risk-checklist", "风险与待确认", "列出价格、产品名、规格、库存、图片授权和口径确认项。", "risks", { required: true, storyRole: "风险控制" }) : null,
    makeStep("closing", "下一步行动", "总结需要补齐的信息和下一轮成稿动作。", "closing", { required: true, storyRole: "下一步行动" })
  ].filter(Boolean) : [
    makeStep("cover", "封面", "用一句话说明项目核心价值。", "cover", { required: true, storyRole: "结论先行" }),
    includeToc ? makeStep("toc", "目录", "给长 deck 提供阅读路径。", "toc", { required: true, storyRole: "阅读路径" }) : null,
    makeStep("section", "资料结论", "先讲清资料里的机会、对象和推荐方向。", "brief", { required: true, storyRole: "问题与机会" }),
    hasImages ? makeStep("visual", "产品视觉", "优先展示上传图片、包装图或效果图。", "visual", { required: true, imageSlots: imageHints, storyRole: "第一印象" }) : null,
    hasPrices ? makeStep("pricing", "价格梯度", "用价格带帮助销售判断预算入口。", "prices", { required: true, storyRole: "预算决策" }) : null,
    hasProducts ? makeStep("product-detail", "单品详情", "讲清主推产品的规格、价格和卖点。", "productDetail", { required: true, storyRole: "方案证据" }) : null,
    hasProducts ? makeStep("cards", "产品卖点矩阵", "把重点产品拆成可销售的卖点卡片。", "products", { required: true, storyRole: "卖点证明" }) : null,
    manyChoices ? makeStep("compare", "产品梯队对比", "比较不同价位、定位和使用场景。", "compare", { storyRole: "选择理由" }) : null,
    manyChoices ? makeStep("bundle", "组合推荐", "给出入门、主推和升级组合。", "bundle", { storyRole: "推荐方案" }) : null,
    makeStep("timeline", "推进节奏", "拆解客户沟通到成交交付的路径。", "timeline", { storyRole: "落地路径" }),
    makeStep("quote", "核心话术", "沉淀一页销售可直接复述的表达。", "pitch", { storyRole: "销售表达" }),
    includeRisk ? makeStep("risk-checklist", "风险与补齐", "列出报价、库存、交期、素材和口径确认项。", "risks", { required: true, storyRole: "风险控制" }) : null,
    makeStep("closing", "行动建议", "总结下一步动作和交付方式。", "closing", { required: true, storyRole: "下一步行动" })
  ].filter(Boolean);

  const sourceBase = shouldUseSourceOutline
    ? buildSourceOutline(materialBrief, targetSlides, { hasOldDeck, imagesBySlide })
    : null;
  const templateReadyBase = sourceBase || ensureTemplateLayouts(base, templatePack, {
    hasPrices,
    imageHints,
    includeRisk,
    includeToc,
    weakOrEmpty
  });
  const orderedBase = sourceBase ? templateReadyBase : reorderByTemplate(templateReadyBase, templatePack, weakOrEmpty);
  const rawLayoutSequence = fitSequence(orderedBase, targetSlides, includeRisk);
  const templateReusePlan = buildTemplateReusePlan(rawLayoutSequence, materialBrief.sourceReport || null);
  const layoutSequence = applyTemplateReusePlan(rawLayoutSequence, templateReusePlan);
  const sourceIntegrity = buildSourceIntegrity(materialBrief.sourceReport || null);
  const aestheticPlan = buildAestheticPlan({
    style: input.style || recommendedTheme,
    deckType,
    layoutSequence,
    sourceReport: materialBrief.sourceReport || null,
    styleReferences,
    materialBrief,
    uploads
  });
  return {
    deckType,
    inputStrength,
    targetSlides,
    recommendedTheme,
    templatePack: {
      slug: templatePack.slug,
      name: templatePack.name,
      scenario: templatePack.scenario,
      coreLayouts: templatePack.coreLayouts
    },
    styleReferenceStrategy: {
      count: styleReferences.length,
      names: styleReferences.map((item) => item.name || item.originalName).filter(Boolean).slice(0, 8),
      tone: styleReferences.map((item) => item.tone).filter(Boolean).join("；").slice(0, 420),
      fingerprint: styleFingerprintSummary,
      instruction: styleReferences.length
        ? "生成时参考风格参考库的色彩、留白、质感、字体气质和画面密度；不要复制图片内容本身。"
        : "未提供自定义风格参考，使用内置主题和设计方向规则。"
    },
    storyArc: layoutSequence.map((step) => `${step.index}. ${step.storyRole}: ${step.title}`).join(" → "),
    sections: layoutSequence.map((step) => ({ index: step.index, title: step.title, layout: step.layout, purpose: step.purpose, storyRole: step.storyRole })),
    layoutSequence,
    sourceReport: materialBrief.sourceReport || null,
    sourceIntegrity,
    templateReusePlan,
    designDirectorStrategy: isDesignLed(input) ? {
      typeJudgement: "设计优先重构：先判断内容类型，再抽取视觉 DNA，再按页面角色选择可编辑版式。",
      visualDnaPolicy: ["从上传资料或风格参考中抽主色、背景、字体气质、图片语言和装饰克制程度", "没有明确品牌时选择最适合受众的高级视觉系统，不硬编码客户品牌"],
      pageRolePolicy: ["每页只承载一个主信息", "图片/图表/证据优先成为视觉主角", "标题必须是结论句", "正文压缩到 2-4 条", "页面布局按角色变化，避免整套同一种卡片"],
      deliveryPolicy: ["输出可编辑 PPTX", "文字、图片、形状保持独立对象", "本地素材处理优先，云端只做兜底", "视觉自检不通过则返工"]
    } : null,
    imageStrategy: {
      hasImages,
      imageCount: imageHints.length,
      imageSlots: imageHints,
      requiredLayouts: hasImages ? ["visual", "product-detail", "bundle"] : []
    },
    aestheticPlan,
    riskStrategy: {
      includeRiskChecklist: includeRisk,
      required: includeRisk,
      reason: includeRisk ? (weakOrEmpty ? "弱资料或零资料需要提示待确认项。" : "默认保留交付风险与待补齐项。") : "用户已取消风险清单。"
    },
    missingInfo: {
      ...(materialBrief.missing || {}),
      confirmationFields: materialBrief.confirmationFields || []
    },
    routingReasons: [
      `deckType=${deckType}`,
      `templatePack=${templatePack.slug}`,
      `inputStrength=${inputStrength}`,
      `targetSlides=${targetSlides}`,
      `outlineStrategy=${outlineStrategy}`,
      sourceIntegrity ? `sourceIntegrity=${sourceIntegrity.status}` : "sourceIntegrity=none",
      styleReferences.length ? `styleRefs=${styleReferences.length}` : "noStyleRefs",
      hasImages ? `images=${imageHints.length}` : "noImages",
      hasPrices ? `prices=${materialBrief.prices.length}` : "noPrices",
      hasProducts ? `products=${materialBrief.productCandidates?.length || materialBrief.products?.length || 0}` : "noProducts",
      includeRisk ? "riskChecklist=on" : "riskChecklist=off"
    ]
  };
}

function buildSourceIntegrity(sourceReport = null) {
  if (!sourceReport?.hasOldDeck) return null;
  const audit = sourceReport.extractionAudit || {};
  const cloud = sourceReport.cloudSourceAnalysis || {};
  const warnings = [
    ...(sourceReport.warnings || []),
    ...(audit.warnings || []),
    ...(cloud.findings || [])
  ].filter(Boolean);
  const blocking = [
    Number(audit.missingImageRefs || 0) > 0 ? "missing-image-media" : "",
    cloud.status === "block" ? "cloud-source-block" : ""
  ].filter(Boolean);
  const status = blocking.length ? "block" : warnings.length || cloud.status === "warn" || audit.confidence === "medium" ? "warn" : "pass";
  return {
    status,
    confidence: cloud.confidence || audit.confidence || "medium",
    textCoverage: {
      pages: sourceReport.pageCount || 0,
      textPages: sourceReport.textPageCount || 0,
      auditTextSlides: audit.textSlideCount || 0,
      auditSlides: audit.slideCount || 0
    },
    imageCoverage: {
      extractedImages: sourceReport.extractedImageCount || 0,
      boundImages: sourceReport.boundImageCount || 0,
      embeddedImageRefs: audit.embeddedImageRefs || 0,
      linkedImageRefs: audit.linkedImageRefs || 0,
      missingImageRefs: audit.missingImageRefs || 0
    },
    cloudUsed: Boolean(cloud.used),
    cloudStatus: cloud.status || "not-run",
    blocking,
    warnings: warnings.slice(0, 10)
  };
}
