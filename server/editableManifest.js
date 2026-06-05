import fs from "fs";
import path from "path";
import { imageSize } from "image-size";

const SLIDE_W = 13.333;
const SLIDE_H = 7.5;
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|svg)$/i;
const PDF_EXT_RE = /\.pdf$/i;
const PPT_EXT_RE = /\.pptx?$/i;

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isImageUpload(file = {}) {
  return IMAGE_EXT_RE.test(file.originalName || file.path || "") || /^image\//i.test(file.mimeType || "");
}

function isPdfUpload(file = {}) {
  return PDF_EXT_RE.test(file.originalName || file.path || "") || /pdf/i.test(file.mimeType || "");
}

function isPptUpload(file = {}) {
  return PPT_EXT_RE.test(file.originalName || file.path || "") || /presentation|powerpoint/i.test(file.mimeType || "");
}

function shortName(file = {}) {
  return cleanText(file.originalName || path.basename(file.path || "") || file.id || "source");
}

function readUploadImageSize(file = {}) {
  if (file.mediaProfile?.imageSize?.width && file.mediaProfile?.imageSize?.height) return file.mediaProfile.imageSize;
  if (!file.path || !fs.existsSync(file.path) || !isImageUpload(file)) return null;
  try {
    const size = imageSize(file.path);
    return size?.width && size?.height ? { width: size.width, height: size.height, format: size.type || path.extname(file.path).slice(1) } : null;
  } catch {
    return null;
  }
}

function sourceType(file = {}) {
  if (isImageUpload(file)) return "image";
  if (isPdfUpload(file)) return "pdf";
  if (isPptUpload(file)) return "pptx";
  return "document";
}

export function isImageToEditableCandidate({ uploads = [], materialBrief = {} } = {}) {
  const sourceReport = materialBrief.sourceReport || {};
  const files = Array.isArray(uploads) ? uploads : [];
  const images = files.filter(isImageUpload);
  const pdfs = files.filter(isPdfUpload);
  const ppts = files.filter(isPptUpload);
  const pages = Array.isArray(sourceReport.pages) ? sourceReport.pages : [];
  const imageOnlyPages = pages.filter((page) => page.status === "image-only" || (!Number(page.textChars || 0) && Number(page.imageCount || 0) > 0));
  const lowTextPages = pages.filter((page) => Number(page.textChars || 0) < 24 && Number(page.imageCount || 0) > 0);
  const charCount = Number(materialBrief.charCount || 0);
  const imageCount = Number(materialBrief.imageCount || sourceReport.imageCount || images.length || 0);

  if (images.length && !charCount) return true;
  if (pdfs.length && charCount < 120) return true;
  if (ppts.length && imageOnlyPages.length) return true;
  if (ppts.length && lowTextPages.length >= Math.max(1, Math.ceil((pages.length || 1) * 0.35))) return true;
  if (imageCount >= 3 && charCount < 300) return true;
  return false;
}

export function buildEditableRebuildPlan({ uploads = [], materialBrief = {}, routePlan = {}, deck = {} } = {}) {
  const files = Array.isArray(uploads) ? uploads : [];
  const candidate = isImageToEditableCandidate({ uploads: files, materialBrief });
  const sourceReport = materialBrief.sourceReport || {};
  const pages = Array.isArray(sourceReport.pages) ? sourceReport.pages : [];
  const slides = Array.isArray(deck?.slides) ? deck.slides : [];
  const imageFiles = files.filter(isImageUpload);
  const pdfFiles = files.filter(isPdfUpload);
  const pptFiles = files.filter(isPptUpload);
  const pageCount = Math.max(
    Number(sourceReport.pageCount || 0),
    Number(materialBrief.pageCount || 0),
    slides.length,
    imageFiles.length,
    pdfFiles.length ? 1 : 0
  );
  const inputType = inferInputType({ imageFiles, pdfFiles, pptFiles });
  const warnings = [];
  if (pdfFiles.length) warnings.push("PDF 页面尚未渲染成逐页 source.png，当前只生成重建计划");
  if (pptFiles.length && sourceReport.extractionAudit?.missingImageRefs) warnings.push("原 PPT 存在缺失图片引用，需人工或云端补齐素材");
  if (candidate && !pageCount) warnings.push("已识别为图片化输入，但没有可映射页码");

  const planPages = buildPlanPages({
    pageCount,
    pages,
    slides,
    imageFiles,
    routePlan,
    sourceReport
  });
  const fakeEditableRisks = planPages.flatMap((page) => page.qa.warnings.map((warning) => `${page.pageId}: ${warning}`));

  return {
    schemaVersion: 1,
    mode: "image-to-editable",
    status: candidate ? (fakeEditableRisks.length || warnings.length ? "warn" : "active") : "not-needed",
    candidate,
    reason: candidate
      ? buildCandidateReason({ imageFiles, pdfFiles, pptFiles, sourceReport, materialBrief })
      : "当前输入已有可抽取文本或不是图片化/扫描化重建场景",
    inputType,
    pageCount,
    stages: buildStages({ candidate, pdfFiles, warnings, fakeEditableRisks }),
    pages: planPages,
    warnings: [...warnings, ...fakeEditableRisks].slice(0, 20),
    hardRules: [
      "可读文字必须重建为 PPT 文本框，不能只留在截图里",
      "禁止整页截图加少量文字覆盖来冒充可编辑 PPT",
      "源图只能作为背景证据或不可拆小图素材，文字区必须对象化",
      "每页必须记录 text_inventory、visual_inventory、background_strategy 和 quality_checks",
      "圆角、图标、Logo、产品图等视觉对象要记录来源和可编辑/不可编辑原因"
    ]
  };
}

function inferInputType({ imageFiles = [], pdfFiles = [], pptFiles = [] }) {
  if (imageFiles.length && !pdfFiles.length && !pptFiles.length) return imageFiles.length === 1 ? "image" : "images";
  if (pdfFiles.length) return "pdf";
  if (pptFiles.length) return "pptx";
  if (imageFiles.length) return "images";
  return "mixed";
}

function buildCandidateReason({ imageFiles = [], pdfFiles = [], pptFiles = [], sourceReport = {}, materialBrief = {} }) {
  const reasons = [];
  if (imageFiles.length) reasons.push(`上传图片 ${imageFiles.length} 张`);
  if (pdfFiles.length) reasons.push(`PDF ${pdfFiles.length} 个`);
  if (pptFiles.length && sourceReport.pages?.some((page) => page.status === "image-only")) reasons.push("原 PPT 含图片化页面");
  if (Number(materialBrief.charCount || 0) < 300 && Number(materialBrief.imageCount || sourceReport.imageCount || 0) > 0) reasons.push("低文本、高图片输入");
  return reasons.join(" / ") || "图片化输入需要对象级可编辑重建";
}

function buildStages({ candidate, pdfFiles = [], warnings = [], fakeEditableRisks = [] }) {
  if (!candidate) {
    return [
      { id: "detect", label: "图片化输入检测", status: "skipped", summary: "当前不需要启用 image-to-editable 重建" }
    ];
  }
  return [
    { id: "detect", label: "图片化输入检测", status: "pass", summary: "已识别需要对象级可编辑重建" },
    { id: "source-normalize", label: "页面源图标准化", status: pdfFiles.length ? "warn" : "pass", summary: pdfFiles.length ? "PDF 逐页渲染待接入" : "图片/PPTX 素材已可映射到页面" },
    { id: "manifest", label: "对象 Manifest", status: "pass", summary: "已生成每页文本、图片、背景与 QA 清单" },
    { id: "qa", label: "防伪可编辑 QA", status: warnings.length || fakeEditableRisks.length ? "warn" : "pass", summary: warnings.length || fakeEditableRisks.length ? "存在需复核的可编辑风险" : "未发现明显假可编辑风险" }
  ];
}

function buildPlanPages({ pageCount = 0, pages = [], slides = [], imageFiles = [], routePlan = {}, sourceReport = {} }) {
  const count = Math.max(0, Math.min(80, pageCount || slides.length || imageFiles.length));
  return Array.from({ length: count }, (_, index) => {
    const pageNumber = index + 1;
    const sourcePage = pages.find((page) => Number(page.page || 0) === pageNumber) || {};
    const slide = slides[index] || {};
    const routeStep = routePlan.layoutSequence?.[index] || {};
    const sourceImages = imageFilesForPage({ pageNumber, imageFiles, sourcePage });
    const textBoxes = buildTextBoxes({ slide, routeStep, sourcePage });
    const images = buildManifestImages({ sourceImages, sourcePage, slide, pageNumber });
    const textInventory = textBoxes.map((box) => ({ id: box.id, text: box.text, source: box.source, confidence: box.confidence }));
    const visualInventory = images.map((image) => ({ id: image.id, kind: image.kind, source: image.source, editable: image.editable, role: image.role }));
    const fakeEditableRisk = sourceImages.some(isFullSlideLikeImage) && textBoxes.length > 0;
    const pageWarnings = [
      fakeEditableRisk ? "检测到大幅源图 + 文本框组合，需确认不是整页截图覆盖" : "",
      !textBoxes.length && Number(sourcePage.textChars || 0) > 0 ? "源页有文字但当前未形成文本框" : "",
      sourcePage.status === "image-only" ? "图片化源页需要 OCR/视觉模型补全文本对象" : ""
    ].filter(Boolean);
    return {
      pageId: `page_${String(pageNumber).padStart(3, "0")}`,
      index: pageNumber,
      title: cleanText(slide.title || routeStep.title || sourcePage.title || `第 ${pageNumber} 页`),
      source: {
        page: sourcePage.page || pageNumber,
        status: sourcePage.status || (sourceImages.length ? "image-material" : "generated"),
        images: sourceImages.map((file) => ({
          id: file.id || null,
          name: shortName(file),
          type: sourceType(file),
          width: readUploadImageSize(file)?.width || null,
          height: readUploadImageSize(file)?.height || null
        }))
      },
      editableManifest: {
        schemaVersion: 1,
        slide: { widthIn: SLIDE_W, heightIn: SLIDE_H },
        source: {
          page: pageNumber,
          sourceStatus: sourcePage.status || "",
          sourceTextChars: Number(sourcePage.textChars || 0),
          sourceImageCount: sourceImages.length,
          extractionAudit: sourceReport.extractionAudit ? "available" : "not-available"
        },
        text_inventory: textInventory,
        visual_inventory: visualInventory,
        background_strategy: buildBackgroundStrategy({ sourcePage, sourceImages, slide }),
        quality_checks: {
          font_size_calibrated: false,
          visual_inventory_matched: visualInventory.length > 0,
          background_strategy_checked: true,
          shape_corner_geometry_checked: false,
          fake_editable_checked: !fakeEditableRisk
        },
        text_boxes: textBoxes,
        shapes: buildManifestShapes(slide),
        images,
        asset_provenance: images.map((image) => ({
          id: image.id,
          source: image.source,
          source_type: image.sourceType,
          provenance_note: image.provenanceNote
        })),
        known_limits: pageWarnings
      },
      qa: {
        fakeEditableRisk,
        requiredChecks: [
          "OCR/视觉模型抽取所有可读文字",
          "对照源图确认视觉对象是否拆干净",
          "验证圆角/边框/阴影不是误判",
          "导出 PPTX 后渲染预览并做截图对比"
        ],
        warnings: pageWarnings
      }
    };
  });
}

function imageFilesForPage({ pageNumber, imageFiles = [], sourcePage = {} }) {
  const bySlide = imageFiles.filter((file) => Number(file.sourceSlide || 0) === pageNumber);
  if (bySlide.length) return bySlide;
  if (sourcePage.images?.length) {
    const names = new Set(sourcePage.images.map((item) => cleanText(item).toLowerCase()));
    const named = imageFiles.filter((file) => names.has(shortName(file).toLowerCase()));
    if (named.length) return named;
  }
  if (imageFiles.length === 1 && pageNumber === 1) return imageFiles;
  const loose = imageFiles.filter((file) => !Number(file.sourceSlide || 0));
  return loose[pageNumber - 1] ? [loose[pageNumber - 1]] : [];
}

function buildTextBoxes({ slide = {}, routeStep = {}, sourcePage = {} }) {
  const boxes = [];
  const title = cleanText(slide.title || routeStep.title || sourcePage.title);
  const subtitle = cleanText(slide.subtitle);
  if (title) boxes.push(makeTextBox("title", title, 0.78, 0.52, 11.7, 0.55, "title"));
  if (subtitle) boxes.push(makeTextBox("subtitle", subtitle, 0.85, 1.16, 8.6, 0.42, "subtitle"));
  const bullets = Array.isArray(slide.bullets) ? slide.bullets : [];
  bullets.slice(0, 5).forEach((item, bulletIndex) => {
    const text = cleanText(item);
    if (text) boxes.push(makeTextBox(`bullet_${bulletIndex + 1}`, text, 0.95, 1.85 + bulletIndex * 0.42, 6.2, 0.32, "bullet"));
  });
  const dataPoints = Array.isArray(slide.dataPoints) ? slide.dataPoints : [];
  dataPoints.slice(0, 4).forEach((item, dataIndex) => {
    const text = cleanText(item);
    if (text) boxes.push(makeTextBox(`data_${dataIndex + 1}`, text, 7.35, 1.8 + dataIndex * 0.48, 4.6, 0.34, "data-point"));
  });
  return boxes;
}

function makeTextBox(id, text, x, y, w, h, role) {
  return {
    id,
    type: "text",
    role,
    text,
    boxIn: [x, y, w, h],
    fontSize: role === "title" ? 24 : role === "subtitle" ? 13 : 11,
    source: "deck-plan",
    confidence: 0.68,
    editable: true
  };
}

function buildManifestImages({ sourceImages = [], sourcePage = {}, slide = {}, pageNumber }) {
  const slideSlots = Array.isArray(slide.imageSlots) ? slide.imageSlots : [];
  const fromSource = sourceImages.map((file, index) => {
    const imageSize = readUploadImageSize(file);
    const fullSlide = isFullSlideLikeImage(file);
    return {
      id: `source_image_${index + 1}`,
      kind: fullSlide ? "source-page-reference" : "source-derived-rasterization",
      role: file.materialRole || file.mediaProfile?.role || (fullSlide ? "background-reference" : "visual-asset"),
      source: shortName(file),
      sourceType: fullSlide ? "source-page-reference" : "source-derived-rasterization",
      editable: false,
      boxIn: fullSlide ? [0, 0, SLIDE_W, SLIDE_H] : inferImageBox(index, sourceImages.length),
      widthPx: imageSize?.width || null,
      heightPx: imageSize?.height || null,
      requireEdgeSafeAlpha: !fullSlide,
      provenanceNote: fullSlide
        ? "Large source image is retained only as visual reference or background candidate; readable text must be rebuilt as text boxes."
        : "Small source visual can remain raster if it contains no readable text."
    };
  });
  const fromSlots = slideSlots.slice(0, 6).map((slot, index) => ({
    id: `planned_slot_${index + 1}`,
    kind: "planned-image-slot",
    role: slot.role || "visual",
    source: slot.source || slot.prompt || `slide ${pageNumber} planned image`,
    sourceType: slot.source ? "planned-source-binding" : "generation-needed",
    editable: false,
    boxIn: [Number(slot.x || 7.2), Number(slot.y || 1.45), Number(slot.w || 4.7), Number(slot.h || 4.5)],
    widthPx: null,
    heightPx: null,
    requireEdgeSafeAlpha: Boolean(slot.needsCutout),
    provenanceNote: slot.source ? "Deck image slot is bound to source material." : "Deck image slot needs local/cloud generation or source binding."
  }));
  if (!fromSource.length && sourcePage.imageCount) {
    return [{
      id: "source_image_missing",
      kind: "missing-source-image",
      role: "visual-asset",
      source: `source page ${sourcePage.page || pageNumber}`,
      sourceType: "missing-source-reference",
      editable: false,
      boxIn: [7.2, 1.45, 4.7, 4.5],
      widthPx: null,
      heightPx: null,
      requireEdgeSafeAlpha: false,
      provenanceNote: "Source report says images exist, but no extracted image file is bound to this page."
    }, ...fromSlots];
  }
  return [...fromSource, ...fromSlots];
}

function inferImageBox(index, total) {
  if (total <= 1) return [7.0, 1.25, 5.25, 5.15];
  const col = index % 2;
  const row = Math.floor(index / 2);
  return [6.8 + col * 2.7, 1.35 + row * 2.1, 2.45, 1.85];
}

function buildManifestShapes(slide = {}) {
  const markers = [];
  if (Array.isArray(slide.tags) && slide.tags.length) {
    markers.push({
      id: "tag_band",
      type: "rect",
      role: "tag-container",
      boxIn: [0.75, 6.62, 11.8, 0.38],
      fill: "theme-accent-soft",
      editable: true,
      cornerCategory: "straight",
      sourceCornerRadiusPx: 0
    });
  }
  return markers;
}

function buildBackgroundStrategy({ sourcePage = {}, sourceImages = [], slide = {} }) {
  const hasFullSlide = sourceImages.some(isFullSlideLikeImage);
  if (sourcePage.status === "image-only" || hasFullSlide) {
    return {
      mode: "source-preserving-local-repair",
      sourceConsistency: "保留源页构图、色彩、产品/Logo 位置；可读文字必须另建文本框",
      removedForeground: "仅在 OCR/视觉确认后移除文字层或可重建前景",
      comparisonNote: "需要导出预览后与 source.png/contact sheet 对照"
    };
  }
  if (slide.backgroundImage) {
    return {
      mode: "planned-background-image",
      sourceConsistency: "使用当前 deck 背景图槽，保持文本安全区",
      removedForeground: "无",
      comparisonNote: "检查背景不压正文、不吞标题"
    };
  }
  return {
    mode: "native-or-script",
    sourceConsistency: "用主题色、形状、文本和独立图片对象重建",
    removedForeground: "无",
    comparisonNote: "检查是否保持源页主要信息与视觉层级"
  };
}

function isFullSlideLikeImage(file = {}) {
  const size = readUploadImageSize(file);
  const ratio = size?.width && size?.height ? size.width / size.height : null;
  const area = size?.width && size?.height ? size.width * size.height : 0;
  return Boolean(Number(file.sourceSlide || 0)) || (ratio && ratio > 1.45 && ratio < 2.05 && area > 600000);
}
