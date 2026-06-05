import fs from "fs/promises";
import path from "path";
import zlib from "zlib";
import { uploadDir } from "./store.js";

const PNG_SIGNATURE = "89504e470d0a1a0a";
const CUTOUT_WORKFLOW_ASSET = path.join(process.cwd(), "local-ai", "comfyui-workflows", "ppt-foreground-cutout-rembg.workflow.json");

export async function cutoutImage(file, options = {}) {
  const attempts = [];
  if (path.extname(file?.path || "").toLowerCase() === ".png") {
    try {
      const local = await localFloodFillCutout(file, options);
      return { ...local, attempts: [{ method: "local-flood-fill", ok: true }] };
    } catch (error) {
      attempts.push({ method: "local-flood-fill", ok: false, error: error.message });
    }
  } else {
    attempts.push({ method: "local-flood-fill", ok: false, error: "local cutout supports PNG only" });
  }
  try {
    const cloud = await cloudImageCutout(file, options);
    return { ...cloud, attempts: [...attempts, { method: "cloud-image-edit", ok: true }] };
  } catch (error) {
    return { ok: false, method: "none", status: "failed", reason: error.message, attempts: [...attempts, { method: "cloud-image-edit", ok: false, error: error.message }] };
  }
}

async function localFloodFillCutout(file, options = {}) {
  const image = await readPng(file.path);
  const bg = estimateBackground(image);
  const mask = floodBackground(image, bg, Number(options.tolerance || 34));
  const foreground = mask.filter((item) => !item).length;
  const ratio = foreground / Math.max(1, image.width * image.height);
  if (ratio < 0.04 || ratio > 0.86) throw new Error(`unreliable foreground ratio ${ratio.toFixed(3)}`);
  const alpha = softenAlpha(mask, image.width, image.height);
  const pixels = new Uint8ClampedArray(image.pixels);
  for (let index = 0; index < alpha.length; index += 1) pixels[index * 4 + 3] = alpha[index];
  const outputName = `${path.basename(file.originalName || file.path, path.extname(file.originalName || file.path))}_cutout_${Date.now()}.png`;
  const outputPath = path.join(uploadDir, sanitizeFileName(outputName));
  await fs.writeFile(outputPath, writePng({ width: image.width, height: image.height, pixels }));
  const stat = await fs.stat(outputPath);
  return {
    ok: true,
    method: "local-flood-fill",
    status: "local-pass",
    record: makeCutoutRecord(file, outputPath, stat.size, "local-cutout", "local-pass", { method: "local-flood-fill", foregroundRatio: Number(ratio.toFixed(3)), workflowAsset: CUTOUT_WORKFLOW_ASSET })
  };
}

async function cloudImageCutout(file, options = {}) {
  const env = globalThis.process?.env || {};
  if (env.CLOUD_MATTING_ENABLED === "false") throw new Error("CLOUD_MATTING_ENABLED=false");
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not configured for cloud matting");
  const baseUrl = (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = env.OPENAI_IMAGE_MODEL || env.CLOUD_MATTING_MODEL || "gpt-image-1";
  const bytes = await fs.readFile(file.path);
  const form = new FormData();
  form.set("model", model);
  form.set("image", new Blob([bytes], { type: file.mimeType || "image/png" }), file.originalName || path.basename(file.path));
  form.set("prompt", options.prompt || "Remove the background and return the subject as a transparent PNG cutout. Do not add text, logos, shadows, or new objects.");
  form.set("size", options.size || "1024x1024");
  const response = await fetch(`${baseUrl}/images/edits`, { method: "POST", headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` }, body: form });
  if (!response.ok) throw new Error(`cloud matting failed: HTTP ${response.status} ${await response.text()}`);
  const data = await response.json();
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error("cloud matting response missing b64_json");
  const outputName = `${path.basename(file.originalName || file.path, path.extname(file.originalName || file.path))}_cloud_cutout_${Date.now()}.png`;
  const outputPath = path.join(uploadDir, sanitizeFileName(outputName));
  await fs.writeFile(outputPath, Buffer.from(b64, "base64"));
  const stat = await fs.stat(outputPath);
  return {
    ok: true,
    method: "cloud-image-edit",
    status: "cloud-pass",
    record: makeCutoutRecord(file, outputPath, stat.size, "cloud-cutout", "cloud-pass", { method: "cloud-image-edit", model, aiGenerated: true, workflowAsset: CUTOUT_WORKFLOW_ASSET })
  };
}

function makeCutoutRecord(file, outputPath, size, source, mattingStatus, matting) {
  return {
    id: `${source.replace(/-/g, "")}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    originalName: path.basename(outputPath),
    mimeType: "image/png",
    path: outputPath,
    size,
    createdAt: new Date().toISOString(),
    source,
    derived: true,
    aiGenerated: source === "cloud-cutout",
    sourceImageId: file.id || null,
    sourceImageName: file.originalName || path.basename(file.path || ""),
    sourceSlide: file.sourceSlide || null,
    materialRole: "foreground-cutout",
    needsCutout: false,
    mattingStatus,
    matting
  };
}

function estimateBackground(image) {
  const samples = [];
  const step = Math.max(1, Math.floor(Math.min(image.width, image.height) / 32));
  for (let x = 0; x < image.width; x += step) {
    samples.push(rgbAt(image, x, 0), rgbAt(image, x, image.height - 1));
  }
  for (let y = 0; y < image.height; y += step) {
    samples.push(rgbAt(image, 0, y), rgbAt(image, image.width - 1, y));
  }
  return [0, 1, 2].map((channel) => samples.map((item) => item[channel]).sort((a, b) => a - b)[Math.floor(samples.length / 2)]);
}

function floodBackground(image, bg, tolerance) {
  const mask = new Array(image.width * image.height).fill(false);
  const queue = [];
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
    const index = y * image.width + x;
    if (mask[index] || colorDistance(rgbAt(image, x, y), bg) > tolerance) return;
    mask[index] = true;
    queue.push([x, y]);
  };
  for (let x = 0; x < image.width; x += 1) {
    push(x, 0);
    push(x, image.height - 1);
  }
  for (let y = 0; y < image.height; y += 1) {
    push(0, y);
    push(image.width - 1, y);
  }
  for (let head = 0; head < queue.length; head += 1) {
    const [x, y] = queue[head];
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }
  return mask;
}

function softenAlpha(mask, width, height) {
  const alpha = new Uint8ClampedArray(width * height);
  for (let i = 0; i < alpha.length; i += 1) alpha[i] = mask[i] ? 0 : 255;
  const copy = new Uint8ClampedArray(alpha);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      if (copy[index] === 255 && [copy[index - 1], copy[index + 1], copy[index - width], copy[index + width]].some((value) => value === 0)) alpha[index] = 210;
    }
  }
  return alpha;
}

async function readPng(filePath) {
  const buffer = await fs.readFile(filePath);
  if (buffer.subarray(0, 8).toString("hex") !== PNG_SIGNATURE) throw new Error("Only PNG images are supported.");
  let offset = 8, width = 0, height = 0, colorType = 0, bitDepth = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
  }
  if (bitDepth !== 8 || ![2, 6].includes(colorType)) throw new Error(`Unsupported PNG format: bitDepth=${bitDepth}, colorType=${colorType}`);
  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = new Uint8ClampedArray(width * height * 4);
  let rawOffset = 0;
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rawOffset++];
    const scanline = new Uint8Array(stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? scanline[x - channels] : 0;
      const up = previous[x] || 0;
      const upLeft = x >= channels ? previous[x - channels] || 0 : 0;
      scanline[x] = (raw[rawOffset++] + unfilter(filter, left, up, upLeft)) & 255;
    }
    for (let x = 0; x < width; x += 1) {
      const src = x * channels, dst = (y * width + x) * 4;
      pixels[dst] = scanline[src]; pixels[dst + 1] = scanline[src + 1]; pixels[dst + 2] = scanline[src + 2]; pixels[dst + 3] = channels === 4 ? scanline[src + 3] : 255;
    }
    previous = scanline;
  }
  return { width, height, pixels };
}

function writePng(image) {
  const raw = Buffer.alloc((image.width * 4 + 1) * image.height);
  let offset = 0;
  for (let y = 0; y < image.height; y += 1) {
    raw[offset++] = 0;
    for (let x = 0; x < image.width * 4; x += 1) raw[offset++] = image.pixels[y * image.width * 4 + x];
  }
  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE, "hex"),
    chunk("IHDR", Buffer.concat([u32(image.width), u32(image.height), Buffer.from([8, 6, 0, 0, 0])])),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function chunk(type, data) {
  const name = Buffer.from(type, "ascii");
  return Buffer.concat([u32(data.length), name, data, u32(crc32(Buffer.concat([name, data])))]);
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0);
  return buffer;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function unfilter(filter, left, up, upLeft) {
  if (filter === 0) return 0;
  if (filter === 1) return left;
  if (filter === 2) return up;
  if (filter === 3) return Math.floor((left + up) / 2);
  if (filter === 4) return paeth(left, up, upLeft);
  throw new Error(`Unsupported PNG filter: ${filter}`);
}

function paeth(left, up, upLeft) {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  return pb <= pc ? up : upLeft;
}

function rgbAt(image, x, y) {
  const i = (y * image.width + x) * 4;
  return [image.pixels[i], image.pixels[i + 1], image.pixels[i + 2]];
}

function colorDistance(a, b) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

function sanitizeFileName(value = "") {
  return String(value).replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_").slice(0, 160);
}
