import { getLayoutRecords, getSkillRulePrompt, getTemplatePack, getTemplatePackPrompt, getThemeRecord } from "./designSystem.js";

const FALLBACK_OUTLINE = [
  ["cover", "封面", "用一句话说明方案核心价值。", "cover"],
  ["section", "资料结论", "说明资料里的机会、对象和主推方向。", "brief"],
  ["pricing", "价格梯度", "把价格带转成销售预算入口。", "prices"],
  ["product-detail", "单品详情", "讲清主推产品的规格、价格和卖点。", "productDetail"],
  ["cards", "产品卖点矩阵", "把产品卖点拆成可销售的卡片。", "products"],
  ["compare", "方案对比", "比较不同档位、套餐或使用场景。", "compare"],
  ["timeline", "推进节奏", "拆解销售推进和交付路径。", "timeline"],
  ["quote", "核心话术", "沉淀销售可直接复述的一句话。", "pitch"],
  ["risk-checklist", "风险与补齐", "列出报价、库存、交期、素材和口径确认项。", "risks"],
  ["closing", "行动建议", "总结下一步动作和交付方式。", "closing"]
];

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function extractJson(text = "") {
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

export function fallbackDeck(input = {}) {
  const projectName = input.projectName || "未命名项目";
  const notes = input.notes || "根据上传资料生成一份结构清晰、便于销售或汇报使用的 PPT。";
  const brief = normalizeBrief(input.materialBrief);
  const targetSlides = input.routePlan?.targetSlides || resolveSlideCount(input.pageCount);
  const templatePack = getTemplatePack(input.style || input.routePlan?.recommendedTheme);
  const outline = buildRouteOutline(input.routePlan) || buildFallbackOutline(targetSlides, brief, templatePack);
  const slides = outline.map((spec, index) => makeFallbackSlide(spec, index, projectName, notes, brief));
  return {
    title: projectName,
    summary: brief.summary || notes,
    slides
  };
}

function buildRouteOutline(routePlan) {
  const sequence = routePlan?.layoutSequence;
  if (!Array.isArray(sequence) || !sequence.length) return null;
  return sequence.map((step) => [
    step.layout,
    step.title || step.layout,
    step.purpose || step.visualIntent || step.title || step.layout,
    step.kind || step.layout,
    step.imageSlots || [],
    step.storyRole || step.kind || step.layout
  ]);
}

function buildFallbackOutline(targetSlides, brief, templatePack = null) {
  const base = brief.hasSignal ? [
    ["cover", "封面", "用一句话说明方案核心价值。", "cover"],
    targetSlides >= 10 ? ["toc", "目录", "给长 deck 提供阅读路径。", "toc"] : null,
    ["section", "资料结论", "先把资料里的机会、价格带和主推方向讲清楚。", "brief"],
    brief.imageHints.length ? ["visual", "产品视觉", "展示上传图片、包装图或效果图。", "visual", brief.imageHints] : null,
    brief.prices.length ? ["pricing", "价格梯度", "用价格带帮助销售判断预算入口。", "prices"] : null,
    brief.productCandidates.length ? ["product-detail", "单品详情", "讲清主推产品的规格、价格和卖点。", "productDetail"] : null,
    brief.productCandidates.length ? ["cards", "产品卖点矩阵", "把重点产品拆成可销售的卖点卡片。", "products"] : null,
    ["compare", "产品梯队对比", "比较不同价位、定位和使用场景。", "compare"],
    ["bundle", "组合推荐", "给出入门、主推和升级组合。", "bundle"],
    ["timeline", "销售推进节奏", "拆解客户沟通到成交交付的路径。", "timeline"],
    ["quote", "核心销售话术", "沉淀销售可直接复述的一句话。", "pitch"],
    ["risk-checklist", "风险与补齐", "列出待确认项和交付风险。", "risks"],
    ["closing", "行动建议", "总结下一步动作和交付方式。", "closing"]
  ].filter(Boolean) : FALLBACK_OUTLINE;

  const orderedBase = reorderOutlineByTemplate(base, templatePack, brief.inputStrength === "weak" || brief.inputStrength === "empty");
  if (targetSlides <= orderedBase.length) return orderedBase.slice(0, targetSlides - 1).concat([orderedBase.at(-1)]);
  const extras = [
    ["kpi", "关键数字", "把价格、规格、周期或数量抽成大数字。", "spec"],
    ["cards", "适用客群", "拆分不同客户类型下的主推组合。", "audience"],
    ["timeline", "交付排期", "说明从确认到交付的关键节点。", "delivery"],
    ["quote", "成交话术", "沉淀销售现场可直接使用的话术。", "deal"],
    ["section", "资料补齐", "提示后续需要补充的图片、表格或报价信息。", "material"],
    ["compare", "差异抓手", "突出本方案相对竞品或旧方案的优势。", "competitor"]
  ];
  const middle = [...orderedBase.slice(1, -1), ...extras].slice(0, targetSlides - 2);
  return [orderedBase[0], ...middle, orderedBase.at(-1)];
}

function reorderOutlineByTemplate(outline, templatePack, weakOrEmpty) {
  const preferred = weakOrEmpty ? templatePack?.weakSequence : templatePack?.preferredSequence;
  if (!Array.isArray(preferred) || !preferred.length) return outline;
  const first = outline.find((item) => item?.[0] === "cover") || outline[0];
  const last = outline.find((item) => item?.[0] === "closing") || outline.at(-1);
  const middle = outline.filter((item) => item && item !== first && item !== last);
  const sorted = middle.map((item, index) => {
    const rank = preferred.indexOf(item[0]);
    return { item, index, rank: rank === -1 ? 999 + index : rank };
  }).sort((a, b) => a.rank - b.rank || a.index - b.index).map((entry) => entry.item);
  return [first, ...sorted, last].filter(Boolean);
}

function makeFallbackSlide([layout, title, body, kind, imageSlots = [], storyRole = kind], index, projectName, notes, brief) {
  const slideTitle = index === 0 ? projectName : title;
  return {
    title: slideTitle,
    subtitle: index === 0 ? (compactBriefForCover(brief) || notes).slice(0, 80) : subtitleForKind(kind, brief),
    layout,
    storyRole,
    contentSource: contentSourceForKind(kind, brief),
    visualIntent: body,
    bullets: bulletsForKind(kind, body, brief).slice(0, maxBullets(layout)),
    speakerNotes: speakerNotesForKind(kind, slideTitle, brief),
    dataPoints: kind === "prices" ? brief.prices : [],
    imageSlots: imageSlots.length ? imageSlots : brief.imageHints
  };
}

function maxBullets(layout) {
  if (layout === "cover" || layout === "quote") return 2;
  if (layout === "closing") return 4;
  if (layout === "pricing" || layout === "bundle" || layout === "risk-checklist") return 6;
  return 5;
}

function bulletsForKind(kind, body, brief) {
  const products = brief.productCandidates;
  const prices = brief.prices;
  const highlights = brief.highlights;
  const defaults = [body, "保留关键信息，减少冗余描述。", "使用清晰层级和可编辑版式。"];
  const map = {
    cover: [compactBriefForCover(brief) || body, products[0] ? `主推方向：${products[0]}` : "突出项目核心价值"],
    brief: [
      brief.pageCount ? `资料规模：约 ${brief.pageCount} 页` : "已读取上传资料并提取关键信息",
      prices.length ? `价格带覆盖：${prices.slice(0, 6).join(" / ")}` : "价格、规格和组合信息待补齐",
      highlights.length ? `高频卖点：${highlights.slice(0, 5).join("、")}` : "卖点将按客户可理解语言重写"
    ],
    prices: prices.length ? prices.slice(0, 6).map((price, index) => `${price}：第 ${index + 1} 档预算沟通入口`) : defaults,
    products: products.length ? products.slice(0, 5).map((item) => `${item}：提炼客户、卖点和推荐话术`) : defaults,
    visual: [
      products[0] ? `主视觉围绕 ${products[0]} 展开` : "主视觉承接上传图片素材",
      highlights[0] ? `画面旁突出 ${highlights[0]} 作为第一卖点` : "画面旁突出包装、规格和适用场景",
      prices[0] ? `可结合 ${prices[0]} 起的价格入口说明` : "补充价格和交付信息"
    ],
    toc: ["资料结论", "价格梯度", "单品详情", "组合推荐", "风险清单"],
    productDetail: buildProductDetailBullets(brief),
    compare: [
      products[0] ? `${products[0]}：适合高意向或高预算客户` : "高端档：承担形象展示和升级成交",
      products[1] ? `${products[1]}：适合大众福利或批量采购` : "基础档：承担覆盖面和性价比",
      highlights[0] ? `差异抓手：${highlights[0]}` : "差异抓手：价格、规格、包装和赠品"
    ],
    timeline: ["确认客户预算与送礼场景", "按价格带推荐主推组合", "补齐图片、规格和交期口径", "输出报价并推进确认"],
    pitch: [
      products[0] ? `主推话术：这款 ${products[0]} 兼顾体面、节日感和成交效率。` : "主推话术：这套方案兼顾体面、节日感和成交效率。",
      highlights[0] ? `证据支撑：资料中 ${highlights[0]} 出现频率高，可作为第一卖点。` : "证据支撑：用产品、价格和交付确定性支撑推荐。"
    ],
    bundle: buildBundleBullets(brief),
    assumptions: buildAssumptionBullets(brief),
    audience: [
      "用户输入：围绕当前项目主题和目标对象组织场景",
      "系统推断：可先按客户拜访、员工福利、节日礼赠等场景拆分",
      "待确认：真实购买对象、预算区间和使用渠道"
    ],
    material: buildMissingInfoBullets(brief),
    risks: ["确认最终报价、库存和 MOQ", "补齐产品图、包装图和开盒图", "统一销售话术与禁用表述", "标注交付周期和售后口径"],
    closing: ["确认主推产品与价格带", "补齐图片和报价表", "输出客户版提案", "收集销售反馈继续迭代"]
  };
  return map[kind] || defaults;
}

function buildAssumptionBullets(brief) {
  const topic = brief.productCandidates[0] || "当前项目";
  const fields = brief.confirmationFields || [];
  return [
    `用户输入：已提供 ${topic} 的主题方向${brief.imageHints.length ? `和 ${brief.imageHints.length} 个图片素材` : ""}`,
    "系统推断：可先从视觉质感、使用场景、销售话术三个角度搭建初稿",
    fields.length ? `待确认：${fields.slice(0, 4).join("、")}` : "待确认：价格、规格、库存、交付和品牌口径"
  ];
}

function buildMissingInfoBullets(brief) {
  const fields = brief.confirmationFields || [];
  const fallback = ["产品名称/主推对象", "价格/报价/预算档位", "规格/套餐配置", "正式卖点依据"];
  return (fields.length ? fields : fallback).slice(0, 5).map((item) => `待确认：${item}`);
}

function contentSourceForKind(kind, brief) {
  if (brief.inputStrength === "strong") return "用户资料";
  if (["assumptions", "audience", "material"].includes(kind)) return "系统推断 + 待人工确认";
  if (kind === "prices" && !brief.prices.length) return "待人工确认";
  if (brief.imageHints.length && kind === "visual") return "用户图片";
  return brief.inputStrength === "empty" ? "系统推断 + 待人工确认" : "用户输入 + 系统推断";
}

function buildProductDetailBullets(brief) {
  const product = brief.products[0] || {};
  const name = product.name || brief.productCandidates[0] || "主推产品";
  return [
    `${name}：作为本页主推单品`,
    product.price ? `价格锚点：${product.price}` : brief.prices.at(-1) ? `价格锚点：${brief.prices.at(-1)} 可作高端升级入口` : "价格锚点：待补充最终报价",
    product.dimensions?.[0] ? `规格信息：${product.dimensions[0]}` : "规格信息：待补充尺寸、重量或配置",
    product.highlights?.[0] ? `核心卖点：${product.highlights[0]}` : brief.highlights[0] ? `核心卖点：${brief.highlights[0]}` : "核心卖点：包装、规格、送礼场景",
    product.sourcePage ? `来源参考：资料第 ${product.sourcePage} 页` : "来源参考：上传资料"
  ];
}

function buildBundleBullets(brief) {
  const records = brief.products || [];
  const prices = brief.prices || [];
  const budget = records.find((item) => /大众|批量|预算/.test(item.recommendation || "")) || records[0];
  const main = records.find((item) => /健康|员工|养生/.test(item.recommendation || "")) || records[1] || records[0];
  const premium = records.find((item) => /高端|重要|形象/.test(item.recommendation || "")) || records.at(-1);
  return [
    budget?.name ? `入门组合：${budget.name}${budget.price ? `，${budget.price}` : ""}` : prices[0] ? `入门组合：从 ${prices[0]} 开始承接基础需求` : "入门组合：承接基础福利需求",
    main?.name ? `主推组合：${main.name}${main.price ? `，${main.price}` : ""}` : "主推组合：围绕核心产品做销售话术",
    premium?.name ? `升级组合：${premium.name}${premium.price ? `，${premium.price}` : ""}` : prices.at(-1) ? `升级组合：最高价位 ${prices.at(-1)} 用于高端客户` : "升级组合：用于重要客户或形象展示",
    "销售建议：先问预算和送礼对象，再推荐对应档位"
  ];
}

function compactBriefForCover(brief) {
  return [
    brief.prices.length ? `价格带 ${brief.prices.slice(0, 5).join("/")}` : "",
    brief.productCandidates[0] ? `主推 ${brief.productCandidates[0]}` : "",
    brief.highlights.length ? `卖点 ${brief.highlights.slice(0, 3).join("/")}` : ""
  ].filter(Boolean).join("；") || brief.summary;
}

function subtitleForKind(kind, brief) {
  if (kind === "prices" && brief.prices.length) return `识别到 ${brief.prices.length} 个价格信息`;
  if (kind === "products" && brief.productCandidates.length) return `识别到 ${brief.productCandidates.length} 个候选产品/主题`;
  if (kind === "highlights" && brief.highlights.length) return `高频卖点：${brief.highlights.slice(0, 4).join("、")}`;
  return "";
}

function normalizeBrief(brief = {}) {
  const productCandidates = Array.isArray(brief.productCandidates) ? brief.productCandidates.filter(Boolean) : [];
  const prices = Array.isArray(brief.prices) ? brief.prices.filter(Boolean) : [];
  const highlights = Array.isArray(brief.highlights) ? brief.highlights.filter(Boolean) : [];
  const imageHints = Array.isArray(brief.imageHints) ? brief.imageHints.filter(Boolean) : [];
  const products = Array.isArray(brief.products) ? brief.products.filter(Boolean) : [];
  return {
    summary: brief.summary || "",
    inputStrength: brief.inputStrength || "strong",
    pageCount: brief.pageCount || null,
    productCandidates,
    prices,
    highlights,
    imageHints,
    productSources: brief.productSources || {},
    products,
    preferences: brief.preferences || {},
    missing: brief.missing || {},
    confirmationFields: Array.isArray(brief.confirmationFields) ? brief.confirmationFields.filter(Boolean) : [],
    hasSignal: Boolean(brief.summary || productCandidates.length || prices.length || highlights.length || imageHints.length)
  };
}

function speakerNotesForKind(kind, title, brief) {
  const products = brief.productCandidates;
  const prices = brief.prices;
  const highlights = brief.highlights;
  const lines = {
    cover: `开场先点明主题和使用对象，再用一句话说明这份「${title}」解决什么销售问题。`,
    brief: "先告诉听众系统已读取资料，再强调价格带、主推产品和高频卖点是后续推荐依据。",
    prices: prices.length ? `讲价格时从低到高过一遍：${prices.slice(0, 6).join("、")}。重点说明不同预算客户怎么切入。` : "讲清价格、周期和预算入口，避免只报数字不解释场景。",
    visual: products[0] ? `展示图片时围绕 ${products[0]} 讲包装质感、送礼场景和第一卖点。` : "展示图片时先讲视觉印象，再落到卖点和适用场景。",
    products: products.length ? `逐个介绍主推产品：${products.slice(0, 4).join("、")}。每个产品只讲一个最强购买理由。` : "把产品卖点转成客户能听懂的购买理由。",
    compare: "对比页不要平均用力，先讲推荐项，再解释为什么其他档位适合不同客户。",
    timeline: "按步骤讲推进节奏，重点提示销售下一步要拿到哪些信息、补齐哪些素材。",
    pitch: highlights[0] ? `这一页要像销售话术一样讲，围绕 ${highlights[0]} 把一句话说顺。` : "这一页要沉淀成销售能直接复述的一句话。",
    bundle: "先讲主推组合，再讲入门和升级组合，帮助销售快速匹配客户预算。",
    risks: "提醒销售不要忽略报价、库存、交期、图片和话术口径这些落地风险。",
    closing: "收束时明确下一步动作：确认主推、补齐素材、输出客户版、收集反馈。"
  };
  return lines[kind] || `围绕「${title}」讲清本页结论、证据和下一步动作。`;
}

export async function generateDeckPlan(input, mode) {
  const env = globalThis.process?.env || {};
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    return { deck: fallbackDeck(input), aiUsed: false, warning: "未配置 OPENAI_API_KEY，已使用本地模板生成。", provider: { configured: false } };
  }

  const baseUrl = (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = env.OPENAI_MODEL || "gpt-4.1-mini";
  const provider = { configured: true, baseUrl, model };
  const theme = getThemeRecord(input.style || input.routePlan?.recommendedTheme);
  const templatePack = getTemplatePack(input.style || input.routePlan?.recommendedTheme);
  const templatePackPrompt = getTemplatePackPrompt(input.style || input.routePlan?.recommendedTheme);
  const layouts = getLayoutRecords();
  const skillRulePrompt = getSkillRulePrompt();
  const routePlan = input.routePlan || null;
  const styleReferences = Array.isArray(input.styleReferences) ? input.styleReferences.slice(0, 12) : [];
  const targetSlides = routePlan?.targetSlides || resolveSlideCount(input.pageCount);
  const promptInput = compactPromptInput(input);
  const prompt = [
    "你是资深中文商业 PPT 策划与设计顾问。",
    "请只输出可解析 JSON，不要 Markdown，不要解释。",
    "JSON 格式：{\"title\":\"...\",\"summary\":\"...\",\"slides\":[{\"title\":\"...\",\"subtitle\":\"...\",\"layout\":\"cover|visual|section|toc|kpi|pricing|product-detail|bundle|risk-checklist|compare|timeline|cards|quote|closing\",\"storyRole\":\"...\",\"contentSource\":\"用户输入|用户资料|用户图片|系统推断|待人工确认|系统推断 + 待人工确认\",\"visualIntent\":\"...\",\"bullets\":[\"...\"],\"speakerNotes\":\"...\",\"dataPoints\":[\"...\"],\"imageSlots\":[\"...\"]}]}",
    "像 Gamma 一样先组织故事线，再写每页内容：封面结论 → 问题/机会 → 方案 → 证据/产品 → 价格/选择 → 风险 → 行动。",
    "每页必须有明确 storyRole，并服务整套 deck 的递进关系；不要做成资料堆砌。",
    "生成原则：每页只讲一个主信息；标题短而具体；避免空泛词；不要编造资料里没有的产品、价格、规格。",
    "标题要像商业 PPT 的页标题，优先写结论句，例如“39 元档承接批量福利需求”，不要写“产品介绍”“优势分析”这类空标题。",
    "每页 bullet 控制在 2-4 条；每条尽量短，能被直接放进 PPT 页面。",
    "弱资料/零资料规则：可以生成可编辑初稿，但必须把推断内容写成“系统推断”或“待确认”，不要假装已有资料证明。",
    "禁止伪造具体价格、规格、库存、交期、认证、品牌承诺；缺失时写“待确认：价格/规格/库存/交期”。",
    "如果有图片素材，必须把相关文件名写入 imageSlots，并安排 visual 或 product-detail 类页面承接图片。",
    input.materialBrief?.inputStrength ? `资料强度：${input.materialBrief.inputStrength}。` : "",
    input.materialBrief?.confirmationFields?.length ? `必须提示这些待确认字段：${input.materialBrief.confirmationFields.join("、")}` : "",
    `目标页数：${targetSlides} 页。必须尽量接近这个页数，不要只生成 5 页。`,
    `已选主题：${theme.name}。气质：${theme.tone.join(" / ")}。适合：${theme.bestFor}。`,
    `已选模板包：${templatePack.name}。适用场景：${templatePack.scenario}。`,
    `可用版式：${layouts.map((layout) => `${layout.id}=${layout.name}(${layout.bestFor}，最多 ${layout.maxBullets} 条)`).join("；")}`,
    templatePackPrompt ? `模板包规则（必须遵守）：\n${templatePackPrompt}` : "",
    skillRulePrompt ? `PPT 技能规则：\n${skillRulePrompt}` : "",
    styleReferences.length ? `风格参考库（需要内化到调性里，不要直接复制图片内容）：\n${styleReferences.map((item, index) => `${index + 1}. ${item.name || item.originalName || "风格参考"}：${item.tone || "参考色彩、留白、质感和版式密度"}${item.styleFingerprint?.prompt ? `；本地风格指纹：${item.styleFingerprint.prompt}` : ""}`).join("\n")}` : "",
    routePlan?.styleReferenceStrategy?.fingerprint?.prompt ? `风格库综合指纹：${routePlan.styleReferenceStrategy.fingerprint.prompt}` : "",
    routePlan?.styleReferenceStrategy?.instruction ? `风格参考策略：${routePlan.styleReferenceStrategy.instruction}` : "",
    routePlan?.aestheticPlan ? `PPT 美学分层系统（必须遵守）：背景层只服务文字可读性；文字安全区不能被底图、产品图或装饰遮挡；每页 visualIntent 要体现 pagePlans 中的 background/text/image/ornament 分层。\n${JSON.stringify(routePlan.aestheticPlan, null, 2)}` : "",
    input.styleProofConfirmation ? `已确认风格样张（完整 PPT 必须继承其调性，并避开样稿质检指出的问题）：\n${JSON.stringify(input.styleProofConfirmation, null, 2)}` : "",
    routePlan?.storyArc ? `推荐故事线（必须遵守）：${routePlan.storyArc}` : "",
    routePlan ? `智能路由结果（必须遵守页数、顺序、layout、purpose、storyRole）：\n${JSON.stringify(routePlan, null, 2)}` : "",
    input.materialBrief?.summary ? `资料简报：${input.materialBrief.summary}` : "",
    "必须写 speakerNotes，每页 1-2 句中文讲稿，不超过 90 字。",
    "pricing 页要把 dataPoints 填成价格项；visual 页要把 imageSlots 填成相关图片名；risk-checklist 页要写待确认项。",
    `任务类型：${mode === "optimize" ? "优化旧 PPT 并生成新版本" : mode === "revise" ? "重写单页内容" : "生成新 PPT"}`,
    `输入：${JSON.stringify(promptInput, null, 2)}`
  ].filter(Boolean).join("\n");

  let result;
  try {
    result = await fetchOpenAiCompatible(baseUrl, "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "你只输出可解析 JSON。" },
          { role: "user", content: prompt }
        ],
        temperature: 0.45
      })
    });
  } catch (error) {
    return { deck: fallbackDeck(input), aiUsed: false, warning: `AI 连接失败：${error.message}`, provider };
  }

  const response = result.response;
  const usedBaseUrl = stripEndpoint(result.url, "/chat/completions");
  if (!response.ok) {
    const message = await readProviderError(response);
    return { deck: fallbackDeck(input), aiUsed: false, warning: `AI 调用失败：${message}`, provider: { ...provider, baseUrl: usedBaseUrl, status: response.status } };
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    return { deck: fallbackDeck(input), aiUsed: false, warning: `AI 返回不是 JSON，已使用本地模板生成：${error.message}`, provider: { ...provider, baseUrl: usedBaseUrl } };
  }
  const content = data.choices?.[0]?.message?.content || "";
  const parsed = extractJson(content);
  if (!parsed?.slides?.length) {
    return { deck: fallbackDeck(input), aiUsed: false, warning: "AI 返回内容无法解析，已使用本地模板生成。", provider: { ...provider, baseUrl: usedBaseUrl } };
  }
  return { deck: parsed, aiUsed: true, provider: { ...provider, baseUrl: usedBaseUrl, usage: data.usage || null } };
}

async function fetchOpenAiCompatible(baseUrl, endpoint, options) {
  const errors = [];
  for (const candidate of getCompatibleBaseUrls(baseUrl)) {
    const url = `${candidate}${endpoint}`;
    try {
      const response = await fetch(url, options);
      if (response.ok && isJsonResponse(response)) return { response, url };
      errors.push({ response, url });
      if (response.ok || ![404, 405].includes(response.status)) continue;
    } catch (error) {
      errors.push({ error, url });
    }
  }
  const last = errors.at(-1);
  if (last?.response) return last;
  throw new Error(last?.error?.message || "连接失败，请检查 Base URL。");
}

function getCompatibleBaseUrls(baseUrl) {
  const normalized = String(baseUrl || "https://api.openai.com/v1").trim().replace(/\/$/, "");
  const candidates = [normalized];
  if (!/\/v\d+(\/|$)/.test(normalized)) candidates.push(`${normalized}/v1`);
  return [...new Set(candidates)];
}

function isJsonResponse(response) {
  return /application\/json/i.test(response.headers.get("content-type") || "");
}

function stripEndpoint(url, endpoint) {
  return String(url || "").endsWith(endpoint) ? String(url).slice(0, -endpoint.length) : String(url || "").replace(/\/$/, "");
}

async function readProviderError(response) {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  if (/application\/json/i.test(contentType)) {
    try {
      const data = JSON.parse(text);
      return data.error?.message || data.message || text.slice(0, 240);
    } catch {
      return text.slice(0, 240);
    }
  }
  if (/^\s*</.test(text)) return "服务返回了网页而不是 JSON，请检查 Base URL 是否需要 /v1。";
  return text.slice(0, 240);
}

function compactPromptInput(input = {}) {
  return {
    projectName: input.projectName,
    audience: input.audience,
    pageCount: input.pageCount,
    notes: input.notes,
    style: input.style,
    copyMode: input.copyMode,
    materials: input.materials,
    materialBrief: input.materialBrief,
    styleProofConfirmation: input.styleProofConfirmation,
    extracted: (input.extracted || []).map((file) => ({ name: file.name, text: compactText(file.text, 5200) }))
  };
}

function compactText(value = "", maxLength) {
  const text = cleanText(value);
  if (text.length <= maxLength) return text;
  const head = text.slice(0, Math.floor(maxLength * 0.72));
  const tail = text.slice(-Math.floor(maxLength * 0.18));
  return `${head}\n[中间内容较长，已省略]\n${tail}`;
}

function resolveSlideCount(value = "") {
  const text = String(value);
  if (text.includes("8")) return 8;
  if (text.includes("12")) return 12;
  if (text.includes("19")) return 19;
  return 8;
}

export async function reviseSlide(deck, slideIndex, instruction) {
  const target = deck.slides[slideIndex];
  if (!target) throw new Error("找不到要修改的页面。");
  const input = {
    projectName: deck.title,
    notes: [
      `请根据指令重写第 ${slideIndex + 1} 页：${instruction}`,
      "必须保留或重新判断 layout、visualIntent、speakerNotes、dataPoints、imageSlots。",
      "只输出这一页作为 slides[0]，不要输出整套 PPT。"
    ].join("\n"),
    existingSlide: target,
    pageCount: "1页"
  };
  const result = await generateDeckPlan(input, "revise");
  const generated = result.aiUsed ? result.deck.slides?.[0] || {} : reviseSlideLocally(target, instruction);
  const nextSlide = normalizeRevisedSlide(target, generated);
  const nextDeck = { ...deck, slides: deck.slides.map((slide, index) => (index === slideIndex ? nextSlide : slide)) };
  return { deck: nextDeck, aiUsed: result.aiUsed, warning: result.warning };
}

function reviseSlideLocally(target, instruction = "") {
  const text = String(instruction || "");
  const next = { ...target };
  if (/价格梯度|价格带|报价/.test(text)) next.layout = "pricing";
  if (/主视觉|产品图|包装图|图片/.test(text)) next.layout = "visual";
  if (/对比/.test(text)) next.layout = "compare";
  if (/流程|节奏|时间线/.test(text)) next.layout = "timeline";
  if (/标题.*销售|销售化/.test(text)) next.title = salesTitle(next.title);
  if (/减少文字|更高级|更简洁/.test(text)) next.bullets = (next.bullets || []).slice(0, Math.max(2, Math.min(3, (next.bullets || []).length)));
  if (/讲稿|口语/.test(text)) next.speakerNotes = makeConversationalNotes(next);
  if (/下一步|行动/.test(text)) {
    next.bullets = [...(next.bullets || []).slice(0, 3), "明确下一步：确认版本、补齐素材、推进报价。"];
    next.speakerNotes = "这一页最后要落到行动：谁确认、补什么、什么时候给客户下一版。";
  }
  next.visualIntent = next.visualIntent || "根据修改指令优化页面表达。";
  return next;
}

function salesTitle(title = "") {
  const text = cleanText(title).replace(/^第\d+页[:：]?/, "");
  if (/推荐|成交|主推|行动/.test(text)) return text;
  return `${text || "本页重点"}：销售主推逻辑`;
}

function makeConversationalNotes(slide) {
  const firstBullet = (slide.bullets || [])[0] || slide.title;
  return `这一页可以这样讲：先说结论「${slide.title}」，再用「${firstBullet}」作为客户能听懂的理由。`;
}

function normalizeRevisedSlide(previous, generated) {
  return {
    ...previous,
    ...generated,
    title: generated.title || previous.title,
    subtitle: generated.subtitle ?? previous.subtitle,
    layout: generated.layout || previous.layout,
    visualIntent: generated.visualIntent || previous.visualIntent,
    speakerNotes: generated.speakerNotes || previous.speakerNotes,
    bullets: Array.isArray(generated.bullets) && generated.bullets.length ? generated.bullets : previous.bullets,
    dataPoints: Array.isArray(generated.dataPoints) ? generated.dataPoints : previous.dataPoints,
    imageSlots: Array.isArray(generated.imageSlots) ? generated.imageSlots : previous.imageSlots
  };
}
