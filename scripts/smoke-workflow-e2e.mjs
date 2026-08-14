#!/usr/bin/env node
import "dotenv/config";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import zlib from "zlib";
import { execFile } from "child_process";
import { promisify } from "util";
import { approveCodexPptGate } from "../server/workflowApprovals.js";
import { recordWorkflowCodexPptBackendDecision, recordWorkflowCodexPptStyle } from "../server/workflowCodexPptDecisions.js";
import { prepareCodexPptSlideRun } from "../server/workflowCodexPptRunState.js";
import { createWorkflowJob, readWorkflowJob, saveWorkflowJob } from "../server/workflowJobs.js";
import { recordWorkflowCodexPptOutline } from "../server/workflowOutline.js";

const execFileAsync = promisify(execFile);
const DEFAULT_BASE_URL = process.env.PPT_TOOL_BASE_URL || "http://127.0.0.1:4180";
const DEFAULT_AGENT_ID = "smoke-worker-001";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (args.worker) {
    await runSmokeWorker(args);
    return;
  }
  await runSmoke(args);
}

async function runSmoke(args) {
  const baseUrl = String(args["base-url"] || args.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const agentId = String(args["agent-id"] || args.agentId || DEFAULT_AGENT_ID).trim();
  const timeoutMs = clampInteger(args["timeout-ms"] || args.timeoutMs, 30000, 900000, 180000);

  const health = await api(baseUrl, "/api/health");
  if (!health.ok) throw new Error(`PPT tool server is not healthy at ${baseUrl}`);

  const deliveryReadyFixture = args["delivery-ready-fixture"] === true;
  let job = await createWorkflowJob({
    internal: !deliveryReadyFixture,
    visibility: deliveryReadyFixture ? "public" : "internal",
    mode: "smoke-e2e",
    projectName: deliveryReadyFixture ? "严格 E2E 成功态验证（合成）" : "",
    notes: "Synthetic runner -> page pipeline -> record -> finalize smoke test."
  });

  const sourceImage = path.join(job.dirs.visualImages, "page_001.png");
  await writeSolidPng(sourceImage, 1280, 720, {
    r: 248,
    g: 250,
    b: 252,
    a: 255
  });
  const imageStat = await fs.stat(sourceImage);
  const imageSha256 = await hashFile(sourceImage);
  const ocrHintsPath = path.join(job.dirs.ocr, "text_hints.json");
  const visualOcrHintsPath = path.join(job.dirs.ocr, "visual_text_hints.json");
  const smokeOcrLines = [
    { id: "title", text: "Editable PPT Smoke Test", confidence: 1, low_confidence: false, mojibake_suspect: false, box_px: [96, 128, 660, 86], font_pt_if_latin: 34 },
    { id: "body", text: "Runner, pipeline, record, and finalize completed.", confidence: 1, low_confidence: false, mojibake_suspect: false, box_px: [100, 250, 640, 110], font_pt_if_latin: 20 }
  ];
  await writeJson(ocrHintsPath, {
    version: 1,
    jobId: job.id,
    backend: "smoke-synthetic-ocr",
    ocrBackend: { name: "smoke-synthetic-ocr", mode: "test" },
    pageCount: 1,
    textCount: smokeOcrLines.length,
    lowConfidenceCount: 0,
    summary: { pageCount: 1, textCount: smokeOcrLines.length, lowConfidenceCount: 0, mojibakeCount: 0, errorCount: 0 },
    pages: [{
      pageId: "page_001",
      pageNumber: 1,
      imagePath: sourceImage,
      imageSha256,
      backend: "smoke-synthetic-ocr",
      lineCount: smokeOcrLines.length,
      lowConfidenceCount: 0,
      requiredText: smokeOcrLines.map((line) => line.text),
      ocrLines: smokeOcrLines
    }],
    errors: []
  });
  await writeJson(visualOcrHintsPath, {
    version: 1,
    jobId: job.id,
    backend: "smoke-synthetic-ocr",
    ocrBackend: { name: "smoke-synthetic-ocr", mode: "test" },
    pageCount: 1,
    textCount: smokeOcrLines.length,
    lowConfidenceCount: 0,
    summary: { pageCount: 1, textCount: smokeOcrLines.length, lowConfidenceCount: 0, mojibakeCount: 0, errorCount: 0 },
    pages: [{
      pageId: "page_001",
      pageNumber: 1,
      imagePath: sourceImage,
      imageSha256,
      backend: "smoke-synthetic-ocr",
      lineCount: smokeOcrLines.length,
      lowConfidenceCount: 0,
      requiredText: smokeOcrLines.map((line) => line.text),
      ocrLines: smokeOcrLines
    }],
    errors: []
  });
  const visualPage = {
    kind: "visual_image",
    pageId: "page_001",
    pageNumber: 1,
    path: sourceImage,
    relativePath: path.relative(process.cwd(), sourceImage),
    size: imageStat.size,
    sha256: imageSha256,
    provider: "smoke-synthetic",
    createdAt: new Date().toISOString()
  };
  job.artifacts = {
    ...(job.artifacts || {}),
    renderedPages: [{
      kind: "rendered_page",
      pageId: "page_001",
      pageNumber: 1,
      path: sourceImage,
      relativePath: path.relative(process.cwd(), sourceImage),
      size: imageStat.size,
      sha256: imageSha256,
      createdAt: new Date().toISOString()
    }],
    ocrTextHints: {
      kind: "ocr_text_hints",
      path: ocrHintsPath,
      relativePath: path.relative(process.cwd(), ocrHintsPath),
      backend: "smoke-synthetic-ocr",
      pageCount: 1,
      textCount: smokeOcrLines.length,
      lowConfidenceCount: 0
    },
    visualOcrTextHints: {
      kind: "visual_ocr_text_hints",
      path: visualOcrHintsPath,
      relativePath: path.relative(process.cwd(), visualOcrHintsPath),
      backend: "smoke-synthetic-ocr",
      pageCount: 1,
      textCount: smokeOcrLines.length,
      lowConfidenceCount: 0,
      evidenceSource: "visual",
      coordinateModeVersion: "visual-coordinates-v2"
    },
    sourceMeta: {
      kind: "source_meta",
      pageCount: 1,
      width: 1280,
      height: 720
    },
    visualSample: { ...visualPage, sample: true },
    visualImages: [visualPage]
  };
  job = await saveWorkflowJob(job);

  // Use the public review endpoints so the smoke covers the same visual gate as the product UI.
  // The first call also verifies that missing quality evidence is rebuilt locally from existing images.
  job = await api(baseUrl, `/api/workflow-jobs/${job.id}/image-deck/review/pages/page_001`, {
    method: "POST",
    body: { status: "pass", reviewer: "smoke-e2e", note: "synthetic visual page reviewed" }
  });
  job = await api(baseUrl, `/api/workflow-jobs/${job.id}/image-deck/review/approve`, {
    method: "POST",
    body: { reviewer: "smoke-e2e", note: "synthetic image deck review approved" }
  });
  job = await api(baseUrl, `/api/workflow-jobs/${job.id}/visual-quality/review/approve`, {
    method: "POST",
    body: { reviewer: "smoke-e2e", note: "synthetic visual quality evidence reviewed" }
  });

  const prepared = await api(baseUrl, `/api/workflow-jobs/${job.id}/editable/prepare`, {
    method: "POST",
    body: { force: true, noTextHints: true, maxConcurrentPages: 1, timeoutMs, confirmRouteB: true }
  });
  const editableStatus = await api(baseUrl, `/api/workflow-jobs/${job.id}/editable/status`);
  let prompted = prepared;
  if (editableStatus.next?.stage === "rebuild_page_locally") {
    job = await api(baseUrl, `/api/workflow-jobs/${job.id}/editable/local-rebuild`, {
      method: "POST",
      body: {
        agentId: "main",
        allowTextDominantLocal: true,
        regression: true,
        acceptOfflineTextHints: true,
        offlineTextHintsReason: "synthetic smoke page has no OCR text requirement",
        timeoutMs
      }
    });
    prompted = job;
  } else {
    prompted = await api(baseUrl, `/api/workflow-jobs/${job.id}/editable/prompts`, {
      method: "POST",
      body: { pages: ["page_001"], timeoutMs }
    });
    const tasks = await api(baseUrl, `/api/workflow-jobs/${job.id}/editable/worker-tasks/sync`, {
      method: "POST",
      body: {}
    });
    const pageTask = (tasks.tasks || []).find((task) => task.pageId === "page_001");
    if (!pageTask) throw new Error("Smoke worker task was not created for page_001");

    const runnerArgs = [
      "scripts/page-worker-runner.mjs",
      "once",
      "--base-url",
      baseUrl,
      "--job-id",
      job.id,
      "--agent-id",
      agentId,
      "--page",
      "page_001",
      "--heartbeat-ms",
      "5000",
      "--accept-offline-text-hints",
      "--offline-text-hints-reason",
      "synthetic smoke page has no OCR text requirement",
      "--command",
      quoteCommand([process.execPath, "scripts/smoke-workflow-e2e.mjs", "--worker"])
    ];
    await execFileAsync(process.execPath, runnerArgs, {
      cwd: process.cwd(),
      windowsHide: true,
      encoding: "utf8",
      timeout: timeoutMs,
      env: {
        ...process.env,
        PPT_TOOL_BASE_URL: baseUrl,
        PYTHONIOENCODING: "utf-8"
      }
    });
  }

  let finalized = await api(baseUrl, `/api/workflow-jobs/${job.id}/editable/finalize`, {
    method: "POST",
    body: { timeoutMs }
  });
  finalized = await api(baseUrl, `/api/workflow-jobs/${job.id}/review/pages/page_001`, {
    method: "POST",
    body: { status: "pass", reviewer: "smoke-e2e", note: "synthetic editable page visually reviewed" }
  });
  finalized = await api(baseUrl, `/api/workflow-jobs/${job.id}/review/approve`, {
    method: "POST",
    body: { reviewer: "smoke-e2e", note: "synthetic final deck reviewed" }
  });
  const finalPath = finalized.artifacts?.editableFinal?.path || "";
  const validationPath = finalized.artifacts?.editableFinal?.validation?.path || "";
  if (!finalPath || !fsSync.existsSync(finalPath)) throw new Error(`Final editable PPTX was not created: ${finalPath}`);

  if (deliveryReadyFixture) finalized = await promoteSyntheticDeliveryReadyFixture(finalized.id);
  const delivery = await api(baseUrl, `/api/workflow-jobs/${job.id}/delivery-status`);
  const compliance = await api(baseUrl, `/api/workflow-jobs/${job.id}/compliance`);
  if (deliveryReadyFixture) assertReadyDeliveryEvidence(delivery);
  else assertDeliveryEvidence(delivery);
  assertComplianceEvidence(compliance);

  const result = {
    ok: true,
    kind: deliveryReadyFixture ? "synthetic-ready-api-workflow-e2e" : "synthetic-api-workflow-e2e",
    reviewMode: "synthetic-api-transition",
    fixtureScope: deliveryReadyFixture ? "control-plane-ready-state-only" : "blocked-state-only",
    baseUrl,
    jobId: job.id,
    rootDir: finalized.rootDir,
    runDir: prepared.artifacts?.editableRun?.path || prompted.artifacts?.editableNext?.runDir || "",
    pageId: "page_001",
    finalPath,
    validationPath,
    editable: finalized.artifacts?.editableFinal?.pptxEditability?.editable ?? null,
    taskSummary: (await api(baseUrl, `/api/workflow-jobs/${job.id}/editable/worker-tasks`)).summary,
    delivery: {
      gate: delivery.finalGate?.level || "",
      pageEvidenceComplete: delivery.finalGate?.checks?.pageEvidenceComplete === true,
      finalEvidenceComplete: delivery.finalGate?.checks?.finalEvidenceComplete === true,
      codexPptApprovalsComplete: delivery.finalGate?.checks?.codexPptApprovalsComplete === true,
      codexPptBackendFixed: delivery.finalGate?.checks?.codexPptBackendFixed === true,
      reasons: delivery.finalGate?.reasons || []
    },
    compliance: {
      pageEvidence: checkStatus(compliance, "page-worker-evidence"),
      finalEvidence: checkStatus(compliance, "finalize-evidence"),
      recordedPages: compliance.counts?.recordedPages || 0,
      pageEvidencePages: compliance.counts?.pageEvidencePages || 0,
      pageEvidenceTotal: compliance.counts?.pageEvidenceTotal || 0,
      finalEvidenceComplete: compliance.counts?.finalEvidenceComplete || 0
    }
  };
  console.log(JSON.stringify(result, null, 2));
}

async function promoteSyntheticDeliveryReadyFixture(jobId) {
  const backend = {
    provider: "strict-ui-fixture",
    baseUrl: "http://strict-ui-fixture.local",
    model: "strict-ui-image-fixture"
  };
  let job = await readWorkflowJob(jobId);
  const sample = job.artifacts?.visualSample || {};
  job.artifacts = {
    ...(job.artifacts || {}),
    visualSample: { ...sample, ...backend, syntheticFixture: true },
    visualImages: (job.artifacts?.visualImages || []).map((image) => ({
      ...image,
      ...backend,
      approvedSampleSha256: sample.sha256,
      referenceImagePaths: [sample.path].filter(Boolean),
      staleStyleReference: false,
      styleLockStatus: "current",
      syntheticFixture: true
    }))
  };
  job = await saveWorkflowJob(job);
  job = await recordWorkflowCodexPptOutline(jobId, {
    source: "strict-ui-synthetic-fixture",
    recordedBy: "strict-ui-e2e",
    title: "Synthetic ready-state fixture",
    outlinePlan: {
      title: "Synthetic ready-state fixture",
      layoutSequence: [{ layout: "cover", title: "Editable PPT Smoke Test", purpose: "Validate ready-state delivery controls." }]
    }
  });
  job = await recordWorkflowCodexPptStyle(jobId, {
    source: "strict-ui-synthetic-fixture",
    recordedBy: "strict-ui-e2e",
    styleBrief: "Synthetic QA fixture with a restrained blue and white system.",
    audience: "automated acceptance",
    tone: "neutral"
  });
  job = await recordWorkflowCodexPptBackendDecision(jobId, {
    source: "strict-ui-synthetic-fixture",
    recordedBy: "strict-ui-e2e",
    backend
  });
  for (const gate of ["outline", "style", "backend", "sample", "fullDeck"]) {
    job = await approveCodexPptGate(jobId, {
      gate,
      backend,
      allowNonProductBackend: true,
      approvedBy: "strict-ui-e2e",
      note: "Synthetic control-plane fixture; not product-generation evidence."
    });
  }
  job = await readWorkflowJob(jobId);
  const run = await prepareCodexPptSlideRun(job, {
    renderedPages: job.artifacts?.renderedPages || [],
    selectedPages: [1],
    prompts: {
      styleBrief: "Synthetic QA fixture",
      styleLock: { source: "strict-ui-synthetic-fixture" },
      pages: [{ pageNumber: 1, prompt: "Use the existing synthetic visual page as the accepted fixture." }]
    },
    options: { maxConcurrentSlides: 1 }
  });
  job.artifacts = {
    ...(job.artifacts || {}),
    codexPptDeckSpec: run.deckSpec,
    codexPptSpeech: run.speech,
    codexPptSlideJobs: run.slideJobs,
    codexPptSlideRunState: run.slideRunState,
    codexPptSlidePrompts: run.slidePrompts
  };
  return saveWorkflowJob(job);
}

function assertDeliveryEvidence(delivery = {}) {
  const gate = delivery.finalGate || {};
  const checks = gate.checks || {};
  for (const key of ["hasFinal", "validationPassed", "pageEvidenceComplete", "finalEvidenceComplete"]) {
    if (checks[key] !== true) throw new Error(`Delivery gate check failed: ${key}`);
  }
  if (gate.level !== "blocked") {
    throw new Error(`Synthetic smoke must remain blocked without codex-ppt evidence, got ${gate.level || "missing"}.`);
  }
  if (!isOnlyCodexPptBlocked(gate)) {
    throw new Error(`Delivery gate is blocked for non-codex evidence reason(s): ${(gate.reasons || []).join("; ")}`);
  }
  if (checks.codexPptApprovalsComplete !== false) throw new Error("Synthetic smoke unexpectedly has codex-ppt approval evidence.");
  if (checks.codexPptBackendFixed !== false) throw new Error("Synthetic smoke unexpectedly has a fixed codex-ppt backend.");
  if (delivery.status?.level !== "blocked") throw new Error(`Synthetic smoke delivery status must be blocked, got ${delivery.status?.level || "missing"}.`);
  if (delivery.pageEvidence?.complete !== true) throw new Error("Delivery page evidence is not complete.");
  if (delivery.finalEvidence?.complete !== true) throw new Error("Delivery final evidence is not complete.");
}

function assertReadyDeliveryEvidence(delivery = {}) {
  const gate = delivery.finalGate || {};
  const checks = gate.checks || {};
  for (const key of [
    "hasFinal",
    "validationPassed",
    "pageEvidenceComplete",
    "finalEvidenceComplete",
    "codexPptApprovalsComplete",
    "codexPptOutlineRecorded",
    "codexPptStyleRecorded",
    "codexPptBackendDecisionRecorded",
    "codexPptSampleRecorded",
    "codexPptBackendFixed",
    "codexPptSlideRunComplete"
  ]) {
    if (checks[key] !== true) throw new Error(`Ready fixture delivery gate check failed: ${key}`);
  }
  if (gate.productReady !== true || gate.downloadable !== true || gate.level !== "ready") {
    throw new Error(`Synthetic ready fixture did not close the delivery gate: ${JSON.stringify({ level: gate.level, productReady: gate.productReady, downloadable: gate.downloadable, reasons: gate.reasons })}`);
  }
  if (delivery.status?.level !== "ready") throw new Error(`Synthetic ready fixture status must be ready, got ${delivery.status?.level || "missing"}.`);
}

function isOnlyCodexPptBlocked(gate = {}) {
  const reasons = Array.isArray(gate.reasons) ? gate.reasons : [];
  return reasons.length > 0 && reasons.every((reason) => /codex-ppt/i.test(reason));
}

function assertComplianceEvidence(compliance = {}) {
  const pageEvidence = checkStatus(compliance, "page-worker-evidence");
  const finalEvidence = checkStatus(compliance, "finalize-evidence");
  if (pageEvidence !== "pass") throw new Error(`Compliance page-worker-evidence expected pass, got ${pageEvidence || "missing"}`);
  if (finalEvidence !== "pass") throw new Error(`Compliance finalize-evidence expected pass, got ${finalEvidence || "missing"}`);
  if (compliance.editppt?.pageEvidence?.complete !== true) throw new Error("Compliance page evidence is not complete.");
  if (compliance.editppt?.finalEvidence?.complete !== true) throw new Error("Compliance final evidence is not complete.");
}

function checkStatus(bundle = {}, id = "") {
  return (Array.isArray(bundle.checks) ? bundle.checks : []).find((check) => check.id === id)?.status || "";
}

async function runSmokeWorker() {
  const pageDir = path.resolve(process.env.PPT_WORKER_PAGE_DIR || "");
  if (!pageDir || !fsSync.existsSync(pageDir)) throw new Error("PPT_WORKER_PAGE_DIR is required for smoke worker mode.");
  const pageRequest = await readJson(path.join(pageDir, "page_request.json"));
  const width = Number(pageRequest.source_size_px?.width || 1280);
  const height = Number(pageRequest.source_size_px?.height || 720);
  const spec = buildSmokeRebuildSpec({ width, height });
  await writeJson(path.join(pageDir, "page-rebuild-spec.json"), spec);
  const { stdout, stderr } = await execFileAsync(process.execPath, ["scripts/page-worker-pipeline.mjs"], {
    cwd: process.cwd(),
    windowsHide: true,
    encoding: "utf8",
    timeout: 180000,
    env: {
      ...process.env,
      PPT_WORKER_PAGE_DIR: pageDir,
      PYTHONIOENCODING: "utf-8"
    }
  });
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}

function buildSmokeRebuildSpec({ width, height }) {
  return {
    schema_version: 1,
    strategy: "smoke-worker-native-rebuild",
    page_strategy: "smoke-worker-native-rebuild",
    text_inventory: [
      { id: "title", text: "Editable PPT Smoke Test", decision: "native-text" },
      { id: "body", text: "Runner, pipeline, record, and finalize completed.", decision: "native-text" }
    ],
    visual_inventory: [
      { id: "background", description: "native structural background and accent shapes" }
    ],
    background_strategy: {
      mode: "native-or-script",
      source_consistency_contract: "Preserve a clean wide-slide composition with light background, left title block, and right accent panel.",
      removed_foreground: [],
      comparison_note: "Synthetic smoke source is intentionally simple and rebuilt with native editable objects."
    },
    quality_checks: {
      font_size_calibrated: true,
      visual_inventory_matched: true,
      background_strategy_checked: true,
      shape_corner_geometry_checked: true
    },
    required_text: [
      "Editable PPT Smoke Test",
      "Runner, pipeline, record, and finalize completed."
    ],
    text_boxes: [
      {
        id: "title",
        text: "Editable PPT Smoke Test",
        box_px: [96, 128, Math.round(width * 0.52), 86],
        font_size: 34,
        font_size_source: "smoke-worker-spec",
        font_face: "Microsoft YaHei",
        color: "#172033",
        bold: true,
        wrap: true,
        fit_text: true,
        z_index: 100
      },
      {
        id: "body",
        text: "Runner, pipeline, record, and finalize completed.",
        box_px: [100, 250, Math.round(width * 0.5), 110],
        font_size: 20,
        font_size_source: "smoke-worker-spec",
        font_face: "Microsoft YaHei",
        color: "#3F4A5F",
        wrap: true,
        fit_text: true,
        z_index: 101
      }
    ],
    shapes: [
      {
        id: "page_background",
        type: "rect",
        box_px: [0, 0, width, height],
        fill: "#F8FAFC",
        stroke: "none",
        z_index: 0
      },
      {
        id: "accent_panel",
        type: "roundRect",
        box_px: [Math.round(width * 0.64), 96, Math.round(width * 0.25), Math.round(height * 0.62)],
        fill: "#DDE7F2",
        stroke: "#9FB4CC",
        source_corner_radius_px: 24,
        corner_category: "medium-radius",
        corner_reason: "synthetic source uses a softly rounded accent panel",
        z_index: 10
      },
      {
        id: "accent_line",
        type: "line",
        points_px: [96, 224, Math.round(width * 0.52), 224],
        color: "#2A6F97",
        stroke: "#2A6F97",
        width: 3,
        z_index: 20
      }
    ],
    images: [],
    asset_provenance: [],
    notes: "Smoke worker authored this spec, then delegated page artifact creation to lab:page-pipeline."
  };
}

async function api(baseUrl, route, { method = "GET", body = null } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${response.status} ${route}`);
  }
  return data;
}

async function writeSolidPng(filePath, width, height, color) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
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
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", Buffer.concat([
      uint32(width),
      uint32(height),
      Buffer.from([8, 6, 0, 0, 0])
    ])),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
  await fs.writeFile(filePath, png);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([typeBuffer, data]);
  return Buffer.concat([
    uint32(data.length),
    typeBuffer,
    data,
    uint32(crc32(crcInput))
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

async function hashFile(filePath) {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

function quoteCommand(parts) {
  return parts.map((part) => {
    const text = String(part);
    if (!/[\s"]/u.test(text)) return text;
    return `"${text.replace(/"/g, '\\"')}"`;
  }).join(" ");
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

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function printHelp() {
  console.log(`Workflow E2E smoke

Usage:
  node scripts/smoke-workflow-e2e.mjs --base-url http://127.0.0.1:4180

What it proves:
  1. Creates a synthetic workflow job with one visual page.
  2. Calls the real editable prepare and prompt APIs.
  3. Runs worker:once against a real external smoke worker command.
  4. The worker writes page-rebuild-spec.json and delegates artifacts to lab:page-pipeline.
  5. worker:once completes, record runs, then finalize produces editable-final.pptx.
  6. Delivery and compliance APIs report complete page/final evidence.
  7. Any blocked delivery gate reason is limited to the missing codex-ppt half of the full product path.
`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
