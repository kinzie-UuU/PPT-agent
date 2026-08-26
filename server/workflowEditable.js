import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import JSZip from "jszip";
import { execFile } from "child_process";
import { promisify } from "util";
import { readWorkflowJob, saveWorkflowJob } from "./workflowJobs.js";
import { inspectEditablePptx, inspectPowerPointOpenability, inspectPowerPointTextLayout } from "./pptxEditability.js";
import { runWorkflowOcr } from "./workflowOcr.js";
import { comparePngVisualFidelity, EDITABLE_VISUAL_SIMILARITY_MINIMUM, evaluateEditableVisualFidelity } from "./workflowFinalEvidence.js";
import { isWorkflowImageDeckReviewReady } from "../shared/workflowDeliveryStatus.js";
import { getExpectedWorkflowPageCount as getExpectedImageDeckPageCount } from "./workflowImageDeckReview.js";

const execFileAsync = promisify(execFile);

const USER_HOME = process.env.USERPROFILE || "C:\\Users\\Administrator";
const DEFAULT_SKILL_ROOT = firstExistingPath([
  path.join(USER_HOME, ".agents", "skills", "image-to-editable-ppt"),
  path.join(USER_HOME, ".codex", "skills", "image-to-editable-ppt")
]);
const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_EDITABLE_RUN_ROOT = path.join(os.tmpdir(), "ppt-tool-editable-runs");
const REPAIR_HASH_KEYS = [
  "page_manifest",
  "imagegen_jobs",
  "page_pptx",
  "preview",
  "contact_sheet",
  "validation",
  "page_result"
];
const RECOVERABLE_EDITABLE_PAGE_OUTPUTS = Object.freeze({
  page_manifest: "manifest.json",
  imagegen_jobs: "imagegen-jobs.json",
  page_pptx: "page.pptx",
  preview: "preview.png",
  contact_sheet: "split_assets_contact.png",
  validation: "validation.json",
  page_result: "page_result.json"
});

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
  const inputs = getEditablePrepareInputs(job, options);
  const visualQuality = artifacts.visualQuality || {};
  const qualitySummary = normalizeVisualQualitySummary(visualQuality);
  const visualReviewCurrent = isVisualQualityReviewCurrent(artifacts);
  const imageDeckReviewReady = isWorkflowJobImageDeckReviewApproved(job);
  const textHintEvidence = getEditableTextHintEvidence(artifacts, inputs.map((input) => input.pageId));
  const imageDeckPath = artifacts.imageDeck?.path || "";
  const checks = [
    {
      id: "image-deck",
      label: "图片型 PPT",
      ok: Boolean(imageDeckPath && fsSync.existsSync(imageDeckPath)),
      detail: imageDeckPath || "等待 codex-ppt 生成图片型 PPT"
    },
    {
      id: "image-deck-review",
      label: "图片版人工复核",
      ok: imageDeckReviewReady,
      detail: describeImageDeckReviewGate(artifacts, imageDeckReviewReady)
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
      ok: Boolean(visualQuality.path) && (qualitySummary.failedCount === 0 || imageDeckReviewReady) && (qualitySummary.reviewCount === 0 || visualReviewCurrent || imageDeckReviewReady),
      warning: Boolean(imageDeckReviewReady && (qualitySummary.failedCount > 0 || qualitySummary.reviewCount > 0)),
      detail: visualQuality.path
        ? imageDeckReviewReady && (qualitySummary.failedCount > 0 || qualitySummary.reviewCount > 0)
          ? `人工已复核并接受自动检查提示：风险 ${qualitySummary.failedCount || 0} 页，提醒 ${qualitySummary.reviewCount || 0} 页`
          : `review ${qualitySummary.reviewCount || 0}, failed ${qualitySummary.failedCount || 0}, approved ${visualReviewCurrent ? "yes" : "no"}`
        : "尚未生成视觉质量报告"
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
    safeToRunAutomatically: false,
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

export function describeImageDeckReviewGate(artifacts = {}, ready = false) {
  if (ready) return "整套图片版已按当前证据完成人工复核";
  const review = artifacts.imageDeckReview || {};
  const summary = review.summary || {};
  const total = Number(summary.totalPages || 0);
  const marked = Number(summary.markedCount || 0);
  const semanticRisks = Number(summary.semanticBlockedCount || 0);
  const styleRisks = Number(summary.styleDriftCount || 0);
  if (total && marked === 0 && Object.keys(review.marks || {}).length) {
    return `质量证据已更新，原通过记录需要重新确认；${semanticRisks} 页有内容保真提示，${styleRisks} 页有风格提示`;
  }
  if (total) {
    return `已按当前证据确认 ${marked}/${total} 页；内容保真提示 ${semanticRisks} 页，风格提示 ${styleRisks} 页`;
  }
  return "必须先完成整套图片版人工复核";
}

export async function prepareWorkflowEditableRun(jobId, options = {}) {
  let job = await readWorkflowJob(jobId);
  const runtime = getEditableRuntimeConfig(options);
  assertImageDeckReviewGate(job, options);
  assertVisualQualityGate(job, options);
  let inputs = getEditablePrepareInputs(job, options);
  if (!inputs.length) throw new Error("No visual images available for editable prepare. Run visual/generate first.");
  if (!hasRapidOcrTextHints(job) && options.skipRapidOcr !== true && options.noTextHints !== true) {
    await runWorkflowOcr(jobId, {
      source: "visual",
      maxPages: inputs.length,
      requestedBy: "editable-prepare",
      preserveWorkflowStage: true,
      note: "auto-run local RapidOCR before image-to-editable-ppt prepare"
    });
    job = await readWorkflowJob(jobId);
    inputs = getEditablePrepareInputs(job, options);
  }
  await fs.mkdir(job.dirs.editableRun, { recursive: true });
  const layout = getEditableRunLayout(job, options);
  const runDir = layout.runDir;
  const deckManifestPath = path.join(runDir, "deck_manifest.json");
  const force = Boolean(options.force);
  const staleVisualPageIds = normalizePages(job.artifacts?.editableRun?.staleVisualPageIds || []);
  if (fsSync.existsSync(deckManifestPath) && !force && staleVisualPageIds.length) {
    const error = new Error(`Editable prepare inputs are stale for ${staleVisualPageIds.join(", ")}. Refresh the editable run before dispatching page workers.`);
    error.status = 409;
    error.code = "EDITABLE_PREPARE_REFRESH_REQUIRED";
    error.pages = staleVisualPageIds;
    throw error;
  }
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
  let refreshArchive = null;
  if (force) {
    refreshArchive = staleVisualPageIds.length
      ? await archiveGeneratedEditableRun(layout, job)
      : null;
    if (!refreshArchive) await clearGeneratedEditableRun(layout, job);
  }
  try {
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
    const preservedPageIds = refreshArchive
      ? await restoreRecordedEditablePages(refreshArchive, layout, staleVisualPageIds)
      : [];
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
        refreshedVisualPageIds: staleVisualPageIds,
        preservedRecordedPageIds: preservedPageIds,
        status,
        next
      })
    };
    const saved = await saveWorkflowJob(markEditablePrepared(job, { runDir, inputs, runtime, status, next, rapidOcrHints }));
    if (refreshArchive) await fs.rm(refreshArchive.archiveRoot, { recursive: true, force: true });
    return saved;
  } catch (error) {
    if (refreshArchive) await rollbackArchivedEditableRun(refreshArchive, layout).catch(() => null);
    throw error;
  }
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
  await syncEditableRunState(job, null, next);
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
  await syncEditableRunState(job, status, next);
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
  const selectedPages = resolveEditablePageSelection(options, next);
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
  const promptArtifacts = prompts.map((prompt) => artifactRecord("editable_worker_prompt", prompt.promptFile, {
    pageId: prompt.pageId,
    pageDir: prompt.pageDir,
    runDir,
    executionMode: prompt.executionMode,
    dispatchCommandTemplate: prompt.dispatchCommandTemplate
  }));
  job.artifacts = {
    ...(job.artifacts || {}),
    editableWorkerPrompts: mergePromptArtifacts(job.artifacts?.editableWorkerPrompts, promptArtifacts),
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
  const promptRecords = mergePromptArtifacts(await discoverPromptFiles(runDir), artifactPrompts);
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

function mergePromptArtifacts(existing = [], additions = []) {
  const byPage = new Map();
  for (const prompt of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(additions) ? additions : [])]) {
    const pageId = normalizePageId(prompt?.pageId || path.basename(path.dirname(prompt?.path || prompt?.promptFile || "")));
    const promptPath = prompt?.path || prompt?.promptFile || "";
    if (!pageId || !promptPath) continue;
    byPage.set(pageId, {
      ...prompt,
      pageId,
      path: promptPath,
      promptFile: promptPath
    });
  }
  return [...byPage.values()].sort((a, b) => a.pageId.localeCompare(b.pageId));
}

export async function dispatchWorkflowEditablePage(jobId, options = {}) {
  let job = await readWorkflowJob(jobId);
  if (!isWorkflowJobImageDeckReviewApproved(job)) {
    const error = new Error("请先完成整套图片内容与视觉复核，再启动可编辑页面重建。");
    error.status = 409;
    error.code = "IMAGE_DECK_REVIEW_REQUIRED";
    throw error;
  }
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
  const beforeNext = await getEditableNextForRun(runDir, runtime);
  assertEditableDispatchAllowed(beforeNext, pageId, { localMode });
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
  await syncEditableRunState(job, status, next);
  job.events = appendEvent(job.events, "editable.dispatched", localMode ? `Claimed ${pageId} for local rebuild` : `Dispatched ${pageId} to worker`, { pageId, agentId, promptFile, nextStage: next.stage, executionMode: localMode ? "local" : "worker" });
  return saveWorkflowJob(job);
}

export function assertEditableDispatchAllowed(next = {}, pageId = "", options = {}) {
  const stage = String(next?.stage || "");
  const expectedStage = options.localMode ? "rebuild_page_locally" : "dispatch_pages";
  if (stage !== expectedStage) {
    const error = new Error(`editppt is not ready to dispatch this page; expected next stage ${expectedStage}, current next stage is ${stage || "unknown"}.`);
    error.code = "EDITABLE_DISPATCH_STAGE_MISMATCH";
    error.next = next;
    throw error;
  }
  const selectedPages = normalizeDispatchPageIds(next);
  if (selectedPages.length && !selectedPages.includes(pageId)) {
    const error = new Error(`Page ${pageId} is not in the current editppt dispatch set.`);
    error.code = "EDITABLE_DISPATCH_PAGE_NOT_SELECTED";
    error.next = next;
    error.selectedPages = selectedPages;
    throw error;
  }
}

function normalizeDispatchPageIds(next = {}) {
  const candidates = [
    next.page,
    next.pageId,
    next.pages,
    next.pageIds,
    next.selectedPages,
    next.selected_pages,
    next.dispatchPages,
    next.dispatch_pages,
    next.tasks,
    next.jobs
  ];
  return [...new Set(candidates.flatMap(extractPageIdsFromNextValue).map(normalizePageId).filter(Boolean))];
}

function extractPageIdsFromNextValue(value) {
  if (!value) return [];
  if (typeof value === "string" || typeof value === "number") return [value];
  if (Array.isArray(value)) return value.flatMap(extractPageIdsFromNextValue);
  if (typeof value === "object") {
    return [
      value.pageId,
      value.page_id,
      value.page,
      value.id,
      value.name
    ].filter(Boolean);
  }
  return [];
}

async function ensureTextHintsCheckpoint(job, runtime, options = {}) {
  if (job.artifacts?.editableTextHintsAcknowledgement?.accepted) return job;
  const localOcrHints = getLocalOcrTextHintsCheckpoint(job);
  const result = await testEditableRuntime({
    skillRoot: runtime.skillRoot,
    pythonPath: runtime.pythonPath,
    timeoutMs: runtime.timeoutMs
  });
  const textHints = result.doctor?.text_hints || {};
  const needsOfflineAcknowledgement = textHints.selection === "builtin-ink" || textHints.paddle_token === "unset";
  if (!needsOfflineAcknowledgement) return job;
  const acceptedByLocalOcr = Boolean(localOcrHints?.path);
  if (!acceptedByLocalOcr && !options.acceptOfflineTextHints && !options.confirmOfflineTextHints && !options.paddleOcrDeclined) {
    throw new Error("本地 OCR 文字提示尚未就绪。派发前请先运行 PaddleOCR/RapidOCR 本地文字识别，或确认继续使用 editppt 离线内置文字提示。");
  }
  const acknowledgement = {
    kind: "editable_text_hints_acknowledgement",
    accepted: true,
    textHintsBackend: acceptedByLocalOcr ? localOcrHints.backend : textHints.selection || "builtin-ink",
    paddleToken: textHints.paddle_token || "unset",
    applyUrl: textHints.apply_url || "https://aistudio.baidu.com/account/accessToken",
    reason: cleanString(options.offlineTextHintsReason || (acceptedByLocalOcr ? `${localOcrHints.backend} text hints are available for this workflow` : "user accepted offline text hints for this workflow")),
    rapidOcrHintsPath: localOcrHints?.path || "",
    localOcrHintsPath: localOcrHints?.path || "",
    acceptedAt: new Date().toISOString()
  };
  job.artifacts = {
    ...(job.artifacts || {}),
    editableTextHintsAcknowledgement: acknowledgement
  };
  job.events = appendEvent(job.events, "editable.text_hints_acknowledged", "Offline editppt text hints accepted for this workflow", acknowledgement);
  return saveWorkflowJob(job);
}

function getLocalOcrTextHintsCheckpoint(job = {}) {
  const artifacts = job.artifacts || {};
  const candidates = [
    artifacts.ocrTextHints?.path,
    artifacts.editableRun?.rapidOcrHintsPath
  ].filter(Boolean);
  const hintPath = candidates.find((candidate) => fsSync.existsSync(candidate));
  if (!hintPath) return null;
  return {
    path: hintPath,
    backend: artifacts.ocrTextHints?.backend || artifacts.ocrTextHints?.ocrBackend?.name || "local-ocr"
  };
}

export async function recordWorkflowEditablePage(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  if (!isWorkflowJobImageDeckReviewApproved(job)) {
    const error = new Error("Image deck review must be current and approved before recording editable page results.");
    error.status = 409;
    error.code = "IMAGE_DECK_REVIEW_REQUIRED";
    throw error;
  }
  const runtime = getEditableRuntimeConfig(options);
  const runDir = getPreparedRunDir(job);
  const pageId = normalizePageId(options.pageId || options.page || "");
  const agentId = cleanString(options.agentId || "");
  if (!pageId) throw new Error("pageId is required");
  if (!agentId) throw new Error("agentId is required");
  const pageDir = path.join(runDir, "pages", pageId);
  const productVisualQa = await inspectEditablePageVisualFidelity(pageDir, pageId);
  if (!productVisualQa.passed) {
    const percent = Math.round(Number(productVisualQa.comparison?.score || 0) * 1000) / 10;
    const minimumPercent = EDITABLE_VISUAL_SIMILARITY_MINIMUM * 100;
    const reasons = [];
    if (productVisualQa.issues.includes("preview-visual-similarity-low")) {
      reasons.push(`visual similarity ${percent}% is below the ${minimumPercent}% product threshold`);
    }
    const structuralIssues = productVisualQa.issues.filter((issue) => issue !== "preview-visual-similarity-low");
    if (structuralIssues.length) reasons.push(`visual structure checks failed: ${structuralIssues.join(", ")}`);
    const error = new Error(`Editable page ${pageId} failed product visual fidelity QA: ${reasons.join("; ")}. Rebuild the page with source-locked coordinates and masked/local background repair; do not record this preview.`);
    error.code = "EDITABLE_VISUAL_FIDELITY_FAILED";
    error.details = productVisualQa;
    throw error;
  }
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
  const recordCreatedAt = new Date().toISOString();
  const promptFile = path.join(pageDir, "worker-prompt.md");
  const editableWorkerTasks = syncEditableWorkerTaskAfterRecord(job.artifacts?.editableWorkerTasks, {
    pageId,
    agentId,
    recordCreatedAt,
    pageDir,
    promptFile
  });
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
      createdAt: recordCreatedAt
    }].slice(-200),
    editableWorkerTasks,
    editableNext: { kind: "editable_next", runDir, next, checkedAt: new Date().toISOString() }
  };
  await syncEditableRunState(job, status, next);
  job.events = appendEvent(job.events, "editable.recorded", `Recorded ${pageId}`, { pageId, agentId, nextStage: next.stage });
  return saveWorkflowJob(job);
}

export async function inspectEditablePageVisualFidelity(pageDir, pageId = "") {
  const sourcePath = path.join(pageDir, "source.png");
  const previewPath = path.join(pageDir, "preview.png");
  const editableTextContract = readEditableTextVisualContract(pageDir);
  const comparison = comparePngVisualFidelity(sourcePath, previewPath, {
    ignoreBoxes: editableTextContract.passed ? editableTextContract.boxes : []
  });
  const issues = evaluateEditableVisualFidelity(comparison);
  const result = {
    version: 1,
    kind: "product_editable_visual_qa",
    pageId: normalizePageId(pageId || path.basename(pageDir)),
    sourcePath,
    previewPath,
    minimumSimilarity: EDITABLE_VISUAL_SIMILARITY_MINIMUM,
    comparisonMode: editableTextContract.passed
      ? "non-text-structure-with-validated-editable-text-mask"
      : "full-page-pixel-and-structure",
    editableTextContract,
    comparison,
    issues,
    passed: issues.length === 0,
    checkedAt: new Date().toISOString()
  };
  await fs.writeFile(path.join(pageDir, "product-visual-qa.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

function readEditableTextVisualContract(pageDir = "") {
  try {
    const manifest = JSON.parse(fsSync.readFileSync(path.join(pageDir, "manifest.json"), "utf8").replace(/^\uFEFF/, ""));
    const validation = JSON.parse(fsSync.readFileSync(path.join(pageDir, "validation.json"), "utf8").replace(/^\uFEFF/, ""));
    const texts = Array.isArray(manifest.text_boxes)
      ? manifest.text_boxes
      : Array.isArray(manifest.texts)
        ? manifest.texts
        : [];
    const boxes = texts.map((item) => Array.isArray(item?.box_px) ? item.box_px.map(Number) : null)
      .filter((box) => box && box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0);
    const requiredText = Array.isArray(validation.required_text) ? validation.required_text : [];
    const missingRequiredText = Array.isArray(validation.missing_required_text) ? validation.missing_required_text : [];
    const passed = validation.passed === true && texts.length > 0 && boxes.length === texts.length && missingRequiredText.length === 0;
    return {
      passed,
      editableTextShapeCount: Number(validation.editable_text_shapes || texts.length || 0),
      manifestTextCount: texts.length,
      requiredTextCount: requiredText.length,
      missingRequiredText,
      boxes: passed ? boxes : []
    };
  } catch (error) {
    return {
      passed: false,
      editableTextShapeCount: 0,
      manifestTextCount: 0,
      requiredTextCount: 0,
      missingRequiredText: [],
      boxes: [],
      error: cleanString(error?.message || error)
    };
  }
}

function syncEditableWorkerTaskAfterRecord(tasks = [], { pageId, agentId, pageDir = "", promptFile = "", recordCreatedAt } = {}) {
  const normalizedPageId = normalizePageId(pageId);
  if (!normalizedPageId) return Array.isArray(tasks) ? tasks : [];
  const now = recordCreatedAt || new Date().toISOString();
  const normalizedTasks = Array.isArray(tasks) ? tasks.map((task) => ({ ...task })) : [];
  const index = normalizedTasks.findIndex((task) => normalizePageId(task.pageId || task.page) === normalizedPageId);
  const update = {
    pageId: normalizedPageId,
    status: "recorded",
    agentId: cleanString(agentId || ""),
    pageDir: cleanString(pageDir),
    promptFile: cleanString(promptFile),
    relativePath: cleanString(promptFile),
    heartbeatAt: now,
    recordedAt: now,
    error: "",
    updatedAt: now
  };
  if (index >= 0) {
    normalizedTasks[index] = {
      ...normalizedTasks[index],
      ...update,
      agentId: update.agentId || cleanString(normalizedTasks[index].agentId || ""),
      message: cleanString(normalizedTasks[index].message || "")
    };
    return normalizedTasks;
  }
  return [...normalizedTasks, {
    ...update,
    workerName: "",
    attempts: 0,
    claimedAt: "",
    dispatchAt: "",
    message: "",
    createdAt: now
  }];
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
  const selectedPages = resolveEditablePageSelection(options, next);
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
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1"
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
  const pageJobs = await readJson(path.join(runDir, "page_jobs.json")).catch(() => null);
  const pageState = (Array.isArray(pageJobs?.pages) ? pageJobs.pages : [])
    .find((page) => normalizePageId(page?.page_id || page?.pageId || "") === pageId);
  const alreadyPending = String(pageState?.status || "").toLowerCase() === "pending";
  const resetTransactionId = cleanString(options.resetTransactionId || "");
  const reset = alreadyPending
    ? { stdout: `${pageId} is already pending; reset is idempotently satisfied.`, stderr: "", alreadyPending: true }
    : await runEditppt(args, { runtime, timeoutMs: runtime.timeoutMs });
  const status = await getEditableStatusForRun(runDir, runtime);
  const next = await getEditableNextForRun(runDir, runtime);
  job.currentStage = "pages_running";
  job.status = "pages_running";
  job.stageStatus = "running";
  job.stages.pages_running = markStage(job.stages.pages_running, "running", `Reset ${pageId} for editable retry`, { pageId, status, next });
  const existingResets = Array.isArray(job.artifacts?.editableResets) ? job.artifacts.editableResets : [];
  const resetAlreadyRecorded = Boolean(resetTransactionId && existingResets.some((item) => item.resetTransactionId === resetTransactionId));
  job.artifacts = {
    ...(job.artifacts || {}),
    editableDispatches: (Array.isArray(job.artifacts?.editableDispatches) ? job.artifacts.editableDispatches : []).filter((item) => normalizePageId(item.pageId) !== pageId),
    editableRecords: (Array.isArray(job.artifacts?.editableRecords) ? job.artifacts.editableRecords : []).filter((item) => normalizePageId(item.pageId) !== pageId),
    editableResets: resetAlreadyRecorded ? existingResets : [...existingResets, {
      kind: "editable_reset",
      pageId,
      runDir,
      resetTransactionId,
      stdout: reset.stdout,
      stderr: reset.stderr,
      alreadyPending,
      createdAt: new Date().toISOString()
    }].slice(-200),
    editableNext: { kind: "editable_next", runDir, next, checkedAt: new Date().toISOString() }
  };
  await syncEditableRunState(job, status, next);
  if (!resetAlreadyRecorded) {
    job.events = appendEvent(job.events, "editable.reset", `Reset ${pageId} for retry`, { pageId, nextStage: next.stage, resetTransactionId });
  }
  return saveWorkflowJob(job);
}

export async function finalizeWorkflowEditableRun(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  if (!isWorkflowJobImageDeckReviewApproved(job)) {
    const error = new Error("Image deck review must be current and approved before finalizing the editable PPTX.");
    error.status = 409;
    error.code = "IMAGE_DECK_REVIEW_REQUIRED";
    throw error;
  }
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
  let editability = await inspectEditablePptx(finalPath).catch((error) => ({
    version: 1,
    source: "pptx-openxml-inspection",
    status: "warn",
    editable: false,
    warnings: ["pptx-editability-inspection-failed"],
    error: error.message || "inspection failed"
  }));
  let powerPointOpenability = await inspectPowerPointOpenability(finalPath).catch((error) => ({
    version: 1,
    source: "powerpoint-com-open",
    available: process.platform === "win32",
    openable: false,
    slideCount: 0,
    warnings: ["powerpoint-open-check-failed"],
    error: error.message || "PowerPoint open check failed"
  }));
  let powerPointTextLayout = await inspectPowerPointTextLayout(finalPath).catch((error) => ({
    version: 1,
    source: "powerpoint-com-text-layout",
    available: process.platform === "win32",
    passed: false,
    slideCount: 0,
    checkedTextFrames: 0,
    overflowingTextFrames: 0,
    slides: [],
    warnings: ["powerpoint-text-layout-check-failed"],
    error: error.message || "PowerPoint text-layout check failed"
  }));
  const expectedFinalSlides = Number(summary?.page_count || editability?.slideCount || 0);
  const powerPointSlideCountMismatch = Boolean(
    expectedFinalSlides > 0
    && (Number(powerPointOpenability?.slideCount || 0) !== expectedFinalSlides
      || Number(powerPointTextLayout?.slideCount || 0) !== expectedFinalSlides)
  );
  const powerPointTextLayoutIncomplete = powerPointTextLayout.available !== true
    || powerPointTextLayout.passed !== true
    || (Number(editability?.nativeTextBoxes || 0) > 0 && Number(powerPointTextLayout?.checkedTextFrames || 0) === 0);
  const shouldRunOpenableRepair = options.disableOpenableRepair !== true
    && (powerPointOpenability.openable === false
      || powerPointSlideCountMismatch
      || powerPointTextLayoutIncomplete
      || options.forceOpenableRepair === true
      || options.repairPagePptx === true);
  const openableRepair = shouldRunOpenableRepair
    ? await repairEditablePptxWithOpenableManifestWriter(runDir, finalPath, runtime).catch((error) => ({
        ok: false,
        error: error.message || "openable manifest repair failed"
      }))
    : null;
  if (openableRepair?.ok) {
    editability = await inspectEditablePptx(finalPath).catch((error) => ({
      version: 1,
      source: "pptx-openxml-inspection",
      status: "warn",
      editable: false,
      warnings: ["pptx-editability-inspection-failed"],
      error: error.message || "inspection failed"
    }));
    powerPointOpenability = await inspectPowerPointOpenability(finalPath).catch((error) => ({
      version: 1,
      source: "powerpoint-com-open",
      available: process.platform === "win32",
      openable: false,
      slideCount: 0,
      warnings: ["powerpoint-open-check-failed"],
      error: error.message || "PowerPoint open check failed"
    }));
    powerPointTextLayout = await inspectPowerPointTextLayout(finalPath).catch((error) => ({
      version: 1,
      source: "powerpoint-com-text-layout",
      available: process.platform === "win32",
      passed: false,
      slideCount: 0,
      checkedTextFrames: 0,
      overflowingTextFrames: 0,
      slides: [],
      warnings: ["powerpoint-text-layout-check-failed"],
      error: error.message || "PowerPoint text-layout check failed"
    }));
    const validateScript = path.join(runtime.cliPath, "editppt", "runtime", "validate_pptx.py");
    const deckManifestPath = path.join(runDir, "deck_manifest.json");
    if (!fsSync.existsSync(validateScript)) throw new Error(`editppt validation script not found: ${validateScript}`);
    await fs.copyFile(finalPath, outputPath);
    await execFileAsync(runtime.pythonPath, [
      validateScript,
      outputPath,
      "--deck-manifest",
      deckManifestPath,
      "--report",
      validationSource
    ], {
      cwd: runDir,
      timeout: runtime.timeoutMs || DEFAULT_TIMEOUT_MS,
      windowsHide: true,
      encoding: "utf8",
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8"
      }
    });
    const targetValidation = path.join(job.dirs.final, "editable-validation.json");
    await fs.copyFile(validationSource, targetValidation);
    validationRecord = artifactRecord("editable_validation", targetValidation);
  }
  const finalSha256 = await hashFile(finalPath);
  powerPointOpenability = {
    ...powerPointOpenability,
    finalSha256,
    finalSize: fsSync.statSync(finalPath).size
  };
  powerPointTextLayout = {
    ...powerPointTextLayout,
    finalSha256,
    finalSize: fsSync.statSync(finalPath).size
  };
  const finalRecord = artifactRecord("editable_final_pptx", finalPath, {
    sha256: finalSha256,
    runDir,
    sourceOutputPath: outputPath,
    summary,
    validation: validationRecord,
    pptxEditability: editability,
    powerPointOpenability,
    powerPointTextLayout,
    openableRepair
  });
  job.artifacts = {
    ...(job.artifacts || {}),
    editableFinal: finalRecord
  };
  const finalizedStatus = await getEditableStatusForRun(runDir, runtime).catch(() => null);
  const finalizedNext = await getEditableNextForRun(runDir, runtime).catch(() => null);
  await syncEditableRunState(job, finalizedStatus, finalizedNext);
  job.currentStage = "finalizing";
  job.status = "review_pending";
  job.stageStatus = "complete";
  job.stages.finalizing = markStage(job.stages.finalizing, "complete", "Editable PPTX draft assembled; final delivery still requires review gate", { finalPath, runDir });
  job.stages.complete = markStage(job.stages.complete, "pending", "Final delivery pending manual review and product gate", { finalPath, editability, powerPointOpenability, powerPointTextLayout });
  job.events = appendEvent(job.events, "editable.finalized", "Final editable PPTX assembled", {
    finalPath,
    runDir,
    editable: editability.editable,
    powerPointOpenable: powerPointOpenability.openable,
    powerPointTextLayoutPassed: powerPointTextLayout.passed,
    overflowingTextFrames: powerPointTextLayout.overflowingTextFrames
  });
  return saveWorkflowJob(job);
}

export async function repairWorkflowEditablePageOpenability(jobId, pageId, options = {}) {
  let job = await readWorkflowJob(jobId);
  const runtime = getEditableRuntimeConfig(options);
  const runDir = getPreparedRunDir(job);
  const normalizedPageId = normalizePageId(pageId || options.pageId || options.page || "");
  if (!normalizedPageId) throw new Error("pageId is required");
  const pageDir = path.join(runDir, "pages", normalizedPageId);
  const manifestPath = path.join(pageDir, "manifest.json");
  const pageOut = path.join(pageDir, "page.pptx");
  const scriptPath = path.join(process.cwd(), "scripts", "openable-manifest-pptx.mjs");
  if (!fsSync.existsSync(scriptPath)) throw new Error(`Openable manifest writer not found: ${scriptPath}`);
  if (!fsSync.existsSync(manifestPath)) throw new Error(`Page manifest not found: ${manifestPath}`);
  const before = fsSync.existsSync(pageOut)
    ? await inspectPowerPointOpenability(pageOut).catch((error) => ({
        version: 1,
        source: "powerpoint-com-open",
        available: process.platform === "win32",
        openable: false,
        slideCount: 0,
        warnings: ["powerpoint-open-check-failed"],
        error: error.message || "PowerPoint open check failed"
      }))
    : null;
  const beforeTextLayout = fsSync.existsSync(pageOut)
    ? await inspectPowerPointTextLayout(pageOut).catch((error) => ({
        version: 1,
        source: "powerpoint-com-text-layout",
        available: process.platform === "win32",
        passed: false,
        slideCount: 0,
        checkedTextFrames: 0,
        overflowingTextFrames: 0,
        slides: [],
        warnings: ["powerpoint-text-layout-check-failed"],
        error: error.message || "PowerPoint text-layout check failed"
      }))
    : null;
  const result = await execFileAsync(process.execPath, [scriptPath, "--manifest", manifestPath, "--out", pageOut], {
    cwd: process.cwd(),
    timeout: runtime.timeoutMs || DEFAULT_TIMEOUT_MS,
    windowsHide: true,
    encoding: "utf8"
  });
  const hashRefresh = await refreshOpenableRepairPageJobHashes(runDir, path.join(runDir, "page_jobs.json"), [{
    pageId: normalizedPageId,
    manifestPath,
    pageOut,
    stdout: String(result.stdout || "").slice(-2000),
    stderr: String(result.stderr || "").slice(-2000)
  }]);
  const after = await inspectPowerPointOpenability(pageOut).catch((error) => ({
    version: 1,
    source: "powerpoint-com-open",
    available: process.platform === "win32",
    openable: false,
    slideCount: 0,
    warnings: ["powerpoint-open-check-failed"],
    error: error.message || "PowerPoint open check failed"
  }));
  const afterTextLayout = await inspectPowerPointTextLayout(pageOut).catch((error) => ({
    version: 1,
    source: "powerpoint-com-text-layout",
    available: process.platform === "win32",
    passed: false,
    slideCount: 0,
    checkedTextFrames: 0,
    overflowingTextFrames: 0,
    slides: [],
    warnings: ["powerpoint-text-layout-check-failed"],
    error: error.message || "PowerPoint text-layout check failed"
  }));
  job = await readWorkflowJob(jobId);
  const repairRecord = {
    kind: "editable_page_openable_repair",
    pageId: normalizedPageId,
    pagePptx: pageOut,
    manifestPath,
    before,
    beforeTextLayout,
    after,
    afterTextLayout,
    hashRefresh,
    stdout: String(result.stdout || "").slice(-2000),
    stderr: String(result.stderr || "").slice(-2000),
    repairedAt: new Date().toISOString()
  };
  job.artifacts = {
    ...(job.artifacts || {}),
    editablePageOpenableRepairs: [
      ...(Array.isArray(job.artifacts?.editablePageOpenableRepairs) ? job.artifacts.editablePageOpenableRepairs : []),
      repairRecord
    ].slice(-100)
  };
  job.events = appendEvent(job.events, "editable.page_openable_repaired", `Repaired page PPTX openability ${normalizedPageId}`, {
    pageId: normalizedPageId,
    openable: after.openable,
    textLayoutPassed: afterTextLayout.passed,
    overflowingTextFrames: afterTextLayout.overflowingTextFrames,
    hashRefresh
  });
  const saved = await saveWorkflowJob(job);
  return {
    ok: true,
    jobId,
    pageId: normalizedPageId,
    repair: repairRecord,
    job: saved
  };
}

async function repairEditablePptxWithOpenableManifestWriter(runDir, finalPath, runtime = {}) {
  const scriptPath = path.join(process.cwd(), "scripts", "openable-manifest-pptx.mjs");
  const deckManifest = path.join(runDir, "deck_manifest.json");
  const pageJobsPath = path.join(runDir, "page_jobs.json");
  if (!fsSync.existsSync(scriptPath)) throw new Error(`Openable manifest writer not found: ${scriptPath}`);
  if (!fsSync.existsSync(deckManifest)) throw new Error(`deck_manifest.json not found: ${deckManifest}`);
  const deck = await readJson(deckManifest);
  const root = path.resolve(deck.job_dir || runDir);
  const pageRepairs = [];
  for (const page of Array.isArray(deck.pages) ? deck.pages : []) {
    const manifestPath = path.resolve(root, page.manifest || "");
    if (!fsSync.existsSync(manifestPath)) continue;
    const pageDir = path.dirname(manifestPath);
    const pageOut = path.join(pageDir, "page.pptx");
    const result = await execFileAsync(process.execPath, [scriptPath, "--manifest", manifestPath, "--out", pageOut], {
      cwd: process.cwd(),
      timeout: runtime.timeoutMs || DEFAULT_TIMEOUT_MS,
      windowsHide: true,
      encoding: "utf8"
    });
    pageRepairs.push({
      pageId: normalizePageId(page.page_id || path.basename(pageDir)),
      manifestPath,
      pageOut,
      stdout: String(result.stdout || "").slice(-2000),
      stderr: String(result.stderr || "").slice(-2000)
    });
  }
  const hashRefresh = await refreshOpenableRepairPageJobHashes(runDir, pageJobsPath, pageRepairs).catch((error) => ({
    ok: false,
    error: error.message || "failed to refresh repaired page hashes"
  }));
  const finalResult = await execFileAsync(process.execPath, [scriptPath, "--deck-manifest", deckManifest, "--out", finalPath], {
    cwd: process.cwd(),
    timeout: runtime.timeoutMs || DEFAULT_TIMEOUT_MS,
    windowsHide: true,
    encoding: "utf8"
  });
  return {
    ok: true,
    source: "pptxgenjs-manifest-openable-repair",
    pageRepairs: pageRepairs.length,
    repairedPages: pageRepairs.map((item) => item.pageId).filter(Boolean),
    pageJobHashRefresh: hashRefresh,
    finalPath,
    stdout: String(finalResult.stdout || "").slice(-2000),
    stderr: String(finalResult.stderr || "").slice(-2000)
  };
}

async function refreshOpenableRepairPageJobHashes(runDir, pageJobsPath, pageRepairs = []) {
  if (!fsSync.existsSync(pageJobsPath)) return { ok: false, refreshed: 0, error: `page_jobs.json not found: ${pageJobsPath}` };
  const pageJobs = await readJson(pageJobsPath);
  const pages = Array.isArray(pageJobs.pages) ? pageJobs.pages : [];
  const repairByPage = new Map(pageRepairs.map((repair) => [normalizePageId(repair.pageId || path.basename(path.dirname(repair.pageOut || ""))), repair]));
  const refreshedPages = [];
  const refreshedOutputs = [];
  for (const page of pages) {
    const pageId = normalizePageId(page.page_id || page.pageId || "");
    const repair = repairByPage.get(pageId);
    if (!repair?.pageOut || !fsSync.existsSync(repair.pageOut)) continue;
    page.result = page.result && typeof page.result === "object" ? page.result : {};
    page.result.hashes = page.result.hashes && typeof page.result.hashes === "object" ? page.result.hashes : {};
    page.result.outputs = page.result.outputs && typeof page.result.outputs === "object" ? page.result.outputs : {};
    page.result.outputs.page_pptx = page.result.outputs.page_pptx || path.join("pages", pageId, "page.pptx").replace(/\\/g, "/");
    for (const key of REPAIR_HASH_KEYS) {
      const relative = page.result.outputs[key] || fallbackEditableOutputPath(pageId, key);
      const filePath = resolveEditableRunPath(runDir, relative);
      if (!filePath || !fsSync.existsSync(filePath) || !fsSync.statSync(filePath).isFile()) continue;
      page.result.outputs[key] = relative.replace(/\\/g, "/");
      page.result.hashes[key] = await hashFile(filePath);
      refreshedOutputs.push(`${pageId}:${key}`);
    }
    page.result.openable_repair = {
      source: "pptxgenjs-manifest-openable-repair",
      repairedAt: new Date().toISOString(),
      pagePptx: page.result.outputs.page_pptx
    };
    refreshedPages.push(pageId);
  }
  pageJobs.updated_at = new Date().toISOString();
  await fs.writeFile(pageJobsPath, JSON.stringify(pageJobs, null, 2), "utf8");
  return { ok: true, refreshed: refreshedPages.length, pages: refreshedPages, outputs: refreshedOutputs };
}

function fallbackEditableOutputPath(pageId, key) {
  const names = {
    page_manifest: "manifest.json",
    imagegen_jobs: "imagegen-jobs.json",
    page_pptx: "page.pptx",
    preview: "preview.png",
    contact_sheet: "split_assets_contact.png",
    validation: "validation.json",
    page_result: "page_result.json"
  };
  return path.join("pages", pageId, names[key] || key).replace(/\\/g, "/");
}

function resolveEditableRunPath(runDir, value = "") {
  const raw = String(value || "");
  if (!raw) return "";
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(runDir, raw);
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
  const backendConfigSource = await fs.readFile(path.join(skillRoot, "cli", "editppt", "runtime", "configure_image_backend.py"), "utf8").catch(() => "");
  const imageRecordSource = await fs.readFile(path.join(skillRoot, "cli", "editppt", "runtime", "record_imagegen_result.py"), "utf8").catch(() => "");
  const assetSheetSource = await fs.readFile(path.join(skillRoot, "cli", "editppt", "runtime", "process_asset_sheet.py"), "utf8").catch(() => "");
  const singlePageLocalMode = /single-page[\s\S]{0,220}local|rebuild_page_locally|--local/i.test(source);
  const multiPageWorkerDispatch = /multi-page[\s\S]{0,220}(page workers|worker dispatch|dispatch)|dispatch_pages/i.test(source);
  const serialImageEdit = /serial[\s\S]{0,120}editppt image generate\/edit|editppt image generate\/edit/i.test(source);
  const noFullSlideFallback = /full-slide[\s\S]{0,180}(not acceptable|not an acceptable fallback)|source\.png[\s\S]{0,160}not acceptable/i.test(source);
  const builtinImagegenPreferred = /builtin-imagegen/.test(backendConfigSource) && /image_gen\.imagegen/.test(backendConfigSource);
  const backendProvenance = /fallback_reason/.test(imageRecordSource) && /producing backend/i.test(imageRecordSource);
  const jobScopedAssetSheets = /args\.job_id/.test(assetSheetSource) && /asset-sheet-alpha\.png/.test(assetSheetSource) && /split-report\.json/.test(assetSheetSource);
  const v032Compatible = Boolean(builtinImagegenPreferred && backendProvenance && jobScopedAssetSheets);
  const agentsSkillRoot = /[\\\/]\.agents[\\\/]skills[\\\/]image-to-editable-ppt/i.test(skillRoot);
  const ok = Boolean(singlePageLocalMode && multiPageWorkerDispatch && serialImageEdit && noFullSlideFallback);
  return {
    ok,
    mode: ok ? (v032Compatible ? "v0.3.2-compatible" : "v0.3-compatible") : "legacy-or-unknown",
    skillRoot,
    skillPath,
    skillSha256: crypto.createHash("sha256").update(source).digest("hex"),
    agentsSkillRoot,
    singlePageLocalMode,
    multiPageWorkerDispatch,
    serialImageEdit,
    noFullSlideFallback,
    builtinImagegenPreferred,
    backendProvenance,
    jobScopedAssetSheets,
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
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1"
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
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1"
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

function getEditablePrepareInputs(job, options = {}) {
  const visualImages = Array.isArray(job.artifacts?.visualImages) ? job.artifacts.visualImages : [];
  const selectedPages = normalizePages(options.pages || options.pageIds || options.pageId || []);
  const selectedSet = new Set(selectedPages);
  return visualImages
    .filter((item) => item?.path && item.staleStyleReference !== true && fsSync.existsSync(item.path))
    .filter((item, index) => !selectedSet.size || selectedSet.has(normalizePageId(item.pageId || index + 1)))
    .map((item, index) => ({
      pageId: item.pageId || `page_${String(index + 1).padStart(3, "0")}`,
      pageNumber: Number(item.pageNumber || index + 1),
      path: item.path
    }))
    .sort((a, b) => a.pageNumber - b.pageNumber);
}

async function linkRapidOcrHints(job, runDir) {
  const hintsPath = job.artifacts?.visualOcrTextHints?.path || job.artifacts?.ocrTextHints?.path;
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

async function syncEditableRunState(job, status = null, next = null) {
  if (!job?.artifacts?.editableRun) return;
  job.artifacts.editableRun = {
    ...job.artifacts.editableRun,
    ...(status ? { status } : {}),
    ...(next ? { next } : {}),
    stateUpdatedAt: new Date().toISOString()
  };
  const pointerPath = job.artifacts.editableRun.workspacePointerPath
    || path.join(job.dirs?.editableRun || "", "editable_run_pointer.json");
  if (!pointerPath || !fsSync.existsSync(pointerPath)) return;
  const pointer = await readJson(pointerPath).catch(() => null);
  if (!pointer) return;
  await fs.writeFile(pointerPath, JSON.stringify({
    ...pointer,
    ...(status ? { status } : {}),
    ...(next ? { next } : {}),
    updatedAt: new Date().toISOString()
  }, null, 2), "utf8");
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

async function archiveGeneratedEditableRun(layout, job) {
  const resolvedRunRoot = path.resolve(layout.runRoot);
  const resolvedBase = path.resolve(layout.base);
  if (path.basename(resolvedRunRoot) !== job.id || !resolvedRunRoot.startsWith(resolvedBase + path.sep)) {
    throw new Error("Refusing to archive editable run outside the configured run root");
  }
  if (!fsSync.existsSync(resolvedRunRoot)) return null;
  const archiveBase = path.join(resolvedBase, ".refresh-backups");
  const archiveRoot = path.join(archiveBase, `${job.id}-${Date.now()}`);
  await fs.mkdir(archiveBase, { recursive: true });
  await fs.rename(resolvedRunRoot, archiveRoot);
  return { archiveRoot, runDir: path.join(archiveRoot, "run") };
}

export async function restoreRecordedEditablePages(archive = {}, layout = {}, stalePageIds = []) {
  const stale = new Set(normalizePages(stalePageIds));
  const oldJobsPath = path.join(archive.runDir || "", "page_jobs.json");
  const newJobsPath = path.join(layout.runDir, "page_jobs.json");
  const oldJobs = await readJson(oldJobsPath).catch(() => null);
  const newJobs = await readJson(newJobsPath).catch(() => null);
  if (!Array.isArray(oldJobs?.pages) || !Array.isArray(newJobs?.pages)) return [];
  const preserved = oldJobs.pages.filter((page) => {
    const pageId = normalizePageId(page?.page_id || page?.pageId || page?.page_index);
    return pageId && !stale.has(pageId) && ["recorded", "accepted"].includes(String(page?.status || "").toLowerCase());
  });
  if (!preserved.length) return [];
  const preservedById = new Map();
  for (const page of preserved) {
    const pageId = normalizePageId(page?.page_id || page?.pageId || page?.page_index);
    const sourceDir = path.join(archive.runDir, "pages", pageId);
    const targetDir = path.join(layout.runDir, "pages", pageId);
    if (!(await isRecoverableRecordedEditablePage(sourceDir, targetDir, pageId, page))) continue;
    await fs.rm(targetDir, { recursive: true, force: true });
    await fs.cp(sourceDir, targetDir, { recursive: true, force: true });
    preservedById.set(pageId, page);
  }
  if (!preservedById.size) return [];
  newJobs.pages = newJobs.pages.map((page) => {
    const pageId = normalizePageId(page?.page_id || page?.pageId || page?.page_index);
    return preservedById.get(pageId) || page;
  });
  await fs.writeFile(newJobsPath, JSON.stringify(newJobs, null, 2), "utf8");
  return [...preservedById.keys()];
}

async function isRecoverableRecordedEditablePage(pageDir = "", freshPageDir = "", expectedPageId = "", recordedPage = {}) {
  if (!pageDir || !fsSync.existsSync(pageDir)) return false;
  try {
    for (const fileName of Object.values(RECOVERABLE_EDITABLE_PAGE_OUTPUTS)) {
      const filePath = path.join(pageDir, fileName);
      if (!fsSync.existsSync(filePath) || !fsSync.statSync(filePath).isFile()) return false;
    }
    const manifest = JSON.parse(fsSync.readFileSync(path.join(pageDir, "manifest.json"), "utf8").replace(/^\uFEFF/, ""));
    const validation = JSON.parse(fsSync.readFileSync(path.join(pageDir, "validation.json"), "utf8").replace(/^\uFEFF/, ""));
    const pageResult = JSON.parse(fsSync.readFileSync(path.join(pageDir, "page_result.json"), "utf8").replace(/^\uFEFF/, ""));
    const productVisualQa = JSON.parse(fsSync.readFileSync(path.join(pageDir, "product-visual-qa.json"), "utf8").replace(/^\uFEFF/, ""));
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return false;
    if (manifest.page_id && normalizePageId(manifest.page_id) !== expectedPageId) return false;
    if (validation?.passed !== true) return false;
    if (productVisualQa?.passed !== true || normalizePageId(productVisualQa?.pageId) !== expectedPageId) return false;
    if (!(await isPptxContainer(path.join(pageDir, "page.pptx")))) return false;
    for (const fileName of ["source.png", "preview.png", "split_assets_contact.png"]) {
      if (!isPngFile(path.join(pageDir, fileName))) return false;
    }
    const freshSource = path.join(freshPageDir, "source.png");
    if (!isPngFile(freshSource) || fileSha256Sync(path.join(pageDir, "source.png")) !== fileSha256Sync(freshSource)) return false;
    const hashes = recordedPage?.result?.hashes || {};
    for (const [key, fileName] of Object.entries(RECOVERABLE_EDITABLE_PAGE_OUTPUTS)) {
      if (pageResult?.[key] !== fileName) return false;
      if (!hashes[key] || hashes[key] !== fileSha256Sync(path.join(pageDir, fileName))) return false;
    }
    const manifestAssetPaths = [
      ...(Array.isArray(manifest.images) ? manifest.images.map((item) => item?.path) : []),
      ...(Array.isArray(manifest.asset_provenance) ? manifest.asset_provenance.map((item) => item?.path) : [])
    ].filter(Boolean);
    return manifestAssetPaths.every((assetPath) => isExistingPageFile(pageDir, assetPath));
  } catch {
    return false;
  }
}

async function isPptxContainer(filePath = "") {
  if (!fsSync.existsSync(filePath)) return false;
  try {
    const zip = await JSZip.loadAsync(fsSync.readFileSync(filePath));
    return Boolean(
      zip.file("[Content_Types].xml")
      && zip.file("ppt/presentation.xml")
      && Object.keys(zip.files).some((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    );
  } catch {
    return false;
  }
}

function isPngFile(filePath = "") {
  if (!filePath || !fsSync.existsSync(filePath)) return false;
  const buffer = fsSync.readFileSync(filePath);
  if (buffer.length < 57 || !buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return false;
  let offset = 8;
  let hasIhdr = false;
  let hasIdat = false;
  let hasIend = false;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > buffer.length) return false;
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (!hasIhdr && type !== "IHDR") return false;
    if (type === "IHDR") {
      if (hasIhdr || length !== 13 || buffer.readUInt32BE(offset + 8) <= 0 || buffer.readUInt32BE(offset + 12) <= 0) return false;
      hasIhdr = true;
    } else if (type === "IDAT") {
      hasIdat = hasIdat || length > 0;
    } else if (type === "IEND") {
      if (length !== 0) return false;
      hasIend = true;
      return hasIhdr && hasIdat && chunkEnd === buffer.length;
    }
    offset = chunkEnd;
  }
  return hasIhdr && hasIdat && hasIend;
}

function isExistingPageFile(pageDir = "", filePath = "") {
  if (!filePath || path.isAbsolute(filePath)) return false;
  const root = path.resolve(pageDir);
  const resolved = path.resolve(root, filePath);
  return resolved.startsWith(`${root}${path.sep}`) && fsSync.existsSync(resolved) && fsSync.statSync(resolved).isFile();
}

function fileSha256Sync(filePath = "") {
  return crypto.createHash("sha256").update(fsSync.readFileSync(filePath)).digest("hex");
}

async function rollbackArchivedEditableRun(archive = {}, layout = {}) {
  if (!archive.archiveRoot || !fsSync.existsSync(archive.archiveRoot)) return;
  await fs.rm(layout.runRoot, { recursive: true, force: true });
  await fs.rename(archive.archiveRoot, layout.runRoot);
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
  if (summary.failedCount > 0 && !isWorkflowJobImageDeckReviewApproved(job)) {
    throw new Error(`Visual quality report has ${summary.failedCount} failed page(s). Retry or repair visual pages before editable prepare.`);
  }
  if (summary.reviewCount > 0 && !isVisualQualityReviewCurrent(artifacts) && !isWorkflowJobImageDeckReviewApproved(job)) {
    throw new Error(`Visual quality report requires manual review for ${summary.reviewCount} page(s). Approve visual quality review before editable prepare.`);
  }
}

function assertImageDeckReviewGate(job = {}, options = {}) {
  if (isNonProductEditableGateBypassAllowed(options)) return;
  if (options.confirmRouteB !== true) {
    throw new Error("Route B requires explicit user confirmation before editable prepare.");
  }
  if (isWorkflowJobImageDeckReviewApproved(job, options)) return;
  throw new Error("Image deck review must be approved before editable prepare.");
}

function isWorkflowJobImageDeckReviewApproved(job = {}, options = {}) {
  return isImageDeckReviewApproved(job.artifacts || {}, {
    ...options,
    expectedPages: Number(options.expectedPages || 0) || getExpectedWorkflowPageCount(job)
  });
}

function getExpectedWorkflowPageCount(job = {}) {
  return getExpectedImageDeckPageCount(job);
}

export function isImageDeckReviewApproved(artifacts = {}, options = {}) {
  const qualityReport = readCurrentVisualQualityReport(artifacts);
  if (!qualityReport) return false;
  const pageImageSha256ByPage = Object.fromEntries((Array.isArray(qualityReport.pages) ? qualityReport.pages : []).map((page) => [
    normalizePageId(page.pageId || pageIdFromNumber(page.pageNumber)),
    String(page.sha256 || "").trim()
  ]).filter(([pageId]) => Boolean(pageId)));
  const pageEvidenceSha256ByPage = {
    ...(artifacts.visualTextQuality?.pageEvidenceSha256ByPage || {}),
    ...Object.fromEntries((Array.isArray(qualityReport.pages) ? qualityReport.pages : []).map((page) => [
      normalizePageId(page.pageId || pageIdFromNumber(page.pageNumber)),
      String(page.semanticQuality?.evidenceSha256 || "").trim()
    ]).filter(([pageId, evidenceSha256]) => Boolean(pageId && evidenceSha256)))
  };
  const hydratedArtifacts = {
    ...artifacts,
    visualTextQuality: {
      ...(artifacts.visualTextQuality || {}),
      summary: qualityReport.summary?.semanticQuality || artifacts.visualTextQuality?.summary || {},
      pageEvidenceSha256ByPage
    },
    visualQuality: {
      ...(artifacts.visualQuality || {}),
      summary: qualityReport.summary || {},
      semanticQuality: qualityReport.summary?.semanticQuality || {},
      pageImageSha256ByPage,
      approvedSampleSha256: String(qualityReport.summary?.styleConsistency?.approvedSampleSha256 || "").trim()
    }
  };
  return isWorkflowImageDeckReviewReady(hydratedArtifacts, {
    expectedPages: Number(options.expectedPages || 0) || Math.max(
      Array.isArray(artifacts.renderedPages) ? artifacts.renderedPages.length : 0,
      Number(artifacts.imageDeck?.pageCount || 0),
      Number(artifacts.ocrTextHints?.pageCount || 0),
      (Array.isArray(artifacts.visualImages) ? artifacts.visualImages : [])
        .filter((image) => image?.path && image.staleStyleReference !== true).length
    )
  });
}

function readCurrentVisualQualityReport(artifacts = {}) {
  const reportPath = String(artifacts.visualQuality?.path || "").trim();
  if (!reportPath) return null;
  if (!fsSync.existsSync(reportPath)) return null;
  try {
    const report = JSON.parse(fsSync.readFileSync(reportPath, "utf8"));
    const currentSampleSha256 = String(artifacts.visualSample?.sha256 || "").trim();
    const reportSampleSha256 = String(report?.summary?.styleConsistency?.approvedSampleSha256 || "").trim();
    if (!currentSampleSha256 || !reportSampleSha256 || reportSampleSha256 !== currentSampleSha256) return null;
    const reportPages = new Map((Array.isArray(report?.pages) ? report.pages : [])
      .map((page) => [normalizePageId(page.pageId || pageIdFromNumber(page.pageNumber)), page]));
    const visualImages = (Array.isArray(artifacts.visualImages) ? artifacts.visualImages : [])
      .filter((image) => image?.path && image.staleStyleReference !== true);
    const current = Boolean(visualImages.length) && visualImages.every((image) => {
      const pageId = normalizePageId(image.pageId || pageIdFromNumber(image.pageNumber));
      const reportPage = reportPages.get(pageId);
      const imageSha256 = String(image.sha256 || "").trim();
      const reportSha256 = String(reportPage?.sha256 || "").trim();
      return Boolean(pageId && reportPage && imageSha256 && reportSha256 && reportSha256 === imageSha256);
    });
    return current ? report : null;
  } catch {
    return null;
  }
}

function isNonProductEditableGateBypassAllowed(options = {}) {
  return process.env.PPT_TOOL_ALLOW_NONPRODUCT_EDITABLE_BYPASS === "1";
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
  const hintsPath = job.artifacts?.visualOcrTextHints?.path || job.artifacts?.ocrTextHints?.path || "";
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

function getEditableTextHintEvidence(artifacts = {}, expectedPageIds = []) {
  const useVisualOcr = Boolean(artifacts.visualOcrTextHints?.path);
  const ocr = useVisualOcr ? artifacts.visualOcrTextHints : artifacts.ocrTextHints || {};
  const editable = artifacts.editableHints || {};
  const editableSummary = editable.summary || editable.textHints || {};
  const ocrReady = Boolean(ocr.path && (ocr.pageCount || ocr.textCount || fsSync.existsSync(ocr.path)));
  const expectedPages = [...new Set((Array.isArray(expectedPageIds) ? expectedPageIds : []).map(normalizePageId).filter(Boolean))];
  const ocrPages = useVisualOcr ? artifacts.visualOcrPages : artifacts.ocrPages;
  const ocrPageIds = new Set((Array.isArray(ocrPages) ? ocrPages : [])
    .map((page) => normalizePageId(page?.pageId || page?.pageNumber))
    .filter(Boolean));
  const coveredPages = expectedPages.length
    ? expectedPages.filter((pageId) => ocrPageIds.has(pageId)).length
    : Number(ocr.pageCount || 0) || 0;
  const ocrPartial = Boolean(expectedPages.length && coveredPages < expectedPages.length);
  const editableReadyPages = Number(editableSummary.readyPages || 0) || 0;
  const editablePageCount = Number(editableSummary.pageCount || 0) || 0;
  const editableReady = Boolean(editable.path && editableReadyPages > 0);
  if (ocrReady) {
    return {
      ready: true,
      partial: ocrPartial,
      source: "ocrTextHints",
      pageCount: Number(ocr.pageCount || 0) || 0,
      textLineCount: Number(ocr.textCount || 0) || 0,
      detail: expectedPages.length
        ? `OCR coverage ${coveredPages}/${expectedPages.length} selected page(s), ${ocr.textCount || 0} text line(s)`
        : `OCR ${ocr.pageCount || 0} page(s), ${ocr.textCount || 0} text line(s)`,
      warning: ocrPartial ? `OCR only covers ${coveredPages}/${expectedPages.length} selected page(s); uncovered pages will use editppt fallback hints.` : ""
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
  const pages = [];
  for (const item of raw) {
    const text = String(item || "").trim();
    const range = text.match(/^(?:page_)?(\d{1,3})-(?:page_)?(\d{1,3})$/i);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (Number.isFinite(start) && Number.isFinite(end)) {
        const low = Math.min(start, end);
        const high = Math.max(start, end);
        for (let page = low; page <= high; page += 1) pages.push(normalizePageId(page));
      }
      continue;
    }
    pages.push(normalizePageId(text));
  }
  return [...new Set(pages.filter(Boolean))];
}

function resolveEditablePageSelection(options = {}, next = {}) {
  const requested = options.pages ?? options.pageIds ?? options.pageId;
  const requestedPages = normalizePages(requested);
  if (requestedPages.length) return requestedPages;
  return normalizePages(next.dispatchable_pages || next.suggested_pages || next.pages || next.page_id || next.page || []);
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

async function hashFile(filePath) {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
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
