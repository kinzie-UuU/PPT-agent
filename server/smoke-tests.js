import assert from "node:assert/strict";
import { getDesignSystem, getTemplatePack, getTemplatePackPrompt } from "./designSystem.js";
import { buildMaterialBrief } from "./materialBrief.js";
import { routeDeck } from "./deckRouter.js";
import { validateDeck } from "./validateDeck.js";

const designSystem = getDesignSystem();
assert.equal(designSystem.templatePacks.length, 5);
assert.equal(getTemplatePack("东方自然风").slug, "seasonal-gift");
assert.ok(getTemplatePackPrompt("蓝白科技风").includes("技术方案 / 数据汇报模板"));

const brief = buildMaterialBrief([
  {
    name: "输入说明",
    text: "端午礼盒售价 39元、59元、159元。主推低糖粽礼盒和高端滋补礼盒，规格 300x200x80mm。适合员工福利、客户拜访、节日礼赠。"
  }
]);

assert.deepEqual(brief.prices.slice(0, 3), ["39元", "59元", "159元"]);
assert.ok(brief.productCandidates.includes("低糖粽礼盒"));
assert.ok(brief.productCandidates.includes("高端滋补礼盒"));
assert.deepEqual(brief.dimensions, ["300x200x80mm"]);
assert.equal(brief.inputStrength, "strong");

const weakBrief = buildMaterialBrief([
  { name: "礼盒主图.png", text: "图片素材已上传：礼盒主图.png。生成时请为其预留图片槽位。" },
  { name: "输入说明", text: "项目名称：端午礼盒\n补充说明：做一份给销售团队用的产品战卡。" }
]);
assert.equal(weakBrief.inputStrength, "weak");
assert.equal(weakBrief.imageCount, 1);
assert.ok(weakBrief.confirmationFields.includes("价格/报价/预算档位"));
const weakRoute = routeDeck({ input: { pageCount: "系统推荐" }, materialBrief: weakBrief, uploads: [{ originalName: "礼盒主图.png", mimeType: "image/png" }] });
assert.equal(weakRoute.inputStrength, "weak");
assert.ok(weakRoute.layoutSequence.some((step) => step.layout === "visual"));
assert.ok(weakRoute.layoutSequence.some((step) => step.storyRole === "待确认信息"));
const giftRoute = routeDeck({ input: { pageCount: "系统推荐", style: "东方自然风" }, materialBrief: weakBrief, uploads: [{ originalName: "礼盒主图.png", mimeType: "image/png" }] });
assert.equal(giftRoute.templatePack.slug, "seasonal-gift");
assert.equal(giftRoute.layoutSequence[1].layout, "visual");

const techRoute = routeDeck({ input: { pageCount: "12 页标准版", style: "蓝白科技风", notes: "技术方案 数据汇报 KPI 分析" }, materialBrief: brief, uploads: [] });
assert.equal(techRoute.templatePack.slug, "tech-solution");
assert.ok(techRoute.layoutSequence.slice(0, 5).some((step) => step.layout === "kpi"));

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
const oldDeckRoute = routeDeck({ mode: "optimize", input: { pageCount: "系统推荐" }, materialBrief: oldDeckBrief, uploads: [{ originalName: "case.pptx" }] });
assert.equal(oldDeckRoute.sourceReport.aestheticDiagnosis.overallScore, 60);
assert.ok(oldDeckRoute.layoutSequence.some((step) => step.sourceSlideType === "product_cost" && step.layout === "pricing"));
assert.ok(oldDeckRoute.layoutSequence.some((step) => step.sourceSlideType === "project_review" && step.layout === "risk-checklist"));

const emptyBrief = buildMaterialBrief([{ name: "输入说明", text: "项目名称：新品发布" }]);
assert.equal(emptyBrief.inputStrength, "empty");
assert.ok(emptyBrief.confirmationFields.length >= 3);

const validated = validateDeck({
  title: "字符串字段兼容测试",
  slides: [
    {
      title: "封面",
      layout: "cover",
      bullets: "39元；59元；159元",
      dataPoints: "39元\n59元\n159元",
      imageSlots: ""
    },
    {
      title: "价格页",
      layout: "pricing",
      bullets: "39元：入门预算；59元：主推档位；159元：升级档位",
      dataPoints: "39元\n59元\n159元",
      imageSlots: ""
    }
  ]
});

assert.equal(validated.deck.slides[1].layout, "closing");
assert.deepEqual(validated.deck.slides[0].bullets, ["39元", "59元"]);
assert.deepEqual(validated.deck.slides[1].dataPoints, ["39元", "59元", "159元"]);

console.log("smoke tests passed");
