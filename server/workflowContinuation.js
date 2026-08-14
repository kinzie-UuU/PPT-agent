import { authorizeExternalImageSpend, getExternalImageAuthorizationStatus } from "./workflowAuthorizations.js";
import { runWorkflowCodexPptSlideBatch, getWorkflowCodexPptSlideBatchPreflight } from "./workflowCodexPptSlideBatchRunner.js";
import { readWorkflowJob } from "./workflowJobs.js";

export async function getWorkflowContinuationPreflight(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const partial = buildPartialFinalCoverage(job);
  if (!partial.canContinueRemainingPages) {
    return {
      ok: true,
      startReady: false,
      action: "continue-remaining-pages",
      partialFinal: partial,
      blockingIssues: [partial.reason || "当前没有需要继续生成的剩余页面。"],
      warnings: []
    };
  }
  const pageNumbers = partial.missingVisualPageNumbers;
  const pageSelection = pageNumbers.join(",");
  const authorization = getExternalImageAuthorizationStatus(job, {
    scope: "full-deck",
    imageCalls: pageNumbers.length,
    pageNumbers: pageSelection,
    pageSelection
  });
  const codexPreflight = await getWorkflowCodexPptSlideBatchPreflight(jobId, {
    forceSync: true,
    pages: pageSelection,
    maxPages: pageNumbers.length,
    confirmExternalImageSpend: Boolean(options.confirmExternalImageSpend && !authorization.persisted),
    assembleImageDeck: true,
    prepareEditable: true,
    buildEditablePrompts: true,
    syncEditableWorkerTasks: true
  }).catch((error) => ({
    ok: false,
    ready: false,
    startReady: false,
    blockingIssues: [error.message || "codex-ppt 剩余页预检失败。"],
    warnings: []
  }));
  const syncableTaskBlockers = new Set([
    "No codex-ppt slide worker tasks are synced. Sync the slide queue after full-deck approval.",
    "No ready or failed codex-ppt slide tasks are available for batch generation."
  ]);
  const blockingIssues = (codexPreflight.blockingIssues || [])
    .filter((issue) => !syncableTaskBlockers.has(String(issue || "")));
  const warnings = [...(codexPreflight.warnings || [])];
  if ((codexPreflight.blockingIssues || []).some((issue) => syncableTaskBlockers.has(String(issue || "")))) {
    warnings.push("运行时会先扩展 codex-ppt 图片页任务队列，再继续处理剩余页面。");
  }
  if (!authorization.persisted && !options.confirmExternalImageSpend) {
    warnings.push("继续剩余页面前需要确认 gpt-image-2 外部图片 API 调用额度。");
  }
  const readyAfterTaskSync = blockingIssues.length === 0 && Boolean(codexPreflight.approvals?.ready)
    && Boolean(codexPreflight.provider?.configured)
    && codexPreflight.provider?.enabled !== false
    && codexPreflight.backendRuntime?.backendMatchesRuntime
    && !codexPreflight.backendRuntime?.approvedBackendLooksDryRun;
  return {
    ok: true,
    action: "continue-remaining-pages",
    startReady: Boolean(readyAfterTaskSync && (authorization.persisted || options.confirmExternalImageSpend)),
    ready: Boolean(readyAfterTaskSync),
    partialFinal: partial,
    pageSelection,
    pageNumbers,
    remainingPages: pageNumbers.length,
    externalImageCalls: pageNumbers.length,
    authorization,
    codexPreflight: {
      ...codexPreflight,
      ready: readyAfterTaskSync,
      startReady: Boolean(readyAfterTaskSync && (authorization.persisted || options.confirmExternalImageSpend)),
      selectedCount: pageNumbers.length,
      selectedPages: pageNumbers,
      blockingIssues,
      warnings
    },
    requiredConfirmations: {
      externalImageSpend: {
        required: true,
        confirmed: Boolean(authorization.persisted || options.confirmExternalImageSpend),
        persisted: Boolean(authorization.persisted),
        imageCalls: pageNumbers.length,
        pageSelection
      }
    },
    startBody: {
      pages: pageSelection,
      maxPages: pageNumbers.length,
      confirmExternalImageSpend: Boolean(options.confirmExternalImageSpend && !authorization.persisted),
      assembleImageDeck: true,
      prepareEditable: true,
      buildEditablePrompts: true,
      syncEditableWorkerTasks: true,
      editableMaxConcurrentPages: 6
    },
    blockingIssues,
    warnings
  };
}

export async function runWorkflowContinuation(jobId, options = {}) {
  const preflight = await getWorkflowContinuationPreflight(jobId, options);
  if (!preflight.partialFinal?.canContinueRemainingPages) {
    throw withPreflight(new Error(preflight.blockingIssues?.[0] || "没有可继续处理的剩余页面。"), preflight);
  }
  if (!options.confirmExternalImageSpend && !preflight.authorization?.persisted) {
    const error = new Error("继续剩余页面前必须确认外部图片 API 额度。");
    error.code = "EXTERNAL_IMAGE_SPEND_CONFIRMATION_REQUIRED";
    throw withPreflight(error, preflight);
  }
  if (options.confirmExternalImageSpend && !preflight.authorization?.persisted) {
    await authorizeExternalImageSpend(jobId, {
      scope: "full-deck",
      imageCalls: preflight.externalImageCalls,
      pages: preflight.pageSelection,
      pageSelection: preflight.pageSelection,
      mode: "continue-remaining-pages",
      confirmedBy: options.confirmedBy || options.requestedBy || "frontend-continuation",
      reason: options.reason || "继续生成部分 final 后剩余页面"
    });
  }
  const confirmedPreflight = await getWorkflowContinuationPreflight(jobId, {
    ...options,
    confirmExternalImageSpend: true
  });
  if (!confirmedPreflight.startReady) {
    const issue = [
      ...(confirmedPreflight.blockingIssues || []),
      ...(confirmedPreflight.warnings || [])
    ].filter(Boolean).join(" ");
    throw withPreflight(new Error(issue || "剩余页面预检未通过。"), confirmedPreflight);
  }
  const result = await runWorkflowCodexPptSlideBatch(jobId, {
    ...confirmedPreflight.startBody,
    forceSync: true,
    agentPrefix: options.agentPrefix || "product-continuation-codex-slide",
    requestedBy: options.requestedBy || "workflow-continuation",
    note: options.note || "continue remaining pages after partial final"
  });
  if (!isContinuationBatchSuccess(result)) {
    const firstFailure = result.run?.errors?.[0];
    const failedCount = Number(result.run?.failed || 0);
    const error = new Error(
      `\u5269\u4f59\u9875\u751f\u6210\u5df2\u5728\u7b2c ${failedCount || 1} \u4e2a\u5931\u8d25\u5904\u505c\u6b62\uff1a${firstFailure?.error || "\u672a\u77e5\u6279\u5904\u7406\u9519\u8bef"}`
    );
    error.code = "WORKFLOW_CONTINUATION_BATCH_FAILED";
    throw withPreflight(error, confirmedPreflight);
  }
  return {
    ok: true,
    action: "continue-remaining-pages",
    preflight: confirmedPreflight,
    result
  };
}

export function isContinuationBatchSuccess(result = {}) {
  return ["complete", "review_required", "partial"].includes(String(result.run?.status || ""));
}

export function buildPartialFinalCoverage(job = {}) {
  const artifacts = job.artifacts || {};
  const final = artifacts.editableFinal || {};
  const editability = final.pptxEditability || {};
  const sourcePages = numberOrZero(job.sourceMeta?.pageCount)
    || numberOrZero(artifacts.sourceMeta?.pageCount)
    || countArray(artifacts.renderedPages);
  const finalPages = numberOrZero(final.summary?.page_count || editability.slideCount || job.finalValidation?.slides);
  const sourcePageIds = workflowSourcePageIds(artifacts, sourcePages);
  const visualPageIds = workflowArtifactPageIds((Array.isArray(artifacts.visualImages) ? artifacts.visualImages : [])
    .filter((image) => image?.staleStyleReference !== true));
  const editablePageIds = workflowEditablePageIds(artifacts.editableWorkerTasks);
  const missingVisualPageIds = sourcePageIds.filter((pageId) => !visualPageIds.has(pageId));
  const missingEditablePageIds = sourcePageIds.filter((pageId) => !editablePageIds.has(pageId));
  const missingVisualPageNumbers = missingVisualPageIds.map(pageNumberFromPageId).filter(Boolean);
  const missingEditablePageNumbers = missingEditablePageIds.map(pageNumberFromPageId).filter(Boolean);
  const visualPages = visualPageIds.size;
  const hasFinal = Boolean(final.path);
  if (!hasFinal) {
    return {
      sourcePages,
      finalPages,
      visualPages,
      remainingPages: 0,
      canContinueRemainingPages: false,
      reason: "当前还没有 final PPT。"
    };
  }
  if (!sourcePages || !finalPages || finalPages >= sourcePages) {
    return {
      sourcePages,
      finalPages,
      visualPages,
      remainingPages: 0,
      canContinueRemainingPages: false,
      reason: sourcePages && finalPages >= sourcePages ? "当前 final 已覆盖全部源页面。" : "无法判断源文件页数或 final 页数。"
    };
  }
  const remainingPages = missingVisualPageIds.length;
  return {
    sourcePages,
    finalPages,
    visualPages,
    remainingPages,
    missingVisualPageIds,
    missingVisualPageNumbers,
    missingEditablePageIds,
    missingEditablePageNumbers,
    pageSelection: missingVisualPageIds.join(","),
    numericPageSelection: missingVisualPageNumbers.join(","),
    finalPath: final.path || "",
    canReviewCurrentSample: true,
    canContinueRemainingPages: missingVisualPageIds.length > 0,
    canContinueEditablePages: missingVisualPageIds.length === 0 && missingEditablePageIds.length > 0,
    reason: missingVisualPageIds.length
      ? `当前 final 只覆盖 ${finalPages}/${sourcePages} 页，可以复核当前样例，或继续生成缺失的 ${missingVisualPageIds.length} 个图片页。`
      : `图片版已覆盖 ${visualPages}/${sourcePages} 页，下一步应继续重建缺失的 ${missingEditablePageIds.length} 个可编辑页，不要重复生成图片。`
  };
}

function withPreflight(error, preflight) {
  error.preflight = preflight;
  return error;
}

function workflowSourcePageIds(artifacts = {}, sourcePages = 0) {
  const rendered = workflowArtifactPageIds(artifacts.renderedPages);
  if (sourcePages > 0) {
    return Array.from({ length: sourcePages }, (_item, index) => `page_${String(index + 1).padStart(3, "0")}`);
  }
  return [...rendered].sort(comparePageIds);
}

function workflowArtifactPageIds(items = []) {
  return new Set((Array.isArray(items) ? items : [])
    .map((item) => cleanPageId(item?.pageId || item?.page_id || item?.pageNumber || item?.page_number))
    .filter(Boolean));
}

function workflowEditablePageIds(tasks = []) {
  const completed = (Array.isArray(tasks) ? tasks : []).filter((task) => {
    const status = String(task?.status || "").toLowerCase();
    return task?.accepted === true || task?.recorded === true || ["accepted", "recorded", "complete", "completed"].includes(status);
  });
  return workflowArtifactPageIds(completed);
}

function cleanPageId(value = "") {
  const match = String(value || "").match(/(?:page[_-]?)?(\d+)/i);
  if (!match) return "";
  const number = Number(match[1]);
  return Number.isFinite(number) && number > 0 ? `page_${String(number).padStart(3, "0")}` : "";
}

function pageNumberFromPageId(value = "") {
  const match = String(value || "").match(/page_(\d+)/i);
  return match ? Number(match[1]) : 0;
}

function comparePageIds(left = "", right = "") {
  return pageNumberFromPageId(left) - pageNumberFromPageId(right);
}

function countArray(value) {
  return Array.isArray(value) ? value.length : 0;
}

function numberOrZero(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}
