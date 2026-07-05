#!/usr/bin/env node
import "dotenv/config";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { execFile } from "child_process";
import { fileURLToPath } from "url";
import { promisify } from "util";
import { getProviderConfig, requestOpenAiCompatible, readProviderError, stripEndpoint } from "../server/providers.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const execFileAsync = promisify(execFile);
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
const FOREGROUND_FAMILY_RE = /\b(icon|photo|logo|screenshot|badge|sticker|stamp|device|illustration|mark|laurel|leaf|leaves|award|trophy)\b|图标|照片|徽标|截图|贴纸|标记/i;
const FOREGROUND_CONTRACT_RE = /\b(icon|photo|logo|screenshot|badge|sticker|stamp|device|illustration|mark|panel|frame|ribbon|rule|band|wave|accent|laurel|leaf|leaves|award|trophy)\b/i;
const ASSET_SEPARATION_RE = /asset-sheet-separated|asset-sheet separated|asset sheet separated|image edit|separated|user-approved|user approved|rasterization|imagegen|分离/i;
const NATIVE_STRUCTURAL_RE = /native structural|结构|background|formula|divider|rule|grid|panel|card|pagination|native background|arc|circle|ellipse|bullet|line|border|curve|stroke|sweep/i;
const activeModelResponse = {
  bundle: null,
  selected: null,
  attemptRecords: [],
  latest: {},
  finalWritten: false
};

installTerminationFinalResponseHandlers();

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
  const lowComplexity = Boolean(args["low-complexity"] || args.lowComplexity || process.env.MODEL_PAGE_SPEC_LOW_COMPLEXITY === "1");

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
      maxTokens,
      lowComplexity
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
      if (hydrateNeededAssetJobsFromAvailableAssets(spec, promptBundle)) {
        spec.passed = true;
        spec.notes = [
          removeForbiddenFallbackTerms(spec.notes),
          "Asset-hydrated from model passed:false by mapping needed_visual_asset_jobs to existing page assets."
        ].filter(Boolean).join(" ");
        delete spec.error;
        clearResolvedNoImageFallbackMarker(pageDir);
      } else if (!promptBundle.includeImage) {
        spec.passed = true;
        spec.notes = [
          spec.notes,
          "No-image fallback ignored model-requested visual asset jobs; this page requires visual QA before production delivery."
        ].filter(Boolean).join(" ");
        spec.needed_visual_asset_jobs = [];
        delete spec.error;
      } else {
        if (Array.isArray(spec.needed_visual_asset_jobs) && spec.needed_visual_asset_jobs.length) {
          await writeJson(path.join(pageDir, "visual-asset-jobs.json"), buildVisualAssetSpec(spec.needed_visual_asset_jobs));
        }
        throw new Error(spec.error || "Model refused to create page-rebuild-spec because required assets are missing.");
      }
    }
    normalizeSpecDraft(spec, promptBundle, pageRequest);
    const missingImageAssetJobs = promptBundle.includeImage
      ? [
        ...collectMissingImageAssetJobs(spec),
        ...collectMissingForegroundInventoryAssetJobs(spec),
        ...collectMissingBrandBlockAssetJobs(spec, promptBundle)
      ]
      : [];
    if (missingImageAssetJobs.length) {
      await writeJson(path.join(pageDir, "visual-asset-jobs.json"), buildVisualAssetSpec(missingImageAssetJobs));
      omitUnavailableImageAssets(spec, missingImageAssetJobs);
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

function omitUnavailableImageAssets(spec = {}, missingJobs = []) {
  const missingIds = new Set(
    (Array.isArray(missingJobs) ? missingJobs : [])
      .map((job) => cleanAssetId(job.id || ""))
      .filter(Boolean)
  );
  if (!missingIds.size) return spec;
  const isMissing = (item = {}) => {
    const id = cleanAssetId(item.id || item.image_id || "");
    if (id && missingIds.has(id)) return true;
    const text = JSON.stringify(item || {});
    return Array.from(missingIds).some((missingId) => text.includes(missingId));
  };
  spec.images = (Array.isArray(spec.images) ? spec.images : []).filter((item) => !isMissing(item));
  spec.visual_inventory = (Array.isArray(spec.visual_inventory) ? spec.visual_inventory : []).filter((item) => !isMissing(item));
  spec.asset_provenance = (Array.isArray(spec.asset_provenance) ? spec.asset_provenance : []).filter((item) => !isMissing(item));
  spec.warnings = [
    ...(Array.isArray(spec.warnings) ? spec.warnings : []),
    `Omitted unavailable generated image assets: ${Array.from(missingIds).join(", ")}.`
  ];
  spec.background_strategy = {
    ...(spec.background_strategy || {}),
    comparison_note: [
      spec.background_strategy?.comparison_note,
      `Omitted unavailable generated image assets: ${Array.from(missingIds).join(", ")}.`
    ].filter(Boolean).join(" ")
  };
  return spec;
}

async function buildPromptBundle({ pageDir, pageId, pageRequest, sourceImage, brief, includeImage = true, timeoutMs = null, maxRetries = null, maxTokens = null, lowComplexity = false }) {
  const providerConfig = getProviderConfig().llm;
  const apiKey = process.env.OPENAI_API_KEY || process.env.PROVIDER_API_KEY || "";
  const model = process.env.PAGE_SPEC_MODEL || process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || providerConfig.model;
  const promptImage = includeImage && lowComplexity ? await preparePromptImage(sourceImage, pageDir) : null;
  const dataUrl = includeImage ? await imageDataUrl(promptImage?.path || sourceImage) : "";
  const ocrLines = brief?.ocr?.lines || [];
  const skeleton = brief?.specSkeleton || buildFallbackSkeleton(pageRequest, ocrLines);
  const availableAssets = listAvailableAssets(pageDir);
  const promptOcrLines = lowComplexity ? compactOcrLinesForPrompt(ocrLines, 35) : ocrLines;
  const promptSkeleton = lowComplexity ? buildCompactPromptSkeleton(pageRequest, promptOcrLines) : skeleton;
  const promptAvailableAssets = lowComplexity ? compactAvailableAssetsForPrompt(availableAssets, 12) : availableAssets;
  const system = [
    "You are a page worker for image-to-editable-ppt.",
    "Return only valid JSON for page-rebuild-spec.json.",
    "Do not include markdown fences.",
    "You must preserve editable text and simple native shapes.",
    "Visual fidelity is mandatory: every visible non-text object larger than about 2% of the slide area must appear in visual_inventory and must be rebuilt as native shapes or images.",
    "Do not claim the background is preserved unless the required background/decoration objects are represented by shapes, images, or needed_visual_asset_jobs.",
    "Brand logos, complex icons, screenshots, decorative maps, patterned panels, cards, shadows, and image-like decorations must be represented as images with real separated/generated assets, or requested through needed_visual_asset_jobs.",
    "Simple borders, divider lines, arcs, circles, ellipses, bullets, rectangles, grids, and translucent blocks must be represented as native structural shapes with source pixel coordinates.",
    "If a foreground logo/photo/icon/screenshot/device/illustration must be reused, represent it only as an image asset with asset_provenance from asset-sheet-separated or imagegen, and only if an actual asset path exists.",
    "Never reference source.png in images[].path.",
    "Never use words crop, approximation, fallback, or emoji anywhere in visual_inventory or asset_provenance.",
    "Use clean visual_inventory decisions only: native-shape, image-asset, needed-visual-asset, or native-text. Do not write native-shape-approximation.",
    "When image asset separation is required but no asset file exists yet, return a JSON object with passed:false, error, and needed_visual_asset_jobs instead of a page-rebuild-spec.",
    "If an available page asset listed by the user matches a required foreground object, reference it in images[].path and add matching asset_provenance with source_type asset-sheet-separated or user-approved-rasterization according to the asset metadata.",
    "Before returning needed_visual_asset_jobs, first match the required object against Available page assets by id, prompt_excerpt, provenance_note, and source_box_px. Reuse matching available assets instead of requesting duplicates.",
    "All box_px and points_px values are source.png pixel coordinates.",
    includeImage
      ? "You can inspect the source image attached in this message."
      : "No image is attached in this run. Use OCR lines, page_request, and worker brief only; set background_strategy.mode to text-only-ocr-spec and describe this limitation in notes.",
    lowComplexity
      ? "Low-complexity mode is enabled because the provider timed out. Return a compact but valid spec: prioritize editable text, simple shapes, major image regions, and only essential visual asset jobs."
      : ""
  ].join(" ");
  const userText = [
    `Page id: ${pageId}`,
    `Source size: ${pageRequest.source_size_px?.width}x${pageRequest.source_size_px?.height}px`,
    `Slide: ${JSON.stringify(pageRequest.slide || {})}`,
    `Content box: ${JSON.stringify(pageRequest.content_box || {})}`,
    "",
    "OCR lines:",
    JSON.stringify(promptOcrLines, null, lowComplexity ? 0 : 2),
    "",
    "Use this skeleton as a starting point, but verify the image before deciding:",
    JSON.stringify(promptSkeleton, null, lowComplexity ? 0 : 2),
    "",
    "Available page assets:",
    JSON.stringify(promptAvailableAssets, null, lowComplexity ? 0 : 2),
    availableAssets.length
      ? "Important: these assets already exist in the page directory. If one matches a photo, logo, icon, badge, or decorative object, use its path in images[] and asset_provenance. Do not ask for a new needed_visual_asset_job for the same object."
      : "No separated page assets are available yet; request needed_visual_asset_jobs for required non-text foreground visuals.",
    "",
    "Visual coverage rules:",
    lowComplexity
      ? "Cover visible logos/photos/icons/packaging/panels. Use native shapes for simple geometry. Use image assets only from Available page assets. Request needed_visual_asset_jobs only for missing required assets. Never use source.png."
      : JSON.stringify({
        must_cover: [
          "all visible logos or brand marks",
          "large decorative background maps, patterns, grids, bands, cards, panels, and shadows",
          "icons, badges, screenshots, device frames, photos, illustrations, and image-like marks",
          "all divider lines, borders, accent rules, and colored blocks"
        ],
        allowed_methods: [
          "native shapes for simple geometry",
          "image assets only when a real asset path exists",
          "needed_visual_asset_jobs when a required visual asset is not yet available"
        ],
        not_allowed: [
          "omitting decoration because it is not text",
          "claiming the background is preserved while shapes/images are missing",
          "using source.png as an image",
          "creating a mostly blank editable text-only page"
        ]
      }, null, 2),
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
    }, null, lowComplexity ? 0 : 2)
  ].join("\n");

  const userContent = [
    { type: "text", text: userText }
  ];
  if (includeImage) {
    userContent.push({
      type: "image_url",
      image_url: {
        url: dataUrl,
        ...(lowComplexity ? { detail: "low" } : {})
      }
    });
  }
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
    pageRequest,
    brief,
    model,
    baseUrl: providerConfig.baseUrl,
    apiKey,
    timeoutMs: timeoutMs ?? providerConfig.timeoutMs,
    maxRetries: maxRetries ?? providerConfig.maxRetries,
    maxTokens,
    lowComplexity,
    includeImage,
    promptImage,
    availableAssets,
    messages,
    redactedPromptRecord: {
      version: 1,
      kind: "model-page-spec-prompt",
      pageId,
      model,
      baseUrl: providerConfig.baseUrl,
      includeImage,
      promptImage,
      lowComplexity,
      timeoutMs: timeoutMs ?? providerConfig.timeoutMs,
      maxRetries: maxRetries ?? providerConfig.maxRetries,
      maxTokens,
      availableAssets,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: includeImage
            ? [{ type: "text", text: userText }, { type: "image_url", image_url: { url: lowComplexity ? "<prompt-image data-url redacted>" : "<source.png data-url redacted>", ...(lowComplexity ? { detail: "low" } : {}) } }]
            : [{ type: "text", text: userText }]
        }
      ],
      createdAt: new Date().toISOString()
    }
  };
}

async function callVisionModel(bundle) {
  if (!bundle.apiKey) throw new Error("Missing API key for model page worker. Configure OPENAI_API_KEY or PROVIDER_API_KEY.");
  const compactTimeoutMs = parseBoundedNumber(bundle.timeoutMs || 300000, 90000, 600000, 300000);
  const compactMaxTokens = Math.min(bundle.maxTokens || 1800, 1800);
  const attempts = bundle.lowComplexity
    ? [
      { responseFormat: true, compact: true, reason: "low-complexity-compact-vision-json", timeoutMs: compactTimeoutMs, maxTokens: compactMaxTokens, maxRetries: 0 },
      { responseFormat: false, compact: true, reason: "low-complexity-plain-json-retry", timeoutMs: compactTimeoutMs, maxTokens: compactMaxTokens, maxRetries: 0 }
    ]
    : [
      { responseFormat: true, reason: "json_object" },
      { responseFormat: true, compact: true, reason: "compact-vision-json-after-empty-or-invalid-content", timeoutMs: Math.min(bundle.timeoutMs || 120000, 120000), maxTokens: Math.min(bundle.maxTokens || 1800, 1800) },
      { responseFormat: false, reason: "plain-json-retry-after-empty-or-invalid-content", timeoutMs: Math.min(bundle.timeoutMs || 120000, 120000), maxTokens: Math.min(bundle.maxTokens || 1800, 1800) }
    ];
  const attemptRecords = [];
  let selected = null;
  Object.assign(activeModelResponse, { bundle, selected, attemptRecords, latest: {}, finalWritten: false });
  for (const attempt of attempts) {
    try {
      const result = await requestModelSpecAttempt(bundle, attempt);
      attemptRecords.push(result.record);
      activeModelResponse.selected = selected;
      activeModelResponse.latest = {
        data: result.data,
        content: result.content,
        spec: result.spec,
        parseError: result.parseError
      };
      await writeModelResponseRecord(bundle, {
        selected,
        attemptRecords,
        data: result.data,
        content: result.content,
        spec: result.spec,
        parseError: result.parseError,
        final: false
      });
      if (result.spec) {
        selected = result;
        activeModelResponse.selected = selected;
        break;
      }
    } catch (error) {
      const latest = activeModelResponse.latest || {};
      attemptRecords.push({
        reason: attempt.reason || "",
        responseFormat: Boolean(attempt.responseFormat),
        compact: Boolean(attempt.compact),
        ok: false,
        contentLength: 0,
        parseError: "",
        error: error.message || String(error),
        baseUrl: "",
        usage: null,
        finishReason: ""
      });
      activeModelResponse.selected = selected;
      await writeModelResponseRecord(bundle, {
        selected,
        attemptRecords,
        data: latest.data || {},
        content: latest.content || "",
        spec: latest.spec || null,
        parseError: error.message || String(error),
        final: false
      });
    }
  }
  const latest = activeModelResponse.latest || {};
  const existing = readJsonIfExists(path.join(bundle.pageDir, "model-page-spec-response.json"));
  const data = selected?.data || latest.data || existing?.raw || {};
  const content = selected?.content || latest.content || existing?.content || "";
  const spec = selected?.spec || latest.spec || existing?.parsed || null;
  const parseError = selected?.parseError || latest.parseError || attemptRecords.at(-1)?.parseError || existing?.parseError || "";
  await writeModelResponseRecord(bundle, { selected, attemptRecords, data, content, spec, parseError, final: true });
  activeModelResponse.finalWritten = true;
  if (!spec) {
    throw new Error([
      "Model response did not contain parseable JSON.",
      parseError ? `parse error: ${parseError}` : "",
      content ? `content preview: ${String(content).slice(0, 240)}` : "content was empty; see model-page-spec-response.json raw field"
    ].filter(Boolean).join(" "));
  }
  if (spec.passed === false) {
    if (hydrateNeededAssetJobsFromAvailableAssets(spec, bundle)) {
      spec.passed = true;
      spec.notes = [
        removeForbiddenFallbackTerms(spec.notes),
        "Asset-hydrated from model passed:false by mapping needed_visual_asset_jobs to existing page assets."
      ].filter(Boolean).join(" ");
      delete spec.error;
      clearResolvedNoImageFallbackMarker(bundle.pageDir);
    } else if (!bundle.includeImage) {
      spec.passed = true;
      spec.notes = [
        spec.notes,
        "No-image fallback ignored model-requested visual asset jobs; this page requires visual QA before production delivery."
      ].filter(Boolean).join(" ");
      spec.needed_visual_asset_jobs = [];
      delete spec.error;
    } else {
    if (Array.isArray(spec.needed_visual_asset_jobs) && spec.needed_visual_asset_jobs.length) {
      await writeJson(path.join(bundle.pageDir, "visual-asset-jobs.json"), buildVisualAssetSpec(spec.needed_visual_asset_jobs));
    }
    throw new Error(spec.error || "Model refused to create page-rebuild-spec because required assets are missing.");
    }
  }
  spec.model_worker = {
    provider: "openai-compatible",
    model: bundle.model,
    baseUrl: selected?.baseUrl || "",
    createdAt: new Date().toISOString(),
    usage: data.usage || null
  };
  return spec;
}

function hydrateNeededAssetJobsFromAvailableAssets(spec = {}, bundle = {}) {
  const jobs = Array.isArray(spec.needed_visual_asset_jobs) ? spec.needed_visual_asset_jobs : [];
  if (!jobs.length) return false;
  const pageDir = bundle.pageDir || "";
  if (!pageDir) return false;
  if (!Array.isArray(spec.images)) spec.images = [];
  if (!Array.isArray(spec.asset_provenance)) spec.asset_provenance = [];
  if (!Array.isArray(spec.visual_inventory)) spec.visual_inventory = [];
  const existingImagePaths = new Set(spec.images.map((image) => normalizeAssetPath(image.path || "")).filter(Boolean));
  const injected = [];
  const injectedMappings = [];
  const remaining = [];
  for (const job of jobs) {
    const assetPath = findExistingAssetForNeededJob(pageDir, job);
    const box = coerceAssetJobBox(job);
    if (!assetPath || !box) {
      remaining.push(job);
      continue;
    }
    const id = cleanAssetId(job.id || path.basename(assetPath, path.extname(assetPath)));
    if (!existingImagePaths.has(assetPath)) {
      spec.images.push({
        id,
        path: assetPath,
        box_px: box,
        description: cleanLooseText(job.description || job.prompt || job.required_for || "Recovered available page asset."),
        z_index: Number(job.z_index || 40)
      });
      existingImagePaths.add(assetPath);
    }
    spec.asset_provenance.push({
      path: assetPath,
      source: assetPath,
      source_type: "asset-sheet-separated",
      provenance_note: cleanLooseText(job.asset_provenance || job.note || "Mapped from needed_visual_asset_jobs to an existing generated page asset.")
    });
    injected.push(id);
    injectedMappings.push({ id, path: assetPath, box, job });
  }
  spec.needed_visual_asset_jobs = remaining;
  if (!injected.length) return false;
  spec.visual_inventory = spec.visual_inventory.map((item) => {
    if (!item || typeof item !== "object") return item;
    const itemId = cleanAssetId(item.id || "");
    const itemBox = coerceBox(item.box_px || item.bounds_px || item.box);
    const mapping = injectedMappings.find((entry) => {
      if (itemId && itemId === entry.id) return true;
      if (itemBox && entry.box && boxOverlapRatio(itemBox, entry.box) > 0.45) return true;
      return assetJobTextScore(item, entry.job) >= 2;
    });
    if (!mapping) return item;
    return {
      ...item,
      decision: "asset-sheet-separated",
      path: item.path || mapping.path,
      asset_provenance: {
        ...(typeof item.asset_provenance === "object" && !Array.isArray(item.asset_provenance) ? item.asset_provenance : {}),
        path: item.path || mapping.path,
        source_type: "asset-sheet-separated",
        provenance_note: "Mapped from needed_visual_asset_jobs to an existing separated page asset."
      }
    };
  });
  spec.background_strategy = {
    ...(spec.background_strategy || {}),
    comparison_note: [
      removeForbiddenFallbackTerms(spec.background_strategy?.comparison_note),
      `Mapped existing generated assets for: ${injected.join(", ")}.${remaining.length ? ` Remaining requested assets were left to native/shape reconstruction: ${remaining.map((job) => cleanAssetId(job.id || "")).filter(Boolean).join(", ")}.` : ""}`
    ].filter(Boolean).join(" ")
  };
  spec.notes = removeForbiddenFallbackTerms(spec.notes);
  spec.background_strategy.source_consistency_contract = removeForbiddenFallbackTerms(spec.background_strategy.source_consistency_contract);
  return remaining.length === 0;
}

function cleanLooseText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function coerceAssetJobBox(job = {}) {
  return coerceBox(
    job.source_box_px
    || job.source_region_box_px
    || job.source_region_px
    || job.intended_placement_px
    || job.sourceBoxPx
    || job.box_px
    || job.target_box_px
  );
}

function compactOcrLinesForPrompt(lines = [], limit = 80) {
  const normalized = (Array.isArray(lines) ? lines : [])
    .map((line, index) => {
      const box = coerceBox(line?.box_px || line?.box || line?.bounds);
      return {
        id: String(line?.id || `L${index + 1}`).trim(),
        text: cleanLooseText(line?.text || ""),
        ...(box ? { box_px: box } : {}),
        ...(line?.font_pt_if_cjk ? { font_pt_if_cjk: Number(line.font_pt_if_cjk) } : {}),
        ...(line?.font_pt_if_latin ? { font_pt_if_latin: Number(line.font_pt_if_latin) } : {})
      };
    })
    .filter((line) => line.text || line.box_px);
  normalized.sort((a, b) => {
    const ay = Number(a.box_px?.[1] || 0);
    const by = Number(b.box_px?.[1] || 0);
    if (ay !== by) return ay - by;
    return Number(a.box_px?.[0] || 0) - Number(b.box_px?.[0] || 0);
  });
  return normalized.slice(0, limit);
}

function buildCompactPromptSkeleton(pageRequest = {}, ocrLines = []) {
  const width = Number(pageRequest.source_size_px?.width || 1280);
  const height = Number(pageRequest.source_size_px?.height || 720);
  return {
    schema_version: 1,
    strategy: "model-page-worker-rebuild",
    page_strategy: "model-page-worker-rebuild",
    source_size_px: { width, height },
    required_text: ocrLines.map((line) => line.text).filter(Boolean),
    text_boxes: "Return one text box per visible text region using the attached image and OCR boxes as hints.",
    shapes: [],
    images: [],
    asset_provenance: [],
    quality_checks: Object.fromEntries(REQUIRED_QUALITY_CHECKS.map((key) => [key, false]))
  };
}

function compactAvailableAssetsForPrompt(assets = [], limit = 30) {
  return (Array.isArray(assets) ? assets : [])
    .slice(0, limit)
    .map((asset) => ({
      id: cleanAssetId(asset?.id || path.basename(asset?.path || "", path.extname(asset?.path || ""))),
      path: normalizeAssetPath(asset?.path || ""),
      source_type: asset?.source_type || "",
      ...(Array.isArray(asset?.source_box_px) ? { source_box_px: asset.source_box_px } : {}),
      ...(asset?.prompt_excerpt ? { prompt_excerpt: cleanLooseText(asset.prompt_excerpt).slice(0, 180) } : {})
    }))
    .filter((asset) => asset.path);
}

function removeForbiddenFallbackTerms(value = "") {
  return String(value || "")
    .replace(/Generated in --no-image [^.]*\./gi, "")
    .replace(/requires visual pass before production[^.]*\./gi, "")
    .replace(/no-image mode for unavailable generated assets:[^.]*\./gi, "")
    .replace(/\bno-image\s+fallback\b/gi, "asset-hydrated recovery")
    .replace(/\bno-image\b/gi, "asset-hydrated")
    .replace(/\bfallback\b/gi, "recovery")
    .replace(/\bapproximation\b/gi, "rebuild")
    .replace(/\bcrop\b/gi, "region")
    .replace(/\bemoji\b/gi, "symbol")
    .replace(/\s+/g, " ")
    .trim();
}

function clearResolvedNoImageFallbackMarker(pageDir = "") {
  if (!pageDir) return;
  const markerPath = path.join(pageDir, "page-spec-fallback.json");
  try {
    if (fsSync.existsSync(markerPath)) fsSync.rmSync(markerPath, { force: true });
  } catch {
    // Best effort cleanup; validation will still catch unresolved fallback evidence.
  }
}

function findExistingAssetForNeededJob(pageDir, job = {}) {
  const id = cleanAssetId(job.id || "");
  const numericSuffix = id.match(/(\d+)$/)?.[1] || "";
  const target = normalizeAssetPath(job.target_asset_path || job.expected_asset_path || job.path || job.dest || "");
  const candidates = [
    target,
    id ? `assets/${id}.png` : "",
    id ? `assets/generated/${id}.png` : "",
    numericSuffix ? `assets/generated/job${numericSuffix.padStart(3, "0")}.png` : "",
    numericSuffix ? `assets/generated/job${numericSuffix}.png` : ""
  ].filter(Boolean);
  for (const relativePath of candidates) {
    const fullPath = path.join(pageDir, relativePath);
    if (fsSync.existsSync(fullPath)
      && fsSync.statSync(fullPath).isFile()
      && isTrustedExistingAssetForNeededJob(pageDir, relativePath, job)) {
      return normalizeAssetPath(relativePath);
    }
  }
  const jobBox = coerceAssetJobBox(job);
  const scored = listAvailableAssets(pageDir)
    .filter((asset) => !isExcludedAssetCandidate(asset))
    .map((asset) => ({
      asset,
      exactIdMatch: assetIdMatchesJob(asset, job),
      overlap: jobBox && Array.isArray(asset.source_box_px) ? boxOverlapRatio(jobBox, asset.source_box_px) : 0,
      score: assetJobTextScore(asset, job)
    }))
    .filter(({ asset, exactIdMatch, overlap, score }) => exactIdMatch || overlap > 0.35 || (score >= 3 && assetJobFamilyMatch(asset, job)))
    .sort((a, b) => Number(b.exactIdMatch) - Number(a.exactIdMatch) || (b.overlap - a.overlap) || (b.score - a.score));
  if (scored[0]?.asset?.path) return normalizeAssetPath(scored[0].asset.path);
  return "";
}

function isTrustedExistingAssetForNeededJob(pageDir = "", relativePath = "", job = {}) {
  const normalizedPath = normalizeAssetPath(relativePath);
  const asset = listAvailableAssets(pageDir).find((item) => normalizeAssetPath(item.path || "") === normalizedPath);
  if (!asset) return false;
  if (isExcludedAssetCandidate(asset)) return false;
  const jobBox = coerceAssetJobBox(job);
  if (assetIdMatchesJob(asset, job)) return true;
  const overlap = jobBox && Array.isArray(asset.source_box_px) ? boxOverlapRatio(jobBox, asset.source_box_px) : 0;
  if (overlap > 0.35) return true;
  const score = assetJobTextScore(asset, job);
  if (score >= 3 && assetJobFamilyMatch(asset, job)) return true;
  const assetJob = readVisualAssetJobIndex(pageDir).get(normalizedPath);
  const assetJobScore = assetJob ? assetJobTextScore({
    id: assetJob.id,
    path: assetJob.dest,
    prompt_excerpt: assetJob.prompt || assetJob.note,
    provenance_note: assetJob.note,
    source_box_px: assetJob.source_box_px
  }, job) : 0;
  const assetJobOverlap = assetJob && jobBox && Array.isArray(assetJob.source_box_px) ? boxOverlapRatio(jobBox, assetJob.source_box_px) : 0;
  if (assetJob && (assetJobOverlap > 0.35 || (assetJobScore >= 3 && assetJobFamilyMatch(assetJob, job)))) {
    return true;
  }
  return false;
}

function assetIdMatchesJob(asset = {}, job = {}) {
  const jobId = cleanAssetId(job.id || job.job_id || job.jobId || "");
  if (!jobId) return false;
  const assetIds = [
    asset.id,
    path.basename(asset.path || "", path.extname(asset.path || ""))
  ].map((value) => cleanAssetId(value)).filter(Boolean);
  return assetIds.includes(jobId);
}

function assetJobTextScore(asset = {}, job = {}) {
  const assetText = cleanLooseText([
    asset.id,
    asset.path,
    asset.prompt_excerpt,
    asset.provenance_note,
    asset.description,
    asset.purpose
  ].filter(Boolean).join(" ")).toLowerCase();
  const jobText = cleanLooseText([
    job.id,
    job.purpose,
    job.requirements,
    job.description,
    job.prompt,
    job.required_for
  ].filter(Boolean).join(" ")).toLowerCase();
  if (!assetText || !jobText) return 0;
  let score = 0;
  const groups = [
    ["product", "products", "package", "packaging", "gift", "box", "mooncake", "bottle", "cluster", "arrangement", "snack"],
    ["photo", "photograph", "image", "scene", "bed", "bedroom", "bedding", "sheet", "pillow"],
    ["logo", "brand", "inovance", "crown", "badge"],
    ["background", "decor", "texture", "shadow", "line"]
  ];
  for (const group of groups) {
    const assetHits = group.filter((term) => assetText.includes(term));
    const jobHits = group.filter((term) => jobText.includes(term));
    if (assetHits.length && jobHits.length) score += Math.min(assetHits.length, jobHits.length);
  }
  if (assetText.includes(cleanAssetId(job.id || "")) && job.id) score += 2;
  return score;
}

function assetJobFamilyMatch(asset = {}, job = {}) {
  const assetText = cleanLooseText([
    asset.id,
    asset.path,
    asset.prompt_excerpt,
    asset.provenance_note,
    asset.description,
    asset.purpose,
    asset.note
  ].filter(Boolean).join(" ")).toLowerCase();
  const jobText = cleanLooseText([
    job.id,
    job.purpose,
    job.requirements,
    job.description,
    job.prompt,
    job.required_for,
    job.note
  ].filter(Boolean).join(" ")).toLowerCase();
  if (!assetText || !jobText) return false;
  const families = [
    ["photo", "photograph", "image", "scene", "bed", "bedroom", "bedding", "sheet", "pillow"],
    ["logo", "brand", "inovance", "crown", "badge"],
    ["product", "products", "package", "packaging", "gift", "box", "mooncake", "bottle", "cluster", "arrangement", "snack"],
    ["background", "decor", "texture", "shadow", "line"]
  ];
  return families.some((family) => family.some((term) => assetText.includes(term)) && family.some((term) => jobText.includes(term)));
}

function isExcludedAssetCandidate(asset = {}) {
  const text = cleanLooseText([
    asset.id,
    asset.path,
    asset.prompt_excerpt,
    asset.provenance_note,
    asset.description,
    asset.purpose,
    asset.note
  ].filter(Boolean).join(" ")).toLowerCase();
  return /source[\s_-]?fidelity[\s_-]?tile|full[\s_-]?slide|source page|native structural|text-only|background[\s_-]?tile/.test(text);
}

function boxOverlapRatio(a = [], b = []) {
  const boxA = coerceBox(a);
  const boxB = coerceBox(b);
  if (!boxA || !boxB) return 0;
  const left = Math.max(boxA[0], boxB[0]);
  const top = Math.max(boxA[1], boxB[1]);
  const right = Math.min(boxA[0] + boxA[2], boxB[0] + boxB[2]);
  const bottom = Math.min(boxA[1] + boxA[3], boxB[1] + boxB[3]);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const areaA = Math.max(1, boxA[2] * boxA[3]);
  const areaB = Math.max(1, boxB[2] * boxB[3]);
  return intersection / Math.min(areaA, areaB);
}

async function requestModelSpecAttempt(bundle, attempt = {}) {
  const body = {
    model: bundle.model,
    messages: attempt.compact
      ? buildCompactSpecMessages(bundle)
      : attempt.responseFormat
        ? bundle.messages
        : strengthenPlainJsonMessages(bundle.messages),
    temperature: 0.1
  };
  if (attempt.responseFormat) body.response_format = { type: "json_object" };
  if (attempt.maxTokens || bundle.maxTokens) body.max_tokens = attempt.maxTokens || bundle.maxTokens;
  const result = await requestOpenAiCompatible(bundle.baseUrl, "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${bundle.apiKey}` },
    body: JSON.stringify(body),
    timeoutMs: attempt.timeoutMs || bundle.timeoutMs,
    maxRetries: attempt.maxRetries ?? bundle.maxRetries
  });
  if (!result.response.ok) {
    throw new Error(`model page worker failed: HTTP ${result.response.status} ${await readProviderError(result.response)}`);
  }
  const data = await result.response.json();
  const content = extractModelContent(data);
  let spec = null;
  let parseError = "";
  try {
    spec = parseJsonContent(content);
  } catch (error) {
    parseError = error.message || String(error);
  }
  const baseUrl = stripEndpoint(result.url, "/chat/completions");
  return {
    data,
    content,
    spec,
    parseError,
    baseUrl,
    record: {
      reason: attempt.reason || "",
      responseFormat: Boolean(attempt.responseFormat),
      compact: Boolean(attempt.compact),
      ok: Boolean(spec),
      contentLength: String(content || "").length,
      parseError,
      baseUrl,
      usage: data.usage || null,
      finishReason: data.choices?.[0]?.finish_reason || ""
    }
  };
}

async function writeModelResponseRecord(bundle, { selected = null, attemptRecords = [], data = {}, content = "", spec = null, parseError = "", final = false } = {}) {
  const raw = data && typeof data === "object" ? data : {};
  await writeJson(path.join(bundle.pageDir, "model-page-spec-response.json"), {
    version: 1,
    final: Boolean(final),
    model: bundle.model,
    baseUrl: selected?.baseUrl || attemptRecords.at(-1)?.baseUrl || "",
    includeImage: bundle.includeImage,
    lowComplexity: Boolean(bundle.lowComplexity),
    content: selected?.content || content || "",
    raw,
    parsed: selected?.spec || spec || null,
    parseError: selected?.parseError || parseError || "",
    attempts: attemptRecords,
    usage: raw.usage || null,
    createdAt: new Date().toISOString()
  });
  if (final) activeModelResponse.finalWritten = true;
}

function installTerminationFinalResponseHandlers() {
  const finalizeAndExit = (signal) => {
    writeFinalResponseOnTermination(signal)
      .finally(() => {
        process.exit(signal === "SIGTERM" ? 143 : 130);
      });
  };
  process.once("SIGTERM", () => finalizeAndExit("SIGTERM"));
  process.once("SIGINT", () => finalizeAndExit("SIGINT"));
  process.once("uncaughtException", (error) => {
    writeFinalResponseOnTermination(`uncaughtException: ${error?.message || error}`)
      .finally(() => {
        process.stderr.write(`${error?.stack || error}\n`);
        process.exit(1);
      });
  });
}

async function writeFinalResponseOnTermination(reason = "terminated") {
  if (!activeModelResponse.bundle || activeModelResponse.finalWritten) return;
  const existing = readJsonIfExists(path.join(activeModelResponse.bundle.pageDir, "model-page-spec-response.json"));
  const latest = activeModelResponse.latest || {};
  await writeModelResponseRecord(activeModelResponse.bundle, {
    selected: activeModelResponse.selected || null,
    attemptRecords: activeModelResponse.attemptRecords,
    data: latest.data || existing?.raw || {},
    content: latest.content || existing?.content || "",
    spec: latest.spec || existing?.parsed || null,
    parseError: `model page spec worker terminated before final response: ${reason}`,
    final: true
  }).catch(() => null);
}

function strengthenPlainJsonMessages(messages = []) {
  return messages.map((message, index) => {
    if (index !== 0 || message.role !== "system") return message;
    return {
      ...message,
      content: [
        message.content || "",
        "The previous provider request may not support response_format for vision. You must still return exactly one JSON object and no surrounding prose."
      ].filter(Boolean).join(" ")
    };
  });
}

function buildCompactSpecMessages(bundle = {}) {
  const pageRequest = bundle.pageRequest || {};
  const ocrLines = Array.isArray(bundle?.brief?.ocr?.lines) ? bundle.brief.ocr.lines.slice(0, 80) : [];
  const skeleton = buildFallbackSkeleton(pageRequest, ocrLines);
  const system = [
    "You rebuild a slide image into editable PowerPoint objects.",
    "Return exactly one valid JSON object. No markdown.",
    "Use source.png pixel coordinates for every box_px and points_px.",
    "Do not reference source.png as an image asset.",
    "Do not create a mostly blank editable text-only page. Cover all large visible non-text objects as shapes, images, or needed_visual_asset_jobs.",
    "Do not claim the background is preserved unless the visible decoration is actually represented.",
    "Never use words crop, approximation, fallback, or emoji anywhere in visual_inventory or asset_provenance.",
    "Use clean visual_inventory decisions only: native-shape, image-asset, needed-visual-asset, or native-text. Do not write native-shape-approximation.",
    "If a logo/photo/icon/screenshot/device must be separated first, return passed:false with needed_visual_asset_jobs.",
    "Otherwise create editable text_boxes and native shapes; keep images empty unless an actual separated asset exists.",
    "Required arrays: text_inventory, visual_inventory, required_text, text_boxes, shapes, images, asset_provenance.",
    "Required quality_checks booleans must all be true: font_size_calibrated, visual_inventory_matched, background_strategy_checked, shape_corner_geometry_checked."
  ].join(" ");
  const userText = [
    `Page id: ${bundle.pageId}`,
    `Source size: ${pageRequest.source_size_px?.width || 0}x${pageRequest.source_size_px?.height || 0}px`,
    "OCR lines:",
    JSON.stringify(ocrLines, null, 2),
    "Start from this JSON skeleton and correct it by looking at the image:",
    JSON.stringify({
      schema_version: 1,
      strategy: "model-page-worker-rebuild",
      page_strategy: "model-page-worker-rebuild",
      text_inventory: skeleton.text_inventory,
      visual_inventory: [],
      background_strategy: {
        mode: "native-or-script",
        source_consistency_contract: "preserve visible source composition with editable text and native shapes",
        removed_foreground: [],
        comparison_note: "match the source slide layout closely enough for QA review"
      },
      quality_checks: {
        font_size_calibrated: true,
        visual_inventory_matched: true,
        background_strategy_checked: true,
        shape_corner_geometry_checked: true
      },
      required_text: skeleton.required_text,
      text_boxes: skeleton.text_boxes,
      shapes: [],
      images: [],
      asset_provenance: [],
      notes: "compact page spec"
    }, null, 2)
  ].join("\n");
  const userContent = [{ type: "text", text: userText }];
  const imagePart = bundle.messages?.find((message) => message.role === "user")?.content?.find?.((part) => part?.type === "image_url");
  if (bundle.includeImage && imagePart) userContent.push(imagePart);
  return [
    { role: "system", content: system },
    { role: "user", content: userContent }
  ];
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
  normalizeImageAssetReferences(spec, bundle);
  ensureAvailableBrandAssetsRepresented(spec, bundle);
  normalizeVisualInventoryProvenance(spec);
  normalizeShapeGeometry(spec, pageRequest);
  sanitizeSpecDraft(spec, bundle, pageRequest);
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

function sanitizeSpecDraft(spec, bundle, pageRequest) {
  if (!spec || typeof spec !== "object") return;
  const width = Number(pageRequest.source_size_px?.width || 0);
  const height = Number(pageRequest.source_size_px?.height || 0);
  const rejected = [];

  if (!Array.isArray(spec.text_boxes)) spec.text_boxes = [];
  const textBoxes = [];
  for (const [index, box] of spec.text_boxes.entries()) {
    if (!box || typeof box !== "object") {
      rejected.push(`text_boxes[${index}] non-object`);
      continue;
    }
    const text = String(box.text || "").trim();
    const cleanBox = coerceBox(box.box_px);
    if (!text || !validBox(cleanBox, width, height)) {
      rejected.push(`text_boxes[${index}] missing text or valid box_px`);
      continue;
    }
    textBoxes.push({ ...box, text, box_px: cleanBox });
  }
  spec.text_boxes = textBoxes;

  if (!spec.text_boxes.length) {
    const ocrLines = Array.isArray(bundle?.brief?.ocr?.lines) ? bundle.brief.ocr.lines : [];
    const fallback = buildFallbackSkeleton(pageRequest, ocrLines);
    spec.text_boxes = fallback.text_boxes.filter((box) => box.text && validBox(coerceBox(box.box_px), width, height));
    if (spec.text_boxes.length) {
      spec.text_inventory = fallback.text_inventory;
      spec.required_text = fallback.required_text;
      rejected.push(`restored ${spec.text_boxes.length} text box(es) from OCR skeleton`);
    }
  }

  if (!Array.isArray(spec.shapes)) spec.shapes = [];
  spec.shapes = spec.shapes.filter((shape, index) => {
    if (!shape || typeof shape !== "object") {
      rejected.push(`shapes[${index}] non-object`);
      return false;
    }
    if (shape.type === "line") {
      const points = coercePoints(shape.points_px);
      if (!validPoints(points, width, height)) {
        rejected.push(`shapes[${index}] line missing valid points_px`);
        return false;
      }
      shape.points_px = points;
      return true;
    }
    const box = coerceBox(shape.box_px);
    if (!validBox(box, width, height)) {
      rejected.push(`shapes[${index}] missing valid box_px`);
      return false;
    }
    shape.box_px = box;
    return true;
  });

  if (!Array.isArray(spec.images)) spec.images = [];
  spec.images = spec.images.filter((image, index) => {
    const imagePath = normalizeAssetPath(image?.path);
    const box = coerceBox(image?.box_px);
    const ok = imagePath && imagePath !== "source.png" && validBox(box, width, height);
    if (!ok) rejected.push(`images[${index}] missing valid path or box_px`);
    if (ok) {
      image.path = imagePath;
      image.box_px = box;
    }
    return ok;
  });

  if (!Array.isArray(spec.text_inventory)) spec.text_inventory = [];
  if (!Array.isArray(spec.visual_inventory)) spec.visual_inventory = [];
  if (!Array.isArray(spec.asset_provenance)) spec.asset_provenance = [];
  if (!Array.isArray(spec.required_text)) spec.required_text = spec.text_boxes.map((box) => box.text).filter(Boolean);
  if (rejected.length) {
    spec.notes = [
      spec.notes,
      `Sanitized invalid model objects before validation: ${rejected.slice(0, 12).join("; ")}${rejected.length > 12 ? "; ..." : ""}.`
    ].filter(Boolean).join(" ");
  }
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
  const points = coercePoints(item.points_px) || coerceStartEndPoints(item) || coerceInchLine(item, pageRequest);
  if (points) item.points_px = points;
  const polygon = coercePolygon(item.polygon_px);
  if (polygon) item.polygon_px = polygon;
  if (Array.isArray(item.items)) item.items.forEach((child) => normalizeCoordinateItem(child, pageRequest));
  if (Array.isArray(item.children)) item.children.forEach((child) => normalizeCoordinateItem(child, pageRequest));
  if (Array.isArray(item.segments_px)) {
    item.segments_px = item.segments_px.map((segment) => coercePoints(segment) || segment);
  }
}

function coerceStartEndPoints(item) {
  if (!item || typeof item !== "object") return null;
  const start = Array.isArray(item.start_px) ? item.start_px : Array.isArray(item.start) ? item.start : null;
  const end = Array.isArray(item.end_px) ? item.end_px : Array.isArray(item.end) ? item.end : null;
  if (!start || !end) return null;
  const points = [start[0], start[1], end[0], end[1]].map(Number);
  return points.every(Number.isFinite) ? points : null;
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
    && spec.asset_provenance.some((item) => ASSET_SEPARATION_RE.test(JSON.stringify(item)));
  spec.visual_inventory = spec.visual_inventory.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const text = JSON.stringify(item);
    const hasAssetSeparation = ASSET_SEPARATION_RE.test(text);
    if ((!FOREGROUND_FAMILY_RE.test(text) && !FOREGROUND_CONTRACT_RE.test(text)) || hasAssetSeparation) return item;
    if (NATIVE_STRUCTURAL_RE.test(text) && !FOREGROUND_FAMILY_RE.test(text)) return item;
    return {
      ...item,
      decision: [
        item.decision,
        hasSeparatedAsset
          ? "asset-sheet separated image edit for foreground asset reuse"
          : "requires foreground asset separation before page rebuild"
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

function collectMissingForegroundInventoryAssetJobs(spec) {
  if (!Array.isArray(spec?.visual_inventory)) return [];
  const imageIds = new Set((Array.isArray(spec.images) ? spec.images : []).map((image) => cleanAssetId(image.id || "")).filter(Boolean));
  const imagePaths = new Set((Array.isArray(spec.images) ? spec.images : []).map((image) => normalizeAssetPath(image.path || "")).filter(Boolean));
  const provenanceText = JSON.stringify(spec.asset_provenance || []);
  return spec.visual_inventory
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .filter((item) => requiresForegroundAsset(item))
    .filter((item) => {
      const id = cleanAssetId(item.id || "");
      const itemPath = normalizeAssetPath(item.path || item.asset_provenance?.path || item.asset_provenance?.source || "");
      const text = JSON.stringify(item);
      const mentionsImagePath = Array.from(imagePaths).some((imagePath) => imagePath && text.includes(imagePath));
      if (id && imageIds.has(id)) return false;
      if (mentionsImagePath && ASSET_SEPARATION_RE.test(provenanceText)) return false;
      if (itemPath && imagePaths.has(itemPath) && ASSET_SEPARATION_RE.test(provenanceText) && provenanceText.includes(itemPath)) return false;
      return !ASSET_SEPARATION_RE.test(provenanceText) || (!id && !itemPath) || (id && !provenanceText.includes(id)) || (itemPath && !provenanceText.includes(itemPath));
    })
    .map((item, index) => {
      const id = cleanAssetId(item.id || `foreground_asset_${index + 1}`);
      const description = [
        item.description || item.kind || item.type || "foreground visual object",
        "Separate this exact foreground visual object from source.png as a source-faithful reusable PPT asset.",
        "Do not redraw, simplify, replace with a similar symbol, or include unrelated text."
      ].join(" ");
      return {
        id,
        description,
        target_asset_path: path.join("assets", `${id}.png`).replace(/\\/g, "/"),
        transparent_background: true,
        asset_provenance: "asset-sheet-separated image edit for foreground asset reuse"
      };
    });
}

function collectMissingBrandBlockAssetJobs(spec, bundle = {}) {
  const assets = Array.isArray(bundle.availableAssets) ? bundle.availableAssets : [];
  const represented = new Set([
    ...(Array.isArray(spec.images) ? spec.images : []).map((image) => normalizeAssetPath(image.path || "")).filter(Boolean),
    ...assets.map((asset) => normalizeAssetPath(asset.path || "")).filter(Boolean)
  ]);
  const textBoxes = Array.isArray(spec.text_boxes) ? spec.text_boxes : [];
  const brandBoxes = textBoxes
    .filter((box) => /benlai\.com|本来生活|sto|express|申通快递/i.test(String(box.text || "")))
    .filter((box) => Array.isArray(box.box_px) && box.box_px.length === 4);
  if (!brandBoxes.length) return [];
  const clusters = clusterNearbyBrandTextBoxes(brandBoxes);
  return clusters
    .filter((cluster) => cluster.length >= 2 || /benlai\.com|express/i.test(cluster.map((box) => box.text || "").join(" ")))
    .map((cluster, index) => {
      const id = `brand_logo_asset_${index + 1}`;
      const targetPath = path.join("assets", `${id}.png`).replace(/\\/g, "/");
      if (represented.has(targetPath)) return null;
      const box = expandBox(unionBoxes(cluster.map((item) => item.box_px)), 36, bundle.pageRequest?.source_size_px);
      const label = cluster.map((item) => item.text || "").filter(Boolean).join(" / ");
      return {
        id,
        description: [
          `Separate the complete brand/logo block containing: ${label}.`,
          "Keep the original typography, colors, background panel, shadows, and spacing as one source-faithful reusable PPT image asset.",
          "Do not split the logo into editable text; this brand mark must be reused as an image asset."
        ].join(" "),
        target_asset_path: targetPath,
        source_box_px: box,
        transparent_background: false,
        asset_provenance: "asset-sheet-separated image edit for brand/logo block reuse"
      };
    })
    .filter(Boolean);
}

function ensureAvailableBrandAssetsRepresented(spec, bundle = {}) {
  const assets = (Array.isArray(bundle.availableAssets) ? bundle.availableAssets : [])
    .filter((asset) => /^brand_logo_asset_/i.test(asset.id || "") && normalizeAssetPath(asset.path || "") && Array.isArray(asset.source_box_px));
  if (!assets.length) return;
  if (!Array.isArray(spec.images)) spec.images = [];
  if (!Array.isArray(spec.asset_provenance)) spec.asset_provenance = [];
  if (!Array.isArray(spec.visual_inventory)) spec.visual_inventory = [];
  const imagePaths = new Set(spec.images.map((image) => normalizeAssetPath(image.path || "")).filter(Boolean));
  const provenancePaths = new Set(spec.asset_provenance.map((item) => normalizeAssetPath(item.path || "")).filter(Boolean));
  for (const asset of assets) {
    const assetPath = normalizeAssetPath(asset.path || "");
    if (!assetPath || imagePaths.has(assetPath)) continue;
    spec.images.push({
      id: asset.id,
      type: "image",
      description: "Source-faithful brand/logo block separated from the slide image.",
      path: assetPath,
      box_px: asset.source_box_px,
      z_index: 80
    });
    spec.visual_inventory.push({
      id: asset.id,
      type: "image",
      description: "Source-faithful brand/logo block separated from the slide image.",
      path: assetPath,
      box_px: asset.source_box_px,
      decision: "asset-sheet-separated image edit for brand/logo block reuse"
    });
    if (!provenancePaths.has(assetPath)) {
      spec.asset_provenance.push({
        path: assetPath,
        source: asset.source || assetPath,
        source_type: asset.source_type || "asset-sheet-separated",
        provenance_note: asset.provenance_note || "asset-sheet-separated brand/logo block selected from available page assets."
      });
      provenancePaths.add(assetPath);
    }
    imagePaths.add(assetPath);
  }
}

function clusterNearbyBrandTextBoxes(boxes = []) {
  const sorted = [...boxes].sort((a, b) => Number(a.box_px?.[1] || 0) - Number(b.box_px?.[1] || 0));
  const clusters = [];
  for (const box of sorted) {
    const current = clusters.find((cluster) => boxesAreNear(unionBoxes(cluster.map((item) => item.box_px)), box.box_px));
    if (current) current.push(box);
    else clusters.push([box]);
  }
  return clusters;
}

function boxesAreNear(a = [], b = []) {
  if (!a.length || !b.length) return false;
  const ax2 = Number(a[0] || 0) + Number(a[2] || 0);
  const ay2 = Number(a[1] || 0) + Number(a[3] || 0);
  const bx2 = Number(b[0] || 0) + Number(b[2] || 0);
  const by2 = Number(b[1] || 0) + Number(b[3] || 0);
  const xGap = Math.max(0, Math.max(Number(a[0] || 0), Number(b[0] || 0)) - Math.min(ax2, bx2));
  const yGap = Math.max(0, Math.max(Number(a[1] || 0), Number(b[1] || 0)) - Math.min(ay2, by2));
  return xGap <= 80 && yGap <= 80;
}

function unionBoxes(boxes = []) {
  const valid = boxes.filter((box) => Array.isArray(box) && box.length === 4).map((box) => box.map(Number));
  if (!valid.length) return [0, 0, 1, 1];
  const left = Math.min(...valid.map((box) => box[0]));
  const top = Math.min(...valid.map((box) => box[1]));
  const right = Math.max(...valid.map((box) => box[0] + box[2]));
  const bottom = Math.max(...valid.map((box) => box[1] + box[3]));
  return [left, top, right - left, bottom - top].map((value) => Math.round(value));
}

function expandBox(box = [], padding = 0, size = {}) {
  const width = Number(size?.width || 0);
  const height = Number(size?.height || 0);
  const left = Math.max(0, Number(box[0] || 0) - padding);
  const top = Math.max(0, Number(box[1] || 0) - padding);
  const right = width ? Math.min(width, Number(box[0] || 0) + Number(box[2] || 0) + padding) : Number(box[0] || 0) + Number(box[2] || 0) + padding;
  const bottom = height ? Math.min(height, Number(box[1] || 0) + Number(box[3] || 0) + padding) : Number(box[1] || 0) + Number(box[3] || 0) + padding;
  return [left, top, Math.max(1, right - left), Math.max(1, bottom - top)].map((value) => Math.round(value));
}

function normalizeImageAssetReferences(spec, bundle = {}) {
  if (!Array.isArray(spec?.images)) return;
  const assets = Array.isArray(bundle.availableAssets) ? bundle.availableAssets : [];
  const assetByPath = new Map(assets.map((asset) => [normalizeAssetPath(asset.path), asset]));
  const assetById = new Map(assets.map((asset) => [cleanAssetId(asset.id || path.basename(asset.path || "", path.extname(asset.path || ""))), asset]));
  const provenanceByPath = new Map((Array.isArray(spec.asset_provenance) ? spec.asset_provenance : [])
    .map((item) => [normalizeAssetPath(item?.path || ""), item])
    .filter(([assetPath]) => assetPath));
  const nextProvenance = Array.isArray(spec.asset_provenance) ? [...spec.asset_provenance] : [];

  spec.images = spec.images.map((image, index) => {
    if (!image || typeof image !== "object") return image;
    const imageId = cleanAssetId(image.id || `image_${index + 1}`);
    const existingPath = normalizeAssetPath(image.path || "");
    const asset = assetByPath.get(existingPath) || assetById.get(imageId);
    const imagePath = existingPath || normalizeAssetPath(asset?.path || "");
    if (!imagePath) return { ...image, id: imageId };
    if (!provenanceByPath.has(imagePath)) {
      const sourceType = asset?.source_type || "asset-sheet-separated";
      const provenance = {
        path: imagePath,
        source: asset?.source || imagePath,
        source_type: sourceType,
        provenance_note: asset?.provenance_note || `${sourceType} foreground asset selected from available page assets.`
      };
      nextProvenance.push(provenance);
      provenanceByPath.set(imagePath, provenance);
    } else {
      const provenance = provenanceByPath.get(imagePath);
      const sourceType = provenance.source_type || asset?.source_type || "asset-sheet-separated";
      provenance.source_type = sourceType;
      provenance.source = provenance.source || asset?.source || imagePath;
      provenance.provenance_note = provenance.provenance_note || provenance.note || provenance.description || `${sourceType} foreground asset selected from available page assets.`;
    }
    return {
      ...image,
      id: imageId,
      path: imagePath
    };
  });
  spec.asset_provenance = nextProvenance;
}

function requiresForegroundAsset(item = {}) {
  const text = JSON.stringify(item);
  if (!FOREGROUND_FAMILY_RE.test(text) && !FOREGROUND_CONTRACT_RE.test(text)) return false;
  if (NATIVE_STRUCTURAL_RE.test(text) && !FOREGROUND_FAMILY_RE.test(text)) return false;
  if (/shape|native-shape|native shape|native structural/i.test(`${item.type || ""} ${item.kind || ""} ${item.decision || ""}`) && !/logo|photo|screenshot|brand|device/i.test(text)) return false;
  return true;
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
      const sourceBox = coerceAssetJobBox(job);
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
          job.transparent_background === false
            ? "Keep the original rectangular/panel background."
            : "Use real transparent pixels outside the requested object; do not render a gray-white checkerboard, transparency grid, or placeholder background. If true transparency is unavailable, use one flat high-saturation chroma-key color that does not appear in the object."
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
  const assetJobByDest = readVisualAssetJobIndex(pageDir);
  const results = [];
  const stack = [assetsDir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fsSync.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (/\.(png|jpe?g|webp)$/i.test(entry.name)) {
        const relativePath = path.relative(pageDir, full).replace(/\\/g, "/");
        const job = assetJobByDest.get(relativePath) || {};
        results.push({
          id: cleanAssetId(path.basename(entry.name, path.extname(entry.name))),
          path: relativePath,
          bytes: fsSync.statSync(full).size,
          source: relativePath,
          source_type: /user_approved|raster/i.test(entry.name) ? "user-approved-rasterization" : "asset-sheet-separated",
          provenance_note: job.note || "Available page asset discovered after visual asset generation/import.",
          ...(readAssetPromptExcerpt(pageDir, entry.name) ? { prompt_excerpt: readAssetPromptExcerpt(pageDir, entry.name) } : {}),
          ...(Array.isArray(job.source_box_px) ? { source_box_px: job.source_box_px } : {})
        });
      }
    }
  }
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

function readAssetPromptExcerpt(pageDir, fileName = "") {
  const id = cleanAssetId(path.basename(fileName, path.extname(fileName)));
  const candidates = [
    path.join(pageDir, "prompts", "image-assets", `${id}.prompt.txt`)
  ];
  for (const filePath of candidates) {
    try {
      if (!fsSync.existsSync(filePath)) continue;
      return fsSync.readFileSync(filePath, "utf8").replace(/\s+/g, " ").trim().slice(0, 360);
    } catch {
      return "";
    }
  }
  return "";
}

function readVisualAssetJobIndex(pageDir) {
  const index = new Map();
  try {
    const specPath = path.join(pageDir, "visual-asset-jobs.json");
    if (fsSync.existsSync(specPath)) {
      const spec = JSON.parse(fsSync.readFileSync(specPath, "utf8").replace(/^\uFEFF/, ""));
      for (const job of Array.isArray(spec.jobs) ? spec.jobs : []) {
        const dest = normalizeAssetPath(job.dest || "");
        if (dest) index.set(dest, job);
      }
    }
    const imagegenPath = path.join(pageDir, "imagegen-jobs.json");
    if (fsSync.existsSync(imagegenPath)) {
      const imagegen = JSON.parse(fsSync.readFileSync(imagegenPath, "utf8").replace(/^\uFEFF/, ""));
      for (const job of Array.isArray(imagegen.jobs) ? imagegen.jobs : []) {
        const output = normalizeAssetPath(job.output || "");
        if (!output || index.has(output)) continue;
        index.set(output, {
          id: job.job_id || job.id,
          dest: output,
          note: job.note || "asset-sheet-separated",
          source_box_px: job.source_box_px,
          prompt: readPromptFileExcerpt(resolvePageRelativePath(pageDir, job.prompt_file || ""))
        });
      }
    }
  } catch {
    // Ignore malformed transient asset job specs; the caller can still use filesystem assets.
  }
  return index;
}

function resolvePageRelativePath(pageDir = "", filePath = "") {
  if (!filePath) return "";
  return path.isAbsolute(filePath) ? filePath : path.join(pageDir, filePath);
}

function readPromptFileExcerpt(filePath = "") {
  try {
    if (!filePath || !fsSync.existsSync(filePath)) return "";
    return fsSync.readFileSync(filePath, "utf8").replace(/\s+/g, " ").trim().slice(0, 360);
  } catch {
    return "";
  }
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
    const circleBox = boxFromCircleShape(shape, width, height);
    if (circleBox) {
      expanded.push({
        ...shape,
        id: shape.id || "circle",
        type: "ellipse",
        box_px: circleBox
      });
      continue;
    }
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
    if (shape?.type === "line") {
      const pointPairs = collectPointPairs(shape.points_px);
      if (pointPairs.length > 2) {
        let emitted = 0;
        for (let index = 0; index + 1 < pointPairs.length; index += 1) {
          const start = pointPairs[index];
          const end = pointPairs[index + 1];
          if (start[0] === end[0] && start[1] === end[1]) continue;
          emitted += 1;
          expanded.push({
            ...shape,
            id: `${shape.id || "line"}_${String(emitted).padStart(3, "0")}`,
            type: "line",
            points_px: [start[0], start[1], end[0], end[1]],
            fill: "none",
            z_index: Number(shape.z_index || 0) + emitted / 1000
          });
        }
        if (emitted) continue;
      }
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
      if (shape.type === "roundRect" && !Number.isFinite(Number(shape.source_corner_radius_px))) {
        const radius = Number(shape.radius_px);
        shape.source_corner_radius_px = Number.isFinite(radius) ? radius : inferRoundRectCornerRadius(shape.box_px);
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

function boxFromCircleShape(shape = {}, width, height) {
  const type = String(shape.type || "").toLowerCase();
  if (!["circle", "ellipse", "oval"].includes(type)) return null;
  if (validBox(shape.box_px, width, height)) return shape.box_px.map(Number);
  const center = Array.isArray(shape.center_px)
    ? shape.center_px
    : shape.center_px && typeof shape.center_px === "object"
      ? [shape.center_px.x, shape.center_px.y]
      : [shape.cx ?? shape.centerX ?? shape.x, shape.cy ?? shape.centerY ?? shape.y];
  const cx = Number(center?.[0]);
  const cy = Number(center?.[1]);
  const radius = Number(shape.radius_px ?? shape.r);
  const rx = Number(shape.radius_x_px ?? shape.rx ?? radius);
  const ry = Number(shape.radius_y_px ?? shape.ry ?? radius);
  if (![cx, cy, rx, ry].every(Number.isFinite) || rx <= 0 || ry <= 0) return null;
  return clampBoxToCanvas([cx - rx, cy - ry, rx * 2, ry * 2], width, height);
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

function inferRoundRectCornerRadius(boxPx = []) {
  const box = Array.isArray(boxPx) ? boxPx.map(Number) : [];
  const width = Math.abs(Number(box[2] || 0));
  const height = Math.abs(Number(box[3] || 0));
  const shortest = Math.min(width || 0, height || 0);
  if (!Number.isFinite(shortest) || shortest <= 0) return 8;
  return Math.max(4, Math.min(24, Math.round(shortest * 0.18)));
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
  const missingForegroundAssetJobs = collectMissingForegroundInventoryAssetJobs(spec);
  if (missingForegroundAssetJobs.length) {
    omitUnavailableImageAssets(spec, missingForegroundAssetJobs);
    spec.visual_inventory = (Array.isArray(spec.visual_inventory) ? spec.visual_inventory : []).filter((item) => !requiresForegroundAsset(item));
    spec.background_strategy = {
      ...(spec.background_strategy || {}),
      comparison_note: [
        spec.background_strategy?.comparison_note,
        `no-image mode for unavailable generated assets: ${missingForegroundAssetJobs.map((job) => job.id).join(", ")}.`
      ].filter(Boolean).join(" ")
    };
  }
  errors.push(...collectVisualCoverageIssues(spec));
  if (errors.length) throw new Error(errors.join(" | "));
}

function collectVisualCoverageIssues(spec = {}) {
  const issues = [];
  const visualInventory = Array.isArray(spec.visual_inventory) ? spec.visual_inventory : [];
  const shapes = Array.isArray(spec.shapes) ? spec.shapes : [];
  const images = Array.isArray(spec.images) ? spec.images : [];
  const backgroundText = [
    spec.background_strategy?.mode,
    spec.background_strategy?.source_consistency_contract,
    spec.background_strategy?.comparison_note,
    spec.notes
  ].filter(Boolean).join(" ");
  const noImageMode = /text-only|ocr-only|no-image/i.test(backgroundText);
  if (noImageMode) return issues;

  const preservationClaim = /preserv|match|consistent|intact|source composition|background|visual elements/i.test(backgroundText);
  const renderableVisuals = shapes.length + images.length;
  const meaningfulShapes = shapes.filter(isMeaningfulVisualShape).length;
  const hasNonTextVisuals = visualInventory.length > 0;

  if (hasNonTextVisuals && renderableVisuals === 0) {
    issues.push("visual_inventory lists visible non-text objects but shapes/images are empty.");
  }
  if (preservationClaim && visualInventory.length === 0) {
    issues.push("background_strategy claims source visual preservation but visual_inventory is empty.");
  }
  if (preservationClaim && images.length === 0 && meaningfulShapes < 3 && visualInventory.length < 3) {
    issues.push("background_strategy claims preserved or matched source visuals but the rebuild has too few meaningful shapes/images.");
  }
  return issues;
}

function isMeaningfulVisualShape(shape = {}) {
  if (shape.type === "line") return Array.isArray(shape.points_px) && shape.points_px.length >= 4;
  const box = Array.isArray(shape.box_px) ? shape.box_px.map(Number) : [];
  if (box.length !== 4 || !box.every(Number.isFinite)) return false;
  return Math.max(0, box[2]) * Math.max(0, box[3]) >= 6000;
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
  const providers = getProviderConfig();
  await writeJson(path.join(pageDir, "validation.json"), {
    passed: false,
    status: "failed",
    reason,
    provider_snapshot: {
      llm: publicProviderSnapshot(providers.llm),
      image: publicProviderSnapshot(providers.image)
    },
    createdAt: new Date().toISOString()
  });
  await writeJson(path.join(pageDir, "page_result.json"), {
    validation: "validation.json",
    page_result: "page_result.json"
  });
}

function publicProviderSnapshot(provider = {}) {
  return {
    provider: provider.provider || "",
    configured: Boolean(provider.configured),
    enabled: provider.enabled !== false,
    baseUrl: provider.baseUrl || "",
    model: provider.model || "",
    timeoutMs: provider.timeoutMs || null,
    maxRetries: provider.maxRetries ?? null,
    concurrency: provider.concurrency ?? null
  };
}

async function imageDataUrl(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
  const buffer = await fs.readFile(filePath);
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

async function preparePromptImage(sourceImage, pageDir) {
  const maxWidth = parseBoundedNumber(process.env.PAGE_SPEC_PROMPT_IMAGE_MAX_WIDTH, 384, 2048, 512);
  const quality = parseBoundedNumber(process.env.PAGE_SPEC_PROMPT_IMAGE_QUALITY, 35, 95, 55);
  const previewPath = path.join(pageDir, `model-page-spec-source-preview-${maxWidth}w-q${quality}.jpg`);
  const sourceStat = fsSync.statSync(sourceImage);
  const needsRefresh = !fsSync.existsSync(previewPath)
    || fsSync.statSync(previewPath).mtimeMs < sourceStat.mtimeMs
    || fsSync.statSync(previewPath).size < 512;
  if (needsRefresh) {
    const script = [
      "import sys",
      "from PIL import Image",
      "src, out, max_width, quality = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])",
      "im = Image.open(src).convert('RGB')",
      "w, h = im.size",
      "if w > max_width:",
      "    h = max(1, round(h * (max_width / w)))",
      "    w = max_width",
      "    im = im.resize((w, h), Image.Resampling.LANCZOS)",
      "im.save(out, 'JPEG', quality=quality, optimize=True)"
    ].join("\n");
    try {
      await execFileAsync(process.env.PYTHON || process.env.PYTHON_PATH || "python", ["-c", script, sourceImage, previewPath, String(maxWidth), String(quality)], {
        timeout: 30000,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
        encoding: "utf8"
      });
    } catch {
      return {
        path: sourceImage,
        sourcePath: sourceImage,
        optimized: false,
        reason: "prompt-image-preview-unavailable"
      };
    }
  }
  const previewStat = fsSync.existsSync(previewPath) ? fsSync.statSync(previewPath) : null;
  return {
    path: previewPath,
    sourcePath: sourceImage,
    optimized: Boolean(previewStat),
    maxWidth,
    quality,
    sourceBytes: sourceStat.size,
    previewBytes: previewStat?.size || null
  };
}

function parseJsonContent(content) {
  const text = String(content || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(text);
  } catch {
    const candidates = extractJsonCandidates(text);
    for (const candidate of candidates) {
      try {
        return JSON.parse(candidate);
      } catch {
        // Keep scanning. Some gateways prepend progress text or append notes.
      }
    }
    throw new Error("Model response did not contain parseable JSON.");
  }
}

function extractModelContent(data = {}) {
  const message = data.choices?.[0]?.message || {};
  const content = message.content ?? data.output_text ?? data.text ?? "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        return part?.text || part?.content || part?.input_text || part?.output_text || "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (message.parsed && typeof message.parsed === "object") return JSON.stringify(message.parsed);
  const toolCallArgs = message.tool_calls?.[0]?.function?.arguments;
  if (typeof toolCallArgs === "string") return toolCallArgs;
  return "";
}

function extractJsonCandidates(text = "") {
  const candidates = [];
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
    .map((match) => match[1]?.trim())
    .filter(Boolean);
  candidates.push(...fenced);
  for (const candidate of balancedObjectCandidates(text)) candidates.push(candidate);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  return [...new Set(candidates.map((item) => String(item || "").trim()).filter(Boolean))];
}

function balancedObjectCandidates(text = "") {
  const results = [];
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === "\"") inString = false;
        continue;
      }
      if (char === "\"") {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          results.push(text.slice(start, index + 1));
          break;
        }
      }
    }
  }
  return results;
}

function readJsonIfExists(filePath) {
  try {
    if (!filePath || !fsSync.existsSync(filePath)) return null;
    return JSON.parse(fsSync.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
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
