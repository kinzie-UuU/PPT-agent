import { readWorkflowJob, saveWorkflowJob } from "./workflowJobs.js";

export async function approveWorkflowManualReview(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const artifacts = job.artifacts || {};
  const final = artifacts.editableFinal || {};
  if (!final.path) throw new Error("Final PPTX must exist before manual review can be approved.");
  const tasks = Array.isArray(artifacts.editableWorkerTasks) ? artifacts.editableWorkerTasks : [];
  const recordedPages = tasks.filter((task) => task.status === "recorded").map((task) => task.pageId).filter(Boolean);
  const now = new Date().toISOString();
  const manualReview = {
    kind: "manual_review",
    status: "approved",
    reviewer: cleanString(options.reviewer || "operator"),
    note: cleanString(options.note || ""),
    reviewedPages: recordedPages,
    reviewedPageCount: recordedPages.length,
    finalPath: final.path,
    finalCreatedAt: final.createdAt || "",
    finalSize: final.size || 0,
    approvedAt: now
  };
  job.artifacts = {
    ...artifacts,
    manualReview
  };
  job.events = appendEvent(job.events, "workflow.manual_review_approved", "Manual review approved", {
    reviewedPageCount: manualReview.reviewedPageCount,
    reviewer: manualReview.reviewer,
    finalPath: final.path
  });
  return saveWorkflowJob(job);
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

function cleanString(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 1000);
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
