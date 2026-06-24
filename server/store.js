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
const emptyDb = () => ({ uploads: {}, jobs: {}, styleReferences: {} });

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
  const tempPath = `${dbPath}.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(normalizeDb(db), null, 2), "utf8");
  await fs.rename(tempPath, dbPath);
}

function normalizeDb(db) {
  return {
    uploads: db && typeof db.uploads === "object" && !Array.isArray(db.uploads) ? db.uploads : {},
    jobs: db && typeof db.jobs === "object" && !Array.isArray(db.jobs) ? db.jobs : {},
    styleReferences: db && typeof db.styleReferences === "object" && !Array.isArray(db.styleReferences) ? db.styleReferences : {}
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
  const { sha256, buffer } = await hashFile(file.path);
  const originalName = decodeUploadName(file.originalname);
  const existing = Object.values(db.uploads).find((item) => item.sha256 === sha256 && item.path);
  if (existing) {
    await removeFileInside(file.path, uploadDir);
    return {
      ...existing,
      duplicate: true,
      duplicateOf: existing.id,
      reused: true,
      originalName: existing.originalName || originalName
    };
  }
  const id = makeId("file");
  const mediaProfile = buildUploadMediaProfile({
    originalName,
    mimeType: file.mimetype,
    path: file.path,
    size: file.size,
    sha256,
    buffer
  });
  const record = {
    id,
    originalName,
    mimeType: file.mimetype,
    path: file.path,
    size: file.size,
    sha256,
    mediaProfile,
    materialRole: mediaProfile.role,
    needsCutoutCandidate: mediaProfile.needsCutoutCandidate,
    createdAt: new Date().toISOString()
  };
  db.uploads[id] = record;
  await writeDb(db);
  return record;
}

async function hashFile(filePath) {
  const buffer = await fs.readFile(filePath);
  return {
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    buffer
  };
}

function buildUploadMediaProfile({ originalName = "", mimeType = "", path: filePath = "", size = 0, sha256 = "", buffer = null }) {
  const isImage = isImageFile({ originalName, mimeType, path: filePath });
  const imageSize = isImage ? readImageSize(buffer, originalName, mimeType) : null;
  const role = isImage ? inferImageRole({ originalName, imageSize }) : inferDocumentRole(originalName, mimeType);
  const needsCutoutCandidate = isImage && role === "foreground";
  const textSafeCandidate = isImage && role === "background";
  return {
    version: 1,
    sha256,
    kind: isImage ? "image" : "document",
    role,
    imageSize,
    aspectRatio: imageSize?.width && imageSize?.height ? Number((imageSize.width / imageSize.height).toFixed(4)) : null,
    needsCutoutCandidate,
    textSafeCandidate,
    duplicatePolicy: "reuse-by-sha256",
    notes: buildMediaProfileNotes({ isImage, role, imageSize, needsCutoutCandidate, textSafeCandidate, size })
  };
}

function isImageFile(file = {}) {
  return /\.(png|jpe?g|svg|webp)$/i.test(file.originalName || file.path || "") || /^image\//.test(file.mimeType || "");
}

function inferDocumentRole(originalName = "", mimeType = "") {
  const text = `${originalName} ${mimeType}`.toLowerCase();
  if (/pptx?|template|模板|母版/.test(text)) return "template";
  if (/pdf|docx?|xlsx?/.test(text)) return "source-document";
  return "source-document";
}

function inferImageRole({ originalName = "", imageSize = null }) {
  const text = originalName.toLowerCase();
  if (/style|reference|ref|mood|风格|参考|调性/.test(text)) return "style-reference";
  if (/icon|logo|mark|图标|标识|角标|装饰/.test(text)) return "decor";
  if (/cutout|product|item|foreground|fg|主图|产品|包装|礼盒|素材|抠图|前景/.test(text)) return "foreground";
  if (/background|hero|scene|poster|bg|底图|背景|海报|场景|主视觉/.test(text)) return "background";
  const ratio = imageSize?.width && imageSize?.height ? imageSize.width / imageSize.height : null;
  if (ratio && ratio > 1.25) return "background";
  if (ratio && ratio < 0.72) return "foreground";
  return "material";
}

function buildMediaProfileNotes({ isImage, role, imageSize, needsCutoutCandidate, textSafeCandidate, size }) {
  const notes = [];
  if (!isImage) notes.push("source text/template material");
  if (isImage && imageSize?.width && imageSize?.height) notes.push(`size ${imageSize.width}x${imageSize.height}`);
  if (role === "background") notes.push("candidate for cover/hero/background, preserve aspect ratio with cover/crop");
  if (role === "foreground") notes.push("candidate for product/foreground slot, may need matting/cutout");
  if (role === "decor") notes.push("candidate for logo/icon/decorative mark");
  if (role === "style-reference") notes.push("style-only signal, do not consume as content image unless explicitly selected");
  if (needsCutoutCandidate) notes.push("needs cutout candidate");
  if (textSafeCandidate) notes.push("reserve text-safe area when used as background");
  if (size) notes.push(`bytes ${size}`);
  return notes;
}

function readImageSize(buffer, originalName = "", mimeType = "") {
  if (!buffer || buffer.length < 24) return null;
  if (/png/i.test(mimeType) || /\.png$/i.test(originalName)) return readPngSize(buffer);
  if (/jpe?g/i.test(mimeType) || /\.jpe?g$/i.test(originalName)) return readJpegSize(buffer);
  if (/webp/i.test(mimeType) || /\.webp$/i.test(originalName)) return readWebpSize(buffer);
  if (/svg/i.test(mimeType) || /\.svg$/i.test(originalName)) return readSvgSize(buffer);
  return readPngSize(buffer) || readJpegSize(buffer) || readWebpSize(buffer);
}

function readPngSize(buffer) {
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), format: "png" };
}

function readJpegSize(buffer) {
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5), format: "jpeg" };
    }
    offset += 2 + length;
  }
  return null;
}

function readWebpSize(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") return null;
  const type = buffer.toString("ascii", 12, 16);
  if (type === "VP8X" && buffer.length >= 30) {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
      format: "webp"
    };
  }
  return null;
}

function readSvgSize(buffer) {
  const text = buffer.toString("utf8", 0, Math.min(buffer.length, 4096));
  const width = Number(text.match(/\bwidth=["']?([\d.]+)/i)?.[1] || 0);
  const height = Number(text.match(/\bheight=["']?([\d.]+)/i)?.[1] || 0);
  if (width && height) return { width, height, format: "svg" };
  const viewBox = text.match(/\bviewBox=["'][\d.\-\s]+?\s+([\d.]+)\s+([\d.]+)["']/i);
  if (viewBox) return { width: Number(viewBox[1]), height: Number(viewBox[2]), format: "svg" };
  return null;
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
    name: cleanMeta(meta.name) || originalName.replace(/\.[^.]+$/, "") || "可选参考图",
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
