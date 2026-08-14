import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { imageSize } from "image-size";
import { rootDir } from "./store.js";
import { readWorkflowJob, saveWorkflowJob } from "./workflowJobs.js";
import { analyzeGeneratedImage } from "./imageQa.js";
import { appendEvent, artifactRecord, getRenderedPages, markStage } from "./workflowVisuals.js";
import { inferDeckPageRole } from "./workflowDeckDesignSystem.js";

const ARTIFACT_STEM = "information_asset_map";
const execFileAsync = promisify(execFile);

export async function buildWorkflowInformationAssetMap(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const renderedPages = getRenderedPages(job);
  if (!renderedPages.length) {
    throw new Error("No rendered source pages. Run source/render first.");
  }

  const now = new Date().toISOString();
  const outDir = path.join(job.rootDir, "codex-ppt");
  const fidelityAssetDir = path.join(outDir, "fidelity-assets");
  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir(fidelityAssetDir, { recursive: true });

  const pages = [];
  for (const page of renderedPages) {
    pages.push(await buildPageAssetRecord(page, renderedPages.length, fidelityAssetDir));
  }

  const summary = buildAssetSummary(pages);
  const fidelityAssetManifest = buildFidelityAssetManifest({
    job,
    pages,
    rootDir: fidelityAssetDir,
    recordedAt: now
  });
  const payload = {
    kind: "codex_ppt_information_asset_map",
    version: 1,
    jobId: job.id,
    source: cleanText(options.source || "route-a-pre-sample"),
    confidence: "heuristic",
    rule: "Preserve source information assets first; redraw visual treatment second.",
    pageCount: pages.length,
    summary,
    fidelityAssets: fidelityAssetManifest,
    pages,
    reviewRules: [
      "Original photos, product screenshots, logos, charts, tables, QR codes, and data labels must keep their factual content.",
      "Backgrounds, cards, dividers, colors, spacing, and decorative shapes may be redesigned.",
      "Readable titles and short labels may be re-rendered for sharpness, but meaning and numeric values must not change.",
      "If an original image cannot be identified with confidence, keep it as an image reference instead of inventing a replacement."
    ],
    recordedBy: cleanText(options.recordedBy || options.requestedBy || "frontend-route-a"),
    recordedAt: now
  };

  const jsonPath = path.join(outDir, `${ARTIFACT_STEM}.json`);
  const markdownPath = path.join(outDir, `${ARTIFACT_STEM}.md`);
  const fidelityManifestPath = path.join(fidelityAssetDir, "manifest.json");
  await fs.writeFile(jsonPath, JSON.stringify(payload, null, 2), "utf8");
  await fs.writeFile(markdownPath, buildAssetMarkdown(payload), "utf8");
  await fs.writeFile(fidelityManifestPath, JSON.stringify(fidelityAssetManifest, null, 2), "utf8");
  const [jsonStat, markdownStat, fidelityStat] = await Promise.all([fs.stat(jsonPath), fs.stat(markdownPath), fs.stat(fidelityManifestPath)]);
  const fidelityArtifact = artifactRecord("codex_ppt_fidelity_assets", fidelityManifestPath, {
    rootPath: fidelityAssetDir,
    rootRelativePath: path.relative(rootDir, fidelityAssetDir),
    pageCount: payload.pageCount,
    assetCount: fidelityAssetManifest.assetCount,
    size: fidelityStat.size,
    sha256: await hashFile(fidelityManifestPath),
    createdAt: now
  });
  const artifact = {
    ...artifactRecord("codex_ppt_information_asset_map", jsonPath, {
      markdownPath,
      fidelityAssetManifestPath: fidelityManifestPath,
      fidelityAssetRootPath: fidelityAssetDir,
      relativePath: path.relative(rootDir, jsonPath),
      markdownRelativePath: path.relative(rootDir, markdownPath),
      fidelityAssetManifestRelativePath: path.relative(rootDir, fidelityManifestPath),
      fidelityAssetRootRelativePath: path.relative(rootDir, fidelityAssetDir),
      pageCount: payload.pageCount,
      summary,
      confidence: payload.confidence,
      size: jsonStat.size,
      markdownSize: markdownStat.size,
      sha256: await hashFile(jsonPath),
      markdownSha256: await hashFile(markdownPath),
      createdAt: now
    })
  };

  job.artifacts = {
    ...(job.artifacts || {}),
    codexPptInformationAssets: artifact,
    informationAssetMap: artifact,
    codexPptFidelityAssets: fidelityArtifact
  };
  job.stages.information_assets = markStage(job.stages.information_assets, "complete", "Recorded source information asset map", {
    pageCount: payload.pageCount,
    fidelityAssets: fidelityAssetManifest.assetCount,
    source: payload.source,
    confidence: payload.confidence
  });
  job.events = appendEvent(job.events, "codex-ppt.information-assets.recorded", "Recorded source information asset map", {
    pageCount: payload.pageCount,
    fidelityAssets: fidelityAssetManifest.assetCount,
    source: payload.source,
    path: jsonPath
  });

  return saveWorkflowJob(job);
}

export function hasWorkflowInformationAssetMap(job = {}) {
  const artifact = job.artifacts?.codexPptInformationAssets || job.artifacts?.informationAssetMap || {};
  return Boolean(artifact.path || artifact.relativePath || artifact.markdownPath);
}

export function assertWorkflowInformationAssetMapReady(job = {}) {
  if (hasWorkflowInformationAssetMap(job)) return;
  const error = new Error("Information asset map is required before codex-ppt visual generation.");
  error.code = "CODEX_PPT_INFORMATION_ASSET_MAP_REQUIRED";
  error.status = 409;
  throw error;
}

async function buildPageAssetRecord(page = {}, totalPages = 0, fidelityAssetDir = "") {
  const dimensions = getImageDimensions(page.path);
  const qa = await analyzeGeneratedImage(page.path).catch((error) => ({
    ok: false,
    error: error.message || "image analysis failed"
  }));
  const pageId = page.pageId || `page_${String(page.pageNumber || 1).padStart(3, "0")}`;
  const role = inferDeckPageRole(page, { totalPages });
  const risks = inferRisks(page, qa);
  const reusableAssets = await buildReusableAssets({ page, pageId, dimensions, risks, fidelityAssetDir });
  const preserve = [
    {
      type: "source-page-reference",
      label: "Full original page",
      reason: "Baseline for factual fidelity and visual comparison.",
      sourcePath: page.path || "",
      reusableAssetId: reusableAssets.find((asset) => asset.type === "source-page-reference")?.assetId || "",
      required: true
    },
    ...inferPreserveAssets(page, qa, risks, reusableAssets)
  ];
  return {
    pageId,
    pageNumber: Number(page.pageNumber || 0),
    role,
    sourcePagePath: page.path || "",
    width: dimensions?.width || page.width || null,
    height: dimensions?.height || page.height || null,
    outlineTitle: cleanText(page.outlineTitle || ""),
    outlinePurpose: cleanText(page.outlinePurpose || ""),
    textDensity: inferTextDensity(page),
    visualDensity: inferVisualDensity(qa),
    reusableAssets,
    mustPreserve: preserve,
    mayRedesign: [
      "background treatment",
      "decorative shapes",
      "card/container style",
      "spacing and alignment",
      "color system, as long as brand-critical colors remain recognizable"
    ],
    mayReflow: [
      "title and short labels may be reset as crisp editable-safe text",
      "dense paragraphs may be simplified into clean text regions if content is preserved elsewhere",
      "charts and tables may be restyled only if values, labels, and relationships remain unchanged"
    ],
    risks,
    promptGuardrails: buildPromptGuardrails(role, preserve, risks),
    reviewChecklist: buildReviewChecklist(risks)
  };
}

async function buildReusableAssets({ page = {}, pageId = "", dimensions = null, risks = [], fidelityAssetDir = "" } = {}) {
  if (!page.path || !fidelityAssetDir) return [];
  const width = Number(dimensions?.width || page.width || 0);
  const height = Number(dimensions?.height || page.height || 0);
  if (!width || !height) return [];
  const pageDir = path.join(fidelityAssetDir, pageId);
  await fs.mkdir(pageDir, { recursive: true });
  const assets = [];
  const sourceCopyPath = path.join(pageDir, "source_page.png");
  await fs.copyFile(page.path, sourceCopyPath);
  assets.push(await assetRecordForCrop({
    assetId: `${pageId}_source_page`,
    type: "source-page-reference",
    role: "strict-reference",
    page,
    filePath: sourceCopyPath,
    box: [0, 0, width, height],
    note: "Full original rendered page for factual comparison and emergency reuse."
  }));

  const candidates = inferReusableAssetCandidates({ width, height, risks });
  for (const candidate of candidates) {
    const targetPath = path.join(pageDir, `${candidate.id}.png`);
    const cropped = await cropImage(page.path, targetPath, candidate.box).catch(() => null);
    if (!cropped) continue;
    assets.push(await assetRecordForCrop({
      assetId: `${pageId}_${candidate.id}`,
      type: candidate.type,
      role: candidate.role,
      page,
      filePath: targetPath,
      box: cropped.box,
      note: candidate.note
    }));
  }
  return assets;
}

function inferReusableAssetCandidates({ width = 0, height = 0, risks = [] } = {}) {
  const candidates = [];
  const hasBrand = risks.includes("brand-or-logo-likely");
  const hasImage = risks.includes("photo-or-screenshot-likely") || risks.includes("source-image-fidelity-required");
  const hasData = risks.includes("chart-or-table-likely");
  const hasDenseText = risks.includes("dense-text-likely");
  if (hasBrand) {
    candidates.push({
      id: "logo_zone",
      type: "brand-mark",
      role: "reuse-or-compare",
      box: pctBox(width, height, 0, 0, 0.28, 0.18),
      note: "Likely logo or brand area; keep as a strict crop candidate before asking the model to redraw."
    });
  }
  if (hasImage) {
    candidates.push({
      id: "main_visual_zone",
      type: "photo-screenshot",
      role: "reuse-or-compare",
      box: pctBox(width, height, 0.08, 0.16, 0.84, 0.66),
      note: "Likely source image or screenshot area; prefer reuse or local enhancement instead of model replacement."
    });
  }
  if (hasData) {
    candidates.push({
      id: "data_zone",
      type: "chart-table",
      role: "reuse-or-compare",
      box: pctBox(width, height, 0.05, 0.2, 0.9, 0.68),
      note: "Likely chart/table/data area; preserve values, labels, and relationships."
    });
  }
  if (hasDenseText) {
    candidates.push({
      id: "text_zone",
      type: "dense-text",
      role: "text-rerender-reference",
      box: pctBox(width, height, 0.06, 0.12, 0.88, 0.76),
      note: "Likely text area; use as OCR/reference while final text should be program-rendered for sharpness."
    });
  }
  return dedupeCandidateBoxes(candidates);
}

function dedupeCandidateBoxes(candidates = []) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.type}:${candidate.box.map((value) => Math.round(value / 24) * 24).join(",")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pctBox(width, height, x, y, w, h) {
  return [
    Math.round(width * x),
    Math.round(height * y),
    Math.max(1, Math.round(width * w)),
    Math.max(1, Math.round(height * h))
  ];
}

async function cropImage(sourcePath, targetPath, box) {
  const code = [
    "import json, sys",
    "from pathlib import Path",
    "from PIL import Image",
    "src = Path(sys.argv[1])",
    "out = Path(sys.argv[2])",
    "box = [int(round(float(x))) for x in json.loads(sys.argv[3])]",
    "img = Image.open(src).convert('RGBA')",
    "w, h = img.size",
    "x, y, bw, bh = box",
    "x = max(0, min(x, max(0, w - 1)))",
    "y = max(0, min(y, max(0, h - 1)))",
    "bw = max(1, min(bw, w - x))",
    "bh = max(1, min(bh, h - y))",
    "out.parent.mkdir(parents=True, exist_ok=True)",
    "img.crop((x, y, x + bw, y + bh)).save(out)",
    "print(json.dumps({'box': [x, y, bw, bh], 'width': bw, 'height': bh}, ensure_ascii=False))"
  ].join("; ");
  const { stdout } = await execFileAsync("python", ["-c", code, sourcePath, targetPath, JSON.stringify(box)], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8"
    }
  });
  return JSON.parse(String(stdout || "{}"));
}

async function assetRecordForCrop({ assetId, type, role, page = {}, filePath = "", box = [], note = "" } = {}) {
  const dimensions = getImageDimensions(filePath);
  const stat = await fs.stat(filePath);
  return {
    assetId,
    pageId: page.pageId || `page_${String(page.pageNumber || 1).padStart(3, "0")}`,
    pageNumber: Number(page.pageNumber || 0),
    type,
    role,
    path: filePath,
    relativePath: path.relative(rootDir, filePath),
    sourcePagePath: page.path || "",
    sourceBoxPx: box,
    width: dimensions?.width || box[2] || null,
    height: dimensions?.height || box[3] || null,
    size: stat.size,
    sha256: await hashFile(filePath),
    note
  };
}

function inferPreserveAssets(page = {}, qa = {}, risks = [], reusableAssets = []) {
  const assets = [];
  if (cleanText(page.outlineTitle)) {
    assets.push({ type: "title", label: "Visible title", reason: "Keep the slide meaning and page identity.", required: true });
  }
  if (risks.includes("brand-or-logo-likely")) {
    assets.push({ type: "brand-mark", label: "Logo or brand mark", reason: "Do not redraw into a different logo or brand shape.", sourceAssetIds: assetIdsByType(reusableAssets, "brand-mark"), required: true });
  }
  if (risks.includes("photo-or-screenshot-likely")) {
    assets.push({ type: "photo-screenshot", label: "Original image area", reason: "Original image content must remain factually correct.", sourceAssetIds: assetIdsByType(reusableAssets, "photo-screenshot"), required: true });
  }
  if (risks.includes("source-image-fidelity-required")) {
    assets.push({ type: "source-image", label: "Original page image content", reason: "Source visual information should remain recognizable after redesign.", sourceAssetIds: assetIdsByType(reusableAssets, "photo-screenshot"), required: true });
  }
  if (risks.includes("chart-or-table-likely")) {
    assets.push({ type: "chart-table", label: "Data visual", reason: "Values, labels, hierarchy, and relationships must be preserved.", sourceAssetIds: assetIdsByType(reusableAssets, "chart-table"), required: true });
  }
  if (risks.includes("dense-text-likely")) {
    assets.push({ type: "dense-text", label: "Dense text block", reason: "Meaning should be retained; avoid hallucinated readable text.", sourceAssetIds: assetIdsByType(reusableAssets, "dense-text"), required: true });
  }
  if (!assets.length && qa?.ok !== false) {
    assets.push({ type: "layout-anchor", label: "Primary composition", reason: "Keep the original information order and relative emphasis.", required: true });
  }
  return assets;
}

function assetIdsByType(assets = [], type = "") {
  return assets.filter((asset) => asset.type === type).map((asset) => asset.assetId).filter(Boolean);
}

function inferRisks(page = {}, qa = {}) {
  const text = [
    page.outlineTitle,
    page.outlinePurpose,
    page.outlineEvidence,
    page.textPreview,
    page.sourceSlideType
  ].filter(Boolean).join(" ");
  const risks = new Set();
  if (/logo|brand|商标|品牌|标识/i.test(text)) risks.add("brand-or-logo-likely");
  if (/chart|table|data|metric|trend|图表|表格|数据|指标|增长|同比|环比|%/i.test(text)) risks.add("chart-or-table-likely");
  if (/screenshot|photo|image|diagram|截图|照片|图片|示意图|二维码|QR/i.test(text)) risks.add("photo-or-screenshot-likely");
  if (Number(page.textChars || 0) > 120 || /paragraph|copy|正文|段落/i.test(text)) risks.add("dense-text-likely");
  const qaRisks = Array.isArray(qa?.risks) ? qa.risks : [];
  const edgeDensity = Number(qa?.full?.edgeDensity || qa?.edgeDensity || qa?.summary?.edgeDensity || 0);
  const textLikeScore = Number(qa?.full?.textLikeScore || qa?.textLikeScore || 0);
  const darkComponentDensity = Number(qa?.full?.darkComponentDensity || qa?.darkComponentDensity || 0);
  const saturationDensity = Number(qa?.full?.saturationDensity || qa?.saturationDensity || 0);
  if (qaRisks.some((item) => /text|label|foreground/i.test(item)) || textLikeScore > 0.006 || darkComponentDensity > 0.035) {
    risks.add("dense-text-likely");
  }
  if (edgeDensity > 0.045) risks.add("chart-or-table-likely");
  if (edgeDensity > 0.07 || saturationDensity > 0.16) risks.add("photo-or-screenshot-likely");
  if (!risks.has("photo-or-screenshot-likely") && !risks.has("chart-or-table-likely") && page.path) {
    risks.add("source-image-fidelity-required");
  }
  if (!risks.size) risks.add("general-fidelity");
  return [...risks];
}

function inferTextDensity(page = {}) {
  const chars = Number(page.textChars || cleanText(page.textPreview || page.outlineEvidence || "").length || 0);
  if (chars > 260) return "high";
  if (chars > 80) return "medium";
  return "low";
}

function inferVisualDensity(qa = {}) {
  const edgeDensity = Number(qa?.full?.edgeDensity || qa?.edgeDensity || qa?.summary?.edgeDensity || 0);
  const saturationDensity = Number(qa?.full?.saturationDensity || qa?.saturationDensity || 0);
  if (edgeDensity > 0.12 || saturationDensity > 0.22) return "high";
  if (edgeDensity > 0.045 || saturationDensity > 0.1) return "medium";
  return "low";
}

function buildPromptGuardrails(role, preserve = [], risks = []) {
  const guardrails = [
    `Treat this page as ${role}.`,
    "Use the source image as the factual reference, not just as style inspiration.",
    "Redesign the visual system while keeping preserved information assets recognizable."
  ];
  if (preserve.some((item) => item.type === "photo-screenshot")) {
    guardrails.push("Do not replace original photos/screenshots with invented images.");
  }
  if (preserve.some((item) => item.type === "chart-table")) {
    guardrails.push("Do not alter chart/table values, labels, axes, sequence, or comparisons.");
  }
  if (risks.includes("dense-text-likely")) {
    guardrails.push("Keep readable short labels sharp; avoid fake long readable text.");
  }
  return guardrails;
}

function buildReviewChecklist(risks = []) {
  const checklist = [
    "Compare against the original page before approving the sample/full deck.",
    "Check that all obvious source images and key labels still refer to the same content."
  ];
  if (risks.includes("brand-or-logo-likely")) checklist.push("Logo/brand mark is not distorted or replaced.");
  if (risks.includes("photo-or-screenshot-likely")) checklist.push("Original photo/screenshot subject, crop, and key details are still correct.");
  if (risks.includes("chart-or-table-likely")) checklist.push("Data values and relationships are unchanged.");
  if (risks.includes("dense-text-likely")) checklist.push("Long text is not hallucinated; short visible labels remain legible.");
  return checklist;
}

function buildAssetSummary(pages = []) {
  const reusableAssets = pages.flatMap((page) => Array.isArray(page.reusableAssets) ? page.reusableAssets : []);
  return {
    pages: pages.length,
    reusableAssets: reusableAssets.length,
    sourceReferenceAssets: reusableAssets.filter((asset) => asset.type === "source-page-reference").length,
    strictReuseCandidates: reusableAssets.filter((asset) => asset.role === "reuse-or-compare").length,
    brandRiskPages: pages.filter((page) => page.risks.includes("brand-or-logo-likely")).length,
    imageRiskPages: pages.filter((page) => page.risks.includes("photo-or-screenshot-likely")).length,
    dataRiskPages: pages.filter((page) => page.risks.includes("chart-or-table-likely")).length,
    denseTextPages: pages.filter((page) => page.risks.includes("dense-text-likely")).length,
    highReviewPages: pages.filter((page) => page.risks.length > 1 || page.visualDensity === "high").length
  };
}

function buildFidelityAssetManifest({ job = {}, pages = [], rootDir = "", recordedAt = "" } = {}) {
  const assets = pages.flatMap((page) => Array.isArray(page.reusableAssets) ? page.reusableAssets : []);
  return {
    kind: "codex_ppt_fidelity_assets",
    version: 1,
    jobId: job.id || "",
    rootPath: rootDir,
    rootRelativePath: path.relative(rootDir ? path.dirname(rootDir) : process.cwd(), rootDir || ""),
    assetCount: assets.length,
    pages: pages.map((page) => ({
      pageId: page.pageId,
      pageNumber: page.pageNumber,
      sourcePagePath: page.sourcePagePath,
      assets: (page.reusableAssets || []).map((asset) => ({
        assetId: asset.assetId,
        type: asset.type,
        role: asset.role,
        path: asset.path,
        relativePath: asset.relativePath,
        sourceBoxPx: asset.sourceBoxPx,
        width: asset.width,
        height: asset.height,
        sha256: asset.sha256,
        note: asset.note
      }))
    })),
    recordedAt
  };
}

function buildAssetMarkdown(payload = {}) {
  const lines = [
    "# Information Asset Map",
    "",
    `- Job: ${payload.jobId}`,
    `- Pages: ${payload.pageCount}`,
    `- Confidence: ${payload.confidence}`,
    `- Reusable assets: ${payload.summary?.reusableAssets || 0}`,
    `- Recorded at: ${payload.recordedAt}`,
    "",
    "## Rule",
    "",
    payload.rule,
    "",
    "## Summary",
    "",
    `- Brand/logo risk pages: ${payload.summary?.brandRiskPages || 0}`,
    `- Photo/screenshot risk pages: ${payload.summary?.imageRiskPages || 0}`,
    `- Chart/table risk pages: ${payload.summary?.dataRiskPages || 0}`,
    `- Dense text pages: ${payload.summary?.denseTextPages || 0}`,
    "",
    "## Pages"
  ];
  for (const page of payload.pages || []) {
    lines.push(
      "",
      `### ${page.pageId}`,
      "",
      `- Role: ${page.role}`,
      `- Source: ${page.sourcePagePath}`,
      `- Risks: ${page.risks.join(", ")}`,
      `- Reusable assets: ${(page.reusableAssets || []).map((item) => `${item.type}:${item.relativePath}`).join(" / ") || "none"}`,
      `- Must preserve: ${page.mustPreserve.map((item) => item.type).join(", ")}`,
      `- Review: ${page.reviewChecklist.join(" / ")}`
    );
  }
  return `${lines.join("\n")}\n`;
}

function getImageDimensions(filePath) {
  if (!filePath || !fsSync.existsSync(filePath)) return null;
  try {
    return imageSize(filePath);
  } catch {
    return null;
  }
}

async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  const buffer = await fs.readFile(filePath);
  hash.update(buffer);
  return hash.digest("hex");
}

function cleanText(value = "") {
  return String(value || "").trim();
}
