import path from "path";

const IMAGE_RE = /\.(png|jpe?g|webp|svg|gif)$/i;

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function toList(value) {
  if (Array.isArray(value)) return value.map(cleanText).filter(Boolean);
  if (!value) return [];
  return String(value).split(/\r?\n|[;,，；、]+/).map(cleanText).filter(Boolean);
}

function isImage(file = {}) {
  return IMAGE_RE.test(file.originalName || file.path || "") || /^image\//i.test(file.mimeType || "");
}

function normalizedName(file = {}) {
  return cleanText(file.originalName || path.basename(file.path || ""));
}

function inferAssetKind(file = {}) {
  const role = cleanText(file.materialRole || file.mediaProfile?.role || "").toLowerCase();
  const name = normalizedName(file).toLowerCase();
  if (/page[-_\s]?screenshot|slide[-_\s]?shot|old[-_\s]?page|source[-_\s]?page/.test(name) || role === "page-screenshot") return "page-screenshot";
  if (/logo|mark|标识|品牌|brand/.test(name) || role === "decor") return "logo";
  if (/chart|graph|diagram|table|图表|数据/.test(name)) return "chart";
  if (/icon|图标/.test(name)) return "icon";
  if (/product|pack|sku|item|礼盒|包装|产品|主图|foreground/.test(name) || role === "foreground") return "product";
  if (/background|hero|poster|scene|bg|背景|底图|主视觉/.test(name) || role === "background") return "decoration";
  if (Number(file.sourceSlide || 0)) return "product";
  return isImage(file) ? "decoration" : "source-document";
}

function policyForKind(kind) {
  if (kind === "logo") return {
    priority: "must_keep",
    canEnterBackground: false,
    editableRole: "independentImage",
    needsCutout: false
  };
  if (kind === "product" || kind === "chart") return {
    priority: "must_keep",
    canEnterBackground: false,
    editableRole: "independentImage",
    needsCutout: kind === "product"
  };
  if (kind === "icon") return {
    priority: "can_relayout",
    canEnterBackground: false,
    editableRole: "independentImage",
    needsCutout: false
  };
  if (kind === "decoration") return {
    priority: "can_style",
    canEnterBackground: true,
    editableRole: "backgroundOnly",
    needsCutout: false
  };
  if (kind === "page-screenshot") return {
    priority: "can_style",
    canEnterBackground: false,
    editableRole: "backgroundOnly",
    needsCutout: false
  };
  if (kind === "text") return {
    priority: "must_keep",
    canEnterBackground: false,
    editableRole: "textBox",
    needsCutout: false
  };
  return {
    priority: "can_relayout",
    canEnterBackground: false,
    editableRole: "sourceOnly",
    needsCutout: false
  };
}

export function buildAssetManifest({ files = [], materialBrief = {}, deck = {} } = {}) {
  const fileAssets = (files || []).map((file, index) => {
    const kind = inferAssetKind(file);
    const policy = policyForKind(kind);
    return {
      id: file.id || `asset_file_${index + 1}`,
      kind,
      name: normalizedName(file),
      path: file.path || "",
      source: file.source || "upload",
      sourceSlide: Number(file.sourceSlide || 0) || null,
      sourceUploadId: file.sourceUploadId || file.id || null,
      mimeType: file.mimeType || "",
      size: file.size || null,
      priority: policy.priority,
      canEnterBackground: policy.canEnterBackground,
      editableRole: policy.editableRole,
      needsCutout: Boolean(file.needsCutout || file.needsCutoutCandidate || policy.needsCutout),
      route: policy.needsCutout ? "local_first_cloud_fallback" : "local_first",
      materialRole: file.materialRole || file.mediaProfile?.role || kind,
      warnings: []
    };
  });

  const textAssets = [];
  const slides = Array.isArray(deck.slides) ? deck.slides : [];
  slides.forEach((slide, index) => {
    const base = `slide_${String(index + 1).padStart(2, "0")}`;
    if (cleanText(slide.title)) textAssets.push(textAsset(`${base}_title`, "title", slide.title, index + 1));
    if (cleanText(slide.subtitle || slide.visualIntent)) textAssets.push(textAsset(`${base}_subtitle`, "subtitle", slide.subtitle || slide.visualIntent, index + 1));
    toList(slide.bullets).forEach((text, itemIndex) => textAssets.push(textAsset(`${base}_bullet_${itemIndex + 1}`, "body", text, index + 1)));
    toList(slide.dataPoints).forEach((text, itemIndex) => textAssets.push(textAsset(`${base}_data_${itemIndex + 1}`, "data", text, index + 1)));
  });

  const requiredText = [
    ...(materialBrief.prices || []).map((text, index) => textAsset(`required_price_${index + 1}`, "price", text, null)),
    ...(materialBrief.dimensions || []).map((text, index) => textAsset(`required_dimension_${index + 1}`, "data", text, null))
  ];

  const assets = [...fileAssets, ...textAssets, ...requiredText];
  const sourceRefs = buildSourceRefs({ files, materialBrief, deck, assets });
  const slideBindings = buildSlideBindings({ deck, assets });
  const counts = assets.reduce((acc, asset) => {
    acc[asset.kind] = (acc[asset.kind] || 0) + 1;
    return acc;
  }, {});
  const critical = assets.filter((asset) => asset.priority === "must_keep");
  const backgroundBlocked = assets.filter((asset) => asset.canEnterBackground === false && ["logo", "product", "chart", "text"].includes(asset.kind));
  return {
    version: 1,
    status: assets.length ? "ready" : "empty",
    source: "asset-first-hybrid-pipeline",
    createdAt: new Date().toISOString(),
    source_refs: sourceRefs,
    sourceRefs,
    slideBindings,
    assets,
    counts,
    criticalCount: critical.length,
    backgroundBlockedCount: backgroundBlocked.length,
    policies: {
      factSource: "assetManifest/materialBrief/userInput",
      localFirst: true,
      cloudFallback: true,
      noCriticalContentInBackground: true,
      oldPageScreenshotsAreReferenceOnly: true,
      sourceRefsRequired: true
    },
    hardRules: [
      "Logo, product, chart, title, body, price, customer names, and key data must stay editable/independent.",
      "Old page screenshots and visual targets are style references, not final editable slide backgrounds.",
      "Page-bound product/customer/chart images must stay on their source slide; do not reuse them on other slides unless explicitly marked shared.",
      "Local extraction, OCR, cutout, and image QA are tried first; cloud is fallback for low-confidence or failed local steps."
    ],
    warnings: assets.length ? [] : ["asset-manifest-empty"]
  };
}

function buildSlideBindings({ deck = {}, assets = [] } = {}) {
  const slides = Array.isArray(deck.slides) ? deck.slides : [];
  const globalAssetIds = assets
    .filter((asset) => !asset.sourceSlide && ["logo", "icon"].includes(asset.kind))
    .map((asset) => asset.id);
  return slides.map((slide, index) => {
    const sourceSlide = index + 1;
    const sourceAssets = assets.filter((asset) => Number(asset.sourceSlide || 0) === sourceSlide);
    const textAssetIds = sourceAssets.filter((asset) => asset.kind === "text").map((asset) => asset.id);
    const criticalImageIds = sourceAssets
      .filter((asset) => ["logo", "product", "chart"].includes(asset.kind))
      .map((asset) => asset.id);
    const visualAssetIds = sourceAssets
      .filter((asset) => asset.kind !== "text" && asset.editableRole !== "textBox")
      .map((asset) => asset.id);
    return {
      slide: sourceSlide,
      title: cleanText(slide.title || `Slide ${sourceSlide}`),
      assetIds: [...new Set([...sourceAssets.map((asset) => asset.id), ...globalAssetIds])],
      criticalImageIds,
      visualAssetIds,
      textAssetIds,
      globalAssetIds,
      missingRequiredImage: Boolean(toList(slide.imageSlots).length && !visualAssetIds.length),
      reusePolicy: "page-bound-critical-assets-cannot-be-reused-by-other-slides"
    };
  });
}

function textAsset(id, role, text, sourceSlide) {
  const policy = policyForKind("text");
  return {
    id,
    kind: "text",
    role,
    text: cleanText(text),
    source: "deck-content",
    sourceSlide,
    priority: policy.priority,
    canEnterBackground: false,
    editableRole: "textBox",
    needsCutout: false,
    route: "native_text_box",
    warnings: []
  };
}

function buildSourceRefs({ files = [], materialBrief = {}, deck = {}, assets = [] } = {}) {
  const refs = [];
  for (const [index, file] of (files || []).entries()) {
    const sourceId = file.sourceUploadId || file.id || `source_file_${index + 1}`;
    refs.push({
      id: sourceId,
      type: sourceTypeForFile(file),
      name: normalizedName(file),
      path: file.path || "",
      sourceSlide: Number(file.sourceSlide || 0) || null,
      assetIds: assets.filter((asset) => asset.sourceUploadId === sourceId || asset.id === file.id).map((asset) => asset.id),
      factAuthority: file.materialRole === "visual-target-reference" ? "visual-reference-only" : "source-material"
    });
  }
  const slides = Array.isArray(deck.slides) ? deck.slides : [];
  for (const [index, slide] of slides.entries()) {
    refs.push({
      id: `source_slide_${String(index + 1).padStart(2, "0")}`,
      type: "generated-slide-content",
      name: cleanText(slide.title || `Slide ${index + 1}`),
      sourceSlide: index + 1,
      assetIds: assets.filter((asset) => asset.sourceSlide === index + 1).map((asset) => asset.id),
      factAuthority: "deck-content"
    });
  }
  if (materialBrief.summary || materialBrief.charCount || materialBrief.pageCount) {
    refs.push({
      id: "source_material_brief",
      type: "material-brief",
      name: "Material brief",
      charCount: materialBrief.charCount || 0,
      pageCount: materialBrief.pageCount || 0,
      factAuthority: "extracted-source-summary"
    });
  }
  return refs;
}

function sourceTypeForFile(file = {}) {
  const name = normalizedName(file).toLowerCase();
  if (file.materialRole === "visual-target-reference") return "visual-target-reference";
  if (file.materialRole === "page-screenshot" || /page[-_\s]?screenshot|slide[-_\s]?shot/.test(name)) return "page-screenshot";
  if (/\.pptx?$/.test(name)) return "source-ppt";
  if (/\.pdf$/.test(name)) return "source-pdf";
  if (isImage(file)) return "source-image";
  return "source-document";
}

export function validateAssetManifest(manifest = {}) {
  const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
  const warnings = [];
  const errors = [];
  for (const asset of assets) {
    if (asset.kind === "text" && asset.canEnterBackground) errors.push(`${asset.id}: text cannot enter background`);
    if (["logo", "product", "chart"].includes(asset.kind) && asset.canEnterBackground) errors.push(`${asset.id}: critical image cannot enter background`);
    if (asset.kind === "page-screenshot" && asset.canEnterBackground) errors.push(`${asset.id}: page screenshot is reference only and cannot enter final background`);
    if (asset.priority === "must_keep" && !asset.editableRole) warnings.push(`${asset.id}: missing editable role`);
    if (asset.needsCutout && !/local_first/.test(asset.route || "")) warnings.push(`${asset.id}: cutout should route local first`);
  }
  if (!Array.isArray(manifest.source_refs) || !manifest.source_refs.length) warnings.push("source_refs missing or empty");
  return {
    version: 1,
    status: errors.length ? "block" : warnings.length ? "warn" : "pass",
    assetCount: assets.length,
    criticalCount: assets.filter((asset) => asset.priority === "must_keep").length,
    backgroundBlockedCount: assets.filter((asset) => asset.canEnterBackground === false).length,
    errors,
    warnings,
    checks: {
      noCriticalBackground: !errors.some((item) => /background/.test(item)),
      textNative: assets.filter((asset) => asset.kind === "text").every((asset) => asset.editableRole === "textBox"),
      localFirstCutout: !warnings.some((item) => /cutout/.test(item)),
      sourceRefsPresent: Array.isArray(manifest.source_refs) && manifest.source_refs.length > 0,
      pageScreenshotsReferenceOnly: assets.filter((asset) => asset.kind === "page-screenshot").every((asset) => asset.canEnterBackground === false)
    }
  };
}
