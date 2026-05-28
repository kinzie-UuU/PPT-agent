import { getLayoutRecords, getThemeRecord } from "./designSystem.js";

const DEFAULT_OUTLINE = [
  ["cover", "封面", "用一句话说明方案核心价值，搭配产品或品牌视觉。"],
  ["section", "机会背景", "说明场景、用户、节日或业务机会。"],
  ["kpi", "关键数字", "提炼价格、周期、规格、预算或业务指标。"],
  ["cards", "产品卖点", "提炼产品矩阵、价值点和证据。"],
  ["compare", "方案对比", "比较不同套餐、竞品、旧方案和新方案。"],
  ["timeline", "销售节奏", "拆解推荐步骤、交付路径和推进节奏。"],
  ["quote", "核心话术", "沉淀一句销售可直接复述的关键表达。"],
  ["compare", "推荐方案", "给出组合推荐、价格逻辑和销售话术。"],
  ["cards", "执行清单", "列出销售准备、素材补齐、客户沟通要点。"],
  ["closing", "行动建议", "总结下一步动作和交付方式。"]
];

function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
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
  const targetSlides = resolveSlideCount(input.pageCount);
  const brief = normalizeBrief(input.materialBrief);
  const outline = buildFallbackOutline(targetSlides, brief);
  const slides = outline.map((spec, index) => makeFallbackSlide(spec, index, projectName, notes, brief));
  return {
    title: projectName,
    summary: brief.summary || notes,
    slides
  };
}

function buildFallbackOutline(targetSlides, brief) {
  const prefs = brief.preferences || {};
  const richOutline = [
    ["cover", "封面", "用一句话说明方案核心价值，搭配产品或品牌视觉。", "cover"],
    prefs.includeToc !== false && (targetSlides >= 10 || prefs.includeToc) ? ["toc", "目录", "让听众先看到整套战卡的阅读路径。", "toc"] : null,
    ["section", "资料结论", "先把上传资料里的核心机会、价格带和主推方向讲清楚。", "brief"],
    brief.imageHints.length ? ["visual", "产品视觉", "展示上传的产品图、包装图或设计效果图。", "visual"] : null,
    ["pricing", "价格梯度", "用价格带帮助销售快速判断主推组合和客户预算。", "prices"],
    ["product-detail", "单品详情", "把主推礼盒的价格、规格、包装和核心卖点讲透。", "productDetail"],
    ["cards", "主推产品矩阵", "把资料里出现的重点产品拆成可销售的卖点卡片。", "products"],
    ["compare", "产品梯队对比", "比较不同价位、不同定位和不同使用场景。", "compare"],
    ["bundle", "组合推荐", "给出入门、主推和升级的销售组合。", "bundle"],
    ["timeline", "销售推进节奏", "拆解从客户沟通到成交交付的推荐路径。", "timeline"],
    ["quote", "核心销售话术", "沉淀一页销售可直接复述的关键表达。", "pitch"],
    ["cards", "卖点证据", "把高频卖点转成可被客户理解的证据语言。", "highlights"],
    prefs.includeRiskChecklist !== false ? ["risk-checklist", "风险与补齐", "列出素材、报价、库存、周期和口径上的待确认项。", "risks"] : null,
    ["closing", "行动建议", "总结下一步动作和交付方式。", "closing"]
  ].filter(Boolean);
  const base = brief.hasSignal ? richOutline : DEFAULT_OUTLINE.map(([layout, title, body]) => [layout, title, body, layout]);
  if (targetSlides <= base.length) return base.slice(0, targetSlides - 1).concat([base.at(-1)]);
  const extra = [
    ["kpi", "目标拆解", "用关键数字说明销售目标、转化或备货建议。", "target"],
    ["cards", "适用客群", "拆分不同客户类型下的主推组合。", "audience"],
    ["timeline", "交付排期", "说明从确认到交付的关键节点。", "delivery"],
    ["quote", "成交话术", "沉淀一页销售现场可直接使用的话术。", "deal"],
    ["section", "资料补齐", "提示后续需要补充的图片、表格或报价信息。", "material"],
    ["cards", "复盘留存", "为后续版本迭代保留反馈入口和记录结构。", "review"],
    ["compare", "竞品差异", "突出本方案相对竞品或旧方案的优势。", "competitor"],
    ["kpi", "关键规格", "将尺寸、规格、数量和周期抽成一页可扫读信息。", "spec"],
    ["risk-checklist", "交付检查", "把报价、库存、交期和素材确认项列清楚。", "risks"]
  ];
  const middle = DEFAULT_OUTLINE.slice(1, -1);
  const richMiddle = base.slice(1, -1);
  const neededMiddle = targetSlides - 2;
  const expanded = [...richMiddle, ...extra].slice(0, neededMiddle);
  return [base[0], ...expanded, base.at(-1)];
}

function makeFallbackBullets(layout, bullets) {
  const max = layout === "cover" || layout === "quote" ? 2 : layout === "closing" ? 4 : 5;
  return bullets.slice(0, max);
}

function makeFallbackSlide([layout, title, body, kind], index, projectName, notes, brief) {
  const slideTitle = index === 0 ? projectName : title;
  const subtitle = index === 0 ? (compactBriefForCover(brief) || notes).slice(0, 70) : subtitleForKind(kind, brief);
  const bullets = bulletsForKind(kind, body, brief);
  return {
    title: slideTitle,
    subtitle,
    layout,
    visualIntent: body,
    bullets: makeFallbackBullets(layout, bullets),
    speakerNotes: speakerNotesForKind(kind, slideTitle, brief),
    dataPoints: kind === "prices" ? brief.prices : [],
    imageSlots: brief.imageHints
  };
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
      prices.length ? `价格带覆盖：${prices.slice(0, 6).join(" / ")}` : "价格、规格和组合信息待补充",
      highlights.length ? `高频卖点：${highlights.slice(0, 5).join("、")}` : "卖点将按客户可理解语言重写"
    ],
    prices: prices.length ? prices.slice(0, 6).map((price, index) => `${price}：第 ${index + 1} 档预算沟通入口`) : defaults,
    products: products.length ? products.slice(0, 5).map((item) => `${item}：提炼对应客群、卖点和推荐话术`) : defaults,
    visual: [
      products[0] ? `主视觉围绕 ${products[0]} 展开` : "主视觉用于承接上传图片素材",
      highlights[0] ? `画面旁突出 ${highlights[0]} 作为第一卖点` : "画面旁突出包装、规格和适用场景",
      prices[0] ? `可结合 ${prices[0]} 起的价格入口说明` : "补充价格和交付信息"
    ],
    toc: buildTocBullets(brief),
    productDetail: buildProductDetailBullets(brief),
    compare: [
      products[0] && products[1] ? `${products[0]}：适合高意向或高预算客户` : "高端款：承担形象展示和升级成交",
      products[2] ? `${products[2]}：适合大众福利或批量采购` : "基础款：承担覆盖面和性价比",
      highlights[0] ? `差异抓手：${highlights[0]}` : "差异抓手：价格、规格、包装和赠品"
    ],
    timeline: ["确认客户预算与送礼场景", "按价格带推荐主推组合", "补齐图片、规格和交期口径", "输出报价并推进确认"],
    pitch: [
      products[0] ? `主推话术：这款 ${products[0]} 兼顾体面、节日感和成交效率。` : "主推话术：这套方案兼顾体面、节日感和成交效率。",
      highlights[0] ? `证据支撑：资料中 ${highlights[0]} 出现频率最高，可作为第一卖点。` : "证据支撑：用产品、价格和交付确定性支撑推荐。"
    ],
    highlights: highlights.length ? highlights.slice(0, 5).map((item) => `${item}：转成客户可感知的购买理由`) : defaults,
    bundle: buildBundleBullets(brief),
    risks: ["确认最终报价、库存和 MOQ", "补齐产品图、包装图和开盒图", "统一销售话术与禁用表述", "标注交付周期和售后口径"],
    closing: ["确认主推产品与价格带", "补齐图片和报价表", "输出客户版提案", "收集销售反馈继续迭代"]
  };
  return map[kind] || defaults;
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

function buildTocBullets(brief) {
  return [
    "资料结论：价格带、产品和高频卖点",
    "价格梯度：预算入口和套餐分层",
    "单品详情：主推礼盒的规格与卖点",
    "组合推荐：入门、主推、升级",
    "风险清单：报价、库存、交期、素材"
  ];
}

function buildProductDetailBullets(brief) {
  const preferredName = brief.preferences?.primaryProduct || "";
  const productRecord = findPreferredProduct(brief.products, preferredName)
    || brief.products.find((item) => (item.price || item.dimensions?.length) && !/战卡/.test(item.name || ""))
    || brief.products[0];
  const product = productRecord?.name || brief.productCandidates[0] || "主推产品";
  const source = productRecord?.sourcePage ? `资料第 ${productRecord.sourcePage} 页` : brief.productSources[product]?.page ? `资料第 ${brief.productSources[product].page} 页` : "上传资料";
  return [
    `${product}：作为本页主推单品`,
    productRecord?.price ? `价格锚点：${productRecord.price}` : brief.prices.at(-1) ? `价格锚点：${brief.prices.at(-1)} 可作为高端升级入口` : "价格锚点：待补充最终报价",
    productRecord?.dimensions?.[0] ? `规格信息：${productRecord.dimensions[0]}` : "规格信息：待补充尺寸、重量或配置",
    productRecord?.highlights?.[0] ? `核心卖点：${productRecord.highlights[0]} 优先讲` : brief.highlights[0] ? `核心卖点：${brief.highlights[0]} 优先讲` : "核心卖点：包装、规格、送礼场景",
    `来源参考：${source}`,
    productRecord?.recommendation ? `推荐场景：${productRecord.recommendation}` : "销售表达：把规格信息转成客户能理解的购买理由"
  ];
}

function findPreferredProduct(products, preferredName) {
  const target = normalizeProductKey(preferredName);
  if (!target) return null;
  return products.find((item) => {
    const name = normalizeProductKey(item.name);
    return name === target || name.includes(target) || target.includes(name);
  }) || null;
}

function normalizeProductKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[\u00b7.,\u3001\uff0c\u3002:\uff1a;\uff1b'"\u201c\u201d\u2018\u2019()[\]\uff08\uff09\u3010\u3011_-]/g, "")
    .replace(/\u793c\u76d2|\u76d2\u88c5|\u5957\u88c5|\u7aef\u5348|\u7cbd\u5b50|\u7cbd/g, "");
}

function normalizeBrief(brief = {}) {
  const productCandidates = Array.isArray(brief.productCandidates) ? brief.productCandidates.filter(Boolean) : [];
  const prices = Array.isArray(brief.prices) ? brief.prices.filter(Boolean) : [];
  const highlights = Array.isArray(brief.highlights) ? brief.highlights.filter(Boolean) : [];
  const imageHints = Array.isArray(brief.imageHints) ? brief.imageHints.filter(Boolean) : [];
  const productSources = brief.productSources || {};
  const products = Array.isArray(brief.products) ? brief.products.filter(Boolean) : [];
  const preferences = brief.preferences || {};
  return {
    summary: brief.summary || "",
    pageCount: brief.pageCount || null,
    productCandidates,
    prices,
    highlights,
    imageHints,
    productSources,
    products,
    preferences,
    hasSignal: Boolean(brief.summary || productCandidates.length || prices.length || highlights.length || imageHints.length)
  };
}

function speakerNotesForKind(kind, title, brief) {
  const products = brief.productCandidates;
  const prices = brief.prices;
  const highlights = brief.highlights;
  const lines = {
    cover: `开场先点明主题和使用对象，再用一句话说明这份 ${title} 解决什么销售问题。`,
    brief: `先告诉听众系统已读取资料，再强调价格带、主推产品和高频卖点是后续推荐的依据。`,
    prices: prices.length ? `讲价格时从低到高过一遍：${prices.slice(0, 6).join("、")}。重点说明不同预算客户应该怎么切入。` : "讲清价格、周期和预算入口，避免只报数字不解释适用场景。",
    visual: products[0] ? `展示图片时围绕 ${products[0]} 讲包装质感、送礼场景和第一卖点。` : "展示图片时先讲视觉印象，再落到卖点和适用场景。",
    products: products.length ? `逐个介绍主推产品：${products.slice(0, 4).join("、")}。每个产品只讲一个最强购买理由。` : "把产品卖点转成客户能听懂的购买理由。",
    compare: "对比页不要平均用力，先讲推荐项，再解释为什么其他档位适合不同客户。",
    timeline: "按步骤讲推进节奏，重点提示销售下一步要拿到哪些信息、补齐哪些素材。",
    pitch: highlights[0] ? `这页要像销售话术一样讲，围绕 ${highlights[0]} 把一句话说顺。` : "这页要沉淀成销售能直接复述的一句话。",
    highlights: "把高频卖点讲成证据链：资料出现频率、客户感知价值、成交时怎么表达。",
    bundle: "先讲主推组合，再讲入门和升级组合，帮助销售快速匹配客户预算。",
    risks: "提醒销售不要忽略报价、库存、交期、图片和话术口径这些落地风险。",
    closing: "收束时明确下一步动作：确认主推、补齐素材、输出客户版、收集反馈。"
  };
  return lines[kind] || `围绕“${title}”讲清本页结论、证据和下一步动作。`;
}

export async function generateDeckPlan(input, mode) {
  const env = globalThis.process?.env || {};
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    return { deck: fallbackDeck(input), aiUsed: false, warning: "未配置 OPENAI_API_KEY，已使用本地模板生成。" };
  }

  const baseUrl = (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = env.OPENAI_MODEL || "gpt-4.1-mini";
  const theme = getThemeRecord(input.style);
  const layouts = getLayoutRecords();
  const targetSlides = resolveSlideCount(input.pageCount);
  const promptInput = compactPromptInput(input);
  const prompt = [
    "你是资深中文商业 PPT 策划与设计顾问。",
    "请只输出 JSON，不要 Markdown。",
    'JSON 格式：{"title":"...","summary":"...","slides":[{"title":"...","subtitle":"...","layout":"cover|visual|section|toc|kpi|pricing|product-detail|bundle|risk-checklist|compare|timeline|cards|quote|closing","visualIntent":"...","bullets":["...","..."],"speakerNotes":"...","dataPoints":["..."],"imageSlots":["..."]}]}',
    "每页 bullets 2-5 条，语言简洁，销售或汇报可用。",
    `目标页数：${targetSlides} 页。必须尽量接近这个页数，不要只生成 5 页。`,
    `已选主题：${theme.name}。主题气质：${theme.tone.join(" / ")}。适合：${theme.bestFor}。`,
    `可用版式：${layouts.map((layout) => `${layout.id}=${layout.name}(${layout.bestFor}, 最多${layout.maxBullets}条)`).join("；")}`,
    input.materialBrief?.summary ? `资料简报：${input.materialBrief.summary}` : "",
    "layout 规则：第 1 页用 cover；长 deck 可在前部使用 toc；最后一页用 closing 或 quote；有上传图片/包装图/产品效果图时优先安排 visual；多档价格/套餐价格带用 pricing；单品规格/价格/包装/卖点用 product-detail；入门/主推/升级组合用 bundle；报价/库存/交期/素材风险用 risk-checklist；单个关键数字/周期用 kpi；新旧/竞品/套餐差异用 compare；步骤/交付/活动节奏用 timeline；卖点矩阵用 cards；核心话术或结论用 quote。",
    "5 页以上至少使用 3 种 layout；8 页以上至少使用 5 种 layout；不要连续 3 页使用同一种 layout。",
    "不要只堆 bullet，要为每页写 visualIntent，说明这页视觉上应该突出什么。",
    "每页必须写 speakerNotes，给销售或汇报人一段 1-2 句中文讲稿，不要超过 90 字。",
    `任务类型：${mode === "optimize" ? "优化旧 PPT 并重生成新版" : mode === "revise" ? "重写单页内容" : "生成新 PPT"}`,
    `输入：${JSON.stringify(promptInput, null, 2)}`
  ].join("\n");

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "你只输出可解析 JSON。" },
        { role: "user", content: prompt }
      ],
      temperature: 0.5
    })
  });

  if (!response.ok) {
    const message = await response.text();
    return { deck: fallbackDeck(input), aiUsed: false, warning: `AI 调用失败：${message.slice(0, 240)}` };
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || "";
  const parsed = extractJson(content);
  if (!parsed?.slides?.length) {
    return { deck: fallbackDeck(input), aiUsed: false, warning: "AI 返回内容无法解析，已使用本地模板生成。" };
  }
  return { deck: parsed, aiUsed: true };
}

function compactPromptInput(input = {}) {
  const extracted = (input.extracted || []).map((file) => ({
    name: file.name,
    text: compactText(file.text, 5200)
  }));
  return {
    projectName: input.projectName,
    audience: input.audience,
    pageCount: input.pageCount,
    notes: input.notes,
    style: input.style,
    copyMode: input.copyMode,
    materials: input.materials,
    materialBrief: input.materialBrief,
    extracted
  };
}

function compactText(value = "", maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  const head = text.slice(0, Math.floor(maxLength * 0.72));
  const tail = text.slice(-Math.floor(maxLength * 0.18));
  return `${head}\n[中间内容较长，已省略]\n${tail}`;
}

function buildBundleBullets(brief) {
  const records = (brief.products || []).filter((item) => !/战卡/.test(item.name || ""));
  const prices = brief.prices || [];
  const budget = records.find((item) => /大众|批量|预算/.test(item.recommendation || "")) || records.at(0);
  const main = records.find((item) => /健康|员工|养生/.test(item.recommendation || "")) || records.at(1) || records.at(0);
  const premium = records.find((item) => /高端|重要|形象/.test(item.recommendation || "")) || records.at(-1);
  return [
    budget?.name ? `入门组合：${budget.name}${budget.price ? `（${budget.price}）` : ""}` : prices[0] ? `入门组合：从 ${prices[0]} 开始承接基础需求` : "入门组合：承接基础福利需求",
    main?.name ? `主推组合：${main.name}${main.price ? `（${main.price}）` : ""}` : "主推组合：围绕核心产品做销售话术",
    premium?.name ? `升级组合：${premium.name}${premium.price ? `（${premium.price}）` : ""}` : prices.at(-1) ? `升级组合：最高价位 ${prices.at(-1)} 用于高端客户` : "升级组合：用于重要客户或形象展示",
    budget?.recommendation ? `入门适用：${budget.recommendation}` : "入门适用：预算敏感和批量客户",
    main?.recommendation ? `主推适用：${main.recommendation}` : "主推适用：大多数节日福利客户",
    premium?.recommendation ? `升级适用：${premium.recommendation}` : "升级适用：重要客户和高端拜访"
  ];
}

function resolveSlideCount(value = "") {
  const text = String(value);
  if (text.includes("8")) return 8;
  if (text.includes("12")) return 12;
  if (text.includes("19")) return 19;
  return 7;
}

export async function reviseSlide(deck, slideIndex, instruction) {
  const target = deck.slides[slideIndex];
  if (!target) throw new Error("找不到要修改的页面");
  const input = {
    projectName: deck.title,
    notes: [
      `请根据指令重写第 ${slideIndex + 1} 页：${instruction}`,
      "必须保留或重新判断 layout、visualIntent、speakerNotes、dataPoints、imageSlots。",
      "只输出这一页作为 slides[0]，不要输出整套 PPT。"
    ].join("\n"),
    existingSlide: target
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
  if (/价格梯度|价格带/.test(text)) next.layout = "pricing";
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
  const text = String(title || "本页重点").replace(/^第\d+页[:：]?/, "").trim();
  if (/推荐|成交|主推|行动/.test(text)) return text;
  return `${text}：销售主推逻辑`;
}

function makeConversationalNotes(slide) {
  const firstBullet = (slide.bullets || [])[0] || slide.title;
  return `这一页可以这样讲：先说结论“${slide.title}”，再用“${firstBullet}”作为客户能听懂的理由。`;
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
