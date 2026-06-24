import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import JSZip from "jszip";
import { getWorkflowDeliveryStatus } from "./workflowDelivery.js";
import { readWorkflowJob } from "./workflowJobs.js";

const MAX_INCLUDED_FILE_SIZE = 5 * 1024 * 1024;
const SAFE_LOG_EXTENSIONS = new Set([".json", ".txt", ".log", ".md"]);

export async function buildWorkflowLogBundle(id) {
  const job = await readWorkflowJob(id);
  const logsDir = path.resolve(job.dirs?.logs || path.join(job.rootDir, "logs"));
  await fs.mkdir(logsDir, { recursive: true });
  const outputPath = path.join(logsDir, `${job.id}-logs.zip`);
  const zip = new JSZip();

  zip.file("README.txt", [
    "PPT Tool workflow log bundle",
    `Job: ${job.id}`,
    `Created: ${job.createdAt || ""}`,
    `Updated: ${job.updatedAt || ""}`,
    "",
    "This bundle contains workflow state, manifest, events, delivery status, errors, and safe text/json logs.",
    "It does not include API keys or provider secrets."
  ].join("\n"));

  zip.file("workflow-state.json", JSON.stringify(sanitizeJobForLogs(job), null, 2));
  zip.file("events.json", JSON.stringify(Array.isArray(job.events) ? job.events : [], null, 2));
  zip.file("errors.json", JSON.stringify(Array.isArray(job.errors) ? job.errors : [], null, 2));
  zip.file("artifacts.json", JSON.stringify(job.artifacts || {}, null, 2));

  const delivery = await getWorkflowDeliveryStatus(job.id).catch((error) => ({
    ok: false,
    error: error.message || "delivery status failed"
  }));
  zip.file("delivery-status.json", JSON.stringify(delivery, null, 2));

  await addIfExists(zip, job.rootDir, path.join(job.rootDir, "manifest.json"), "manifest.json");
  await addIfExists(zip, job.rootDir, path.join(job.rootDir, "state.json"), "state.json");
  await addLogDirectory(zip, job.rootDir, logsDir, outputPath);

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 }
  });
  await fs.writeFile(outputPath, buffer);
  return {
    path: outputPath,
    fileName: path.basename(outputPath),
    size: buffer.length,
    jobId: job.id
  };
}

export async function getWorkflowLogBundleLink(id) {
  const job = await readWorkflowJob(id);
  const logsDir = path.resolve(job.dirs?.logs || path.join(job.rootDir, "logs"));
  const outputPath = path.join(logsDir, `${job.id}-logs.zip`);
  const stat = fsSync.existsSync(outputPath) ? fsSync.statSync(outputPath) : null;
  return {
    key: "log-bundle",
    pageId: "",
    label: "Log Bundle",
    fileName: `${job.id}-logs.zip`,
    size: stat?.size || 0,
    href: `/api/workflow-jobs/${encodeURIComponent(job.id)}/logs/download`
  };
}

async function addIfExists(zip, jobRoot, filePath, zipPath) {
  const resolved = path.resolve(filePath);
  if (!isInsidePath(resolved, path.resolve(jobRoot))) return;
  if (!fsSync.existsSync(resolved) || !fsSync.statSync(resolved).isFile()) return;
  const stat = fsSync.statSync(resolved);
  if (stat.size > MAX_INCLUDED_FILE_SIZE) {
    zip.file(`${zipPath}.skipped.txt`, `Skipped ${zipPath}: file is larger than ${MAX_INCLUDED_FILE_SIZE} bytes.`);
    return;
  }
  zip.file(zipPath, await fs.readFile(resolved));
}

async function addLogDirectory(zip, jobRoot, logsDir, outputPath) {
  const entries = await fs.readdir(logsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(logsDir, entry.name);
    if (path.resolve(fullPath) === path.resolve(outputPath)) continue;
    if (entry.isDirectory()) {
      await addNestedLogDirectory(zip, jobRoot, fullPath, path.join("logs", entry.name), outputPath);
    } else if (entry.isFile()) {
      await addSafeLogFile(zip, jobRoot, fullPath, path.join("logs", entry.name));
    }
  }
}

async function addNestedLogDirectory(zip, jobRoot, dirPath, zipPrefix, outputPath) {
  if (!isInsidePath(path.resolve(dirPath), path.resolve(jobRoot))) return;
  const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const childZipPath = path.join(zipPrefix, entry.name).replace(/\\/g, "/");
    if (path.resolve(fullPath) === path.resolve(outputPath)) continue;
    if (entry.isDirectory()) await addNestedLogDirectory(zip, jobRoot, fullPath, childZipPath, outputPath);
    else if (entry.isFile()) await addSafeLogFile(zip, jobRoot, fullPath, childZipPath);
  }
}

async function addSafeLogFile(zip, jobRoot, filePath, zipPath) {
  const resolved = path.resolve(filePath);
  if (!isInsidePath(resolved, path.resolve(jobRoot))) return;
  const ext = path.extname(resolved).toLowerCase();
  if (!SAFE_LOG_EXTENSIONS.has(ext)) return;
  const stat = fsSync.statSync(resolved);
  if (stat.size > MAX_INCLUDED_FILE_SIZE) {
    zip.file(`${zipPath}.skipped.txt`, `Skipped ${zipPath}: file is larger than ${MAX_INCLUDED_FILE_SIZE} bytes.`);
    return;
  }
  zip.file(zipPath.replace(/\\/g, "/"), await fs.readFile(resolved));
}

function sanitizeJobForLogs(job = {}) {
  return {
    version: job.version,
    id: job.id,
    kind: job.kind,
    internal: Boolean(job.internal),
    status: job.status,
    currentStage: job.currentStage,
    stageStatus: job.stageStatus,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    rootDir: job.rootDir,
    dirs: job.dirs,
    input: job.input,
    stages: job.stages,
    pages: job.pages,
    constraints: job.constraints
  };
}

function isInsidePath(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}
