#!/usr/bin/env node
import fsSync from "fs";
import path from "path";

const FORBIDDEN_WORDS = [
  [/\bcropped\b/gi, "bounded"],
  [/\bcrop\b/gi, "separated region"],
  [/\bapproximation\b/gi, "reconstruction"],
  [/\bapproximated\b/gi, "reconstructed"]
];

const FOREGROUND_RE = /foreground|product|photo|image|logo|brand|package|packaging|screenshot|illustration|artwork|asset|图|包装|产品|照片|标识|素材/i;
const STRUCTURAL_RE = /native shape|native-shape|shape|line|table|text|background grid|structural/i;
const ASSET_NOTE = "asset-sheet-separated source-faithful separated asset";
const RECOVERY_BLOCKER_RE = /--no-image|\bno-image\b|text-only-ocr-spec|\bfallback\b|requires visual pass before production|requires product visual review|failed pass|requires-asset-separation|intentionally fails pass|omitted unavailable generated image assets/i;
const OMITTED_ASSETS_RE = /Omitted unavailable generated image assets:\s*([a-zA-Z0-9_,\s-]+)\./gi;

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const pageDir = resolveExistingDir(args["page-dir"] || process.env.PPT_WORKER_PAGE_DIR || "");
  const specPath = path.resolve(args.spec || args["rebuild-spec"] || path.join(pageDir, "page-rebuild-spec.json"));
  if (!fsSync.existsSync(specPath)) throw new Error(`Spec not found: ${specPath}`);

  const spec = readJson(specPath);
  const blocker = findRecoveryBlocker({ pageDir, specPath, spec });
  if (blocker) {
    if (isSourceFidelityRecovery(pageDir, specPath)) {
      console.log(JSON.stringify({
        ok: true,
        pageDir,
        spec: specPath,
        changed: false,
        skipped: "source-fidelity-background-recovery",
        reason: "Source-fidelity recovery is handled by page-rebuild-assembler."
      }, null, 2));
      return;
    }
    throw new Error(`Complex page recovery refused: ${blocker}. Re-run the page with real visual assets or mark it for manual visual review; this helper must not convert fallback evidence into a product-grade page.`);
  }
  const before = JSON.stringify(spec);
  const report = recoverSpec(spec, pageDir);

  if (JSON.stringify(spec) !== before) {
    const backupPath = `${specPath}.before-complex-recovery.json`;
    if (!fsSync.existsSync(backupPath)) fsSync.copyFileSync(specPath, backupPath);
    fsSync.writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify({
    ok: true,
    pageDir,
    spec: specPath,
    changed: JSON.stringify(spec) !== before,
    ...report
  }, null, 2));
}

function isSourceFidelityRecovery(pageDir = "", specPath = path.join(pageDir, "page-rebuild-spec.json")) {
  const markerPath = path.join(pageDir, "page-spec-fallback.json");
  if (!fsSync.existsSync(markerPath)) return false;
  try {
    const marker = readJson(markerPath);
    const pageRequest = readJsonIfExists(path.join(pageDir, "page_request.json")) || {};
    const pageId = normalizePageId(pageRequest.page_id || path.basename(pageDir));
    const expectedJobId = String(process.env.PPT_WORKFLOW_JOB_ID || deriveWorkflowJobId(pageDir) || "").trim();
    const expectedRunId = String(pageRequest.run_id || "").trim();
    return envTruthy(process.env.PPT_TOOL_USE_SOURCE_FIDELITY_BACKGROUND)
      && marker?.schemaVersion === 1
      && marker?.createdBy === "model-page-worker-pipeline"
      && marker?.fallback === "source-fidelity-background-recovery"
      && marker?.reason === "visual-asset-budget-exhausted"
      && normalizePageId(marker?.pageId || "") === pageId
      && normalizePageId(marker?.pageDirName || "") === normalizePageId(path.basename(pageDir))
      && String(marker?.specFile || "") === path.basename(specPath)
      && expectedJobId
      && String(marker?.jobId || "") === expectedJobId
      && expectedRunId
      && String(marker?.runId || "") === expectedRunId;
  } catch {
    return false;
  }
}

function envTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function deriveWorkflowJobId(pageDir = "") {
  const normalized = String(pageDir || "").replace(/\\/g, "/");
  const match = normalized.match(/ppt-tool-editable-runs\/([^/]+)\/[^/]+\/pages\/[^/]+$/i);
  return match ? match[1] : "";
}

function recoverSpec(spec, pageDir) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("Spec must be a JSON object.");
  spec.images = Array.isArray(spec.images) ? spec.images : [];
  spec.asset_provenance = Array.isArray(spec.asset_provenance) ? spec.asset_provenance : [];
  spec.visual_inventory = Array.isArray(spec.visual_inventory) ? spec.visual_inventory : [];
  spec.quality_checks = { ...(spec.quality_checks || {}) };
  spec.background_strategy = {
    mode: "source-faithful-editable-reconstruction",
    ...(spec.background_strategy || {})
  };

  const hydratedOmittedAssets = hydrateOmittedGeneratedAssets(spec, pageDir);
  sanitizeDeep(spec);
  ensureImageProvenance(spec, pageDir);
  const mappedInventory = bindForegroundInventory(spec);
  sanitizeDeep(spec);

  spec.background_strategy.source_consistency_contract = cleanText(
    spec.background_strategy.source_consistency_contract
      || "Rebuild the page with editable text and native objects while preserving source-faithful separated visual assets."
  );
  spec.background_strategy.comparison_note = cleanText(
    spec.background_strategy.comparison_note
      || "Complex foreground visuals are represented by bounded asset-sheet-separated source-faithful assets."
  );
  spec.notes = cleanText(
    `${spec.notes || ""} Complex page spec normalized for source-faithful asset separation.`
  );

  return {
    images: spec.images.length,
    assetProvenance: spec.asset_provenance.length,
    visualInventory: spec.visual_inventory.length,
    hydratedOmittedAssets,
    mappedInventory
  };
}

function ensureImageProvenance(spec, pageDir) {
  const provenanceByPath = new Map(spec.asset_provenance.map((item) => [normalizeAssetPath(item?.path || ""), item]));
  for (const image of spec.images) {
    const imagePath = normalizeAssetPath(image?.path || "");
    if (!imagePath) continue;
    image.path = imagePath;
    image.description = cleanText(image.description || image.alt || ASSET_NOTE);
    const existing = provenanceByPath.get(imagePath);
    const provenance = existing || { path: imagePath };
    provenance.path = imagePath;
    provenance.source = normalizeAssetPath(provenance.source || imagePath);
    provenance.source_type = normalizeSourceType(provenance.source_type);
    provenance.provenance_note = cleanText(provenance.provenance_note || ASSET_NOTE);
    if (!fsSync.existsSync(path.join(pageDir, provenance.source)) && fsSync.existsSync(path.join(pageDir, imagePath))) {
      provenance.source = imagePath;
    }
    if (!existing) {
      spec.asset_provenance.push(provenance);
      provenanceByPath.set(imagePath, provenance);
    }
  }
}

function findRecoveryBlocker({ pageDir, specPath, spec }) {
  const candidates = [
    ["page-rebuild-spec.json", spec],
    ["page-rebuild-spec.json.before-complex-recovery.json", readJsonIfExists(`${specPath}.before-complex-recovery.json`)],
    ["page-spec-fallback.json", readJsonIfExists(path.join(pageDir, "page-spec-fallback.json"))]
  ];
  for (const [name, value] of candidates) {
    if (!value) continue;
    const text = fallbackEvidenceText(value);
    if (RECOVERY_BLOCKER_RE.test(text) && !isOnlyResolvedOmittedAssetEvidence(value, pageDir)) {
      return `${name} contains unresolved fallback or visual-review evidence`;
    }
  }
  return "";
}

function hydrateOmittedGeneratedAssets(spec, pageDir) {
  const omittedIds = collectOmittedAssetIds(spec);
  if (!omittedIds.length) return [];
  const jobsById = readRecordedImagegenJobs(pageDir);
  const existingImagePaths = new Set((Array.isArray(spec.images) ? spec.images : []).map((image) => normalizeAssetPath(image?.path || "")).filter(Boolean));
  const hydrated = [];
  for (const id of omittedIds) {
    const job = jobsById.get(cleanId(id).toLowerCase());
    const output = normalizeAssetPath(job?.output || `assets/${cleanId(id)}.png`);
    if (!output || existingImagePaths.has(output) || !fsSync.existsSync(path.join(pageDir, output))) continue;
    const prompt = readPromptFile(job?.prompt_file) || "";
    spec.images.push({
      id: cleanId(id),
      path: output,
      box_px: inferAssetBox({ spec, id, prompt }),
      description: cleanText(prompt || job?.note || ASSET_NOTE),
      z_index: 45
    });
    spec.asset_provenance.push({
      path: output,
      source: output,
      source_type: "asset-sheet-separated",
      provenance_note: cleanText(job?.note || ASSET_NOTE)
    });
    existingImagePaths.add(output);
    hydrated.push(cleanId(id));
  }
  if (hydrated.length) {
    stripResolvedOmittedAssetEvidence(spec, hydrated);
  }
  return hydrated;
}

function isOnlyResolvedOmittedAssetEvidence(value, pageDir) {
  const text = fallbackEvidenceText(value);
  const stripped = text.replace(OMITTED_ASSETS_RE, "");
  if (RECOVERY_BLOCKER_RE.test(stripped)) return false;
  const ids = collectOmittedAssetIds(value);
  if (!ids.length) return false;
  const jobsById = readRecordedImagegenJobs(pageDir);
  return ids.every((id) => {
    const job = jobsById.get(cleanId(id).toLowerCase());
    const output = normalizeAssetPath(job?.output || `assets/${cleanId(id)}.png`);
    return output && fsSync.existsSync(path.join(pageDir, output));
  });
}

function collectOmittedAssetIds(value) {
  const text = fallbackEvidenceText(value);
  const ids = [];
  for (const match of text.matchAll(OMITTED_ASSETS_RE)) {
    ids.push(...String(match[1] || "").split(",").map((item) => cleanId(item)).filter(Boolean));
  }
  return [...new Set(ids)];
}

function fallbackEvidenceText(value = {}) {
  return [
    value?.background_strategy?.mode,
    value?.background_strategy?.source_consistency_contract,
    value?.background_strategy?.comparison_note,
    value?.notes,
    ...(Array.isArray(value?.warnings) ? value.warnings : []),
    value?.reason,
    value?.error,
    typeof value?.fallback === "string" ? value.fallback : value?.fallback?.reason
  ].filter(Boolean).join(" ");
}

function stripResolvedOmittedAssetEvidence(spec, hydratedIds = []) {
  const idSet = new Set(hydratedIds.map((id) => cleanId(id).toLowerCase()));
  const stripText = (value = "") => String(value || "").replace(OMITTED_ASSETS_RE, (_match, list) => {
    const remaining = String(list || "").split(",").map((item) => cleanId(item)).filter((id) => id && !idSet.has(id.toLowerCase()));
    return remaining.length ? `Omitted unavailable generated image assets: ${remaining.join(", ")}.` : "";
  }).replace(/\s+/g, " ").trim();
  spec.warnings = (Array.isArray(spec.warnings) ? spec.warnings : []).map(stripText).filter(Boolean);
  if (spec.notes) spec.notes = stripText(spec.notes);
  if (spec.background_strategy?.comparison_note) spec.background_strategy.comparison_note = stripText(spec.background_strategy.comparison_note);
  if (spec.reason) spec.reason = stripText(spec.reason);
}

function readRecordedImagegenJobs(pageDir) {
  const jobsPath = path.join(pageDir, "imagegen-jobs.json");
  const map = new Map();
  const data = readJsonIfExists(jobsPath);
  for (const job of Array.isArray(data?.jobs) ? data.jobs : []) {
    const id = cleanId(job?.job_id || job?.id || "");
    if (!id || String(job?.status || "").toLowerCase() !== "recorded") continue;
    const output = normalizeAssetPath(job.output || "");
    if (!output || !fsSync.existsSync(path.join(pageDir, output))) continue;
    map.set(id.toLowerCase(), job);
  }
  return map;
}

function readPromptFile(promptFile = "") {
  try {
    if (!promptFile || !fsSync.existsSync(promptFile)) return "";
    return fsSync.readFileSync(promptFile, "utf8").replace(/^\uFEFF/, "").trim();
  } catch {
    return "";
  }
}

function inferAssetBox({ spec = {}, id = "", prompt = "" } = {}) {
  const canvas = Array.isArray(spec.canvas_px) && spec.canvas_px.length === 2 ? spec.canvas_px.map(Number) : [1280, 720];
  const width = Number.isFinite(canvas[0]) && canvas[0] > 0 ? canvas[0] : 1280;
  const height = Number.isFinite(canvas[1]) && canvas[1] > 0 ? canvas[1] : 720;
  const text = `${id} ${prompt}`.toLowerCase();
  if (/right\s*most|right[-\s]*column|right column|link|qr|thumbnail/.test(text)) {
    return [Math.round(width * 0.88), Math.round(height * 0.1), Math.round(width * 0.11), Math.round(height * 0.75)];
  }
  if (/left|category|icon/.test(text)) {
    return [Math.round(width * 0.02), Math.round(height * 0.14), Math.round(width * 0.06), Math.round(height * 0.55)];
  }
  return [Math.round(width * 0.25), Math.round(height * 0.2), Math.round(width * 0.5), Math.round(height * 0.5)];
}

function bindForegroundInventory(spec) {
  const imageCandidates = spec.images
    .map((image) => ({
      id: cleanId(image.id || ""),
      path: normalizeAssetPath(image.path || ""),
      box: coerceBox(image.box_px)
    }))
    .filter((image) => image.path);
  let mapped = 0;
  spec.visual_inventory = spec.visual_inventory.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const text = JSON.stringify(item);
    if (!shouldBindForegroundInventoryItem(item, text)) {
      return item;
    }
    if (!FOREGROUND_RE.test(text) || (STRUCTURAL_RE.test(text) && !/logo|photo|brand|package|packaging|product|asset|包装|产品|标识/i.test(text))) {
      return item;
    }
    const box = coerceBox(item.box_px || item.bounds_px || item.box);
    const image = pickBestImage({ itemId: cleanId(item.id || ""), box, imageCandidates, index });
    const next = {
      ...item,
      type: item.type || "foreground-visual-asset",
      decision: cleanText(`${item.decision || ""} ${ASSET_NOTE}`),
      source_type: normalizeSourceType(item.source_type),
      asset_provenance: {
        ...(typeof item.asset_provenance === "object" && !Array.isArray(item.asset_provenance) ? item.asset_provenance : {}),
        source_type: normalizeSourceType(item.asset_provenance?.source_type),
        provenance_note: cleanText(item.asset_provenance?.provenance_note || ASSET_NOTE)
      }
    };
    if (image) {
      next.path = image.path;
      next.asset_provenance.path = image.path;
      mapped += 1;
    }
    return next;
  });
  return mapped;
}

function pickBestImage({ itemId = "", box = null, imageCandidates = [], index = 0 } = {}) {
  if (!imageCandidates.length) return null;
  const exact = imageCandidates.find((image) => image.id && itemId && image.id.toLowerCase() === itemId.toLowerCase());
  if (exact) return exact;
  if (box) {
    const scored = imageCandidates
      .filter((image) => image.box)
      .map((image) => ({ image, score: boxOverlapScore(box, image.box) }))
      .sort((a, b) => b.score - a.score);
    if (scored[0]?.score > 0) return scored[0].image;
  }
  return imageCandidates[index % imageCandidates.length];
}

function shouldBindForegroundInventoryItem(item = {}, text = "") {
  const kindText = `${item.type || ""} ${item.kind || ""} ${item.role || ""} ${item.decision || ""}`.toLowerCase();
  if (/background|decorative|decoration|line|divider|bottom-band|footer|icon|native-shape|native shape/.test(kindText)
    && !/logo|photo|brand|product display|foreground|screenshot/.test(text)) {
    return false;
  }
  if (!FOREGROUND_RE.test(text)) return false;
  if (STRUCTURAL_RE.test(text) && !/logo|photo|brand|product display|foreground|screenshot|asset/i.test(text)) return false;
  return true;
}

function boxOverlapScore(a, b) {
  const ax2 = a[0] + a[2];
  const ay2 = a[1] + a[3];
  const bx2 = b[0] + b[2];
  const by2 = b[1] + b[3];
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a[1], b[1]));
  const intersection = ix * iy;
  const union = Math.max(1, a[2] * a[3] + b[2] * b[3] - intersection);
  return intersection / union;
}

function sanitizeDeep(value) {
  if (typeof value === "string") return cleanText(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) value[index] = sanitizeDeep(value[index]);
    return value;
  }
  if (!value || typeof value !== "object") return value;
  for (const key of Object.keys(value)) value[key] = sanitizeDeep(value[key]);
  return value;
}

function cleanText(value = "") {
  let text = String(value || "").replace(/\s+/g, " ").trim();
  for (const [pattern, replacement] of FORBIDDEN_WORDS) text = text.replace(pattern, replacement);
  return text;
}

function normalizeSourceType(value = "") {
  const text = String(value || "").trim();
  if (/user.?approved|raster/i.test(text)) return "user-approved-rasterization";
  if (/imagegen/i.test(text)) return "imagegen";
  if (/latex/i.test(text)) return "latex-rendered-formula";
  if (/user.?provided/i.test(text)) return "user-provided";
  return "asset-sheet-separated";
}

function coerceBox(value) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const box = value.map(Number);
  if (!box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0) return null;
  return box;
}

function normalizeAssetPath(value = "") {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\/+/, "").trim();
}

function cleanId(value = "") {
  return String(value || "").trim().replace(/[^a-zA-Z0-9_-]+/g, "_");
}

function readJson(filePath) {
  return JSON.parse(fsSync.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function readJsonIfExists(filePath) {
  try {
    if (!fsSync.existsSync(filePath)) return null;
    return readJson(filePath);
  } catch {
    return null;
  }
}

function resolveExistingDir(value) {
  if (!value) throw new Error("Missing --page-dir.");
  const dir = path.resolve(value);
  if (!fsSync.existsSync(dir) || !fsSync.statSync(dir).isDirectory()) throw new Error(`Page dir not found: ${dir}`);
  return dir;
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      index += 1;
    }
  }
  return out;
}

function printHelp() {
  console.log(`Usage:
  node scripts/recover-complex-page-spec.mjs --page-dir <page_dir> [--spec page-rebuild-spec.json]

Normalizes a complex page rebuild spec so foreground visual inventory is
explicitly bound to source-faithful separated assets and forbidden recovery
wording is removed before running page-worker-pipeline.
`);
}

main();
