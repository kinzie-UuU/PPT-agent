import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { deriveWorkflowDeliveryStatus } from "../shared/workflowDeliveryStatus.js";
import { readWorkflowJob } from "./workflowJobs.js";
import { scanWorkflowPageEvidence } from "./workflowPageEvidence.js";
import { scanWorkflowFinalEvidence } from "./workflowFinalEvidence.js";
import { listWorkflowEditableWorkerTasks } from "./workflowWorkerQueue.js";
import { getExternalImageAuthorizationStatus } from "./workflowAuthorizations.js";

export async function getWorkflowDeliveryStatus(id) {
  const job = await readWorkflowJob(id);
  const workerTaskBundle = await listWorkflowEditableWorkerTasks(job.id).catch(() => null);
  const sourceMeta = await readSafeArtifactJson(job, job.artifacts?.sourceMeta?.path);
  const finalValidation = await readSafeArtifactJson(job, job.artifacts?.editableFinal?.validation?.path);
  const artifacts = {
    ...(job.artifacts || {}),
    editableWorkerTasks: Array.isArray(workerTaskBundle?.tasks)
      ? workerTaskBundle.tasks
      : job.artifacts?.editableWorkerTasks
  };
  const enrichedJob = {
    ...job,
    artifacts,
    sourceMeta: sourceMeta.data || null,
    finalValidation: finalValidation.data || null
  };
  const status = deriveWorkflowDeliveryStatus(enrichedJob);
  const coverage = buildCoverage(enrichedJob);
  const pageEvidenceOptions = {
    skipPowerPointOpenability: !isFullDeliveryCoverageCandidate(coverage)
  };
  const pageEvidence = await scanWorkflowPageEvidence(enrichedJob, pageEvidenceOptions).catch((error) => ({
    ok: false,
    complete: false,
    totalPages: 0,
    summary: { total: 0, completePages: 0 },
    issues: [{ pageId: "", issue: error.message || "page evidence scan failed" }]
  }));
  const finalEvidence = await scanWorkflowFinalEvidence(enrichedJob).catch((error) => ({
    ok: false,
    complete: false,
    summary: {},
    issues: [error.message || "final evidence scan failed"]
  }));
  const finalGate = buildFinalDeliveryGate(enrichedJob, status, pageEvidence, finalEvidence);
  const deliveryStatus = alignDeliveryStatusWithFinalGate(status, finalGate, enrichedJob);
  return {
    ok: true,
    jobId: job.id,
    status: deliveryStatus,
    finalGate,
    coverage,
    sourceMeta: {
      artifact: job.artifacts?.sourceMeta || null,
      exists: sourceMeta.exists,
      error: sourceMeta.error,
      data: compactSourceMeta(sourceMeta.data)
    },
    validation: {
      artifact: job.artifacts?.editableFinal?.validation || null,
      exists: finalValidation.exists,
      error: finalValidation.error,
      data: finalValidation.data
    },
    final: {
      artifact: job.artifacts?.editableFinal || null,
      editability: job.artifacts?.editableFinal?.pptxEditability || null
    },
    pageEvidence,
    finalEvidence
  };
}

function isFullDeliveryCoverageCandidate(coverage = {}) {
  const sourcePages = numberOrZero(coverage.sourcePages);
  const finalPages = numberOrZero(coverage.finalPages);
  return Boolean(sourcePages && finalPages && finalPages >= sourcePages);
}

export function alignDeliveryStatusWithFinalGate(status = {}, finalGate = {}, job = {}) {
  if (!finalGate?.level) return status;
  if (finalGate.level === "ready") {
    const facts = withFinalPptxFact(status.facts, "可交付");
    return status.level === "ready"
      ? { ...status, facts }
      : {
          ...status,
          level: "ready",
          title: "可以交付",
          facts,
          summary: finalGate.summary || status.summary || "最终 PPTX 已通过交付检查。"
        };
  }
  if (finalGate.level === "blocked") {
    const reason = firstNonEmpty([...(finalGate.reasons || []), ...(finalGate.warnings || [])]) || "最终交付门禁未通过。";
    const recoveryStep = inferBlockedGateRecoveryStep(finalGate, job);
    return {
      ...status,
      level: "blocked",
      title: "交付被阻断",
      summary: finalGate.summary || "最终交付门禁未通过。",
      facts: withFinalPptxFact(status.facts, "被阻断"),
      warnings: uniqueStrings([...(status.warnings || []), ...(finalGate.reasons || []), ...(finalGate.warnings || [])]),
      nextStep: recoveryStep || {
        id: "review-delivery-gate",
        label: "复核交付门禁",
        reason,
        description: reason
      },
      nextActions: uniqueStrings([
        recoveryStep ? `${recoveryStep.label}：${recoveryStep.description}` : `复核交付门禁：${reason}`,
        ...filterBlockedGateNextActions(status.nextActions || [], reason)
      ])
    };
  }
  if (finalGate.level === "draft") {
    const warning = firstNonEmpty(finalGate.warnings || []) || "最终 PPTX 仍有交付警告，需要人工复核。";
    return {
      ...status,
      level: status.level === "blocked" ? "blocked" : "warning",
      title: status.level === "blocked" ? status.title : "草稿需复核",
      summary: finalGate.summary || status.summary || "最终 PPTX 可下载为草稿，但尚未达到产品级交付。",
      facts: withFinalPptxFact(status.facts, finalGate.downloadable ? "草稿" : "需复核"),
      warnings: uniqueStrings([...(status.warnings || []), ...(finalGate.warnings || [])]),
      nextStep: status.level === "blocked" && status.nextStep
        ? status.nextStep
        : {
            id: "review-delivery-gate",
            label: "复核交付门禁",
            description: warning
          },
      nextActions: uniqueStrings([`复核交付门禁：${warning}`, ...(status.nextActions || [])])
    };
  }
  return status;
}

function withFinalPptxFact(facts = [], value = "") {
  if (!Array.isArray(facts) || !value) return facts;
  return facts.map((fact) => fact?.label === "最终 PPTX" ? { ...fact, value } : fact);
}

function filterBlockedGateNextActions(actions = [], reason = "") {
  const blocksExternalProvider = /额度|余额|鉴权|API Key|provider|quota|billing|unauthorized/i.test(reason);
  return actions.filter((action) => {
    const text = String(action || "");
    if (!text.trim()) return false;
    if (/下载最终 PPT|下载最终|复核并下载|download/i.test(text)) {
      return false;
    }
    if (blocksExternalProvider && /启动页面 worker|运行受保护的 worker|外部图片 API|start-page-workers/i.test(text)) {
      return false;
    }
    return true;
  });
}

function inferBlockedGateRecoveryStep(finalGate = {}, job = {}) {
  const text = [...(finalGate.reasons || []), ...(finalGate.warnings || [])].join(" ");
  const tasks = Array.isArray(job.artifacts?.editableWorkerTasks) ? job.artifacts.editableWorkerTasks : [];
  const readyPages = tasks
    .filter((task) => task.status === "ready")
    .map((task) => cleanPageId(task.pageId))
    .filter(Boolean);
  if (!readyPages.length) return null;
  if (!/页面任务证据不完整|final visual qa|editable-preview-missing|asset-contact-sheet-missing|重跑|rerun/i.test(text)) return null;
  const pageNumbers = readyPages.map(pageNumberFromPageId).filter(Boolean);
  const externalImageCallsPerPage = getEditableWorkerExternalImageCallsPerPage();
  const externalImageCalls = Math.max(0, readyPages.length * externalImageCallsPerPage);
  const batchPlan = buildBlockedGateEditableBatchPlan(readyPages, externalImageCallsPerPage);
  const authorization = getExternalImageAuthorizationStatus(job, {
    scope: "editable-workers",
    imageCalls: externalImageCalls,
    pageSelection: readyPages.join(","),
    pageNumbers
  });
  const authorizationText = authorization.persisted
    ? "页面级额度授权账本已记录"
    : `缺少页面级额度授权账本（${readyPages.join(", ")}，${externalImageCalls} 次调用）`;
  const description = `${readyPages.join(", ")} 已重置为就绪状态；${authorizationText}；启动 image-to-editable-ppt 页面 worker 前还需要确保 LLM provider 可用。`;
  return {
    id: "start-page-workers",
    label: "重跑可编辑页面",
    reason: description,
    description,
    pageSelection: readyPages.join(","),
    pages: readyPages,
    externalImageCalls,
    externalImageCallsPerPage,
    batchPlan,
    authorization: {
      required: true,
      persisted: Boolean(authorization.persisted),
      scope: authorization.scope,
      imageCalls: authorization.imageCalls,
      pageSelection: authorization.pageSelection,
      pages: authorization.pages,
      warning: authorization.warning
    }
  };
}

function buildBlockedGateEditableBatchPlan(pages = [], imageCallsPerPage = 8) {
  const cleanPages = pages.filter(Boolean);
  const defaultBatchPages = cleanPages.slice(0, Math.min(2, cleanPages.length));
  return {
    totalPages: cleanPages.length,
    pageSelection: cleanPages.join(","),
    defaultBatchSize: defaultBatchPages.length,
    defaultBatchPages,
    defaultBatchPageSelection: defaultBatchPages.join(","),
    defaultBatchExternalImageCalls: defaultBatchPages.length * imageCallsPerPage,
    externalImageCallsPerPage: imageCallsPerPage,
    whyBatch: "默认先跑 2 页，确认模型、额度和页面证据稳定后再继续剩余页面。",
    preserveSuccessfulPages: true,
    requiresExplicitConfirmation: true
  };
}

function pageNumberFromPageId(pageId = "") {
  const match = String(pageId || "").match(/^page_0*(\d+)$/i);
  return match ? Number(match[1]) : 0;
}

function getEditableWorkerExternalImageCallsPerPage() {
  const value = Number(
    process.env.PPT_EXTERNAL_IMAGE_CALLS_PER_PAGE
      || process.env.PPT_MAX_VISUAL_ASSET_JOBS
      || 8
  );
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : 8;
}

export function buildFinalDeliveryGate(job, status = {}, pageEvidence = {}, finalEvidence = {}) {
  const artifacts = job.artifacts || {};
  const final = artifacts.editableFinal || {};
  const editability = final.pptxEditability || {};
  const tasks = Array.isArray(artifacts.editableWorkerTasks) ? artifacts.editableWorkerTasks : [];
  const finalValidation = job.finalValidation || null;
  const hasFinal = Boolean(final.path);
  const visualFreshness = inspectVisualEditableFreshness(artifacts);
  const invalidatedFinal = inspectInvalidatedFinal(job, hasFinal);
  const manualReviewRecorded = isManualReviewCurrent(artifacts.manualReview, final);
  const reasons = [];
  const warnings = [];
  const failedTasks = tasks.filter(isFailedEditableWorkerTask);
  const failedTaskSummary = summarizeFailedEditableWorkerTasks(failedTasks);
  const fullSlidePictures = numberOrZero(editability.fullSlidePictures);
  const rasterOnlySlides = Number.isFinite(Number(editability.rasterOnlySlides))
    ? numberOrZero(editability.rasterOnlySlides)
    : fullSlidePictures;
  const rasterBackgroundSlides = Number.isFinite(Number(editability.rasterBackgroundSlides))
    ? numberOrZero(editability.rasterBackgroundSlides)
    : Math.max(0, fullSlidePictures - rasterOnlySlides);
  const editabilityWarnings = Array.isArray(editability.warnings) ? editability.warnings : [];
  const hasExperimentalEvidence = hasExperimentalModelEvidence(job) || envTruthy(process.env.PPT_TOOL_ALLOW_LOCAL_ASSET_FALLBACK);
  const localTextOnlyMultiPageEvidence = hasLocalTextOnlyMultiPageEvidence(job);
  const pageEvidenceComplete = Boolean(pageEvidence.complete);
  const finalEvidenceComplete = Boolean(finalEvidence.complete);
  const codexPptEvidence = buildCodexPptDeliveryEvidence(job);
  const sourcePages = numberOrZero(job.sourceMeta?.pageCount) || countArray(artifacts.renderedPages);
  const finalPages = numberOrZero(final.summary?.page_count || editability.slideCount || job.finalValidation?.slides);
  const partialSourceCoverage = Boolean(hasFinal && sourcePages && finalPages && finalPages < sourcePages);

  if (!hasFinal) warnings.push("最终可编辑 PPTX 尚未生成。");
  if (invalidatedFinal.exists) {
    warnings.push(invalidatedFinal.reason);
  }
  if (failedTaskSummary) reasons.push(failedTaskSummary);
  if (hasFinal && !pageEvidenceComplete) {
    reasons.push(summarizePageEvidenceIssue(pageEvidence));
  }
  if (hasFinal && !finalEvidenceComplete) {
    reasons.push(summarizeFinalEvidenceIssue(finalEvidence));
  }
  if (hasFinal && visualFreshness.stale) {
    reasons.push(visualFreshness.reason);
  }
  if (hasFinal && localTextOnlyMultiPageEvidence) {
    reasons.push("image-to-editable-ppt used a local text-only multi-page worker; run model page workers for product delivery.");
  }
  if (hasFinal && !codexPptEvidence.approvalsComplete) {
    reasons.push(`codex-ppt approval evidence is incomplete: missing ${codexPptEvidence.missingApprovals.join(", ")}.`);
  }
  if (hasFinal && !codexPptEvidence.outlineEvidenceComplete) {
    reasons.push("codex-ppt outline.md/json artifact evidence is missing.");
  }
  if (hasFinal && !codexPptEvidence.styleEvidenceComplete) {
    reasons.push("codex-ppt style.md/json artifact evidence is missing.");
  }
  if (hasFinal && !codexPptEvidence.backendDecisionComplete) {
    reasons.push("codex-ppt backend.md/json artifact evidence is missing.");
  }
  if (hasFinal && !codexPptEvidence.sampleEvidenceComplete) {
    reasons.push("codex-ppt sample artifact evidence is missing.");
  }
  if (hasFinal && !codexPptEvidence.backendFixed) {
    reasons.push(codexPptEvidence.backendIssue || "codex-ppt fixed image backend evidence is incomplete.");
  }
  if (hasFinal && !codexPptEvidence.slideRunComplete) {
    reasons.push("codex-ppt slide job state is incomplete: deck_spec, prompt jobs, dispatch, or recorded image results are missing.");
  }
  if (!final.validation?.path) warnings.push("最终校验 JSON 尚未生成。");
  if (finalValidation?.passed === false) reasons.push("最终校验未通过。");
  if (editability.editable === false || rasterOnlySlides > 0) {
    warnings.push("OpenXML 可编辑性检查存在警告。");
  }
  if (rasterOnlySlides) {
    warnings.push(`检测到 ${rasterOnlySlides} 个整页栅格图风险。`);
  }
  if (rasterBackgroundSlides) {
    warnings.push(`检测到 ${rasterBackgroundSlides} 个全页背景图，请人工复核它不是整页截图。`);
  }
  if (editabilityWarnings.length) {
    warnings.push(...editabilityWarnings.map((item) => `可编辑性警告：${item}`));
  }
  if (hasExperimentalEvidence) {
    warnings.push("当前工作流存在实验性本地/模型重建证据，需要复核。");
  }
  if (localTextOnlyMultiPageEvidence) {
    warnings.push("当前工作流存在本地纯文本多页 worker 证据，仅适用于实验室/回归验证。");
  }
  if (hasFinal && !manualReviewRecorded) {
    warnings.push("尚未记录逐页人工视觉复核。");
  }
  if (partialSourceCoverage) {
    warnings.push(`当前最终 PPT 只覆盖 ${finalPages}/${sourcePages} 个源页面；可作为当前测试范围下载，但不能作为完整产品交付。`);
  }

  const level = !hasFinal
    ? reasons.length
      ? "blocked"
      : "pending"
    : reasons.length
      ? "blocked"
      : warnings.length
      ? "draft"
      : status.level === "ready"
        ? "ready"
        : "pending";
  return {
    level,
    label: gateLabel(level),
    title: gateTitle(level),
    summary: gateSummary(level),
    productReady: level === "ready" && !partialSourceCoverage,
    downloadable: hasFinal && level !== "blocked",
    reasons,
    warnings: uniqueStrings(warnings),
    checks: {
      hasFinal,
      validationPassed: finalValidation?.passed === true,
      editabilityPassed: editability.editable === true && rasterOnlySlides === 0,
      noFullSlideRaster: rasterOnlySlides === 0,
      noExperimentalEvidence: !hasExperimentalEvidence,
      noLocalTextOnlyMultiPageEvidence: !localTextOnlyMultiPageEvidence,
      manualReviewRecorded,
      pageEvidenceComplete,
      finalEvidenceComplete,
      fullSourceCoverage: !partialSourceCoverage,
      sourcePages,
      finalPages,
      editableMatchesCurrentVisuals: !visualFreshness.stale,
      powerPointOpenable: finalEvidence.summary?.powerPointOpenable ?? final.powerPointOpenability?.openable ?? null,
      codexPptOutlineRecorded: codexPptEvidence.outlineEvidenceComplete,
      codexPptStyleRecorded: codexPptEvidence.styleEvidenceComplete,
      codexPptBackendDecisionRecorded: codexPptEvidence.backendDecisionComplete,
      codexPptApprovalsComplete: codexPptEvidence.approvalsComplete,
      codexPptSampleRecorded: codexPptEvidence.sampleEvidenceComplete,
      codexPptBackendFixed: codexPptEvidence.backendFixed,
      codexPptSlideRunComplete: codexPptEvidence.slideRunComplete
    },
    visualFreshness,
    invalidatedFinal,
    codexPptEvidence
  };
}

function isFailedEditableWorkerTask(task = {}) {
  const status = String(task.status || "");
  if (status === "ready" || status === "pending") return false;
  return task.status === "failed"
    || task.validationStatus === "failed"
    || (task.status === "recorded" && task.evidence?.validationPassed === false)
    || Boolean(task.evidence?.validationError);
}

function summarizeFailedEditableWorkerTasks(tasks = []) {
  const failed = tasks.filter(Boolean);
  if (!failed.length) return "";
  const pages = failed.map((task) => cleanPageId(task.pageId)).filter(Boolean).join(", ");
  const errors = failed.map((task) => [
    task.error,
    task.message,
    task.evidence?.validationError,
    ...(Array.isArray(task.evidence?.outputContractIssues) ? task.evidence.outputContractIssues : [])
  ].filter(Boolean).join(" ")).join("\n");
  const prefix = pages ? `页面 worker 失败：${pages}。` : `${failed.length} 个页面 worker 失败。`;
  if (/额度已用尽|余额|insufficient[_\s-]?quota|quota|credit|billing/i.test(errors)) {
    return `${prefix}模型服务额度已用尽或余额不足，请更换/充值 LLM provider 后重跑这些 editable 页面任务。`;
  }
  if (/HTTP\s*401|unauthorized|invalid.*api.*key|api.*key.*invalid/i.test(errors)) {
    return `${prefix}模型服务鉴权失败，请检查 LLM provider 的 API Key/网关配置后重跑这些 editable 页面任务。`;
  }
  return `${prefix}请查看页面 worker 日志并重跑失败页面。`;
}

function inspectVisualEditableFreshness(artifacts = {}) {
  const visualTimes = [
    artifacts.imageDeck?.createdAt,
    artifacts.visualManifest?.createdAt,
    artifacts.visualQuality?.createdAt,
    ...(Array.isArray(artifacts.visualImages) ? artifacts.visualImages.map((image) => image?.createdAt) : [])
  ].map(toTime).filter((time) => time > 0);
  const latestVisualAt = visualTimes.length ? Math.max(...visualTimes) : 0;
  const editableTimes = [
    artifacts.editableRun?.createdAt,
    artifacts.editableHints?.createdAt,
    artifacts.editableFinal?.createdAt
  ].map(toTime).filter((time) => time > 0);
  const latestEditableAt = editableTimes.length ? Math.max(...editableTimes) : 0;
  const stale = Boolean(latestVisualAt && latestEditableAt && latestVisualAt > latestEditableAt);
  return {
    stale,
    latestVisualAt: latestVisualAt ? new Date(latestVisualAt).toISOString() : "",
    latestEditableAt: latestEditableAt ? new Date(latestEditableAt).toISOString() : "",
    reason: stale
      ? "codex-ppt visual images are newer than the editable rebuild; rerun image-to-editable-ppt before final delivery."
      : ""
  };
}

function gateTitle(level) {
  if (level === "ready") return "产品级交付已就绪";
  if (level === "draft") return "仅可作为可编辑草稿";
  if (level === "blocked") return "最终交付被阻断";
  return "最终交付待处理";
}

function gateLabel(level) {
  if (level === "ready") return "editable-final.pptx";
  if (level === "draft") return "editable-draft.pptx";
  if (level === "blocked") return "not-deliverable.pptx";
  return "pending-delivery";
}

function gateSummary(level) {
  if (level === "ready") return "最终可编辑 PPTX 已通过结构、可编辑性和工作流证据检查。";
  if (level === "draft") return "最终 PPTX 已存在，但仍有警告项；复核或补齐证据前只能作为草稿。";
  if (level === "blocked") return "存在必须修复的失败任务、校验失败或证据缺口，当前不能作为最终 PPT 交付。";
  return "工作流尚未到达最终交付阶段。";
}

function inspectInvalidatedFinal(job = {}, hasFinal = false) {
  const finalPath = path.join(job.dirs?.final || "", "editable-final.pptx");
  const invalidationEvent = (Array.isArray(job.events) ? job.events : [])
    .slice()
    .reverse()
    .find((event) => event?.type === "editable.fresh_run_invalidated"
      && Array.isArray(event.details?.invalidated)
      && event.details.invalidated.includes("editableFinal"));
  const exists = Boolean(!hasFinal && finalPath && fsSync.existsSync(finalPath) && invalidationEvent);
  return {
    exists,
    path: exists ? finalPath : "",
    invalidatedAt: exists ? invalidationEvent.createdAt || "" : "",
    invalidatedReason: exists ? cleanBackendToken(invalidationEvent.details?.reason || "") : "",
    reason: exists
      ? "检测到旧 editable-final.pptx 文件仍在磁盘上，但它已被 fresh editppt 运行作废；不能把这个旧文件当作最终交付。"
      : ""
  };
}

function compactSourceMeta(data) {
  if (!data) return null;
  return {
    version: data.version || 1,
    ok: data.ok === true,
    renderer: data.renderer || "",
    pageCount: numberOrZero(data.pageCount),
    warnings: Array.isArray(data.warnings) ? data.warnings : [],
    startedAt: data.startedAt || "",
    finishedAt: data.finishedAt || ""
  };
}

function buildCoverage(job) {
  const artifacts = job.artifacts || {};
  const final = artifacts.editableFinal || {};
  const editability = final.pptxEditability || {};
  return {
    sourcePages: numberOrZero(job.sourceMeta?.pageCount) || countArray(artifacts.renderedPages),
    renderedPages: countArray(artifacts.renderedPages),
    visualPages: countArray(artifacts.visualImages),
    imageDeckPages: numberOrZero(artifacts.imageDeck?.pageCount),
    ocrPages: numberOrZero(artifacts.ocrTextHints?.pageCount),
    workerBriefPages: numberOrZero(artifacts.workerBriefs?.pageCount),
    finalPages: numberOrZero(final.summary?.page_count || editability.slideCount),
    validationExpectedPages: numberOrZero(job.finalValidation?.expected_pages),
    validationSlides: numberOrZero(job.finalValidation?.slides)
  };
}

async function readSafeArtifactJson(job, filePath) {
  if (!filePath) return { exists: false, data: null, error: "" };
  const resolved = path.resolve(String(filePath));
  const jobRoot = path.resolve(job.rootDir);
  if (!isInsidePath(resolved, jobRoot)) {
    return { exists: false, data: null, error: "Artifact path is outside workflow job root" };
  }
  if (!fsSync.existsSync(resolved)) return { exists: false, data: null, error: "Artifact file not found" };
  try {
    const raw = await fs.readFile(resolved, "utf8");
    return { exists: true, data: JSON.parse(raw), error: "" };
  } catch (error) {
    return { exists: true, data: null, error: error.message || "Failed to parse artifact JSON" };
  }
}

function isInsidePath(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function countArray(value) {
  return Array.isArray(value) ? value.length : 0;
}

function numberOrZero(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function toTime(value = "") {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? time : 0;
}

function hasExperimentalModelEvidence(job = {}) {
  const artifacts = job.artifacts || {};
  const events = Array.isArray(job.events) ? job.events : [];
  const artifactText = JSON.stringify({
    records: artifacts.editableRecords || [],
    tasks: artifacts.editableWorkerTasks || []
  });
  const eventText = events.map((event) => `${event.type || ""} ${event.message || ""}`).join(" ");
  return /model-page|model worker|worker:model-page-pipeline/i.test(`${artifactText} ${eventText}`);
}

function hasLocalTextOnlyMultiPageEvidence(job = {}) {
  const artifacts = job.artifacts || {};
  const runs = Array.isArray(artifacts.editableWorkerBatchRuns) ? artifacts.editableWorkerBatchRuns : [];
  if (runs.some((run) => run?.mode === "local" && estimateRunnerPageCount(run) > 1)) return true;
  if (runs.some((run) => run?.mode === "local" && (run.experimentalLocalBatch || run.nonProductDelivery))) return true;

  const records = Array.isArray(artifacts.editableRecords) ? artifacts.editableRecords : [];
  const localRecordPages = new Set(records
    .filter((record) => /local-page-worker|local-worker|local-ocr-text-rebuild/i.test(JSON.stringify(record || {})))
    .map((record) => cleanPageId(record.pageId || record.page || ""))
    .filter(Boolean));
  if (localRecordPages.size > 1) return true;

  const localRebuilds = Array.isArray(artifacts.editableLocalRebuilds) ? artifacts.editableLocalRebuilds : [];
  const localRebuildPages = new Set(localRebuilds
    .map((record) => cleanPageId(record.pageId || record.page || ""))
    .filter(Boolean));
  return localRebuildPages.size > 1;
}

function estimateRunnerPageCount(run = {}) {
  const summaryTotal = Number(run.taskSummary?.total || run.summary?.taskSummary?.total || run.summary?.requested || run.succeeded || 0);
  if (Number.isFinite(summaryTotal) && summaryTotal > 0) return summaryTotal;
  const pages = String(run.pages || "").split(/[,\s]+/).filter(Boolean);
  if (pages.length) return pages.length;
  const maxPages = Number(run.maxPages || 0);
  return Number.isFinite(maxPages) ? maxPages : 0;
}

function cleanPageId(value = "") {
  const text = String(value || "").trim().toLowerCase();
  const match = text.match(/\d+/);
  return match ? `page_${String(Number(match[0])).padStart(3, "0")}` : "";
}

function envTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function uniqueStrings(items = []) {
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))];
}

function firstNonEmpty(items = []) {
  return items.find((item) => String(item || "").trim()) || "";
}

function summarizePageEvidenceIssue(pageEvidence = {}) {
  const issues = Array.isArray(pageEvidence.issues) ? pageEvidence.issues : [];
  const openFailedPages = new Set(
    issues
      .filter((item) => String(item?.issue || "") === "page-pptx-powerpoint-open-failed")
      .map((item) => item.pageId)
      .filter(Boolean)
  );
  if (openFailedPages.size) {
    return `页面级 PPTX 有 ${openFailedPages.size} 页无法被 PowerPoint 打开，需要重置并重新运行这些 image-to-editable-ppt 页面任务。`;
  }
  const hashPages = new Set(
    issues
      .filter((item) => /^hash-mismatch-/.test(String(item?.issue || "")))
      .map((item) => item.pageId)
      .filter(Boolean)
  );
  if (hashPages.size) {
    return `页面任务证据哈希已过期：${hashPages.size} 页需要重置并重新运行 editable 页面任务。`;
  }
  const failedPages = new Set(issues.map((item) => item.pageId).filter(Boolean));
  if (failedPages.size) {
    return `页面任务证据不完整：${failedPages.size} 页需要复核或重跑。`;
  }
  return "页面任务证据不完整，需要复核或重跑可编辑页面任务。";
}

function summarizeFinalEvidenceIssue(finalEvidence = {}) {
  const issues = Array.isArray(finalEvidence.issues) ? finalEvidence.issues : [];
  if (issues.includes("final-visual-qa-failed")) {
    const qa = finalEvidence.summary?.visualQa || {};
    const pages = Array.isArray(qa.pages) ? qa.pages : [];
    const failed = pages
      .filter((page) => Array.isArray(page.issues) && page.issues.length)
      .map((page) => `${page.pageId}: ${page.issues.map(formatVisualQaIssue).join("、")}`)
      .slice(0, 6)
      .join("；");
    return failed
      ? `最终视觉 QA 未通过：${failed}。这些可编辑页与 codex-ppt 目标图片不一致，交付前需要重跑对应的 image-to-editable-ppt 页面任务。`
      : "最终视觉 QA 未通过：可编辑页与 codex-ppt 目标图片不一致，交付前需要重跑对应的 image-to-editable-ppt 页面任务。";
  }
  if (issues.includes("final-visual-qa-needs-review")) {
    return "最终视觉 QA 需要人工复核：交付前请对比可编辑预览和 codex-ppt 目标图片。";
  }
  if (issues.includes("page-foreground-assets-missing")) {
    const pages = Array.isArray(finalEvidence.summary?.foregroundAssetIssues)
      ? finalEvidence.summary.foregroundAssetIssues
      : [];
    const pageSummary = pages
      .map((item) => `${item.pageId}: ${Array.isArray(item.missing) ? item.missing.join(", ") : ""}`)
      .filter(Boolean)
      .join("; ");
    return pageSummary
      ? `页面前景资产没有完成 image edit 分离：${pageSummary}。请重跑这些 editable 页面任务。`
      : "页面前景资产没有完成 image edit 分离，请重跑 editable 页面任务。";
  }
  if (issues.includes("final-pptx-powerpoint-open-failed")) {
    const detail = finalEvidence.powerPointOpenability?.error || "PowerPoint 无法打开最终 PPTX。";
    return `最终 PPTX 无法被 PowerPoint 打开：${detail}`;
  }
  if (issues.includes("workspace-final-validation-not-passed") || issues.includes("run-final-validation-not-passed")) {
    return "最终校验未通过。";
  }
  if (issues.includes("final-copy-hash-mismatch") || issues.includes("final-copy-size-mismatch")) {
    return "最终 PPTX 复制证据已过期或不匹配。";
  }
  if (issues.length) return `最终生成证据不完整：${issues.map(formatVisualQaIssue).join("、")}。`;
  return "最终生成证据不完整。";
}

function formatVisualQaIssue(issue = "") {
  const value = String(issue || "");
  const labels = {
    "editable-preview-missing": "缺少可编辑预览图",
    "asset-contact-sheet-missing": "缺少资产分离总览图",
    "preview-too-small-simplified": "重建预览明显过度简化",
    "target-image-missing": "缺少 codex-ppt 目标图",
    "visual-page-missing": "缺少视觉页",
    "preview-size-mismatch": "预览尺寸异常",
    "manual-review-missing": "缺少人工复核"
  };
  return labels[value] || value;
}

function isManualReviewCurrent(manualReview = {}, final = {}) {
  if (!final.path) return false;
  return manualReview?.status === "approved"
    && manualReview.finalPath === final.path
    && Number(manualReview.finalSize || 0) === Number(final.size || 0)
    && String(manualReview.finalCreatedAt || "") === String(final.createdAt || "");
}

const CODEX_PPT_REQUIRED_GATES = [
  ["outline", "outline approval"],
  ["style", "style approval"],
  ["backend", "backend approval"],
  ["sample", "sample approval"],
  ["fullDeck", "full-deck authorization"]
];

function buildCodexPptDeliveryEvidence(job = {}) {
  const artifacts = job.artifacts || {};
  const approved = new Set((Array.isArray(artifacts.codexPptApprovals) ? artifacts.codexPptApprovals : [])
    .filter((item) => item?.status === "approved" && item.gate)
    .map((item) => item.gate));
  const missingApprovals = CODEX_PPT_REQUIRED_GATES
    .filter(([gate]) => !approved.has(gate))
    .map(([, label]) => label);
  const backend = artifacts.codexPptBackend || {};
  const outline = artifacts.codexPptOutline || {};
  const style = artifacts.codexPptStyle || {};
  const backendDecision = artifacts.codexPptBackendDecision || {};
  const sample = artifacts.visualSample || {};
  const slideRun = summarizeCodexPptSlideRun(artifacts);
  const visualImages = Array.isArray(artifacts.visualImages) ? artifacts.visualImages : [];
  const backendKey = backendRecordKey(backend);
  const visualBackendKeys = [...new Set(visualImages.map(backendRecordKey).filter(Boolean))];
  const passthrough = isPassthroughBackend(backend) || visualImages.some(isPassthroughBackend);
  let backendIssue = "";
  if (!backendKey) backendIssue = "codex-ppt fixed image backend evidence is missing.";
  else if (passthrough) backendIssue = "codex-ppt visual backend uses passthrough/dry-run evidence.";
  else if (visualBackendKeys.length && !visualBackendKeys.includes(backendKey)) {
    backendIssue = `codex-ppt backend does not match visual image evidence: ${backendKey} vs ${visualBackendKeys.join(", ")}.`;
  }
  return {
    approvalsComplete: missingApprovals.length === 0,
    approvedGates: [...approved],
    missingApprovals,
    outlineEvidenceComplete: Boolean(outline.path),
    outline,
    styleEvidenceComplete: Boolean(style.path),
    style,
    backendDecisionComplete: Boolean(backendDecision.path),
    backendDecision,
    sampleEvidenceComplete: Boolean(sample.path),
    sample,
    backendFixed: Boolean(backendKey && !backendIssue),
    backend,
    backendKey,
    visualBackendKeys,
    backendIssue,
    slideRunComplete: slideRun.complete,
    slideRun
  };
}

function summarizeCodexPptSlideRun(artifacts = {}) {
  const jobs = artifacts.codexPptSlideJobs || {};
  const runState = artifacts.codexPptSlideRunState || {};
  const total = numberOrZero(runState.total || jobs.total || artifacts.codexPptSlidePrompts?.length);
  const recorded = numberOrZero(runState.recorded || jobs.recorded);
  const failed = numberOrZero(runState.failed || jobs.failed);
  return {
    total,
    recorded,
    failed,
    complete: total > 0 && recorded >= total && failed === 0,
    deckSpecPath: artifacts.codexPptDeckSpec?.path || "",
    slideJobsPath: jobs.path || "",
    slideRunStatePath: runState.path || ""
  };
}

function backendRecordKey(record = {}) {
  const provider = normalizeBackendProvider(record);
  const model = cleanBackendToken(record.model || record.imageModel || "");
  if (!provider && !model) return "";
  return `${provider || "unknown"}:${model || ""}`;
}

function normalizeBackendProvider(record = {}) {
  const baseUrl = normalizeBackendEndpoint(record.baseUrl || "");
  if (baseUrl) return baseUrl;
  const provider = cleanBackendToken(record.provider || record.backend || record.backendUsed || record.source || "");
  return normalizeBackendEndpoint(provider) || provider;
}

function normalizeBackendEndpoint(value = "") {
  const text = cleanBackendToken(value);
  if (!/^https?:\/\//i.test(text)) return "";
  return text
    .replace(/\/+$/, "")
    .replace(/\/v\d+$/i, "")
    .toLowerCase();
}

function isPassthroughBackend(record = {}) {
  const text = `${record.provider || ""} ${record.source || ""} ${record.backend || ""} ${record.backendUsed || ""} ${record.model || ""}`;
  return Boolean(record.dryRun) || /passthrough|source-page-passthrough|smoke-synthetic|regression/i.test(text);
}

function cleanBackendToken(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}
