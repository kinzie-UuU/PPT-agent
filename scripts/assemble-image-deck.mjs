import fs from "fs";
import path from "path";
import PptxGenJS from "pptxgenjs";

const deckDir = process.argv[2];
const outName = process.argv[3] || "image-deck.pptx";

if (!deckDir) {
  console.error("Usage: node scripts/assemble-image-deck.mjs <deckDir> [outName]");
  process.exit(1);
}

const absDeckDir = path.resolve(deckDir);
const originDir = path.join(absDeckDir, "origin_image");
const speechPath = path.join(absDeckDir, "speech.md");
const outPath = path.join(absDeckDir, outName);

if (!fs.existsSync(originDir)) {
  console.error(`Missing origin_image directory: ${originDir}`);
  process.exit(1);
}

const slideImages = fs
  .readdirSync(originDir)
  .filter((name) => /^slide_\d{2}\.png$/i.test(name))
  .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

if (!slideImages.length) {
  console.error(`No slide_XX.png files found in ${originDir}`);
  process.exit(1);
}

const notes = new Map();
if (fs.existsSync(speechPath)) {
  const speech = fs.readFileSync(speechPath, "utf8");
  const chunks = speech.split(/^## Slide\s+(\d+):[^\n]*\n/gm);
  for (let i = 1; i < chunks.length; i += 2) {
    notes.set(Number(chunks[i]), chunks[i + 1].trim());
  }
}

const pptx = new PptxGenJS();
pptx.layout = "LAYOUT_WIDE";
pptx.author = "Codex PPT Director";
pptx.company = "OpenAI";
pptx.subject = "Image-based PPT deck";
pptx.title = path.basename(outName, path.extname(outName));
pptx.lang = "zh-CN";

for (const imageName of slideImages) {
  const slideNo = Number(imageName.match(/\d+/)[0]);
  const slide = pptx.addSlide();
  slide.background = { color: "FFFFFF" };
  slide.addImage({
    path: path.join(originDir, imageName),
    x: 0,
    y: 0,
    w: 13.333,
    h: 7.5
  });
  const note = notes.get(slideNo);
  if (note) slide.addNotes(note);
}

await pptx.writeFile({ fileName: outPath });
console.log(outPath);
