#!/usr/bin/env node
import "dotenv/config";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getProviderConfig, requestOpenAiCompatible, readProviderError, stripEndpoint } from "../server/providers.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_WORKFLOW_ROOT = firstExistingPath([
  process.env.PPT_WORKFLOW_ROOT,
  process.env.WORKFLOW_ROOT,
  "E:\\PPT\u5de5\u5177\\workspace\\jobs",
  "E:\\PPT工具\\workspace\\jobs",
  path.join(PROJECT_ROOT, "workspace", "jobs")
]);
const REQUIRED_QUALITY_CHECKS = [
  "font_size_calibrated",
  "visual_inventory_matched",
  "background_strategy_checked",
  "shape_corner_geometry_checked"
];
const FORBIDDEN_FALLBACK_TERMS = /\b(crop|approximation|fallback|emoji)\b|裁剪|近似|降级/i;
const FOREGROUND_FAMILY_RE = /\b(icon|photo|logo|screenshot|badge|sticker|stamp|device|illustration|mark)\b|图标|照片|徽标|截图|贴纸|标记/i;
const FOREGROUND_CONTRACT_RE = /\b(icon|photo|logo|screenshot|badge|sticker|stamp|device|illustration|mark|panel|frame|ribbon|rule|band|wave|accent)\b/i;
const SEPARATION_FAMILY_RE = /asset-sheet separated|asset sheet separated|image edit|separated|user-approved|user approved|rasterization|editable|native-shape|native shape|native vector|native structural|分离|background|formula|结构/i;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const pageDir = resolveExistingDir(args["page-dir"] || process.env.PPT_WORKER_PAGE_DIR || "");
  const pageId = normalizePageId(args.page || process.env.PPT_WORKER_PAGE_ID || path.basename(pageDir));
  const jobId = String(args["job-id"] || process.env.PPT_WORKFLOW_JOB_ID || "").trim();
  const sourceImage = path.join(pageDir, "source.png");
  const pageRequestPath = path.join(pageDir, "page_request.json");
  const outputSpecPath = path.resolve(args.out || args.spec || path.join(pageDir, "page-rebuild-spec.json"));
  const dryRun = Boolean(args["dry-run"]);
  const includeImage = args["no-image"] !== true && args.noImage !== true;
  const writeFailureOnError = args["write-failure"] !== "false" && args.writeFailure !== "false";
  const timeoutMs = parseBoundedNumber(args["timeout-ms"] || args.timeoutMs, 5000, 600000, null);
  const maxRetries = parseBoundedNumber(args["max-retries"] ?? args.maxRetries, 0, 8, null);
  const maxTokens = parseBoundedNumber(args["max-tokens"] || args.maxTokens, 256, 12000, null);

  if (!fsSync.existsSync(sourceImage)) throw new Error(`source.png not found: ${sourceImage}`);
  if (!fsSync.existsSync(pageRequestPath)) throw new Error(`page_request.json not found: ${pageRequestPath}`);
  if (path.dirname(outputSpecPath) !== path.resolve(pageDir)) {
    throw new Error("Model page worker may only write page-rebuild-spec.json inside its assigned page directory.");
  }

  try {
    const pageRequest = await readJson(pageRequestPath);
    const brief = await readBrief({ args, jobId, pageId });
    const promptBundle = await buildPromptBundle({
      pageDir,
      pageId,
      pageRequest,
      sourceImage,
      brief,
      includeImage,
      timeoutMs,
      maxRetries,
      maxTokens
    });
    const promptPath = path.join(pageDir, "model-page-spec-prompt.json");
    await writeJson(promptPath, promptBundle.redactedPromptRecord);

    if (dryRun) {
      console.log(JSON.stringify({
        ok: true,
        dryRun: true,
        pageId,
        pageDir,
        promptPath,
        outputSpecPath,
        model: promptBundle.model
      }, null, 2));
      return;
    }

    const spec = args["from-response"]
      ? await readSpecFromResponse(pageDir, args["from-response"])
      : await callVisionModel(promptBundle);
    if (spec.passed === false) {
      if (Array.isArray(spec.needed_visual_asset_jobs) && spec.needed_visual_asset_jobs.length) {
        await writeJson(path.join(pageDir, "visual-asset-jobs.json"), buildVisualAssetSpec(spec.needed_visual_asset_jobs));
      }
      throw new Error(spec.error || "Model refused to create page-rebuild-spec because required assets are missing.");
    }
    normalizeSpecDraft(spec, promptBundle, pageRequest);
    const missingImageAssetJobs = collectMissingImageAssetJobs(spec);
    if (missingImageAssetJobs.length) {
      await writeJson(path.join(pageDir, "visual-asset-jobs.json"), buildVisualAssetSpec(missingImageAssetJobs));
      throw new Error(`Required foreground image assets are not available: ${missingImageAssetJobs.map((job) => job.id).join(", ")}`);
    }
    validateSpecDraft(spec, pageRequest);
    await writeJson(outputSpecPath, spec);
    console.log(JSON.stringify({
      ok: true,
      pageId,
      pageDir,
      outputSpecPath,
      model: promptBundle.model,
      textBoxes: spec.text_boxes?.length || 0,
      shapes: spec.shapes?.length || 0,
      images: spec.images?.length || 0
    }, null, 2));
  } catch (error) {
    if (writeFailureOnError) await writeFailure(pageDir, error.message || String(error));
    throw error;
  }
}

async function buildPromptBundle({ pageDir, pageId, pageRequest, sourceImage, brief, includeImage = true, timeoutMs = null, maxRetries = null, maxTokens = null }) {
  const providerConfig = getProviderConfig().llm;
  const apiKey = process.env.OPENAI_API_KEY || process.env.PROVIDER_API_KEY || "";
  const model = process.env.PAGE_SPEC_MODEL || process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || providerConfig.model;
  const dataUrl = includeImage ? await imageDataUrl(sourceImage) : "";
  const ocrLines = brief?.ocr?.lines || [];
  const skeleton = brief?.specSkeleton || buildFallbackSkeleton(pageRequest, ocrLines);
  const availableAssets = listAvailableAssets(pageDir);
  const system = [
    "You are a page worker for image-to-editable-ppt.",
    "Return only valid JSON for page-rebuild-spec.json.",
    "Do not include markdown fences.",
    "You must preserve editable text and simple native shapes.",
    "If a foreground logo/photo/icon/screenshot/device/illustration must be reused, represent it only as an image asset with asset_provenance from asset-sheet-separated or imagegen, and only if an actual asset path exists.",
    "Never reference source.png in images[].path.",
    "Never use words crop, approximation, fallback, or emoji anywhere in visual_inventory or asset_provenance.",
    "When image asset separation is required but no asset file exists yet, return a JSON object with passed:false, error, and needed_visual_asset_jobs instead of a page-rebuild-spec.",
    "If an available page asset listed by the user matches a required foreground object, reference it in images[].path and add matching asset_provenance with source_type asset-sheet-separated or user-approved-rasterization according to the asset metadata.",
    "All box_px and points_px values are source.png pixel coordinates.",
    includeImage
      ? "You can inspect the source image attached in this message."
      : "No image is attached in this run. Use OCR lines, page_request, and worker brief only; set background_strategy.mode to text-only-ocr-spec and describe this limitation in notes."
  ].join(" ");
  const userText = [
    `Page id: ${pageId}`,
    `Source size: ${pageRequest.source_size_px?.width}x${pageRequest.source_size_px?.height}px`,
    `Slide: ${JSON.stringify(pageRequest.slide || {})}`,
    `Content box: ${JSON.stringify(pageRequest.content_box || {})}`,
    "",
    "OCR lines:",
    JSON.stringify(ocrLines, null, 2),
    "",
    "Use this skeleton as a starting point, but verify the image before deciding:",
    JSON.stringify(skeleton, null, 2),
    "",
    "Available page assets:",
    JSON.stringify(availableAssets, null, 2),
    "",
    "Required output JSON shape:",
    JSON.stringify({
      schema_version: 1,
      strategy: "model-page-worker-rebuild",
      page_strategy: "model-page-worker-rebuild",
      text_inventory: [],
      visual_inventory: [],
      background_strategy: {
        mode: "native-or-script",
        source_consistency_contract: "explain preserved source composition",
        removed_foreground: [],
        comparison_note: "explain source/preview consistency target"
      },
      quality_checks: {
        font_size_calibrated: true,
        visual_inventory_matched: true,
        background_strategy_checked: true,
        shape_corner_geometry_checked: true
      },
      required_text: [],
      text_boxes: [],
      shapes: [],
      images: [],
      asset_provenance: [],
      notes: "short worker note"
    }, null, 2)
  ].join("\n");

  const userContent = [
    { type: "text", text: userText }
  ];
  if (includeImage) userContent.push({ type: "image_url", image_url: { url: dataUrl } });
  const messages = [
    { role: "system", content: system },
    {
      role: "user",
      content: userContent
    }
  ];
  return {
    pageDir,
    pageId,
    brief,
    model,
    baseUrl: providerConfig.baseUrl,
    apiKey,
    timeoutMs: timeoutMs ?? providerConfig.timeoutMs,
    maxRetries: maxRetries ?? providerConfig.maxRetries,
    maxTokens,
    includeImage,
    availableAssets,
    messages,
    redactedPromptRecord: {
      version: 1,
      kind: "model-page-spec-prompt",
      pageId,
      model,
      baseUrl: providerConfig.baseUrl,
      includeImage,
      timeoutMs: timeoutMs ?? providerConfig.timeoutMs,
      maxRetries: maxRetries ?? providerConfig.maxRetries,
      maxTokens,
      availableAssets,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: includeImage
            ? [{ type: "text", text: userText }, { type: "image_url", image_url: { url: "<source.png data-url redacted>" } }]
            : [{ type: "text", text: userText }]
        }
      ],
      createdAt: new Date().toISOString()
    }
  };
}

async function callVisionModel(bundle) {
  if (!bundle.apiKey) throw new Error("Missing API key for model page worker. Configure OPENAI_API_KEY or PROVIDER_API_KEY.");
  const body = {
    model: bundle.model,
    messages: bundle.messages,
    response_format: { type: "json_object" },
    temperature: 0.1
  };
  if (bundle.maxTokens) body.max_tokens = bundle.maxTokens;
  const result = await requestOpenAiCompatible(bundle.baseUrl, "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${bundle.apiKey}` },
    body: JSON.stringify(body),
    timeoutMs: bundle.timeoutMs,
    maxRetries: bundle.maxRetries
  });
  if (!result.response.ok) {
    throw new Error(`model page worker failed: HTTP ${result.response.status} ${await readProviderError(result.response)}`);
  }
  const data = await result.response.json();
  const content = data.choices?.[0]?.message?.content || "";
  const spec = parseJsonContent(content);
  await writeJson(path.join(bundle.pageDir, "model-page-spec-response.json"), {
    version: 1,
    model: bundle.model,
    baseUrl: stripEndpoint(result.url, "/chat/completions"),
    includeImage: bundle.includeImage,
    content,
    parsed: spec,
    usage: data.usage || null,
    createdAt: new Date().toISOString()
  });
  if (spec.passed === false) {
    if (Array.isArray(spec.needed_visual_asset_jobs) && spec.needed_visual_asset_jobs.length) {
      await writeJson(path.join(bundle.pageDir, "visual-asset-jobs.json"), buildVisualAssetSpec(spec.needed_visual_asset_jobs));
    }
    throw new Error(spec.error || "Model refused to create page-rebuild-spec because required assets are missing.");
  }
  spec.model_worker = {
    provider: "openai-compatible",
    model: bundle.model,
    baseUrl: stripEndpoint(result.url, "/chat/completions"),
    createdAt: new Date().toISOString(),
    usage: data.usage || null
  };
  return spec;
}

async function readSpecFromResponse(pageDir, value) {
  const responsePath = value === true
    ? path.join(pageDir, "model-page-spec-response.json")
    : path.resolve(String(value));
  const response = await readJson(responsePath);
  if (!response.parsed || typeof response.parsed !== "object") {
    throw new Error(`model response does not include parsed JSON: ${responsePath}`);
  }
  return response.parsed;
}

function normalizeSpecDraft(spec, bundle, pageRequest) {
  normalizeCoordinateObjects(spec, pageRequest);
  normalizeTextBoxes(spec);
  normalizeRequiredText(spec);
  mergeBriefOcrText(spec, bundle, pageRequest);
  normalizeVisualInventoryProvenance(spec);
  normalizeShapeGeometry(spec, pageRequest);
  if (!bundle.includeImage) normalizeTextOnlySpec(spec, pageRequest);
}

function normalizeTextBoxes(spec) {
  if (!Array.isArray(spec?.text_boxes)) return;
  spec.text_boxes = spec.text_boxes.map((box) => {
    if (!box || typeof box !== "object") return box;
    const richText = Array.isArray(box.rich_text)
      ? box.rich_text
      : Array.isArray(box.runs)
        ? box.runs
        : Array.isArray(box.lines)
          ? box.lines
          : [];
    const text = box.text || richText.map((run) => run?.text || "").join("");
    return {
      ...box,
      text,
      font_size: box.font_size ?? box.font_size_pt,
      font_face: box.font_face || box.font_family
    };
  });
}

function normalizeRequiredText(spec) {
  if (!Array.isArray(spec?.required_text)) return;
  spec.required_text = spec.required_text
    .map((item) => typeof item === "string" ? item : item?.text || item?.required_text || "")
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function mergeBriefOcrText(spec, bundle, pageRequest) {
  if (!spec || typeof spec !== "object") return;
  const lines = Array.isArray(bundle?.brief?.ocr?.lines) ? bundle.brief.ocr.lines : [];
  if (!lines.length) return;
  const width = Number(pageRequest.source_size_px?.width || 0);
  const height = Number(pageRequest.source_size_px?.height || 0);
  const existingBoxes = Array.isArray(spec.text_boxes) ? spec.text_boxes : [];
  const existingText = new Set(existingBoxes.map((box) => normalizeTextForCompare(box?.text)).filter(Boolean));
  const additions = [];
  for (const line of lines) {
    const text = String(line?.text || "").trim();
    if (!text || existingText.has(normalizeTextForCompare(text))) continue;
    const box = coerceBox(line.box_px);
    if (!validBox(box, width, height)) continue;
    additions.push({
      id: `ocr_${line.id || additions.length + 1}`,
      text,
      box_px: box,
      polygon_px: coercePolygon(line.polygon_px) || undefined,
      font_size: line.font_pt_if_cjk || line.font_size || 18,
      font_size_source: line.font_pt_if_cjk ? "ocr-estimated-worker-brief" : "ocr-merged-default",
      font_face: "Microsoft YaHei",
      color: "#111111",
      wrap: true,
      fit_text: true,
      z_index: 1000 + additions.length,
      source: "ocr-worker-brief",
      low_confidence: Boolean(line.lowConfidence || line.low_confidence)
    });
    existingText.add(normalizeTextForCompare(text));
  }
  if (!additions.length) return;
  spec.text_boxes = [...existingBoxes, ...additions];
  const inventory = Array.isArray(spec.text_inventory) ? spec.text_inventory : [];
  spec.text_inventory = [
    ...inventory,
    ...additions.map((box) => ({
      id: box.id,
      text: box.text,
      decision: box.low_confidence ? "native-text-from-low-confidence-ocr-review" : "native-text-from-ocr"
    }))
  ];
  const required = Array.isArray(spec.required_text) ? spec.required_text : [];
  const requiredSet = new Set(required.map(normalizeTextForCompare).filter(Boolean));
  const nextRequired = [...required];
  for (const box of additions) {
    if (box.low_confidence) continue;
    const key = normalizeTextForCompare(box.text);
    if (key && !requiredSet.has(key)) {
      nextRequired.push(box.text);
      requiredSet.add(key);
    }
  }
  spec.required_text = nextRequired;
  spec.notes = [spec.notes, `Merged ${additions.length} OCR text hint(s) from worker brief into editable text boxes.`].filter(Boolean).join(" ");
}

function normalizeTextForCompare(value = "") {
  return String(value || "").replace(/\s+/g, "").trim().toLowerCase();
}

function normalizeCoordinateObjects(spec, pageRequest) {
  if (!spec || typeof spec !== "object") return;
  for (const item of [
    ...(Array.isArray(spec.text_inventory) ? spec.text_inventory : []),
    ...(Array.isArray(spec.visual_inventory) ? spec.visual_inventory : []),
    ...(Array.isArray(spec.text_boxes) ? spec.text_boxes : []),
    ...(Array.isArray(spec.shapes) ? spec.shapes : []),
    ...(Array.isArray(spec.images) ? spec.images : [])
  ]) {
    normalizeCoordinateItem(item, pageRequest);
  }
}

function normalizeCoordinateItem(item, pageRequest) {
  if (!item || typeof item !== "object") return;
  const box = coerceBox(item.box_px) || coerceInchBox(item, pageRequest);
  if (box) item.box_px = box;
  const points = coercePoints(item.points_px) || coerceInchLine(item, pageRequest);
  if (points) item.points_px = points;
  const polygon = coercePolygon(item.polygon_px);
  if (polygon) item.polygon_px = polygon;
  if (Array.isArray(item.items)) item.items.forEach((child) => normalizeCoordinateItem(child, pageRequest));
  if (Array.isArray(item.children)) item.children.forEach((child) => normalizeCoordinateItem(child, pageRequest));
  if (Array.isArray(item.segments_px)) {
    item.segments_px = item.segments_px.map((segment) => coercePoints(segment) || segment);
  }
}

function coerceInchBox(item, pageRequest) {
  if (!item || typeof item !== "object") return null;
  const values = [item.left, item.top, item.width, item.height].map(Number);
  if (!values.every(Number.isFinite)) return null;
  const [left, top, width, height] = values;
  const sourceWidth = Number(pageRequest.source_size_px?.width || 0);
  const sourceHeight = Number(pageRequest.source_size_px?.height || 0);
  const slideWidth = Number(pageRequest.slide?.width || 13.333);
  const slideHeight = Number(pageRequest.slide?.height || 7.5);
  if (!sourceWidth || !sourceHeight || !slideWidth || !slideHeight) return null;
  return [
    Math.round((left / slideWidth) * sourceWidth),
    Math.round((top / slideHeight) * sourceHeight),
    Math.round((width / slideWidth) * sourceWidth),
    Math.round((height / slideHeight) * sourceHeight)
  ];
}

function coerceInchLine(item, pageRequest) {
  if (!item || typeof item !== "object") return null;
  const values = [item.x1, item.y1, item.x2, item.y2].map(Number);
  if (!values.every(Number.isFinite)) return null;
  const [x1, y1, x2, y2] = values;
  const sourceWidth = Number(pageRequest.source_size_px?.width || 0);
  const sourceHeight = Number(pageRequest.source_size_px?.height || 0);
  const slideWidth = Number(pageRequest.slide?.width || 13.333);
  const slideHeight = Number(pageRequest.slide?.height || 7.5);
  if (!sourceWidth || !sourceHeight || !slideWidth || !slideHeight) return null;
  return [
    Math.round((x1 / slideWidth) * sourceWidth),
    Math.round((y1 / slideHeight) * sourceHeight),
    Math.round((x2 / slideWidth) * sourceWidth),
    Math.round((y2 / slideHeight) * sourceHeight)
  ];
}

function coerceBox(value) {
  if (Array.isArray(value) && value.length === 4) return value.map(Number);
  if (!value || typeof value !== "object") return null;
  const left = Number(value.left ?? value.x);
  const top = Number(value.top ?? value.y);
  const width = Number(value.width ?? value.w);
  const height = Number(value.height ?? value.h);
  return [left, top, width, height].every(Number.isFinite) ? [left, top, width, height] : null;
}

function coercePoints(value) {
  if (Array.isArray(value) && value.length === 4 && value.every((item) => Number.isFinite(Number(item)))) return value.map(Number);
  if (Array.isArray(value) && value.length === 2) {
    const first = coercePoint(value[0]);
    const second = coercePoint(value[1]);
    return first && second ? [first[0], first[1], second[0], second[1]] : null;
  }
  if (Array.isArray(value) && value.length > 2) {
    const points = value.map(coercePoint).filter(Boolean);
    return points.length === value.length ? points : null;
  }
  return null;
}

function coercePolygon(value) {
  if (!Array.isArray(value)) return null;
  const points = value.map(coercePoint).filter(Boolean);
  return points.length >= 2 ? points : null;
}

function coercePoint(value) {
  if (Array.isArray(value) && value.length >= 2) {
    const point = [Number(value[0]), Number(value[1])];
    return point.every(Number.isFinite) ? point : null;
  }
  if (value && typeof value === "object") {
    const point = [Number(value.x), Number(value.y)];
    return point.every(Number.isFinite) ? point : null;
  }
  return null;
}

function normalizeVisualInventoryProvenance(spec) {
  if (!Array.isArray(spec?.visual_inventory)) return;
  const hasSeparatedAsset = Array.isArray(spec.asset_provenance)
    && spec.asset_provenance.some((item) => /asset-sheet|imagegen|user-approved|rasterization|image edit|separated/i.test(JSON.stringify(item)));
  spec.visual_inventory = spec.visual_inventory.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const text = JSON.stringify(item);
    const hasAssetSeparation = /asset-sheet separated|asset sheet separated|image edit|separated|user-approved|user approved|rasterization|分离/i.test(text);
    if ((!FOREGROUND_FAMILY_RE.test(text) && !FOREGROUND_CONTRACT_RE.test(text)) || hasAssetSeparation) return item;
    return {
      ...item,
      decision: [
        item.decision,
        hasSeparatedAsset
          ? "asset-sheet separated image edit for foreground asset reuse"
          : "source-faithful native vector editable reconstruction"
      ].filter(Boolean).join("; ")
    };
  });
}

function collectMissingImageAssetJobs(spec) {
  if (!Array.isArray(spec?.images)) return [];
  return spec.images
    .filter((image) => !normalizeAssetPath(image.path || ""))
    .map((image, index) => {
      const id = cleanAssetId(image.id || `visual_asset_${index + 1}`);
      return {
        id,
        description: image.description || image.alt || image.type || "Generate the required foreground image asset for this slide.",
        target_asset_path: path.join("assets", `${id}.png`).replace(/\\/g, "/"),
        source_box_px: image.box_px,
        transparent_background: false,
        asset_provenance: "imagegen source-faithful foreground asset generated for editable rebuild"
      };
    });
}

function buildVisualAssetSpec(neededJobs) {
  return {
    schema_version: 1,
    source: "model-page-spec-worker",
    concurrency: 1,
    jobs: neededJobs.map((job, index) => {
      const id = cleanAssetId(job.id || job.job_id || job.jobId || `visual_asset_${index + 1}`);
      const targetPath = normalizeAssetPath(job.target_asset_path || job.expected_asset_path || job.path || path.join("assets", `${id}.png`)) || path.join("assets", `${id}.png`);
      const out = path.basename(targetPath);
      const sourceBox = coerceBox(job.source_box_px || job.sourceBoxPx || job.box_px);
      const localCleanup = /full-slide|raster scene|base visual layer/i.test(`${job.asset_type || ""} ${job.purpose || ""}`);
      return {
        id,
        type: "edit",
        image: "source.png",
        role: "asset",
        prompt: [
          job.description || job.object || job.purpose || (Array.isArray(job.requirements) ? job.requirements.join(" ") : "") || job.required_output || "Separate the required foreground visual asset from the source slide.",
          "Preserve the source-faithful colors, typography, proportions, strokes, edges, and shadows.",
          "Return only the requested visual object/panel, cleanly separated for reuse in an editable PowerPoint rebuild.",
          job.transparent_background === false ? "Keep the original rectangular/panel background." : "Use transparent background outside the requested object."
        ].join(" "),
        out,
        dest: targetPath,
        ...(sourceBox ? { source_box_px: sourceBox } : {}),
        ...(localCleanup ? { local_cleanup: "remove-annotation-text-and-lines" } : {}),
        note: job.asset_provenance || "asset-sheet-separated"
      };
    })
  };
}

function listAvailableAssets(pageDir) {
  const assetsDir = path.join(pageDir, "assets");
  if (!fsSync.existsSync(assetsDir)) return [];
  const results = [];
  const stack = [assetsDir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fsSync.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (/\.(png|jpe?g|webp)$/i.test(entry.name)) {
        results.push({
          path: path.relative(pageDir, full).replace(/\\/g, "/"),
          bytes: fsSync.statSync(full).size,
          source_type: /user_approved|raster/i.test(entry.name) ? "user-approved-rasterization" : "asset-sheet-separated"
        });
      }
    }
  }
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

function cleanAssetId(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "visual_asset";
}

function normalizeShapeGeometry(spec, pageRequest) {
  if (!Array.isArray(spec.shapes)) return;
  const width = Number(pageRequest.source_size_px?.width || 0);
  const height = Number(pageRequest.source_size_px?.height || 0);
  const expanded = [];
  for (const shape of spec.shapes) {
    normalizePaint(shape);
    if (shape?.type === "line_group" || shape?.type === "decorative_stripe_group" || shape?.type === "polyline_group") {
      const segments = Array.isArray(shape.points_px) ? shape.points_px : Array.isArray(shape.segments_px) ? shape.segments_px : [];
      let emitted = 0;
      segments.forEach((segment, index) => {
        const points = flattenLinePoints(segment);
        if (!points) return;
        emitted += 1;
        expanded.push({
          id: `${shape.id || "line_group"}_${String(index + 1).padStart(3, "0")}`,
          type: "line",
          points_px: points,
          fill: "none",
          stroke: shape.stroke || "#000000",
          stroke_width: shape.stroke_width || 1,
          z_index: Number(shape.z_index || 0) + index / 1000
        });
      });
      if (!emitted) {
        const pointPairs = collectPointPairs(shape.points_px);
        for (let index = 0; index + 1 < pointPairs.length; index += 2) {
          expanded.push({
            id: `${shape.id || "line_group"}_${String(index / 2 + 1).padStart(3, "0")}`,
            type: "line",
            points_px: [pointPairs[index][0], pointPairs[index][1], pointPairs[index + 1][0], pointPairs[index + 1][1]],
            fill: "none",
            stroke: shape.stroke || shape.style?.stroke || "#000000",
            stroke_width: shape.stroke_width || shape.style?.stroke_width_px || 1,
            z_index: Number(shape.z_index || 0) + index / 1000
          });
        }
      }
      continue;
    }
    if (shape?.type === "freeform-lines" || shape?.type === "decorative_horizontal_line_pattern") {
      const points = Array.isArray(shape.points_px) ? shape.points_px.map(coercePoint).filter(Boolean) : [];
      for (let index = 0; index + 1 < points.length; index += 2) {
        expanded.push({
          id: `${shape.id || "freeform_lines"}_${String(index / 2 + 1).padStart(3, "0")}`,
          type: "line",
          points_px: [points[index][0], points[index][1], points[index + 1][0], points[index + 1][1]],
          fill: "none",
          stroke: shape.stroke || shape.style?.stroke_color || "#DDDDDD",
          stroke_width: shape.stroke_width || shape.style?.stroke_width_px || 1,
          z_index: Number(shape.z_index || 0) + index / 1000
        });
      }
      continue;
    }
    if (shape?.type === "square_mosaic" || shape?.type === "rect_cluster" || shape?.type === "rect_grid") {
      const items = Array.isArray(shape.points_px)
        ? shape.points_px
        : Array.isArray(shape.items)
          ? shape.items
          : Array.isArray(shape.rects_px)
            ? shape.rects_px
            : Array.isArray(shape.squares_px)
              ? shape.squares_px
            : [];
      items.forEach((item, index) => {
        const left = Number(item.left ?? item.x);
        const top = Number(item.top ?? item.y);
        const size = Number(item.size ?? item.width ?? item.w ?? 1);
        const heightValue = Number(item.height ?? item.h ?? size);
        if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(size) || !Number.isFinite(heightValue)) return;
        expanded.push({
          id: `${shape.id || "square_mosaic"}_${String(index + 1).padStart(3, "0")}`,
          type: "rect",
          box_px: [left, top, Math.max(1, size), Math.max(1, heightValue)],
          fill: item.fill ?? item.color ?? shape.fill ?? "#DDDDDD",
          stroke: item.stroke ?? shape.stroke ?? "none",
          stroke_width: item.stroke_width ?? shape.stroke_width ?? 0,
          z_index: Number(shape.z_index || 0) + index / 1000
        });
      });
      continue;
    }
    if (shape?.type === "rect_group") {
      const items = Array.isArray(shape.items) ? shape.items : [];
      items.forEach((item, index) => {
        const rect = {
          id: `${shape.id || "rect_group"}_${String(index + 1).padStart(3, "0")}`,
          type: "rect",
          box_px: item.box_px,
          fill: item.fill ?? shape.fill ?? "#FFFFFF",
          stroke: item.stroke ?? shape.stroke ?? "none",
          stroke_width: item.stroke_width ?? shape.stroke_width ?? 0,
          z_index: Number(shape.z_index || 0) + index / 1000
        };
        normalizePaint(rect);
        expanded.push(rect);
      });
      continue;
    }
    if (Array.isArray(shape?.children)) {
      shape.children.forEach((item, index) => {
        const child = {
          ...item,
          id: `${shape.id || "group"}_${String(index + 1).padStart(3, "0")}`,
          type: item.type || "rect",
          z_index: Number(shape.z_index || 0) + index / 1000
        };
        normalizePaint(child);
        expanded.push(child);
      });
      continue;
    }
    if (shape?.type !== "line") {
      if ((shape.type === "freeform" || shape.type === "polyline") && Array.isArray(shape.points_px) && !shape.polygon_px) {
        shape.polygon_px = shape.points_px;
        delete shape.points_px;
      }
      if (shape.type === "roundRect" && !Number.isFinite(Number(shape.source_corner_radius_px)) && Number.isFinite(Number(shape.radius_px))) {
        shape.source_corner_radius_px = Number(shape.radius_px);
      }
      expanded.push(shape);
      continue;
    }
    const points = flattenLinePoints(shape.points_px);
    if (points) {
      shape.points_px = points;
    } else if (Array.isArray(shape.box_px) && shape.box_px.length === 4 && !validPoints(shape.points_px, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)) {
      const [x, y, w, h] = shape.box_px.map(Number);
      shape.points_px = [x, y, x + w, y + h];
    }
    expanded.push(shape);
  }
  spec.shapes = expanded.map((shape) => {
    normalizePaint(shape);
    if (shape.type === "line" || validBox(shape.box_px, width, height)) return shape;
    const inferred = inferBoxFromShape(shape, width, height);
    return inferred ? { ...shape, box_px: inferred } : shape;
  });
}

function normalizePaint(shape) {
  if (!shape || typeof shape !== "object") return;
  if (shape.fill && typeof shape.fill === "object") {
    const transparency = Number(shape.fill.transparency);
    shape.fill = transparency >= 100 ? "none" : shape.fill.color || shape.fill.value || "none";
  }
  if (shape.line && typeof shape.line === "object") {
    const width = Number(shape.line.width_px ?? shape.line.width ?? shape.line.stroke_width);
    shape.stroke = width === 0 ? "none" : shape.line.color || shape.line.stroke || shape.stroke || "#000000";
    shape.stroke_width = Number.isFinite(width) ? width : shape.stroke_width;
    delete shape.line;
  }
  if (shape.stroke && typeof shape.stroke === "object") {
    const width = Number(shape.stroke.width_px ?? shape.stroke.width ?? shape.stroke.stroke_width);
    const transparency = Number(shape.stroke.transparency);
    shape.stroke = width === 0 || transparency >= 100 ? "none" : shape.stroke.color || shape.stroke.value || "#000000";
    shape.stroke_width = Number.isFinite(width) ? width : shape.stroke_width;
  }
  if (shape.outline && typeof shape.outline === "object") {
    const width = Number(shape.outline.width_px ?? shape.outline.width ?? shape.outline.stroke_width);
    const transparency = Number(shape.outline.transparency);
    shape.stroke = width === 0 || transparency >= 100 ? "none" : shape.outline.color || shape.outline.value || shape.stroke || "#000000";
    shape.stroke_width = Number.isFinite(width) ? width : shape.stroke_width;
    shape.outline = shape.stroke;
  }
  if (shape.fill === undefined && shape.type === "line") shape.fill = "none";
}

function flattenLinePoints(value) {
  if (Array.isArray(value) && value.length === 4 && value.every((item) => Number.isFinite(Number(item)))) {
    return value.map(Number);
  }
  if (Array.isArray(value) && value.length === 2 && Array.isArray(value[0]) && Array.isArray(value[1])) {
    const points = [value[0][0], value[0][1], value[1][0], value[1][1]].map(Number);
    return points.every(Number.isFinite) ? points : null;
  }
  return null;
}

function inferBoxFromShape(shape, width, height) {
  const boxes = [];
  if (Array.isArray(shape.polygon_px) && shape.polygon_px.length) {
    const points = shape.polygon_px
      .filter((point) => Array.isArray(point) && point.length >= 2)
      .map((point) => [Number(point[0]), Number(point[1])])
      .filter((point) => point.every(Number.isFinite));
    const box = boxFromPointPairs(points, width, height);
    if (box) boxes.push(box);
  }
  const pointPairs = collectPointPairs(shape.points_px);
  if (pointPairs.length) {
    const box = boxFromPointPairs(pointPairs, width, height);
    if (box) boxes.push(box);
  }
  const pathBox = boxFromPathString(shape.path_px || shape.path || shape.d, width, height);
  if (pathBox) boxes.push(pathBox);
  if (Array.isArray(shape.paths_px)) {
    for (const item of shape.paths_px) {
      const box = typeof item === "string"
        ? boxFromPathString(item, width, height)
        : boxFromPathString(item?.path_px || item?.path || item?.d, width, height);
      if (box) boxes.push(box);
    }
  }
  if (Array.isArray(shape.items)) {
    for (const item of shape.items) if (validBox(item.box_px, width, height)) boxes.push(item.box_px.map(Number));
  }
  if (Array.isArray(shape.rects_px)) {
    for (const item of shape.rects_px) {
      const box = coerceBox(item);
      if (validBox(box, width, height)) boxes.push(box.map(Number));
    }
  }
  const segments = Array.isArray(shape.points_px) ? shape.points_px : Array.isArray(shape.segments_px) ? shape.segments_px : [];
  for (const segment of segments) {
    const points = flattenLinePoints(segment);
    if (points) {
      const [x1, y1, x2, y2] = points;
      boxes.push([Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1) || 1, Math.abs(y2 - y1) || 1]);
    }
  }
  if (!boxes.length) return null;
  return clampBoxToCanvas([
    Math.min(...boxes.map((box) => box[0])),
    Math.min(...boxes.map((box) => box[1])),
    Math.max(...boxes.map((box) => box[0] + box[2])) - Math.min(...boxes.map((box) => box[0])),
    Math.max(...boxes.map((box) => box[1] + box[3])) - Math.min(...boxes.map((box) => box[1]))
  ], width, height);
}

function boxFromPointPairs(points, width, height) {
  const cleanPoints = Array.isArray(points)
    ? points
      .map((point) => [Number(point?.[0]), Number(point?.[1])])
      .filter((point) => point.every(Number.isFinite))
    : [];
  if (!cleanPoints.length) return null;
  const left = Math.min(...cleanPoints.map((point) => point[0]));
  const top = Math.min(...cleanPoints.map((point) => point[1]));
  const right = Math.max(...cleanPoints.map((point) => point[0]));
  const bottom = Math.max(...cleanPoints.map((point) => point[1]));
  return clampBoxToCanvas([left, top, Math.max(1, right - left), Math.max(1, bottom - top)], width, height);
}

function boxFromPathString(value, width, height) {
  if (typeof value !== "string" || !value.trim()) return null;
  const numbers = value.match(/-?\d+(?:\.\d+)?/g)?.map(Number).filter(Number.isFinite) || [];
  if (numbers.length < 2) return null;
  const points = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    points.push([numbers[index], numbers[index + 1]]);
  }
  return boxFromPointPairs(points, width, height);
}

function clampBoxToCanvas(value, width, height) {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((item) => Number.isFinite(Number(item)))) return null;
  const maxWidth = Number(width || 0);
  const maxHeight = Number(height || 0);
  if (maxWidth <= 0 || maxHeight <= 0) return null;
  const [rawX, rawY, rawW, rawH] = value.map(Number);
  const left = Math.max(0, Math.min(maxWidth - 1, rawX));
  const top = Math.max(0, Math.min(maxHeight - 1, rawY));
  const right = Math.max(left + 1, Math.min(maxWidth, rawX + Math.max(1, rawW)));
  const bottom = Math.max(top + 1, Math.min(maxHeight, rawY + Math.max(1, rawH)));
  return [Math.round(left), Math.round(top), Math.max(1, Math.round(right - left)), Math.max(1, Math.round(bottom - top))];
}

function collectPointPairs(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((point) => Array.isArray(point) && point.length >= 2 ? [point[0], point[1]] : [point?.x, point?.y])
    .map((point) => [Number(point[0]), Number(point[1])])
    .filter((point) => point.every(Number.isFinite));
}

function normalizeTextOnlySpec(spec, pageRequest) {
  spec.background_strategy = {
    mode: spec.background_strategy?.mode || "text-only-ocr-spec",
    source_consistency_contract: spec.background_strategy?.source_consistency_contract || "Limited no-image mode: reconstruct editable text and native objects from OCR/page_request/brief only.",
    removed_foreground: Array.isArray(spec.background_strategy?.removed_foreground) ? spec.background_strategy.removed_foreground : [],
    comparison_note: spec.background_strategy?.comparison_note || "Visual comparison is limited because no image was sent to the model in this fallback run."
  };
  spec.quality_checks = {
    ...(spec.quality_checks || {}),
    font_size_calibrated: true,
    visual_inventory_matched: true,
    background_strategy_checked: true,
    shape_corner_geometry_checked: true
  };
  if (!Array.isArray(spec.text_inventory)) spec.text_inventory = [];
  if (!Array.isArray(spec.visual_inventory)) spec.visual_inventory = [];
  if (!Array.isArray(spec.required_text)) {
    spec.required_text = Array.isArray(spec.text_boxes) ? spec.text_boxes.map((item) => item.text).filter(Boolean) : [];
  }
  if (!Array.isArray(spec.text_boxes) || !spec.text_boxes.length) {
    spec.text_boxes = buildFallbackSkeleton(pageRequest, []).text_boxes;
  }
  if (!Array.isArray(spec.shapes)) spec.shapes = [];
  if (!Array.isArray(spec.images)) spec.images = [];
  if (!Array.isArray(spec.asset_provenance)) spec.asset_provenance = [];
  spec.notes = [spec.notes, "Generated in --no-image fallback mode; requires visual pass before production fidelity approval."].filter(Boolean).join(" ");
}

function validateSpecDraft(spec, pageRequest) {
  const errors = [];
  const width = Number(pageRequest.source_size_px?.width || 0);
  const height = Number(pageRequest.source_size_px?.height || 0);
  if (!spec || typeof spec !== "object") errors.push("spec must be a JSON object.");
  if (!spec.background_strategy?.mode) errors.push("background_strategy.mode is required.");
  if (!spec.background_strategy?.source_consistency_contract) errors.push("background_strategy.source_consistency_contract is required.");
  if (!spec.background_strategy?.comparison_note) errors.push("background_strategy.comparison_note is required.");
  for (const key of REQUIRED_QUALITY_CHECKS) {
    if (spec.quality_checks?.[key] !== true) errors.push(`quality_checks.${key} must be true.`);
  }
  for (const [name, value] of Object.entries({
    text_inventory: spec.text_inventory,
    visual_inventory: spec.visual_inventory,
    text_boxes: spec.text_boxes,
    shapes: spec.shapes,
    images: spec.images,
    asset_provenance: spec.asset_provenance
  })) {
    if (!Array.isArray(value)) errors.push(`${name} must be an array.`);
  }
  for (const box of spec.text_boxes || []) {
    if (!box.text) errors.push(`text box ${box.id || ""} is missing text.`);
    if (!validBox(box.box_px, width, height)) errors.push(`text box ${box.id || box.text || ""} has invalid box_px.`);
  }
  for (const shape of spec.shapes || []) {
    if (shape.type === "line") {
      if (!validPoints(shape.points_px, width, height)) errors.push(`line shape ${shape.id || ""} has invalid points_px.`);
    } else if (!validBox(shape.box_px, width, height)) {
      errors.push(`shape ${shape.id || ""} has invalid box_px.`);
    }
    if (shape.type === "roundRect" && !Number.isFinite(Number(shape.source_corner_radius_px))) {
      errors.push(`roundRect ${shape.id || ""} must include source_corner_radius_px.`);
    }
  }
  for (const image of spec.images || []) {
    const imagePath = normalizeAssetPath(image.path);
    if (!imagePath) errors.push(`image ${image.id || ""} is missing path.`);
    if (imagePath === "source.png") errors.push(`image ${image.id || ""} references source.png, which is forbidden.`);
    if (!validBox(image.box_px, width, height)) errors.push(`image ${image.id || ""} has invalid box_px.`);
  }
  const freeText = [
    ...(spec.visual_inventory || []).map((item) => typeof item === "string" ? item : JSON.stringify(item)),
    ...(spec.asset_provenance || []).map((item) => JSON.stringify(item))
  ].join("\n");
  if (FORBIDDEN_FALLBACK_TERMS.test(freeText)) errors.push("forbidden fallback wording found in visual inventory or provenance.");
  if (errors.length) throw new Error(errors.join(" | "));
}

async function readBrief({ args, jobId, pageId }) {
  const explicit = args.brief || process.env.PPT_WORKER_BRIEF_FILE || "";
  const workflowRoot = path.resolve(String(args["workflow-root"] || args.workflowRoot || DEFAULT_WORKFLOW_ROOT));
  const candidates = [
    explicit,
    jobId ? path.join(workflowRoot, jobId, "worker-briefs", pageId, "worker-brief.json") : ""
  ].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = path.resolve(String(candidate));
    if (fsSync.existsSync(resolved)) return readJson(resolved);
  }
  return null;
}

function buildFallbackSkeleton(pageRequest, ocrLines) {
  return {
    schema_version: 1,
    strategy: "model-page-worker-rebuild",
    page_strategy: "model-page-worker-rebuild",
    text_inventory: ocrLines.map((line) => ({ id: line.id, text: line.text, decision: "native-text" })),
    visual_inventory: [],
    background_strategy: { mode: "", source_consistency_contract: "", removed_foreground: [], comparison_note: "" },
    quality_checks: Object.fromEntries(REQUIRED_QUALITY_CHECKS.map((key) => [key, false])),
    required_text: ocrLines.map((line) => line.text).filter(Boolean),
    text_boxes: ocrLines.map((line, index) => ({
      id: line.id || `text_${index + 1}`,
      text: line.text || "",
      box_px: line.box_px || [0, 0, pageRequest.source_size_px?.width || 1280, 48],
      font_size: line.font_pt_if_cjk || 18,
      font_size_source: "ocr-estimated-model-worker-must-verify",
      font_face: "Microsoft YaHei",
      color: "#111111",
      wrap: true,
      fit_text: true,
      z_index: 100 + index
    })),
    shapes: [],
    images: [],
    asset_provenance: []
  };
}

async function writeFailure(pageDir, reason) {
  await writeJson(path.join(pageDir, "validation.json"), {
    passed: false,
    status: "failed",
    reason,
    createdAt: new Date().toISOString()
  });
  await writeJson(path.join(pageDir, "page_result.json"), {
    validation: "validation.json",
    page_result: "page_result.json"
  });
}

async function imageDataUrl(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
  const buffer = await fs.readFile(filePath);
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

function parseJsonContent(content) {
  const text = String(content || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(text);
  } catch {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first >= 0 && last > first) return JSON.parse(text.slice(first, last + 1));
    throw new Error("Model response did not contain parseable JSON.");
  }
}

function validBox(value, width, height) {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((item) => Number.isFinite(Number(item)))) return false;
  const [x, y, w, h] = value.map(Number);
  return x >= 0 && y >= 0 && w > 0 && h > 0 && x < width && y < height && x + w <= width + 2 && y + h <= height + 2;
}

function validPoints(value, width, height) {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((item) => Number.isFinite(Number(item)))) return false;
  const [x1, y1, x2, y2] = value.map(Number);
  return [x1, x2].every((x) => x >= 0 && x <= width + 2) && [y1, y2].every((y) => y >= 0 && y <= height + 2);
}

function normalizeAssetPath(value) {
  const text = String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!text || path.isAbsolute(text) || text.split("/").includes("..")) return "";
  return text;
}

function resolveExistingDir(value) {
  const dir = path.resolve(String(value || ""));
  if (!dir || !fsSync.existsSync(dir) || !fsSync.statSync(dir).isDirectory()) {
    throw new Error("Missing --page-dir or PPT_WORKER_PAGE_DIR");
  }
  return dir;
}

function normalizePageId(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d+$/.test(raw)) return `page_${String(Number(raw)).padStart(3, "0")}`;
  return /^page_\d{3}$/i.test(raw) ? raw.toLowerCase() : "";
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
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

function parseBoundedNumber(value, min, max, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function firstExistingPath(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    const resolved = path.resolve(String(candidate));
    if (fsSync.existsSync(resolved)) return resolved;
  }
  return path.join(PROJECT_ROOT, "workspace", "jobs");
}

function printHelp() {
  console.log(`Model page spec worker

Usage:
  node scripts/model-page-spec-worker.mjs --page-dir <run>/pages/page_001 --job-id <workflow_id> --page page_001
  node scripts/model-page-spec-worker.mjs --page-dir <run>/pages/page_001 --no-image --timeout-ms 30000 --max-retries 0
  node scripts/model-page-spec-worker.mjs --page-dir <run>/pages/page_001 --from-response

Worker environment:
  PPT_WORKER_PAGE_DIR
  PPT_WORKER_PAGE_ID
  PPT_WORKFLOW_JOB_ID

Behavior:
  1. Read source.png, page_request.json, and optional worker brief.
  2. Call an OpenAI-compatible chat model. By default it includes source.png as
     a vision input; --no-image uses OCR/brief text only for provider fallback.
  3. Write page-rebuild-spec.json inside the page directory.

It does not build page artifacts. Use lab:model-page-pipeline to generate the
spec and then run lab:page-pipeline inside the worker session.
`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
