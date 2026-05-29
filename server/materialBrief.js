function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function unique(values) {
  return [...new Set(values.map((item) => cleanText(item)).filter(Boolean))];
}

function uniqueMatches(text, regex) {
  return unique([...text.matchAll(regex)].map((match) => match[1] || match[0]));
}

export function buildMaterialBrief(files = []) {
  const joined = files.map((file) => `${file.name || "资料"}：${file.text || ""}`).join("\n");
  const text = cleanText(joined);
  const uploadedFiles = files.filter((file) => (file.name || "") !== "输入说明");
  const inputText = cleanText(files.find((file) => (file.name || "") === "输入说明")?.text || "");
  const imageHints = files
    .filter((file) => /图片素材已上传|image|png|jpg|jpeg|webp|svg/i.test(`${file.name || ""} ${file.text || ""}`))
    .map((file) => file.name || "图片素材")
    .slice(0, 12);
  const nonImageUploadedText = cleanText(uploadedFiles
    .filter((file) => !imageHints.includes(file.name || ""))
    .map((file) => file.text || "")
    .join("\n")
    .replace(/图片素材已上传：[^。]+。?/g, "")
    .replace(/资料抽取失败：[^。]+。?/g, ""));
  const pages = extractPages(text);
  const prices = extractPrices(text).slice(0, 18);
  const dimensions = uniqueMatches(text, /\d{2,4}\s*[xX×*]\s*\d{2,4}(?:\s*[xX×*]\s*\d{2,4})?\s*(?:mm|cm|毫米|厘米)?/g).slice(0, 12);
  const productCandidates = extractProductCandidates(text).slice(0, 20);
  const highlights = extractHighlights(text).slice(0, 12);
  const productSources = buildProductSources(productCandidates, pages);
  const products = buildProducts(productCandidates, pages, prices, highlights, text).slice(0, 16);

  const pageCount = inferPageCount(text, pages);
  const inputStrength = inferInputStrength({
    uploadedFileCount: uploadedFiles.length,
    imageCount: imageHints.length,
    nonImageUploadedText,
    inputText,
    pageCount,
    prices,
    productCandidates,
    dimensions,
    products
  });
  const missing = {
    bodyMaterial: nonImageUploadedText.length < 120,
    price: prices.length === 0,
    productName: productCandidates.length === 0,
    spec: dimensions.length === 0
  };
  const confirmationFields = [
    missing.productName ? "产品名称/主推对象" : "",
    missing.price ? "价格/报价/预算档位" : "",
    missing.spec ? "规格/尺寸/套餐配置" : "",
    missing.bodyMaterial ? "正式资料正文/卖点依据" : ""
  ].filter(Boolean);

  return {
    fileCount: files.length,
    uploadedFileCount: uploadedFiles.length,
    charCount: text.length,
    bodyCharCount: nonImageUploadedText.length,
    pageCount,
    inputStrength,
    missing,
    confirmationFields,
    prices,
    dimensions,
    productCandidates,
    productSources,
    products,
    pages: pages.slice(0, 30),
    highlights,
    imageCount: imageHints.length,
    imageHints,
    summary: [
      inputStrength === "strong" ? "资料强度：强资料" : inputStrength === "weak" ? "资料强度：弱资料，可先生成可编辑初稿" : "资料强度：零资料，将生成待补齐初稿",
      pageCount ? `识别到约 ${pageCount} 页资料` : "",
      prices.length ? `价格/金额：${prices.slice(0, 8).join("、")}` : "",
      productCandidates.length ? `候选产品/主题：${productCandidates.slice(0, 8).join("、")}` : "",
      dimensions.length ? `规格信息：${dimensions.slice(0, 5).join("、")}` : "",
      highlights.length ? `高频卖点：${highlights.slice(0, 6).join("、")}` : "",
      imageHints.length ? `图片素材：${imageHints.length} 个` : "",
      confirmationFields.length ? `待确认：${confirmationFields.join("、")}` : ""
    ].filter(Boolean).join("；")
  };
}

function inferInputStrength({ uploadedFileCount, imageCount, nonImageUploadedText, inputText, pageCount, prices, productCandidates, dimensions, products }) {
  const hasStructuredSignals = prices.length >= 2 || productCandidates.length >= 2 || dimensions.length || products.length >= 2;
  if (!uploadedFileCount && !imageCount && inputText.length < 24 && !prices.length && !dimensions.length) return "empty";
  if (nonImageUploadedText.length >= 500 || Number(pageCount || 0) >= 3 || (uploadedFileCount > imageCount && hasStructuredSignals) || (inputText.length >= 40 && hasStructuredSignals)) return "strong";
  if (imageCount > 0 || inputText.length >= 28 || prices.length || productCandidates.length) return "weak";
  return "empty";
}

function inferPageCount(text, pages) {
  const markers = [...text.matchAll(/--\s*\d+\s+of\s+(\d+)\s*--/g)];
  const marked = Number(markers.at(-1)?.[1] || 0);
  if (marked) return marked;
  return pages.length || null;
}

function extractPages(text) {
  const parts = text.split(/--\s*(\d+)\s+of\s+\d+\s*--/g);
  const pages = [];
  const coverText = cleanText(parts[0]);
  if (coverText) pages.push({ page: 1, title: inferPageTitle(coverText), text: coverText.slice(0, 1100) });
  for (let index = 1; index < parts.length; index += 2) {
    const page = Number(parts[index]);
    const body = cleanText(parts[index + 1] || "");
    if (body) pages.push({ page, title: inferPageTitle(body), text: body.slice(0, 1100) });
  }
  return pages;
}

function inferPageTitle(text) {
  const candidate = cleanText(text)
    .split(/\s+/)
    .find((item) => /[\u4e00-\u9fa5]/.test(item) && item.length >= 3);
  return (candidate || cleanText(text).slice(0, 28) || "资料页").slice(0, 28);
}

function extractPrices(text) {
  const withoutDimensions = String(text || "").replace(/\d{2,4}\s*[xX×*]\s*\d{2,4}(?:\s*[xX×*]\s*\d{2,4})?\s*(?:mm|cm|毫米|厘米)?/g, " ");
  const raw = uniqueMatches(withoutDimensions, /(?:售价|价格|报价|单价|零售价|金额|预算)?\s*[:：]?\s*([¥￥]?\s*\d{1,5}(?:\.\d{1,2})?\s*(?:元|块|RMB)?)/g);
  return raw
    .map((item) => item.replace(/\s+/g, ""))
    .filter((item) => /\d/.test(item))
    .filter((item) => /[¥￥元块RMB]/i.test(item) || Number(item.replace(/[^\d.]/g, "")) < 250)
    .filter((item) => !/^\d{4}$/.test(item))
    .slice(0, 30);
}

function extractProductCandidates(text) {
  const candidates = [];
  const patterns = [
    /([\u4e00-\u9fa5A-Za-z0-9·]{2,18}(?:礼盒|礼包|套装|战卡|粽|粽子|茶|酒|券|卡|包|盒))/g,
    /(?:品名|产品|商品|礼盒|名称)\s*[:：]\s*([\u4e00-\u9fa5A-Za-z0-9·（）()]{2,24})/g
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) candidates.push(normalizeProductName(match[1]));
  }
  const expanded = candidates.flatMap(expandProductPhrase);
  return unique(expanded)
    .filter((item) => !/产品效果图|介绍页|目录|报价|方案|资料|图片|设计|销售战卡|战卡|项目名称|补充说明/.test(item))
    .filter((item) => !/^\d{4}$/.test(item))
    .sort((a, b) => scorePhrase(b) - scorePhrase(a));
}

function normalizeProductName(value) {
  return cleanText(value)
    .replace(/[：:，,。；;]+$/g, "")
    .replace(/^(产品|品名|商品|名称)/, "")
    .slice(0, 24);
}

function expandProductPhrase(value) {
  const text = normalizeProductName(value).replace(/^主推/, "");
  const split = text.split(/和|与|及|、|，|,/).map(normalizeProductName).filter(Boolean);
  if (split.length > 1 && split.some((item) => /礼盒|礼包|套装|粽/.test(item))) return split;
  return [text];
}

function extractHighlights(text) {
  const keywords = [
    "低糖", "低GI", "轻养", "轻奢", "高端", "国潮", "竹编", "烫金", "非遗",
    "滋补", "上汤", "保温", "性价比", "定制", "包邮", "企业专供", "健康",
    "礼赠", "端午", "节日", "员工福利", "客户拜访"
  ];
  return keywords
    .map((keyword) => ({ keyword, count: (text.match(new RegExp(escapeRegExp(keyword), "g")) || []).length }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count)
    .map((item) => `${item.keyword}(${item.count})`);
}

function buildProductSources(products, pages) {
  const sources = {};
  for (const product of products) {
    const hit = pages.find((page) => page.text.includes(product));
    if (hit) sources[product] = { page: hit.page, title: hit.title };
  }
  return sources;
}

function buildProducts(productCandidates, pages, prices, highlights, fullText) {
  return productCandidates.map((name) => {
    const page = pages.find((item) => item.text.includes(name));
    const localText = page?.text || nearbyText(name, fullText, 360);
    const localPrices = extractPrices(localText).slice(0, 4);
    const localDimensions = uniqueMatches(localText, /\d{2,4}\s*[xX×*]\s*\d{2,4}(?:\s*[xX×*]\s*\d{2,4})?\s*(?:mm|cm|毫米|厘米)?/g).slice(0, 3);
    const localHighlights = extractHighlights(localText).slice(0, 5);
    return {
      name,
      price: localPrices[0] || inferNearbyPrice(name, fullText) || prices[0] || "",
      prices: localPrices,
      dimensions: localDimensions,
      highlights: localHighlights.length ? localHighlights : highlights.slice(0, 3),
      sourcePage: page?.page || null,
      sourceTitle: page?.title || "",
      recommendation: inferRecommendation(name, localPrices[0] || "", localHighlights)
    };
  });
}

function nearbyText(name, text, radius) {
  const index = text.indexOf(name);
  if (index < 0) return "";
  return text.slice(Math.max(0, index - radius), index + name.length + radius);
}

function inferNearbyPrice(name, text) {
  return extractPrices(nearbyText(name, text, 220))[0] || "";
}

function inferRecommendation(name, price, highlights) {
  const joined = `${name} ${price} ${highlights.join(" ")}`;
  if (/高端|轻奢|滋补|鲍|参|199|299|399|599/.test(joined)) return "高端客户、重要拜访、形象礼赠";
  if (/低糖|低GI|轻养|健康|养生/.test(joined)) return "健康诉求客户、员工福利、养生礼赠";
  if (/39|59|79|99|性价比|批量/.test(joined)) return "大众福利、批量采购、预算敏感客户";
  return "常规送礼、节日福利、销售推荐";
}

function scorePhrase(value) {
  let score = value.length;
  if (/礼盒|礼包|套装|战卡/.test(value)) score += 8;
  if (/端午|粽/.test(value)) score += 5;
  if (/\d/.test(value)) score += 2;
  return score;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
