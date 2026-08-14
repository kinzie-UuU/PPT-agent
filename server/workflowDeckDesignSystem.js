const ROLE_ALIASES = new Map([
  ["cover", "cover"],
  ["opening", "cover"],
  ["封面", "cover"],
  ["agenda", "agenda"],
  ["目录", "agenda"],
  ["section", "section"],
  ["section divider", "section"],
  ["章节", "section"],
  ["visual", "visual"],
  ["image", "visual"],
  ["cards", "content"],
  ["content", "content"],
  ["quote", "quote"],
  ["timeline", "process"],
  ["process", "process"],
  ["compare", "comparison"],
  ["comparison", "comparison"],
  ["pricing", "table"],
  ["data", "table"],
  ["table", "table"],
  ["product", "product"],
  ["summary", "summary"],
  ["closing", "closing"],
  ["q&a", "closing"],
  ["qa", "closing"]
]);

const ROLE_TYPOGRAPHY = Object.freeze({
  cover: { titlePt: [48, 60], subtitlePt: [22, 30], bodyPt: [18, 24], labelPt: [11, 16] },
  agenda: { titlePt: [34, 42], subtitlePt: [18, 24], bodyPt: [18, 24], labelPt: [11, 15] },
  section: { titlePt: [40, 50], subtitlePt: [20, 28], bodyPt: [18, 24], labelPt: [11, 15] },
  visual: { titlePt: [30, 40], subtitlePt: [18, 24], bodyPt: [17, 23], labelPt: [10, 15] },
  content: { titlePt: [30, 38], subtitlePt: [18, 24], bodyPt: [17, 23], labelPt: [10, 15] },
  quote: { titlePt: [32, 44], subtitlePt: [18, 24], bodyPt: [20, 30], labelPt: [10, 15] },
  process: { titlePt: [30, 38], subtitlePt: [18, 24], bodyPt: [16, 22], labelPt: [10, 14] },
  comparison: { titlePt: [30, 38], subtitlePt: [18, 24], bodyPt: [16, 22], labelPt: [10, 14] },
  product: { titlePt: [30, 40], subtitlePt: [18, 24], bodyPt: [16, 22], labelPt: [10, 14] },
  table: { titlePt: [24, 32], subtitlePt: [16, 22], bodyPt: [13, 19], labelPt: [9, 13] },
  summary: { titlePt: [32, 42], subtitlePt: [18, 24], bodyPt: [17, 23], labelPt: [10, 15] },
  closing: { titlePt: [40, 52], subtitlePt: [20, 28], bodyPt: [17, 23], labelPt: [10, 15] }
});

const PLACEHOLDER_PATTERNS = [
  /^your\s*(?:brand|logo|company|name)$/i,
  /^(?:brand|company)\s*name$/i,
  /^(?:add|insert|type)\s+(?:a\s+)?(?:title|subtitle|text|heading)$/i,
  /^(?:title|subtitle|sample|placeholder)\s*(?:text|here)?$/i,
  /^(?:lorem\s+ipsum|dummy\s+text)/i,
  /^(?:待填写|请输入|添加标题|添加文本|公司名称|品牌名称|示例文字)$/i
];

const PAGE_MARKER_PATTERNS = [
  /^(?:slide|page)\s*[.:#-]?\s*0*\d{1,3}(?:\s*[\/.|-]\s*0*\d{1,3})?[.。]?$/i,
  /^第\s*0*\d{1,3}\s*页(?:\s*[\/.|-]\s*共?\s*0*\d{1,3}\s*页?)?$/i,
  /^0*\d{1,3}\s*[\/|·-]\s*0*\d{1,3}$/,
  /^0*\d{1,3}\s*\/\s*共?\s*0*\d{1,3}\s*页?$/i
];

const CJK_CLOSING_RE = /(?:^|\s)(?:谢谢(?:观看|聆听)?|感谢聆听|感谢观看|致谢|答疑|问答|联系我们|结束)(?:\s|$|[，。！!：:|])/i;
const ENGLISH_CLOSING_LABEL_RE = /^(?:closing(?:\s+remarks)?|thank\s*you|thanks|q\s*&\s*a|questions?|the\s*end|contact\s*us)(?:\s*[|丨｜/·•:：—-]\s*(?:us|end|q\s*&\s*a|[\u3400-\u9fff]{1,4})){0,2}\s*[|丨｜/·•:：—-]?$/i;

const STRICT_CJK_CLOSING_RE = /(?:^|\s)(?:\u8c22\u8c22(?:\u89c2\u770b|\u8046\u542c)?|\u611f\u8c22\u8046\u542c|\u611f\u8c22\u89c2\u770b|\u81f4\u8c22|(?:\u9879\u76ee)?\u7b54\u7591(?:\u73af\u8282)?|\u95ee\u7b54(?:\u73af\u8282)?|\u8054\u7cfb\u6211\u4eec|\u7ed3\u675f)(?:\s|$|[\uff0c\u3002\uff01\uff1f!?,])/i;
const STRICT_ENGLISH_CLOSING_RE = /^(?:closing(?:\s+remarks)?|thank\s*you|thanks|q\s*&\s*a|questions?|the\s*end|contact\s*us)(?:\s*[|\u4e28\uff5c/\u00b7\u2014\uff1a:\u2013-]\s*(?:us|end|q\s*&\s*a)){0,2}\s*[|\u4e28\uff5c/\u00b7\u2014\uff1a:\u2013-]?\s*[!\uff01?\uff1f.\u3002]*$/i;

export function normalizeDeckPageRole(value = "") {
  const clean = cleanText(value).toLowerCase();
  if (!clean) return "content";
  if (ROLE_ALIASES.has(clean)) return ROLE_ALIASES.get(clean);
  for (const [alias, role] of ROLE_ALIASES.entries()) {
    if (clean.includes(alias)) return role;
  }
  return "content";
}

export function isTemplatePlaceholderText(value = "") {
  const text = cleanText(value).replace(/[：:。.!！]+$/g, "");
  return Boolean(text && PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(text)));
}

export function isPageMarkerText(value = "") {
  const text = cleanText(value);
  return Boolean(text && PAGE_MARKER_PATTERNS.some((pattern) => pattern.test(text)));
}

export function classifyDeckText(value = "") {
  const text = cleanText(value);
  if (!text) return "empty";
  if (isTemplatePlaceholderText(text)) return "placeholder";
  if (/^(?:slide|page|section|chapter)$/i.test(text)) return "template_chrome";
  if (/^(?:slide|page)\s*\d{1,3}\b/i.test(text)) return "template_chrome";
  if (isPageMarkerText(text)) return "page_number";
  if (/^(?:https?:\/\/|www\.)|^[\w.+-]+@[\w.-]+\.[a-z]{2,}$|(?:^|\s)[a-z0-9][a-z0-9.-]*\.(?:com|cn|net|org|io|ai|co|biz|info)(?=$|[\s/，。；;：:,])/i.test(text)) return "contact";
  if (/[¥￥$€£]|\d[\d,.]*\s*(?:%|‰|元|万元|亿元|万|亿|年|月|日|天|人|套|件|台|个|kg|g|mm|cm|m|ml|l|pcs?)|^\d[\d,.]*$/i.test(text)) return "data";
  if (/^[A-Z][A-Z0-9&+._-]{2,}(?:\s+[A-Z0-9&+._-]{2,}){0,3}$/.test(text)) return "brand_or_code";
  if (/^(?:[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+|[a-z]+[A-Z][A-Za-z0-9]*)$/.test(text)) return "brand_or_code";
  if (isLikelyCjkBrandText(text)) return "brand_or_code";
  if (/^[\u3400-\u9fff]{2,8}(?:\u6280\u672f|\u79d1\u6280)$/.test(text)) return "brand_candidate";
  return "content";
}

export function isSemanticClosingText(value = "") {
  const text = cleanText(value);
  if (!text) return false;
  return STRICT_ENGLISH_CLOSING_RE.test(text) || STRICT_CJK_CLOSING_RE.test(text);
}

export function isClosingLabelText(value = "") {
  const text = cleanText(value);
  if (!text) return false;
  return ENGLISH_CLOSING_LABEL_RE.test(text) || CJK_CLOSING_RE.test(text);
}

export function inferDeckPageRole(page = {}, options = {}) {
  const pageNumber = Number(page.pageNumber || options.pageNumber || 0);
  const totalPages = Number(options.totalPages || 0);
  const preferExplicitRole = options.preferExplicitRole !== false;
  const ignoreExplicitRole = options.ignoreExplicitRole === true;
  const explicit = normalizeDeckPageRole(page.layout || page.role || page.storyRole || "");
  const ocrText = Array.isArray(page.ocrText) ? page.ocrText.filter(Boolean) : [];
  const textParts = [
    page.title,
    page.outlineTitle,
    page.textPreview,
    page.text,
    page.outlinePurpose,
    page.outlineEvidence,
    page.visualIntent,
    ...ocrText
  ].filter(Boolean);
  const text = textParts.join(" ");
  const textChars = Number(page.textChars || cleanText(text).length || 0);
  const imageCount = Number(page.imageCount || 0);
  const denseTable = hasDenseTableSignals(page, text);
  const nonOcrTextParts = textParts.slice(0, textParts.length - ocrText.length);
  const semanticClosing = ocrText.some(isSemanticClosingText)
    || (!denseTable && nonOcrTextParts.some(isSemanticClosingText));

  if (pageNumber === 1 && totalPages !== 1) return "cover";
  if (!ignoreExplicitRole && preferExplicitRole && ["cover", "closing"].includes(explicit)) return explicit;
  if (semanticClosing && (!totalPages || !pageNumber || pageNumber === totalPages)) return "closing";
  if (denseTable) return "table";
  if (!ignoreExplicitRole && explicit !== "content" && (preferExplicitRole || !["cover", "closing"].includes(explicit))) return explicit;
  if (/\b(?:agenda|contents?)\b|目录|议程|内容概览/i.test(text)) return "agenda";
  if (/price|pricing|quotation|报价|价格|费用|预算|产品清单|规格表|参数表|明细表/i.test(text)) return "table";
  if (/table|data|metric|chart|图表|表格|数据|指标|同比|环比|%/i.test(text) || Number(page.tableCount || 0) > 0) return "table";
  if (/compare|comparison|对比|竞品|优劣|差异/i.test(text)) return "comparison";
  if (/timeline|roadmap|process|workflow|时间|流程|路径|步骤|计划/i.test(text)) return "process";
  if (/product|sku|型号|礼盒|产品|商品|包装|选品/i.test(text)) return "product";
  if (/summary|conclusion|recap|总结|结论|要点回顾/i.test(text)) return "summary";
  if (/quote|quotation|引言|寄语|金句/i.test(text)) return "quote";
  if (/section|chapter|章节|篇章|部分\s*[一二三四五六七八九十\d]/i.test(text)) return "section";
  if (imageCount > 0 && textChars < 80) return "visual";
  return "content";
}

export function hasDenseTableSignals(page = {}, textValue = "") {
  if (Number(page.tableCount || 0) > 0) return true;
  const text = cleanText(textValue || page.text || page.textPreview || "");
  if (!text) return false;
  const signals = [
    /(?:category|product\s*(?:content|name)|\u7c7b\u522b|\u4ea7\u54c1\u5185\u5bb9|\u4ea7\u54c1\u540d\u79f0)/i,
    /(?:parameter|specification|\u53c2\u6570|\u89c4\u683c)/i,
    /(?:quantity|\u6570\u91cf|\u9884\u4f30\u6570\u91cf)/i,
    /(?:price|quotation|\u62a5\u4ef7|\u4ef7\u683c|\u91c7\u96c6\u4ef7|\u5e02\u573a\u4ef7)/i,
    /(?:total|subtotal|\u5408\u8ba1|\u603b\u4ef7|\u603b\u989d)/i,
    /(?:https?:\/\/|www\.|\u94fe\u63a5)/i
  ].filter((pattern) => pattern.test(text)).length;
  const numericTokens = text.match(/\b\d+(?:[.,]\d+)?\b/g)?.length || 0;
  return signals >= 3 || (signals >= 2 && numericTokens >= 5);
}

export function buildDeckStyleSpec(options = {}) {
  const source = options.styleSpec && typeof options.styleSpec === "object" ? options.styleSpec : {};
  const styleBrief = cleanText(options.styleBrief || source.direction?.summary || "Unified premium business presentation system.");
  const audience = cleanText(options.audience || source.direction?.audience || "business audience");
  const tone = cleanText(options.tone || source.direction?.tone || "clear, restrained, confident");
  const typographyMode = cleanText(source.typography?.familyMode || inferTypographyMode(styleBrief));
  const designContract = buildDeckDesignContract({ pageNumberPolicy: options.pageNumberPolicy || source.master?.pageNumberPolicy || "none" });
  return {
    kind: "codex_ppt_style_spec",
    version: 1,
    direction: {
      summary: styleBrief,
      audience,
      tone
    },
    typography: {
      familyMode: typographyMode,
      rule: cleanText(source.typography?.rule || typographyRule(typographyMode)),
      weights: cleanList(source.typography?.weights, designContract.typography.weights),
      roles: source.typography?.roles && typeof source.typography.roles === "object"
        ? source.typography.roles
        : designContract.typography.roles
    },
    palette: {
      mode: cleanText(source.palette?.mode || "approved-sample-locked"),
      background: cleanText(source.palette?.background || "one stable light or dark background family selected by the approved sample"),
      primaryAccent: cleanText(source.palette?.primaryAccent || "one dominant accent sampled from the approved sample"),
      secondaryAccent: cleanText(source.palette?.secondaryAccent || "at most one supporting accent"),
      neutralRule: cleanText(source.palette?.neutralRule || "use one consistent neutral text and surface scale"),
      forbidden: cleanList(source.palette?.forbidden, ["page-specific theme switching", "generic blue fallback", "unrelated gradients"])
    },
    master: {
      aspectRatio: "16:9",
      outerMarginPercent: normalizePercentRange(source.master?.outerMarginPercent, designContract.master.outerMarginPercent),
      titleAnchor: cleanText(source.master?.titleAnchor || "keep one title anchor for comparable page roles"),
      header: cleanText(source.master?.header || designContract.master.header),
      footer: cleanText(source.master?.footer || designContract.master.footer),
      pageNumberPolicy: designContract.master.pageNumberPolicy,
      pageNumberRule: cleanText(source.master?.pageNumberRule || designContract.master.pageNumberRule)
    },
    components: {
      cards: cleanText(source.components?.cards || "one card radius and one border/shadow treatment across the deck"),
      icons: cleanText(source.components?.icons || "one icon family and line-weight language"),
      charts: cleanText(source.components?.charts || "one chart palette, label hierarchy, and framing treatment"),
      imagery: cleanText(source.components?.imagery || "one crop, mask, and illustration/rendering language")
    },
    variation: {
      rule: cleanText(source.variation?.rule || "vary composition by page role without changing typography, palette, master anchors, or component finish"),
      stableAcrossPages: cleanList(source.variation?.stableAcrossPages, ["font family mood", "title hierarchy", "palette", "header/footer anchors", "page-number anchor", "icon and card language"])
    }
  };
}

export function formatDeckStyleSpecPrompt(styleSpec = {}) {
  const spec = buildDeckStyleSpec({ styleSpec });
  const roleRanges = Object.entries(spec.typography.roles || {})
    .map(([role, values]) => `${role}:title ${formatRange(values?.titlePt)},body ${formatRange(values?.bodyPt)}`)
    .join("; ");
  return [
    `STYLE SYSTEM SUMMARY: ${spec.direction.summary}`,
    `AUDIENCE/TONE: ${spec.direction.audience}; ${spec.direction.tone}.`,
    `TYPE SYSTEM: ${spec.typography.rule} Weights: ${spec.typography.weights.join(", ")}. Role scale: ${roleRanges}.`,
    `PALETTE SYSTEM: ${spec.palette.background}; ${spec.palette.primaryAccent}; ${spec.palette.secondaryAccent}; ${spec.palette.neutralRule}. Forbidden: ${spec.palette.forbidden.join(", ")}.`,
    `MASTER SYSTEM: ${spec.master.outerMarginPercent.join("-")}% outer margins; ${spec.master.titleAnchor}; ${spec.master.header}; ${spec.master.footer}; ${spec.master.pageNumberRule}`,
    `COMPONENT SYSTEM: cards=${spec.components.cards}; icons=${spec.components.icons}; charts=${spec.components.charts}; imagery=${spec.components.imagery}.`,
    `CONTROLLED VARIATION: ${spec.variation.rule}. Keep stable: ${spec.variation.stableAcrossPages.join(", ")}.`
  ].join(" ");
}

export function resolveVisualSampleSelection(pages = [], options = {}) {
  if (!Array.isArray(pages) || !pages.length) return null;
  const representative = selectRepresentativeSamplePage(pages, options);
  const requestedPageNumber = Number(options.pageNumber || options.page || 0);
  const requested = requestedPageNumber
    ? pages.find((page, index) => Number(page.pageNumber || index + 1) === requestedPageNumber)
    : null;
  if (requestedPageNumber && !requested) {
    return {
      page: null,
      pageNumber: requestedPageNumber,
      role: "",
      score: null,
      mode: "explicit-page-not-found",
      requestedPageNumber,
      blocked: true,
      blockerCode: "CODEX_PPT_SAMPLE_PAGE_NOT_FOUND",
      blockerMessage: `Page ${requestedPageNumber} does not exist in this ${pages.length}-page deck.`,
      recommendedPageNumber: representative?.pageNumber || 0,
      overriddenRequestedPage: false
    };
  }
  if (!requestedPageNumber) {
    return representative ? { ...representative, mode: "representative-content-page", requestedPageNumber: 0 } : null;
  }
  const totalPages = pages.length;
  const requestedRole = inferDeckPageRole(requested, {
    totalPages,
    pageNumber: requestedPageNumber,
    preferExplicitRole: options.preferExplicitRole !== false,
    ignoreExplicitRole: options.ignoreExplicitRole === true
  });
  const representativeIsContent = representative && !["cover", "closing"].includes(representative.role);
  const protectFromEdgeSample = totalPages >= 3
    && ["cover", "closing"].includes(requestedRole)
    && representativeIsContent
    && options.allowNonRepresentativeSample !== true
    && options.allowCoverSample !== true;
  if (protectFromEdgeSample) {
    return {
      page: requested,
      pageNumber: requestedPageNumber,
      role: requestedRole,
      score: null,
      mode: "explicit-page-blocked",
      requestedPageNumber,
      requestedRole,
      blocked: true,
      blockerCode: "CODEX_PPT_NON_REPRESENTATIVE_SAMPLE_REQUIRES_OPT_IN",
      blockerMessage: `Page ${requestedPageNumber} is a ${requestedRole} page and cannot become the default deck-wide style sample. Choose a representative content page or explicitly allow this edge-page sample.`,
      recommendedPageNumber: representative.pageNumber,
      overriddenRequestedPage: false
    };
  }
  return {
    page: requested,
    pageNumber: requestedPageNumber,
    role: requestedRole,
    score: null,
    mode: "explicit-page",
    requestedPageNumber,
    overriddenRequestedPage: false
  };
}

export function buildDeckStructureAudit(pages = [], options = {}) {
  const totalPages = pages.length;
  const roles = pages.map((page, index) => inferDeckPageRole(page, {
    ...options,
    pageNumber: page.pageNumber || index + 1,
    totalPages
  }));
  const hasCover = roles[0] === "cover";
  const hasClosing = roles[roles.length - 1] === "closing";
  return {
    version: 1,
    hasCover,
    hasClosing,
    closingRecommended: Boolean(totalPages >= 4 && !hasClosing),
    closingAction: options.sourceDeck === false ? "plan-in-outline" : "recommend-only",
    pageRoles: roles.map((role, index) => ({
      pageId: pages[index]?.pageId || `page_${String(index + 1).padStart(3, "0")}`,
      pageNumber: Number(pages[index]?.pageNumber || index + 1),
      role
    }))
  };
}

export function selectRepresentativeSamplePage(pages = [], options = {}) {
  if (!Array.isArray(pages) || !pages.length) return null;
  const totalPages = pages.length;
  const scored = pages.map((page, index) => {
    const role = inferDeckPageRole(page, {
      totalPages,
      pageNumber: page.pageNumber || index + 1,
      preferExplicitRole: options.preferExplicitRole !== false,
      ignoreExplicitRole: options.ignoreExplicitRole === true
    });
    const textChars = Number(page.textChars || cleanText(page.textPreview || page.outlineEvidence || "").length || 0);
    const roleScore = {
      content: 10,
      product: 10,
      comparison: 9,
      process: 9,
      visual: 8,
      summary: 7,
      table: 5,
      agenda: 4,
      quote: 4,
      section: 3,
      cover: 0,
      closing: 0
    }[role] ?? 5;
    const densityScore = textChars >= 40 && textChars <= 220 ? 3 : textChars > 420 ? -3 : textChars > 0 ? 1 : 0;
    const edgePenalty = index === 0 || index === totalPages - 1 ? -2 : 0;
    return { page, pageNumber: Number(page.pageNumber || index + 1), role, score: roleScore + densityScore + edgePenalty };
  }).sort((a, b) => b.score - a.score || a.pageNumber - b.pageNumber);
  return scored[0] || null;
}

export function buildDeckDesignContract(options = {}) {
  const pageNumberPolicy = ["none", "preserve", "normalize"].includes(options.pageNumberPolicy)
    ? options.pageNumberPolicy
    : "none";
  return {
    kind: "deck_design_contract",
    version: 2,
    typography: {
      familyMode: "single-sans",
      rule: "Use one modern sans-serif family mood for Chinese and Latin text. Do not mix serif and sans-serif display faces unless the approved style explicitly requires it.",
      weights: ["regular", "medium", "semibold", "bold"],
      lineHeight: { title: [1.05, 1.18], body: [1.25, 1.5] },
      roles: ROLE_TYPOGRAPHY
    },
    master: {
      aspectRatio: "16:9",
      outerMarginPercent: [5, 7],
      titleZone: "Keep the role-specific title anchor stable across comparable content pages.",
      header: "Use one header variant per page role; do not invent a different brand strip on each page.",
      footer: "Keep logo/footer anchors fixed across comparable pages; omit them when absent from the confirmed system.",
      pageNumberPolicy,
      pageNumberRule: pageNumberPolicy === "none"
        ? "Do not render slide numbers, page counters, Slide N labels, or Page N labels."
        : pageNumberPolicy === "preserve"
          ? "Preserve a source page number only when it is an intentional, verified master element."
          : "Use one normalized page-number format and one fixed anchor across the deck."
    },
    contentSafety: {
      placeholderPolicy: "Never render template placeholders or generic template chrome.",
      inventionPolicy: "Do not invent brands, logos, company names, URLs, model numbers, prices, dates, percentages, or slogans.",
      longTextPolicy: "Do not replace readable source content with anonymous gray bars. Shorten only when meaning and critical facts are retained.",
      blockedTextClasses: ["placeholder", "page_number", "template_chrome"]
    },
    structure: {
      existingDeckClosingPolicy: "Preserve the source page count and semantic page roles. Never turn the last source page into a closing slide unless its content is actually a closing message.",
      briefClosingPolicy: "For a newly planned deck from a brief, include a purposeful summary, next-step, Q&A, or thank-you closing when appropriate."
    }
  };
}

export function inferPageNumberPolicyFromOcrHints(hints = {}, explicitPolicy = "") {
  if (["none", "preserve", "normalize"].includes(explicitPolicy)) return explicitPolicy;
  const pages = Array.isArray(hints.pages) ? hints.pages : [];
  if (pages.length < 2) return "none";
  const contentPages = pages.slice(1);
  const pagesWithMarkers = contentPages.filter((page) => (
    (Array.isArray(page.ocrLines) ? page.ocrLines : []).some((line) => isPageMarkerText(line?.text || ""))
  ));
  return pagesWithMarkers.length / Math.max(1, contentPages.length) >= 0.6 ? "normalize" : "none";
}

export function getRoleTypography(role = "content") {
  return ROLE_TYPOGRAPHY[normalizeDeckPageRole(role)] || ROLE_TYPOGRAPHY.content;
}

function isLikelyCjkBrandText(value = "") {
  const text = cleanText(value);
  if (!/^[\u3400-\u9fff]{4,16}$/.test(text)) return false;
  if (/^(?:\u7f8e\u597d\u751f\u6d3b|\u672a\u6765\u751f\u6d3b|\u54c1\u8d28\u751f\u6d3b|\u667a\u80fd\u6c7d\u8f66|\u65b0\u80fd\u6e90\u6c7d\u8f66)$/.test(text)) return false;
  return /(?:\u96c6\u56e2|\u516c\u53f8|\u80a1\u4efd|\u63a7\u80a1|\u94f6\u884c|\u5927\u5b66|\u5b66\u9662|\u7814\u7a76\u9662|\u7535\u6c14|\u8f6f\u4ef6|\u7f51\u7edc|\u533b\u836f|\u751f\u7269|\u80fd\u6e90|\u6c7d\u8f66|\u751f\u6d3b)$/.test(text);
}

function inferTypographyMode(styleBrief = "") {
  if (/serif|衬线|editorial|杂志|出版/i.test(styleBrief)) return "serif-led";
  if (/hand[- ]?drawn|handwritten|手绘|手写/i.test(styleBrief)) return "sans-with-handmade-accent";
  return "single-sans";
}

function typographyRule(mode = "single-sans") {
  if (mode === "sample-matched") return "Match the approved sample's visible type-family mood and hierarchy; do not introduce an unrelated serif, sans-serif, handwritten, calligraphic, or decorative display family.";
  if (mode === "serif-led") return "Use one approved serif display family for titles and one restrained sans-serif family for body text; never alternate additional display families between pages.";
  if (mode === "sans-with-handmade-accent") return "Use one modern sans-serif family for all readable text; handmade marks may be decorative accents only and must not replace the text hierarchy.";
  return "Use one modern sans-serif family mood for Chinese and Latin text; do not mix serif, handwritten, calligraphic, and unrelated display faces between pages.";
}

function cleanList(value, fallback = []) {
  const list = Array.isArray(value) ? value : fallback;
  return [...new Set(list.map((item) => cleanText(item)).filter(Boolean))].slice(0, 24);
}

function formatRange(value = []) {
  return Array.isArray(value) && value.length >= 2 ? `${value[0]}-${value[1]}pt` : "locked";
}

function normalizePercentRange(value, fallback = [5, 7]) {
  if (!Array.isArray(value) || value.length < 2) return [...fallback];
  const normalized = value.slice(0, 2).map(Number);
  if (!normalized.every(Number.isFinite)) return [...fallback];
  const [first, second] = normalized.map((item) => Math.max(0, Math.min(20, item)));
  return first <= second ? [first, second] : [second, first];
}

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 4000);
}
