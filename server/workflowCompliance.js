import fsSync from "fs";
import { readWorkflowJob } from "./workflowJobs.js";
import { getProviderConfig } from "./providers.js";
import { testEditableRuntime } from "./workflowEditable.js";
import { scanWorkflowPageEvidence } from "./workflowPageEvidence.js";
import { scanWorkflowFinalEvidence } from "./workflowFinalEvidence.js";
import { isCodexPptFullDeckApprovalCurrent } from "./workflowApprovals.js";

export async function getWorkflowComplianceStatus(jobId) {
  const job = await readWorkflowJob(jobId);
  const providers = getProviderConfig();
  const artifacts = job.artifacts || {};
  const stages = job.stages || {};
  const tasks = Array.isArray(artifacts.editableWorkerTasks) ? artifacts.editableWorkerTasks : [];
  const sourcePages = numberOrZero(job.sourceMeta?.pageCount) || countArray(artifacts.renderedPages);
  const visualPages = currentVisualImages(artifacts).length;
  const imageDeckPages = numberOrZero(artifacts.imageDeck?.pageCount);
  const ocrPages = numberOrZero(artifacts.ocrTextHints?.pageCount);
  const promptPages = countArray(artifacts.editableWorkerPrompts);
  const recordedPages = tasks.filter((task) => task.status === "recorded").length;
  const failedTasks = tasks.filter((task) => task.status === "failed").length;
  const editableRun = artifacts.editableRun || {};
  const editableHints = artifacts.editableHints || {};
  const editableHintsSummary = editableHints.summary || editableRun.textHints || {};
  const textHintPageCount = numberOrZero(editableHintsSummary.pageCount);
  const textHintReadyPages = numberOrZero(editableHintsSummary.readyPages);
  const textHintLineCount = numberOrZero(editableHintsSummary.textLineCount);
  const textHintsReady = Boolean(editableRun.path && textHintPageCount && textHintReadyPages >= textHintPageCount);
  const editableNext = artifacts.editableNext?.next || editableRun.next || {};
  const final = artifacts.editableFinal || {};
  const finalValidation = final.validation || job.finalValidation || null;
  const finalEditability = final.pptxEditability || {};
  const usesExperimentalLocalFallback = envTruthy(process.env.PPT_TOOL_ALLOW_LOCAL_ASSET_FALLBACK);
  const hasModelWorkerEvent = hasExperimentalModelEvidence(job);
  const codexPptOutline = artifacts.codexPptOutline || {};
  const codexPptStyle = artifacts.codexPptStyle || {};
  const codexPptBackendDecision = artifacts.codexPptBackendDecision || {};
  const codexPptSlideState = summarizeCodexPptSlideState(artifacts);
  const codexPptGates = buildCodexPptGateSummary(job, artifacts, { visualPages, imageDeckPages });
  const codexPptSample = buildCodexPptSampleSummary(artifacts, codexPptGates);
  const visualBackend = buildVisualBackendSummary(artifacts, providers);
  const editpptDoctor = compactEditableDoctor(await testEditableRuntime({ timeoutMs: 60000 }).catch((error) => ({
    ok: false,
    configured: false,
    error: error.message || "editppt doctor 检查失败"
  })));
  const editpptImageBackend = extractEditpptImageBackendContract(editableRun);
  const pageEvidence = await scanWorkflowPageEvidence(job).catch((error) => ({
    ok: false,
    complete: false,
    totalPages: 0,
    summary: { total: 0, completePages: 0 },
    pages: [],
    issues: [{ pageId: "", issue: error.message || "页面证据扫描失败" }]
  }));
  const finalEvidence = await scanWorkflowFinalEvidence(job).catch((error) => ({
    ok: false,
    complete: false,
    summary: {},
    issues: [error.message || "最终证据扫描失败"]
  }));
  const runbook = buildSkillFirstRunbook({
    sourcePages,
    visualPages,
    imageDeckPages,
    promptPages,
    recordedPages,
    failedTasks,
    codexPptGates,
    codexPptSlideState,
    visualBackend,
    hasVisualSample: Boolean(artifacts.visualSample?.path),
    editableRun,
    textHintsReady,
    textHintPageCount,
    textHintReadyPages,
    editableNext,
    editpptDoctor,
    pageEvidence,
    final,
    finalEvidence,
    finalValidation
  });
  const checks = [
    makeCheck({
      id: "codex-ppt-approval-gates",
      label: "codex-ppt 确认关卡",
      status: codexPptGates.status,
      detail: codexPptGates.detail
    }),
    makeCheck({
      id: "codex-ppt-outline-artifact",
      label: "codex-ppt 大纲证据",
      status: codexPptOutline.path ? "pass" : "pending",
      detail: codexPptOutline.path ? `${codexPptOutline.slideCount || "?"} 页，${shortPath(codexPptOutline.markdownPath || codexPptOutline.path)}` : "等待 outline.md/json 证据"
    }),
    makeCheck({
      id: "codex-ppt-style-artifact",
      label: "codex-ppt 风格证据",
      status: codexPptStyle.path ? "pass" : "pending",
      detail: codexPptStyle.path ? shortPath(codexPptStyle.markdownPath || codexPptStyle.path) : "等待 style.md/json 证据"
    }),
    makeCheck({
      id: "codex-ppt-backend-decision",
      label: "codex-ppt 后端决策",
      status: codexPptBackendDecision.path ? "pass" : "pending",
      detail: codexPptBackendDecision.path
        ? `${codexPptBackendDecision.model || "图片模型"} 通过 ${codexPptBackendDecision.baseUrl || codexPptBackendDecision.provider || "已配置服务商"}`
        : "等待 backend.md/json 证据"
    }),
    makeCheck({
      id: "codex-ppt-sample-evidence",
      label: "codex-ppt 样张证据",
      status: codexPptSample.status,
      detail: codexPptSample.detail
    }),
    makeCheck({
      id: "codex-ppt-backend-fixed",
      label: "codex-ppt 固定后端",
      status: visualBackend.status,
      detail: visualBackend.detail
    }),
    makeCheck({
      id: "codex-ppt-visual-deck",
      label: "codex-ppt 视觉整套",
      status: visualPages && imageDeckPages ? "pass" : visualPages ? "warning" : "pending",
      detail: visualPages && imageDeckPages
        ? `${visualPages} 张视觉图，图片型 PPT 已组装`
        : visualPages
          ? `${visualPages} 张视觉图，图片型 PPT 尚未组装`
          : "等待视觉图片页"
    }),
    makeCheck({
      id: "codex-ppt-slide-state",
      label: "codex-ppt 图片页任务",
      status: codexPptSlideState.complete ? "pass" : codexPptSlideState.total ? "warning" : "pending",
      detail: codexPptSlideState.total
        ? `${codexPptSlideState.recorded}/${codexPptSlideState.total} 已记录，${codexPptSlideState.dispatched} 已派发`
        : "等待 deck_spec、图片页提示和 slide_run_state"
    }),
    makeCheck({
      id: "image-backend",
      label: "产品图片后端",
      status: providers.image.enabled && providers.image.configured ? "pass" : "warning",
      detail: providers.image.enabled && providers.image.configured
        ? `${providers.image.model || "图片模型"} 通过 ${providers.image.baseUrl || "已配置服务商"}`
        : "图片服务商尚未完整配置"
    }),
    makeCheck({
      id: "editppt-prepare",
      label: "editppt prepare",
      status: editableRun.prepared || fsSync.existsSync(pathFromArtifact(editableRun, "deck_manifest.json")) ? "pass" : "pending",
      detail: editableRun.path ? shortPath(editableRun.path) : "可编辑运行目录尚未准备"
    }),
    makeCheck({
      id: "editppt-doctor",
      label: "editppt doctor",
      status: editpptDoctor.ok ? "pass" : editpptDoctor.configured ? "warning" : "fail",
      detail: editpptDoctor.ok
        ? "运行环境 doctor 已通过"
        : editpptDoctor.error || editpptDoctor.next || "运行环境 doctor 未通过"
    }),
    makeCheck({
      id: "editppt-image-backend-contract",
      label: "editppt 图片契约",
      status: editpptImageBackend.present ? "pass" : editableRun.path ? "warning" : "pending",
      detail: editpptImageBackend.present
        ? `${editpptImageBackend.toolCall || editpptImageBackend.toolName || "editppt image"}${editpptImageBackend.model ? ` / ${editpptImageBackend.model}` : ""}`
        : "prepare 输出中没有找到 editppt 图片后端契约"
    }),
    makeCheck({
      id: "editppt-text-hints",
      label: "editppt 文字提示",
      status: !editableRun.path ? "pending" : textHintsReady ? "pass" : "warning",
      detail: !editableRun.path
        ? "等待 editppt prepare"
        : textHintsReady
          ? `${textHintReadyPages}/${textHintPageCount} 页，${textHintLineCount} 行文字`
          : "文字提示证据缺失或不完整；派发页面前请重新生成 editppt 提示"
    }),
    makeCheck({
      id: "page-worker-prompts",
      label: "页面提示",
      status: promptPages ? "pass" : editableRun.path ? "pending" : "pending",
      detail: promptPages ? `${promptPages} 个提示已就绪` : "等待可派发的页面提示"
    }),
    makeCheck({
      id: "editppt-record",
      label: "派发 / 记录",
      status: failedTasks ? "fail" : recordedPages && (!sourcePages || recordedPages >= sourcePages) ? "pass" : recordedPages ? "warning" : "pending",
      detail: `${recordedPages}/${sourcePages || promptPages || "?"} 页已记录${failedTasks ? `，${failedTasks} 页失败` : ""}`
    }),
    makeCheck({
      id: "page-worker-evidence",
      label: "页面任务证据",
      status: pageEvidence.complete ? "pass" : pageEvidence.totalPages ? "warning" : editableRun.path ? "warning" : "pending",
      detail: pageEvidence.totalPages
        ? `${pageEvidence.summary.completePages || 0}/${pageEvidence.totalPages} 页拥有完整 worker 产物`
        : "未找到页面任务产物证据"
    }),
    makeCheck({
      id: "editppt-finalize",
      label: "editppt finalize",
      status: final.path && finalEditability.editable !== false ? "pass" : final.path ? "warning" : "pending",
      detail: final.path ? shortPath(final.path) : `下一阶段：${editableNext.stage || "未知"}`
    }),
    makeCheck({
      id: "finalize-evidence",
      label: "最终生成证据",
      status: finalEvidence.complete ? "pass" : final.path ? "warning" : "pending",
      detail: finalEvidence.complete
        ? `${finalEvidence.summary?.expectedPages || "?"} 页，输出哈希已匹配`
        : final.path
          ? `${finalEvidence.issues?.length || 0} 个最终证据问题`
          : "等待 editppt finalize 输出"
    }),
    makeCheck({
      id: "experimental-fallbacks",
      label: "实验性兜底",
      status: usesExperimentalLocalFallback || hasModelWorkerEvent ? "warning" : "pass",
      detail: usesExperimentalLocalFallback
        ? "本地素材兜底开关已启用"
        : hasModelWorkerEvent
          ? "此任务中发现模型 worker 证据"
          : "未发现明确的实验性兜底开关"
    })
  ];
  const warnings = [];
  if (!codexPptOutline.path) warnings.push("缺少 codex-ppt 大纲证据；大纲审批需要 outline.md/json。");
  if (!codexPptStyle.path) warnings.push("缺少 codex-ppt 风格证据；风格审批需要 style.md/json。");
  if (!codexPptBackendDecision.path) warnings.push("缺少 codex-ppt 后端决策证据；后端审批需要 backend.md/json。");
  for (const missing of codexPptGates.missing) warnings.push(`缺少 codex-ppt 关卡证据：${missing}。`);
  if (codexPptSample.warning) warnings.push(codexPptSample.warning);
  if (visualBackend.status === "warning") warnings.push(visualBackend.warning);
  if (visualPages && !codexPptSlideState.complete) warnings.push("codex-ppt 图片页任务状态不完整；请检查 deck_spec、提示任务、派发和已记录图片结果。");
  if (!editpptDoctor.ok) warnings.push(`editppt doctor 警告：${editpptDoctor.error || editpptDoctor.next || "运行环境检查失败"}。`);
  if (editableRun.path && !editpptImageBackend.present) warnings.push("editppt prepare 未暴露必需的 editppt image generate/edit 后端契约。");
  if (editableRun.path && !textHintsReady) warnings.push("editppt 文字提示证据缺失或不完整；派发页面任务前请重新生成提示。");
  if (usesExperimentalLocalFallback) warnings.push("本地裁剪/修补兜底已启用；这不属于默认 skill-first 路径。");
  if (hasModelWorkerEvent) warnings.push("此任务存在模型 worker 证据；除非明确选择，否则应视为实验路径。");
  if (failedTasks) warnings.push(`${failedTasks} 个页面任务失败。`);
  if (!pageEvidence.complete && pageEvidence.totalPages) {
    warnings.push(`${pageEvidence.totalPages - (pageEvidence.summary.completePages || 0)} 页缺少完整页面任务证据。`);
  }
  if (pageEvidence.issues?.length) {
    for (const issue of pageEvidence.issues.slice(0, 5)) warnings.push(`页面证据问题${issue.pageId ? ` ${issue.pageId}` : ""}：${issue.issue}。`);
  }
  if (!finalEvidence.complete && final.path) warnings.push("最终生成证据不完整；请检查 run_summary、最终校验、复制输出和哈希匹配。");
  if (finalEvidence.issues?.length) {
    for (const issue of finalEvidence.issues.slice(0, 5)) warnings.push(`最终生成证据问题：${issue}。`);
  }
  if (final.path && finalEditability.editable === false) warnings.push("最终 PPTX 已存在，但可编辑性检查未通过。");
  if (finalValidation?.passed === false) warnings.push("最终校验未通过。");
  const nextActions = [];
  if (!codexPptOutline.path) nextActions.push("审批大纲关卡前，请先记录 codex-ppt outline.md/json。");
  if (!codexPptStyle.path) nextActions.push("审批风格关卡前，请先记录 codex-ppt style.md/json。");
  if (!codexPptBackendDecision.path) nextActions.push("审批后端关卡前，请先记录 codex-ppt backend.md/json。");
  if (codexPptGates.status !== "pass") nextActions.push("将视觉生成视为产品级前，请先记录 codex-ppt 大纲/风格/后端/样张确认。");
  if (visualBackend.status !== "pass") nextActions.push("请记录已确认的视觉图片后端，并在样张和全量生成中复用。");
  if (!editpptDoctor.ok) nextActions.push("派发页面任务前，请先修复 editppt doctor 问题。");
  if (!visualPages) nextActions.push("请完成 codex-ppt 视觉图片页生成。");
  else if (!imageDeckPages) nextActions.push("请把视觉图片组装成图片型 PPT。");
  else if (!editableRun.path) nextActions.push("请在图片型 PPT/页面上运行 editppt prepare。");
  else if (!textHintsReady) nextActions.push("生成页面提示前，请运行“重建文字提示”。");
  else if (!promptPages) nextActions.push("请从 editppt next 生成页面提示。");
  else if (failedTasks) nextActions.push("请修复根因后重置失败页面任务并重新派发。");
  else if (!recordedPages || (sourcePages && recordedPages < sourcePages)) nextActions.push("请派发真实页面任务，并通过 editppt 记录每一页。");
  else if (!pageEvidence.complete) nextActions.push("将记录视为产品级前，请补齐缺失的页面任务证据。");
  else if (!final.path) nextActions.push("所有页面记录完成后，请运行 editppt finalize。");
  else if (!finalEvidence.complete) nextActions.push("将 PPTX 视为产品级前，请处理最终生成证据不一致问题。");
  else nextActions.push("交付前请复核最终产物和校验结果。");
  const level = checks.some((check) => check.status === "fail")
    ? "blocked"
    : checks.some((check) => check.status === "warning")
      ? "warning"
      : checks.every((check) => check.status === "pass")
        ? "pass"
        : "pending";
  return {
    ok: true,
    jobId: job.id,
    level,
    title: titleForLevel(level),
    summary: summaryForLevel(level),
    counts: {
      sourcePages,
      visualPages,
      imageDeckPages,
      ocrPages,
      promptPages,
      recordedPages,
      textHintPages: textHintReadyPages,
      textHintPagesTotal: textHintPageCount,
      textHintLines: textHintLineCount,
      failedTasks,
      pageEvidencePages: pageEvidence.summary.completePages || 0,
      pageEvidenceTotal: pageEvidence.totalPages || 0,
      finalEvidenceComplete: finalEvidence.complete ? 1 : 0,
      approvalGates: codexPptGates.passed,
      approvalGatesTotal: codexPptGates.total,
      outlineArtifact: codexPptOutline.path ? 1 : 0,
      styleArtifact: codexPptStyle.path ? 1 : 0,
      backendDecisionArtifact: codexPptBackendDecision.path ? 1 : 0,
      codexPptSlideJobs: codexPptSlideState.total,
      codexPptSlideRecorded: codexPptSlideState.recorded
    },
    providers: {
      image: {
        configured: providers.image.configured,
        enabled: providers.image.enabled,
        baseUrl: providers.image.baseUrl,
        model: providers.image.model
      },
      ocr: {
        enabled: providers.ocr.enabled,
        provider: providers.ocr.provider
      }
    },
    editppt: {
      runDir: editableRun.path || "",
      nextStage: editableNext.stage || "",
      prepared: Boolean(editableRun.prepared || editableRun.path),
      doctor: editpptDoctor,
      imageBackend: editpptImageBackend,
      pageEvidence,
      finalEvidence
    },
    codexPpt: {
      outline: codexPptOutline,
      style: codexPptStyle,
      backendDecision: codexPptBackendDecision,
      slideState: codexPptSlideState,
      approvals: codexPptGates,
      sample: codexPptSample,
      backend: visualBackend
    },
    runbook,
    checks,
    warnings,
    nextActions: uniqueStrings([...(runbook.nextActions || []), ...nextActions]),
    updatedAt: new Date().toISOString()
  };
}

function makeCheck({ id, label, status, detail }) {
  return { id, label, status, detail };
}

function buildCodexPptGateSummary(job = {}, artifacts = {}, counts = {}) {
  const structured = new Set((Array.isArray(artifacts.codexPptApprovals) ? artifacts.codexPptApprovals : [])
    .filter((item) => item?.status === "approved" && item.gate)
    .map((item) => item.gate));
  if (!isCodexPptFullDeckApprovalCurrent(job)) structured.delete("fullDeck");
  const gateRules = [
    { id: "outline", label: "大纲确认", patterns: [/outline/i, /大纲|提纲/] },
    { id: "style", label: "风格确认", patterns: [/style/i, /风格|视觉/] },
    { id: "backend", label: "后端确认", patterns: [/backend|provider|model/i, /后端|模型/] },
    { id: "sample", label: "样张确认", patterns: [/sample/i, /样张|样稿|样页/] },
    { id: "fullDeck", label: "2 页测试通过后全量授权", patterns: [/full.?deck|generate/i, /整套|全量|继续生成/] }
  ];
  const gates = gateRules.map((rule) => ({
    id: rule.id,
    label: codexGateLabel(rule.id) || rule.label,
    passed: structured.has(rule.id)
  }));
  const passed = gates.filter((gate) => gate.passed).length;
  const missing = gates.filter((gate) => !gate.passed).map((gate) => gate.label);
  const started = Boolean(counts.visualPages || counts.imageDeckPages || artifacts.visualSample || artifacts.visualPrompts);
  const status = passed === gates.length ? "pass" : started ? "warning" : "pending";
  const detail = passed === gates.length
    ? "所有确认关卡都有记录证据"
    : started
      ? `${passed}/${gates.length} 个关卡已记录；缺少 ${missing.join("、")}`
      : "等待大纲/风格/后端/样张确认";
  return { status, detail, gates, missing, passed, total: gates.length };
}

function buildCodexPptSampleSummary(artifacts = {}, gates = {}) {
  const sampleApproved = Boolean((gates.gates || []).find((gate) => gate.id === "sample")?.passed);
  const sample = artifacts.visualSample || {};
  const hasArtifact = Boolean(sample.path);
  if (sampleApproved && hasArtifact) {
    return {
      status: "pass",
      detail: shortPath(sample.path),
      warning: "",
      artifact: sample
    };
  }
  if (sampleApproved && !hasArtifact) {
    return {
      status: "fail",
      detail: "已有样张确认，但缺少视觉样张产物",
      warning: "codex-ppt 样张确认已记录，但缺少视觉样张产物证据。",
      artifact: sample
    };
  }
  return {
    status: hasArtifact ? "warning" : "pending",
    detail: hasArtifact ? "样张产物已存在，但尚未确认" : "等待一页已确认的视觉样张",
    warning: hasArtifact ? "codex-ppt 视觉样张产物已存在，但样张确认尚未记录。" : "",
    artifact: sample
  };
}

function codexGateLabel(id = "") {
  const labels = {
    outline: "大纲确认",
    style: "风格确认",
    backend: "后端确认",
    sample: "样张确认",
    fullDeck: "2 页测试后全量授权"
  };
  return labels[id] || "";
}

function summarizeCodexPptSlideState(artifacts = {}) {
  const jobs = artifacts.codexPptSlideJobs || {};
  const runState = artifacts.codexPptSlideRunState || {};
  const tasks = Array.isArray(artifacts.codexPptSlideWorkerTasks) ? artifacts.codexPptSlideWorkerTasks : [];
  const recordedTasks = tasks.filter((task) => task.status === "recorded");
  const total = numberOrZero(runState.total || jobs.total || artifacts.codexPptSlidePrompts?.length || tasks.length);
  const recorded = numberOrZero(runState.recorded || jobs.recorded || recordedTasks.length);
  const dispatched = numberOrZero(runState.dispatched || jobs.dispatched || tasks.filter((task) => task.dispatchAt || task.status === "running" || task.status === "recorded").length);
  const pending = numberOrZero(runState.pending || jobs.pending || tasks.filter((task) => task.status === "ready").length);
  const failed = numberOrZero(runState.failed || jobs.failed || tasks.filter((task) => task.status === "failed").length);
  return {
    total,
    recorded,
    dispatched,
    pending,
    failed,
    recordedImagePaths: recordedTasks.filter((task) => task.imagePath).length,
    complete: total > 0 && recorded >= total && failed === 0,
    deckSpecPath: artifacts.codexPptDeckSpec?.path || "",
    slideJobsPath: jobs.path || "",
    slideRunStatePath: runState.path || ""
  };
}

function buildVisualBackendSummary(artifacts = {}, providers = {}) {
  const sample = artifacts.visualSample || {};
  const visualImages = currentVisualImages(artifacts);
  const approvedBackend = normalizeBackendRecord(artifacts.codexPptBackend || {});
  const backendRecords = [
    approvedBackend,
    normalizeBackendRecord(sample),
    ...visualImages.map(normalizeBackendRecord)
  ].filter((item) => item.provider || item.model || item.source);
  const configuredProvider = providers.image || {};
  const hasConfigured = configuredProvider.enabled && configuredProvider.configured;
  const uniqueKeys = [...new Set(backendRecords.map((item) => `${item.provider || item.source || "unknown"}:${item.model || ""}`))];
  if (!backendRecords.length && !hasConfigured) {
    return {
      status: "warning",
      provider: "",
      model: "",
      detail: "没有生成后端证据，且产品图片服务商未配置",
      warning: "尚未记录固定视觉图片后端证据。"
    };
  }
  if (!backendRecords.length) {
    return {
      status: "warning",
      provider: configuredProvider.baseUrl || "已配置服务商",
      model: configuredProvider.model || "",
      detail: "服务商已配置，但此任务没有固定后端记录",
      warning: "此任务没有记录审批后固定使用的视觉图片后端。"
    };
  }
  if (uniqueKeys.length > 1) {
    return {
      status: "warning",
      provider: uniqueKeys.join(", "),
      model: "",
      detail: `检测到多个后端记录：${uniqueKeys.join(", ")}`,
      warning: "样张/全量生成的视觉后端证据不一致。"
    };
  }
  const fixed = backendRecords[0];
  const passthrough = fixed.provider === "passthrough" || fixed.source === "source-page-passthrough" || fixed.dryRun;
  return {
    status: passthrough ? "warning" : "pass",
    provider: fixed.provider || fixed.source || configuredProvider.baseUrl || "图片后端",
    model: fixed.model || configuredProvider.model || "",
    detail: passthrough
      ? "视觉页使用了透传/验证链路输出，不是最终生成图片"
      : `${fixed.provider || fixed.source || "图片后端"}${fixed.model ? ` / ${fixed.model}` : ""}`,
    warning: passthrough
      ? "视觉图片包含透传/验证链路证据，而不是最终生成图片。"
      : ""
  };
}

function currentVisualImages(artifacts = {}) {
  return (Array.isArray(artifacts.visualImages) ? artifacts.visualImages : [])
    .filter((image) => image?.path && image.staleStyleReference !== true);
}

function buildSkillFirstRunbook({
  sourcePages = 0,
  visualPages = 0,
  imageDeckPages = 0,
  promptPages = 0,
  recordedPages = 0,
  failedTasks = 0,
  codexPptGates = {},
  codexPptSlideState = {},
  visualBackend = {},
  hasVisualSample = false,
  editableRun = {},
  textHintsReady = false,
  textHintPageCount = 0,
  textHintReadyPages = 0,
  editableNext = {},
  editpptDoctor = {},
  pageEvidence = {},
  final = {},
  finalEvidence = {},
  finalValidation = null
} = {}) {
  const gateStatus = new Map((codexPptGates.gates || []).map((gate) => [gate.id, Boolean(gate.passed)]));
  const firstThreeApproved = ["outline", "style", "backend"].every((gate) => gateStatus.get(gate));
  const allCodexApproved = ["outline", "style", "backend", "sample", "fullDeck"].every((gate) => gateStatus.get(gate));
  const sampleApproved = Boolean(gateStatus.get("sample"));
  const sampleComplete = Boolean(hasVisualSample && sampleApproved);
  const fullDeckReady = Boolean(firstThreeApproved && sampleComplete && gateStatus.get("fullDeck"));
  const codexSlidesComplete = Boolean(codexPptSlideState.complete);
  const visualCoverageComplete = Boolean(sourcePages > 0 && visualPages >= sourcePages);
  const imageDeckAvailable = imageDeckPages > 0;
  const hasImageDeck = Boolean(imageDeckAvailable && sourcePages > 0 && imageDeckPages >= sourcePages);
  const nextCodexDeckAction = visualCoverageComplete
    ? "image-deck/assemble"
    : "visual/generate";
  const hasEditableRun = Boolean(editableRun.path || editableRun.prepared);
  const hasFinal = Boolean(final.path);
  const expectedPages = sourcePages || imageDeckPages || pageEvidence.totalPages || 0;
  const allPagesRecorded = Boolean(recordedPages && (!expectedPages || recordedPages >= expectedPages));
  const finalValidationFailed = finalValidation?.passed === false;
  const stalePageEvidenceIds = getStalePageEvidenceIds(pageEvidence);
  const hasStalePageEvidence = stalePageEvidenceIds.length > 0;
  const steps = [
    makeRunbookStep({
      id: "source-render",
      title: "渲染源页面",
      summary: sourcePages ? `${sourcePages} 个源页面已渲染` : "导入源文件并渲染为页面图片",
      status: sourcePages ? "pass" : "active",
      action: sourcePages ? "" : "source/render"
    }),
    makeRunbookStep({
      id: "codex-ppt-approvals",
      title: "确认 codex-ppt 大纲、风格和后端",
      summary: firstThreeApproved ? "大纲、风格和后端已确认" : `缺少 ${missingGateLabels(codexPptGates, ["outline", "style", "backend"]).join("、")}`,
      status: firstThreeApproved ? "pass" : sourcePages ? "active" : "pending",
      action: firstThreeApproved ? "" : "approve outline/style/backend"
    }),
    makeRunbookStep({
      id: "codex-ppt-sample",
      title: "生成并确认一页视觉样张",
      summary: sampleComplete
        ? "样张产物和确认均已记录"
        : sampleApproved && !hasVisualSample
          ? "已有样张确认，但缺少样张产物证据"
          : firstThreeApproved
            ? "生成样张、复核，然后记录确认"
            : "等待大纲/风格/后端确认",
      status: sampleComplete ? "pass" : sampleApproved && !hasVisualSample ? "blocked" : firstThreeApproved ? "active" : "pending",
      action: sampleComplete ? "" : firstThreeApproved ? "visual/sample" : ""
    }),
    makeRunbookStep({
      id: "codex-ppt-full-deck",
      title: "生成 codex-ppt 图片型 PPT",
      summary: hasImageDeck
        ? `${visualPages} 张视觉图，图片型 PPT 已组装`
        : imageDeckAvailable
          ? `当前只有 ${imageDeckPages}/${sourcePages || "?"} 页图片测试稿，请继续生成剩余页面`
        : codexSlidesComplete
          ? `${codexPptSlideState.recorded}/${codexPptSlideState.total} 张 codex-ppt 图片页已记录；请组装图片型 PPT`
        : fullDeckReady
          ? visualPages ? "把视觉图组装成图片型 PPT" : codexSlidesStarted ? `${codexPptSlideState.recorded}/${codexPptSlideState.total} 个图片页任务结果已记录` : "为已确认的全量生成同步 codex-ppt 图片页任务"
          : sampleComplete
            ? `缺少 ${missingGateLabels(codexPptGates, ["fullDeck"]).join("、") || "全量授权"}`
            : "等待已确认的样张证据",
      status: hasImageDeck ? "pass" : fullDeckReady ? "active" : "pending",
      action: hasImageDeck ? "" : fullDeckReady ? nextCodexDeckAction : sampleComplete ? "approve fullDeck" : ""
    }),
    makeRunbookStep({
      id: "editppt-prepare",
      title: "准备 image-to-editable-ppt 运行",
      summary: hasEditableRun ? "editppt prepare 输出已存在" : hasImageDeck ? "基于完整图片型 PPT 运行 editppt prepare" : imageDeckAvailable ? `等待完整图片版，当前 ${imageDeckPages}/${sourcePages || "?"} 页` : "等待 codex-ppt 图片型 PPT",
      status: hasEditableRun ? "pass" : hasImageDeck ? "active" : "pending",
      action: hasEditableRun ? "" : hasImageDeck ? "editable/prepare" : ""
    }),
    makeRunbookStep({
      id: "editppt-text-hints",
      title: "校验 editppt 文字提示",
      summary: textHintsReady
        ? `${textHintReadyPages}/${textHintPageCount} 个文字提示页面已就绪`
        : hasEditableRun
          ? "生成页面提示前，请运行或重新生成 editppt 文字提示"
          : "等待 editppt prepare",
      status: textHintsReady ? "pass" : hasEditableRun ? "active" : "pending",
      action: textHintsReady ? "" : hasEditableRun ? "editable/hints" : ""
    }),
    makeRunbookStep({
      id: "page-workers",
      title: "派发并记录页面任务",
      summary: failedTasks
        ? `${failedTasks} 个页面任务失败`
        : pageEvidence.complete
          ? `${recordedPages}/${expectedPages || recordedPages} 页已记录并带证据`
          : hasEditableRun && textHintsReady
            ? `${recordedPages}/${expectedPages || "?"} 页已记录；下一 editppt 阶段 ${editableNext.stage || "未知"}`
            : hasEditableRun
              ? "等待 editppt 文字提示"
              : "等待 editppt prepare",
      status: failedTasks || hasStalePageEvidence ? "blocked" : pageEvidence.complete ? "pass" : hasEditableRun && textHintsReady ? "active" : "pending",
      action: failedTasks ? "reset failed page workers" : hasStalePageEvidence ? "retry-stale-page-evidence" : hasEditableRun && textHintsReady ? (promptPages ? "editable/dispatch + editable/record" : "editable/prompts") : ""
    }),
    makeRunbookStep({
      id: "editppt-finalize",
      title: "生成最终可编辑 PPTX",
      summary: finalEvidence.complete
        ? "最终 PPTX 证据完整"
        : finalValidationFailed
          ? "最终校验失败"
          : allPagesRecorded
            ? "所有页面已记录；请运行 editppt finalize"
            : "等待已记录页面 manifest",
      status: finalValidationFailed ? "blocked" : finalEvidence.complete ? "pass" : allPagesRecorded ? "active" : "pending",
      action: finalEvidence.complete ? "" : allPagesRecorded ? "editable/finalize" : ""
    }),
    makeRunbookStep({
      id: "review-deliver",
      title: "复核并交付",
      summary: hasFinal ? "复核最终产物、交付门禁和人工确认" : "等待最终可编辑 PPTX",
      status: hasFinal && finalEvidence.complete && allCodexApproved && visualBackend.status === "pass" ? "active" : "pending",
      action: hasFinal ? "review/approve" : ""
    })
  ];
  const active = steps.find((step) => step.status === "blocked") || steps.find((step) => step.status === "active") || steps.find((step) => step.status !== "pass") || steps[steps.length - 1];
  const blockers = steps.filter((step) => step.status === "blocked").map((step) => step.summary).filter(Boolean);
  if (visualBackend.status === "warning" && (visualPages || hasImageDeck || hasFinal)) {
    blockers.push(visualBackend.warning || "视觉后端证据尚未达到产品级要求。");
  }
  if (hasEditableRun && !editpptDoctor.ok) {
    blockers.push(editpptDoctor.error || editpptDoctor.next || "editppt doctor 未通过。");
  }
  const allowedActions = steps
    .filter((step) => step.action && (step.status === "active" || step.action === "retry-stale-page-evidence"))
    .map((step) => step.action);
  const nextActions = [
    active?.action ? `下一步：${active.action}` : "",
    active?.summary || ""
  ].filter(Boolean);
  return {
    currentStep: active?.id || "",
    currentTitle: active?.title || "",
    level: blockers.length ? "blocked" : steps.every((step) => step.status === "pass") ? "pass" : "working",
    summary: active?.summary || "",
    allowedActions: uniqueStrings(allowedActions),
    blockers: uniqueStrings(blockers),
    nextActions: uniqueStrings(nextActions),
    steps
  };
}

function makeRunbookStep({ id, title, summary, status, action = "" }) {
  return { id, title, summary, status, action };
}

function getStalePageEvidenceIds(pageEvidence = {}) {
  const issues = Array.isArray(pageEvidence.issues) ? pageEvidence.issues : [];
  const ids = new Set();
  for (const issue of issues) {
    const issueText = String(issue?.issue || issue?.code || issue || "");
    if (!/hash-mismatch-/i.test(issueText)) continue;
    const pageId = issue?.pageId || issue?.page || issue?.id || "";
    if (pageId) ids.add(String(pageId));
  }
  return Array.from(ids).sort();
}

function missingGateLabels(codexPptGates = {}, ids = []) {
  const gates = new Map((codexPptGates.gates || []).map((gate) => [gate.id, gate]));
  return ids
    .filter((id) => !gates.get(id)?.passed)
    .map((id) => gates.get(id)?.label || id);
}

function normalizeBackendRecord(record = {}) {
  return {
    provider: cleanToken(record.provider || record.baseUrl || record.backend || record.backendUsed || ""),
    model: cleanToken(record.model || record.imageModel || ""),
    source: cleanToken(record.source || ""),
    dryRun: Boolean(record.dryRun)
  };
}

function extractEditpptImageBackendContract(editableRun = {}) {
  const stdout = String(editableRun.editpptPrepare?.stdout || "");
  const parsed = parseImageBackendJson(stdout);
  const backend = parsed?.image_backend || parsed || {};
  const toolCall = cleanToken(backend.tool_call || "");
  const toolName = cleanToken(backend.tool_name || "");
  const present = /editppt image (generate|edit)|editppt image generate\/edit/i.test(`${toolCall} ${toolName} ${stdout}`);
  return {
    present,
    backendId: cleanToken(backend.backend_id || ""),
    toolName,
    toolCall,
    model: cleanToken(backend.model || ""),
    modePolicy: cleanToken(backend.mode_policy || "")
  };
}

function parseImageBackendJson(stdout = "") {
  const text = String(stdout || "");
  const marker = text.indexOf("\"image_backend\"");
  if (marker < 0) return null;
  const first = text.lastIndexOf("{", marker);
  const last = text.indexOf("\n}", marker);
  const end = last >= 0 ? last + 2 : text.lastIndexOf("}");
  if (first < 0 || end < first) return null;
  try {
    return JSON.parse(text.slice(first, end));
  } catch {
    return null;
  }
}

function compactEditableDoctor(result = {}) {
  const doctor = result.doctor || {};
  const ok = Boolean(result.ok && (doctor.ok !== false));
  return {
    ok,
    configured: Boolean(result.configured),
    runtime: result.runtime || null,
    next: cleanToken(doctor.next || result.error || ""),
    error: ok ? "" : cleanToken(result.error || doctor.error || ""),
    checks: Array.isArray(doctor.checks) ? doctor.checks.slice(0, 20) : undefined
  };
}

function hasExperimentalModelEvidence(job = {}) {
  const artifacts = job.artifacts || {};
  const events = Array.isArray(job.events) ? job.events : [];
  const artifactText = JSON.stringify({
    records: artifacts.editableRecords || [],
    tasks: artifacts.editableWorkerTasks || []
  });
  return /model-page|model worker|worker:model-page-pipeline/i.test(`${artifactText} ${events.map((event) => `${event.type || ""} ${event.message || ""}`).join(" ")}`);
}

function pathFromArtifact(artifact = {}, childName = "") {
  if (!artifact.path || !childName) return "";
  return `${artifact.path.replace(/[\\/]+$/, "")}/${childName}`;
}

function titleForLevel(level) {
  if (level === "pass") return "Skill 路径已对齐";
  if (level === "warning") return "Skill 路径有警告";
  if (level === "blocked") return "Skill 路径被阻断";
  return "Skill 路径待处理";
}

function summaryForLevel(level) {
  if (level === "pass") return "当前工作流证据匹配默认 codex-ppt 加 image-to-editable-ppt 路径。";
  if (level === "warning") return "工作流可以继续，但产品级交付前至少有一项需要复核。";
  if (level === "blocked") return "最终交付前必须先处理失败任务或校验问题。";
  return "工作流尚未完成所有必需的 skill-first 阶段。";
}

function countArray(value) {
  return Array.isArray(value) ? value.length : 0;
}

function numberOrZero(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function envTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function shortPath(value = "") {
  return String(value || "").replace(/^.*?(workspace[\\/].*)$/i, "$1");
}

function cleanToken(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 300);
}

function uniqueStrings(items = []) {
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))];
}
