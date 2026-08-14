import { readWorkflowJob, saveWorkflowJob } from "./workflowJobs.js";
import { dispatchWorkflowEditablePage, listWorkflowEditableWorkerPrompts, recordWorkflowEditablePage, resetWorkflowEditablePage } from "./workflowEditable.js";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import { withWorkflowJobLock } from "./workflowJobLock.js";

const TASK_STATUSES = ["ready", "claimed", "running", "recorded", "failed"];
const REQUIRED_PAGE_RESULT = {
  page_manifest: "manifest.json",
  imagegen_jobs: "imagegen-jobs.json",
  page_pptx: "page.pptx",
  preview: "preview.png",
  contact_sheet: "split_assets_contact.png",
  validation: "validation.json",
  page_result: "page_result.json"
};
const REQUIRED_MANIFEST_KEYS = [
  "slide",
  "content_box",
  "source",
  "text_inventory",
  "visual_inventory",
  "background_strategy",
  "quality_checks",
  "text_boxes",
  "shapes",
  "images",
  "asset_provenance",
  "page_strategy"
];
const REQUIRED_QUALITY_CHECKS = [
  "font_size_calibrated",
  "visual_inventory_matched",
  "background_strategy_checked",
  "shape_corner_geometry_checked"
];
const RESET_TRANSACTION_FILE = ".ppt-agent-reset-transaction.json";

export async function syncWorkflowEditableWorkerTasks(jobId, options = {}) {
  return withWorkflowJobLock(`editable-task:${jobId}`, () => syncWorkflowEditableWorkerTasksUnlocked(jobId, options));
}

async function syncWorkflowEditableWorkerTasksUnlocked(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const promptBundle = await listWorkflowEditableWorkerPrompts(jobId, options);
  const existingTasks = Array.isArray(job.artifacts?.editableWorkerTasks) ? job.artifacts.editableWorkerTasks : [];
  const existingByPage = new Map(existingTasks.map((task) => [task.pageId, task]));
  const dispatches = Array.isArray(job.artifacts?.editableDispatches) ? job.artifacts.editableDispatches : [];
  const records = Array.isArray(job.artifacts?.editableRecords) ? job.artifacts.editableRecords : [];
  const now = new Date().toISOString();
  const tasks = promptBundle.prompts.map((prompt) => {
    const existing = existingByPage.get(prompt.pageId) || {};
    const dispatch = lastByPage(dispatches, prompt.pageId);
    const record = lastByPage(records, prompt.pageId);
    const evidence = inspectPageEvidence(prompt.pageDir);
    const recordCurrent = record && evidence.validationPassed && evidence.outputContractOk && !isResetAfterRecord(existing, record);
    const existingStatus = existing.status === "recorded" && !recordCurrent ? "" : existing.status;
    const leaseExpired = ["claimed", "running"].includes(existingStatus) && !isRecentTaskActivity(existing);
    const status = recordCurrent ? "recorded" : leaseExpired ? "failed" : existingStatus || "ready";
    return normalizeTask({
      ...existing,
      pageId: prompt.pageId,
      promptFile: prompt.promptFile,
      pageDir: prompt.pageDir,
      relativePath: prompt.relativePath,
      status,
      error: leaseExpired ? existing.error || "Worker heartbeat expired; inspect the old process and reset this page before retrying." : existing.error || "",
      message: leaseExpired ? "Worker lease expired. Manual reset is required before rerun." : existing.message || "",
      failedAt: leaseExpired ? existing.failedAt || now : existing.failedAt || "",
      failureKind: leaseExpired ? "worker-lease-expired" : existing.failureKind || "",
      agentId: recordCurrent ? existing.agentId || dispatch?.agentId || "" : existing.agentId || "",
      dispatchAt: recordCurrent ? existing.dispatchAt || dispatch?.createdAt || "" : existing.dispatchAt || "",
      recordedAt: recordCurrent ? existing.recordedAt || record?.createdAt || "" : existing.recordedAt || "",
      updatedAt: now,
      createdAt: existing.createdAt || now
    });
  });
  job.artifacts = {
    ...(job.artifacts || {}),
    editableWorkerTasks: tasks
  };
  job.events = appendEvent(job.events, "editable.worker_tasks_synced", `Synced ${tasks.length} worker task(s)`, {
    pages: tasks.map((task) => task.pageId)
  });
  const saved = await saveWorkflowJob(job);
  return toTaskBundle(saved, promptBundle, tasks);
}

export async function listWorkflowEditableWorkerTasks(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const promptBundle = await listWorkflowEditableWorkerPrompts(jobId, options);
  const existingTasks = Array.isArray(job.artifacts?.editableWorkerTasks) ? job.artifacts.editableWorkerTasks.map(normalizeTask) : [];
  const promptPages = new Set(promptBundle.prompts.map((prompt) => prompt.pageId));
  const tasks = existingTasks.filter((task) => promptPages.has(task.pageId));
  const knownPages = new Set(tasks.map((task) => task.pageId));
  for (const prompt of promptBundle.prompts) {
    if (!knownPages.has(prompt.pageId)) {
      tasks.push(normalizeTask({
        pageId: prompt.pageId,
        promptFile: prompt.promptFile,
        pageDir: prompt.pageDir,
        relativePath: prompt.relativePath,
        status: "ready"
      }));
    }
  }
  tasks.sort((a, b) => a.pageId.localeCompare(b.pageId));
  return toTaskBundle(job, promptBundle, tasks);
}

export async function claimWorkflowEditableWorkerTask(jobId, pageId, options = {}) {
  return withWorkflowJobLock(`editable-task:${jobId}`, () => claimWorkflowEditableWorkerTaskUnlocked(jobId, pageId, options));
}

async function claimWorkflowEditableWorkerTaskUnlocked(jobId, pageId, options = {}) {
  const agentId = cleanString(options.agentId || "");
  if (!agentId) throw new Error("agentId is required");
  const taskBundle = await ensureTasks(jobId, options);
  const pageTask = findTask(taskBundle.tasks, pageId);
  if (!pageTask) throw new Error(`Worker task not found: ${pageId}`);
  if (pageTask.status === "recorded") throw new Error(`Worker task already recorded: ${pageTask.pageId}`);
  if (pageTask.status !== "ready") {
    throw new Error(`Worker task is ${pageTask.status}: ${pageTask.pageId}. Reset a failed task before retrying it.`);
  }
  const prompt = taskBundle.prompts.find((item) => item.pageId === pageTask.pageId);
  if (!prompt) throw new Error(`Worker prompt not found: ${pageTask.pageId}`);
  const localMode = Boolean(options.localRebuild || options.localMode || taskBundle.next?.stage === "rebuild_page_locally");
  const attemptId = `attempt_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const leaseToken = crypto.randomBytes(18).toString("hex");

  const dispatched = await dispatchWorkflowEditablePage(jobId, {
    pageId: pageTask.pageId,
    agentId,
    promptFile: prompt.promptFile,
    confirmSpawned: true,
    acceptOfflineTextHints: options.acceptOfflineTextHints || options.confirmOfflineTextHints || options.paddleOcrDeclined,
    offlineTextHintsReason: options.offlineTextHintsReason || "",
    agentNickname: options.agentNickname || options.workerName || "",
    localRebuild: localMode
  });
  const now = new Date().toISOString();
  const tasks = updateTask(dispatched, pageTask.pageId, {
    status: "running",
    agentId,
    workerName: cleanString(options.workerName || options.agentNickname || (localMode ? "main-agent" : "")),
    claimedAt: pageTask.claimedAt || now,
    dispatchAt: now,
    heartbeatAt: now,
    attempts: Number(pageTask.attempts || 0) + 1,
    attemptId,
    leaseToken,
    error: ""
  });
  dispatched.artifacts = {
    ...(dispatched.artifacts || {}),
    editableWorkerTasks: tasks
  };
  dispatched.events = appendEvent(dispatched.events, "editable.worker_task_claimed", `Worker claimed ${pageTask.pageId}`, {
    pageId: pageTask.pageId,
    agentId,
    attemptId
  });
  const saved = await saveWorkflowJob(dispatched);
  return listWorkflowEditableWorkerTasks(saved.id, options);
}

export async function heartbeatWorkflowEditableWorkerTask(jobId, pageId, options = {}) {
  return withWorkflowJobLock(`editable-task:${jobId}`, () => heartbeatWorkflowEditableWorkerTaskUnlocked(jobId, pageId, options));
}

async function heartbeatWorkflowEditableWorkerTaskUnlocked(jobId, pageId, options = {}) {
  const agentId = cleanString(options.agentId || "");
  const job = await readWorkflowJob(jobId);
  const pageTask = findTask(job.artifacts?.editableWorkerTasks || [], pageId);
  if (!pageTask) throw new Error(`Worker task not found: ${pageId}`);
  if (agentId && pageTask.agentId && agentId !== pageTask.agentId) throw new Error(`Task belongs to another agent: ${pageTask.agentId}`);
  assertCurrentAttempt(pageTask, options);
  if (!["claimed", "running"].includes(pageTask.status)) throw new Error(`Worker task is not running: ${pageTask.pageId}`);
  const tasks = updateTask(job, pageTask.pageId, {
    status: pageTask.status,
    agentId: pageTask.agentId || agentId,
    heartbeatAt: new Date().toISOString(),
    message: cleanString(options.message || pageTask.message || "")
  });
  job.artifacts = {
    ...(job.artifacts || {}),
    editableWorkerTasks: tasks
  };
  const saved = await saveWorkflowJob(job);
  return listWorkflowEditableWorkerTasks(saved.id, options);
}

export async function completeWorkflowEditableWorkerTask(jobId, pageId, options = {}) {
  return withWorkflowJobLock(`editable-task:${jobId}`, () => completeWorkflowEditableWorkerTaskUnlocked(jobId, pageId, options));
}

async function completeWorkflowEditableWorkerTaskUnlocked(jobId, pageId, options = {}) {
  const agentId = cleanString(options.agentId || "");
  if (!agentId) throw new Error("agentId is required");
  const job = await readWorkflowJob(jobId);
  const pageTask = findTask(job.artifacts?.editableWorkerTasks || [], pageId);
  if (!pageTask) throw new Error(`Worker task not found: ${pageId}`);
  if (pageTask.agentId && pageTask.agentId !== agentId) throw new Error(`Task belongs to another agent: ${pageTask.agentId}`);
  assertCurrentAttempt(pageTask, options);
  if (!["claimed", "running"].includes(pageTask.status)) throw new Error(`Worker task is not running: ${pageTask.pageId}`);
  try {
    const evidence = inspectPageEvidence(pageTask.pageDir);
    if (evidence.validationPassed !== true || evidence.outputContractOk !== true) {
      throw new Error(`Page evidence is not recordable: ${[
        evidence.validationError,
        ...(evidence.outputContractIssues || [])
      ].filter(Boolean).slice(0, 5).join(" | ") || "validation or output contract failed"}`);
    }
    const recorded = await recordWorkflowEditablePage(jobId, {
      pageId: pageTask.pageId,
      agentId,
      pageResult: options.pageResult || ""
    });
    const tasks = updateTask(recorded, pageTask.pageId, {
      status: "recorded",
      agentId,
      heartbeatAt: new Date().toISOString(),
      recordedAt: new Date().toISOString(),
      error: "",
      message: "page artifacts recorded"
    });
    recorded.artifacts = {
      ...(recorded.artifacts || {}),
      editableWorkerTasks: tasks
    };
    recorded.events = appendEvent(recorded.events, "editable.worker_task_recorded", `Worker task recorded ${pageTask.pageId}`, {
      pageId: pageTask.pageId,
      agentId
    });
    const saved = await saveWorkflowJob(recorded);
    return listWorkflowEditableWorkerTasks(saved.id, options);
  } catch (error) {
    const failedJob = await readWorkflowJob(jobId);
    const tasks = updateTask(failedJob, pageTask.pageId, {
      status: "failed",
      agentId,
      heartbeatAt: new Date().toISOString(),
      error: error.message || "record failed"
    });
    failedJob.artifacts = {
      ...(failedJob.artifacts || {}),
      editableWorkerTasks: tasks
    };
    failedJob.events = appendEvent(failedJob.events, "editable.worker_task_failed", `Worker task failed ${pageTask.pageId}`, {
      pageId: pageTask.pageId,
      agentId,
      error: error.message || "record failed"
    });
    await saveWorkflowJob(failedJob);
    throw error;
  }
}

export async function resetWorkflowEditableWorkerTask(jobId, pageId, options = {}) {
  return withWorkflowJobLock(`editable-task:${jobId}`, () => resetWorkflowEditableWorkerTaskUnlocked(jobId, pageId, options));
}

async function resetWorkflowEditableWorkerTaskUnlocked(jobId, pageId, options = {}) {
  const taskBundle = await ensureTasks(jobId, options);
  const pageTask = findTask(taskBundle.tasks, pageId);
  if (!pageTask) throw new Error(`Worker task not found: ${pageId}`);
  const failureRelease = Boolean(options.failureRelease || options.releaseAfterFailure || options.automaticFailureRelease);
  if (failureRelease) assertCurrentAttempt(pageTask, options);
  if (["running", "claimed"].includes(pageTask.status)) {
    if (!Boolean(options.confirmLost || options.confirm_lost)) {
      const error = new Error(`Active worker must be explicitly confirmed lost before reset: ${pageTask.pageId}`);
      error.code = "EDITABLE_WORKER_CONFIRM_LOST_REQUIRED";
      throw error;
    }
    assertCurrentAttempt(pageTask, options);
  }
  if (pageTask.status === "failed" && (pageTask.attemptId || pageTask.leaseToken)) {
    if (!Boolean(options.confirmLost || options.confirm_lost)) {
      const error = new Error(`Failed worker attempt must be explicitly confirmed stopped before reset: ${pageTask.pageId}`);
      error.code = "EDITABLE_WORKER_CONFIRM_LOST_REQUIRED";
      throw error;
    }
    assertCurrentAttempt(pageTask, options);
  }
  if (pageTask.status === "recorded" && !options.forceRecorded) {
    throw new Error(`Recorded task cannot be reset without force: ${pageTask.pageId}`);
  }
  let job = await readWorkflowJob(jobId);
  let editpptReset = null;
  let resetTransaction = beginResetTransaction(pageTask, options);
  try {
    const editpptAlreadyReset = ["editppt-reset", "artifacts-archived", "state-committed", "complete"].includes(resetTransaction.stage);
    if (!editpptAlreadyReset && (pageTask.status !== "ready" || options.forceEditpptReset)) {
      job = await resetWorkflowEditablePage(jobId, {
        ...options,
        pageId: pageTask.pageId,
        agentId: options.agentId || pageTask.agentId || "",
        resetTransactionId: resetTransaction.id,
        confirmLost: Boolean(options.confirmLost || options.confirm_lost)
      });
      editpptReset = { ok: true };
      resetTransaction = advanceResetTransaction(resetTransaction, "editppt-reset", { editpptReset });
    } else {
      editpptReset = resetTransaction.editpptReset || { ok: true, skipped: true };
    }
    const failureReason = cleanString(options.failureReason || options.reason || pageTask.error || "worker execution failed");
    const shouldArchiveArtifacts = Boolean(
      options.clearGeneratedArtifacts
      || options.archiveGeneratedArtifacts
      || failureRelease
      || pageTask.status === "failed"
    );
    const archiveAlreadyComplete = ["artifacts-archived", "state-committed", "complete"].includes(resetTransaction.stage);
    const archivedArtifacts = archiveAlreadyComplete
      ? resetTransaction.archivedArtifacts || null
      : shouldArchiveArtifacts
        ? archiveGeneratedPageArtifacts(pageTask.pageDir, {
          reason: failureReason,
          transactionId: resetTransaction.id,
          preserveGeneratedAssets: options.preserveGeneratedAssets === true
        })
        : null;
    if (!archiveAlreadyComplete) resetTransaction = advanceResetTransaction(resetTransaction, "artifacts-archived", { archivedArtifacts });
    const now = new Date().toISOString();
    const failureKind = failureRelease ? classifyEditableWorkerFailure(failureReason) : cleanString(pageTask.failureKind || "");
    const tasks = updateTask(job, pageTask.pageId, {
      status: failureRelease ? "failed" : "ready",
      agentId: "",
      workerName: "",
      claimedAt: "",
      dispatchAt: "",
      heartbeatAt: "",
      recordedAt: "",
      error: failureRelease ? failureReason : "",
      message: failureRelease ? "页面执行失败，需先查看原因并重置后才能重跑。" : cleanString(options.reason || "reset for retry"),
      failedAt: failureRelease ? now : cleanString(pageTask.failedAt || ""),
      failureKind,
      failureCount: failureRelease ? Number(pageTask.failureCount || 0) + 1 : Number(pageTask.failureCount || 0),
      retryPreparedAt: failureRelease ? cleanString(pageTask.retryPreparedAt || "") : now,
      retryReason: failureRelease ? cleanString(pageTask.retryReason || "") : cleanString(options.reason || "manual reset after diagnosis"),
      attemptId: failureRelease ? cleanString(pageTask.attemptId || "") : "",
      leaseToken: failureRelease ? cleanString(pageTask.leaseToken || "") : ""
    });
    job.artifacts = {
      ...(job.artifacts || {}),
      editableWorkerTasks: tasks
    };
    job.events = appendEvent(job.events, "editable.worker_task_reset", `Worker task reset ${pageTask.pageId}`, {
      pageId: pageTask.pageId,
      previousStatus: pageTask.status,
      nextStatus: failureRelease ? "failed" : "ready",
      reason: failureReason,
      failureKind,
      editpptReset,
      archivedArtifacts,
      resetTransactionId: resetTransaction.id
    });
    const saved = await saveWorkflowJob(job);
    resetTransaction = advanceResetTransaction(resetTransaction, "state-committed", { savedJobUpdatedAt: saved.updatedAt || "" });
    advanceResetTransaction(resetTransaction, "complete", { completedAt: new Date().toISOString() });
    return listWorkflowEditableWorkerTasks(saved.id, options);
  } catch (error) {
    failResetTransaction(resetTransaction, error);
    await markResetRecoveryRequired(jobId, pageTask, resetTransaction, error).catch(() => {});
    throw error;
  }
}

async function markResetRecoveryRequired(jobId, pageTask, transaction, error) {
  const job = await readWorkflowJob(jobId);
  const current = findTask(job.artifacts?.editableWorkerTasks || [], pageTask.pageId);
  if (!current || current.status === "ready") return;
  const tasks = updateTask(job, pageTask.pageId, {
    status: "failed",
    error: error?.message || "reset transaction interrupted",
    message: "页面重置在中途被打断；再次执行重置会从已保存的检查点继续。",
    failureKind: "reset-transaction-interrupted",
    failedAt: new Date().toISOString(),
    attemptId: cleanString(pageTask.attemptId || ""),
    leaseToken: cleanString(pageTask.leaseToken || "")
  });
  job.artifacts = { ...(job.artifacts || {}), editableWorkerTasks: tasks };
  job.events = appendEvent(job.events, "editable.worker_task_reset_interrupted", `Reset interrupted ${pageTask.pageId}`, {
    pageId: pageTask.pageId,
    resetTransactionId: transaction.id,
    checkpoint: transaction.stage,
    error: error?.message || "reset transaction interrupted"
  });
  await saveWorkflowJob(job);
}

function beginResetTransaction(pageTask, options = {}) {
  const file = resetTransactionPath(pageTask.pageDir);
  const existing = readResetTransaction(file);
  const sameAttempt = existing
    && cleanString(existing.attemptId || "") === cleanString(pageTask.attemptId || "")
    && cleanString(existing.leaseToken || "") === cleanString(pageTask.leaseToken || "");
  if (existing && existing.pageId === pageTask.pageId && sameAttempt && existing.status !== "complete") {
    return { ...existing, file, resumedAt: new Date().toISOString() };
  }
  const transaction = {
    id: crypto.randomUUID(),
    pageId: pageTask.pageId,
    previousStatus: pageTask.status,
    attemptId: cleanString(pageTask.attemptId || ""),
    leaseToken: cleanString(pageTask.leaseToken || ""),
    stage: "prepared",
    status: "running",
    reason: cleanString(options.failureReason || options.reason || pageTask.error || "reset for retry"),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    file
  };
  writeResetTransaction(transaction);
  return transaction;
}

function advanceResetTransaction(transaction, stage, details = {}) {
  const next = {
    ...transaction,
    ...details,
    stage,
    status: stage === "complete" ? "complete" : "running",
    updatedAt: new Date().toISOString()
  };
  writeResetTransaction(next);
  return next;
}

function failResetTransaction(transaction, error) {
  try {
    writeResetTransaction({
      ...transaction,
      status: "failed",
      error: error?.message || "reset transaction failed",
      failedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  } catch {
    // Preserve the original reset error; the last durable checkpoint remains resumable.
  }
}

function resetTransactionPath(pageDir = "") {
  const root = path.resolve(String(pageDir || ""));
  if (!root || !fsSync.existsSync(root)) throw new Error("Reset transaction page directory not found");
  return path.join(root, RESET_TRANSACTION_FILE);
}

function readResetTransaction(file = "") {
  try {
    return JSON.parse(fsSync.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeResetTransaction(transaction = {}) {
  const file = transaction.file;
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const payload = { ...transaction };
  delete payload.file;
  try {
    fsSync.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    renameWithRetrySync(temp, file);
  } finally {
    if (fsSync.existsSync(temp)) {
      try { fsSync.unlinkSync(temp); } catch {}
    }
  }
}

function archiveGeneratedPageArtifacts(pageDir = "", options = {}) {
  const root = path.resolve(String(pageDir || ""));
  if (!root || !fsSync.existsSync(root) || !fsSync.statSync(root).isDirectory()) {
    return { ok: false, archived: 0, reason: "page directory not found" };
  }
  const preserveGeneratedAssets = options.preserveGeneratedAssets === true;
  const names = [
    "manifest.json",
    "imagegen-jobs.json",
    "page.pptx",
    "preview.png",
    "split_assets_contact.png",
    "validation.json",
    "page_result.json",
    "page-rebuild-spec.json",
    "page-spec-fallback.json",
    ...(preserveGeneratedAssets ? [] : ["visual-asset-jobs.json"]),
    "model-page-spec-prompt.json",
    "model-page-spec-response.json",
    "model-page-spec-source-preview.jpg"
  ];
  const directories = preserveGeneratedAssets
    ? []
    : ["assets", path.join("prompts", "image-assets")];
  const transactionId = cleanString(options.transactionId || new Date().toISOString().replace(/[:.]/g, "-"))
    .replace(/[^A-Za-z0-9._-]/g, "-");
  const archiveDir = path.join(root, ".retry-archive", transactionId);
  const moved = [];
  fsSync.mkdirSync(archiveDir, { recursive: true });
  try {
    for (const name of [...names, ...directories]) {
      const source = path.join(root, name);
      if (!isInsidePath(source, root) || !fsSync.existsSync(source)) continue;
      const target = path.join(archiveDir, name);
      fsSync.mkdirSync(path.dirname(target), { recursive: true });
      renameWithRetrySync(source, target);
      moved.push(name);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const name of [...moved].reverse()) {
      const source = path.join(root, name);
      const target = path.join(archiveDir, name);
      try {
        if (fsSync.existsSync(target) && !fsSync.existsSync(source)) {
          fsSync.mkdirSync(path.dirname(source), { recursive: true });
          renameWithRetrySync(target, source);
        }
      } catch (rollbackError) {
        rollbackErrors.push(`${name}: ${rollbackError.message || rollbackError}`);
      }
    }
    if (rollbackErrors.length) error.message = `${error.message}; rollback incomplete: ${rollbackErrors.join(" | ")}`;
    throw error;
  }
  const archivedEntries = listArchivedEntries(archiveDir);
  if (!archivedEntries.length) {
    try { fsSync.rmdirSync(archiveDir); } catch {}
  } else if (!fsSync.existsSync(path.join(archiveDir, "archive_reason.txt"))) {
    fsSync.writeFileSync(path.join(archiveDir, "archive_reason.txt"), cleanString(options.reason || "reset for retry"), "utf8");
  }
  return {
    ok: true,
    archived: archivedEntries.length,
    archiveDir: archivedEntries.length ? archiveDir : "",
    files: archivedEntries,
    preservedGeneratedAssets: preserveGeneratedAssets
  };
}

function listArchivedEntries(archiveDir = "") {
  if (!archiveDir || !fsSync.existsSync(archiveDir)) return [];
  return fsSync.readdirSync(archiveDir, { withFileTypes: true })
    .filter((entry) => entry.name !== "archive_reason.txt")
    .map((entry) => entry.name);
}

function renameWithRetrySync(source, target, attempts = 4) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fsSync.renameSync(source, target);
      return;
    } catch (error) {
      lastError = error;
      if (!["EBUSY", "EPERM", "EACCES"].includes(error?.code) || attempt === attempts - 1) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60 * (attempt + 1));
    }
  }
  throw lastError;
}

function isInsidePath(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

async function ensureTasks(jobId, options = {}) {
  const current = await listWorkflowEditableWorkerTasks(jobId, options);
  if (current.tasks.length) return current;
  return syncWorkflowEditableWorkerTasksUnlocked(jobId, options);
}

function toTaskBundle(job, promptBundle, tasks) {
  return {
    ok: true,
    jobId: job.id,
    runDir: promptBundle.runDir,
    next: promptBundle.next,
    status: promptBundle.status,
    prompts: promptBundle.prompts,
    tasks: tasks.map(enrichTaskEvidence),
    summary: {
      total: tasks.length,
      ready: tasks.filter((task) => task.status === "ready").length,
      running: tasks.filter((task) => task.status === "claimed" || task.status === "running").length,
      recorded: tasks.filter((task) => task.status === "recorded").length,
      failed: tasks.filter((task) => task.status === "failed").length
    }
  };
}

function updateTask(job, pageId, patch) {
  const now = new Date().toISOString();
  const page = normalizePageId(pageId);
  const tasks = Array.isArray(job.artifacts?.editableWorkerTasks) ? job.artifacts.editableWorkerTasks.map(normalizeTask) : [];
  const index = tasks.findIndex((task) => task.pageId === page);
  const existing = index >= 0 ? tasks[index] : { pageId: page, createdAt: now };
  const next = normalizeTask({
    ...existing,
    ...patch,
    pageId: page,
    updatedAt: now
  });
  if (index >= 0) tasks[index] = next;
  else tasks.push(next);
  return tasks.sort((a, b) => a.pageId.localeCompare(b.pageId));
}

function normalizeTask(task = {}) {
  const status = TASK_STATUSES.includes(task.status) ? task.status : "ready";
  return {
    pageId: normalizePageId(task.pageId || task.page || ""),
    status,
    promptFile: cleanString(task.promptFile || ""),
    pageDir: cleanString(task.pageDir || ""),
    relativePath: cleanString(task.relativePath || ""),
    agentId: cleanString(task.agentId || ""),
    workerName: cleanString(task.workerName || ""),
    attempts: Number.isFinite(Number(task.attempts)) ? Number(task.attempts) : 0,
    claimedAt: cleanString(task.claimedAt || ""),
    dispatchAt: cleanString(task.dispatchAt || ""),
    heartbeatAt: cleanString(task.heartbeatAt || ""),
    recordedAt: cleanString(task.recordedAt || ""),
    attemptId: cleanString(task.attemptId || ""),
    leaseToken: cleanString(task.leaseToken || ""),
    error: cleanString(task.error || ""),
    message: cleanString(task.message || ""),
    failedAt: cleanString(task.failedAt || ""),
    failureKind: cleanString(task.failureKind || ""),
    failureCount: Number.isFinite(Number(task.failureCount)) ? Number(task.failureCount) : 0,
    retryPreparedAt: cleanString(task.retryPreparedAt || ""),
    retryReason: cleanString(task.retryReason || ""),
    createdAt: cleanString(task.createdAt || new Date().toISOString()),
    updatedAt: cleanString(task.updatedAt || task.createdAt || new Date().toISOString())
  };
}

function classifyEditableWorkerFailure(value = "") {
  const text = String(value || "");
  if (/visual similarity|visual fidelity|preview-structure-loss|视觉.*(?:差异|匹配)/i.test(text)) return "visual-fidelity-failed";
  if (/Output already exists|already exists.*overwrite/i.test(text)) return "stale-generated-artifacts";
  if (/timeout|timed out|HTTP 524/i.test(text)) return "provider-timeout";
  if (/quota|credit|billing|insufficient/i.test(text)) return "provider-quota-exhausted";
  if (/401|403|authentication|unauthorized|API key/i.test(text)) return "provider-auth-failed";
  if (/parsed JSON|parseable JSON|JSON.*(?:invalid|parse)/i.test(text)) return "page-spec-json-invalid";
  if (/required assets are missing|needed_visual_asset_jobs/i.test(text)) return "required-assets-missing";
  if (/validation|recordable|contract/i.test(text)) return "page-validation-failed";
  return "worker-execution-failed";
}

function assertCurrentAttempt(task = {}, options = {}) {
  const attemptId = cleanString(options.attemptId || options.attempt_id || "");
  const leaseToken = cleanString(options.leaseToken || options.lease_token || "");
  if (!task.attemptId || !task.leaseToken) {
    throw new Error(`Worker task has no active attempt lease: ${task.pageId}`);
  }
  if (attemptId !== task.attemptId || leaseToken !== task.leaseToken) {
    const error = new Error(`Worker attempt is stale for ${task.pageId}. Refresh the task before sending heartbeat or completion.`);
    error.code = "EDITABLE_WORKER_ATTEMPT_STALE";
    throw error;
  }
}

function enrichTaskEvidence(task = {}) {
  const normalized = normalizeTask(task);
  const evidence = inspectPageEvidence(normalized.pageDir);
  const validationStatus = evidence.validationExists
    ? evidence.validationPassed && evidence.outputContractOk
      ? "passed"
      : "failed"
    : "missing";
  const generated = Boolean(evidence.pagePptxExists || evidence.previewExists || evidence.manifestExists || evidence.pageResultExists);
  return {
    ...normalized,
    generated,
    validationStatus,
    statusLabel: normalized.status === "recorded" && validationStatus === "passed"
      ? "校验通过"
      : normalized.status === "failed" || validationStatus === "failed"
        ? "校验失败"
        : generated
          ? "已生成"
          : workerStatusLabel(normalized.status),
    evidence
  };
}

function inspectPageEvidence(pageDir = "") {
  const result = {
    pagePptxExists: false,
    previewExists: false,
    manifestExists: false,
    validationExists: false,
    pageResultExists: false,
    validationPassed: false,
    validationError: "",
    providerSnapshot: null,
    outputContractOk: false,
    outputContractIssues: []
  };
  if (!pageDir || !fsSync.existsSync(pageDir)) return result;
  result.pagePptxExists = fsSync.existsSync(path.join(pageDir, "page.pptx"));
  result.previewExists = fsSync.existsSync(path.join(pageDir, "preview.png"));
  result.manifestExists = fsSync.existsSync(path.join(pageDir, "manifest.json"));
  result.validationExists = fsSync.existsSync(path.join(pageDir, "validation.json"));
  result.pageResultExists = fsSync.existsSync(path.join(pageDir, "page_result.json"));
  if (result.validationExists) {
    try {
      const validation = JSON.parse(fsSync.readFileSync(path.join(pageDir, "validation.json"), "utf8"));
      result.validationPassed = validation.passed === true;
      result.validationError = validation.reason || validation.error || "";
      result.providerSnapshot = validation.provider_snapshot || validation.providerSnapshot || null;
    } catch (error) {
      result.validationError = error.message || "validation read failed";
    }
  }
  result.outputContractIssues = inspectPageOutputContract(pageDir);
  result.outputContractOk = result.outputContractIssues.length === 0;
  if (!result.validationError && result.outputContractIssues.length) {
    result.validationError = result.outputContractIssues.slice(0, 3).join(" | ");
  }
  return result;
}

function inspectPageOutputContract(pageDir = "") {
  const issues = [];
  const validation = readJsonIfExists(path.join(pageDir, "validation.json"));
  if (validation && validation.passed !== true) issues.push("validation.json missing top-level passed=true");

  const pageResult = readJsonIfExists(path.join(pageDir, "page_result.json"));
  if (pageResult) {
    for (const [key, expected] of Object.entries(REQUIRED_PAGE_RESULT)) {
      if (pageResult[key] !== expected) issues.push(`page_result.${key} must be ${expected}`);
      if (!fsSync.existsSync(path.join(pageDir, expected))) issues.push(`page_result target missing: ${expected}`);
    }
  } else if (fsSync.existsSync(path.join(pageDir, "page_result.json"))) {
    issues.push("page_result.json is not readable JSON");
  }

  const manifest = readJsonIfExists(path.join(pageDir, "manifest.json"));
  if (manifest) {
    for (const key of REQUIRED_MANIFEST_KEYS) {
      if (!(key in manifest)) issues.push(`manifest missing ${key}`);
    }
    for (const key of REQUIRED_QUALITY_CHECKS) {
      if (manifest.quality_checks?.[key] !== true) issues.push(`manifest quality_checks.${key} must be true`);
    }
    if (!manifest.background_strategy?.mode) issues.push("manifest background_strategy.mode missing");
    if (!manifest.background_strategy?.source_consistency_contract) issues.push("manifest background_strategy.source_consistency_contract missing");
    if (!manifest.background_strategy?.comparison_note) issues.push("manifest background_strategy.comparison_note missing");
    for (const item of Array.isArray(manifest.text_boxes) ? manifest.text_boxes : []) {
      if (!isValidBox(item?.box_px)) issues.push(`manifest text box ${item?.id || item?.text || ""} missing box_px`);
    }
    for (const item of Array.isArray(manifest.images) ? manifest.images : []) {
      if (!isValidBox(item?.box_px)) issues.push(`manifest image ${item?.id || item?.path || ""} missing box_px`);
    }
    for (const item of Array.isArray(manifest.shapes) ? manifest.shapes : []) {
      if (item?.type === "line") {
        if (!Array.isArray(item.points_px) || item.points_px.length !== 4) issues.push(`manifest line ${item?.id || ""} missing points_px`);
      } else if (!isValidBox(item?.box_px)) {
        issues.push(`manifest shape ${item?.id || ""} missing box_px`);
      }
    }
  } else if (fsSync.existsSync(path.join(pageDir, "manifest.json"))) {
    issues.push("manifest.json is not readable JSON");
  }
  return [...new Set(issues)].slice(0, 30);
}

function readJsonIfExists(filePath) {
  if (!fsSync.existsSync(filePath)) return null;
  try {
    return JSON.parse(fsSync.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function isValidBox(value) {
  return Array.isArray(value) && value.length === 4 && value.every((item) => Number.isFinite(Number(item))) && Number(value[2]) > 0 && Number(value[3]) > 0;
}

function workerStatusLabel(status = "") {
  if (status === "ready") return "待运行";
  if (status === "claimed") return "已领取";
  if (status === "running") return "运行中";
  if (status === "recorded") return "已记录";
  if (status === "failed") return "失败";
  return "未知";
}

function findTask(tasks = [], pageId = "") {
  const normalized = normalizePageId(pageId);
  return tasks.map(normalizeTask).find((task) => task.pageId === normalized) || null;
}

function lastByPage(items = [], pageId = "") {
  const normalized = normalizePageId(pageId);
  return [...items].reverse().find((item) => normalizePageId(item.pageId) === normalized) || null;
}

function isResetAfterRecord(task = {}, record = {}) {
  if (!record?.createdAt || !task?.updatedAt) return false;
  const taskStatus = normalizeTask(task).status;
  if (taskStatus === "recorded") return false;
  const taskTime = Date.parse(task.updatedAt);
  const recordTime = Date.parse(record.createdAt);
  return Number.isFinite(taskTime) && Number.isFinite(recordTime) && taskTime > recordTime;
}

function isRecentTaskActivity(task = {}, maxAgeMs = 15 * 60 * 1000) {
  const value = task.heartbeatAt || task.claimedAt || task.dispatchAt || "";
  const time = Date.parse(value);
  return Number.isFinite(time) && Date.now() - time < maxAgeMs;
}

function normalizePageId(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d+$/.test(raw)) return `page_${String(Number(raw)).padStart(3, "0")}`;
  return /^page_\d{3}$/i.test(raw) ? raw.toLowerCase() : "";
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
