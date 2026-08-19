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
    checkFrontendV2Workspace(files),
    checkFrontendButtonContracts(files),
    checkApiSurface(files),
    checkSkillRuntimeRoots(files),
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
    upstreamSkillContract: await readText("docs/upstream-skill-contract.md"),
    currentAgentPlan: await readText("docs/current-agent-plan.md"),
    frontend: await readText("src/main.jsx"),
    styles: await readText("src/styles.css"),
    uiV2: await readText("src/ui-v2/PptAgentWorkspace.jsx"),
    uiV2Styles: await readText("src/ui-v2/PptAgentWorkspace.module.css"),
    apiClient: await readText("src/api/client.js"),
    serverIndex: await readText("server/index.js"),
    doctor: await readText("server/doctor.js"),
    pptxEditability: await readText("server/pptxEditability.js"),
    workflowDelivery: await readText("server/workflowDelivery.js"),
    workflowNextAction: await readText("server/workflowNextAction.js"),
    workflowEditable: await readText("server/workflowEditable.js"),
    workflowImageDeckReview: await readText("server/workflowImageDeckReview.js"),
    workflowManualReview: await readText("server/workflowManualReview.js"),
    workflowCodexPptSlideBatchRunner: await readText("server/workflowCodexPptSlideBatchRunner.js"),
    workflowCodexPptRunState: await readText("server/workflowCodexPptRunState.js"),
    workflowVisuals: await readText("server/workflowVisuals.js"),
    workflowStyleConsistency: await readText("server/workflowStyleConsistency.js"),
    workflowProductVisualReadinessRunner: await readText("server/workflowProductVisualReadinessRunner.js"),
    workflowApprovals: await readText("server/workflowApprovals.js"),
    workflowV1Readiness: await readText("server/workflowV1Readiness.js"),
    workflowWorkerBatchRunner: await readText("server/workflowWorkerBatchRunner.js"),
    workflowFinalEvidence: await readText("server/workflowFinalEvidence.js"),
    workflowPageEvidence: await readText("server/workflowPageEvidence.js"),
    workflowJobs: await readText("server/workflowJobs.js"),
    workflowVisibility: await readText("shared/workflowVisibility.js"),
    workflowSelectionGuard: await readText("src/workflow/workflowSelectionGuard.js"),
    workflowArtifacts: await readText("server/workflowArtifacts.js"),
    workflowCostEstimate: await readText("server/workflowCostEstimate.js"),
    workflowBusinessReadiness: await readText("server/workflowBusinessReadiness.js"),
    providers: await readText("server/providers.js"),
    pageRebuildAssembler: await readText("scripts/page-rebuild-assembler.mjs"),
    visualAssetHelper: await readText("scripts/visual-asset-helper.mjs"),
    modelPageSpecWorker: await readText("scripts/model-page-spec-worker.mjs"),
    strictUiPlaywright: await readText("scripts/strict-ui-e2e.playwright.js"),
    auditMojibake: await readText("scripts/audit-mojibake.mjs")
  };
}

function checkSkillRuntimeRoots(files) {
  return named("Editable runtime prefers the canonical .agents skill", () => {
    mustInclude(files.upstreamSkillContract, "PPT Agent 以以下两个官方仓库为核心实现基础");
    mustInclude(files.upstreamSkillContract, "不得复制一套本地生成逻辑替代");
    mustInclude(files.upstreamSkillContract, "v0.5.5");
    mustInclude(files.upstreamSkillContract, "v0.3.2");
    mustInclude(files.readme, ".agents\\skills\\image-to-editable-ppt");
    mustInclude(files.workflowEditable, '".agents", "skills", "image-to-editable-ppt"');
    mustInclude(files.workflowEditable, '"v0.3.2-compatible"');
    mustInclude(files.workflowEditable, "jobScopedAssetSheets");
    mustInclude(files.serverIndex, "/api/doctor");
    mustInclude(files.doctor, '"codex-ppt-contract"');
    mustInclude(files.doctor, '"v0.5.5-compatible"');
    mustInclude(files.pageRebuildAssembler, '".agents", "skills", "image-to-editable-ppt"');
    mustInclude(files.visualAssetHelper, '".agents", "skills", "image-to-editable-ppt"');
    mustInclude(files.visualAssetHelper, "runEditpptImageJobs");
    mustInclude(files.visualAssetHelper, "detectEditpptImageBackend");
    mustInclude(files.visualAssetHelper, "refusing to guess provenance");
    mustInclude(files.visualAssetHelper, "has no producing-backend provenance");
    mustNotInclude(files.visualAssetHelper, "editImageWithProvider");
    mustNotInclude(files.visualAssetHelper, "generateImageWithProvider");
    mustNotInclude(files.visualAssetHelper, ".editppt-api-backend-only");
  });
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
    mustInclude(files.frontend, "当前只可作为草稿检查；正式可编辑 PPT 需要全部页面复核通过后才能下载。");
    mustNotInclude(files.frontend, "当前测试范围已通过阻断门禁");
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

function checkFrontendV2Workspace(files) {
  return named("Frontend exposes the V2 Agent workspace", () => {
    mustInclude(files.frontend, "PptAgentWorkspace");
    mustInclude(files.frontend, "outlinePlan = null");
    mustInclude(files.frontend, "outlinePlan={outlinePlan}");
    mustInclude(files.frontend, 'setPreviewMode("visual")');
    mustInclude(files.frontend, 'import { isInternalWorkflowJob } from "../shared/workflowVisibility.js"');
    mustNotInclude(files.frontend, "function isInternalWorkflowJob(job = {})");
    mustInclude(files.workflowVisibility, 'if (visibility === "public") return false;');
    mustInclude(files.workflowVisibility, "INTERNAL_WORKFLOW_PATTERN.test(text)");
    mustInclude(files.frontend, "api.workflowDeliveryStatus(id, controller.signal)");
    mustInclude(files.frontend, "projectName: getEffectiveProjectName(form, files)");
    mustInclude(files.frontend, "function workflowTaskTitle(job = null)");
    mustInclude(files.frontend, "|| job?.input?.projectName");
    mustInclude(files.strictUiPlaywright, "await readySearch.fill(readyTitle)");
    mustInclude(files.frontend, "onLoadMoreJobs={loadMoreWorkflowJobs}");
    mustInclude(files.frontend, "buildDualRouteState(job, deliveryBundle)");
    mustInclude(files.frontend, "deliveryBundle?.jobId === job?.id ? deliveryBundle : null");
    mustInclude(files.frontend, 'state.routeB.deliverableReady\n    ? "complete"');
    mustInclude(files.frontend, 'deliverableReady\n    ? "可编辑 PPT 已通过交付门禁，可直接下载。"');
    mustInclude(files.serverIndex, "projectName: req.body?.projectName || \"\"");
    mustInclude(files.workflowJobs, "projectName: cleanString(input.projectName || \"\")");
    mustInclude(files.workflowJobs, "WORKFLOW_LIST_CACHE_TTL_MS");
    mustInclude(files.workflowJobs, 'visibility: cleanString(input.visibility || "")');
    mustInclude(files.serverIndex, "const pagedSummaries = jobs.slice(offset, offset + limit)");
    mustInclude(files.serverIndex, "readWorkflowJobsByIds(pagedSummaries.map((job) => job.id))");
    mustInclude(files.workflowJobs, "export async function listWorkflowJobSummaries");
    mustInclude(files.workflowJobs, "WORKFLOW_LIST_READ_CONCURRENCY");
    mustInclude(files.workflowJobs, "refreshWorkflowListCacheSingleFlight");
    mustInclude(files.workflowJobs, "startedRevision === workflowListCacheRevision");
    mustInclude(files.workflowJobs, "cached?.fingerprint === fingerprint");
    mustInclude(files.serverIndex, 'import { isInternalWorkflowJob } from "../shared/workflowVisibility.js"');
    mustNotInclude(files.serverIndex, "function isInternalWorkflowJob(job = {})");
    mustInclude(files.workflowSelectionGuard, "export function mergeWorkflowJobPage");
    mustInclude(files.frontend, "activeJob: activeCandidate && isUserWorkflowJob(activeCandidate) ? activeCandidate : null");
    mustInclude(files.workflowFinalEvidence, "!cached.finalSha256 || cached.finalSha256 !== finalHash");
    mustInclude(files.frontend, "onPlanOutline={() => planOutline(null, { stayInWorkspace: true })}\n              onOpenDelivery={openDeliveryReviewPanel}\n              onOpenEditableReview={openEditableReviewPanel}");
    mustInclude(files.frontend, 'React.lazy(() => import("./ui-v2/PptAgentWorkspace.jsx")');
    mustInclude(files.frontend, "<React.Suspense");
    mustNotInclude(files.frontend, 'import { PptAgentWorkspace } from "./ui-v2/PptAgentWorkspace.jsx"');
    mustInclude(files.frontend, 'get("ui") === "legacy"');
    mustInclude(files.frontend, "<AgentFlowPanel");
    mustInclude(files.frontend, "<AgentPreviewPanel");
    mustInclude(files.frontend, 'className="outline-sequence-summary"');
    mustInclude(files.frontend, "outlineEditingIndex === index");
    mustInclude(files.frontend, "invalidateOutlineDraft()");
    mustInclude(files.frontend, "openOutlineStep(index)");
    mustInclude(files.frontend, "outlineBusy || workflowBusy");
    mustInclude(files.frontend, "intakeRevisionRef.current");
    mustInclude(files.frontend, "stayInWorkspace: true");
    mustInclude(files.frontend, "editableWorkerRunBundle?.jobId === job?.id");
    mustInclude(files.frontend, "expectedPages > 0 && finalPages === expectedPages");
    mustInclude(files.frontend, "先看整套内容是否顺畅");
    mustNotInclude(files.frontend, 'className="outline-card-item"');
    mustInclude(files.frontend, "errorMessage: error");
    mustInclude(files.frontend, "statusMessage: status");
    mustInclude(files.frontend, 'itemBucket === "failed" ? "失败"');
    mustInclude(files.uiV2, 'data-ui-version="2"');
    mustInclude(files.uiV2, "ppt-agent-v2");
    mustInclude(files.uiV2, "PPT 页面预览");
    mustInclude(files.uiV2, "Agent 工作流");
    mustInclude(files.uiV2, "高级详情");
    mustInclude(files.uiV2, 'role="alert"');
    mustInclude(files.uiV2, 'loading="lazy"');
    mustInclude(files.uiV2, "create.inputLocked");
    mustInclude(files.uiV2, 'aria-label="大纲摘要"');
    mustInclude(files.uiV2Styles, "@media (max-width: 1280px)");
    mustInclude(files.uiV2Styles, "@media (max-width: 560px)");
    mustInclude(files.uiV2Styles, ".taskList { display: flex; }");
    mustInclude(files.styles, ".workspace-shell:has(.ppt-agent-v2)");
  });
}

function checkFrontendButtonContracts(files) {
  return named("Frontend buttons keep actionable contracts", () => {
    mustInclude(files.frontend, "setTaskFilter(id)");
    mustInclude(files.frontend, "setTaskSearch(event.target.value)");
    mustInclude(files.frontend, "setCreateOpen(true)");
    mustInclude(files.frontend, "handleArchiveTask(event, item)");
    const uploadFlow = files.frontend.slice(
      files.frontend.indexOf("async function uploadFiles(event)"),
      files.frontend.indexOf("async function removeUploadedFile(file)")
    );
    mustNotInclude(uploadFlow, "currentJob");
    mustInclude(files.frontend, "const routeBStarted = Boolean(");
    mustInclude(files.frontend, 'if (routeBStarted && state.routeB.status !== "ready") return "running";');
    mustInclude(files.frontend, "onConfirm={askUserConfirm}");
    mustInclude(files.frontend, 'return "准备 1 页样张"');
    mustInclude(files.frontend, '"等待方案确认"');
    mustNotInclude(files.frontend, 'requestedBy: "frontend-route-a-source-text"');
    mustInclude(files.serverIndex, 'requestedBy: "visual-sample-source-ocr"');
    mustInclude(files.serverIndex, "const sampleOptions = { ...body, pageNumber: samplePageNumber }");
    mustInclude(files.uiV2, 'preview.emptyTitle || "页面将在这里生成"');
    mustInclude(files.uiV2, "disabled={taskList.busy}");
    const routeAFlow = files.frontend.slice(
      files.frontend.indexOf("async function runRouteAAction()"),
      files.frontend.indexOf("async function runRouteBAction()")
    );
    const assetStep = routeAFlow.indexOf("recordCodexPptInformationAssets");
    const sampleConfirm = routeAFlow.indexOf('title: "生成 1 页样张"');
    const sampleCall = routeAFlow.indexOf('workflowAction(currentJob.id, "visual/sample"');
    if (!(assetStep >= 0 && assetStep < sampleConfirm && sampleConfirm < sampleCall)) {
      throw new Error("sample preparation must run asset analysis before user confirmation and the visual API call");
    }
    if (routeAFlow.slice(assetStep, sampleConfirm).includes("return;")) {
      throw new Error("sample preparation must not stop between free asset analysis and the sample confirmation");
    }
    mustInclude(files.frontend, "onArchiveJob={toggleWorkflowArchive}");
    mustInclude(files.frontend, "onArchivedVisibilityChange={setWorkflowArchiveVisibility}");
    mustInclude(files.frontend, "onRouteAAction={runRouteAAction}");
    mustInclude(files.frontend, "onRouteBAction={runRouteBAction}");
    mustInclude(files.frontend, "确认开始路线 B");
    mustInclude(files.frontend, "confirmRouteBStartIfNeeded");
    mustInclude(files.frontend, "needsRouteBConfirmation");
    mustInclude(files.frontend, "workflowNextActionPreflight(workflowJob.id, body)");
    mustInclude(files.frontend, "frontend-route-b-local-setup");
    mustInclude(files.frontend, "api.syncWorkflowWorkerTasks(workflowJob.id)");
    mustInclude(files.frontend, "api.buildWorkflowWorkerBriefs(workflowJob.id");
    mustInclude(files.frontend, "api.probeWorkflowPageSpecProvider(workflowJob.id");
    mustInclude(files.frontend, "workflowJob?.artifacts?.editableWorkerBatchRuns");
    mustInclude(files.frontend, 'run?.status === "running"');
    mustInclude(files.frontend, "api.workflowWorkerBatchPreflight(workflowJob.id");
    mustInclude(files.frontend, "api.startWorkflowWorkerBatch(workflowJob.id");
    mustInclude(files.frontend, "开始生成 ${state.routeB.readyEditablePages} 页可编辑 PPT");
    mustInclude(files.frontend, "confirmRouteB: true");
    mustInclude(files.frontend, "job?.artifacts?.editableWorkerTasks?.tasks");
    mustInclude(files.frontend, "job?.artifacts?.editableWorkerTasks");
    mustInclude(files.frontend, "可编辑版确认");
    mustInclude(files.frontend, "后台准备 editppt、文字识别和页面任务");
    mustInclude(files.frontend, "不需要用户操作的步骤会在后台处理；需要确认时才会弹窗。");
    mustInclude(files.frontend, "正式可编辑 PPT 需要全部页面复核通过后才能下载。");
    if (!(files.frontend.indexOf("if (finalGate.productReady)") < files.frontend.indexOf("if (finalGate.downloadable)"))) {
      throw new Error("Final download state must evaluate productReady before draft downloadable");
    }
    mustNotInclude(files.frontend, "finalGate.productReady || finalGate.downloadable");
    mustNotInclude(files.frontend, "deliveryGate?.downloadable === true || deliveryGate?.productReady === true");
    mustInclude(files.frontend, "onDeliveryModeChange={setPendingDeliveryMode}");
    mustInclude(files.frontend, "onOpenSampleReview={openSampleReviewPanel}");
    mustInclude(files.frontend, "onOpenImageDeckReview={openImageDeckReviewPanel}");
    mustInclude(files.frontend, "onCreateWorkflow?.({");
    mustInclude(files.frontend, "enforcePredictableCost: true");
    mustInclude(files.frontend, "maxImageCalls: costPreview?.plannedImageCalls");
    mustInclude(files.frontend, "onRemoveFile={removeUploadedFile}");
    mustInclude(files.frontend, "return { ok: false, error: message }");
    mustInclude(files.frontend, 'const uploadDeleteBusyRef = useRef("")');
    mustInclude(files.frontend, 'removingFileId: uploadDeleteBusyId');
    mustInclude(files.frontend, "if (!canRunWhileUploadsStable()) return;");
    mustInclude(files.frontend, "workflowBusy || outlineBusy || generationProgress.active || Boolean(uploadDeleteBusyId)");
    mustInclude(files.frontend, 'error: "任务正在处理源文件，完成后才能删除。"');
    mustInclude(files.uiV2, "create.removalDisabled");
    mustInclude(files.uiV2, "create.onRemoveFile(file)");
    mustInclude(files.uiV2, "删除已上传文件");
    mustInclude(files.uiV2, "!create.canSubmit || Boolean(removingFileId)");
    mustInclude(files.uiV2, 'className={styles.createError} role="alert"');
  });
}

function checkApiSurface(files) {
  return named("API exposes product workflow controls", () => {
    mustInclude(files.workflowVisuals, "Keep the generated visual intact");
    mustNotInclude(files.workflowVisuals, "applyFidelityOverlayToVisualImage");
    mustNotInclude(files.workflowVisuals, "applyProgramTextOverlayToVisualImage");
    mustInclude(files.apiClient, "workflowDeliveryStatus");
    mustInclude(files.apiClient, "workflowCostEstimate");
    mustInclude(files.apiClient, "workflowCostPreview");
    mustInclude(files.workflowCostEstimate, "upperBoundUsd");
    mustInclude(files.workflowCostEstimate, "plannedImageCalls");
    mustInclude(files.workflowBusinessReadiness, "minimumSuccessRate: 0.9");
    mustInclude(files.workflowBusinessReadiness, "minimumTasks: 20");
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
    mustInclude(files.workflowArtifacts, "isFinalPptxProductReady(finalGate");
    mustInclude(files.workflowArtifacts, "isFinalPptxProductReady(gate");
    mustInclude(files.workflowArtifacts, "Final PPTX is blocked until productReady=true.");
    mustInclude(files.workflowArtifacts, "productReady: gate.productReady === true");
    mustInclude(files.workflowArtifacts, "downloadable: productReady");
    mustInclude(files.workflowNextAction, "Route B requires explicit user confirmation before starting editable PPT rebuild.");
    mustInclude(files.workflowNextAction, "isImageDeckReviewApproved");
    mustInclude(files.workflowNextAction, "Route B requires image deck review approval before editable prepare.");
    mustInclude(files.workflowNextAction, "const preparedJob = await runStage(jobId, \"editable_prepared\"");
    mustInclude(files.workflowNextAction, "{ job: preparedJob }");
    mustNotInclude(files.workflowEditable, "approvedAt >= qualityCreatedAt");
    mustInclude(files.workflowImageDeckReview, 'source: "image-deck-review"');
    mustInclude(files.frontend, ".slice(0, 2)");
    mustInclude(files.frontend, "confirmLlmProviderRecovered: true");
    mustInclude(files.frontend, "result.run?.id");
    mustInclude(files.visualAssetHelper, "runEditpptImageJobs");
    mustNotInclude(files.visualAssetHelper, "editImageWithProvider");
    mustInclude(files.visualAssetHelper, "visual-asset-force-progress.json");
    mustInclude(files.visualAssetHelper, "plannedItem?.actualBackend");
    mustNotInclude(files.visualAssetHelper, '["image", "batch"');
    if ((files.workflowNextAction.match(/Route B requires image deck review approval before editable prepare\./g) || []).length < 2) {
      throw new Error("Route B image deck review gate must protect both execution and preflight paths");
    }
    mustInclude(files.workflowEditable, "assertImageDeckReviewGate(job, options)");
    mustInclude(files.workflowEditable, "Route B requires explicit user confirmation before editable prepare.");
    mustInclude(files.workflowEditable, "isImageDeckReviewApproved");
    mustInclude(files.workflowEditable, "safeToRunAutomatically: false");
    mustNotInclude(files.workflowEditable, "allowMissingVisualQualityForTest || options.allowNonProductVisual || options.allowNonProductBackend");
    mustNotInclude(files.workflowEditable, "/regression|smoke|test/i.test(marker)");
    mustInclude(files.pageRebuildAssembler, "(?<=[\\u3400-\\u9fff])\\s*\\|\\s*(?=[\\u3400-\\u9fff])");
    mustNotInclude(files.pageRebuildAssembler, ".replace(/\\s*\\|\\s*/g, \"|\")");
    mustInclude(files.pageRebuildAssembler, "inferRoundRectCornerRadius(shape.box_px)");
    mustInclude(files.modelPageSpecWorker, "inferRoundRectCornerRadius(shape.box_px)");
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
    mustInclude(files.workflowCodexPptSlideBatchRunner, "referenceImagePaths");
    mustInclude(files.workflowCodexPptSlideBatchRunner, "resolveCodexStyleReferenceImages");
    mustInclude(files.workflowCodexPptSlideBatchRunner, "review_required");
    mustInclude(files.workflowCodexPptSlideBatchRunner, "refreshBatchVisualQuality");
    mustInclude(files.workflowCodexPptRunState, "existing-visual-manifest");
    mustInclude(files.workflowCodexPptRunState, "accepted-sample");
    mustInclude(files.workflowVisuals, "buildCodexPptStyleLock");
    mustInclude(files.workflowVisuals, "STYLE LOCK: all slides must share one visual identity.");
    mustInclude(files.workflowVisuals, "styleReferenceImages");
    mustInclude(files.workflowVisuals, "referenceImagePaths: styleLock.referenceImages");
    mustInclude(files.workflowVisuals, "buildDeckStyleConsistencyReport");
    mustInclude(files.workflowStyleConsistency, "Deck-level pixel consistency QA");
    mustInclude(files.frontend, "风格一致性");
    mustInclude(files.workflowProductVisualReadinessRunner, "styleLock");
    mustInclude(files.workflowProductVisualReadinessRunner, "风格锁");
    mustInclude(files.workflowProductVisualReadinessRunner, "2 页测试尚未逐页复核通过");
    mustInclude(files.workflowProductVisualReadinessRunner, "preservedTestPages");
    mustInclude(files.workflowProductVisualReadinessRunner, "requiresImageDeckReview: true");
    mustNotInclude(files.workflowProductVisualReadinessRunner, "await assembleWorkflowImageDeck");
    mustInclude(files.workflowApprovals, "CODEX_PPT_TWO_PAGE_TEST_REQUIRED");
    mustInclude(files.workflowApprovals, "source-page-edit-plus-style-reference");
    mustInclude(files.workflowApprovals, "isCodexPptFullDeckApprovalCurrent");
    mustInclude(files.frontend, "const testPageCount = Math.max(1, Number(routeState.routeA.twoPageTestTarget || 1))");
    mustInclude(files.frontend, "workflowSelectionRef");
    mustInclude(files.frontend, "claimWorkflowSelection");
    mustInclude(files.frontend, "isWorkflowSelectionCurrent");
    mustInclude(files.frontend, "applySelectedWorkflowJob");
    mustInclude(files.frontend, "canApplyWorkflowJob(workflowSelectionRef, next?.id)");
    mustInclude(files.frontend, "if (!isWorkflowSelectionCurrent(selection, polledJobId)) return;");
    mustInclude(files.frontend, "通过并开放全量");
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
    mustInclude(files.workflowDelivery, "storedWorkerTasks");
    mustInclude(files.workflowPageEvidence, "page-pptx-openability-skipped");
    mustInclude(files.workflowPageEvidence, "powerpoint-open-check-skipped-until-full-delivery");
    mustInclude(files.workflowPageEvidence, "PAGE_EVIDENCE_HASH_CACHE");
    mustInclude(files.workflowDelivery, "不能作为完整产品交付");
    mustInclude(files.workflowDelivery, "final-visual-qa-needs-review");
    mustInclude(files.workflowDelivery, "visualQaPassed");
    mustInclude(files.workflowFinalEvidence, "automatedStatus");
    mustInclude(files.workflowFinalEvidence, "manualReviewStatus");
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
    mustInclude(files.workflowEditable, "assertEditableDispatchAllowed");
    mustInclude(files.workflowEditable, "EDITABLE_DISPATCH_STAGE_MISMATCH");
    mustInclude(files.workflowEditable, "EDITABLE_DISPATCH_PAGE_NOT_SELECTED");
    mustInclude(files.workflowEditable, "rebuild_page_locally");
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
    mustInclude(files.workflowFinalEvidence, "fsSync.readSync(fileHandle, buffer");
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
