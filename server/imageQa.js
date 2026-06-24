import fs from "fs/promises";
import zlib from "zlib";

const PNG_SIGNATURE = "89504e470d0a1a0a";

export async function analyzeGeneratedImage(filePath, options = {}) {
  const image = await readPng(filePath);
  const safeRegion = parseTextSafeArea(options.textSafeArea, image.width, image.height) || defaultSafeRegion(image.width, image.height);
  const titleRegion = parseTextSafeArea(options.titleArea, image.width, image.height) || defaultTitleRegion(image.width, image.height);
  const full = analyzeRegion(image, { x: 0, y: 0, width: image.width, height: image.height });
  const textSafe = analyzeRegion(image, safeRegion);
  const titleArea = analyzeRegion(image, titleRegion);
  const risks = [];
  if (full.variance < 12) risks.push("image-may-be-too-blank");
  if (textSafe.edgeDensity > 0.105) risks.push("text-safe-area-too-busy");
  if (full.textLikeScore > 0.011) risks.push("possible-readable-text-or-labels");
  if (full.darkComponentDensity > 0.014 && full.edgeDensity > 0.02) risks.push("possible-small-dark-text-or-labels");
  if (full.darkComponentDensity > 0.085 && full.edgeDensity > 0.09) risks.push("high-contrast-foreground-may-include-text");
  return {
    version: 1,
    source: "local-pixel-qa",
    status: risks.length ? "warn" : "pass",
    width: image.width,
    height: image.height,
    textSafeArea: safeRegion,
    titleRegion,
    full,
    textSafe,
    titleArea,
    risks
  };
}

function analyzeRegion(image, region) {
  const { width, height, pixels } = image;
  const x0 = clamp(Math.floor(region.x), 0, width - 1);
  const y0 = clamp(Math.floor(region.y), 0, height - 1);
  const x1 = clamp(Math.floor(region.x + region.width), x0 + 1, width);
  const y1 = clamp(Math.floor(region.y + region.height), y0 + 1, height);
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 180000)));
  let count = 0, sum = 0, sumSq = 0, dark = 0, saturated = 0, edge = 0, textLike = 0;
  for (let y = y0 + step; y < y1 - step; y += step) {
    for (let x = x0 + step; x < x1 - step; x += step) {
      const lum = luminanceAt(pixels, width, x, y);
      const dx = Math.abs(luminanceAt(pixels, width, x + step, y) - luminanceAt(pixels, width, x - step, y));
      const dy = Math.abs(luminanceAt(pixels, width, x, y + step) - luminanceAt(pixels, width, x, y - step));
      const gradient = dx + dy;
      const sat = saturationAt(pixels, width, x, y);
      count += 1;
      sum += lum;
      sumSq += lum * lum;
      if (lum < 78) dark += 1;
      if (sat > 0.42) saturated += 1;
      if (gradient > 44) edge += 1;
      if (gradient > 58 && lum < 150) textLike += 1;
    }
  }
  const mean = count ? sum / count : 0;
  const variance = count ? Math.sqrt(Math.max(0, sumSq / count - mean * mean)) : 0;
  return {
    brightness: round(mean / 255),
    variance: round(variance),
    edgeDensity: round(edge / Math.max(1, count)),
    darkComponentDensity: round(dark / Math.max(1, count)),
    saturationDensity: round(saturated / Math.max(1, count)),
    textLikeScore: round(textLike / Math.max(1, count))
  };
}

async function readPng(filePath) {
  const buffer = await fs.readFile(filePath);
  if (buffer.subarray(0, 8).toString("hex") !== PNG_SIGNATURE) throw new Error("Only PNG images are supported for local visual QA.");
  let offset = 8, width = 0, height = 0, colorType = 0, bitDepth = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
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
      const src = x * channels;
      const dst = (y * width + x) * 4;
      pixels[dst] = scanline[src];
      pixels[dst + 1] = scanline[src + 1];
      pixels[dst + 2] = scanline[src + 2];
      pixels[dst + 3] = channels === 4 ? scanline[src + 3] : 255;
    }
    previous = scanline;
  }
  return { width, height, pixels };
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
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  return pb <= pc ? up : upLeft;
}

function luminanceAt(pixels, width, x, y) {
  const index = (y * width + x) * 4;
  return 0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2];
}

function saturationAt(pixels, width, x, y) {
  const index = (y * width + x) * 4;
  const r = pixels[index] / 255, g = pixels[index + 1] / 255, b = pixels[index + 2] / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return max ? (max - min) / max : 0;
}

function parseTextSafeArea(value, width, height) {
  const match = String(value || "").match(/left\s+(\d+(?:\.\d+)?)%.*?top\s+(\d+(?:\.\d+)?)%.*?width\s+(\d+(?:\.\d+)?)%.*?height\s+(\d+(?:\.\d+)?)%/i);
  if (!match) return null;
  return {
    x: width * Number(match[1]) / 100,
    y: height * Number(match[2]) / 100,
    width: width * Number(match[3]) / 100,
    height: height * Number(match[4]) / 100
  };
}

function defaultSafeRegion(width, height) {
  return { x: width * 0.08, y: height * 0.12, width: width * 0.5, height: height * 0.62 };
}

function defaultTitleRegion(width, height) {
  return { x: width * 0.05, y: height * 0.08, width: width * 0.9, height: height * 0.34 };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
