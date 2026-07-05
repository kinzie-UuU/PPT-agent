import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import pptxgen from "pptxgenjs";
import { imageSize } from "image-size";
import { analyzeGeneratedImage } from "./imageQa.js";
import { editImageWithProvider, generateImageWithProvider, getProviderConfig } from "./providers.js";
import { readWorkflowJob, saveWorkflowJob } from "./workflowJobs.js";
import { prepareCodexPptSlideRun, recordCodexPptSlideDispatch, recordCodexPptSlideResult } from "./workflowCodexPptRunState.js";

const SLIDE_W = 13.333;
const SLIDE_H = 7.5;
const VISUAL_IMAGE_W = 1536;
const VISUAL_IMAGE_H = 864;
const IMAGE_RE = /\.(png|jpe?g|webp|svg)$/i;
const VISUAL_IMAGES_MANIFEST = "visual_images_manifest.json";
const VISUAL_SAMPLE_MANIFEST = "visual_sample_manifest.json";
const VISUAL_QUALITY_REPORT = "visual_quality_report.json";

export async function generateWorkflowVisualSample(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  assertWorkflowVisualGenerationAllowed(options);
  const renderedPages = getRenderedPages(job);
  if (!renderedPages.length) throw new Error("No rendered source pages. Run source/render first.");
  const pageNumber = clampPageNumber(options.pageNumber || options.page || 1, renderedPages.length);
  const page = renderedPages[pageNumber - 1];
  const startedAt = new Date().toISOString();
  await ensureVisualDirs(job);
  const prompts = await writeVisualPrompts(job, renderedPages, options);
  const result = await createVisualImageForPage(job, page, prompts.pages[pageNumber - 1], {
    ...options,
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
  const sampleRecord = await buildVisualImageRecord({
    result: sampleRecordDraft,
    page,
    pageNumber,
    outputPath: samplePath,
    prompt: prompts.pages[pageNumber - 1].prompt,
    extra: {
      sample: true,
      samplePath,
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

export async function generateWorkflowVisualImages(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  assertWorkflowVisualGenerationAllowed(options);
  const renderedPages = getRenderedPages(job);
  if (!renderedPages.length) throw new Error("No rendered source pages. Run source/render first.");
  await ensureVisualDirs(job);
  const prompts = await writeVisualPrompts(job, renderedPages, options);
  const maxPages = Number.isFinite(Number(options.maxPages)) ? Math.max(1, Number(options.maxPages)) : renderedPages.length;
  const selected = parsePageSelection(options.pages || options.pageNumbers, renderedPages.length).slice(0, maxPages);
  let slideRun = await prepareCodexPptSlideRun(job, { renderedPages, prompts, selectedPages: selected, options });
  const records = [];
  const errors = [];
  job.currentStage = "visual_generating";
  job.status = "visual_generating";
  job.stageStatus = "running";
  job.stages.visual_generating = markStage(job.stages.visual_generating, "running", "Generating visual slide images", { selectedPages: selected });

  for (const pageNumber of selected) {
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
      const record = await buildVisualImageRecord({ result, page, pageNumber, outputPath, prompt: prompt.prompt });
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
  const visualQuality = await writeVisualQualityReport(job, allExisting, renderedPages);
  job.artifacts = {
    ...(job.artifacts || {}),
    visualPrompts: artifactRecord("visual_prompts", prompts.path),
    codexPptDeckSpec: slideRun.deckSpec,
    codexPptSpeech: slideRun.speech,
    codexPptSlideJobs: slideRun.slideJobs,
    codexPptSlideRunState: slideRun.slideRunState,
    codexPptSlidePrompts: slideRun.slidePrompts,
    visualManifest: artifactRecord("visual_images_manifest", manifestPath, { imageCount: allExisting.length }),
    visualQuality: artifactRecord("visual_quality_report", visualQuality.path, visualQuality.summary),
    visualImages: allExisting
  };
  const existingPageNumbers = new Set(allExisting.map((image) => Number(image.pageNumber || 0)).filter(Number.isFinite));
  const selectedComplete = selected.length > 0 && selected.every((pageNumber) => existingPageNumbers.has(Number(pageNumber)));
  const complete = errors.length === 0 && selectedComplete;
  job.currentStage = complete ? "image_deck_ready" : "visual_generating";
  job.status = errors.length ? "failed" : complete ? "image_deck_ready" : "visual_generating";
  job.stageStatus = errors.length ? "failed" : complete ? "complete" : "running";
  job.stages.visual_generating = markStage(job.stages.visual_generating, errors.length ? "failed" : "complete", errors.length ? "Some visual images failed" : `Generated ${records.length} visual image(s)`, {
    generated: records.length,
    existing: allExisting.length,
    errors
  });
  if (complete) {
    job.stages.image_deck_ready = markStage(job.stages.image_deck_ready, "pending", "Visual images ready; image deck assembly pending", { visualImages: allExisting.length });
  }
  job.events = appendEvent(job.events, errors.length ? "visual.generate_failed" : "visual.generated", errors.length ? "Some visual images failed" : `Generated ${records.length} visual image(s)`, {
    generated: records.length,
    existing: allExisting.length,
    errors
  });
  if (errors.length) job.errors = [...(job.errors || []), ...errors.map((item) => ({ stage: "visual_generating", message: item.error, details: item, createdAt: new Date().toISOString() }))].slice(-50);
  return saveWorkflowJob(job);
}

export async function assembleWorkflowImageDeck(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const visualImages = await discoverVisualImages(job.dirs.visualImages, job.artifacts?.visualManifest?.path || visualManifestPath(job));
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
  job.artifacts = {
    ...(job.artifacts || {}),
    visualImages,
    imageDeck: artifactRecord("image_deck", outPath, { pageCount: visualImages.length })
  };
  job.currentStage = "image_deck_ready";
  job.status = "image_deck_ready";
  job.stageStatus = "complete";
  job.stages.image_deck_ready = markStage(job.stages.image_deck_ready, "complete", `Assembled image deck with ${visualImages.length} slide(s)`, {
    pageCount: visualImages.length,
    path: outPath
  });
  job.events = appendEvent(job.events, "image_deck.ready", `Assembled image deck with ${visualImages.length} slide(s)`, { path: outPath, pageCount: visualImages.length });
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
  if (options.useSourceImageReference !== false && page.path && fsSync.existsSync(page.path)) {
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
  const marker = `${options.approvedBy || ""} ${options.requestedBy || ""} ${options.note || ""} ${options.visualProfile || ""} ${options.mode || ""}`;
  return Boolean(options.allowNonProductVisual || options.allowNonProductBackend) || /regression|smoke|test/i.test(marker);
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
  const prompts = buildVisualPromptsPayload(job, renderedPages, options);
  const promptPath = path.join(job.dirs.visualImages, "visual_prompts.json");
  await fs.writeFile(promptPath, JSON.stringify(prompts, null, 2), "utf8");
  return { ...prompts, path: promptPath };
}

export function buildVisualPromptsPayload(job = {}, renderedPages = [], options = {}) {
  const styleLock = buildCodexPptStyleLock(job, options);
  const styleBrief = cleanText(options.styleBrief || options.style || styleLock.styleBrief);
  return {
    version: 1,
    jobId: job.id,
    styleBrief,
    styleLock,
    createdAt: new Date().toISOString(),
    pages: renderedPages.map((page) => ({
      pageId: page.pageId,
      pageNumber: page.pageNumber,
      sourcePagePath: page.path || page.sourcePagePath || "",
      styleReferenceImages: styleLock.referenceImages,
      prompt: [
        `Create one polished 16:9 full-slide presentation visual at ${VISUAL_IMAGE_W}x${VISUAL_IMAGE_H}; no letterbox, no crop, no extra border.`,
        `Use this deck-wide style: ${styleBrief}`,
        buildStyleLockPrompt(styleLock),
        `This is page ${page.pageNumber} of ${renderedPages.length}.`,
        page.outlineTitle ? `Slide title: ${page.outlineTitle}.` : "",
        page.outlinePurpose ? `Slide purpose: ${page.outlinePurpose}.` : "",
        page.outlineEvidence ? `Approved outline evidence: ${page.outlineEvidence}.` : "",
        "Respect the source page structure and approximate information density, but redraw with a consistent visual system.",
        "Preserve clearly visible logos, brand color blocks, short slide titles, cover subtitles, title positions, key visual anchors, charts, icons, and content density from the source.",
        "Keep short visible headings readable when they are legible in the source image; only long paragraphs or dense body copy should become clean text-safe placeholder regions or subtle blurred/abstract text texture.",
        "Do not invent new readable long text, fake Chinese text, watermarks, or UI chrome.",
        "Leave clean safe areas for editable title/body text while keeping the slide composition visibly complete.",
        "Output should look like a premium business PowerPoint slide visual target, not an empty background."
      ].filter(Boolean).join(" ")
    }))
  };
}

export function buildCodexPptStyleLock(job = {}, options = {}) {
  const sample = job.artifacts?.visualSample || {};
  const styleArtifact = job.artifacts?.codexPptStyle || {};
  const samplePath = cleanText(sample.path || "");
  const sampleReady = Boolean(
    samplePath
    && fsSync.existsSync(samplePath)
    && sample.sha256
    && sample.dryRun !== true
    && sample.provider !== "passthrough"
  );
  const referenceImages = sampleReady && options.useStyleReference !== false ? [samplePath] : [];
  const styleBrief = cleanText(
    options.styleBrief
    || options.style
    || styleArtifact.styleBrief
    || "Unified premium business presentation system with one locked visual identity: consistent Chinese typography hierarchy, fixed restrained palette, shared grid, repeated title/content zones, stable icon/card/chart language, and role-specific layouts."
  );
  return {
    version: 1,
    locked: sampleReady,
    source: sampleReady ? "approved-visual-sample" : "style-text-only",
    styleBrief,
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
    tokens: {
      typography: "Use one clean Chinese business font mood across the deck; keep title, subtitle, section label, body label, chart label, and footer sizes visually consistent from slide to slide.",
      palette: "Use one restrained palette across all pages: neutral light backgrounds, one primary brand accent, one secondary accent, and consistent low-saturation support colors.",
      grid: "Use a stable 16:9 grid, aligned title zone, consistent outer margins, repeated footer/logo handling, and predictable card/chart spacing.",
      components: "Reuse the same card radius, line weights, icon style, callout treatment, chart/table framing, and image mask language.",
      density: "Keep comparable visual density for comparable slide roles; do not switch between unrelated poster, dashboard, magazine, and template styles unless the role explicitly requires a controlled variation."
    },
    requirements: [
      "Match the approved sample's typography mood, color discipline, spacing rhythm, and component finish.",
      "Vary composition by slide role, but do not change the deck's font family mood, title hierarchy, palette, icon language, or card/chart treatment.",
      "Prefer consistent readable Chinese headings over decorative or mixed random fonts.",
      "If the source page has mixed or messy styling, normalize it into the locked deck style instead of copying the inconsistency."
    ]
  };
}

function buildStyleLockPrompt(styleLock = {}) {
  const parts = [
    "STYLE LOCK: all slides must share one visual identity.",
    `Typography: ${styleLock.tokens?.typography || ""}`,
    `Palette: ${styleLock.tokens?.palette || ""}`,
    `Grid: ${styleLock.tokens?.grid || ""}`,
    `Components: ${styleLock.tokens?.components || ""}`,
    `Density: ${styleLock.tokens?.density || ""}`,
    ...(styleLock.locked ? ["An approved sample slide is attached as a style-only reference; match its typography mood, palette discipline, spacing rhythm, and component finish. Do not copy its exact layout unless this page has the same role."] : ["No approved sample image is available yet; follow the style contract strictly and keep every page consistent."]),
    ...(Array.isArray(styleLock.requirements) ? styleLock.requirements : [])
  ];
  return parts.filter(Boolean).join(" ");
}

export function getRenderedPages(job) {
  const pages = Array.isArray(job.artifacts?.renderedPages) ? job.artifacts.renderedPages : [];
  return pages.filter((page) => page?.path && fsSync.existsSync(page.path)).sort((a, b) => a.pageNumber - b.pageNumber);
}

export async function buildVisualImageRecord({ result = {}, page = {}, pageNumber = 1, outputPath = "", prompt = "", extra = {} }) {
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
  const renderedByPage = new Map((Array.isArray(renderedPages) ? renderedPages : []).map((page) => [page.pageId, page]));
  const pages = [];
  for (const image of Array.isArray(visualImages) ? visualImages : []) {
    const sourcePage = renderedByPage.get(image.pageId) || null;
    const visualQa = await analyzeImageSafely(image.path);
    const sourceQa = sourcePage?.path ? await analyzeImageSafely(sourcePage.path) : null;
    const manualReasons = [
      ...(sourceQa?.full?.textLikeScore > 0.004 || sourceQa?.full?.darkComponentDensity > 0.012 ? ["source-has-readable-text-or-title"] : []),
      ...detectSourceTextLoss(sourceQa, visualQa),
      ...(visualQa.risks || []),
      ...(!image.sourcePagePath && !image.sourceImagePath ? ["missing-source-reference"] : [])
    ];
    const status = visualQa.status === "pass" && !manualReasons.length ? "pass" : "review";
    pages.push({
      pageId: image.pageId,
      pageNumber: image.pageNumber,
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
  const styleConsistency = buildDeckStyleConsistencyReport(pages);
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
      styleConsistency
    },
    pages
  };
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { path: reportPath, report, summary: report.summary };
}

function buildDeckStyleConsistencyReport(pages = []) {
  const candidates = (Array.isArray(pages) ? pages : [])
    .map((page) => ({
      pageId: page.pageId,
      pageNumber: page.pageNumber,
      metrics: extractStyleMetrics(page.visualQa)
    }))
    .filter((page) => page.metrics);
  if (candidates.length < 3) {
    return {
      status: "insufficient-data",
      checkedPages: candidates.length,
      driftCount: 0,
      driftPages: [],
      message: "Need at least 3 generated pages for deck-level style consistency QA."
    };
  }
  const baseline = {
    brightness: median(candidates.map((page) => page.metrics.brightness)),
    saturationDensity: median(candidates.map((page) => page.metrics.saturationDensity)),
    edgeDensity: median(candidates.map((page) => page.metrics.edgeDensity)),
    textLikeScore: median(candidates.map((page) => page.metrics.textLikeScore)),
    titleEdgeDensity: median(candidates.map((page) => page.metrics.titleEdgeDensity))
  };
  const driftPages = candidates
    .map((page) => {
      const deltas = {
        brightness: round(Math.abs(page.metrics.brightness - baseline.brightness)),
        saturationDensity: round(Math.abs(page.metrics.saturationDensity - baseline.saturationDensity)),
        edgeDensity: round(Math.abs(page.metrics.edgeDensity - baseline.edgeDensity)),
        textLikeScore: round(Math.abs(page.metrics.textLikeScore - baseline.textLikeScore)),
        titleEdgeDensity: round(Math.abs(page.metrics.titleEdgeDensity - baseline.titleEdgeDensity))
      };
      const reasons = [
        ...(deltas.brightness > 0.22 ? ["style-brightness-drift"] : []),
        ...(deltas.saturationDensity > 0.35 ? ["style-color-drift"] : []),
        ...(deltas.edgeDensity > 0.085 ? ["style-density-drift"] : []),
        ...(deltas.textLikeScore > 0.04 ? ["style-text-density-drift"] : []),
        ...(deltas.titleEdgeDensity > 0.08 ? ["style-title-density-drift"] : [])
      ];
      return {
        pageId: page.pageId,
        pageNumber: page.pageNumber,
        reasons,
        metrics: page.metrics,
        deltas
      };
    })
    .filter((page) => page.reasons.length);
  return {
    status: driftPages.length ? "review" : "pass",
    checkedPages: candidates.length,
    driftCount: driftPages.length,
    driftPages,
    baseline,
    thresholds: {
      brightness: 0.22,
      saturationDensity: 0.35,
      edgeDensity: 0.085,
      textLikeScore: 0.04,
      titleEdgeDensity: 0.08
    },
    message: driftPages.length
      ? `${driftPages.length} page(s) visually drift from the deck baseline and need human review or rerun.`
      : "Deck-level pixel consistency QA did not detect obvious style drift."
  };
}

function extractStyleMetrics(qa = null) {
  if (!qa || qa.status === "failed" || !qa.full) return null;
  return {
    brightness: Number(qa.full.brightness || 0),
    saturationDensity: Number(qa.full.saturationDensity || 0),
    edgeDensity: Number(qa.full.edgeDensity || 0),
    textLikeScore: Number(qa.full.textLikeScore || 0),
    titleEdgeDensity: Number(qa.titleArea?.edgeDensity || 0)
  };
}

function median(values = []) {
  const numbers = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!numbers.length) return 0;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 ? numbers[middle] : round((numbers[middle - 1] + numbers[middle]) / 2);
}

function round(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
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
  return {
    ...stage,
    status,
    message,
    details,
    updatedAt: now,
    startedAt: stage.startedAt || now,
    ...(status === "complete" || status === "failed" ? { finishedAt: now } : {})
  };
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
