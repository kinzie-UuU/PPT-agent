import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";
import { rootDir } from "./store.js";
import { getProviderConfig } from "./providers.js";
import { readWorkflowJob, saveWorkflowJob } from "./workflowJobs.js";
import { getWorkflowCostEstimate } from "./workflowCostEstimate.js";
import { finalizeWorkflowEditableRun } from "./workflowEditable.js";
import { getExternalImageAuthorizationStatus } from "./workflowAuthorizations.js";

const RUNNER_STATUSES = new Set(["running", "complete", "failed", "unknown"]);

export async function startWorkflowEditableWorkerBatch(jobId, options = {}) {
  const mode = normalizeMode(options.mode || "model");
  const preflight = await getWorkflowEditableWorkerBatchPreflight(jobId, { ...options, mode });
  enforceEditableWorkerBatchPreflight(preflight, mode);
  const job = await readWorkflowJob(jobId);
  const activeRunner = findActiveRunner(job);
  if (activeRunner) {
    throw new Error(`Editable worker batch ${activeRunner.id} is already running. Wait for it to finish or inspect its log before starting another batch.`);
  }
  const runnerOptions = {
    ...options,
    mode,
    maxPages: preflight.startBody?.maxPages || options.maxPages,
    pages: preflight.startBody?.pages || options.pages || "",
    agentPrefix: preflight.startBody?.agentPrefix || options.agentPrefix || "product-page-worker",
    confirmExternalImageSpend: mode === "model"
      ? Boolean(preflight.startBody?.confirmExternalImageSpend || options.confirmExternalImageSpend || options.confirmSpend)
      : false,
    acceptOfflineTextHints: Boolean(
      preflight.startBody?.acceptOfflineTextHints
      || options.acceptOfflineTextHints
      || options.confirmOfflineTextHints
      || options.paddleOcrDeclined
    ),
    offlineTextHintsReason: preflight.startBody?.offlineTextHintsReason || options.offlineTextHintsReason || "",
    autoFinalize: Boolean(preflight.startBody?.autoFinalize || options.autoFinalize || options.finalizeOnComplete)
  };
  const runId = makeRunnerId();
  const logsDir = path.join(job.dirs.logs, "worker-runs");
  await fs.mkdir(logsDir, { recursive: true });
  const logPath = path.join(logsDir, `${runId}.log`);
  const metaPath = path.join(logsDir, `${runId}.json`);
  const command = buildWorkerCommand(mode, runnerOptions);
  const args = buildBatchArgs({ jobId, command, options: runnerOptions });
  const startedAt = new Date().toISOString();
  const runner = {
    id: runId,
    kind: "editable_worker_batch",
    status: "running",
    mode,
    pid: 0,
    pages: cleanString(runnerOptions.pages || ""),
    maxPages: clampInteger(runnerOptions.maxPages, 1, 200, 20),
    agentPrefix: cleanToken(runnerOptions.agentPrefix || "product-page-worker"),
    command,
    confirmExternalImageSpend: mode === "model" ? Boolean(runnerOptions.confirmExternalImageSpend || runnerOptions.confirmSpend) : false,
    acceptOfflineTextHints: Boolean(runnerOptions.acceptOfflineTextHints || runnerOptions.confirmOfflineTextHints || runnerOptions.paddleOcrDeclined),
    autoFinalize: Boolean(runnerOptions.autoFinalize || runnerOptions.finalizeOnComplete),
    args,
    logPath,
    relativeLogPath: path.relative(rootDir, logPath),
    metaPath,
    relativeMetaPath: path.relative(rootDir, metaPath),
    startedAt,
    finishedAt: "",
    exitCode: null,
    error: ""
  };
  await writeJson(metaPath, runner);

  const logFd = fsSync.openSync(logPath, "a");
  fsSync.writeSync(logFd, `[${startedAt}] Starting editable worker batch ${runId}\n`);
  fsSync.writeSync(logFd, `mode=${mode}\ncommand=${command}\nargs=${args.join(" ")}\n\n`);
  const child = spawn(process.execPath, args, {
    cwd: rootDir,
    windowsHide: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      PPT_TOOL_BASE_URL: options.baseUrl || process.env.PPT_TOOL_BASE_URL || `http://127.0.0.1:${process.env.PORT || 4180}`,
      PYTHONIOENCODING: "utf-8"
    }
  });
  runner.pid = child.pid || 0;
  await recordRunner(job.id, { ...runner });
  await writeJson(metaPath, runner);

  child.once("exit", async (code) => {
    fsSync.writeSync(logFd, `\n[${new Date().toISOString()}] Worker batch exited with code ${Number(code || 0)}\n`);
    fsSync.closeSync(logFd);
    const summary = await readRunnerSummary(logPath).catch(() => null);
    let finalize = null;
    if (Number(code || 0) === 0 && runner.autoFinalize && isAllTasksRecorded(summary?.taskSummary)) {
      finalize = await autoFinalizeEditableRun(job.id).catch((error) => ({
        ok: false,
        error: error.message || "auto finalize failed"
      }));
    }
    const finalRunner = {
      ...runner,
      status: Number(code || 0) === 0 && finalize?.ok === false ? "failed" : Number(code || 0) === 0 ? "complete" : "failed",
      exitCode: Number(code || 0),
      finishedAt: new Date().toISOString(),
      summary,
      succeeded: summary?.succeeded ?? null,
      failed: summary?.failed ?? null,
      taskSummary: summary?.taskSummary || null,
      finalize
    };
    await writeJson(metaPath, finalRunner).catch(() => null);
    await updateRunner(job.id, finalRunner).catch(() => null);
  });
  child.once("error", async (error) => {
    fsSync.writeSync(logFd, `\n[${new Date().toISOString()}] Worker batch failed to start: ${error.message || error}\n`);
    fsSync.closeSync(logFd);
    const finalRunner = {
      ...runner,
      status: "failed",
      exitCode: 1,
      finishedAt: new Date().toISOString(),
      error: error.message || String(error)
    };
    await writeJson(metaPath, finalRunner).catch(() => null);
    await updateRunner(job.id, finalRunner).catch(() => null);
  });

  return {
    ok: true,
    jobId: job.id,
    run: publicRunner(runner, job.id),
    runs: await listWorkflowEditableWorkerRuns(job.id)
  };
}

export async function getWorkflowEditableWorkerBatchPreflight(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const artifacts = job.artifacts || {};
  const mode = normalizeMode(options.mode || "model");
  const maxPages = clampInteger(options.maxPages, 1, 200, 20);
  const selectedPages = parsePageSelection(options.pages || options.page || "");
  const prompts = Array.isArray(artifacts.editableWorkerPrompts) ? artifacts.editableWorkerPrompts : [];
  const tasks = Array.isArray(artifacts.editableWorkerTasks) ? artifacts.editableWorkerTasks : [];
  const activeRunner = findActiveRunner(job);
  const runnableTasks = tasks
    .filter((task) => task.status === "ready" || task.status === "failed")
    .filter((task) => !selectedPages.size || selectedPages.has(normalizePageId(task.pageId)))
    .slice(0, maxPages);
  const providers = getProviderConfig();
  const cost = await getWorkflowCostEstimate(jobId).catch(() => null);
  const externalImageRequired = mode === "model";
  const textHints = getTextHintEvidence(artifacts);
  const rapidOcrTextHintsAccepted = Boolean(textHints.ocrReady && textHints.backend === "rapidocr-local");
  const offlineTextHintsRequired = !textHints.ocrReady && textHints.backend === "builtin-ink";
  const offlineHintsAccepted = Boolean(
    options.acceptOfflineTextHints
    || options.confirmOfflineTextHints
    || options.paddleOcrDeclined
    || artifacts.editableTextHintsAcknowledgement?.accepted
    || rapidOcrTextHintsAccepted
  );
  const authorization = externalImageRequired
    ? getExternalImageAuthorizationStatus(job, { scope: "editable-workers", imageCalls: runnableTasks.length })
    : null;
  const externalImageConfirmed = Boolean(
    options.confirmExternalImageSpend
    || options.confirmSpend
    || authorization?.persisted
  );
  const blockingIssues = [];
  const warnings = [];

  if (!artifacts.editableRun?.path) blockingIssues.push("editppt prepare has not produced an editable run yet.");
  if (activeRunner) blockingIssues.push(`Editable worker batch ${activeRunner.id} is already running.`);
  if (!prompts.length) blockingIssues.push("No editable page worker prompts are available.");
  if (!tasks.length) blockingIssues.push("No editable worker tasks are synced.");
  if (tasks.length && !runnableTasks.length) blockingIssues.push("No ready or failed editable worker task matches this batch.");
  if (externalImageRequired && (!providers.image.configured || providers.image.enabled === false)) {
    blockingIssues.push("External image provider is not configured or enabled.");
  }
  if (externalImageRequired && !externalImageConfirmed) {
    warnings.push("External image API credit confirmation is required before starting model page workers.");
  }
  if (offlineTextHintsRequired && !offlineHintsAccepted) {
    warnings.push("Offline builtin-ink text hints must be accepted or PaddleOCR must be configured before dispatch.");
  }

  const requiredConfirmations = {
    externalImageSpend: {
      required: externalImageRequired,
      confirmed: externalImageRequired ? externalImageConfirmed : true,
      persisted: Boolean(authorization?.persisted),
      source: authorization?.persisted ? "authorization-ledger" : externalImageConfirmed ? "request-confirmation" : "missing"
    },
    offlineTextHints: {
      required: offlineTextHintsRequired || rapidOcrTextHintsAccepted,
      confirmed: offlineHintsAccepted,
      acceptedByWorkflow: Boolean(artifacts.editableTextHintsAcknowledgement?.accepted),
      reason: rapidOcrTextHintsAccepted ? "rapidocr-local" : offlineTextHintsRequired ? "builtin-ink" : textHints.backend || "not-required",
      state: rapidOcrTextHintsAccepted ? "ocr-ready" : offlineTextHintsRequired ? "offline-ack-required" : "not-required"
    }
  };
  const ready = blockingIssues.length === 0;
  const startReady = ready
    && (!requiredConfirmations.externalImageSpend.required || requiredConfirmations.externalImageSpend.confirmed)
    && (!requiredConfirmations.offlineTextHints.required || requiredConfirmations.offlineTextHints.confirmed);
  const selectedPageIds = runnableTasks.map((task) => normalizePageId(task.pageId)).filter(Boolean);
  const batchCost = buildWorkerBatchCostSummary(cost, {
    selectedCount: runnableTasks.length,
    selectedPageIds,
    selectedPages,
    totalTasks: tasks.length
  });
  return {
    ok: true,
    jobId: job.id,
    ready,
    startReady,
    mode,
    selectedCount: runnableTasks.length,
    selectedPageIds,
    maxPages,
    pages: cleanString(options.pages || ""),
    counts: {
      prompts: prompts.length,
      total: tasks.length,
      ready: tasks.filter((task) => task.status === "ready").length,
      failed: tasks.filter((task) => task.status === "failed").length,
      running: tasks.filter((task) => task.status === "running" || task.status === "claimed").length,
      recorded: tasks.filter((task) => task.status === "recorded").length
    },
    provider: publicProvider(providers.image),
    textHints,
    cost: batchCost,
    authorization,
    requiredConfirmations,
    activeRunner: activeRunner ? publicRunner(activeRunner, job.id) : null,
    blockingIssues,
    warnings,
    startBody: {
      mode,
      maxPages: runnableTasks.length || maxPages,
      pages: selectedPageIds.join(","),
      agentPrefix: cleanToken(options.agentPrefix || "product-page-worker"),
      confirmExternalImageSpend: externalImageRequired ? externalImageConfirmed : false,
      acceptOfflineTextHints: Boolean(offlineHintsAccepted && (offlineTextHintsRequired || rapidOcrTextHintsAccepted)),
      offlineTextHintsReason: rapidOcrTextHintsAccepted ? "RapidOCR local text hints are available for this workflow." : cleanString(options.offlineTextHintsReason || ""),
      autoFinalize: Boolean(options.autoFinalize || options.finalizeOnComplete)
    },
    updatedAt: new Date().toISOString()
  };
}

function buildWorkerBatchCostSummary(cost, { selectedCount = 0, selectedPageIds = [], selectedPages = new Set(), totalTasks = 0 } = {}) {
  if (!cost) return null;
  const sourceEditablePages = cost.operations?.editablePages || {};
  const editablePrice = findCostItemUnit(cost.costItems, "editable-page-rebuild");
  const selectedTotal = selectedPages?.size ? selectedPages.size : selectedCount;
  const knownTotalUsd = editablePrice === null ? 0 : roundMoney(editablePrice * selectedCount);
  const unknownCostItems = editablePrice === null && selectedCount > 0 ? ["editable-page-rebuild"] : [];
  return {
    knownTotalUsd,
    unknownCostItems,
    editablePages: {
      ...sourceEditablePages,
      remaining: selectedCount,
      totalExpected: selectedTotal || selectedCount || 0,
      selected: selectedCount,
      selectedPageIds,
      sourceRemaining: sourceEditablePages.remaining ?? null,
      sourceTotalExpected: sourceEditablePages.totalExpected ?? null,
      scope: selectedPages?.size ? "selected-pages" : "runnable-worker-pages",
      totalTasks
    },
    duration: scaleDuration(cost.duration, selectedCount, Number(sourceEditablePages.remaining || sourceEditablePages.totalExpected || 0)),
    sourceEstimate: {
      knownTotalUsd: cost.knownTotalUsd,
      unknownCostItems: cost.unknownCostItems || [],
      editablePages: sourceEditablePages
    }
  };
}

function getTextHintEvidence(artifacts = {}) {
  const ocr = artifacts.ocrTextHints || {};
  const editable = artifacts.editableHints || {};
  const editableSummary = editable.summary || editable.textHints || {};
  const ocrReady = Boolean(ocr.path && fsSync.existsSync(ocr.path));
  const editableReadyPages = Number(editableSummary.readyPages || 0) || 0;
  const editablePageCount = Number(editableSummary.pageCount || 0) || 0;
  if (ocrReady) {
    return {
      source: "ocrTextHints",
      ocrReady: true,
      backend: "rapidocr-local",
      pageCount: Number(ocr.pageCount || 0) || 0,
      readyPages: Number(ocr.pageCount || 0) || 0,
      textLineCount: Number(ocr.textCount || 0) || 0,
      lowConfidenceCount: Number(ocr.lowConfidenceCount || 0) || 0,
      path: ocr.relativePath || ocr.path || ""
    };
  }
  return {
    source: editable.path ? "editableHints" : "",
    ocrReady: false,
    backend: editableSummary.backend || "",
    pageCount: editablePageCount,
    readyPages: editableReadyPages,
    textLineCount: Number(editableSummary.textLineCount || 0) || 0,
    lowConfidenceCount: 0,
    path: editable.relativePath || editable.path || ""
  };
}

function findCostItemUnit(items = [], id = "") {
  const item = Array.isArray(items) ? items.find((candidate) => candidate?.id === id) : null;
  if (!item || item.known === false) return null;
  const unit = Number(item.unitUsd);
  return Number.isFinite(unit) ? unit : null;
}

function scaleDuration(duration = null, selectedCount = 0, sourceCount = 0) {
  if (!duration || typeof duration !== "object" || !sourceCount || !selectedCount) return duration;
  const ratio = Math.min(1, Math.max(0, selectedCount / sourceCount));
  return {
    ...duration,
    estimatedMinutesLow: Math.max(1, Math.round(Number(duration.estimatedMinutesLow || 0) * ratio)),
    estimatedMinutesHigh: Math.max(1, Math.round(Number(duration.estimatedMinutesHigh || 0) * ratio)),
    sourceScope: duration.scope || "full-workflow",
    scope: "worker-batch"
  };
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 10000) / 10000;
}

function enforceEditableWorkerBatchPreflight(preflight = {}, mode = "model") {
  const issues = Array.isArray(preflight.blockingIssues) ? preflight.blockingIssues : [];
  const warnings = Array.isArray(preflight.warnings) ? preflight.warnings : [];
  const externalConfirmation = preflight.requiredConfirmations?.externalImageSpend;
  if (mode === "model" && externalConfirmation?.required && !externalConfirmation.confirmed) {
    throw new Error("confirmExternalImageSpend=true is required before running image-to-editable-ppt model page workers. Editable worker batch preflight failed: external image API credit confirmation is missing.");
  }
  if (!preflight.ready || !preflight.startReady) {
    const reasons = [...issues, ...warnings].filter(Boolean);
    throw new Error(`Editable worker batch preflight failed: ${reasons.join(" ") || "not start-ready"}`);
  }
}

export async function listWorkflowEditableWorkerRuns(jobId) {
  const job = await readWorkflowJob(jobId);
  const runs = Array.isArray(job.artifacts?.editableWorkerBatchRuns) ? job.artifacts.editableWorkerBatchRuns : [];
  const hydratedRuns = await Promise.all(runs.map((run) => hydrateRunnerFromMeta(run)));
  return {
    ok: true,
    jobId: job.id,
    runs: hydratedRuns.map((run) => publicRunner(resolveRunnerRuntimeStatus(run), job.id)).sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")))
  };
}

export async function getWorkflowEditableWorkerRunLog(jobId, runId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const run = findRunner(job, runId);
  const logPath = resolveRunnerLogPath(job, run);
  const download = Boolean(options.download);
  const tailBytes = clampInteger(options.tailBytes || options.tail || 12000, 1024, 1024 * 1024, 12000);
  const stat = await fs.stat(logPath);
  const start = download ? 0 : Math.max(0, stat.size - tailBytes);
  const handle = await fs.open(logPath, "r");
  try {
    const buffer = Buffer.alloc(stat.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return {
      ok: true,
      jobId: job.id,
      run: publicRunner(resolveRunnerRuntimeStatus(run), job.id),
      path: logPath,
      fileName: path.basename(logPath),
      size: stat.size,
      truncated: start > 0,
      content: buffer.toString("utf8")
    };
  } finally {
    await handle.close();
  }
}

async function recordRunner(jobId, runner) {
  const job = await readWorkflowJob(jobId);
  const runs = Array.isArray(job.artifacts?.editableWorkerBatchRuns) ? job.artifacts.editableWorkerBatchRuns : [];
  job.artifacts = {
    ...(job.artifacts || {}),
    editableWorkerBatchRuns: upsertRun(runs, runner)
  };
  job.events = appendEvent(job.events, "editable.worker_batch_started", `Started editable worker batch ${runner.id}`, {
    runId: runner.id,
    pid: runner.pid,
    mode: runner.mode,
    maxPages: runner.maxPages,
    pages: runner.pages
  });
  return saveWorkflowJob(job);
}

async function updateRunner(jobId, runner) {
  const job = await readWorkflowJob(jobId);
  const runs = Array.isArray(job.artifacts?.editableWorkerBatchRuns) ? job.artifacts.editableWorkerBatchRuns : [];
  job.artifacts = {
    ...(job.artifacts || {}),
    editableWorkerBatchRuns: upsertRun(runs, runner)
  };
  job.events = appendEvent(job.events, runner.status === "complete" ? "editable.worker_batch_complete" : "editable.worker_batch_failed", `${runner.id} ${runner.status}`, {
    runId: runner.id,
    pid: runner.pid,
    exitCode: runner.exitCode,
    mode: runner.mode,
    succeeded: runner.succeeded ?? null,
    failed: runner.failed ?? null,
    taskSummary: runner.taskSummary || null,
    finalize: runner.finalize || null
  });
  return saveWorkflowJob(job);
}

async function autoFinalizeEditableRun(jobId) {
  const finalized = await finalizeWorkflowEditableRun(jobId, { requestedBy: "editable-worker-batch-auto-finalize" });
  return {
    ok: true,
    finalPath: finalized.artifacts?.editableFinal?.path || "",
    validationPath: finalized.artifacts?.editableFinal?.validation?.path || "",
    editable: finalized.artifacts?.editableFinal?.pptxEditability?.editable ?? null
  };
}

async function readRunnerSummary(logPath) {
  const content = await fs.readFile(logPath, "utf8");
  const parsed = parseLastJsonObject(content);
  if (!parsed || parsed.jobId === undefined || parsed.requested === undefined) return null;
  return sanitizeRunnerSummary(parsed);
}

function buildBatchArgs({ jobId, command, options }) {
  const args = [
    path.join(rootDir, "scripts", "page-worker-batch.mjs"),
    "--job-id",
    jobId,
    "--base-url",
    cleanString(options.baseUrl || process.env.PPT_TOOL_BASE_URL || `http://127.0.0.1:${process.env.PORT || 4180}`),
    "--agent-prefix",
    cleanToken(options.agentPrefix || "product-page-worker"),
    "--max-pages",
    String(clampInteger(options.maxPages, 1, 200, 20)),
    "--timeout-ms",
    String(clampInteger(options.timeoutMs, 30000, 1800000, 600000)),
    "--command",
    command
  ];
  const pages = cleanString(options.pages || "");
  if (pages) args.push("--pages", pages);
  if (options.acceptOfflineTextHints || options.confirmOfflineTextHints || options.paddleOcrDeclined) {
    args.push("--accept-offline-text-hints", "--offline-text-hints-reason", cleanString(options.offlineTextHintsReason || "RapidOCR local text hints accepted for this workflow"));
  }
  if (options.stopOnError) args.push("--stop-on-error");
  return args;
}

function isAllTasksRecorded(summary = null) {
  const total = Number(summary?.total || 0);
  const recorded = Number(summary?.recorded || 0);
  return total > 0 && recorded >= total;
}

function buildWorkerCommand(mode, options = {}) {
  if (options.command) return cleanString(options.command);
  if (mode === "local") return quoteCommand(process.execPath, path.join(rootDir, "scripts", "local-page-worker.mjs"));
  return quoteCommand(process.execPath, path.join(rootDir, "scripts", "model-page-worker-pipeline.mjs"));
}

function quoteCommand(...parts) {
  return parts.map((part) => `"${String(part).replace(/"/g, '\\"')}"`).join(" ");
}

function normalizeMode(value) {
  const mode = cleanToken(value || "model");
  return mode === "local" ? "local" : "model";
}

function parsePageSelection(value = "") {
  const raw = Array.isArray(value) ? value.join(",") : String(value || "");
  const pages = new Set();
  for (const part of raw.split(/[,\s]+/).filter(Boolean)) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Math.max(1, Number(range[1]));
      const end = Math.max(start, Number(range[2]));
      for (let page = start; page <= end; page += 1) pages.add(formatPageId(page));
      continue;
    }
    const normalized = normalizePageId(part);
    if (normalized) pages.add(normalized);
  }
  return pages;
}

function normalizePageId(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d+$/.test(raw)) return formatPageId(Number(raw));
  return /^page_\d{3}$/i.test(raw) ? raw.toLowerCase() : "";
}

function formatPageId(page) {
  return `page_${String(Number(page)).padStart(3, "0")}`;
}

function publicProvider(provider = {}) {
  return {
    configured: Boolean(provider.configured),
    enabled: provider.enabled !== false,
    baseUrl: provider.baseUrl || "",
    model: provider.model || "",
    concurrency: provider.concurrency || 1
  };
}

function makeRunnerId() {
  return `editable_worker_batch_${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-")}_${crypto.randomBytes(3).toString("hex")}`;
}

function resolveRunnerRuntimeStatus(run = {}) {
  const status = RUNNER_STATUSES.has(run.status) ? run.status : "unknown";
  if (status !== "running") return { ...run, status };
  if (!run.pid || isProcessAlive(run.pid)) return run;
  return { ...run, status: "unknown", error: run.error || "Runner process is no longer visible to the server." };
}

async function hydrateRunnerFromMeta(run = {}) {
  const metaPath = cleanString(run.metaPath || "");
  if (!metaPath || !fsSync.existsSync(metaPath)) return run;
  try {
    const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
    if (!meta || typeof meta !== "object" || meta.id !== run.id) return run;
    const metaStatus = RUNNER_STATUSES.has(meta.status) ? meta.status : "";
    if (metaStatus && metaStatus !== "running") return { ...run, ...meta };
    if (run.status === "running" && meta.finishedAt) return { ...run, ...meta };
  } catch {
    return run;
  }
  return run;
}

function findActiveRunner(job = {}) {
  const runs = Array.isArray(job.artifacts?.editableWorkerBatchRuns) ? job.artifacts.editableWorkerBatchRuns : [];
  return runs
    .map(resolveRunnerRuntimeStatus)
    .find((run) => run.status === "running") || null;
}

function isProcessAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function upsertRun(runs, runner) {
  const next = runs.filter((run) => run.id !== runner.id);
  return [sanitizeRunner(runner), ...next].slice(0, 25);
}

function publicRunner(run = {}, jobId = "") {
  const runId = run.id || "";
  const encodedJob = encodeURIComponent(jobId);
  const encodedRun = encodeURIComponent(runId);
  return {
    id: runId,
    status: run.status || "unknown",
    mode: run.mode || "",
    pid: run.pid || 0,
    pages: run.pages || "",
    maxPages: run.maxPages || 0,
    agentPrefix: run.agentPrefix || "",
    confirmExternalImageSpend: Boolean(run.confirmExternalImageSpend),
    acceptOfflineTextHints: Boolean(run.acceptOfflineTextHints),
    autoFinalize: Boolean(run.autoFinalize),
    logPath: run.logPath || "",
    relativeLogPath: run.relativeLogPath || "",
    startedAt: run.startedAt || "",
    finishedAt: run.finishedAt || "",
    exitCode: run.exitCode ?? null,
    error: run.error || "",
    summary: run.summary || null,
    succeeded: run.succeeded ?? null,
    failed: run.failed ?? null,
    taskSummary: run.taskSummary || null,
    finalize: run.finalize || null,
    logHref: jobId && runId ? `/api/workflow-jobs/${encodedJob}/editable/worker-runs/${encodedRun}/log` : "",
    logDownloadHref: jobId && runId ? `/api/workflow-jobs/${encodedJob}/editable/worker-runs/${encodedRun}/log?download=1` : ""
  };
}

function findRunner(job, runId) {
  const cleanRunId = cleanToken(runId);
  const runs = Array.isArray(job.artifacts?.editableWorkerBatchRuns) ? job.artifacts.editableWorkerBatchRuns : [];
  const run = runs.find((item) => item.id === cleanRunId);
  if (!run) throw new Error("Worker run not found");
  return run;
}

function resolveRunnerLogPath(job, run) {
  const logPath = path.resolve(run.logPath || "");
  const jobRoot = path.resolve(job.rootDir);
  const relative = path.relative(jobRoot, logPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Worker run log is outside workflow job root");
  }
  if (!fsSync.existsSync(logPath) || !fsSync.statSync(logPath).isFile()) {
    throw new Error("Worker run log file not found");
  }
  return logPath;
}

function sanitizeRunner(run = {}) {
  return {
    id: cleanToken(run.id),
    kind: "editable_worker_batch",
    status: RUNNER_STATUSES.has(run.status) ? run.status : "unknown",
    mode: normalizeMode(run.mode),
    pid: Number(run.pid || 0),
    pages: cleanString(run.pages || ""),
    maxPages: clampInteger(run.maxPages, 1, 200, 20),
    agentPrefix: cleanToken(run.agentPrefix || "product-page-worker"),
    confirmExternalImageSpend: Boolean(run.confirmExternalImageSpend),
    acceptOfflineTextHints: Boolean(run.acceptOfflineTextHints),
    autoFinalize: Boolean(run.autoFinalize),
    command: cleanString(run.command || ""),
    args: Array.isArray(run.args) ? run.args.map(cleanString) : [],
    logPath: cleanString(run.logPath || ""),
    relativeLogPath: cleanString(run.relativeLogPath || ""),
    metaPath: cleanString(run.metaPath || ""),
    relativeMetaPath: cleanString(run.relativeMetaPath || ""),
    startedAt: cleanString(run.startedAt || ""),
    finishedAt: cleanString(run.finishedAt || ""),
    exitCode: run.exitCode ?? null,
    error: cleanString(run.error || ""),
    summary: run.summary ? sanitizeRunnerSummary(run.summary) : null,
    succeeded: run.succeeded ?? null,
    failed: run.failed ?? null,
    taskSummary: sanitizeTaskSummary(run.taskSummary || run.summary?.taskSummary || null),
    finalize: sanitizeFinalize(run.finalize || null)
  };
}

function sanitizeFinalize(finalize = null) {
  if (!finalize || typeof finalize !== "object") return null;
  return {
    ok: Boolean(finalize.ok),
    finalPath: cleanString(finalize.finalPath || ""),
    validationPath: cleanString(finalize.validationPath || ""),
    editable: finalize.editable ?? null,
    error: cleanString(finalize.error || "")
  };
}

function sanitizeRunnerSummary(summary = {}) {
  const results = Array.isArray(summary.results) ? summary.results.slice(0, 200).map((item) => ({
    pageId: cleanString(item.pageId || ""),
    agentId: cleanString(item.agentId || ""),
    ok: Boolean(item.ok),
    error: cleanString(item.error || ""),
    startedAt: cleanString(item.startedAt || ""),
    finishedAt: cleanString(item.finishedAt || "")
  })) : [];
  return {
    ok: Boolean(summary.ok),
    jobId: cleanString(summary.jobId || ""),
    requested: Number(summary.requested || 0),
    succeeded: Number(summary.succeeded || 0),
    failed: Number(summary.failed || 0),
    taskSummary: sanitizeTaskSummary(summary.taskSummary || null),
    results
  };
}

function sanitizeTaskSummary(summary = null) {
  if (!summary || typeof summary !== "object") return null;
  return {
    total: Number(summary.total || 0),
    ready: Number(summary.ready || 0),
    running: Number(summary.running || 0),
    recorded: Number(summary.recorded || 0),
    failed: Number(summary.failed || 0)
  };
}

function parseLastJsonObject(content = "") {
  const text = String(content || "");
  const starts = [];
  const pattern = /\{\s*"ok"\s*:/g;
  let match = pattern.exec(text);
  while (match) {
    starts.push(match.index);
    match = pattern.exec(text);
  }
  for (const start of starts.reverse()) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === "\"") inString = false;
        continue;
      }
      if (char === "\"") {
        inString = true;
        continue;
      }
      if (char === "{") {
        depth += 1;
        continue;
      }
      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = text.slice(start, index + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
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

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
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
