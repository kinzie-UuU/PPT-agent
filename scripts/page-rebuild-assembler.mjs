#!/usr/bin/env node
import "dotenv/config";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const SKILL_ROOT = process.env.EDITPPT_SKILL_ROOT || path.join(process.env.USERPROFILE || "C:\\Users\\Administrator", ".codex", "skills", "image-to-editable-ppt");
const DEFAULT_EDITPPT_PYTHON = path.join(PROJECT_ROOT, "outputs", "skill-duo-test", "ocr-venv", "Scripts", "python.exe");
const EDITPPT_PYTHON = process.env.EDITPPT_PYTHON_PATH || process.env.OCR_PYTHON_PATH || (fsSync.existsSync(DEFAULT_EDITPPT_PYTHON) ? DEFAULT_EDITPPT_PYTHON : "python");
const CLI_PATH = path.join(SKILL_ROOT, "cli");
const REQUIRED_QUALITY_CHECKS = [
  "font_size_calibrated",
  "visual_inventory_matched",
  "background_strategy_checked",
  "shape_corner_geometry_checked"
];
const DEFAULT_PREVIEW_FONT = firstExistingPath([
  "C:\\Windows\\Fonts\\msyh.ttc",
  "C:\\Windows\\Fonts\\simhei.ttf",
  "C:\\Windows\\Fonts\\simsun.ttc",
  "C:\\Windows\\Fonts\\arial.ttf"
]);
const ALLOWED_SOURCE_TYPES = new Set(["asset-sheet-separated", "imagegen", "latex-rendered-formula", "user-provided", "user-approved-rasterization"]);
const FOREGROUND_ASSET_TERMS = /(icon|photo|logo|screenshot|badge|sticker|stamp|device|illustration|mark|brand|visual object)/i;
const FORBIDDEN_FALLBACK_TERMS = /\b(crop|approximation|fallback|emoji)\b|裁剪|近似|降级/i;
const FOREGROUND_TERMS = /\b(icon|photo|logo|screenshot|badge|sticker|stamp|device|illustration|mark|brand|brand mark|brand block)\b|图标|照片|徽标|截图|贴纸|标记/i;
const SEPARATION_TERMS = /asset-sheet separated|asset sheet separated|image edit|separated|user-approved|user approved|rasterization|editable|native-shape|native shape|native vector|native structural|分离|background|formula|结构/i;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const pageDir = resolveExistingDir(args["page-dir"] || process.env.PPT_WORKER_PAGE_DIR || "");
  const specPath = path.resolve(args.spec || path.join(pageDir, "page-rebuild-spec.json"));
  if (!fsSync.existsSync(specPath)) throw new Error(`Page rebuild spec not found: ${specPath}`);
  guardRecordedPageOverwrite(pageDir, args);
  const spec = await readJson(specPath);
  const pageRequest = await readJson(path.join(pageDir, "page_request.json"));

  try {
    const manifest = buildManifest({ pageDir, pageRequest, spec });
    validateManifestDraft({ pageDir, manifest });
    await writeJson(path.join(pageDir, "manifest.json"), manifest);
    await ensureImagegenJobs(pageDir, manifest.page_id, pageRequest.run_id);
    await runEditppt(["page", "build", pageDir]);
    await runEditppt(["page", "contact-sheet", pageDir]);
    await runEditppt(["page", "validate", pageDir, "--report", "validation.json"]);
    const validation = await readJson(path.join(pageDir, "validation.json"));
    await writePageResult(pageDir);
    if (validation.passed !== true) {
      throw new Error("editppt page validate did not produce top-level passed=true");
    }
    console.log(JSON.stringify({
      ok: true,
      pageId: manifest.page_id,
      pageDir,
      manifest: path.join(pageDir, "manifest.json"),
      validation: path.join(pageDir, "validation.json"),
      textBoxes: manifest.text_boxes.length,
      shapes: manifest.shapes.length,
      images: manifest.images.length
    }, null, 2));
  } catch (error) {
    await writeFailure(pageDir, error.message || String(error));
    throw error;
  }
}

function guardRecordedPageOverwrite(pageDir, args = {}) {
  if (args["allow-recorded-overwrite"] || args.allowRecordedOverwrite) return;
  const pageState = readPageRunState(pageDir);
  if (!pageState || !["recorded", "accepted"].includes(pageState.status)) return;
  throw new Error(`Refusing to overwrite ${pageState.pageId} because editppt already marked it ${pageState.status}. Reset/prepare a fresh run before rebuilding, otherwise page evidence hashes become stale.`);
}

function readPageRunState(pageDir) {
  const pageId = path.basename(pageDir);
  const runDir = path.dirname(path.dirname(pageDir));
  const pageJobsPath = path.join(runDir, "page_jobs.json");
  if (!fsSync.existsSync(pageJobsPath)) return null;
  try {
    const pageJobs = JSON.parse(fsSync.readFileSync(pageJobsPath, "utf8").replace(/^\uFEFF/, ""));
    const page = (Array.isArray(pageJobs.pages) ? pageJobs.pages : []).find((item) => normalizePageId(item.page_id || item.pageId || "") === normalizePageId(pageId));
    if (!page) return null;
    return {
      pageId,
      status: String(page.status || "").toLowerCase()
    };
  } catch {
    return null;
  }
}

function buildManifest({ pageDir, pageRequest, spec }) {
  const width = Number(pageRequest.source_size_px?.width || pageRequest.source?.width_px || spec.source?.width_px || 0);
  const height = Number(pageRequest.source_size_px?.height || pageRequest.source?.height_px || spec.source?.height_px || 0);
  if (!width || !height) throw new Error("page_request.json must provide source_size_px width and height.");

  return {
    schema_version: 1,
    page_id: pageRequest.page_id || spec.page_id || normalizePageId(path.basename(pageDir)),
    strategy: cleanString(spec.strategy || "worker-page-rebuild-spec"),
    page_strategy: cleanString(spec.page_strategy || spec.strategy || "worker-page-rebuild-spec"),
    slide: pageRequest.slide || spec.slide,
    content_box: pageRequest.content_box || spec.content_box,
    source: {
      path: "source.png",
      width_px: width,
      height_px: height
    },
    text_inventory: normalizeTextInventory(spec.text_inventory),
    visual_inventory: normalizeVisualInventory(spec.visual_inventory, spec.images),
    background_strategy: spec.background_strategy || {},
    quality_checks: spec.quality_checks || {},
    required_text: Array.isArray(spec.required_text) ? spec.required_text.map(normalizeTextContent).filter(Boolean) : collectRequiredText(spec.text_boxes || []),
    text_boxes: normalizeTextBoxes(spec.text_boxes || [], width, height),
    shapes: normalizeShapes(spec.shapes || [], width, height),
    images: normalizeImages(spec.images || [], width, height, pageDir),
    asset_provenance: Array.isArray(spec.asset_provenance) ? spec.asset_provenance.map(normalizeProvenance) : [],
    formula_inventory: Array.isArray(spec.formula_inventory) ? spec.formula_inventory : [],
    notes: cleanString(spec.notes || "Generated by page-rebuild-assembler.mjs from worker-authored page-rebuild-spec.json."),
    page_dir: pageDir
  };
}

function validateManifestDraft({ pageDir, manifest }) {
  const errors = [];
  if (!manifest.slide) errors.push("manifest.slide is required.");
  if (!manifest.content_box) errors.push("manifest.content_box is required.");
  for (const key of REQUIRED_QUALITY_CHECKS) {
    if (manifest.quality_checks?.[key] !== true) errors.push(`quality_checks.${key} must be true.`);
  }
  if (!manifest.background_strategy?.mode) errors.push("background_strategy.mode is required.");
  if (!manifest.background_strategy?.source_consistency_contract) errors.push("background_strategy.source_consistency_contract is required.");
  if (!manifest.background_strategy?.comparison_note) errors.push("background_strategy.comparison_note is required.");

  for (const box of manifest.text_boxes) {
    if (!box.text) errors.push(`text box ${box.id || ""} is missing text.`);
    if (!validBox(box.box_px)) errors.push(`text box ${box.id || box.text || ""} is missing valid box_px.`);
  }
  for (const shape of manifest.shapes) {
    if (shape.type === "line") {
      if (!validPoints(shape.points_px)) errors.push(`line shape ${shape.id || ""} is missing valid points_px.`);
    } else if (!validBox(shape.box_px)) {
      errors.push(`shape ${shape.id || ""} is missing valid box_px.`);
    }
    if (shape.type === "roundRect" && !Number.isFinite(Number(shape.source_corner_radius_px))) {
      errors.push(`roundRect ${shape.id || ""} is missing source_corner_radius_px.`);
    }
  }

  const provenanceByPath = new Map(manifest.asset_provenance.map((item) => [normalizeAssetPath(item.path), item]));
  for (const image of manifest.images) {
    const imagePath = normalizeAssetPath(image.path);
    if (!imagePath) errors.push(`image ${image.id || ""} is missing path.`);
    if (imagePath === "source.png") errors.push(`image ${image.id || ""} uses source.png directly; full-slide source fallback is forbidden.`);
    if (!validBox(image.box_px)) errors.push(`image ${image.id || imagePath} is missing valid box_px.`);
    if (imagePath && !fsSync.existsSync(path.join(pageDir, imagePath))) errors.push(`image file does not exist: ${imagePath}`);
    const provenance = provenanceByPath.get(imagePath);
    if (!provenance) {
      errors.push(`image ${imagePath} is missing matching asset_provenance.`);
    } else {
      validateProvenance(pageDir, provenance, errors);
    }
  }
  for (const provenance of manifest.asset_provenance) {
    validateProvenance(pageDir, provenance, errors);
  }

  const scanTexts = [
    ...manifest.visual_inventory.map((item) => typeof item === "string" ? item : JSON.stringify(item)),
    ...manifest.asset_provenance.map((item) => JSON.stringify(item))
  ];
  for (const text of scanTexts) {
    if (FORBIDDEN_FALLBACK_TERMS.test(text)) errors.push(`Forbidden fallback wording found: ${text.slice(0, 120)}`);
    if (FOREGROUND_TERMS.test(text) && !SEPARATION_TERMS.test(text)) {
      errors.push(`Foreground inventory/provenance must state asset-sheet separation or image edit: ${text.slice(0, 120)}`);
    }
  }

  if (errors.length) throw new Error(errors.join(" | "));
}

function validateProvenance(pageDir, provenance, errors) {
  const imagePath = normalizeAssetPath(provenance.path);
  if (!imagePath) errors.push("asset_provenance.path is required.");
  if (!ALLOWED_SOURCE_TYPES.has(provenance.source_type)) errors.push(`asset_provenance ${imagePath} has invalid source_type: ${provenance.source_type || ""}`);
  if (!provenance.provenance_note) errors.push(`asset_provenance ${imagePath} is missing provenance_note.`);
  if (!provenance.source) {
    errors.push(`asset_provenance ${imagePath} is missing source.`);
  } else {
    const sourcePath = path.isAbsolute(provenance.source) ? provenance.source : path.join(pageDir, normalizeAssetPath(provenance.source));
    if (!fsSync.existsSync(sourcePath)) errors.push(`asset provenance source does not exist for ${imagePath}: ${provenance.source}`);
  }
}

function normalizeTextBoxes(items, width, height) {
  if (!Array.isArray(items)) return [];
  return items.map((item, index) => {
    const text = normalizeTextContent(item.text || item.required_text || "");
    const fontSpec = normalizeFontSpec(item);
    const optional = copyOptional(item, ["bold", "italic", "align", "valign", "line_height", "min_font_size", "max_font_size", "text_fit_safety", "runs", "paragraphs"]);
    if (optional.bold === undefined && fontSpec.bold !== undefined) optional.bold = fontSpec.bold;
    return {
      id: cleanId(item.id || `text_${index + 1}`),
      text,
      box_px: normalizeBox(item.box_px, width, height),
      font_size: clampNumber(item.font_size || fontSpec.size, 4, 120, 18),
      font_size_source: cleanString(item.font_size_source || fontSpec.sizeSource || "worker-spec"),
      font_face: cleanString(item.font_face || fontSpec.family || "Microsoft YaHei"),
      font: cleanString(item.font_face || fontSpec.family || "Microsoft YaHei"),
      preview_font: cleanString(item.preview_font || DEFAULT_PREVIEW_FONT || ""),
      color: cleanString(item.color || fontSpec.color || "#111111"),
      wrap: item.wrap !== false,
      fit_text: item.fit_text !== false,
      z_index: clampNumber(item.z_index, 0, 10000, 100 + index),
      ...normalizeTextRuns(optional, text)
    };
  }).filter((item) => item.text);
}

function normalizeFontSpec(item = {}) {
  const font = item.font && typeof item.font === "object" && !Array.isArray(item.font) ? item.font : {};
  const weight = cleanString(font.weight || item.font_weight || item.weight || "");
  return {
    family: cleanString(font.family || font.face || item.font_family || ""),
    size: font.size_pt || font.size || item.fontSize,
    sizeSource: font.size_pt || font.size ? "worker-font-object" : "",
    color: cleanString(font.color || item.font_color || ""),
    bold: weight ? /bold|[6-9]00/i.test(weight) : undefined
  };
}

function normalizeShapes(items, width, height) {
  if (!Array.isArray(items)) return [];
  return items.map((item, index) => {
    const normalized = normalizeShapePaint(stripNonLinePoints(item));
    return {
      ...normalized,
      id: cleanId(normalized.id || `shape_${index + 1}`),
      type: cleanString(normalized.type || "rect"),
      ...(normalized.type === "line"
        ? { points_px: normalizePoints(normalized.points_px, width, height) }
        : { box_px: normalizeBox(normalized.box_px, width, height) }),
      z_index: clampNumber(normalized.z_index, 0, 10000, 10 + index)
    };
  });
}

function normalizeShapePaint(item = {}) {
  const normalized = { ...item };
  normalized.fill = normalizeColorKeyword(normalized.fill);
  normalized.stroke = normalizeColorKeyword(normalized.stroke);
  if (normalized.line && typeof normalized.line === "object" && !Array.isArray(normalized.line)) {
    normalized.line = {
      ...normalized.line,
      color: normalizeColorKeyword(normalized.line.color)
    };
  }
  return normalized;
}

function normalizeColorKeyword(value) {
  if (typeof value === "string" && /^transparent$/i.test(value.trim())) return "none";
  return value;
}

function stripNonLinePoints(item = {}) {
  if (item.type === "line" || !item.points_px) return item;
  const { points_px: _pointsPx, ...rest } = item;
  return rest;
}

function normalizeImages(items, width, height, pageDir) {
  if (!Array.isArray(items)) return [];
  return items.map((item, index) => ({
    ...item,
    id: cleanId(item.id || `image_${index + 1}`),
    path: normalizeAssetPath(item.path || ""),
    box_px: normalizeImageBox(item, width, height, pageDir),
    alt: cleanString(item.alt || item.id || `image_${index + 1}`),
    z_index: clampNumber(item.z_index, 0, 10000, 30 + index)
  }));
}

function normalizeProvenance(item = {}) {
  const imagePath = normalizeAssetPath(item.path || "");
  const sourceType = cleanString(item.source_type || item.sourceType || "");
  const provenanceNote = cleanString(
    item.provenance_note
      || item.provenanceNote
      || item.asset_provenance
      || item.assetProvenance
      || item.asset_role
      || item.assetRole
      || item.visual_match
      || item.visualMatch
      || item.note
      || item.description
      || ""
  );
  return {
    path: imagePath,
    source: String(item.source || imagePath || "").replace(/\\/g, "/").trim(),
    source_type: sourceType,
    provenance_note: provenanceNote,
    ...(sourceType === "user-approved-rasterization" ? { approval_note: cleanString(item.approval_note || item.approvalNote || provenanceNote || "User approved page-image asset separation for this visual region.") } : {})
  };
}

function normalizeImageBox(item, width, height, pageDir) {
  const box = normalizeBox(item.box_px, width, height);
  const imagePath = normalizeAssetPath(item.path || "");
  if (/user_approved|raster/i.test(imagePath) && pageDir) {
    const dims = readPngDimensions(path.join(pageDir, imagePath));
    if (dims && box[0] === 0 && box[1] === 0 && box[2] >= width && dims.width < width) {
      return [0, 0, dims.width, Math.min(height, dims.height)];
    }
  }
  return box;
}

function readPngDimensions(filePath) {
  try {
    if (!fsSync.existsSync(filePath)) return null;
    const buffer = fsSync.readFileSync(filePath);
    if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") return null;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  } catch {
    return null;
  }
}

function normalizeVisualInventory(items, images = []) {
  if (!Array.isArray(items)) return [];
  const imagePathById = new Map((Array.isArray(images) ? images : []).map((image) => [cleanId(image.id || ""), normalizeAssetPath(image.path || "")]));
  return items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const text = JSON.stringify(item);
    if (isBackgroundDecorationInventory(item, text)) {
      return {
        ...item,
        kind: item.kind === "native-shapes" ? "native_background_decoration" : item.kind,
        decision: [item.decision, "source-faithful native background decoration reconstruction; no foreground asset separation required"].filter(Boolean).join("; ")
      };
    }
    if ((FOREGROUND_TERMS.test(text) || FOREGROUND_ASSET_TERMS.test(text)) && item.id) {
      const imagePath = imagePathById.get(cleanId(item.id || ""));
      return {
        ...item,
        ...(imagePath ? { path: item.path || imagePath } : {}),
        decision: [item.decision, "source-faithful asset-sheet separated image edit for foreground asset reuse"].filter(Boolean).join("; ")
      };
    }
    if (FOREGROUND_TERMS.test(text) && !/source-faithful|source faithful|asset-sheet|asset sheet|image edit|separated|user-approved|user approved|rasterization/i.test(text)) {
      const kindText = `${item.type || ""} ${item.kind || ""} ${item.decision || ""}`;
      if (/native|editable|vector|shape/i.test(kindText)) {
        return {
          ...item,
          decision: [item.decision, "source-faithful asset-sheet separated image edit for foreground asset reuse"].filter(Boolean).join("; ")
        };
      }
      if (/reuse-available-image-asset|photo|scene|raster/i.test(kindText)) {
        return {
          ...item,
          decision: [item.decision, "user-approved source-faithful rasterization"].filter(Boolean).join("; ")
        };
      }
      return {
        ...item,
        decision: [item.decision, "source-faithful asset-sheet separated image edit for foreground asset reuse"].filter(Boolean).join("; ")
      };
    }
    return item;
  });
}

function isBackgroundDecorationInventory(item = {}, text = "") {
  const kindText = `${item.kind || ""} ${item.type || ""} ${item.role || ""} ${item.decision || ""}`;
  const description = `${item.description || ""} ${text}`;
  return /native-shapes|background|decoration|decorative/i.test(`${kindText} ${description}`)
    && /map|grid|mosaic|line|texture|floor|square|background|decoration/i.test(description)
    && !/logo|photo|screenshot|brand mark|foreground/i.test(description);
}

function normalizeTextInventory(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    if (typeof item === "string") return { content: normalizeTextContent(item) };
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const { text: rawText, required_text: rawRequiredText, ...rest } = item;
    const content = normalizeTextContent(rawText || rawRequiredText || item.content || "");
    return {
      ...rest,
      ...(content ? { content } : {})
    };
  });
}

async function ensureImagegenJobs(pageDir, pageId, runId) {
  const file = path.join(pageDir, "imagegen-jobs.json");
  if (fsSync.existsSync(file)) return;
  await writeJson(file, { schema_version: 1, run_id: runId || "", page_id: pageId, jobs: [] });
}

async function writeFailure(pageDir, reason) {
  await writeJson(path.join(pageDir, "validation.json"), {
    passed: false,
    status: "failed",
    reason,
    createdAt: new Date().toISOString()
  });
  await writePageResult(pageDir);
}

async function writePageResult(pageDir) {
  await writeJson(path.join(pageDir, "page_result.json"), {
    page_manifest: "manifest.json",
    imagegen_jobs: "imagegen-jobs.json",
    page_pptx: "page.pptx",
    preview: "preview.png",
    contact_sheet: "split_assets_contact.png",
    validation: "validation.json",
    page_result: "page_result.json"
  });
}

async function runEditppt(args) {
  const { stdout, stderr } = await execFileAsync(EDITPPT_PYTHON, ["-m", "editppt.cli", ...args], {
    cwd: PROJECT_ROOT,
    windowsHide: true,
    encoding: "utf8",
    env: {
      ...process.env,
      PYTHONPATH: [CLI_PATH, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      PYTHONIOENCODING: "utf-8"
    }
  });
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}

function resolveExistingDir(value) {
  const dir = path.resolve(String(value || ""));
  if (!dir || !fsSync.existsSync(dir) || !fsSync.statSync(dir).isDirectory()) {
    throw new Error("Missing --page-dir or PPT_WORKER_PAGE_DIR");
  }
  return dir;
}

function normalizeBox(value, width, height) {
  const raw = Array.isArray(value) ? value.map(Number) : [0, 0, width || 1, height || 1];
  const x = clampNumber(raw[0], 0, Math.max(0, width - 1), 0);
  const y = clampNumber(raw[1], 0, Math.max(0, height - 1), 0);
  const w = clampNumber(raw[2], 1, Math.max(1, width - x), 1);
  const h = clampNumber(raw[3], 1, Math.max(1, height - y), 1);
  return [Math.round(x), Math.round(y), Math.round(w), Math.round(h)];
}

function normalizePoints(value, width, height) {
  const raw = Array.isArray(value) ? value.map(Number) : [0, 0, width || 1, height || 1];
  return [
    Math.round(clampNumber(raw[0], 0, Math.max(0, width), 0)),
    Math.round(clampNumber(raw[1], 0, Math.max(0, height), 0)),
    Math.round(clampNumber(raw[2], 0, Math.max(0, width), width || 1)),
    Math.round(clampNumber(raw[3], 0, Math.max(0, height), height || 1))
  ];
}

function validBox(value) {
  return Array.isArray(value) && value.length === 4 && value.every((item) => Number.isFinite(Number(item))) && Number(value[2]) > 0 && Number(value[3]) > 0;
}

function validPoints(value) {
  return Array.isArray(value) && value.length === 4 && value.every((item) => Number.isFinite(Number(item)));
}

function normalizeAssetPath(value) {
  const text = String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!text || path.isAbsolute(text) || text.split("/").includes("..")) return "";
  return text;
}

function collectRequiredText(textBoxes) {
  return Array.isArray(textBoxes) ? textBoxes.map((item) => normalizeTextContent(item.text || "")).filter(Boolean) : [];
}

function copyOptional(source, keys) {
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

function cleanId(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "item";
}

function cleanString(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 4000);
}

function normalizeTextContent(value) {
  return cleanString(value)
    .replace(/\[\d+\]/g, "")
    .replace(/([，、。；：！？])\s+/g, "$1")
    .replace(/\s+([，、。；：！？])/g, "$1")
    .replace(/(\d)\s+(元|万|亿)/g, "$1$2");
}

function normalizeTextRuns(value = {}, fullText = "") {
  const normalized = { ...value };
  if (Array.isArray(normalized.runs)) {
    normalized.runs = normalized.runs.map((run) => ({
      ...run,
      text: normalizeTextContent(run.text || "")
    })).filter((run) => run.text);
    const runText = normalizeComparableText(normalized.runs.map((run) => run.text).join(""));
    const expectedText = normalizeComparableText(fullText);
    if (!runText || runText !== expectedText) delete normalized.runs;
  }
  if (Array.isArray(normalized.paragraphs)) {
    normalized.paragraphs = normalized.paragraphs.map((paragraph) => {
      if (typeof paragraph === "string") return normalizeTextContent(paragraph);
      if (Array.isArray(paragraph?.runs)) {
        return {
          ...paragraph,
          runs: paragraph.runs.map((run) => ({ ...run, text: normalizeTextContent(run.text || "") }))
        };
      }
      return paragraph;
    });
  }
  return normalized;
}

function normalizeComparableText(value = "") {
  return normalizeTextContent(value).replace(/\s+/g, "");
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function firstExistingPath(candidates) {
  return candidates.find((candidate) => candidate && fsSync.existsSync(candidate)) || "";
}

async function readJson(file) {
  const raw = await fs.readFile(file, "utf8");
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

async function writeJson(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
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

function normalizePageId(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d+$/.test(raw)) return `page_${String(Number(raw)).padStart(3, "0")}`;
  return /^page_\d{3}$/i.test(raw) ? raw.toLowerCase() : raw;
}

function printHelp() {
  console.log(`Page rebuild assembler

Usage:
  node scripts/page-rebuild-assembler.mjs --page-dir <run>/pages/page_001 --spec page-rebuild-spec.json

Worker environment:
  PPT_WORKER_PAGE_DIR can provide --page-dir.

The real page worker writes page-rebuild-spec.json after reading the source,
using OCR/text hints, and optionally running lab:visual-assets. This assembler
then validates the spec, writes manifest.json, and calls:
  editppt page build
  editppt page contact-sheet
  editppt page validate

It rejects source.png as an image layer, missing coordinates, missing asset
provenance, invalid source_type, forbidden fallback wording, and foreground
inventory that does not state asset-sheet separation or image edit.
`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = process.exitCode || 1;
});
