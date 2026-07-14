import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import zlib from "zlib";
import { rootDir } from "./store.js";
import { editImageWithProvider, generateImageWithProvider, getProviderConfig } from "./providers.js";
import { CODEX_PPT_VISUAL_DECK_GATES, isCodexPptFullDeckApprovalCurrent } from "./workflowApprovals.js";
import { assembleWorkflowImageDeck, assertWorkflowVisualGenerationAllowed, getRenderedPages } from "./workflowVisuals.js";
import { buildWorkflowEditableWorkerPrompts, prepareWorkflowEditableRun } from "./workflowEditable.js";
import { syncWorkflowEditableWorkerTasks } from "./workflowWorkerQueue.js";
import { getExternalImageAuthorizationStatus } from "./workflowAuthorizations.js";
import {
  claimWorkflowCodexPptSlideTask,
  completeWorkflowCodexPptSlideTask,
  listWorkflowCodexPptSlideTasks,
  markWorkflowCodexPptSlideTaskFailed,
  syncWorkflowCodexPptSlideTasks
} from "./workflowCodexPptWorkerQueue.js";
import { readWorkflowJob, saveWorkflowJob } from "./workflowJobs.js";

export async function runWorkflowCodexPptSlideBatch(jobId, options = {}) {
  const synced = await syncWorkflowCodexPptSlideTasks(jobId, options);
  const preflight = await getWorkflowCodexPptSlideBatchPreflight(jobId, {
    ...options,
    syncedTaskBundle: synced
  });
  if (!preflight.startReady) {
    throw new Error(`Codex-ppt slide batch preflight failed: ${[...preflight.blockingIssues, ...preflight.warnings].join(" ") || "not start-ready"}`);
  }
  assertWorkflowVisualGenerationAllowed({
    ...options,
    confirmExternalImageSpend: Boolean(preflight.requiredConfirmations?.externalImageSpend?.confirmed)
  });
  const job = await readWorkflowJob(jobId);
  const runId = makeRunId();
  const agentPrefix = cleanToken(options.agentPrefix || "product-codex-slide-batch");
  const selectedTasks = selectRunnableTasks(synced.tasks || [], options);
  const nonProduct = Boolean(options.allowNonProductVisual || options.dryRun || options.passthrough || options.provider === "passthrough");
  const runDir = path.join(job.dirs.logs, "codex-slide-batches", runId);
  await fs.mkdir(runDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const results = [];
  const errors = [];
  const confirmedExternalImageSpend = Boolean(
    preflight.requiredConfirmations?.externalImageSpend?.confirmed
    || options.confirmExternalImageSpend
    || options.confirmSpend
    || options.confirmImageApiSpend
  );

  for (const task of selectedTasks) {
    const agentId = `${agentPrefix}-${task.pageId}`;
    try {
      await claimWorkflowCodexPptSlideTask(jobId, task.pageId, {
        agentId,
        workerName: "product codex-ppt slide batch",
        confirmSpawned: true,
        spawned: true,
        dispatchMode: "product-codex-slide-batch",
        message: "claimed by product codex-ppt slide batch runner"
      });
      const promptPayload = await readPromptPayload(job, task);
      const image = nonProduct
        ? await writePlaceholderImage(runDir, task, promptPayload)
        : await createCodexSlideImage(job, task, promptPayload);
      const completed = await completeWorkflowCodexPptSlideTask(jobId, task.pageId, {
        agentId,
        imagePath: image.path,
        confirmExternalImageSpend: confirmedExternalImageSpend,
        provider: image.provider || (nonProduct ? "passthrough" : ""),
        baseUrl: image.baseUrl || "",
        model: image.model || "",
        dryRun: Boolean(nonProduct),
        passthrough: Boolean(nonProduct),
        allowNonProductVisual: Boolean(nonProduct),
        source: nonProduct ? "codex-slide-batch-placeholder" : "product-codex-slide-batch",
        qaNote: nonProduct ? "Regression placeholder recorded by codex-ppt slide batch runner." : "Generated and recorded by product codex-ppt slide batch runner."
      });
      results.push({
        pageId: task.pageId,
        pageNumber: task.pageNumber,
        status: "recorded",
        imagePath: image.path,
        provider: image.provider || (nonProduct ? "passthrough" : ""),
        model: image.model || "",
        summary: completed.summary || null
      });
    } catch (error) {
      const message = error.message || "codex-ppt slide batch failed";
      errors.push({ pageId: task.pageId, pageNumber: task.pageNumber, error: message });
      await markWorkflowCodexPptSlideTaskFailed(jobId, task.pageId, { agentId, error: message }).catch(() => null);
      if (options.stopOnError) break;
    }
  }

  const finalBundle = await listWorkflowCodexPptSlideTasks(jobId);
  let imageDeck = null;
  let imageDeckError = "";
  let editableRun = null;
  let editablePrepareError = "";
  let editableWorkerTaskBundle = null;
  let editableWorkerPromptError = "";
  const shouldAssembleImageDeck = Boolean(options.assembleImageDeck || options.autoAssembleImageDeck);
  const shouldPrepareEditable = Boolean(options.prepareEditable || options.autoPrepareEditable);
  const shouldBuildEditablePrompts = Boolean(options.buildEditablePrompts || options.autoBuildEditablePrompts || options.syncEditableWorkerTasks);
  const allRecorded = Number(finalBundle.summary?.total || 0) > 0
    && Number(finalBundle.summary?.recorded || 0) >= Number(finalBundle.summary?.total || 0)
    && Number(finalBundle.summary?.failed || 0) === 0;
  if (shouldAssembleImageDeck && errors.length === 0 && allRecorded) {
    try {
      const deckJob = await assembleWorkflowImageDeck(jobId, {
        outName: cleanString(options.imageDeckName || "codex-ppt-image-deck.pptx")
      });
      imageDeck = deckJob.artifacts?.imageDeck || null;
    } catch (error) {
      imageDeckError = error.message || "image deck assembly failed";
      errors.push({ pageId: "", pageNumber: 0, error: imageDeckError });
    }
  }
  const imageDeckReady = !shouldAssembleImageDeck || Boolean(imageDeck?.path);
  if (shouldPrepareEditable && errors.length === 0 && allRecorded && imageDeckReady) {
    try {
      const editableJob = await prepareWorkflowEditableRun(jobId, {
        force: options.forceEditablePrepare !== false,
        maxConcurrentPages: clampInteger(options.editableMaxConcurrentPages || options.maxConcurrentPages, 1, 12, 6),
        noTextHints: Boolean(options.noTextHints),
        timeoutMs: options.editableTimeoutMs,
        skillRoot: options.editpptSkillRoot,
        pythonPath: options.editpptPythonPath,
        runRoot: options.editpptRunRoot,
        requestedBy: options.requestedBy || "codex-ppt-slide-batch-runner",
        note: options.note || "",
        allowNonProductVisual: Boolean(options.allowNonProductVisual)
      });
      editableRun = editableJob.artifacts?.editableRun || null;
    } catch (error) {
      editablePrepareError = error.message || "editable prepare failed";
      errors.push({ pageId: "", pageNumber: 0, stage: "editable/prepare", error: editablePrepareError });
    }
  }
  if (shouldBuildEditablePrompts && errors.length === 0 && editableRun?.path) {
    try {
      await buildWorkflowEditableWorkerPrompts(jobId, {
        pages: options.editablePages || "",
        pageIds: options.editablePageIds || ""
      });
      editableWorkerTaskBundle = await syncWorkflowEditableWorkerTasks(jobId, {});
    } catch (error) {
      editableWorkerPromptError = error.message || "editable worker prompt build failed";
      errors.push({ pageId: "", pageNumber: 0, stage: "editable/prompts", error: editableWorkerPromptError });
    }
  }
  const run = {
    id: runId,
    kind: "codex_ppt_slide_batch_run",
    status: errors.length ? "failed" : "complete",
    nonProduct,
    confirmExternalImageSpend: Boolean(options.confirmExternalImageSpend || options.confirmSpend),
    requested: selectedTasks.length,
    recorded: results.length,
    failed: errors.length,
    pages: cleanString(options.pages || ""),
    maxPages: clampInteger(options.maxPages, 1, 200, selectedTasks.length || 20),
    agentPrefix,
    results,
    errors,
    imageDeck,
    imageDeckError,
    editableRun,
    editablePrepareError,
    editableWorkerTaskSummary: editableWorkerTaskBundle?.summary || null,
    editableWorkerPromptError,
    runDir,
    relativeRunDir: path.relative(rootDir, runDir),
    startedAt,
    finishedAt: new Date().toISOString()
  };
  await recordBatchRun(jobId, run);
  return {
    ok: errors.length === 0,
    jobId,
    run: publicRun(run),
    taskBundle: finalBundle,
    imageDeck,
    editableRun,
    editableWorkerTaskBundle,
    summary: finalBundle.summary
  };
}

export async function getWorkflowCodexPptSlideBatchPreflight(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const providers = getProviderConfig();
  const nonProduct = Boolean(options.allowNonProductVisual || options.dryRun || options.passthrough || options.provider === "passthrough");
  const taskBundle = options.syncedTaskBundle || await listWorkflowCodexPptSlideTasks(jobId);
  const tasks = Array.isArray(taskBundle.tasks) ? taskBundle.tasks : [];
  const selectedTasks = selectRunnableTasks(tasks, options);
  const approvals = summarizeApprovals(job);
  const provider = providers.image || {};
  const backendRuntime = buildCodexSlideBackendRuntimeEvidence(providers, job.artifacts?.codexPptBackendDecision);
  const externalImageRequired = !nonProduct;
  const authorization = externalImageRequired
    ? getExternalImageAuthorizationStatus(job, { scope: "full-deck", imageCalls: selectedTasks.length })
    : null;
  const externalImageConfirmed = Boolean(options.confirmExternalImageSpend || options.confirmSpend || authorization?.persisted);
  const blockingIssues = [];
  const warnings = [];
  if (!approvals.ready) {
    blockingIssues.push(`Missing codex-ppt approval gate(s): ${approvals.missing.join(", ")}`);
  }
  if (!tasks.length) {
    blockingIssues.push("No codex-ppt slide worker tasks are synced. Sync the slide queue after full-deck approval.");
  } else if (!selectedTasks.length) {
    blockingIssues.push("No ready or failed codex-ppt slide tasks are available for batch generation.");
  }
  if (externalImageRequired && (!provider.configured || provider.enabled === false)) {
    blockingIssues.push("External image API provider is not configured or enabled.");
  }
  if (externalImageRequired && backendRuntime.approvedBackendLooksDryRun) {
    blockingIssues.push("codex-ppt backend approval was recorded from a dry-run/passthrough path. Re-approve the backend with the current image runtime before product visual generation.");
  } else if (externalImageRequired && !backendRuntime.backendMatchesRuntime) {
    blockingIssues.push("codex-ppt backend approval no longer matches the current image runtime. Re-approve the backend before product visual generation.");
  }
  if (externalImageRequired && !externalImageConfirmed) {
    warnings.push("External image API credit confirmation is required before starting codex-ppt slide image generation.");
  }
  const ready = blockingIssues.length === 0;
  return {
    ok: true,
    ready,
    startReady: ready && (!externalImageRequired || externalImageConfirmed),
    mode: nonProduct ? "non-product" : "product",
    selectedCount: selectedTasks.length,
    selectedPages: selectedTasks.map((task) => task.pageNumber).filter(Boolean),
    counts: taskBundle.summary || summarizeTasks(tasks),
    approvals,
    provider: {
      configured: Boolean(provider.configured),
      enabled: provider.enabled !== false,
      model: provider.model || "",
      baseUrl: provider.baseUrl || ""
    },
    authorization,
    backendRuntime,
    requiredConfirmations: {
      externalImageSpend: {
        required: externalImageRequired,
        confirmed: externalImageRequired ? externalImageConfirmed : false,
        persisted: Boolean(authorization?.persisted),
        source: authorization?.persisted ? "authorization-ledger" : externalImageConfirmed ? "request-confirmation" : "missing"
      }
    },
    cost: {
      imageCalls: selectedTasks.length,
      knownTotalUsd: null,
      unknownCostItems: externalImageRequired && selectedTasks.length ? ["codex-ppt-slide-image-generation"] : []
    },
    blockingIssues,
    warnings,
    startBody: {
      maxPages: selectedTasks.length || clampInteger(options.maxPages, 1, 200, tasks.length || 20),
      pages: selectedTasks.map((task) => task.pageNumber).filter(Boolean).join(","),
      confirmExternalImageSpend: externalImageRequired ? externalImageConfirmed : false,
      assembleImageDeck: options.assembleImageDeck !== false,
      prepareEditable: options.prepareEditable !== false,
      buildEditablePrompts: options.buildEditablePrompts !== false,
      syncEditableWorkerTasks: options.syncEditableWorkerTasks !== false
    }
  };
}

function buildCodexSlideBackendRuntimeEvidence(providers = {}, backendDecision = null) {
  const runtime = {
    configured: Boolean(providers.image?.configured),
    enabled: providers.image?.enabled !== false,
    baseUrl: providers.image?.baseUrl || "",
    model: providers.image?.model || ""
  };
  const approvedBackend = {
    provider: backendDecision?.provider || backendDecision?.backend?.provider || "",
    baseUrl: backendDecision?.baseUrl || backendDecision?.backend?.baseUrl || "",
    model: backendDecision?.model || backendDecision?.backend?.model || ""
  };
  const modelMatches = !approvedBackend.model || !runtime.model || approvedBackend.model === runtime.model;
  const baseUrlMatches = !approvedBackend.baseUrl || !runtime.baseUrl || normalizeBaseUrl(approvedBackend.baseUrl) === normalizeBaseUrl(runtime.baseUrl);
  const backendMatchesRuntime = modelMatches && baseUrlMatches;
  const approvedBackendLooksDryRun = looksLikeDryRun([
    backendDecision?.source,
    approvedBackend.provider,
    approvedBackend.model,
    approvedBackend.baseUrl
  ].join(" "));
  return {
    runtime,
    approvedBackend,
    runtimeKey: [runtime.model, normalizeBaseUrl(runtime.baseUrl)].filter(Boolean).join(" @ "),
    approvedBackendKey: [approvedBackend.provider, approvedBackend.model, normalizeBaseUrl(approvedBackend.baseUrl)].filter(Boolean).join(" @ "),
    modelMatches,
    baseUrlMatches,
    backendMatchesRuntime,
    backendMismatch: !backendMatchesRuntime,
    approvedBackendLooksDryRun
  };
}

function looksLikeDryRun(value = "") {
  return /\b(regression|dry[-_\s]?run|passthrough|source[-_\s]?page[-_\s]?passthrough)\b/i.test(String(value || ""));
}

function normalizeBaseUrl(value = "") {
  return String(value || "").trim().replace(/\/+$/, "");
}

function selectRunnableTasks(tasks = [], options = {}) {
  const selectedPages = parsePageSelection(options.pages || options.pageNumbers);
  const maxPages = clampInteger(options.maxPages, 1, 200, tasks.length || 20);
  return tasks
    .filter((task) => !selectedPages.size || selectedPages.has(Number(task.pageNumber || 0)))
    .filter((task) => task.status === "ready" || task.status === "failed" || (options.includeRunning && task.status === "running"))
    .slice(0, maxPages);
}

async function readPromptPayload(job = {}, task = {}) {
  const filePath = path.resolve(task.promptFile || "");
  const root = path.resolve(job.rootDir || "");
  if (!filePath || !isInsidePath(filePath, root) || !fsSync.existsSync(filePath)) return {};
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return {};
  }
}

async function createCodexSlideImage(job = {}, task = {}, promptPayload = {}) {
  const prompt = providerPrompt(promptPayload.prompt || `Create presentation slide ${task.pageNumber}.`);
  const sourceImagePath = findSourceImagePath(job, task, promptPayload);
  if (sourceImagePath && promptPayload.useSourceImageReference !== false) {
    return editImageWithProvider({
      prompt,
      sourceImagePath,
      width: 1536,
      height: 864,
      prefix: `${job.id}_${task.pageId}`
    });
  }
  return generateImageWithProvider({
    prompt,
    width: 1536,
    height: 864,
    prefix: `${job.id}_${task.pageId}`
  });
}

function findSourceImagePath(job = {}, task = {}, promptPayload = {}) {
  const renderedPage = getRenderedPages(job).find((page) => Number(page.pageNumber || 0) === Number(task.pageNumber || 0));
  const candidates = [
    renderedPage?.path,
    renderedPage?.sourcePagePath,
    promptPayload.sourcePagePath,
    promptPayload.sourceImagePath
  ];
  for (const candidate of candidates) {
    const resolved = safeExistingFile(candidate);
    if (resolved) return resolved;
  }
  return "";
}

function safeExistingFile(filePath = "") {
  const clean = cleanString(filePath);
  if (!clean) return "";
  const resolved = path.resolve(clean);
  return fsSync.existsSync(resolved) && fsSync.statSync(resolved).isFile() ? resolved : "";
}

function providerPrompt(value = "") {
  return cleanString(value || "")
    .replace(/[A-Za-z]:\\[^\s。；，,;]+/g, "the uploaded source page image")
    .replace(/Approved outline evidence:\s*the uploaded source page image\.?/gi, "Approved outline evidence: the uploaded source page image.");
}

async function writePlaceholderImage(runDir, task = {}, promptPayload = {}) {
  const filePath = path.join(runDir, `${task.pageId || "page"}.png`);
  await fs.writeFile(filePath, makeSolidPng(1280, 720, { r: 246, g: 248, b: 252, a: 255 }));
  const stat = await fs.stat(filePath);
  return {
    path: filePath,
    provider: "passthrough",
    model: "non-product-placeholder",
    size: stat.size,
    prompt: promptPayload.prompt || "",
    dryRun: true
  };
}

async function recordBatchRun(jobId, run) {
  const job = await readWorkflowJob(jobId);
  const runs = Array.isArray(job.artifacts?.codexPptSlideBatchRuns) ? job.artifacts.codexPptSlideBatchRuns : [];
  job.artifacts = {
    ...(job.artifacts || {}),
    codexPptSlideBatchRuns: [run, ...runs.filter((item) => item.id !== run.id)].slice(0, 25)
  };
  job.events = appendEvent(job.events, run.status === "complete" ? "codex-ppt.slide_batch_complete" : "codex-ppt.slide_batch_failed", `${run.id} ${run.status}`, {
    runId: run.id,
    recorded: run.recorded,
    failed: run.failed,
    nonProduct: run.nonProduct
  });
  await saveWorkflowJob(job);
}

function publicRun(run = {}) {
  return {
    id: run.id || "",
    status: run.status || "unknown",
    nonProduct: Boolean(run.nonProduct),
    requested: run.requested || 0,
    recorded: run.recorded || 0,
    failed: run.failed || 0,
    pages: run.pages || "",
    maxPages: run.maxPages || 0,
    agentPrefix: run.agentPrefix || "",
    relativeRunDir: run.relativeRunDir || "",
    startedAt: run.startedAt || "",
    finishedAt: run.finishedAt || "",
    errors: run.errors || [],
    imageDeck: run.imageDeck || null,
    imageDeckError: run.imageDeckError || "",
    editableRun: run.editableRun || null,
    editablePrepareError: run.editablePrepareError || "",
    editableWorkerTaskSummary: run.editableWorkerTaskSummary || null,
    editableWorkerPromptError: run.editableWorkerPromptError || ""
  };
}

function summarizeApprovals(job = {}) {
  const approved = new Set((Array.isArray(job.artifacts?.codexPptApprovals) ? job.artifacts.codexPptApprovals : [])
    .filter((item) => item?.status === "approved" && item.gate)
    .map((item) => item.gate));
  if (!isCodexPptFullDeckApprovalCurrent(job)) approved.delete("fullDeck");
  const missing = CODEX_PPT_VISUAL_DECK_GATES.filter((gate) => !approved.has(gate));
  return {
    required: CODEX_PPT_VISUAL_DECK_GATES,
    approved: CODEX_PPT_VISUAL_DECK_GATES.filter((gate) => approved.has(gate)),
    missing,
    ready: missing.length === 0
  };
}

function summarizeTasks(tasks = []) {
  const normalized = Array.isArray(tasks) ? tasks : [];
  return {
    total: normalized.length,
    ready: normalized.filter((task) => task.status === "ready").length,
    running: normalized.filter((task) => task.status === "running" || task.status === "claimed").length,
    recorded: normalized.filter((task) => task.status === "recorded").length,
    failed: normalized.filter((task) => task.status === "failed").length
  };
}

function parsePageSelection(value = "") {
  const raw = Array.isArray(value) ? value.join(",") : String(value || "");
  const pages = new Set();
  for (const part of raw.split(/[,\s]+/).filter(Boolean)) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Math.max(1, Number(range[1]));
      const end = Math.max(start, Number(range[2]));
      for (let page = start; page <= end; page += 1) pages.add(page);
    } else {
      const page = Number(part);
      if (Number.isInteger(page) && page >= 1) pages.add(page);
    }
  }
  return pages;
}

function makeSolidPng(width, height, color) {
  const rowBytes = width * 4 + 1;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const index = rowStart + 1 + x * 4;
      raw[index] = color.r;
      raw[index + 1] = color.g;
      raw[index + 2] = color.b;
      raw[index + 3] = color.a;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", Buffer.concat([uint32(width), uint32(height), Buffer.from([8, 6, 0, 0, 0])])),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  return Buffer.concat([uint32(data.length), typeBuffer, data, uint32(crc32(Buffer.concat([typeBuffer, data])))]);
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function makeRunId() {
  return `codex_slide_batch_${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-")}_${crypto.randomBytes(3).toString("hex")}`;
}

function appendEvent(events = [], type, message, details = {}) {
  return [...(Array.isArray(events) ? events : []), {
    id: `evt_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
    type,
    message,
    details,
    createdAt: new Date().toISOString()
  }].slice(-500);
}

function isInsidePath(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function cleanString(value = "") {
  return String(value || "").trim().slice(0, 2000);
}

function cleanToken(value = "") {
  return cleanString(value).replace(/[^a-zA-Z0-9_.:-]/g, "-").slice(0, 80);
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}
