import { getTemplatePack } from "./designSystem.js";

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
  if (hasOldDeck || Number(materialBrief.pageCount || 0) >= 15) return 19;
  const richMaterial = (materialBrief.products?.length || 0) >= 3
    || (materialBrief.productCandidates?.length || 0) >= 3
    || (materialBrief.prices?.length || 0) >= 3
    || Number(materialBrief.charCount || 0) > 5000;
  return richMaterial ? 12 : 8;
}

function detectDeckType({ mode, input = {}, materialBrief = {}, uploads = [] }) {
  const text = cleanText([input.projectName, input.audience, input.notes, input.copyMode].join(" "));
  const hasOldDeck = mode === "optimize" || uploads.some((file) => /\.(ppt|pptx)$/i.test(file.originalName || file.path || ""));
  const productCount = materialBrief.productCandidates?.length || materialBrief.products?.length || 0;
  const priceCount = materialBrief.prices?.length || 0;
  if (hasOldDeck) return "旧稿优化";
  if (materialBrief.inputStrength === "empty") return "零资料初稿";
  if (materialBrief.inputStrength === "weak") return "弱资料初稿";
  if (hasAny(text, [/客户|提案|方案|汇报给客户/])) return "客户提案";
  if (productCount && priceCount) return "销售战卡";
  if (productCount) return "产品介绍";
  if (priceCount || materialBrief.dimensions?.length || hasAny(text, [/数据|指标|KPI|分析|复盘/])) return "数据汇报";
  return "资料整理";
}

function chooseTheme(input = {}, deckType) {
  if (input.style && !/系统|推荐|auto/i.test(input.style)) return input.style;
  const map = {
    销售战卡: "轻盈渐变风",
    客户提案: "轻盈渐变风",
    产品介绍: "东方自然风",
    数据汇报: "蓝白科技风",
    旧稿优化: "蓝白科技风",
    弱资料初稿: "轻盈渐变风",
    零资料初稿: "黑白画册风",
    资料整理: "黑白画册风"
  };
  return map[deckType] || "轻盈渐变风";
}

function makeStep(layout, title, purpose, kind, options = {}) {
  return {
    layout,
    title,
    purpose,
    kind,
    storyRole: options.storyRole || kind,
    required: Boolean(options.required),
    imageSlots: options.imageSlots || []
  };
}

function dedupeConsecutive(sequence) {
  return sequence.map((step, index) => {
    if (index < 2) return step;
    const a = sequence[index - 1]?.layout;
    const b = sequence[index - 2]?.layout;
    if (step.layout !== a || step.layout !== b) return step;
    return { ...step, layout: step.layout === "cards" ? "quote" : "cards" };
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
  const ranked = middle.map((step, index) => {
    const rank = preferred.indexOf(step.layout);
    return { step, index, rank: rank === -1 ? 999 + index : rank };
  }).sort((a, b) => a.rank - b.rank || a.index - b.index).map((item) => item.step);
  return [first, ...ranked, last].filter(Boolean);
}

function makeTemplateStep(layout, context = {}) {
  const imageSlots = context.imageHints || [];
  const steps = {
    toc: makeStep("toc", "目录", "按模板包给长 deck 提供清晰阅读路径。", "toc", { required: true, storyRole: "阅读路径" }),
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

export function routeDeck({ mode = "generate", input = {}, materialBrief = {}, uploads = [] } = {}) {
  const deckType = detectDeckType({ mode, input, materialBrief, uploads });
  const recommendedTheme = chooseTheme(input, deckType);
  const templatePack = getTemplatePack(input.style || recommendedTheme);
  const targetSlides = resolveTargetSlides(input.pageCount, materialBrief, uploads);
  const imageHints = [
    ...(materialBrief.imageHints || []),
    ...uploads.filter(isImageFile).map((file) => file.originalName || "图片素材")
  ].filter(Boolean).slice(0, 12);
  const hasImages = imageHints.length > 0;
  const hasPrices = (materialBrief.prices || []).length > 0;
  const hasProducts = (materialBrief.productCandidates || []).length > 0 || (materialBrief.products || []).length > 0;
  const manyChoices = (materialBrief.productCandidates?.length || 0) >= 3 || (materialBrief.prices?.length || 0) >= 3;
  const includeRisk = input.includeRiskChecklist !== false;
  const includeToc = targetSlides >= 10 && input.includeToc !== false;
  const inputStrength = materialBrief.inputStrength || "strong";
  const weakOrEmpty = inputStrength === "weak" || inputStrength === "empty";

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
    makeStep("section", "资料结论", "先讲清楚资料里的机会、对象和推荐方向。", "brief", { required: true, storyRole: "问题与机会" }),
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

  const templateReadyBase = ensureTemplateLayouts(base, templatePack, {
    hasPrices,
    imageHints,
    includeRisk,
    includeToc,
    weakOrEmpty
  });
  const layoutSequence = fitSequence(reorderByTemplate(templateReadyBase, templatePack, weakOrEmpty), targetSlides, includeRisk);
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
    storyArc: layoutSequence.map((step) => `${step.index}. ${step.storyRole}: ${step.title}`).join(" → "),
    sections: layoutSequence.map((step) => ({ index: step.index, title: step.title, layout: step.layout, purpose: step.purpose, storyRole: step.storyRole })),
    layoutSequence,
    imageStrategy: {
      hasImages,
      imageCount: imageHints.length,
      imageSlots: imageHints,
      requiredLayouts: hasImages ? ["visual"] : []
    },
    riskStrategy: {
      includeRiskChecklist: includeRisk,
      required: includeRisk,
      reason: includeRisk ? (weakOrEmpty ? "弱资料/零资料必须提示待确认项。" : "默认保留交付风险与待补齐项。") : "用户已取消风险清单。"
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
      hasImages ? `images=${imageHints.length}` : "noImages",
      hasPrices ? `prices=${materialBrief.prices.length}` : "noPrices",
      hasProducts ? `products=${materialBrief.productCandidates?.length || materialBrief.products?.length || 0}` : "noProducts",
      includeRisk ? "riskChecklist=on" : "riskChecklist=off"
    ]
  };
}
