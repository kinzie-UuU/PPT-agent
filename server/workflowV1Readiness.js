import fsSync from "fs";
import path from "path";
import { getProviderConfig } from "./providers.js";
import { listWorkflowArtifactLinks } from "./workflowArtifacts.js";
import { getWorkflowDeliveryStatus } from "./workflowDelivery.js";
import { readWorkflowJob } from "./workflowJobs.js";
import { getWorkflowCodexPptSlideBatchPreflight } from "./workflowCodexPptSlideBatchRunner.js";
import { resetWorkflowNonProductCodexPptSlides } from "./workflowCodexPptWorkerQueue.js";
import { getWorkflowEditableWorkerBatchPreflight } from "./workflowWorkerBatchRunner.js";
import { getExternalImageAuthorizationStatus } from "./workflowAuthorizations.js";
import { findLegacyStyleEvidence } from "./workflowApprovals.js";

export async function getWorkflowV1Readiness(jobId) {
  const job = await readWorkflowJob(jobId);
  const providers = getProviderConfig();
  const delivery = await getWorkflowDeliveryStatus(jobId).catch((error) => ({
    ok: false,
    error: error.message || "交付状态不可用",
    finalGate: null,
    coverage: {}
  }));
  const artifactLinks = await listWorkflowArtifactLinks(jobId).catch(() => ({ links: [] }));
  const artifacts = job.artifacts || {};
  const renderedPages = Array.isArray(artifacts.renderedPages) ? artifacts.renderedPages : [];
  const visualImages = (Array.isArray(artifacts.visualImages) ? artifacts.visualImages : [])
    .filter((image) => image?.path && image.staleStyleReference !== true);
  const editableTasks = Array.isArray(artifacts.editableWorkerTasks) ? artifacts.editableWorkerTasks : [];
  const approvals = Array.isArray(artifacts.codexPptApprovals) ? artifacts.codexPptApprovals : [];
  const approvedGates = new Set(approvals.filter((item) => item.status === "approved").map((item) => item.gate));
  const finalGate = delivery.finalGate || {};
  const coverage = delivery.coverage || {};
  const deliveryStatus = delivery.status || {};
  const rawDeliveryNextStep = deliveryStatus.nextStep || null;
  const linkKeys = new Set((artifactLinks.links || []).map((link) => link.key));
  const requiredDownloadLinks = ["final-pptx", "validation", "image-deck", "log-bundle"];
  const missingDownloadLinks = requiredDownloadLinks.filter((key) => !linkKeys.has(key));
  const finalDownloadable = Boolean(finalGate.productReady);
  const downloadsReady = !missingDownloadLinks.length && finalDownloadable;
  const sourceName = job.input?.sourceOriginalName || artifacts.source?.originalName || "";
  const sourcePages = numberOrZero(coverage.sourcePages) || renderedPages.length;
  const finalPages = numberOrZero(coverage.finalPages);
  const recordedPages = editableTasks.filter((task) => task.status === "recorded").length;
  const failedPages = editableTasks.filter((task) => task.status === "failed").length;
  const readyPages = editableTasks.filter((task) => task.status === "ready").length;
  const runningPages = editableTasks.filter((task) => task.status === "running" || task.status === "claimed").length;
  const rootBase = path.basename(job.rootDir || job.id || "");
  const styleEvidence = buildCodexPptStyleEvidence(artifacts.codexPptStyle);
  const providerEvidence = buildProviderEvidence(providers, artifacts.codexPptBackendDecision);
  const sampleEvidence = buildVisualSampleEvidence(artifacts.visualSample, providerEvidence);
  const scopedTargetPages = getCurrentWorkflowScopePages(artifacts, {
    visualImages: visualImages.length,
    editableTasks: editableTasks.length,
    sourcePages
  });
  const isPartialWorkflowScope = Boolean(sourcePages && scopedTargetPages && scopedTargetPages < sourcePages);
  const scopeEvidence = {
    sourcePages,
    currentScopePages: scopedTargetPages,
    partial: isPartialWorkflowScope,
    scopeLabel: isPartialWorkflowScope ? `${scopedTargetPages}/${sourcePages} 页测试范围` : `${scopedTargetPages || sourcePages || 0} 页范围`
  };
  const textHintEvidence = buildTextHintCoverageEvidence(artifacts, scopedTargetPages || sourcePages, sourcePages);
  const qualityEvidence = buildPageFinalQualityEvidence(delivery);
  const providerReady = providers.llm.configured && providers.image.configured && providers.image.enabled;
  const sampleAuthorization = getExternalImageAuthorizationStatus(job, { scope: "visual-sample", imageCalls: 1 });
  const fullDeckAuthorization = getExternalImageAuthorizationStatus(job, { scope: "full-deck", imageCalls: sourcePages || renderedPages.length || 0 });
  const codexSlideBatchPreflight = await getWorkflowCodexPptSlideBatchPreflight(jobId, {
    maxPages: sourcePages || renderedPages.length || 20,
    assembleImageDeck: true,
    prepareEditable: true,
    buildEditablePrompts: true,
    syncEditableWorkerTasks: true
  }).then(compactCodexSlideBatchPreflight).catch((error) => ({
    ok: false,
    ready: false,
    startReady: false,
    error: error.message || "codex-ppt 图片页批处理预检不可用"
  }));
  const codexSlideResetPreview = await resetWorkflowNonProductCodexPptSlides(jobId, {})
    .then(compactCodexSlideResetPreview)
    .catch((error) => ({
      ok: false,
      candidateCount: 0,
      error: error.message || "codex-ppt 非产品级结果重置预览不可用"
    }));
  const workerBatchPreflight = await getWorkflowEditableWorkerBatchPreflight(jobId, {
    mode: "model",
    maxPages: sourcePages || editableTasks.length || 20,
    autoFinalize: true
  }).then(compactWorkerBatchPreflight).catch((error) => ({
    ok: false,
    ready: false,
    startReady: false,
    error: error.message || "可编辑重建批处理预检不可用"
  }));
  const currentEditableEvidence = buildCurrentEditableEvidence({
    artifacts,
    finalGate,
    qualityEvidence
  });
  const effectiveWorkerBatchPreflight = suppressResolvedWorkerBatchFailure(workerBatchPreflight, currentEditableEvidence);
  const workerEvidence = {
    total: editableTasks.length,
    ready: readyPages,
    running: runningPages,
    recorded: recordedPages,
    failed: failedPages,
    prompts: Array.isArray(artifacts.editableWorkerPrompts) ? artifacts.editableWorkerPrompts.length : 0,
    deliveryNextStepId: rawDeliveryNextStep?.id || "",
    batchPreflight: effectiveWorkerBatchPreflight
  };

  const checks = [
    makeCheck({
      id: "real-deck-acceptance-target",
      label: "15 页真实 PPT 验收目标",
      status: sourcePages >= 15 && /\.pptx?$/i.test(sourceName) ? "pass" : "warning",
      detail: sourcePages
        ? `已从 ${sourceName || "当前工作流"} 检测到 ${sourcePages} 个源页面`
        : "声明 v1 验收前，需要使用真实 15 页 PPTX",
      evidence: { sourceName, sourcePages }
    }),
    makeCheck({
      id: "source-rendered",
      label: "源文件已渲染为页面",
      status: renderedPages.length ? "pass" : job.id ? "pending" : "fail",
      detail: renderedPages.length ? `${renderedPages.length} 张页面图已渲染` : "请先渲染源页面",
      evidence: { renderedPages: renderedPages.length }
    }),
    makeCheck({
      id: "provider-runtime",
      label: "外部运行环境已配置",
      status: providerReady ? providerEvidence.backendMatchesRuntime ? "pass" : "warning" : "fail",
      detail: providerReady
        ? providerEvidence.backendMatchesRuntime
          ? `${providers.image.model || "图片模型"} 通过 ${providers.image.baseUrl || "已配置服务商"}`
          : `当前运行环境 ${providerEvidence.runtime.model || "图片模型"} 与已确认后端 ${providerEvidence.approvedBackend.model || "未知"} 不一致`
        : "产品运行时必须配置外部图片 API",
      evidence: providerEvidence
    }),
    makeCheck({
      id: "codex-ppt-approval-chain",
      label: "codex-ppt 确认链路",
      status: styleEvidence.legacy ? "warning" : ["outline", "style", "backend", "sample", "fullDeck"].every((gate) => approvedGates.has(gate)) ? "pass" : approvals.length ? "warning" : "pending",
      detail: `${approvedGates.size}/5 个确认关卡已记录${styleEvidence.legacy ? "；codex-ppt 风格证据仍是历史调性，请刷新" : ""}${sampleEvidence.issue ? `；${sampleEvidence.issue}` : ""}`,
      evidence: { approvedGates: [...approvedGates], style: styleEvidence, sample: sampleEvidence }
    }),
    makeCheck({
      id: "image-deck",
      label: "图片型 PPT 输出",
      status: artifacts.imageDeck?.path ? isPartialWorkflowScope ? "warning" : "pass" : visualImages.length ? "warning" : "pending",
      detail: artifacts.imageDeck?.path
        ? `${shortPath(artifacts.imageDeck.path)}；当前覆盖 ${scopeEvidence.scopeLabel}${isPartialWorkflowScope ? "，还不是完整 15 页验收图片型 PPT" : ""}`
        : `${visualImages.length} 张视觉图，图片型 PPT 待生成`,
      evidence: { visualImages: visualImages.length, imageDeck: Boolean(artifacts.imageDeck?.path), ...scopeEvidence }
    }),
    makeCheck({
      id: "editable-run",
      label: "image-to-editable-ppt/editppt 运行",
      status: artifacts.editableRun?.path ? "pass" : artifacts.imageDeck?.path ? "pending" : "pending",
      detail: artifacts.editableRun?.path ? shortPath(artifacts.editableRun.path) : "图片型 PPT 生成后再准备 editppt",
      evidence: { editableRun: Boolean(artifacts.editableRun?.path) }
    }),
    makeCheck({
      id: "ocr-text-hint-coverage",
      label: "OCR 文字提示覆盖",
      status: textHintEvidence.ready
        ? textHintEvidence.lowConfidenceCount ? "warning" : "pass"
        : textHintEvidence.hasAnyTextHints ? "warning" : "pending",
      detail: textHintEvidence.ready
        ? textHintEvidence.lowConfidenceCount
          ? `文字提示已覆盖 ${textHintEvidence.coveredPages}/${textHintEvidence.expectedPages} 页，但仍有 ${textHintEvidence.lowConfidenceCount} 条低置信 OCR 需要修正`
          : `文字提示已覆盖 ${textHintEvidence.coveredPages}/${textHintEvidence.expectedPages} 页，低置信 OCR 已清零${textHintEvidence.partialScope ? `；这是当前测试范围，完整 v1 仍需覆盖 ${textHintEvidence.sourcePages} 页` : ""}`
        : textHintEvidence.hasAnyTextHints
          ? `文字提示只覆盖 ${textHintEvidence.coveredPages}/${textHintEvidence.expectedPages || "待定"} 页，请补齐 OCR/editppt hints`
          : "等待 OCR 或 editppt 文字提示；它用于提升可编辑重建的文本准确率",
      evidence: textHintEvidence
    }),
    makeCheck({
      id: "page-workers-and-retry",
      label: "页面任务与可重试性",
      status: failedPages ? "warning" : recordedPages && (!scopedTargetPages || recordedPages >= scopedTargetPages) ? "pass" : editableTasks.length ? "warning" : "pending",
      detail: `${recordedPages}/${scopedTargetPages || editableTasks.length || 0} 个当前页面任务已记录，${failedPages} 页失败；重试 API 可用${isPartialWorkflowScope ? `；完整 v1 仍需覆盖 ${sourcePages} 页` : ""}`,
      evidence: { recordedPages, failedPages, retryApi: true, ...scopeEvidence }
    }),
    makeCheck({
      id: "page-final-evidence-quality",
      label: "页面与最终证据质量",
      status: qualityEvidence.ready
        ? "pass"
        : qualityEvidence.hasAnyEvidence
          ? qualityEvidence.blockingIssueCount ? "warning" : "pending"
          : "pending",
      detail: qualityEvidence.ready
        ? `页面证据 ${qualityEvidence.completePages}/${qualityEvidence.totalPages} 完整，最终 validation/hash 已通过`
        : qualityEvidence.hasAnyEvidence
          ? `页面证据 ${qualityEvidence.completePages}/${qualityEvidence.totalPages || "待定"} 完整；manifest 问题 ${qualityEvidence.manifestIssueCount} 个，最终证据问题 ${qualityEvidence.finalIssueCount} 个`
          : "等待 editppt 页面证据、manifest、validation 和最终文件 hash 证据",
      evidence: qualityEvidence
    }),
    makeCheck({
      id: "final-editable-pptx",
      label: "最终可编辑 PPTX",
      status: finalGate.productReady ? "pass" : artifacts.editableFinal?.path ? "warning" : "pending",
      detail: finalGate.label || (artifacts.editableFinal?.path ? shortPath(artifacts.editableFinal.path) : "等待最终可编辑 PPTX"),
      evidence: { productReady: Boolean(finalGate.productReady), downloadable: Boolean(finalGate.downloadable), finalPages }
    }),
    makeCheck({
      id: "validation-and-downloads",
      label: "校验与下载",
      status: downloadsReady ? "pass" : linkKeys.size ? "warning" : "pending",
      detail: downloadsReady
        ? "最终 PPTX、图片型 PPT、validation.json 和日志包均可交付下载"
        : !finalDownloadable && linkKeys.has("final-pptx")
          ? `最终 PPTX 已生成但被交付门禁阻断：${finalGate.label || finalGate.title || "not-deliverable.pptx"}`
          : `缺少下载项：${missingDownloadLinks.join(", ") || "最终 PPTX 尚不可下载"}`,
      evidence: {
        linkKeys: [...linkKeys],
        requiredLinks: requiredDownloadLinks,
        missingLinks: missingDownloadLinks,
        finalDownloadable,
        finalGateLevel: finalGate.level || "",
        finalGateLabel: finalGate.label || ""
      }
    }),
    makeCheck({
      id: "restart-and-chinese-path-safety",
      label: "重启恢复与路径安全",
      status: fsSync.existsSync(path.join(job.rootDir, "state.json")) && isAscii(rootBase) ? "pass" : "warning",
      detail: isAscii(rootBase)
        ? `状态已持久化在 ${rootBase}${hasCjk(sourceName) ? "；中文源文件名仅作为元数据保留" : ""}`
        : "为保证 CLI 安全，工作流根目录应保持 ASCII",
      evidence: {
        stateJson: fsSync.existsSync(path.join(job.rootDir, "state.json")),
        rootBase,
        rootAscii: isAscii(rootBase),
        sourceNameHasCjk: hasCjk(sourceName)
      }
    })
  ];

  const pass = checks.filter((check) => check.status === "pass").length;
  const warning = checks.filter((check) => check.status === "warning").length;
  const fail = checks.filter((check) => check.status === "fail").length;
  const pending = checks.filter((check) => check.status === "pending").length;
  const level = fail ? "blocked" : warning ? "warning" : pending ? "pending" : "pass";
  const preflightActions = buildPreflightActions(effectiveWorkerBatchPreflight);
  const styleActions = buildStyleActions(styleEvidence);
  const sampleActions = buildCodexSampleActions({ approvedGates, sampleEvidence, providerReady, providerEvidence, sourcePages });
  const codexSlideActions = filterCodexSlideActionsForCurrentStage(
    [...sampleActions, ...buildCodexSlidePreflightActions(codexSlideBatchPreflight, codexSlideResetPreview)],
    {
      hasImageDeck: Boolean(artifacts.imageDeck?.path),
      hasEditableRun: Boolean(artifacts.editableRun?.path),
      workerBatchPreflight: effectiveWorkerBatchPreflight
    }
  );
  const providerActions = buildProviderActions(providerEvidence, providerReady, effectiveWorkerBatchPreflight);
  const authorizationActions = buildAuthorizationActions({ approvedGates, sampleAuthorization, fullDeckAuthorization, sampleEvidence, providerReady, sourcePages });
  const stalePageEvidenceActions = buildStalePageEvidenceActions(delivery.pageEvidence || {});
  const deliveryNextStep = buildEffectiveDeliveryNextStep(styleActions, providerActions, authorizationActions, preflightActions, codexSlideActions, stalePageEvidenceActions, rawDeliveryNextStep);
  workerEvidence.deliveryNextStepId = deliveryNextStep?.id || "";
  workerEvidence.rawDeliveryNextStepId = rawDeliveryNextStep?.id || "";
  const evidenceActions = checks
    .filter((check) => check.status !== "pass")
    .slice(0, 5)
    .map((check) => `${check.label}: ${check.detail}`);
  return {
    ok: true,
    jobId: job.id,
    level,
    title: level === "pass" ? "v1 验收就绪" : level === "blocked" ? "v1 验收被阻断" : level === "warning" ? "v1 验收还缺少证据" : "v1 验收待处理",
    summary: `${pass}/${checks.length} 项 v1 验收检查已通过`,
    counts: { pass, warning, pending, fail, total: checks.length },
    checks,
    delivery: {
      level: deliveryStatus.level || "",
      title: deliveryStatus.title || "",
      summary: deliveryStatus.summary || "",
      nextStep: deliveryNextStep,
      rawNextStep: rawDeliveryNextStep,
      finalGate: finalGate.level || ""
    },
    deliveryNextStep,
    codexSlideBatchPreflight,
    codexSlideResetPreview,
    workerBatchPreflight: effectiveWorkerBatchPreflight,
    workerEvidence,
    authorization: {
      sample: sampleAuthorization,
      fullDeck: fullDeckAuthorization
    },
    actionGroups: {
      style: styleActions,
      authorization: authorizationActions,
      codexSlide: codexSlideActions,
      preflight: preflightActions,
      provider: providerActions,
      pageEvidence: stalePageEvidenceActions,
      evidence: evidenceActions
    },
    nextActions: [
      ...styleActions.map((action) => action.detail),
      ...providerActions.map((action) => action.detail),
      ...authorizationActions.map((action) => action.detail),
      ...stalePageEvidenceActions.map((action) => action.detail),
      ...codexSlideActions.map((action) => action.detail),
      ...preflightActions.map((action) => action.detail),
      deliveryNextStep ? `当前工作流步骤：${deliveryNextStep.label}：${deliveryNextStep.reason}` : "",
      ...evidenceActions
    ]
      .filter(Boolean),
    updatedAt: new Date().toISOString()
  };
}

function makeCheck({ id, label, status, detail, evidence = {} }) {
  return { id, label, status, detail, evidence };
}

function compactCodexSlideResetPreview(preview = {}) {
  return {
    ok: preview.ok === true,
    preview: preview.preview !== false,
    candidateCount: numberOrZero(preview.candidateCount),
    candidates: Array.isArray(preview.candidates) ? preview.candidates.slice(0, 20).map((item) => ({
      pageId: item.pageId || "",
      pageNumber: numberOrZero(item.pageNumber),
      message: item.message || ""
    })) : [],
    skippedRecorded: Array.isArray(preview.skippedRecorded) ? preview.skippedRecorded.slice(0, 5) : []
  };
}

function compactCodexSlideBatchPreflight(preflight = {}) {
  const external = preflight.requiredConfirmations?.externalImageSpend || {};
  const backendRuntime = preflight.backendRuntime || {};
  return {
    ok: preflight.ok === true,
    ready: Boolean(preflight.ready),
    startReady: Boolean(preflight.startReady),
    mode: preflight.mode || "product",
    selectedCount: numberOrZero(preflight.selectedCount),
    selectedPages: Array.isArray(preflight.selectedPages) ? preflight.selectedPages.slice(0, 20) : [],
    counts: preflight.counts || {},
    approvals: preflight.approvals || {},
    provider: {
      configured: Boolean(preflight.provider?.configured),
      enabled: preflight.provider?.enabled !== false,
      model: preflight.provider?.model || "",
      baseUrl: preflight.provider?.baseUrl || ""
    },
    backendRuntime: {
      runtimeKey: backendRuntime.runtimeKey || "",
      approvedBackendKey: backendRuntime.approvedBackendKey || "",
      backendMatchesRuntime: Boolean(backendRuntime.backendMatchesRuntime),
      backendMismatch: Boolean(backendRuntime.backendMismatch),
      approvedBackendLooksDryRun: Boolean(backendRuntime.approvedBackendLooksDryRun)
    },
    confirmations: {
      externalImageSpend: {
        required: Boolean(external.required),
        confirmed: Boolean(external.confirmed)
      }
    },
    cost: {
      imageCalls: numberOrZero(preflight.cost?.imageCalls),
      unknownCostItems: Array.isArray(preflight.cost?.unknownCostItems) ? preflight.cost.unknownCostItems.slice(0, 5) : []
    },
    blockingIssues: Array.isArray(preflight.blockingIssues) ? preflight.blockingIssues.slice(0, 5) : [],
    warnings: Array.isArray(preflight.warnings) ? preflight.warnings.slice(0, 5) : []
  };
}

function compactWorkerBatchPreflight(preflight = {}) {
  const external = preflight.requiredConfirmations?.externalImageSpend || {};
  const offline = preflight.requiredConfirmations?.offlineTextHints || {};
  const llmProviderRecovered = preflight.requiredConfirmations?.llmProviderRecovered || {};
  const recentProviderFailure = preflight.recentProviderFailure || {};
  const providerFailure = preflight.providerFailure || {};
  const llmRecoveryPlan = buildLlmProviderRecoveryPlan({ providerFailure, recentProviderFailure, llmProviderRecovered });
  return {
    ok: preflight.ok === true,
    ready: Boolean(preflight.ready),
    startReady: Boolean(preflight.startReady),
    mode: preflight.mode || "model",
    selectedCount: numberOrZero(preflight.selectedCount),
    counts: preflight.counts || {},
    provider: {
      configured: Boolean(preflight.provider?.configured),
      enabled: preflight.provider?.enabled !== false,
      model: preflight.provider?.model || "",
      baseUrl: preflight.provider?.baseUrl || ""
    },
    llmProvider: compactProvider(preflight.llmProvider || preflight.providers?.llm),
    imageProvider: compactProvider(preflight.imageProvider || preflight.providers?.image || preflight.provider),
    providerFailure: {
      blocked: Boolean(providerFailure.blocked),
      kind: providerFailure.kind || "",
      message: providerFailure.message || "",
      currentProvider: providerFailure.currentProvider || null,
      failedProvider: providerFailure.failedProvider || null
    },
    recentProviderFailure: {
      found: Boolean(recentProviderFailure.found),
      kind: recentProviderFailure.kind || "",
      message: recentProviderFailure.message || "",
      pages: Array.isArray(recentProviderFailure.pages) ? recentProviderFailure.pages.slice(0, 20) : [],
      currentProvider: recentProviderFailure.currentProvider || null,
      failedProvider: recentProviderFailure.failedProvider || null
    },
    llmRecoveryPlan,
    confirmations: {
      externalImageSpend: {
        required: Boolean(external.required),
        confirmed: Boolean(external.confirmed)
      },
      offlineTextHints: {
        required: Boolean(offline.required),
        confirmed: Boolean(offline.confirmed),
        acceptedByWorkflow: Boolean(offline.acceptedByWorkflow)
      },
      llmProviderRecovered: {
        required: Boolean(llmProviderRecovered.required),
        confirmed: Boolean(llmProviderRecovered.confirmed),
        state: llmProviderRecovered.state || "",
        reason: llmProviderRecovered.reason || ""
      }
    },
    blockingIssues: Array.isArray(preflight.blockingIssues) ? preflight.blockingIssues.slice(0, 5) : [],
    warnings: Array.isArray(preflight.warnings) ? preflight.warnings.slice(0, 5) : [],
    activeRunner: preflight.activeRunner ? {
      id: preflight.activeRunner.id || "",
      status: preflight.activeRunner.status || "",
      logHref: preflight.activeRunner.logHref || ""
    } : null
  };
}

function buildCurrentEditableEvidence({ artifacts = {}, finalGate = {}, qualityEvidence = {} } = {}) {
  const checks = finalGate.checks || {};
  const gateReasons = [
    ...(Array.isArray(finalGate.reasons) ? finalGate.reasons : []),
    ...(Array.isArray(finalGate.warnings) ? finalGate.warnings : [])
  ].map((item) => String(item || ""));
  const waitingForManualReview = gateReasons.some((item) => /final-visual-qa-needs-review|视觉 QA|人工复核/.test(item));
  const finalReviewOnly = Boolean(
    artifacts.editableFinal?.path
    && finalGate.level === "blocked"
    && checks.hasFinal === true
    && checks.validationPassed === true
    && checks.editabilityPassed === true
    && checks.powerPointOpenable === true
    && checks.noFullSlideRaster === true
    && checks.pageEvidenceComplete === true
    && checks.manualReviewRecorded !== true
    && waitingForManualReview
  );
  const finalEvidenceUsable = Boolean(
    artifacts.editableFinal?.path
    && qualityEvidence.pageEvidenceComplete === true
    && qualityEvidence.finalValidationPassed === true
    && qualityEvidence.noFullSlideRaster === true
    && qualityEvidence.validationFailuresEmpty === true
  );
  return {
    finalReviewOnly,
    finalEvidenceUsable,
    suppressHistoricalProviderFailure: Boolean(finalReviewOnly || finalGate.productReady || finalEvidenceUsable)
  };
}

function suppressResolvedWorkerBatchFailure(preflight = {}, currentEditableEvidence = {}) {
  if (!currentEditableEvidence.suppressHistoricalProviderFailure) return preflight;
  const blockingIssues = Array.isArray(preflight.blockingIssues)
    ? preflight.blockingIssues.filter((issue) => !/No ready(?: or failed)? editable worker task matches this batch/i.test(String(issue || "")))
    : [];
  const warnings = Array.isArray(preflight.warnings)
    ? preflight.warnings.filter((issue) => !/最近一次可编辑重建失败|provider-timeout|timed out|timeout|aborted/i.test(String(issue || "")))
    : [];
  return {
    ...preflight,
    ready: blockingIssues.length === 0 ? true : preflight.ready,
    startReady: blockingIssues.length === 0 ? true : preflight.startReady,
    recentProviderFailure: {
      ...(preflight.recentProviderFailure || {}),
      found: false,
      supersededByCurrentEvidence: true,
      message: ""
    },
    llmRecoveryPlan: {
      ...(preflight.llmRecoveryPlan || {}),
      required: false,
      confirmed: true,
      supersededByCurrentEvidence: true
    },
    confirmations: {
      ...(preflight.confirmations || {}),
      llmProviderRecovered: {
        ...(preflight.confirmations?.llmProviderRecovered || {}),
        required: false,
        confirmed: true,
        state: "not-required-current-evidence-complete",
        reason: "current-editable-evidence-complete"
      }
    },
    blockingIssues,
    warnings,
    currentEditableEvidence
  };
}

function compactProvider(provider = {}) {
  return {
    configured: Boolean(provider?.configured),
    enabled: provider?.enabled !== false,
    model: provider?.model || "",
    baseUrl: provider?.baseUrl || ""
  };
}

function buildCodexPptStyleEvidence(style = {}) {
  const legacyToken = findLegacyStyleEvidence(style);
  return {
    exists: Boolean(style?.path || style?.relativePath),
    legacy: Boolean(legacyToken),
    legacyToken,
    title: style?.title || "",
    styleBrief: style?.styleBrief || "",
    source: style?.source || "",
    path: style?.relativePath || style?.path || ""
  };
}

function buildStyleActions(styleEvidence = {}) {
  if (!styleEvidence.legacy) return [];
  return [{
    id: "refresh-codex-ppt-style-evidence",
    label: "刷新 codex-ppt 风格证据",
    detail: `当前 codex-ppt 风格证据仍包含历史调性${styleEvidence.legacyToken ? `：${styleEvidence.legacyToken}` : ""}。请重新记录基于两套 Skill 的视觉风格说明，再确认风格关卡。`,
    severity: "warning",
    targetStepId: "refresh-style-approval"
  }];
}

function buildCodexSlidePreflightActions(preflight = {}, resetPreview = {}) {
  const actions = [];
  const external = preflight.confirmations?.externalImageSpend || {};
  if (!preflight.selectedCount && resetPreview.candidateCount) {
    actions.push({
      id: "reset-non-product-codex-slide-evidence",
      label: "重置非产品级 codex-ppt 图片页证据",
      detail: `将 ${resetPreview.candidateCount} 个验证链路/透传 codex-ppt 图片页结果重置为就绪，然后用已配置图片运行环境重跑。`,
      severity: "warning",
      targetStepId: "generate-image-deck"
    });
  }
  for (const issue of preflight.blockingIssues || []) {
    actions.push({
      id: `codex-slide-preflight-blocker-${actions.length + 1}`,
      label: "处理 codex-ppt 图片页预检阻断",
      detail: localizeV1Text(issue),
      severity: "blocked",
      targetStepId: "generate-image-deck"
    });
  }
  if (external.required && !external.confirmed && preflight.selectedCount) {
    actions.push({
      id: "confirm-codex-slide-image-spend",
      label: "确认 codex-ppt 图片 API 用量",
      detail: `重新生成 ${preflight.selectedCount} 张 codex-ppt 图片页前，请确认外部图片 API 额度用量。`,
      severity: "warning",
      targetStepId: "generate-image-deck"
    });
  }
  return actions;
}

function filterCodexSlideActionsForCurrentStage(actions = [], context = {}) {
  const workerReady = context.workerBatchPreflight?.ready === true || context.workerBatchPreflight?.startReady === true;
  const editableStageReady = Boolean(context.hasImageDeck && context.hasEditableRun && workerReady);
  if (!editableStageReady) return actions;
  return actions.filter((action) => !isExhaustedCodexSlideQueueAction(action));
}

function isExhaustedCodexSlideQueueAction(action = {}) {
  const detail = String(action.detail || "");
  return /No ready or failed codex-ppt slide tasks are available for batch generation/i.test(detail);
}

function buildCodexSampleActions({ approvedGates = new Set(), sampleEvidence = {}, providerReady = false, providerEvidence = {}, sourcePages = 0 } = {}) {
  const actions = [];
  const firstThreeApproved = ["outline", "style", "backend"].every((gate) => approvedGates.has(gate));
  if (!firstThreeApproved || !providerReady) return actions;
  const runtimeLabel = providerEvidence.runtimeKey || providerEvidence.runtime?.model || "已配置图片运行环境";
  if (!approvedGates.has("sample")) {
    if (!sampleEvidence.exists) {
      actions.push({
        id: "generate-product-visual-sample",
        label: "生成产品级视觉样张",
        detail: `请先确认 1 次外部图片 API 调用，再使用 ${runtimeLabel} 生成 1 页 codex-ppt 视觉样张，然后审批样张关卡。`,
        severity: "blocked",
        targetStepId: "generate-sample",
        requiresConfirmation: "externalImageSpend",
        imageCalls: 1
      });
      return actions;
    }
    if (!sampleEvidence.productReady) {
    actions.push({
      id: "regenerate-product-visual-sample",
      label: "重新生成产品级视觉样张",
      detail: `${ensureSentence(localizeV1Text(sampleEvidence.issue || "当前视觉样张未达到产品级要求"))} 请先确认 1 次外部图片 API 调用，再使用 ${runtimeLabel} 重新生成后审批样张。`,
      severity: "blocked",
      targetStepId: "generate-sample",
      requiresConfirmation: "externalImageSpend",
      imageCalls: 1
    });
      return actions;
    }
    actions.push({
      id: "approve-product-visual-sample",
      label: "确认产品级视觉样张",
      detail: "请复核当前产品级视觉样张，然后确认 codex-ppt 样张关卡。",
      severity: "warning",
      targetStepId: "approve-sample"
    });
    return actions;
  }
  if (!approvedGates.has("fullDeck")) {
    actions.push({
      id: "approve-codex-full-deck",
      label: "确认全量生成",
      detail: `生成 ${sourcePages || "全部"} 张 codex-ppt 图片页前，请先确认全量生成授权。`,
      severity: "warning",
      targetStepId: "approve-fullDeck"
    });
  }
  return actions;
}

function buildPreflightActions(preflight = {}) {
  const actions = [];
  const external = preflight.confirmations?.externalImageSpend || {};
  const offline = preflight.confirmations?.offlineTextHints || {};
  if (external.required && !external.confirmed) {
    actions.push({
      id: "confirm-external-image-spend",
      label: "确认外部图片 API 用量",
      detail: "启动可编辑重建页面任务前，请在可编辑任务面板确认外部图片 API 额度用量。",
      severity: "warning"
    });
  }
  if (offline.required && !offline.confirmed) {
    actions.push({
      id: "confirm-offline-text-hints",
      label: "确认文字提示来源",
      detail: "派发可编辑页面任务前，请接受离线内置文字提示，或先配置 PaddleOCR。",
      severity: "warning"
    });
  }
  for (const issue of preflight.blockingIssues || []) {
    actions.push({
      id: `preflight-blocker-${actions.length + 1}`,
      label: "处理可编辑重建预检阻断",
      detail: localizeV1Text(issue),
      severity: "blocked"
    });
  }
  return actions;
}

function buildProviderActions(providerEvidence = {}, providerReady = false, workerBatchPreflight = {}) {
  const recentProviderFailure = workerBatchPreflight.recentProviderFailure || {};
  const providerFailure = workerBatchPreflight.providerFailure || {};
  const llmFailure = providerFailure.blocked ? providerFailure : recentProviderFailure.found ? recentProviderFailure : null;
  if (llmFailure) {
    const isAuth = llmFailure.kind === "provider-auth-failed";
    const recoveryPlan = buildLlmProviderRecoveryPlan({
      providerFailure,
      recentProviderFailure,
      llmProviderRecovered: workerBatchPreflight.confirmations?.llmProviderRecovered || {}
    });
    return [{
      id: isAuth ? "fix-llm-provider-auth" : "fix-llm-provider-quota",
      label: isAuth ? "处理对话模型鉴权失败" : "处理对话模型额度不足",
      detail: llmFailure.message || (isAuth
        ? "可编辑重建需要可用的对话模型服务商；请先检查 API Key 或服务商鉴权，再重跑可编辑页面任务。"
        : "可编辑重建需要可用的对话模型服务商；请先充值或切换对话模型服务商，再重跑可编辑页面任务。"),
      severity: providerFailure.blocked ? "blocked" : "warning",
      targetStepId: "fix-llm-provider",
      source: "editable-worker-preflight",
      providerKind: "llm",
      recoveryPlan
    }];
  }
  if (!providerReady) {
    return [{
      id: "configure-external-image-runtime",
      label: "配置外部图片运行环境",
      detail: "审批 codex-ppt 产品级视觉页前，请先配置并测试外部图片 API。",
      severity: "blocked",
      targetStepId: "generate-image-deck"
    }];
  }
  if (!providerEvidence.backendMismatch) return [];
  const runtimeLabel = providerEvidence.runtimeKey || providerEvidence.runtime?.model || "当前运行环境";
  const backendLabel = providerEvidence.approvedBackendKey || providerEvidence.approvedBackend?.model || "已确认后端";
  const dryRunNote = providerEvidence.approvedBackendLooksDryRun
    ? "已确认的后端证据像回归验证/验证链路路径，不是产品级视觉证据。"
    : "已确认的后端证据不再匹配当前配置的运行环境。";
  return [{
    id: "regenerate-codex-ppt-with-runtime",
    label: "生成前刷新后端确认",
    detail: `${dryRunNote} 请使用 ${runtimeLabel} 刷新 codex-ppt 后端确认，并在全量生成前重新生成视觉样张。`,
    severity: "warning",
    targetStepId: "refresh-backend-approval",
    runtimeKey: runtimeLabel,
    approvedBackendKey: backendLabel
  }];
}

function buildLlmProviderRecoveryPlan({ providerFailure = {}, recentProviderFailure = {}, llmProviderRecovered = {} } = {}) {
  const activeFailure = providerFailure.blocked ? providerFailure : recentProviderFailure.found ? recentProviderFailure : {};
  const pages = Array.isArray(activeFailure.pages) ? activeFailure.pages.filter(Boolean) : [];
  const isAuth = activeFailure.kind === "provider-auth-failed";
  const stepOne = isAuth
    ? "检查对话模型 API Key、Base URL 和服务商鉴权"
    : "充值或切换对话模型服务商，不需要改 gpt-image-2";
  return {
    required: Boolean(providerFailure.blocked || recentProviderFailure.found || llmProviderRecovered.required),
    kind: activeFailure.kind || "",
    pages,
    confirmed: Boolean(llmProviderRecovered.confirmed),
    steps: [
      stepOne,
      "重置失败的可编辑页面任务，清掉旧失败证据",
      "确认对话模型已恢复，并重新启动可编辑重建",
      "页面任务通过后重新生成最终 PPT，只有交付门禁通过才开放下载"
    ],
    apiSequence: [
      "POST /api/workflow-jobs/:id/pages/retry-failed",
      "POST /api/workflow-jobs/:id/editable/worker-runs/preflight",
      "POST /api/workflow-jobs/:id/editable/worker-runs",
      "POST /api/workflow-jobs/:id/editable/finalize"
    ],
    note: "恢复对话模型后不能复用旧失败最终文件；必须重置失败页并重新跑可编辑重建页面任务。"
  };
}

function buildAuthorizationActions({ approvedGates = new Set(), sampleAuthorization = {}, fullDeckAuthorization = {}, sampleEvidence = {}, providerReady = false, sourcePages = 0 } = {}) {
  if (!providerReady) return [];
  const actions = [];
  const firstThreeApproved = ["outline", "style", "backend"].every((gate) => approvedGates.has(gate));
  if (firstThreeApproved && !approvedGates.has("sample") && !sampleAuthorization.persisted) {
    actions.push({
      id: "record-sample-spend-authorization",
      label: "记录样张额度授权",
      detail: "生成 codex-ppt 产品样张前，请先记录 1 次外部图片 API 授权。",
      severity: "warning",
      targetStepId: "record-sample-authorization",
      scope: "visual-sample",
      imageCalls: 1,
      persisted: false
    });
  }
  const canAuthorizeFullDeck = approvedGates.has("sample") && sampleEvidence.productReady;
  if (canAuthorizeFullDeck && !approvedGates.has("fullDeck") && !fullDeckAuthorization.persisted) {
    actions.push({
      id: "record-full-deck-spend-authorization",
      label: "记录全量额度授权",
      detail: `全量生成前，请先为 ${sourcePages || "全部"} 张 codex-ppt 图片页记录外部图片 API 授权。`,
      severity: "warning",
      targetStepId: "record-full-deck-authorization",
      scope: "full-deck",
      imageCalls: sourcePages || 0,
      persisted: false
    });
  }
  return actions;
}

function buildEffectiveDeliveryNextStep(styleActions = [], providerActions = [], authorizationActions = [], preflightActions = [], codexSlideActions = [], stalePageEvidenceActions = [], deliveryNextStep = null) {
  const styleAction = styleActions.find((action) => action?.targetStepId);
  if (styleAction) {
    return {
      id: styleAction.targetStepId || styleAction.id,
      label: styleAction.label || "刷新 codex-ppt 风格证据",
      reason: styleAction.detail || "继续前请先刷新历史风格证据。",
      source: "codex-ppt-style",
      actionId: styleAction.id || ""
    };
  }
  const blockingProviderAction = providerActions.find((action) => action?.targetStepId);
  if (blockingProviderAction) {
    return {
      id: blockingProviderAction.targetStepId || blockingProviderAction.id,
      label: blockingProviderAction.label || "处理服务商运行环境",
      reason: blockingProviderAction.detail || "继续前请先处理服务商运行环境证据。",
      source: "provider-runtime",
      actionId: blockingProviderAction.id || "",
      recoveryPlan: blockingProviderAction.recoveryPlan || null
    };
  }
  const authorizationAction = authorizationActions.find((action) => action?.targetStepId);
  if (authorizationAction) {
    return {
      id: authorizationAction.targetStepId || authorizationAction.id,
      label: authorizationAction.label || "记录图片额度授权",
      reason: authorizationAction.detail || "开始产品级视觉生成前，请先记录图片额度授权。",
      source: "external-image-authorization",
      actionId: authorizationAction.id || ""
    };
  }
  const stalePageEvidenceAction = stalePageEvidenceActions.find((action) => action?.targetStepId);
  if (stalePageEvidenceAction) {
    return {
      id: stalePageEvidenceAction.targetStepId || stalePageEvidenceAction.id,
      label: stalePageEvidenceAction.label || "重置过期页面证据",
      reason: stalePageEvidenceAction.detail || "页面证据哈希已过期，请重置相关页面后重新运行可编辑页面任务。",
      source: "page-evidence",
      actionId: stalePageEvidenceAction.id || ""
    };
  }
  const workerPreflightAction = preflightActions.find((action) => action?.severity === "blocked" || action?.severity === "warning");
  if (workerPreflightAction) {
    return {
      id: workerPreflightAction.targetStepId || workerPreflightAction.id || "start-page-workers",
      label: workerPreflightAction.label || "确认可编辑重建任务",
      reason: workerPreflightAction.detail || "启动可编辑重建页面任务前需要先完成预检确认。",
      source: "editable-worker-preflight",
      actionId: workerPreflightAction.id || ""
    };
  }
  const blockingCodexSlideAction = codexSlideActions.find((action) => action?.targetStepId);
  if (!blockingCodexSlideAction) return deliveryNextStep;
  return {
    id: blockingCodexSlideAction.targetStepId || blockingCodexSlideAction.id,
    label: blockingCodexSlideAction.label || "处理 codex-ppt 视觉证据",
    reason: blockingCodexSlideAction.detail || "进入可编辑重建前，请先处理 codex-ppt 视觉证据。",
    source: "codex-ppt-visual",
    actionId: blockingCodexSlideAction.id || ""
  };
}

function buildStalePageEvidenceActions(pageEvidence = {}) {
  const pageIds = stalePageEvidencePageIds(pageEvidence);
  if (!pageIds.length) return [];
  return [{
    id: "retry-stale-page-evidence",
    label: "重置过期页面证据",
    detail: `检测到 ${pageIds.length} 页可编辑页面任务证据哈希已过期，请先重置这些页面，再启动页面任务重跑。`,
    severity: "blocked",
    targetStepId: "retry-stale-page-evidence",
    pages: pageIds
  }];
}

function stalePageEvidencePageIds(pageEvidence = {}) {
  const issues = Array.isArray(pageEvidence.issues) ? pageEvidence.issues : [];
  const ids = new Set();
  for (const issue of issues) {
    const issueText = String(issue?.issue || issue?.code || issue || "");
    if (!/hash-mismatch-|page-pptx-powerpoint-open-failed/i.test(issueText)) continue;
    const pageId = issue?.pageId || issue?.page || issue?.id || "";
    if (pageId) ids.add(String(pageId));
  }
  return Array.from(ids).sort();
}

function numberOrZero(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function ensureSentence(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function localizeV1Text(value = "") {
  let text = String(value || "");
  if (!text) return "";
  const replacements = [
    ["visual sample is dry-run/passthrough evidence", "当前视觉样张是验证链路/透传证据"],
    ["External Image API is required for product runtime", "产品运行时必须配置外部图片 API"],
    ["No visual images are available to assemble.", "没有可用于组装的视觉图片。"],
    ["Image-based PPT output is required before editppt prepare.", "准备 editppt 前必须先生成图片型 PPT。"],
    ["Editable run is required before regenerating text hints.", "重新生成文字提示前必须先准备可编辑运行目录。"],
    ["Editable run is required before building page-worker prompts.", "生成页面提示前必须先准备可编辑运行目录。"],
    ["Next action preflight failed.", "下一步预检失败。"],
    ["Confirmation is required before running this action.", "运行此动作前需要先确认。"],
    ["No codex-ppt slide worker tasks are synced.", "还没有同步 codex-ppt 图片页任务。"],
    ["Sync the slide queue after full-deck approval.", "全量确认后请同步图片页队列。"],
    ["Missing codex-ppt approval gate(s):", "缺少 codex-ppt 确认关卡："],
    ["The approved backend evidence looks like a regression/dry-run path, not product visual evidence.", "已确认的后端证据像回归验证/验证链路路径，不是产品级视觉证据。"],
    ["Refresh the codex-ppt backend approval with", "请使用"],
    ["then regenerate the visual sample before full-deck generation.", "刷新 codex-ppt 后端确认，并在全量生成前重新生成视觉样张。"],
    ["The approved backend evidence no longer matches the configured runtime.", "已确认的后端证据不再匹配当前配置的运行环境。"],
    ["dry-run/passthrough", "验证链路/透传"],
    ["dry-run", "验证链路"],
    ["passthrough", "透传"],
    ["source page", "源页面"],
    ["source pages", "源页面"],
    ["visual image(s)", "张视觉图"],
    ["slide image(s)", "张图片页"],
    ["page worker task(s)", "个页面任务"],
    ["page(s)", "页"],
    ["all", "全部"],
    ["pending", "待处理"],
    ["missing", "缺失"],
    ["unknown", "未知"]
  ];
  for (const [from, to] of replacements) text = text.split(from).join(to);
  return text;
}

function buildProviderEvidence(providers = {}, backendDecision = null) {
  const runtime = {
    llmConfigured: Boolean(providers.llm?.configured),
    imageConfigured: Boolean(providers.image?.configured),
    imageEnabled: Boolean(providers.image?.enabled),
    baseUrl: providers.image?.baseUrl || "",
    model: providers.image?.model || ""
  };
  const approvedBackend = {
    provider: backendDecision?.provider || backendDecision?.backend?.provider || "",
    baseUrl: backendDecision?.baseUrl || backendDecision?.backend?.baseUrl || "",
    model: backendDecision?.model || backendDecision?.backend?.model || ""
  };
  const modelMatches = !approvedBackend.model || !runtime.model || approvedBackend.model === runtime.model;
  const baseUrlMatches = !approvedBackend.baseUrl || !runtime.baseUrl || normalizeBaseUrl(approvedBackend.baseUrl) === normalizeBaseUrl(runtime.baseUrl);
  const backendMatchesRuntime = modelMatches && baseUrlMatches;
  const runtimeReady = Boolean(runtime.llmConfigured && runtime.imageConfigured && runtime.imageEnabled);
  const runtimeKey = [runtime.model, normalizeBaseUrl(runtime.baseUrl)].filter(Boolean).join(" @ ");
  const approvedBackendKey = [approvedBackend.provider, approvedBackend.model, normalizeBaseUrl(approvedBackend.baseUrl)].filter(Boolean).join(" @ ");
  const approvedBackendLooksDryRun = looksLikeDryRun([
    backendDecision?.source,
    approvedBackend.provider,
    approvedBackend.model,
    approvedBackend.baseUrl
  ].join(" "));
  return {
    llmConfigured: runtime.llmConfigured,
    imageConfigured: runtime.imageConfigured,
    imageEnabled: runtime.imageEnabled,
    apiKeyHidden: true,
    runtime,
    approvedBackend,
    runtimeReady,
    runtimeKey,
    approvedBackendKey,
    modelMatches,
    baseUrlMatches,
    backendMatchesRuntime,
    backendMismatch: !backendMatchesRuntime,
    approvedBackendLooksDryRun
  };
}

function buildVisualSampleEvidence(sample = {}, providerEvidence = {}) {
  const exists = Boolean(sample?.path);
  const nonProduct = exists && looksLikeDryRun([
    sample.source,
    sample.provider,
    sample.model,
    sample.baseUrl,
    sample.dryRun ? "dry-run" : "",
    sample.passthrough ? "passthrough" : ""
  ].join(" "));
  const modelMatches = !exists || !sample.model || !providerEvidence.runtime?.model || sample.model === providerEvidence.runtime.model;
  const baseUrlMatches = !exists || !sample.baseUrl || !providerEvidence.runtime?.baseUrl || normalizeBaseUrl(sample.baseUrl) === normalizeBaseUrl(providerEvidence.runtime.baseUrl);
  const sourceReferenced = Boolean(sample?.imageInputMode === "source-page-edit" && (sample?.sourceImagePath || sample?.sourcePagePath));
  const productReady = exists && !nonProduct && modelMatches && baseUrlMatches && sourceReferenced;
  let issue = "";
  if (exists && nonProduct) issue = "当前视觉样张是验证链路/透传证据";
  else if (exists && !modelMatches) issue = `视觉样张模型 ${sample.model || "未知"} 与当前运行环境 ${providerEvidence.runtime?.model || "未知"} 不一致`;
  else if (exists && !baseUrlMatches) issue = "视觉样张服务商与当前运行环境不一致";
  if (exists && !issue && !sourceReferenced) issue = "视觉样张缺少源页面图片参考输入证据，请用 gpt-image-2 图片编辑链路重新生成。";
  return {
    exists,
    productReady,
    nonProduct,
    modelMatches,
    baseUrlMatches,
    provider: sample.provider || "",
    baseUrl: sample.baseUrl || "",
    model: sample.model || "",
    source: sample.source || "",
    dryRun: Boolean(sample.dryRun),
    imageInputMode: sample.imageInputMode || "",
    sourceImagePath: sample.sourceImagePath || "",
    pageNumber: sample.pageNumber || null,
    issue
  };
}

function getCurrentWorkflowScopePages(artifacts = {}, counts = {}) {
  return numberOrZero(artifacts.imageDeck?.pageCount)
    || numberOrZero(counts.visualImages)
    || numberOrZero(counts.editableTasks)
    || numberOrZero(artifacts.editableHints?.summary?.pageCount)
    || numberOrZero(artifacts.editableRun?.textHints?.pageCount)
    || numberOrZero(counts.sourcePages);
}

function buildTextHintCoverageEvidence(artifacts = {}, expectedScopePages = 0, sourcePages = 0) {
  const ocr = artifacts.ocrTextHints || {};
  const editableSummary = artifacts.editableHints?.summary || artifacts.editableRun?.textHints || {};
  const expectedPages = numberOrZero(expectedScopePages)
    || numberOrZero(artifacts.imageDeck?.pageCount)
    || numberOrZero(editableSummary.pageCount)
    || numberOrZero(ocr.pageCount);
  const ocrPageCount = numberOrZero(ocr.pageCount);
  const editableHintPageCount = numberOrZero(editableSummary.pageCount);
  const editableReadyPages = numberOrZero(editableSummary.readyPages);
  const coveredPages = Math.max(ocrPageCount, editableReadyPages);
  const ocrTextCount = numberOrZero(ocr.textCount);
  const editableHintLineCount = numberOrZero(editableSummary.textLineCount);
  const lowConfidenceCount = numberOrZero(ocr.lowConfidenceCount);
  const correctedCount = numberOrZero(ocr.correctedCount);
  const hasAnyTextHints = Boolean(ocr.path || ocrTextCount || editableReadyPages || editableHintLineCount);
  const coverageRatio = expectedPages ? Math.min(1, coveredPages / expectedPages) : (coveredPages ? 1 : 0);
  const textLineCount = Math.max(ocrTextCount, editableHintLineCount);
  return {
    expectedPages,
    sourcePages: numberOrZero(sourcePages),
    partialScope: Boolean(sourcePages && expectedPages && expectedPages < sourcePages),
    coveredPages,
    coverageRatio,
    ready: Boolean(expectedPages && coveredPages >= expectedPages && textLineCount > 0),
    hasAnyTextHints,
    ocrPageCount,
    ocrTextCount,
    lowConfidenceCount,
    correctedCount,
    editableHintPageCount,
    editableReadyPages,
    editableHintLineCount,
    textLineCount,
    ocrPath: ocr.relativePath || ocr.path || "",
    editableHintsPath: artifacts.editableHints?.relativePath || artifacts.editableHints?.path || ""
  };
}

function buildPageFinalQualityEvidence(delivery = {}) {
  const pageEvidence = delivery.pageEvidence || {};
  const finalEvidence = delivery.finalEvidence || {};
  const finalGate = delivery.finalGate || {};
  const pageSummary = pageEvidence.summary || {};
  const finalSummary = finalEvidence.summary || {};
  const pageIssues = Array.isArray(pageEvidence.issues) ? pageEvidence.issues : [];
  const finalIssues = Array.isArray(finalEvidence.issues) ? finalEvidence.issues : [];
  const gateReasons = Array.isArray(finalGate.reasons) ? finalGate.reasons : [];
  const gateWarnings = Array.isArray(finalGate.warnings) ? finalGate.warnings : [];
  const gateChecks = finalGate.checks || {};
  const manifestIssueCount = pageIssues.filter((item) => /manifest/i.test(String(item?.issue || item))).length;
  const fullSlidePictures = extractFullSlidePictureCount(gateWarnings);
  const editabilityWarnings = gateWarnings.filter((item) => /editability warning/i.test(String(item || ""))).length;
  const totalPages = numberOrZero(pageEvidence.totalPages || pageSummary.total);
  const completePages = numberOrZero(pageSummary.completePages);
  const hasAnyEvidence = Boolean(pageEvidence.ok || finalEvidence.ok || totalPages || finalSummary.hasFinal);
  const pageEvidenceComplete = Boolean(pageEvidence.complete);
  const finalEvidenceComplete = Boolean(finalEvidence.complete);
  const ready = Boolean(
    pageEvidenceComplete
    && finalEvidenceComplete
    && gateChecks.validationPassed === true
    && gateChecks.noFullSlideRaster === true
    && finalSummary.validationFailuresEmpty !== false
    && !pageIssues.length
    && !finalIssues.length
  );
  return {
    ready,
    hasAnyEvidence,
    totalPages,
    completePages,
    pageEvidenceComplete,
    finalEvidenceComplete,
    dispatchedPages: numberOrZero(pageSummary.dispatched),
    recordedPages: numberOrZero(pageSummary.recorded),
    artifactsPages: numberOrZero(pageSummary.artifacts),
    validationPassedPages: numberOrZero(pageSummary.validationPassed),
    manifestContractPages: numberOrZero(pageSummary.manifestContract),
    hashMatchedPages: numberOrZero(pageSummary.hashes),
    pageIssueCount: pageIssues.length,
    manifestIssueCount,
    finalIssueCount: finalIssues.length,
    blockingIssueCount: pageIssues.length + finalIssues.length + gateReasons.length,
    finalValidationPassed: Boolean(finalSummary.validationPassed),
    runSummaryComplete: Boolean(finalSummary.runSummaryComplete),
    finalHashMatched: Boolean(finalSummary.hashesMatch),
    validationFailuresEmpty: finalSummary.validationFailuresEmpty !== false,
    fullSlidePictures,
    noFullSlideRaster: gateChecks.noFullSlideRaster === true,
    editabilityWarnings,
    gateLevel: finalGate.level || "",
    gateReasonCount: gateReasons.length,
    gateWarningCount: gateWarnings.length,
    sampleIssues: pageIssues.slice(0, 3).map((item) => item.issue || String(item)),
    finalIssues: finalIssues.slice(0, 3)
  };
}

function extractFullSlidePictureCount(warnings = []) {
  for (const warning of warnings) {
    const match = String(warning || "").match(/(\d+)\s+full-slide picture/i);
    if (match) return numberOrZero(match[1]);
  }
  return 0;
}

function looksLikeDryRun(value = "") {
  return /\b(regression|dry[-_\s]?run|passthrough|source[-_\s]?page[-_\s]?passthrough)\b/i.test(String(value || ""));
}

function normalizeBaseUrl(value = "") {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v\d+$/i, "");
}

function hasCjk(value = "") {
  return /[\u3400-\u9fff]/.test(String(value || ""));
}

function isAscii(value = "") {
  return /^[\x00-\x7f]+$/.test(String(value || ""));
}

function shortPath(value = "") {
  return String(value || "").replace(/^.*?(workspace[\\/].*)$/i, "$1");
}
