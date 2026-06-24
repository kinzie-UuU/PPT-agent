#!/usr/bin/env node
import "dotenv/config";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import zlib from "zlib";
import { execFile } from "child_process";
import { promisify } from "util";
import { createWorkflowJob, saveWorkflowJob } from "../server/workflowJobs.js";

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

  let job = await createWorkflowJob({
    internal: true,
    mode: "smoke-e2e",
    notes: "Synthetic runner -> page pipeline -> record -> finalize smoke test."
  });

  const sourceImage = path.join(job.dirs.visualImages, "smoke-page-001.png");
  await writeSolidPng(sourceImage, 1280, 720, {
    r: 248,
    g: 250,
    b: 252,
    a: 255
  });
  const imageStat = await fs.stat(sourceImage);
  job.artifacts = {
    ...(job.artifacts || {}),
    visualImages: [{
      kind: "visual_image",
      pageId: "page_001",
      pageNumber: 1,
      path: sourceImage,
      relativePath: path.relative(process.cwd(), sourceImage),
      size: imageStat.size,
      sha256: await hashFile(sourceImage),
      provider: "smoke-synthetic",
      createdAt: new Date().toISOString()
    }]
  };
  job = await saveWorkflowJob(job);

  const prepared = await api(baseUrl, `/api/workflow-jobs/${job.id}/editable/prepare`, {
    method: "POST",
    body: { force: true, noTextHints: true, maxConcurrentPages: 1, timeoutMs }
  });
  const prompted = await api(baseUrl, `/api/workflow-jobs/${job.id}/editable/prompts`, {
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

  const finalized = await api(baseUrl, `/api/workflow-jobs/${job.id}/editable/finalize`, {
    method: "POST",
    body: { timeoutMs }
  });
  const finalPath = finalized.artifacts?.editableFinal?.path || "";
  const validationPath = finalized.artifacts?.editableFinal?.validation?.path || "";
  if (!finalPath || !fsSync.existsSync(finalPath)) throw new Error(`Final editable PPTX was not created: ${finalPath}`);

  const delivery = await api(baseUrl, `/api/workflow-jobs/${job.id}/delivery-status`);
  const compliance = await api(baseUrl, `/api/workflow-jobs/${job.id}/compliance`);
  assertDeliveryEvidence(delivery);
  assertComplianceEvidence(compliance);

  const result = {
    ok: true,
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

function assertDeliveryEvidence(delivery = {}) {
  const gate = delivery.finalGate || {};
  const checks = gate.checks || {};
  for (const key of ["hasFinal", "validationPassed", "pageEvidenceComplete", "finalEvidenceComplete"]) {
    if (checks[key] !== true) throw new Error(`Delivery gate check failed: ${key}`);
  }
  if (gate.level === "blocked" && !isOnlyCodexPptBlocked(gate)) {
    throw new Error(`Delivery gate is blocked for non-codex evidence reason(s): ${(gate.reasons || []).join("; ")}`);
  }
  if (delivery.pageEvidence?.complete !== true) throw new Error("Delivery page evidence is not complete.");
  if (delivery.finalEvidence?.complete !== true) throw new Error("Delivery final evidence is not complete.");
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
