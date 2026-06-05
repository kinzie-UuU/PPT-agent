import fs from "fs/promises";
import JSZip from "jszip";

const SLIDE_W_EMU = 13.333 * 914400;
const SLIDE_H_EMU = 7.5 * 914400;

export async function inspectEditablePptx(pptxPath) {
  const zip = await JSZip.loadAsync(await fs.readFile(pptxPath));
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b));
  const slides = [];
  for (const name of slideNames) {
    const xml = await zip.files[name].async("text");
    slides.push(inspectSlideXml(xml, slideNumber(name)));
  }
  const totals = slides.reduce((acc, slide) => ({
    nativeTextBoxes: acc.nativeTextBoxes + slide.nativeTextBoxes,
    nativeShapes: acc.nativeShapes + slide.nativeShapes,
    nativePictures: acc.nativePictures + slide.nativePictures,
    fullSlidePictures: acc.fullSlidePictures + slide.fullSlidePictures,
    slidesWithText: acc.slidesWithText + (slide.nativeTextBoxes ? 1 : 0),
    slidesWithShapes: acc.slidesWithShapes + (slide.nativeShapes ? 1 : 0)
  }), { nativeTextBoxes: 0, nativeShapes: 0, nativePictures: 0, fullSlidePictures: 0, slidesWithText: 0, slidesWithShapes: 0 });
  const warnings = [];
  if (!totals.nativeTextBoxes) warnings.push("no-native-text-boxes");
  if (!totals.nativeShapes) warnings.push("no-native-shapes");
  if (totals.fullSlidePictures) warnings.push(`full-slide-picture-risk:${totals.fullSlidePictures}`);
  return {
    version: 1,
    source: "pptx-openxml-inspection",
    status: warnings.length ? "warn" : "pass",
    slideCount: slides.length,
    ...totals,
    editable: totals.nativeTextBoxes > 0 && totals.nativeShapes > 0 && totals.fullSlidePictures === 0,
    checks: {
      nativeTextBoxes: totals.nativeTextBoxes > 0,
      nativeShapes: totals.nativeShapes > 0,
      independentPictures: totals.fullSlidePictures === 0,
      noFullSlideRaster: totals.fullSlidePictures === 0
    },
    warnings,
    slides
  };
}

function inspectSlideXml(xml = "", index = 0) {
  const shapeBlocks = matchBlocks(xml, "p:sp");
  const pictureBlocks = matchBlocks(xml, "p:pic");
  const textShapeBlocks = shapeBlocks.filter((block) => /<a:t>[\s\S]*?<\/a:t>/.test(block));
  const fullSlidePictures = pictureBlocks.filter(isFullSlidePicture).length;
  return {
    index,
    nativeTextBoxes: textShapeBlocks.length,
    nativeShapes: shapeBlocks.length,
    nativePictures: pictureBlocks.length,
    fullSlidePictures,
    textChars: textShapeBlocks.reduce((sum, block) => sum + extractTextChars(block), 0)
  };
}

function matchBlocks(xml, tag) {
  const pattern = new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, "g");
  return xml.match(pattern) || [];
}

function isFullSlidePicture(block = "") {
  const off = block.match(/<a:off[^>]*x="(-?\d+)"[^>]*y="(-?\d+)"/);
  const ext = block.match(/<a:ext[^>]*cx="(\d+)"[^>]*cy="(\d+)"/);
  if (!ext) return false;
  const x = off ? Number(off[1]) : 0;
  const y = off ? Number(off[2]) : 0;
  const cx = Number(ext[1]);
  const cy = Number(ext[2]);
  return Math.abs(x) < 91440 && Math.abs(y) < 91440 && cx >= SLIDE_W_EMU * 0.88 && cy >= SLIDE_H_EMU * 0.88;
}

function extractTextChars(block = "") {
  const texts = [...block.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((match) => decodeXml(match[1]));
  return texts.join("").trim().length;
}

function decodeXml(value = "") {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function slideNumber(name = "") {
  return Number(name.match(/slide(\d+)\.xml/i)?.[1] || 0);
}
