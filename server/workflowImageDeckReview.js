import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { readWorkflowJob, saveWorkflowJob } from "./workflowJobs.js";

const DOWNSTREAM_IMAGE_DECK_KEYS = [
  "imageDeck",
  "ocrTextHints",
  "editableRun",
  "editableHints",
  "editableNext",
  "editableWorkerPrompts",
  "editableWorkerTasks",
  "editableDispatches",
  "editableRecords",
  "editableLocalRebuilds",
  "editableWorkerBatchRuns",
  "editableFinal",
  "editableTextHintsAcknowledgement",
  "workerBriefs"
];

export async function recordWorkflowImageDeckPageReview(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const pageId = normalizePageId(options.pageId || "");
  const status = normalizeStatus(options.status || "");
  if (!pageId) throw new Error("A valid pageId is required for image deck review.");
  if (!status) throw new Error("Image deck review status must be pass, accept, or rerun.");
  const visualImage = findVisualImage(job, pageId);
  if (!visualImage) throw new Error("Visual image is missing for this page.");
  const now = new Date().toISOString();
  const previous = job.artifacts?.imageDeckReview || {};
  const marks = {
    ...(previous.marks || {}),
    [pageId]: {
      kind: "image_deck_review_mark",
      pageId,
      pageNumber: visualImage.pageNumber || Number(pageId.match(/\d+/)?.[0] || 0),
      status,
      reviewer: cleanString(options.reviewer || "operator"),
      note: cleanString(options.note || ""),
      visualImagePath: visualImage.path || "",
      visualImageSha256: visualImage.sha256 || "",
      markedAt: now
    }
  };
  const resetResult = status === "rerun" ? await resetImageDeckPageForRerun(job, pageId) : null;
  const summary = summarizeImageDeckReview(job, marks);
  job.artifacts = {
    ...(job.artifacts || {}),
    imageDeckReview: {
      kind: "image_deck_review",
      status: summary.readyForApproval ? "reviewed" : "in_progress",
      marks,
      summary,
      updatedAt: now
    }
  };
  job.events = appendEvent(job.events, "workflow.image_deck_page_review_marked", "Image deck page review marked", {
    pageId,
    status,
    reviewer: marks[pageId].reviewer,
    rerunReset: resetResult
  });
  return saveWorkflowJob(job);
}

export async function approveWorkflowImageDeckReview(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const marks = job.artifacts?.imageDeckReview?.marks || {};
  const summary = summarizeImageDeckReview(job, marks);
  if (!summary.readyForApproval) {
    const error = new Error("Every generated image page must be reviewed before image deck assembly.");
    error.status = 409;
    error.code = "IMAGE_DECK_REVIEW_INCOMPLETE";
    error.summary = summary;
    throw error;
  }
  const now = new Date().toISOString();
  job.artifacts = {
    ...(job.artifacts || {}),
    imageDeckReview: {
      ...(job.artifacts?.imageDeckReview || {}),
      kind: "image_deck_review",
      status: "approved",
      reviewer: cleanString(options.reviewer || "operator"),
      note: cleanString(options.note || ""),
      summary,
      approvedAt: now,
      visualImageHashes: getVisualImages(job).map((image) => ({
        pageId: image.pageId || pageIdFromNumber(image.pageNumber),
        sha256: image.sha256 || "",
        path: image.path || ""
      }))
    }
  };
  job.events = appendEvent(job.events, "workflow.image_deck_review_approved", "Image deck review approved", {
    reviewedPageCount: summary.passCount + summary.acceptCount,
    reviewer: job.artifacts.imageDeckReview.reviewer
  });
  return saveWorkflowJob(job);
}

export function assertWorkflowImageDeckReviewReady(job = {}) {
  const review = job.artifacts?.imageDeckReview || {};
  const summary = summarizeImageDeckReview(job, review.marks || {});
  if (review.status !== "approved" || !summary.readyForApproval || !reviewMatchesCurrentVisualImages(job, review)) {
    const error = new Error("Image deck review must be approved before assembling the image deck.");
    error.status = 409;
    error.code = "IMAGE_DECK_REVIEW_REQUIRED";
    error.summary = summary;
    throw error;
  }
}

function summarizeImageDeckReview(job = {}, marks = {}) {
  const visualImages = getVisualImages(job);
  const pageIds = [...new Set([
    ...visualImages.map((image) => image.pageId || pageIdFromNumber(image.pageNumber)).filter(Boolean),
    ...Object.keys(marks || {}).map(normalizePageId).filter(Boolean)
  ])];
  const values = pageIds.map((pageId) => marks[pageId]).filter(Boolean);
  const passCount = values.filter((mark) => mark.status === "pass").length;
  const acceptCount = values.filter((mark) => mark.status === "accept").length;
  const rerunCount = values.filter((mark) => mark.status === "rerun").length;
  const allPagesReviewed = pageIds.length > 0
    && pageIds.every((pageId) => ["pass", "accept"].includes(marks[pageId]?.status));
  const allMarksCurrent = pageIds.every((pageId) => {
    const image = findVisualImage(job, pageId);
    const mark = marks[pageId];
    return !mark || !image?.sha256 || mark.visualImageSha256 === image.sha256;
  });
  return {
    totalPages: pageIds.length,
    markedCount: values.length,
    passCount,
    acceptCount,
    rerunCount,
    allPagesReviewed,
    allMarksCurrent,
    readyForApproval: Boolean(pageIds.length && allPagesReviewed && allMarksCurrent && rerunCount === 0)
  };
}

function reviewMatchesCurrentVisualImages(job = {}, review = {}) {
  const recorded = new Map((Array.isArray(review.visualImageHashes) ? review.visualImageHashes : [])
    .map((item) => [item.pageId, item.sha256 || ""]));
  const visualImages = getVisualImages(job);
  return Boolean(visualImages.length)
    && visualImages.every((image) => {
      const pageId = image.pageId || pageIdFromNumber(image.pageNumber);
      return pageId && recorded.get(pageId) === (image.sha256 || "");
    });
}

function getVisualImages(job = {}) {
  return (Array.isArray(job.artifacts?.visualImages) ? job.artifacts.visualImages : [])
    .filter((image) => image?.path)
    .sort((a, b) => Number(a.pageNumber || 0) - Number(b.pageNumber || 0));
}

function findVisualImage(job = {}, pageId = "") {
  const clean = normalizePageId(pageId);
  return getVisualImages(job).find((image) => (image.pageId || pageIdFromNumber(image.pageNumber)) === clean);
}

async function resetImageDeckPageForRerun(job = {}, pageId = "") {
  const clean = normalizePageId(pageId);
  const artifacts = { ...(job.artifacts || {}) };
  const previousImages = Array.isArray(artifacts.visualImages) ? artifacts.visualImages : [];
  const removedImages = previousImages.filter((image) => (image.pageId || pageIdFromNumber(image.pageNumber)) === clean);
  const keptImages = previousImages.filter((image) => (image.pageId || pageIdFromNumber(image.pageNumber)) !== clean);
  artifacts.visualImages = keptImages;
  const archivedFiles = await archiveRerunVisualFiles(removedImages, clean);

  if (artifacts.visualManifest?.path) {
    await rewriteVisualManifestWithoutPage(artifacts.visualManifest.path, clean);
    artifacts.visualManifest = {
      ...artifacts.visualManifest,
      imageCount: keptImages.length,
      resetPageId: clean,
      updatedAt: new Date().toISOString()
    };
  }

  if (Array.isArray(artifacts.codexPptSlideWorkerTasks)) {
    artifacts.codexPptSlideWorkerTasks = artifacts.codexPptSlideWorkerTasks.map((task) => (
      normalizePageId(task.pageId) === clean
        ? {
          ...task,
          status: "ready",
          agentId: "",
          workerName: "",
          claimedAt: "",
          dispatchAt: "",
          heartbeatAt: "",
          recordedAt: "",
          imagePath: "",
          imageSha256: "",
          error: "",
          message: "reset from image deck review rerun"
        }
        : task
    ));
  }
  await resetCodexPptSlideRunForRerun(artifacts, clean);

  const invalidated = [];
  for (const key of DOWNSTREAM_IMAGE_DECK_KEYS) {
    if (artifacts[key] === undefined) continue;
    invalidated.push(key);
    delete artifacts[key];
  }
  job.artifacts = artifacts;
  job.currentStage = "visual_generating";
  job.status = "visual_generating";
  job.stageStatus = "pending";
  return {
    pageId: clean,
    removedVisualImages: removedImages.length,
    archivedFiles,
    invalidatedArtifacts: invalidated
  };
}

async function archiveRerunVisualFiles(images = [], pageId = "") {
  const archived = [];
  for (const image of Array.isArray(images) ? images : []) {
    const filePath = image?.path || "";
    if (!filePath || !fsSync.existsSync(filePath) || !fsSync.statSync(filePath).isFile()) continue;
    const archiveDir = path.join(path.dirname(filePath), ".review-rerun-archive", `${Date.now()}_${pageId}`);
    await fs.mkdir(archiveDir, { recursive: true });
    const target = path.join(archiveDir, path.basename(filePath));
    await fs.rename(filePath, target).catch(async () => {
      await fs.copyFile(filePath, target);
      await fs.rm(filePath, { force: true });
    });
    archived.push({ from: filePath, to: target });
  }
  return archived;
}

async function resetCodexPptSlideRunForRerun(artifacts = {}, pageId = "") {
  const pageNumber = Number(String(pageId || "").match(/\d+/)?.[0] || 0);
  const resetSlide = (slide = {}) => Number(slide.pageNumber || 0) === pageNumber
    ? {
      ...slide,
      status: "pending",
      agentId: "",
      dispatchMode: "",
      dispatchedAt: "",
      recordedAt: "",
      imagePath: "",
      imageSha256: "",
      qaNote: "reset from image deck review rerun"
    }
    : slide;
  for (const key of ["codexPptSlideJobs", "codexPptSlideRunState"]) {
    const artifact = artifacts[key] || {};
    if (!artifact.path || !fsSync.existsSync(artifact.path)) continue;
    const payload = JSON.parse(await fs.readFile(artifact.path, "utf8"));
    payload.slides = (Array.isArray(payload.slides) ? payload.slides : []).map(resetSlide);
    payload.updatedAt = new Date().toISOString();
    payload.summary = summarizeSlideRun(payload.slides);
    await fs.writeFile(artifact.path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    artifacts[key] = {
      ...artifact,
      ...payload.summary,
      updatedAt: payload.updatedAt
    };
  }
}

function summarizeSlideRun(slides = []) {
  const total = slides.length;
  const pending = slides.filter((slide) => slide.status === "pending").length;
  const dispatched = slides.filter((slide) => slide.status === "dispatched" || slide.dispatchedAt || slide.agentId).length;
  const recorded = slides.filter((slide) => slide.status === "recorded").length;
  const failed = slides.filter((slide) => slide.status === "failed").length;
  return { total, pending, dispatched, recorded, failed, complete: total > 0 && recorded >= total && failed === 0 };
}

async function rewriteVisualManifestWithoutPage(manifestPath = "", pageId = "") {
  if (!manifestPath || !fsSync.existsSync(manifestPath)) return;
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const images = Array.isArray(manifest.images) ? manifest.images : [];
  const next = {
    ...manifest,
    images: images.filter((image) => (image.pageId || pageIdFromNumber(image.pageNumber)) !== pageId),
    updatedAt: new Date().toISOString()
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function pageIdFromNumber(value = 0) {
  const number = Number(value || 0);
  return number ? `page_${String(number).padStart(3, "0")}` : "";
}

function normalizePageId(value = "") {
  const match = String(value || "").match(/\d+/);
  return match ? `page_${String(Number(match[0])).padStart(3, "0")}` : "";
}

function normalizeStatus(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (["pass", "passed", "approve", "approved"].includes(text)) return "pass";
  if (["accept", "accepted", "temporary_accept", "temporary-accept"].includes(text)) return "accept";
  if (["rerun", "retry", "needs_rerun", "needs-rerun", "fail", "failed"].includes(text)) return "rerun";
  return "";
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
