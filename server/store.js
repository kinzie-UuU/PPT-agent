import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

export const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const dataDir = path.join(rootDir, "data");
export const uploadDir = path.join(rootDir, "uploads");
export const outputDir = path.join(rootDir, "outputs");
const dbPath = path.join(dataDir, "jobs.json");
const emptyDb = () => ({ uploads: {}, jobs: {} });

export async function ensureDirs() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(uploadDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });
  try {
    await fs.access(dbPath);
  } catch {
    await writeDb(emptyDb());
  }
}

async function readDb() {
  await ensureDirs();
  const raw = await fs.readFile(dbPath, "utf8");
  try {
    return normalizeDb(JSON.parse(raw));
  } catch (error) {
    const backupPath = path.join(dataDir, `jobs.corrupt-${toFileStamp(new Date())}.json`);
    await fs.writeFile(backupPath, raw, "utf8");
    await writeDb(emptyDb());
    console.warn(`jobs.json is invalid and was reset. Backup: ${backupPath}. Reason: ${error.message}`);
    return emptyDb();
  }
}

async function writeDb(db) {
  const tempPath = `${dbPath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(normalizeDb(db), null, 2), "utf8");
  await fs.rename(tempPath, dbPath);
}

function normalizeDb(db) {
  return {
    uploads: db && typeof db.uploads === "object" && !Array.isArray(db.uploads) ? db.uploads : {},
    jobs: db && typeof db.jobs === "object" && !Array.isArray(db.jobs) ? db.jobs : {}
  };
}

function toFileStamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export function makeId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

export async function addUpload(file) {
  const db = await readDb();
  const id = makeId("file");
  const record = {
    id,
    originalName: decodeUploadName(file.originalname),
    mimeType: file.mimetype,
    path: file.path,
    size: file.size,
    createdAt: new Date().toISOString()
  };
  db.uploads[id] = record;
  await writeDb(db);
  return record;
}

function decodeUploadName(name = "") {
  const candidates = [
    name,
    Buffer.from(name, "latin1").toString("utf8")
  ];
  return candidates.sort((a, b) => scoreName(b) - scoreName(a))[0];
}

function scoreName(name) {
  let score = 0;
  if (/[\u4e00-\u9fa5]/.test(name)) score += 4;
  if (/[a-z0-9]/i.test(name)) score += 1;
  if (/[ÃÂâ¤åç]/.test(name)) score -= 3;
  if (/[\ufffd]/.test(name)) score -= 8;
  return score;
}

export async function getUploads(ids = []) {
  const db = await readDb();
  return ids.map((id) => db.uploads[id]).filter(Boolean);
}

export async function saveJob(job) {
  const db = await readDb();
  db.jobs[job.id] = job;
  await writeDb(db);
  return job;
}

export async function getJob(id) {
  const db = await readDb();
  return db.jobs[id] || null;
}

export async function listJobs() {
  const db = await readDb();
  return Object.values(db.jobs).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
