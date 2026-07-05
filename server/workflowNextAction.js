import { renderWorkflowSource } from "./sourceRenderer.js";
import { assembleWorkflowImageDeck, assertWorkflowVisualGenerationAllowed, generateWorkflowVisualImages, generateWorkflowVisualSample } from "./workflowVisuals.js";
import { runWorkflowOcr } from "./workflowOcr.js";
import { buildWorkflowEditableWorkerPrompts, finalizeWorkflowEditableRun, prepareWorkflowEditableRun, regenerateWorkflowEditableHints } from "./workflowEditable.js";
import { getWorkflowComplianceStatus } from "./workflowCompliance.js";
import { assertCodexPptApprovals, CODEX_PPT_VISUAL_DECK_GATES, CODEX_PPT_VISUAL_SAMPLE_GATES } from "./workflowApprovals.js";
import { syncWorkflowCodexPptSlideTasks } from "./workflowCodexPptWorkerQueue.js";
import { readWorkflowJob, updateWorkflowStage } from "./workflowJobs.js";
import { getExternalImageAuthorizationStatus } from "./workflowAuthorizations.js";
import { retryStaleWorkflowPageEvidence } from "./workflowPageRetry.js";
import { listWorkflowEditableWorkerTasks } from "./workflowWorkerQueue.js";
import { getWorkflowDeliveryStatus } from "./workflowDelivery.js";

const MANUAL_ACTION_RE = /approve|approval|review\/approve|codex slide worker|slide workers|editable\/dispatch|editable\/record|page workers|reset failed/i;

export async function runWorkflowNextAction(jobId, options = {}) {
  const compliance = await getWorkflowComplianceStatus(jobId);
  const action = String((compliance.runbook?.allowedActions || [])[0] || "").trim();
  const job = await readWorkflowJob(jobId);
  const partialFinal = buildPartialFinalContinuation(job);
  if (partialFinal && (!action || action === "review/approve" || /review\/approve/i.test(action))) {
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
    const pageCount = Array.isArray(jobState.artifacts?.renderedPages) ? jobState.artifacts.renderedPages.length : 0;
    const authorization = getExternalImageAuthorizationStatus(jobState, { scope: "full-deck", imageCalls: pageCount });
    const authorizedBody = withExternalImageAuthorization(body, authorization);
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
    const job = await runStage(jobId, "editable_prepared", "正在准备 editppt 运行目录", "可编辑重建准备失败", body, () => prepareWorkflowEditableRun(jobId, { force: true, maxConcurrentPages: 6, ...body }));
    return makeRunResult(jobId, compliance, "editable/prepare", { job });
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
  const partialFinal = buildPartialFinalContinuation(job);
  if (partialFinal && (!action || action === "review/approve" || /review\/approve/i.test(action))) {
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
    const pageCount = Array.isArray(job.artifacts?.renderedPages) ? job.artifacts.renderedPages.length : 0;
    const authorization = getExternalImageAuthorizationStatus(job, { scope: "full-deck", imageCalls: pageCount });
    return previewWithAssertions(base, async () => {
      await assertCodexPptApprovals(jobId, CODEX_PPT_VISUAL_DECK_GATES);
      assertWorkflowVisualGenerationAllowed(withExternalImageAuthorization(body, authorization));
      return {
        action: "visual/generate",
        startReady: true,
        externalImageCalls: pageCount,
        authorization,
        reason: `可以生成 ${pageCount || "全部"} 张 codex-ppt 视觉图片页。`
      };
    }, { externalImageCalls: pageCount, authorization });
  }
  if (action === "image-deck/assemble" || action.includes("image-deck/assemble")) {
    const visualImages = Array.isArray(job.artifacts?.visualImages) ? job.artifacts.visualImages.length : 0;
    return visualImages
      ? { ...base, action: "image-deck/assemble", startReady: true, reason: `可以把 ${visualImages} 张视觉图组装成图片型 PPT。` }
      : { ...base, action: "image-deck/assemble", blockingIssues: ["没有可用于组装的视觉图片。"] };
  }
  if (action === "ocr/run" || action.includes("ocr/run")) {
    return { ...base, action: "ocr/run", startReady: true, reason: "可以运行 OCR/文字提示提取。" };
  }
  if (action === "editable/prepare" || action.includes("editable/prepare")) {
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

async function tryBuildFastEditablePageWorkerPreflight(jobId) {
  const job = await readWorkflowJob(jobId).catch(() => null);
  if (!job) return null;
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
      level: "working",
      currentTitle: "继续剩余页面可编辑重建",
      summary: `${recordedPages}/${tasks.length || "?"} 页已记录；剩余页面等待 image-to-editable-ppt 重建。`,
      allowedActions: ["editable/dispatch + editable/record"],
      blockers: [],
      nextActions: ["下一步：启动可编辑页面任务"]
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
  const artifacts = job.artifacts || {};
  const final = artifacts.editableFinal || {};
  const editability = final.pptxEditability || {};
  const sourcePages = numberOrZero(job.sourceMeta?.pageCount)
    || numberOrZero(artifacts.sourceMeta?.pageCount)
    || countArray(artifacts.renderedPages);
  const finalPages = numberOrZero(final.summary?.page_count || editability.slideCount || job.finalValidation?.slides);
  const visualPages = countArray(artifacts.visualImages);
  const hasFinal = Boolean(final.path);
  if (!hasFinal || !sourcePages || !finalPages || finalPages >= sourcePages) return null;

  const remainingPages = Math.max(0, sourcePages - finalPages);
  const startPage = finalPages + 1;
  const endPage = sourcePages;
  const pageSelection = `page_${String(startPage).padStart(3, "0")}-page_${String(endPage).padStart(3, "0")}`;
  const reason = `当前最终 PPT 只覆盖 ${finalPages}/${sourcePages} 页。请先复核当前 ${finalPages} 页样例，或确认额度后继续生成剩余 ${remainingPages} 页。`;
  return {
    partialFinal: {
      sourcePages,
      finalPages,
      remainingPages,
      visualPages,
      pageSelection,
      finalPath: final.path || "",
      canReviewCurrentSample: true,
      canContinueRemainingPages: remainingPages > 0
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
      {
        id: "continue-remaining-pages",
        label: `继续生成剩余 ${remainingPages} 页`,
        detail: `继续处理 ${pageSelection}。启动前必须再次确认 gpt-image-2 图片 API 和页面规格模型调用额度。`,
        targetPanel: "codex-slide-worker-panel",
        pageSelection,
        mutatesWorkflow: true,
        requiresExternalImageConfirmation: true,
        externalImageCalls: remainingPages
      }
    ],
    reason,
    warnings: [`当前是 ${finalPages}/${sourcePages} 页小样本，不是完整产品级交付。`]
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
