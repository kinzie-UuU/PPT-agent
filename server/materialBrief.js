function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function buildMaterialBrief(files = []) {
  const joined = files.map((file) => `${file.name || "资料"}：${file.text || ""}`).join("\n");
  const text = cleanText(joined);
  const prices = uniqueMatches(text, /(?:售价[:：]?\s*)?(?:[¥￥]\s*\d{1,5}|\d{1,5}\s*元)/g)
    .filter((item) => /\d/.test(item))
    .slice(0, 16);
  const dimensions = uniqueMatches(text, /\d{2,4}\s*[×xX*]\s*\d{2,4}(?:\s*[×xX*]\s*\d{2,4})?\s*mm/gi).slice(0, 10);
  const pageMarkers = [...text.matchAll(/--\s*\d+\s+of\s+(\d+)\s*--/g)];
  const pageCount = pageMarkers.at(-1)?.[1] || null;
  const pages = extractPages(text);
  const productCandidates = extractProductCandidates(text).slice(0, 18);
  const productSources = buildProductSources(productCandidates, pages);
  const highlights = extractHighlights(text).slice(0, 10);
  const products = buildProducts(productCandidates, pages, prices, highlights, text).slice(0, 16);
  const imageHints = files
    .filter((file) => /图片素材已上传/.test(file.text || ""))
    .map((file) => file.name || "图片素材")
    .slice(0, 12);

  return {
    fileCount: files.length,
    charCount: text.length,
    pageCount: pageCount ? Number(pageCount) : null,
    prices,
    dimensions,
    productCandidates,
    productSources,
    products,
    pages: pages.slice(0, 30),
    highlights,
    imageHints,
    summary: [
      pageCount ? `识别到约 ${pageCount} 页资料` : "",
      prices.length ? `价格/金额：${prices.slice(0, 8).join("、")}` : "",
      productCandidates.length ? `候选产品/主题：${productCandidates.slice(0, 8).join("、")}` : "",
      highlights.length ? `高频卖点：${highlights.slice(0, 6).join("、")}` : "",
      imageHints.length ? `图片素材：${imageHints.length} 个` : ""
    ].filter(Boolean).join("；")
  };
}

function buildProducts(productCandidates, pages, prices, highlights, fullText) {
  return productCandidates.map((name) => {
    const page = pages.find((item) => item.text.includes(name));
    const localText = page?.text || "";
    const localPrices = uniqueMatches(localText, /(?:售价[:：]?\s*)?(?:[¥￥]\s*\d{1,5}|\d{1,5}\s*元)/g).slice(0, 4);
    const localDimensions = uniqueMatches(localText, /\d{2,4}\s*[×xX*]\s*\d{2,4}(?:\s*[×xX*]\s*\d{2,4})?\s*mm/gi).slice(0, 3);
    const localHighlights = extractHighlights(localText).slice(0, 5);
    return {
      name,
      price: localPrices[0] || inferNearbyPrice(name, fullText),
      prices: localPrices,
      dimensions: localDimensions,
      highlights: localHighlights.length ? localHighlights : highlights.slice(0, 3),
      sourcePage: page?.page || null,
      sourceTitle: page?.title || "",
      recommendation: inferRecommendation(name, localPrices[0] || "", localHighlights)
    };
  });
}

function inferNearbyPrice(name, text) {
  const aliases = [...new Set([name, name.replace(/礼盒|礼包|战卡/g, ""), name.slice(0, 4)].filter((item) => item && item.length >= 2))];
  for (const alias of aliases) {
    const index = text.indexOf(alias);
    if (index < 0) continue;
    const window = text.slice(Math.max(0, index - 20), index + alias.length + 28);
    const after = window.slice(window.indexOf(alias));
    const hit = after.match(/(?:售价[:：]?\s*)?(?:[¥￥]\s*\d{1,5}|\d{1,5}\s*元)/);
    if (hit) return hit[0].replace(/\s+/g, "");
  }
  return "";
}

function inferRecommendation(name, price, highlights) {
  if (/福禄|澳龙|花胶|鲍鱼|高端|轻奢/.test(name) || /299|199|179/.test(price)) return "高端客户、重要拜访、形象礼赠";
  if (/低糖|青稞|轻养/.test(name) || highlights.some((item) => /低糖|轻养|高纤/.test(item))) return "健康诉求客户、员工福利、养生礼赠";
  if (/粽承|粽享时光|39|59|79/.test(name) || /39|59|79/.test(price)) return "大众福利、批量采购、预算敏感客户";
  return "常规送礼、节日福利、销售推荐";
}

function extractPages(text) {
  const parts = text.split(/--\s*(\d+)\s+of\s+\d+\s*--/g);
  const pages = [];
  let coverText = cleanText(parts[0]);
  if (coverText) pages.push({ page: 1, title: inferPageTitle(coverText), text: coverText.slice(0, 900) });
  for (let index = 1; index < parts.length; index += 2) {
    const page = Number(parts[index]);
    const body = cleanText(parts[index + 1] || "");
    if (body) pages.push({ page, title: inferPageTitle(body), text: body.slice(0, 900) });
  }
  return pages;
}

function inferPageTitle(text) {
  const chunks = cleanText(text).split(/\s+/).filter(Boolean);
  const candidate = chunks.find((item) => /[\u4e00-\u9fa5]/.test(item) && item.length >= 3) || chunks[0] || "资料页";
  return candidate.slice(0, 28);
}

function buildProductSources(products, pages) {
  const sources = {};
  for (const product of products) {
    const hit = pages.find((page) => page.text.includes(product));
    if (hit) sources[product] = { page: hit.page, title: hit.title };
  }
  return sources;
}

function uniqueMatches(text, regex) {
  return [...new Set([...text.matchAll(regex)].map((match) => cleanText(match[0]).replace(/\s+/g, "")))];
}

function extractProductCandidates(text) {
  const phrases = [];
  for (const pattern of [
    /[\u4e00-\u9fa5A-Za-z0-9·]{2,14}(?:礼盒|粽|礼包|保温杯|双肩包|帆布袋|战卡)/g,
    /(?:品名|产品|礼盒)[:：]\s*([\u4e00-\u9fa5A-Za-z0-9·（）()]{2,20})/g
  ]) {
    for (const match of text.matchAll(pattern)) phrases.push(normalizeProductName(match[1] || match[0]));
  }
  return [...new Set(phrases)]
    .filter((item) => !/产品效果图|介绍页|商品定制|产品力/.test(item))
    .filter((item) => !/^(建立|打造|高级但克制|适合|需要|输出)/.test(item))
    .filter((item) => !/的端午礼盒$/.test(item))
    .sort((a, b) => scorePhrase(b) - scorePhrase(a));
}

function normalizeProductName(value) {
  return cleanText(value)
    .replace(/(礼盒)\1+/g, "$1")
    .replace(/(礼包)\1+/g, "$1")
    .replace(/(战卡)\1+/g, "$1");
}

function extractHighlights(text) {
  const keywords = ["低糖", "低GI", "轻养", "轻奢", "高纤", "滋补", "上汤", "非遗", "竹编", "烫金", "凹凸", "国潮", "保温", "高端", "性价比", "包销", "专供"];
  return keywords
    .map((keyword) => ({ keyword, count: (text.match(new RegExp(keyword, "g")) || []).length }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count)
    .map((item) => `${item.keyword}(${item.count})`);
}

function scorePhrase(value) {
  let score = value.length;
  if (/礼盒|礼包|战卡/.test(value)) score += 8;
  if (/粽|端午/.test(value)) score += 5;
  if (/\d/.test(value)) score += 2;
  return score;
}
