import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { deriveWorkflowDeliveryStatus } from "../shared/workflowDeliveryStatus.js";
import { readWorkflowJob } from "./workflowJobs.js";
import { scanWorkflowPageEvidence } from "./workflowPageEvidence.js";
import { scanWorkflowFinalEvidence } from "./workflowFinalEvidence.js";

export async function getWorkflowDeliveryStatus(id) {
  const job = await readWorkflowJob(id);
  const sourceMeta = await readSafeArtifactJson(job, job.artifacts?.sourceMeta?.path);
  const finalValidation = await readSafeArtifactJson(job, job.artifacts?.editableFinal?.validation?.path);
  const enrichedJob = {
    ...job,
    sourceMeta: sourceMeta.data || null,
    finalValidation: finalValidation.data || null
  };
  const status = deriveWorkflowDeliveryStatus(enrichedJob);
  const pageEvidence = await scanWorkflowPageEvidence(enrichedJob).catch((error) => ({
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
  const deliveryStatus = alignDeliveryStatusWithFinalGate(status, finalGate);
  return {
    ok: true,
    jobId: job.id,
    status: deliveryStatus,
    finalGate,
    coverage: buildCoverage(enrichedJob),
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

export function alignDeliveryStatusWithFinalGate(status = {}, finalGate = {}) {
  if (!finalGate?.level) return status;
  if (finalGate.level === "ready") {
    return status.level === "ready"
      ? status
      : {
          ...status,
          level: "ready",
          title: "可以交付",
          summary: finalGate.summary || status.summary || "最终 PPTX 已通过交付检查。"
        };
  }
  if (finalGate.level === "blocked") {
    const reason = firstNonEmpty([...(finalGate.reasons || []), ...(finalGate.warnings || [])]) || "最终交付门禁未通过。";
    return {
      ...status,
      level: "blocked",
      title: "交付被阻断",
      summary: finalGate.summary || "最终交付门禁未通过。",
      warnings: uniqueStrings([...(status.warnings || []), ...(finalGate.reasons || []), ...(finalGate.warnings || [])]),
      nextStep: {
        id: "review-delivery-gate",
        label: "复核交付门禁",
        description: reason
      },
      nextActions: uniqueStrings([`复核交付门禁：${reason}`, ...(status.nextActions || [])])
    };
  }
  if (finalGate.level === "draft") {
    const warning = firstNonEmpty(finalGate.warnings || []) || "最终 PPTX 仍有交付警告，需要人工复核。";
    return {
      ...status,
      level: status.level === "blocked" ? "blocked" : "warning",
      title: status.level === "blocked" ? status.title : "草稿需复核",
      summary: finalGate.summary || status.summary || "最终 PPTX 可下载为草稿，但尚未达到产品级交付。",
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

export function buildFinalDeliveryGate(job, status = {}, pageEvidence = {}, finalEvidence = {}) {
  const artifacts = job.artifacts || {};
  const final = artifacts.editableFinal || {};
  const editability = final.pptxEditability || {};
  const tasks = Array.isArray(artifacts.editableWorkerTasks) ? artifacts.editableWorkerTasks : [];
  const finalValidation = job.finalValidation || null;
  const hasFinal = Boolean(final.path);
  const manualReviewRecorded = isManualReviewCurrent(artifacts.manualReview, final);
  const reasons = [];
  const warnings = [];
  const failedTasks = tasks.filter((task) => task.status === "failed").length;
  const fullSlidePictures = numberOrZero(editability.fullSlidePictures);
  const editabilityWarnings = Array.isArray(editability.warnings) ? editability.warnings : [];
  const hasExperimentalEvidence = hasExperimentalModelEvidence(job) || envTruthy(process.env.PPT_TOOL_ALLOW_LOCAL_ASSET_FALLBACK);
  const pageEvidenceComplete = Boolean(pageEvidence.complete);
  const finalEvidenceComplete = Boolean(finalEvidence.complete);
  const codexPptEvidence = buildCodexPptDeliveryEvidence(job);

  if (!hasFinal) warnings.push("Final editable PPTX has not been generated yet.");
  if (failedTasks) reasons.push(`${failedTasks} page worker task(s) failed.`);
  if (hasFinal && !pageEvidenceComplete) {
    reasons.push(summarizePageEvidenceIssue(pageEvidence));
  }
  if (hasFinal && !finalEvidenceComplete) {
    reasons.push("Finalize evidence is incomplete.");
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
  if (!final.validation?.path) warnings.push("Final validation artifact is missing.");
  if (finalValidation?.passed === false) reasons.push("Final validation did not pass.");
  if (editability.editable === false || editability.status === "warn") {
    warnings.push("OpenXML editability inspection has warnings.");
  }
  if (fullSlidePictures) {
    warnings.push(`${fullSlidePictures} full-slide picture risk(s) detected.`);
  }
  if (editabilityWarnings.length) {
    warnings.push(...editabilityWarnings.map((item) => `Editability warning: ${item}`));
  }
  if (hasExperimentalEvidence) {
    warnings.push("Experimental local/model rebuild evidence exists in this workflow.");
  }
  if (hasFinal && !manualReviewRecorded) {
    warnings.push("Manual page-level visual review is not recorded yet.");
  }

  const level = !hasFinal
    ? "pending"
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
    productReady: level === "ready",
    downloadable: hasFinal && level !== "blocked",
    reasons,
    warnings: uniqueStrings(warnings),
    checks: {
      hasFinal,
      validationPassed: finalValidation?.passed === true,
      editabilityPassed: editability.editable === true && editability.status !== "warn",
      noFullSlideRaster: fullSlidePictures === 0,
      noExperimentalEvidence: !hasExperimentalEvidence,
      manualReviewRecorded,
      pageEvidenceComplete,
      finalEvidenceComplete,
      codexPptOutlineRecorded: codexPptEvidence.outlineEvidenceComplete,
      codexPptStyleRecorded: codexPptEvidence.styleEvidenceComplete,
      codexPptBackendDecisionRecorded: codexPptEvidence.backendDecisionComplete,
      codexPptApprovalsComplete: codexPptEvidence.approvalsComplete,
      codexPptSampleRecorded: codexPptEvidence.sampleEvidenceComplete,
      codexPptBackendFixed: codexPptEvidence.backendFixed,
      codexPptSlideRunComplete: codexPptEvidence.slideRunComplete
    },
    codexPptEvidence
  };
}

function gateTitle(level) {
  if (level === "ready") return "Product-ready delivery";
  if (level === "draft") return "Editable draft only";
  if (level === "blocked") return "Delivery blocked";
  return "Delivery pending";
}

function gateLabel(level) {
  if (level === "ready") return "editable-final.pptx";
  if (level === "draft") return "editable-draft.pptx";
  if (level === "blocked") return "not-deliverable.pptx";
  return "pending-delivery";
}

function gateSummary(level) {
  if (level === "ready") return "The final PPTX passed structural, editability, and workflow checks.";
  if (level === "draft") return "A PPTX exists, but it should be treated as a draft until the warnings are resolved or reviewed.";
  if (level === "blocked") return "A required delivery condition failed, so this should not be delivered as final.";
  return "The workflow has not reached final delivery.";
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
  return "Page worker evidence is incomplete.";
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
