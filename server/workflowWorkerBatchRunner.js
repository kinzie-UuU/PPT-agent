import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import { execFile, spawn } from "child_process";
import { rootDir } from "./store.js";
import { getProviderConfig, testPageSpecProvider } from "./providers.js";
import { readWorkflowJob, saveWorkflowJob } from "./workflowJobs.js";
import { getWorkflowCostEstimate } from "./workflowCostEstimate.js";
import { describeImageDeckReviewGate, finalizeWorkflowEditableRun, isImageDeckReviewApproved } from "./workflowEditable.js";
import { listWorkflowEditableWorkerTasks } from "./workflowWorkerQueue.js";
import { consumeExternalImageSpendAuthorization, getExternalImageAuthorizationStatus } from "./workflowAuthorizations.js";
import { withWorkflowJobLock } from "./workflowJobLock.js";

const RUNNER_STATUSES = new Set(["running", "complete", "failed", "cancelled", "unknown"]);
const MODEL_WORKER_DEFAULT_MAX_PAGES = 2;
const LOCAL_WORKER_DEFAULT_MAX_PAGES = 20;
const MODEL_WORKER_DEFAULT_TIMEOUT_MS = 1800000;
const LOCAL_WORKER_DEFAULT_TIMEOUT_MS = 600000;
const MODEL_PAGE_SPEC_TIMEOUT_MS = 300000;
const MODEL_PAGE_SPEC_MAX_TOKENS = 9000;
const MODEL_WORKER_DEFAULT_IMAGE_CALLS_PER_PAGE = 8;
const ACTIVE_RUNNER_CHILDREN = new Map();

export async function startWorkflowEditableWorkerBatch(jobId, options = {}) {
  return withWorkflowJobLock(`editable-batch:${jobId}`, () => startWorkflowEditableWorkerBatchUnlocked(jobId, options));
}

async function startWorkflowEditableWorkerBatchUnlocked(jobId, options = {}) {
  const mode = normalizeMode(options.mode || "model");
  const preflight = await getWorkflowEditableWorkerBatchPreflight(jobId, { ...options, mode });
  enforceEditableWorkerBatchPreflight(preflight, mode);
  const job = await readWorkflowJob(jobId);
  if (!isImageDeckReviewApproved(job.artifacts || {})) {
    const error = new Error("请先完成整套图片内容与视觉复核，再启动可编辑页面重建。");
    error.status = 409;
    error.code = "IMAGE_DECK_REVIEW_REQUIRED";
    throw error;
  }
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
    allowExperimentalLocalBatch: Boolean(
      preflight.startBody?.allowExperimentalLocalBatch
      || options.allowExperimentalLocalBatch
      || options.allowLocalTextOnlyBatch
      || options.regression
      || options.labMode
    ),
    offlineTextHintsReason: preflight.startBody?.offlineTextHintsReason || options.offlineTextHintsReason || "",
    autoFinalize: Boolean(preflight.startBody?.autoFinalize || options.autoFinalize || options.finalizeOnComplete),
    stopOnError: mode === "model" ? options.stopOnError !== false : Boolean(options.stopOnError),
    useSourceFidelityBackground: sourceFidelityBackgroundEnabled(preflight.startBody || options),
    lowComplexityPageSpec: options.disableLowComplexityPageSpec === true
      ? false
      : Boolean(
        preflight.startBody?.lowComplexityPageSpec
        || options.lowComplexityPageSpec
        || options.useLowComplexityPageSpec
      ),
    externalImageCallBudget: mode === "model"
      ? clampInteger(
        firstDefined(
          preflight.startBody?.externalImageCallBudget,
          preflight.authorization?.imageCalls,
          preflight.requiredConfirmations?.externalImageSpend?.imageCalls
        ),
        0,
        500,
        0
      )
      : 0,
    externalImageCallsPerPage: mode === "model"
      ? clampInteger(
        firstDefined(
          preflight.startBody?.externalImageCallsPerPage,
          preflight.requiredConfirmations?.externalImageSpend?.imageCallsPerPage
        ),
        0,
        50,
        MODEL_WORKER_DEFAULT_IMAGE_CALLS_PER_PAGE
      )
      : 0
  };
  const runId = makeRunnerId();
  if (preflight.requiredConfirmations?.externalImageSpend?.source === "authorization-ledger") {
    await consumeExternalImageSpendAuthorization(jobId, {
      scope: "editable-workers",
      imageCalls: preflight.requiredConfirmations.externalImageSpend.imageCalls,
      pages: preflight.selectedPageIds || [],
      pageSelection: (preflight.selectedPageIds || []).join(","),
      runId,
      consumedBy: options.requestedBy || "editable-worker-batch"
    });
  }
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
    maxPages: clampInteger(runnerOptions.maxPages, 1, 200, defaultWorkerMaxPages(mode)),
    agentPrefix: cleanToken(runnerOptions.agentPrefix || "product-page-worker"),
    command,
    confirmExternalImageSpend: mode === "model" ? Boolean(runnerOptions.confirmExternalImageSpend || runnerOptions.confirmSpend) : false,
    acceptOfflineTextHints: Boolean(runnerOptions.acceptOfflineTextHints || runnerOptions.confirmOfflineTextHints || runnerOptions.paddleOcrDeclined),
    experimentalLocalBatch: mode === "local" && Boolean(runnerOptions.allowExperimentalLocalBatch),
    nonProductDelivery: mode === "local" && Boolean(runnerOptions.allowExperimentalLocalBatch),
    useSourceFidelityBackground: Boolean(runnerOptions.useSourceFidelityBackground),
    autoFinalize: Boolean(runnerOptions.autoFinalize || runnerOptions.finalizeOnComplete),
    stopOnError: Boolean(runnerOptions.stopOnError),
    lowComplexityPageSpec: Boolean(runnerOptions.lowComplexityPageSpec),
    externalImageCallBudget: Number(runnerOptions.externalImageCallBudget || 0),
    externalImageCallsPerPage: Number(runnerOptions.externalImageCallsPerPage || 0),
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
      NODE_USE_ENV_PROXY: process.execArgv.includes("--use-env-proxy") || process.env.NODE_USE_ENV_PROXY === "1" ? "1" : "",
      PPT_TOOL_BASE_URL: options.baseUrl || process.env.PPT_TOOL_BASE_URL || `http://127.0.0.1:${process.env.PORT || 4180}`,
      PPT_TOOL_USE_SOURCE_FIDELITY_BACKGROUND: runnerOptions.useSourceFidelityBackground ? "1" : "",
      PPT_EXTERNAL_IMAGE_CALL_BUDGET: Number.isFinite(Number(runnerOptions.externalImageCallsPerPage)) ? String(runnerOptions.externalImageCallsPerPage) : process.env.PPT_EXTERNAL_IMAGE_CALL_BUDGET || "",
      PYTHONIOENCODING: "utf-8"
    }
  });
  runner.pid = child.pid || 0;
  runner.childRegisteredAt = new Date().toISOString();
  ACTIVE_RUNNER_CHILDREN.set(runId, {
    pid: runner.pid,
    startedAt,
    command,
    cwd: rootDir,
    child,
    cancelRequested: false
  });
  await recordRunner(job.id, { ...runner });
  await writeJson(metaPath, runner);

  child.once("exit", async (code) => {
    fsSync.writeSync(logFd, `\n[${new Date().toISOString()}] Worker batch exited with code ${Number(code || 0)}\n`);
    fsSync.closeSync(logFd);
    const activeChild = ACTIVE_RUNNER_CHILDREN.get(runId);
    ACTIVE_RUNNER_CHILDREN.delete(runId);
    const currentMeta = readJsonSyncIfExists(metaPath);
    if (activeChild?.cancelRequested || currentMeta?.status === "cancelled" || currentMeta?.status === "cancelling") {
      const cancelledRunner = {
        ...runner,
        ...currentMeta,
        status: "cancelled",
        exitCode: Number(code || currentMeta.exitCode || 1),
        finishedAt: currentMeta.finishedAt || new Date().toISOString()
      };
      await writeJson(metaPath, cancelledRunner).catch(() => null);
      await updateRunner(job.id, cancelledRunner).catch(() => null);
      return;
    }
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
    ACTIVE_RUNNER_CHILDREN.delete(runId);
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
  const maxPagesProvided = hasExplicitMaxPages(options);
  const maxPages = clampInteger(options.maxPages, 1, 200, defaultWorkerMaxPages(mode));
  const selectedPages = parsePageSelection(options.pages || options.page || "");
  const prompts = Array.isArray(artifacts.editableWorkerPrompts) ? artifacts.editableWorkerPrompts : [];
  const taskBundle = await listWorkflowEditableWorkerTasks(jobId, options).catch(() => null);
  const tasks = Array.isArray(taskBundle?.tasks)
    ? taskBundle.tasks
    : Array.isArray(artifacts.editableWorkerTasks) ? artifacts.editableWorkerTasks : [];
  const activeRunner = findActiveRunner(job);
  const selectedFailedTasks = tasks
    .filter((task) => task.status === "failed")
    .filter((task) => !selectedPages.size || selectedPages.has(normalizePageId(task.pageId)));
  const runnableTasks = tasks
    .filter((task) => task.status === "ready")
    .filter((task) => !selectedPages.size || selectedPages.has(normalizePageId(task.pageId)))
    .slice(0, maxPages);
  const selectedPageIds = runnableTasks.map((task) => normalizePageId(task.pageId)).filter(Boolean);
  const selectedPageNumbers = selectedPageIds
    .map((pageId) => Number(pageId.replace(/^page_0*/, "")))
    .filter((page) => Number.isInteger(page) && page > 0);
  const staleVisualPageIds = new Set((Array.isArray(artifacts.editableRun?.staleVisualPageIds)
    ? artifacts.editableRun.staleVisualPageIds
    : [])
    .map(normalizePageId)
    .filter(Boolean));
  const staleSelectedPageIds = selectedPageIds.filter((pageId) => staleVisualPageIds.has(pageId));
  const externalImageCallsPerPage = clampInteger(
    firstDefined(options.externalImageCallsPerPage, options.imageCallsPerPage, process.env.PPT_EDITABLE_IMAGE_CALLS_PER_PAGE),
    0,
    50,
    MODEL_WORKER_DEFAULT_IMAGE_CALLS_PER_PAGE
  );
  const minimumExternalImageCalls = runnableTasks.length * externalImageCallsPerPage;
  const requestedExternalImageCalls = clampInteger(firstDefined(options.externalImageCallBudget, options.imageCalls), 0, 500, minimumExternalImageCalls);
  const requiredExternalImageCalls = mode === "model"
    ? Math.max(minimumExternalImageCalls, requestedExternalImageCalls)
    : 0;
  const providers = getProviderConfig();
  const providerFailure = inspectProviderFailure(runnableTasks, providers);
  const recentProviderFailure = inspectRecentProviderFailure(job, providers);
  const cost = await getWorkflowCostEstimate(jobId).catch(() => null);
  const externalImageRequired = mode === "model" && requiredExternalImageCalls > 0;
  const textHints = getTextHintEvidence(artifacts);
  const localOcrTextHintsAccepted = Boolean(textHints.ocrReady && /ocr-local|local-ocr|rapidocr|paddleocr/i.test(textHints.backend || ""));
  const offlineTextHintsRequired = !textHints.ocrReady && textHints.backend === "builtin-ink";
  const offlineHintsAccepted = Boolean(
    options.acceptOfflineTextHints
    || options.confirmOfflineTextHints
    || options.paddleOcrDeclined
    || artifacts.editableTextHintsAcknowledgement?.accepted
    || localOcrTextHintsAccepted
  );
  const authorization = externalImageRequired
    ? getExternalImageAuthorizationStatus(job, {
      scope: "editable-workers",
      imageCalls: requiredExternalImageCalls,
      pageSelection: selectedPageIds.join(","),
      pageNumbers: selectedPageNumbers
    })
    : null;
  const allowExperimentalLocalBatch = Boolean(
    options.allowExperimentalLocalBatch
    || options.allowLocalTextOnlyBatch
    || options.regression
    || options.labMode
  );
  const localMultiPageBatch = mode === "local" && runnableTasks.length > 1;
  const externalImageConfirmed = Boolean(authorization?.persisted);
  const requestOnlyExternalImageConfirmation = Boolean(options.confirmExternalImageSpend || options.confirmSpend);
  const explicitLlmRecoveryRequired = Boolean(
    options.requireLlmProviderRecovery
    || options.requiresLlmProviderRecovery
    || options.forceLlmProviderRecovery
  );
  const pageSpecProviderProbe = inspectPersistedPageSpecProviderProbe(job, providers);
  const llmProviderRecoveryRequired = mode === "model"
    && (providerFailure.blocked || recentProviderFailure.found || explicitLlmRecoveryRequired);
  const llmProviderRecovered = Boolean(
    options.confirmLlmProviderRecovered
    || options.confirmLLMProviderRecovered
    || options.llmProviderRecovered
    || options.confirmProviderRecovered
  );
  const providerFailureRecovered = Boolean(providerFailure.blocked && llmProviderRecovered && pageSpecProviderProbe.ready);
  const blockingIssues = [];
  const warnings = [];

  if (!isImageDeckReviewApproved(artifacts)) blockingIssues.push(`${describeImageDeckReviewGate(artifacts, false)}。完成后再启动可编辑页面重建。`);
  if (!artifacts.editableRun?.path) blockingIssues.push("editppt prepare has not produced an editable run yet.");
  if (staleSelectedPageIds.length) {
    blockingIssues.push(`第 ${staleSelectedPageIds.map((pageId) => Number(pageId.replace(/^page_0*/, ""))).join("、")} 页图片已更新，请先刷新可编辑运行和该页输入，再启动重建。`);
  }
  if (activeRunner) blockingIssues.push(`Editable worker batch ${activeRunner.id} is already running.`);
  if (!prompts.length) blockingIssues.push("No editable page worker prompts are available.");
  if (!tasks.length) blockingIssues.push("No editable worker tasks are synced.");
  if (selectedPages.size && selectedFailedTasks.length) {
    blockingIssues.push(`第 ${selectedFailedTasks.map((task) => Number(normalizePageId(task.pageId).replace(/^page_0*/, ""))).join("、")} 页仍是失败状态。请先查看失败原因并重置这些页面，再启动重跑。`);
  }
  if (tasks.length && !runnableTasks.length) blockingIssues.push("No ready editable worker task matches this batch. Reset failed pages after reviewing their failure reason before retrying.");
  if (mode === "model" && !providers.llm.configured) {
    blockingIssues.push("对话模型服务商未配置，image-to-editable-ppt 模型页面任务无法生成可编辑页面规格。");
  }
  if (externalImageRequired && (!providers.image.configured || providers.image.enabled === false)) {
    blockingIssues.push("External image provider is not configured or enabled.");
  }
  if (mode === "model" && providerFailure.blocked && !providerFailureRecovered) {
    blockingIssues.push(providerFailure.message);
  }
  if (mode === "model" && providerFailureRecovered) {
    warnings.push(`${providerFailure.message} 当前页面规格模型探针已通过，并已确认恢复，允许重跑。`);
  } else if (mode === "model" && !providerFailure.blocked && recentProviderFailure.found) {
    warnings.push(recentProviderFailure.message);
  }
  if (externalImageRequired && !externalImageConfirmed) {
    warnings.push(requestOnlyExternalImageConfirmation
      ? "Persisted page-scoped external image API authorization is required before starting model page workers; request-only confirmation is ignored for product safety."
      : "External image API credit confirmation is required before starting model page workers.");
  }
  if (offlineTextHintsRequired && !offlineHintsAccepted) {
    warnings.push("Offline builtin-ink text hints must be accepted or PaddleOCR must be configured before dispatch.");
  }
  if (localMultiPageBatch && !allowExperimentalLocalBatch) {
    blockingIssues.push("Local text-only worker batch is not allowed for multi-page product delivery. Use mode=model, or pass allowExperimentalLocalBatch=true only for lab/regression verification.");
  }
  if (localMultiPageBatch && allowExperimentalLocalBatch) {
    warnings.push("Local text-only multi-page worker is experimental and cannot produce product-ready delivery.");
  }
  const modelPageWorkers = inspectModelPageWorkers(job, runnableTasks, { required: mode === "model" });
  if (mode === "model" && modelPageWorkers.missingCount) {
    blockingIssues.push(`Model page worker preflight failed on ${modelPageWorkers.missingCount} page(s): ${modelPageWorkers.missingSummary}.`);
  }
  if (mode === "model" && runnableTasks.length && !pageSpecProviderProbe.ready) {
    blockingIssues.push(pageSpecProviderProbe.message);
  }
  const lowComplexityPageSpec = mode === "model"
    && options.disableLowComplexityPageSpec !== true
    && Boolean(options.lowComplexityPageSpec || options.useLowComplexityPageSpec);
  if (lowComplexityPageSpec) {
    warnings.push("本次已显式启用低复杂度页面规格模式；将优先生成更小的 compact JSON，降低再次 524 的概率。");
  } else if (mode === "model" && recentProviderFailure.kind === "provider-timeout") {
    warnings.push("检测到历史页面规格请求超时；当前批次仍保持完整页面规格，避免复杂页面因自动降级而丢失视觉资产。");
  }

  const requiredConfirmations = {
    externalImageSpend: {
      required: externalImageRequired,
      confirmed: externalImageRequired ? externalImageConfirmed : true,
      imageCalls: requiredExternalImageCalls,
      imageCallsPerPage: externalImageCallsPerPage,
      persisted: Boolean(authorization?.persisted),
      requestConfirmed: requestOnlyExternalImageConfirmation,
      source: authorization?.persisted ? "authorization-ledger" : requestOnlyExternalImageConfirmation ? "request-confirmation-ignored" : "missing"
    },
    offlineTextHints: {
      required: offlineTextHintsRequired || localOcrTextHintsAccepted,
      confirmed: offlineHintsAccepted,
      acceptedByWorkflow: Boolean(artifacts.editableTextHintsAcknowledgement?.accepted),
      reason: localOcrTextHintsAccepted ? textHints.backend : offlineTextHintsRequired ? "builtin-ink" : textHints.backend || "not-required",
      state: localOcrTextHintsAccepted ? "ocr-ready" : offlineTextHintsRequired ? "offline-ack-required" : "not-required"
    },
    llmProviderRecovered: {
      required: llmProviderRecoveryRequired,
      confirmed: llmProviderRecoveryRequired ? llmProviderRecovered : true,
      reason: llmProviderRecoveryRequired ? recentProviderFailure.kind || "v1-acceptance-requires-provider-recovery" : "not-required",
      state: llmProviderRecoveryRequired
        ? llmProviderRecovered ? "confirmed-after-provider-recovery" : "confirmation-required-after-provider-recovery"
        : "not-required"
    },
    localTextOnlyBatch: {
      required: localMultiPageBatch,
      confirmed: localMultiPageBatch ? allowExperimentalLocalBatch : true,
      state: localMultiPageBatch
        ? allowExperimentalLocalBatch ? "experimental-lab-confirmed" : "blocked-for-product"
        : "not-required"
    }
  };
  const ready = blockingIssues.length === 0;
  const startReady = ready
    && (!requiredConfirmations.externalImageSpend.required || requiredConfirmations.externalImageSpend.confirmed)
    && (!requiredConfirmations.offlineTextHints.required || requiredConfirmations.offlineTextHints.confirmed)
    && (!requiredConfirmations.llmProviderRecovered.required || requiredConfirmations.llmProviderRecovered.confirmed);
  const batchCost = buildWorkerBatchCostSummary(cost, {
    selectedCount: runnableTasks.length,
    selectedPageIds,
    recoveryRequiredPageIds: selectedFailedTasks.map((task) => normalizePageId(task.pageId)).filter(Boolean),
    staleSelectedPageIds,
    selectedPages,
    totalTasks: tasks.length,
    externalImageCalls: requiredExternalImageCalls,
    externalImageCallsPerPage
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
    pageLimitPolicy: {
      source: maxPagesProvided ? "request" : "product-default",
      defaultMaxPages: defaultWorkerMaxPages(mode),
      productSampleFirst: mode === "model"
    },
    pages: cleanString(options.pages || ""),
    counts: {
      prompts: prompts.length,
      total: tasks.length,
      ready: tasks.filter((task) => task.status === "ready" && !isFailedWorkerTask(task)).length,
      failed: tasks.filter(isFailedWorkerTask).length,
      running: tasks.filter((task) => task.status === "running" || task.status === "claimed").length,
      recorded: tasks.filter((task) => task.status === "recorded").length
    },
    provider: publicProvider(providers.image),
    llmProvider: publicProvider(providers.llm),
    pageSpecProvider: publicPageSpecProvider(providers.llm),
    pageSpecProviderProbe,
    imageProvider: publicProvider(providers.image),
    providerFailure,
    recentProviderFailure,
    llmRecoveryPlan: buildLlmRecoveryPlan({ providerFailure, recentProviderFailure, pageSpecProviderProbe }),
    textHints,
    modelPageWorkers,
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
      confirmLlmProviderRecovered: Boolean(llmProviderRecoveryRequired && llmProviderRecovered),
      requireLlmProviderRecovery: Boolean(llmProviderRecoveryRequired),
      acceptOfflineTextHints: Boolean(offlineHintsAccepted && (offlineTextHintsRequired || localOcrTextHintsAccepted)),
      allowExperimentalLocalBatch: Boolean(localMultiPageBatch && allowExperimentalLocalBatch),
      offlineTextHintsReason: localOcrTextHintsAccepted ? `${textHints.backend || "Local OCR"} text hints are available for this workflow.` : cleanString(options.offlineTextHintsReason || ""),
      autoFinalize: Boolean(options.autoFinalize || options.finalizeOnComplete),
      externalImageCallBudget: requiredExternalImageCalls,
      externalImageCallsPerPage,
      useSourceFidelityBackground: sourceFidelityBackgroundEnabled(options),
      lowComplexityPageSpec
    },
    updatedAt: new Date().toISOString()
  };
}

function buildLlmRecoveryPlan({ providerFailure = {}, recentProviderFailure = {}, pageSpecProviderProbe = {} } = {}) {
  const active = providerFailure.blocked ? providerFailure : recentProviderFailure.found ? recentProviderFailure : null;
  if (!active) {
    return {
      required: false,
      kind: "",
      pages: [],
      title: "",
      summary: "",
      recommendedAction: "",
      steps: []
    };
  }
  const kind = active.kind || "";
  const pages = Array.isArray(active.pages) ? active.pages : [];
  const timeout = kind === "provider-timeout";
  const auth = kind === "provider-auth-failed";
  const quota = kind === "provider-quota-exhausted";
  const empty = kind === "provider-empty-response";
  return {
    required: true,
    kind,
    pages,
    providerProbeReady: Boolean(pageSpecProviderProbe.ready),
    title: timeout
      ? "页面规格模型请求超时"
      : auth
        ? "页面规格模型鉴权失败"
        : quota
          ? "页面规格模型额度不足"
          : empty
            ? "页面规格模型空响应或 JSON 不可解析"
            : "页面规格模型不可用",
    summary: active.message || "可编辑重建需要先恢复页面规格模型，再重跑页面任务。",
    recommendedAction: timeout
      ? "切换更稳定的 PAGE_SPEC_MODEL，或启用低复杂度页面规格生成后再重跑。"
      : auth
        ? "检查 PAGE_SPEC_MODEL / OPENAI_BASE_URL / API Key 后重新检测页面重建模型。"
        : quota
          ? "充值或切换对话模型服务商后重新检测页面重建模型。"
          : "切换支持图片输入、非空 JSON 输出的页面规格模型后重新检测。",
    steps: [
      timeout
        ? "先不要继续硬跑同一页，避免重复触发 HTTP 524。"
        : "先暂停页面 worker，避免继续产生无效调用。",
      "在设置中切换或修复页面重建模型；这里指的是对话/规格模型，不是 OCR，也不是 gpt-image-2。",
      "点击“检测页面重建模型”，确认图片输入、JSON 输出和非空响应都通过。",
      pages.length ? `只重跑受影响页面：${pages.join("、")}。` : "只重跑受影响页面，不污染已成功页面。"
    ]
  };
}

export async function getWorkflowPageSpecProviderProbe(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const preflight = await getWorkflowEditableWorkerBatchPreflight(jobId, {
    ...options,
    mode: "model",
    maxPages: options.maxPages || 1
  });
  const requestedPages = parsePageSelection(options.pages || options.page || "");
  const probeTaskBundle = await listWorkflowEditableWorkerTasks(jobId, options).catch(() => null);
  const allModelPages = inspectModelPageWorkers(job, Array.isArray(probeTaskBundle?.tasks) ? probeTaskBundle.tasks : [], {
    required: false
  }).pages || [];
  const probePages = [
    ...(preflight.modelPageWorkers?.pages || []),
    ...allModelPages
  ];
  const page = selectPageForProviderProbe(probePages, requestedPages);
  const sourceImage = page?.pageDir ? path.join(page.pageDir, "source.png") : "";
  const probe = await testPageSpecProvider({
    model: options.model,
    baseUrl: options.baseUrl,
    timeoutMs: options.timeoutMs || MODEL_PAGE_SPEC_TIMEOUT_MS,
    maxRetries: options.maxRetries ?? 0,
    imagePath: sourceImage,
    visionProbe: options.visionProbe !== false
  });
  const result = {
    ok: Boolean(probe.ok),
    jobId,
    pageId: page?.pageId || "",
    pageDir: page?.pageDir || "",
    sourceImage,
    provider: probe.provider,
    checks: probe.checks,
    message: probe.ok
      ? "页面重建模型检测通过：支持非空 JSON 输出，并通过当前页面图片的视觉 JSON 检测。"
      : translatePageSpecProbeMessage(probe.message || ""),
    rawMessage: probe.message || "",
    preflight: {
      selectedPageIds: preflight.selectedPageIds || [],
      startReady: Boolean(preflight.startReady),
      providerFailure: preflight.providerFailure || null,
      recentProviderFailure: preflight.recentProviderFailure || null,
      probeSource: page?.source || ""
    },
    updatedAt: new Date().toISOString()
  };
  job.artifacts = {
    ...(job.artifacts || {}),
    pageSpecProviderProbe: {
      kind: "page_spec_provider_probe",
      ok: result.ok,
      pageId: result.pageId,
      provider: result.provider,
      checks: result.checks,
      message: result.message,
      rawMessage: result.rawMessage,
      sourceImage: result.sourceImage,
      updatedAt: result.updatedAt
    }
  };
  job.events = appendEvent(job.events, result.ok ? "page_spec_provider.probe_passed" : "page_spec_provider.probe_failed", result.message, {
    pageId: result.pageId,
    provider: result.provider,
    checks: result.checks
  });
  await saveWorkflowJob(job);
  return result;
}

function selectPageForProviderProbe(pages = [], requestedPages = new Set()) {
  const seen = new Set();
  const unique = [];
  for (const page of pages) {
    const pageId = normalizePageId(page?.pageId || "");
    if (!pageId || seen.has(pageId)) continue;
    seen.add(pageId);
    unique.push({ ...page, pageId, source: page.source || "worker-task" });
  }
  const requested = requestedPages?.size
    ? unique.find((page) => requestedPages.has(page.pageId) && page.ready && page.pageDir)
      || unique.find((page) => requestedPages.has(page.pageId) && page.pageDir)
    : null;
  return requested
    || unique.find((page) => page.ready && page.pageDir)
    || unique.find((page) => page.pageDir)
    || null;
}

function inspectModelPageWorkers(job = {}, tasks = [], { required = false } = {}) {
  const jobRoot = path.resolve(job.rootDir || rootDir);
  const workflowRoot = path.dirname(jobRoot);
  const pages = tasks.map((task) => inspectModelPageWorkerTask(job, task, { workflowRoot }));
  const missingPages = pages.filter((page) => !page.ready);
  return {
    required: Boolean(required),
    ready: missingPages.length === 0,
    total: pages.length,
    readyCount: pages.filter((page) => page.ready).length,
    missingCount: missingPages.length,
    missingSummary: summarizeMissingModelPageWorkerFiles(missingPages),
    pages: pages.slice(0, 80),
    checkedFiles: ["source.png", "page_request.json", "worker-prompt.md", "worker-brief.json"]
  };
}

function inspectModelPageWorkerTask(job = {}, task = {}, { workflowRoot = "" } = {}) {
  const pageId = normalizePageId(task.pageId || task.page || "");
  const editableRunDir = job.artifacts?.editableRun?.path || "";
  const pageDirRaw = task.pageDir || (editableRunDir && pageId ? path.join(editableRunDir, "pages", pageId) : "");
  const pageDir = pageDirRaw ? path.resolve(pageDirRaw) : "";
  const promptPath = path.resolve(task.promptFile || path.join(pageDir, "worker-prompt.md"));
  const briefPath = path.resolve(workflowRoot || path.dirname(path.resolve(job.rootDir || rootDir)), job.id || "", "worker-briefs", pageId, "worker-brief.json");
  const checks = [
    fileCheck("pageDir", pageDir, "directory"),
    fileCheck("source.png", path.join(pageDir, "source.png"), "file"),
    fileCheck("page_request.json", path.join(pageDir, "page_request.json"), "file"),
    fileCheck("worker-prompt.md", promptPath, "file"),
    fileCheck("worker-brief.json", briefPath, "file")
  ];
  const missing = checks.filter((item) => !item.ok).map((item) => item.name);
  return {
    pageId,
    status: task.status || "",
    ready: missing.length === 0,
    missing,
    checks,
    pageDir,
    promptPath,
    briefPath,
    nextCommand: missing.length
      ? ""
      : `npm.cmd run lab:model-preflight -- --job-id ${job.id || "<workflow_id>"} --page ${pageId || "<page_id>"} --page-dir "${pageDir}"`
  };
}

function fileCheck(name, filePath, kind = "file") {
  const exists = Boolean(filePath && fsSync.existsSync(filePath));
  const ok = exists && (kind === "directory" ? fsSync.statSync(filePath).isDirectory() : fsSync.statSync(filePath).isFile());
  return {
    name,
    kind,
    ok,
    path: filePath || ""
  };
}

function summarizeMissingModelPageWorkerFiles(pages = []) {
  const summary = pages.slice(0, 4).map((page) => `${page.pageId || "unknown"} missing ${page.missing.join(", ")}`);
  const extra = pages.length > summary.length ? `; +${pages.length - summary.length} more` : "";
  return `${summary.join("; ")}${extra}`;
}

function buildWorkerBatchCostSummary(cost, { selectedCount = 0, selectedPageIds = [], selectedPages = new Set(), totalTasks = 0, externalImageCalls = 0, externalImageCallsPerPage = 0 } = {}) {
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
    imageCalls: externalImageCalls,
    imageCallsPerPage: externalImageCallsPerPage,
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
      backend: ocr.backend || ocr.ocrBackend?.name || "local-ocr",
      pageCount: Number(ocr.pageCount || 0) || 0,
      readyPages: Number(ocr.pageCount || 0) || 0,
      textLineCount: Number(ocr.textCount || 0) || 0,
      lowConfidenceCount: Number(ocr.lowConfidenceCount || 0) || 0,
      mojibakeCount: Number(ocr.mojibakeCount || 0) || 0,
      quality: ocr.quality || null,
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

function isFailedWorkerTask(task = {}) {
  const status = String(task.status || "");
  if (status === "ready" || status === "pending") return false;
  return task.status === "failed"
    || task.validationStatus === "failed"
    || (task.status === "recorded" && task.evidence?.validationPassed === false)
    || Boolean(task.evidence?.validationError);
}

function inspectProviderFailure(tasks = [], providers = {}) {
  const failed = tasks.filter(isFailedWorkerTask);
  const errors = failed.map((task) => [
    task.error,
    task.evidence?.validationError
  ].filter(Boolean).join(" ")).join("\n");
  const pages = failed.map((task) => normalizePageId(task.pageId)).filter(Boolean);
  const pageText = pages.length ? pages.join(",") : "";
  const failedProvider = firstProviderSnapshot(failed);
  const currentProvider = {
    llm: publicProvider(providers.llm),
    image: publicProvider(providers.image)
  };
  if (isImageProviderOverloadText(errors)) {
    return {
      blocked: true,
      kind: "image-provider-overloaded",
      pages,
      failedProvider,
      currentProvider,
      message: `失败页面${pageText ? `（${pageText}）` : ""}的 gpt-image-2 图片资产生成服务过载。请稍后只重跑受影响页面，或切换更稳定的图片服务商。`
    };
  }
  if (/额度已用尽|余额|insufficient[_\s-]?quota|quota|credit|billing/i.test(errors)) {
    return {
      blocked: true,
      kind: "provider-quota-exhausted",
      pages,
      failedProvider,
      currentProvider,
      message: `失败页面${pageText ? `（${pageText}）` : ""}的对话模型服务商额度或余额不足。请充值或切换服务商，重置失败页后再重跑可编辑页面任务。`
    };
  }
  if (/HTTP\s*401|unauthorized|invalid.*api.*key|api.*key.*invalid/i.test(errors)) {
    return {
      blocked: true,
      kind: "provider-auth-failed",
      pages,
      failedProvider,
      currentProvider,
      message: `失败页面${pageText ? `（${pageText}）` : ""}的对话模型服务商鉴权失败。请检查 API Key / Base URL，重置失败页后再重跑可编辑页面任务。`
    };
  }
  if (/operation was aborted|aborted|timeout|timed out|ETIMEDOUT|AbortError|HTTP\s*524|\b524\b|gateway timeout|cloudflare/i.test(errors)) {
    return {
      blocked: true,
      kind: "provider-timeout",
      pages,
      failedProvider,
      currentProvider,
      message: `失败页面${pageText ? `（${pageText}）` : ""}的页面重建模型请求超时或被中止。请切换更稳定的页面重建模型，或降低页面规格生成复杂度后再重跑。`
    };
  }
  if (/Model response did not contain parseable JSON|content was empty|completion_tokens["':\s]+0|finishReason["':\s]+stop/i.test(errors)) {
    return {
      blocked: true,
      kind: "provider-empty-response",
      pages,
      failedProvider,
      currentProvider,
      message: `失败页面${pageText ? `（${pageText}）` : ""}的对话模型返回空内容或不可解析 JSON。请切换支持视觉输入和 JSON 输出的对话模型，或调整模型规格生成方式后再重跑。`
    };
  }
  return {
    blocked: false,
    kind: "",
    pages: [],
    failedProvider: null,
    currentProvider,
    message: ""
  };
}

function firstProviderSnapshot(tasks = []) {
  for (const task of tasks) {
    const snapshot = task?.evidence?.providerSnapshot;
    if (snapshot && typeof snapshot === "object") return snapshot;
  }
  return null;
}

export function inspectRecentProviderFailure(job = {}, providers = {}) {
  const runs = Array.isArray(job.artifacts?.editableWorkerBatchRuns) ? job.artifacts.editableWorkerBatchRuns : [];
  const orderedRuns = [...runs].sort((a, b) => timestampOfRun(b) - timestampOfRun(a));
  const recordedPageIds = new Set((Array.isArray(job.artifacts?.editableWorkerTasks) ? job.artifacts.editableWorkerTasks : [])
    .filter((task) => task?.status === "recorded")
    .map((task) => normalizePageId(task.pageId))
    .filter(Boolean));
  const currentProvider = {
    llm: publicProvider(providers.llm),
    image: publicProvider(providers.image)
  };
  for (const run of orderedRuns) {
    const text = collectRunFailureText(run);
    const kind = classifyRecentProviderFailureText(text);
    if (!kind) continue;
    const failedPages = collectRunFailurePages(run);
    const pages = failedPages.filter((pageId) => !recordedPageIds.has(pageId));
    if (failedPages.length && !pages.length) continue;
    const pageText = pages.length ? `（${pages.join(",")}）` : "";
    const quota = kind === "provider-quota-exhausted";
    const empty = kind === "provider-empty-response";
    const timeout = kind === "provider-timeout";
    const imageOverloaded = kind === "image-provider-overloaded";
    return {
      found: true,
      kind,
      pages,
      runId: run.id || "",
      startedAt: run.startedAt || "",
      finishedAt: run.finishedAt || "",
      failedProvider: null,
      currentProvider,
      message: imageOverloaded
        ? `最近一次可编辑重建失败是图片 API 服务过载${pageText}；请稍后只重跑受影响页面，或切换更稳定的图片服务商。`
        : quota
        ? `最近一次可编辑重建失败是对话模型服务商额度或余额不足${pageText}；确认启动前请先充值或切换对话模型服务商。`
        : empty
        ? `最近一次可编辑重建失败是对话模型返回空内容或不可解析 JSON${pageText}；确认启动前请先切换支持视觉输入和 JSON 输出的对话模型，或调整模型规格生成方式。`
        : timeout
        ? `最近一次可编辑重建失败是页面重建模型请求超时或被中止${pageText}；确认启动前请先切换更稳定的页面重建模型，或降低页面规格生成复杂度。`
        : `最近一次可编辑重建失败是对话模型服务商鉴权失败${pageText}；确认启动前请先检查 API Key、Base URL 或切换对话模型服务商。`
    };
  }
  return {
    found: false,
    kind: "",
    pages: [],
    runId: "",
    startedAt: "",
    finishedAt: "",
    failedProvider: null,
    currentProvider,
    message: ""
  };
}

function classifyRecentProviderFailureText(value = "") {
  const text = String(value || "");
  if (isImageProviderOverloadText(text)) return "image-provider-overloaded";
  if (/额度已用尽|余额|insufficient[_\s-]?quota|quota|credit|billing/i.test(text)) return "provider-quota-exhausted";
  if (/HTTP\s*401|unauthorized|invalid.*api.*key|api.*key.*invalid/i.test(text)) return "provider-auth-failed";
  if (/operation was aborted|\baborted\b|\btimed out\b|\brequest timeout\b|\btimeout(?: error| exceeded| after)\b|ETIMEDOUT|AbortError|HTTP\s*524|\b524\b|gateway timeout|cloudflare/i.test(text)) return "provider-timeout";
  if (/Model response did not contain parseable JSON|content was empty|completion_tokens["':\s]+0|finishReason["':\s]+stop/i.test(text)) return "provider-empty-response";
  return "";
}

function isImageProviderOverloadText(text = "") {
  return /servers are currently overloaded|server(?:s)? overloaded|overloaded\. please try again later|try again later|image batch .*exited with code 1/i.test(String(text || ""));
}

function collectRunFailureText(run = {}) {
  const parts = [
    run.error,
    run.summary?.error,
    ...(Array.isArray(run.summary?.results) ? run.summary.results.map((item) => item?.error) : []),
    ...(Array.isArray(run.errors) ? run.errors.map((item) => item?.error || item) : []),
    readRunLogTail(run)
  ];
  return parts.filter(Boolean).join("\n");
}

function collectRunFailurePages(run = {}) {
  const pages = new Set();
  for (const item of Array.isArray(run.summary?.results) ? run.summary.results : []) {
    if (item?.ok !== false) continue;
    const pageId = normalizePageId(item.pageId);
    if (pageId) pages.add(pageId);
  }
  for (const item of Array.isArray(run.errors) ? run.errors : []) {
    const pageId = normalizePageId(item?.pageId);
    if (pageId) pages.add(pageId);
  }
  if (!pages.size) {
    for (const pageId of parseRunPages(run.pages)) {
      pages.add(pageId);
    }
  }
  return Array.from(pages).sort();
}

function parseRunPages(value = "") {
  if (Array.isArray(value)) return value.map(normalizePageId).filter(Boolean);
  return String(value || "")
    .split(/[,\s]+/)
    .map(normalizePageId)
    .filter(Boolean);
}

function timestampOfRun(run = {}) {
  return Date.parse(run.finishedAt || run.startedAt || "") || 0;
}

function readRunLogTail(run = {}) {
  const logPath = cleanString(run.logPath || "");
  if (!logPath || !fsSync.existsSync(logPath)) return "";
  try {
    const stat = fsSync.statSync(logPath);
    const maxBytes = 32000;
    const start = Math.max(0, stat.size - maxBytes);
    const handle = fsSync.openSync(logPath, "r");
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fsSync.readSync(handle, buffer, 0, buffer.length, start);
      return buffer.toString("utf8");
    } finally {
      fsSync.closeSync(handle);
    }
  } catch {
    return "";
  }
}

function enforceEditableWorkerBatchPreflight(preflight = {}, mode = "model") {
  const issues = Array.isArray(preflight.blockingIssues) ? preflight.blockingIssues : [];
  const warnings = Array.isArray(preflight.warnings) ? preflight.warnings : [];
  const reviewIssue = issues.find((issue) => /image deck review|整套图片(?:风格|内容与视觉)复核/i.test(String(issue || "")));
  if (reviewIssue) {
    const error = new Error(reviewIssue);
    error.status = 409;
    error.code = "IMAGE_DECK_REVIEW_REQUIRED";
    throw error;
  }
  const externalConfirmation = preflight.requiredConfirmations?.externalImageSpend;
  if (mode === "model" && externalConfirmation?.required && !externalConfirmation.confirmed) {
    throw new Error("A persisted page-scoped external image spend authorization is required before running image-to-editable-ppt model page workers. Editable worker batch preflight failed: authorization ledger entry is missing.");
  }
  const llmProviderRecovered = preflight.requiredConfirmations?.llmProviderRecovered;
  if (mode === "model" && llmProviderRecovered?.required && !llmProviderRecovered.confirmed) {
    throw new Error("最近一次 image-to-editable-ppt 页面重建卡在对话模型服务商额度/鉴权；重新启动前必须传入 confirmLlmProviderRecovered=true。");
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

export async function cancelWorkflowEditableWorkerRun(jobId, runId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const run = findRunner(job, runId);
  const runtime = resolveRunnerRuntimeStatus(await hydrateRunnerFromMeta(run));
  if (runtime.status !== "running") {
    return {
      ok: true,
      jobId: job.id,
      cancelled: false,
      reason: `Worker run is ${runtime.status || "not running"}.`,
      run: publicRunner(runtime, job.id)
    };
  }
  if (!runtime.pid) throw new Error("Worker run pid is missing.");
  const activeChild = ACTIVE_RUNNER_CHILDREN.get(runtime.id);
  const child = activeChild?.child || null;
  if (!activeChild || Number(activeChild.pid || 0) !== Number(runtime.pid || 0) || !child || child.exitCode !== null || child.signalCode !== null) {
    const finishedAt = new Date().toISOString();
    const staleRunner = {
      ...runtime,
      status: "unknown",
      finishedAt,
      error: "Runner is not registered in this server process; refusing to kill a possibly reused PID. Refresh state or reset the affected pages."
    };
    if (staleRunner.metaPath) {
      await writeJson(staleRunner.metaPath, staleRunner).catch(() => null);
    }
    await updateRunner(job.id, staleRunner);
    return {
      ok: false,
      jobId: job.id,
      cancelled: false,
      reason: staleRunner.error,
      run: publicRunner(staleRunner, job.id)
    };
  }
  const finishedAt = new Date().toISOString();
  const finalRunner = {
    ...runtime,
    status: "cancelled",
    exitCode: 1,
    finishedAt,
    error: cleanString(options.reason || "Worker run cancelled by user.")
  };
  activeChild.cancelRequested = true;
  if (finalRunner.metaPath) {
    await writeJson(finalRunner.metaPath, finalRunner).catch(() => null);
  }
  if (finalRunner.logPath && fsSync.existsSync(finalRunner.logPath)) {
    await fs.appendFile(finalRunner.logPath, `\n[${finishedAt}] Worker batch cancelled: ${finalRunner.error}\n`, "utf8").catch(() => null);
  }
  await killProcessTree(runtime.pid);
  await updateRunner(job.id, finalRunner);
  return {
    ok: true,
    jobId: job.id,
    cancelled: true,
    run: publicRunner(finalRunner, job.id)
  };
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
  const mode = normalizeMode(options.mode || "model");
  const args = [
    path.join(rootDir, "scripts", "page-worker-batch.mjs"),
    "--job-id",
    jobId,
    "--base-url",
    cleanString(options.baseUrl || process.env.PPT_TOOL_BASE_URL || `http://127.0.0.1:${process.env.PORT || 4180}`),
    "--agent-prefix",
    cleanToken(options.agentPrefix || "product-page-worker"),
    "--max-pages",
    String(clampInteger(options.maxPages, 1, 200, defaultWorkerMaxPages(mode))),
    "--timeout-ms",
    String(clampInteger(options.timeoutMs, 30000, 1800000, defaultWorkerTimeoutMs(mode))),
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
  const commandParts = [
    quoteCommand(process.execPath, path.join(rootDir, "scripts", "model-page-worker-pipeline.mjs")),
    "--timeout-ms",
    String(clampInteger(options.modelSpecTimeoutMs || options.specTimeoutMs, 30000, 600000, MODEL_PAGE_SPEC_TIMEOUT_MS)),
    "--max-retries",
    String(clampInteger(options.modelSpecMaxRetries ?? options.maxRetries, 0, 8, 1)),
    "--max-tokens",
    String(clampInteger(options.modelSpecMaxTokens || options.maxTokens, 256, 12000, MODEL_PAGE_SPEC_MAX_TOKENS))
  ];
  if (options.forceModelSpec || options.forceSpec || options.refreshModelSpec) commandParts.push("--force");
  if (options.lowComplexityPageSpec || options.useLowComplexityPageSpec) commandParts.push("--low-complexity-spec");
  return commandParts.join(" ");
}

function quoteCommand(...parts) {
  return parts.map((part) => `"${String(part).replace(/"/g, '\\"')}"`).join(" ");
}

function normalizeMode(value) {
  const mode = cleanToken(value || "model");
  return mode === "local" ? "local" : "model";
}

function defaultWorkerMaxPages(mode = "model") {
  return normalizeMode(mode) === "model" ? MODEL_WORKER_DEFAULT_MAX_PAGES : LOCAL_WORKER_DEFAULT_MAX_PAGES;
}

function defaultWorkerTimeoutMs(mode = "model") {
  return normalizeMode(mode) === "model" ? MODEL_WORKER_DEFAULT_TIMEOUT_MS : LOCAL_WORKER_DEFAULT_TIMEOUT_MS;
}

function hasExplicitMaxPages(options = {}) {
  return options.maxPages !== undefined && options.maxPages !== null && String(options.maxPages).trim() !== "";
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

function publicPageSpecProvider(provider = {}) {
  return {
    configured: Boolean(provider.configured),
    enabled: provider.enabled !== false,
    baseUrl: provider.baseUrl || "",
    model: provider.pageSpecModel || provider.model || "",
    source: provider.pageSpecModel && provider.pageSpecModel !== provider.model ? "PAGE_SPEC_MODEL" : "LLM_MODEL",
    concurrency: provider.concurrency || 1
  };
}

function inspectPersistedPageSpecProviderProbe(job = {}, providers = {}) {
  const current = publicPageSpecProvider(providers.llm || {});
  const probe = job.artifacts?.pageSpecProviderProbe || null;
  if (!probe) {
    return {
      required: true,
      ready: false,
      ok: false,
      stale: false,
      provider: current,
      checkedAt: "",
      message: "页面重建模型尚未完成能力检测。请先点击“检测页面重建模型”，确认它支持图片输入、JSON 输出和非空响应。"
    };
  }
  const checkedProvider = probe.provider || {};
  const modelMatches = cleanString(checkedProvider.model) === cleanString(current.model);
  const baseUrlMatches = normalizeProviderKey(checkedProvider.baseUrl) === normalizeProviderKey(current.baseUrl);
  const checks = probe.checks || {};
  const textOk = Boolean(checks.textJson?.ok);
  const visionOk = checks.visionJson === null || checks.visionJson === undefined ? false : Boolean(checks.visionJson?.ok);
  const nonEmpty = Boolean(checks.nonEmpty);
  const ready = Boolean(probe.ok && modelMatches && baseUrlMatches && textOk && visionOk && nonEmpty);
  const stale = Boolean(probe.ok && (!modelMatches || !baseUrlMatches));
  const message = ready
    ? "页面重建模型能力检测已通过。"
    : stale
      ? "页面重建模型配置已变化，请重新检测 PAGE_SPEC_MODEL / Base URL 后再启动 image-to-editable-ppt 页面 worker。"
      : probe.message || "页面重建模型能力检测未通过，请切换支持视觉输入和 JSON 输出的模型后重新检测。";
  return {
    required: true,
    ready,
    ok: Boolean(probe.ok),
    stale,
    provider: current,
    checkedProvider,
    modelMatches,
    baseUrlMatches,
    checks,
    checkedAt: probe.updatedAt || "",
    pageId: probe.pageId || "",
    message
  };
}

function normalizeProviderKey(value = "") {
  return String(value || "").trim().replace(/\/+$/, "").replace(/\/v\d+$/i, "");
}

function translatePageSpecProbeMessage(message = "") {
  const text = String(message || "");
  if (/empty content/i.test(text)) return "页面重建模型返回空内容。请切换支持视觉输入和 JSON 输出的对话模型，或调整 PAGE_SPEC_MODEL 后再重跑。";
  if (/image input|vision/i.test(text)) return "页面重建模型没有通过图片输入 + JSON 输出检测。请为 image-to-editable-ppt 配置支持视觉理解的页面重建模型。";
  if (/parseable JSON|JSON/i.test(text)) return "页面重建模型没有返回可解析 JSON。请切换模型或关闭不兼容的 response_format 路径。";
  if (/API key|Missing/i.test(text)) return "页面重建模型 API Key 未配置。";
  return text || "页面重建模型检测未通过。";
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

async function killProcessTree(pid) {
  const numericPid = Number(pid || 0);
  if (!numericPid) throw new Error("Invalid worker run pid.");
  if (process.platform === "win32") {
    await new Promise((resolve, reject) => {
      execFile("taskkill", ["/PID", String(numericPid), "/T", "/F"], { windowsHide: true }, (error) => {
        if (error && isProcessAlive(numericPid)) reject(error);
        else resolve();
      });
    });
    return;
  }
  try {
    process.kill(numericPid, "SIGTERM");
  } catch (error) {
    if (isProcessAlive(numericPid)) throw error;
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
  const sanitized = sanitizeRunner(run);
  return {
    id: runId,
    status: sanitized.status || "unknown",
    mode: sanitized.mode || "",
    pid: sanitized.pid || 0,
    pages: sanitized.pages || "",
    maxPages: sanitized.maxPages || 0,
    agentPrefix: sanitized.agentPrefix || "",
    confirmExternalImageSpend: Boolean(run.confirmExternalImageSpend),
    acceptOfflineTextHints: Boolean(run.acceptOfflineTextHints),
    experimentalLocalBatch: Boolean(run.experimentalLocalBatch),
    nonProductDelivery: Boolean(run.nonProductDelivery),
    useSourceFidelityBackground: Boolean(run.useSourceFidelityBackground),
    autoFinalize: Boolean(run.autoFinalize),
    lowComplexityPageSpec: Boolean(run.lowComplexityPageSpec),
    externalImageCallBudget: Number(run.externalImageCallBudget || 0),
    externalImageCallsPerPage: Number(run.externalImageCallsPerPage || 0),
    logPath: sanitized.logPath || "",
    relativeLogPath: sanitized.relativeLogPath || "",
    startedAt: sanitized.startedAt || "",
    finishedAt: sanitized.finishedAt || "",
    exitCode: sanitized.exitCode ?? null,
    error: sanitized.error || "",
    summary: sanitized.summary || null,
    succeeded: run.succeeded ?? null,
    failed: run.failed ?? null,
    taskSummary: sanitized.taskSummary || null,
    finalize: sanitized.finalize || null,
    failureAnalysis: buildRunnerFailureAnalysis(run),
    logHref: jobId && runId ? `/api/workflow-jobs/${encodedJob}/editable/worker-runs/${encodedRun}/log` : "",
    logDownloadHref: jobId && runId ? `/api/workflow-jobs/${encodedJob}/editable/worker-runs/${encodedRun}/log?download=1` : ""
  };
}

function buildRunnerFailureAnalysis(run = {}) {
  if (!["failed", "cancelled", "unknown"].includes(String(run.status || "")) && Number(run.failed || 0) <= 0) {
    return null;
  }
  const text = collectRunFailureText(run);
  const runnerKind = classifyRunnerFailureText(text);
  const providerKind = classifyRecentProviderFailureText(text);
  const kind = ["page-validation-failed", "visual-fidelity-failed"].includes(runnerKind)
    ? runnerKind
    : providerKind || runnerKind;
  const pages = collectRunFailurePages(run);
  const pageText = pages.length ? pages.join("、") : "未知页面";
  const base = {
    kind,
    pages,
    title: "",
    reason: "",
    recommendedAction: "",
    recoveryPlan: null,
    canRetryPages: pages.length > 0,
    retryLabel: pages.length === 1 ? `重跑 ${pages[0]}` : "重跑受影响页面"
  };
  if (kind === "image-provider-overloaded") {
    return {
      ...base,
      title: "图片 API 服务过载",
      reason: `${pageText} 的 gpt-image-2 图片资产生成失败，服务商返回 servers are currently overloaded。`,
      recommendedAction: "稍后只重跑受影响页面的图片资产生成；已成功页面不会被覆盖。若连续失败，再切换图片服务商或降低单页资产数量。",
      recoveryPlan: buildRunnerRecoveryPlan(run, {
        kind,
        pages,
        reason: `${pageText} 的 gpt-image-2 图片资产生成失败，服务商返回 servers are currently overloaded。`,
        recommendedAction: "稍后只重跑受影响页面的图片资产生成；已成功页面不会被覆盖。若连续失败，再切换图片服务商或降低单页资产数量。",
        imageProviderRetryRecommended: true,
        lowComplexityRecommended: false
      })
    };
  }
  if (kind === "provider-timeout") {
    return {
      ...base,
      title: "页面重建模型超时",
      reason: `${pageText} 的页面规格生成请求超时或被中止。`,
      recommendedAction: "先检测页面重建模型；若通过，使用低复杂度模式重跑该页。已成功页面不会被覆盖。",
      recoveryPlan: buildRunnerRecoveryPlan(run, {
        kind,
        pages,
        reason: `${pageText} 的页面规格生成请求超时或被中止。`,
        recommendedAction: "先检测页面重建模型；若通过，使用低复杂度模式重跑该页。已成功页面不会被覆盖。",
        lowComplexityRecommended: true
      })
    };
  }
  if (kind === "provider-quota-exhausted") {
    return {
      ...base,
      title: "模型额度不足",
      reason: `${pageText} 调用页面重建模型时额度或余额不足。`,
      recommendedAction: "充值或切换对话模型服务商后，重新预检并重跑受影响页面。",
      recoveryPlan: buildRunnerRecoveryPlan(run, {
        kind,
        pages,
        reason: `${pageText} 调用页面重建模型时额度或余额不足。`,
        recommendedAction: "充值或切换对话模型服务商后，重新预检并重跑受影响页面。"
      })
    };
  }
  if (kind === "provider-auth-failed") {
    return {
      ...base,
      title: "模型鉴权失败",
      reason: `${pageText} 调用页面重建模型时鉴权失败。`,
      recommendedAction: "检查 API Key、Base URL 和模型权限，再重跑受影响页面。",
      recoveryPlan: buildRunnerRecoveryPlan(run, {
        kind,
        pages,
        reason: `${pageText} 调用页面重建模型时鉴权失败。`,
        recommendedAction: "检查 API Key、Base URL 和模型权限，再重跑受影响页面。"
      })
    };
  }
  if (kind === "provider-empty-response") {
    return {
      ...base,
      title: "模型返回不可解析",
      reason: `${pageText} 的页面规格模型返回空内容或不可解析 JSON。`,
      recommendedAction: "切换支持图片输入和 JSON 输出的模型，或降低页面规格复杂度后重跑。",
      recoveryPlan: buildRunnerRecoveryPlan(run, {
        kind,
        pages,
        reason: `${pageText} 的页面规格模型返回空内容或不可解析 JSON。`,
        recommendedAction: "切换支持图片输入和 JSON 输出的模型，或降低页面规格复杂度后重跑。",
        lowComplexityRecommended: true
      })
    };
  }
  if (kind === "page-validation-failed") {
    return {
      ...base,
      title: "页面校验未通过",
      reason: `${pageText} 的页面产物没有满足 editppt 校验规则。`,
      recommendedAction: "查看日志中的具体校验项，重置页面后重跑；不要覆盖已成功页面。",
      recoveryPlan: buildRunnerRecoveryPlan(run, {
        kind,
        pages,
        reason: `${pageText} 的页面产物没有满足 editppt 校验规则。`,
        recommendedAction: "查看日志中的具体校验项，重置页面后重跑；不要覆盖已成功页面。"
      })
    };
  }
  if (kind === "visual-fidelity-failed") {
    return {
      ...base,
      title: "视觉相似度未达标",
      reason: `${pageText} 的可编辑预览没有达到产品视觉相似度门槛。`,
      recommendedAction: "保留已生成资产，重新规划并只重跑受影响页面；不要覆盖已成功页面。",
      recoveryPlan: buildRunnerRecoveryPlan(run, {
        kind,
        pages,
        reason: `${pageText} 的可编辑预览没有达到产品视觉相似度门槛。`,
        recommendedAction: "保留已生成资产，重新规划并只重跑受影响页面；不要覆盖已成功页面。",
        lowComplexityRecommended: false
      })
    };
  }
  if (kind === "asset-provenance-missing") {
    return {
      ...base,
      title: "已有图片资产缺少来源记录",
      reason: `${pageText} 已有可复用图片，但缺少可核验的生成后端或文件哈希记录。`,
      recommendedAction: "系统将先从历史重跑记录中按文件哈希恢复来源账本；只有无法核验的资产才重新生成。",
      recoveryPlan: buildRunnerRecoveryPlan(run, {
        kind,
        pages,
        reason: `${pageText} 已有可复用图片，但缺少可核验的生成后端或文件哈希记录。`,
        recommendedAction: "按文件哈希恢复资产来源账本后，只重跑受影响页面。"
      })
    };
  }
  return {
    ...base,
    title: "页面重建命令失败",
    reason: `${pageText} 的页面 worker 没有完成。`,
    recommendedAction: "打开日志查看最后错误；重置受影响页面后单页重跑。",
    recoveryPlan: buildRunnerRecoveryPlan(run, {
      kind,
      pages,
      reason: `${pageText} 的页面 worker 没有完成。`,
      recommendedAction: "打开日志查看最后错误；重置受影响页面后单页重跑。"
    })
  };
}

function buildRunnerRecoveryPlan(run = {}, analysis = {}) {
  const pages = Array.isArray(analysis.pages) ? analysis.pages.filter(Boolean) : [];
  const pageText = pages.length ? pages.join(",") : "";
  const lowComplexityRecommended = Boolean(analysis.lowComplexityRecommended || run.lowComplexityPageSpec);
  const imageProviderRetryRecommended = Boolean(analysis.imageProviderRetryRecommended);
  const autoFinalize = Boolean(run.autoFinalize);
  const preflightDetail = imageProviderRetryRecommended
    ? "先确认图片 API 服务恢复，再做重跑预检；这不是 OCR 问题，也不是成功页问题。"
    : lowComplexityRecommended
      ? "会启用低复杂度页面规格模式，降低再次超时概率。"
      : "检查模型、额度、页面证据和运行目录。";
  const retryDetail = imageProviderRetryRecommended
    ? "只重跑受影响页面的图片资产生成和可编辑重建；成功页不会被覆盖。"
    : "重跑范围固定为失败页，成功页不会被覆盖。";
  return {
    pages,
    pageSelection: pageText,
    failureKind: analysis.kind || "worker-command-failed",
    reason: analysis.reason || "页面重建没有完成。",
    recommendedAction: analysis.recommendedAction || "查看日志，重置受影响页面后只重跑这些页面。",
    preserveSuccessfulPages: true,
    lowComplexityRecommended,
    imageProviderRetryRecommended,
    autoFinalize,
    externalApiRequired: true,
    steps: [
      { id: "inspect", label: "查看失败原因", detail: "先确认失败页和日志，不处理已成功页面。" },
      { id: "reset", label: "重置失败页", detail: "只清理这些页面的失败/锁定状态，不调用外部 API。" },
      { id: "preflight", label: "重跑前预检", detail: preflightDetail },
      { id: "retry", label: imageProviderRetryRecommended ? "稍后只重跑影响页" : "只重跑影响页", detail: retryDetail },
      { id: "finalize", label: "重新合成 final", detail: autoFinalize ? "页面成功后会自动尝试合成最终 PPT。" : "页面成功后手动重新合成 editable-final.pptx。" }
    ]
  };
}

function classifyRunnerFailureText(value = "") {
  const text = String(value || "");
  if (/product visual fidelity QA|visual similarity .*below the .*threshold|structure-loss/i.test(text)) return "visual-fidelity-failed";
  if (/has no producing-backend provenance|refusing to guess provenance/i.test(text)) return "asset-provenance-missing";
  if (/validation failed|background_strategy|visual_inventory|invalid box_px|missing text|invalid points_px|source_corner_radius_px|roundRect .*must include|page validate|校验/i.test(text)) return "page-validation-failed";
  if (/Worker command exited|command failed|exited with code|Page artifacts were not recorded/i.test(text)) return "worker-command-failed";
  return "worker-command-failed";
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
    maxPages: clampInteger(run.maxPages, 1, 200, defaultWorkerMaxPages(run.mode)),
    agentPrefix: cleanToken(run.agentPrefix || "product-page-worker"),
    confirmExternalImageSpend: Boolean(run.confirmExternalImageSpend),
    acceptOfflineTextHints: Boolean(run.acceptOfflineTextHints),
    experimentalLocalBatch: Boolean(run.experimentalLocalBatch),
    nonProductDelivery: Boolean(run.nonProductDelivery),
    useSourceFidelityBackground: Boolean(run.useSourceFidelityBackground),
    autoFinalize: Boolean(run.autoFinalize),
    lowComplexityPageSpec: Boolean(run.lowComplexityPageSpec),
    externalImageCallBudget: Number(run.externalImageCallBudget || 0),
    externalImageCallsPerPage: Number(run.externalImageCallsPerPage || 0),
    command: cleanString(run.command || ""),
    args: Array.isArray(run.args) ? run.args.map(cleanString) : [],
    logPath: cleanString(run.logPath || ""),
    relativeLogPath: cleanString(run.relativeLogPath || ""),
    metaPath: cleanString(run.metaPath || ""),
    relativeMetaPath: cleanString(run.relativeMetaPath || ""),
    startedAt: cleanString(run.startedAt || ""),
    finishedAt: cleanString(run.finishedAt || ""),
    exitCode: run.exitCode ?? null,
    error: cleanPublicError(run.error || ""),
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
    error: cleanPublicError(finalize.error || "")
  };
}

function sanitizeRunnerSummary(summary = {}) {
  const results = Array.isArray(summary.results) ? summary.results.slice(0, 200).map((item) => ({
    pageId: cleanString(item.pageId || ""),
    agentId: cleanString(item.agentId || ""),
    ok: Boolean(item.ok),
    error: cleanPublicError(item.error || ""),
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

function readJsonSyncIfExists(filePath) {
  try {
    if (!filePath || !fsSync.existsSync(filePath)) return null;
    return JSON.parse(fsSync.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function cleanString(value = "") {
  return String(value || "").trim().slice(0, 2000);
}

export function cleanPublicError(value = "") {
  const text = redactSensitiveText(cleanString(value));
  if (!text) return "";
  if (/background_strategy|visual_inventory|invalid box_px|missing text|invalid points_px|validation failed/i.test(text)) {
    return "页面规格校验未通过，建议查看失败分析后单页重跑。";
  }
  if (/timeout|timed out|aborted|524|ETIMEDOUT|ECONNRESET/i.test(text)) {
    return "页面重建模型请求超时或被中止。";
  }
  if (/quota|insufficient|余额|额度|rate limit/i.test(text)) {
    return "模型额度或限流导致请求失败。";
  }
  if (/unauthori[sz]ed|forbidden|invalid api key|401|403/i.test(text)) {
    return "模型鉴权失败，请检查 API Key 或模型权限。";
  }
  if (/Worker command exited|Command failed|exited with code|Page artifacts were not recorded/i.test(text)) {
    return "页面 worker 命令未完成，页面产物没有记录。";
  }
  return "页面 worker 失败，原始错误已隐藏；请查看失败分析或受控日志。";
}

function redactSensitiveText(value = "") {
  return String(value || "")
    .replace(/sk-[a-zA-Z0-9_-]{8,}/g, "sk-***")
    .replace(/Bearer\s+[a-zA-Z0-9._~+/=-]{8,}/gi, "Bearer ***")
    .replace(/api[-_ ]?key["'\s:=]+[a-zA-Z0-9._~+/=-]{8,}/gi, "api_key=***")
    .replace(/authorization["'\s:=]+[a-zA-Z0-9._~+/=-]{8,}/gi, "authorization=***");
}

function cleanToken(value = "") {
  return cleanString(value).replace(/[^a-zA-Z0-9_.:-]/g, "-").slice(0, 80);
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function envTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function sourceFidelityBackgroundEnabled(options = {}) {
  return Boolean(options.useSourceFidelityBackground) || envTruthy(process.env.PPT_TOOL_USE_SOURCE_FIDELITY_BACKGROUND);
}
