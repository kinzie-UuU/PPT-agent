import { renderWorkflowSource } from "./sourceRenderer.js";
import { assembleWorkflowImageDeck, assertWorkflowVisualGenerationAllowed, generateWorkflowVisualImages, generateWorkflowVisualSample, parsePageSelection } from "./workflowVisuals.js";
import { runWorkflowOcr } from "./workflowOcr.js";
import { buildWorkflowEditableWorkerPrompts, finalizeWorkflowEditableRun, isImageDeckReviewApproved, prepareWorkflowEditableRun, regenerateWorkflowEditableHints } from "./workflowEditable.js";
import { getWorkflowComplianceStatus } from "./workflowCompliance.js";
import { assertCodexPptApprovals, CODEX_PPT_VISUAL_DECK_GATES, CODEX_PPT_VISUAL_SAMPLE_GATES, isCodexPptSampleApprovalCurrent } from "./workflowApprovals.js";
import { syncWorkflowCodexPptSlideTasks } from "./workflowCodexPptWorkerQueue.js";
import { readWorkflowJob, updateWorkflowStage } from "./workflowJobs.js";
import { getExternalImageAuthorizationStatus } from "./workflowAuthorizations.js";
import { retryStaleWorkflowPageEvidence } from "./workflowPageRetry.js";
import { listWorkflowEditableWorkerTasks } from "./workflowWorkerQueue.js";
import { getWorkflowDeliveryStatus } from "./workflowDelivery.js";
import { buildPartialFinalCoverage } from "./workflowContinuation.js";
import { assertWorkflowImageDeckReviewReady, getExpectedWorkflowPageCount } from "./workflowImageDeckReview.js";

const MANUAL_ACTION_RE = /approve|approval|review\/approve|codex slide worker|slide workers|editable\/dispatch|editable\/record|page workers|reset failed/i;

export async function runWorkflowNextAction(jobId, options = {}) {
  const compliance = await getWorkflowComplianceStatus(jobId);
  const action = String((compliance.runbook?.allowedActions || [])[0] || "").trim();
  const job = await readWorkflowJob(jobId);
  const visualTest = buildPendingVisualTestGuidance(job, compliance);
  if (visualTest) return { ok: true, didRun: false, jobId, compliance, job, ...visualTest };
  const partialFinal = buildPartialFinalContinuation(job);
  if (partialFinal) {
    const partialDelivery = await buildExistingFinalDeliveryResult(jobId, compliance, job);
    if (partialDelivery?.blockingIssues?.length) {
      return mergePartialFinalDelivery(partialDelivery, partialFinal);
    }
    return {
      ok: true,
      didRun: false,
      manualRequired: true,
      action: "partial-final-review-or-continue",
      reason: partialFinal.reason,
      compliance,
      job,
      ...partialFinal
    };
  }
  if (!action) {
    if (partialFinal) {
      return { ok: true, didRun: false, manualRequired: true, action: "partial-final-review-or-continue", reason: partialFinal.reason, compliance, job, ...partialFinal };
    }
  }
  if (!action) return makeIdleResult(jobId, compliance, "当前没有可运行的工作流动作。");
  const finalDelivery = await buildExistingFinalDeliveryResult(jobId, compliance, job);
  if (finalDelivery) return finalDelivery;
  if (isEditablePageWorkerAction(action)) {
    return buildEditablePageWorkerManualResult(jobId, compliance, job);
  }
  if (MANUAL_ACTION_RE.test(action) && !/sync codex/i.test(action)) {
    return makeManualResult(jobId, compliance, action, manualReason(action));
  }

  const body = { ...options, requestedBy: options.requestedBy || "workflow-next-action" };
  if (/sync codex/i.test(action)) {
    await assertCodexPptApprovals(jobId, CODEX_PPT_VISUAL_DECK_GATES);
    const taskBundle = await syncWorkflowCodexPptSlideTasks(jobId, body);
    return makeRunResult(jobId, compliance, action, { taskBundle });
  }
  if (action === "retry-stale-page-evidence" || action.includes("retry-stale-page-evidence")) {
    const result = await retryStaleWorkflowPageEvidence(jobId, {
      ...body,
      apply: true,
      reason: body.reason || "workflow next action reset stale editable page evidence"
    });
    return makeRunResult(jobId, compliance, "retry-stale-page-evidence", { result, job: result.job });
  }
  if (action === "source/render" || action.includes("source/render")) {
    const job = await runStage(jobId, "source_rendered", "正在渲染源页面", "源页面渲染失败", body, () => renderWorkflowSource(jobId));
    return makeRunResult(jobId, compliance, "source/render", { job });
  }
  if (action === "visual/sample" || action.includes("visual/sample")) {
    await assertCodexPptApprovals(jobId, CODEX_PPT_VISUAL_SAMPLE_GATES);
    const jobState = await readWorkflowJob(jobId);
    const authorization = getExternalImageAuthorizationStatus(jobState, { scope: "visual-sample", imageCalls: 1 });
    const authorizedBody = withExternalImageAuthorization(body, authorization);
    assertWorkflowVisualGenerationAllowed(authorizedBody);
    const job = await runStage(jobId, "visual_sample_ready", "正在生成视觉样张", "视觉样张生成失败", authorizedBody, () => generateWorkflowVisualSample(jobId, authorizedBody));
    return makeRunResult(jobId, compliance, "visual/sample", { job });
  }
  if (action === "visual/generate" || action.includes("visual/generate")) {
    await assertCodexPptApprovals(jobId, CODEX_PPT_VISUAL_DECK_GATES);
    const jobState = await readWorkflowJob(jobId);
    const { requestedPages, pageCount, pageSelection } = buildVisualGenerationScope(jobState, body);
    if (!pageCount) {
      return {
        ok: true,
        didRun: false,
        manualRequired: false,
        action: "visual/generate",
        reason: "没有剩余图片页需要生成，已跳过外部图片 API 调用。",
        compliance: await getWorkflowComplianceStatus(jobId),
        job: jobState
      };
    }
    const authorization = getExternalImageAuthorizationStatus(jobState, { scope: "full-deck", imageCalls: pageCount, pages: requestedPages, pageSelection });
    const authorizedBody = withExternalImageAuthorization({
      ...body,
      ...(!pageSelection ? {} : { pages: pageSelection, maxPages: pageCount })
    }, authorization);
    assertWorkflowVisualGenerationAllowed(authorizedBody);
    const job = await runStage(jobId, "visual_generating", "正在生成视觉图片", "视觉图片生成失败", authorizedBody, () => generateWorkflowVisualImages(jobId, authorizedBody));
    return makeRunResult(jobId, compliance, "visual/generate", { job });
  }
  if (action === "image-deck/assemble" || action.includes("image-deck/assemble")) {
    const job = await runStage(jobId, "image_deck_ready", "正在组装图片型 PPT", "图片型 PPT 组装失败", body, () => assembleWorkflowImageDeck(jobId, body));
    return makeRunResult(jobId, compliance, "image-deck/assemble", { job });
  }
  if (action === "ocr/run" || action.includes("ocr/run")) {
    const job = await runStage(jobId, "ocr_ready", "正在运行 OCR", "OCR 失败", body, () => runWorkflowOcr(jobId, body));
    return makeRunResult(jobId, compliance, "ocr/run", { job });
  }
  if (action === "editable/prepare" || action.includes("editable/prepare")) {
    if (job.artifacts?.imageDeck && !isWorkflowJobImageDeckReviewApproved(job)) {
      return {
        ok: true,
        didRun: false,
        manualRequired: true,
        action: "editable/prepare",
        reason: "Route B requires image deck review approval before editable prepare.",
        blockingIssues: ["Route B requires image deck review approval before editable prepare."],
        compliance,
        job
      };
    }
    if (body.confirmRouteB !== true) {
      return {
        ok: true,
        didRun: false,
        manualRequired: true,
        action: "editable/prepare",
        reason: "Route B requires explicit user confirmation before starting editable PPT rebuild.",
        compliance,
        job
      };
    }
    const preparedJob = await runStage(jobId, "editable_prepared", "正在准备 editppt 运行目录", "可编辑重建准备失败", body, () => prepareWorkflowEditableRun(jobId, { force: true, maxConcurrentPages: 6, ...body }));
    return makeRunResult(jobId, compliance, "editable/prepare", { job: preparedJob });
  }
  if (action === "editable/hints" || action.includes("editable/hints")) {
    const job = await runStage(jobId, "editable_prepared", "正在重新生成 editppt 文字提示", "可编辑文字提示重新生成失败", body, () => regenerateWorkflowEditableHints(jobId, body));
    return makeRunResult(jobId, compliance, "editable/hints", { job });
  }
  if (action === "editable/prompts" || action.includes("editable/prompts")) {
    const job = await buildWorkflowEditableWorkerPrompts(jobId, body);
    return makeRunResult(jobId, compliance, "editable/prompts", { job });
  }
  if (action === "editable/finalize" || action.includes("editable/finalize")) {
    const job = await runStage(jobId, "finalizing", "正在生成最终可编辑 PPTX", "可编辑 PPTX 最终生成失败", body, () => finalizeWorkflowEditableRun(jobId, body));
    return makeRunResult(jobId, compliance, "editable/finalize", { job });
  }
  return makeManualResult(jobId, compliance, action, `暂不支持的下一步动作：${action}`);
}

export async function getWorkflowNextActionPreflight(jobId, options = {}) {
  const fastEditablePreflight = await tryBuildFastEditablePageWorkerPreflight(jobId);
  if (fastEditablePreflight) return fastEditablePreflight;
  const compliance = await getWorkflowComplianceStatus(jobId);
  const action = String((compliance.runbook?.allowedActions || [])[0] || "").trim();
  const job = await readWorkflowJob(jobId);
  const body = { ...options, requestedBy: options.requestedBy || "workflow-next-action-preflight" };
  const visualTest = buildPendingVisualTestGuidance(job, compliance);
  if (visualTest) {
    return {
      ok: true,
      preview: true,
      didRun: false,
      jobId,
      compliance,
      updatedAt: new Date().toISOString(),
      ...visualTest
    };
  }
  const partialFinal = buildPartialFinalContinuation(job);
  if (partialFinal) {
    const partialDelivery = await buildExistingFinalDeliveryPreflight(jobId, compliance, job);
    if (partialDelivery?.blockingIssues?.length) {
      return mergePartialFinalDelivery(partialDelivery, partialFinal);
    }
    return {
      ok: true,
      preview: true,
      didRun: false,
      jobId,
      action: "partial-final-review-or-continue",
      title: "当前测试范围已生成",
      summary: "当前最终 PPT 已生成但只覆盖部分源页面。",
      startReady: false,
      manualRequired: true,
      requiredConfirmation: "",
      externalImageCalls: 0,
      mutatesWorkflow: false,
      blockingIssues: [],
      warnings: partialFinal.warnings,
      compliance,
      updatedAt: new Date().toISOString(),
      ...partialFinal
    };
  }
  if (!action) {
    if (partialFinal) {
      return {
        ok: true,
        preview: true,
        didRun: false,
        jobId,
        action: "partial-final-review-or-continue",
        title: "当前测试范围已生成",
        summary: "当前最终 PPT 已生成但只覆盖部分源页。",
        startReady: false,
        manualRequired: true,
        requiredConfirmation: "",
        externalImageCalls: 0,
        mutatesWorkflow: false,
        blockingIssues: [],
        warnings: partialFinal.warnings,
        compliance,
        updatedAt: new Date().toISOString(),
        ...partialFinal
      };
    }
  }
  const finalDelivery = await buildExistingFinalDeliveryPreflight(jobId, compliance, job);
  if (finalDelivery) return finalDelivery;
  const base = {
    ok: true,
    preview: true,
    didRun: false,
    jobId,
    action,
    title: compliance.runbook?.currentTitle || "",
    summary: compliance.runbook?.summary || "",
    startReady: false,
    manualRequired: false,
    requiredConfirmation: "",
    externalImageCalls: 0,
    mutatesWorkflow: Boolean(action),
    blockingIssues: [],
    warnings: [],
    compliance,
    updatedAt: new Date().toISOString()
  };

  if (!action) return { ...base, reason: "当前没有可运行的工作流动作。" };
  if (isEditablePageWorkerAction(action)) {
    return buildEditablePageWorkerPreflight(base, jobId);
  }
  if (MANUAL_ACTION_RE.test(action) && !/sync codex/i.test(action)) {
    return {
      ...base,
      manualRequired: true,
      reason: manualReason(action),
      blockingIssues: [manualReason(action)]
    };
  }

  if (/sync codex/i.test(action)) {
    return previewWithAssertions(base, async () => {
      await assertCodexPptApprovals(jobId, CODEX_PPT_VISUAL_DECK_GATES);
      return {
        action: "sync codex slide tasks",
        startReady: true,
        reason: "可以同步 codex-ppt 图片页任务。"
      };
    });
  }
  if (action === "retry-stale-page-evidence" || action.includes("retry-stale-page-evidence")) {
    const result = await retryStaleWorkflowPageEvidence(jobId, { ...body, dryRun: true });
    return {
      ...base,
      action: "retry-stale-page-evidence",
      startReady: result.requested > 0,
      reason: result.requested
        ? `可重置 ${result.requested} 页过期页面证据：${(result.candidates || []).join(", ")}。此操作只重置页面任务，不会直接调用外部图片 API。`
        : "没有发现需要重置的过期页面证据。",
      stalePageCandidates: result.candidates || [],
      recovery: result.recovery || null,
      blockingIssues: result.requested ? [] : ["没有发现需要重置的过期页面证据。"],
      mutatesWorkflow: true
    };
  }
  if (action === "source/render" || action.includes("source/render")) {
    return { ...base, action: "source/render", startReady: true, reason: "可以渲染源页面。" };
  }
  if (action === "visual/sample" || action.includes("visual/sample")) {
    const authorization = getExternalImageAuthorizationStatus(job, { scope: "visual-sample", imageCalls: 1 });
    return previewWithAssertions(base, async () => {
      await assertCodexPptApprovals(jobId, CODEX_PPT_VISUAL_SAMPLE_GATES);
      assertWorkflowVisualGenerationAllowed(withExternalImageAuthorization(body, authorization));
      return {
        action: "visual/sample",
        startReady: true,
        externalImageCalls: 1,
        authorization,
        reason: "可以生成 1 页产品级 codex-ppt 视觉样张。"
      };
    }, { externalImageCalls: 1, authorization });
  }
  if (action === "visual/generate" || action.includes("visual/generate")) {
    const { pendingPages, requestedPages, pageCount, pageSelection } = buildVisualGenerationScope(job, body);
    if (!pageCount) {
      return {
        ...base,
        action: "visual/generate",
        title: "图片页已补齐",
        summary: "没有剩余图片页需要生成。",
        startReady: false,
        externalImageCalls: 0,
        blockingIssues: ["没有剩余图片页需要生成。"],
        warnings: []
      };
    }
    const authorization = getExternalImageAuthorizationStatus(job, { scope: "full-deck", imageCalls: pageCount, pages: requestedPages, pageSelection });
    return previewWithAssertions(base, async () => {
      await assertCodexPptApprovals(jobId, CODEX_PPT_VISUAL_DECK_GATES);
      assertWorkflowVisualGenerationAllowed(withExternalImageAuthorization(body, authorization));
      return {
        action: "visual/generate",
        title: pendingPages.length ? `继续生成剩余 ${pendingPages.length} 页` : "生成 codex-ppt 图片页",
        summary: pendingPages.length ? `保留当前 ${currentVisualImages(job).length} 页，只生成尚未完成的页面。` : "生成当前选择范围的 codex-ppt 图片页。",
        startReady: true,
        externalImageCalls: pageCount,
        authorization,
        reason: `可以生成 ${pageCount || "全部"} 张 codex-ppt 视觉图片页。`
      };
    }, { externalImageCalls: pageCount, authorization });
  }
  if (action === "image-deck/assemble" || action.includes("image-deck/assemble")) {
    const visualImages = Array.isArray(job.artifacts?.visualImages)
      ? job.artifacts.visualImages.filter((image) => image?.path && image.staleStyleReference !== true).length
      : 0;
    if (!visualImages) {
      return { ...base, action: "image-deck/assemble", blockingIssues: ["没有可用于组装的视觉图片。"] };
    }
    try {
      assertWorkflowImageDeckReviewReady(job);
      return { ...base, action: "image-deck/assemble", startReady: true, reason: `可以把 ${visualImages} 张已复核视觉图组装成图片型 PPT。` };
    } catch (error) {
      return {
        ...base,
        action: "image-deck/assemble",
        startReady: false,
        manualRequired: true,
        reason: "请先逐页复核整套图片，确认信息、文字和视觉风格后再组装。",
        blockingIssues: [error.message || "整套图片尚未完成复核。"]
      };
    }
  }
  if (action === "ocr/run" || action.includes("ocr/run")) {
    return { ...base, action: "ocr/run", startReady: true, reason: "可以运行 OCR/文字提示提取。" };
  }
  if (action === "editable/prepare" || action.includes("editable/prepare")) {
    if (job.artifacts?.imageDeck && !isWorkflowJobImageDeckReviewApproved(job)) {
      return { ...base, action: "editable/prepare", blockingIssues: ["Route B requires image deck review approval before editable prepare."] };
    }
    return job.artifacts?.imageDeck
      ? { ...base, action: "editable/prepare", startReady: true, reason: "可以准备 image-to-editable-ppt/editppt。" }
      : { ...base, action: "editable/prepare", blockingIssues: ["准备 editppt 前必须先生成图片型 PPT。"] };
  }
  if (action === "editable/hints" || action.includes("editable/hints")) {
    return job.artifacts?.editableRun
      ? { ...base, action: "editable/hints", startReady: true, reason: "可以重新生成 editppt 文字提示。" }
      : { ...base, action: "editable/hints", blockingIssues: ["重新生成文字提示前必须先准备可编辑运行目录。"] };
  }
  if (action === "editable/prompts" || action.includes("editable/prompts")) {
    return job.artifacts?.editableRun
      ? { ...base, action: "editable/prompts", startReady: true, reason: "可以生成 image-to-editable-ppt 页面提示。" }
      : { ...base, action: "editable/prompts", blockingIssues: ["生成页面提示前必须先准备可编辑运行目录。"] };
  }
  if (action === "editable/finalize" || action.includes("editable/finalize")) {
    return { ...base, action: "editable/finalize", startReady: true, reason: "如果所有页面记录齐全，可以生成最终可编辑 PPTX。" };
  }

  return {
    ...base,
    manualRequired: true,
    reason: `暂不支持的下一步动作：${action}`,
    blockingIssues: [`暂不支持的下一步动作：${action}`]
  };
}

function currentVisualImages(job = {}) {
  return (Array.isArray(job.artifacts?.visualImages) ? job.artifacts.visualImages : [])
    .filter((image) => image?.path && image.staleStyleReference !== true);
}

function isWorkflowJobImageDeckReviewApproved(job = {}) {
  const artifacts = job.artifacts || {};
  const expectedPages = getExpectedWorkflowPageCount(job);
  return isImageDeckReviewApproved(artifacts, { expectedPages });
}

export function buildPendingVisualTestGuidance(job = {}, compliance = null) {
  const sourcePages = Array.isArray(job.artifacts?.renderedPages) ? job.artifacts.renderedPages.length : 0;
  const targetPages = Math.min(2, sourcePages);
  const visualImages = currentVisualImages(job);
  const approvals = Array.isArray(job.artifacts?.codexPptApprovals) ? job.artifacts.codexPptApprovals : [];
  const sampleApproved = approvals.some((approval) => approval?.gate === "sample" && approval?.status === "approved");
  const fullDeckApproved = approvals.some((approval) => approval?.gate === "fullDeck" && approval?.status === "approved");
  const slideJobs = job.artifacts?.codexPptSlideJobs || {};
  const testScopeRecorded = Number(slideJobs.total || 0) > 0 && Number(slideJobs.total || 0) <= Math.max(2, targetPages);
  const rerunPageIds = Object.entries(job.artifacts?.imageDeckReview?.marks || {})
    .filter(([, mark]) => mark?.status === "rerun")
    .map(([pageId]) => pageId);
  const missingCount = Math.max(0, targetPages - visualImages.length);
  if (!sampleApproved || fullDeckApproved || !targetPages || !missingCount || (!testScopeRecorded && !rerunPageIds.length)) return null;
  const pageLabel = missingCount === 1 ? "1 页" : `${missingCount} 页`;
  return {
    action: "visual/generate",
    title: `补生成 ${pageLabel}测试图`,
    summary: `当前测试范围 ${visualImages.length}/${targetPages} 页；保留已通过页面，只补生成缺失的 ${pageLabel}。`,
    reason: "测试页尚未齐全，不能提前进入全量授权。",
    startReady: false,
    manualRequired: true,
    requiredConfirmation: `确认调用 ${missingCount} 次外部图片 API 后补生成测试页。`,
    externalImageCalls: missingCount,
    mutatesWorkflow: true,
    blockingIssues: [],
    warnings: rerunPageIds.length ? [`待重做页面：${rerunPageIds.join(", ")}`] : [],
    testScope: {
      targetPages,
      generatedPages: visualImages.length,
      missingPages: missingCount,
      rerunPageIds
    },
    compliance
  };
}

export function getPendingVisualPageNumbers(job = {}) {
  const currentPages = new Set(currentVisualImages(job)
    .map((image) => Number(image.pageNumber || String(image.pageId || "").match(/\d+/)?.[0] || 0))
    .filter(Boolean));
  const sample = job.artifacts?.visualSample || {};
  if (sample.path && sample.sha256 && isCodexPptSampleApprovalCurrent(job)) {
    const samplePageNumber = Number(sample.pageNumber || String(sample.pageId || "").match(/\d+/)?.[0] || 0);
    if (samplePageNumber) currentPages.add(samplePageNumber);
  }
  return (Array.isArray(job.artifacts?.renderedPages) ? job.artifacts.renderedPages : [])
    .map((page, index) => Number(page.pageNumber || String(page.pageId || "").match(/\d+/)?.[0] || index + 1))
    .filter((pageNumber) => pageNumber > 0 && !currentPages.has(pageNumber));
}

export function buildVisualGenerationScope(job = {}, options = {}) {
  const pendingPages = getPendingVisualPageNumbers(job);
  const explicitPages = String(options.pages || options.pageNumbers || "").trim();
  const renderedPageCount = Array.isArray(job.artifacts?.renderedPages) ? job.artifacts.renderedPages.length : 0;
  const pendingSet = new Set(pendingPages);
  const requestedPages = explicitPages
    ? parsePageSelection(explicitPages, renderedPageCount).filter((pageNumber) => options.force === true || pendingSet.has(pageNumber))
    : pendingPages;
  return {
    pendingPages,
    explicitPages,
    requestedPages,
    pageCount: requestedPages.length,
    pageSelection: requestedPages.join(",")
  };
}

async function tryBuildFastEditablePageWorkerPreflight(jobId) {
  const job = await readWorkflowJob(jobId).catch(() => null);
  if (!job) return null;
  const imageDeckReviewReady = !job.artifacts?.imageDeck || isWorkflowJobImageDeckReviewApproved(job);
  const taskBundle = await listWorkflowEditableWorkerTasks(jobId).catch(() => null);
  const tasks = Array.isArray(taskBundle?.tasks)
    ? taskBundle.tasks
    : Array.isArray(job.artifacts?.editableWorkerTasks)
      ? job.artifacts.editableWorkerTasks
      : [];
  const readyPages = tasks
    .filter((task) => task?.status === "ready")
    .map((task) => cleanPageId(task.pageId))
    .filter(Boolean);
  const recordedPages = tasks.filter((task) => task?.status === "recorded").length;
  if (!readyPages.length || !recordedPages) return null;
  const compliance = {
    ok: true,
    lightweight: true,
    runbook: {
      level: imageDeckReviewReady ? "working" : "blocked",
      currentTitle: imageDeckReviewReady ? "继续剩余页面可编辑重建" : "先完成图片版复核",
      summary: imageDeckReviewReady
        ? `${recordedPages}/${tasks.length || "?"} 页已记录；剩余页面等待 image-to-editable-ppt 重建。`
        : `${recordedPages}/${tasks.length || "?"} 页属于历史可编辑草稿；图片版复核完成前暂停继续重建。`,
      allowedActions: imageDeckReviewReady ? ["editable/dispatch + editable/record"] : ["image-deck/review"],
      blockers: imageDeckReviewReady ? [] : ["图片版逐页复核尚未完成。"],
      nextActions: [imageDeckReviewReady ? "下一步：启动可编辑页面任务" : "下一步：返回图片版逐页复核"]
    }
  };
  return buildEditablePageWorkerPreflight({
    ok: true,
    preview: true,
    didRun: false,
    jobId,
    action: "editable/page-workers",
    title: "继续剩余页面可编辑重建",
    summary: "",
    startReady: false,
    manualRequired: true,
    requiredConfirmation: "",
    externalImageCalls: 0,
    mutatesWorkflow: true,
    blockingIssues: [],
    warnings: [],
    compliance,
    updatedAt: new Date().toISOString()
  }, jobId);
}

async function runStage(jobId, stage, runningMessage, failedMessage, details, run) {
  await updateWorkflowStage(jobId, { stage, status: "running", message: runningMessage, details });
  try {
    return await run();
  } catch (error) {
    await updateWorkflowStage(jobId, {
      stage,
      status: "failed",
      message: error.message || failedMessage,
      details
    }).catch(() => null);
    throw error;
  }
}

async function makeIdleResult(jobId, compliance, reason) {
  return { ok: true, didRun: false, manualRequired: false, action: "", reason, compliance, job: await readWorkflowJob(jobId) };
}

async function makeManualResult(jobId, compliance, action, reason) {
  return { ok: true, didRun: false, manualRequired: true, action, reason, compliance, job: await readWorkflowJob(jobId) };
}

function isEditablePageWorkerAction(action = "") {
  return /editable\/dispatch|editable\/record|page workers/i.test(String(action || ""));
}

async function buildExistingFinalDeliveryResult(jobId, compliance, job = {}) {
  const preflight = await buildExistingFinalDeliveryPreflight(jobId, compliance, job);
  if (!preflight) return null;
  return {
    ...preflight,
    preview: false,
    job: job || await readWorkflowJob(jobId)
  };
}

async function buildExistingFinalDeliveryPreflight(jobId, compliance, job = {}) {
  if (!job?.artifacts?.editableFinal?.path) return null;
  const delivery = await getWorkflowDeliveryStatus(jobId).catch(() => null);
  const finalGate = delivery?.finalGate || null;
  if (!finalGate?.level) return null;

  const statusStep = delivery?.status?.nextStep || {};
  const checks = finalGate.checks || {};
  const reasons = Array.isArray(finalGate.reasons) ? finalGate.reasons : [];
  const warnings = Array.isArray(finalGate.warnings) ? finalGate.warnings : [];
  const hasBlockingReasons = reasons.length > 0;
  const firstReason = firstNonEmpty([...reasons, ...warnings]);
  const action = finalGate.productReady
    ? "delivery/download"
    : statusStep.id === "start-page-workers"
      ? "editable/page-workers"
      : "review-delivery-gate";
  const title = finalGate.productReady
    ? "最终 PPTX 已可交付"
    : hasBlockingReasons
      ? "最终 PPTX 已生成，但交付被阻断"
      : "最终 PPTX 已生成，等待复核";
  const summary = finalGate.productReady
    ? "交付门禁已通过，可以下载最终产品级 PPT。"
    : firstReason || finalGate.summary || "请先复核交付门禁，再决定重跑页面或记录人工复核。";

  return {
    ok: true,
    preview: true,
    didRun: false,
    jobId,
    action,
    title,
    summary,
    startReady: action === "editable/page-workers" && Boolean(statusStep.authorization?.persisted),
    manualRequired: action !== "editable/page-workers",
    requiredConfirmation: "",
    externalImageCalls: Number(statusStep.externalImageCalls || 0),
    mutatesWorkflow: action === "editable/page-workers",
    blockingIssues: hasBlockingReasons ? reasons : [],
    warnings,
    compliance,
    delivery: {
      level: finalGate.level,
      productReady: Boolean(finalGate.productReady),
      downloadable: Boolean(finalGate.downloadable),
      label: finalGate.label || "",
      checks,
      reasons,
      warnings,
      nextStep: statusStep
    },
    finalGate,
    pageSelection: statusStep.pageSelection || "",
    pages: Array.isArray(statusStep.pages) ? statusStep.pages : [],
    batchPlan: statusStep.batchPlan || null,
    authorization: statusStep.authorization || null,
    nextOptions: buildFinalDeliveryNextOptions(finalGate, statusStep),
    reason: summary,
    updatedAt: new Date().toISOString()
  };
}

function buildFinalDeliveryNextOptions(finalGate = {}, statusStep = {}) {
  if (finalGate.productReady) {
    return [
      {
        id: "download-final-pptx",
        label: "下载最终产品级 PPT",
        detail: "最终交付门禁已通过。",
        targetPanel: "workflow-delivery-panel",
        mutatesWorkflow: false,
        externalImageCalls: 0
      }
    ];
  }

  const options = [
    {
      id: "review-delivery-gate",
      label: "复核交付门禁",
      detail: firstNonEmpty([...(finalGate.reasons || []), ...(finalGate.warnings || [])]) || "查看当前阻断原因、页面证据和最终文件状态。",
      targetPanel: "workflow-delivery-panel",
      mutatesWorkflow: false,
      externalImageCalls: 0
    },
    {
      id: "record-manual-visual-review",
      label: "记录人工视觉复核",
      detail: "逐页对比原始页、图片版和可编辑页；每页只需要选择通过或不通过。",
      targetPanel: "workflow-delivery-panel",
      mutatesWorkflow: true,
      externalImageCalls: 0
    }
  ];

  if (statusStep?.id === "start-page-workers") {
    options.unshift({
      id: "rerun-blocked-editable-pages",
      label: "重跑阻断页面",
      detail: statusStep.description || statusStep.reason || "只重跑当前被重置或阻断的可编辑页面。",
      targetPanel: "editable-page-worker-panel",
      pageSelection: statusStep.pageSelection || "",
      pages: Array.isArray(statusStep.pages) ? statusStep.pages : [],
      mutatesWorkflow: true,
      requiresExternalImageConfirmation: true,
      externalImageCalls: Number(statusStep.externalImageCalls || 0)
    });
  }

  return options;
}

async function buildEditablePageWorkerManualResult(jobId, compliance, job = null) {
  const preflight = await buildEditablePageWorkerPreflight({
    ok: true,
    preview: true,
    didRun: false,
    jobId,
    action: "editable/page-workers",
    title: "继续剩余页面可编辑重建",
    summary: "",
    startReady: false,
    manualRequired: true,
    requiredConfirmation: "",
    externalImageCalls: 0,
    mutatesWorkflow: true,
    blockingIssues: [],
    warnings: [],
    compliance,
    updatedAt: new Date().toISOString()
  }, jobId);
  return {
    ok: true,
    didRun: false,
    manualRequired: true,
    action: "editable/page-workers",
    reason: preflight.reason,
    compliance,
    job: job || await readWorkflowJob(jobId),
    ...preflight
  };
}

async function buildEditablePageWorkerPreflight(base, jobId) {
  const job = await readWorkflowJob(jobId);
  if (job.artifacts?.imageDeck && !isWorkflowJobImageDeckReviewApproved(job)) {
    const reviewIssue = describeImageDeckReviewIssue(job);
    const reason = reviewIssue.reason;
    return {
      ...base,
      action: "image-deck/review",
      title: "先复核整套图片",
      summary: reason,
      startReady: false,
      manualRequired: true,
      mutatesWorkflow: false,
      reason,
      pageSelection: "",
      pages: [],
      externalImageCalls: 0,
      blockingIssues: [reason],
      warnings: [],
      nextOptions: [
        {
          id: "review-image-deck-style",
          label: "复核整套图片",
          detail: reviewIssue.detail,
          targetPanel: "image-deck-review",
          mutatesWorkflow: false,
          externalImageCalls: 0
        }
      ]
    };
  }
  const taskBundle = await listWorkflowEditableWorkerTasks(jobId).catch(() => null);
  const tasks = Array.isArray(taskBundle?.tasks)
    ? taskBundle.tasks
    : Array.isArray(job.artifacts?.editableWorkerTasks)
      ? job.artifacts.editableWorkerTasks
      : [];
  const pages = tasks
    .filter((task) => task?.status === "ready")
    .map((task) => cleanPageId(task.pageId))
    .filter(Boolean);
  if (!pages.length) {
    const reason = manualReason("page workers");
    return {
      ...base,
      action: "editable/page-workers",
      title: "继续可编辑页面重建",
      summary: reason,
      manualRequired: true,
      reason,
      blockingIssues: [reason]
    };
  }
  const pageSelection = pages.join(",");
  const externalImageCallsPerPage = getEditableWorkerExternalImageCallsPerPage();
  const externalImageCalls = Math.max(0, pages.length * externalImageCallsPerPage);
  const authorization = getExternalImageAuthorizationStatus(job, {
    scope: "editable-workers",
    imageCalls: externalImageCalls,
    pageSelection,
    pages: pages.map(pageNumberFromPageId).filter(Boolean)
  });
  const authorizationPersisted = Boolean(authorization?.persisted);
  const reason = `${pages.length || "若干"} 页等待 image-to-editable-ppt 重建；预计 ${externalImageCalls || "待确认"} 次 gpt-image-2 图片 API 调用。${authorizationPersisted ? "额度授权账本已记录，可以继续启动前预检。" : "启动前必须先记录额度授权账本。"}`;
  return {
    ...base,
    action: "editable/page-workers",
    title: "继续剩余页面可编辑重建",
    summary: reason,
    startReady: false,
    manualRequired: true,
    mutatesWorkflow: true,
    reason,
    pageSelection,
    pages,
    externalImageCalls,
    externalImageCallsPerPage,
    batchPlan: buildEditableWorkerBatchPlan(pages, externalImageCallsPerPage),
    authorization,
    blockingIssues: authorizationPersisted ? [] : ["启动页面 worker 前，需要先记录 gpt-image-2 图片额度授权。"],
    warnings: [
      "这一步会进入真实 image-to-editable-ppt 页面 worker；启动前必须人工确认，不会自动静默消耗外部 API。"
    ],
    nextOptions: [
      {
        id: "preview-editable-worker-start",
        label: "启动前预检",
        detail: "检查页码、worker 材料、LLM provider 状态和额度账本。",
        externalImageCalls: 0,
        mutatesWorkflow: false
      },
      {
        id: "authorize-editable-worker-spend",
        label: `授权 ${externalImageCalls || "本批"} 次图片额度`,
        detail: "只记录授权账本，不会立刻启动 worker。",
        externalImageCalls,
        mutatesWorkflow: true,
        requiresExternalImageConfirmation: true
      },
      {
        id: "start-editable-worker",
        label: "确认并启动页面重建",
        detail: "预检通过且额度授权后，启动真实 image-to-editable-ppt 页面 worker。",
        pageSelection,
        externalImageCalls,
        mutatesWorkflow: true,
        requiresExternalImageConfirmation: true
      }
    ]
  };
}

function buildEditableWorkerBatchPlan(pages = [], externalImageCallsPerPage = 8) {
  const defaultBatchPages = pages.slice(0, 2);
  return {
    totalPages: pages.length,
    pageSelection: pages.join(","),
    defaultBatchSize: defaultBatchPages.length,
    defaultBatchPages,
    defaultBatchPageSelection: defaultBatchPages.join(","),
    defaultBatchExternalImageCalls: defaultBatchPages.length * externalImageCallsPerPage,
    externalImageCallsPerPage,
    whyBatch: "默认先跑 2 页，确认模型、额度和页面证据稳定后再继续剩余页面。",
    preserveSuccessfulPages: true,
    requiresExplicitConfirmation: true
  };
}

function getEditableWorkerExternalImageCallsPerPage() {
  const configured = Number(process.env.PPT_TOOL_EDITABLE_IMAGE_CALLS_PER_PAGE || 8);
  return Number.isFinite(configured) && configured > 0 ? Math.ceil(configured) : 8;
}

function cleanPageId(value = "") {
  const match = String(value || "").match(/page[_-]?(\d+)/i);
  if (!match) return "";
  return `page_${String(Number(match[1])).padStart(3, "0")}`;
}

function pageNumberFromPageId(value = "") {
  const match = String(value || "").match(/page_(\d+)/i);
  const number = match ? Number(match[1]) : 0;
  return Number.isFinite(number) && number > 0 ? number : 0;
}

async function makeRunResult(jobId, compliance, action, extra = {}) {
  return {
    ok: true,
    didRun: true,
    manualRequired: false,
    action,
    reason: "",
    compliance,
    ...extra,
    job: extra.job || await readWorkflowJob(jobId)
  };
}

function withExternalImageAuthorization(body = {}, authorization = {}) {
  if (body.confirmExternalImageSpend || body.confirmSpend || body.confirmImageApiSpend) return body;
  if (!authorization?.persisted) return body;
  body.confirmExternalImageSpend = true;
  body.authorizationSource = "authorization-ledger";
  return body;
}

function buildPartialFinalContinuation(job = {}) {
  const coverage = buildPartialFinalCoverage(job);
  const {
    sourcePages = 0,
    finalPages = 0,
    visualPages = 0,
    missingVisualPageIds = [],
    missingEditablePageIds = [],
    canContinueRemainingPages = false,
    canContinueEditablePages = false
  } = coverage;
  if (!canContinueRemainingPages && !canContinueEditablePages) return null;

  const continueVisuals = canContinueRemainingPages;
  const imageDeckReviewReady = isWorkflowJobImageDeckReviewApproved(job);
  const requiresImageDeckReview = Boolean(!continueVisuals && canContinueEditablePages && !imageDeckReviewReady);
  const remainingPageIds = continueVisuals ? missingVisualPageIds : missingEditablePageIds;
  const remainingPages = remainingPageIds.length;
  const pageSelection = remainingPageIds.join(",");
  const externalImageCalls = continueVisuals ? remainingPages : remainingPages * getEditableWorkerExternalImageCallsPerPage();
  const reviewIssue = describeImageDeckReviewIssue(job);
  const reason = continueVisuals
    ? `当前最终 PPT 只覆盖 ${finalPages}/${sourcePages} 页。请先复核当前 ${finalPages} 页样例，或确认额度后继续生成缺失的 ${remainingPages} 个图片页。`
    : requiresImageDeckReview
      ? `图片版已经覆盖 ${visualPages}/${sourcePages} 页。${reviewIssue.reason}之后再继续重建缺失的 ${remainingPages} 个可编辑页。`
      : `图片版已经覆盖 ${visualPages}/${sourcePages} 页。下一步应继续重建缺失的 ${remainingPages} 个可编辑页，不会重复生成图片页。`;
  const continuationOption = requiresImageDeckReview
    ? {
      id: "review-image-deck-style",
      label: "复核整套图片",
      detail: reviewIssue.detail,
      targetPanel: "image-deck-review",
      mutatesWorkflow: false,
      externalImageCalls: 0
    }
    : {
      id: continueVisuals ? "continue-remaining-pages" : "continue-editable-pages",
      label: continueVisuals ? `继续生成缺失的 ${remainingPages} 个图片页` : `继续重建缺失的 ${remainingPages} 个可编辑页`,
      detail: continueVisuals
        ? `继续处理 ${pageSelection}。启动前必须再次确认 gpt-image-2 图片 API 调用额度。`
        : `继续处理 ${pageSelection}。只进入 image-to-editable-ppt 页面重建，不重复调用 codex-ppt 生成图片页。`,
      targetPanel: continueVisuals ? "codex-slide-worker-panel" : "editable-page-worker-panel",
      pageSelection,
      mutatesWorkflow: true,
      requiresExternalImageConfirmation: true,
      externalImageCalls
    };
  return {
    partialFinal: {
      sourcePages,
      finalPages,
      remainingPages,
      visualPages,
      pageSelection,
      continuationKind: continueVisuals ? "visual" : "editable",
      missingVisualPageIds,
      missingEditablePageIds,
      finalPath: coverage.finalPath || "",
      canReviewCurrentSample: true,
      canContinueRemainingPages: continueVisuals,
      canContinueEditablePages: Boolean(canContinueEditablePages && imageDeckReviewReady),
      imageDeckReviewReady,
      requiresImageDeckReview
    },
    nextOptions: [
      {
        id: "review-current-sample",
        label: `复核当前 ${finalPages} 页样例`,
        detail: "逐页对比原始页、图片版和可编辑页；每页选择通过或不通过。",
        targetPanel: "workflow-delivery-panel",
        mutatesWorkflow: false,
        externalImageCalls: 0
      },
      continuationOption
    ],
    reason,
    warnings: [`当前是 ${finalPages}/${sourcePages} 页小样本，不是完整产品级交付。`]
  };
}

function describeImageDeckReviewIssue(job = {}) {
  const semantic = job.artifacts?.visualTextQuality?.summary
    || job.artifacts?.visualQuality?.semanticQuality
    || job.artifacts?.visualQuality?.summary?.semanticQuality
    || {};
  const blockedCount = Number(semantic.blockedCount || 0);
  if (blockedCount > 0) {
    return {
      blockedCount,
      reason: `图片版有 ${blockedCount} 页存在文字、数据、页码或页面角色等自动风险，请逐页对照原稿后确认或标记重做。`,
      detail: `内容确认无误可明确接受；确有问题的页面可单独或批量加入重做，该动作本身不会立即调用外部 API。`
    };
  }
  return {
    blockedCount: 0,
    reason: "图片版已生成，但整套人工复核尚未完成。请先确认信息保真和正常的版式差异。",
    detail: "逐页确认信息保真和风格差异；正常变化需要明确确认，有问题的页面应标记重做。"
  };
}

function mergePartialFinalDelivery(delivery = {}, partial = {}) {
  if (partial.partialFinal?.requiresImageDeckReview) {
    const reviewOptions = (partial.nextOptions || []).filter((option) => option.id === "review-current-sample" || option.id === "review-image-deck-style");
    return {
      ...delivery,
      action: "image-deck/review",
      title: "先复核整套图片",
      summary: partial.reason,
      reason: partial.reason,
      startReady: false,
      manualRequired: true,
      mutatesWorkflow: false,
      externalImageCalls: 0,
      blockingIssues: [partial.reason],
      partialFinal: partial.partialFinal,
      nextOptions: reviewOptions,
      warnings: [...new Set([...(delivery.warnings || []), ...(partial.warnings || [])])]
    };
  }
  return {
    ...delivery,
    partialFinal: partial.partialFinal,
    nextOptions: [...(delivery.nextOptions || []), ...(partial.nextOptions || [])],
    warnings: [...new Set([...(delivery.warnings || []), ...(partial.warnings || [])])]
  };
}

function countArray(value) {
  return Array.isArray(value) ? value.length : 0;
}

function numberOrZero(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function firstNonEmpty(items = []) {
  return items.find((item) => String(item || "").trim()) || "";
}

async function previewWithAssertions(base, run, fallback = {}) {
  try {
    const result = await run();
    return { ...base, ...fallback, ...result, blockingIssues: [], warnings: [] };
  } catch (error) {
    const requiredConfirmation = error.requiredConfirmation || "";
    return {
      ...base,
      ...fallback,
      startReady: false,
      reason: localizeNextActionError(error.message || "下一步预检失败。"),
      requiredConfirmation,
      blockingIssues: requiredConfirmation ? [] : [localizeNextActionError(error.message || "下一步预检失败。")],
      warnings: requiredConfirmation ? [localizeNextActionError(error.message || "运行此动作前需要先确认。")] : [],
      code: error.code || "",
      missing: error.missing || [],
      required: error.required || []
    };
  }
}

function manualReason(action) {
  if (/approve|approval/i.test(action)) return "产品工作流继续前，此步骤需要明确的审批证据。";
  if (/review\/approve/i.test(action)) return "标记交付就绪前，最终产物需要人工复核。";
  if (/codex slide worker|slide workers/i.test(action)) return "codex-ppt 图片页任务必须由真实智能体认领并记录。";
  if (/editable\/dispatch|editable\/record|page workers/i.test(action)) return "image-to-editable-ppt 页面任务必须派发并记录页面证据。";
  if (/reset failed/i.test(action)) return "重试前需要先检查失败页面任务。";
  return "这个运行手册动作需要操作员决策。";
}

function localizeNextActionError(value = "") {
  let text = String(value || "");
  const replacements = [
    ["Next action preflight failed.", "下一步预检失败。"],
    ["Confirmation is required before running this action.", "运行此动作前需要先确认。"],
    ["External image API credit confirmation is required before starting codex-ppt slide image generation.", "开始 codex-ppt 图片页生成前，必须确认外部图片 API 额度。"],
    ["External image API credit confirmation is required before generation.", "生成前必须确认外部图片 API 额度。"],
    ["Missing codex-ppt approval gate(s):", "缺少 codex-ppt 确认关卡："],
    ["No visual images are available to assemble.", "没有可用于组装的视觉图片。"],
    ["Image-based PPT output is required before editppt prepare.", "准备 editppt 前必须先生成图片型 PPT。"],
    ["Editable run is required before regenerating text hints.", "重新生成文字提示前必须先准备可编辑运行目录。"],
    ["Editable run is required before building page-worker prompts.", "生成页面提示前必须先准备可编辑运行目录。"],
    ["dry-run", "验证链路"],
    ["passthrough", "透传"]
  ];
  for (const [from, to] of replacements) text = text.split(from).join(to);
  return text;
}
