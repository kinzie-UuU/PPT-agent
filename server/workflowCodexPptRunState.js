import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import { rootDir } from "./store.js";
import { isCodexPptSampleApprovalCurrent } from "./workflowApprovals.js";

export async function prepareCodexPptSlideRun(job, { renderedPages = [], prompts = {}, selectedPages = [], options = {} } = {}) {
  const now = new Date().toISOString();
  const runDir = path.join(job.rootDir, "codex-ppt");
  const promptDir = path.join(runDir, "prompts");
  await fs.mkdir(promptDir, { recursive: true });
  const selected = selectedPages.length ? selectedPages : renderedPages.map((page) => page.pageNumber).filter(Boolean);
  const pagesByNumber = new Map(renderedPages.map((page) => [Number(page.pageNumber), page]));
  const promptByNumber = new Map((Array.isArray(prompts.pages) ? prompts.pages : []).map((prompt) => [Number(prompt.pageNumber), prompt]));
  const preservedByNumber = await readPreservedSlides(job);
  const backend = job.artifacts?.codexPptBackend || job.artifacts?.codexPptBackendDecision || {};
  const slidePrompts = [];

  for (const pageNumber of selected) {
    const page = pagesByNumber.get(Number(pageNumber));
    if (!page) continue;
    const prompt = promptByNumber.get(Number(pageNumber)) || {};
    const promptPayload = {
      version: 1,
      kind: "codex_ppt_slide_prompt",
      jobId: job.id,
      slideId: slideId(pageNumber),
      pageId: page.pageId || pageId(pageNumber),
      pageNumber,
      sourcePagePath: page.path || "",
      prompt: prompt.prompt || "",
      styleBrief: prompts.styleBrief || "",
      styleLock: prompts.styleLock || null,
      styleReferenceImages: Array.isArray(prompt.styleReferenceImages) ? prompt.styleReferenceImages : [],
      backend: compactBackend(backend),
      sampleGenerationMethod: buildSampleGenerationMethod(job),
      workerContract: {
        owner: "slide-worker",
        parentOwns: ["outline", "style", "backend", "deck_spec", "slide_jobs", "slide_run_state", "final_assembly"],
        workerReturns: ["selected_image_path", "backend", "qa_note"]
      },
      createdAt: now
    };
    const promptPath = path.join(promptDir, `${slideId(pageNumber)}.json`);
    await fs.writeFile(promptPath, JSON.stringify(promptPayload, null, 2), "utf8");
    slidePrompts.push({
      kind: "codex_ppt_slide_prompt",
      slideId: promptPayload.slideId,
      pageId: promptPayload.pageId,
      pageNumber,
      path: promptPath,
      relativePath: path.relative(rootDir, promptPath),
      sha256: await hashFile(promptPath),
      createdAt: now
    });
  }

  const deckSpecPath = path.join(runDir, "deck_spec.json");
  const speechPath = path.join(runDir, "speech.md");
  const slideJobsPath = path.join(runDir, "slide_jobs.json");
  const slideRunStatePath = path.join(runDir, "slide_run_state.json");
  const deckSpec = {
    version: 1,
    kind: "codex_ppt_deck_spec",
    jobId: job.id,
    createdAt: now,
    outline: artifactPointer(job.artifacts?.codexPptOutline),
    style: artifactPointer(job.artifacts?.codexPptStyle),
    backend: compactBackend(backend),
    sampleGenerationMethod: buildSampleGenerationMethod(job),
    styleLock: prompts.styleLock || null,
    selectedPages: selected,
    slideCount: slidePrompts.length,
    slides: slidePrompts.map((prompt) => ({
      slideId: prompt.slideId,
      pageId: prompt.pageId,
      pageNumber: prompt.pageNumber,
      promptPath: prompt.path,
      status: preservedByNumber.get(Number(prompt.pageNumber))?.status === "recorded" ? "recorded" : "pending"
    })),
    policy: {
      fixedBackendRequired: true,
      generatedImagesRequired: true,
      localDrawingFallbackAllowed: false,
      subagentDispatchRequiredWhenAvailable: true
    }
  };
  const slideJobs = {
    version: 1,
    kind: "codex_ppt_slide_jobs",
    jobId: job.id,
    createdAt: now,
    updatedAt: now,
    maxConcurrentSlides: clampInteger(options.maxConcurrentSlides || options.concurrency, 1, 12, 6),
    slides: slidePrompts.map((prompt) => buildPreparedSlide(prompt, deckSpec.backend, preservedByNumber.get(Number(prompt.pageNumber))))
  };
  const slideRunState = {
    version: 1,
    kind: "codex_ppt_slide_run_state",
    jobId: job.id,
    createdAt: now,
    updatedAt: now,
    sampleAccepted: Boolean(job.artifacts?.visualSample?.path),
    sampleGenerationMethod: deckSpec.sampleGenerationMethod,
    summary: summarizeSlideJobs(slideJobs.slides),
    slides: slideJobs.slides
  };
  await fs.writeFile(deckSpecPath, JSON.stringify(deckSpec, null, 2), "utf8");
  await fs.writeFile(speechPath, buildSpeechMarkdown(deckSpec), "utf8");
  await fs.writeFile(slideJobsPath, JSON.stringify(slideJobs, null, 2), "utf8");
  await fs.writeFile(slideRunStatePath, JSON.stringify(slideRunState, null, 2), "utf8");

  return {
    deckSpec: await artifactRecord("codex_ppt_deck_spec", deckSpecPath, { slideCount: deckSpec.slideCount }),
    speech: await artifactRecord("codex_ppt_speech", speechPath, { slideCount: deckSpec.slideCount }),
    slideJobs: await artifactRecord("codex_ppt_slide_jobs", slideJobsPath, summarizeSlideJobs(slideJobs.slides)),
    slideRunState: await artifactRecord("codex_ppt_slide_run_state", slideRunStatePath, summarizeSlideJobs(slideRunState.slides)),
    slidePrompts
  };
}

async function readPreservedSlides(job = {}) {
  const byNumber = new Map();
  const existingState = await readJson(job.artifacts?.codexPptSlideRunState?.path);
  const existingJobs = await readJson(job.artifacts?.codexPptSlideJobs?.path);
  const existingTasks = Array.isArray(job.artifacts?.codexPptSlideWorkerTasks) ? job.artifacts.codexPptSlideWorkerTasks : [];
  for (const slide of [...(existingJobs.slides || []), ...(existingState.slides || [])]) {
    const pageNumber = Number(slide.pageNumber || 0);
    if (!pageNumber) continue;
    byNumber.set(pageNumber, { ...(byNumber.get(pageNumber) || {}), ...slide });
  }
  for (const task of existingTasks) {
    const pageNumber = Number(task.pageNumber || String(task.pageId || "").match(/\d+/)?.[0] || 0);
    if (!pageNumber) continue;
    const previous = byNumber.get(pageNumber) || {};
    byNumber.set(pageNumber, {
      ...previous,
      status: task.status || previous.status,
      agentId: task.agentId || previous.agentId || "",
      dispatchedAt: task.dispatchAt || previous.dispatchedAt || "",
      recordedAt: task.recordedAt || previous.recordedAt || "",
      imagePath: task.imagePath || previous.imagePath || "",
      imageSha256: task.imageSha256 || previous.imageSha256 || "",
      qaNote: task.message || previous.qaNote || ""
    });
  }
  for (const image of Array.isArray(job.artifacts?.visualImages) ? job.artifacts.visualImages : []) {
    const pageNumber = Number(image?.pageNumber || String(image?.pageId || "").match(/\d+/)?.[0] || 0);
    const imagePath = cleanString(image?.path || "");
    if (!pageNumber || !imagePath || !fsSync.existsSync(imagePath) || !visualImageMatchesCurrentSample(job, image)) continue;
    const previous = byNumber.get(pageNumber) || {};
    byNumber.set(pageNumber, {
      ...previous,
      status: "recorded",
      imagePath,
      imageSha256: cleanString(image.sha256 || previous.imageSha256 || await hashFile(imagePath)),
      backend: compactBackend(image),
      agentId: cleanString(image.agentId || previous.agentId || "existing-visual-manifest"),
      dispatchMode: cleanString(image.dispatchMode || previous.dispatchMode || "manifest-recovery"),
      recordedAt: cleanString(image.finishedAt || image.createdAt || previous.recordedAt || ""),
      qaNote: cleanString(image.qaNote || previous.qaNote || "Recovered from the current visual image manifest.")
    });
  }
  if (isCodexPptSampleApprovalCurrent(job)) {
    const visualByNumber = new Map((Array.isArray(job.artifacts?.visualImages) ? job.artifacts.visualImages : [])
      .map((image) => [Number(image?.pageNumber || String(image?.pageId || "").match(/\d+/)?.[0] || 0), image])
      .filter(([pageNumber]) => pageNumber));
    for (const [pageNumber, preserved] of byNumber.entries()) {
      if (preserved.status !== "recorded") continue;
      const image = visualByNumber.get(pageNumber);
      if (!image || !visualImageMatchesCurrentSample(job, image)) byNumber.delete(pageNumber);
    }
  }
  const approvedSample = await buildApprovedSampleSlide(job);
  if (approvedSample) {
    const previous = byNumber.get(approvedSample.pageNumber) || {};
    byNumber.set(approvedSample.pageNumber, {
      ...previous,
      ...approvedSample,
      status: "recorded"
    });
  }
  return byNumber;
}

function visualImageMatchesCurrentSample(job = {}, image = {}) {
  if (image.staleStyleReference === true) return false;
  const sample = job.artifacts?.visualSample || {};
  if (!sample.sha256 || !sample.path || !isCodexPptSampleApprovalCurrent(job)) return true;
  if (image.approvedSampleSha256 === sample.sha256) return true;
  const samplePath = path.resolve(sample.path);
  return (Array.isArray(image.referenceImagePaths) ? image.referenceImagePaths : [])
    .some((item) => item && path.resolve(item) === samplePath);
}

async function buildApprovedSampleSlide(job = {}) {
  const sample = job.artifacts?.visualSample || {};
  const samplePath = cleanString(sample.path || "");
  if (!samplePath || !fsSync.existsSync(samplePath) || !isCodexPptSampleApprovalCurrent(job)) return null;
  const visualImages = Array.isArray(job.artifacts?.visualImages) ? job.artifacts.visualImages : [];
  const matchingImage = visualImages.find((image) => (
    (sample.sha256 && image?.sha256 === sample.sha256)
    || (image?.path && path.resolve(image.path) === path.resolve(samplePath))
    || (sample.pageId && image?.pageId === sample.pageId)
  ));
  const pageNumber = Number(
    sample.pageNumber
    || String(sample.pageId || "").match(/\d+/)?.[0]
    || matchingImage?.pageNumber
    || String(matchingImage?.pageId || "").match(/\d+/)?.[0]
    || 0
  );
  if (!pageNumber) return null;
  const imagePath = cleanString(matchingImage?.path || samplePath);
  if (!imagePath || !fsSync.existsSync(imagePath)) return null;
  return {
    pageNumber,
    status: "recorded",
    imagePath,
    imageSha256: cleanString(matchingImage?.sha256 || sample.sha256 || await hashFile(imagePath)),
    backend: compactBackend(matchingImage || sample),
    agentId: "approved-visual-sample",
    dispatchMode: "accepted-sample",
    recordedAt: cleanString(sample.approvedAt || sample.createdAt || new Date().toISOString()),
    qaNote: "Approved visual sample retained as the generated result for this page."
  };
}

function buildPreparedSlide(prompt, backend, preserved = {}) {
  const recorded = preserved.status === "recorded" && preserved.imagePath;
  return {
    slideId: prompt.slideId,
    pageId: prompt.pageId,
    pageNumber: prompt.pageNumber,
    promptPath: prompt.path,
    status: recorded ? "recorded" : "pending",
    backend: recorded ? compactBackend(preserved.backend || preserved) : backend,
    agentId: recorded ? cleanString(preserved.agentId || "") : "",
    dispatchMode: recorded ? cleanString(preserved.dispatchMode || "") : "",
    dispatchedAt: recorded ? cleanString(preserved.dispatchedAt || preserved.dispatchAt || "") : "",
    recordedAt: recorded ? cleanString(preserved.recordedAt || "") : "",
    imagePath: recorded ? cleanString(preserved.imagePath || "") : "",
    imageSha256: recorded ? cleanString(preserved.imageSha256 || "") : "",
    qaNote: recorded ? cleanString(preserved.qaNote || preserved.message || "") : ""
  };
}

export async function recordCodexPptSlideDispatch(runArtifacts = {}, { pageNumber, agentId = "", mode = "api-orchestrated-slide-worker" } = {}) {
  const slideJobs = await readJson(runArtifacts.slideJobs?.path);
  const slideRunState = await readJson(runArtifacts.slideRunState?.path);
  const now = new Date().toISOString();
  updateSlide(slideJobs, pageNumber, (slide) => ({
    ...slide,
    status: "dispatched",
    agentId: cleanString(agentId || `${mode}-${slide.slideId}`),
    dispatchMode: cleanString(mode),
    dispatchedAt: now
  }));
  updateSlide(slideRunState, pageNumber, (slide) => ({
    ...slide,
    status: "dispatched",
    agentId: cleanString(agentId || `${mode}-${slide.slideId}`),
    dispatchMode: cleanString(mode),
    dispatchedAt: now
  }));
  await writeSlideState(runArtifacts, slideJobs, slideRunState);
  return refreshRunArtifacts(runArtifacts);
}

export async function recordCodexPptSlideResult(runArtifacts = {}, { pageNumber, imageRecord = {}, qaNote = "" } = {}) {
  const slideJobs = await readJson(runArtifacts.slideJobs?.path);
  const slideRunState = await readJson(runArtifacts.slideRunState?.path);
  const now = new Date().toISOString();
  const patch = (slide) => ({
    ...slide,
    status: "recorded",
    imagePath: imageRecord.path || "",
    imageSha256: imageRecord.sha256 || "",
    backend: compactBackend(imageRecord),
    qaNote: cleanString(qaNote || imageRecord.qaNote || "Recorded generated slide image result."),
    recordedAt: now
  });
  updateSlide(slideJobs, pageNumber, patch);
  updateSlide(slideRunState, pageNumber, patch);
  await writeSlideState(runArtifacts, slideJobs, slideRunState);
  return refreshRunArtifacts(runArtifacts);
}

async function writeSlideState(runArtifacts, slideJobs, slideRunState) {
  const now = new Date().toISOString();
  slideJobs.updatedAt = now;
  slideRunState.updatedAt = now;
  slideRunState.summary = summarizeSlideJobs(slideRunState.slides);
  await fs.writeFile(runArtifacts.slideJobs.path, JSON.stringify(slideJobs, null, 2), "utf8");
  await fs.writeFile(runArtifacts.slideRunState.path, JSON.stringify(slideRunState, null, 2), "utf8");
}

async function refreshRunArtifacts(runArtifacts) {
  const slideJobs = await readJson(runArtifacts.slideJobs?.path);
  const slideRunState = await readJson(runArtifacts.slideRunState?.path);
  return {
    ...runArtifacts,
    slideJobs: await artifactRecord("codex_ppt_slide_jobs", runArtifacts.slideJobs.path, summarizeSlideJobs(slideJobs.slides)),
    slideRunState: await artifactRecord("codex_ppt_slide_run_state", runArtifacts.slideRunState.path, summarizeSlideJobs(slideRunState.slides))
  };
}

function updateSlide(bundle, pageNumber, updater) {
  const slides = Array.isArray(bundle?.slides) ? bundle.slides : [];
  const index = slides.findIndex((slide) => Number(slide.pageNumber) === Number(pageNumber));
  if (index < 0) return;
  slides[index] = updater(slides[index]);
}

function summarizeSlideJobs(slides = []) {
  const total = slides.length;
  const pending = slides.filter((slide) => slide.status === "pending").length;
  const dispatched = slides.filter((slide) => slide.status === "dispatched" || slide.dispatchedAt || slide.agentId).length;
  const recorded = slides.filter((slide) => slide.status === "recorded").length;
  const failed = slides.filter((slide) => slide.status === "failed").length;
  return { total, pending, dispatched, recorded, failed, complete: total > 0 && recorded >= total && failed === 0 };
}

function buildSampleGenerationMethod(job = {}) {
  const sample = job.artifacts?.visualSample || {};
  return {
    samplePath: sample.path || "",
    provider: sample.provider || "",
    baseUrl: sample.baseUrl || job.artifacts?.codexPptBackend?.baseUrl || "",
    model: sample.model || job.artifacts?.codexPptBackend?.model || "",
    dryRun: Boolean(sample.dryRun),
    sha256: sample.sha256 || "",
    prompt: sample.prompt || ""
  };
}

function buildSpeechMarkdown(deckSpec = {}) {
  const lines = ["# Speech Notes", ""];
  for (const slide of deckSpec.slides || []) {
    lines.push(`## Slide ${slide.pageNumber}`, "", `Use the approved deck style and source page ${slide.pageNumber} narrative.`, "");
  }
  return lines.join("\n");
}

function compactBackend(record = {}) {
  return {
    provider: cleanString(record.provider || record.baseUrl || record.source || ""),
    baseUrl: cleanString(record.baseUrl || ""),
    model: cleanString(record.model || record.imageModel || ""),
    dryRun: Boolean(record.dryRun)
  };
}

function artifactPointer(record = {}) {
  return {
    path: record.path || "",
    markdownPath: record.markdownPath || "",
    sha256: record.sha256 || "",
    title: record.title || ""
  };
}

async function artifactRecord(kind, filePath, extra = {}) {
  const stat = await fs.stat(filePath);
  return {
    kind,
    path: filePath,
    relativePath: path.relative(rootDir, filePath),
    size: stat.size,
    sha256: await hashFile(filePath),
    createdAt: new Date().toISOString(),
    ...extra
  };
}

async function readJson(filePath = "") {
  if (!filePath || !fsSync.existsSync(filePath)) return {};
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function hashFile(filePath) {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function slideId(pageNumber) {
  return `slide_${String(pageNumber).padStart(2, "0")}`;
}

function pageId(pageNumber) {
  return `page_${String(pageNumber).padStart(3, "0")}`;
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function cleanString(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 1000);
}
