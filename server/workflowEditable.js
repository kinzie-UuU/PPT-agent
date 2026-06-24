import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { readWorkflowJob, saveWorkflowJob } from "./workflowJobs.js";
import { inspectEditablePptx } from "./pptxEditability.js";
import { runWorkflowOcr } from "./workflowOcr.js";

const execFileAsync = promisify(execFile);

const USER_HOME = process.env.USERPROFILE || "C:\\Users\\Administrator";
const DEFAULT_SKILL_ROOT = firstExistingPath([
  path.join(USER_HOME, ".agents", "skills", "image-to-editable-ppt"),
  path.join(USER_HOME, ".codex", "skills", "image-to-editable-ppt")
]);
const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_EDITABLE_RUN_ROOT = path.join(os.tmpdir(), "ppt-tool-editable-runs");

export async function testEditableRuntime(overrides = {}) {
  const runtime = getEditableRuntimeConfig(overrides);
  const contract = await inspectEditableSkillContract(runtime).catch((error) => ({
    ok: false,
    error: error.message || "Failed to inspect image-to-editable-ppt skill contract",
    skillRoot: runtime.skillRoot
  }));
  const result = await runEditppt(["doctor", "--json"], { runtime, timeoutMs: runtime.timeoutMs }).catch((error) => ({
    ok: false,
    stdout: error.stdout || "",
    stderr: error.stderr || "",
    error: error.message || "editppt doctor failed",
    exitCode: error.exitCode || 1
  }));
  const doctor = parseJsonOutput(result.stdout) || {};
  return {
    ok: Boolean(result.ok && doctor.ok),
    configured: Boolean(result.ok),
    runtime: publicRuntime(runtime),
    contract,
    doctor,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.ok ? doctor.next || "" : result.error
  };
}

export async function configureEditpptPaddleOcrToken(options = {}) {
  const token = String(options.paddleOcrToken || options.token || "").trim();
  if (!token) throw new Error("paddleOcrToken is required");
  const runtime = getEditableRuntimeConfig(options);
  await runEditppt(["config", "--paddle-ocr-token", token], { runtime, timeoutMs: runtime.timeoutMs });
  const doctor = await testEditableRuntime({
    skillRoot: runtime.skillRoot,
    pythonPath: runtime.pythonPath,
    timeoutMs: runtime.timeoutMs
  });
  return {
    ok: Boolean(doctor.ok),
    runtime: publicRuntime(runtime),
    textHints: compactDoctorTextHints(doctor)
  };
}

export async function getWorkflowEditablePreparePreflight(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const runtime = getEditableRuntimeConfig(options);
  const artifacts = job.artifacts || {};
  const inputs = getEditablePrepareInputs(job);
  const visualQuality = artifacts.visualQuality || {};
  const qualitySummary = normalizeVisualQualitySummary(visualQuality);
  const visualReviewCurrent = isVisualQualityReviewCurrent(artifacts);
  const textHintEvidence = getEditableTextHintEvidence(artifacts);
  const imageDeckPath = artifacts.imageDeck?.path || "";
  const checks = [
    {
      id: "image-deck",
      label: "图片型 PPT",
      ok: Boolean(imageDeckPath && fsSync.existsSync(imageDeckPath)),
      detail: imageDeckPath || "等待 codex-ppt 生成图片型 PPT"
    },
    {
      id: "visual-pages",
      label: "视觉页面图",
      ok: inputs.length > 0,
      detail: `${inputs.length} page(s)`
    },
    {
      id: "visual-quality",
      label: "视觉质量证据",
      ok: Boolean(visualQuality.path) && qualitySummary.failedCount === 0 && (qualitySummary.reviewCount === 0 || visualReviewCurrent),
      warning: Boolean(qualitySummary.reviewCount && visualReviewCurrent),
      detail: visualQuality.path ? `review ${qualitySummary.reviewCount || 0}, failed ${qualitySummary.failedCount || 0}, approved ${visualReviewCurrent ? "yes" : "no"}` : "尚未生成视觉质量报告"
    },
    {
      id: "text-hints",
      label: "文字提示",
      ok: true,
      warning: !textHintEvidence.ready || textHintEvidence.partial,
      detail: textHintEvidence.detail
    },
    {
      id: "skill-root",
      label: "image-to-editable-ppt skill",
      ok: Boolean(runtime.skillRoot && fsSync.existsSync(runtime.skillRoot)),
      detail: runtime.skillRoot
    },
    {
      id: "editppt-cli",
      label: "editppt CLI",
      ok: Boolean(runtime.cliPath && fsSync.existsSync(runtime.cliPath)),
      detail: runtime.cliPath
    },
    {
      id: "python-runtime",
      label: "Python runtime",
      ok: isExecutableReference(runtime.pythonPath),
      detail: runtime.pythonPath
    }
  ];
  const contract = await inspectEditableSkillContract(runtime).catch((error) => ({
    ok: false,
    error: error.message || "Failed to inspect image-to-editable-ppt skill contract",
    skillRoot: runtime.skillRoot
  }));
  checks.push({
    id: "skill-contract",
    label: "image-to-editable-ppt v0.3 contract",
    ok: Boolean(contract.ok),
    detail: contract.mode || contract.error || ""
  });
  const blockingIssues = checks
    .filter((check) => !check.ok)
    .map((check) => `${check.label}: ${check.detail || "not ready"}`);
  const warnings = [
    ...(qualitySummary.reviewCount && visualReviewCurrent ? [`${qualitySummary.reviewCount} page(s) were manually approved for visual/source review.`] : []),
    ...(!textHintEvidence.ready ? [textHintEvidence.warning] : []),
    ...(textHintEvidence.partial ? [textHintEvidence.warning] : [])
  ];
  const ready = blockingIssues.length === 0;
  return {
    ok: true,
    preview: true,
    didRun: false,
    paidImageGeneration: false,
    safeToRunAutomatically: true,
    jobId: job.id,
    nextAction: "editable/prepare",
    ready,
    startReady: ready,
    blockingIssues,
    warnings,
    checks,
    runtime: publicRuntime(runtime),
    contract,
    inputCount: inputs.length,
    imageDeck: imageDeckPath ? artifactRecord("image_deck", imageDeckPath, { pageCount: artifacts.imageDeck?.pageCount || inputs.length }) : null,
    visualQuality: visualQuality.path ? visualQuality : null,
    textHints: textHintEvidence,
    summary: ready
      ? "图片型 PPT 已可进入 image-to-editable-ppt/editppt prepare。"
      : "还不能进入 image-to-editable-ppt/editppt prepare。"
  };
}

export async function prepareWorkflowEditableRun(jobId, options = {}) {
  let job = await readWorkflowJob(jobId);
  const runtime = getEditableRuntimeConfig(options);
  assertVisualQualityGate(job, options);
  let inputs = getEditablePrepareInputs(job);
  if (!inputs.length) throw new Error("No visual images available for editable prepare. Run visual/generate first.");
  if (!hasRapidOcrTextHints(job) && options.skipRapidOcr !== true && options.noTextHints !== true) {
    await runWorkflowOcr(jobId, {
      source: "visual",
      maxPages: inputs.length,
      requestedBy: "editable-prepare",
      note: "auto-run local RapidOCR before image-to-editable-ppt prepare"
    });
    job = await readWorkflowJob(jobId);
    inputs = getEditablePrepareInputs(job);
  }
  await fs.mkdir(job.dirs.editableRun, { recursive: true });
  const layout = getEditableRunLayout(job, options);
  const runDir = layout.runDir;
  const deckManifestPath = path.join(runDir, "deck_manifest.json");
  const force = Boolean(options.force);
  if (fsSync.existsSync(deckManifestPath) && !force) {
    const status = await getWorkflowEditableStatus(jobId, options).catch(() => null);
    const rapidOcrHints = await linkRapidOcrHints(job, runDir);
    const textHintsSummary = await collectTextHintSummary(runDir);
    job.artifacts = {
      ...(job.artifacts || {}),
      editableHints: artifactRecord("editable_text_hints", runDir, {
        runDir,
        summary: textHintsSummary,
        updatedAt: new Date().toISOString(),
        source: "prepare-reuse"
      }),
      editableRun: artifactRecord("editable_run", runDir, {
        prepared: true,
        reused: true,
        runtime: publicRuntime(runtime),
        rapidOcrHintsPath: rapidOcrHints?.path || null,
        textHints: textHintsSummary,
        status
      })
    };
    return saveWorkflowJob(markEditablePrepared(job, { runDir, inputs, runtime, status, rapidOcrHints, reused: true }));
  }
  if (force) await clearGeneratedEditableRun(layout, job);
  await fs.mkdir(layout.inputDir, { recursive: true });
  await fs.mkdir(layout.runDir, { recursive: true });
  const preparedInputs = await copyInputsToAsciiScratch(inputs, layout.inputDir);

  const args = [
    "prepare",
    ...preparedInputs.map((input) => input.path),
    "--job-dir",
    runDir,
    "--max-concurrent-pages",
    String(clampInteger(options.maxConcurrentPages, 1, 12, 6))
  ];
  if (options.noTextHints) args.push("--no-text-hints");

  const prepare = await runEditppt(args, { runtime, timeoutMs: runtime.timeoutMs });
  const status = await getEditableStatusForRun(runDir, runtime);
  const next = await getEditableNextForRun(runDir, runtime);
  const rapidOcrHints = await linkRapidOcrHints(job, runDir);
  const pointer = await writeEditableRunPointer(job, { layout, runtime, inputs, preparedInputs, status, next, rapidOcrHints });
  const deckManifest = await readJson(path.join(runDir, "deck_manifest.json")).catch(() => null);
  const pageJobs = await readJson(path.join(runDir, "page_jobs.json")).catch(() => null);
  const textHintsSummary = await collectTextHintSummary(runDir);

  job.artifacts = {
    ...(job.artifacts || {}),
    editableHints: artifactRecord("editable_text_hints", runDir, {
      runDir,
      summary: textHintsSummary,
      command: summarizeCommand(prepare),
      updatedAt: new Date().toISOString(),
      source: "prepare"
    }),
    editableRun: artifactRecord("editable_run", runDir, {
      prepared: true,
      reused: false,
      runtime: publicRuntime(runtime),
      runRoot: layout.runRoot,
      workspacePointerPath: pointer.path,
      inputCount: inputs.length,
      inputs: preparedInputs.map((input) => ({ pageId: input.pageId, pageNumber: input.pageNumber, path: input.path, sourcePath: input.sourcePath })),
      pageCount: Array.isArray(deckManifest?.pages) ? deckManifest.pages.length : pageJobs?.pages?.length || inputs.length,
      deckManifestPath: path.join(runDir, "deck_manifest.json"),
      pageJobsPath: path.join(runDir, "page_jobs.json"),
      rapidOcrHintsPath: rapidOcrHints?.path || null,
      editpptPrepare: summarizeCommand(prepare),
      textHints: textHintsSummary,
      status,
      next
    })
  };
  return saveWorkflowJob(markEditablePrepared(job, { runDir, inputs, runtime, status, next, rapidOcrHints }));
}

export async function invalidateWorkflowEditableRebuildEvidence(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const artifacts = job.artifacts || {};
  const {
    editableDispatches: _editableDispatches,
    editableRecords: _editableRecords,
    editableResets: _editableResets,
    editableLocalRebuilds: _editableLocalRebuilds,
    editableWorkerPrompts: _editableWorkerPrompts,
    editableWorkerTasks: _editableWorkerTasks,
    workerBriefs: _workerBriefs,
    editableNext: _editableNext,
    editableFinal: _editableFinal,
    manualReview: _manualReview,
    ...remainingArtifacts
  } = artifacts;
  const invalidated = [
    "editableDispatches",
    "editableRecords",
    "editableResets",
    "editableLocalRebuilds",
    "editableWorkerPrompts",
    "editableWorkerTasks",
    "workerBriefs",
    "editableNext",
    "editableFinal",
    "manualReview"
  ].filter((key) => artifacts[key] !== undefined);
  job.artifacts = remainingArtifacts;
  job.currentStage = "editable_prepared";
  job.status = "editable_prepared";
  job.stageStatus = "running";
  job.stages.pages_running = markStage(job.stages.pages_running, "pending", "Editable page evidence invalidated for fresh run", { invalidated });
  job.stages.finalizing = markStage(job.stages.finalizing, "pending", "Final editable PPTX invalidated for fresh run", { invalidated });
  job.stages.complete = markStage(job.stages.complete, "pending", "Workflow completion invalidated for fresh editable run", { invalidated });
  job.events = appendEvent(job.events, "editable.fresh_run_invalidated", "Invalidated stale editable rebuild evidence for fresh run", {
    reason: cleanString(options.reason || ""),
    invalidated
  });
  return saveWorkflowJob(job);
}

export async function getWorkflowEditableStatus(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const runtime = getEditableRuntimeConfig(options);
  const runDir = getPreparedRunDir(job);
  const status = await getEditableStatusForRun(runDir, runtime);
  const next = await getEditableNextForRun(runDir, runtime);
  return {
    ok: true,
    jobId,
    runDir,
    runtime: publicRuntime(runtime),
    status,
    next
  };
}

export async function getWorkflowEditableNext(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const runtime = getEditableRuntimeConfig(options);
  const runDir = getPreparedRunDir(job);
  const next = await getEditableNextForRun(runDir, runtime);
  job.artifacts = {
    ...(job.artifacts || {}),
    editableNext: {
      kind: "editable_next",
      runDir,
      next,
      checkedAt: new Date().toISOString()
    }
  };
  job.events = appendEvent(job.events, "editable.next", `editppt next: ${next.stage || "unknown"}`, { runDir, next });
  return saveWorkflowJob(job);
}

export async function regenerateWorkflowEditableHints(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const runtime = getEditableRuntimeConfig(options);
  const runDir = getPreparedRunDir(job);
  assertEditableHintsCanRegenerate(job, options);
  const hints = await runEditppt(["run", "hints", runDir], { runtime, timeoutMs: runtime.timeoutMs });
  const status = await getEditableStatusForRun(runDir, runtime);
  const next = await getEditableNextForRun(runDir, runtime);
  const doctor = await testEditableRuntime({
    skillRoot: runtime.skillRoot,
    pythonPath: runtime.pythonPath,
    timeoutMs: runtime.timeoutMs
  }).catch((error) => ({ ok: false, error: error.message || "editppt doctor failed" }));
  const summary = await collectTextHintSummary(runDir);
  const {
    editableWorkerPrompts: _editableWorkerPrompts,
    editableWorkerTasks: _editableWorkerTasks,
    workerBriefs: _workerBriefs,
    ...remainingArtifacts
  } = job.artifacts || {};
  job.artifacts = {
    ...remainingArtifacts,
    editableHints: artifactRecord("editable_text_hints", runDir, {
      runDir,
      summary,
      doctor: compactDoctorTextHints(doctor),
      command: summarizeCommand(hints),
      updatedAt: new Date().toISOString()
    }),
    editableNext: {
      kind: "editable_next",
      runDir,
      next,
      checkedAt: new Date().toISOString()
    },
    editableRun: job.artifacts?.editableRun ? {
      ...job.artifacts.editableRun,
      status,
      next,
      textHints: summary
    } : job.artifacts?.editableRun
  };
  job.events = appendEvent(job.events, "editable.hints_regenerated", `Regenerated editppt text hints for ${summary.pageCount || 0} page(s)`, {
    runDir,
    textHintsBackend: doctor.doctor?.text_hints?.selection || summary.backend || "",
    pageCount: summary.pageCount,
    nextStage: next.stage || "",
    invalidated: ["editableWorkerPrompts", "editableWorkerTasks", "workerBriefs"]
  });
  return saveWorkflowJob(job);
}

function assertEditableHintsCanRegenerate(job, options = {}) {
  if (options.forceAfterDispatch === true) return;
  const artifacts = job.artifacts || {};
  const dispatches = Array.isArray(artifacts.editableDispatches) ? artifacts.editableDispatches : [];
  const records = Array.isArray(artifacts.editableRecords) ? artifacts.editableRecords : [];
  const activeTasks = (Array.isArray(artifacts.editableWorkerTasks) ? artifacts.editableWorkerTasks : [])
    .filter((task) => ["claimed", "running", "recorded"].includes(task.status));
  if (dispatches.length || records.length || activeTasks.length) {
    throw new Error("Cannot regenerate editppt text hints after page reconstruction has started. Reset or create a fresh editable run before changing text hints.");
  }
}

export async function buildWorkflowEditableWorkerPrompts(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const runtime = getEditableRuntimeConfig(options);
  const runDir = getPreparedRunDir(job);
  const next = await getEditableNextForRun(runDir, runtime);
  const localMode = next.stage === "rebuild_page_locally";
  if (next.stage !== "dispatch_pages" && !localMode) {
    throw new Error(`Editable run is not ready to dispatch or rebuild pages. Current next stage: ${next.stage || "unknown"}`);
  }
  const selectedPages = normalizePages(options.pages || options.pageIds || next.dispatchable_pages || next.suggested_pages || next.pages || next.page_id || next.page || []);
  if (!selectedPages.length) throw new Error("No dispatchable or locally rebuildable pages returned by editppt run next.");
  const prompts = [];
  for (const pageId of selectedPages) {
    const pageDir = path.join(runDir, "pages", pageId);
    const out = path.join(pageDir, "worker-prompt.md");
    const result = await runSkillScript("scripts/build-page-worker-prompt.py", [runDir, "--page", pageId, "--out", out], { runtime, timeoutMs: runtime.timeoutMs });
    const payload = parseJsonOutput(result.stdout) || {};
    await appendRapidOcrHintsToWorkerPrompt(payload.prompt_file || out, runDir, pageId);
    prompts.push({
      pageId,
      promptFile: payload.prompt_file || out,
      pageDir: payload.page_dir || pageDir,
      runDir: payload.run_dir || runDir,
      executionMode: localMode ? "local" : "worker",
      dispatchCommandTemplate: payload.dispatch_command_template || "",
      stdout: result.stdout,
      stderr: result.stderr
    });
  }
  job.artifacts = {
    ...(job.artifacts || {}),
    editableWorkerPrompts: prompts.map((prompt) => artifactRecord("editable_worker_prompt", prompt.promptFile, {
      pageId: prompt.pageId,
      pageDir: prompt.pageDir,
      runDir,
      executionMode: prompt.executionMode,
      dispatchCommandTemplate: prompt.dispatchCommandTemplate
    })),
    editableNext: {
      kind: "editable_next",
      runDir,
      next,
      checkedAt: new Date().toISOString()
    }
  };
  job.events = appendEvent(job.events, "editable.prompts_ready", `Built ${prompts.length} editable page prompt(s)`, { runDir, pages: selectedPages, executionMode: localMode ? "local" : "worker" });
  return saveWorkflowJob(job);
}

export async function listWorkflowEditableWorkerPrompts(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const runtime = getEditableRuntimeConfig(options);
  const runDir = getPreparedRunDir(job);
  const status = await getEditableStatusForRun(runDir, runtime).catch((error) => ({ error: error.message || "status failed" }));
  const next = await getEditableNextForRun(runDir, runtime).catch((error) => ({ error: error.message || "next failed" }));
  const artifactPrompts = Array.isArray(job.artifacts?.editableWorkerPrompts) ? job.artifacts.editableWorkerPrompts : [];
  const promptRecords = artifactPrompts.length ? artifactPrompts : await discoverPromptFiles(runDir);
  const prompts = [];
  const maxContentLength = clampInteger(options.maxContentLength || 60000, 1000, 200000, 60000);
  for (const prompt of promptRecords) {
    const promptFile = path.resolve(prompt.path || prompt.promptFile || "");
    if (!promptFile || !promptFile.startsWith(path.resolve(runDir))) continue;
    const content = await fs.readFile(promptFile, "utf8").catch(() => "");
    const pageId = normalizePageId(prompt.pageId || path.basename(path.dirname(promptFile)));
    prompts.push({
      pageId,
      promptFile,
      pageDir: prompt.pageDir || path.dirname(promptFile),
      relativePath: path.relative(process.cwd(), promptFile),
      executionMode: prompt.executionMode || (next.stage === "rebuild_page_locally" ? "local" : "worker"),
      size: Buffer.byteLength(content, "utf8"),
      content: content.slice(0, maxContentLength),
      truncated: content.length > maxContentLength,
      dispatchCommandTemplate: prompt.dispatchCommandTemplate || ""
    });
  }
  prompts.sort((a, b) => a.pageId.localeCompare(b.pageId));
  return {
    ok: true,
    jobId,
    runDir,
    runtime: publicRuntime(runtime),
    status,
    next,
    prompts
  };
}

export async function dispatchWorkflowEditablePage(jobId, options = {}) {
  let job = await readWorkflowJob(jobId);
  const runtime = getEditableRuntimeConfig(options);
  const runDir = getPreparedRunDir(job);
  const pageId = normalizePageId(options.pageId || options.page || "");
  const localMode = Boolean(options.local || options.localMode || options.localRebuild);
  const agentId = cleanString(options.agentId || (localMode ? "main" : ""));
  if (!pageId) throw new Error("pageId is required");
  if (!agentId) throw new Error("agentId is required");
  if (!localMode && options.spawned !== true && options.confirmSpawned !== true) {
    throw new Error("Refusing to dispatch without spawned=true. editppt dispatch must only record a real page worker.");
  }
  job = await ensureTextHintsCheckpoint(job, runtime, options);
  const promptFile = path.resolve(options.promptFile || path.join(runDir, "pages", pageId, "worker-prompt.md"));
  if (!fsSync.existsSync(promptFile)) throw new Error(`Worker prompt not found: ${promptFile}`);
  const args = ["run", "dispatch", runDir, "--page", pageId, "--agent-id", agentId, "--prompt-file", promptFile];
  if (options.agentNickname) args.push("--agent-nickname", cleanString(options.agentNickname));
  if (localMode) args.push("--local");
  const dispatch = await runEditppt(args, { runtime, timeoutMs: runtime.timeoutMs });
  const status = await getEditableStatusForRun(runDir, runtime);
  const next = await getEditableNextForRun(runDir, runtime);
  job.currentStage = "pages_running";
  job.status = "pages_running";
  job.stageStatus = "running";
  job.stages.pages_running = markStage(job.stages.pages_running, "running", localMode ? `Claimed ${pageId} for local rebuild` : `Dispatched ${pageId} to worker`, { pageId, agentId, promptFile, status, next, executionMode: localMode ? "local" : "worker" });
  job.artifacts = {
    ...(job.artifacts || {}),
    editableDispatches: [...(Array.isArray(job.artifacts?.editableDispatches) ? job.artifacts.editableDispatches : []), {
      kind: "editable_dispatch",
      pageId,
      agentId,
      executionMode: localMode ? "local" : "worker",
      promptFile,
      runDir,
      stdout: dispatch.stdout,
      stderr: dispatch.stderr,
      createdAt: new Date().toISOString()
    }].slice(-200),
    editableNext: { kind: "editable_next", runDir, next, checkedAt: new Date().toISOString() }
  };
  job.events = appendEvent(job.events, "editable.dispatched", localMode ? `Claimed ${pageId} for local rebuild` : `Dispatched ${pageId} to worker`, { pageId, agentId, promptFile, nextStage: next.stage, executionMode: localMode ? "local" : "worker" });
  return saveWorkflowJob(job);
}

async function ensureTextHintsCheckpoint(job, runtime, options = {}) {
  if (job.artifacts?.editableTextHintsAcknowledgement?.accepted) return job;
  const rapidOcrHints = getRapidOcrTextHintsCheckpoint(job);
  const result = await testEditableRuntime({
    skillRoot: runtime.skillRoot,
    pythonPath: runtime.pythonPath,
    timeoutMs: runtime.timeoutMs
  });
  const textHints = result.doctor?.text_hints || {};
  const needsOfflineAcknowledgement = textHints.selection === "builtin-ink" || textHints.paddle_token === "unset";
  if (!needsOfflineAcknowledgement) return job;
  const acceptedByRapidOcr = Boolean(rapidOcrHints?.path);
  if (!acceptedByRapidOcr && !options.acceptOfflineTextHints && !options.confirmOfflineTextHints && !options.paddleOcrDeclined) {
    throw new Error("PaddleOCR token is not configured. Before dispatching page reconstruction, confirm whether to continue with offline builtin-ink text hints or configure a free PaddleOCR token from https://aistudio.baidu.com/account/accessToken and rerun editppt run hints.");
  }
  const acknowledgement = {
    kind: "editable_text_hints_acknowledgement",
    accepted: true,
    textHintsBackend: acceptedByRapidOcr ? "rapidocr-local" : textHints.selection || "builtin-ink",
    paddleToken: textHints.paddle_token || "unset",
    applyUrl: textHints.apply_url || "https://aistudio.baidu.com/account/accessToken",
    reason: cleanString(options.offlineTextHintsReason || (acceptedByRapidOcr ? "RapidOCR local text hints are available for this workflow" : "user accepted offline text hints for this workflow")),
    rapidOcrHintsPath: rapidOcrHints?.path || "",
    acceptedAt: new Date().toISOString()
  };
  job.artifacts = {
    ...(job.artifacts || {}),
    editableTextHintsAcknowledgement: acknowledgement
  };
  job.events = appendEvent(job.events, "editable.text_hints_acknowledged", "Offline editppt text hints accepted for this workflow", acknowledgement);
  return saveWorkflowJob(job);
}

function getRapidOcrTextHintsCheckpoint(job = {}) {
  const artifacts = job.artifacts || {};
  const candidates = [
    artifacts.ocrTextHints?.path,
    artifacts.editableRun?.rapidOcrHintsPath
  ].filter(Boolean);
  const hintPath = candidates.find((candidate) => fsSync.existsSync(candidate));
  if (!hintPath) return null;
  return {
    path: hintPath,
    backend: "rapidocr-local"
  };
}

export async function recordWorkflowEditablePage(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const runtime = getEditableRuntimeConfig(options);
  const runDir = getPreparedRunDir(job);
  const pageId = normalizePageId(options.pageId || options.page || "");
  const agentId = cleanString(options.agentId || "");
  if (!pageId) throw new Error("pageId is required");
  if (!agentId) throw new Error("agentId is required");
  const args = ["run", "record", runDir, "--page", pageId, "--agent-id", agentId];
  if (options.pageResult) args.push("--page-result", cleanString(options.pageResult));
  const record = await runEditppt(args, { runtime, timeoutMs: runtime.timeoutMs });
  const recordPayload = parseJsonOutput(record.stdout) || {};
  const status = await getEditableStatusForRun(runDir, runtime);
  const next = await getEditableNextForRun(runDir, runtime);
  const allRecorded = next.stage === "finalize";
  job.currentStage = allRecorded ? "finalizing" : "pages_running";
  job.status = allRecorded ? "finalizing" : "pages_running";
  job.stageStatus = allRecorded ? "pending" : "running";
  job.stages.pages_running = markStage(job.stages.pages_running, allRecorded ? "complete" : "running", allRecorded ? "All editable pages recorded" : `Recorded ${pageId}`, { pageId, agentId, status, next });
  if (allRecorded) {
    job.stages.finalizing = markStage(job.stages.finalizing, "pending", "Editable pages recorded; final assembly pending", { runDir });
  }
  job.artifacts = {
    ...(job.artifacts || {}),
    editableRecords: [...(Array.isArray(job.artifacts?.editableRecords) ? job.artifacts.editableRecords : []), {
      kind: "editable_record",
      pageId,
      agentId,
      runDir,
      record: recordPayload,
      stdout: record.stdout,
      stderr: record.stderr,
      createdAt: new Date().toISOString()
    }].slice(-200),
    editableNext: { kind: "editable_next", runDir, next, checkedAt: new Date().toISOString() }
  };
  job.events = appendEvent(job.events, "editable.recorded", `Recorded ${pageId}`, { pageId, agentId, nextStage: next.stage });
  return saveWorkflowJob(job);
}

export async function rebuildWorkflowEditableLocalPage(jobId, options = {}) {
  if (options.allowTextDominantLocal !== true && options.regression !== true) {
    throw new Error("Single-page local rebuild currently requires allowTextDominantLocal=true. The available local runner is text-dominant and must not be treated as full visual asset separation.");
  }
  let job = await readWorkflowJob(jobId);
  const runtime = getEditableRuntimeConfig(options);
  const runDir = getPreparedRunDir(job);
  const next = await getEditableNextForRun(runDir, runtime);
  if (next.stage !== "rebuild_page_locally") {
    throw new Error(`Editable run is not ready for single-page local rebuild. Current next stage: ${next.stage || "unknown"}`);
  }
  const selectedPages = normalizePages(options.pages || options.pageIds || options.pageId || next.suggested_pages || next.dispatchable_pages || []);
  if (selectedPages.length !== 1) throw new Error("Single-page local rebuild requires exactly one page.");
  const pageId = selectedPages[0];
  const pageDir = path.join(runDir, "pages", pageId);
  const promptFile = path.join(pageDir, "worker-prompt.md");
  if (options.forcePrompt || !fsSync.existsSync(promptFile)) {
    await runSkillScript("scripts/build-page-worker-prompt.py", [runDir, "--page", pageId, "--out", promptFile], { runtime, timeoutMs: runtime.timeoutMs });
  }

  job = await dispatchWorkflowEditablePage(jobId, {
    ...options,
    pageId,
    agentId: cleanString(options.agentId || "main"),
    promptFile,
    local: true
  });

  const startedAt = new Date().toISOString();
  const scriptPath = path.join(process.cwd(), "scripts", "local-page-worker.mjs");
  const local = await execFileAsync(process.execPath, [scriptPath, "--run-dir", runDir, "--page-dir", pageDir, "--page", pageId], {
    cwd: process.cwd(),
    timeout: runtime.timeoutMs,
    windowsHide: true,
    encoding: "utf8",
    env: {
      ...process.env,
      EDITPPT_SKILL_ROOT: runtime.skillRoot,
      EDITPPT_PYTHON_PATH: runtime.pythonPath,
      PYTHONIOENCODING: "utf-8"
    }
  });

  job = await recordWorkflowEditablePage(jobId, {
    ...options,
    pageId,
    agentId: cleanString(options.agentId || "main")
  });
  job.artifacts = {
    ...(job.artifacts || {}),
    editableLocalRebuilds: [...(Array.isArray(job.artifacts?.editableLocalRebuilds) ? job.artifacts.editableLocalRebuilds : []), {
      kind: "editable_local_rebuild",
      pageId,
      agentId: cleanString(options.agentId || "main"),
      runDir,
      pageDir,
      promptFile,
      stdout: local.stdout,
      stderr: local.stderr,
      startedAt,
      finishedAt: new Date().toISOString()
    }].slice(-100)
  };
  job.events = appendEvent(job.events, "editable.local_rebuild_recorded", `Local page rebuild recorded ${pageId}`, { pageId, agentId: cleanString(options.agentId || "main") });
  return saveWorkflowJob(job);
}

export async function resetWorkflowEditablePage(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const runtime = getEditableRuntimeConfig(options);
  const runDir = getPreparedRunDir(job);
  const pageId = normalizePageId(options.pageId || options.page || "");
  if (!pageId) throw new Error("pageId is required");
  const args = ["run", "reset", runDir, "--page", pageId];
  const agentId = cleanString(options.agentId || "");
  if (agentId) args.push("--agent-id", agentId);
  if (options.confirmLost || options.confirm_lost) args.push("--confirm-lost");
  const reset = await runEditppt(args, { runtime, timeoutMs: runtime.timeoutMs });
  const status = await getEditableStatusForRun(runDir, runtime);
  const next = await getEditableNextForRun(runDir, runtime);
  job.currentStage = "pages_running";
  job.status = "pages_running";
  job.stageStatus = "running";
  job.stages.pages_running = markStage(job.stages.pages_running, "running", `Reset ${pageId} for editable retry`, { pageId, status, next });
  job.artifacts = {
    ...(job.artifacts || {}),
    editableDispatches: (Array.isArray(job.artifacts?.editableDispatches) ? job.artifacts.editableDispatches : []).filter((item) => normalizePageId(item.pageId) !== pageId),
    editableRecords: (Array.isArray(job.artifacts?.editableRecords) ? job.artifacts.editableRecords : []).filter((item) => normalizePageId(item.pageId) !== pageId),
    editableResets: [...(Array.isArray(job.artifacts?.editableResets) ? job.artifacts.editableResets : []), {
      kind: "editable_reset",
      pageId,
      runDir,
      stdout: reset.stdout,
      stderr: reset.stderr,
      createdAt: new Date().toISOString()
    }].slice(-200),
    editableNext: { kind: "editable_next", runDir, next, checkedAt: new Date().toISOString() }
  };
  job.events = appendEvent(job.events, "editable.reset", `Reset ${pageId} for retry`, { pageId, nextStage: next.stage });
  return saveWorkflowJob(job);
}

export async function finalizeWorkflowEditableRun(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const runtime = getEditableRuntimeConfig(options);
  const runDir = getPreparedRunDir(job);
  const finalize = await runEditppt(["run", "finalize", runDir], { runtime, timeoutMs: runtime.timeoutMs });
  const summary = parseJsonOutput(finalize.stdout) || await readJson(path.join(runDir, "final", "run_summary.json")).catch(() => null);
  const outputPath = summary?.output || path.join(runDir, "final", "deck_edited.pptx");
  if (!fsSync.existsSync(outputPath)) throw new Error(`Final editable PPTX not found: ${outputPath}`);
  await fs.mkdir(job.dirs.final, { recursive: true });
  const finalPath = path.join(job.dirs.final, "editable-final.pptx");
  await fs.copyFile(outputPath, finalPath);
  const validationSource = summary?.validation || path.join(runDir, "final", "validation.json");
  let validationRecord = null;
  if (fsSync.existsSync(validationSource)) {
    const targetValidation = path.join(job.dirs.final, "editable-validation.json");
    await fs.copyFile(validationSource, targetValidation);
    validationRecord = artifactRecord("editable_validation", targetValidation);
  }
  const editability = await inspectEditablePptx(finalPath).catch((error) => ({
    version: 1,
    source: "pptx-openxml-inspection",
    status: "warn",
    editable: false,
    warnings: ["pptx-editability-inspection-failed"],
    error: error.message || "inspection failed"
  }));
  const finalRecord = artifactRecord("editable_final_pptx", finalPath, {
    runDir,
    sourceOutputPath: outputPath,
    summary,
    validation: validationRecord,
    pptxEditability: editability
  });
  job.artifacts = {
    ...(job.artifacts || {}),
    editableFinal: finalRecord
  };
  job.currentStage = "complete";
  job.status = "complete";
  job.stageStatus = "complete";
  job.stages.finalizing = markStage(job.stages.finalizing, "complete", "Final editable PPTX assembled", { finalPath, runDir });
  job.stages.complete = markStage(job.stages.complete, "complete", "Workflow complete", { finalPath, editability });
  job.events = appendEvent(job.events, "editable.finalized", "Final editable PPTX assembled", { finalPath, runDir, editable: editability.editable });
  return saveWorkflowJob(job);
}

function getEditableRuntimeConfig(overrides = {}) {
  const env = globalThis.process?.env || {};
  const skillRoot = path.resolve(overrides.skillRoot || env.EDITPPT_SKILL_ROOT || DEFAULT_SKILL_ROOT);
  const pythonPath = normalizeExecutable(overrides.pythonPath || env.EDITPPT_PYTHON_PATH || defaultPythonPath());
  const cliPath = path.join(skillRoot, "cli");
  return {
    skillRoot,
    cliPath,
    pythonPath,
    timeoutMs: clampInteger(overrides.timeoutMs || env.EDITPPT_TIMEOUT_MS, 30000, 900000, DEFAULT_TIMEOUT_MS)
  };
}

async function inspectEditableSkillContract(runtime = {}) {
  const skillRoot = path.resolve(runtime.skillRoot || DEFAULT_SKILL_ROOT);
  const skillPath = path.join(skillRoot, "SKILL.md");
  const source = await fs.readFile(skillPath, "utf8");
  const singlePageLocalMode = /single-page[\s\S]{0,220}local|rebuild_page_locally|--local/i.test(source);
  const multiPageWorkerDispatch = /multi-page[\s\S]{0,220}(page workers|worker dispatch|dispatch)|dispatch_pages/i.test(source);
  const serialImageEdit = /serial[\s\S]{0,120}editppt image generate\/edit|editppt image generate\/edit/i.test(source);
  const noFullSlideFallback = /full-slide[\s\S]{0,180}(not acceptable|not an acceptable fallback)|source\.png[\s\S]{0,160}not acceptable/i.test(source);
  const agentsSkillRoot = /[\\\/]\.agents[\\\/]skills[\\\/]image-to-editable-ppt/i.test(skillRoot);
  const ok = Boolean(singlePageLocalMode && multiPageWorkerDispatch && serialImageEdit && noFullSlideFallback);
  return {
    ok,
    mode: ok ? "v0.3-compatible" : "legacy-or-unknown",
    skillRoot,
    skillPath,
    agentsSkillRoot,
    singlePageLocalMode,
    multiPageWorkerDispatch,
    serialImageEdit,
    noFullSlideFallback,
    checkedAt: new Date().toISOString()
  };
}

function firstExistingPath(candidates = []) {
  for (const candidate of candidates) {
    if (candidate && fsSync.existsSync(candidate)) return candidate;
  }
  return candidates.find(Boolean) || "";
}

function defaultPythonPath() {
  return firstExistingPath([
    path.join(USER_HOME, "AppData", "Local", "Programs", "Python", "Python313", "python.exe"),
    path.join(USER_HOME, "AppData", "Local", "Programs", "Python", "Python312", "python.exe"),
    path.join(USER_HOME, "AppData", "Local", "Microsoft", "WindowsApps", "python.exe"),
    "python"
  ]);
}

function normalizeExecutable(value = "") {
  const text = String(value || "").trim();
  if (!text) return defaultPythonPath();
  if (path.isAbsolute(text) || /[\\/]/.test(text)) return path.resolve(text);
  return text;
}

function isExecutableReference(value = "") {
  const text = String(value || "").trim();
  if (!text) return false;
  if (path.isAbsolute(text) || /[\\/]/.test(text)) return fsSync.existsSync(text);
  return true;
}

function assertExecutableAvailable(command = "", label = "executable") {
  const text = String(command || "").trim();
  if (!text) throw new Error(`${label} not configured`);
  if ((path.isAbsolute(text) || /[\\/]/.test(text)) && !fsSync.existsSync(text)) {
    throw new Error(`${label} not found: ${text}`);
  }
}

function getEditableRunLayout(job, options = {}) {
  const env = globalThis.process?.env || {};
  const base = path.resolve(options.runRoot || env.EDITPPT_RUN_ROOT || DEFAULT_EDITABLE_RUN_ROOT);
  const runRoot = path.join(base, job.id);
  return {
    base,
    runRoot,
    inputDir: path.join(runRoot, "input-images"),
    runDir: path.join(runRoot, "run")
  };
}

async function runEditppt(args, { runtime = getEditableRuntimeConfig(), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  assertExecutableAvailable(runtime.pythonPath, "editppt Python");
  if (!fsSync.existsSync(runtime.cliPath)) throw new Error(`editppt skill CLI not found: ${runtime.cliPath}`);
  const { stdout, stderr } = await execFileAsync(runtime.pythonPath, ["-m", "editppt.cli", ...args], {
    cwd: process.cwd(),
    timeout: timeoutMs,
    windowsHide: true,
    encoding: "utf8",
    env: {
      ...process.env,
      PYTHONPATH: [runtime.cliPath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      PYTHONIOENCODING: "utf-8"
    }
  });
  return { ok: true, stdout, stderr, args };
}

async function runSkillScript(relativeScript, args, { runtime = getEditableRuntimeConfig(), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const scriptPath = path.join(runtime.skillRoot, relativeScript);
  if (!fsSync.existsSync(scriptPath)) throw new Error(`Skill script not found: ${scriptPath}`);
  assertExecutableAvailable(runtime.pythonPath, "editppt Python");
  const { stdout, stderr } = await execFileAsync(runtime.pythonPath, [scriptPath, ...args], {
    cwd: process.cwd(),
    timeout: timeoutMs,
    windowsHide: true,
    encoding: "utf8",
    env: {
      ...process.env,
      PYTHONPATH: [runtime.cliPath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      PYTHONIOENCODING: "utf-8"
    }
  });
  return { ok: true, stdout, stderr, args };
}

async function getEditableStatusForRun(runDir, runtime) {
  const result = await runEditppt(["run", "status", runDir, "--json"], { runtime, timeoutMs: runtime.timeoutMs });
  return parseJsonOutput(result.stdout) || { raw: result.stdout };
}

async function getEditableNextForRun(runDir, runtime) {
  const result = await runEditppt(["run", "next", runDir, "--json"], { runtime, timeoutMs: runtime.timeoutMs });
  return parseJsonOutput(result.stdout) || { raw: result.stdout };
}

function getEditablePrepareInputs(job) {
  const visualImages = Array.isArray(job.artifacts?.visualImages) ? job.artifacts.visualImages : [];
  return visualImages
    .filter((item) => item?.path && fsSync.existsSync(item.path))
    .map((item, index) => ({
      pageId: item.pageId || `page_${String(index + 1).padStart(3, "0")}`,
      pageNumber: Number(item.pageNumber || index + 1),
      path: item.path
    }))
    .sort((a, b) => a.pageNumber - b.pageNumber);
}

async function linkRapidOcrHints(job, runDir) {
  const hintsPath = job.artifacts?.ocrTextHints?.path;
  if (!hintsPath || !fsSync.existsSync(hintsPath)) return null;
  const target = path.join(runDir, "workflow_rapidocr_text_hints.json");
  await fs.copyFile(hintsPath, target);
  return artifactRecord("rapidocr_text_hints", target);
}

async function appendRapidOcrHintsToWorkerPrompt(promptFile, runDir, pageId) {
  const hintsPath = path.join(runDir, "workflow_rapidocr_text_hints.json");
  if (!promptFile || !fsSync.existsSync(promptFile) || !fsSync.existsSync(hintsPath)) return null;
  const hints = await readJson(hintsPath).catch(() => null);
  const page = (Array.isArray(hints?.pages) ? hints.pages : []).find((item) => normalizePageId(item.pageId) === normalizePageId(pageId));
  if (!page) return null;
  const required = Array.isArray(page.requiredText) ? page.requiredText.map(cleanString).filter(Boolean) : [];
  const lines = Array.isArray(page.ocrLines) ? page.ocrLines : [];
  const lineSamples = lines
    .map((line) => cleanString(line?.text || ""))
    .filter(Boolean)
    .slice(0, 80);
  const body = [
    "",
    "## Local RapidOCR Text Evidence",
    `RapidOCR hints JSON: ${hintsPath}`,
    `OCR backend: ${hints?.ocrBackend?.name || hints?.backend || "rapidocr-local"}`,
    required.length ? "Required readable text candidates:" : "",
    ...required.slice(0, 80).map((text) => `- ${text}`),
    !required.length && lineSamples.length ? "OCR text candidates:" : "",
    ...(!required.length ? lineSamples.map((text) => `- ${text}`) : []),
    "Use these local OCR candidates as evidence for editable text reconstruction. Preserve short visible titles and labels when they match the source page."
  ].filter(Boolean).join("\n");
  const current = await fs.readFile(promptFile, "utf8").catch(() => "");
  if (/## Local RapidOCR Text Evidence/.test(current)) return null;
  await fs.appendFile(promptFile, `${body}\n`, "utf8");
  return { path: hintsPath, lineCount: required.length || lineSamples.length };
}

async function collectTextHintSummary(runDir) {
  const pagesDir = path.join(runDir, "pages");
  const entries = await fs.readdir(pagesDir, { withFileTypes: true }).catch(() => []);
  const pages = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pageId = normalizePageId(entry.name);
    if (!pageId) continue;
    const hintsPath = path.join(pagesDir, entry.name, "text_hints.json");
    const imagePath = path.join(pagesDir, entry.name, "text_hints.png");
    const hints = await readJson(hintsPath).catch(() => null);
    pages.push({
      pageId,
      path: hintsPath,
      imagePath: fsSync.existsSync(imagePath) ? imagePath : "",
      exists: fsSync.existsSync(hintsPath),
      backend: hints?.backend || hints?.text_hints_backend || "",
      lineCount: Array.isArray(hints?.lines) ? hints.lines.length : Array.isArray(hints?.text_lines) ? hints.text_lines.length : 0
    });
  }
  pages.sort((a, b) => a.pageId.localeCompare(b.pageId));
  const backends = uniqueList(pages.map((page) => page.backend).filter(Boolean));
  return {
    pageCount: pages.length,
    readyPages: pages.filter((page) => page.exists).length,
    textLineCount: pages.reduce((sum, page) => sum + page.lineCount, 0),
    backend: backends.join(", "),
    pages
  };
}

function compactDoctorTextHints(result = {}) {
  const textHints = result.doctor?.text_hints || {};
  return {
    ok: Boolean(result.ok),
    selection: textHints.selection || "",
    paddleToken: textHints.paddle_token || "",
    applyUrl: textHints.apply_url || "",
    configureCommand: textHints.configure_command || "",
    error: result.error || ""
  };
}

async function discoverPromptFiles(runDir) {
  const pagesDir = path.join(runDir, "pages");
  const entries = await fs.readdir(pagesDir, { withFileTypes: true }).catch(() => []);
  const prompts = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pageId = normalizePageId(entry.name);
    if (!pageId) continue;
    const promptFile = path.join(pagesDir, entry.name, "worker-prompt.md");
    if (!fsSync.existsSync(promptFile)) continue;
    prompts.push({
      kind: "editable_worker_prompt",
      pageId,
      path: promptFile,
      pageDir: path.dirname(promptFile)
    });
  }
  return prompts;
}

async function copyInputsToAsciiScratch(inputs, inputDir) {
  const copied = [];
  for (const input of inputs) {
    const ext = path.extname(input.path) || ".png";
    const target = path.join(inputDir, `${input.pageId}${safeExtension(ext)}`);
    await fs.copyFile(input.path, target);
    copied.push({ ...input, sourcePath: input.path, path: target });
  }
  return copied;
}

async function writeEditableRunPointer(job, details = {}) {
  await fs.mkdir(job.dirs.editableRun, { recursive: true });
  const pointerPath = path.join(job.dirs.editableRun, "editable_run_pointer.json");
  const pointer = {
    version: 1,
    jobId: job.id,
    kind: "editable_run_pointer",
    note: "The live editppt run uses an ASCII scratch path to avoid Windows non-ASCII path issues.",
    runRoot: details.layout.runRoot,
    runDir: details.layout.runDir,
    inputDir: details.layout.inputDir,
    workspaceDir: job.dirs.editableRun,
    runtime: publicRuntime(details.runtime),
    sourceInputs: details.inputs.map((input) => ({ pageId: input.pageId, pageNumber: input.pageNumber, path: input.path })),
    preparedInputs: details.preparedInputs.map((input) => ({ pageId: input.pageId, pageNumber: input.pageNumber, path: input.path, sourcePath: input.sourcePath })),
    rapidOcrHintsPath: details.rapidOcrHints?.path || null,
    status: details.status,
    next: details.next,
    createdAt: new Date().toISOString()
  };
  await fs.writeFile(pointerPath, JSON.stringify(pointer, null, 2), "utf8");
  return artifactRecord("editable_run_pointer", pointerPath);
}

function markEditablePrepared(job, { runDir, inputs, runtime, status = null, next = null, rapidOcrHints = null, reused = false } = {}) {
  job.currentStage = "editable_prepared";
  job.status = "editable_prepared";
  job.stageStatus = "complete";
  job.stages.editable_prepared = markStage(job.stages.editable_prepared, "complete", reused ? "Reused prepared editppt run" : `Prepared editppt run with ${inputs.length} page(s)`, {
    runDir,
    inputCount: inputs.length,
    runtime: publicRuntime(runtime),
    status,
    next,
    rapidOcrHintsPath: rapidOcrHints?.path || null
  });
  job.events = appendEvent(job.events, "editable.prepared", reused ? "Reused prepared editppt run" : `Prepared editppt run with ${inputs.length} page(s)`, {
    runDir,
    inputCount: inputs.length,
    nextStage: next?.stage || null
  });
  return job;
}

async function clearGeneratedEditableRun(layout, job) {
  const resolvedRunRoot = path.resolve(layout.runRoot);
  const resolvedBase = path.resolve(layout.base);
  if (path.basename(resolvedRunRoot) !== job.id || !resolvedRunRoot.startsWith(resolvedBase + path.sep)) {
    throw new Error("Refusing to clear editable run outside the configured run root");
  }
  await fs.rm(resolvedRunRoot, { recursive: true, force: true });
  await fs.mkdir(layout.runDir, { recursive: true });
}

function getPreparedRunDir(job) {
  const runDir = job.artifacts?.editableRun?.path || job.dirs?.editableRun;
  if (!runDir || !fsSync.existsSync(path.join(runDir, "deck_manifest.json"))) {
    throw new Error("Editable run is not prepared. Run editable/prepare first.");
  }
  return runDir;
}

function markStage(stage = {}, status, message, details = {}) {
  const now = new Date().toISOString();
  return {
    ...stage,
    status,
    message,
    details,
    updatedAt: now,
    startedAt: stage.startedAt || now,
    ...(status === "complete" || status === "failed" ? { finishedAt: now } : {})
  };
}

function appendEvent(events = [], type, message, details = {}) {
  return [...(Array.isArray(events) ? events : []), {
    id: `evt_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    type,
    message,
    details,
    createdAt: new Date().toISOString()
  }].slice(-500);
}

function artifactRecord(kind, filePath, extra = {}) {
  const stat = fsSync.existsSync(filePath) ? fsSync.statSync(filePath) : null;
  return {
    kind,
    path: filePath,
    relativePath: path.relative(process.cwd(), filePath),
    size: stat?.size || 0,
    createdAt: new Date().toISOString(),
    ...extra
  };
}

function assertVisualQualityGate(job = {}, options = {}) {
  const artifacts = job.artifacts || {};
  const visualQuality = artifacts.visualQuality || {};
  const summary = normalizeVisualQualitySummary(visualQuality);
  if (!visualQuality.path) {
    if (isNonProductEditableGateBypassAllowed(options)) return;
    throw new Error("Visual quality report is required before editable prepare.");
  }
  if (summary.failedCount > 0) {
    throw new Error(`Visual quality report has ${summary.failedCount} failed page(s). Retry or repair visual pages before editable prepare.`);
  }
  if (summary.reviewCount > 0 && !isVisualQualityReviewCurrent(artifacts)) {
    throw new Error(`Visual quality report requires manual review for ${summary.reviewCount} page(s). Approve visual quality review before editable prepare.`);
  }
}

function isNonProductEditableGateBypassAllowed(options = {}) {
  const marker = `${options.requestedBy || ""} ${options.note || ""} ${options.mode || ""}`;
  return Boolean(options.allowMissingVisualQualityForTest || options.allowNonProductVisual || options.allowNonProductBackend) || /regression|smoke|test/i.test(marker);
}

function isVisualQualityReviewCurrent(artifacts = {}) {
  const visualQuality = artifacts.visualQuality || {};
  const review = artifacts.visualQualityReview || {};
  if (review.status !== "approved" || !visualQuality.path) return false;
  if (review.visualQualityPath && review.visualQualityPath !== visualQuality.path) return false;
  if (review.visualQualitySize && visualQuality.size && Number(review.visualQualitySize) !== Number(visualQuality.size)) return false;
  if (review.visualQualityCreatedAt && visualQuality.createdAt && review.visualQualityCreatedAt !== visualQuality.createdAt) return false;
  return true;
}

function hasRapidOcrTextHints(job = {}) {
  const hintsPath = job.artifacts?.ocrTextHints?.path || "";
  return Boolean(hintsPath && fsSync.existsSync(hintsPath));
}

function normalizeVisualQualitySummary(visualQuality = {}) {
  const summary = visualQuality.summary || {};
  return {
    pageCount: Number(summary.pageCount ?? visualQuality.pageCount ?? 0) || 0,
    passCount: Number(summary.passCount ?? visualQuality.passCount ?? 0) || 0,
    reviewCount: Number(summary.reviewCount ?? visualQuality.reviewCount ?? 0) || 0,
    failedCount: Number(summary.failedCount ?? visualQuality.failedCount ?? 0) || 0
  };
}

function getEditableTextHintEvidence(artifacts = {}) {
  const ocr = artifacts.ocrTextHints || {};
  const editable = artifacts.editableHints || {};
  const editableSummary = editable.summary || editable.textHints || {};
  const ocrReady = Boolean(ocr.path && (ocr.pageCount || ocr.textCount || fsSync.existsSync(ocr.path)));
  const editableReadyPages = Number(editableSummary.readyPages || 0) || 0;
  const editablePageCount = Number(editableSummary.pageCount || 0) || 0;
  const editableReady = Boolean(editable.path && editableReadyPages > 0);
  if (ocrReady) {
    return {
      ready: true,
      partial: false,
      source: "ocrTextHints",
      pageCount: Number(ocr.pageCount || 0) || 0,
      textLineCount: Number(ocr.textCount || 0) || 0,
      detail: `OCR ${ocr.pageCount || 0} page(s), ${ocr.textCount || 0} text line(s)`,
      warning: ""
    };
  }
  if (editableReady) {
    return {
      ready: true,
      partial: editableReadyPages < editablePageCount,
      source: "editableHints",
      pageCount: editablePageCount,
      readyPages: editableReadyPages,
      textLineCount: Number(editableSummary.textLineCount || 0) || 0,
      backend: editableSummary.backend || "",
      detail: `editppt ${editableReadyPages}/${editablePageCount || editableReadyPages} page(s), ${editableSummary.textLineCount || 0} text line(s)`,
      warning: "editppt text hints are partial; review pages before dispatch."
    };
  }
  return {
    ready: false,
    partial: false,
    source: "",
    pageCount: 0,
    textLineCount: 0,
    detail: "尚未生成 OCR/editppt 文字提示",
    warning: "OCR/editppt text hints are not ready."
  };
}

function publicRuntime(runtime) {
  return {
    skillRoot: runtime.skillRoot,
    cliPath: runtime.cliPath,
    pythonPath: runtime.pythonPath,
    timeoutMs: runtime.timeoutMs
  };
}

function parseJsonOutput(stdout = "") {
  const text = String(stdout || "").trim();
  if (!text) return null;
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first < 0 || last < first) return null;
  try {
    return JSON.parse(text.slice(first, last + 1));
  } catch {
    return null;
  }
}

function normalizePages(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[,\s]+/);
  return raw.map((item) => normalizePageId(item)).filter(Boolean);
}

function normalizePageId(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d+$/.test(raw)) return `page_${String(Number(raw)).padStart(3, "0")}`;
  return /^page_\d{3}$/i.test(raw) ? raw.toLowerCase() : "";
}

function cleanString(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 1000);
}

function uniqueList(values = []) {
  return [...new Set(values.map((value) => cleanString(value)).filter(Boolean))];
}

function summarizeCommand(result) {
  return {
    ok: Boolean(result?.ok),
    stdout: String(result?.stdout || "").slice(-4000),
    stderr: String(result?.stderr || "").slice(-4000)
  };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function safeExtension(ext) {
  const cleaned = String(ext || "").toLowerCase().replace(/[^.a-z0-9]/g, "");
  return cleaned && cleaned.startsWith(".") ? cleaned : ".png";
}
