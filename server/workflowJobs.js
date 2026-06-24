import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import { rootDir } from "./store.js";

export const workflowRootDir = path.join(rootDir, "workspace", "jobs");

export const WORKFLOW_STAGE_ORDER = [
  "created",
  "source_ready",
  "source_rendered",
  "visual_sample_ready",
  "visual_generating",
  "image_deck_ready",
  "ocr_ready",
  "editable_prepared",
  "pages_running",
  "finalizing",
  "complete"
];

export const WORKFLOW_STAGE_STATUS = ["pending", "running", "complete", "failed", "skipped"];
export const WORKFLOW_PAGE_STATUS = ["pending", "running", "recorded", "failed", "retrying"];

const WORKFLOW_DIRS = [
  "input",
  "source",
  "rendered-pages",
  "visual-images",
  "image-deck",
  "ocr",
  "editable-run",
  "final",
  "logs"
];

export async function ensureWorkflowRoot() {
  await fs.mkdir(workflowRootDir, { recursive: true });
}

export async function createWorkflowJob(input = {}) {
  await ensureWorkflowRoot();
  const now = new Date();
  const id = makeWorkflowId(now);
  const jobRoot = path.join(workflowRootDir, id);
  const dirs = makeWorkflowDirs(jobRoot);
  await fs.mkdir(jobRoot, { recursive: true });
  await Promise.all(Object.values(dirs).map((dir) => fs.mkdir(dir, { recursive: true })));

  const sourceArtifact = input.sourceUpload?.path
    ? await copySourceToJobInput(input.sourceUpload, dirs.input)
    : await writeBriefSourceToJobInput(input, dirs.input);
  const stages = makeInitialStages(now, Boolean(sourceArtifact));
  const events = [
    makeWorkflowEvent("job.created", "Workflow job created", {
      hasSource: Boolean(sourceArtifact),
      sourceOriginalName: input.sourceUpload?.originalName || input.sourceOriginalName || ""
    })
  ];
  if (sourceArtifact) {
    events.push(makeWorkflowEvent("source.ready", "Source file attached to workflow job", { path: sourceArtifact.path }));
  }

  const job = {
    version: 1,
    id,
    kind: "ppt-rebuild-workflow",
    internal: Boolean(input.internal),
    status: sourceArtifact ? "source_ready" : "created",
    currentStage: sourceArtifact ? "source_ready" : "created",
    stageStatus: "complete",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    rootDir: jobRoot,
    dirs,
    input: {
      sourceUploadId: input.sourceUpload?.id || input.sourceUploadId || "",
      sourceOriginalName: input.sourceUpload?.originalName || input.sourceOriginalName || "",
      sourceMimeType: input.sourceUpload?.mimeType || input.sourceMimeType || "",
      sourceSize: input.sourceUpload?.size || input.sourceSize || 0,
      sourceKind: sourceArtifact?.kind || "",
      sourceBrief: cleanString(input.sourceBrief || ""),
      mode: cleanString(input.mode || "ppt-rebuild"),
      notes: cleanString(input.notes || ""),
      internal: Boolean(input.internal)
    },
    artifacts: sourceArtifact ? { source: sourceArtifact } : {},
    stages,
    pages: [],
    events,
    errors: [],
    constraints: {
      asciiRuntimePath: true,
      noOriginalOverwrite: true,
      resumableState: true,
      perPageRetry: true
    }
  };

  await writeWorkflowState(job);
  await writeWorkflowManifest(job);
  return job;
}

export async function listWorkflowJobs() {
  await ensureWorkflowRoot();
  const entries = await fs.readdir(workflowRootDir, { withFileTypes: true }).catch(() => []);
  const jobs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const job = await readWorkflowJob(entry.name).catch(() => null);
    if (job) jobs.push(job);
  }
  return jobs.sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
}

export async function previewWorkflowJobCleanup(options = {}) {
  const allJobs = await listWorkflowJobs();
  const candidates = allJobs
    .map((job) => toWorkflowCleanupCandidate(job, options))
    .filter(Boolean)
    .slice(0, getCleanupLimit(options));
  return buildWorkflowCleanupSummary(candidates, allJobs);
}

export async function archiveWorkflowJobCleanup(options = {}) {
  const preview = await previewWorkflowJobCleanup(options);
  const archivedJobs = [];
  for (const candidate of preview.candidates) {
    const job = await archiveWorkflowJob(candidate.id, {
      archivedBy: cleanString(options.archivedBy || "cleanup"),
      reason: cleanString(options.reason || `cleanup: ${candidate.reasons.join(", ")}`)
    });
    archivedJobs.push(job);
  }
  return {
    ...preview,
    archivedCount: archivedJobs.length,
    archivedIds: archivedJobs.map((job) => job.id)
  };
}

export async function archiveWorkflowJob(id, options = {}) {
  const job = await readWorkflowJob(id);
  const now = new Date().toISOString();
  job.lifecycle = {
    ...(job.lifecycle || {}),
    archivedAt: now,
    archivedBy: cleanString(options.archivedBy || "operator"),
    archiveReason: cleanString(options.reason || "workflow archived")
  };
  job.events = appendEvent(job.events, makeWorkflowEvent("workflow.archived", "Workflow archived", {
    archivedBy: job.lifecycle.archivedBy,
    reason: job.lifecycle.archiveReason
  }));
  job.updatedAt = now;
  await writeWorkflowState(job);
  await writeWorkflowManifest(job);
  return normalizeWorkflowJob(job);
}

export async function restoreWorkflowJob(id, options = {}) {
  const job = await readWorkflowJob(id);
  const now = new Date().toISOString();
  job.lifecycle = {
    ...(job.lifecycle || {}),
    archivedAt: "",
    restoredAt: now,
    restoredBy: cleanString(options.restoredBy || "operator"),
    restoreReason: cleanString(options.reason || "workflow restored")
  };
  job.events = appendEvent(job.events, makeWorkflowEvent("workflow.restored", "Workflow restored", {
    restoredBy: job.lifecycle.restoredBy,
    reason: job.lifecycle.restoreReason
  }));
  job.updatedAt = now;
  await writeWorkflowState(job);
  await writeWorkflowManifest(job);
  return normalizeWorkflowJob(job);
}

export async function readWorkflowJob(id) {
  assertWorkflowId(id);
  const statePath = getStatePath(id);
  const raw = await fs.readFile(statePath, "utf8");
  return normalizeWorkflowJob(JSON.parse(raw));
}

export async function saveWorkflowJob(job) {
  const normalized = normalizeWorkflowJob(job);
  normalized.updatedAt = new Date().toISOString();
  await writeWorkflowState(normalized);
  await writeWorkflowManifest(normalized);
  return normalized;
}

export async function updateWorkflowStage(id, { stage, status, message = "", details = {} } = {}) {
  const job = await readWorkflowJob(id);
  assertStage(stage);
  assertStageStatus(status);
  const now = new Date().toISOString();
  job.stages[stage] = {
    ...(job.stages[stage] || {}),
    id: stage,
    status,
    message: cleanString(message),
    details: sanitizeJson(details),
    updatedAt: now,
    ...(status === "running" ? { startedAt: job.stages[stage]?.startedAt || now } : {}),
    ...(status === "complete" || status === "failed" ? { finishedAt: now } : {})
  };
  job.currentStage = stage;
  job.stageStatus = status;
  job.status = status === "failed" ? "failed" : stage;
  job.updatedAt = now;
  if (status === "failed") {
    job.errors = [...(job.errors || []), { stage, message: cleanString(message), details: sanitizeJson(details), createdAt: now }].slice(-50);
  }
  job.events = appendEvent(job.events, makeWorkflowEvent(`stage.${status}`, cleanString(message) || `${stage} ${status}`, { stage, details }));
  await writeWorkflowState(job);
  await writeWorkflowManifest(job);
  return job;
}

export async function updateWorkflowPage(id, { pageNumber, status, message = "", details = {} } = {}) {
  const job = await readWorkflowJob(id);
  const page = Number(pageNumber);
  if (!Number.isInteger(page) || page < 1) throw new Error("pageNumber must be a positive integer");
  assertPageStatus(status);
  const now = new Date().toISOString();
  const pageId = `page_${String(page).padStart(3, "0")}`;
  const pages = Array.isArray(job.pages) ? [...job.pages] : [];
  const index = pages.findIndex((item) => item.pageNumber === page);
  const record = {
    ...(index >= 0 ? pages[index] : {}),
    pageId,
    pageNumber: page,
    status,
    message: cleanString(message),
    details: sanitizeJson(details),
    updatedAt: now
  };
  if (index >= 0) pages[index] = record;
  else pages.push(record);
  pages.sort((a, b) => a.pageNumber - b.pageNumber);
  job.pages = pages;
  job.updatedAt = now;
  job.events = appendEvent(job.events, makeWorkflowEvent(`page.${status}`, cleanString(message) || `${pageId} ${status}`, { pageId, pageNumber: page, details }));
  await writeWorkflowState(job);
  await writeWorkflowManifest(job);
  return job;
}

export async function appendWorkflowEvent(id, { type = "workflow.note", message = "", details = {} } = {}) {
  const job = await readWorkflowJob(id);
  job.events = appendEvent(job.events, makeWorkflowEvent(cleanString(type) || "workflow.note", cleanString(message), sanitizeJson(details)));
  job.updatedAt = new Date().toISOString();
  await writeWorkflowState(job);
  await writeWorkflowManifest(job);
  return job;
}

function makeInitialStages(now, hasSource) {
  const iso = now.toISOString();
  return Object.fromEntries(WORKFLOW_STAGE_ORDER.map((stage) => {
    const status = stage === "created" || (hasSource && stage === "source_ready") ? "complete" : "pending";
    return [stage, {
      id: stage,
      status,
      message: status === "complete" ? `${stage} complete` : "",
      updatedAt: iso,
      ...(status === "complete" ? { startedAt: iso, finishedAt: iso } : {})
    }];
  }));
}

async function copySourceToJobInput(sourceUpload, inputDir) {
  if (!sourceUpload?.path) return null;
  const sourcePath = path.resolve(sourceUpload.path);
  if (!fsSync.existsSync(sourcePath)) return null;
  const ext = path.extname(sourceUpload.originalName || sourceUpload.path || "") || path.extname(sourcePath) || ".bin";
  const targetPath = path.join(inputDir, `source${safeExtension(ext)}`);
  await fs.copyFile(sourcePath, targetPath);
  const stat = await fs.stat(targetPath);
  return {
    kind: "source",
    originalName: sourceUpload.originalName || path.basename(sourcePath),
    uploadId: sourceUpload.id || "",
    path: targetPath,
    relativePath: path.relative(rootDir, targetPath),
    size: stat.size,
    sha256: await hashFile(targetPath),
    createdAt: new Date().toISOString()
  };
}

async function writeBriefSourceToJobInput(input = {}, inputDir) {
  const sourceBrief = String(input.sourceBrief || "").trim();
  if (!sourceBrief) return null;
  const targetPath = path.join(inputDir, "source.md");
  const markdown = [
    "# PPT Brief Source",
    "",
    sourceBrief,
    "",
    input.notes ? "## Notes" : "",
    input.notes ? cleanString(input.notes) : ""
  ].filter((line) => line !== "").join("\n");
  await fs.writeFile(targetPath, markdown, "utf8");
  const stat = await fs.stat(targetPath);
  return {
    kind: "brief_source",
    originalName: input.sourceOriginalName || "brief-source.md",
    uploadId: "",
    path: targetPath,
    relativePath: path.relative(rootDir, targetPath),
    size: stat.size,
    sha256: await hashFile(targetPath),
    createdAt: new Date().toISOString()
  };
}

function makeWorkflowDirs(jobRoot) {
  return Object.fromEntries(WORKFLOW_DIRS.map((name) => [camelDirName(name), path.join(jobRoot, name)]));
}

function camelDirName(name) {
  return name.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function makeWorkflowId(date) {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  return `workflow_${stamp}_${crypto.randomBytes(3).toString("hex")}`;
}

function makeWorkflowEvent(type, message, details = {}) {
  return {
    id: `evt_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
    type,
    message,
    details: sanitizeJson(details),
    createdAt: new Date().toISOString()
  };
}

function appendEvent(events = [], event) {
  return [...(Array.isArray(events) ? events : []), event].slice(-500);
}

function toWorkflowCleanupCandidate(job = {}, options = {}) {
  if (!job?.id) return null;
  if (!options.includeArchived && job.lifecycle?.archivedAt) return null;
  if (!isOlderThanHours(job, options.olderThanHours)) return null;
  const reasons = getWorkflowCleanupReasons(job, options);
  if (!reasons.length) return null;
  return {
    id: job.id,
    createdAt: job.createdAt || "",
    updatedAt: job.updatedAt || "",
    status: job.status || "",
    currentStage: job.currentStage || "",
    internal: Boolean(job.internal || job.input?.internal),
    archived: Boolean(job.lifecycle?.archivedAt),
    mode: cleanString(job.input?.mode || ""),
    sourceOriginalName: cleanString(job.input?.sourceOriginalName || ""),
    reasons
  };
}

function getWorkflowCleanupReasons(job = {}, options = {}) {
  const categories = getCleanupCategories(options);
  const text = [
    job.input?.mode,
    job.input?.sourceOriginalName,
    job.input?.notes,
    ...(Array.isArray(job.events) ? job.events.map((event) => `${event.type || ""} ${event.message || ""}`) : [])
  ].filter(Boolean).join(" ");
  const reasons = [];
  if (categories.has("internal") && (job.internal === true || job.input?.internal === true)) reasons.push("internal");
  if (categories.has("regression") && /\b(regression|smoke-e2e|product-visual-readiness|codex-slide-negative|skill-first-regression)\b/i.test(text)) reasons.push("regression");
  if (categories.has("probe") && /\b(archive-probe|cleanup-probe)\b/i.test(text)) reasons.push("probe");
  return [...new Set(reasons)];
}

function getCleanupCategories(options = {}) {
  const raw = Array.isArray(options.categories)
    ? options.categories
    : String(options.categories || "internal,regression,probe").split(",");
  const allowed = new Set(["internal", "regression", "probe"]);
  const selected = raw.map((item) => cleanString(item).toLowerCase()).filter((item) => allowed.has(item));
  return new Set(selected.length ? selected : ["internal", "regression", "probe"]);
}

function getCleanupLimit(options = {}) {
  const limit = Number(options.limit || 200);
  if (!Number.isFinite(limit)) return 200;
  return Math.max(1, Math.min(500, Math.round(limit)));
}

function isOlderThanHours(job = {}, olderThanHours = 0) {
  const hours = Number(olderThanHours || 0);
  if (!Number.isFinite(hours) || hours <= 0) return true;
  const timestamp = new Date(job.updatedAt || job.createdAt || 0).getTime();
  if (!Number.isFinite(timestamp)) return false;
  return Date.now() - timestamp >= hours * 60 * 60 * 1000;
}

function buildWorkflowCleanupSummary(candidates = [], allJobs = []) {
  const reasonCounts = {};
  for (const candidate of candidates) {
    for (const reason of candidate.reasons || []) {
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    }
  }
  return {
    ok: true,
    mode: "soft-archive",
    totalJobs: allJobs.length,
    candidateCount: candidates.length,
    reasonCounts,
    candidates
  };
}

async function writeWorkflowState(job) {
  const statePath = path.join(job.rootDir, "state.json");
  await writeJsonAtomic(statePath, normalizeWorkflowJob(job));
}

async function writeWorkflowManifest(job) {
  const manifest = {
    version: 1,
    id: job.id,
    kind: job.kind,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    stageOrder: WORKFLOW_STAGE_ORDER,
    pageStatuses: WORKFLOW_PAGE_STATUS,
    dirs: Object.fromEntries(Object.entries(job.dirs || {}).map(([key, value]) => [key, path.relative(rootDir, value)])),
    input: job.input,
    artifacts: job.artifacts,
    lifecycle: job.lifecycle || {},
    constraints: job.constraints
  };
  await writeJsonAtomic(path.join(job.rootDir, "manifest.json"), manifest);
}

async function writeJsonAtomic(filePath, data) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(data, null, 2), "utf8");
  const maxAttempts = 30;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await fs.rename(tempPath, filePath);
      return;
    } catch (error) {
      const retryable = ["EPERM", "EBUSY", "EACCES"].includes(error?.code);
      if (!retryable || attempt === maxAttempts - 1) {
        await fs.unlink(tempPath).catch(() => {});
        throw error;
      }
      await sleep(Math.min(1200, 80 * (attempt + 1)));
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function hashFile(filePath) {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function normalizeWorkflowJob(job) {
  return {
    version: 1,
    id: job.id,
    kind: job.kind || "ppt-rebuild-workflow",
    internal: Boolean(job.internal || job.input?.internal),
    status: job.status || "created",
    currentStage: job.currentStage || "created",
    stageStatus: job.stageStatus || "pending",
    createdAt: job.createdAt || new Date().toISOString(),
    updatedAt: job.updatedAt || job.createdAt || new Date().toISOString(),
    rootDir: job.rootDir || path.join(workflowRootDir, job.id),
    dirs: job.dirs || makeWorkflowDirs(path.join(workflowRootDir, job.id)),
    input: job.input || {},
    artifacts: job.artifacts || {},
    lifecycle: job.lifecycle || {},
    stages: { ...makeInitialStages(new Date(job.createdAt || Date.now()), false), ...(job.stages || {}) },
    pages: Array.isArray(job.pages) ? job.pages : [],
    events: Array.isArray(job.events) ? job.events : [],
    errors: Array.isArray(job.errors) ? job.errors : [],
    constraints: {
      asciiRuntimePath: true,
      noOriginalOverwrite: true,
      resumableState: true,
      perPageRetry: true,
      ...(job.constraints || {})
    }
  };
}

function getStatePath(id) {
  assertWorkflowId(id);
  return path.join(workflowRootDir, id, "state.json");
}

function assertWorkflowId(id) {
  if (!/^workflow_\d{8}-\d{6}Z_[a-f0-9]{6}$/.test(String(id || ""))) {
    throw new Error("Invalid workflow job id");
  }
}

function assertStage(stage) {
  if (!WORKFLOW_STAGE_ORDER.includes(stage)) throw new Error(`Invalid workflow stage: ${stage}`);
}

function assertStageStatus(status) {
  if (!WORKFLOW_STAGE_STATUS.includes(status)) throw new Error(`Invalid workflow stage status: ${status}`);
}

function assertPageStatus(status) {
  if (!WORKFLOW_PAGE_STATUS.includes(status)) throw new Error(`Invalid workflow page status: ${status}`);
}

function cleanString(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 1000);
}

function sanitizeJson(value) {
  if (value === undefined) return {};
  return JSON.parse(JSON.stringify(value));
}

function safeExtension(ext) {
  const cleaned = String(ext || "").toLowerCase().replace(/[^.a-z0-9]/g, "");
  return cleaned && cleaned.startsWith(".") ? cleaned : ".bin";
}
