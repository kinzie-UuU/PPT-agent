#!/usr/bin/env node
import fs from "fs";
import path from "path";
import PptxGenJS from "pptxgenjs";

const args = parseArgs(process.argv.slice(2));

if (args.help || (!args.manifest && !args["deck-manifest"])) {
  printHelp();
  process.exit(args.help ? 0 : 1);
}

const outPath = path.resolve(args.out || "");
if (!outPath) throw new Error("--out is required");

if (args.manifest) {
  const manifestPath = path.resolve(args.manifest);
  const manifest = readJson(manifestPath);
  await writeDeck([{ manifest, manifestPath }], outPath, manifest.slide || {});
  console.log(JSON.stringify({ ok: true, mode: "page", outPath }, null, 2));
} else {
  const deckManifestPath = path.resolve(args["deck-manifest"]);
  const { entries, slide } = readDeckEntries(deckManifestPath);
  await writeDeck(entries, outPath, slide);
  console.log(JSON.stringify({ ok: true, mode: "deck", pages: entries.length, outPath }, null, 2));
}

function readDeckEntries(deckManifestPath) {
  const deck = readJson(deckManifestPath);
  const root = path.resolve(deck.job_dir || path.dirname(deckManifestPath));
  const entries = (Array.isArray(deck.pages) ? deck.pages : [])
    .map((page) => {
      const manifestPath = path.resolve(root, page.manifest || "");
      return { manifest: readJson(manifestPath), manifestPath };
    });
  if (!entries.length) throw new Error("Deck manifest has no pages.");
  return { entries, slide: deck.slide || entries[0].manifest.slide || {} };
}

async function writeDeck(entries, outPath, deckSlide = {}) {
  const firstSlide = entries[0]?.manifest?.slide || deckSlide || {};
  const slideWidth = numberValue(deckSlide.width || firstSlide.width, 13.333);
  const slideHeight = numberValue(deckSlide.height || firstSlide.height, 7.5);
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "PPT_TOOL_MANIFEST", width: slideWidth, height: slideHeight });
  pptx.layout = "PPT_TOOL_MANIFEST";
  pptx.author = "PPT Agent";
  pptx.company = "PPT Agent";
  pptx.subject = "Editable manifest rebuild";
  pptx.title = path.basename(outPath, path.extname(outPath));
  pptx.lang = "zh-CN";
  pptx.theme = {
    headFontFace: "Microsoft YaHei",
    bodyFontFace: "Microsoft YaHei",
    lang: "zh-CN"
  };

  for (const entry of entries) {
    const slide = pptx.addSlide();
    drawManifest(slide, pptx, entry.manifest, path.dirname(entry.manifestPath));
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await pptx.writeFile({ fileName: outPath });
}

function drawManifest(slide, pptx, manifest, baseDir) {
  const slideInfo = manifest.slide || {};
  slide.background = { color: normalizeColor(slideInfo.background || "#FFFFFF") || "FFFFFF" };
  const layered = [];
  for (const item of manifest.shapes || []) layered.push([numberValue(item.z_index, 100), "shape", item]);
  for (const item of manifest.images || []) layered.push([numberValue(item.z_index, 200), "image", item]);
  for (const item of manifest.text_boxes || []) layered.push([numberValue(item.z_index, 300), "text", item]);
  layered.sort((a, b) => a[0] - b[0]);
  for (const [, kind, item] of layered) {
    if (kind === "shape") drawShape(slide, pptx, manifest, item);
    else if (kind === "image") drawImage(slide, manifest, item, baseDir);
    else drawText(slide, manifest, item);
  }
}

function drawShape(slide, pptx, manifest, item) {
  const pos = positionForItem(manifest, item);
  const shapeType = shapeTypeFor(pptx, item);
  const fillColor = normalizeColor(item.fill);
  const strokeColor = normalizeColor(item.stroke || item.line?.color);
  const lineWidth = Math.max(0, numberValue(item.stroke_width || item.line?.width, 1));
  const options = {
    ...pos,
    fill: fillColor ? { color: fillColor } : { color: "FFFFFF", transparency: 100 },
    line: strokeColor ? { color: strokeColor, width: lineWidth || 0.25 } : { color: "FFFFFF", transparency: 100, width: 0 }
  };
  slide.addShape(shapeType, options);
}

function drawImage(slide, manifest, item, baseDir) {
  const imagePath = path.resolve(baseDir, String(item.path || ""));
  if (!fs.existsSync(imagePath)) return;
  slide.addImage({ path: imagePath, ...positionForItem(manifest, item) });
}

function drawText(slide, manifest, item) {
  const pos = positionForItem(manifest, item);
  slide.addText(String(item.text || ""), {
    ...pos,
    margin: 0,
    breakLine: false,
    fit: "shrink",
    fontFace: item.font_face || item.font || "Microsoft YaHei",
    fontSize: numberValue(item.font_size, 18),
    color: normalizeColor(item.color) || "111111",
    bold: Boolean(item.bold),
    italic: Boolean(item.italic),
    align: pptxTextAlign(item.align),
    valign: pptxTextValign(item.valign),
    wrap: item.wrap !== "none"
  });
}

function shapeTypeFor(pptx, item = {}) {
  const type = String(item.type || "rect");
  if (type === "ellipse") return pptx.ShapeType.ellipse;
  if (type === "roundRect") return pptx.ShapeType.roundRect;
  if (type === "line") return pptx.ShapeType.line;
  if (type === "star5") return pptx.ShapeType.star5;
  if (type === "diamond") return pptx.ShapeType.diamond;
  return pptx.ShapeType.rect;
}

function positionForItem(manifest, item) {
  if (Array.isArray(item.points_px) && item.type === "line") {
    const [x1, y1, x2, y2] = item.points_px.map(Number);
    const strokeWidth = Math.max(1, numberValue(item.stroke_width || item.line?.width, 1));
    const thickness = Math.max(1, Math.round(strokeWidth));
    return pxToInches(
      manifest,
      Math.min(x1, x2),
      Math.min(y1, y2),
      Math.max(Math.abs(x2 - x1), x1 === x2 ? thickness : 1),
      Math.max(Math.abs(y2 - y1), y1 === y2 ? thickness : 1)
    );
  }
  const box = Array.isArray(item.box_px) ? item.box_px.map(Number) : [0, 0, 1, 1];
  return pxToInches(manifest, box[0], box[1], box[2], box[3]);
}

function pxToInches(manifest, x, y, width, height) {
  const source = manifest.source || {};
  const sourceWidth = numberValue(source.width_px, 1);
  const sourceHeight = numberValue(source.height_px, 1);
  const contentBox = contentBoxForManifest(manifest, sourceWidth, sourceHeight);
  return {
    x: contentBox.left + Number(x || 0) / sourceWidth * contentBox.width,
    y: contentBox.top + Number(y || 0) / sourceHeight * contentBox.height,
    w: Number(width || 0) / sourceWidth * contentBox.width,
    h: Number(height || 0) / sourceHeight * contentBox.height
  };
}

function contentBoxForManifest(manifest, sourceWidth, sourceHeight) {
  const box = manifest.content_box || {};
  if (box.width && box.height) {
    return {
      left: numberValue(box.left, 0),
      top: numberValue(box.top, 0),
      width: numberValue(box.width, 13.333),
      height: numberValue(box.height, 7.5)
    };
  }
  const slide = manifest.slide || {};
  return fitContentBox(sourceWidth, sourceHeight, numberValue(slide.width, 13.333), numberValue(slide.height, 7.5));
}

function fitContentBox(sourceWidth, sourceHeight, slideWidth, slideHeight) {
  const sourceAspect = sourceWidth / sourceHeight;
  const slideAspect = slideWidth / slideHeight;
  if (sourceAspect >= slideAspect) {
    const width = slideWidth;
    const height = width / sourceAspect;
    return { left: 0, top: (slideHeight - height) / 2, width, height };
  }
  const height = slideHeight;
  const width = height * sourceAspect;
  return { left: (slideWidth - width) / 2, top: 0, width, height };
}

function normalizeColor(value) {
  const text = String(value || "").trim();
  if (!text || /^none|transparent$/i.test(text)) return "";
  return text.replace(/^#/, "").toUpperCase();
}

function pptxTextAlign(value) {
  const text = String(value || "").toLowerCase();
  if (text === "ctr" || text === "center") return "center";
  if (text === "r" || text === "right") return "right";
  if (text === "just" || text === "justify") return "justify";
  return "left";
}

function pptxTextValign(value) {
  const text = String(value || "").toLowerCase();
  if (text === "ctr" || text === "mid" || text === "middle") return "mid";
  if (text === "b" || text === "bottom") return "bottom";
  return "top";
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function numberValue(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/openable-manifest-pptx.mjs --manifest <page/manifest.json> --out <page.pptx>
  node scripts/openable-manifest-pptx.mjs --deck-manifest <deck_manifest.json> --out <editable-final.pptx>`);
}
