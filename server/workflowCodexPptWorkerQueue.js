import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { readWorkflowJob, saveWorkflowJob } from "./workflowJobs.js";
import { prepareCodexPptSlideRun, recordCodexPptSlideDispatch, recordCodexPptSlideResult } from "./workflowCodexPptRunState.js";
import { artifactRecord, assertWorkflowVisualGenerationAllowed, buildVisualImageRecord, discoverVisualImages, getRenderedPages, markStage, mergeVisualManifestRecords, parsePageSelection, readVisualManifest, upsertPage, visualManifestPath, writeVisualManifest, writeVisualPrompts } from "./workflowVisuals.js";
import { isCodexPptSampleApprovalCurrent } from "./workflowApprovals.js";

const TASK_STATUSES = ["ready", "claimed", "running", "recorded", "failed"];
const DOWNSTREAM_ARTIFACT_KEYS = [
  "visualManifest",
  "visualImages",
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
const VISUAL_RESULT_DOWNSTREAM_ARTIFACT_KEYS = [
  "imageDeck",
  "visualQuality",
  "visualQualityReview",
  "imageDeckReview",
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

export async function syncWorkflowCodexPptSlideTasks(jobId, options = {}) {
  let job = await readWorkflowJob(jobId);
  const styleReconciliation = await reconcileVisualImagesForCurrentSample(job);
  job.artifacts = {
    ...(job.artifacts || {}),
    ...(styleReconciliation.visualImages.length ? {
      visualImages: styleReconciliation.visualImages,
      visualManifest: artifactRecord("visual_images_manifest", styleReconciliation.manifestPath, { imageCount: styleReconciliation.visualImages.length })
    } : {})
  };
  const renderedPages = getRenderedPages(job);
  if (!renderedPages.length) throw new Error("No rendered source pages. Run source/render first.");
  const targetPages = await buildCodexPptSlideSourcePages(job, renderedPages);
  const prompts = await writeVisualPrompts(job, targetPages, options);
  const maxPages = Number.isFinite(Number(options.maxPages)) ? Math.max(1, Number(options.maxPages)) : targetPages.length;
  const selectedPages = parsePageSelection(options.pages || options.pageNumbers, targetPages.length).slice(0, maxPages);
  let slideRun = {
    deckSpec: job.artifacts?.codexPptDeckSpec,
    speech: job.artifacts?.codexPptSpeech,
    slideJobs: job.artifacts?.codexPptSlideJobs,
    slideRunState: job.artifacts?.codexPptSlideRunState,
    slidePrompts: job.artifacts?.codexPptSlidePrompts || []
  };
  const shouldPrepare = Boolean(options.force)
    || Boolean(options.forceSync)
    || shouldRefreshSlideRun(slideRun, selectedPages, targetPages.length)
    || !job.artifacts?.codexPptDeckSpec?.path
    || !job.artifacts?.codexPptSlideJobs?.path
    || !job.artifacts?.codexPptSlideRunState?.path;
  if (shouldPrepare) {
    const preparePages = options.forceSync && selectedPages.length
      ? targetPages.map((page) => page.pageNumber).filter(Boolean)
      : selectedPages;
    slideRun = await prepareCodexPptSlideRun(job, { renderedPages: targetPages, prompts, selectedPages: preparePages, options });
  }
  const tasks = mergeTasks(
    job.artifacts?.codexPptSlideWorkerTasks,
    slideRun.slidePrompts,
    await readSlideRunState(slideRun.slideRunState?.path),
    styleReconciliation.stalePageIds
  );
  const staleDeckInvalidation = invalidateStaleImageDeck(job.artifacts || {});
  job.artifacts = {
    ...staleDeckInvalidation.artifacts,
    visualPrompts: artifactRecord("visual_prompts", prompts.path),
    codexPptDeckSpec: slideRun.deckSpec,
    codexPptSpeech: slideRun.speech,
    codexPptSlideJobs: slideRun.slideJobs,
    codexPptSlideRunState: slideRun.slideRunState,
    codexPptSlidePrompts: slideRun.slidePrompts,
    codexPptSlideWorkerTasks: tasks
  };
  job.events = appendEvent(job.events, "codex-ppt.slide_tasks_synced", `Synced ${tasks.length} codex-ppt slide task(s)`, {
    pages: tasks.map((task) => task.pageId),
    renderedSourcePages: renderedPages.length,
    targetSlides: targetPages.length,
    invalidatedStaleArtifacts: staleDeckInvalidation.invalidatedKeys,
    staleStylePages: styleReconciliation.stalePageIds
  });
  job = await saveWorkflowJob(job);
  return toTaskBundle(job, tasks);
}

async function reconcileVisualImagesForCurrentSample(job = {}) {
  const images = Array.isArray(job.artifacts?.visualImages) ? job.artifacts.visualImages : [];
  const sample = job.artifacts?.visualSample || {};
  const samplePath = sample.path ? path.resolve(sample.path) : "";
  const enforceStyleLock = Boolean(sample.sha256 && samplePath && isCodexPptSampleApprovalCurrent(job));
  const visualImages = images.map((image) => {
    const references = (Array.isArray(image.referenceImagePaths) ? image.referenceImagePaths : [])
      .map((item) => path.resolve(item || ""));
    const matches = !enforceStyleLock
      || image.approvedSampleSha256 === sample.sha256
      || references.includes(samplePath);
    return {
      ...image,
      staleStyleReference: !matches,
      styleLockStatus: matches ? "current" : "stale",
      currentApprovedSampleSha256: sample.sha256 || ""
    };
  });
  const manifestPath = visualManifestPath(job);
  if (visualImages.length) await writeVisualManifest(manifestPath, visualImages, { styleReconciledAt: new Date().toISOString() });
  return {
    visualImages,
    manifestPath,
    stalePageIds: visualImages.filter((image) => image.staleStyleReference).map((image) => image.pageId).filter(Boolean)
  };
}

export function invalidateStaleImageDeck(artifacts = {}) {
  const visualImages = Array.isArray(artifacts.visualImages) ? artifacts.visualImages.filter((image) => image?.path) : [];
  const visualCount = visualImages.filter((image) => image.staleStyleReference !== true).length;
  const staleVisualCount = visualImages.filter((image) => image.staleStyleReference === true).length;
  const imageDeckPageCount = Number(artifacts.imageDeck?.pageCount || 0);
  if (staleVisualCount === 0 && (!artifacts.imageDeck?.path || (visualCount > 0 && imageDeckPageCount === visualCount))) {
    return { artifacts, invalidatedKeys: [] };
  }
  return invalidateDownstreamArtifacts(artifacts, [
    "imageDeck",
    "imageDeckReview",
    "visualQuality",
    "visualQualityReview",
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
  ], {
    reason: staleVisualCount
      ? `image deck includes ${staleVisualCount} page(s) generated without the current approved sample reference`
      : `stale image deck covers ${imageDeckPageCount}/${visualCount} current visual pages`
  });
}

function shouldRefreshSlideRun(slideRun = {}, selectedPages = [], targetCount = 0) {
  const prompts = Array.isArray(slideRun.slidePrompts) ? slideRun.slidePrompts : [];
  const promptPages = new Set(prompts.map((prompt) => Number(prompt.pageNumber || 0)).filter(Boolean));
  if (targetCount && prompts.length < Math.min(targetCount, selectedPages.length || targetCount)) return true;
  if (Array.isArray(selectedPages) && selectedPages.length) {
    return selectedPages.some((pageNumber) => !promptPages.has(Number(pageNumber)));
  }
  return false;
}

export async function listWorkflowCodexPptSlideTasks(jobId) {
  const job = await readWorkflowJob(jobId);
  const stalePageIds = (Array.isArray(job.artifacts?.visualImages) ? job.artifacts.visualImages : [])
    .filter((image) => image?.staleStyleReference === true)
    .map((image) => image.pageId)
    .filter(Boolean);
  const tasks = mergeTasks(
    job.artifacts?.codexPptSlideWorkerTasks,
    job.artifacts?.codexPptSlidePrompts || [],
    await readSlideRunState(job.artifacts?.codexPptSlideRunState?.path),
    stalePageIds
  );
  return toTaskBundle(job, tasks);
}

export async function claimWorkflowCodexPptSlideTask(jobId, pageId, options = {}) {
  const agentId = cleanString(options.agentId || "");
  if (!agentId) throw new Error("agentId is required");
  if (options.spawned !== true && options.confirmSpawned !== true) {
    throw new Error("Refusing to claim codex-ppt slide task without spawned=true. Record dispatch only after a real slide worker/subagent has started.");
  }
  let bundle = await ensureTasks(jobId, options);
  const pageTask = findTask(bundle.tasks, pageId);
  if (!pageTask) throw new Error(`Codex slide task not found: ${pageId}`);
  if (pageTask.status === "recorded") throw new Error(`Codex slide task already recorded: ${pageTask.pageId}`);
  if (pageTask.agentId && pageTask.agentId !== agentId) throw new Error(`Task belongs to another agent: ${pageTask.agentId}`);
  let job = await readWorkflowJob(jobId);
  const slideRun = await recordCodexPptSlideDispatch({
    slideJobs: job.artifacts?.codexPptSlideJobs,
    slideRunState: job.artifacts?.codexPptSlideRunState
  }, {
    pageNumber: pageTask.pageNumber,
    agentId,
    mode: cleanString(options.dispatchMode || "external-slide-worker")
  });
  const tasks = updateTask(job, pageTask.pageId, {
    status: "running",
    agentId,
    workerName: cleanString(options.workerName || options.agentNickname || ""),
    claimedAt: pageTask.claimedAt || new Date().toISOString(),
    dispatchAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    attempts: Number(pageTask.attempts || 0) + 1,
    error: "",
    message: cleanString(options.message || "claimed by external slide worker")
  });
  job.artifacts = {
    ...(job.artifacts || {}),
    codexPptSlideJobs: slideRun.slideJobs,
    codexPptSlideRunState: slideRun.slideRunState,
    codexPptSlideWorkerTasks: tasks
  };
  job.currentStage = "visual_generating";
  job.status = "visual_generating";
  job.stageStatus = "running";
  job.stages.visual_generating = markStage(job.stages.visual_generating, "running", "Codex-ppt slide worker claimed task", { pageId: pageTask.pageId, agentId });
  job.events = appendEvent(job.events, "codex-ppt.slide_task_claimed", `Slide worker claimed ${pageTask.pageId}`, { pageId: pageTask.pageId, agentId });
  job = await saveWorkflowJob(job);
  return listWorkflowCodexPptSlideTasks(job.id);
}

export async function heartbeatWorkflowCodexPptSlideTask(jobId, pageId, options = {}) {
  const agentId = cleanString(options.agentId || "");
  const job = await readWorkflowJob(jobId);
  const pageTask = findTask(job.artifacts?.codexPptSlideWorkerTasks || [], pageId);
  if (!pageTask) throw new Error(`Codex slide task not found: ${pageId}`);
  if (agentId && pageTask.agentId && pageTask.agentId !== agentId) throw new Error(`Task belongs to another agent: ${pageTask.agentId}`);
  const tasks = updateTask(job, pageTask.pageId, {
    status: pageTask.status === "ready" ? "claimed" : pageTask.status,
    agentId: pageTask.agentId || agentId,
    heartbeatAt: new Date().toISOString(),
    message: cleanString(options.message || pageTask.message || "")
  });
  job.artifacts = { ...(job.artifacts || {}), codexPptSlideWorkerTasks: tasks };
  const saved = await saveWorkflowJob(job);
  return listWorkflowCodexPptSlideTasks(saved.id);
}

export async function completeWorkflowCodexPptSlideTask(jobId, pageId, options = {}) {
  const agentId = cleanString(options.agentId || "");
  if (!agentId) throw new Error("agentId is required");
  const imagePath = path.resolve(cleanString(options.imagePath || options.selectedImagePath || ""));
  if (!imagePath || !fsSync.existsSync(imagePath) || !fsSync.statSync(imagePath).isFile()) throw new Error("imagePath must point to an existing image file");
  assertWorkflowVisualGenerationAllowed(options);

  let job = await readWorkflowJob(jobId);
  const pageTask = findTask(job.artifacts?.codexPptSlideWorkerTasks || [], pageId);
  if (!pageTask) throw new Error(`Codex slide task not found: ${pageId}`);
  if (pageTask.agentId && pageTask.agentId !== agentId) throw new Error(`Task belongs to another agent: ${pageTask.agentId}`);
  const page = getRenderedPages(job).find((item) => item.pageNumber === pageTask.pageNumber) || {};
  const prompt = job.artifacts?.codexPptSlidePrompts?.find((item) => item.pageId === pageTask.pageId) || {};
  const ext = safeImageExtension(path.extname(imagePath));
  const outputPath = path.join(job.dirs.visualImages, `${pageTask.pageId}${ext}`);
  await fs.mkdir(job.dirs.visualImages, { recursive: true });
  if (path.resolve(imagePath) !== path.resolve(outputPath)) await fs.copyFile(imagePath, outputPath);
  const record = await buildVisualImageRecord({
    result: {
      id: `codex_slide_${Date.now()}`,
      path: outputPath,
      provider: cleanString(options.provider || options.backend?.provider || job.artifacts?.codexPptBackend?.provider || ""),
      baseUrl: cleanString(options.baseUrl || options.backend?.baseUrl || job.artifacts?.codexPptBackend?.baseUrl || ""),
      model: cleanString(options.model || options.backend?.model || job.artifacts?.codexPptBackend?.model || ""),
      dryRun: Boolean(options.dryRun || options.passthrough),
      source: cleanString(options.source || "external-slide-worker"),
      imageInputMode: cleanString(options.imageInputMode || ""),
      sourceImagePath: cleanString(options.sourceImagePath || ""),
      referenceImagePaths: Array.isArray(options.referenceImagePaths) ? options.referenceImagePaths : [],
      approvedSampleSha256: cleanString(options.approvedSampleSha256 || ""),
      qaNote: cleanString(options.qaNote || "")
    },
    job,
    page,
    pageNumber: pageTask.pageNumber,
    outputPath,
    prompt: await readPromptText(prompt.path),
    extra: {
      agentId,
      workerName: cleanString(options.workerName || ""),
      recordedBy: "codex-ppt-slide-worker-task"
    }
  });
  const manifestPath = visualManifestPath(job);
  const previousManifest = await readVisualManifest(manifestPath);
  await writeVisualManifest(manifestPath, mergeVisualManifestRecords(previousManifest.images, [record]));
  const allExisting = await discoverVisualImages(job.dirs.visualImages, manifestPath);
  const slideRun = await recordCodexPptSlideResult({
    slideJobs: job.artifacts?.codexPptSlideJobs,
    slideRunState: job.artifacts?.codexPptSlideRunState
  }, {
    pageNumber: pageTask.pageNumber,
    imageRecord: record,
    qaNote: options.qaNote || ""
  });
  const tasks = updateTask(job, pageTask.pageId, {
    status: "recorded",
    agentId,
    heartbeatAt: new Date().toISOString(),
    recordedAt: new Date().toISOString(),
    imagePath: outputPath,
    imageSha256: record.sha256 || "",
    error: "",
    message: cleanString(options.qaNote || "external slide worker result recorded")
  });
  const selectedTotal = Number(slideRun.slideRunState?.total || tasks.length || 0);
  const recordedCount = Number(slideRun.slideRunState?.recorded || 0);
  const failedCount = Number(slideRun.slideRunState?.failed || 0);
  const complete = selectedTotal > 0 && recordedCount >= selectedTotal && failedCount === 0;
  const invalidation = invalidateDownstreamArtifacts(job.artifacts || {}, VISUAL_RESULT_DOWNSTREAM_ARTIFACT_KEYS, {
    reason: `visual image changed for ${pageTask.pageId}`,
    pages: [pageTask.pageId]
  });
  job.artifacts = {
    ...invalidation.artifacts,
    codexPptSlideJobs: slideRun.slideJobs,
    codexPptSlideRunState: slideRun.slideRunState,
    codexPptSlideWorkerTasks: tasks,
    visualManifest: artifactRecord("visual_images_manifest", manifestPath, { imageCount: allExisting.length }),
    visualImages: allExisting
  };
  job.pages = upsertPage(job.pages, pageTask.pageNumber, "recorded", "codex-ppt slide image ready", { visualImagePath: outputPath, agentId });
  job.currentStage = complete ? "image_deck_ready" : "visual_generating";
  job.status = complete ? "image_deck_ready" : "visual_generating";
  job.stageStatus = complete ? "complete" : "running";
  job.stages.visual_generating = markStage(job.stages.visual_generating, complete ? "complete" : "running", complete ? "All codex-ppt slide worker results recorded" : "Codex-ppt slide worker result recorded", {
    recorded: recordedCount,
    total: selectedTotal
  });
  if (complete) job.stages.image_deck_ready = markStage(job.stages.image_deck_ready, "pending", "Visual images ready; image deck assembly pending", { visualImages: allExisting.length });
  job.events = appendEvent(job.events, "codex-ppt.slide_task_recorded", `Slide worker recorded ${pageTask.pageId}`, { pageId: pageTask.pageId, agentId, imagePath: outputPath });
  job = await saveWorkflowJob(job);
  return listWorkflowCodexPptSlideTasks(job.id);
}

export async function resetWorkflowCodexPptSlideTask(jobId, pageId, options = {}) {
  const bundle = await ensureTasks(jobId, options);
  const pageTask = findTask(bundle.tasks, pageId);
  if (!pageTask) throw new Error(`Codex slide task not found: ${pageId}`);
  if (pageTask.status === "recorded" && !options.forceRecorded) throw new Error(`Recorded task cannot be reset without force: ${pageTask.pageId}`);
  const job = await readWorkflowJob(jobId);
  const tasks = updateTask(job, pageTask.pageId, {
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
    message: cleanString(options.reason || "reset for retry")
  });
  job.artifacts = { ...(job.artifacts || {}), codexPptSlideWorkerTasks: tasks };
  job.events = appendEvent(job.events, "codex-ppt.slide_task_reset", `Slide task reset ${pageTask.pageId}`, { pageId: pageTask.pageId, previousStatus: pageTask.status });
  const saved = await saveWorkflowJob(job);
  return listWorkflowCodexPptSlideTasks(saved.id);
}

export async function resetWorkflowNonProductCodexPptSlides(jobId, options = {}) {
  const bundle = await listWorkflowCodexPptSlideTasks(jobId);
  const selectedPages = parsePageSelection(options.pages || options.pageNumbers, bundle.tasks.length);
  const candidates = (bundle.tasks || [])
    .filter((task) => task.status === "recorded")
    .filter((task) => !selectedPages.length || selectedPages.includes(Number(task.pageNumber || 0)))
    .filter((task) => isNonProductRecordedSlideTask(task));
  const preview = {
    ok: true,
    jobId,
    mode: "non-product-recorded-slide-reset",
    preview: options.confirmNonProductReset !== true,
    requestedPages: selectedPages,
    candidateCount: candidates.length,
    candidates: candidates.map((task) => ({
      pageId: task.pageId,
      pageNumber: task.pageNumber,
      status: task.status,
      agentId: task.agentId || "",
      message: task.message || "",
      imagePath: task.imagePath || ""
    })),
    skippedRecorded: (bundle.tasks || [])
      .filter((task) => task.status === "recorded" && (!selectedPages.length || selectedPages.includes(Number(task.pageNumber || 0))) && !isNonProductRecordedSlideTask(task))
      .map((task) => ({ pageId: task.pageId, pageNumber: task.pageNumber, reason: "recorded task does not look like non-product evidence" }))
  };
  if (options.confirmNonProductReset !== true) return preview;
  let job = await readWorkflowJob(jobId);
  if (!candidates.length && options.forceDownstreamInvalidation !== true) {
    throw new Error("No non-product recorded codex-ppt slide tasks are eligible for reset.");
  }
  let tasks = Array.isArray(job.artifacts?.codexPptSlideWorkerTasks) ? job.artifacts.codexPptSlideWorkerTasks : [];
  for (const candidate of candidates) {
    tasks = tasks.map((task) => normalizePageId(task.pageId) === normalizePageId(candidate.pageId)
      ? normalizeTask({
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
        message: cleanString(options.reason || "reset non-product codex-ppt slide evidence for product rerun")
      })
      : task);
  }
  const resetDetails = {
    reason: cleanString(options.reason || "reset non-product codex-ppt slide evidence for product rerun"),
    reset: candidates.length,
    pages: candidates.map((task) => task.pageId)
  };
  const invalidation = invalidateDownstreamArtifacts(job.artifacts || {}, DOWNSTREAM_ARTIFACT_KEYS, resetDetails);
  const slideArtifacts = await resetSlideRunArtifacts(invalidation.artifacts, candidates.length ? candidates : tasks, options);
  job.artifacts = {
    ...invalidation.artifacts,
    ...slideArtifacts,
    codexPptSlideWorkerTasks: tasks
  };
  job.currentStage = "visual_generating";
  job.status = "visual_generating";
  job.stageStatus = "pending";
  job.stages.visual_generating = markStage(job.stages.visual_generating, "pending", "Non-product codex-ppt slide evidence reset for product rerun", {
    reset: candidates.length,
    pages: resetDetails.pages,
    invalidatedArtifacts: invalidation.invalidatedKeys
  });
  job.events = appendEvent(job.events, "codex-ppt.slide_tasks_non_product_reset", `Reset ${candidates.length} non-product codex-ppt slide task(s)`, {
    pages: resetDetails.pages,
    reason: resetDetails.reason,
    invalidatedArtifacts: invalidation.invalidatedKeys
  });
  job = await saveWorkflowJob(job);
  const next = await listWorkflowCodexPptSlideTasks(job.id);
  return {
    ...preview,
    preview: false,
    reset: candidates.length,
    invalidatedArtifacts: invalidation.invalidatedKeys,
    taskBundle: next
  };
}

export async function markWorkflowCodexPptSlideTaskFailed(jobId, pageId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const pageTask = findTask(job.artifacts?.codexPptSlideWorkerTasks || [], pageId);
  if (!pageTask) throw new Error(`Codex slide task not found: ${pageId}`);
  const tasks = updateTask(job, pageTask.pageId, {
    status: "failed",
    agentId: cleanString(options.agentId || pageTask.agentId || ""),
    heartbeatAt: new Date().toISOString(),
    error: cleanString(options.error || options.message || "codex-ppt slide task failed"),
    message: cleanString(options.message || "failed during codex-ppt slide batch")
  });
  job.artifacts = { ...(job.artifacts || {}), codexPptSlideWorkerTasks: tasks };
  job.pages = upsertPage(job.pages, pageTask.pageNumber, "failed", options.error || "codex-ppt slide task failed", {
    agentId: options.agentId || pageTask.agentId || "",
    stage: "codex-ppt-slide-worker"
  });
  job.events = appendEvent(job.events, "codex-ppt.slide_task_failed", `Slide task failed ${pageTask.pageId}`, {
    pageId: pageTask.pageId,
    agentId: options.agentId || pageTask.agentId || "",
    error: options.error || ""
  });
  const saved = await saveWorkflowJob(job);
  return listWorkflowCodexPptSlideTasks(saved.id);
}

function isNonProductRecordedSlideTask(task = {}) {
  const text = [
    task.agentId,
    task.workerName,
    task.message,
    task.provider,
    task.model,
    task.source,
    task.imagePath
  ].join(" ");
  return /\b(regression|dry[-_\s]?run|passthrough|placeholder|source[-_\s]?page[-_\s]?passthrough)\b/i.test(text);
}

function invalidateDownstreamArtifacts(artifacts = {}, keys = [], details = {}) {
  const remaining = { ...(artifacts || {}) };
  const invalidated = {};
  for (const key of keys) {
    const value = remaining[key];
    if (!artifactHasValue(value)) continue;
    invalidated[key] = value;
    delete remaining[key];
  }
  const invalidatedKeys = Object.keys(invalidated);
  if (!invalidatedKeys.length) return { artifacts: remaining, invalidatedKeys };
  const prior = Array.isArray(remaining.invalidatedArtifacts) ? remaining.invalidatedArtifacts : [];
  const entry = {
    kind: "invalidated_artifacts",
    source: "codex-ppt-slide-reset",
    invalidatedAt: new Date().toISOString(),
    reason: cleanString(details.reason || ""),
    reset: Number(details.reset || 0),
    pages: Array.isArray(details.pages) ? details.pages : [],
    keys: invalidatedKeys,
    artifacts: invalidated
  };
  return {
    artifacts: {
      ...remaining,
      invalidatedArtifacts: [...prior, entry].slice(-20)
    },
    invalidatedKeys
  };
}

function artifactHasValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (!value) return false;
  if (typeof value !== "object") return true;
  return Object.keys(value).length > 0;
}

async function resetSlideRunArtifacts(artifacts = {}, resetItems = [], options = {}) {
  const result = {};
  const resetPages = new Set(
    (Array.isArray(resetItems) ? resetItems : [])
      .map((item) => Number(item.pageNumber || normalizePageId(item.pageId).match(/\d+/)?.[0] || 0))
      .filter(Boolean)
  );
  const resetAll = options.forceDownstreamInvalidation === true && !resetPages.size;
  const slideJobsPath = artifacts.codexPptSlideJobs?.path || "";
  const slideRunStatePath = artifacts.codexPptSlideRunState?.path || "";
  if (slideJobsPath) {
    const slideJobs = await readJsonSafe(slideJobsPath);
    const next = resetSlideBundle(slideJobs, resetPages, resetAll);
    if (next.changed) {
      await writeJson(slideJobsPath, next.bundle);
      result.codexPptSlideJobs = artifactRecord("codex_ppt_slide_jobs", slideJobsPath, summarizeSlides(next.bundle.slides));
    }
  }
  if (slideRunStatePath) {
    const slideRunState = await readJsonSafe(slideRunStatePath);
    const next = resetSlideBundle(slideRunState, resetPages, resetAll);
    if (next.changed) {
      await writeJson(slideRunStatePath, next.bundle);
      result.codexPptSlideRunState = artifactRecord("codex_ppt_slide_run_state", slideRunStatePath, summarizeSlides(next.bundle.slides));
    }
  }
  return result;
}

function resetSlideBundle(bundle = {}, resetPages = new Set(), resetAll = false) {
  if (!Array.isArray(bundle.slides)) return { bundle, changed: false };
  let changed = false;
  const now = new Date().toISOString();
  const slides = bundle.slides.map((slide) => {
    const pageNumber = Number(slide.pageNumber || 0);
    if (!resetAll && !resetPages.has(pageNumber)) return slide;
    changed = true;
    return {
      ...slide,
      status: "pending",
      backend: {},
      agentId: "",
      dispatchedAt: "",
      recordedAt: "",
      imagePath: "",
      imageSha256: "",
      qaNote: "",
      dispatchMode: "",
      updatedAt: now
    };
  });
  if (!changed) return { bundle, changed: false };
  const summary = summarizeSlides(slides);
  return {
    bundle: {
      ...bundle,
      updatedAt: now,
      summary,
      slides,
      total: summary.total,
      pending: summary.pending,
      dispatched: summary.dispatched,
      recorded: summary.recorded,
      failed: summary.failed,
      complete: summary.complete
    },
    changed: true
  };
}

function summarizeSlides(slides = []) {
  const normalized = Array.isArray(slides) ? slides : [];
  const total = normalized.length;
  const pending = normalized.filter((slide) => !slide.status || slide.status === "pending").length;
  const dispatched = normalized.filter((slide) => slide.status === "dispatched").length;
  const recorded = normalized.filter((slide) => slide.status === "recorded").length;
  const failed = normalized.filter((slide) => slide.status === "failed").length;
  return {
    total,
    pending,
    dispatched,
    recorded,
    failed,
    complete: total > 0 && recorded >= total && failed === 0
  };
}

async function readJsonSafe(filePath = "") {
  if (!filePath || !fsSync.existsSync(filePath)) return {};
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return {};
  }
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function ensureTasks(jobId, options = {}) {
  const current = await listWorkflowCodexPptSlideTasks(jobId);
  if (current.tasks.length) return current;
  return syncWorkflowCodexPptSlideTasks(jobId, options);
}

async function buildCodexPptSlideSourcePages(job = {}, renderedPages = []) {
  const outline = await readOutlineArtifact(job);
  const outlineSequence = Array.isArray(outline.layoutSequence) ? outline.layoutSequence : [];
  const targetCount = clampInteger(job.artifacts?.codexPptOutline?.slideCount || outline.slideCount || outlineSequence.length || renderedPages.length, 1, 500, renderedPages.length || 1);
  const renderedByNumber = new Map(renderedPages.map((page) => [Number(page.pageNumber), page]));
  return Array.from({ length: targetCount }, (_item, index) => {
    const pageNumber = index + 1;
    const rendered = renderedByNumber.get(pageNumber);
    const outlineStep = outlineSequence[index] || {};
    if (rendered) {
      return {
        ...rendered,
        layout: cleanString(outlineStep.layout || rendered.layout || ""),
        storyRole: cleanString(outlineStep.storyRole || rendered.storyRole || ""),
        visualIntent: cleanString(outlineStep.visualIntent || rendered.visualIntent || ""),
        outlineTitle: cleanString(outlineStep.title || ""),
        outlinePurpose: cleanString(outlineStep.purpose || ""),
        outlineEvidence: cleanString(outlineStep.evidence || ""),
        outlineStoryRole: cleanString(outlineStep.storyRole || ""),
        outlineVisualIntent: cleanString(outlineStep.visualIntent || ""),
        outlineNotes: cleanString(outlineStep.notes || "")
      };
    }
    return {
      pageId: `page_${String(pageNumber).padStart(3, "0")}`,
      pageNumber,
      kind: "outline_slide",
      format: "codex-ppt-outline",
      layout: cleanString(outlineStep.layout || "content"),
      storyRole: cleanString(outlineStep.storyRole || ""),
      visualIntent: cleanString(outlineStep.visualIntent || ""),
      path: "",
      sourcePagePath: "",
      title: cleanString(outlineStep.title || `Slide ${pageNumber}`),
      outlineTitle: cleanString(outlineStep.title || `Slide ${pageNumber}`),
      outlinePurpose: cleanString(outlineStep.purpose || outlineStep.visualIntent || "Create a visually unified slide from the approved brief and outline."),
      outlineEvidence: cleanString(outlineStep.evidence || job.input?.sourceBrief || ""),
      outlineStoryRole: cleanString(outlineStep.storyRole || ""),
      outlineVisualIntent: cleanString(outlineStep.visualIntent || ""),
      outlineNotes: cleanString(outlineStep.notes || ""),
      width: renderedPages[0]?.width || 1280,
      height: renderedPages[0]?.height || 720
    };
  });
}

async function readOutlineArtifact(job = {}) {
  const outlinePath = job.artifacts?.codexPptOutline?.path || "";
  if (!outlinePath || !fsSync.existsSync(outlinePath)) return {};
  try {
    return JSON.parse(await fs.readFile(outlinePath, "utf8"));
  } catch {
    return {};
  }
}

function toTaskBundle(job, tasks) {
  const normalized = tasks.map(normalizeTask).sort((a, b) => a.pageId.localeCompare(b.pageId));
  return {
    ok: true,
    jobId: job.id,
    tasks: normalized,
    prompts: job.artifacts?.codexPptSlidePrompts || [],
    artifacts: {
      deckSpec: job.artifacts?.codexPptDeckSpec || null,
      slideJobs: job.artifacts?.codexPptSlideJobs || null,
      slideRunState: job.artifacts?.codexPptSlideRunState || null
    },
    summary: {
      total: normalized.length,
      ready: normalized.filter((task) => task.status === "ready").length,
      running: normalized.filter((task) => task.status === "claimed" || task.status === "running").length,
      recorded: normalized.filter((task) => task.status === "recorded").length,
      failed: normalized.filter((task) => task.status === "failed").length
    }
  };
}

export function mergeTasks(existingTasks = [], prompts = [], slideRunState = {}, stalePageIds = []) {
  const existingByPage = new Map((Array.isArray(existingTasks) ? existingTasks : []).map((task) => [normalizePageId(task.pageId), normalizeTask(task)]));
  const slideByPage = new Map((Array.isArray(slideRunState.slides) ? slideRunState.slides : []).map((slide) => [normalizePageId(slide.pageId), slide]));
  const stalePages = new Set((Array.isArray(stalePageIds) ? stalePageIds : []).map(normalizePageId).filter(Boolean));
  return (Array.isArray(prompts) ? prompts : []).map((prompt) => {
    const pageId = normalizePageId(prompt.pageId);
    const existing = existingByPage.get(pageId) || {};
    const slide = slideByPage.get(pageId) || {};
    const staleStyleReference = stalePages.has(pageId);
    const hasSlideState = Boolean(slide.pageId || slide.slideId || slide.pageNumber);
    const slideRecorded = !staleStyleReference && slide.status === "recorded" && slide.imagePath && fsSync.existsSync(slide.imagePath);
    const existingRecorded = !staleStyleReference && existing.status === "recorded" && existing.imagePath && fsSync.existsSync(existing.imagePath);
    const status = staleStyleReference
      ? "ready"
      : slideRecorded || existingRecorded
      ? (hasSlideState ? (slideRecorded ? "recorded" : slide.status === "dispatched" ? "running" : "ready") : "recorded")
      : hasSlideState ? (slide.status === "dispatched" ? "running" : "ready") : existing.status || "ready";
    return normalizeTask({
      ...existing,
      pageId,
      slideId: prompt.slideId || slide.slideId || "",
      pageNumber: Number(prompt.pageNumber || slide.pageNumber || pageId.match(/\d+/)?.[0] || 0),
      promptFile: prompt.path || slide.promptPath || "",
      relativePath: prompt.relativePath || "",
      status,
      agentId: status === "ready" ? "" : slide.agentId || existing.agentId || "",
      dispatchAt: status === "ready" ? "" : slide.dispatchedAt || existing.dispatchAt || "",
      recordedAt: status === "recorded" ? slide.recordedAt || existing.recordedAt || "" : "",
      imagePath: status === "recorded" ? slide.imagePath || existing.imagePath || "" : "",
      imageSha256: status === "recorded" ? slide.imageSha256 || existing.imageSha256 || "" : "",
      createdAt: existing.createdAt || prompt.createdAt || slide.createdAt || new Date().toISOString(),
      updatedAt: existing.updatedAt || slide.recordedAt || slide.dispatchedAt || new Date().toISOString()
    });
  });
}

function updateTask(job, pageId, patch) {
  const now = new Date().toISOString();
  const page = normalizePageId(pageId);
  const tasks = Array.isArray(job.artifacts?.codexPptSlideWorkerTasks) ? job.artifacts.codexPptSlideWorkerTasks.map(normalizeTask) : [];
  const index = tasks.findIndex((task) => task.pageId === page);
  const existing = index >= 0 ? tasks[index] : { pageId: page, createdAt: now };
  const next = normalizeTask({ ...existing, ...patch, pageId: page, updatedAt: now });
  if (index >= 0) tasks[index] = next;
  else tasks.push(next);
  return tasks.sort((a, b) => a.pageId.localeCompare(b.pageId));
}

function normalizeTask(task = {}) {
  const status = TASK_STATUSES.includes(task.status) ? task.status : "ready";
  return {
    pageId: normalizePageId(task.pageId || task.page || ""),
    slideId: cleanString(task.slideId || ""),
    pageNumber: Number(task.pageNumber || 0),
    status,
    promptFile: cleanString(task.promptFile || ""),
    relativePath: cleanString(task.relativePath || ""),
    agentId: cleanString(task.agentId || ""),
    workerName: cleanString(task.workerName || ""),
    attempts: Number.isFinite(Number(task.attempts)) ? Number(task.attempts) : 0,
    claimedAt: cleanString(task.claimedAt || ""),
    dispatchAt: cleanString(task.dispatchAt || ""),
    heartbeatAt: cleanString(task.heartbeatAt || ""),
    recordedAt: cleanString(task.recordedAt || ""),
    imagePath: cleanString(task.imagePath || ""),
    imageSha256: cleanString(task.imageSha256 || ""),
    error: cleanString(task.error || ""),
    message: cleanString(task.message || ""),
    createdAt: cleanString(task.createdAt || new Date().toISOString()),
    updatedAt: cleanString(task.updatedAt || task.createdAt || new Date().toISOString())
  };
}

function findTask(tasks = [], pageId = "") {
  const normalized = normalizePageId(pageId);
  return tasks.map(normalizeTask).find((task) => task.pageId === normalized) || null;
}

async function readSlideRunState(filePath = "") {
  if (!filePath || !fsSync.existsSync(filePath)) return {};
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readPromptText(filePath = "") {
  if (!filePath || !fsSync.existsSync(filePath)) return "";
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  return parsed.prompt || "";
}

function normalizePageId(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d+$/.test(raw)) return `page_${String(Number(raw)).padStart(3, "0")}`;
  return /^page_\d{3}$/i.test(raw) ? raw.toLowerCase() : "";
}

function safeImageExtension(ext = "") {
  const lower = String(ext || "").toLowerCase();
  return [".png", ".jpg", ".jpeg", ".webp", ".svg"].includes(lower) ? lower : ".png";
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
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
