import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getDesignSystem, getTemplatePack, getTemplatePackPrompt } from "./designSystem.js";
import { buildMaterialBrief } from "./materialBrief.js";
import { routeDeck } from "./deckRouter.js";
import { validateDeck } from "./validateDeck.js";
import { applySceneGraphOverrides, applySceneGraphRepairPlan, buildSceneGraph, buildSceneGraphRepairRecord, buildVisualTarget, compareRenderedPreviewToVisualTarget, compareVisualTarget, validateSceneGraph } from "./sceneGraph.js";
import { buildDeck } from "./ppt.js";
import { inspectEditablePptx } from "./pptxEditability.js";
import { getCloudImageConfig } from "./cloudImage.js";
import { buildAssetManifest, validateAssetManifest } from "./assetManifest.js";
import { ensureVisualProjectForJob, generateVisualProjectSlides, writeEditableSceneGraphArtifacts } from "./visualProject.js";
import { buildFinalExportGate, buildHybridQa } from "./hybridQa.js";
import { cutoutImage } from "./matting.js";

const EASTERN = "\u4e1c\u65b9\u81ea\u7136\u98ce";
const TECH = "\u84dd\u767d\u79d1\u6280\u98ce";
const SYSTEM_RECOMMEND = "\u7cfb\u7edf\u63a8\u8350";

const designSystem = getDesignSystem();
assert.ok(designSystem.templatePacks.length >= 5);
assert.equal(designSystem.templatePacks.some((pack) => /模板/.test(pack.name)), false);
assert.equal(getTemplatePack(EASTERN).slug, "seasonal-gift");
assert.ok(getTemplatePackPrompt(TECH).includes("\u6280\u672f\u65b9\u6848 / \u6570\u636e\u6c47\u62a5\u65b9\u5411"));

const brief = buildMaterialBrief([
  {
    name: "\u8f93\u5165\u8bf4\u660e",
    text: "\u7aef\u5348\u793c\u76d2\u552e\u4ef7 39\u5143\u300159\u5143\u3001159\u5143\u3002\u4e3b\u63a8\u4f4e\u7cd6\u7cbd\u793c\u76d2\u548c\u9ad8\u7aef\u6ecb\u8865\u793c\u76d2\uff0c\u89c4\u683c 300x200x80mm\u3002\u9002\u5408\u5458\u5de5\u798f\u5229\u3001\u5ba2\u6237\u62dc\u8bbf\u3001\u8282\u65e5\u793c\u8d60\u3002"
  }
]);

assert.deepEqual(brief.prices.slice(0, 3), ["39\u5143", "59\u5143", "159\u5143"]);
assert.ok(brief.productCandidates.includes("\u4f4e\u7cd6\u7cbd\u793c\u76d2"));
assert.ok(brief.productCandidates.includes("\u9ad8\u7aef\u6ecb\u8865\u793c\u76d2"));
assert.deepEqual(brief.dimensions, ["300x200x80mm"]);
assert.equal(brief.inputStrength, "strong");

const weakBrief = buildMaterialBrief([
  { name: "\u793c\u76d2\u4e3b\u56fe.png", text: "\u56fe\u7247\u7d20\u6750\u5df2\u4e0a\u4f20\uff1a\u793c\u76d2\u4e3b\u56fe.png\u3002\u751f\u6210\u65f6\u8bf7\u4e3a\u5176\u9884\u7559\u56fe\u7247\u69fd\u4f4d\u3002" },
  { name: "\u8f93\u5165\u8bf4\u660e", text: "\u9879\u76ee\u540d\u79f0\uff1a\u7aef\u5348\u793c\u76d2\n\u8865\u5145\u8bf4\u660e\uff1a\u505a\u4e00\u4efd\u7ed9\u9500\u552e\u56e2\u961f\u7528\u7684\u4ea7\u54c1\u6218\u5361\u3002" }
]);
assert.equal(weakBrief.inputStrength, "weak");
assert.equal(weakBrief.imageCount, 1);
assert.ok(weakBrief.confirmationFields.includes("\u4ef7\u683c/\u62a5\u4ef7/\u9884\u7b97\u6863\u4f4d"));

const weakRoute = routeDeck({ input: { pageCount: SYSTEM_RECOMMEND }, materialBrief: weakBrief, uploads: [{ originalName: "\u793c\u76d2\u4e3b\u56fe.png", mimeType: "image/png" }] });
assert.equal(weakRoute.inputStrength, "weak");
assert.ok(weakRoute.layoutSequence.some((step) => step.layout === "visual"));
assert.ok(weakRoute.layoutSequence.some((step) => step.storyRole === "\u5f85\u786e\u8ba4\u4fe1\u606f"));

const giftRoute = routeDeck({
  input: { pageCount: SYSTEM_RECOMMEND, style: EASTERN },
  materialBrief: weakBrief,
  uploads: [{ originalName: "\u793c\u76d2\u4e3b\u56fe.png", mimeType: "image/png" }]
});
assert.equal(giftRoute.templatePack.slug, "seasonal-gift");
assert.equal(giftRoute.layoutSequence[1].layout, "visual");

const techRoute = routeDeck({
  input: { pageCount: "12", style: TECH, notes: "\u6280\u672f\u65b9\u6848 \u6570\u636e\u6c47\u62a5 KPI \u5206\u6790" },
  materialBrief: brief,
  uploads: []
});
assert.equal(techRoute.templatePack.slug, "tech-solution");
assert.ok(techRoute.layoutSequence.slice(0, 5).some((step) => step.layout === "kpi"));

const oldDeckBrief = buildMaterialBrief([{ name: "case.pptx", text: "cover\nprice 39 59 159\nrisk delivery complaint\ncategory matrix" }]);
oldDeckBrief.sourceReport = {
  hasOldDeck: true,
  templateProfile: {
    version: 1,
    deckNames: ["case.pptx"],
    slideCount: 4,
    layoutCount: 3,
    usedLayoutCount: 3,
    reusableLayoutCount: 3,
    warnings: [],
    layouts: [
      { id: "slideLayout1", name: "Title Slide", role: "cover", useCount: 1, placeholderCount: 2, placeholders: [{ type: "ctrTitle" }, { type: "subTitle" }] },
      { id: "slideLayout2", name: "Title and Content", role: "structured", useCount: 2, placeholderCount: 2, placeholders: [{ type: "title" }, { type: "body" }] },
      { id: "slideLayout3", name: "Picture with Caption", role: "visual", useCount: 1, placeholderCount: 2, placeholders: [{ type: "title" }, { type: "pic" }] }
    ]
  },
  aestheticDiagnosis: {
    overallScore: 60,
    lowScoreSlides: [2],
    highDensitySlides: [3],
    slides: [
      { page: 1, type: "cover", diagnosisScore: 82, layoutStrategy: "cover_hero" },
      { page: 2, type: "product_cost", diagnosisScore: 55, layoutStrategy: "cost_cards" },
      { page: 3, type: "project_review", diagnosisScore: 64, layoutStrategy: "review_four_blocks" }
    ]
  }
};
oldDeckBrief.pages = [
  { page: 1, title: "Source cover", text: "cover", sourceSlideType: "cover", diagnosisScore: 82, layoutStrategy: "cover_hero" },
  { page: 2, title: "Source price", text: "price 39 59 159", sourceSlideType: "product_cost", diagnosisScore: 55, layoutStrategy: "cost_cards" },
  { page: 3, title: "Source risk", text: "risk delivery complaint", sourceSlideType: "project_review", diagnosisScore: 64, layoutStrategy: "review_four_blocks" },
  { page: 4, title: "Source matrix", text: "category matrix", sourceSlideType: "category_matrix", diagnosisScore: 74, layoutStrategy: "category_matrix" }
];
const oldDeckRoute = routeDeck({ mode: "optimize", input: { pageCount: SYSTEM_RECOMMEND }, materialBrief: oldDeckBrief, uploads: [{ originalName: "case.pptx" }] });
assert.equal(oldDeckRoute.sourceReport.aestheticDiagnosis.overallScore, 60);
assert.ok(oldDeckRoute.layoutSequence.some((step) => step.sourceSlideType === "product_cost" && step.layout === "pricing"));
assert.ok(oldDeckRoute.layoutSequence.some((step) => step.sourceSlideType === "project_review" && step.layout === "risk-checklist"));
assert.equal(oldDeckRoute.templateReusePlan.status, "has-reuse-candidates");
assert.ok(oldDeckRoute.layoutSequence.some((step) => step.templateReuse?.status === "reuse-candidate"));
const pptUploadDeck = validateDeck({
  title: "Uploaded PPT rewrite",
  slides: oldDeckBrief.pages.map((page) => ({
    title: page.title,
    layout: page.sourceSlideType === "cover" ? "cover" : page.sourceSlideType === "category_matrix" ? "cards" : "visual",
    bullets: [page.text],
    sourceSlideType: page.sourceSlideType
  }))
}, oldDeckRoute).deck;
const pptUploadJob = {
  id: "smoke_uploaded_ppt_visual_project",
  mode: "optimize",
  input: { routePlan: oldDeckRoute, materialBrief: oldDeckBrief },
  deck: pptUploadDeck,
  files: [{ id: "upload_ppt_1", originalName: "case.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", path: "C:/tmp/case.pptx", source: "upload" }],
  exports: {}
};
pptUploadJob.assetManifest = buildAssetManifest({ files: pptUploadJob.files, materialBrief: oldDeckBrief, deck: pptUploadDeck });
pptUploadJob.assetManifestQa = validateAssetManifest(pptUploadJob.assetManifest);
assert.equal(pptUploadJob.assetManifestQa.checks.sourceRefsPresent, true);
assert.ok(pptUploadJob.assetManifest.source_refs.some((ref) => ref.type === "source-ppt" && ref.name === "case.pptx"));
const pptUploadVisualProject = await ensureVisualProjectForJob(pptUploadJob);
const pptUploadDeckSpec = JSON.parse(fs.readFileSync(pptUploadVisualProject.deckSpecPath, "utf8"));
assert.ok(pptUploadDeckSpec.asset_manifest.source_refs.some((ref) => ref.type === "source-ppt"));
assert.equal(fs.existsSync(pptUploadVisualProject.outlinePath), true);
assert.equal(fs.existsSync(pptUploadVisualProject.deckSpecPath), true);
const pptUploadPrompt = JSON.parse(fs.readFileSync(path.join(pptUploadVisualProject.promptsDir, "slide_01.json"), "utf8"));
assert.ok(pptUploadPrompt.asset_rules);
assert.ok(pptUploadPrompt.prompt.includes("Visual target is not the final editable PPT background") || pptUploadPrompt.prompt.includes("Background policy"));
const pptUploadSlideJobs = JSON.parse(fs.readFileSync(pptUploadVisualProject.slideJobsPath, "utf8"));
assert.ok(pptUploadSlideJobs.worker_constraints.some((item) => /asset_manifest/.test(item)));

const emptyBrief = buildMaterialBrief([{ name: "\u8f93\u5165\u8bf4\u660e", text: "\u9879\u76ee\u540d\u79f0\uff1a\u65b0\u54c1\u53d1\u5e03" }]);
assert.equal(emptyBrief.inputStrength, "empty");
assert.ok(emptyBrief.confirmationFields.length >= 3);

const textOnlyBrief = buildMaterialBrief([{ name: "\u4e00\u53e5\u9700\u6c42", text: "\u505a\u4e00\u4efd\u9ad8\u7ea7\u89c6\u89c9\u611f\u7684\u65b0\u54c1\u53d1\u5e03 PPT" }]);
const textOnlyRoute = routeDeck({ input: { pageCount: SYSTEM_RECOMMEND }, materialBrief: textOnlyBrief, uploads: [] });
const textOnlyDeck = validateDeck({
  title: "\u65b0\u54c1\u53d1\u5e03",
  slides: [
    { title: "\u65b0\u54c1\u53d1\u5e03", layout: "cover", bullets: ["\u9ad8\u7ea7\u89c6\u89c9\u611f", "\u53ef\u7f16\u8f91 PPTX"] },
    { title: "\u6838\u5fc3\u4eae\u70b9", layout: "visual", bullets: ["\u54c1\u724c\u6c14\u8d28", "\u4ea7\u54c1\u4ef7\u503c"] }
  ]
}, textOnlyRoute).deck;
const textOnlyJob = {
  id: "smoke_text_only_visual_project",
  mode: "generate",
  input: { routePlan: textOnlyRoute, materialBrief: textOnlyBrief },
  deck: textOnlyDeck,
  files: [],
  exports: {}
};
textOnlyJob.assetManifest = buildAssetManifest({ files: [], materialBrief: textOnlyBrief, deck: textOnlyDeck });
textOnlyJob.assetManifestQa = validateAssetManifest(textOnlyJob.assetManifest);
assert.equal(textOnlyJob.assetManifestQa.checks.sourceRefsPresent, true);
assert.ok(textOnlyJob.assetManifest.assets.some((asset) => asset.kind === "text" && asset.editableRole === "textBox"));
const textOnlyVisualProject = await ensureVisualProjectForJob(textOnlyJob);
assert.equal(fs.existsSync(textOnlyVisualProject.outlinePath), true);
assert.equal(fs.existsSync(textOnlyVisualProject.deckSpecPath), true);
assert.equal(fs.existsSync(path.join(textOnlyVisualProject.promptsDir, "slide_01.json")), true);
const textOnlyDeckSpec = JSON.parse(fs.readFileSync(textOnlyVisualProject.deckSpecPath, "utf8"));
assert.ok(textOnlyDeckSpec.style_system);
assert.equal(textOnlyDeckSpec.output_contract.editable_final_pptx, "SceneGraph-rendered final delivery");
assert.ok(textOnlyDeckSpec.asset_manifest.source_refs.length >= 1);

const validated = validateDeck({
  title: "\u5b57\u7b26\u4e32\u5b57\u6bb5\u517c\u5bb9\u6d4b\u8bd5",
  slides: [
    {
      title: "\u5c01\u9762",
      layout: "cover",
      bullets: "39\u5143\uff1b59\u5143\uff1b159\u5143",
      dataPoints: "39\u5143\n59\u5143\n159\u5143",
      imageSlots: ""
    },
    {
      title: "\u4ef7\u683c\u9875",
      layout: "pricing",
      bullets: "39\u5143\uff1a\u5165\u95e8\u9884\u7b97\uff1b59\u5143\uff1a\u4e3b\u63a8\u6863\u4f4d\uff1b159\u5143\uff1a\u5347\u7ea7\u6863\u4f4d",
      dataPoints: "39\u5143\n59\u5143\n159\u5143",
      imageSlots: ""
    }
  ]
});

assert.equal(validated.deck.slides[1].layout, "closing");
assert.deepEqual(validated.deck.slides[0].bullets, ["39\u5143", "59\u5143"]);
assert.deepEqual(validated.deck.slides[1].dataPoints, ["39\u5143", "59\u5143", "159\u5143"]);

const visualTarget = buildVisualTarget({
  job: { deck: validated.deck, files: [] },
  routePlan: giftRoute,
  materialBrief: weakBrief
});
const assetManifest = buildAssetManifest({
  files: [{ id: "logo_1", originalName: "brand-logo.png", mimeType: "image/png", path: "C:/tmp/logo.png" }],
  materialBrief: brief,
  deck: validated.deck
});
const assetManifestQa = validateAssetManifest(assetManifest);
assert.equal(assetManifestQa.status, "pass");
assert.ok(assetManifest.source_refs.length >= 1);
assert.equal(assetManifestQa.checks.sourceRefsPresent, true);
assert.ok(assetManifest.assets.some((asset) => asset.kind === "logo" && asset.canEnterBackground === false));
assert.ok(assetManifest.assets.some((asset) => asset.kind === "text" && asset.editableRole === "textBox"));
const chineseAssetManifest = buildAssetManifest({
  files: [
    { id: "cn_logo", originalName: "本来生活品牌标识.png", mimeType: "image/png", path: "C:/tmp/cn-logo.png" },
    { id: "cn_product", originalName: "端午礼盒产品主图.png", mimeType: "image/png", path: "C:/tmp/product.png" },
    { id: "cn_chart", originalName: "供应链数据图表.png", mimeType: "image/png", path: "C:/tmp/chart.png" },
    { id: "cn_icon", originalName: "蓝色符号图标.png", mimeType: "image/png", path: "C:/tmp/icon.png" },
    { id: "cn_bg", originalName: "橙色主视觉背景.png", mimeType: "image/png", path: "C:/tmp/bg.png" }
  ],
  materialBrief: weakBrief,
  deck: {
    slides: [{
      title: "中文素材识别",
      layout: "visual",
      bullets: "产品图、Logo；价格，供应链",
      dataPoints: "39元；59元、159元"
    }]
  }
});
assert.ok(chineseAssetManifest.assets.some((asset) => asset.id === "cn_logo" && asset.kind === "logo" && asset.canEnterBackground === false));
assert.ok(chineseAssetManifest.assets.some((asset) => asset.id === "cn_product" && asset.kind === "product" && asset.editableRole === "independentImage"));
assert.ok(chineseAssetManifest.assets.some((asset) => asset.id === "cn_chart" && asset.kind === "chart" && asset.canEnterBackground === false));
assert.ok(chineseAssetManifest.assets.some((asset) => asset.id === "cn_icon" && asset.kind === "icon" && asset.editableRole === "independentImage"));
assert.ok(chineseAssetManifest.assets.some((asset) => asset.id === "cn_bg" && asset.kind === "decoration" && asset.canEnterBackground === true));
assert.deepEqual(
  chineseAssetManifest.assets.filter((asset) => asset.kind === "text" && asset.role === "body").map((asset) => asset.text),
  ["产品图", "Logo", "价格", "供应链"]
);
assert.deepEqual(
  chineseAssetManifest.assets.filter((asset) => asset.kind === "text" && asset.role === "data").map((asset) => asset.text),
  ["39元", "59元", "159元"]
);
const screenshotManifest = buildAssetManifest({
  files: [{ id: "shot_1", originalName: "old-page-screenshot-01.png", mimeType: "image/png", path: "C:/tmp/old-page-screenshot-01.png", materialRole: "page-screenshot" }],
  materialBrief: weakBrief,
  deck: { slides: [{ title: "Screenshot reference only", layout: "visual" }] }
});
const screenshotAsset = screenshotManifest.assets.find((asset) => asset.kind === "page-screenshot");
assert.equal(screenshotAsset.canEnterBackground, false);
assert.equal(validateAssetManifest(screenshotManifest).checks.pageScreenshotsReferenceOnly, true);
const previousCloudMatting = globalThis.process?.env?.CLOUD_MATTING_ENABLED;
if (globalThis.process?.env) globalThis.process.env.CLOUD_MATTING_ENABLED = "false";
const cutoutFallback = await cutoutImage({
  id: "jpg_cutout_candidate",
  originalName: "product-photo.jpg",
  mimeType: "image/jpeg",
  path: path.join(process.cwd(), "missing-product-photo.jpg")
});
if (globalThis.process?.env) {
  if (previousCloudMatting === undefined) delete globalThis.process.env.CLOUD_MATTING_ENABLED;
  else globalThis.process.env.CLOUD_MATTING_ENABLED = previousCloudMatting;
}
assert.equal(cutoutFallback.ok, false);
assert.equal(cutoutFallback.attempts[0].method, "local-flood-fill");
assert.equal(cutoutFallback.attempts[0].ok, false);
assert.equal(cutoutFallback.attempts[1].method, "cloud-image-edit");
assert.equal(cutoutFallback.attempts[1].ok, false);
assert.ok(cutoutFallback.attempts[1].error.includes("CLOUD_MATTING_ENABLED=false"));
assert.equal(visualTarget.noFullSlideRasterAsFinal, true);
assert.equal(visualTarget.sample.status, "not-generated");
assert.ok(visualTarget.sample.prompt.includes("visual reference only"));
const sceneGraph = buildSceneGraph({
  job: { deck: validated.deck, files: [], assetManifest },
  routePlan: giftRoute,
  materialBrief: weakBrief,
  visualTarget
});
const sceneGraphQa = validateSceneGraph(sceneGraph);
assert.equal(sceneGraph.constraints.noFullSlideRaster, true);
assert.equal(sceneGraph.version, 2);
assert.equal(sceneGraph.layerModel.texts.includes("native"), true);
assert.ok(sceneGraph.slides[0].layers.background);
const overriddenSceneGraph = applySceneGraphOverrides(sceneGraph, {
  slides: {
    slide_01: {
      source: "online-editor",
      texts: { title: "Edited SceneGraph Title" }
    }
  }
});
assert.equal(overriddenSceneGraph.slides[0].texts.find((item) => item.role === "title").text, "Edited SceneGraph Title");
assert.equal(validateSceneGraph(overriddenSceneGraph).checks.noFullSlideRaster, true);
assert.equal(sceneGraph.slides.length, validated.deck.slides.length);
assert.ok(sceneGraphQa.textBoxes >= 2);
assert.ok(sceneGraphQa.shapeCount >= 2);
assert.equal(sceneGraphQa.checks.noFullSlideRaster, true);
assert.equal(sceneGraph.slides[0].source.textCoverage.missingExpectedItems.length, 0);
assert.ok(sceneGraph.slides[0].source.textCoverage.expectedItems <= sceneGraph.slides[0].source.textCoverage.sourceItems);
const missingTextQa = validateSceneGraph({
  ...sceneGraph,
  slides: [{
    ...sceneGraph.slides[0],
    source: {
      ...(sceneGraph.slides[0].source || {}),
      textCoverage: {
        ...(sceneGraph.slides[0].source?.textCoverage || {}),
        missingExpectedItems: ["title"]
      }
    }
  }]
});
assert.equal(missingTextQa.status, "warn");
assert.ok(missingTextQa.warnings.some((item) => /expected editable text missing/.test(item)));
const missingTextRepair = buildSceneGraphRepairRecord({
  ...sceneGraph,
  slides: [{ ...sceneGraph.slides[0], texts: [], source: { ...(sceneGraph.slides[0].source || {}), textCoverage: { missingExpectedItems: ["title"] } } }]
}, { items: [] }, validateSceneGraph({
  ...sceneGraph,
  slides: [{ ...sceneGraph.slides[0], texts: [], source: { ...(sceneGraph.slides[0].source || {}), textCoverage: { missingExpectedItems: ["title"] } } }]
}));
assert.ok(missingTextRepair.actions.some((item) => item.action === "rebuild-native-text-boxes"));
const repairedMissingText = applySceneGraphRepairPlan({
  ...sceneGraph,
  slides: [{ ...sceneGraph.slides[0], texts: [], source: { ...(sceneGraph.slides[0].source || {}), textCoverage: { missingExpectedItems: ["title"] } } }]
}, missingTextRepair);
assert.equal(repairedMissingText.sceneGraph.slides[0].texts.some((item) => item.role === "title" && item.editable), true);
const chineseMissingDataRepair = buildSceneGraphRepairRecord({
  slides: [{ id: "slide_missing_data", source: { title: "价格数据页", data: "39元" }, texts: [{ id: "title", role: "title", text: "价格数据页" }], images: [], shapes: [], decorations: [] }]
}, { items: [] }, {
  errors: ["slide_missing_data: missing editable key data / 价格数据"],
  warnings: []
});
const repairedChineseMissingData = applySceneGraphRepairPlan({
  slides: [{ id: "slide_missing_data", source: { title: "价格数据页", data: "39元" }, texts: [{ id: "title", role: "title", text: "价格数据页" }], images: [], shapes: [], decorations: [] }]
}, chineseMissingDataRepair);
assert.ok(repairedChineseMissingData.sceneGraph.slides[0].texts.some((item) => item.role === "data" && item.text === "39元"));
const missingTextHybridQa = buildHybridQa({
  deck: { slides: [{ title: "Missing title", layout: "cover" }] },
  sceneGraphQa: missingTextQa,
  files: [],
  assetManifest: { assets: [], source_refs: [{ id: "source_slide_01" }] },
  assetManifestQa: { checks: { sourceRefsPresent: true }, errors: [], warnings: [] }
}, {}, []);
assert.equal(missingTextHybridQa.categories.content.status, "block");
assert.ok(missingTextHybridQa.categories.content.blockers.some((item) => item.includes("missing-editable-content")));
const canvasSceneGraph = buildSceneGraph({
  job: {
    deck: {
      title: "canvas",
      slides: [
        {
          title: "Canvas title",
          layout: "cover",
          canvasEdits: { title: { box: { x: 20, y: 10, w: 50, h: 12 } } }
        }
      ]
    },
    files: []
  },
  routePlan: giftRoute,
  materialBrief: weakBrief
});
assert.equal(Math.round(canvasSceneGraph.slides[0].texts.find((item) => item.role === "title").box.x * 10) / 10, 2.7);
const visualSampleExcludedGraph = buildSceneGraph({
  job: {
    deck: { title: "visual target exclusion", slides: [{ title: "Cover", layout: "cover", imageSlots: ["sample"] }] },
    files: [{ originalName: "sample.png", mimeType: "image/png", path: "C:/tmp/sample.png", materialRole: "visual-target-reference" }]
  },
  routePlan: giftRoute,
  materialBrief: weakBrief
});
assert.equal(visualSampleExcludedGraph.slides[0].images.filter((image) => image.path).length, 0);
assert.equal(visualSampleExcludedGraph.slides[0].images[0]?.required, true);
assert.equal(visualSampleExcludedGraph.slides[0].images[0]?.provenance?.selectionReason, "no-page-bound-image-found");
const cutoutPreferredGraph = buildSceneGraph({
  job: {
    deck: { title: "cutout priority", slides: [{ title: "Product hero", layout: "visual", imageSlots: ["hero-product.png"] }] },
    files: [
      { id: "hero_original", originalName: "hero-product.png", mimeType: "image/png", path: "C:/tmp/hero-product.png", materialRole: "foreground-cutout-candidate", needsCutout: true, mattingStatus: "planned-not-implemented" },
      { id: "hero_cutout", originalName: "hero-product_cutout.png", mimeType: "image/png", path: "C:/tmp/hero-product_cutout.png", materialRole: "foreground-cutout", derived: true, sourceImageId: "hero_original", sourceImageName: "hero-product.png", needsCutout: false, mattingStatus: "local-pass" }
    ]
  },
  routePlan: giftRoute,
  materialBrief: weakBrief
});
assert.equal(cutoutPreferredGraph.slides[0].images[0].path, "C:/tmp/hero-product_cutout.png");
assert.equal(cutoutPreferredGraph.slides[0].images[0].fullSlide, false);
assert.equal(cutoutPreferredGraph.slides[0].images[0].provenance.selectionReason, "preferred-foreground-cutout");
assert.equal(cutoutPreferredGraph.slides[0].images[0].provenance.mattingStatus, "local-pass");
const fullSlideRiskGraph = {
  version: 2,
  slides: [{
    id: "slide_01",
    constraints: { editable: true, noFullSlideRaster: true },
    texts: [{ id: "title", role: "title", text: "native", box: { x: 1, y: 1, w: 4, h: 1 } }],
    shapes: [],
    decorations: [],
    images: [{ id: "bad", path: "C:/tmp/full.png", box: { x: 0, y: 0, w: 13.333, h: 7.5 }, fullSlide: false }]
  }]
};
const fullSlideRasterQa = validateSceneGraph(fullSlideRiskGraph);
assert.equal(fullSlideRasterQa.status, "block");
assert.ok(fullSlideRasterQa.errors.some((item) => item.includes("full-slide raster")));
const fullSlideRepair = buildSceneGraphRepairRecord(fullSlideRiskGraph, { items: [] }, fullSlideRasterQa);
assert.ok(fullSlideRepair.actions.some((item) => item.action === "remove-full-slide-raster-risk"));
const repairedFullSlide = applySceneGraphRepairPlan(fullSlideRiskGraph, fullSlideRepair);
assert.equal(repairedFullSlide.repairRecord.completed.some((item) => item.action === "remove-full-slide-raster-risk"), true);
assert.ok(repairedFullSlide.sceneGraph.slides[0].images[0].box.w < 13.333);
const backgroundViolationGraph = {
  version: 2,
  slides: [{
    id: "slide_01",
    constraints: { editable: true, noFullSlideRaster: true },
    layers: { background: { containsCriticalText: true, containsLogo: true, containsProductHero: true, containsKeyData: true }, texts: [], shapes: [], assets: [] },
    source: { title: "Recovered proposal title" },
    texts: [],
    shapes: [],
    decorations: [],
    images: []
  }]
};
const backgroundViolationQa = validateSceneGraph(backgroundViolationGraph);
assert.equal(backgroundViolationQa.status, "block");
assert.ok(backgroundViolationQa.errors.some((item) => item.includes("background layer contains critical content")));
const backgroundRepair = buildSceneGraphRepairRecord(backgroundViolationGraph, { items: [] }, backgroundViolationQa);
assert.ok(backgroundRepair.actions.some((item) => item.action === "sanitize-background-layer"));
const repairedBackground = applySceneGraphRepairPlan(backgroundViolationGraph, backgroundRepair);
assert.equal(repairedBackground.sceneGraph.slides[0].layers.background.containsCriticalText, false);
assert.equal(repairedBackground.sceneGraph.slides[0].texts.some((item) => item.role === "title" && item.editable), true);
assert.equal(repairedBackground.sceneGraph.slides[0].images.some((item) => item.role === "logo" && item.required && item.fullSlide === false), true);
assert.equal(repairedBackground.sceneGraph.slides[0].images.some((item) => item.role === "product" && item.required && item.fullSlide === false), true);
assert.equal(validateSceneGraph(repairedBackground.sceneGraph).status, "warn");
const missingImageGraph = {
  version: 2,
  slides: [{
    id: "slide_01",
    constraints: { editable: true, noFullSlideRaster: true, visualPriority: "high" },
    layers: { background: {}, texts: [], shapes: [], assets: [] },
    texts: [{ id: "title", role: "title", text: "native", box: { x: 1, y: 1, w: 4, h: 1 } }],
    shapes: [],
    decorations: [],
    images: []
  }]
};
const missingImageQa = validateSceneGraph(missingImageGraph);
assert.equal(missingImageQa.status, "warn");
assert.ok(missingImageQa.warnings.some((item) => item.includes("missing-required-image-object")));
const missingImageRepair = buildSceneGraphRepairRecord(missingImageGraph, { items: [] }, missingImageQa);
assert.ok(missingImageRepair.actions.some((item) => item.action === "bind-or-generate-independent-image"));
const repairedMissingImage = applySceneGraphRepairPlan(missingImageGraph, missingImageRepair);
assert.equal(repairedMissingImage.sceneGraph.slides[0].images.some((item) => item.required && item.fullSlide === false && item.editable), true);
assert.equal(repairedMissingImage.repairRecord.completed.some((item) => item.action === "bind-or-generate-independent-image" && item.materialStatus === "pending-bind-or-generate"), true);
const missingImageHybridQa = buildHybridQa({
  deck: { slides: [{ title: "Missing image", layout: "visual" }] },
  sceneGraphQa: validateSceneGraph(repairedMissingImage.sceneGraph),
  files: [],
  assetManifest: { assets: [], source_refs: [{ id: "source_slide_01" }] },
  assetManifestQa: { checks: { sourceRefsPresent: true }, errors: [], warnings: [] }
}, {}, []);
assert.equal(missingImageHybridQa.categories.assets.status, "block");
assert.ok(missingImageHybridQa.categories.assets.blockers.some((item) => item.includes("missing-required-independent-images")));
assert.equal(buildFinalExportGate({ formats: ["pdf"], hybridQa: missingImageHybridQa }).blocked, true);
assert.equal(buildFinalExportGate({ formats: ["pptx"], hybridQa: missingImageHybridQa }).blocked, false);
const pdfPendingGraph = buildSceneGraph({
  job: {
    deck: { title: "pdf", slides: [{ title: "PDF page", layout: "cover" }] },
    files: [{ originalName: "source.pdf", mimeType: "application/pdf", path: "C:/tmp/source.pdf" }]
  },
  routePlan: giftRoute,
  materialBrief: weakBrief
});
const pdfPendingQa = validateSceneGraph(pdfPendingGraph);
assert.equal(pdfPendingGraph.editableManifest.pdfPending, true);
assert.equal(pdfPendingQa.status, "warn");
assert.ok(pdfPendingQa.warnings.some((item) => /PDF source pages/.test(item)));
const visualCompare = compareVisualTarget(sceneGraph, visualTarget);
assert.ok(visualCompare.score > 0);
assert.ok(["pass", "warn"].includes(visualCompare.status));
const repairRecord = buildSceneGraphRepairRecord(sceneGraph, visualCompare, sceneGraphQa);
assert.ok(["not-needed", "planned", "blocked"].includes(repairRecord.status));
assert.equal(repairRecord.policy.includes("never paste visual target"), true);
const previewCompare = compareRenderedPreviewToVisualTarget({
  sceneGraph,
  visualTarget,
  previewImages: ["/outputs/job/exports/png/slide-1.png", "/outputs/job/exports/png/slide-2.png"],
  previewQa: [
    { status: "pass", risks: [], full: { variance: 34, brightness: 0.7, edgeDensity: 0.04, saturationDensity: 0.15 } },
    { status: "warn", risks: ["text-safe-area-too-busy"], full: { variance: 22, brightness: 0.65, edgeDensity: 0.08, saturationDensity: 0.12 } }
  ],
  targetQa: { status: "pass", risks: [], full: { variance: 32, brightness: 0.68, edgeDensity: 0.05, saturationDensity: 0.13 } }
});
assert.equal(previewCompare.method, "pptx-preview-pixel-qa");
assert.ok(previewCompare.score > 0);
assert.ok(["pass", "warn"].includes(previewCompare.status));
const blankPreviewCompare = compareRenderedPreviewToVisualTarget({
  sceneGraph,
  visualTarget,
  previewImages: ["/outputs/job/exports/png/slide-1.png"],
  previewQa: [{ status: "warn", risks: ["image-may-be-too-blank"], full: { variance: 4, brightness: 0.9, edgeDensity: 0.004, saturationDensity: 0.01 } }]
});
const blankRepair = buildSceneGraphRepairRecord(sceneGraph, blankPreviewCompare, sceneGraphQa);
assert.ok(blankRepair.actions.some((item) => item.action === "increase-visual-hierarchy"));
const repairedBlank = applySceneGraphRepairPlan(sceneGraph, blankRepair);
assert.ok(repairedBlank.repairRecord.completed.some((item) => item.action === "increase-visual-hierarchy"));
assert.ok(repairedBlank.sceneGraph.slides[0].decorations.length > sceneGraph.slides[0].decorations.length);

const smokePptxJob = {
  id: "smoke_editability",
  mode: "generate",
  input: { routePlan: giftRoute, materialBrief: weakBrief },
  deck: {
    title: "Smoke Editable Export",
    slides: [
      { title: "Native cover", layout: "cover", bullets: ["text box", "shape object"] },
      { title: "Native closing", layout: "closing", bullets: ["editable PPTX"] }
    ]
  },
  files: [],
  exports: {}
};
smokePptxJob.assetManifest = buildAssetManifest({ files: smokePptxJob.files, materialBrief: weakBrief, deck: smokePptxJob.deck });
smokePptxJob.assetManifestQa = validateAssetManifest(smokePptxJob.assetManifest);
const visualProject = await ensureVisualProjectForJob(smokePptxJob);
assert.equal(fs.existsSync(visualProject.outlinePath), true);
assert.equal(fs.existsSync(visualProject.deckSpecPath), true);
assert.equal(fs.existsSync(visualProject.slideJobsPath), true);
const visualDeckSpec = JSON.parse(fs.readFileSync(visualProject.deckSpecPath, "utf8"));
assert.ok(visualDeckSpec.asset_manifest.source_refs.length >= 1);
assert.equal(visualDeckSpec.output_contract.visual_target_pptx.includes("not editable"), true);
assert.equal(path.extname(visualProject.contactSheetPath).toLowerCase(), ".png");
assert.equal(fs.existsSync(visualProject.contactSheetPath), true);
assert.equal(visualProject.editable, false);
const generatedVisual = await generateVisualProjectSlides(smokePptxJob, {
  maxSlides: 1,
  generateImage: async () => ({ path: smokePptxJob.visualProject.contactSheetPath, provider: "smoke-generator", visualQa: { status: "pass" } })
});
assert.equal(generatedVisual.status, "recorded");
assert.equal(fs.existsSync(path.join(smokePptxJob.visualProject.originImageDir, "slide_01.png")), true);
assert.equal(fs.existsSync(smokePptxJob.visualProject.visualTargetPptxPath), true);
const visualTargetEditability = await inspectEditablePptx(smokePptxJob.visualProject.visualTargetPptxPath);
assert.equal(visualTargetEditability.editable, false);
assert.ok(visualTargetEditability.fullSlidePictures >= 1);
assert.equal(smokePptxJob.visualProject.visualTargetPptxKind, "full-slide-image-intermediate");
const generatedAllVisualTargets = await generateVisualProjectSlides(smokePptxJob, {
  maxSlides: Infinity,
  generateImage: async () => ({ path: smokePptxJob.visualProject.contactSheetPath, provider: "smoke-generator", visualQa: { status: "pass" } })
});
assert.equal(generatedAllVisualTargets.status, "recorded");
assert.equal(fs.existsSync(path.join(smokePptxJob.visualProject.originImageDir, "slide_02.png")), true);
assert.equal(smokePptxJob.visualProject.generatedImages, smokePptxJob.deck.slides.length);
assert.equal(smokePptxJob.visualProject.status, "ready");
const smokePptxPath = await buildDeck(smokePptxJob);
assert.equal(fs.existsSync(smokePptxPath), true);
assert.equal(path.basename(smokePptxPath), "editable-final.pptx");
const editableWorkerManifest = await writeEditableSceneGraphArtifacts(smokePptxJob);
assert.equal(editableWorkerManifest.status, "recorded");
assert.equal(fs.existsSync(smokePptxJob.visualProject.slideSceneGraphManifestPath), true);
assert.equal(fs.existsSync(path.join(smokePptxJob.visualProject.sceneGraphDir, "slide_01.json")), true);
const slideSceneGraphArtifact = JSON.parse(fs.readFileSync(path.join(smokePptxJob.visualProject.sceneGraphDir, "slide_01.json"), "utf8"));
assert.equal(slideSceneGraphArtifact.worker.type, "single-slide-editable-worker");
assert.equal(slideSceneGraphArtifact.qa.noFullSlideRaster, true);
assert.equal(smokePptxJob.renderReport.renderMode, "sceneGraph");
assert.ok(smokePptxJob.sceneGraph?.slides?.length >= 2);
assert.ok(smokePptxJob.sceneGraph.visualProject.referenceOnly);
assert.ok(smokePptxJob.sceneGraph.slides[0].source.visualTargetImage?.endsWith("slide_01.png"));
assert.equal(smokePptxJob.sceneGraph.slides[0].images.some((image) => image.path === smokePptxJob.sceneGraph.slides[0].source.visualTargetImage), false);
assert.equal(smokePptxJob.sceneGraphQa.checks.noFullSlideRaster, true);
const editability = await inspectEditablePptx(smokePptxPath);
assert.equal(editability.checks.nativeTextBoxes, true);
assert.equal(editability.checks.nativeShapes, true);
assert.equal(editability.checks.noFullSlideRaster, true);
assert.equal(editability.fullSlidePictures, 0);
assert.ok(editability.nativeTextBoxes >= 2);
assert.ok(editability.nativeShapes >= 2);
assert.equal(path.extname(smokePptxPath).toLowerCase(), ".pptx");
assert.equal(smokePptxJob.quality.pptxEditability.status, "pass");
assert.ok(smokePptxJob.quality.pptxEditability.nativeTextBoxes >= 2);

const imageEditableJob = {
  id: "smoke_editable_image_object",
  mode: "generate",
  input: { routePlan: giftRoute, materialBrief: weakBrief },
  deck: {
    title: "Smoke Editable Image Object",
    slides: [
      { title: "Product visual", layout: "visual", imageSlots: ["product-hero.png"], bullets: ["independent image object"] },
      { title: "Image stays editable", layout: "closing", bullets: ["not a full-slide raster"] }
    ]
  },
  files: [{
    id: "product_image_1",
    originalName: "product-hero.png",
    mimeType: "image/png",
    path: smokePptxJob.visualProject.contactSheetPath,
    materialRole: "product",
    source: "upload"
  }],
  exports: {}
};
imageEditableJob.assetManifest = buildAssetManifest({
  files: imageEditableJob.files,
  materialBrief: weakBrief,
  deck: imageEditableJob.deck
});
imageEditableJob.assetManifestQa = validateAssetManifest(imageEditableJob.assetManifest);
const imageEditablePptxPath = await buildDeck(imageEditableJob);
const imageEditable = await inspectEditablePptx(imageEditablePptxPath);
assert.equal(path.basename(imageEditablePptxPath), "editable-final.pptx");
assert.ok(imageEditableJob.sceneGraph.slides[0].images.some((image) => image.path === smokePptxJob.visualProject.contactSheetPath));
assert.ok(imageEditableJob.sceneGraph.slides[0].images.some((image) => image.provenance?.source === "product"));
assert.equal(imageEditableJob.sceneGraph.slides[0].layers.background.containsProductHero, false);
assert.ok(imageEditable.nativePictures >= 1);
assert.equal(imageEditable.fullSlidePictures, 0);
assert.equal(imageEditable.checks.noFullSlideRaster, true);

const pageBoundJob = {
  id: "smoke_page_bound_visual_target",
  mode: "generate",
  input: { routePlan: giftRoute, materialBrief: weakBrief },
  deck: {
    title: "Page Bound Visual Target",
    slides: [
      { title: "Cover with product", layout: "cover", imageSlots: ["slide-one-product"], bullets: ["hero product"] },
      { title: "Case with second product", layout: "visual", imageSlots: ["slide-two-product"], bullets: ["different page asset"] },
      { title: "Closing without source image", layout: "closing", imageSlots: ["missing-closing-asset"], bullets: ["must not reuse another page image"] }
    ]
  },
  files: [
    { id: "asset_slide_1_product", originalName: "slide-one-product.png", mimeType: "image/png", path: "E:\\PPT工具\\tmp\\slide-one-product.png", materialRole: "product", sourceSlide: 1 },
    { id: "asset_slide_2_product", originalName: "slide-two-product.png", mimeType: "image/png", path: "E:\\PPT工具\\tmp\\slide-two-product.png", materialRole: "product", sourceSlide: 2 }
  ],
  exports: {}
};
pageBoundJob.assetManifest = buildAssetManifest({
  files: pageBoundJob.files,
  materialBrief: weakBrief,
  deck: pageBoundJob.deck
});
assert.ok(pageBoundJob.assetManifest.slideBindings?.[0]?.criticalImageIds.includes("asset_slide_1_product"));
assert.ok(pageBoundJob.assetManifest.slideBindings?.[1]?.criticalImageIds.includes("asset_slide_2_product"));
await ensureVisualProjectForJob(pageBoundJob, { force: true });
const promptJobs = JSON.parse(fs.readFileSync(pageBoundJob.visualProject.slideJobsPath, "utf8"));
assert.equal(promptJobs.selected_backend, "cloud-image-first-local-fallback");
assert.ok(promptJobs.worker_constraints.some((item) => /selected image backend/.test(item)));
assert.ok(promptJobs.slides[0].prompt.includes("codex-ppt quality"));
assert.ok(promptJobs.slides[0].prompt.includes("image_area_target"));
assert.ok(promptJobs.slides[0].input_images.some((image) => image.id === "asset_slide_1_product"));
assert.equal(promptJobs.slides[0].input_images.some((image) => image.id === "asset_slide_2_product"), false);
const pageBoundTarget = buildVisualTarget({ job: pageBoundJob, routePlan: giftRoute, materialBrief: weakBrief });
const pageBoundSceneGraph = buildSceneGraph({ job: pageBoundJob, routePlan: giftRoute, materialBrief: weakBrief, visualTarget: pageBoundTarget });
const slideOneImage = pageBoundSceneGraph.slides[0].images[0];
const slideTwoImage = pageBoundSceneGraph.slides[1].images[0];
const slideThreeImage = pageBoundSceneGraph.slides[2].images[0];
assert.equal(slideOneImage.provenance.sourceSlide, 1);
assert.equal(slideTwoImage.provenance.sourceSlide, 2);
assert.equal(slideThreeImage.path, "");
assert.equal(slideThreeImage.required, true);
assert.equal(slideThreeImage.provenance.selectionReason, "no-page-bound-image-found");
const slideArea = 13.333 * 7.5;
assert.ok((slideOneImage.box.w * slideOneImage.box.h) / slideArea >= 0.34);
assert.ok((slideTwoImage.box.w * slideTwoImage.box.h) / slideArea >= 0.30);
const pageBoundCompare = compareVisualTarget(pageBoundSceneGraph, pageBoundTarget);
assert.ok(pageBoundCompare.items[2].warnings.includes("missing-required-image-object"));
assert.equal(pageBoundCompare.items[0].warnings.some((warning) => /^image-area-too-small/.test(warning)), false);

const passHybridQa = buildHybridQa(smokePptxJob, smokePptxJob.quality, smokePptxJob.previewImages || []);
assert.equal(passHybridQa.categories.editable.status, "pass");
assert.equal(passHybridQa.facts.fullSlidePictures, 0);
const blockedHybridQa = buildHybridQa({
  ...smokePptxJob,
  quality: {
    ...(smokePptxJob.quality || {}),
    pptxEditability: { editable: false, fullSlidePictures: 1, warnings: ["full-slide-picture-risk:1"] }
  }
}, { pptxEditability: { editable: false, fullSlidePictures: 1, warnings: ["full-slide-picture-risk:1"] } }, []);
assert.equal(blockedHybridQa.categories.editable.status, "block");
assert.equal(blockedHybridQa.status, "block");
const blockedFinalGate = buildFinalExportGate({ formats: ["pptx", "pdf"], hybridQa: blockedHybridQa });
assert.equal(blockedFinalGate.blocked, true);
assert.equal(blockedFinalGate.requestedFinalFormats[0], "pdf");
const draftOnlyGate = buildFinalExportGate({ formats: ["pptx"], hybridQa: blockedHybridQa });
assert.equal(draftOnlyGate.blocked, false);
const allowedBlockedGate = buildFinalExportGate({ formats: ["png"], hybridQa: blockedHybridQa, allowBlockedExport: true });
assert.equal(allowedBlockedGate.blocked, false);
const visualReferenceExportJob = {
  id: "smoke_visual_reference_exclusion",
  mode: "generate",
  input: { routePlan: giftRoute, materialBrief: weakBrief },
  deck: { title: "Visual reference exclusion", slides: [{ title: "Do not paste reference", layout: "cover", imageSlots: ["visual-target.png"] }] },
  files: [{ originalName: "visual-target.png", mimeType: "image/png", path: path.join(process.cwd(), "missing-visual-target.png"), materialRole: "visual-target-reference" }],
  exports: {}
};
const visualReferencePptxPath = await buildDeck(visualReferenceExportJob);
const visualReferenceEditability = await inspectEditablePptx(visualReferencePptxPath);
assert.equal(visualReferenceExportJob.sceneGraph.slides[0].images.some((image) => image.provenance?.source === "visual-target-reference" || image.path?.includes("visual-target.png")), false);
assert.equal(visualReferenceExportJob.sceneGraph.slides[0].images.filter((image) => image.path).length, 0);
assert.equal(visualReferenceEditability.nativePictures, 0);
await assert.rejects(
  () => buildDeck({
    id: "smoke_no_scenegraph_fallback",
    mode: "generate",
    input: { routePlan: giftRoute, materialBrief: weakBrief },
    deck: { title: "No fallback", slides: [] },
    files: [],
    exports: {}
  }),
  /SceneGraph has no slides/
);
const cloudImageConfig = getCloudImageConfig();
assert.equal(typeof cloudImageConfig.enabled, "boolean");
assert.ok(cloudImageConfig.baseUrl);
assert.ok(cloudImageConfig.model);

const frontendSource = fs.readFileSync(path.join(process.cwd(), "src", "main.jsx"), "utf8");
assert.ok(frontendSource.includes("dual-preview-grid"));
assert.ok(frontendSource.includes("dual-slide-selector"));
assert.ok(frontendSource.includes("setSelectedSlide={setSelectedSlide}"));
assert.ok(frontendSource.includes("视觉目标"));
assert.ok(frontendSource.includes("不可编辑 / 中间产物"));
assert.ok(frontendSource.includes("可编辑结果"));
assert.ok(frontendSource.includes("最终交付 / SceneGraph"));
assert.ok(frontendSource.includes("一键提案级可编辑重构"));
assert.ok(frontendSource.includes("一键生成可编辑最终稿"));
assert.ok(frontendSource.includes("方向审阅可选"));
assert.ok(frontendSource.includes("直接进入全链路"));
assert.ok(frontendSource.includes("未采用方向也可直接生成"));
assert.ok(frontendSource.includes("hasUploadedMaterials"));
assert.ok(frontendSource.includes("{hasUploadedMaterials && ("));
assert.ok(frontendSource.includes("outline-strategy-toggle"));
assert.ok(frontendSource.includes("主视觉方向审阅"));
assert.ok(frontendSource.includes("生成主视觉方向"));
assert.ok(frontendSource.includes("采用此方向"));
assert.ok(frontendSource.includes("这些只是 visual target"));
assert.ok(frontendSource.includes("stage-empty-state"));
assert.ok(frontendSource.includes("还没有可编辑结果"));
assert.ok(frontendSource.includes("暂无可导出文件"));
assert.ok(frontendSource.includes("rightPanelTabs"));
assert.ok(frontendSource.includes("formatDesignDirectionName"));
assert.ok(frontendSource.includes("战卡方向"));
assert.equal(frontendSource.includes(">模板包<"), false);
assert.equal(frontendSource.includes("确认这个风格"), false);
assert.equal(frontendSource.includes("风格样稿确认"), false);
assert.equal(frontendSource.includes("生成风格样稿"), false);
assert.equal(frontendSource.includes("!styleConfirmed"), false);
assert.ok(frontendSource.includes("editable-draft.pptx"));
assert.ok(frontendSource.includes("QA blocked: 当前 PPTX 是可编辑草稿"));
assert.ok(frontendSource.includes("全量生成"));
assert.ok(frontendSource.includes("isJobBlockedForFinal"));

console.log("smoke tests passed");
