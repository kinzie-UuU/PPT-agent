import fs from "fs/promises";
import path from "path";
import zlib from "zlib";
import { promisify } from "util";
import { imageSize } from "image-size";

const inflateAsync = promisify(zlib.inflate);

export async function analyzeStyleReference(file = {}, meta = {}) {
  const fingerprint = {
    version: 1,
    source: "local-deterministic",
    confidence: "medium",
    width: null,
    height: null,
    aspectRatio: null,
    orientation: "unknown",
    density: "unknown",
    brightness: "unknown",
    saturation: "unknown",
    palette: [],
    traits: [],
    prompt: ""
  };
  const filePath = file.path;
  try {
    const size = imageSize(filePath);
    fingerprint.width = size.width || null;
    fingerprint.height = size.height || null;
    fingerprint.aspectRatio = size.width && size.height ? Number((size.width / size.height).toFixed(2)) : null;
    fingerprint.orientation = inferOrientation(size.width, size.height);
    fingerprint.density = inferDensity(file.size || 0, size.width, size.height);
  } catch {
    fingerprint.confidence = "low";
  }

  const ext = path.extname(file.originalName || file.path || "").toLowerCase();
  if (ext === ".svg") {
    await addSvgFingerprint(fingerprint, filePath);
  } else if (ext === ".png") {
    await addPngFingerprint(fingerprint, filePath);
  } else {
    fingerprint.traits.push("raster-reference");
  }

  const textTraits = inferTextTraits([meta.name, meta.tone, file.originalName].filter(Boolean).join(" "));
  fingerprint.traits = uniqueList([...fingerprint.traits, ...textTraits, fingerprint.orientation, fingerprint.density]).filter((item) => item !== "unknown").slice(0, 12);
  fingerprint.prompt = buildStyleFingerprintPrompt(fingerprint, meta);
  return fingerprint;
}

export function summarizeStyleFingerprints(references = []) {
  const fingerprints = references.map((item) => item.styleFingerprint).filter(Boolean);
  if (!fingerprints.length) return null;
  const palettes = uniqueList(fingerprints.flatMap((item) => item.palette || [])).slice(0, 8);
  const traits = uniqueList(fingerprints.flatMap((item) => item.traits || [])).slice(0, 18);
  const brightness = mostCommon(fingerprints.map((item) => item.brightness).filter(Boolean));
  const saturation = mostCommon(fingerprints.map((item) => item.saturation).filter(Boolean));
  const density = mostCommon(fingerprints.map((item) => item.density).filter(Boolean));
  return {
    count: fingerprints.length,
    palette: palettes,
    traits,
    brightness,
    saturation,
    density,
    prompt: [
      palettes.length ? `主色参考：${palettes.join(" / ")}` : "",
      traits.length ? `视觉特征：${traits.join(" / ")}` : "",
      brightness ? `亮度倾向：${brightness}` : "",
      saturation ? `饱和度倾向：${saturation}` : "",
      density ? `画面密度：${density}` : ""
    ].filter(Boolean).join("；")
  };
}

async function addSvgFingerprint(fingerprint, filePath) {
  const svg = await fs.readFile(filePath, "utf8").catch(() => "");
  const colors = uniqueList([...svg.matchAll(/#[0-9a-fA-F]{3,8}|rgb\([^)]+\)/g)].map((match) => normalizeColor(match[0]))).slice(0, 8);
  fingerprint.palette = colors;
  fingerprint.brightness = inferBrightnessFromPalette(colors);
  fingerprint.saturation = inferSaturationFromPalette(colors);
  fingerprint.traits.push("vector-clean", colors.length <= 3 ? "limited-palette" : "multi-color");
}

async function addPngFingerprint(fingerprint, filePath) {
  const buffer = await fs.readFile(filePath).catch(() => null);
  if (!buffer || buffer.toString("ascii", 1, 4) !== "PNG") return;
  const png = await decodePng(buffer).catch(() => null);
  if (!png?.pixels?.length) return;
  const sample = samplePixels(png.pixels, png.width, png.height, png.channels);
  const stats = colorStats(sample);
  fingerprint.palette = stats.palette;
  fingerprint.brightness = stats.brightness;
  fingerprint.saturation = stats.saturation;
  fingerprint.traits.push(stats.whiteRatio > 0.42 ? "high-whitespace" : stats.whiteRatio > 0.22 ? "balanced-whitespace" : "dense-visual");
  fingerprint.traits.push(stats.edgeContrast > 0.28 ? "high-contrast" : "soft-contrast");
  fingerprint.confidence = "medium";
}

async function decodePng(buffer) {
  const chunks = [];
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    }
    if (type === "IDAT") chunks.push(data);
    if (type === "IEND") break;
    offset += 12 + length;
  }
  if (bitDepth !== 8 || ![0, 2, 6].includes(colorType)) return null;
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const inflated = await inflateAsync(Buffer.concat(chunks));
  const stride = width * channels;
  const pixels = Buffer.alloc(width * height * channels);
  let inputOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset++];
    const row = inflated.subarray(inputOffset, inputOffset + stride);
    inputOffset += stride;
    unfilterRow(row, pixels, y, stride, channels, filter);
  }
  return { width, height, channels, pixels };
}

function unfilterRow(row, pixels, y, stride, channels, filter) {
  const outOffset = y * stride;
  const prevOffset = (y - 1) * stride;
  for (let x = 0; x < stride; x += 1) {
    const raw = row[x];
    const left = x >= channels ? pixels[outOffset + x - channels] : 0;
    const up = y > 0 ? pixels[prevOffset + x] : 0;
    const upLeft = y > 0 && x >= channels ? pixels[prevOffset + x - channels] : 0;
    const value = filter === 1
      ? raw + left
      : filter === 2
        ? raw + up
        : filter === 3
          ? raw + Math.floor((left + up) / 2)
          : filter === 4
            ? raw + paeth(left, up, upLeft)
            : raw;
    pixels[outOffset + x] = value & 255;
  }
}

function samplePixels(pixels, width, height, channels) {
  const maxSamples = 900;
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / maxSamples)));
  const sample = [];
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const offset = (y * width + x) * channels;
      const r = pixels[offset];
      const g = channels === 1 ? r : pixels[offset + 1];
      const b = channels === 1 ? r : pixels[offset + 2];
      const a = channels === 4 ? pixels[offset + 3] : 255;
      if (a > 16) sample.push([r, g, b]);
    }
  }
  return sample;
}

function colorStats(sample) {
  if (!sample.length) return { palette: [], brightness: "unknown", saturation: "unknown", whiteRatio: 0, edgeContrast: 0 };
  const buckets = new Map();
  let brightnessSum = 0;
  let saturationSum = 0;
  let white = 0;
  let dark = 0;
  for (const [r, g, b] of sample) {
    const { h, s, v } = rgbToHsv(r, g, b);
    brightnessSum += v;
    saturationSum += s;
    if (v > 0.88 && s < 0.16) white += 1;
    if (v < 0.2) dark += 1;
    const key = `${Math.round(h / 30) * 30}-${Math.round(s * 4) / 4}-${Math.round(v * 4) / 4}`;
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  const palette = [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([key]) => hsvBucketToLabel(key));
  const brightnessAvg = brightnessSum / sample.length;
  const saturationAvg = saturationSum / sample.length;
  return {
    palette: uniqueList(palette),
    brightness: brightnessAvg > 0.72 ? "bright" : brightnessAvg < 0.36 ? "dark" : "medium",
    saturation: saturationAvg > 0.48 ? "high-saturation" : saturationAvg < 0.2 ? "low-saturation" : "medium-saturation",
    whiteRatio: white / sample.length,
    edgeContrast: (white + dark) / sample.length
  };
}

function rgbToHsv(r, g, b) {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const d = max - min;
  const h = d === 0 ? 0 : max === rr ? 60 * (((gg - bb) / d) % 6) : max === gg ? 60 * ((bb - rr) / d + 2) : 60 * ((rr - gg) / d + 4);
  return { h: (h + 360) % 360, s: max === 0 ? 0 : d / max, v: max };
}

function hsvBucketToLabel(key) {
  const [hRaw, sRaw, vRaw] = key.split("-").map(Number);
  const hue = hueName(hRaw);
  const saturation = sRaw <= 0.25 ? "muted" : sRaw >= 0.75 ? "vivid" : "soft";
  const value = vRaw <= 0.25 ? "dark" : vRaw >= 0.75 ? "light" : "mid";
  return `${value}-${saturation}-${hue}`;
}

function hueName(hue) {
  if (hue < 20 || hue >= 340) return "red";
  if (hue < 45) return "orange";
  if (hue < 70) return "yellow";
  if (hue < 165) return "green";
  if (hue < 200) return "cyan";
  if (hue < 255) return "blue";
  if (hue < 300) return "purple";
  return "magenta";
}

function inferTextTraits(text = "") {
  const traits = [];
  if (/东方|自然|中式|国风|茶|山水|松|竹|禅/.test(text)) traits.push("reference-natural");
  if (/高级|克制|留白|画册|低饱和/.test(text)) traits.push("premium-restraint");
  if (/科技|蓝白|数据|系统|AI|SaaS/i.test(text)) traits.push("technical-structured");
  if (/潮玩|高饱和|强对比|活泼/.test(text)) traits.push("playful-vivid");
  if (/暗黑|发布|未来|霓虹/.test(text)) traits.push("dark-launch");
  return traits;
}

function inferOrientation(width, height) {
  if (!width || !height) return "unknown";
  const ratio = width / height;
  if (ratio > 1.25) return "landscape";
  if (ratio < 0.8) return "portrait";
  return "square";
}

function inferDensity(bytes, width, height) {
  if (!bytes || !width || !height) return "unknown";
  const bpp = bytes / Math.max(1, width * height);
  if (bpp > 1.2) return "rich-detail";
  if (bpp < 0.28) return "clean-minimal";
  return "balanced-detail";
}

function inferBrightnessFromPalette(colors = []) {
  if (!colors.length) return "unknown";
  const labels = colors.join(" ");
  if (/light|white|bright/i.test(labels)) return "bright";
  if (/dark|black/i.test(labels)) return "dark";
  return "medium";
}

function inferSaturationFromPalette(colors = []) {
  if (!colors.length) return "unknown";
  const labels = colors.join(" ");
  if (/vivid/i.test(labels)) return "high-saturation";
  if (/muted/i.test(labels)) return "low-saturation";
  return "medium-saturation";
}

function normalizeColor(value = "") {
  return value.toLowerCase().replace(/\s+/g, "");
}

function buildStyleFingerprintPrompt(fingerprint, meta = {}) {
  return [
    fingerprint.palette.length ? `palette=${fingerprint.palette.join("/")}` : "",
    fingerprint.traits.length ? `traits=${fingerprint.traits.join("/")}` : "",
    fingerprint.brightness !== "unknown" ? `brightness=${fingerprint.brightness}` : "",
    fingerprint.saturation !== "unknown" ? `saturation=${fingerprint.saturation}` : "",
    fingerprint.aspectRatio ? `aspect=${fingerprint.aspectRatio}` : "",
    meta.tone ? `userTone=${meta.tone}` : ""
  ].filter(Boolean).join("; ");
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function mostCommon(values = []) {
  const counts = new Map();
  for (const value of values.filter((item) => item && item !== "unknown")) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

function uniqueList(values = []) {
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))];
}
