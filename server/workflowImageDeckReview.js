import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { readWorkflowJob, saveWorkflowJob } from "./workflowJobs.js";
import { writeWorkflowVisualTextQualityReport } from "./workflowVisualTextQa.js";

const GLOBAL_IMAGE_DECK_KEYS = [
  "imageDeck",
  "visualQuality",
  "visualTextQuality",
  "visualQualityReview",
  "editableNext",
  "editableFinal",
  "manualReview",
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
  const semanticBlockingReasons = getSemanticBlockingReasonMap(job).get(pageId) || [];
  if (["pass", "accept"].includes(status)) {
    const semanticRiskAccepted = Boolean(
      semanticBlockingReasons.length
      && status === "accept"
      && options.confirmSemanticRisk === true
    );
    assertVisualQualityAllowsReview(job, pageId, { allowSemanticBlocked: semanticRiskAccepted });
    if (semanticBlockingReasons.length && !semanticRiskAccepted) {
      throwSemanticRiskAcceptanceError(pageId, semanticBlockingReasons);
    }
    const styleDriftReasons = getPageStyleDriftReasons(job, pageId);
    if (styleDriftReasons.length && status === "pass") {
      throwStyleDriftAcceptanceError(pageId, styleDriftReasons);
    }
    if (styleDriftReasons.length && (status !== "accept" || options.confirmStyleDrift !== true)) {
      throwStyleDriftAcceptanceError(pageId, styleDriftReasons);
    }
  }
  const styleDriftReasons = getPageStyleDriftReasons(job, pageId);
  const visualTextQualityEvidenceSha256 = getVisualTextQualityEvidenceSha256(job);
  const visualTextQualityPageEvidenceSha256 = getVisualTextQualityPageEvidenceSha256(job, pageId);
  const visualQualityEvidenceSha256 = getVisualQualityEvidenceSha256(job);
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
      visualTextQualityEvidenceSha256,
      visualTextQualityPageEvidenceSha256,
      visualQualityEvidenceSha256,
      semanticBlockingReasons,
      semanticRiskAccepted: Boolean(semanticBlockingReasons.length && status === "accept" && options.confirmSemanticRisk === true),
      styleDriftReasons,
      styleDriftAccepted: Boolean(styleDriftReasons.length && status === "accept" && options.confirmStyleDrift === true),
      markedAt: now
    }
  };
  const resetResult = status === "rerun" && options.resetForRerun === true
    ? await resetImageDeckPageForRerun(job, pageId, { note: marks[pageId].note })
    : null;
  const summary = summarizeImageDeckReview(job, marks);
  job.artifacts = {
    ...(job.artifacts || {}),
    imageDeckReview: {
      kind: "image_deck_review",
      status: summary.readyForApproval ? "reviewed" : "in_progress",
      marks,
      summary,
      visualTextQualityEvidenceSha256,
      visualQualityEvidenceSha256,
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

export async function recordWorkflowImageDeckPagesForRerun(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  if (options.confirmResetForRerun !== true) {
    const error = new Error("Batch image-page rerun reset requires explicit confirmation.");
    error.status = 409;
    error.code = "IMAGE_DECK_RERUN_CONFIRMATION_REQUIRED";
    throw error;
  }
  const pageIds = [...new Set((Array.isArray(options.pageIds) ? options.pageIds : String(options.pages || "").split(","))
    .map(normalizePageId)
    .filter(Boolean))];
  if (!pageIds.length) throw new Error("At least one valid pageId is required for image deck rerun.");
  const visualImages = new Map(getVisualImages(job).map((image) => [image.pageId || pageIdFromNumber(image.pageNumber), image]));
  const missingPageIds = pageIds.filter((pageId) => !visualImages.has(pageId));
  if (missingPageIds.length) {
    const error = new Error(`Visual image is missing for ${missingPageIds.join(", ")}.`);
    error.status = 409;
    error.code = "IMAGE_DECK_RERUN_PAGE_MISSING";
    error.pages = missingPageIds;
    throw error;
  }
  const previous = job.artifacts?.imageDeckReview || {};
  const visualTextQualityEvidenceSha256 = getVisualTextQualityEvidenceSha256(job);
  const visualQualityEvidenceSha256 = getVisualQualityEvidenceSha256(job);
  const now = new Date().toISOString();
  const marks = { ...(previous.marks || {}) };
  for (const pageId of pageIds) {
    const image = visualImages.get(pageId);
    const previousNote = cleanString(job.artifacts?.imageDeckReview?.marks?.[pageId]?.note || job.artifacts?.codexPptRerunGuidance?.[pageId]?.note || "");
    marks[pageId] = {
      kind: "image_deck_review_mark",
      pageId,
      pageNumber: image.pageNumber || Number(pageId.match(/\d+/)?.[0] || 0),
      status: "rerun",
      reviewer: cleanString(options.reviewer || "operator"),
      note: cleanString(options.note || previousNote || "batch reset from image deck quality review"),
      visualImagePath: image.path || "",
      visualImageSha256: image.sha256 || "",
      visualTextQualityEvidenceSha256,
      visualTextQualityPageEvidenceSha256: getVisualTextQualityPageEvidenceSha256(job, pageId),
      visualQualityEvidenceSha256,
      styleDriftReasons: getPageStyleDriftReasons(job, pageId),
      styleDriftAccepted: false,
      markedAt: now
    };
  }
  const rerunGuidanceByPage = new Map(pageIds.map((pageId) => [
    pageId,
    captureImageDeckRerunGuidance(job, pageId, marks[pageId]?.note || "")
  ]));
  const resetResults = [];
  for (const pageId of pageIds) {
    resetResults.push(await resetImageDeckPageForRerun(job, pageId, {
      note: marks[pageId]?.note || "",
      rerunGuidance: rerunGuidanceByPage.get(pageId)
    }));
  }
  const summary = summarizeImageDeckReview(job, marks);
  job.artifacts = {
    ...(job.artifacts || {}),
    imageDeckReview: {
      kind: "image_deck_review",
      status: "in_progress",
      marks,
      summary,
      visualTextQualityEvidenceSha256,
      visualQualityEvidenceSha256,
      updatedAt: now
    }
  };
  job.events = appendEvent(job.events, "workflow.image_deck_pages_reset_for_rerun", "Image deck pages reset for rerun", {
    pageIds,
    reviewer: cleanString(options.reviewer || "operator"),
    resetResults
  });
  return saveWorkflowJob(job);
}

export async function approveWorkflowImageDeckReview(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  // Automated OCR and visual rules surface risks, but a reviewer looking at the
  // source/generated pair may explicitly accept them. Missing or stale evidence
  // remains a hard gate; summarizeImageDeckReview verifies every risk acceptance.
  assertVisualQualityAllowsReview(job, "", { allowSemanticBlocked: true });
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
  const visualQuality = job.artifacts?.visualQuality || {};
  job.artifacts = {
    ...(job.artifacts || {}),
    imageDeckReview: {
      ...(job.artifacts?.imageDeckReview || {}),
      kind: "image_deck_review",
      status: "approved",
      reviewer: cleanString(options.reviewer || "operator"),
      note: cleanString(options.note || ""),
      summary,
      visualQualityEvidenceSha256: getVisualQualityEvidenceSha256(job),
      approvedAt: now,
      visualImageHashes: getVisualImages(job).map((image) => ({
        pageId: image.pageId || pageIdFromNumber(image.pageNumber),
        sha256: image.sha256 || "",
        path: image.path || ""
      }))
    },
    visualQualityReview: {
      kind: "visual_quality_review",
      status: "approved",
      reviewer: cleanString(options.reviewer || "operator"),
      note: cleanString(options.note || "approved with image deck page review"),
      source: "image-deck-review",
      visualQualityPath: visualQuality.path || "",
      visualQualityCreatedAt: visualQuality.createdAt || "",
      visualQualityEvidenceSha256: getVisualQualityEvidenceSha256(job),
      visualQualitySize: visualQuality.size || 0,
      summary: visualQuality.summary || {},
      approvedAt: now
    }
  };
  job.events = appendEvent(job.events, "workflow.image_deck_review_approved", "Image deck review approved", {
    reviewedPageCount: summary.passCount + summary.acceptCount,
    reviewer: job.artifacts.imageDeckReview.reviewer
  });
  return saveWorkflowJob(job);
}

export function assertWorkflowImageDeckReviewReady(job = {}) {
  assertVisualQualityAllowsReview(job, "", { allowSemanticBlocked: true });
  const review = job.artifacts?.imageDeckReview || {};
  const summary = summarizeImageDeckReview(job, review.marks || {});
  const expectedPages = getExpectedWorkflowPageCount(job);
  const fullCoverage = Boolean(expectedPages > 0 && getVisualImages(job).length === expectedPages);
  if (!fullCoverage || review.status !== "approved" || !summary.readyForApproval || !reviewMatchesCurrentVisualImages(job, review)) {
    const error = new Error("Image deck review must be approved before assembling the image deck.");
    error.status = 409;
    error.code = "IMAGE_DECK_REVIEW_REQUIRED";
    error.summary = summary;
    throw error;
  }
}

export function assertVisualQualityAllowsReview(job = {}, pageId = "", options = {}) {
  const reportPath = cleanString(job.artifacts?.visualQuality?.path || "");
  if (!reportPath || !fsSync.existsSync(reportPath)) {
    throwImageDeckQualityError(
      "IMAGE_DECK_VISUAL_QUALITY_REQUIRED",
      "Current visual quality evidence is required before approving generated pages."
    );
  }
  let report;
  try {
    report = JSON.parse(fsSync.readFileSync(reportPath, "utf8"));
  } catch {
    throwImageDeckQualityError(
      "IMAGE_DECK_VISUAL_QUALITY_INVALID",
      "Visual quality evidence is unreadable. Rebuild the local quality report before review."
    );
  }
  const styleConsistency = report?.summary?.styleConsistency || {};
  const sourceOcrCoverage = report?.summary?.sourceOcrCoverage || {};
  if (Object.prototype.hasOwnProperty.call(report?.summary || {}, "sourceOcrCoverage") && sourceOcrCoverage.complete !== true) {
    const error = new Error(`Source-page OCR evidence is incomplete for ${sourceOcrCoverage.missingPageIds?.length || 0} page(s). Run local source OCR and rebuild visual quality before approval.`);
    error.status = 409;
    error.code = "IMAGE_DECK_SOURCE_OCR_REQUIRED";
    error.pages = sourceOcrCoverage.missingPageIds || [];
    throw error;
  }
  const sampleSha256 = cleanString(job.artifacts?.visualSample?.sha256 || "");
  const reportPages = new Map((Array.isArray(report?.pages) ? report.pages : [])
    .map((page) => [normalizePageId(page.pageId || pageIdFromNumber(page.pageNumber)), page]));
  const evidenceCurrent = Boolean(
    sampleSha256
    && styleConsistency.approvedSampleSha256 === sampleSha256
    && getVisualImages(job).length
    && getVisualImages(job).every((image) => {
      const id = image.pageId || pageIdFromNumber(image.pageNumber);
      return id && image.sha256 && reportPages.get(id)?.sha256 === image.sha256;
    })
  );
  if (!evidenceCurrent) {
    throwImageDeckQualityError(
      "IMAGE_DECK_VISUAL_QUALITY_STALE",
      "Visual quality evidence does not match the current sample or generated pages. Rebuild it before review."
    );
  }
  const semanticSummary = report?.summary?.semanticQuality || {};
  const semanticEvidenceCurrent = Boolean(
    semanticSummary.complete === true
    && getVisualImages(job).length
    && getVisualImages(job).every((image) => {
      const id = image.pageId || pageIdFromNumber(image.pageNumber);
      const page = (Array.isArray(report?.pages) ? report.pages : []).find((item) => normalizePageId(item.pageId || pageIdFromNumber(item.pageNumber)) === id);
      return Boolean(page?.semanticQuality && (!image.sha256 || page.semanticQuality.visualImageSha256 === image.sha256));
    })
  );
  if (!semanticEvidenceCurrent) {
    throwImageDeckQualityError(
      "IMAGE_DECK_TEXT_QUALITY_REQUIRED",
      "Current generated-page OCR and semantic text-quality evidence are required before review. Run local visual OCR and rebuild quality evidence."
    );
  }
  const semanticPages = (Array.isArray(report?.pages) ? report.pages : [])
    .map((page) => ({
      pageId: normalizePageId(page.pageId || pageIdFromNumber(page.pageNumber)),
      reasons: [...new Set([
        ...(Array.isArray(page.blockingReasons) ? page.blockingReasons : []),
        ...(Array.isArray(page.semanticQuality?.blockingReasons) ? page.semanticQuality.blockingReasons : [])
      ])]
    }))
    .filter((page) => page.pageId && page.reasons.length);
  const requestedPageId = normalizePageId(pageId);
  const blocked = requestedPageId
    ? semanticPages.filter((page) => page.pageId === requestedPageId)
    : semanticPages;
  if (blocked.length && options.allowSemanticBlocked !== true) {
    const error = new Error(requestedPageId
      ? `${requestedPageId} contains a content-quality blocker and must be regenerated before approval.`
      : `${blocked.length} generated page(s) contain content-quality blockers and must be regenerated before final approval.`);
    error.status = 409;
    error.code = "IMAGE_DECK_SEMANTIC_QUALITY_BLOCKED";
    error.pages = blocked;
    throw error;
  }
  // Pixel heuristics compare different slide roles, such as a saturated cover
  // and a white data table. Keep drift as a human-review hint instead of
  // overriding the reviewer who can see the source/generated page pair.
  return report;
}

function throwSemanticRiskAcceptanceError(pageId = "", reasons = []) {
  const error = new Error(`${pageId} has automated content-fidelity warnings. Compare the source and generated page, then explicitly accept the risks or mark the page for rerun.`);
  error.status = 409;
  error.code = "IMAGE_DECK_SEMANTIC_RISK_REQUIRES_ACCEPTANCE";
  error.pageId = pageId;
  error.reasons = reasons;
  throw error;
}

function throwStyleDriftAcceptanceError(pageId = "", reasons = []) {
  const error = new Error(`${pageId} has automated deck-style drift warnings. Review the page pair and explicitly accept the variation or mark the page for rerun.`);
  error.status = 409;
  error.code = "IMAGE_DECK_STYLE_DRIFT_REQUIRES_ACCEPTANCE";
  error.pageId = pageId;
  error.reasons = reasons;
  throw error;
}

function throwImageDeckQualityError(code, message) {
  const error = new Error(message);
  error.status = 409;
  error.code = code;
  throw error;
}

function summarizeImageDeckReview(job = {}, marks = {}) {
  const visualImages = getVisualImages(job);
  const pageIds = [...new Set([
    ...visualImages.map((image) => image.pageId || pageIdFromNumber(image.pageNumber)).filter(Boolean),
    ...Object.keys(marks || {}).map(normalizePageId).filter(Boolean)
  ])];
  const evidenceSha256 = getVisualTextQualityEvidenceSha256(job);
  const visualQualityEvidenceSha256 = getVisualQualityEvidenceSha256(job);
  const isMarkCurrent = (pageId) => {
    const mark = marks[pageId];
    if (!mark) return false;
    const pageEvidenceSha256 = getVisualTextQualityPageEvidenceSha256(job, pageId);
    if (!evidenceSha256 || !pageEvidenceSha256 || !visualQualityEvidenceSha256) return false;
    if (mark.visualTextQualityPageEvidenceSha256 !== pageEvidenceSha256) return false;
    if (mark.visualQualityEvidenceSha256 !== visualQualityEvidenceSha256) return false;
    if (mark.status === "rerun") return true;
    const image = findVisualImage(job, pageId);
    return Boolean(image && (!image.sha256 || mark.visualImageSha256 === image.sha256));
  };
  const values = pageIds.map((pageId) => isMarkCurrent(pageId) ? marks[pageId] : null).filter(Boolean);
  const passCount = values.filter((mark) => mark.status === "pass").length;
  const acceptCount = values.filter((mark) => mark.status === "accept").length;
  const rerunCount = values.filter((mark) => mark.status === "rerun").length;
  const styleDriftByPage = getStyleDriftReasonMap(job);
  const semanticBlockByPage = getSemanticBlockingReasonMap(job);
  const validReview = (pageId) => {
    const mark = marks[pageId] || {};
    if (!isMarkCurrent(pageId)) return false;
    const hasSemanticRisk = (semanticBlockByPage.get(pageId) || []).length > 0;
    const hasStyleDrift = (styleDriftByPage.get(pageId) || []).length > 0;
    if (hasSemanticRisk && (mark.status !== "accept" || mark.semanticRiskAccepted !== true)) return false;
    if (hasStyleDrift && (mark.status !== "accept" || mark.styleDriftAccepted !== true)) return false;
    return ["pass", "accept"].includes(mark.status);
  };
  const allPagesReviewed = pageIds.length > 0 && pageIds.every(validReview);
  const allMarksCurrent = pageIds.every((pageId) => !marks[pageId] || isMarkCurrent(pageId));
  return {
    totalPages: pageIds.length,
    markedCount: values.length,
    passCount,
    acceptCount,
    rerunCount,
    styleDriftCount: styleDriftByPage.size,
    semanticBlockedCount: semanticBlockByPage.size,
    semanticBlockedPages: pageIds.filter((pageId) => (semanticBlockByPage.get(pageId) || []).length),
    pendingStyleDriftPages: pageIds.filter((pageId) => (styleDriftByPage.get(pageId) || []).length && !validReview(pageId)),
    allPagesReviewed,
    allMarksCurrent,
    readyForApproval: Boolean(pageIds.length && allPagesReviewed && allMarksCurrent && rerunCount === 0)
  };
}

function getSemanticBlockingReasonMap(job = {}) {
  const reportPath = cleanString(job.artifacts?.visualQuality?.path || "");
  if (!reportPath || !fsSync.existsSync(reportPath)) return new Map();
  try {
    const report = JSON.parse(fsSync.readFileSync(reportPath, "utf8"));
    return new Map((Array.isArray(report?.pages) ? report.pages : []).map((page) => {
      const pageId = normalizePageId(page.pageId || pageIdFromNumber(page.pageNumber));
      const reasons = [...new Set([
        ...(Array.isArray(page.blockingReasons) ? page.blockingReasons : []),
        ...(Array.isArray(page.semanticQuality?.blockingReasons) ? page.semanticQuality.blockingReasons : [])
      ])];
      return [pageId, reasons];
    }).filter(([pageId, reasons]) => pageId && reasons.length));
  } catch {
    return new Map();
  }
}

function getPageStyleDriftReasons(job = {}, pageId = "") {
  return getStyleDriftReasonMap(job).get(normalizePageId(pageId)) || [];
}

function getStyleDriftReasonMap(job = {}) {
  const reportPath = cleanString(job.artifacts?.visualQuality?.path || "");
  if (!reportPath || !fsSync.existsSync(reportPath)) return new Map();
  try {
    const report = JSON.parse(fsSync.readFileSync(reportPath, "utf8"));
    return new Map((Array.isArray(report?.pages) ? report.pages : []).map((page) => {
      const pageId = normalizePageId(page.pageId || pageIdFromNumber(page.pageNumber));
      const reasons = [...new Set([
        ...(Array.isArray(page?.styleConsistency?.reasons) ? page.styleConsistency.reasons : []),
        ...(Array.isArray(page?.manualReviewReasons) ? page.manualReviewReasons : [])
      ].filter((reason) => /^style-.*-drift$/i.test(String(reason || ""))))];
      return [pageId, reasons];
    }).filter(([pageId, reasons]) => pageId && reasons.length));
  } catch {
    return new Map();
  }
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
    .filter((image) => image?.path && image.staleStyleReference !== true)
    .sort((a, b) => Number(a.pageNumber || 0) - Number(b.pageNumber || 0));
}

export function getExpectedWorkflowPageCount(job = {}) {
  const artifacts = job.artifacts || {};
  const outlineCount = artifacts.source?.kind === "brief_source"
    ? Number(artifacts.codexPptOutline?.slideCount || readOutlineSlideCount(artifacts.codexPptOutline?.path || "") || 0)
    : 0;
  return outlineCount || Number(
    job.sourceMeta?.pageCount
    || artifacts.sourceMeta?.pageCount
    || job.input?.sourcePageCount
    || artifacts.source?.pageCount
    || 0
  ) || Math.max(
    Array.isArray(artifacts.renderedPages) ? artifacts.renderedPages.length : 0,
    Number(artifacts.imageDeck?.pageCount || 0),
    Number(artifacts.ocrTextHints?.pageCount || 0),
    getVisualImages(job).length
  );
}

function readOutlineSlideCount(filePath = "") {
  const cleanPath = cleanString(filePath);
  if (!cleanPath || !fsSync.existsSync(cleanPath)) return 0;
  try {
    const outline = JSON.parse(fsSync.readFileSync(cleanPath, "utf8"));
    return Number(outline.slideCount || (Array.isArray(outline.layoutSequence) ? outline.layoutSequence.length : 0) || 0);
  } catch {
    return 0;
  }
}

function getVisualTextQualityEvidenceSha256(job = {}) {
  return cleanString(job.artifacts?.visualTextQuality?.evidenceSha256 || job.artifacts?.visualTextQuality?.sha256 || "");
}

function getVisualQualityEvidenceSha256(job = {}) {
  return cleanString(job.artifacts?.visualQuality?.evidenceSha256 || job.artifacts?.visualQuality?.sha256 || "");
}

function getVisualTextQualityPageEvidenceSha256(job = {}, pageId = "") {
  const clean = normalizePageId(pageId);
  const recorded = job.artifacts?.visualTextQuality?.pageEvidenceSha256ByPage?.[clean];
  if (recorded) return cleanString(recorded);
  const reportPath = cleanString(job.artifacts?.visualTextQuality?.path || "");
  if (!reportPath || !fsSync.existsSync(reportPath)) return "";
  try {
    const report = JSON.parse(fsSync.readFileSync(reportPath, "utf8"));
    const page = (Array.isArray(report.pages) ? report.pages : [])
      .find((item) => normalizePageId(item.pageId || pageIdFromNumber(item.pageNumber)) === clean);
    return cleanString(page?.evidenceSha256 || "");
  } catch {
    return "";
  }
}

function findVisualImage(job = {}, pageId = "") {
  const clean = normalizePageId(pageId);
  return getVisualImages(job).find((image) => (image.pageId || pageIdFromNumber(image.pageNumber)) === clean);
}

async function resetImageDeckPageForRerun(job = {}, pageId = "", options = {}) {
  const clean = normalizePageId(pageId);
  const artifacts = { ...(job.artifacts || {}) };
  const rerunGuidance = options.rerunGuidance
    || captureImageDeckRerunGuidance(job, clean, options.note || "");
  artifacts.codexPptRerunGuidance = {
    ...(artifacts.codexPptRerunGuidance || {}),
    [clean]: rerunGuidance
  };
  const samplePageId = normalizePageId(artifacts.visualSample?.pageId || pageIdFromNumber(artifacts.visualSample?.pageNumber));
  if (samplePageId && samplePageId === clean) {
    delete artifacts.visualSample;
    delete artifacts.visualSampleManifest;
    artifacts.codexPptApprovals = (Array.isArray(artifacts.codexPptApprovals) ? artifacts.codexPptApprovals : [])
      .filter((approval) => !["sample", "fullDeck"].includes(approval?.gate));
  }
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

  const invalidated = invalidateDownstreamForImagePageRerun(artifacts, clean);
  job.artifacts = artifacts;
  if (keptImages.length) {
    await writeWorkflowVisualTextQualityReport(job);
  }
  job.currentStage = "visual_generating";
  job.status = "visual_generating";
  job.stageStatus = "pending";
  return {
    pageId: clean,
    removedVisualImages: removedImages.length,
    archivedFiles,
    rerunGuidance,
    invalidatedArtifacts: invalidated
  };
}

function captureImageDeckRerunGuidance(job = {}, pageId = "", note = "") {
  const reportPath = cleanString(job.artifacts?.visualQuality?.path || "");
  let page = null;
  if (reportPath && fsSync.existsSync(reportPath)) {
    try {
      const report = JSON.parse(fsSync.readFileSync(reportPath, "utf8"));
      page = (Array.isArray(report.pages) ? report.pages : [])
        .find((item) => normalizePageId(item?.pageId || item?.pageNumber) === pageId) || null;
    } catch {
      page = null;
    }
  }
  const previous = job.artifacts?.codexPptRerunGuidance?.[pageId] || {};
  const previousReasons = Array.isArray(previous.reasons) ? previous.reasons.map(cleanString).filter(Boolean) : [];
  const previousHasRestoreReason = previousReasons.some((reason) => [
    "critical-data-or-contact-missing",
    "critical-brand-or-code-missing",
    "substantial-source-text-loss",
    "missing-critical-source-text",
    "source-title-mismatch",
    "semantic-evidence-missing"
  ].includes(reason));
  const previousRequiredTexts = Array.isArray(previous.requiredTexts) ? previous.requiredTexts : [];
  const migrateLegacyInventedRequired = previousReasons.includes("invented-critical-text")
    && !previousHasRestoreReason
    && !(Array.isArray(previous.forbiddenTexts) && previous.forbiddenTexts.length);
  const reasons = [...new Set([
    ...previousReasons,
    ...(Array.isArray(page?.blockingReasons) ? page.blockingReasons : []),
    ...(Array.isArray(page?.manualReviewReasons) ? page.manualReviewReasons : []),
    ...(Array.isArray(page?.semanticQuality?.blockingReasons) ? page.semanticQuality.blockingReasons : []),
    ...(Array.isArray(page?.semanticQuality?.reviewReasons) ? page.semanticQuality.reviewReasons : []),
    ...(Array.isArray(page?.styleConsistency?.reasons) ? page.styleConsistency.reasons : []),
    ...getPageStyleDriftReasons(job, pageId)
  ].map(cleanString).filter(Boolean))];
  const requiredTexts = [...new Set([
    ...(!migrateLegacyInventedRequired ? previousRequiredTexts : []),
    ...(Array.isArray(page?.missingCriticalTexts) ? page.missingCriticalTexts : []),
    ...(Array.isArray(page?.semanticQuality?.missingCriticalTexts) ? page.semanticQuality.missingCriticalTexts : [])
  ].map(cleanString).filter(Boolean))].slice(0, 20);
  const forbiddenTexts = [...new Set([
    ...(Array.isArray(previous.forbiddenTexts) ? previous.forbiddenTexts : []),
    ...(migrateLegacyInventedRequired ? previousRequiredTexts : []),
    ...(Array.isArray(page?.inventedCriticalBlockingTexts) ? page.inventedCriticalBlockingTexts : []),
    ...(Array.isArray(page?.semanticQuality?.inventedCriticalBlockingTexts) ? page.semanticQuality.inventedCriticalBlockingTexts : [])
  ].map(cleanString).filter(Boolean))].slice(0, 20);
  return {
    kind: "codex_ppt_rerun_guidance",
    pageId,
    attempts: Math.max(0, Number(previous.attempts || 0)) + 1,
    reasons,
    requiredTexts,
    forbiddenTexts,
    note: cleanString(note || previous.note || ""),
    capturedAt: new Date().toISOString()
  };
}

function invalidateDownstreamForImagePageRerun(artifacts = {}, pageId = "") {
  const invalidated = [];
  for (const key of GLOBAL_IMAGE_DECK_KEYS) {
    if (artifacts[key] === undefined) continue;
    invalidated.push(key);
    delete artifacts[key];
  }
  for (const key of ["editableWorkerPrompts", "editableDispatches", "editableRecords", "editableLocalRebuilds"]) {
    if (!Array.isArray(artifacts[key])) continue;
    const before = artifacts[key].length;
    artifacts[key] = artifacts[key].filter((item) => normalizePageId(item?.pageId || item?.pageNumber) !== pageId);
    if (artifacts[key].length !== before) invalidated.push(`${key}:${pageId}`);
  }
  if (Array.isArray(artifacts.editableWorkerTasks)) {
    artifacts.editableWorkerTasks = artifacts.editableWorkerTasks.map((task) => (
      normalizePageId(task?.pageId || task?.pageNumber) === pageId
        ? {
          ...task,
          status: "ready",
          agentId: "",
          workerName: "",
          claimedAt: "",
          dispatchAt: "",
          heartbeatAt: "",
          recordedAt: "",
          error: "",
          message: "waiting for regenerated visual page and refreshed worker prompt"
        }
        : task
    ));
    invalidated.push(`editableWorkerTasks:${pageId}`);
  }
  const staleVisualPageIds = [...new Set([
    ...(Array.isArray(artifacts.editableRun?.staleVisualPageIds) ? artifacts.editableRun.staleVisualPageIds : []),
    pageId
  ])];
  if (artifacts.editableRun) {
    artifacts.editableRun = {
      ...artifacts.editableRun,
      staleVisualPageIds,
      requiresVisualPageRefresh: true,
      updatedAt: new Date().toISOString()
    };
    invalidated.push(`editableRun:${pageId}`);
  }
  if (artifacts.editableHints) {
    artifacts.editableHints = {
      ...artifacts.editableHints,
      staleVisualPageIds,
      requiresVisualPageRefresh: true,
      updatedAt: new Date().toISOString()
    };
    invalidated.push(`editableHints:${pageId}`);
  }
  return invalidated;
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
