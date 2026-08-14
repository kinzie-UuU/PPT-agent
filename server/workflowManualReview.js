import { readWorkflowJob, saveWorkflowJob } from "./workflowJobs.js";
import crypto from "crypto";
import fs from "fs/promises";
import { buildEditableVisualQaSignature, isBlockingEditableVisualIssue, scanWorkflowFinalEvidence } from "./workflowFinalEvidence.js";
import { scanWorkflowPageEvidence } from "./workflowPageEvidence.js";

export async function approveWorkflowManualReview(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const artifacts = job.artifacts || {};
  const final = artifacts.editableFinal || {};
  if (!final.path) throw new Error("Final PPTX must exist before manual review can be approved.");
  const pageEvidence = await scanWorkflowPageEvidence(job);
  if (pageEvidence?.complete !== true) throw new Error("All page evidence must be complete before final manual review can be approved.");
  const finalEvidence = await scanWorkflowFinalEvidence(job);
  const visualQaPages = Array.isArray(finalEvidence.summary?.visualQa?.pages) ? finalEvidence.summary.visualQa.pages : [];
  const failedVisualPages = visualQaPages.filter((page) => (page.issues || []).some(isBlockingEditableVisualIssue));
  if (failedVisualPages.length) {
    throw new Error(`Editable visual QA failed for: ${failedVisualPages.map((page) => page.pageId).join(", ")}. Rerun these pages before approval.`);
  }
  const pageMarks = artifacts.pageVisualReview?.marks || {};
  const evidencePageIds = (pageEvidence.pages || []).map((page) => page.pageId).filter(Boolean);
  const missingPassMarks = evidencePageIds.filter((pageId) => pageMarks[pageId]?.status !== "pass");
  if (missingPassMarks.length) {
    throw new Error(`Every page must be marked pass before final approval: ${missingPassMarks.join(", ")}.`);
  }
  const staleMarks = visualQaPages.filter((page) => pageMarks[page.pageId]?.visualQaSignature !== buildEditableVisualQaSignature(page));
  if (staleMarks.length) {
    throw new Error(`Page review is stale for: ${staleMarks.map((page) => page.pageId).join(", ")}. Review the current previews again.`);
  }
  const tasks = Array.isArray(artifacts.editableWorkerTasks) ? artifacts.editableWorkerTasks : [];
  const recordedPages = tasks.filter((task) => task.status === "recorded").map((task) => task.pageId).filter(Boolean);
  const sourcePages = numberOrZero(job.sourceMeta?.pageCount || artifacts.sourceMeta?.pageCount);
  const finalPages = numberOrZero(final.summary?.page_count || final.pptxEditability?.slideCount);
  if (!sourcePages || !finalPages) {
    throw new Error("Source and final page counts are required before manual review can be approved.");
  }
  if (finalPages > sourcePages) {
    throw new Error(`Final PPT page count does not match the source: ${finalPages}/${sourcePages}. Finalize again after removing duplicated or unexpected pages.`);
  }
  const reviewScope = sourcePages && finalPages && finalPages < sourcePages ? "sample" : "full";
  const finalSha256 = final.sha256 || await hashFile(final.path);
  const now = new Date().toISOString();
  const manualReview = {
    kind: "manual_review",
    status: "approved",
    scope: reviewScope,
    reviewer: cleanString(options.reviewer || "operator"),
    note: cleanString(options.note || ""),
    reviewedPages: recordedPages,
    reviewedPageCount: finalPages || recordedPages.length,
    sourcePages,
    finalPages,
    partialSourceCoverage: reviewScope === "sample",
    finalPath: final.path,
    finalCreatedAt: final.createdAt || "",
    finalSize: final.size || 0,
    finalSha256,
    approvedAt: now
  };
  job.artifacts = {
    ...artifacts,
    editableFinal: { ...final, sha256: finalSha256 },
    manualReview
  };
  job.events = appendEvent(job.events, "workflow.manual_review_approved", "Manual review approved", {
    reviewedPageCount: manualReview.reviewedPageCount,
    scope: manualReview.scope,
    reviewer: manualReview.reviewer,
    finalPath: final.path
  });
  return saveWorkflowJob(job);
}

async function hashFile(filePath) {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export async function approveWorkflowVisualQualityReview(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const artifacts = job.artifacts || {};
  const visualQuality = artifacts.visualQuality || {};
  if (!visualQuality.path) throw new Error("Visual quality report must exist before visual review can be approved.");
  const now = new Date().toISOString();
  const visualQualityReview = {
    kind: "visual_quality_review",
    status: "approved",
    reviewer: cleanString(options.reviewer || "operator"),
    note: cleanString(options.note || ""),
    visualQualityPath: visualQuality.path,
    visualQualityCreatedAt: visualQuality.createdAt || "",
    visualQualitySize: visualQuality.size || 0,
    summary: visualQuality.summary || {},
    approvedAt: now
  };
  job.artifacts = {
    ...artifacts,
    visualQualityReview
  };
  job.events = appendEvent(job.events, "workflow.visual_quality_review_approved", "Visual quality review approved", {
    reviewer: visualQualityReview.reviewer,
    visualQualityPath: visualQuality.path,
    reviewCount: Number(visualQuality.summary?.reviewCount || 0) || 0,
    failedCount: Number(visualQuality.summary?.failedCount || 0) || 0
  });
  return saveWorkflowJob(job);
}

export async function resetWorkflowManualReview(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const previous = job.artifacts?.manualReview || null;
  job.artifacts = {
    ...(job.artifacts || {}),
    manualReview: {
      kind: "manual_review",
      status: "reset",
      reviewer: cleanString(options.reviewer || "operator"),
      note: cleanString(options.note || "manual review reset"),
      previousApprovedAt: previous?.approvedAt || "",
      resetAt: new Date().toISOString()
    }
  };
  job.events = appendEvent(job.events, "workflow.manual_review_reset", "Manual review reset", {
    previousApprovedAt: previous?.approvedAt || "",
    reviewer: job.artifacts.manualReview.reviewer
  });
  return saveWorkflowJob(job);
}

export async function recordWorkflowPageVisualReview(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const pageId = normalizePageId(options.pageId || "");
  const status = normalizePageReviewStatus(options.status || "");
  if (!pageId) throw new Error("A valid pageId is required for page visual review.");
  if (!status) throw new Error("Page visual review status must be pass, accept, or rerun.");

  const pageEvidence = await scanWorkflowPageEvidence(job).catch(() => null);
  const page = Array.isArray(pageEvidence?.pages)
    ? pageEvidence.pages.find((item) => item.pageId === pageId)
    : null;
  if (!page && status !== "rerun") {
    throw new Error("Page evidence is missing; only rerun can be recorded for this page.");
  }
  if (status !== "rerun" && page?.complete !== true) {
    throw new Error("Page evidence is incomplete; mark this page as rerun or complete the editable rebuild first.");
  }

  const artifacts = job.artifacts || {};
  const finalEvidence = status === "rerun" ? null : await scanWorkflowFinalEvidence(job);
  const visualQaPage = Array.isArray(finalEvidence?.summary?.visualQa?.pages)
    ? finalEvidence.summary.visualQa.pages.find((item) => item.pageId === pageId)
    : null;
  const blockingVisualIssues = (visualQaPage?.issues || []).filter(isBlockingEditableVisualIssue);
  if (status !== "rerun" && (!visualQaPage || blockingVisualIssues.length)) {
    const detail = blockingVisualIssues.length ? blockingVisualIssues.join(", ") : "visual-comparison-unavailable";
    throw new Error(`Page visual QA is not ready for approval: ${pageId} (${detail}).`);
  }
  const previous = artifacts.pageVisualReview || {};
  const marks = {
    ...(previous.marks || {})
  };
  const now = new Date().toISOString();
  marks[pageId] = {
    kind: "page_visual_review_mark",
    pageId,
    status,
    reviewer: cleanString(options.reviewer || "operator"),
    note: cleanString(options.note || ""),
    evidenceComplete: page?.complete === true,
    issues: Array.isArray(page?.issues) ? page.issues : [],
    visualQaSignature: visualQaPage ? buildEditableVisualQaSignature(visualQaPage) : "",
    visualQa: visualQaPage ? {
      score: visualQaPage.visualSimilarity?.score || 0,
      edgeOverlap: visualQaPage.visualSimilarity?.edgeOverlap || 0,
      edgeRetention: visualQaPage.visualSimilarity?.edgeRetention || 0,
      weakContentTileRatio: visualQaPage.visualSimilarity?.weakContentTileRatio || 0
    } : null,
    markedAt: now
  };
  const summary = summarizePageVisualReviewMarks(marks, pageEvidence);
  job.artifacts = {
    ...artifacts,
    pageVisualReview: {
      kind: "page_visual_review",
      status: summary.readyForFinalReview ? "reviewed" : "in_progress",
      marks,
      summary,
      updatedAt: now
    }
  };
  job.events = appendEvent(job.events, "workflow.page_visual_review_marked", "Page visual review marked", {
    pageId,
    status,
    evidenceComplete: page?.complete === true,
    reviewer: marks[pageId].reviewer
  });
  return saveWorkflowJob(job);
}

function normalizePageId(value = "") {
  const match = String(value || "").match(/\d+/);
  return match ? `page_${String(Number(match[0])).padStart(3, "0")}` : "";
}

function normalizePageReviewStatus(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (["pass", "passed", "approve", "approved"].includes(text)) return "pass";
  if (["accept", "accepted", "temporary_accept", "temporary-accept"].includes(text)) return "accept";
  if (["rerun", "retry", "needs_rerun", "needs-rerun", "fail", "failed"].includes(text)) return "rerun";
  return "";
}

function summarizePageVisualReviewMarks(marks = {}, pageEvidence = null) {
  const pages = Array.isArray(pageEvidence?.pages) ? pageEvidence.pages : [];
  const pageIds = pages.map((page) => page.pageId).filter(Boolean);
  const values = Object.values(marks || {});
  const passCount = values.filter((mark) => mark.status === "pass").length;
  const acceptCount = values.filter((mark) => mark.status === "accept").length;
  const rerunCount = values.filter((mark) => mark.status === "rerun").length;
  const markedCount = values.length;
  const completePageIds = pages.filter((page) => page.complete === true).map((page) => page.pageId);
  const allCompletePagesReviewed = completePageIds.length > 0
    && completePageIds.every((pageId) => ["pass", "accept"].includes(marks[pageId]?.status));
  const allPagesReviewed = pageIds.length > 0
    && pageIds.every((pageId) => ["pass", "accept"].includes(marks[pageId]?.status));
  return {
    totalPages: pageIds.length,
    completePages: completePageIds.length,
    markedCount,
    passCount,
    acceptCount,
    rerunCount,
    allCompletePagesReviewed,
    allPagesReviewed,
    readyForFinalReview: Boolean(pageEvidence?.complete && allPagesReviewed && rerunCount === 0)
  };
}

function cleanString(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 1000);
}

function numberOrZero(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function appendEvent(events = [], type, message, details = {}) {
  return [...(Array.isArray(events) ? events : []), {
    id: `evt_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    type,
    message,
    details,
    createdAt: new Date().toISOString()
  }].slice(-500);
}
