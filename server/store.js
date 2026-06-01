import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { analyzeStyleReference } from "./styleFingerprint.js";

export const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const dataDir = path.join(rootDir, "data");
export const uploadDir = path.join(rootDir, "uploads");
export const outputDir = path.join(rootDir, "outputs");
const dbPath = path.join(dataDir, "jobs.json");
const emptyDb = () => ({ uploads: {}, jobs: {}, styleReferences: {}, styleGroups: {} });

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
    jobs: db && typeof db.jobs === "object" && !Array.isArray(db.jobs) ? db.jobs : {},
    styleReferences: db && typeof db.styleReferences === "object" && !Array.isArray(db.styleReferences) ? db.styleReferences : {},
    styleGroups: db && typeof db.styleGroups === "object" && !Array.isArray(db.styleGroups) ? db.styleGroups : {}
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

export async function deleteUpload(id) {
  const db = await readDb();
  const record = db.uploads[id];
  if (!record) return null;
  delete db.uploads[id];
  await writeDb(db);
  await removeFileInside(record.path, uploadDir);
  return record;
}

export async function addStyleReference(file, meta = {}) {
  const db = await readDb();
  const id = makeId("style");
  const originalName = decodeUploadName(file.originalname);
  const styleFingerprint = await analyzeStyleReference({
    originalName,
    mimeType: file.mimetype,
    path: file.path,
    size: file.size
  }, meta).catch(() => null);
  const record = {
    id,
    name: cleanMeta(meta.name) || originalName.replace(/\.[^.]+$/, "") || "风格参考",
    tone: cleanMeta(meta.tone) || "参考这张图的色彩、质感、版式气质和留白节奏。",
    themeName: cleanMeta(meta.themeName),
    themeSlug: cleanMeta(meta.themeSlug),
    originalName,
    mimeType: file.mimetype,
    path: file.path,
    size: file.size,
    styleFingerprint,
    createdAt: new Date().toISOString()
  };
  db.styleReferences[id] = record;
  await writeDb(db);
  return record;
}

export async function updateStyleReference(id, meta = {}) {
  const db = await readDb();
  const record = db.styleReferences[id];
  if (!record) return null;
  const styleFingerprint = await analyzeStyleReference(record, { ...record, ...meta }).catch(() => record.styleFingerprint || null);
  const next = {
    ...record,
    name: meta.name === undefined ? record.name : cleanMeta(meta.name),
    tone: meta.tone === undefined ? record.tone : cleanMeta(meta.tone),
    themeName: meta.themeName === undefined ? record.themeName : cleanMeta(meta.themeName),
    themeSlug: meta.themeSlug === undefined ? record.themeSlug : cleanMeta(meta.themeSlug),
    styleFingerprint,
    updatedAt: new Date().toISOString()
  };
  db.styleReferences[id] = next;
  await writeDb(db);
  return next;
}

export async function listStyleReferences() {
  const db = await readDb();
  let changed = false;
  for (const record of Object.values(db.styleReferences)) {
    if (!record.styleFingerprint && record.path) {
      record.styleFingerprint = await analyzeStyleReference(record, record).catch(() => null);
      changed = true;
    }
  }
  if (changed) await writeDb(db);
  return Object.values(db.styleReferences).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function addStyleGroup(meta = {}) {
  const db = await readDb();
  const name = cleanMeta(meta.name);
  if (!name) throw new Error("风格库名称不能为空");
  const existing = Object.values(db.styleGroups).find((group) => group.name === name);
  if (existing) return existing;
  const id = makeId("style_group");
  const record = {
    id,
    slug: `custom-${id.replace(/^style_group_/, "")}`,
    name,
    tone: cleanMeta(meta.tone),
    bestFor: cleanMeta(meta.bestFor || meta.tone),
    custom: true,
    createdAt: new Date().toISOString()
  };
  db.styleGroups[id] = record;
  await writeDb(db);
  return record;
}

export async function listStyleGroups() {
  const db = await readDb();
  return Object.values(db.styleGroups).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteStyleGroup(id) {
  const db = await readDb();
  const record = db.styleGroups[id];
  if (!record) return null;
  delete db.styleGroups[id];
  await writeDb(db);
  return record;
}

export async function deleteStyleReference(id) {
  const db = await readDb();
  const record = db.styleReferences[id];
  if (!record) return null;
  delete db.styleReferences[id];
  await writeDb(db);
  await removeFileInside(record.path, uploadDir);
  return record;
}

function cleanMeta(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 280);
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

export async function deleteJob(id) {
  const db = await readDb();
  const record = db.jobs[id];
  if (!record) return null;
  delete db.jobs[id];
  await writeDb(db);
  await removeDirectoryInside(path.join(outputDir, id), outputDir);
  return record;
}

export async function listJobs() {
  const db = await readDb();
  return Object.values(db.jobs).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function isInside(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function removeFileInside(filePath, parentDir) {
  if (!filePath || !isInside(filePath, parentDir)) return;
  await fs.unlink(filePath).catch(() => {});
}

async function removeDirectoryInside(dirPath, parentDir) {
  if (!dirPath || !isInside(dirPath, parentDir)) return;
  await fs.rm(dirPath, { recursive: true, force: true }).catch(() => {});
}
