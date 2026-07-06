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
import { findLegacyStyleEvidence } from "./workflowApprovals.js";
import { cleanPublicError } from "./workflowWorkerBatchRunner.js";
import { deriveWorkflowDeliveryStatus } from "../shared/workflowDeliveryStatus.js";

const EASTERN = "\u4e1c\u65b9\u81ea\u7136\u98ce";
const TECH = "\u84dd\u767d\u79d1\u6280\u98ce";
const SYSTEM_RECOMMEND = "\u7cfb\u7edf\u63a8\u8350";

const designSystem = getDesignSystem();
assert.equal(Object.hasOwn(designSystem, "templatePacks"), false);
assert.equal(Object.hasOwn(designSystem.skillRules, "oldDeck"), false);
assert.equal(Object.hasOwn(designSystem.skillRules, "templateReuse"), false);
assert.equal(Object.hasOwn(designSystem.skillRules, "templatePacks"), false);
assert.equal(getTemplatePack(EASTERN).slug, "skill-first-no-legacy-template");
assert.equal(getTemplatePackPrompt(TECH), "");
assert.equal(findLegacyStyleEvidence({ styleBrief: "轻盈渐变风" }), "轻盈渐变风");
assert.equal(findLegacyStyleEvidence({ styleBrief: "Premium clean business presentation" }), "");

const derivedWorkerStatus = deriveWorkflowDeliveryStatus({
  sourceMeta: { pageCount: 4 },
  artifacts: {
    renderedPages: [{}, {}, {}, {}],
    visualImages: [{}, {}, {}, {}],
    imageDeck: { pageCount: 4 },
    editableRun: { path: "run" },
    editableWorkerTasks: [
      { pageId: "page_001", status: "recorded" },
      { pageId: "page_002", status: "ready" },
      { pageId: "page_004", status: "ready" }
    ],
    externalImageSpendAuthorizations: []
  }
});
assert.equal(derivedWorkerStatus.nextStep.id, "start-page-workers");
assert.deepEqual(derivedWorkerStatus.nextStep.pages, ["page_002", "page_004"]);
assert.equal(derivedWorkerStatus.nextStep.pageSelection, "page_002,page_004");
assert.equal(derivedWorkerStatus.nextStep.externalImageCalls, 16);
assert.equal(derivedWorkerStatus.nextStep.authorization.required, true);
assert.equal(derivedWorkerStatus.nextStep.authorization.persisted, false);

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
assert.equal(giftRoute.templatePack.slug, "skill-first-no-legacy-template");
assert.equal(giftRoute.layoutSequence[1].layout, "visual");

const techRoute = routeDeck({
  input: { pageCount: "12", style: TECH, notes: "\u6280\u672f\u65b9\u6848 \u6570\u636e\u6c47\u62a5 KPI \u5206\u6790" },
  materialBrief: brief,
  uploads: []
});
assert.equal(techRoute.templatePack.slug, "skill-first-no-legacy-template");
assert.ok(techRoute.layoutSequence.some((step) => step.layout === "pricing"));

const oldDeckBrief = buildMaterialBrief([{ name: "case.pptx", text: "cover\nprice 39 59 159\nrisk delivery complaint\ncategory matrix" }]);
oldDeckBrief.sourceReport = {
  hasOldDeck: true,
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
assert.equal(oldDeckRoute.templateReusePlan.status, "removed");
assert.equal(oldDeckRoute.layoutSequence.some((step) => step.templateReuse), false);
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
const canvasLayerSceneGraph = buildSceneGraph({
  job: {
    deck: {
      title: "canvas-layers",
      slides: [
        {
          title: "Canvas image and shape",
          layout: "visual",
          imageSlots: ["hero-product.png"],
          canvasEdits: {
            asset_0: { type: "image", box: { x: 60, y: 20, w: 22, h: 28 }, fit: "cover", opacity: 0.8 },
            shape_0: { type: "shape", box: { x: 0, y: 0, w: 100, h: 2 }, fill: "#123456", line: "#123456", opacity: 0.7 }
          }
        }
      ]
    },
    files: [{ id: "hero", originalName: "hero-product.png", mimeType: "image/png", path: "C:/tmp/hero-product.png", materialRole: "foreground" }]
  },
  routePlan: giftRoute,
  materialBrief: weakBrief
});
assert.equal(canvasLayerSceneGraph.slides[0].images[0].fit, "cover");
assert.equal(Math.round(canvasLayerSceneGraph.slides[0].images[0].box.x * 10) / 10, 8);
assert.equal(canvasLayerSceneGraph.slides[0].decorations[0].fill, "123456");
assert.equal(canvasLayerSceneGraph.slides[0].decorations[0].transparency, 30);
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
const apiClientSource = fs.readFileSync(path.join(process.cwd(), "src", "api", "client.js"), "utf8");
const guidedActionSource = fs.readFileSync(path.join(process.cwd(), "src", "workflow", "guidedAction.js"), "utf8");
const indexSource = fs.readFileSync(path.join(process.cwd(), "server", "index.js"), "utf8");
const storeSource = fs.readFileSync(path.join(process.cwd(), "server", "store.js"), "utf8");
const sourceRendererSource = fs.readFileSync(path.join(process.cwd(), "server", "sourceRenderer.js"), "utf8");
const doctorSource = fs.readFileSync(path.join(process.cwd(), "server", "doctor.js"), "utf8");
const productVisualReadinessRunnerSource = fs.readFileSync(path.join(process.cwd(), "server", "workflowProductVisualReadinessRunner.js"), "utf8");
const workflowEditableSource = fs.readFileSync(path.join(process.cwd(), "server", "workflowEditable.js"), "utf8");
const workflowDeliverySource = fs.readFileSync(path.join(process.cwd(), "server", "workflowDelivery.js"), "utf8");
const workflowWorkerQueueSource = fs.readFileSync(path.join(process.cwd(), "server", "workflowWorkerQueue.js"), "utf8");
assert.ok(!frontendSource.includes("dual-preview-grid"));
assert.ok(!frontendSource.includes("GenerationGateFlow"));
assert.ok(!frontendSource.includes("StylePreviewGate"));
assert.ok(!frontendSource.includes("VisualProjectWorkspace"));
assert.ok(!frontendSource.includes("settingsStatus"));
assert.ok(frontendSource.includes("rightPanelTabs"));
assert.ok(frontendSource.includes("SettingsPanel"));
assert.ok(frontendSource.includes("hasUploadedMaterials"));
assert.ok(frontendSource.includes("{hasUploadedMaterials && ("));
assert.ok(frontendSource.includes("outline-strategy-toggle"));
assert.ok(frontendSource.includes("stage-empty-state"));
assert.ok(!frontendSource.includes("TemplatePreflightSelector"));
assert.ok(!indexSource.includes('/api/jobs/:id/template'));
assert.ok(!frontendSource.includes("function HistoryPanel"));
assert.ok(!frontendSource.includes("jobHealthClass"));
assert.ok(!frontendSource.includes("workflow-reference-advanced"));
assert.ok(!frontendSource.includes("WorkflowSampleLibraryPanel"));
assert.ok(!frontendSource.includes("workflow-sample-library"));
assert.ok(!frontendSource.includes("useWorkflowSample"));
assert.ok(!frontendSource.includes("FALLBACK_THEMES"));
assert.ok(!frontendSource.includes('style: "轻盈渐变风"'));
assert.ok(!fs.readFileSync(path.join(process.cwd(), "server", "deckRouter.js"), "utf8").includes("轻盈渐变风"));
assert.ok(!fs.readFileSync(path.join(process.cwd(), "design-system", "themes.json"), "utf8").includes("轻盈渐变风"));
assert.ok(!fs.readFileSync(path.join(process.cwd(), "design-system", "aesthetic-recipes.json"), "utf8").includes("轻盈渐变风"));
assert.ok(!frontendSource.includes("api.designSystem"));
assert.ok(!/form\.style|styleBrief:\s*form\.style|themeName:\s*""|themeSlug:\s*""/.test(frontendSource));
assert.ok(!frontendSource.includes("themes={themes}"));
assert.ok(!frontendSource.includes("风格参考库"));
assert.ok(!frontendSource.includes("风格库综合指纹"));
assert.ok(!frontendSource.includes("还没有风格参考图"));
assert.ok(!frontendSource.includes("暂无风格参考"));
assert.ok(!frontendSource.includes("\\u98ce\\u683c\\u53c2\\u8003\\u5e93"));
assert.ok(!frontendSource.includes('projectName: "2026 端午礼盒"'));
assert.ok(!frontendSource.includes('audience: "销售团队内部战卡"'));
assert.ok(frontendSource.includes("可选参考图（非模板）"));
const frontendStyleSource = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
const layoutSource = fs.readFileSync(path.join(process.cwd(), "design-system", "layouts.json"), "utf8");
const checklistSource = fs.readFileSync(path.join(process.cwd(), "design-system", "checklist.md"), "utf8");
assert.ok(!/销售战卡|成交话术|销售预算|卖点卡片|单品详情|组合推荐|风险清单|价格梯度/.test(layoutSource));
assert.ok(!/销售战卡|成交话术|销售预算/.test(checklistSource));
assert.ok(!frontendStyleSource.includes(".theme-row"));
assert.ok(!frontendStyleSource.includes(".theme-card"));
assert.ok(!frontendStyleSource.includes(".orchestration-grid"));
assert.ok(frontendSource.includes("可选参考图"));
assert.ok(frontendSource.includes("确认所有就绪关卡（不生成图片）"));
assert.ok(frontendSource.includes("不会生成图片"));
assert.ok(frontendSource.includes("formatReadyApprovalGateLabels"));
assert.ok(frontendSource.includes("getNoCostCodexApprovalSummary"));
assert.ok(frontendSource.includes("approveNoCostCodexGates"));
assert.ok(frontendSource.includes("skill-first-next-card"));
assert.ok(frontendSource.includes("下一步：无费用确认"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8").includes(".skill-first-next-card"));
assert.ok(indexSource.includes('/api/v1-acceptance/product-visual-sample/preflight'));
assert.ok(indexSource.includes('/api/v1-acceptance/product-visual-sample/prompt-preview'));
assert.ok(indexSource.includes('/api/v1-acceptance/product-visual-sample/approval/preflight'));
assert.ok(indexSource.includes('/api/v1-acceptance/product-visual-sample/approval/approve'));
assert.ok(indexSource.includes('/api/v1-acceptance/product-visual-full-deck/approval/preflight'));
assert.ok(indexSource.includes('/api/v1-acceptance/product-visual-full-deck/approval/approve'));
assert.ok(indexSource.includes('/api/v1-acceptance/product-visual-full-deck/preflight'));
assert.ok(indexSource.includes('/api/v1-acceptance/product-visual-sample/run'));
assert.ok(indexSource.includes('/api/v1-acceptance/product-visual-full-deck/run'));
assert.ok(indexSource.includes('app.get("/api/v1-acceptance"'));
assert.ok(indexSource.includes("buildLatestV1AcceptancePayload"));
assert.ok(indexSource.includes("hydrateProductVisualActionPayload"));
assert.ok(indexSource.includes("promptPreviewJobId: readinessJobId"));
assert.ok(apiClientSource.includes('fetch("/api/v1-acceptance"'));
assert.ok(!apiClientSource.includes('fetch("/api/v1-acceptance/latest"'));
assert.ok(indexSource.includes("matchesLatestReport"));
assert.ok(indexSource.includes("产品级视觉预检已过期"));
const v1AcceptanceReportSource = fs.readFileSync(path.join(process.cwd(), "server", "workflowV1AcceptanceReport.js"), "utf8");
assert.ok(v1AcceptanceReportSource.includes("buildRealPptRegressionCommand"));
assert.ok(v1AcceptanceReportSource.includes("spendPlan"));
assert.ok(v1AcceptanceReportSource.includes("buildProductVisualSpendPlan"));
assert.ok(v1AcceptanceReportSource.includes("totalExternalImageCalls"));
assert.ok(v1AcceptanceReportSource.includes("isV1ScopedReport"));
assert.ok(v1AcceptanceReportSource.includes("findLatestV1ScopedReport"));
assert.ok(v1AcceptanceReportSource.includes("if (requiredForV1)"));
assert.ok(v1AcceptanceReportSource.includes("latestUpdated: requiredForV1"));
assert.ok(v1AcceptanceReportSource.includes("latestRepaired"));
assert.ok(v1AcceptanceReportSource.includes("product-visual-full-deck-approval-preflight"));
assert.ok(v1AcceptanceReportSource.includes("product-visual-full-deck-approval-approve"));
assert.ok(productVisualReadinessRunnerSource.includes("getProductVisualSamplePreflight"));
assert.ok(productVisualReadinessRunnerSource.includes("promptPreviewStatus"));
assert.ok(productVisualReadinessRunnerSource.includes("getProductVisualSampleApprovalPreflight"));
assert.ok(productVisualReadinessRunnerSource.includes("approveProductVisualSample"));
assert.ok(productVisualReadinessRunnerSource.includes("getProductVisualFullDeckApprovalPreflight"));
assert.ok(productVisualReadinessRunnerSource.includes("approveProductVisualFullDeck"));
assert.ok(productVisualReadinessRunnerSource.includes("buildSampleReviewChecklist"));
assert.ok(productVisualReadinessRunnerSource.includes("sampleReviewChecklist"));
assert.ok(productVisualReadinessRunnerSource.includes("preflightCodexPptGate"));
assert.ok(productVisualReadinessRunnerSource.includes("approveCodexPptGate"));
assert.ok(productVisualReadinessRunnerSource.includes("buildProductVisualNextStagePlan"));
assert.ok(productVisualReadinessRunnerSource.includes("nextStagePlan"));
assert.ok(productVisualReadinessRunnerSource.includes("recommendedTestPages"));
assert.ok(productVisualReadinessRunnerSource.includes("estimatedFullDeckImageCalls"));
assert.ok(productVisualReadinessRunnerSource.includes("getProductVisualFullDeckPreflight"));
assert.ok(productVisualReadinessRunnerSource.includes("runProductVisualSample"));
assert.ok(productVisualReadinessRunnerSource.includes("runProductVisualFullDeck"));
assert.ok(productVisualReadinessRunnerSource.includes("generateWorkflowVisualImages"));
assert.ok(productVisualReadinessRunnerSource.includes("assembleWorkflowImageDeck"));
assert.ok(productVisualReadinessRunnerSource.includes("syncProductVisualDeckToV1AcceptanceReport"));
assert.ok(productVisualReadinessRunnerSource.includes("writeV1AcceptanceReport"));
assert.ok(productVisualReadinessRunnerSource.includes("latestUpdated: writeResult.latestUpdated"));
const productVisualReadinessCliSource = fs.readFileSync(path.join(process.cwd(), "scripts", "product-visual-readiness.mjs"), "utf8");
assert.ok(productVisualReadinessCliSource.includes("latest-product-visual-readiness.json"));
assert.ok(productVisualReadinessCliSource.includes("writeLatestNoCostReadiness"));
assert.ok(productVisualReadinessCliSource.includes("!generateSample && !generateDeck"));
assert.ok(productVisualReadinessRunnerSource.includes("safeToRunAutomatically: true"));
assert.ok(productVisualReadinessRunnerSource.includes("requiresExplicitSpendConfirmation: false"));
assert.ok(productVisualReadinessRunnerSource.includes("nextRequiresExplicitSpendConfirmation: true"));
assert.ok(productVisualReadinessRunnerSource.includes("externalImageCalls: 0"));
assert.ok(productVisualReadinessRunnerSource.includes('requiredConfirmation: "externalImageSpend"'));
assert.ok(productVisualReadinessRunnerSource.includes("externalImageCalls: 1"));
assert.ok(productVisualReadinessRunnerSource.includes("confirmProductVisualSample"));
assert.ok(productVisualReadinessRunnerSource.includes("confirmProductVisualFullDeck"));
assert.ok(productVisualReadinessRunnerSource.includes("sampleLink: makeWorkflowArtifactLink"));
assert.ok(productVisualReadinessRunnerSource.includes("buildSourcePageLinkForSample"));
assert.ok(productVisualReadinessRunnerSource.includes("sourcePageLink"));
assert.ok(productVisualReadinessRunnerSource.includes('"rendered-page"'));
assert.ok(productVisualReadinessRunnerSource.includes("imageDeckLink: makeWorkflowArtifactLink"));
assert.ok(productVisualReadinessRunnerSource.includes("visualQualityLink: makeWorkflowArtifactLink"));
assert.ok(productVisualReadinessRunnerSource.includes("visualQuality: finalJob.artifacts?.visualQuality"));
assert.ok(productVisualReadinessRunnerSource.includes("visualImageLinks: buildVisualImageLinks"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowVisuals.js"), "utf8").includes("writeVisualQualityReport"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowVisuals.js"), "utf8").includes("detectSourceTextLoss"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowVisuals.js"), "utf8").includes("possible-title-or-text-loss"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "imageQa.js"), "utf8").includes("titleArea"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowPageRetry.js"), "utf8").includes("getVisualQualityRetryPreflight"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "index.js"), "utf8").includes("/api/workflow-jobs/:id/visual-quality/retry-preflight"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowArtifacts.js"), "utf8").includes("visual-quality"));
assert.ok(productVisualReadinessRunnerSource.includes("PRODUCT_VISUAL_SAMPLE_CONFIRMATION_REQUIRED"));
assert.ok(productVisualReadinessRunnerSource.includes("PRODUCT_VISUAL_SAMPLE_PROMPT_PREVIEW_REQUIRED"));
assert.ok(productVisualReadinessRunnerSource.includes("assertProductVisualSamplePromptPreviewReady"));
assert.ok(productVisualReadinessRunnerSource.includes("PRODUCT_VISUAL_SAMPLE_PROMPT_PREVIEW_ARTIFACT_REQUIRED"));
assert.ok(productVisualReadinessRunnerSource.includes("PRODUCT_VISUAL_SAMPLE_PROMPT_PREVIEW_STALE"));
assert.ok(productVisualReadinessRunnerSource.includes("confirmPromptPreview"));
assert.ok(productVisualReadinessRunnerSource.includes("promptPreviewJobId"));
assert.ok(productVisualReadinessRunnerSource.includes("PRODUCT_VISUAL_FULL_DECK_CONFIRMATION_REQUIRED"));
assert.ok(productVisualReadinessRunnerSource.includes("pageSelection"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowAuthorizations.js"), "utf8").includes("normalizePages"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowAuthorizations.js"), "utf8").includes("pageSelection"));
assert.ok(productVisualReadinessRunnerSource.includes("resolveLocalSourcePath"));
assert.ok(productVisualReadinessRunnerSource.includes("normalizeLocalPathCandidates"));
assert.ok(productVisualReadinessRunnerSource.includes('candidate.replace(/\\\\\\\\+/g, "\\\\")'));
assert.ok(productVisualReadinessRunnerSource.includes("localizeSampleApprovalIssue"));
assert.ok(productVisualReadinessRunnerSource.includes("请先生成 1 页真实 codex-ppt 视觉样张"));
assert.ok(productVisualReadinessRunnerSource.includes("getLatestReadinessFreshness"));
assert.ok(productVisualReadinessRunnerSource.includes("PRODUCT_VISUAL_READINESS_STALE"));
assert.ok(productVisualReadinessRunnerSource.includes("buildExecutionSnapshot"));
assert.ok(productVisualReadinessRunnerSource.includes("executionSnapshot"));
assert.ok(productVisualReadinessRunnerSource.includes('status: readyIfConfirmed ? "ready-after-confirmation" : "blocked"'));
assert.ok(productVisualReadinessRunnerSource.includes("getProductVisualSamplePromptPreview"));
assert.ok(productVisualReadinessRunnerSource.includes("buildVisualPromptsPayload"));
assert.ok(productVisualReadinessRunnerSource.includes("persistProductVisualSamplePromptPreview"));
assert.ok(productVisualReadinessRunnerSource.includes("codexPptSamplePromptPreview"));
assert.ok(productVisualReadinessRunnerSource.includes("promptPreview"));
assert.ok(productVisualReadinessRunnerSource.includes("buildAuthorizationPreview"));
assert.ok(productVisualReadinessRunnerSource.includes("authorizationPreview"));
assert.ok(productVisualReadinessRunnerSource.includes("sourceReferenceRequired"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowArtifacts.js"), "utf8").includes("codex-ppt-sample-prompt-preview"));
assert.ok(productVisualReadinessRunnerSource.includes("isSourceReferencedVisualSample"));
assert.ok(productVisualReadinessRunnerSource.includes("source-page-edit"));
assert.ok(productVisualReadinessRunnerSource.includes("image-edit-provider"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "providers.js"), "utf8").includes("/images/edits"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowVisuals.js"), "utf8").includes("editImageWithProvider"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowV1AcceptanceReport.js"), "utf8").includes("productActions"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowV1AcceptanceReport.js"), "utf8").includes("buildProductVisualProductActions"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowV1AcceptanceReport.js"), "utf8").includes("confirmPromptPreview"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowV1AcceptanceReport.js"), "utf8").includes("product-visual-test-deck-run"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowV1AcceptanceReport.js"), "utf8").includes("product-visual-custom-pages-run"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowV1AcceptanceReport.js"), "utf8").includes("buildV1PhaseProgress"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowV1AcceptanceReport.js"), "utf8").includes("phaseProgress"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowV1AcceptanceReport.js"), "utf8").includes("buildCompletionAudit"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowV1AcceptanceReport.js"), "utf8").includes("completionAudit"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowV1AcceptanceReport.js"), "utf8").includes("remainingExternalImageCalls"));
assert.ok(frontendSource.includes("DualRouteDashboard"));
assert.ok(frontendSource.includes("buildDualRouteState"));
assert.ok(frontendSource.includes("不需要用户操作的 codex-ppt 步骤保持后台处理"));
assert.ok(frontendSource.includes("TopbarQuickPanel"));
assert.ok(frontendSource.includes("topbarPanel"));
assert.ok(frontendSource.includes("aria-label=\"本地账户\""));
assert.ok(frontendSource.includes("topbar-mode-caret"));
assert.ok(frontendSource.includes("DualCleanupPanel"));
assert.ok(frontendSource.includes("高级诊断"));
assert.ok(frontendSource.includes("route-lane"));
assert.ok(frontendSource.includes("dual-dashboard-left"));
assert.ok(frontendSource.includes("dual-dashboard-main"));
assert.ok(!frontendSource.includes("dual-dashboard-right"));
assert.ok(frontendSource.includes('accent="visual"'));
assert.ok(frontendSource.includes('accent="editable"'));
assert.ok(frontendSource.includes("artifacts/image-deck?download=1"));
assert.ok(frontendSource.includes("artifacts/final-pptx?download=1"));
assert.ok(frontendSource.includes("state.routeB.deliverableReady"));
assert.ok(frontendSource.includes("WorkflowDeliveryPortal"));
assert.ok(frontendSource.includes("WorkflowDeliverySummary"));
assert.ok(frontendSource.includes("WorkflowDeliverySimpleCheck"));
assert.ok(frontendSource.includes("WorkflowDeliveryUserHint"));
assert.ok(!frontendSource.includes("WorkflowStrip"));
assert.ok(!frontendSource.includes("workflow-strip"));
assert.ok(!fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8").includes("workflow-strip"));
assert.ok(frontendSource.includes("这里只看能不能交付"));
assert.ok(frontendSource.includes("开始人工复核"));
assert.ok(frontendSource.includes("图片版可先交付"));
assert.ok(frontendSource.includes("workflow-simple-delivery-strip"));
assert.ok(!frontendSource.includes("workflow-delivery-advanced-details"));
assert.ok(!frontendSource.includes("WorkflowPlainAgentDashboardClean"));
assert.ok(!frontendSource.includes("PPT Agent 正在处理"));
assert.ok(frontendSource.includes("checks.fullSourceCoverage === true"));
assert.ok(!frontendSource.includes("ProductV1AcceptancePanel"));
assert.ok(!frontendSource.includes("ProductV1RealDeckAcceptanceCard"));
assert.ok(!frontendSource.includes("ProductVisualPromptPreview"));
assert.ok(!frontendSource.includes("product-v1-product-visual-actions-contract"));
assert.ok(workflowEditableSource.includes("getWorkflowEditablePreparePreflight"));
assert.ok(workflowEditableSource.includes("getEditableTextHintEvidence"));
assert.ok(workflowEditableSource.includes("OCR/editppt text hints are not ready"));
assert.ok(indexSource.includes("/api/workflow-jobs/:id/editable/prepare/preflight"));
assert.ok(apiClientSource.includes("workflowEditablePreparePreflight"));
assert.ok(frontendSource.includes("WorkflowEditablePreparePreflightPanel"));
assert.ok(frontendSource.includes("workflow-editable-prepare-preflight"));
assert.ok(frontendSource.includes("image-to-editable-ppt 准备"));
assert.ok(!frontendSource.includes("WorkflowEditableFailureRecoveryCard"));
assert.ok(!frontendSource.includes("workflow-editable-failure-card"));
assert.ok(frontendSource.includes("resetLatestFailurePages"));
assert.ok(frontendSource.includes("resetLatestDeliveryFailurePages"));
assert.ok(frontendSource.includes("workflowWorkerTaskAction(job.id, pageId, \"reset\""));
assert.ok(!frontendSource.includes("最近失败恢复"));
assert.ok(frontendSource.includes("deliveryWorkerRunBundle"));
assert.ok(frontendSource.includes("previewLatestFailureWorkerStart"));
assert.ok(frontendSource.includes("startLatestFailureWorker"));
assert.ok(frontendSource.includes("latestDeliveryFailurePageSelection"));
assert.ok(frontendSource.includes("if (!job?.id || !latestDeliveryFailurePageSelection) return null;"));
assert.ok(frontendSource.includes("pages: latestDeliveryFailurePageSelection"));
assert.ok(frontendSource.includes("workflowPageSelectionsMatch(preflightPageSelection, latestDeliveryFailurePageSelection)"));
assert.ok(frontendSource.includes("pages: startBody.pages || latestDeliveryFailurePageSelection"));
assert.ok(frontendSource.includes("workflowWorkerPageSelection(status)"));
assert.ok(frontendSource.includes("workflowPreflightPageSelection(workerPreflightBundle)"));
assert.ok(frontendSource.includes("confirmLlmProviderRecovered: Boolean(llmRecovery.required ? llmRecovery.confirmed : false)"));
assert.ok(frontendSource.includes("deliveryLlmRecoveredConfirmed"));
assert.ok(frontendSource.includes("确认页面重建模型服务可用"));
assert.ok(frontendSource.includes("setWorkerPreflightBundle(null)"));
assert.ok(frontendSource.includes("workflowPageSelectionsMatch"));
assert.ok(frontendSource.includes("normalizeWorkflowPageSelection"));
assert.ok(apiClientSource.includes("finalizeWorkflowEditableRun"));
assert.ok(frontendSource.includes("recomposeEditableFinal"));
assert.ok(!frontendSource.includes("WorkflowEditableFinalizeAction"));
assert.ok(frontendSource.includes("allowPartialSample: isPartial"));
assert.ok(frontendSource.includes("不调用外部 API"));
assert.ok(frontendSource.includes("重新合成 editable-final.pptx"));
assert.ok(frontendSource.includes("重新合成最终 PPT"));
assert.ok(!fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8").includes(".workflow-editable-finalize-action"));
assert.ok(frontendSource.includes("deliveryWorkerBatchSize"));
assert.ok(frontendSource.includes("deliverySelectedWorkerPageIds"));
assert.ok(frontendSource.includes("latestDeliveryRun"));
assert.ok(!frontendSource.includes("WorkflowAgentWorkerRunStatusClean"));
assert.ok(!frontendSource.includes("本批正在重建"));
assert.ok(!frontendSource.includes("授权本批 ${selectedBatchImageCalls} 次图片额度"));
assert.ok(!frontendSource.includes("确认并启动 ${selectedBatchCount || \"\"} 页重建"));
assert.ok(!frontendSource.includes("workflow-agent-dashboard-checklist"));
assert.ok(frontendSource.includes("将记录 ${imageCalls} 次 gpt-image-2 图片 API 额度授权"));
assert.ok(frontendSource.includes("这一步只记录授权账本，不会立刻启动 worker"));
assert.ok(frontendSource.includes("后续启动 image-to-editable-ppt 页面 worker 会真实调用外部模型/图片服务"));
assert.ok(frontendSource.includes("已取消页面任务额度授权"));
const workflowNextActionSource = fs.readFileSync(path.join(process.cwd(), "server", "workflowNextAction.js"), "utf8");
assert.ok(workflowNextActionSource.includes("tryBuildFastEditablePageWorkerPreflight"));
assert.ok(workflowNextActionSource.includes("listWorkflowEditableWorkerTasks"));
assert.ok(workflowNextActionSource.includes("lightweight: true"));
assert.ok(workflowNextActionSource.includes("editable/page-workers"));
assert.ok(workflowNextActionSource.includes("启动页面 worker 前，需要先记录 gpt-image-2 图片额度授权。"));
assert.ok(workflowNextActionSource.includes("不会自动静默消耗外部 API"));
assert.ok(workflowNextActionSource.includes("requiresExternalImageConfirmation: true"));
assert.ok(workflowNextActionSource.includes("generateWorkflowVisualSample(jobId, authorizedBody)"));
assert.ok(workflowNextActionSource.includes("generateWorkflowVisualImages(jobId, authorizedBody)"));
assert.ok(!frontendSource.includes("待处理页面"));
const workflowArtifactsSource = fs.readFileSync(path.join(process.cwd(), "server", "workflowArtifacts.js"), "utf8");
assert.ok(workflowArtifactsSource.includes("draft-final-pptx"));
assert.ok(workflowArtifactsSource.includes("assertDraftFinalPptxDownloadable"));
assert.ok(workflowArtifactsSource.includes("Draft final PPTX is only available for partial sample results."));
assert.ok(frontendSource.includes("getFinalDownloadState"));
assert.ok(frontendSource.includes("确认方案"));
assert.ok(frontendSource.includes("确认样张"));
assert.ok(frontendSource.includes("后台生成"));
assert.ok(frontendSource.includes("下载图片版"));
assert.ok(frontendSource.includes("需要弹出确认界面"));
assert.ok(frontendSource.includes("不需要用户操作的 codex-ppt 步骤保持后台处理"));
assert.ok(frontendSource.includes("codexPptDecisionReady"));
assert.ok(frontendSource.includes("sampleApproved"));
assert.ok(!frontendSource.includes("先按 codex-ppt skill 完成 6 步"));
assert.ok(!frontendSource.includes("准备 slide jobs 和运行状态"));
assert.ok(!frontendSource.includes("派发幻灯片子任务"));
assert.ok(!frontendSource.includes("样张已确认，图片版正在后台生成和组装。"));
assert.ok(!frontendSource.includes("后续图片页生成、检查和组装在后台完成"));
assert.ok(!frontendSource.includes("图片页已检查并组装"));
assert.ok(!frontendSource.includes("正在生成、检查和组装"));
assert.ok(!frontendSource.includes("state.routeA.imageDeckReady ? `${PRODUCT_VISUAL_STYLE_LOCK_LABEL}已固化`"));
assert.ok(frontendSource.includes("小样本草稿"));
assert.ok(workflowArtifactsSource.includes("asset-contact-sheet"));
assert.ok(workflowArtifactsSource.includes("split_assets_contact.png"));
assert.ok(frontendSource.includes("WorkflowPageVisualReviewWorkbench"));
assert.ok(frontendSource.includes("workflow-review-modal"));
assert.ok(frontendSource.includes("逐页对比：原始页、图片版、可编辑页"));
assert.ok(frontendSource.includes("label=\"原始页\""));
assert.ok(frontendSource.includes("label=\"图片版\""));
assert.ok(frontendSource.includes("label=\"可编辑页\""));
assert.ok(frontendSource.includes("全部通过，记录复核"));
assert.ok(frontendSource.includes("开始人工复核"));
assert.ok(!frontendSource.includes("暂时接受"));
assert.ok(!frontendSource.includes("确认人工复核通过"));
assert.ok(!frontendSource.includes("标记复核通过"));
assert.ok(!frontendSource.includes("WorkflowArtifactReviewPanel"));
assert.ok(!frontendSource.includes("workflow-artifact-review-panel"));
assert.ok(!frontendSource.includes("workflow-review-panel"));
assert.ok(!frontendSource.includes("buildWorkflowReviewRows"));
assert.ok(frontendSource.includes("markWorkflowPageReview"));
assert.ok(frontendSource.includes("pageVisualReview"));
assert.ok(frontendSource.includes("pendingPageMarks"));
assert.ok(frontendSource.includes("pageMarkErrors"));
assert.ok(frontendSource.includes("savingPages"));
assert.ok(!frontendSource.includes("pageReviewBusy"));
assert.ok(!frontendSource.includes("pageReviewError"));
assert.ok(frontendSource.includes("不通过"));
assert.ok(guidedActionSource.includes("workflow-delivery-panel"));
assert.ok(workflowNextActionSource.includes("workflow-delivery-panel"));
assert.ok(!guidedActionSource.includes("workflow-artifact-review-panel"));
assert.ok(!workflowNextActionSource.includes("workflow-artifact-review-panel"));
const workflowManualReviewSource = fs.readFileSync(path.join(process.cwd(), "server", "workflowManualReview.js"), "utf8");
assert.ok(workflowManualReviewSource.includes("recordWorkflowPageVisualReview"));
assert.ok(workflowManualReviewSource.includes("readyForFinalReview"));
assert.ok(workflowManualReviewSource.includes("Page evidence is incomplete"));
assert.ok(indexSource.includes("/api/workflow-jobs/:id/review/pages/:pageId"));
assert.ok(indexSource.includes("sourceName: workflowSourceName(job)"));
assert.ok(indexSource.includes("sourcePages,"));
assert.ok(indexSource.includes("finalPages,"));
assert.ok(indexSource.includes("isSample: Boolean(sourcePages && finalPages && finalPages < sourcePages)"));
assert.ok(indexSource.includes("function workflowSourceName"));
assert.ok(indexSource.includes("const includeInternal = isTruthyQuery(req.query?.includeInternal)"));
assert.ok(indexSource.includes("buildPrimaryWorkflowListItem(primaryWorkflow)"));
assert.ok(indexSource.includes("job: null"));
assert.ok(frontendSource.includes("workflowJob?.input?.sourceOriginalName"));
assert.ok(frontendSource.includes("checks.sourcePages"));
assert.ok(frontendSource.includes("checks.finalPages"));
const workflowWorkerBatchRunnerSource = fs.readFileSync(path.join(process.cwd(), "server", "workflowWorkerBatchRunner.js"), "utf8");
assert.ok(workflowWorkerBatchRunnerSource.includes("buildRunnerFailureAnalysis"));
assert.ok(workflowWorkerBatchRunnerSource.includes("canRetryPages"));
assert.ok(workflowWorkerBatchRunnerSource.includes("const sanitized = sanitizeRunner(run)"));
assert.ok(workflowWorkerBatchRunnerSource.includes("cleanPublicError"));
assert.ok(workflowWorkerBatchRunnerSource.includes("页面 worker 命令未完成，页面产物没有记录。"));
assert.equal(cleanPublicError("Command failed: C:\\Program Files\\nodejs\\node.exe script.mjs --api-key sk-1234567890abcdef"), "页面 worker 命令未完成，页面产物没有记录。");
assert.equal(cleanPublicError('HTTP 400 {"error":{"message":"raw provider body with Bearer abcdefghijklmnop and sk-1234567890abcdef"}}'), "页面 worker 失败，原始错误已隐藏；请查看失败分析或受控日志。");
assert.equal(cleanPublicError("Worker command exited with code 1. Page artifacts were not recorded."), "页面 worker 命令未完成，页面产物没有记录。");
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowOcr.js"), "utf8").includes("maxPages"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowOcr.js"), "utf8").includes("normalizePages"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowWorkerBatchRunner.js"), "utf8").includes("getTextHintEvidence"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowWorkerBatchRunner.js"), "utf8").includes("localOcrTextHintsAccepted"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowEditable.js"), "utf8").includes("getLocalOcrTextHintsCheckpoint"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "scripts", "visual-asset-helper.mjs"), "utf8").includes("process.env.OPENAI_IMAGE_MODEL"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "scripts", "visual-asset-helper.mjs"), "utf8").includes("IMAGE_TO_EDITABLE_PPT_IMAGE_MODEL"));
assert.ok(frontendSource.includes("textHints.source"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8").includes(".dual-dashboard"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8").includes(".route-lane"));
assert.ok(!fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8").includes(".product-v1-product-visual-sample-preflight"));
assert.ok(!fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8").includes(".product-v1-real-deck"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8").includes(".workflow-editable-prepare-preflight"));
assert.ok(!frontendSource.includes("api.jobs().then"));
assert.ok(!apiClientSource.includes("async jobs("));
assert.ok(!apiClientSource.includes("async job("));
assert.ok(!apiClientSource.includes("async designSystem("));
assert.ok(!indexSource.includes("/api/style-groups"));
assert.ok(!indexSource.includes("listStyleGroups"));
assert.ok(!storeSource.includes("styleGroups"));
assert.ok(!storeSource.includes("style_group"));
assert.ok(indexSource.includes("legacyTemplatesRemoved: true"));
assert.ok(frontendSource.includes("不是旧模板库"));
assert.ok(frontendSource.includes("真正调用外部图片 API 前"));
assert.ok(frontendSource.includes("PPT 智能体工作台"));
assert.ok(frontendSource.includes("PPT Agent"));
assert.ok(!frontendSource.includes("设计方向控制台"));
assert.ok(!frontendSource.includes("模板 / 版式方向"));
assert.ok(!frontendSource.includes("startupJob"));
assert.ok(frontendSource.includes("WorkflowHistoryPanel"));
assert.ok(frontendSource.includes("jobs={workflowJobs}"));
assert.ok(!/visibleRightPanelMode === "history"[\s\S]{0,240}<HistoryPanel/.test(frontendSource));
assert.ok(frontendSource.includes("WorkflowSideStatusPanel"));
assert.ok(/visibleRightPanelMode === "status"[\s\S]{0,900}workflowJob \?/.test(frontendSource));
assert.ok(frontendSource.includes("workflow-side-status"));
assert.ok(frontendSource.includes("workflowJob={workflowJob}"));
assert.ok(frontendSource.includes("PPT 重制助手"));
assert.ok(frontendSource.includes("Agent 状态"));
assert.ok(!frontendSource.includes("双技能工作流助手"));
assert.ok(!frontendSource.includes("双技能状态"));
assert.ok(frontendSource.includes("重制现有 PPT"));
assert.ok(frontendSource.includes("从需求创建任务"));
assert.ok(!frontendSource.includes("从需求创建工作流"));
assert.ok(frontendSource.includes("未选择工作流"));
assert.ok(frontendSource.includes('["not_started", "未开始"]'));
assert.ok(!frontendSource.includes("PPT 助手"));
assert.ok(!frontendSource.includes("从零生成 PPT"));
assert.ok(!frontendSource.includes("优化现有 PPT"));
assert.ok(!frontendSource.includes("未选择 workflow"));
assert.ok(!frontendSource.includes('"not started"'));
assert.ok(frontendSource.includes("workflowJobId: workflowJob?.id"));
assert.ok(!frontendSource.includes("Conversational PPT director"));
assert.ok(!frontendSource.includes("waiting for input"));
assert.ok(!frontendSource.includes("one-click-panel"));
assert.ok(indexSource.includes("workflowJobId"));
assert.ok(indexSource.includes("buildSkillFirstDirectorReply"));
assert.ok(indexSource.includes("getWorkflowComplianceStatus(workflowJob.id)"));
assert.ok(indexSource.includes("getWorkflowDeliveryStatus(workflowJob.id)"));
assert.ok(indexSource.includes("codex-ppt 负责视觉统一的图片型 PPT"));
assert.ok(guidedActionSource.includes("推荐下一步"));
assert.ok(guidedActionSource.includes("打开图片页任务"));
assert.ok(guidedActionSource.includes("准备 editppt"));
assert.ok(!/(\u93ba\u3128\u5d18|\u93b5\u64b3\u7d11|\u9351\u55d7\ue62c|\u6d93\u5b29\u7af4\u59dd|\u9365\u5267\u5896\u6924|\u9359\ue21c\u7d2a|\u6942\u6a3c\u9a87)/.test(guidedActionSource));
assert.ok(frontendSource.includes("api.planWorkflowOutline"));
assert.ok(!frontendSource.includes('/api/jobs/outline'));
assert.ok(apiClientSource.includes('/api/workflow-outline/plan'));
assert.ok(indexSource.includes('app.post("/api/workflow-outline/plan"'));
assert.ok(!indexSource.includes('app.get("/api/workflow-samples"'));
assert.ok(!apiClientSource.includes("workflowSamples"));
assert.ok(sourceRendererSource.includes("PDFTOPPM_PATH"));
assert.ok(sourceRendererSource.includes("PDFTOPPM_ARGS_PREFIX_JSON"));
assert.ok(sourceRendererSource.includes("pdftoppm"));
assert.ok(sourceRendererSource.includes("pdf-parse"));
assert.ok(sourceRendererSource.includes("renderPdfSourceWithPdfParse"));
assert.ok(sourceRendererSource.includes("page_"));
assert.ok(doctorSource.includes("pdf-renderer"));
assert.ok(doctorSource.includes("PDFTOPPM_PATH"));
assert.ok(doctorSource.includes("PDFTOPPM_ARGS_PREFIX_JSON"));
assert.ok(doctorSource.includes("PDF_PARSE_RENDER_WIDTH"));
assert.ok(doctorSource.includes("nextAction"));
assert.ok(frontendSource.includes('"pdf-renderer"'));
assert.ok(frontendSource.includes("check.nextAction"));
assert.ok(frontendSource.includes("PDF 渲染器"));
assert.ok(doctorSource.includes("image-to-editable-contract"));
assert.ok(doctorSource.includes("image-edit-provider"));
assert.ok(doctorSource.includes("supportsImageEdit"));
assert.ok(frontendSource.includes("参考图重绘"));
assert.ok(workflowEditableSource.includes("inspectEditableSkillContract"));
assert.ok(workflowEditableSource.includes("singlePageLocalMode"));
assert.ok(workflowEditableSource.includes("multiPageWorkerDispatch"));
assert.ok(workflowEditableSource.includes("serialImageEdit"));
assert.ok(workflowEditableSource.includes("noFullSlideFallback"));
assert.ok(frontendSource.includes("image-to-editable-contract"));
assert.ok(workflowWorkerQueueSource.includes("enrichTaskEvidence"));
assert.ok(workflowWorkerQueueSource.includes("validationStatus"));
assert.ok(workflowWorkerQueueSource.includes("statusLabel"));
assert.ok(workflowWorkerQueueSource.includes("validationError"));
assert.ok(workflowWorkerQueueSource.includes("providerSnapshot"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "scripts", "model-page-spec-worker.mjs"), "utf8").includes("provider_snapshot"));
assert.ok(workflowWorkerQueueSource.includes("outputContractOk"));
assert.ok(workflowWorkerQueueSource.includes("outputContractIssues"));
assert.ok(workflowWorkerQueueSource.includes("pagePptxExists"));
assert.ok(workflowWorkerQueueSource.includes("pageResultExists"));
assert.ok(frontendSource.includes("task.statusLabel || workerTaskStatusLabel"));
assert.ok(frontendSource.includes("formatEditableTaskIssue(task)"));
assert.ok(frontendSource.includes("validationLabel"));
assert.ok(frontendSource.includes("v0.3-compatible"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8").includes(".product-doctor-grid em"));
assert.ok(frontendSource.includes("skill-first-review-notice"));
assert.ok(!frontendSource.includes("完成视觉方向和 SceneGraph 重建后"));
assert.ok(frontendSource.includes("WorkflowDeliveryPortal"));
assert.ok(frontendSource.includes("交付文件"));
assert.ok(!frontendSource.includes("双技能交付中心"));
assert.ok(workflowDeliverySource.includes("inspectInvalidatedFinal"));
assert.ok(workflowDeliverySource.includes("已被 fresh editppt 运行作废"));
assert.ok(!frontendSource.includes("旧最终 PPT 已作废"));
assert.ok(frontendSource.includes("GenerationProgress"));
assert.ok(frontendSource.includes("StyleReferenceItem"));
assert.ok(frontendSource.includes("PreviewCanvas"));
assert.ok(frontendSource.includes("editable-draft.pptx"));
assert.ok(frontendSource.includes("isJobBlockedForFinal"));

console.log("smoke tests passed");
