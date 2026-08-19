import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { readWorkflowJob } from "./workflowJobs.js";
import { getProviderConfig } from "./providers.js";

export async function getWorkflowCostEstimate(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const providers = getProviderConfig();
  const sourceMeta = await readArtifactJson(job, job.artifacts?.sourceMeta?.path);
  const pageCount = inferPageCount(job, sourceMeta);
  const artifacts = job.artifacts || {};
  const visualImages = Array.isArray(artifacts.visualImages) ? artifacts.visualImages : [];
  const tasks = Array.isArray(artifacts.editableWorkerTasks) ? artifacts.editableWorkerTasks : [];
  const recordedPages = tasks.filter((task) => task.status === "recorded").length;
  const failedPages = tasks.filter((task) => task.status === "failed").length;
  const hasImageDeck = Boolean(artifacts.imageDeck?.path);
  const hasFinal = Boolean(artifacts.editableFinal?.path);
  const hasVisualSample = Boolean(artifacts.visualSample?.path);
  const hasOcrHints = Boolean(artifacts.ocrTextHints?.path || artifacts.editableHints?.summary?.readyPages);
  const imageGenerations = {
    sampleRemaining: hasVisualSample ? 0 : clampCount(pageCount ? 1 : 0),
    deckRemaining: hasImageDeck ? 0 : clampCount(pageCount - visualImages.length),
    recorded: visualImages.length,
    totalExpected: pageCount
  };
  const editablePages = {
    remaining: hasFinal ? 0 : clampCount(pageCount - recordedPages),
    recorded: recordedPages,
    failed: failedPages,
    totalExpected: pageCount
  };
  const ocrPages = {
    remaining: hasOcrHints ? 0 : pageCount,
    totalExpected: pageCount
  };
  const llm = estimateLlmUsage(pageCount, artifacts);
  const pricing = readPricing(options.env || globalThis.process?.env || {});
  const editableImageCallsPerPage = readEditableImageCallsPerPage(options.env || globalThis.process?.env || {});
  const editableAssetImageCalls = job.input?.deliveryMode === "editable" || job.constraints?.spendBudget?.deliveryMode === "editable"
    ? editablePages.remaining * editableImageCallsPerPage
    : 0;
  const costItems = [
    makeCostItem("codex-ppt visual sample", imageGenerations.sampleRemaining, pricing.imageUsdPerGeneration, "image generation"),
    makeCostItem("codex-ppt full visual deck", imageGenerations.deckRemaining, pricing.imageUsdPerGeneration, "image generation"),
    makeCostItem("editable visual assets", editableAssetImageCalls, pricing.imageUsdPerGeneration, "image generation"),
    makeCostItem("OCR text hints", ocrPages.remaining, pricing.ocrUsdPerPage, providers.ocr.provider === "rapidocr-local" ? "local OCR page" : "OCR page"),
    makeCostItem("editable page rebuild", editablePages.remaining, pricing.editableUsdPerPage, "editable page"),
    makeTokenCostItem("LLM planning and prompts", llm.inputTokens, llm.outputTokens, pricing.llmInputUsdPer1k, pricing.llmOutputUsdPer1k)
  ];
  const knownItems = costItems.filter((item) => item.known);
  const unknownItems = costItems.filter((item) => !item.known && item.quantity > 0);
  const knownTotalUsd = roundMoney(knownItems.reduce((sum, item) => sum + item.estimatedUsd, 0));
  const contingencyRate = normalizeContingencyRate(job.constraints?.spendBudget?.contingencyRate);
  const upperBoundUsd = unknownItems.length ? null : roundMoney(knownTotalUsd * (1 + contingencyRate));
  const plannedImageCalls = imageGenerations.sampleRemaining + imageGenerations.deckRemaining + editableAssetImageCalls;
  const budget = buildBudgetStatus(job.constraints?.spendBudget, {
    knownTotalUsd,
    upperBoundUsd,
    plannedImageCalls,
    pricingConfigured: unknownItems.length === 0,
    contingencyRate
  });
  const duration = estimateDurationMinutes({ imageGenerations, editablePages, ocrPages, providers });
  const warnings = [];
  if (!providers.image.configured || !providers.image.enabled) warnings.push("Image provider is not ready; visual generation cannot run on the product path.");
  if (imageGenerations.sampleRemaining + imageGenerations.deckRemaining > 0 && pricing.imageUsdPerGeneration === null) warnings.push("Set COST_IMAGE_USD_PER_GENERATION to show an image API dollar estimate.");
  if (editablePages.remaining > 0 && pricing.editableUsdPerPage === null) warnings.push("Set COST_EDITABLE_PAGE_USD to estimate image-to-editable-ppt page rebuild cost.");
  if (unknownItems.length) warnings.push("Some unit prices are not configured, so the dollar total is partial.");
  return {
    ok: true,
    jobId: job.id,
    currency: "USD",
    pricingConfigured: unknownItems.length === 0,
    knownTotalUsd,
    upperBoundUsd,
    contingencyRate,
    plannedImageCalls,
    budget,
    unknownCostItems: unknownItems.map((item) => item.id),
    pageCount,
    operations: {
      imageGenerations,
      editablePages,
      ocrPages,
      llm
    },
    duration,
    providers: {
      image: publicProvider(providers.image),
      llm: publicProvider(providers.llm),
      ocr: {
        provider: providers.ocr.provider,
        enabled: providers.ocr.enabled,
        concurrency: providers.ocr.concurrency
      }
    },
    costItems,
    warnings,
    notes: [
      "This is a conservative planning estimate, not a provider bill.",
      "Unit prices are read from local environment variables and never exposed as API keys."
    ],
    updatedAt: new Date().toISOString()
  };
}

export function getWorkflowCostPreview(options = {}) {
  const pageCount = clampCount(options.pageCount);
  const deliveryMode = options.deliveryMode === "editable" ? "editable" : "visual";
  const env = options.env || globalThis.process?.env || {};
  const pricing = readPricing(env);
  const editableImageCallsPerPage = readEditableImageCallsPerPage(env);
  const visualImageCalls = pageCount ? pageCount + 1 : 0;
  const editableAssetImageCalls = deliveryMode === "editable" ? pageCount * editableImageCallsPerPage : 0;
  const llm = estimateLlmUsage(pageCount, {});
  const costItems = [
    makeCostItem("codex-ppt visual generation", visualImageCalls, pricing.imageUsdPerGeneration, "image generation"),
    makeCostItem("editable visual assets", editableAssetImageCalls, pricing.imageUsdPerGeneration, "image generation"),
    makeCostItem("OCR text hints", pageCount, pricing.ocrUsdPerPage, "OCR page"),
    makeCostItem("editable page rebuild", deliveryMode === "editable" ? pageCount : 0, pricing.editableUsdPerPage, "editable page"),
    makeTokenCostItem("LLM planning and prompts", llm.inputTokens, llm.outputTokens, pricing.llmInputUsdPer1k, pricing.llmOutputUsdPer1k)
  ];
  const unknownItems = costItems.filter((item) => !item.known && item.quantity > 0);
  const knownTotalUsd = roundMoney(costItems.filter((item) => item.known).reduce((sum, item) => sum + item.estimatedUsd, 0));
  const contingencyRate = normalizeContingencyRate(options.contingencyRate);
  const upperBoundUsd = unknownItems.length ? null : roundMoney(knownTotalUsd * (1 + contingencyRate));
  const plannedImageCalls = visualImageCalls + editableAssetImageCalls;
  return {
    ok: true,
    currency: "USD",
    pageCount,
    deliveryMode,
    pricingConfigured: unknownItems.length === 0,
    knownTotalUsd,
    upperBoundUsd,
    contingencyRate,
    plannedImageCalls,
    editableImageCallsPerPage,
    unknownCostItems: unknownItems.map((item) => item.id),
    costItems,
    predictability: {
      ready: pageCount > 0 && unknownItems.length === 0,
      reason: !pageCount
        ? "请先生成大纲以确定页数。"
        : unknownItems.length
          ? "尚未配置全部模型单价；可以继续整理材料和大纲，但不能创建付费任务。"
          : `费用上限已包含 ${Math.round(contingencyRate * 100)}% 风险缓冲。`
    }
  };
}

async function readArtifactJson(job = {}, filePath = "") {
  if (!filePath) return null;
  const resolved = path.resolve(String(filePath));
  const root = path.resolve(job.rootDir || "");
  if (!isInsidePath(resolved, root) || !fsSync.existsSync(resolved)) return null;
  try {
    return JSON.parse(await fs.readFile(resolved, "utf8"));
  } catch {
    return null;
  }
}

function inferPageCount(job = {}, sourceMeta = null) {
  const artifacts = job.artifacts || {};
  const final = artifacts.editableFinal || {};
  const candidates = [
    artifacts.codexPptOutline?.slideCount,
    sourceMeta?.pageCount,
    artifacts.sourceMeta?.pageCount,
    countArray(artifacts.renderedPages),
    countArray(artifacts.visualImages),
    artifacts.imageDeck?.pageCount,
    artifacts.editableRun?.pageCount,
    artifacts.editableHints?.summary?.pageCount,
    artifacts.workerBriefs?.pageCount,
    final.summary?.page_count,
    final.pptxEditability?.slideCount,
    Array.isArray(job.pages) ? job.pages.length : 0
  ].map((value) => Number(value || 0)).filter((value) => Number.isFinite(value) && value > 0);
  return Math.max(0, Math.min(500, Math.round(Math.max(...candidates, 0))));
}

function estimateLlmUsage(pageCount, artifacts = {}) {
  const promptPages = countArray(artifacts.editableWorkerPrompts);
  const effectivePages = Math.max(pageCount, promptPages, 1);
  return {
    callsRemaining: artifacts.codexPptOutline?.path && artifacts.codexPptStyle?.path ? 0 : 2,
    inputTokens: effectivePages * 1200,
    outputTokens: effectivePages * 500
  };
}

function readPricing(env = {}) {
  return {
    imageUsdPerGeneration: optionalMoney(env.COST_IMAGE_USD_PER_GENERATION),
    editableUsdPerPage: optionalMoney(env.COST_EDITABLE_PAGE_USD),
    ocrUsdPerPage: optionalMoney(env.COST_OCR_PAGE_USD, 0),
    llmInputUsdPer1k: optionalMoney(env.COST_LLM_INPUT_USD_PER_1K),
    llmOutputUsdPer1k: optionalMoney(env.COST_LLM_OUTPUT_USD_PER_1K)
  };
}

function readEditableImageCallsPerPage(env = {}) {
  const number = Number(env.PPT_EXTERNAL_IMAGE_CALL_BUDGET || 8);
  if (!Number.isFinite(number)) return 8;
  return Math.max(0, Math.min(50, Math.round(number)));
}

function normalizeContingencyRate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.2;
  return Math.max(0, Math.min(1, number));
}

function buildBudgetStatus(policy = null, estimate = {}) {
  const enabled = policy?.enforcePredictableCost === true;
  const maxTotalUsd = optionalMoney(policy?.maxTotalUsd);
  const maxImageCalls = clampCount(policy?.maxImageCalls);
  const reasons = [];
  if (enabled && !estimate.pricingConfigured) reasons.push("pricing-not-configured");
  if (enabled && (maxTotalUsd === null || estimate.upperBoundUsd > maxTotalUsd)) reasons.push("usd-budget-exceeded");
  if (enabled && (!maxImageCalls || estimate.plannedImageCalls > maxImageCalls)) reasons.push("image-call-budget-exceeded");
  return {
    enabled,
    ready: !enabled || reasons.length === 0,
    maxTotalUsd,
    maxImageCalls,
    estimatedUpperBoundUsd: estimate.upperBoundUsd,
    plannedImageCalls: estimate.plannedImageCalls,
    reasons
  };
}

function makeCostItem(label, quantity, unitUsd, unitLabel) {
  const known = unitUsd !== null;
  return {
    id: label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    label,
    unitLabel,
    quantity,
    unitUsd,
    known,
    estimatedUsd: known ? roundMoney(quantity * unitUsd) : 0
  };
}

function makeTokenCostItem(label, inputTokens, outputTokens, inputUnitUsd, outputUnitUsd) {
  const known = inputUnitUsd !== null && outputUnitUsd !== null;
  const estimatedUsd = known
    ? roundMoney(inputTokens / 1000 * inputUnitUsd + outputTokens / 1000 * outputUnitUsd)
    : 0;
  return {
    id: "llm-planning-and-prompts",
    label,
    unitLabel: "estimated tokens",
    quantity: inputTokens + outputTokens,
    inputTokens,
    outputTokens,
    unitUsd: known ? { inputPer1k: inputUnitUsd, outputPer1k: outputUnitUsd } : null,
    known,
    estimatedUsd
  };
}

function estimateDurationMinutes({ imageGenerations, editablePages, ocrPages, providers }) {
  const imageCount = imageGenerations.sampleRemaining + imageGenerations.deckRemaining;
  const imageConcurrency = Math.max(1, Number(providers.image.concurrency || 1));
  const editableConcurrency = 6;
  const ocrConcurrency = Math.max(1, Number(providers.ocr.concurrency || 1));
  const min = Math.ceil(
    imageCount / imageConcurrency * 2
    + editablePages.remaining / editableConcurrency * 4
    + ocrPages.remaining / ocrConcurrency * 0.25
  );
  const max = Math.ceil(
    imageCount / imageConcurrency * 6
    + editablePages.remaining / editableConcurrency * 12
    + ocrPages.remaining / ocrConcurrency * 0.75
  );
  return {
    minMinutes: Math.max(0, min),
    maxMinutes: Math.max(0, max),
    label: max ? `${Math.max(1, min)}-${Math.max(1, max)} min` : "No remaining generated work"
  };
}

function publicProvider(provider = {}) {
  return {
    provider: provider.provider || "",
    configured: Boolean(provider.configured),
    enabled: provider.enabled !== false,
    baseUrl: provider.baseUrl || "",
    model: provider.model || "",
    concurrency: provider.concurrency || 1
  };
}

function optionalMoney(value, fallback = null) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return number;
}

function clampCount(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.round(number));
}

function countArray(value) {
  return Array.isArray(value) ? value.length : 0;
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

function isInsidePath(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}
