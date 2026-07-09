#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();

async function main() {
  const files = await readProjectFiles();
  const checks = [
    checkReadme(files),
    checkProductGoalCurrent(files),
    checkFrontendMainFlow(files),
    checkFrontendButtonContracts(files),
    checkApiSurface(files),
    checkDeliveryGate(files),
    checkFinalEvidence(files),
    checkMojibakeAuditScope(files)
  ];
  const failed = checks.filter((item) => !item.ok);
  if (failed.length) {
    for (const item of failed) {
      console.error(`[fail] ${item.name}: ${item.reason}`);
    }
    process.exit(1);
  }
  console.log(JSON.stringify({
    ok: true,
    kind: "skill-first-product-boundary-regression",
    checks: checks.map(({ name }) => name)
  }, null, 2));
}

async function readProjectFiles() {
  return {
    readme: await readText("README.md"),
    productGoal: await readText("docs/product-goal.md"),
    currentAgentPlan: await readText("docs/current-agent-plan.md"),
    frontend: await readText("src/main.jsx"),
    styles: await readText("src/styles.css"),
    apiClient: await readText("src/api/client.js"),
    serverIndex: await readText("server/index.js"),
    pptxEditability: await readText("server/pptxEditability.js"),
    workflowDelivery: await readText("server/workflowDelivery.js"),
    workflowNextAction: await readText("server/workflowNextAction.js"),
    workflowEditable: await readText("server/workflowEditable.js"),
    workflowManualReview: await readText("server/workflowManualReview.js"),
    workflowCodexPptSlideBatchRunner: await readText("server/workflowCodexPptSlideBatchRunner.js"),
    workflowVisuals: await readText("server/workflowVisuals.js"),
    workflowProductVisualReadinessRunner: await readText("server/workflowProductVisualReadinessRunner.js"),
    workflowV1Readiness: await readText("server/workflowV1Readiness.js"),
    workflowWorkerBatchRunner: await readText("server/workflowWorkerBatchRunner.js"),
    workflowFinalEvidence: await readText("server/workflowFinalEvidence.js"),
    workflowPageEvidence: await readText("server/workflowPageEvidence.js"),
    workflowArtifacts: await readText("server/workflowArtifacts.js"),
    workflowCostEstimate: await readText("server/workflowCostEstimate.js"),
    providers: await readText("server/providers.js"),
    auditMojibake: await readText("scripts/audit-mojibake.mjs")
  };
}

async function readText(relativePath) {
  return fs.readFile(path.join(root, relativePath), "utf8");
}

function checkReadme(files) {
  return named("README documents product usage", () => {
    mustInclude(files.readme, "Skill-first workflow");
    mustInclude(files.readme, "npm run local");
    mustInclude(files.readme, "/api/workflow-jobs/:id/cost-estimate");
    mustInclude(files.readme, "npm run regression:skill-first");
    mustInclude(files.readme, "产品级 v1 验收");
    mustInclude(files.readme, "acceptance.ready=true");
    mustInclude(files.readme, "必须显式确认外部 API 额度");
    mustNotInclude(files.readme, "workflow-briefs");
  });
}

function checkProductGoal(files) {
  return named("Product goal documents current target", () => {
    mustInclude(files.productGoal, "PPT Agent 产品目标");
    mustInclude(files.productGoal, "codex-ppt");
    mustInclude(files.productGoal, "image-to-editable-ppt");
    mustInclude(files.productGoal, "gpt-image-2");
    mustInclude(files.productGoal, "对话模型");
    mustInclude(files.productGoal, "editable-final.pptx");
    mustInclude(files.productGoal, "acceptance.ready");
    mustInclude(files.productGoal, "draft-final-pptx");
    mustInclude(files.productGoal, "editable-sample-2p-draft.pptx");
    mustInclude(files.productGoal, "final-pptx");
    mustInclude(files.productGoal, "接口应返回 409");
    mustInclude(files.productGoal, "默认先跑 2 页");
    mustInclude(files.productGoal, "人工视觉复核");
    mustNotInclude(files.productGoal, "美学设计系统");
    mustNotInclude(files.productGoal, "旧 PPT 优化重塑");
  });
}

function checkProductGoalV2(files) {
  return named("Product goal documents current target", () => {
    mustInclude(files.productGoal, "PPT Agent 产品目标");
    mustInclude(files.productGoal, "codex-ppt");
    mustInclude(files.productGoal, "image-to-editable-ppt");
    mustInclude(files.productGoal, "gpt-image-2");
    mustInclude(files.productGoal, "paddleocr-local");
    mustInclude(files.productGoal, "rapidocr-local");
    mustInclude(files.productGoal, "editable-final.pptx");
    mustInclude(files.productGoal, "acceptance.ready");
    mustInclude(files.productGoal, "人工视觉复核");
    mustInclude(files.productGoal, "旧模板");
    mustInclude(files.currentAgentPlan, "PPT Agent 当前状态与后续计划");
    mustInclude(files.currentAgentPlan, "draft-final-pptx");
    mustInclude(files.currentAgentPlan, "editable-sample-2p-draft.pptx");
    mustInclude(files.currentAgentPlan, "默认先跑 2 页");
    mustInclude(files.currentAgentPlan, "页面重建模型超时");
    mustInclude(files.currentAgentPlan, "当前是 2/15 页小样本");
    mustNotInclude(files.productGoal, "美学设计系统");
    mustNotInclude(files.productGoal, "旧 PPT 优化重塑");
  });
}

function checkProductGoalCurrent(files) {
  return named("Product goal documents current target", () => {
    mustInclude(files.productGoal, "PPT Agent 产品目标");
    mustInclude(files.productGoal, "codex-ppt");
    mustInclude(files.productGoal, "image-to-editable-ppt");
    mustInclude(files.productGoal, "gpt-image-2");
    mustInclude(files.productGoal, "paddleocr-local");
    mustInclude(files.productGoal, "rapidocr-local");
    mustInclude(files.productGoal, "editable-final.pptx");
    mustInclude(files.productGoal, "acceptance.ready");
    mustInclude(files.productGoal, "人工视觉复核");
    mustInclude(files.productGoal, "旧模板");
    mustInclude(files.productGoal, "当前已完成：20/20 页 `codex-ppt` 图片型页面和图片型 PPT");
    mustInclude(files.productGoal, "当前已跑通：2/20 页 `image-to-editable-ppt / editppt` 可编辑重建小样本");
    mustInclude(files.productGoal, "当前交付状态：blocked，不是完整产品交付");
    mustInclude(files.productGoal, "剩余 18 页需要继续跑真实 `image-to-editable-ppt / editppt` 页面 worker");
    mustInclude(files.productGoal, "当前待重建页集：`page_001,page_002,page_005-page_020`");
    mustInclude(files.productGoal, "当前完整页面证据页：`page_003,page_004`");
    mustInclude(files.productGoal, "当前 2 页 final 是旧小样本结果，不等于当前已记录页面证据页");
    mustInclude(files.productGoal, "继续生成剩余 18 页");
    mustInclude(files.currentAgentPlan, "PPT Agent 当前状态与后续计划");
    mustInclude(files.currentAgentPlan, "当前交付状态：blocked，完整产品交付未完成");
    mustInclude(files.currentAgentPlan, "当前下一步：继续剩余 18 页 `image-to-editable-ppt / editppt` 页面重建");
    mustInclude(files.currentAgentPlan, "当前待重建页集：`page_001,page_002,page_005-page_020`");
    mustInclude(files.currentAgentPlan, "当前完整页面证据页：`page_003,page_004`");
    mustInclude(files.currentAgentPlan, "这不是完整 20 页产品级交付");
    mustNotInclude(files.productGoal, "美学设计系统");
    mustNotInclude(files.productGoal, "旧 PPT 优化重塑");
  });
}

function checkFrontendMainFlow(files) {
  return named("Frontend keeps Skill-first main flow", () => {
    mustInclude(files.frontend, "startSkillFirstWorkflow");
    mustInclude(files.frontend, "workflowDeliveryStatus");
    mustInclude(files.frontend, "WorkflowPageVisualReviewWorkbench");
    mustInclude(files.frontend, "workflow-review-modal");
    mustInclude(files.frontend, "逐页对比：原始页、图片版、可编辑页");
    mustInclude(files.frontend, "全部通过，记录复核");
    mustNotInclude(files.frontend, "WorkflowStrip");
    mustNotInclude(files.frontend, "workflow-strip");
    mustNotInclude(files.styles, "workflow-strip");
    mustNotInclude(files.frontend, "WorkflowPartialFinalNextPanel");
    mustNotInclude(files.frontend, "继续剩余");
    mustNotInclude(files.frontend, "确认人工复核通过");
    mustNotInclude(files.frontend, "标记复核通过");
    mustNotInclude(files.frontend, "WorkflowArtifactReviewPanel");
    mustNotInclude(files.frontend, "workflow-artifact-review-panel");
    mustNotInclude(files.frontend, "workflow-review-panel");
    mustNotInclude(files.frontend, "buildWorkflowReviewRows");
    mustInclude(files.frontend, "approveWorkflowManualReview");
    mustInclude(files.frontend, "getFinalDownloadState");
    mustInclude(files.frontend, "当前测试范围已通过阻断门禁");
    mustInclude(files.frontend, "可编辑 PPT 已可交付");
    mustInclude(files.frontend, "原始页");
    mustInclude(files.frontend, "图片版");
    mustInclude(files.frontend, "可编辑页");
    mustInclude(files.frontend, "rendered-page");
    mustInclude(files.frontend, "visual-page");
    mustInclude(files.frontend, "rebuild-preview");
    mustNotInclude(files.frontend, "WorkflowManualReviewSummary");
    mustInclude(files.frontend, "本次只记录当前小样本复核");
    mustInclude(files.frontend, "复核范围");
    mustInclude(files.frontend, "完整产品交付仍需要跑完全部页面并重新复核");
    mustNotInclude(files.frontend, "WorkflowFinalVisualQa");
    mustNotInclude(files.frontend, "WorkflowFinalGate");
    mustNotInclude(files.frontend, "WorkflowDeliveryArtifactLink");
    mustInclude(files.frontend, "可选参考图（非模板）");
    mustInclude(files.styles, "workflow-page-review-workbench");
    mustNotInclude(files.styles, "workflow-delivery-link.downloadable");
    mustInclude(files.frontend, "gpt-image-2");
    mustNotInclude(files.frontend, "设计方向控制台");
    mustNotInclude(files.frontend, "模板 / 版式方向");
    mustNotInclude(files.frontend, "WorkflowSampleLibraryPanel");
    mustNotInclude(files.frontend, "workflow-sample-library");
  });
}

function checkFrontendButtonContracts(files) {
  return named("Frontend buttons keep actionable contracts", () => {
    mustInclude(files.frontend, "setTaskFilter(id)");
    mustInclude(files.frontend, "setTaskSearch(event.target.value)");
    mustInclude(files.frontend, "setCreateOpen(true)");
    mustInclude(files.frontend, "handleArchiveTask(event, item)");
    mustInclude(files.frontend, "onConfirm={askUserConfirm}");
    mustInclude(files.frontend, "onArchiveJob={toggleWorkflowArchive}");
    mustInclude(files.frontend, "onArchivedVisibilityChange={setWorkflowArchiveVisibility}");
    mustInclude(files.frontend, "onRouteAAction={runRouteAAction}");
    mustInclude(files.frontend, "onRouteBAction={runRouteBAction}");
    mustInclude(files.frontend, "onDeliveryModeChange={setPendingDeliveryMode}");
    mustInclude(files.frontend, "onOpenSampleReview={openSampleReviewPanel}");
    mustInclude(files.frontend, "onOpenImageDeckReview={openImageDeckReviewPanel}");
    mustInclude(files.frontend, "onCreateWorkflow?.({ deliveryMode: selectedDeliveryMode })");
  });
}

function checkApiSurface(files) {
  return named("API exposes product workflow controls", () => {
    mustInclude(files.apiClient, "workflowDeliveryStatus");
    mustInclude(files.apiClient, "workflowCostEstimate");
    mustInclude(files.apiClient, "latestV1Acceptance");
    mustInclude(files.serverIndex, "primaryWorkflowState");
    mustInclude(files.serverIndex, "primaryJobId");
    mustInclude(files.serverIndex, "recordedEditablePages");
    mustInclude(files.serverIndex, "workflowRecordedEditablePageCount");
    mustInclude(files.serverIndex, "/api/workflow-jobs/:id/delivery-status");
    mustInclude(files.serverIndex, "/api/workflow-jobs/:id/cost-estimate");
    mustInclude(files.serverIndex, "/api/v1-acceptance/product-visual-sample/prompt-preview");
    mustInclude(files.serverIndex, "/api/v1-acceptance/product-visual-full-deck/approval/approve");
    mustInclude(files.serverIndex, "/api/workflow-jobs/:id/editable/finalize");
    mustInclude(files.apiClient, "finalizeWorkflowEditableRun");
    mustNotInclude(files.frontend, "WorkflowEditableFinalizeAction");
    mustInclude(files.frontend, "recomposeEditableFinal");
    mustInclude(files.frontend, "allowPartialSample: isPartial");
    mustInclude(files.frontend, "不消耗外部额度");
    mustInclude(files.frontend, "重新合成最终可编辑 PPT");
    mustInclude(files.workflowArtifacts, "draft-final-pptx");
    mustInclude(files.workflowArtifacts, "assertDraftFinalPptxDownloadable");
    mustInclude(files.frontend, "小样本草稿");
    mustNotInclude(files.styles, ".workflow-editable-finalize-action");
    mustInclude(files.frontend, "deliveryWorkerBatchSize");
    mustInclude(files.frontend, "deliverySelectedWorkerPageIds");
    mustNotInclude(files.frontend, "默认本批");
    mustInclude(files.frontend, "成功页不会被覆盖");
    mustInclude(files.frontend, "latestDeliveryRun");
    mustNotInclude(files.frontend, "WorkflowAgentWorkerRunStatusClean");
    mustInclude(files.frontend, "当前主验收任务");
    mustInclude(files.frontend, "非主验收任务");
    mustInclude(files.frontend, "已完成可编辑页");
    mustInclude(files.frontend, "当前 final");
    mustInclude(files.frontend, "workflow-primary-badge");
    mustInclude(files.frontend, "开始人工复核");
    mustInclude(files.frontend, "只显示最终交付状态");
    mustInclude(files.frontend, "需要人工确认时再展开复核界面");
    mustInclude(files.frontend, "所有交付检查都已通过");
    mustInclude(files.frontend, "这里只看能不能交付");
    mustInclude(files.frontend, "开始人工复核");
    mustNotInclude(files.frontend, "WorkflowPlainAgentDashboardClean");
    mustNotInclude(files.frontend, "WorkflowEditableFailureRecoveryCard");
    mustNotInclude(files.frontend, "双技能交付中心");
    mustNotInclude(files.frontend, "PPT Agent 正在处理");
    mustInclude(files.styles, ".workflow-primary-badge");
    mustInclude(files.frontend, "resetLatestFailurePages");
    mustInclude(files.frontend, "resetLatestDeliveryFailurePages");
    mustInclude(files.frontend, "workflowWorkerTaskAction(job.id, pageId, \"reset\"");
    mustNotInclude(files.frontend, "最近失败恢复");
    mustNotInclude(files.frontend, "低复杂度模式");
    mustNotInclude(files.frontend, "重跑后合成");
    mustNotInclude(files.frontend, "重置失败页");
    mustNotInclude(files.frontend, "4. 重新合成 final");
    mustNotInclude(files.frontend, "不适用：图片 API 过载");
    mustNotInclude(files.frontend, "Skill 路径等待检查");
    mustNotInclude(files.frontend, "codex-ppt 到可编辑 PPT");
    mustNotInclude(files.frontend, "image-to-editable-ppt 可编辑页");
    mustNotInclude(files.frontend, "对当前单页运行 image-to-editable-ppt");
    mustInclude(files.frontend, "上次失败原因是图片生成服务过载");
    mustInclude(files.frontend, "externalImageCallBudget");
    mustInclude(files.frontend, "confirmExternalImageSpend: true");
    mustInclude(files.frontend, "本批预计最多使用");
    mustNotInclude(files.frontend, "成功页会保留，失败页后续单独重跑");
    mustInclude(files.styles, ".workflow-editable-failure-flow");
    mustInclude(files.workflowWorkerBatchRunner, "buildRunnerRecoveryPlan");
    mustInclude(files.workflowWorkerBatchRunner, "preserveSuccessfulPages");
    mustInclude(files.workflowWorkerBatchRunner, "lowComplexityRecommended");
    mustInclude(files.workflowWorkerBatchRunner, "imageProviderRetryRecommended");
    mustInclude(files.workflowWorkerBatchRunner, "autoFinalize");
    mustInclude(files.workflowDelivery, "buildBlockedGateEditableBatchPlan");
    mustInclude(files.workflowDelivery, "defaultBatchPages");
    mustInclude(files.workflowDelivery, "preserveSuccessfulPages");
    mustInclude(files.workflowDelivery, "requiresExplicitConfirmation");
    mustInclude(files.workflowDelivery, "默认先跑 2 页");
    mustInclude(files.workflowDelivery, "batchPlan");
    mustInclude(files.workflowDelivery, "externalImageCallsPerPage");
    mustInclude(files.workflowDelivery, "defaultBatchExternalImageCalls");
    mustInclude(files.workflowDelivery, "whyBatch");
    mustInclude(files.workflowDelivery, "pageSelection");
    mustInclude(files.workflowCodexPptSlideBatchRunner, "confirmedExternalImageSpend");
    mustInclude(files.workflowCodexPptSlideBatchRunner, "confirmExternalImageSpend: confirmedExternalImageSpend");
    mustInclude(files.workflowCodexPptSlideBatchRunner, "editImageWithProvider");
    mustInclude(files.workflowCodexPptSlideBatchRunner, "sourceImagePath");
    mustInclude(files.workflowVisuals, "buildCodexPptStyleLock");
    mustInclude(files.workflowVisuals, "STYLE LOCK: all slides must share one visual identity.");
    mustInclude(files.workflowVisuals, "styleReferenceImages");
    mustInclude(files.workflowVisuals, "referenceImagePaths: styleLock.referenceImages");
    mustInclude(files.workflowVisuals, "buildDeckStyleConsistencyReport");
    mustInclude(files.workflowVisuals, "Deck-level pixel consistency QA");
    mustInclude(files.frontend, "风格一致性");
    mustInclude(files.workflowProductVisualReadinessRunner, "styleLock");
    mustInclude(files.workflowProductVisualReadinessRunner, "风格锁");
    mustInclude(files.providers, "referenceImagePaths");
    mustInclude(files.providers, "source-page-edit-plus-style-reference");
    mustInclude(files.frontend, "确认方案");
    mustInclude(files.frontend, "确认样张");
    mustInclude(files.frontend, "后台生成");
    mustInclude(files.frontend, "不需要用户操作的步骤会在后台处理");
    mustNotInclude(files.frontend, "先按 codex-ppt skill 完成 6 步");
    mustNotInclude(files.frontend, "样张已确认，图片版正在后台生成和组装。");
    mustNotInclude(files.frontend, "后续图片页生成、检查和组装在后台完成");
    mustNotInclude(files.frontend, "图片页已检查并组装");
    mustNotInclude(files.frontend, "正在生成、检查和组装");
  });
}

function checkDeliveryGate(files) {
  return named("Delivery gate blocks unsafe finals", () => {
    mustInclude(files.workflowDelivery, "manualReviewRecorded");
    mustInclude(files.workflowManualReview, "scope");
    mustInclude(files.workflowManualReview, "partialSourceCoverage");
    mustInclude(files.workflowManualReview, "sourcePages");
    mustInclude(files.workflowManualReview, "finalPages");
    mustInclude(files.workflowDelivery, "powerPointOpenable");
    mustInclude(files.workflowDelivery, "rasterOnlySlides");
    mustInclude(files.workflowDelivery, "rasterBackgroundSlides");
    mustInclude(files.workflowDelivery, "noFullSlideRaster");
    mustInclude(files.workflowDelivery, "finalEvidenceComplete");
    mustInclude(files.workflowDelivery, "partialSourceCoverage");
    mustInclude(files.workflowDelivery, "fullSourceCoverage");
    mustInclude(files.workflowDelivery, "isFullDeliveryCoverageCandidate");
    mustInclude(files.workflowDelivery, "skipPowerPointOpenability");
    mustInclude(files.workflowPageEvidence, "page-pptx-openability-skipped");
    mustInclude(files.workflowPageEvidence, "powerpoint-open-check-skipped-until-full-delivery");
    mustInclude(files.workflowDelivery, "不能作为完整产品交付");
    mustInclude(files.workflowDelivery, "final-visual-qa-needs-review");
    mustInclude(files.workflowV1Readiness, "suppressResolvedWorkerBatchFailure");
    mustInclude(files.workflowV1Readiness, "supersededByCurrentEvidence");
    mustInclude(files.workflowV1Readiness, "current-editable-evidence-complete");
    mustInclude(files.workflowArtifacts, "blockedReason");
    mustInclude(files.workflowArtifacts, "nextAction");
    mustInclude(files.workflowArtifacts, "final-pptx");
    mustInclude(files.workflowArtifacts, "final-compare");
    mustInclude(files.workflowWorkerBatchRunner, "pageSpecProviderProbe");
    mustInclude(files.workflowWorkerBatchRunner, "inspectPersistedPageSpecProviderProbe");
    mustInclude(files.workflowWorkerBatchRunner, "selectPageForProviderProbe");
    mustInclude(files.workflowWorkerBatchRunner, "probeTaskBundle");
    mustInclude(files.workflowWorkerBatchRunner, "检测页面重建模型");
    mustInclude(files.workflowWorkerBatchRunner, "图片输入、JSON 输出和非空响应");
    mustInclude(files.workflowEditable, "getEditablePrepareInputs(job, options)");
    mustInclude(files.workflowEditable, "options.pages || options.pageIds || options.pageId");
    mustInclude(files.providers, "plain-json-fallback");
    mustInclude(files.providers, "parsed.ok === true");
    mustInclude(files.workflowNextAction, "partial-final-review-or-continue");
    mustInclude(files.workflowNextAction, "review-current-sample");
    mustInclude(files.workflowNextAction, "continue-remaining-pages");
    mustInclude(files.pptxEditability, "rasterOnly");
    mustInclude(files.pptxEditability, "rasterBackground");
    mustInclude(files.pptxEditability, "full-slide-background-picture");
  });
}

function checkFinalEvidence(files) {
  return named("Final evidence checks visual QA", () => {
    mustInclude(files.workflowFinalEvidence, "inspectFinalVisualQuality");
    mustInclude(files.workflowFinalEvidence, "visualQa");
    mustInclude(files.workflowFinalEvidence, "blockingIssues");
    mustInclude(files.workflowFinalEvidence, "manualReviewCurrent");
    mustInclude(files.workflowFinalEvidence, "previewToTargetBytes");
    mustInclude(files.workflowFinalEvidence, "foregroundAssetIssues");
    mustInclude(files.workflowFinalEvidence, "jobPageIds.length");
  });
}

function checkMojibakeAuditScope(files) {
  return named("Mojibake audit protects user-facing files", () => {
    mustInclude(files.auditMojibake, "README.md");
    mustInclude(files.auditMojibake, "docs/product-goal.md");
    mustInclude(files.auditMojibake, "docs/current-agent-plan.md");
    mustInclude(files.auditMojibake, "server/index.js");
    mustInclude(files.auditMojibake, "src");
    mustNotInclude(files.auditMojibake, "scripts/skill-first-regression.mjs");
  });
}

function named(name, fn) {
  try {
    fn();
    return { name, ok: true };
  } catch (error) {
    return { name, ok: false, reason: error.message };
  }
}

function mustInclude(source, text) {
  if (!source.includes(text)) throw new Error(`missing ${JSON.stringify(text)}`);
}

function mustNotInclude(source, text) {
  if (source.includes(text)) throw new Error(`unexpected ${JSON.stringify(text)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
