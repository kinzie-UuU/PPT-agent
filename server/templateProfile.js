import fs from "fs/promises";
import path from "path";
import JSZip from "jszip";

const EMU_PER_INCH = 914400;

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function decodeXml(value = "") {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function attrs(xml = "") {
  const result = {};
  for (const match of String(xml || "").matchAll(/\b([A-Za-z0-9:_-]+)="([^"]*)"/g)) {
    result[match[1]] = decodeXml(match[2]);
  }
  return result;
}

function blocks(xml = "", tag) {
  const escaped = tag.replace(":", "\\:");
  const pattern = new RegExp(`<${escaped}\\b[\\s\\S]*?<\\/${escaped}>`, "g");
  return [...String(xml || "").matchAll(pattern)].map((match) => match[0]);
}

function round(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function emuToInch(value) {
  return Number(value || 0) / EMU_PER_INCH;
}

function extractTransform(xml = "") {
  const off = xml.match(/<a:off\b([^>]*)\/>/)?.[1] || "";
  const ext = xml.match(/<a:ext\b([^>]*)\/>/)?.[1] || "";
  const offAttrs = attrs(off);
  const extAttrs = attrs(ext);
  return {
    x: round(emuToInch(offAttrs.x)),
    y: round(emuToInch(offAttrs.y)),
    w: round(emuToInch(extAttrs.cx)),
    h: round(emuToInch(extAttrs.cy))
  };
}

function extractText(xml = "") {
  return cleanText([...String(xml || "").matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map((match) => decodeXml(match[1])).join(" "));
}

function relsFromXml(xml = "") {
  return [...String(xml || "").matchAll(/<Relationship\b([^>]*)\/?>/g)].map((match) => {
    const rel = attrs(match[1] || "");
    return {
      id: rel.Id || "",
      type: rel.Type || "",
      target: rel.Target || "",
      targetMode: rel.TargetMode || ""
    };
  }).filter((rel) => rel.id && rel.target);
}

function readRelationMap(xml = "") {
  return new Map(relsFromXml(xml).map((rel) => [rel.id, rel]));
}

function resolveTarget(basePath, target = "") {
  if (!target || /^https?:\/\//i.test(target)) return target;
  return path.posix.normalize(path.posix.join(path.posix.dirname(basePath), target));
}

async function readZipText(zip, name) {
  return zip.file(name)?.async("string") || "";
}

function relationshipPath(partPath) {
  return path.posix.join(path.posix.dirname(partPath), "_rels", `${path.posix.basename(partPath)}.rels`);
}

function parseSlideIds(presentationXml = "", presentationRels = new Map()) {
  return [...presentationXml.matchAll(/<p:sldId\b([^>]*)\/>/g)].map((match, index) => {
    const a = attrs(match[1] || "");
    const rel = presentationRels.get(a["r:id"]);
    return {
      slide: index + 1,
      id: a.id || "",
      relId: a["r:id"] || "",
      path: rel ? resolveTarget("ppt/presentation.xml", rel.target) : ""
    };
  }).filter((slide) => slide.path);
}

function parseLayoutName(xml = "", fallback = "") {
  const cSldAttrs = attrs(xml.match(/<p:cSld\b([^>]*)>/)?.[1] || "");
  return cleanText(cSldAttrs.name || "") || fallback;
}

function parsePlaceholders(xml = "") {
  return [...blocks(xml, "p:sp"), ...blocks(xml, "p:pic")].map((block, index) => {
    const phAttrs = attrs(block.match(/<p:ph\b([^>]*)\/>/)?.[1] || "");
    if (!Object.keys(phAttrs).length) return null;
    return {
      id: `${phAttrs.type || "body"}-${phAttrs.idx || index}`,
      type: phAttrs.type || "body",
      idx: phAttrs.idx || null,
      size: phAttrs.sz || null,
      text: extractText(block).slice(0, 80),
      ...extractTransform(block)
    };
  }).filter(Boolean);
}

function classifyLayout(placeholders = [], slideUseCount = 0) {
  const types = new Set(placeholders.map((item) => item.type));
  const hasTitle = types.has("title") || types.has("ctrTitle");
  const hasBody = types.has("body") || types.has("subTitle") || types.has("obj");
  const imageLike = placeholders.filter((item) => ["pic", "media", "clipArt"].includes(item.type)).length;
  if (types.has("sldNum") && placeholders.length <= 2) return "system";
  if (types.has("ctrTitle") && !hasBody) return "cover";
  if (imageLike && hasTitle) return "visual";
  if (hasTitle && hasBody && placeholders.length >= 3) return "structured";
  if (hasTitle && slideUseCount > 0) return "title-content";
  return slideUseCount > 0 ? "used-custom" : "unused-custom";
}

async function analyzeSlides(zip, presentationXml, presentationRels) {
  const slides = [];
  for (const slide of parseSlideIds(presentationXml, presentationRels)) {
    const slideXml = await readZipText(zip, slide.path);
    const slideRels = readRelationMap(await readZipText(zip, relationshipPath(slide.path)));
    const layoutRel = [...slideRels.values()].find((rel) => /\/slideLayout$/i.test(rel.type));
    const layoutPath = layoutRel ? resolveTarget(slide.path, layoutRel.target) : "";
    slides.push({
      slide: slide.slide,
      path: slide.path,
      layoutPath,
      textChars: extractText(slideXml).length,
      imageCount: blocks(slideXml, "p:pic").length,
      shapeCount: blocks(slideXml, "p:sp").length
    });
  }
  return slides;
}

async function analyzeLayouts(zip, slides = []) {
  const slideUse = slides.reduce((map, slide) => {
    if (slide.layoutPath) map.set(slide.layoutPath, (map.get(slide.layoutPath) || 0) + 1);
    return map;
  }, new Map());
  const layoutFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slideLayout(\d+)/)?.[1] || 0) - Number(b.match(/slideLayout(\d+)/)?.[1] || 0));
  const layouts = [];
  for (const name of layoutFiles) {
    const xml = await readZipText(zip, name);
    const placeholders = parsePlaceholders(xml);
    const usedBy = slides.filter((slide) => slide.layoutPath === name).map((slide) => slide.slide);
    layouts.push({
      id: path.posix.basename(name, ".xml"),
      path: name,
      name: parseLayoutName(xml, path.posix.basename(name, ".xml")),
      useCount: slideUse.get(name) || 0,
      usedBy: usedBy.slice(0, 40),
      placeholderCount: placeholders.length,
      placeholders: placeholders.slice(0, 16),
      role: classifyLayout(placeholders, slideUse.get(name) || 0)
    });
  }
  return layouts;
}

function buildWarnings(layouts = [], slides = []) {
  const usedLayouts = layouts.filter((layout) => layout.useCount > 0);
  return [
    !layouts.length ? "no-slide-layouts-detected" : "",
    slides.length && !usedLayouts.length ? "slides-without-layout-links" : "",
    usedLayouts.some((layout) => layout.placeholderCount === 0) ? "used-layout-without-placeholders" : "",
    layouts.length > 20 ? "many-layouts-review-template-noise" : ""
  ].filter(Boolean);
}

export async function analyzePptxTemplate(file) {
  const ext = path.extname(file?.originalName || file?.path || "").toLowerCase();
  if (!file?.path || ext !== ".pptx") return null;
  const buffer = await fs.readFile(file.path);
  const zip = await JSZip.loadAsync(buffer);
  const presentationXml = await readZipText(zip, "ppt/presentation.xml");
  const presentationRels = readRelationMap(await readZipText(zip, "ppt/_rels/presentation.xml.rels"));
  const slides = await analyzeSlides(zip, presentationXml, presentationRels);
  const layouts = await analyzeLayouts(zip, slides);
  const usedLayouts = layouts.filter((layout) => layout.useCount > 0);
  return {
    version: 1,
    deckName: file.originalName || path.basename(file.path),
    slideCount: slides.length,
    layoutCount: layouts.length,
    usedLayoutCount: usedLayouts.length,
    reusableLayoutCount: layouts.filter((layout) => layout.placeholderCount > 0 && layout.role !== "system").length,
    warnings: buildWarnings(layouts, slides),
    slides: slides.slice(0, 80),
    layouts
  };
}

export function compactTemplateProfile(profile) {
  if (!profile) return null;
  return {
    version: profile.version,
    deckName: profile.deckName,
    slideCount: profile.slideCount,
    layoutCount: profile.layoutCount,
    usedLayoutCount: profile.usedLayoutCount,
    reusableLayoutCount: profile.reusableLayoutCount,
    warnings: profile.warnings || [],
    slides: (profile.slides || []).map((slide) => ({
      slide: slide.slide,
      layoutPath: slide.layoutPath,
      textChars: slide.textChars,
      imageCount: slide.imageCount,
      shapeCount: slide.shapeCount
    })),
    layouts: (profile.layouts || []).map((layout) => ({
      id: layout.id,
      name: layout.name,
      path: layout.path,
      role: layout.role,
      useCount: layout.useCount,
      usedBy: layout.usedBy || [],
      placeholderCount: layout.placeholderCount,
      placeholders: (layout.placeholders || []).map((item) => ({
        type: item.type,
        idx: item.idx,
        size: item.size,
        x: item.x,
        y: item.y,
        w: item.w,
        h: item.h,
        text: item.text
      }))
    }))
  };
}
