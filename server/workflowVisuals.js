import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import pptxgen from "pptxgenjs";
import { imageSize } from "image-size";
import { analyzeGeneratedImage } from "./imageQa.js";
import { analyzeStyleReference } from "./styleFingerprint.js";
import { editImageWithProvider, generateImageWithProvider, getProviderConfig } from "./providers.js";
import { readWorkflowJob, saveWorkflowJob } from "./workflowJobs.js";
import { assertWorkflowImageDeckReviewReady } from "./workflowImageDeckReview.js";
import { isCodexPptSampleApprovalCurrent } from "./workflowApprovals.js";
import { prepareCodexPptSlideRun, recordCodexPptSlideDispatch, recordCodexPptSlideResult } from "./workflowCodexPptRunState.js";
import { getWorkflowOcrCoverage } from "./workflowOcr.js";
import { consumeExternalImageSpendAuthorization } from "./workflowAuthorizations.js";
import {
  buildDeckDesignContract,
  buildDeckStyleSpec,
  classifyDeckText,
  formatDeckStyleSpecPrompt,
  getRoleTypography,
  inferPageNumberPolicyFromOcrHints,
  inferDeckPageRole,
  isClosingLabelText,
  isSemanticClosingText,
  resolveVisualSampleSelection
} from "./workflowDeckDesignSystem.js";
import { buildDeckStyleConsistencyReport } from "./workflowStyleConsistency.js";

export { buildDeckStyleConsistencyReport } from "./workflowStyleConsistency.js";

const SLIDE_W = 13.333;
const SLIDE_H = 7.5;
const VISUAL_IMAGE_W = 1536;
const VISUAL_IMAGE_H = 864;
const IMAGE_RE = /\.(png|jpe?g|webp|svg)$/i;
const VISUAL_IMAGES_MANIFEST = "visual_images_manifest.json";
const VISUAL_SAMPLE_MANIFEST = "visual_sample_manifest.json";
const VISUAL_QUALITY_REPORT = "visual_quality_report.json";

export async function generateWorkflowVisualSample(jobId, options = {}) {
  let job = await readWorkflowJob(jobId);
  assertWorkflowVisualGenerationAllowed(options);
  const renderedPages = mergeOutlineMetadata(job, getRenderedPages(job));
  if (!renderedPages.length) throw new Error("No rendered source pages. Run source/render first.");
  const sampleSelection = resolveVisualSampleSelection(
    addSourceOcrForSampleSelection(job, renderedPages),
    withSampleRolePreference(job, options)
  );
  assertVisualSampleSelectionAllowed(sampleSelection);
  const pageNumber = clampPageNumber(sampleSelection?.pageNumber || 1, renderedPages.length);
  const page = sampleSelection?.page || renderedPages.find((item) => Number(item.pageNumber) === pageNumber) || renderedPages[pageNumber - 1];
  if (options.authorizationSource === "authorization-ledger") {
    job = (await consumeExternalImageSpendAuthorization(jobId, {
      scope: "visual-sample",
      imageCalls: 1,
      runId: `visual-sample-${jobId}-${Date.now()}`,
      consumedBy: options.requestedBy || "visual-sample"
    })).job;
  }
  const startedAt = new Date().toISOString();
  await ensureVisualDirs(job);
  const continuityReference = await resolveRetainedVisualContinuityReference(job, page.pageId);
  const generationOptions = continuityReference
    ? {
      ...options,
      continuityReferenceImagePath: continuityReference.path,
      continuityReferencePageId: continuityReference.pageId,
      continuityReferenceSha256: continuityReference.sha256,
      continuityStyleFingerprint: await analyzeApprovedSampleStyle(continuityReference.path)
    }
    : options;
  const prompts = await writeVisualPrompts(job, renderedPages, generationOptions);
  const result = await createVisualImageForPage(job, page, prompts.pages[pageNumber - 1], {
    ...generationOptions,
    prefix: `workflow_sample_${job.id}_${page.pageId}`,
    sample: true
  });
  const sampleRecordDraft = {
    ...result,
    pageId: page.pageId,
    pageNumber,
    sourcePagePath: page.path,
    startedAt,
    finishedAt: new Date().toISOString()
  };
  const samplePath = path.join(job.dirs.visualImages, `sample_${page.pageId}${path.extname(result.path) || ".png"}`);
  await fs.copyFile(result.path, samplePath);
  const sampleStyleFingerprint = await analyzeApprovedSampleStyle(samplePath);
  const sampleRecord = await buildVisualImageRecord({
    result: sampleRecordDraft,
    job,
    page,
    pageNumber,
    outputPath: samplePath,
    prompt: prompts.pages[pageNumber - 1].prompt,
    extra: {
      sample: true,
      sampleRole: inferDeckPageRole(page, { totalPages: renderedPages.length }),
      sampleSelection: sampleSelection?.mode || "representative-content-page",
      requestedSamplePageNumber: sampleSelection?.requestedPageNumber || null,
      overriddenRequestedSamplePage: Boolean(sampleSelection?.overriddenRequestedPage),
      samplePath,
      styleFingerprint: sampleStyleFingerprint,
      continuityReference: continuityReference ? {
        pageId: continuityReference.pageId,
        path: continuityReference.path,
        sha256: continuityReference.sha256
      } : null,
      startedAt,
      finishedAt: sampleRecordDraft.finishedAt
    }
  });
  const sampleManifestPath = path.join(job.dirs.visualImages, VISUAL_SAMPLE_MANIFEST);
  await writeVisualManifest(sampleManifestPath, [sampleRecord], { kind: "visual_sample_manifest" });

  job.artifacts = {
    ...(job.artifacts || {}),
    visualPrompts: artifactRecord("visual_prompts", prompts.path),
    visualSample: artifactRecord("visual_sample", samplePath, sampleRecord),
    visualSampleManifest: artifactRecord("visual_sample_manifest", sampleManifestPath, { imageCount: 1 })
  };
  job.currentStage = "visual_sample_ready";
  job.status = "visual_sample_ready";
  job.stageStatus = "complete";
  job.stages.visual_sample_ready = markStage(job.stages.visual_sample_ready, "complete", `Generated visual sample for ${page.pageId}`, {
    pageNumber,
    provider: sampleRecord.provider,
    dryRun: Boolean(sampleRecord.dryRun)
  });
  job.events = appendEvent(job.events, "visual.sample_ready", `Generated visual sample for ${page.pageId}`, {
    pageNumber,
    provider: sampleRecord.provider,
    dryRun: Boolean(sampleRecord.dryRun)
  });
  return saveWorkflowJob(job);
}

export function resolveWorkflowVisualSampleSelection(job = {}, options = {}) {
  const renderedPages = mergeOutlineMetadata(job, getRenderedPages(job));
  if (!renderedPages.length) return null;
  return resolveVisualSampleSelection(
    addSourceOcrForSampleSelection(job, renderedPages),
    withSampleRolePreference(job, options)
  );
}

export function assertVisualSampleSelectionAllowed(selection = null) {
  if (!selection?.blocked) return selection;
  const error = new Error(selection.blockerMessage || "The selected sample page is not representative of this deck.");
  error.code = selection.blockerCode || "CODEX_PPT_NON_REPRESENTATIVE_SAMPLE_REQUIRES_OPT_IN";
  error.pageNumber = selection.pageNumber || 0;
  error.recommendedPageNumber = selection.recommendedPageNumber || 0;
  throw error;
}

export async function generateWorkflowVisualImages(jobId, options = {}) {
  let job = await readWorkflowJob(jobId);
  assertWorkflowVisualGenerationAllowed(options);
  const renderedPages = getRenderedPages(job);
  if (!renderedPages.length) throw new Error("No rendered source pages. Run source/render first.");
  await ensureVisualDirs(job);
  const prompts = await writeVisualPrompts(job, renderedPages, options);
  const retainedSample = await retainApprovedSampleAsVisualImage(job, renderedPages);
  const maxPages = Number.isFinite(Number(options.maxPages)) ? Math.max(1, Number(options.maxPages)) : renderedPages.length;
  const selected = parsePageSelection(options.pages || options.pageNumbers, renderedPages.length).slice(0, maxPages);
  const authorizedPages = selected.filter((pageNumber) => !retainedSample || Number(retainedSample.pageNumber) !== Number(pageNumber));
  if (options.authorizationSource === "authorization-ledger" && authorizedPages.length) {
    job = (await consumeExternalImageSpendAuthorization(jobId, {
      scope: "full-deck",
      imageCalls: authorizedPages.length,
      pages: authorizedPages,
      pageSelection: authorizedPages.join(","),
      runId: `visual-deck-${jobId}-${Date.now()}`,
      consumedBy: options.requestedBy || "visual-generate"
    })).job;
  }
  let slideRun = await prepareCodexPptSlideRun(job, { renderedPages, prompts, selectedPages: selected, options });
  const records = retainedSample ? [retainedSample] : [];
  const errors = [];
  job.currentStage = "visual_generating";
  job.status = "visual_generating";
  job.stageStatus = "running";
  job.stages.visual_generating = markStage(job.stages.visual_generating, "running", "Generating visual slide images", { selectedPages: selected });

  for (const pageNumber of selected) {
    if (retainedSample && Number(retainedSample.pageNumber) === Number(pageNumber)) continue;
    const page = renderedPages[pageNumber - 1];
    const prompt = prompts.pages[pageNumber - 1];
    try {
      slideRun = await recordCodexPptSlideDispatch(slideRun, {
        pageNumber,
        agentId: cleanText(options.agentId || options.slideAgentId || ""),
        mode: cleanText(options.dispatchMode || "api-orchestrated-slide-worker")
      });
      const result = await createVisualImageForPage(job, page, prompt, {
        ...options,
        prefix: `workflow_visual_${job.id}_${page.pageId}`
      });
      const outputPath = path.join(job.dirs.visualImages, `${page.pageId}${path.extname(result.path) || ".png"}`);
      await fs.copyFile(result.path, outputPath);
      const record = await buildVisualImageRecord({ result, job, page, pageNumber, outputPath, prompt: prompt.prompt });
      slideRun = await recordCodexPptSlideResult(slideRun, { pageNumber, imageRecord: record });
      records.push(record);
      job.pages = upsertPage(job.pages, pageNumber, "recorded", "visual image ready", { visualImagePath: outputPath });
    } catch (error) {
      errors.push({ pageId: page.pageId, pageNumber, error: error.message || "visual image generation failed" });
      job.pages = upsertPage(job.pages, pageNumber, "failed", error.message || "visual image generation failed", {});
    }
  }

  const manifestPath = visualManifestPath(job);
  const previousManifest = await readVisualManifest(manifestPath);
  const manifestRecords = mergeVisualManifestRecords(previousManifest.images, records);
  await writeVisualManifest(manifestPath, manifestRecords);
  const allExisting = await discoverVisualImages(job.dirs.visualImages, manifestPath);
  const currentImages = allExisting.filter((image) => image.staleStyleReference !== true);
  const visualQuality = await writeVisualQualityReport(job, currentImages, renderedPages);
  const previousImageDeckReview = job.artifacts?.imageDeckReview || null;
  const currentArtifacts = invalidateVisualDownstreamArtifacts(job.artifacts || {});
  const retainedImageDeckReview = retainUnchangedImageDeckReviewMarks(previousImageDeckReview, currentImages);
  job.artifacts = {
    ...currentArtifacts,
    ...(retainedImageDeckReview ? { imageDeckReview: retainedImageDeckReview } : {}),
    visualPrompts: artifactRecord("visual_prompts", prompts.path),
    codexPptDeckSpec: slideRun.deckSpec,
    codexPptSpeech: slideRun.speech,
    codexPptSlideJobs: slideRun.slideJobs,
    codexPptSlideRunState: slideRun.slideRunState,
    codexPptSlidePrompts: slideRun.slidePrompts,
    visualManifest: artifactRecord("visual_images_manifest", manifestPath, { imageCount: allExisting.length, currentImageCount: currentImages.length }),
    visualQuality: artifactRecord("visual_quality_report", visualQuality.path, visualQuality.summary),
    visualImages: allExisting
  };
  const existingPageNumbers = new Set(currentImages.map((image) => Number(image.pageNumber || 0)).filter(Number.isFinite));
  const selectedComplete = selected.length > 0 && selected.every((pageNumber) => existingPageNumbers.has(Number(pageNumber)));
  const fullCoverage = renderedPages.length > 0 && renderedPages.every((page) => existingPageNumbers.has(Number(page.pageNumber || 0)));
  const complete = errors.length === 0 && selectedComplete && fullCoverage;
  job.currentStage = complete ? "image_deck_ready" : "visual_generating";
  job.status = errors.length ? "failed" : complete ? "image_deck_ready" : "visual_generating";
  job.stageStatus = errors.length ? "failed" : complete ? "complete" : "running";
  job.stages.visual_generating = markStage(job.stages.visual_generating, errors.length ? "failed" : fullCoverage ? "complete" : "running", errors.length ? "Some visual images failed" : fullCoverage ? "All visual images generated" : `Generated ${records.length} visual image(s); full deck is still incomplete`, {
    generated: records.length,
    existing: currentImages.length,
    fullCoverage,
    errors
  });
  if (complete) {
    job.stages.image_deck_ready = markStage(job.stages.image_deck_ready, "pending", "Visual images ready; full-deck review pending", { visualImages: currentImages.length });
  }
  job.events = appendEvent(job.events, errors.length ? "visual.generate_failed" : "visual.generated", errors.length ? "Some visual images failed" : `Generated ${records.length} visual image(s)`, {
    generated: records.length,
    existing: currentImages.length,
    fullCoverage,
    errors
  });
  if (errors.length) job.errors = [...(job.errors || []), ...errors.map((item) => ({ stage: "visual_generating", message: item.error, details: item, createdAt: new Date().toISOString() }))].slice(-50);
  return saveWorkflowJob(job);
}

async function retainApprovedSampleAsVisualImage(job = {}, renderedPages = []) {
  const sample = job.artifacts?.visualSample || {};
  if (!sample.path || !sample.sha256 || !fsSync.existsSync(sample.path) || !isCodexPptSampleApprovalCurrent(job)) return null;
  const pageNumber = Number(sample.pageNumber || String(sample.pageId || "").match(/\d+/)?.[0] || 0);
  const page = renderedPages[pageNumber - 1];
  if (!pageNumber || !page) return null;
  const outputPath = path.join(job.dirs.visualImages, `${page.pageId || `page_${String(pageNumber).padStart(3, "0")}`}${path.extname(sample.path) || ".png"}`);
  if (path.resolve(sample.path) !== path.resolve(outputPath)) await fs.copyFile(sample.path, outputPath);
  const stat = await fs.stat(outputPath);
  return {
    ...sample,
    kind: "visual_image",
    pageId: page.pageId || `page_${String(pageNumber).padStart(3, "0")}`,
    pageNumber,
    path: outputPath,
    sourcePagePath: page.path || page.sourcePagePath || "",
    size: stat.size,
    sha256: sample.sha256 || await hashFile(outputPath),
    approvedSampleSha256: sample.sha256,
    referenceImagePaths: [sample.path],
    retainedApprovedSample: true,
    staleStyleReference: false,
    createdAt: sample.createdAt || new Date().toISOString()
  };
}

function invalidateVisualDownstreamArtifacts(artifacts = {}) {
  const next = { ...(artifacts || {}) };
  for (const key of [
    "imageDeck",
    "imageDeckReview",
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
  ]) delete next[key];
  return next;
}

export function retainUnchangedImageDeckReviewMarks(review = null, currentImages = []) {
  const previousMarks = review?.marks && typeof review.marks === "object" ? review.marks : {};
  const imagesByPage = new Map((Array.isArray(currentImages) ? currentImages : [])
    .map((image) => [image.pageId || `page_${String(Number(image.pageNumber || 0)).padStart(3, "0")}`, image])
    .filter(([pageId, image]) => pageId && image?.path));
  const marks = Object.fromEntries(Object.entries(previousMarks).filter(([pageId, mark]) => {
    const image = imagesByPage.get(pageId);
    if (!image || !["pass", "accept"].includes(String(mark?.status || "").toLowerCase())) return false;
    return Boolean(mark.visualImageSha256 && image.sha256 && mark.visualImageSha256 === image.sha256);
  }));
  if (!Object.keys(marks).length) return null;
  const passCount = Object.values(marks).filter((mark) => mark.status === "pass").length;
  const acceptCount = Object.values(marks).filter((mark) => mark.status === "accept").length;
  return {
    ...review,
    status: "in_progress",
    marks,
    summary: {
      totalPages: imagesByPage.size,
      markedCount: Object.keys(marks).length,
      passCount,
      acceptCount,
      rerunCount: 0,
      allPagesReviewed: false,
      allMarksCurrent: true,
      readyForApproval: false
    },
    approvedAt: "",
    visualImageHashes: [],
    updatedAt: new Date().toISOString()
  };
}

export async function assembleWorkflowImageDeck(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  assertWorkflowImageDeckReviewReady(job);
  const visualImages = (await discoverVisualImages(job.dirs.visualImages, job.artifacts?.visualManifest?.path || visualManifestPath(job)))
    .filter((image) => image.staleStyleReference !== true);
  if (!visualImages.length) throw new Error("No visual images to assemble. Run visual/generate first.");
  await fs.mkdir(job.dirs.imageDeck, { recursive: true });
  const outName = sanitizeFileName(options.outName || "image-based-deck.pptx");
  const outPath = path.join(job.dirs.imageDeck, outName);
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "PPT Design Tool";
  pptx.company = "Local";
  pptx.subject = "Image-based visual intermediate deck";
  pptx.title = path.basename(outName, path.extname(outName));
  pptx.lang = "zh-CN";
  for (const image of visualImages) {
    const slide = pptx.addSlide();
    slide.background = { color: "FFFFFF" };
    slide.addImage({ path: image.path, x: 0, y: 0, w: SLIDE_W, h: SLIDE_H });
    slide.addNotes(`Image-based intermediate page ${image.pageNumber}. Final editable rebuild should use OCR and image-to-editable reconstruction.`);
  }
  await pptx.writeFile({ fileName: outPath });
  const sourcePages = Number(job.sourceMeta?.pageCount || 0) || (Array.isArray(job.artifacts?.renderedPages) ? job.artifacts.renderedPages.length : 0);
  const fullCoverage = Boolean(sourcePages > 0 && visualImages.length >= sourcePages);
  job.artifacts = {
    ...(job.artifacts || {}),
    visualImages,
    imageDeck: artifactRecord("image_deck", outPath, {
      pageCount: visualImages.length,
      sourcePageCount: sourcePages,
      fullCoverage,
      scope: fullCoverage ? "full" : "sample"
    })
  };
  job.currentStage = "image_deck_ready";
  job.status = fullCoverage ? "image_deck_ready" : "image_deck_partial";
  job.stageStatus = fullCoverage ? "complete" : "pending";
  job.stages.image_deck_ready = markStage(job.stages.image_deck_ready, fullCoverage ? "complete" : "pending", fullCoverage
    ? `Assembled complete image deck with ${visualImages.length} slide(s)`
    : `Assembled ${visualImages.length}/${sourcePages || "?"} slide image test deck`, {
    pageCount: visualImages.length,
    sourcePageCount: sourcePages,
    fullCoverage,
    path: outPath
  });
  job.events = appendEvent(job.events, fullCoverage ? "image_deck.ready" : "image_deck.partial", fullCoverage
    ? `Assembled complete image deck with ${visualImages.length} slide(s)`
    : `Assembled ${visualImages.length}/${sourcePages || "?"} slide image test deck`, { path: outPath, pageCount: visualImages.length, sourcePageCount: sourcePages, fullCoverage });
  return saveWorkflowJob(job);
}

async function createVisualImageForPage(job, page, promptRecord, options = {}) {
  const dryRun = Boolean(options.dryRun || options.passthrough);
  const providerConfig = getProviderConfig().image;
  if (dryRun || !providerConfig.configured || options.provider === "passthrough") {
    return {
      id: `visual_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      path: page.path,
      source: "source-page-passthrough",
      provider: "passthrough",
      dryRun: true,
      model: "",
      width: page.width || 0,
      height: page.height || 0,
      prompt: promptRecord.prompt
    };
  }
  if (options.useSourceImageReference !== false && isVisualSourceImage(page.path) && fsSync.existsSync(page.path)) {
    const styleLock = buildCodexPptStyleLock(job, options);
    return editImageWithProvider({
      prompt: promptRecord.prompt,
      sourceImagePath: page.path,
      referenceImagePaths: styleLock.referenceImages,
      width: VISUAL_IMAGE_W,
      height: VISUAL_IMAGE_H,
      prefix: options.prefix || `workflow_visual_${job.id}_${page.pageId}`
    });
  }
  return generateImageWithProvider({
    prompt: promptRecord.prompt,
    width: VISUAL_IMAGE_W,
    height: VISUAL_IMAGE_H,
    prefix: options.prefix || `workflow_visual_${job.id}_${page.pageId}`
  });
}

export function isVisualSourceImage(filePath = "") {
  return IMAGE_RE.test(String(filePath || ""));
}

export function assertWorkflowVisualGenerationAllowed(options = {}) {
  const providerConfig = getProviderConfig().image;
  const dryRun = Boolean(options.dryRun || options.passthrough || options.provider === "passthrough");
  const allowNonProduct = isNonProductVisualAllowed(options);
  if (dryRun && !allowNonProduct) {
    throwCodexVisualError(
      "CODEX_PPT_NON_PRODUCT_VISUAL_REQUIRES_OPT_IN",
      "dryRun/passthrough visual generation is not allowed on the default product path.",
      { provider: options.provider || "", dryRun: Boolean(options.dryRun), passthrough: Boolean(options.passthrough) }
    );
  }
  if ((!providerConfig.enabled || !providerConfig.configured) && !allowNonProduct) {
    throwCodexVisualError(
      "CODEX_PPT_IMAGE_BACKEND_REQUIRED",
      "A configured external image backend is required before generating codex-ppt visual images.",
      {
        provider: providerConfig.provider || "",
        enabled: Boolean(providerConfig.enabled),
        configured: Boolean(providerConfig.configured),
        model: providerConfig.model || "",
        baseUrl: providerConfig.baseUrl || ""
      }
    );
  }
  if (!dryRun && !allowNonProduct && providerConfig.enabled && providerConfig.configured && !isExternalImageSpendConfirmed(options)) {
    throwCodexVisualError(
      "CODEX_PPT_IMAGE_SPEND_CONFIRMATION_REQUIRED",
      "confirmExternalImageSpend=true is required before generating codex-ppt visual images with the external image API.",
      {
        provider: providerConfig.provider || "",
        enabled: Boolean(providerConfig.enabled),
        configured: Boolean(providerConfig.configured),
        model: providerConfig.model || "",
        baseUrl: providerConfig.baseUrl || "",
        requiredConfirmation: "externalImageSpend"
      }
    );
  }
}

function isNonProductVisualAllowed(options = {}) {
  return options.allowNonProductVisual === true || options.allowNonProductBackend === true;
}

function isExternalImageSpendConfirmed(options = {}) {
  return Boolean(options.confirmExternalImageSpend || options.confirmSpend || options.confirmImageApiSpend);
}

function throwCodexVisualError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  throw error;
}

export async function writeVisualPrompts(job, renderedPages, options = {}) {
  await fs.mkdir(job.dirs.visualImages, { recursive: true });
  const sampleStyleFingerprint = await ensureApprovedSampleStyleFingerprint(job, options);
  const promptPages = mergeOutlineMetadata(job, renderedPages);
  const prompts = buildVisualPromptsPayload(job, promptPages, {
    ...options,
    sampleStyleFingerprint
  });
  const promptPath = path.join(job.dirs.visualImages, "visual_prompts.json");
  await fs.writeFile(promptPath, JSON.stringify(prompts, null, 2), "utf8");
  return { ...prompts, path: promptPath };
}

export function buildVisualPromptsPayload(job = {}, renderedPages = [], options = {}) {
  const styleLock = buildCodexPptStyleLock(job, options);
  const styleBrief = cleanText(options.styleBrief || options.style || styleLock.styleBrief);
  const informationAssetMap = readInformationAssetMap(job);
  const sourceOcrByPage = readSourceOcrByPage(job);
  const ocrPromptLexicon = buildOcrPromptLexicon(sourceOcrByPage);
  const rerunGuidanceByPage = job.artifacts?.codexPptRerunGuidance || {};
  const briefSourcePrompt = buildBriefSourcePrompt(job);
  const isBriefSource = Boolean(briefSourcePrompt);
  const importedDeckSource = isImportedDeckSource(job);
  return {
    version: 2,
    jobId: job.id,
    styleBrief,
    styleLock,
    createdAt: new Date().toISOString(),
    pages: renderedPages.map((page) => {
      const pageId = page.pageId || `page_${String(Number(page.pageNumber || 0)).padStart(3, "0")}`;
      const sourceOcrEvidence = sourceOcrByPage.get(pageId);
      const role = inferDeckPageRole({
        ...page,
        ocrText: [
          ...(Array.isArray(page.ocrText) ? page.ocrText : []),
          ...(Array.isArray(sourceOcrEvidence?.ocrLines)
            ? sourceOcrEvidence.ocrLines
              .filter((line) => isTrustedOcrLine(line) && isOcrPromptTextAllowed(line.text, ocrPromptLexicon))
              .map((line) => cleanText(line?.text || ""))
              .filter(Boolean)
            : [])
        ]
      }, {
        totalPages: renderedPages.length,
        preferExplicitRole: isBriefSource
      });
      const typography = resolvePromptTypography(styleLock, role);
      const pageNumberPrompt = buildPageNumberPrompt(styleLock.designContract, page, role, renderedPages.length);
      const rerunGuidance = rerunGuidanceByPage[page.pageId] || rerunGuidanceByPage[String(page.pageNumber)] || null;
      return {
        pageId: page.pageId,
        pageNumber: page.pageNumber,
        role,
        storyRole: page.storyRole || page.outlineStoryRole || "",
        visualIntent: page.visualIntent || page.outlineVisualIntent || "",
        sourcePagePath: page.path || page.sourcePagePath || "",
        styleReferenceImages: styleLock.referenceImages,
        prompt: [
        `Create one polished 16:9 full-slide presentation visual at ${VISUAL_IMAGE_W}x${VISUAL_IMAGE_H}; no letterbox, no crop, no extra border.`,
        `Use this deck-wide style: ${styleBrief}`,
        buildStyleLockPrompt(styleLock),
        pageNumberPrompt,
        `PAGE ROLE: ${role}. STORY ROLE: ${page.storyRole || page.outlineStoryRole || "develop the narrative"}.`,
        `ROLE TYPOGRAPHY LIMITS: title ${typography.titlePt[0]}-${typography.titlePt[1]}pt, subtitle ${typography.subtitlePt[0]}-${typography.subtitlePt[1]}pt, body ${typography.bodyPt[0]}-${typography.bodyPt[1]}pt, labels ${typography.labelPt[0]}-${typography.labelPt[1]}pt. Keep comparable pages within this hierarchy.`,
        page.outlineTitle
          ? importedDeckSource
            ? `OUTLINE PLANNING LABEL (not output copy): ${page.outlineTitle}. Preserve the actual visible title in source image 1 exactly; never replace it with this planning label or with a body quote.`
            : `Slide title: ${page.outlineTitle}.`
          : importedDeckSource
            ? "SOURCE TITLE AUTHORITY: preserve the actual visible source-page title exactly; do not invent or summarize a replacement title."
            : "",
        page.outlinePurpose ? `Slide purpose: ${page.outlinePurpose}.` : "",
        page.outlineEvidence ? `Approved outline evidence: ${page.outlineEvidence}.` : "",
        page.outlineVisualIntent || page.visualIntent ? `Visual intent: ${page.outlineVisualIntent || page.visualIntent}.` : "",
        buildSourceOcrFidelityPrompt(sourceOcrByPage, page, role, ocrPromptLexicon),
        buildSourceCleanupPrompt(sourceOcrByPage, page, styleLock.designContract, role),
        buildRerunGuidancePrompt(rerunGuidance),
        briefSourcePrompt,
        isBriefSource ? "This is a from-brief slide. Do not invent a company name, logo, date, location, slogan, or unrelated business theme." : buildInformationAssetPrompt(informationAssetMap, page),
        styleLock.locked
          ? "CONTENT AUTHORITY: use the current source page only for factual content, information hierarchy, logos, products, charts, data, and approximate density. VISUAL AUTHORITY: the approved sample overrides the source page for palette, background treatment, typography mood, decorative geometry, icon/illustration rendering, component skin, spacing rhythm, and overall finish."
          : isBriefSource
            ? "Treat the user's brief as the content authority. Use its exact subject and requested title; create the visual composition from scratch."
            : "Respect the source page structure and approximate information density, but redraw with a consistent visual system.",
        styleLock.locked
          ? "INPUT ORDER: image 1 is the current source page and supplies content only; image 2 is the approved sample and supplies the deck-wide visual identity. Never treat image 1 as the style reference."
          : "",
        styleLock.locked
          ? "STYLE REFERENCE CONTENT EXCLUSION: never copy words, logos, brands, products, mascots, numbers, dates, slogans, or factual objects from image 2 unless the exact same item is visibly present in image 1. Image 2 supplies visual grammar only."
          : "",
        styleLock.locked
          ? "Do not preserve or imitate the source page's palette, background, decorative shapes, template chrome, mascot rendering style, card skin, or font styling when they conflict with the approved sample. Retheme those elements into the approved sample's visual language. Preserve brand marks and factual assets accurately, but do not let their local colors redefine the deck-wide palette."
          : isBriefSource
            ? "Keep the requested Chinese title clear and prominent. Use only supporting text justified by the brief."
            : "Preserve clearly visible logos, brand color blocks, short slide titles, cover subtitles, title positions, key visual anchors, charts, icons, and content density from the source.",
        "Keep visible headings, labels, and critical facts readable when they are legible in the source image. Dense body copy may be tightened without changing meaning, but never replace readable content with blank boxes, gray bars, fake glyphs, or abstract text texture.",
        "Do not invent new readable long text, fake Chinese text, watermarks, UI chrome, company names, brands, logos, slogans, or template labels.",
        styleLock.designContract?.master?.pageNumberPolicy === "normalize" && role !== "cover"
          ? `FORBIDDEN OUTPUT: Slide N, Page N, any page counter except the exact required counter ${formatPageCounter(page.pageNumber, renderedPages.length)}, YOUR BRAND, YOUR LOGO, COMPANY NAME, placeholder text, Lorem Ipsum, or anonymous gray bars that erase readable source content.`
          : styleLock.designContract?.master?.pageNumberPolicy === "preserve" && role !== "cover"
            ? "FORBIDDEN OUTPUT: duplicate page counters, Slide N or Page N template titles, YOUR BRAND, YOUR LOGO, COMPANY NAME, placeholder text, Lorem Ipsum, or anonymous gray bars that erase readable source content. One intentional counter already present in the source is allowed."
            : "FORBIDDEN OUTPUT: Slide N, Page N, N/total page counters, YOUR BRAND, YOUR LOGO, COMPANY NAME, placeholder text, Lorem Ipsum, or anonymous gray bars that erase readable source content.",
        "Do not add a QR code, barcode, website, phone number, email address, price, date, percentage, or model number unless it is visibly present in the current source page.",
        "Leave clean safe areas for editable title/body text while keeping the slide composition visibly complete.",
        "Output should look like a premium business PowerPoint slide visual target, not an empty background."
        ].filter(Boolean).join(" ")
      };
    })
  };
}

function buildPageNumberPrompt(contract = {}, page = {}, role = "content", totalPages = 0) {
  const pageNumber = Number(page.pageNumber || 0);
  const policy = contract?.master?.pageNumberPolicy || "none";
  if (role === "cover" || policy === "none") {
    return `INTERNAL PAGE INDEX: ${pageNumber} of ${totalPages}; use it only for narrative context and do not render a page number or counter.`;
  }
  if (policy === "normalize") {
    return `PAGE COUNTER MASTER: render exactly "${formatPageCounter(pageNumber, totalPages)}" once, using the single deck-wide counter anchor established by the approved sample or dominant verified source-page pattern. Keep that anchor identical on every non-cover page. Do not render Slide N, Page N, duplicate counters, or any other counter format.`;
  }
  return `PAGE COUNTER POLICY: preserve one intentional source counter only when clearly present, while keeping its format and anchor consistent with comparable pages. Never render Slide N or Page N as a title.`;
}

function formatPageCounter(pageNumber = 0, totalPages = 0) {
  const width = Math.max(2, String(Math.max(1, Number(totalPages || 0))).length);
  return `${String(Math.max(0, Number(pageNumber || 0))).padStart(width, "0")} / ${String(Math.max(0, Number(totalPages || 0))).padStart(width, "0")}`;
}

export function mergeOutlineMetadata(job = {}, renderedPages = []) {
  const outlinePath = cleanText(job.artifacts?.codexPptOutline?.path || "");
  let sequence = [];
  let outlinePayload = {};
  if (outlinePath && fsSync.existsSync(outlinePath)) {
    try {
      outlinePayload = JSON.parse(fsSync.readFileSync(outlinePath, "utf8"));
      sequence = Array.isArray(outlinePayload.layoutSequence) ? outlinePayload.layoutSequence : [];
    } catch {
      sequence = [];
      outlinePayload = {};
    }
  }
  const pages = Array.isArray(renderedPages) ? renderedPages : [];
  const sourceDeck = isImportedDeckSource(job) && pages.length > 1;
  const legacyMachineOutline = Boolean(
    sourceDeck
    && Number(outlinePayload.version || 0) > 0
    && Number(outlinePayload.version || 0) < 2
    && /(?:frontend|workflow|skill-first)/i.test(cleanText(outlinePayload.source || ""))
  );
  const degenerateLegacyRole = legacyMachineOutline ? findDegenerateLegacyRole(sequence) : "";
  return pages.map((page, index) => {
    const step = sequence[Number(page.pageNumber || index + 1) - 1] || sequence[index] || {};
    const pageNumber = Number(page.pageNumber || index + 1);
    const rawLayout = cleanText(page.layout || resolveLegacyOutlineLayout(step.layout, pageNumber, legacyMachineOutline, degenerateLegacyRole) || "");
    const rawVisualIntent = cleanText(page.visualIntent || step.visualIntent || "");
    const rawOutlineTitle = cleanText(page.outlineTitle || step.title || "");
    const rawOutlineEvidence = cleanText(page.outlineEvidence || step.evidence || "");
    return {
      ...page,
      layout: sanitizeSourceEdgeRole(rawLayout, pageNumber, pages.length, legacyMachineOutline),
      storyRole: cleanText(page.storyRole || step.storyRole || ""),
      visualIntent: sanitizeSourceVisualIntent(rawVisualIntent, pageNumber, pages.length, legacyMachineOutline),
      outlineTitle: sanitizeSourceOutlineTitle(rawOutlineTitle, legacyMachineOutline),
      outlinePurpose: cleanText(page.outlinePurpose || step.purpose || ""),
      outlineEvidence: sanitizeSourceOutlineEvidence(rawOutlineEvidence, legacyMachineOutline),
      outlineStoryRole: cleanText(page.outlineStoryRole || step.storyRole || ""),
      outlineVisualIntent: sanitizeSourceVisualIntent(cleanText(page.outlineVisualIntent || step.visualIntent || ""), pageNumber, pages.length, legacyMachineOutline)
    };
  });
}

function withSampleRolePreference(job = {}, options = {}) {
  const briefSource = job.artifacts?.source?.kind === "brief_source";
  return {
    ...options,
    preferExplicitRole: typeof options.preferExplicitRole === "boolean" ? options.preferExplicitRole : briefSource
  };
}

function isImportedDeckSource(job = {}) {
  const source = job.artifacts?.source || {};
  if (source.kind === "brief_source") return false;
  const ext = path.extname(cleanText(source.path || source.originalName || "")).toLowerCase();
  return [".ppt", ".pptx", ".pdf"].includes(ext);
}

function findDegenerateLegacyRole(sequence = []) {
  const middle = (Array.isArray(sequence) ? sequence : []).slice(1, -1);
  if (middle.length < 3) return "";
  const counts = new Map();
  for (const step of middle) {
    const role = cleanText(step?.layout || "").toLowerCase();
    if (role) counts.set(role, (counts.get(role) || 0) + 1);
  }
  const dominant = [...counts.entries()].sort((left, right) => right[1] - left[1])[0];
  if (!dominant || dominant[0] !== "visual" || dominant[1] / middle.length < 0.8) return "";
  const machineCoverIntentCount = middle.filter((step) => isMachineCoverVisualIntent(step?.visualIntent || "")).length;
  return machineCoverIntentCount / middle.length >= 0.8 ? "visual" : "";
}

function resolveLegacyOutlineLayout(value = "", pageNumber = 0, legacyMachineOutline = false, degenerateLegacyRole = "") {
  const role = cleanText(value).toLowerCase();
  if (!legacyMachineOutline) return role;
  if (pageNumber === 1) return "cover";
  if (role === "cover") return "";
  if (degenerateLegacyRole && role === degenerateLegacyRole) return "";
  return role;
}

function isMachineCoverVisualIntent(value = "") {
  const intent = cleanText(value);
  return /^(?:参考源页类型[：:]\s*)?(?:cover|封面)$|^按\s*(?:cover|封面)\s*页面角色重绘[；;].*$/i.test(intent);
}

function sanitizeSourceEdgeRole(value = "", pageNumber = 0, totalPages = 0, sourceDeck = false) {
  if (!sourceDeck) return value;
  const role = cleanText(value).toLowerCase();
  if (role === "cover" && pageNumber > 1) return "content";
  if (role === "closing" && pageNumber !== totalPages) return "content";
  return value;
}

function sanitizeSourceVisualIntent(value = "", pageNumber = 0, totalPages = 0, sourceDeck = false) {
  if (!sourceDeck) return value;
  const intent = cleanText(value);
  const machineCoverIntent = isMachineCoverVisualIntent(intent);
  const machineClosingIntent = /^(?:参考源页类型[：:]\s*)?(?:closing|尾页|收尾页)$|^按\s*(?:closing|尾页|收尾页)\s*页面角色重绘[；;].*$/i.test(intent);
  if (pageNumber > 1 && machineCoverIntent) return "";
  if (machineClosingIntent) return "";
  return intent;
}

function sanitizeSourceOutlineTitle(value = "", sourceDeck = false) {
  const title = cleanText(value);
  if (!sourceDeck) return title;
  return /^(?:page|slide)\s*0*\d{1,3}$/i.test(title) || /^源稿第\s*\d{1,3}\s*页$/.test(title) ? "" : title;
}

function sanitizeSourceOutlineEvidence(value = "", sourceDeck = false) {
  const evidence = cleanText(value);
  if (!sourceDeck) return evidence;
  return /^source[-_ ]page[-_ ]0*\d{1,3}$/i.test(evidence) ? "" : evidence;
}

function readSourceOcrByPage(job = {}) {
  const filePath = cleanText(job.artifacts?.ocrTextHints?.path || "");
  if (!filePath || !fsSync.existsSync(filePath)) return new Map();
  try {
    const hints = JSON.parse(fsSync.readFileSync(filePath, "utf8"));
    return new Map((Array.isArray(hints.pages) ? hints.pages : []).map((page) => [
      page.pageId || `page_${String(Number(page.pageNumber || 0)).padStart(3, "0")}`,
      page
    ]));
  } catch {
    return new Map();
  }
}

function addSourceOcrForSampleSelection(job = {}, pages = []) {
  const sourceOcrByPage = readSourceOcrByPage(job);
  const lexicon = buildOcrPromptLexicon(sourceOcrByPage);
  return pages.map((page) => {
    const pageId = page.pageId || `page_${String(Number(page.pageNumber || 0)).padStart(3, "0")}`;
    const evidence = sourceOcrByPage.get(pageId) || {};
    const ocrText = (Array.isArray(evidence.ocrLines) ? evidence.ocrLines : [])
      .filter(isTrustedOcrLine)
      .map((line) => cleanText(line.text))
      .filter((text) => text && isOcrPromptTextAllowed(text, lexicon));
    const requiredText = [...getExplicitRequiredText(evidence), ...(Array.isArray(evidence.ocrLines) ? evidence.ocrLines : [])
      .filter(isManuallyCorrectedOcrLine)
      .map((line) => cleanText(line.text))]
      .filter(Boolean);
    const sampleText = [...new Set([...requiredText, ...ocrText])];
    return {
      ...page,
      ocrText: sampleText,
      textChars: sampleText.join("").length || page.textChars || 0
    };
  });
}

function buildOcrPromptLexicon(sourceOcrByPage = new Map()) {
  const pageFrequencies = new Map();
  const requiredTokens = new Set();
  for (const [pageId, evidence] of sourceOcrByPage.entries()) {
    const pageTokens = new Set();
    for (const line of Array.isArray(evidence?.ocrLines) ? evidence.ocrLines : []) {
      if (!isTrustedOcrLine(line)) continue;
      const token = normalizeLatinBrandToken(line.text);
      if (!token) continue;
      pageTokens.add(token);
    }
    for (const token of pageTokens) {
      const pages = pageFrequencies.get(token) || new Set();
      pages.add(pageId);
      pageFrequencies.set(token, pages);
    }
    for (const line of Array.isArray(evidence?.ocrLines) ? evidence.ocrLines : []) {
      if (!isManuallyCorrectedOcrLine(line)) continue;
      const token = normalizeLatinBrandToken(line.text);
      if (token) requiredTokens.add(token);
    }
    for (const value of getExplicitRequiredText(evidence)) {
      const token = normalizeLatinBrandToken(value);
      if (token) requiredTokens.add(token);
    }
  }
  const canonicalBrands = [...pageFrequencies.entries()]
    .filter(([token, pages]) => pages.size >= 3 && isCanonicalBrandCandidate(token))
    .map(([token]) => token)
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  return { pageFrequencies, requiredTokens, canonicalBrands };
}

function isTrustedOcrLine(line = {}) {
  return Boolean(
    line?.text
    && line.low_confidence !== true
    && line.mojibake_suspect !== true
    && Number(line.confidence ?? 1) >= 0.8
  );
}

function isManuallyCorrectedOcrLine(line = {}) {
  return Boolean(line?.corrected === true && cleanText(line.text));
}

function getExplicitRequiredText(evidence = {}) {
  const ocrText = new Set((Array.isArray(evidence.ocrLines) ? evidence.ocrLines : [])
    .map((line) => cleanText(line?.text || ""))
    .filter(Boolean));
  return [...new Set((Array.isArray(evidence.requiredText) ? evidence.requiredText : [])
    .map(cleanText)
    .filter((text) => text && !ocrText.has(text)))];
}

function isOcrPromptTextAllowed(value = "", lexicon = null) {
  const text = cleanText(value);
  if (!text) return false;
  const token = normalizeLatinBrandToken(text);
  if (!token || !lexicon?.canonicalBrands?.length) return true;
  if (lexicon.requiredTokens?.has(token)) return true;
  if (Number(lexicon.pageFrequencies?.get(token)?.size || 0) >= 2) return true;
  return !lexicon.canonicalBrands.some((canonical) => {
    if (canonical === token) return false;
    if (token.startsWith(canonical) || canonical.startsWith(token)) return false;
    const maxLength = Math.max(canonical.length, token.length);
    if (Math.abs(canonical.length - token.length) > 3) return false;
    const threshold = Math.min(3, Math.max(1, Math.round(maxLength * 0.35)));
    return levenshteinDistance(token, canonical) <= threshold;
  });
}

function isCanonicalBrandCandidate(token = "") {
  if (classifyDeckText(token) !== "brand_or_code") return false;
  return !new Set([
    "ABOUT", "AGENDA", "CATEGORY", "COMPANY", "CONTENT", "FESTIVAL", "OVERVIEW",
    "PAGE", "PARAMETER", "PRICE", "PRODUCT", "PRODUCTS", "QUANTITY", "SLIDE",
    "SUMMARY", "TABLE", "TOTAL"
  ]).has(token);
}

function normalizeLatinBrandToken(value = "") {
  const token = cleanText(value).replace(/\s+/g, "").toUpperCase();
  return /^[A-Z]{5,20}$/.test(token) ? token : "";
}

function levenshteinDistance(left = "", right = "") {
  const previous = Array.from({ length: right.length + 1 }, (_item, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function buildSourceOcrFidelityPrompt(sourceOcrByPage = new Map(), page = {}, role = "content", lexicon = null) {
  const pageId = page.pageId || `page_${String(Number(page.pageNumber || 0)).padStart(3, "0")}`;
  const evidence = sourceOcrByPage.get(pageId);
  if (!evidence) return "SOURCE TEXT EVIDENCE: no current OCR evidence is available for this page; preserve visible titles, brands, numbers, and codes conservatively and do not invent replacements.";
  const lines = (Array.isArray(evidence.ocrLines) ? evidence.ocrLines : [])
    .filter((line) => isTrustedOcrLine(line) || isManuallyCorrectedOcrLine(line))
    .map((line) => cleanText(line.text))
    .filter((text) => isOcrPromptTextAllowed(text, lexicon))
    .filter((text) => !["placeholder", "page_number", "template_chrome"].includes(classifyDeckText(text)))
    .filter((text) => role === "closing" || !isSemanticClosingText(text) || isContactCallToActionText(text));
  const explicitRequired = [...getExplicitRequiredText(evidence), ...(Array.isArray(evidence.ocrLines) ? evidence.ocrLines : [])
    .filter(isManuallyCorrectedOcrLine)
    .map((line) => cleanText(line.text))]
    .filter(Boolean);
  const allRequired = [...new Set([...explicitRequired, ...lines])].filter(Boolean);
  const allCritical = allRequired.filter((text) => ["data", "brand_or_code", "contact"].includes(classifyDeckText(text)));
  const requiredLimit = role === "table" ? 28 : 16;
  const criticalLimit = role === "table" ? 20 : 12;
  const critical = allCritical.slice(0, criticalLimit);
  const required = [...new Set([...critical, ...allRequired])].slice(0, requiredLimit);
  return [
    required.length ? `SOURCE TEXT EVIDENCE: preserve these readable source strings exactly when they appear in the design: ${required.join(" | ")}.` : "",
    critical.length ? `CRITICAL TOKENS: do not alter, translate, approximate, or replace these brands/numbers/codes: ${critical.join(" | ")}.` : ""
  ].filter(Boolean).join(" ");
}

function resolvePromptTypography(styleLock = {}, role = "content") {
  const fallback = getRoleTypography(role);
  const custom = styleLock.styleSpec?.typography?.roles?.[role];
  if (!custom || typeof custom !== "object") return fallback;
  const normalizeRange = (value, fallbackRange) => {
    if (!Array.isArray(value) || value.length < 2) return fallbackRange;
    const range = value.slice(0, 2).map(Number);
    return range.every(Number.isFinite) ? range : fallbackRange;
  };
  return {
    titlePt: normalizeRange(custom.titlePt, fallback.titlePt),
    subtitlePt: normalizeRange(custom.subtitlePt, fallback.subtitlePt),
    bodyPt: normalizeRange(custom.bodyPt, fallback.bodyPt),
    labelPt: normalizeRange(custom.labelPt, fallback.labelPt)
  };
}

function buildSourceCleanupPrompt(sourceOcrByPage = new Map(), page = {}, contract = {}, role = "content") {
  const pageId = page.pageId || `page_${String(Number(page.pageNumber || 0)).padStart(3, "0")}`;
  const evidence = sourceOcrByPage.get(pageId);
  if (!evidence) return "";
  const removable = [...new Set((Array.isArray(evidence.ocrLines) ? evidence.ocrLines : [])
    .filter((line) => line?.text && line.corrected !== true && line.low_confidence !== true && Number(line.confidence ?? 1) >= 0.7)
    .map((line) => cleanText(line.text))
    .filter((text) => ["placeholder", "template_chrome"].includes(classifyDeckText(text))))].slice(0, 12);
  const sourceCounters = [...new Set((Array.isArray(evidence.ocrLines) ? evidence.ocrLines : [])
    .filter((line) => line?.text && classifyDeckText(line.text) === "page_number")
    .map((line) => cleanText(line.text)))].slice(0, 6);
  const misleadingClosingLabels = role === "closing" ? [] : [...new Set((Array.isArray(evidence.ocrLines) ? evidence.ocrLines : [])
    .filter((line) => line?.text && line.corrected !== true && line.low_confidence !== true && Number(line.confidence ?? 1) >= 0.7)
    .map((line) => cleanText(line.text))
    .filter((text) => isClosingLabelText(text) && !isContactCallToActionText(text)))].slice(0, 6);
  return [
    removable.length ? `SOURCE TEMPLATE CLEANUP: these are source-template artifacts, not factual content; remove them instead of preserving them: ${removable.join(" | ")}.` : "",
    misleadingClosingLabels.length ? `SOURCE ROLE CLEANUP: this is a ${role} page, not a closing page. Remove these misleading terminal labels instead of preserving them: ${misleadingClosingLabels.join(" | ")}.` : "",
    sourceCounters.length && contract?.master?.pageNumberPolicy === "normalize"
      ? `SOURCE COUNTER REPLACEMENT: ignore these inconsistent source counters and use only the required page-counter master: ${sourceCounters.join(" | ")}.`
      : ""
  ].filter(Boolean).join(" ");
}

function isContactCallToActionText(value = "") {
  const text = cleanText(value).replace(/[\s:：。.!！,，?？;；]+$/g, "");
  return /^(?:联系我们|联系(?:方式|电话|邮箱)|contact\s+us|get\s+in\s+touch)$/i.test(text);
}

function buildRerunGuidancePrompt(guidance = null) {
  if (!guidance || typeof guidance !== "object") return "";
  const reasons = [...new Set(Array.isArray(guidance.reasons) ? guidance.reasons.map(cleanText).filter(Boolean) : [])].slice(0, 12);
  const requiredTexts = [...new Set(Array.isArray(guidance.requiredTexts) ? guidance.requiredTexts.map(cleanText).filter(Boolean) : [])].slice(0, 20);
  const note = cleanText(guidance.note || "");
  if (!reasons.length && !requiredTexts.length && !note) return "";
  const instructions = reasons.map((reason) => ({
    "placeholder-text-detected": "remove every placeholder or generic brand label",
    "template-chrome-detected": "remove Slide N, Page N, and other template chrome",
    "unexpected-page-number": "remove every page number and counter",
    "missing-page-number": "render the exact required page counter once at the master anchor",
    "page-number-value-mismatch": "correct the page counter value and total",
    "inconsistent-page-number-format": "use only the exact deck page-counter format",
    "inconsistent-page-number-position": "move the page counter to the confirmed deck-wide master anchor",
    "closing-label-on-content-page": "remove the misleading closing label and use the factual content title",
    "synthetic-closing-on-content-page": "keep the source page role and do not turn it into a closing slide",
    "severe-language-drift": "keep the source language and do not replace Chinese content with English filler",
    "critical-data-or-contact-missing": "restore every source number, price, code, and contact token exactly",
    "critical-brand-or-code-missing": "restore every source brand, company name, logo wordmark, and model code exactly",
    "substantial-source-text-loss": "restore the readable source meaning instead of blank or gray placeholder bars",
    "missing-critical-source-text": "restore every missing critical source token exactly",
    "invented-critical-text": "remove invented brands, codes, numbers, URLs, dates, and slogans",
    "source-title-mismatch": "restore the prominent source-page title exactly and do not promote a body quote or planning label into the title",
    "semantic-evidence-missing": "rebuild local OCR evidence for this page before approval",
    "title-scale-outlier": "match the approved sample's role-specific title hierarchy",
    "deck-style-drift": "match the approved sample's typography, palette, spacing, and component language"
  }[reason] || `correct the previous QA issue: ${reason}`));
  return `RERUN CORRECTION: this page failed a previous product review. ${[...new Set(instructions)].join("; ")}.${requiredTexts.length ? ` Restore these exact missing or altered source strings: ${requiredTexts.join(" | ")}.` : ""}${note ? ` Reviewer note: ${note}.` : ""} Do not repeat the previous defects.`;
}

export function buildBriefSourcePrompt(job = {}) {
  const source = job.artifacts?.source || {};
  if (source.kind !== "brief_source" || !source.path || !fsSync.existsSync(source.path)) return "";
  try {
    const text = fsSync.readFileSync(source.path, "utf8");
    const requirements = text.match(/用户需求：\s*([\s\S]*?)(?:\n已确认大纲：|\n##|$)/)?.[1] || text;
    const normalized = cleanText(requirements).slice(0, 2400);
    return normalized ? `BRIEF CONTENT AUTHORITY: ${normalized}` : "";
  } catch {
    return "";
  }
}

export function buildCodexPptStyleLock(job = {}, options = {}) {
  const sample = job.artifacts?.visualSample || {};
  const styleArtifact = job.artifacts?.codexPptStyle || {};
  const stylePayload = readArtifactJson(styleArtifact.path);
  const samplePath = cleanText(sample.path || "");
  const sampleReady = Boolean(
    samplePath
    && fsSync.existsSync(samplePath)
    && sample.sha256
    && sample.dryRun !== true
    && sample.provider !== "passthrough"
    && isCodexPptSampleApprovalCurrent(job, options)
  );
  const continuityReferencePath = cleanText(options.continuityReferenceImagePath || "");
  const continuityReady = Boolean(
    !sampleReady
    && continuityReferencePath
    && fsSync.existsSync(continuityReferencePath)
    && options.useStyleReference !== false
  );
  const referenceReady = sampleReady || continuityReady;
  const referenceImages = options.useStyleReference === false
    ? []
    : sampleReady
      ? [samplePath]
      : continuityReady
        ? [continuityReferencePath]
        : [];
  const sampleStyleFingerprint = options.sampleStyleFingerprint
    || sample.styleFingerprint
    || options.continuityStyleFingerprint
    || null;
  const paletteFingerprint = Array.isArray(sampleStyleFingerprint?.palette) && sampleStyleFingerprint.palette.length
    ? sampleStyleFingerprint.palette.join(" / ")
    : "read the exact dominant colors directly from the approved sample image";
  const sampleFinish = [
    sampleStyleFingerprint?.brightness ? `brightness=${sampleStyleFingerprint.brightness}` : "",
    sampleStyleFingerprint?.saturation ? `saturation=${sampleStyleFingerprint.saturation}` : "",
    sampleStyleFingerprint?.density ? `density=${sampleStyleFingerprint.density}` : "",
    Array.isArray(sampleStyleFingerprint?.traits) && sampleStyleFingerprint.traits.length
      ? `traits=${sampleStyleFingerprint.traits.join("/")}`
      : ""
  ].filter(Boolean).join("; ");
  const styleBrief = cleanText(
    options.styleBrief
    || options.style
    || styleArtifact.styleBrief
    || "Unified premium business presentation system with one locked visual identity: consistent Chinese typography hierarchy, fixed restrained palette, shared grid, repeated title/content zones, stable icon/card/chart language, and role-specific layouts."
  );
  const sourceOcrHintsPath = cleanText(job.artifacts?.ocrTextHints?.path || "");
  let sourceOcrHints = {};
  if (sourceOcrHintsPath && fsSync.existsSync(sourceOcrHintsPath)) {
    try {
      sourceOcrHints = JSON.parse(fsSync.readFileSync(sourceOcrHintsPath, "utf8"));
    } catch {
      sourceOcrHints = {};
    }
  }
  const recordedPageNumberPolicy = options.pageNumberPolicy
    || styleArtifact.styleSpec?.master?.pageNumberPolicy
    || stylePayload.styleSpec?.master?.pageNumberPolicy
    || "";
  const designContract = buildDeckDesignContract({
    pageNumberPolicy: inferPageNumberPolicyFromOcrHints(sourceOcrHints, recordedPageNumberPolicy)
  });
  const recordedStyleSpec = options.styleSpec || styleArtifact.styleSpec || stylePayload.styleSpec || null;
  const styleSpec = buildDeckStyleSpec({
    styleSpec: recordedStyleSpec || (referenceReady ? { typography: { familyMode: "sample-matched" } } : null),
    styleBrief,
    audience: options.audience || styleArtifact.audience || stylePayload.audience,
    tone: options.tone || styleArtifact.tone || stylePayload.tone,
    pageNumberPolicy: designContract.master.pageNumberPolicy
  });
  return {
    version: 2,
    locked: referenceReady,
    source: sampleReady ? "approved-visual-sample" : continuityReady ? "retained-deck-continuity" : "style-text-only",
    styleBrief,
    styleSpec,
    referenceImages,
    approvedSample: sampleReady ? {
      path: samplePath,
      pageId: sample.pageId || "",
      pageNumber: sample.pageNumber || null,
      sha256: sample.sha256 || "",
      provider: sample.provider || "",
      model: sample.model || "",
      imageInputMode: sample.imageInputMode || ""
    } : null,
    continuityReference: continuityReady ? {
      path: continuityReferencePath,
      pageId: cleanText(options.continuityReferencePageId || ""),
      sha256: cleanText(options.continuityReferenceSha256 || "")
    } : null,
    sampleStyleFingerprint,
    designContract,
    tokens: {
      typography: `${sampleReady ? "The approved sample is the final typography authority. " : continuityReady ? "The retained current-deck page is the typography continuity authority for this replacement sample. " : ""}${styleSpec.typography.rule} Use only ${styleSpec.typography.weights.join(", ")} weights and keep role-specific title, subtitle, body, chart-label, and footer scales stable.`,
      palette: referenceReady
        ? `Use the attached style reference's actual palette across all pages. Local fingerprint: ${paletteFingerprint}. Do not fall back to the source page's palette or to a generic blue business template.`
        : "Use one restrained palette across all pages: neutral light backgrounds, one primary brand accent, one secondary accent, and consistent low-saturation support colors.",
      grid: `Use a stable 16:9 grid with ${styleSpec.master.outerMarginPercent.join("-")}% outer margins. ${styleSpec.master.titleAnchor}. ${styleSpec.master.header} ${styleSpec.master.footer} ${designContract.master.pageNumberRule}`,
      components: `Cards: ${styleSpec.components.cards}. Icons: ${styleSpec.components.icons}. Charts: ${styleSpec.components.charts}. Imagery: ${styleSpec.components.imagery}.`,
      density: "Keep comparable visual density for comparable slide roles; do not switch between unrelated poster, dashboard, magazine, and template styles unless the role explicitly requires a controlled variation."
    },
    requirements: [
      sampleReady
        ? "The approved sample is the sole deck-level visual authority. When source styling conflicts with it, the approved sample wins."
        : continuityReady
          ? "The retained current-deck page is attached only to preserve visual continuity while replacing the sample. Match its typography, palette, spacing, component finish, and master anchors; never copy its words, brands, products, logos, numbers, or layout content."
        : "Establish one coherent deck-level visual identity before full production.",
      referenceReady && sampleFinish ? `Style reference fingerprint: ${sampleFinish}.` : "",
      referenceReady
        ? "Match the attached style reference's typography mood, color discipline, spacing rhythm, and component finish."
        : "Apply the confirmed style brief consistently to typography, palette, spacing rhythm, and component finish.",
      formatDeckStyleSpecPrompt(styleSpec),
      "Vary composition by slide role, but do not change the deck's font family mood, title hierarchy, palette, icon language, or card/chart treatment.",
      "FONT FAMILY LOCK: use one deck-wide Chinese/Latin type system. Never alternate serif, sans-serif, calligraphic, handwritten, or decorative display faces between pages; match the approved sample, or use a modern sans-serif system when no font style was explicitly approved.",
      "MASTER ELEMENT LOCK: keep recurring header, footer, logo, section label, and page-counter anchors identical on comparable page roles. Do not improvise a new header strip, footer treatment, or page-number position on each page.",
      designContract.contentSafety.placeholderPolicy,
      designContract.contentSafety.inventionPolicy,
      designContract.contentSafety.longTextPolicy,
      designContract.structure.existingDeckClosingPolicy,
      "If the source page has mixed or messy styling, normalize it into the locked deck style instead of copying the inconsistency.",
      referenceReady
        ? "Use the source page as content evidence only. Re-render non-factual visual styling in the attached style reference's language."
        : ""
    ].filter(Boolean)
  };
}

function buildStyleLockPrompt(styleLock = {}) {
  const referenceInstruction = styleLock.source === "approved-visual-sample"
    ? "An approved sample slide is attached as the deck-level visual authority. Match its palette, typography mood, decorative geometry, illustration/icon language, spacing rhythm, and component finish. Do not copy its exact layout unless this page has the same role; vary composition without changing visual identity."
    : styleLock.source === "retained-deck-continuity"
      ? "A retained, locally validated page from this same deck is attached as a visual continuity reference for the replacement sample. Match its palette, typography mood, spacing rhythm, master anchors, icon language, and component finish. Do not copy any of its factual content or exact layout."
      : "No approved sample image is available yet; follow the style contract strictly and keep every page consistent.";
  const parts = [
    "STYLE LOCK: all slides must share one visual identity.",
    `Typography: ${styleLock.tokens?.typography || ""}`,
    `Palette: ${styleLock.tokens?.palette || ""}`,
    `Grid: ${styleLock.tokens?.grid || ""}`,
    `Components: ${styleLock.tokens?.components || ""}`,
    `Density: ${styleLock.tokens?.density || ""}`,
    referenceInstruction,
    ...(Array.isArray(styleLock.requirements) ? styleLock.requirements : [])
  ];
  return parts.filter(Boolean).join(" ");
}

async function ensureApprovedSampleStyleFingerprint(job = {}, options = {}) {
  if (options.sampleStyleFingerprint) return options.sampleStyleFingerprint;
  const sample = job.artifacts?.visualSample || null;
  if (sample?.styleFingerprint) return sample.styleFingerprint;
  const samplePath = cleanText(sample?.path || "");
  if (!samplePath || !fsSync.existsSync(samplePath)) return null;
  const fingerprint = await analyzeApprovedSampleStyle(samplePath);
  if (sample && fingerprint) sample.styleFingerprint = fingerprint;
  return fingerprint;
}

export async function resolveRetainedVisualContinuityReference(job = {}, targetPageId = "") {
  const target = cleanText(targetPageId);
  const images = (Array.isArray(job.artifacts?.visualImages) ? job.artifacts.visualImages : [])
    .filter((image) => image?.path && fsSync.existsSync(image.path) && image.staleStyleReference !== true)
    .filter((image) => cleanText(image.pageId || "") !== target);
  if (!images.length) return null;
  const semanticReport = readArtifactJson(job.artifacts?.visualTextQuality?.path || "");
  const semanticPassPageIds = new Set((Array.isArray(semanticReport.pages) ? semanticReport.pages : [])
    .filter((page) => page?.status === "pass" && !page?.blockingReasons?.length)
    .map((page) => cleanText(page.pageId || ""))
    .filter(Boolean));
  const reviewMarks = job.artifacts?.imageDeckReview?.marks || {};
  const reviewedPageIds = new Set(Object.entries(reviewMarks)
    .filter(([, mark]) => ["pass", "accept"].includes(cleanText(mark?.status || "").toLowerCase()))
    .map(([pageId]) => cleanText(pageId))
    .filter(Boolean));
  const qualified = images
    .map((image) => ({
      image,
      score: semanticPassPageIds.has(cleanText(image.pageId || "")) ? 2 : reviewedPageIds.has(cleanText(image.pageId || "")) ? 1 : 0
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || Number(right.image.pageNumber || 0) - Number(left.image.pageNumber || 0));
  return qualified[0]?.image || null;
}

async function analyzeApprovedSampleStyle(samplePath = "") {
  if (!samplePath || !fsSync.existsSync(samplePath)) return null;
  const stat = await fs.stat(samplePath).catch(() => null);
  return analyzeStyleReference({
    path: samplePath,
    originalName: path.basename(samplePath),
    size: stat?.size || 0
  }, {
    name: "approved visual sample",
    tone: "deck-level visual authority"
  }).catch(() => null);
}

function readInformationAssetMap(job = {}) {
  const filePath = cleanText(job.artifacts?.codexPptInformationAssets?.path || job.artifacts?.informationAssetMap?.path || "");
  if (!filePath || !fsSync.existsSync(filePath)) return null;
  try {
    return JSON.parse(fsSync.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readArtifactJson(filePath = "") {
  const cleanPath = cleanText(filePath);
  if (!cleanPath || !fsSync.existsSync(cleanPath)) return {};
  try {
    return JSON.parse(fsSync.readFileSync(cleanPath, "utf8"));
  } catch {
    return {};
  }
}

function buildInformationAssetPrompt(assetMap = null, page = {}) {
  const pages = Array.isArray(assetMap?.pages) ? assetMap.pages : [];
  const record = pages.find((item) => {
    const itemNumber = Number(item.pageNumber || 0);
    return item.pageId === page.pageId || (itemNumber && itemNumber === Number(page.pageNumber || 0));
  });
  if (!record) return "";
  const preserveTypes = (Array.isArray(record.mustPreserve) ? record.mustPreserve : [])
    .map((item) => cleanText(item.type || item.label || ""))
    .filter(Boolean)
    .slice(0, 8);
  const reusableAssets = (Array.isArray(record.reusableAssets) ? record.reusableAssets : [])
    .filter((item) => item?.role === "reuse-or-compare" || item?.role === "text-rerender-reference")
    .map((item) => `${cleanText(item.type)}=${cleanText(item.relativePath || item.path || item.assetId)}`)
    .filter(Boolean)
    .slice(0, 8);
  const guardrails = (Array.isArray(record.promptGuardrails) ? record.promptGuardrails : [])
    .map(cleanText)
    .filter(Boolean)
    .slice(0, 6);
  const risks = (Array.isArray(record.risks) ? record.risks : [])
    .map(cleanText)
    .filter(Boolean)
    .slice(0, 6);
  return [
    "SOURCE INFORMATION ASSET MAP:",
    preserveTypes.length ? `Must preserve asset types: ${preserveTypes.join(", ")}.` : "",
    reusableAssets.length ? `Reusable source assets are recorded for later composition or comparison: ${reusableAssets.join("; ")}.` : "",
    reusableAssets.length ? "Design around preserved assets; do not invent replacement products, logos, screenshots, charts, or QR/data visuals." : "",
    "Model work should focus on design layer: background, layout atmosphere, card containers, decorative elements, spacing, and unified style.",
    "Information assets ground the visual prompt. OCR remains separate evidence for content checks and later editable reconstruction. Keep the generated visual intact; the image-stage pipeline must not paste OCR boxes or source-page crops over it.",
    risks.length ? `Fidelity risks: ${risks.join(", ")}.` : "",
    guardrails.length ? `Guardrails: ${guardrails.join(" ")}` : ""
  ].filter(Boolean).join(" ");
}

export function getRenderedPages(job) {
  const pages = Array.isArray(job.artifacts?.renderedPages) ? job.artifacts.renderedPages : [];
  return pages.filter((page) => page?.path && fsSync.existsSync(page.path)).sort((a, b) => a.pageNumber - b.pageNumber);
}

export async function buildVisualImageRecord({ result = {}, job = null, page = {}, pageNumber = 1, outputPath = "", prompt = "", extra = {} }) {
  const dimensions = getImageDimensions(outputPath);
  const stat = await fs.stat(outputPath);
  return {
    ...result,
    kind: "visual_image",
    pageId: page.pageId || `page_${String(pageNumber).padStart(3, "0")}`,
    pageNumber,
    path: outputPath,
    relativePath: path.relative(process.cwd(), outputPath),
    sourcePagePath: page.path || result.sourcePagePath || "",
    prompt,
    size: stat.size,
    sha256: await hashFile(outputPath),
    width: dimensions?.width || result.width || page.width || null,
    height: dimensions?.height || result.height || page.height || null,
    createdAt: new Date().toISOString(),
    approvedSampleSha256: result.approvedSampleSha256 || (Array.isArray(result.referenceImagePaths) && result.referenceImagePaths.length ? job?.artifacts?.visualSample?.sha256 || "" : ""),
    ...extra
  };
}

export async function discoverVisualImages(dir, manifestPath = "") {
  const manifest = await readVisualManifest(manifestPath);
  const byPageId = new Map(manifest.images.map((record) => [record.pageId, record]));
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const images = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^page_\d{3}\.(png|jpe?g|webp|svg)$/i.test(entry.name)) continue;
    const filePath = path.join(dir, entry.name);
    const pageNumber = Number(entry.name.match(/\d{3}/)?.[0] || images.length + 1);
    const pageId = `page_${String(pageNumber).padStart(3, "0")}`;
    const stored = byPageId.get(pageId) || {};
    const dimensions = getImageDimensions(filePath);
    const stat = await fs.stat(filePath);
    images.push({
      ...stored,
      kind: "visual_image",
      pageId,
      pageNumber,
      path: filePath,
      relativePath: path.relative(process.cwd(), filePath),
      size: stat.size,
      sha256: await hashFile(filePath),
      width: dimensions?.width || stored.width || null,
      height: dimensions?.height || stored.height || null,
      createdAt: stat.mtime.toISOString()
    });
  }
  return images.sort((a, b) => a.pageNumber - b.pageNumber);
}

export function visualManifestPath(job) {
  return path.join(job.dirs.visualImages, VISUAL_IMAGES_MANIFEST);
}

export async function readVisualManifest(filePath = "") {
  if (!filePath || !fsSync.existsSync(filePath)) return { version: 1, images: [] };
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    return {
      version: parsed.version || 1,
      images: Array.isArray(parsed.images) ? parsed.images : []
    };
  } catch {
    return { version: 1, images: [] };
  }
}

export async function writeVisualManifest(filePath, images = [], extra = {}) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const normalized = [...images]
    .filter((record) => record?.pageId || record?.path)
    .sort((a, b) => Number(a.pageNumber || 0) - Number(b.pageNumber || 0));
  await fs.writeFile(filePath, JSON.stringify({
    version: 1,
    kind: "visual_images_manifest",
    updatedAt: new Date().toISOString(),
    imageCount: normalized.length,
    ...extra,
    images: normalized
  }, null, 2), "utf8");
}

export async function writeVisualQualityReport(job, visualImages = [], renderedPages = []) {
  const reportPath = path.join(job.dirs.visualImages, VISUAL_QUALITY_REPORT);
  const currentVisualImages = (Array.isArray(visualImages) ? visualImages : []).filter((image) => image.staleStyleReference !== true);
  const enrichedRenderedPages = mergeOutlineMetadata(job, renderedPages);
  const renderedByPage = new Map(enrichedRenderedPages.map((page) => [page.pageId, page]));
  const approvedSamplePath = cleanText(job.artifacts?.visualSample?.path || "");
  const approvedSampleQa = approvedSamplePath && fsSync.existsSync(approvedSamplePath)
    ? await analyzeImageSafely(approvedSamplePath)
    : null;
  const sourceOcrCoverage = getWorkflowOcrCoverage(job, {
    pages: currentVisualImages.map((image) => image.pageId || image.pageNumber)
  });
  const missingSourceOcr = new Set(sourceOcrCoverage.missingPageIds);
  const pages = [];
  for (const image of currentVisualImages) {
    const sourcePage = renderedByPage.get(image.pageId) || null;
    const visualQa = await analyzeImageSafely(image.path);
    const sourceQa = sourcePage?.path ? await analyzeImageSafely(sourcePage.path) : null;
    const manualReasons = [
      ...(sourceQa?.full?.textLikeScore > 0.004 || sourceQa?.full?.darkComponentDensity > 0.012 ? ["source-has-readable-text-or-title"] : []),
      ...detectSourceTextLoss(sourceQa, visualQa),
      ...(visualQa.risks || []),
      ...(missingSourceOcr.has(image.pageId) ? ["missing-source-ocr-evidence"] : []),
      ...(!image.sourcePagePath && !image.sourceImagePath ? ["missing-source-reference"] : [])
    ];
    const status = visualQa.status === "pass" && !manualReasons.length ? "pass" : "review";
    pages.push({
      pageId: image.pageId,
      pageNumber: image.pageNumber,
      role: inferDeckPageRole(sourcePage || image, { totalPages: enrichedRenderedPages.length || currentVisualImages.length }),
      status,
      manualReviewRequired: status !== "pass",
      manualReviewReasons: [...new Set(manualReasons)],
      visualPath: image.path,
      sourcePagePath: image.sourcePagePath || image.sourceImagePath || sourcePage?.path || "",
      sha256: image.sha256 || "",
      visualQa,
      sourceQa
    });
  }
  const styleConsistency = buildDeckStyleConsistencyReport(pages, approvedSampleQa);
  styleConsistency.approvedSampleSha256 = cleanText(job.artifacts?.visualSample?.sha256 || "");
  const driftByPage = new Map((styleConsistency.driftPages || []).map((page) => [page.pageId, page]));
  for (const page of pages) {
    const drift = driftByPage.get(page.pageId);
    if (!drift) continue;
    page.status = page.status === "failed" ? "failed" : "review";
    page.manualReviewRequired = true;
    page.manualReviewReasons = [...new Set([...(page.manualReviewReasons || []), "deck-style-drift", ...drift.reasons])];
    page.styleConsistency = {
      status: "review",
      reasons: drift.reasons,
      metrics: drift.metrics,
      deltas: drift.deltas
    };
  }
  const reviewPages = pages.filter((page) => page.manualReviewRequired);
  const failedPages = pages.filter((page) => page.visualQa?.status === "failed");
  const report = {
    version: 1,
    kind: "visual_quality_report",
    updatedAt: new Date().toISOString(),
    status: failedPages.length ? "fail" : reviewPages.length ? "review" : "pass",
    summary: {
      pageCount: pages.length,
      passCount: pages.filter((page) => page.status === "pass").length,
      reviewCount: reviewPages.length,
      failedCount: failedPages.length,
      manualReviewRequired: reviewPages.length > 0,
      primaryReason: reviewPages[0]?.manualReviewReasons?.[0] || "",
      styleConsistency,
      sourceOcrCoverage
    },
    pages
  };
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { path: reportPath, report, summary: report.summary };
}

function detectSourceTextLoss(sourceQa = null, visualQa = null) {
  if (!sourceQa || !visualQa || sourceQa.status === "failed" || visualQa.status === "failed") return [];
  const sourceTextSafe = Number(sourceQa.textSafe?.textLikeScore || 0);
  const visualTextSafe = Number(visualQa.textSafe?.textLikeScore || 0);
  const sourceTitle = Number(sourceQa.titleArea?.textLikeScore || 0);
  const visualTitle = Number(visualQa.titleArea?.textLikeScore || 0);
  const sourceTitleEdges = Number(sourceQa.titleArea?.edgeDensity || 0);
  const visualTitleEdges = Number(visualQa.titleArea?.edgeDensity || 0);
  const sourceHasTitleLikeText = sourceTextSafe >= 0.006 || sourceTitle >= 0.006 || sourceTitleEdges >= 0.045;
  const visualLostTextSafe = sourceTextSafe >= 0.006 && visualTextSafe < sourceTextSafe * 0.45;
  const visualLostTitle = sourceTitle >= 0.006 && visualTitle < sourceTitle * 0.45;
  const visualLostTitleEdges = sourceTitleEdges >= 0.045 && visualTitleEdges < sourceTitleEdges * 0.58;
  return sourceHasTitleLikeText && (visualLostTextSafe || visualLostTitle || visualLostTitleEdges)
    ? ["possible-title-or-text-loss"]
    : [];
}

async function analyzeImageSafely(filePath = "") {
  try {
    return await analyzeGeneratedImage(filePath);
  } catch (error) {
    return {
      version: 1,
      source: "local-pixel-qa",
      status: "failed",
      risks: ["qa-failed"],
      error: error.message || "visual QA failed"
    };
  }
}

export function mergeVisualManifestRecords(previous = [], updates = []) {
  const merged = new Map();
  for (const record of previous) {
    if (record?.pageId) merged.set(record.pageId, record);
  }
  for (const record of updates) {
    if (record?.pageId) merged.set(record.pageId, record);
  }
  return [...merged.values()];
}

async function ensureVisualDirs(job) {
  await fs.mkdir(job.dirs.visualImages, { recursive: true });
  await fs.mkdir(job.dirs.imageDeck, { recursive: true });
}

export function parsePageSelection(value, max) {
  if (!value) return Array.from({ length: max }, (_item, index) => index + 1);
  const raw = Array.isArray(value) ? value.join(",") : String(value);
  const pages = new Set();
  for (const part of raw.split(/[,\s，、]+/).filter(Boolean)) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Math.max(1, Number(range[1]));
      const end = Math.min(max, Number(range[2]));
      for (let page = start; page <= end; page += 1) pages.add(page);
    } else {
      const page = Number(part);
      if (Number.isInteger(page) && page >= 1 && page <= max) pages.add(page);
    }
  }
  return [...pages].sort((a, b) => a - b);
}

export function upsertPage(pages = [], pageNumber, status, message, details = {}) {
  const next = Array.isArray(pages) ? [...pages] : [];
  const pageId = `page_${String(pageNumber).padStart(3, "0")}`;
  const index = next.findIndex((page) => page.pageNumber === pageNumber);
  const record = {
    ...(index >= 0 ? next[index] : {}),
    pageId,
    pageNumber,
    status,
    message,
    details: { ...(index >= 0 ? next[index].details || {} : {}), ...details },
    updatedAt: new Date().toISOString()
  };
  if (index >= 0) next[index] = record;
  else next.push(record);
  return next.sort((a, b) => a.pageNumber - b.pageNumber);
}

export function markStage(stage = {}, status, message, details = {}) {
  const now = new Date().toISOString();
  const next = {
    ...stage,
    status,
    message,
    details,
    updatedAt: now,
    startedAt: stage.startedAt || now,
    ...(status === "complete" || status === "failed" ? { finishedAt: now } : {})
  };
  if (status !== "complete" && status !== "failed") delete next.finishedAt;
  return next;
}

export function appendEvent(events = [], type, message, details = {}) {
  return [...(Array.isArray(events) ? events : []), {
    id: `evt_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    type,
    message,
    details,
    createdAt: new Date().toISOString()
  }].slice(-500);
}

export function artifactRecord(kind, filePath, extra = {}) {
  const stat = fsSync.existsSync(filePath) ? fsSync.statSync(filePath) : null;
  return {
    kind,
    path: filePath,
    relativePath: path.relative(process.cwd(), filePath),
    size: stat?.size || 0,
    createdAt: new Date().toISOString(),
    ...extra
  };
}

function getImageDimensions(filePath) {
  if (!IMAGE_RE.test(filePath)) return null;
  try {
    return imageSize(filePath);
  } catch {
    return null;
  }
}

async function hashFile(filePath) {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function clampPageNumber(value, max) {
  const page = Number(value);
  if (!Number.isInteger(page)) return 1;
  return Math.max(1, Math.min(max, page));
}

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function sanitizeFileName(value = "") {
  const name = String(value || "image-based-deck.pptx").replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_").slice(0, 120);
  return name.toLowerCase().endsWith(".pptx") ? name : `${name || "image-based-deck"}.pptx`;
}
