import fs from "fs/promises";
import fsSync from "fs";
import { readWorkflowJob } from "./workflowJobs.js";
import { getExternalImageAuthorizationStatus } from "./workflowAuthorizations.js";
import { listWorkflowCodexPptSlideTasks, resetWorkflowCodexPptSlideTask } from "./workflowCodexPptWorkerQueue.js";
import { scanWorkflowPageEvidence } from "./workflowPageEvidence.js";
import { getWorkflowEditableWorkerBatchPreflight } from "./workflowWorkerBatchRunner.js";
import { listWorkflowEditableWorkerTasks, resetWorkflowEditableWorkerTask } from "./workflowWorkerQueue.js";

export async function retryWorkflowPage(jobId, pageId, options = {}) {
  const normalizedPageId = normalizePageId(pageId);
  if (!normalizedPageId) throw new Error("A valid page id is required");
  const target = normalizeTarget(options.skillId || options.skill || options.target || "auto");
  const reason = cleanString(options.reason || "product page retry");
  const results = [];

  if (target === "auto" || target === "image-to-editable-ppt") {
    const editable = await retryEditableTask(jobId, normalizedPageId, { ...options, reason }).catch((error) => ({
      skillId: "image-to-editable-ppt",
      pageId: normalizedPageId,
      retried: false,
      error: error.message || "editable retry failed"
    }));
    if (target === "image-to-editable-ppt" || editable.exists || editable.retried || editable.error) results.push(editable);
  }

  if (target === "auto" || target === "codex-ppt") {
    const codex = await retryCodexSlideTask(jobId, normalizedPageId, { ...options, reason }).catch((error) => ({
      skillId: "codex-ppt",
      pageId: normalizedPageId,
      retried: false,
      error: error.message || "codex-ppt retry failed"
    }));
    if (target === "codex-ppt" || codex.exists || codex.retried || codex.error) results.push(codex);
  }

  const retried = results.filter((item) => item.retried);
  if (!retried.length) {
    const explicitErrors = results.map((item) => item.error).filter(Boolean);
    throw new Error(explicitErrors[0] || `No retryable task found for ${normalizedPageId}`);
  }

  return {
    ok: true,
    jobId,
    pageId: normalizedPageId,
    retried: retried.length,
    results,
    job: await readWorkflowJob(jobId)
  };
}

export async function getVisualQualityRetryPreflight(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const reportPath = job.artifacts?.visualQuality?.path || "";
  const report = await readVisualQualityReport(reportPath);
  const pages = Array.isArray(report.pages) ? report.pages : [];
  const requestedPages = parsePageList(options.pages || options.pageIds || options.pageId || options.page || "");
  const includeAllReview = Boolean(options.includeAllReview);
  const candidates = pages
    .filter((page) => !requestedPages.length || requestedPages.includes(normalizePageId(page.pageId || page.pageNumber)))
    .filter((page) => includeAllReview ? page.manualReviewRequired : isVisualRetryCandidate(page))
    .map((page) => ({
      pageId: normalizePageId(page.pageId || page.pageNumber),
      pageNumber: Number(page.pageNumber || page.pageId?.match?.(/\d+/)?.[0] || 0),
      status: page.status || "",
      reasons: Array.isArray(page.manualReviewReasons) ? page.manualReviewReasons : [],
      visualPath: page.visualPath || "",
      sourcePagePath: page.sourcePagePath || ""
    }))
    .filter((page) => page.pageId);
  const taskBundle = await listWorkflowCodexPptSlideTasks(jobId).catch(() => ({ tasks: [], summary: {} }));
  const taskByPage = new Map((taskBundle.tasks || []).map((task) => [normalizePageId(task.pageId || task.slideId || task.pageNumber), task]));
  const candidateDetails = candidates.map((page) => {
    const task = taskByPage.get(page.pageId) || null;
    return {
      ...page,
      codexTask: task ? {
        exists: true,
        status: task.status || "",
        imagePath: task.imagePath || "",
        agentId: task.agentId || "",
        resettable: task.status === "recorded" || task.status === "failed" || task.status === "running" || task.status === "ready"
      } : { exists: false, resettable: false }
    };
  });
  const resettablePages = candidateDetails.filter((page) => page.codexTask?.resettable).map((page) => page.pageId);
  const authorization = getExternalImageAuthorizationStatus(job, { scope: "full-deck", imageCalls: resettablePages.length });
  const blockingIssues = [];
  const warnings = [];
  if (!reportPath || !fsSync.existsSync(reportPath)) blockingIssues.push("Visual quality report is missing.");
  if (!candidateDetails.length) warnings.push("No visual quality retry candidates found.");
  if (candidateDetails.length && !resettablePages.length) blockingIssues.push("No matching codex-ppt slide task can be reset for the visual quality candidates.");
  if (resettablePages.length && !authorization.persisted) warnings.push("External image API authorization is required before rerunning codex-ppt slide tasks.");
  return {
    ok: true,
    preview: true,
    didRun: false,
    jobId,
    ready: blockingIssues.length === 0,
    resetReady: blockingIssues.length === 0 && resettablePages.length > 0,
    runReadyAfterReset: blockingIssues.length === 0 && resettablePages.length > 0 && Boolean(authorization.persisted),
    reportPath,
    reportSummary: report.summary || {},
    candidateCount: candidateDetails.length,
    resettableCount: resettablePages.length,
    candidates: candidateDetails,
    resetPages: resettablePages,
    authorization,
    requiredConfirmations: {
      externalImageSpend: {
        required: resettablePages.length > 0,
        confirmed: resettablePages.length ? Boolean(authorization.persisted) : true,
        persisted: Boolean(authorization.persisted),
        scope: "full-deck",
        imageCalls: resettablePages.length
      }
    },
    resetBody: {
      target: "codex-ppt",
      forceRecorded: true,
      reason: "visual quality retry: title/text loss or failed local QA"
    },
    runBody: {
      mode: "model",
      maxPages: resettablePages.length,
      pages: resettablePages.join(","),
      agentPrefix: "product-codex-slide-retry",
      confirmExternalImageSpend: Boolean(authorization.persisted),
      assembleImageDeck: true,
      prepareEditable: true,
      buildEditablePrompts: true,
      syncEditableWorkerTasks: true
    },
    blockingIssues,
    warnings,
    updatedAt: new Date().toISOString()
  };
}

export async function retryFailedWorkflowPages(jobId, options = {}) {
  const target = normalizeTarget(options.skillId || options.skill || options.target || "auto");
  const reason = cleanString(options.reason || "product bulk retry failed pages");
  const failed = [];

  if (target === "auto" || target === "image-to-editable-ppt") {
    const bundle = await listWorkflowEditableWorkerTasks(jobId).catch(() => null);
    for (const task of Array.isArray(bundle?.tasks) ? bundle.tasks : []) {
      if (task.status === "failed") {
        failed.push({
          skillId: "image-to-editable-ppt",
          pageId: normalizePageId(task.pageId || task.pageNumber)
        });
      }
    }
  }

  if (target === "auto" || target === "codex-ppt") {
    const bundle = await listWorkflowCodexPptSlideTasks(jobId).catch(() => null);
    for (const task of Array.isArray(bundle?.tasks) ? bundle.tasks : []) {
      if (task.status === "failed") {
        failed.push({
          skillId: "codex-ppt",
          pageId: normalizePageId(task.pageId || task.slideId || task.pageNumber)
        });
      }
    }
  }

  const uniqueFailed = dedupeFailedTasks(failed);
  const results = [];
  for (const task of uniqueFailed) {
    if (!task.pageId) continue;
    const result = await retryWorkflowPage(jobId, task.pageId, {
      ...options,
      skillId: task.skillId,
      reason
    }).then((value) => ({
      skillId: task.skillId,
      pageId: task.pageId,
      ok: true,
      retried: value.retried || 0
    })).catch((error) => ({
      skillId: task.skillId,
      pageId: task.pageId,
      ok: false,
      retried: 0,
      error: error.message || "bulk retry failed"
    }));
    results.push(result);
  }

  return {
    ok: results.every((item) => item.ok),
    jobId,
    requested: uniqueFailed.length,
    retried: results.filter((item) => item.ok && item.retried).length,
    failed: results.filter((item) => !item.ok).length,
    results,
    job: await readWorkflowJob(jobId)
  };
}

export async function retryStaleWorkflowPageEvidence(jobId, options = {}) {
  const reason = cleanString(options.reason || "product retry stale editable page evidence");
  const dryRun = options.dryRun !== false && options.apply !== true && options.confirm !== true;
  const evidence = await scanWorkflowPageEvidence(jobId);
  const candidates = findStaleEvidencePages(evidence);
  const results = [];

  if (!dryRun) {
    for (const pageId of candidates) {
      const result = await retryWorkflowPage(jobId, pageId, {
        ...options,
        skillId: "image-to-editable-ppt",
        forceRecorded: true,
        forceEditpptReset: true,
        allowQueueOnlyReset: true,
        confirmLost: true,
        reason
      }).then((value) => ({
        pageId,
        ok: true,
        retried: value.retried || 0
      })).catch((error) => ({
        pageId,
        ok: false,
        retried: 0,
        error: error.message || "stale evidence retry failed"
      }));
      results.push(result);
    }
  }

  const workerBatchPreflight = !dryRun && candidates.length
    ? await getWorkflowEditableWorkerBatchPreflight(jobId, {
      mode: "model",
      maxPages: candidates.length,
      pages: candidates.join(","),
      agentPrefix: "product-page-worker",
      confirmExternalImageSpend: false,
      acceptOfflineTextHints: Boolean(options.acceptOfflineTextHints || options.confirmOfflineTextHints),
      autoFinalize: true
    }).catch((error) => ({
      ok: false,
      ready: false,
      startReady: false,
      error: error.message || "editable worker batch preflight failed"
    }))
    : null;
  const workerBatchPreview = candidates.length
    ? await buildStaleEvidenceWorkerBatchPreview(jobId, candidates, options).catch((error) => ({
      ok: false,
      ready: false,
      startReady: false,
      error: error.message || "stale evidence worker batch preview failed"
    }))
    : null;
  const freshEditableRun = buildFreshEditableRunRecovery(evidence, candidates, { dryRun });

  return {
    ok: dryRun ? true : results.every((item) => item.ok),
    jobId,
    dryRun,
    requested: candidates.length,
    retried: dryRun ? 0 : results.filter((item) => item.ok && item.retried).length,
    failed: dryRun ? 0 : results.filter((item) => !item.ok).length,
    candidates,
    results,
    evidence: {
      totalPages: evidence.totalPages || 0,
      complete: evidence.complete === true,
      summary: evidence.summary || {},
      issues: (evidence.issues || []).slice(0, 20)
    },
    recovery: buildStaleEvidenceRecoveryPlan(candidates, { dryRun, freshEditableRun }),
    freshEditableRun,
    workerBatchPreflight,
    workerBatchPreview,
    job: dryRun ? await readWorkflowJob(jobId) : await readWorkflowJob(jobId)
  };
}

async function buildStaleEvidenceWorkerBatchPreview(jobId, candidates = [], options = {}) {
  const job = await readWorkflowJob(jobId);
  const taskBundle = await listWorkflowEditableWorkerTasks(jobId).catch(() => ({ tasks: [], prompts: [] }));
  const candidatePages = candidates.map(normalizePageId).filter(Boolean);
  const taskPages = new Set((taskBundle.tasks || []).map((task) => normalizePageId(task.pageId)).filter(Boolean));
  const promptPages = new Set((taskBundle.prompts || []).map((prompt) => normalizePageId(prompt.pageId)).filter(Boolean));
  const selectedPageIds = candidatePages.filter((pageId) => taskPages.has(pageId));
  const missingTaskPages = candidatePages.filter((pageId) => !taskPages.has(pageId));
  const missingPromptPages = candidatePages.filter((pageId) => !promptPages.has(pageId));
  const externalImageRequired = selectedPageIds.length > 0;
  const authorization = getExternalImageAuthorizationStatus(job, {
    scope: "editable-workers",
    imageCalls: selectedPageIds.length
  });
  const offlineHintsAccepted = Boolean(
    options.acceptOfflineTextHints
    || options.confirmOfflineTextHints
    || options.paddleOcrDeclined
    || job.artifacts?.editableTextHintsAcknowledgement?.accepted
  );
  const blockingIssues = [];
  const warnings = [];
  if (!job.artifacts?.editableRun?.path) blockingIssues.push("editppt prepare has not produced an editable run yet.");
  if (!taskBundle.prompts?.length) blockingIssues.push("No editable page worker prompts are available.");
  if (!taskBundle.tasks?.length) blockingIssues.push("No editable worker tasks are synced.");
  if (missingTaskPages.length) blockingIssues.push(`Missing editable worker task(s): ${missingTaskPages.join(", ")}`);
  if (missingPromptPages.length) blockingIssues.push(`Missing editable worker prompt(s): ${missingPromptPages.join(", ")}`);
  if (externalImageRequired && !authorization.persisted) warnings.push("External image API credit authorization is not recorded for editable page workers.");
  if (!offlineHintsAccepted) warnings.push("Offline builtin-ink text hints must be accepted or PaddleOCR must be configured before dispatch.");
  const ready = blockingIssues.length === 0;
  const startReady = ready && (!externalImageRequired || authorization.persisted) && offlineHintsAccepted;
  return {
    ok: true,
    preview: true,
    ready,
    startReady,
    mode: "model",
    selectedCount: selectedPageIds.length,
    selectedPageIds,
    pages: selectedPageIds.join(","),
    counts: {
      candidates: candidatePages.length,
      matchedTasks: selectedPageIds.length,
      missingTasks: missingTaskPages.length,
      missingPrompts: missingPromptPages.length,
      totalTasks: taskBundle.summary?.total || taskBundle.tasks?.length || 0,
      recordedBeforeReset: (taskBundle.tasks || []).filter((task) => candidatePages.includes(normalizePageId(task.pageId)) && task.status === "recorded").length
    },
    authorization,
    requiredConfirmations: {
      externalImageSpend: {
        required: externalImageRequired,
        confirmed: externalImageRequired ? Boolean(authorization.persisted) : true
      },
      offlineTextHints: {
        required: true,
        confirmed: offlineHintsAccepted,
        acceptedByWorkflow: Boolean(job.artifacts?.editableTextHintsAcknowledgement?.accepted)
      }
    },
    blockingIssues,
    warnings,
    startBody: {
      mode: "model",
      maxPages: selectedPageIds.length || candidatePages.length,
      pages: selectedPageIds.join(","),
      agentPrefix: "product-page-worker",
      confirmExternalImageSpend: externalImageRequired ? Boolean(authorization.persisted) : false,
      acceptOfflineTextHints: offlineHintsAccepted,
      autoFinalize: true
    },
    updatedAt: new Date().toISOString()
  };
}

function buildFreshEditableRunRecovery(evidence = {}, candidates = [], options = {}) {
  const candidateSet = new Set(candidates.map(normalizePageId).filter(Boolean));
  const pages = (Array.isArray(evidence.pages) ? evidence.pages : [])
    .filter((page) => candidateSet.has(normalizePageId(page.pageId)))
    .filter((page) => page.accepted === true || String(page.status || "").toLowerCase() === "accepted")
    .map((page) => normalizePageId(page.pageId))
    .filter(Boolean);
  const required = pages.length > 0;
  return {
    required,
    localOnly: true,
    externalImageSpendRequired: false,
    pages,
    reason: required
      ? "editppt accepted pages cannot be reset in-place; rebuild a fresh editable run, rebuild prompts, then rerun page workers."
      : "",
    nextAction: required ? "editable/prepare + editable/prompts + editable/worker-tasks/sync" : "",
    steps: required ? [
      "POST /editable/prepare force=true",
      "POST /editable/prompts",
      "POST /editable/worker-tasks/sync",
      "Then start selected editable page workers after external image spend confirmation."
    ] : [],
    warning: required
      ? "This refreshes the editable run directory and invalidates previous page worker records for this workflow, but it does not call the external image API by itself."
      : "",
    dryRun: Boolean(options.dryRun)
  };
}

function buildStaleEvidenceRecoveryPlan(candidates = [], options = {}) {
  const pages = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  const freshEditableRun = options.freshEditableRun || null;
  const freshRequired = Boolean(freshEditableRun?.required);
  return {
    nextAction: pages.length ? freshRequired ? "editable/prepare + editable/prompts + editable/worker-tasks/sync" : "editable/dispatch + editable/record" : "",
    nextStepId: pages.length ? freshRequired ? "fresh-editable-run" : "start-page-workers" : "",
    targetPanel: pages.length ? "editable-page-worker-panel" : "",
    externalImageConfirmationRequired: pages.length > 0,
    freshEditableRunRequired: freshRequired,
    freshEditableRun,
    pages,
    message: pages.length
      ? freshRequired
        ? `${options.dryRun ? "检测到" : "已重置"} ${pages.length} 页过期页面证据：${pages.join(", ")}。这些页处于 editppt accepted 状态，下一步请先重建 fresh editable run、重建提示并同步页面任务；该准备动作不调用外部图片 API。`
        : `${options.dryRun ? "检测到" : "已重置"} ${pages.length} 页过期页面证据：${pages.join(", ")}。下一步请重跑这些 editable 页面任务；启动模型页面任务前仍需确认外部图片 API 额度。`
      : "没有发现需要重置的过期页面证据。"
  };
}

async function readVisualQualityReport(filePath = "") {
  if (!filePath || !fsSync.existsSync(filePath)) return { pages: [], summary: {} };
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return { pages: [], summary: {} };
  }
}

function isVisualRetryCandidate(page = {}) {
  const reasons = Array.isArray(page.manualReviewReasons) ? page.manualReviewReasons : [];
  return page.status === "failed"
    || reasons.includes("possible-title-or-text-loss")
    || reasons.includes("qa-failed");
}

function parsePageList(value = "") {
  if (Array.isArray(value)) return value.map(normalizePageId).filter(Boolean);
  return String(value || "")
    .split(/[,\s]+/)
    .map(normalizePageId)
    .filter(Boolean);
}

async function retryEditableTask(jobId, pageId, options = {}) {
  const bundle = await listWorkflowEditableWorkerTasks(jobId).catch(() => null);
  const task = findTask(bundle?.tasks, pageId);
  if (!task) return { skillId: "image-to-editable-ppt", pageId, exists: false, retried: false, skipped: true, reason: "task not found" };
  if (task.status === "recorded" && !options.forceRecorded) {
    return { skillId: "image-to-editable-ppt", pageId, exists: true, retried: false, skipped: true, reason: "recorded task is not retried by default" };
  }
  const next = await resetWorkflowEditableWorkerTask(jobId, pageId, {
    ...options,
    reason: options.reason || "product page retry",
    allowQueueOnlyReset: true,
    confirmLost: true
  });
  return {
    skillId: "image-to-editable-ppt",
    pageId,
    exists: true,
    retried: true,
    previousStatus: task.status || "",
    summary: next.summary || null
  };
}

async function retryCodexSlideTask(jobId, pageId, options = {}) {
  const bundle = await listWorkflowCodexPptSlideTasks(jobId).catch(() => null);
  const task = findTask(bundle?.tasks, pageId);
  if (!task) return { skillId: "codex-ppt", pageId, exists: false, retried: false, skipped: true, reason: "task not found" };
  if (task.status === "recorded" && !options.forceRecorded) {
    return { skillId: "codex-ppt", pageId, exists: true, retried: false, skipped: true, reason: "recorded task is not retried by default" };
  }
  const next = await resetWorkflowCodexPptSlideTask(jobId, pageId, {
    ...options,
    reason: options.reason || "product page retry"
  });
  return {
    skillId: "codex-ppt",
    pageId,
    exists: true,
    retried: true,
    previousStatus: task.status || "",
    summary: next.summary || null
  };
}

function dedupeFailedTasks(tasks = []) {
  const seen = new Set();
  const result = [];
  for (const task of tasks) {
    const skillId = normalizeTarget(task.skillId);
    const pageId = normalizePageId(task.pageId);
    const key = `${skillId}:${pageId}`;
    if (!pageId || seen.has(key)) continue;
    seen.add(key);
    result.push({ skillId, pageId });
  }
  return result;
}

function findStaleEvidencePages(evidence = {}) {
  const pages = Array.isArray(evidence.pages) ? evidence.pages : [];
  return pages
    .filter((page) => Array.isArray(page.issues) && page.issues.some((issue) => /^hash-mismatch-/.test(String(issue || ""))))
    .map((page) => normalizePageId(page.pageId))
    .filter(Boolean);
}

function findTask(tasks = [], pageId = "") {
  const normalized = normalizePageId(pageId);
  return (Array.isArray(tasks) ? tasks : []).find((task) => normalizePageId(task.pageId || task.slideId || task.pageNumber) === normalized);
}

function normalizeTarget(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (["codex", "codex-ppt", "slide", "slides"].includes(text)) return "codex-ppt";
  if (["editable", "editppt", "image-to-editable-ppt", "page", "pages"].includes(text)) return "image-to-editable-ppt";
  return "auto";
}

function normalizePageId(value = "") {
  const text = String(value || "").trim().toLowerCase();
  const match = text.match(/\d+/);
  if (!match) return "";
  return `page_${String(Number(match[0])).padStart(3, "0")}`;
}

function cleanString(value = "") {
  return String(value || "").trim().slice(0, 600);
}
