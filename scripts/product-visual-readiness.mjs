#!/usr/bin/env node
import "dotenv/config";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import zlib from "zlib";

const DEFAULT_BASE_URL = process.env.PPT_TOOL_BASE_URL || "http://127.0.0.1:4180";
const LATEST_READINESS_PATH = path.join(process.cwd(), "workspace", "v1-acceptance", "latest-product-visual-readiness.json");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const baseUrl = String(args["base-url"] || args.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const generateSample = Boolean(args["generate-sample"]);
  const generateDeck = Boolean(args["generate-deck"]);
  const maxPages = clampInteger(args["max-pages"] || args.maxPages, 1, 50, 1);
  const sourcePath = args.source ? path.resolve(String(args.source)) : "";
  const sourceBrief = args.brief ? String(args.brief) : "";
  const startedAt = new Date().toISOString();
  const explicitSlideCount = optionalInteger(args.slides || args["slide-count"] || args.slideCount, 1, 50);
  if (generateDeck && !generateSample) {
    throw new Error("--generate-deck requires --generate-sample because codex-ppt full-deck generation must follow an approved sample.");
  }
  if (sourcePath && sourceBrief) throw new Error("Use either --source or --brief, not both.");
  if (sourcePath && !fsSync.existsSync(sourcePath)) throw new Error(`Source file not found: ${sourcePath}`);
  const health = await api(baseUrl, "/api/health");
  if (!health.ok) throw new Error(`PPT tool server is not healthy at ${baseUrl}`);

  const imageProvider = health.providers?.image || {};
  if (!imageProvider.enabled || !imageProvider.configured) {
    throw new Error("Product visual readiness requires a configured image provider.");
  }
  if (imageProvider.supportsImageEdit === false) {
    throw new Error("Product visual readiness requires an image provider that supports source-page image edits.");
  }

  const providerProbe = await api(baseUrl, "/api/providers/test", {
    method: "POST",
    body: { target: "image", generateProbe: false }
  });
  if (!providerProbe.ok || providerProbe.result?.image?.configured !== true) {
    throw new Error(providerProbe.result?.image?.error || "Image provider readiness probe failed.");
  }
  if (providerProbe.result?.image?.provider?.supportsImageEdit === false) {
    throw new Error("Image provider is configured but image edit support is disabled.");
  }

  const upload = sourcePath ? await uploadSourceFile(baseUrl, sourcePath) : sourceBrief ? null : await uploadSyntheticSource(baseUrl);
  let job = await api(baseUrl, "/api/workflow-jobs", {
    method: "POST",
    body: {
      sourceUploadId: upload?.id || "",
      sourceBrief,
      sourceOriginalName: sourceBrief ? "product-visual-readiness-brief.md" : "",
      sourceMimeType: sourceBrief ? "text/markdown" : "",
      mode: "product-visual-readiness",
      internal: true,
      notes: generateSample
        ? "Product visual readiness with one real generated sample."
        : "Product visual readiness without paid image generation."
    }
  });
  job = await runJobStep(baseUrl, job.id, "source/render");
  const renderedPages = Array.isArray(job.artifacts?.renderedPages) ? job.artifacts.renderedPages : [];
  if (!renderedPages.length) {
    throw new Error(`Expected rendered source pages, got ${job.artifacts?.renderedPages?.length ?? "none"}`);
  }
  if (!sourcePath && renderedPages.length !== 1) {
    throw new Error(`Expected one rendered synthetic source page, got ${renderedPages.length}`);
  }
  const targetSlideCount = explicitSlideCount || (sourceBrief ? guessSlideCount(sourceBrief) : 0) || renderedPages.length;

  const outline = await recordOutline(baseUrl, job.id, {
    title: sourceBrief ? "Product visual readiness brief" : path.basename(sourcePath || "synthetic-source.png"),
    pageCount: targetSlideCount,
    renderedPages,
    sourceBrief
  });
  if (!outline.artifacts?.codexPptOutline?.path) {
    throw new Error("Expected codex-ppt outline artifact before approvals.");
  }
  if (outline.artifacts.codexPptOutline.slideCount !== targetSlideCount) {
    throw new Error(`Expected codex-ppt outline to target ${targetSlideCount} slide(s), got ${outline.artifacts.codexPptOutline.slideCount || 0}.`);
  }
  const style = await recordStyle(baseUrl, job.id, {
    styleBrief: "Premium clean business presentation visual, modern hierarchy, no long readable text.",
    source: "product-visual-readiness"
  });
  if (!style.artifacts?.codexPptStyle?.path) {
    throw new Error("Expected codex-ppt style artifact before approvals.");
  }
  const backendDecision = await recordBackendDecision(baseUrl, job.id, {
    source: "product-visual-readiness",
    backend: {
      provider: imageProvider.provider || "openai-compatible-image",
      baseUrl: imageProvider.baseUrl || "",
      model: imageProvider.model || ""
    }
  });
  if (!backendDecision.artifacts?.codexPptBackendDecision?.path) {
    throw new Error("Expected codex-ppt backend decision artifact before approvals.");
  }

  await approveGate(baseUrl, job.id, "outline");
  await approveGate(baseUrl, job.id, "style");
  await approveGate(baseUrl, job.id, "backend", {
    backend: {
      provider: imageProvider.provider || "openai-compatible-image",
      baseUrl: imageProvider.baseUrl || "",
      model: imageProvider.model || ""
    }
  });

  let compliance = await api(baseUrl, `/api/workflow-jobs/${job.id}/compliance`);
  if (compliance.runbook?.currentStep !== "codex-ppt-sample") {
    throw new Error(`Expected runbook step codex-ppt-sample, got ${compliance.runbook?.currentStep || "none"}`);
  }

  let sample = null;
  let visualDeck = null;
  if (generateSample) {
    job = await runJobStep(baseUrl, job.id, "visual/sample", {
      pageNumber: 1,
      confirmExternalImageSpend: true,
      styleBrief: "Premium clean business presentation visual, modern hierarchy, no long readable text."
    });
    sample = job.artifacts?.visualSample || null;
    if (!sample?.path) throw new Error("Real visual sample did not produce an artifact.");
    if (sample.provider === "passthrough" || sample.dryRun === true) {
      throw new Error("Real visual sample unexpectedly used passthrough/dry-run output.");
    }
    if (!sample.sha256) throw new Error("Real visual sample is missing sha256 provenance.");

    await approveGate(baseUrl, job.id, "sample");
    compliance = await api(baseUrl, `/api/workflow-jobs/${job.id}/compliance`);
    if (compliance.codexPpt?.sample?.status !== "pass") {
      throw new Error(`Expected codex-ppt sample evidence pass, got ${compliance.codexPpt?.sample?.status || "none"}`);
    }

    if (generateDeck) {
      await approveGate(baseUrl, job.id, "fullDeck");
      const deckPageLimit = Math.min(maxPages, targetSlideCount);
      job = await runJobStep(baseUrl, job.id, "visual/generate", {
        maxPages: deckPageLimit,
        pages: `1-${deckPageLimit}`,
        confirmExternalImageSpend: true,
        styleBrief: "Premium clean business presentation visual, modern hierarchy, no long readable text."
      });
      const visualImages = Array.isArray(job.artifacts?.visualImages) ? job.artifacts.visualImages : [];
      if (!visualImages.length) throw new Error("Real visual deck generation produced no images.");
      const slideState = summarizeCodexPptSlideState(job);
      if (!slideState.complete) throw new Error(`codex-ppt slide state incomplete: ${JSON.stringify(slideState)}`);
      const badImage = visualImages.find((image) => image.provider === "passthrough" || image.dryRun === true || !image.sha256);
      if (badImage) {
        throw new Error(`Visual deck image ${badImage.pageId || badImage.path || "unknown"} is missing product provenance.`);
      }
      job = await runJobStep(baseUrl, job.id, "image-deck/assemble", {
        outName: "product-visual-image-deck.pptx"
      });
      compliance = await api(baseUrl, `/api/workflow-jobs/${job.id}/compliance`);
      if (compliance.runbook?.currentStep !== "editppt-prepare") {
        throw new Error(`Expected runbook step editppt-prepare after image deck, got ${compliance.runbook?.currentStep || "none"}`);
      }
      visualDeck = {
        visualImages: visualImages.length,
        slideState,
        visualManifest: job.artifacts?.visualManifest?.path || "",
        imageDeck: job.artifacts?.imageDeck?.path || "",
        nextRunbookStep: compliance.runbook?.currentStep || ""
      };
    }
  }

  const result = {
    ok: true,
    baseUrl,
    paidImageGeneration: generateSample,
    jobId: job.id,
    rootDir: job.rootDir,
    provider: {
      configured: imageProvider.configured,
      enabled: imageProvider.enabled,
      baseUrl: imageProvider.baseUrl || "",
      model: imageProvider.model || ""
    },
    sourceRender: {
      renderedPages: job.artifacts?.renderedPages?.length || 0,
      targetSlideCount,
      source: sourcePath || (sourceBrief ? "brief" : "synthetic"),
      renderer: job.artifacts?.sourceMeta?.renderer || ""
    },
    outline: {
      path: outline.artifacts?.codexPptOutline?.path || "",
      markdownPath: outline.artifacts?.codexPptOutline?.markdownPath || "",
      slideCount: outline.artifacts?.codexPptOutline?.slideCount || 0
    },
    decisions: {
      stylePath: style.artifacts?.codexPptStyle?.path || "",
      backendPath: backendDecision.artifacts?.codexPptBackendDecision?.path || ""
    },
    approvals: compliance.codexPpt?.approvals || null,
    runbook: {
      currentStep: compliance.runbook?.currentStep || "",
      currentTitle: compliance.runbook?.currentTitle || "",
      allowedActions: compliance.runbook?.allowedActions || []
    },
    sample: sample ? {
      path: sample.path || "",
      provider: sample.provider || "",
      model: sample.model || "",
      dryRun: Boolean(sample.dryRun),
      sha256: sample.sha256 || ""
    } : null,
    visualDeck,
    next: generateDeck
      ? "Run editppt prepare on the image deck, then dispatch page workers through image-to-editable-ppt."
      : generateSample
        ? "Review the sample visually, then authorize fullDeck and generate the visual deck."
      : "Run again with --generate-sample to spend one image call on a real codex-ppt sample."
  };
  if (!generateSample && !generateDeck) {
    await writeLatestNoCostReadiness({
      baseUrl,
      sourcePath: sourcePath || "",
      sourceMode: sourcePath ? "local-path" : sourceBrief ? "brief" : "synthetic",
      workflowJobId: "",
      maxPages,
      startedAt,
      result
    });
  }
  console.log(JSON.stringify(result, null, 2));
}

async function writeLatestNoCostReadiness({ baseUrl, sourcePath = "", sourceMode = "", workflowJobId = "", maxPages = 15, startedAt = "", result = {} } = {}) {
  await fs.mkdir(path.dirname(LATEST_READINESS_PATH), { recursive: true });
  const payload = {
    ok: true,
    safeToRunAutomatically: true,
    paidImageGeneration: false,
    requiresExplicitSpendConfirmation: false,
    externalImageCalls: 0,
    sourcePath,
    sourceMode,
    workflowJobId,
    maxPages,
    startedAt,
    endedAt: new Date().toISOString(),
    command: buildCommandForLatest({ sourcePath, sourceMode, maxPages }),
    result,
    stderr: ""
  };
  await fs.writeFile(LATEST_READINESS_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function buildCommandForLatest({ sourcePath = "", sourceMode = "", maxPages = 15 } = {}) {
  if (sourcePath) return `node scripts/product-visual-readiness.mjs --source "${sourcePath}" --max-pages ${maxPages}`;
  if (sourceMode === "brief") return `node scripts/product-visual-readiness.mjs --brief "<brief>" --max-pages ${maxPages}`;
  return `node scripts/product-visual-readiness.mjs --max-pages ${maxPages}`;
}

function summarizeCodexPptSlideState(job = {}) {
  const artifacts = job.artifacts || {};
  const jobs = artifacts.codexPptSlideJobs || {};
  const state = artifacts.codexPptSlideRunState || {};
  const total = Number(state.total || jobs.total || artifacts.codexPptSlidePrompts?.length || 0);
  const dispatched = Number(state.dispatched || jobs.dispatched || 0);
  const recorded = Number(state.recorded || jobs.recorded || 0);
  const failed = Number(state.failed || jobs.failed || 0);
  return {
    total,
    dispatched,
    recorded,
    failed,
    complete: Boolean(artifacts.codexPptDeckSpec?.path && jobs.path && state.path && total > 0 && dispatched >= total && recorded >= total && failed === 0),
    deckSpec: artifacts.codexPptDeckSpec?.path || "",
    slideJobs: jobs.path || "",
    slideRunState: state.path || ""
  };
}

async function runJobStep(baseUrl, jobId, action, body = {}) {
  return api(baseUrl, `/api/workflow-jobs/${jobId}/${action}`, {
    method: "POST",
    body
  });
}

async function approveGate(baseUrl, jobId, gate, body = {}) {
  return api(baseUrl, `/api/workflow-jobs/${jobId}/codex-ppt/approvals/${gate}/approve`, {
    method: "POST",
    body: {
      approvedBy: "product-visual-readiness",
      note: `product readiness approval for ${gate}`,
      ...body
    }
  });
}

async function recordOutline(baseUrl, jobId, { title = "", pageCount = 1, renderedPages = [], sourceBrief = "" } = {}) {
  return api(baseUrl, `/api/workflow-jobs/${jobId}/codex-ppt/outline`, {
    method: "POST",
    body: {
      title,
      source: "product-visual-readiness",
      sourceBrief,
      pageCount,
      recordedBy: "product-visual-readiness",
      outlinePlan: {
        layoutSequence: Array.from({ length: pageCount }, (_item, index) => ({
          layout: index === 0 ? "cover" : index === pageCount - 1 && pageCount > 2 ? "closing" : "content",
          title: index === 0 ? "Opening" : index === pageCount - 1 && pageCount > 2 ? "Closing" : `Slide ${index + 1}`,
          purpose: renderedPages[index]?.path
            ? `Reframe source page ${index + 1} into the approved codex-ppt visual system.`
            : "Create a visually unified slide from the product readiness brief.",
          evidence: renderedPages[index]?.path || sourceBrief.slice(0, 180)
        }))
      }
    }
  });
}

async function recordStyle(baseUrl, jobId, { styleBrief = "", source = "product-visual-readiness" } = {}) {
  return api(baseUrl, `/api/workflow-jobs/${jobId}/codex-ppt/style`, {
    method: "POST",
    body: {
      source,
      styleBrief,
      recordedBy: "product-visual-readiness"
    }
  });
}

async function recordBackendDecision(baseUrl, jobId, { backend = {}, source = "product-visual-readiness" } = {}) {
  return api(baseUrl, `/api/workflow-jobs/${jobId}/codex-ppt/backend`, {
    method: "POST",
    body: {
      source,
      backend,
      recordedBy: "product-visual-readiness"
    }
  });
}

async function uploadSyntheticSource(baseUrl) {
  const png = makeSolidPng(1280, 720, { r: 246, g: 248, b: 252, a: 255 });
  const form = new FormData();
  form.append("files", new Blob([png], { type: "image/png" }), `product-visual-source-${Date.now()}.png`);
  const response = await fetch(`${baseUrl}/api/uploads`, { method: "POST", body: form });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.files?.[0]?.id) throw new Error(data.error || `Upload failed with HTTP ${response.status}`);
  return data.files[0];
}

async function uploadSourceFile(baseUrl, sourcePath) {
  const buffer = await fs.readFile(sourcePath);
  const form = new FormData();
  form.append("files", new Blob([buffer], { type: mimeTypeForPath(sourcePath) }), path.basename(sourcePath));
  const response = await fetch(`${baseUrl}/api/uploads`, { method: "POST", body: form });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.files?.[0]?.id) throw new Error(data.error || `Upload failed with HTTP ${response.status}`);
  return data.files[0];
}

async function api(baseUrl, route, { method = "GET", body = null, expectStatus = 200 } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (response.status !== expectStatus) {
    throw new Error(data.error || `Expected HTTP ${expectStatus}, got ${response.status} ${route}`);
  }
  if (expectStatus < 400 && data.ok === false) {
    throw new Error(data.error || `Request failed: ${route}`);
  }
  return data;
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
  console.log(`Product visual readiness

Usage:
  npm.cmd run product:visual-readiness
  npm.cmd run product:visual-readiness -- --source "C:\\path\\deck.pptx"
  npm.cmd run product:visual-readiness -- --brief "Create a 6-page investor update deck"
  npm.cmd run product:visual-readiness -- --brief "Create an investor update deck" --slides 6
  npm.cmd run product:visual-readiness -- --generate-sample
  npm.cmd run product:visual-readiness -- --source "C:\\path\\deck.pptx" --generate-sample --generate-deck --max-pages 1

Default mode is no-cost: it checks the server, image provider configuration,
source rendering, codex-ppt outline/style/backend approvals, and runbook state.

--source uses a real local PPT/PDF/image instead of a synthetic one-page PNG.
--brief uses a text brief as the codex-ppt source material without requiring an
uploaded deck. It still stops at the approval-gated sample stage by default.
--slides / --slide-count sets the target codex-ppt outline slide count for brief
or source readiness checks. Without it, brief text such as "6-page" is inferred.

--generate-sample calls the configured external image API once to create a real
codex-ppt visual sample. This may consume provider credits.

--generate-deck authorizes fullDeck after the real sample and generates visual
slides for --max-pages page(s), then assembles an image-based PPTX. This may
consume one image API call per generated visual page in addition to the sample.
`);
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function optionalInteger(value, min, max) {
  if (value === undefined || value === null || value === "") return 0;
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function guessSlideCount(text = "") {
  const value = String(text || "");
  const english = value.match(/(\d{1,2})\s*-?\s*(page|pages|slide|slides)\b/i);
  if (english) return clampInteger(english[1], 1, 50, 1);
  const chinese = value.match(/(\d{1,2})\s*(页|頁|张|張|页PPT|頁PPT|张PPT|張PPT)/i);
  if (chinese) return clampInteger(chinese[1], 1, 50, 1);
  return 0;
}

function mimeTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pptx") return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (ext === ".ppt") return "application/vnd.ms-powerpoint";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

function makeSolidPng(width, height, color) {
  const rowBytes = width * 4 + 1;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const index = rowStart + 1 + x * 4;
      raw[index] = color.r;
      raw[index + 1] = color.g;
      raw[index + 2] = color.b;
      raw[index + 3] = color.a;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", Buffer.concat([
      uint32(width),
      uint32(height),
      Buffer.from([8, 6, 0, 0, 0])
    ])),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  return Buffer.concat([
    uint32(data.length),
    typeBuffer,
    data,
    uint32(crc32(Buffer.concat([typeBuffer, data])))
  ]);
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
