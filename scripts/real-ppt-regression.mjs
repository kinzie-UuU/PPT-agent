#!/usr/bin/env node
import "dotenv/config";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { createWorkflowJob } from "../server/workflowJobs.js";
import { writeV1AcceptanceReport } from "../server/workflowV1AcceptanceReport.js";

const DEFAULT_BASE_URL = process.env.PPT_TOOL_BASE_URL || "http://127.0.0.1:4180";
const DEFAULT_SOURCE = process.env.PPT_TOOL_REAL_PPT_SOURCE || "";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const baseUrl = String(args["base-url"] || args.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const sourcePath = await resolveSourcePath(args);
  const maxPages = clampInteger(args["max-pages"] || args.maxPages, 1, 200, 3);
  const pageSelection = cleanPageSelection(args.pages || `1-${maxPages}`);
  const skipOcr = Boolean(args["skip-ocr"]);
  const skipEditable = Boolean(args["skip-editable"]);
  const skipWorkerBatch = Boolean(args["skip-worker-batch"]);

  if (!sourcePath) {
    throw new Error([
      "Missing real PPT source.",
      "Pass --source \"C:\\path\\deck.pptx\" or set PPT_TOOL_REAL_PPT_SOURCE.",
      "Use --latest-download-pptx only when the newest PPTX in Downloads is the intended acceptance deck."
    ].join(" "));
  }
  if (!fsSync.existsSync(sourcePath)) throw new Error(`Source file not found: ${sourcePath}`);
  const health = await api(baseUrl, "/api/health");
  if (!health.ok) throw new Error(`PPT tool server is not healthy at ${baseUrl}`);

  const stat = await fs.stat(sourcePath);
  const sourceUpload = {
    id: `real_regression_${Date.now()}`,
    path: sourcePath,
    originalName: path.basename(sourcePath),
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    size: stat.size
  };

  let job = await createWorkflowJob({
    sourceUpload,
    internal: true,
    mode: "real-ppt-regression",
    notes: `Real PPT regression. pages=${pageSelection}; maxPages=${maxPages}; dry-run visual passthrough.`
  });

  job = await runJobStep(baseUrl, job.id, "source/render");
  const renderedCount = job.artifacts?.renderedPages?.length || 0;
  if (!renderedCount) throw new Error(`Source render produced no pages for job ${job.id}`);
  job = await recordCodexPptOutline(baseUrl, job.id, {
    pageCount: renderedCount,
    source: "real-ppt-regression",
    title: path.basename(sourcePath)
  });
  if (!job.artifacts?.codexPptOutline?.path) {
    throw new Error(`codex-ppt outline artifact was not recorded for job ${job.id}`);
  }
  job = await recordCodexPptStyle(baseUrl, job.id, {
    source: "real-ppt-regression",
    styleBrief: "Regression style decision for dry-run passthrough visual generation."
  });
  if (!job.artifacts?.codexPptStyle?.path) {
    throw new Error(`codex-ppt style artifact was not recorded for job ${job.id}`);
  }
  job = await recordCodexPptBackendDecision(baseUrl, job.id, {
    source: "real-ppt-regression",
    backend: { provider: "passthrough", model: "regression-dry-run" }
  });
  if (!job.artifacts?.codexPptBackendDecision?.path) {
    throw new Error(`codex-ppt backend decision artifact was not recorded for job ${job.id}`);
  }

  const approvalProbe = await api(baseUrl, `/api/workflow-jobs/${job.id}/visual/generate`, {
    method: "POST",
    body: { dryRun: true, passthrough: true, pages: pageSelection, maxPages },
    expectStatus: 409
  });
  if (approvalProbe.code !== "CODEX_PPT_APPROVAL_REQUIRED") {
    throw new Error(`Expected codex-ppt approval gate before visual/generate, got ${approvalProbe.code || "none"}`);
  }
  for (const gate of ["outline", "style", "backend"]) {
    await approveCodexPptGate(baseUrl, job.id, gate);
  }

  job = await runJobStep(baseUrl, job.id, "visual/sample", {
    dryRun: true,
    passthrough: true,
    provider: "passthrough",
    allowNonProductVisual: true,
    pageNumber: 1,
    visualProfile: "real-ppt-regression"
  });
  if (!job.artifacts?.visualSample?.path) {
    throw new Error(`Visual sample did not produce artifact evidence for job ${job.id}`);
  }

  for (const gate of ["sample", "fullDeck"]) {
    await approveCodexPptGate(baseUrl, job.id, gate);
  }

  const taskSync = await api(baseUrl, `/api/workflow-jobs/${job.id}/codex-ppt/slide-tasks/sync`, {
    method: "POST",
    body: {
      pages: pageSelection,
      maxPages,
      force: true,
      visualProfile: "real-ppt-regression"
    }
  });
  const slideTasks = Array.isArray(taskSync.tasks) ? taskSync.tasks : [];
  if (!slideTasks.length) throw new Error("codex-ppt slide task sync produced no tasks");
  const agentId = `real-ppt-regression-${Date.now()}`;
  let completedTaskBundle = taskSync;
  for (const task of slideTasks) {
    await api(baseUrl, `/api/workflow-jobs/${job.id}/codex-ppt/slide-tasks/${task.pageId}/claim`, {
      method: "POST",
      body: {
        agentId,
        workerName: "real-ppt-regression-worker",
        dispatchMode: "external-slide-worker-regression",
        confirmSpawned: true
      }
    });
    const sourceImagePath = job.artifacts?.renderedPages?.[task.pageNumber - 1]?.path || job.artifacts?.renderedPages?.[0]?.path || "";
    completedTaskBundle = await api(baseUrl, `/api/workflow-jobs/${job.id}/codex-ppt/slide-tasks/${task.pageId}/complete`, {
      method: "POST",
      body: {
        agentId,
        imagePath: sourceImagePath,
        provider: "passthrough",
        model: "regression-dry-run",
        dryRun: true,
        passthrough: true,
        allowNonProductVisual: true,
        qaNote: "Regression worker returned source page passthrough image."
      }
    });
  }
  if (completedTaskBundle.summary?.recorded !== slideTasks.length) {
    throw new Error(`Expected ${slideTasks.length} recorded codex-ppt slide tasks, got ${completedTaskBundle.summary?.recorded ?? "none"}`);
  }
  job = await api(baseUrl, `/api/workflow-jobs/${job.id}`);

  const visualCount = job.artifacts?.visualImages?.length || 0;
  if (!visualCount) throw new Error(`Visual passthrough produced no images for job ${job.id}`);
  const slideState = summarizeCodexPptSlideState(job);
  if (!slideState.complete) {
    throw new Error(`codex-ppt slide state incomplete: ${JSON.stringify(slideState)}`);
  }
  const visualImages = Array.isArray(job.artifacts?.visualImages) ? job.artifacts.visualImages : [];
  const provenancePreserved = visualImages.every((image) => image.provider === "passthrough" && image.dryRun === true && image.sha256);
  if (!provenancePreserved) {
    throw new Error("Visual image provenance was not preserved after folder discovery");
  }

  job = await runJobStep(baseUrl, job.id, "image-deck/assemble", {
    outName: "real-regression-image-deck.pptx"
  });
  const postImageDeckCompliance = await api(baseUrl, `/api/workflow-jobs/${job.id}/compliance`);
  if (postImageDeckCompliance.runbook?.currentStep !== "editppt-prepare") {
    throw new Error(`Real PPT runbook expected editppt-prepare after image deck, got ${postImageDeckCompliance.runbook?.currentStep || "none"}`);
  }

  if (!skipOcr) {
    job = await runJobStep(baseUrl, job.id, "ocr/run", {
      minConfidence: 0.35
    });
  }

  let editableStatus = null;
  let taskBundle = null;
  let localRebuild = null;
  let editableFinal = null;
  let workerBatch = null;
  if (!skipEditable) {
    job = await runJobStep(baseUrl, job.id, "editable/prepare", {
      force: true,
      noTextHints: skipOcr,
      maxConcurrentPages: Math.min(6, visualCount)
    });
    job = await runJobStep(baseUrl, job.id, "editable/prompts", {
      pages: Array.from({ length: visualCount }, (_item, index) => `page_${String(index + 1).padStart(3, "0")}`)
    });
    editableStatus = await api(baseUrl, `/api/workflow-jobs/${job.id}/editable/status`);
    taskBundle = await api(baseUrl, `/api/workflow-jobs/${job.id}/editable/worker-tasks/sync`, {
      method: "POST",
      body: {}
    });
    if (visualCount === 1 && editableStatus.next?.stage === "rebuild_page_locally" && !skipOcr) {
      job = await runJobStep(baseUrl, job.id, "editable/local-rebuild", {
        agentId: "main",
        allowTextDominantLocal: true,
        regression: true
      });
      localRebuild = {
        stageAfterRecord: job.artifacts?.editableNext?.next?.stage || "",
        count: Array.isArray(job.artifacts?.editableLocalRebuilds) ? job.artifacts.editableLocalRebuilds.length : 0
      };
      if (localRebuild.stageAfterRecord !== "finalize") {
        throw new Error(`Expected finalize after local rebuild, got ${localRebuild.stageAfterRecord || "unknown"}`);
      }
      job = await runJobStep(baseUrl, job.id, "editable/finalize", {});
      editableFinal = {
        path: job.artifacts?.editableFinal?.path || "",
        editable: job.artifacts?.editableFinal?.pptxEditability?.editable ?? null,
        validation: job.artifacts?.editableFinal?.validation?.path || ""
      };
    } else if (visualCount > 1 && !skipOcr && !skipWorkerBatch) {
      const preflight = await api(baseUrl, `/api/workflow-jobs/${job.id}/editable/worker-runs/preflight`, {
        method: "POST",
        body: {
          mode: "local",
          maxPages: visualCount,
          acceptOfflineTextHints: true,
          autoFinalize: true,
          agentPrefix: "real-ppt-local-worker"
        }
      });
      if (!preflight.startReady) {
        throw new Error(`Local editable worker batch preflight failed: ${[
          ...(preflight.blockingIssues || []),
          ...(preflight.warnings || [])
        ].join(" ") || "not start-ready"}`);
      }
      const started = await api(baseUrl, `/api/workflow-jobs/${job.id}/editable/worker-runs`, {
        method: "POST",
        body: {
          mode: "local",
          maxPages: visualCount,
          acceptOfflineTextHints: true,
          autoFinalize: true,
          agentPrefix: "real-ppt-local-worker"
        }
      });
      const runId = started.run?.id || "";
      const completed = await waitForWorkerBatch(baseUrl, job.id, runId, {
        timeoutMs: clampInteger(args["worker-timeout-ms"] || args.workerTimeoutMs, 60000, 1800000, 900000),
        pollMs: 5000
      });
      if (completed.status !== "complete" || completed.finalize?.ok !== true) {
        throw new Error(`Local editable worker batch did not finalize: status=${completed.status || "unknown"} error=${completed.error || completed.finalize?.error || ""}`);
      }
      workerBatch = {
        runId,
        mode: completed.mode || "local",
        status: completed.status,
        succeeded: completed.succeeded ?? null,
        failed: completed.failed ?? null,
        taskSummary: completed.taskSummary || completed.summary?.taskSummary || null,
        finalize: completed.finalize || null,
        logPath: completed.logPath || ""
      };
      taskBundle = await api(baseUrl, `/api/workflow-jobs/${job.id}/editable/worker-tasks`);
      job = await api(baseUrl, `/api/workflow-jobs/${job.id}`);
      editableStatus = await api(baseUrl, `/api/workflow-jobs/${job.id}/editable/status`);
      editableFinal = {
        path: job.artifacts?.editableFinal?.path || "",
        editable: job.artifacts?.editableFinal?.pptxEditability?.editable ?? null,
        validation: job.artifacts?.editableFinal?.validation?.path || ""
      };
    }
  }

  const result = {
    ok: true,
    baseUrl,
    sourcePath,
    maxPages,
    pageSelection,
    command: `npm.cmd run regression:real-ppt -- --source "${sourcePath}" --max-pages ${maxPages}${skipOcr ? " --skip-ocr" : ""}${skipEditable ? " --skip-editable" : ""}${skipWorkerBatch ? " --skip-worker-batch" : ""}`,
    jobId: job.id,
    rootDir: job.rootDir,
    sourceRender: {
      renderedPages: renderedCount,
      renderer: job.artifacts?.sourceMeta?.renderer || job.artifacts?.sourceMeta?.path || ""
    },
    approvals: {
      approvalGateProbe: approvalProbe.code,
      recorded: ["outline", "style", "backend", "sample", "fullDeck"],
      outlineArtifact: job.artifacts?.codexPptOutline?.path || "",
      styleArtifact: job.artifacts?.codexPptStyle?.path || "",
      backendArtifact: job.artifacts?.codexPptBackendDecision?.path || ""
    },
    sample: {
      visualSample: job.artifacts?.visualSample?.path || "",
      visualSampleManifest: job.artifacts?.visualSampleManifest?.path || ""
    },
    visual: {
      mode: "passthrough",
      visualImages: visualCount,
      slideState,
      provenancePreserved,
      nextRunbookStep: postImageDeckCompliance.runbook?.currentStep || "",
      visualManifest: job.artifacts?.visualManifest?.path || "",
      imageDeck: job.artifacts?.imageDeck?.path || ""
    },
    ocr: summarizeOcr(job),
    editable: editableStatus ? {
      runDir: editableStatus.runDir,
      nextStage: editableStatus.next?.stage || "",
      tasks: taskBundle?.summary || null,
      workerBatch,
      localRebuild,
      final: editableFinal
    } : null,
    artifacts: {
      state: path.join(job.rootDir, "state.json"),
      sourceMeta: job.artifacts?.sourceMeta?.path || "",
      codexPptDeckSpec: job.artifacts?.codexPptDeckSpec?.path || "",
      codexPptSlideJobs: job.artifacts?.codexPptSlideJobs?.path || "",
      codexPptSlideRunState: job.artifacts?.codexPptSlideRunState?.path || "",
      imageDeck: job.artifacts?.imageDeck?.path || "",
      ocrTextHints: job.artifacts?.ocrTextHints?.path || "",
      editableRunPointer: job.artifacts?.editableRun?.workspacePointerPath || "",
      editableFinal: job.artifacts?.editableFinal?.path || ""
    }
  };

  const acceptanceReport = await writeV1AcceptanceReport(result, { kind: "real-ppt-regression" });
  console.log(JSON.stringify({ ...result, acceptanceReport }, null, 2));
}

function summarizeCodexPptSlideState(job = {}) {
  const artifacts = job.artifacts || {};
  const jobs = artifacts.codexPptSlideJobs || {};
  const state = artifacts.codexPptSlideRunState || {};
  const total = Number(state.total || jobs.total || artifacts.codexPptSlidePrompts?.length || 0);
  const recorded = Number(state.recorded || jobs.recorded || 0);
  const dispatched = Number(state.dispatched || jobs.dispatched || 0);
  const failed = Number(state.failed || jobs.failed || 0);
  return {
    total,
    dispatched,
    recorded,
    failed,
    complete: Boolean(artifacts.codexPptDeckSpec?.path && jobs.path && state.path && total > 0 && dispatched >= total && recorded >= total && failed === 0),
    deckSpec: artifacts.codexPptDeckSpec?.path || "",
    slideJobs: jobs.path || "",
    slideRunState: state.path || "",
    prompts: artifacts.codexPptSlidePrompts?.length || 0
  };
}

async function runJobStep(baseUrl, jobId, action, body = {}) {
  return api(baseUrl, `/api/workflow-jobs/${jobId}/${action}`, {
    method: "POST",
    body
  });
}

async function approveCodexPptGate(baseUrl, jobId, gate) {
  return api(baseUrl, `/api/workflow-jobs/${jobId}/codex-ppt/approvals/${gate}/approve`, {
    method: "POST",
    body: {
      approvedBy: "real-ppt-regression",
      note: `regression dry-run approval for ${gate}`,
      allowNonProductBackend: true,
      ...(gate === "backend" ? { backend: { provider: "passthrough", model: "regression-dry-run" } } : {})
    }
  });
}

async function recordCodexPptOutline(baseUrl, jobId, { pageCount = 1, source = "real-ppt-regression", title = "" } = {}) {
  return api(baseUrl, `/api/workflow-jobs/${jobId}/codex-ppt/outline`, {
    method: "POST",
    body: {
      pageCount,
      source,
      title,
      recordedBy: "real-ppt-regression",
      outlinePlan: {
        layoutSequence: Array.from({ length: pageCount }, (_item, index) => ({
          layout: index === 0 ? "cover" : index === pageCount - 1 && pageCount > 2 ? "closing" : "content",
          title: index === 0 ? "Opening" : index === pageCount - 1 && pageCount > 2 ? "Closing" : `Slide ${index + 1}`,
          purpose: `Regression outline for source page ${index + 1}.`,
          evidence: `source page ${index + 1}`
        }))
      }
    }
  });
}

async function recordCodexPptStyle(baseUrl, jobId, { source = "real-ppt-regression", styleBrief = "" } = {}) {
  return api(baseUrl, `/api/workflow-jobs/${jobId}/codex-ppt/style`, {
    method: "POST",
    body: {
      source,
      styleBrief,
      recordedBy: "real-ppt-regression"
    }
  });
}

async function recordCodexPptBackendDecision(baseUrl, jobId, { source = "real-ppt-regression", backend = {} } = {}) {
  return api(baseUrl, `/api/workflow-jobs/${jobId}/codex-ppt/backend`, {
    method: "POST",
    body: {
      source,
      backend,
      recordedBy: "real-ppt-regression"
    }
  });
}

async function waitForWorkerBatch(baseUrl, jobId, runId, { timeoutMs = 900000, pollMs = 5000 } = {}) {
  if (!runId) throw new Error("Worker batch did not return a run id.");
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const bundle = await api(baseUrl, `/api/workflow-jobs/${jobId}/editable/worker-runs`);
    const run = (bundle.runs || []).find((item) => item.id === runId);
    if (!run) throw new Error(`Worker batch run not found: ${runId}`);
    if (run.status && run.status !== "running" && !isTransientRunnerUnknown(run)) return run;
    await delay(pollMs);
  }
  throw new Error(`Timed out waiting for editable worker batch ${runId}.`);
}

function isTransientRunnerUnknown(run = {}) {
  return run.status === "unknown"
    && !run.finishedAt
    && /Runner process is no longer visible/i.test(run.error || "");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function summarizeOcr(job) {
  const artifact = job.artifacts?.ocrTextHints;
  if (!artifact) return null;
  return {
    pageCount: artifact.pageCount || 0,
    textCount: artifact.textCount || 0,
    lowConfidenceCount: artifact.lowConfidenceCount || 0,
    path: artifact.path || ""
  };
}

function cleanPageSelection(value) {
  return String(value || "").replace(/[^\d,\-\s]/g, "").replace(/\s+/g, "").replace(/^,+|,+$/g, "") || "1";
}

async function resolveSourcePath(args = {}) {
  const explicit = args.source || args.s || DEFAULT_SOURCE;
  if (explicit && explicit !== true) return path.resolve(String(explicit));
  if (!args["latest-download-pptx"]) return "";
  const candidate = await findLatestDownloadPptx();
  return candidate ? path.resolve(candidate) : "";
}

async function findLatestDownloadPptx() {
  const home = globalThis.process?.env?.USERPROFILE
    || (globalThis.process?.env?.HOMEDRIVE && globalThis.process?.env?.HOMEPATH
      ? `${globalThis.process.env.HOMEDRIVE}${globalThis.process.env.HOMEPATH}`
      : "");
  if (!home) return "";
  const downloads = path.join(home, "Downloads");
  const names = await fs.readdir(downloads).catch(() => []);
  const candidates = [];
  for (const name of names) {
    if (!/\.pptx$/i.test(name) || name.startsWith("~$")) continue;
    const fullPath = path.join(downloads, name);
    const stat = await fs.stat(fullPath).catch(() => null);
    if (stat?.isFile()) candidates.push({ path: fullPath, mtimeMs: stat.mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.path || "";
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
  console.log(`Real PPT regression

Usage:
  npm.cmd run regression:real-ppt -- --source "C:\\path\\deck.pptx" --max-pages 15 --skip-ocr --skip-editable --skip-worker-batch

Default source:
  ${DEFAULT_SOURCE || "none; pass --source or set PPT_TOOL_REAL_PPT_SOURCE"}

Optional source discovery:
  --latest-download-pptx uses the newest .pptx file from the current user's Downloads folder.

What it does:
  1. Creates a workflow job from a real PPTX.
  2. Renders source pages with the product source renderer.
  3. Verifies codex-ppt approval gates block visual generation.
  4. Records regression-only codex-ppt approvals.
  5. Uses visual passthrough for the selected pages.
  6. Assembles an image-based intermediate deck.
  7. Runs local RapidOCR unless --skip-ocr is set.
  8. Prepares editppt and page worker prompts unless --skip-editable is set.
  9. For one-page runs, executes local rebuild and finalize.
  10. For multi-page runs, starts the product local worker batch and waits for auto-finalize unless --skip-worker-batch is set.
  11. Reports the next runbook step from the compliance API.

The visual half remains regression passthrough. The editable finalize proves the
v0.3 page-worker state machine and artifact contract, not final visual quality.
`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
