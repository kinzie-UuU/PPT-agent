import { readWorkflowJob, saveWorkflowJob } from "./workflowJobs.js";
import { dispatchWorkflowEditablePage, listWorkflowEditableWorkerPrompts, recordWorkflowEditablePage, resetWorkflowEditablePage } from "./workflowEditable.js";
import fsSync from "fs";
import path from "path";

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

export async function syncWorkflowEditableWorkerTasks(jobId, options = {}) {
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
    const generated = Boolean(evidence.pagePptxExists || evidence.previewExists || evidence.manifestExists || evidence.pageResultExists);
    const recordCurrent = record && evidence.validationPassed && evidence.outputContractOk && !isResetAfterRecord(existing, record);
    let existingStatus = existing.status === "recorded" && !recordCurrent ? "" : existing.status;
    if (["claimed", "running"].includes(existingStatus) && !generated && !isRecentTaskActivity(existing)) {
      existingStatus = "";
    }
    const status = recordCurrent ? "recorded" : existingStatus || "ready";
    return normalizeTask({
      ...existing,
      pageId: prompt.pageId,
      promptFile: prompt.promptFile,
      pageDir: prompt.pageDir,
      relativePath: prompt.relativePath,
      status,
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
  const agentId = cleanString(options.agentId || "");
  if (!agentId) throw new Error("agentId is required");
  const taskBundle = await ensureTasks(jobId, options);
  const pageTask = findTask(taskBundle.tasks, pageId);
  if (!pageTask) throw new Error(`Worker task not found: ${pageId}`);
  if (pageTask.status === "recorded") throw new Error(`Worker task already recorded: ${pageTask.pageId}`);
  const prompt = taskBundle.prompts.find((item) => item.pageId === pageTask.pageId);
  if (!prompt) throw new Error(`Worker prompt not found: ${pageTask.pageId}`);

  const dispatched = await dispatchWorkflowEditablePage(jobId, {
    pageId: pageTask.pageId,
    agentId,
    promptFile: prompt.promptFile,
    confirmSpawned: true,
    acceptOfflineTextHints: options.acceptOfflineTextHints || options.confirmOfflineTextHints || options.paddleOcrDeclined,
    offlineTextHintsReason: options.offlineTextHintsReason || "",
    agentNickname: options.agentNickname || options.workerName || ""
  });
  const now = new Date().toISOString();
  const tasks = updateTask(dispatched, pageTask.pageId, {
    status: "running",
    agentId,
    workerName: cleanString(options.workerName || options.agentNickname || ""),
    claimedAt: pageTask.claimedAt || now,
    dispatchAt: now,
    heartbeatAt: now,
    attempts: Number(pageTask.attempts || 0) + 1,
    error: ""
  });
  dispatched.artifacts = {
    ...(dispatched.artifacts || {}),
    editableWorkerTasks: tasks
  };
  dispatched.events = appendEvent(dispatched.events, "editable.worker_task_claimed", `Worker claimed ${pageTask.pageId}`, {
    pageId: pageTask.pageId,
    agentId
  });
  const saved = await saveWorkflowJob(dispatched);
  return listWorkflowEditableWorkerTasks(saved.id, options);
}

export async function heartbeatWorkflowEditableWorkerTask(jobId, pageId, options = {}) {
  const agentId = cleanString(options.agentId || "");
  const job = await readWorkflowJob(jobId);
  const pageTask = findTask(job.artifacts?.editableWorkerTasks || [], pageId);
  if (!pageTask) throw new Error(`Worker task not found: ${pageId}`);
  if (agentId && pageTask.agentId && agentId !== pageTask.agentId) throw new Error(`Task belongs to another agent: ${pageTask.agentId}`);
  const tasks = updateTask(job, pageTask.pageId, {
    status: pageTask.status === "ready" ? "claimed" : pageTask.status,
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
  const agentId = cleanString(options.agentId || "");
  if (!agentId) throw new Error("agentId is required");
  const job = await readWorkflowJob(jobId);
  const pageTask = findTask(job.artifacts?.editableWorkerTasks || [], pageId);
  if (!pageTask) throw new Error(`Worker task not found: ${pageId}`);
  if (pageTask.agentId && pageTask.agentId !== agentId) throw new Error(`Task belongs to another agent: ${pageTask.agentId}`);
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
  const taskBundle = await ensureTasks(jobId, options);
  const pageTask = findTask(taskBundle.tasks, pageId);
  if (!pageTask) throw new Error(`Worker task not found: ${pageId}`);
  if (pageTask.status === "recorded" && !options.forceRecorded) {
    throw new Error(`Recorded task cannot be reset without force: ${pageTask.pageId}`);
  }
  let job = await readWorkflowJob(jobId);
  let editpptReset = null;
  if (pageTask.status !== "ready" || options.forceEditpptReset) {
    try {
      job = await resetWorkflowEditablePage(jobId, {
        ...options,
        pageId: pageTask.pageId,
        agentId: options.agentId || pageTask.agentId || "",
        confirmLost: Boolean(options.confirmLost || options.confirm_lost || pageTask.status === "running" || pageTask.status === "claimed")
      });
      editpptReset = { ok: true };
    } catch (error) {
      if (!options.allowQueueOnlyReset) throw error;
      editpptReset = { ok: false, error: error.message || "editppt reset failed" };
      job = await readWorkflowJob(jobId);
    }
  }
  const archivedArtifacts = options.clearGeneratedArtifacts || options.archiveGeneratedArtifacts
    ? archiveGeneratedPageArtifacts(pageTask.pageDir, { reason: options.reason || "" })
    : null;
  const tasks = updateTask(job, pageTask.pageId, {
    status: "ready",
    agentId: "",
    workerName: "",
    claimedAt: "",
    dispatchAt: "",
    heartbeatAt: "",
    recordedAt: "",
    error: "",
    message: cleanString(options.reason || "reset for retry")
  });
  job.artifacts = {
    ...(job.artifacts || {}),
    editableWorkerTasks: tasks
  };
  job.events = appendEvent(job.events, "editable.worker_task_reset", `Worker task reset ${pageTask.pageId}`, {
    pageId: pageTask.pageId,
    previousStatus: pageTask.status,
    reason: cleanString(options.reason || ""),
    editpptReset,
    archivedArtifacts
  });
  const saved = await saveWorkflowJob(job);
  return listWorkflowEditableWorkerTasks(saved.id, options);
}

function archiveGeneratedPageArtifacts(pageDir = "", options = {}) {
  const root = path.resolve(String(pageDir || ""));
  if (!root || !fsSync.existsSync(root) || !fsSync.statSync(root).isDirectory()) {
    return { ok: false, archived: 0, reason: "page directory not found" };
  }
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
    "visual-asset-jobs.json",
    "model-page-spec-prompt.json",
    "model-page-spec-response.json",
    "model-page-spec-source-preview.jpg"
  ];
  const directories = [
    "assets",
    path.join("prompts", "image-assets")
  ];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveDir = path.join(root, ".retry-archive", stamp);
  const moved = [];
  fsSync.mkdirSync(archiveDir, { recursive: true });
  for (const name of names) {
    const source = path.join(root, name);
    if (!isInsidePath(source, root) || !fsSync.existsSync(source)) continue;
    const target = path.join(archiveDir, name);
    fsSync.mkdirSync(path.dirname(target), { recursive: true });
    fsSync.renameSync(source, target);
    moved.push(name);
  }
  for (const name of directories) {
    const source = path.join(root, name);
    if (!isInsidePath(source, root) || !fsSync.existsSync(source)) continue;
    const target = path.join(archiveDir, name);
    fsSync.mkdirSync(path.dirname(target), { recursive: true });
    fsSync.renameSync(source, target);
    moved.push(name);
  }
  if (!moved.length) {
    try { fsSync.rmdirSync(archiveDir); } catch {}
  } else {
    fsSync.writeFileSync(path.join(archiveDir, "archive_reason.txt"), cleanString(options.reason || "reset for retry"), "utf8");
  }
  return {
    ok: true,
    archived: moved.length,
    archiveDir: moved.length ? archiveDir : "",
    files: moved
  };
}

function isInsidePath(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

async function ensureTasks(jobId, options = {}) {
  const current = await listWorkflowEditableWorkerTasks(jobId, options);
  if (current.tasks.length) return current;
  return syncWorkflowEditableWorkerTasks(jobId, options);
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
    error: cleanString(task.error || ""),
    message: cleanString(task.message || ""),
    createdAt: cleanString(task.createdAt || new Date().toISOString()),
    updatedAt: cleanString(task.updatedAt || task.createdAt || new Date().toISOString())
  };
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
