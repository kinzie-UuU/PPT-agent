import fs from "fs";
import path from "path";

const SLIDE_W = 13.333;
const SLIDE_H = 7.5;
const IMAGE_RE = /\.(png|jpe?g|webp|svg)$/i;
const PDF_RE = /\.pdf$/i;
const IMAGE_LED = new Set(["cover", "visual", "product-detail", "bundle", "gallery", "closing", "case"]);
const IMAGE_HEAVY_ROLES = new Set(["cover", "case", "gallery", "product-detail", "bundle", "visual"]);

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function toList(value) {
  if (Array.isArray(value)) return value.map(cleanText).filter(Boolean);
  if (!value) return [];
  return String(value).split(/\r?\n|[;,，；、]+/).map(cleanText).filter(Boolean);
}

function safeId(value = "") {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
}

function isImageFile(file = {}) {
  return IMAGE_RE.test(file.originalName || file.path || "") || /^image\//i.test(file.mimeType || "");
}

function normalizeName(value = "") {
  return String(value || "").toLowerCase().replace(/\s+/g, "").replace(/[^\u4e00-\u9fa5a-z0-9]/g, "");
}

function getImageFiles(files = []) {
  return files.filter((file) => isImageFile(file) && file.materialRole !== "visual-target-reference").map((file, index) => ({
    ...file,
    _imageIndex: index,
    _matchName: normalizeName(file.originalName || path.basename(file.path || "")),
    _sourceMatchName: normalizeName(file.sourceImageName || file.sourceImageId || "")
  }));
}

function pickImageForSlide(files = [], slide = {}, index = 0, assetManifest = {}) {
  const images = getImageFiles(files);
  if (!images.length || !IMAGE_LED.has(slide.layout || slide.role)) return null;
  if (images.length === 1) return images[0];
  const binding = slideBindingFor(assetManifest, index + 1);
  const boundIds = new Set([
    ...(binding.visualAssetIds || []),
    ...(binding.criticalImageIds || [])
  ]);
  const byBoundAsset = bestImageMatch(images, (image) => boundIds.has(image.id) || boundIds.has(image.sourceUploadId));
  if (byBoundAsset) return { ...byBoundAsset, _selectionReason: selectionReasonForImage(byBoundAsset, "page-bound-asset-manifest") };
  const exactSourcePage = bestImageMatch(images, (image) => Number(image.sourceSlide || 0) === index + 1);
  if (exactSourcePage) return { ...exactSourcePage, _selectionReason: selectionReasonForImage(exactSourcePage, "source-slide-exact-match") };
  const slots = toList(slide.imageSlots).map(normalizeName).filter(Boolean);
  for (const slot of slots) {
    const hit = bestImageMatch(images, (image) => imageMatchesSlot(image, slot) && isReusableForSlide(image, index + 1));
    if (hit) return { ...hit, _selectionReason: selectionReasonForImage(hit, "matched-slide-image-slot") };
  }
  const globalReusable = bestImageMatch(images, (image) => isGlobalReusableImage(image));
  if (globalReusable) return { ...globalReusable, _selectionReason: "global-reusable-logo-or-icon" };
  return null;
}

function selectionReasonForImage(image = {}, fallback = "matched-slide-image-slot") {
  return /foreground-cutout|cutout/i.test([image.materialRole, image.source, image.originalName, image.mattingStatus].filter(Boolean).join(" "))
    ? "preferred-foreground-cutout"
    : fallback;
}

function slideBindingFor(assetManifest = {}, slideNumber = 0) {
  return (assetManifest.slideBindings || []).find((binding) => Number(binding.slide || 0) === Number(slideNumber || 0)) || {};
}

function isReusableForSlide(image = {}, slideNumber = 0) {
  const sourceSlide = Number(image.sourceSlide || 0);
  return !sourceSlide || sourceSlide === Number(slideNumber || 0) || isGlobalReusableImage(image);
}

function isGlobalReusableImage(image = {}) {
  const text = [image.materialRole, image.source, image.originalName, image.sourceImageName].filter(Boolean).join(" ");
  return /logo|mark|icon|decor|brand|标识|品牌|图标/i.test(text) && !/product|pack|sku|chart|礼盒|包装|产品|图表/i.test(text);
}

function imageMatchesSlot(image = {}, slot = "") {
  if (!slot) return false;
  return Boolean(
    (image._matchName && (image._matchName.includes(slot) || slot.includes(image._matchName)))
    || (image._sourceMatchName && (image._sourceMatchName.includes(slot) || slot.includes(image._sourceMatchName)))
  );
}

function bestImageMatch(images = [], predicate = () => false) {
  return rankImages(images.filter(predicate))[0] || null;
}

function rankImages(images = []) {
  return [...images].sort((a, b) => imagePriorityScore(b) - imagePriorityScore(a) || Number(a._imageIndex || 0) - Number(b._imageIndex || 0));
}

function imagePriorityScore(image = {}) {
  let score = 0;
  const text = [image.materialRole, image.source, image.mattingStatus, image.originalName, image.sourceImageName].filter(Boolean).join(" ");
  if (/foreground-cutout|cutout|transparent|抠图/i.test(text)) score += 80;
  if (/local-pass|cloud-pass/i.test(text)) score += 40;
  if (image.derived) score += 12;
  if (image.needsCutout === false) score += 8;
  if (/product|pack|sku|hero|foreground|礼盒|包装|产品/i.test(text)) score += 6;
  if (/background|atmosphere|visual-target-reference/i.test(text)) score -= 30;
  return score;
}

export function buildVisualTarget({ job = {}, routePlan = {}, materialBrief = {} } = {}) {
  const deck = job.deck || {};
  const slides = Array.isArray(deck.slides) ? deck.slides : [];
  const sourceReport = materialBrief.sourceReport || routePlan.sourceReport || {};
  const styleFingerprint = routePlan.styleReferenceStrategy?.fingerprint || {};
  const aestheticPlan = routePlan.aestheticPlan || {};
  const palette = inferPalette({ routePlan, aestheticPlan, styleFingerprint });
  const density = inferDensity(slides);
  const imagePolicy = inferImagePolicy({ files: job.files || [], sourceReport, slides });
  const pageTargets = slides.map((slide, index) => ({
    slideId: `slide_${String(index + 1).padStart(2, "0")}`,
    role: normalizeRole(slide.layout || routePlan.layoutSequence?.[index]?.layout, index, slides.length),
    visualIntent: cleanText(slide.visualIntent || routePlan.layoutSequence?.[index]?.purpose || ""),
    composition: pageCompositionFor(slide.layout || routePlan.layoutSequence?.[index]?.layout, index, slides.length),
    imagePriority: IMAGE_LED.has(slide.layout) ? "high" : "medium",
    textDensity: estimateSlideTextLoad(slide) > 260 ? "compress" : "normal"
  }));
  return {
    version: 1,
    engine: "codex-ppt/img2-inspired-visual-target",
    status: "brief-ready",
    source: "derived-from-route-deck-and-style",
    noFullSlideRasterAsFinal: true,
    palette,
    density,
    imagePolicy,
    styleBrief: [
      routePlan.recommendedTheme ? `theme=${routePlan.recommendedTheme}` : "",
      routePlan.deckType ? `deckType=${routePlan.deckType}` : "",
      aestheticPlan.theme ? `aesthetic=${aestheticPlan.theme}` : "",
      styleFingerprint.summary || styleFingerprint.prompt || ""
    ].filter(Boolean).join(" / "),
    sample: {
      status: "not-generated",
      purpose: "visual reference only; final PPTX must render from editable SceneGraph",
      imagePath: null,
      prompt: buildVisualSamplePrompt({ deck, routePlan, palette, density, imagePolicy }),
      reason: "SceneGraph-first implementation keeps img2 targets out of final PPT background"
    },
    pageTargets
  };
}

export function buildSceneGraph({ job = {}, routePlan = {}, materialBrief = {}, visualTarget = null } = {}) {
  const deck = job.deck || {};
  const slides = Array.isArray(deck.slides) ? deck.slides : [];
  const target = visualTarget || buildVisualTarget({ job, routePlan, materialBrief });
  const sceneSlides = slides.map((slide, index) => buildSceneSlide({
    slide,
    index,
    total: slides.length,
    files: job.files || [],
    routeStep: routePlan.layoutSequence?.[index] || {},
    target: target.pageTargets?.[index] || {},
    palette: target.palette,
    assetManifest: job.assetManifest || {},
    visualProject: job.visualProject || {}
  }));
  return {
    version: 2,
    createdAt: new Date().toISOString(),
    source: "asset-first-hybrid-scenegraph",
    constraints: {
      editable: true,
      noFullSlideRaster: true,
      previewFromSceneGraphOrPptx: true,
      textMustBeNative: true,
      criticalAssetsMustBeIndependent: true
    },
    layerModel: {
      background: "main visual atmosphere only; no critical facts",
      assets: "independent images/icons/logos/products/charts",
      shapes: "native editable cards, lines, labels, dividers",
      texts: "native editable titles, body, prices, labels"
    },
    assetManifest: {
      status: job.assetManifest?.status || "not-provided",
      assetCount: job.assetManifest?.assets?.length || 0,
      criticalCount: job.assetManifest?.criticalCount || 0,
      backgroundBlockedCount: job.assetManifest?.backgroundBlockedCount || 0
    },
    visualTarget: {
      status: target.status,
      engine: target.engine,
      sampleStatus: target.sample?.status || "not-generated"
    },
    visualProject: {
      status: job.visualProject?.status || "not-provided",
      slideCount: job.visualProject?.slideCount || 0,
      generatedImages: job.visualProject?.generatedImages || 0,
      referenceOnly: true
    },
    editableManifest: summarizeEditableManifest(job),
    slides: sceneSlides
  };
}

export function validateSceneGraph(sceneGraph = {}) {
  const warnings = [];
  const errors = [];
  const slides = Array.isArray(sceneGraph.slides) ? sceneGraph.slides : [];
  if (sceneGraph.editableManifest?.status === "warn") warnings.push(...(sceneGraph.editableManifest.warnings || []).slice(0, 4));
  if (sceneGraph.editableManifest?.pdfPending) warnings.push("PDF source pages are not rendered to per-page source images yet");
  if (!slides.length) errors.push("sceneGraph.slides is empty");
  slides.forEach((slide, index) => {
    const prefix = `slide ${index + 1}`;
    if (!slide.constraints?.editable) errors.push(`${prefix}: editable constraint missing`);
    if (slide.background?.imagePath && slide.background?.mode === "full-slide-raster") errors.push(`${prefix}: full-slide raster background is forbidden`);
    const bg = slide.layers?.background || {};
    if (bg.containsCriticalText || bg.containsLogo || bg.containsProductHero || bg.containsKeyData) errors.push(`${prefix}: background layer contains critical content`);
    const textCoverage = slide.source?.textCoverage || {};
    if (textCoverage.missingExpectedItems?.length) warnings.push(`${prefix}: expected editable text missing ${textCoverage.missingExpectedItems.join(",")}`);
    const textCount = (slide.texts || []).length;
    const titleCount = (slide.texts || []).filter((item) => item.role === "title").length;
    if (!titleCount) warnings.push(`${prefix}: missing title text box`);
    if (!textCount) warnings.push(`${prefix}: no editable text boxes`);
    if (slide.constraints?.visualPriority === "high" && !(slide.images || []).some((image) => image.path)) warnings.push(`${prefix}: missing-required-image-object`);
    for (const image of slide.images || []) {
      if (!image.path && image.required) warnings.push(`${prefix}: required image missing for ${image.id}`);
      if (image.fullSlide) errors.push(`${prefix}: image ${image.id} is marked fullSlide`);
      if (image.provenance?.source === "visual-target-reference" || image.materialRole === "visual-target-reference") errors.push(`${prefix}: visual target sample cannot be used as a final slide image`);
      const area = Number(image.box?.w || 0) * Number(image.box?.h || 0);
      if (area > SLIDE_W * SLIDE_H * 0.88) errors.push(`${prefix}: image ${image.id} looks like a full-slide raster`);
    }
  });
  const textBoxes = slides.reduce((sum, slide) => sum + (slide.texts || []).length, 0);
  const shapeCount = slides.reduce((sum, slide) => sum + (slide.shapes || []).length + (slide.decorations || []).length, 0);
  const imageCount = slides.reduce((sum, slide) => sum + (slide.images || []).filter((image) => image.path).length, 0);
  const backgroundViolationCount = slides.filter((slide) => {
    const bg = slide.layers?.background || {};
    return bg.containsCriticalText || bg.containsLogo || bg.containsProductHero || bg.containsKeyData;
  }).length;
  return {
    version: 2,
    status: errors.length ? "block" : warnings.length ? "warn" : "pass",
    editable: !errors.length,
    textBoxes,
    shapeCount,
    imageCount,
    backgroundViolationCount,
    slideCount: slides.length,
    errors,
    warnings,
    checks: {
      nativeText: textBoxes > 0,
      nativeShapes: shapeCount > 0,
      independentImages: true,
      noFullSlideRaster: !errors.some((item) => /full-slide|fullSlide/i.test(item)),
      backgroundSafe: backgroundViolationCount === 0
    }
  };
}

function summarizeEditableManifest(job = {}) {
  const plan = job.editableRebuildPlan || null;
  const files = Array.isArray(job.files) ? job.files : [];
  const pdfFiles = files.filter((file) => PDF_RE.test(file.originalName || file.path || "") || /pdf/i.test(file.mimeType || ""));
  if (plan) {
    return {
      schemaVersion: plan.schemaVersion || 1,
      status: plan.status || "unknown",
      candidate: Boolean(plan.candidate),
      inputType: plan.inputType || (pdfFiles.length ? "pdf" : "mixed"),
      pageCount: Number(plan.pageCount || 0),
      pdfPending: pdfFiles.length > 0 && (plan.stages || []).some((stage) => stage.id === "source-normalize" && stage.status === "warn"),
      warnings: (plan.warnings || []).slice(0, 8)
    };
  }
  return {
    schemaVersion: 1,
    status: pdfFiles.length ? "warn" : "not-provided",
    candidate: false,
    inputType: pdfFiles.length ? "pdf" : "mixed",
    pageCount: 0,
    pdfPending: pdfFiles.length > 0,
    warnings: pdfFiles.length ? ["PDF source pages are pending per-page rendering before final editable reconstruction"] : []
  };
}

export function compareVisualTarget(sceneGraph = {}, visualTarget = {}) {
  const slides = Array.isArray(sceneGraph.slides) ? sceneGraph.slides : [];
  const targetSlides = Array.isArray(visualTarget.pageTargets) ? visualTarget.pageTargets : [];
  const items = slides.map((slide, index) => {
    const target = targetSlides[index] || {};
    const textCount = (slide.texts || []).length;
    const imageArea = (slide.images || []).reduce((sum, image) => sum + Number(image.box?.w || 0) * Number(image.box?.h || 0), 0);
    const imageAreaRatio = imageArea / (SLIDE_W * SLIDE_H);
    const wantsImage = target.imagePriority === "high";
    const requiredAreaRatio = Number(target.imageAreaRatio || slide.constraints?.targetImageAreaRatio || imageAreaRatioForRole(slide.role, wantsImage));
    const imageAreaOk = !wantsImage || imageAreaRatio >= requiredAreaRatio * 0.82;
    const hasRequiredMissingImage = (slide.images || []).some((image) => image.required && !image.path);
    const layoutMatch = !target.role || target.role === slide.role;
    const score = Math.max(0.35, Math.min(1, 0.45
      + (layoutMatch ? 0.2 : 0)
      + (textCount ? 0.15 : 0)
      + (imageAreaOk && !hasRequiredMissingImage ? 0.15 : 0)
      + ((slide.shapes || []).length ? 0.05 : 0)));
    const warnings = [
      layoutMatch ? "" : "role-mismatch",
      wantsImage && !imageAreaOk ? `image-area-too-small:${Math.round(imageAreaRatio * 100)}%/${Math.round(requiredAreaRatio * 100)}%` : "",
      wantsImage && (!imageArea || hasRequiredMissingImage) ? "missing-required-image-object" : "",
      !textCount ? "missing-editable-text" : ""
    ].filter(Boolean);
    return {
      slideId: slide.id,
      score: Math.round(score * 100),
      status: warnings.length ? "warn" : "pass",
      warnings,
      metrics: {
        imageAreaRatio: Math.round(imageAreaRatio * 1000) / 1000,
        requiredImageAreaRatio: Math.round(requiredAreaRatio * 1000) / 1000
      }
    };
  });
  const average = items.length ? Math.round(items.reduce((sum, item) => sum + item.score, 0) / items.length) : 0;
  return {
    version: 1,
    status: items.some((item) => item.status === "warn") ? "warn" : "pass",
    score: average,
    method: "structural-proxy-until-image-diff-is-enabled",
    note: "Final preview must still come from SceneGraph/PPTX; img2 target is not a final background.",
    items
  };
}

export function compareRenderedPreviewToVisualTarget({
  sceneGraph = {},
  visualTarget = {},
  previewImages = [],
  previewQa = [],
  targetQa = null
} = {}) {
  const slides = Array.isArray(sceneGraph.slides) ? sceneGraph.slides : [];
  const previewCount = (previewImages || []).filter(Boolean).length;
  const countScore = slides.length && previewCount === slides.length ? 20 : 0;
  const qaItems = Array.isArray(previewQa) ? previewQa : [];
  const riskCount = qaItems.reduce((sum, item) => sum + (item.risks || []).length, 0);
  const blankCount = qaItems.filter((item) => (item.risks || []).includes("image-may-be-too-blank")).length;
  const averageVariance = qaItems.length ? qaItems.reduce((sum, item) => sum + Number(item.full?.variance || 0), 0) / qaItems.length : 0;
  const editableSignals = slides.reduce((sum, slide) => sum + (slide.texts?.length ? 1 : 0) + (slide.shapes?.length ? 1 : 0), 0);
  const editableScore = slides.length ? Math.min(25, Math.round((editableSignals / (slides.length * 2)) * 25)) : 0;
  const visualRichnessScore = Math.max(0, Math.min(25, Math.round((averageVariance / 36) * 25)));
  const riskPenalty = Math.min(25, riskCount * 4 + blankCount * 6);
  const targetSimilarityScore = targetQa && qaItems.length ? compareQaMetricSimilarity(qaItems[0], targetQa) : 15;
  const score = Math.max(0, Math.min(100, countScore + editableScore + visualRichnessScore + targetSimilarityScore - riskPenalty + 15));
  const warnings = [
    slides.length && previewCount !== slides.length ? `preview-count-mismatch:${previewCount}/${slides.length}` : "",
    riskCount ? `preview-qa-risks:${riskCount}` : "",
    blankCount ? `blank-preview-pages:${blankCount}` : "",
    targetQa ? "" : "visual-target-sample-not-generated"
  ].filter(Boolean);
  return {
    version: 1,
    status: score < 72 || warnings.some((item) => /^preview-count|blank-preview/.test(item)) ? "warn" : "pass",
    score,
    method: "pptx-preview-pixel-qa",
    previewCount,
    targetSampleChecked: Boolean(targetQa),
    note: "Final preview is rendered from editable PPTX/SceneGraph; visual target is reference only, never pasted as a final background.",
    warnings,
    items: qaItems.map((item, index) => ({
      slideId: slides[index]?.id || `slide_${String(index + 1).padStart(2, "0")}`,
      score: item.status === "pass" ? 88 : 68,
      status: item.status,
      warnings: item.risks || [],
      metrics: item.full || null
    }))
  };
}

export function buildSceneGraphRepairRecord(sceneGraph = {}, visualCompare = {}, sceneGraphQa = {}) {
  const actions = [];
  const blockers = [];
  if (sceneGraphQa.status === "block") {
    blockers.push(...(sceneGraphQa.errors || []));
  }
  for (const error of sceneGraphQa.errors || []) {
    const slideId = slideIdFromQaMessage(error);
    if (/background layer contains critical content/i.test(error)) actions.push({ slideId, action: "sanitize-background-layer", status: "planned", reason: error });
    if (/full-slide raster|fullSlide|looks like a full-slide raster/i.test(error)) actions.push({ slideId, action: "remove-full-slide-raster-risk", status: "planned", reason: error });
    if (/visual target sample cannot be used/i.test(error)) actions.push({ slideId, action: "remove-visual-target-reference-image", status: "planned", reason: error });
    if (/missing editable key data|missing editable data|价格数据|关键数据/i.test(error)) actions.push({ slideId, action: "rebuild-native-text-boxes", status: "planned", reason: error });
  }
  for (const warning of sceneGraphQa.warnings || []) {
    const slideId = slideIdFromQaMessage(warning);
    if (/expected editable text missing|missing title text box|no editable text boxes/i.test(warning)) actions.push({ slideId, action: "rebuild-native-text-boxes", status: "planned", reason: warning });
    if (/missing-required-image-object|required image missing/i.test(warning)) actions.push({ slideId, action: "bind-or-generate-independent-image", status: "planned", reason: warning });
  }
  for (const item of visualCompare.items || []) {
    for (const warning of item.warnings || []) {
      if (/^image-area-too-small/.test(warning)) actions.push({ slideId: item.slideId, action: "increase-or-bind-image-area", status: "planned", reason: warning });
      if (warning === "missing-required-image-object") actions.push({ slideId: item.slideId, action: "bind-or-generate-independent-image", status: "planned", reason: warning });
      if (warning === "missing-editable-text") actions.push({ slideId: item.slideId, action: "rebuild-native-text-boxes", status: "planned", reason: warning });
      if (warning === "role-mismatch") actions.push({ slideId: item.slideId, action: "recompile-layout-role", status: "planned", reason: warning });
      if (warning === "image-may-be-too-blank" || warning === "blank-preview-pages") actions.push({ slideId: item.slideId, action: "increase-visual-hierarchy", status: "planned", reason: warning });
      if (warning === "text-safe-area-too-busy") actions.push({ slideId: item.slideId, action: "move-text-away-from-busy-region", status: "planned", reason: warning });
    }
  }
  const uniqueActions = dedupeActions(actions);
  return {
    version: 1,
    status: blockers.length && !uniqueActions.length ? "blocked" : uniqueActions.length ? "planned" : "not-needed",
    policy: "repair SceneGraph, never paste visual target as final background",
    blockers,
    actions: uniqueActions,
    completed: [],
    pendingCount: uniqueActions.length
  };
}

function slideIdFromQaMessage(message = "") {
  const text = String(message || "");
  const explicit = text.match(/^([a-z][\w-]*_\w[\w-]*):/i);
  if (explicit) return explicit[1];
  const match = text.match(/slide\s+(\d+)/i);
  const index = Number(match?.[1] || 1);
  return `slide_${String(Math.max(1, index)).padStart(2, "0")}`;
}

export function applySceneGraphRepairPlan(sceneGraph = {}, repairRecord = {}) {
  const actions = Array.isArray(repairRecord.actions) ? repairRecord.actions : [];
  if (!actions.length) return { sceneGraph, repairRecord };
  const completed = [];
  const nextSlides = (sceneGraph.slides || []).map((slide) => {
    let next = { ...slide, texts: [...(slide.texts || [])], shapes: [...(slide.shapes || [])], images: [...(slide.images || [])], decorations: [...(slide.decorations || [])] };
    const slideActions = actions.filter((action) => action.slideId === slide.id);
    for (const action of slideActions) {
      if (action.action === "rebuild-native-text-boxes") {
        const beforeCount = next.texts.length;
        next = ensureRepairTextObjects(next, action);
        if (next.texts.length > beforeCount) completed.push({ ...action, status: "done" });
      } else if (action.action === "increase-or-bind-image-area" && next.images.length) {
        next.images = next.images.map((image, index) => index === 0 ? { ...image, box: { x: 6.55, y: 1.05, w: 5.65, h: 5.15 } } : image);
        completed.push({ ...action, status: "done" });
      } else if (action.action === "increase-visual-hierarchy") {
        next.decorations = [...(next.decorations || []), {
          id: `repair_hierarchy_${completed.length + 1}`,
          type: "rect",
          box: { x: 0.72, y: 6.72, w: 4.8, h: 0.12 },
          fillRole: "accent",
          lineRole: "accent",
          editable: true
        }];
        next.shapes = [...(next.shapes || []), {
          id: `repair_soft_panel_${completed.length + 1}`,
          type: "roundRect",
          box: { x: 0.62, y: 0.62, w: 5.95, h: 5.95 },
          radius: 0.05,
          fillRole: "paper",
          lineRole: "soft",
          transparency: 6,
          editable: true
        }];
        completed.push({ ...action, status: "done" });
      } else if (action.action === "move-text-away-from-busy-region" && next.texts.length) {
        next.texts = next.texts.map((text) => ({
          ...text,
          box: {
            ...(text.box || {}),
            x: Math.max(0.72, Math.min(6.2, Number(text.box?.x || 0.8))),
            w: Math.min(Number(text.box?.w || 5.4), 5.65)
          }
        }));
        completed.push({ ...action, status: "done" });
      } else if (action.action === "bind-or-generate-independent-image") {
        if (!next.images.length) {
          next.images.push(requiredImagePlaceholder("repair_required_image", "content", { x: 7.0, y: 1.25, w: 5.1, h: 4.85 }, action));
        } else {
          next.images = next.images.map((image, index) => index === 0 && !image.path ? { ...image, required: true, fullSlide: false, editable: true } : image);
        }
        completed.push({ ...action, status: "done", materialStatus: "pending-bind-or-generate" });
      } else if (action.action === "sanitize-background-layer") {
        const currentBackground = next.layers?.background || {};
        next = ensureCriticalObjectsForSanitizedBackground(next, currentBackground, action);
        next.layers = {
          ...(next.layers || {}),
          background: {
            ...currentBackground,
            containsCriticalText: false,
            containsLogo: false,
            containsProductHero: false,
            containsKeyData: false,
            repairNote: "Critical content flags cleared; critical assets must be represented as native text or independent image objects."
          }
        };
        completed.push({ ...action, status: "done" });
      } else if (action.action === "remove-full-slide-raster-risk" && next.images.length) {
        next.images = next.images.map((image) => ({
          ...image,
          fullSlide: false,
          fit: image.fit === "cover" ? "contain" : image.fit,
          box: shrinkFullSlideImageBox(image.box)
        }));
        completed.push({ ...action, status: "done" });
      } else if (action.action === "remove-visual-target-reference-image") {
        const before = next.images.length;
        next.images = next.images.filter((image) => image.provenance?.source !== "visual-target-reference" && image.materialRole !== "visual-target-reference");
        if (next.images.length !== before) completed.push({ ...action, status: "done" });
      }
    }
    return next;
  });
  const completedKeys = new Set(completed.map((item) => `${item.slideId}:${item.action}`));
  const remaining = actions.filter((item) => !completedKeys.has(`${item.slideId}:${item.action}`));
  return {
    sceneGraph: { ...sceneGraph, slides: nextSlides },
    repairRecord: {
      ...repairRecord,
      status: remaining.length ? repairRecord.status : "repaired",
      actions: remaining,
      completed: [...(repairRecord.completed || []), ...completed],
      pendingCount: remaining.length
    }
  };
}

function shrinkFullSlideImageBox(box = {}) {
  const area = Number(box?.w || 0) * Number(box?.h || 0);
  if (area <= SLIDE_W * SLIDE_H * 0.72) return box;
  return { x: 6.55, y: 1.05, w: 5.65, h: 5.15 };
}

function ensureCriticalObjectsForSanitizedBackground(slide = {}, background = {}, action = {}) {
  const next = {
    ...slide,
    texts: [...(slide.texts || [])],
    images: [...(slide.images || [])],
    shapes: [...(slide.shapes || [])],
    decorations: [...(slide.decorations || [])]
  };
  if ((background.containsCriticalText || background.containsKeyData) && !next.texts.length) {
    next.texts.push({
      id: "repair_background_text",
      type: "text",
      role: background.containsCriticalText ? "title" : "data",
      text: cleanText(slide.source?.title || "Recovered editable content"),
      box: { x: 0.82, y: 0.82, w: 7.8, h: 0.62 },
      style: { fontFace: "Microsoft YaHei", fontSize: background.containsKeyData ? 15 : 24, bold: true, colorRole: "ink", fit: "shrink" },
      editable: true,
      provenance: { source: "background-sanitizer", reason: action.reason || "critical text moved out of background" }
    });
  }
  if (background.containsLogo && !next.images.some((image) => image.role === "logo")) {
    next.images.push(requiredImagePlaceholder("repair_required_logo", "logo", { x: 0.82, y: 6.55, w: 1.55, h: 0.48 }, action));
  }
  if (background.containsProductHero && !next.images.some((image) => image.role === "product" || image.role === "hero")) {
    next.images.push(requiredImagePlaceholder("repair_required_product", "product", { x: 8.05, y: 1.1, w: 3.9, h: 4.65 }, action));
  }
  return next;
}

function ensureRepairTextObjects(slide = {}, action = {}) {
  const next = { ...slide, texts: [...(slide.texts || [])] };
  const reason = String(action.reason || "");
  const missingTitle = !next.texts.some((text) => text.role === "title") || /title|no editable text boxes|missing-editable-text/i.test(reason);
  const missingData = /data|price|key data|价格|数据/i.test(reason) && !next.texts.some((text) => text.role === "data");
  if (missingTitle) {
    next.texts.push(repairTextObject("repair_title", "title", cleanText(slide.source?.title || "Recovered editable title"), { x: 0.8, y: 0.8, w: 8.8, h: 0.7 }, action));
  }
  if (missingData) {
    next.texts.push(repairTextObject("repair_data", "data", cleanText(slide.source?.data || slide.source?.title || "Recovered editable data"), { x: 0.85, y: 1.68, w: 4.8, h: 0.48 }, action));
  }
  return next;
}

function repairTextObject(id, role, text, box, action = {}) {
  return {
    id,
    type: "text",
    role,
    text,
    box,
    style: { fontFace: "Microsoft YaHei", fontSize: role === "title" ? 24 : 15, bold: true, colorRole: "ink", fit: "shrink" },
    editable: true,
    provenance: { source: "scenegraph-text-repair", reason: action.reason || "" }
  };
}

function requiredImagePlaceholder(id, role, box, action = {}) {
  return {
    id,
    type: "image",
    role,
    path: "",
    name: `${role}-required-independent-asset`,
    box,
    fit: "contain",
    editable: true,
    fullSlide: false,
    required: true,
    provenance: {
      source: "background-sanitizer",
      selectionReason: "critical-background-content-moved-to-independent-object",
      repairReason: action.reason || ""
    }
  };
}


export function buildVisualTargetSamplePrompt(target = {}) {
  return target.sample?.prompt || buildVisualSamplePrompt({
    deck: {},
    routePlan: {},
    palette: target.palette || {},
    density: target.density || "balanced",
    imagePolicy: target.imagePolicy || {}
  });
}

export function ensureSceneGraphForJob(job = {}) {
  const routePlan = job.input?.routePlan || {};
  const materialBrief = job.input?.materialBrief || {};
  const previousTarget = job.visualTarget || null;
  const visualTarget = mergeVisualTarget(buildVisualTarget({ job, routePlan, materialBrief }), previousTarget);
  const sceneGraph = buildSceneGraph({ job, routePlan, materialBrief, visualTarget });
  const sceneGraphQa = validateSceneGraph(sceneGraph);
  const structuralCompare = compareVisualTarget(sceneGraph, visualTarget);
  const previousCompare = job.visualCompare || null;
  const visualCompare = previousCompare?.method === "pptx-preview-pixel-qa" ? previousCompare : structuralCompare;
  let repairRecord = buildSceneGraphRepairRecord(sceneGraph, visualCompare, sceneGraphQa);
  const repaired = applySceneGraphRepairPlan(sceneGraph, repairRecord);
  const finalSceneGraph = applySceneGraphOverrides(repaired.sceneGraph, job.sceneGraphOverrides);
  repairRecord = repaired.repairRecord;
  const finalQa = validateSceneGraph(finalSceneGraph);
  job.visualTarget = visualTarget;
  job.sceneGraph = finalSceneGraph;
  job.sceneGraphQa = finalQa;
  job.visualCompare = visualCompare;
  job.sceneGraphRepair = repairRecord;
  return { visualTarget, sceneGraph: finalSceneGraph, sceneGraphQa: finalQa, visualCompare, sceneGraphRepair: repairRecord };
}

export function applySceneGraphOverrides(sceneGraph = {}, overrides = {}) {
  const bySlide = overrides.slides || overrides || {};
  if (!bySlide || typeof bySlide !== "object") return sceneGraph;
  const slides = (sceneGraph.slides || []).map((slide) => {
    const override = bySlide[slide.id] || bySlide[String(slide.index)] || null;
    if (!override) return slide;
    const texts = applyTextOverrides(slide.texts || [], override.texts || {});
    const nextSlide = {
      ...slide,
      texts,
      layers: {
        ...(slide.layers || {}),
        texts
      },
      overrides: {
        ...(slide.overrides || {}),
        ...(override.meta || {}),
        source: override.source || "online-editor",
        updatedAt: override.updatedAt || new Date().toISOString()
      }
    };
    return nextSlide;
  });
  return {
    ...sceneGraph,
    slides,
    overridesApplied: Object.keys(bySlide).length,
    updatedAt: new Date().toISOString()
  };
}

function applyTextOverrides(texts = [], overrides = {}) {
  if (!overrides || typeof overrides !== "object") return texts;
  return texts.map((text) => {
    const value = overrides[text.id] ?? overrides[text.role];
    if (value === undefined || value === null) return text;
    return { ...text, text: cleanText(value) };
  });
}

function mergeVisualTarget(nextTarget = {}, previousTarget = null) {
  if (!previousTarget) return nextTarget;
  const previousSample = previousTarget.sample || {};
  const hasGeneratedOrPendingSample = ["generated", "pending-local-image", "queued"].includes(previousSample.status);
  return {
    ...nextTarget,
    sample: hasGeneratedOrPendingSample ? { ...(nextTarget.sample || {}), ...previousSample } : nextTarget.sample
  };
}

function buildSceneSlide({ slide = {}, index = 0, total = 1, files = [], routeStep = {}, target = {}, palette = {}, assetManifest = {}, visualProject = {} }) {
  const role = normalizeRole(slide.layout || routeStep.layout, index, total);
  const wantsImage = target.imagePriority === "high" || IMAGE_HEAVY_ROLES.has(role) || toList(slide.imageSlots).length > 0;
  const image = pickImageForSlide(files, { ...slide, role }, index, assetManifest);
  const layout = layoutBoxes(role, Boolean(image) || wantsImage);
  const expectedTextItems = expectedTextItemsForSlide(slide, role);
  const texts = buildTextObjects(slide, layout, role, expectedTextItems);
  applyCanvasEditsToTexts(texts, slide.canvasEdits);
  const shapes = buildShapeObjects(role, layout, palette);
  const requiredImageMissing = wantsImage && !image;
  const images = image ? [buildImageObject(image, layout.image, role)] : requiredImageMissing ? [buildMissingImageObject(layout.image, role, index)] : [];
  const decorations = buildDecorations(role, palette);
  const slideAssets = (assetManifest.assets || []).filter((asset) => !asset.sourceSlide || Number(asset.sourceSlide) === index + 1);
  const visualTargetImage = visualProjectImageForSlide(visualProject, index);
  const backgroundLayer = buildBackgroundLayer({ role, palette, target, slideAssets });
  return {
    id: `slide_${String(index + 1).padStart(2, "0")}`,
    index: index + 1,
    role,
    layout: slide.layout || role,
    size: { w: SLIDE_W, h: SLIDE_H },
    background: { type: "solid", color: palette.bg || "F7F8F4" },
    layers: {
      background: backgroundLayer,
      assets: images,
      shapes: [...decorations, ...shapes],
      texts
    },
    texts,
    shapes,
    images,
    decorations,
    notes: cleanText(slide.speakerNotes || ""),
    source: {
      title: cleanText(slide.title),
      imageSlots: toList(slide.imageSlots),
      visualTargetImage,
      visualTargetReferenceOnly: Boolean(visualTargetImage),
      visualIntent: cleanText(slide.visualIntent || target.visualIntent || routeStep.purpose || ""),
      textCoverage: summarizeTextCoverage(expectedTextItems, texts, slide)
    },
    constraints: {
      editable: true,
      noFullSlideRaster: true,
      visualPriority: target.imagePriority || (IMAGE_LED.has(role) ? "high" : "medium"),
      targetImageAreaRatio: target.imageAreaRatio || imageAreaRatioForRole(role, wantsImage),
      textMustBeNative: true,
      criticalAssetsMustBeIndependent: true,
      backgroundForbiddenKinds: slideAssets.filter((asset) => asset.canEnterBackground === false).map((asset) => asset.kind)
    }
  };
}

function visualProjectImageForSlide(visualProject = {}, index = 0) {
  const originDir = visualProject.originImageDir || "";
  if (!originDir) return null;
  const candidates = [
    path.join(originDir, `slide_${String(index + 1).padStart(2, "0")}.png`),
    path.join(originDir, `slide_${String(index + 1).padStart(2, "0")}.jpg`),
    path.join(originDir, `slide_${String(index + 1).padStart(2, "0")}.jpeg`),
    path.join(originDir, `slide_${String(index + 1).padStart(2, "0")}.webp`)
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function buildBackgroundLayer({ role = "", palette = {}, target = {}, slideAssets = [] } = {}) {
  const blockedKinds = new Set(slideAssets.filter((asset) => asset.canEnterBackground === false).map((asset) => asset.kind));
  return {
    id: "main_visual_background",
    type: "solid-or-generated-atmosphere",
    purpose: "main-visual-atmosphere",
    color: palette.bg || "F7F8F4",
    visualTargetSlideId: target.slideId || null,
    role,
    editable: false,
    canContain: ["atmosphere", "texture", "light", "abstract-decoration", "soft-scene"],
    forbiddenKinds: [...blockedKinds],
    containsCriticalText: false,
    containsLogo: false,
    containsProductHero: false,
    containsKeyData: false,
    notes: "Background is a main-visual layer only; titles, body, prices, logos, products, charts, and customer names must remain native/independent."
  };
}

function buildTextObjects(slide = {}, layout = {}, role = "", expectedItems = null) {
  const texts = [];
  const items = expectedItems || expectedTextItemsForSlide(slide, role);
  const title = items.find((item) => item.role === "title")?.text || "Untitled";
  texts.push(textObject("title", "title", title, layout.title, { fontSize: role === "cover" ? 34 : 25, bold: true }));
  const subtitle = items.find((item) => item.role === "subtitle")?.text || "";
  if (subtitle) texts.push(textObject("subtitle", "subtitle", subtitle, layout.subtitle, { fontSize: role === "cover" ? 14 : 12, colorRole: "muted" }));
  const bullets = items.filter((item) => item.role === "bullet");
  bullets.forEach((bullet, itemIndex) => {
    const box = layout.bullets[itemIndex] || layout.bullets.at(-1);
    if (box) texts.push(textObject(`bullet_${itemIndex + 1}`, "bullet", bullet.text, box, { fontSize: 10.8 }));
  });
  const dataPoints = items.filter((item) => item.role === "data");
  dataPoints.forEach((point, itemIndex) => {
    const box = layout.data[itemIndex];
    if (box) texts.push(textObject(`data_${itemIndex + 1}`, "data", point.text, box, { fontSize: 13, bold: true, colorRole: itemIndex === 0 ? "accent" : "ink" }));
  });
  return texts;
}

function expectedTextItemsForSlide(slide = {}, role = "") {
  const items = [{ role: "title", text: cleanText(slide.title) || "Untitled" }];
  const subtitle = cleanText(slide.subtitle || slide.visualIntent);
  if (subtitle) items.push({ role: "subtitle", text: subtitle });
  for (const bullet of toList(slide.bullets).slice(0, role === "cover" ? 3 : 5)) items.push({ role: "bullet", text: bullet });
  for (const point of toList(slide.dataPoints).slice(0, 4)) items.push({ role: "data", text: point });
  return items;
}

function summarizeTextCoverage(expectedItems = [], texts = [], slide = {}) {
  const rendered = texts.map((item) => ({ role: item.role, text: cleanText(item.text) })).filter((item) => item.text);
  const missingExpectedItems = expectedItems
    .filter((expected) => !rendered.some((item) => item.role === expected.role && item.text === cleanText(expected.text)))
    .map((item) => item.role);
  const sourceItems = [
    cleanText(slide.title),
    cleanText(slide.subtitle || slide.visualIntent),
    ...toList(slide.bullets),
    ...toList(slide.dataPoints)
  ].filter(Boolean);
  return {
    expectedItems: expectedItems.length,
    renderedItems: rendered.length,
    sourceItems: sourceItems.length,
    omittedByCompression: Math.max(0, sourceItems.length - expectedItems.length),
    missingExpectedItems
  };
}

function textObject(id, role, text, box, options = {}) {
  return {
    id,
    type: "text",
    role,
    text,
    box,
    style: {
      fontFace: "Microsoft YaHei",
      fontSize: options.fontSize || 11,
      bold: Boolean(options.bold),
      colorRole: options.colorRole || "ink",
      fit: "shrink"
    },
    editable: true
  };
}

function buildShapeObjects(role, layout, palette = {}) {
  const shapes = [
    { id: "accent_bar", type: "rect", box: layout.accent, fillRole: "accent", lineRole: "accent", editable: true }
  ];
  for (const [index, box] of (layout.cards || []).entries()) {
    shapes.push({ id: `card_${index + 1}`, type: "roundRect", box, radius: 0.05, fillRole: "soft", lineRole: "soft", editable: true });
  }
  if (role === "quote") shapes.push({ id: "quote_mark", type: "textDecor", text: "\"", box: { x: 0.72, y: 0.7, w: 0.9, h: 0.7 }, fillRole: "accent", editable: true });
  return shapes.filter((shape) => shape.box);
}

function buildImageObject(file, box = {}, role = "") {
  const selectionReason = file._selectionReason || (/foreground-cutout|cutout/i.test([file.materialRole, file.source, file.originalName].filter(Boolean).join(" "))
    ? "preferred-foreground-cutout"
    : "matched-slide-image-slot");
  return {
    id: "primary_image",
    type: "image",
    role: role === "cover" ? "hero" : "content",
    path: file.path || "",
    name: cleanText(file.originalName || path.basename(file.path || "")),
    box,
    fit: role === "cover" ? "cover" : "contain",
    editable: true,
    fullSlide: false,
    required: false,
    provenance: {
      source: file.materialRole || file.source || "upload",
      sourceSlide: file.sourceSlide || null,
      sourceImageId: file.sourceImageId || null,
      sourceImageName: file.sourceImageName || null,
      derived: Boolean(file.derived),
      mattingStatus: file.mattingStatus || null,
      selectionReason
    }
  };
}

function buildMissingImageObject(box = {}, role = "", index = 0) {
  return {
    id: "primary_image_missing",
    type: "image",
    role: role === "cover" ? "hero" : "content",
    path: "",
    name: `missing-slide-${index + 1}-image`,
    box,
    fit: "contain",
    editable: true,
    fullSlide: false,
    required: true,
    provenance: {
      source: "asset-manifest-missing",
      sourceSlide: index + 1,
      selectionReason: "no-page-bound-image-found"
    }
  };
}

function applyCanvasEditsToTexts(texts = [], canvasEdits = null) {
  if (!canvasEdits || typeof canvasEdits !== "object") return texts;
  for (const text of texts) {
    const edit = canvasEdits[canvasKeyForText(text)];
    if (!edit?.box) continue;
    text.box = percentBoxToInches(edit.box);
  }
  return texts;
}

function canvasKeyForText(text = {}) {
  if (text.role === "bullet") {
    const number = Number(String(text.id || "").replace(/^bullet_/, ""));
    return `bullet_${Math.max(0, number - 1)}`;
  }
  if (text.role === "data") {
    const number = Number(String(text.id || "").replace(/^data_/, ""));
    return `data_${Math.max(0, number - 1)}`;
  }
  return text.role || text.id;
}

function percentBoxToInches(box = {}) {
  return {
    x: Math.max(0, Math.min(SLIDE_W, Number(box.x || 0) * SLIDE_W / 100)),
    y: Math.max(0, Math.min(SLIDE_H, Number(box.y || 0) * SLIDE_H / 100)),
    w: Math.max(0.05, Math.min(SLIDE_W, Number(box.w || 0) * SLIDE_W / 100)),
    h: Math.max(0.05, Math.min(SLIDE_H, Number(box.h || 0) * SLIDE_H / 100))
  };
}

function buildDecorations(role, palette = {}) {
  const items = [
    { id: "page_rule", type: "rect", box: { x: 0, y: 0, w: SLIDE_W, h: 0.08 }, fillRole: "accent", lineRole: "accent", editable: true }
  ];
  if (["cover", "section", "quote"].includes(role)) {
    items.push({ id: "side_rule", type: "rect", box: { x: 0.48, y: 0.78, w: 0.08, h: 4.8 }, fillRole: "accent", lineRole: "accent", editable: true });
  }
  return items;
}

function layoutBoxes(role, hasImage) {
  const imageRight = imageBoxForRole(role, hasImage);
  const baseBullets = [
    { x: 0.95, y: 3.05, w: hasImage ? 4.0 : 10.6, h: 0.38 },
    { x: 0.95, y: 3.58, w: hasImage ? 4.0 : 10.6, h: 0.38 },
    { x: 0.95, y: 4.11, w: hasImage ? 4.0 : 10.6, h: 0.38 },
    { x: 0.95, y: 4.64, w: hasImage ? 4.0 : 10.6, h: 0.38 },
    { x: 0.95, y: 5.17, w: hasImage ? 4.0 : 10.6, h: 0.38 }
  ];
  const common = {
    title: { x: 0.78, y: 0.75, w: hasImage ? 4.85 : 9.8, h: 0.75 },
    subtitle: { x: 0.8, y: 1.55, w: hasImage ? 4.55 : 8.8, h: 0.4 },
    image: imageRight,
    accent: { x: 0.78, y: 2.35, w: hasImage ? 4.15 : 10.8, h: 0.05 },
    bullets: baseBullets,
    data: [
      { x: 7.0, y: 2.25, w: 2.3, h: 0.5 },
      { x: 9.45, y: 2.25, w: 2.3, h: 0.5 },
      { x: 7.0, y: 3.05, w: 2.3, h: 0.5 },
      { x: 9.45, y: 3.05, w: 2.3, h: 0.5 }
    ],
    cards: hasImage ? [{ x: imageRight.x - 0.18, y: imageRight.y - 0.18, w: imageRight.w + 0.36, h: imageRight.h + 0.36 }] : [
      { x: 0.78, y: 2.55, w: 3.55, h: 1.2 },
      { x: 4.75, y: 2.55, w: 3.55, h: 1.2 },
      { x: 8.72, y: 2.55, w: 3.55, h: 1.2 }
    ]
  };
  if (role === "cover") {
    const coverImage = imageBoxForRole(role, hasImage);
    return {
      ...common,
      title: { x: 0.95, y: 1.05, w: hasImage ? 5.15 : 9.8, h: 1.22 },
      subtitle: { x: 0.98, y: 2.45, w: hasImage ? 4.75 : 8.8, h: 0.55 },
      image: coverImage,
      accent: { x: 0.58, y: 0.92, w: 0.1, h: 4.8 },
      bullets: [
        { x: 1.0, y: 4.45, w: hasImage ? 4.75 : 9.8, h: 0.34 },
        { x: 1.0, y: 4.92, w: hasImage ? 4.75 : 9.8, h: 0.34 },
        { x: 1.0, y: 5.39, w: hasImage ? 4.75 : 9.8, h: 0.34 }
      ],
      cards: hasImage ? [{ x: coverImage.x - 0.2, y: coverImage.y - 0.18, w: coverImage.w + 0.4, h: coverImage.h + 0.36 }] : []
    };
  }
  if (role === "section" || role === "quote") {
    return {
      ...common,
      title: { x: 1.05, y: 1.55, w: 10.4, h: 1.05 },
      subtitle: { x: 1.08, y: 3.0, w: 8.8, h: 0.48 },
      accent: { x: 0.95, y: 1.1, w: 10.8, h: 0.05 },
      image: imageRight,
      bullets: [
        { x: 1.12, y: 4.25, w: 9.5, h: 0.34 },
        { x: 1.12, y: 4.76, w: 9.5, h: 0.34 },
        { x: 1.12, y: 5.27, w: 9.5, h: 0.34 }
      ],
      cards: []
    };
  }
  return common;
}

function normalizeRole(layout = "", index = 0, total = 1) {
  if (index === 0) return "cover";
  if (index === total - 1) return "closing";
  const map = {
    visual: "case",
    "product-detail": "case",
    bundle: "gallery",
    pricing: "matrix",
    cards: "matrix",
    kpi: "matrix",
    compare: "matrix",
    "risk-checklist": "matrix",
    toc: "section"
  };
  return map[layout] || layout || "section";
}

function inferPalette({ routePlan = {}, aestheticPlan = {}, styleFingerprint = {} }) {
  const text = [routePlan.recommendedTheme, aestheticPlan.theme, styleFingerprint.prompt, styleFingerprint.summary].filter(Boolean).join(" ");
  const warm = new RegExp("orange|red|warm|\\u6a59|\\u7ea2|\\u6696|\\u8282").test(text);
  const dark = new RegExp("dark|black|\\u6df1|\\u9ed1|\\u53d1\\u5e03").test(text);
  const green = new RegExp("green|\\u81ea\\u7136|\\u4e1c\\u65b9|\\u793c\\u76d2|\\u751f\\u9c9c").test(text);
  if (dark) return { bg: "111827", paper: "1F2937", soft: "243447", ink: "F8FAFC", muted: "CBD5E1", accent: warm ? "F97316" : "60A5FA" };
  if (warm) return { bg: "FBF6EA", paper: "FFF8EE", soft: "F1E3CF", ink: "241B16", muted: "75685C", accent: "D86B2A" };
  if (green) return { bg: "F7F8F4", paper: "FFFFFF", soft: "E9EFE2", ink: "1F2A20", muted: "657164", accent: "6E765D" };
  return { bg: "F7F8FC", paper: "FFFFFF", soft: "E8EEF8", ink: "172033", muted: "647087", accent: "2D5BD7" };
}

function inferDensity(slides = []) {
  const avg = slides.length ? slides.reduce((sum, slide) => sum + estimateSlideTextLoad(slide), 0) / slides.length : 0;
  return avg > 360 ? "dense-compress" : avg > 180 ? "balanced" : "visual-light";
}

function inferImagePolicy({ files = [], sourceReport = {}, slides = [] }) {
  const imageCount = getImageFiles(files).length || Number(sourceReport.imageCount || 0);
  return {
    priority: imageCount ? "high" : "medium",
    sourceImageCount: imageCount,
    noFullSlideRaster: true,
    localFirst: true
  };
}

function pageCompositionFor(layout = "", index = 0, total = 1) {
  const role = normalizeRole(layout, index, total);
  if (role === "cover") return "large-title-plus-hero-image";
  if (role === "case") return "image-led-case-layout";
  if (role === "gallery") return "multi-image-gallery";
  if (role === "matrix") return "structured-cards-or-data-grid";
  if (role === "quote") return "large-statement";
  return "section-title-and-key-points";
}

function estimateSlideTextLoad(slide = {}) {
  return cleanText([slide.title, slide.subtitle, slide.visualIntent, ...toList(slide.bullets), ...toList(slide.dataPoints)].join(" ")).length;
}

function buildVisualSamplePrompt({ deck = {}, routePlan = {}, palette = {}, density = "balanced", imagePolicy = {} } = {}) {
  const title = cleanText(deck.title || routePlan.deckType || "editable presentation");
  return [
    "Create one 16:9 art-director-level presentation visual direction board as a visual reference only.",
    "No readable text, no fake Chinese characters, no watermark.",
    `Topic: ${title}.`,
    `Style: ${routePlan.recommendedTheme || routePlan.deckType || "modern editorial proposal"}.`,
    `Palette roles: background #${palette.bg || "F7F8FC"}, accent #${palette.accent || "2D5BD7"}, ink #${palette.ink || "172033"}.`,
    `Density: ${density}. Image priority: ${imagePolicy.priority || "medium"}.`,
    "Use a strong hero composition: one dominant image area or product/material stage should occupy about 45-65% of the slide when images are important.",
    "Show a clear editable rebuild structure: separate background atmosphere, independent image/object zones, native text zones, and simple shape accents.",
    "Prefer editorial proposal / premium casebook design language: strong title hierarchy, intentional whitespace, confident contrast, crafted image treatment.",
    "Avoid generic blue-white business templates, tiny repeated cards, dense bullet pages, weak title blocks, and decorative gradients without purpose.",
    "Keep text as abstract blocks only; do not render real words because final PPT text must remain editable.",
    "This image is only a target for style and composition; final PPT must be rebuilt as native editable text, shapes, and independent image objects."
  ].join(" ");
}

function imageBoxForRole(role = "", hasImage = false) {
  if (!hasImage) return { x: 7.0, y: 1.25, w: 5.1, h: 4.85 };
  if (role === "cover") return { x: 6.15, y: 0.78, w: 6.35, h: 5.9 };
  if (role === "gallery") return { x: 5.75, y: 0.9, w: 6.75, h: 5.95 };
  if (role === "case") return { x: 5.75, y: 1.0, w: 6.55, h: 5.65 };
  if (role === "matrix") return { x: 7.45, y: 1.25, w: 4.55, h: 3.85 };
  if (role === "closing") return { x: 7.0, y: 1.35, w: 5.0, h: 4.35 };
  return { x: 6.05, y: 1.05, w: 6.15, h: 5.45 };
}

function imageAreaRatioForRole(role = "", wantsImage = false) {
  if (!wantsImage && !IMAGE_HEAVY_ROLES.has(role)) return 0;
  if (role === "cover") return 0.37;
  if (role === "case") return 0.36;
  if (role === "gallery") return 0.38;
  if (role === "matrix") return 0.18;
  if (role === "closing") return 0.22;
  return 0.32;
}

function dedupeActions(actions = []) {
  const seen = new Set();
  return actions.filter((action) => {
    const key = `${action.slideId}:${action.action}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 24);
}

function compareQaMetricSimilarity(previewQa, targetQa) {
  const p = previewQa.full || {};
  const t = targetQa.full || {};
  const brightnessDelta = Math.abs(Number(p.brightness || 0) - Number(t.brightness || 0));
  const edgeDelta = Math.abs(Number(p.edgeDensity || 0) - Number(t.edgeDensity || 0));
  const saturationDelta = Math.abs(Number(p.saturationDensity || 0) - Number(t.saturationDensity || 0));
  const penalty = brightnessDelta * 24 + edgeDelta * 180 + saturationDelta * 80;
  return Math.max(0, Math.min(20, Math.round(20 - penalty)));
}

