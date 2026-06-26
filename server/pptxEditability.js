import fs from "fs/promises";
import fsSync from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import JSZip from "jszip";

const SLIDE_W_EMU = 13.333 * 914400;
const SLIDE_H_EMU = 7.5 * 914400;
const execFileAsync = promisify(execFile);

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
    rasterOnlySlides: acc.rasterOnlySlides + (slide.rasterOnly ? 1 : 0),
    rasterBackgroundSlides: acc.rasterBackgroundSlides + (slide.rasterBackground ? 1 : 0),
    slidesWithText: acc.slidesWithText + (slide.nativeTextBoxes ? 1 : 0),
    slidesWithShapes: acc.slidesWithShapes + (slide.nativeShapes ? 1 : 0)
  }), { nativeTextBoxes: 0, nativeShapes: 0, nativePictures: 0, fullSlidePictures: 0, rasterOnlySlides: 0, rasterBackgroundSlides: 0, slidesWithText: 0, slidesWithShapes: 0 });
  const warnings = [];
  if (!totals.nativeTextBoxes) warnings.push("no-native-text-boxes");
  if (!totals.nativeShapes) warnings.push("no-native-shapes");
  if (totals.rasterOnlySlides) warnings.push(`full-slide-raster-only-risk:${totals.rasterOnlySlides}`);
  if (totals.rasterBackgroundSlides) warnings.push(`full-slide-background-picture:${totals.rasterBackgroundSlides}`);
  return {
    version: 1,
    source: "pptx-openxml-inspection",
    status: warnings.length ? "warn" : "pass",
    slideCount: slides.length,
    ...totals,
    editable: totals.nativeTextBoxes > 0 && totals.nativeShapes > 0 && totals.rasterOnlySlides === 0,
    checks: {
      nativeTextBoxes: totals.nativeTextBoxes > 0,
      nativeShapes: totals.nativeShapes > 0,
      independentPictures: totals.rasterOnlySlides === 0,
      noFullSlideRaster: totals.rasterOnlySlides === 0
    },
    warnings,
    slides
  };
}

export async function inspectPowerPointOpenability(pptxPath, options = {}) {
  const timeoutMs = clampInteger(options.timeoutMs, 5000, 120000, 60000);
  const resolved = String(pptxPath || "");
  if (!resolved || !fsSync.existsSync(resolved)) {
    return {
      version: 1,
      source: "powerpoint-com-open",
      available: process.platform === "win32",
      openable: false,
      slideCount: 0,
      warnings: ["pptx-file-missing"],
      error: "PPTX file does not exist"
    };
  }
  if (process.platform !== "win32") {
    return {
      version: 1,
      source: "powerpoint-com-open",
      available: false,
      openable: null,
      slideCount: 0,
      warnings: ["powerpoint-com-unavailable"],
      error: "PowerPoint COM open check is only available on Windows"
    };
  }

  const command = [
    "$ErrorActionPreference='Stop'",
    "$ppt=$env:PPTX_OPEN_PATH",
    "$app=$null",
    "$pres=$null",
    "try {",
    "  $app=New-Object -ComObject PowerPoint.Application",
    "  $app.Visible=[Microsoft.Office.Core.MsoTriState]::msoTrue",
    "  $pres=$app.Presentations.Open($ppt,[Microsoft.Office.Core.MsoTriState]::msoFalse,[Microsoft.Office.Core.MsoTriState]::msoFalse,[Microsoft.Office.Core.MsoTriState]::msoFalse)",
    "  $result=@{ok=$true;openable=$true;slideCount=$pres.Slides.Count;error=''}",
    "} catch {",
    "  $hresult=('0x{0:X8}' -f ($_.Exception.HResult -band 0xffffffff))",
    "  $result=@{ok=$true;openable=$false;slideCount=0;error=('PowerPoint could not open PPTX (' + $hresult + ')')}",
    "} finally {",
    "  if ($pres -ne $null) { try { $pres.Close() } catch {} }",
    "  if ($app -ne $null) { try { $app.Quit() } catch {} }",
    "}",
    "$result | ConvertTo-Json -Compress"
  ].join("; ");

  try {
    const { stdout, stderr } = await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
      windowsHide: true,
      timeout: timeoutMs,
      encoding: "utf8",
      env: {
        ...process.env,
        PPTX_OPEN_PATH: resolved
      }
    });
    const result = JSON.parse(String(stdout || "{}"));
    const openable = result.openable === true;
    return {
      version: 1,
      source: "powerpoint-com-open",
      available: true,
      openable,
      slideCount: Number(result.slideCount || 0),
      warnings: openable ? [] : ["powerpoint-open-failed"],
      error: openable ? "" : String(result.error || stderr || "PowerPoint failed to open PPTX")
    };
  } catch (error) {
    return {
      version: 1,
      source: "powerpoint-com-open",
      available: true,
      openable: false,
      slideCount: 0,
      warnings: ["powerpoint-open-check-failed"],
      error: error.message || "PowerPoint open check failed"
    };
  }
}

function inspectSlideXml(xml = "", index = 0) {
  const shapeBlocks = matchBlocks(xml, "p:sp");
  const pictureBlocks = matchBlocks(xml, "p:pic");
  const textShapeBlocks = shapeBlocks.filter((block) => /<a:t>[\s\S]*?<\/a:t>/.test(block));
  const fullSlidePictures = pictureBlocks.filter(isFullSlidePicture).length;
  const rasterOnly = fullSlidePictures > 0 && textShapeBlocks.length === 0 && shapeBlocks.length <= fullSlidePictures;
  const rasterBackground = fullSlidePictures > 0 && !rasterOnly;
  return {
    index,
    nativeTextBoxes: textShapeBlocks.length,
    nativeShapes: shapeBlocks.length,
    nativePictures: pictureBlocks.length,
    fullSlidePictures,
    rasterOnly,
    rasterBackground,
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

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}
