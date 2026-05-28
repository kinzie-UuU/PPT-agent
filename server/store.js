import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

export const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const dataDir = path.join(rootDir, "data");
export const uploadDir = path.join(rootDir, "uploads");
export const outputDir = path.join(rootDir, "outputs");
const dbPath = path.join(dataDir, "jobs.json");

export async function ensureDirs() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(uploadDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });
  try {
    await fs.access(dbPath);
  } catch {
    await fs.writeFile(dbPath, JSON.stringify({ uploads: {}, jobs: {} }, null, 2));
  }
}

async function readDb() {
  await ensureDirs();
  return JSON.parse(await fs.readFile(dbPath, "utf8"));
}

async function writeDb(db) {
  await fs.writeFile(dbPath, JSON.stringify(db, null, 2));
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
  if (/[�]/.test(name)) score -= 8;
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
