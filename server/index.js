import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fsSync from "fs";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import { addStyleReference, addUpload, deleteJob, deleteStyleReference, deleteUpload, ensureDirs, getJob, getUploads, listJobs, listStyleReferences, makeId, outputDir, rootDir, saveJob, updateStyleReference, uploadDir } from "./store.js";
import { auditPptxIntake, buildDeck, exportWithPowerPoint, extractPptxImages, extractText, renderPptxPreview } from "./ppt.js";
import { generateDeckPlan, reviseSlide } from "./ai.js";
import { validateDeck } from "./validateDeck.js";
import { buildMaterialBrief } from "./materialBrief.js";
import { routeDeck } from "./deckRouter.js";
import { addEvent, makeEvent } from "./events.js";
import { reviewDeckVisuals, reviewSourceIntake } from "./visualReview.js";
import { checkLocalImageStatus, generateLocalImage } from "./localImage.js";
import { generateCloudImage } from "./cloudImage.js";
import { analyzeGeneratedImage } from "./imageQa.js";
import { analyzePptxAesthetic, compactAestheticReport } from "./pptAesthetic.js";
import { cutoutImage } from "./matting.js";
import { buildEditableRebuildPlan } from "./editableManifest.js";
import { buildSceneGraphRepairRecord, buildVisualTargetSamplePrompt, compareRenderedPreviewToVisualTarget, ensureSceneGraphForJob } from "./sceneGraph.js";
import { buildAssetManifest, validateAssetManifest } from "./assetManifest.js";
import { ensureVisualProjectForJob, generateVisualProjectSlides } from "./visualProject.js";
import { buildFinalExportGate, buildHybridQa } from "./hybridQa.js";
import { appendWorkflowEvent, archiveWorkflowJob, archiveWorkflowJobCleanup, createWorkflowJob, listWorkflowJobSummaries, previewWorkflowJobCleanup, readWorkflowJob, readWorkflowJobsByIds, restoreWorkflowJob, saveWorkflowJob, updateWorkflowPage, updateWorkflowStage, WORKFLOW_PAGE_STATUS, WORKFLOW_STAGE_ORDER, WORKFLOW_STAGE_STATUS, workflowRootDir } from "./workflowJobs.js";
import { getProviderConfig, listLlmModels, testImageProvider, testLlmProvider, testOcrProvider } from "./providers.js";
import { renderWorkflowSource } from "./sourceRenderer.js";
import { assembleWorkflowImageDeck, assertVisualSampleSelectionAllowed, assertWorkflowVisualGenerationAllowed, discoverVisualImages, generateWorkflowVisualImages, generateWorkflowVisualSample, getWorkflowVisualSourceOcrPageIds, getWorkflowVisualTargetPages, parsePageSelection, resolveWorkflowVisualSampleSelection, writeVisualQualityReport } from "./workflowVisuals.js";
import { correctWorkflowOcrTextHint, getWorkflowOcrCoverage, runWorkflowOcr } from "./workflowOcr.js";
import { writeWorkflowVisualTextQualityReport } from "./workflowVisualTextQa.js";
import { buildWorkflowEditableWorkerPrompts, configureEditpptPaddleOcrToken, dispatchWorkflowEditablePage, finalizeWorkflowEditableRun, getWorkflowEditableNext, getWorkflowEditablePreparePreflight, getWorkflowEditableStatus, invalidateWorkflowEditableRebuildEvidence, listWorkflowEditableWorkerPrompts, prepareWorkflowEditableRun, rebuildWorkflowEditableLocalPage, recordWorkflowEditablePage, regenerateWorkflowEditableHints, repairWorkflowEditablePageOpenability, testEditableRuntime, isImageDeckReviewApproved } from "./workflowEditable.js";
import { claimWorkflowEditableWorkerTask, completeWorkflowEditableWorkerTask, heartbeatWorkflowEditableWorkerTask, listWorkflowEditableWorkerTasks, resetWorkflowEditableWorkerTask, syncWorkflowEditableWorkerTasks } from "./workflowWorkerQueue.js";
import { buildWorkflowWorkerBriefs, getWorkflowWorkerBriefs } from "./workflowWorkerBriefs.js";
import { getWorkflowDeliveryStatus } from "./workflowDelivery.js";
import { listWorkflowArtifactLinks, resolveWorkflowArtifact } from "./workflowArtifacts.js";
import { buildWorkflowLogBundle } from "./workflowLogBundle.js";
import { getWorkflowComplianceStatus } from "./workflowCompliance.js";
import { approveWorkflowManualReview, approveWorkflowVisualQualityReview, recordWorkflowPageVisualReview, resetWorkflowManualReview } from "./workflowManualReview.js";
import { approveWorkflowImageDeckReview, assertWorkflowImageDeckReviewReady, recordWorkflowImageDeckPageReview, recordWorkflowImageDeckPagesForRerun } from "./workflowImageDeckReview.js";
import { approveCodexPptGate, assertCodexPptApprovals, CODEX_PPT_VISUAL_DECK_GATES, CODEX_PPT_VISUAL_SAMPLE_GATES, CODEX_PPT_VISUAL_TEST_GATES, isCodexPptSampleApprovalCurrent, preflightCodexPptGate, resetCodexPptGate } from "./workflowApprovals.js";
import { buildSkillFirstOutlineDraft, recordWorkflowCodexPptOutline } from "./workflowOutline.js";
import { recordWorkflowCodexPptBackendDecision, recordWorkflowCodexPptStyle } from "./workflowCodexPptDecisions.js";
import { assertWorkflowInformationAssetMapReady, buildWorkflowInformationAssetMap } from "./workflowInformationAssets.js";
import { claimWorkflowCodexPptSlideTask, completeWorkflowCodexPptSlideTask, heartbeatWorkflowCodexPptSlideTask, listWorkflowCodexPptSlideTasks, resetWorkflowCodexPptSlideTask, resetWorkflowNonProductCodexPptSlides, syncWorkflowCodexPptSlideTasks } from "./workflowCodexPptWorkerQueue.js";
import { getWorkflowCodexPptSlideBatchPreflight, runWorkflowCodexPptSlideBatch } from "./workflowCodexPptSlideBatchRunner.js";
import { runProductDoctor } from "./doctor.js";
import { getFinalVisualQaRetryPreflight, getVisualQualityRetryPreflight, retryFailedWorkflowPages, retryFinalVisualQaWorkflowPages, retryStaleWorkflowPageEvidence, retryWorkflowPage } from "./workflowPageRetry.js";
import { getWorkflowNextActionPreflight, runWorkflowNextAction } from "./workflowNextAction.js";
import { cancelWorkflowEditableWorkerRun, getWorkflowEditableWorkerBatchPreflight, getWorkflowEditableWorkerRunLog, getWorkflowPageSpecProviderProbe, listWorkflowEditableWorkerRuns, startWorkflowEditableWorkerBatch } from "./workflowWorkerBatchRunner.js";
import { getWorkflowCostEstimate, getWorkflowCostPreview } from "./workflowCostEstimate.js";
import { getWorkflowV1Readiness } from "./workflowV1Readiness.js";
import { getLatestV1AcceptanceReport } from "./workflowV1AcceptanceReport.js";
import { getV1AcceptanceRunStatus, preflightV1AcceptanceRun, startV1AcceptanceRun } from "./workflowV1AcceptanceRunner.js";
import { approveProductVisualFullDeck, approveProductVisualSample, getLatestProductVisualReadiness, getProductVisualFullDeckApprovalPreflight, getProductVisualFullDeckPreflight, getProductVisualSampleApprovalPreflight, getProductVisualSamplePreflight, getProductVisualSamplePromptPreview, runProductVisualFullDeck, runProductVisualReadinessNoCost, runProductVisualSample } from "./workflowProductVisualReadinessRunner.js";
import { authorizeExternalImageSpend, getExternalImageAuthorizationStatus, listWorkflowAuthorizations } from "./workflowAuthorizations.js";
import { getWorkflowContinuationPreflight, runWorkflowContinuation } from "./workflowContinuation.js";
import { requestIdempotency, resolveIdempotencyRecord } from "./requestIdempotency.js";
import { cleanupAbandonedWorkflowJobLocks } from "./workflowJobLock.js";
import { isInternalWorkflowJob } from "../shared/workflowVisibility.js";
import { PRESENTATION_ROUTES, testPptMasterRuntime } from "./workflowPptMaster.js";
import { getWorkflowBusinessReadiness } from "./workflowBusinessReadiness.js";
import { createLocalCorsOptions, createLocalRequestBoundary, localSecurityHeaders, resolveLocalAccessConfig } from "./localAccess.js";
import { createRuntimeIdentityTracker } from "./runtimeIdentity.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(globalThis.process?.env?.PORT || 4180);
const localAccess = resolveLocalAccessConfig(globalThis.process?.env || {}, port);
const envPath = path.join(rootDir, ".env");
const serverStartedAt = new Date();
const appVersion = "0.2.0";
const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    await ensureDirs();
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${makeId("upload")}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 600 * 1024 * 1024 } });
const DEFAULT_PRIMARY_WORKFLOW_JOB_ID = "";

await ensureDirs();
const runtimeIdentity = await createRuntimeIdentityTracker(rootDir);
app.disable("x-powered-by");
app.use(localSecurityHeaders);
app.use(createLocalRequestBoundary(localAccess));
app.use(cors(createLocalCorsOptions(localAccess)));
app.use(express.json({ limit: "20mb" }));
app.use(requestIdempotency);

app.post("/api/system/idempotency/resolve", (req, res, next) => {
  try {
    if (req.body?.confirmation !== "verified-no-side-effect") {
      const error = new Error("Explicit confirmation is required after checking current workflow state");
      error.status = 400;
      error.code = "IDEMPOTENCY_RESOLUTION_CONFIRMATION_REQUIRED";
      throw error;
    }
    res.json({ ok: true, ...resolveIdempotencyRecord(req.body || {}) });
  } catch (error) {
    next(error);
  }
});
app.use("/outputs", express.static(outputDir));
app.use("/uploads", express.static(uploadDir));

app.get("/api/health", async (_req, res, next) => {
  try {
    const providers = getProviderConfig();
    const identity = await runtimeIdentity.current();
    res.json({
      ok: true,
      status: "online",
      version: appVersion,
      pid: globalThis.process?.pid || null,
      port,
      host: localAccess.host,
      accessMode: localAccess.accessMode,
      uptime: globalThis.process?.uptime ? Math.round(globalThis.process.uptime()) : null,
      startedAt: serverStartedAt.toISOString(),
      runtime: identity,
      restartRequired: identity.restartRequired,
      rootDir,
      workflowRootDir,
      hasApiKey: Boolean(globalThis.process?.env?.OPENAI_API_KEY),
      model: globalThis.process?.env?.OPENAI_MODEL || "gpt-4.1-mini",
      providers: {
        llm: { configured: providers.llm.configured, baseUrl: providers.llm.baseUrl, model: providers.llm.model, pageSpecModel: providers.llm.pageSpecModel },
        image: {
          configured: providers.image.configured,
          enabled: providers.image.enabled,
          baseUrl: providers.image.baseUrl,
          model: providers.image.model,
          supportsImageEdit: Boolean(providers.image.supportsImageEdit),
          editEndpoint: providers.image.editEndpoint || "/images/edits",
          requiredInputMode: providers.image.requiredInputMode || "source-page-edit"
        },
        ocr: {
          enabled: providers.ocr.enabled,
          provider: providers.ocr.provider,
          fallbackProvider: providers.ocr.fallbackProvider || "",
          pythonPath: providers.ocr.pythonPath
        }
      },
      time: new Date().toISOString()
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/doctor", async (_req, res, next) => {
  try {
    res.json(await runProductDoctor());
  } catch (error) {
    if (error?.code === "WORKFLOW_FINAL_PPTX_BLOCKED") {
      res.status(error.status || 409).json({
        ok: false,
        code: error.code,
        error: error.message || "Final PPTX is blocked by the delivery gate.",
        finalGate: error.finalGate || null
      });
      return;
    }
    next(error);
  }
});

app.get("/api/providers/ppt-master", async (_req, res, next) => {
  try {
    res.json({
      ok: true,
      routes: PRESENTATION_ROUTES,
      provider: await testPptMasterRuntime()
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/agents/codex-ppt-director/chat", async (req, res, next) => {
  try {
    const text = cleanClientText(req.body?.message || "");
    const fileIds = Array.isArray(req.body?.fileIds) ? req.body.fileIds.filter(Boolean) : [];
    const files = await getUploads(fileIds);
    const job = req.body?.jobId ? await getJob(req.body.jobId) : null;
    const workflowJobId = cleanClientText(req.body?.workflowJobId || "");
    const workflowJob = workflowJobId ? await readWorkflowJob(workflowJobId) : null;
    const workflowContext = workflowJob
      ? await Promise.all([
        getWorkflowComplianceStatus(workflowJob.id).catch((error) => ({ ok: false, error: error.message || "工作流合规状态读取失败" })),
        getWorkflowDeliveryStatus(workflowJob.id).catch((error) => ({ ok: false, error: error.message || "工作流交付状态读取失败" }))
      ])
      : [];
    const reply = workflowJob
      ? buildSkillFirstDirectorReply({
        text,
        files,
        workflowJob,
        compliance: workflowContext[0],
        delivery: workflowContext[1],
        activeStep: req.body?.activeStep
      })
      : buildCodexPptDirectorReply({ text, files, job, activeStep: req.body?.activeStep });
    res.json(reply);
  } catch (error) {
    next(error);
  }
});

app.get("/api/config", async (_req, res) => {
  const env = globalThis.process?.env || {};
  const providers = getProviderConfig(env);
  const editppt = await testEditableRuntime({ timeoutMs: 60000 }).catch((error) => ({
    ok: false,
    error: error.message || "editppt doctor failed"
  }));
  res.json({
    hasApiKey: Boolean(env.OPENAI_API_KEY),
    maskedApiKey: maskSecret(env.OPENAI_API_KEY),
    baseUrl: env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    model: env.OPENAI_MODEL || "gpt-4.1-mini",
    pageSpecModel: env.PAGE_SPEC_MODEL || env.OPENAI_VISION_MODEL || env.OPENAI_MODEL || "gpt-4.1-mini",
    imageModel: env.OPENAI_IMAGE_MODEL || env.CLOUD_IMAGE_MODEL || "gpt-image-2",
    timeoutMs: Number(env.PROVIDER_TIMEOUT_MS || 120000),
    maxRetries: Number(env.PROVIDER_MAX_RETRIES || 2),
    concurrency: Number(env.PROVIDER_CONCURRENCY || 2),
    ocrProvider: env.OCR_PROVIDER || "paddleocr-local",
    ocrFallbackProvider: env.OCR_FALLBACK_PROVIDER || "rapidocr-local",
    ocrPythonPath: env.OCR_PYTHON_PATH || env.PYTHON_PATH || "python",
    editppt: {
      ok: Boolean(editppt.ok),
      textHints: {
        selection: editppt.doctor?.text_hints?.selection || "",
        paddleToken: editppt.doctor?.text_hints?.paddle_token || "unknown",
        applyUrl: editppt.doctor?.text_hints?.apply_url || "https://aistudio.baidu.com/account/accessToken",
        configureCommand: editppt.doctor?.text_hints?.configure_command || "editppt config --paddle-ocr-token <token>"
      },
      error: editppt.error || ""
    },
    providers
  });
});

app.post("/api/config", async (req, res, next) => {
  try {
    const current = await readEnvFile();
    const nextConfig = {
      OPENAI_API_KEY: typeof req.body.apiKey === "string" && req.body.apiKey.trim() ? req.body.apiKey.trim() : current.OPENAI_API_KEY || "",
      OPENAI_BASE_URL: normalizeBaseUrl(req.body.baseUrl || current.OPENAI_BASE_URL || "https://api.openai.com/v1"),
      OPENAI_MODEL: String(req.body.model || current.OPENAI_MODEL || "gpt-4.1-mini").trim(),
      PAGE_SPEC_MODEL: String(req.body.pageSpecModel || current.PAGE_SPEC_MODEL || current.OPENAI_VISION_MODEL || current.OPENAI_MODEL || "gpt-4.1-mini").trim(),
      OPENAI_IMAGE_MODEL: String(req.body.imageModel || current.OPENAI_IMAGE_MODEL || current.CLOUD_IMAGE_MODEL || "gpt-image-2").trim(),
      PROVIDER_TIMEOUT_MS: String(req.body.timeoutMs || current.PROVIDER_TIMEOUT_MS || "120000").trim(),
      PROVIDER_MAX_RETRIES: String(req.body.maxRetries ?? current.PROVIDER_MAX_RETRIES ?? "2").trim(),
      PROVIDER_CONCURRENCY: String(req.body.concurrency || current.PROVIDER_CONCURRENCY || "2").trim(),
      OCR_PROVIDER: String(req.body.ocrProvider || current.OCR_PROVIDER || "paddleocr-local").trim(),
      OCR_FALLBACK_PROVIDER: String(req.body.ocrFallbackProvider || current.OCR_FALLBACK_PROVIDER || "rapidocr-local").trim(),
      OCR_PYTHON_PATH: String(req.body.ocrPythonPath || current.OCR_PYTHON_PATH || current.PYTHON_PATH || "python").trim(),
      PORT: current.PORT || String(port)
    };
    await writeEnvFile(nextConfig);
    Object.assign(globalThis.process.env, nextConfig);
    const providers = getProviderConfig(globalThis.process.env);
    res.json({
      ok: true,
      hasApiKey: Boolean(nextConfig.OPENAI_API_KEY),
      maskedApiKey: maskSecret(nextConfig.OPENAI_API_KEY),
      baseUrl: nextConfig.OPENAI_BASE_URL,
      model: nextConfig.OPENAI_MODEL,
      pageSpecModel: nextConfig.PAGE_SPEC_MODEL,
      imageModel: nextConfig.OPENAI_IMAGE_MODEL,
      timeoutMs: Number(nextConfig.PROVIDER_TIMEOUT_MS),
      maxRetries: Number(nextConfig.PROVIDER_MAX_RETRIES),
      concurrency: Number(nextConfig.PROVIDER_CONCURRENCY),
      ocrProvider: nextConfig.OCR_PROVIDER,
      ocrFallbackProvider: nextConfig.OCR_FALLBACK_PROVIDER,
      ocrPythonPath: nextConfig.OCR_PYTHON_PATH,
      providers
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/config/editppt/paddle-ocr-token", async (req, res) => {
  try {
    const result = await configureEditpptPaddleOcrToken({
      paddleOcrToken: req.body?.paddleOcrToken || req.body?.token || "",
      timeoutMs: req.body?.timeoutMs
    });
    res.json({
      ok: true,
      editppt: {
        ok: result.ok,
        textHints: result.textHints
      }
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "PaddleOCR token configuration failed" });
  }
});

app.post("/api/config/test", async (req, res) => {
  const env = globalThis.process?.env || {};
  const apiKey = String(req.body.apiKey || env.OPENAI_API_KEY || "").trim();
  const baseUrl = normalizeBaseUrl(req.body.baseUrl || env.OPENAI_BASE_URL || "https://api.openai.com/v1");
  const model = String(req.body.model || env.OPENAI_MODEL || "gpt-4.1-mini").trim();

  if (!apiKey) {
    res.status(400).json({ ok: false, error: "请先填写 API Key。" });
    return;
  }

  try {
    const result = await testLlmProvider({ apiKey, baseUrl, model, timeoutMs: req.body.timeoutMs, maxRetries: req.body.maxRetries });
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    res.json({
      ...result,
      ok: true,
      message: `API 连接成功，使用地址：${result.provider?.baseUrl || baseUrl}`,
      usedBaseUrl: result.provider?.baseUrl || baseUrl
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "API 连接失败。" });
  }
});

app.post("/api/config/models", async (req, res) => {
  const env = globalThis.process?.env || {};
  const apiKey = String(req.body.apiKey || env.OPENAI_API_KEY || "").trim();
  const baseUrl = normalizeBaseUrl(req.body.baseUrl || env.OPENAI_BASE_URL || "https://api.openai.com/v1");

  if (!apiKey) {
    res.status(400).json({ ok: false, error: "请先填写 API Key。" });
    return;
  }

  try {
    const result = await listLlmModels({ apiKey, baseUrl, timeoutMs: req.body.timeoutMs, maxRetries: req.body.maxRetries });
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    res.json({
      ...result,
      ok: true,
      models: result.chatModels,
      imageModels: result.imageModels || [],
      usedBaseUrl: result.provider?.baseUrl || baseUrl
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "模型列表获取失败。" });
  }
});

app.get("/api/providers", (_req, res) => {
  res.json({ ok: true, providers: getProviderConfig() });
});

app.post("/api/providers/test", async (req, res) => {
  try {
    const target = req.body?.target || "all";
    const overrides = {
      apiKey: req.body?.apiKey,
      baseUrl: req.body?.baseUrl,
      model: req.body?.model,
      timeoutMs: req.body?.timeoutMs,
      maxRetries: req.body?.maxRetries,
      concurrency: req.body?.concurrency,
      provider: req.body?.ocrProvider,
      pythonPath: req.body?.ocrPythonPath,
      generateProbe: Boolean(req.body?.generateProbe)
    };
    const result = {};
    if (target === "all" || target === "llm") result.llm = await testLlmProvider(overrides);
    if (target === "all" || target === "image") result.image = await testImageProvider({ ...overrides, model: req.body?.imageModel || req.body?.model });
    if (target === "all" || target === "ocr") result.ocr = await testOcrProvider(overrides);
    res.json({ ok: Object.values(result).every((item) => item?.ok), result });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "Provider test failed" });
  }
});

app.get("/api/local-image/status", async (_req, res) => {
  res.json(await checkLocalImageStatus());
});

app.post("/api/local-image/test", async (req, res, next) => {
  try {
    const record = await generateLocalImage({
      prompt: req.body?.prompt || "A clean oriental natural style product presentation background, rice paper texture, olive green and warm red, no text, premium PPT visual asset",
      width: req.body?.width || 768,
      height: req.body?.height || 768,
      steps: req.body?.steps || 8,
      seed: req.body?.seed || Date.now(),
      textSafeArea: req.body?.textSafeArea || "",
      prefix: "ppt_local_zimage_test"
    });
    res.json({ ok: true, image: normalizeUploadRecord(record), record });
  } catch (error) {
    next(error);
  }
});

app.post("/api/uploads", upload.array("files"), async (req, res, next) => {
  try {
    const records = [];
    for (const file of req.files || []) records.push(await addUpload(file));
    res.json({ files: records.map(normalizeUploadRecord) });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/uploads/:id", async (req, res, next) => {
  try {
    const deleted = await deleteUpload(req.params.id);
    if (!deleted) return res.json({ ok: true, missing: true, deleted: { id: req.params.id } });
    res.json({ ok: true, deleted: { id: deleted.id, originalName: deleted.originalName } });
  } catch (error) {
    next(error);
  }
});

app.get("/api/style-references", async (_req, res, next) => {
  try {
    const references = await listStyleReferences();
    res.json({ references: references.map(normalizeStyleReference) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/style-references", upload.array("files"), async (req, res, next) => {
  try {
    const records = [];
    for (const file of req.files || []) records.push(await addStyleReference(file, req.body || {}));
    res.json({ references: records.map(normalizeStyleReference) });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/style-references/:id", async (req, res, next) => {
  try {
    const updated = await updateStyleReference(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: "可选参考图不存在。" });
    res.json({ reference: normalizeStyleReference(updated) });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/style-references/:id", async (req, res, next) => {
  try {
    const deleted = await deleteStyleReference(req.params.id);
    if (!deleted) return res.json({ ok: true, missing: true, deleted: { id: req.params.id } });
    res.json({ ok: true, deleted: { id: deleted.id, name: deleted.name } });
  } catch (error) {
    next(error);
  }
});

app.get("/api/workflow-jobs/meta", async (_req, res) => {
  const primaryJobId = getPrimaryWorkflowJobId();
  const primaryJob = primaryJobId
    ? await readWorkflowJob(primaryJobId).catch(() => null)
    : null;
  const primaryWorkflow = buildPrimaryWorkflowPayload(primaryJob);
  res.json({
    ok: true,
    rootDir: workflowRootDir,
    primaryWorkflowJobId: primaryJobId,
    primaryWorkflow,
    primaryWorkflowJob: primaryJob ? toClientWorkflowJob(primaryJob, { primaryWorkflow }) : null,
    stages: WORKFLOW_STAGE_ORDER,
    stageStatuses: WORKFLOW_STAGE_STATUS,
    pageStatuses: WORKFLOW_PAGE_STATUS
  });
});

app.get("/api/workflow-jobs", async (req, res, next) => {
  try {
    const includeInternal = isTruthyQuery(req.query?.includeInternal);
    const includeArchived = isTruthyQuery(req.query?.includeArchived);
    const requestedLimit = Number(req.query?.limit || 120);
    const requestedOffset = Number(req.query?.offset || 0);
    const limit = Number.isFinite(requestedLimit) ? Math.min(500, Math.max(1, Math.floor(requestedLimit))) : 120;
    const offset = Number.isFinite(requestedOffset) ? Math.max(0, Math.floor(requestedOffset)) : 0;
    const allJobs = await listWorkflowJobSummaries();
    const primaryJobId = getPrimaryWorkflowJobId();
    const primaryJob = primaryJobId ? await readWorkflowJob(primaryJobId).catch(() => null) : null;
    const visibleByInternal = includeInternal ? allJobs : allJobs.filter((job) => !isInternalWorkflowJob(job));
    const jobs = includeArchived ? visibleByInternal : visibleByInternal.filter((job) => !isArchivedWorkflowJob(job));
    const pagedSummaries = jobs.slice(offset, offset + limit);
    const pagedJobs = await readWorkflowJobsByIds(pagedSummaries.map((job) => job.id));
    const primaryWorkflow = buildPrimaryWorkflowPayload(primaryJob);
    const clientJobs = pagedJobs.map((job) => toClientWorkflowJob(job, { primaryWorkflow }));
    const shouldAddPrimarySummary = primaryWorkflow.found
      && !includeInternal
      && (!isArchivedWorkflowJob(primaryJob) || includeArchived)
      && !clientJobs.some((job) => job.id === primaryWorkflow.id);
    const publicJobs = shouldAddPrimarySummary ? [buildPrimaryWorkflowListItem(primaryWorkflow), ...clientJobs] : clientJobs;
    res.json({
      jobs: publicJobs,
      primaryWorkflow,
      hiddenInternalCount: allJobs.length - visibleByInternal.length,
      hiddenArchivedCount: visibleByInternal.length - jobs.length,
      totalCount: jobs.length,
      returnedCount: pagedSummaries.length,
      offset,
      limit,
      hasMore: offset + pagedSummaries.length < jobs.length,
      nextOffset: offset + pagedSummaries.length
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/workflow-jobs/cleanup/preview", async (req, res, next) => {
  try {
    const preview = await previewWorkflowJobCleanup(readWorkflowCleanupOptions(req.query || {}));
    res.json(preview);
  } catch (error) {
    next(error);
  }
});

app.post("/api/workflow-jobs/cleanup/archive", async (req, res, next) => {
  try {
    const result = await archiveWorkflowJobCleanup({
      ...readWorkflowCleanupOptions(req.body || {}),
      archivedBy: cleanClientText(req.body?.archivedBy || "operator-cleanup"),
      reason: cleanClientText(req.body?.reason || "soft cleanup archive")
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/workflow-jobs", async (req, res, next) => {
  try {
    const sourceUploadId = cleanClientText(req.body?.sourceUploadId || "");
    const sourceUpload = sourceUploadId ? (await getUploads([sourceUploadId]))[0] || null : null;
    if (sourceUploadId && !sourceUpload) {
      res.status(404).json({ error: "Source upload not found" });
      return;
    }
    const job = await createWorkflowJob({
      sourceUpload,
      sourceUploadId,
      sourceOriginalName: req.body?.sourceOriginalName || "",
      sourceMimeType: req.body?.sourceMimeType || "",
      sourceSize: req.body?.sourceSize || 0,
      sourceBrief: req.body?.sourceBrief || req.body?.brief || "",
      projectName: req.body?.projectName || "",
      mode: req.body?.mode || "ppt-rebuild",
      generationRoute: req.body?.generationRoute || "image-fidelity",
      deliveryMode: req.body?.deliveryMode || "visual",
      spendBudget: req.body?.spendBudget || {},
      notes: req.body?.notes || "",
      internal: req.body?.internal === true
    });
    res.json(toClientWorkflowJob(job));
  } catch (error) {
    next(error);
  }
});

app.post("/api/workflow-cost-preview", (req, res, next) => {
  try {
    res.json(getWorkflowCostPreview({
      pageCount: req.body?.pageCount,
      deliveryMode: req.body?.deliveryMode,
      contingencyRate: 0.2
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/workflow-jobs/:id", async (req, res, next) => {
  try {
    const job = await readWorkflowJob(req.params.id).catch((error) => {
      if (/ENOENT|Invalid workflow job id/.test(error.message || "")) return null;
      throw error;
    });
    if (!job) {
      res.status(404).json({ error: "Workflow job not found" });
      return;
    }
    const primaryJobId = getPrimaryWorkflowJobId();
    const primaryJob = primaryJobId ? await readWorkflowJob(primaryJobId).catch(() => null) : null;
    if (!canExposeWorkflowJob(job, primaryJob)) {
      res.status(404).json({ error: "Workflow job not found" });
      return;
    }
    const primaryWorkflow = buildPrimaryWorkflowPayload(primaryJob);
    res.json(toClientWorkflowJob(job, { includeEvents: true, primaryWorkflow }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/workflow-jobs/:id/archive", async (req, res, next) => {
  try {
    const job = await archiveWorkflowJob(req.params.id, req.body || {});
    res.json(toClientWorkflowJob(job, { includeEvents: true }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/workflow-jobs/:id/restore", async (req, res, next) => {
  try {
    const job = await restoreWorkflowJob(req.params.id, req.body || {});
    res.json(toClientWorkflowJob(job, { includeEvents: true }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/workflow-jobs/:id/delivery-status", async (req, res, next) => {
  try {
    const delivery = await getWorkflowDeliveryStatus(req.params.id);
    res.json(delivery);
  } catch (error) {
    next(error);
  }
});

app.get("/api/workflow-jobs/:id/compliance", async (req, res, next) => {
  try {
    const compliance = await getWorkflowComplianceStatus(req.params.id);
    res.json(compliance);
  } catch (error) {
    next(error);
  }
});

app.get("/api/workflow-jobs/:id/cost-estimate", async (req, res, next) => {
  try {
    const estimate = await getWorkflowCostEstimate(req.params.id);
    res.json(estimate);
  } catch (error) {
    next(error);
  }
});

app.get("/api/workflow-jobs/:id/v1-readiness", async (req, res, next) => {
  try {
    const readiness = await getWorkflowV1Readiness(req.params.id);
    res.json(readiness);
  } catch (error) {
    next(error);
  }
});

app.get("/api/business-readiness", async (_req, res, next) => {
  try {
    res.json(await getWorkflowBusinessReadiness());
  } catch (error) {
    next(error);
  }
});

async function buildLatestV1AcceptancePayload() {
  const [report, productVisualReadiness] = await Promise.all([
    getLatestV1AcceptanceReport(),
    getLatestProductVisualReadiness()
  ]);
  const readinessAlignment = alignProductVisualReadinessWithLatestReport(report, productVisualReadiness);
  const alignedProductVisualReadiness = {
    ...productVisualReadiness,
    ...readinessAlignment
  };
  const alignedReport = hydrateProductVisualActionPayload(report, readinessAlignment);
  return {
    ...alignedReport,
    productVisualReadiness: alignedProductVisualReadiness
  };
}

async function buildLlmProviderRecoveryPreflight() {
  const report = await getLatestV1AcceptanceReport();
  const providers = getProviderConfig();
  const llm = providers.llm || {};
  const completionAudit = report.completionAudit || report.acceptance?.completionAudit || {};
  const editableStep = Array.isArray(completionAudit.nextSteps)
    ? completionAudit.nextSteps.find((step) => step.id === "recover-llm-and-run-model-editable-workers")
    : null;
  const recentFailure = detectLlmProviderFailure(report.latest || report);
  const recoveryRequired = Boolean(
    completionAudit.blockerSummary?.llmProviderActionRequired
    || editableStep?.requiresLlmProviderRecovery
    || recentFailure.found
  );
  const configured = Boolean(llm.configured);
  const readyIfUserConfirmed = Boolean(configured && recoveryRequired);
  const blockingIssues = [];
  if (!configured) blockingIssues.push("LLM provider is not configured.");
  if (!recoveryRequired) blockingIssues.push("Latest v1 report does not require LLM recovery.");
  return {
    ok: true,
    preview: true,
    didRun: false,
    paidImageGeneration: false,
    externalImageCalls: 0,
    llmApiCalls: 0,
    safeToRunAutomatically: true,
    requiresExplicitUserConfirmation: recoveryRequired,
    recoveryRequired,
    ready: readyIfUserConfirmed,
    readyIfUserConfirmed,
    startReady: false,
    blockingIssues,
    provider: {
      configured,
      provider: llm.provider || "",
      baseUrl: llm.baseUrl || "",
      model: llm.model || "",
      maskedApiKey: llm.maskedApiKey || ""
    },
    recentFailure,
    nextActions: recoveryRequired
      ? [
        "Check or recharge the LLM provider account; do not change gpt-image-2 for this blocker.",
        "Run fresh editable local preparation preflights.",
        "Run editable worker model preflight for pages 1-2.",
        "Only start the model worker after confirming LLM provider recovery and external spend."
      ]
      : [
        "No LLM recovery blocker is recorded in the latest v1 report."
      ],
    summary: recoveryRequired
      ? configured
        ? "LLM provider is configured, but the editable rebuild still requires explicit recovery confirmation before model workers run."
        : "LLM provider recovery is required, but the provider is not configured."
      : "Latest v1 report does not require LLM provider recovery."
  };
}

async function buildEditableRebuildReadinessPreflight() {
  const report = await getLatestV1AcceptanceReport();
  const completionAudit = report.completionAudit || report.acceptance?.completionAudit || {};
  const editableStep = Array.isArray(completionAudit.nextSteps)
    ? completionAudit.nextSteps.find((step) => step.id === "recover-llm-and-run-model-editable-workers")
    : null;
  const jobId = editableStep?.paidAction?.path?.match(/\/api\/workflow-jobs\/([^/]+)\//)?.[1] || report.latest?.jobId || "";
  const decodedJobId = jobId ? decodeURIComponent(jobId) : "";
  const llm = await buildLlmProviderRecoveryPreflight();
  const freshRun = decodedJobId ? await buildFreshRunRecoveryPreflight(decodedJobId) : null;
  const taskSync = decodedJobId ? await buildEditableWorkerTaskSyncPreflight(decodedJobId) : null;
  const workerBatch = decodedJobId
    ? await getWorkflowEditableWorkerBatchPreflight(decodedJobId, {
      mode: "model",
      maxPages: 2,
      pages: "1-2",
      requireLlmProviderRecovery: Boolean(llm.recoveryRequired)
    }).catch((error) => ({
      ok: false,
      ready: false,
      startReady: false,
      error: error.message || "Editable worker batch preflight failed"
    }))
    : null;
  const workerBatchReady = Boolean(workerBatch?.ready);
  const localPreparationReady = Boolean(freshRun?.ready && taskSync?.ready);
  const localPreparationRequired = Boolean(localPreparationReady && !workerBatchReady);
  const checks = [
    {
      id: "llm-provider",
      label: "LLM provider",
      ok: Boolean(llm.readyIfUserConfirmed || llm.ready),
      detail: llm.summary || ""
    },
    {
      id: "fresh-editable-run",
      label: "Fresh editable run",
      ok: Boolean(freshRun?.ready),
      detail: freshRun?.summary || "No v1 workflow job found."
    },
    {
      id: "editable-task-sync",
      label: "Editable task sync",
      ok: Boolean(taskSync?.ready),
      detail: taskSync?.summary || "No v1 workflow job found."
    },
    {
      id: "editable-worker-batch",
      label: "Editable worker batch",
      ok: workerBatchReady,
      detail: localPreparationRequired
        ? "Local editable preparation must run before model page workers can select pages."
        : Array.isArray(workerBatch?.blockingIssues) && workerBatch.blockingIssues.length
        ? workerBatch.blockingIssues.slice(0, 2).join("; ")
        : workerBatch?.summary || ""
    }
  ];
  const hardChecks = localPreparationRequired
    ? checks.filter((check) => check.id !== "editable-worker-batch")
    : checks;
  const readyIfConfirmed = checks.every((check) => check.ok);
  const localPreparationStartReady = Boolean(localPreparationRequired && hardChecks.every((check) => check.ok));
  const nextActions = readyIfConfirmed
    ? [
      "Confirm LLM provider recovery.",
      "Confirm external spend before running model editable workers.",
      "Run 1-2 pages first, then review page-level PPTX output."
    ]
    : localPreparationStartReady
      ? [
        "Run fresh editable run recovery first; this clears stale editable evidence and rebuilds editppt inputs.",
        "Run editable worker task sync after fresh recovery.",
        "Then rerun this readiness preflight before starting model page workers."
      ]
      : checks.filter((check) => !check.ok).map((check) => `${check.label}: ${check.detail}`);
  const acceptancePlan = buildEditableRebuildAcceptancePlan({
    jobId: decodedJobId,
    workerBatch,
    llm,
    readyIfConfirmed
  });
  return {
    ok: true,
    preview: true,
    didRun: false,
    paidImageGeneration: false,
    externalImageCalls: 0,
    llmApiCalls: 0,
    safeToRunAutomatically: true,
    ready: readyIfConfirmed,
    readyIfConfirmed,
    localPreparationRequired,
    localPreparationStartReady,
    startReady: false,
    requiresExplicitSpendConfirmation: true,
    requiresLlmProviderRecovery: Boolean(llm.recoveryRequired),
    jobId: decodedJobId,
    checks,
    llm,
    freshRun,
    taskSync,
    workerBatch,
    acceptancePlan,
    nextActions,
    summary: readyIfConfirmed
      ? "Editable rebuild is ready for an explicitly confirmed 1-2 page model-worker run."
      : localPreparationStartReady
        ? "Editable rebuild needs local preparation before model workers can run; no external image or LLM call is needed for this preparation."
      : "Editable rebuild is not ready; review failed checks before running model workers."
  };
}

async function buildEditableLoopAcceptancePreflight(options = {}) {
  const readiness = await buildEditableRebuildReadinessPreflight();
  const plan = readiness.acceptancePlan || {};
  const jobId = String(options.jobId || plan.jobId || readiness.jobId || "").trim();
  const selectedPageIds = normalizeAcceptancePageIds(options.pages || options.pageIds || plan.selectedPageIds || ["page_001", "page_002"]);
  const delivery = jobId
    ? await getWorkflowDeliveryStatus(jobId).catch((error) => ({
      ok: false,
      error: error.message || "Workflow delivery status failed",
      pageEvidence: null,
      finalGate: null,
      final: null,
      finalEvidence: null
    }))
    : null;
  const pages = Array.isArray(delivery?.pageEvidence?.pages) ? delivery.pageEvidence.pages : [];
  const selectedPages = selectedPageIds.map((pageId) => pages.find((page) => page.pageId === pageId) || { pageId, complete: false, issues: ["page-evidence-missing"] });
  const selectedComplete = selectedPages.length > 0 && selectedPages.every((page) => page.complete === true);
  const finalGate = delivery?.finalGate || {};
  const finalArtifact = delivery?.final?.artifact || null;
  const finalEvidence = delivery?.finalEvidence || null;
  const checks = [
    {
      id: "selected-page-evidence",
      label: "Selected page evidence",
      ok: selectedComplete,
      detail: `${selectedPages.filter((page) => page.complete).length}/${selectedPages.length} selected page(s) complete`,
      pages: selectedPages.map((page) => ({
        pageId: page.pageId,
        complete: Boolean(page.complete),
        pagePptxOpenable: page.pagePptxOpenable ?? null,
        validationPassed: Boolean(page.validationPassed),
        manifestContractOk: Boolean(page.manifestContractOk),
        issues: Array.isArray(page.issues) ? page.issues : []
      }))
    },
    {
      id: "final-pptx",
      label: "Fresh editable-final.pptx",
      ok: Boolean(finalArtifact?.path),
      detail: finalArtifact?.path || "editable-final.pptx is missing"
    },
    {
      id: "final-powerpoint-openable",
      label: "Final PPTX opens in PowerPoint",
      ok: finalEvidence?.summary?.powerPointOpenable === true || finalArtifact?.powerPointOpenability?.openable === true,
      detail: finalEvidence?.powerPointOpenability?.error || finalArtifact?.powerPointOpenability?.error || ""
    },
    {
      id: "delivery-gate",
      label: "Delivery gate",
      ok: finalGate.productReady === true,
      detail: finalGate.summary || finalGate.label || "Delivery gate is not ready",
      reasons: [...(Array.isArray(finalGate.reasons) ? finalGate.reasons : []), ...(Array.isArray(finalGate.warnings) ? finalGate.warnings : [])].slice(0, 8)
    }
  ];
  const ready = Boolean(checks.every((check) => check.ok));
  return {
    ok: true,
    preview: true,
    didRun: false,
    paidImageGeneration: false,
    externalImageCalls: 0,
    llmApiCalls: 0,
    safeToRunAutomatically: true,
    ready,
    jobId,
    selectedPageIds,
    checks,
    delivery: delivery ? {
      ok: delivery.ok,
      status: delivery.status || null,
      finalGate,
      pageEvidenceSummary: delivery.pageEvidence?.summary || null,
      finalEvidenceSummary: delivery.finalEvidence?.summary || null
    } : null,
    nextActions: ready
      ? [
        "Run full 15-page product acceptance after reviewing the 1-2 page output."
      ]
      : buildEditableLoopAcceptanceNextActions(checks),
    summary: ready
      ? "1-2 page editable rebuild loop has product delivery evidence."
      : "1-2 page editable rebuild loop is not accepted yet; review failed checks before v1 completion."
  };
}

function buildEditableRebuildAcceptancePlan({ jobId = "", workerBatch = null, llm = null, readyIfConfirmed = false } = {}) {
  const selectedPageIds = Array.isArray(workerBatch?.selectedPageIds) ? workerBatch.selectedPageIds : [];
  const externalImageCalls = Number(workerBatch?.authorization?.imageCalls || selectedPageIds.length || 0);
  const startBody = workerBatch?.startBody || {};
  return {
    version: 1,
    scope: "product-editable-rebuild-sample",
    jobId,
    readyIfConfirmed: Boolean(readyIfConfirmed),
    selectedPageIds,
    selectedCount: selectedPageIds.length,
    estimatedExternalImageCalls: externalImageCalls,
    requiresExplicitSpendConfirmation: true,
    requiresLlmProviderRecovery: Boolean(llm?.recoveryRequired || workerBatch?.requiredConfirmations?.llmProviderRecovered?.required),
    noSilentSpend: true,
    startRequest: {
      method: "POST",
      path: jobId ? `/api/workflow-jobs/${encodeURIComponent(jobId)}/editable/worker-runs` : "",
      body: {
        mode: "model",
        maxPages: selectedPageIds.length || 2,
        pages: startBody.pages || selectedPageIds.join(","),
        confirmExternalImageSpend: true,
        confirmLlmProviderRecovered: true,
        requireLlmProviderRecovery: true,
        acceptOfflineTextHints: true,
        autoFinalize: true
      }
    },
    verificationPreflight: {
      method: "POST",
      path: "/api/v1-acceptance/editable-loop-acceptance/preflight",
      body: {
        jobId,
        pages: selectedPageIds.join(",")
      },
      paidImageGeneration: false,
      externalImageCalls: 0,
      llmApiCalls: 0,
      safeToRunAutomatically: true
    },
    requiredConfirmations: [
      {
        id: "llm-provider-recovered",
        label: "LLM provider recovered",
        required: true,
        satisfied: Boolean(workerBatch?.requiredConfirmations?.llmProviderRecovered?.confirmed),
        evidence: llm?.provider?.model || workerBatch?.llmProvider?.model || ""
      },
      {
        id: "external-image-spend",
        label: "External image API spend confirmed",
        required: true,
        satisfied: Boolean(workerBatch?.requiredConfirmations?.externalImageSpend?.confirmed),
        evidence: `${externalImageCalls} image call(s)`
      },
      {
        id: "rapidocr-text-hints",
        label: "OCR/text hints accepted",
        required: true,
        satisfied: Boolean(workerBatch?.requiredConfirmations?.offlineTextHints?.confirmed),
        evidence: workerBatch?.requiredConfirmations?.offlineTextHints?.reason || ""
      }
    ],
    expectedArtifacts: [
      "page_result.json for each selected page",
      "validation.json with passed=true for each selected page",
      "manifest.json with editable object evidence",
      "page.pptx that opens in PowerPoint for each selected page",
      "fresh editable-final.pptx after finalize",
      "editable validation report and delivery gate evidence"
    ],
    acceptanceChecks: [
      { id: "page-pptx-openable", label: "Each page-level PPTX opens in PowerPoint" },
      { id: "editable-objects", label: "Pages contain editable text/shapes, not a full-slide screenshot" },
      { id: "product-rebuild-evidence", label: "Page records are model image-to-editable-ppt rebuild evidence" },
      { id: "fresh-final", label: "Finalize creates a new editable-final.pptx from current page records" },
      { id: "delivery-gate", label: "Delivery gate allows download only after product rebuild evidence is valid" }
    ],
    failureRecovery: [
      "If a selected page fails, reset only that page and rerun the model worker for the failed page.",
      "If the provider returns quota/auth errors, keep final delivery blocked until provider recovery is confirmed and pages are rerun.",
      "Do not reuse stale editable-final.pptx or local text-only evidence as product delivery."
    ]
  };
}

function normalizeAcceptancePageIds(value = []) {
  const rawItems = Array.isArray(value) ? value : String(value || "").split(/[,\s]+/);
  const pageIds = rawItems
    .flatMap((item) => String(item || "").split(/[,\s]+/))
    .map((item) => {
      const text = String(item || "").trim().toLowerCase();
      if (!text) return "";
      const match = text.match(/\d+/);
      return match ? `page_${String(Number(match[0])).padStart(3, "0")}` : /^page_\d{3}$/.test(text) ? text : "";
    })
    .filter(Boolean);
  return [...new Set(pageIds.length ? pageIds : ["page_001", "page_002"])];
}

function buildEditableLoopAcceptanceNextActions(checks = []) {
  const failed = checks.filter((check) => !check.ok).map((check) => check.id);
  const actions = [];
  if (failed.includes("selected-page-evidence")) actions.push("Run or rerun the selected image-to-editable-ppt model page workers, then record page evidence.");
  if (failed.includes("final-pptx")) actions.push("Finalize the editable run after selected page records are valid.");
  if (failed.includes("final-powerpoint-openable")) actions.push("Repair or regenerate the final PPTX until PowerPoint can open it.");
  if (failed.includes("delivery-gate")) actions.push("Resolve delivery gate reasons before exposing final download.");
  return actions.length ? actions : ["Review editable rebuild evidence."];
}

function detectLlmProviderFailure(source = {}) {
  const text = JSON.stringify(source || {});
  if (/额度已用尽|余额|insufficient[_\s-]?quota|quota|credit|billing/i.test(text)) {
    return {
      found: true,
      kind: "provider-quota-exhausted",
      message: "Recent evidence mentions LLM provider quota, balance, credit, or billing failure."
    };
  }
  if (/HTTP\s*401|unauthorized|invalid.*api.*key|api.*key.*invalid/i.test(text)) {
    return {
      found: true,
      kind: "provider-auth-failed",
      message: "Recent evidence mentions LLM provider authorization failure."
    };
  }
  return { found: false, kind: "", message: "" };
}

async function buildFreshRunRecoveryPreflight(jobId) {
  const job = await readWorkflowJob(jobId);
  const artifacts = job.artifacts || {};
  const visualImages = Array.isArray(artifacts.visualImages) ? artifacts.visualImages.length : 0;
  const imageDeckReady = Boolean(artifacts.imageDeck?.path || artifacts.imageDeck?.relativePath);
  const editablePreparePreflight = await getWorkflowEditablePreparePreflight(jobId).catch((error) => ({
    ok: false,
    ready: false,
    startReady: false,
    blockingIssues: [error.message || "Editable prepare preflight failed"],
    checks: []
  }));
  const visualQualityCheck = Array.isArray(editablePreparePreflight.checks)
    ? editablePreparePreflight.checks.find((check) => check.id === "visual-quality")
    : null;
  const visualQualityExists = Boolean(editablePreparePreflight.visualQuality?.path || artifacts.visualQuality?.path);
  const visualQualityNeedsApproval = Boolean(visualQualityExists && visualQualityCheck && !visualQualityCheck.ok);
  const existingKeys = [
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
  const ready = Boolean((visualImages || imageDeckReady) && editablePreparePreflight.ready);
  return {
    ok: true,
    preview: true,
    didRun: false,
    ready,
    startReady: ready,
    localOnly: true,
    paidImageGeneration: false,
    externalImageCalls: 0,
    mutatesOnRun: true,
    safeToRunAutomatically: false,
    requiresExplicitUserConfirmation: true,
    jobId: job.id,
    visualImages,
    imageDeckReady,
    editablePreparePreflight,
    visualQualityReady: Boolean(visualQualityCheck?.ok),
    visualQualityRecovery: visualQualityCheck?.ok || visualQualityExists ? null : {
      method: "POST",
      path: `/api/workflow-jobs/${encodeURIComponent(job.id)}/visual-quality/rebuild-from-existing`,
      preflight: {
        method: "POST",
        path: `/api/workflow-jobs/${encodeURIComponent(job.id)}/visual-quality/rebuild-from-existing/preflight`,
        body: {},
        paidImageGeneration: false,
        externalImageCalls: 0,
        safeToRunAutomatically: true
      },
      body: {},
      paidImageGeneration: false,
      externalImageCalls: 0,
      safeToRunAutomatically: false,
      requiresExplicitUserConfirmation: true,
      sideEffect: "Writes a local visual quality report from existing visual images."
    },
    visualQualityReview: visualQualityNeedsApproval ? {
      method: "POST",
      path: `/api/workflow-jobs/${encodeURIComponent(job.id)}/visual-quality/review/approve`,
      body: {
        reviewer: "product-agent",
        note: "visual quality report reviewed before editable rebuild"
      },
      paidImageGeneration: false,
      externalImageCalls: 0,
      safeToRunAutomatically: false,
      requiresExplicitUserConfirmation: true,
      sideEffect: "Approves the current visual quality report for editable prepare."
    } : null,
    invalidates: existingKeys,
    summary: ready
      ? "Fresh editable run recovery is ready. Running it will clear stale editable evidence and rebuild local editppt inputs."
      : visualQualityCheck && !visualQualityCheck.ok
        ? `Fresh editable run recovery needs visual quality evidence first: ${visualQualityCheck.detail || "visual quality report missing"}.`
        : "Fresh editable run recovery is not ready because no visual page evidence is available."
  };
}

async function buildVisualQualityRebuildFromExistingPreflight(jobId) {
  const job = await readWorkflowJob(jobId);
  const visualImages = await discoverVisualImages(job.dirs.visualImages, job.artifacts?.visualManifest?.path || "");
  const renderedPages = Array.isArray(job.artifacts?.renderedPages) ? job.artifacts.renderedPages : [];
  const ready = Boolean(visualImages.length && renderedPages.length);
  return {
    ok: true,
    preview: true,
    didRun: false,
    localOnly: true,
    paidImageGeneration: false,
    externalImageCalls: 0,
    safeToRunAutomatically: true,
    ready,
    startReady: ready,
    jobId: job.id,
    visualImageCount: visualImages.length,
    renderedPageCount: renderedPages.length,
    existingVisualQuality: job.artifacts?.visualQuality || null,
    blockingIssues: [
      ...(!visualImages.length ? ["No existing visual images found."] : []),
      ...(!renderedPages.length ? ["No rendered source pages found for visual quality comparison."] : [])
    ],
    summary: ready
      ? "Existing visual images can be locally analyzed to rebuild the visual quality report."
      : "Visual quality report cannot be rebuilt until visual images and rendered pages exist."
  };
}

async function rebuildVisualQualityFromExisting(jobId) {
  const preflight = await buildVisualQualityRebuildFromExistingPreflight(jobId);
  if (!preflight.ready) {
    const error = new Error(preflight.summary || "Visual quality rebuild preflight failed.");
    error.preflight = preflight;
    throw error;
  }
  const job = await readWorkflowJob(jobId);
  const visualImages = await discoverVisualImages(job.dirs.visualImages, job.artifacts?.visualManifest?.path || "");
  const renderedPages = Array.isArray(job.artifacts?.renderedPages) ? job.artifacts.renderedPages : [];
  const visualQuality = await writeVisualQualityReport(job, visualImages, renderedPages);
  const stat = await fs.stat(visualQuality.path).catch(() => null);
  job.artifacts = {
    ...(job.artifacts || {}),
    visualImages,
    visualQuality: {
      kind: "visual_quality_report",
      path: visualQuality.path,
      relativePath: path.relative(rootDir, visualQuality.path),
      size: stat?.size || 0,
      createdAt: new Date().toISOString(),
      summary: visualQuality.summary
    }
  };
  const visualTextQuality = job.artifacts?.visualOcrTextHints?.path
    ? await writeWorkflowVisualTextQualityReport(job)
    : null;
  addEvent(job, "visual_quality.rebuilt", "Rebuilt visual quality report from existing visual images", {
    pageCount: visualQuality.summary?.pageCount || visualImages.length,
    reviewCount: visualQuality.summary?.reviewCount || 0,
    failedCount: visualQuality.summary?.failedCount || 0,
    semanticBlockedCount: visualTextQuality?.report?.summary?.blockedCount || 0
  });
  const saved = await saveWorkflowJob(job);
  return {
    ok: true,
    localOnly: true,
    paidImageGeneration: false,
    externalImageCalls: 0,
    jobId: saved.id,
    visualQuality: saved.artifacts?.visualQuality || null,
    summary: "Visual quality report was rebuilt locally from existing visual images.",
    job: toClientWorkflowJob(saved, { includeEvents: true })
  };
}

async function buildEditableWorkerTaskSyncPreflight(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const promptBundle = await listWorkflowEditableWorkerPrompts(jobId, options);
  const existingTasks = Array.isArray(job.artifacts?.editableWorkerTasks) ? job.artifacts.editableWorkerTasks : [];
  const ready = Boolean(promptBundle.prompts?.length);
  return {
    ok: true,
    preview: true,
    didRun: false,
    ready,
    startReady: ready,
    localOnly: true,
    paidImageGeneration: false,
    externalImageCalls: 0,
    mutatesOnRun: true,
    safeToRunAutomatically: false,
    requiresExplicitUserConfirmation: true,
    jobId: job.id,
    promptCount: promptBundle.prompts?.length || 0,
    existingTaskCount: existingTasks.length,
    summary: ready
      ? "Editable worker task sync is ready. Running it will refresh the local page task queue from current prompts."
      : "Editable worker task sync is not ready because editable page prompts are missing."
  };
}

app.get("/api/v1-acceptance", async (_req, res, next) => {
  try {
    res.json(await buildLatestV1AcceptancePayload());
  } catch (error) {
    next(error);
  }
});

app.get("/api/v1-acceptance/latest", async (_req, res, next) => {
  try {
    res.json(await buildLatestV1AcceptancePayload());
  } catch (error) {
    next(error);
  }
});

app.get("/api/v1-acceptance/run", async (_req, res, next) => {
  try {
    res.json(await getV1AcceptanceRunStatus());
  } catch (error) {
    next(error);
  }
});

app.post("/api/v1-acceptance/preflight", async (req, res, next) => {
  try {
    res.json(await preflightV1AcceptanceRun(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/v1-acceptance/run", async (req, res, next) => {
  try {
    res.json(await startV1AcceptanceRun(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/v1-acceptance/product-visual-readiness", async (req, res, next) => {
  try {
    res.json(await runProductVisualReadinessNoCost(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/v1-acceptance/llm-provider-recovery/preflight", async (_req, res, next) => {
  try {
    res.json(await buildLlmProviderRecoveryPreflight());
  } catch (error) {
    next(error);
  }
});

app.post("/api/v1-acceptance/editable-rebuild-readiness/preflight", async (_req, res, next) => {
  try {
    res.json(await buildEditableRebuildReadinessPreflight());
  } catch (error) {
    next(error);
  }
});

app.post("/api/v1-acceptance/editable-loop-acceptance/preflight", async (req, res, next) => {
  try {
    res.json(await buildEditableLoopAcceptancePreflight(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/v1-acceptance/product-visual-sample/preflight", async (req, res, next) => {
  try {
    res.json(await getProductVisualSamplePreflight(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/v1-acceptance/product-visual-full-deck/preflight", async (req, res, next) => {
  try {
    res.json(await getProductVisualFullDeckPreflight(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/v1-acceptance/product-visual-sample/prompt-preview", async (req, res, next) => {
  try {
    res.json(await getProductVisualSamplePromptPreview(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/v1-acceptance/product-visual-sample/run", async (req, res, next) => {
  try {
    res.json(await runProductVisualSample(req.body || {}));
  } catch (error) {
    if (error?.preflight || error?.requiredConfirmation) {
      res.status(error.status || 409).json({
        ok: false,
        code: error.code || "PRODUCT_VISUAL_SAMPLE_NOT_READY",
        error: error.message || "Product visual sample run is not ready.",
        requiredConfirmation: error.requiredConfirmation || "",
        externalImageCalls: error.externalImageCalls || 1,
        preflight: error.preflight || null
      });
      return;
    }
    next(error);
  }
});

app.post("/api/v1-acceptance/product-visual-sample/approval/preflight", async (req, res, next) => {
  try {
    res.json(await getProductVisualSampleApprovalPreflight(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/v1-acceptance/product-visual-sample/approval/approve", async (req, res, next) => {
  try {
    res.json(await approveProductVisualSample(req.body || {}));
  } catch (error) {
    if (error?.preflight) {
      res.status(error.status || 409).json({
        ok: false,
        code: error.code || "PRODUCT_VISUAL_SAMPLE_APPROVAL_NOT_READY",
        error: error.message || "Product visual sample approval is not ready.",
        preflight: error.preflight
      });
      return;
    }
    next(error);
  }
});

app.post("/api/v1-acceptance/product-visual-full-deck/approval/preflight", async (req, res, next) => {
  try {
    res.json(await getProductVisualFullDeckApprovalPreflight(req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/v1-acceptance/product-visual-full-deck/approval/approve", async (req, res, next) => {
  try {
    res.json(await approveProductVisualFullDeck(req.body || {}));
  } catch (error) {
    if (error?.preflight) {
      res.status(error.status || 409).json({
        ok: false,
        code: error.code || "PRODUCT_VISUAL_FULL_DECK_APPROVAL_NOT_READY",
        error: error.message || "Product visual full-deck approval is not ready.",
        preflight: error.preflight
      });
      return;
    }
    next(error);
  }
});

app.post("/api/v1-acceptance/product-visual-full-deck/run", async (req, res, next) => {
  try {
    res.json(await runProductVisualFullDeck(req.body || {}));
  } catch (error) {
    if (error?.preflight || error?.requiredConfirmation) {
      res.status(error.status || 409).json({
        ok: false,
        code: error.code || "PRODUCT_VISUAL_FULL_DECK_NOT_READY",
        error: error.message || "Product visual full-deck run is not ready.",
        requiredConfirmation: error.requiredConfirmation || "",
        externalImageCalls: error.externalImageCalls || error.preflight?.externalImageCalls || 0,
        preflight: error.preflight || null
      });
      return;
    }
    next(error);
  }
});

app.get("/api/workflow-jobs/:id/authorizations", async (req, res, next) => {
  try {
    res.json(await listWorkflowAuthorizations(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post("/api/workflow-jobs/:id/authorizations/external-image-spend", async (req, res) => {
  try {
    const result = await authorizeExternalImageSpend(req.params.id, req.body || {});
    res.json({
      ok: true,
      authorization: result.authorization,
      summary: result.summary,
      job: toClientWorkflowJob(result.job, { includeEvents: true })
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      code: error.code || "WORKFLOW_AUTHORIZATION_FAILED",
      error: error.message || "workflow authorization failed"
    });
  }
});

app.post("/api/workflow-jobs/:id/codex-ppt/approvals/:gate/preflight", async (req, res) => {
  try {
    const preflight = await preflightCodexPptGate(req.params.id, { ...(req.body || {}), gate: req.params.gate });
    res.json(preflight);
  } catch (error) {
    res.status(400).json({
      ok: false,
      code: error.code || "CODEX_PPT_APPROVAL_PREFLIGHT_FAILED",
      error: error.message || "codex-ppt approval preflight failed",
      gate: error.gate || req.params.gate
    });
  }
});

app.post("/api/workflow-jobs/:id/codex-ppt/approvals/:gate/approve", async (req, res) => {
  try {
    const job = await approveCodexPptGate(req.params.id, { ...(req.body || {}), gate: req.params.gate });
    res.json(toClientWorkflowJob(job, { includeEvents: true }));
  } catch (error) {
    const status = /^CODEX_PPT_/.test(error.code || "") ? 409 : 400;
    res.status(status).json({
      ok: false,
      code: error.code || "CODEX_PPT_APPROVAL_FAILED",
      error: error.message || "codex-ppt approval failed",
      gate: error.gate || req.params.gate,
      missing: error.missing || [],
      requiredArtifact: error.requiredArtifact || "",
      backend: error.backend || null
    });
  }
});

app.post("/api/workflow-jobs/:id/codex-ppt/outline", async (req, res) => {
  try {
    const job = await recordWorkflowCodexPptOutline(req.params.id, req.body || {});
    res.json(toClientWorkflowJob(job, { includeEvents: true }));
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "codex-ppt outline recording failed" });
  }
});

app.post("/api/workflow-jobs/:id/codex-ppt/style", async (req, res) => {
  try {
    const job = await recordWorkflowCodexPptStyle(req.params.id, req.body || {});
    res.json(toClientWorkflowJob(job, { includeEvents: true }));
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "codex-ppt style recording failed" });
  }
});

app.post("/api/workflow-jobs/:id/codex-ppt/backend", async (req, res) => {
  try {
    const job = await recordWorkflowCodexPptBackendDecision(req.params.id, req.body || {});
    res.json(toClientWorkflowJob(job, { includeEvents: true }));
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "codex-ppt backend recording failed" });
  }
});

app.post("/api/workflow-jobs/:id/codex-ppt/backend/refresh-approval", async (req, res) => {
  try {
    const body = req.body || {};
    const currentJob = await readWorkflowJob(req.params.id);
    const refreshState = getCodexPptBackendRefreshState(currentJob);
    if (!refreshState.runtimeReady) {
      const error = new Error("A configured, enabled image runtime is required before refreshing codex-ppt backend approval.");
      error.code = "CODEX_PPT_BACKEND_NOT_READY";
      error.backend = refreshState.runtime;
      throw error;
    }
    if (!refreshState.needsRefresh && body.forceRefresh !== true) {
      res.json(toClientWorkflowJob(currentJob, { includeEvents: true }));
      return;
    }
    await resetCodexPptGate(req.params.id, {
      gate: "fullDeck",
      reason: body.reason || "backend runtime refresh invalidates full-deck authorization"
    });
    await resetCodexPptGate(req.params.id, {
      gate: "sample",
      reason: body.reason || "backend runtime refresh requires a fresh visual sample approval"
    });
    await resetCodexPptGate(req.params.id, {
      gate: "backend",
      reason: body.reason || "refresh backend approval for current image runtime"
    });
    await recordWorkflowCodexPptBackendDecision(req.params.id, {
      source: body.source || "api-runtime-backend-refresh",
      recordedBy: body.recordedBy || "api-skill-first",
      policy: body.policy || "Use the currently configured external image runtime for codex-ppt product visual generation.",
      fallbackStatus: body.fallbackStatus || "No regression, dry-run, passthrough, local drawing, HTML screenshot, or manual overlay fallback is approved for product visual generation.",
      notes: body.notes || "Refreshed backend decision from the current provider configuration."
    });
    const job = await approveCodexPptGate(req.params.id, {
      gate: "backend",
      note: body.note || "api-runtime-backend-refresh",
      approvedBy: body.approvedBy || "api-skill-first"
    });
    res.json(toClientWorkflowJob(job, { includeEvents: true }));
  } catch (error) {
    const status = /^CODEX_PPT_/.test(error.code || "") ? 409 : 400;
    res.status(status).json({
      ok: false,
      code: error.code || "CODEX_PPT_BACKEND_REFRESH_FAILED",
      error: error.message || "codex-ppt backend approval refresh failed",
      backend: error.backend || null
    });
  }
});

app.post("/api/workflow-jobs/:id/codex-ppt/approvals/:gate/reset", async (req, res) => {
  try {
    const job = await resetCodexPptGate(req.params.id, { ...(req.body || {}), gate: req.params.gate });
    res.json(toClientWorkflowJob(job, { includeEvents: true }));
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "codex-ppt approval reset failed" });
  }
});

app.post("/api/workflow-jobs/:id/review/approve", async (req, res, next) => {
  try {
    const job = await approveWorkflowManualReview(req.params.id, req.body || {});
    res.json(toClientWorkflowJob(job, { includeEvents: true }));
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "Manual review approval failed" });
  }
});

app.post("/api/workflow-jobs/:id/review/reset", async (req, res, next) => {
  try {
    const job = await resetWorkflowManualReview(req.params.id, req.body || {});
    res.json(toClientWorkflowJob(job, { includeEvents: true }));
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "Manual review reset failed" });
  }
});

app.post("/api/workflow-jobs/:id/review/pages/:pageId", async (req, res) => {
  try {
    const job = await recordWorkflowPageVisualReview(req.params.id, {
      ...(req.body || {}),
      pageId: req.params.pageId
    });
    res.json(toClientWorkflowJob(job, { includeEvents: true }));
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "Page visual review mark failed" });
  }
});

app.post("/api/workflow-jobs/:id/image-deck/review/pages/:pageId", async (req, res) => {
  try {
    const job = await runWithCurrentVisualQuality(req.params.id, () => recordWorkflowImageDeckPageReview(req.params.id, {
      ...(req.body || {}),
      pageId: req.params.pageId
    }));
    res.json(toClientWorkflowJob(job, { includeEvents: true }));
  } catch (error) {
    res.status(error.status || 400).json({ ok: false, error: error.message || "Image deck page review failed", code: error.code || "" });
  }
});

app.post("/api/workflow-jobs/:id/image-deck/review/rerun-pages", async (req, res) => {
  try {
    const job = await recordWorkflowImageDeckPagesForRerun(req.params.id, req.body || {});
    res.json(toClientWorkflowJob(job, { includeEvents: true }));
  } catch (error) {
    res.status(error.status || 400).json({
      ok: false,
      error: error.message || "Image deck pages rerun reset failed",
      code: error.code || "",
      pages: error.pages || []
    });
  }
});

app.post("/api/workflow-jobs/:id/image-deck/review/approve", async (req, res) => {
  try {
    const job = await runWithCurrentVisualQuality(req.params.id, () => approveWorkflowImageDeckReview(req.params.id, req.body || {}));
    res.json(toClientWorkflowJob(job, { includeEvents: true }));
  } catch (error) {
    res.status(error.status || 400).json({ ok: false, error: error.message || "Image deck review approval failed", code: error.code || "", summary: error.summary || null });
  }
});

async function runWithCurrentVisualQuality(jobId, action) {
  try {
    return await action();
  } catch (error) {
    const recoverableCodes = new Set([
      "IMAGE_DECK_VISUAL_QUALITY_REQUIRED",
      "IMAGE_DECK_VISUAL_QUALITY_INVALID",
      "IMAGE_DECK_VISUAL_QUALITY_STALE"
    ]);
    if (!recoverableCodes.has(error?.code)) throw error;
    await rebuildVisualQualityFromExisting(jobId);
    return action();
  }
}

app.post("/api/workflow-jobs/:id/visual-quality/review/approve", async (req, res) => {
  try {
    const job = await approveWorkflowVisualQualityReview(req.params.id, req.body || {});
    res.json(toClientWorkflowJob(job, { includeEvents: true }));
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "Visual quality review approval failed" });
  }
});

app.post("/api/workflow-jobs/:id/visual-quality/rebuild-from-existing/preflight", async (req, res) => {
  try {
    res.json(await buildVisualQualityRebuildFromExistingPreflight(req.params.id, req.body || {}));
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "Visual quality rebuild preflight failed" });
  }
});

app.post("/api/workflow-jobs/:id/visual-quality/rebuild-from-existing", async (req, res) => {
  try {
    res.json(await rebuildVisualQualityFromExisting(req.params.id, req.body || {}));
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error.message || "Visual quality rebuild failed",
      preflight: error.preflight || null
    });
  }
});

app.get("/api/workflow-jobs/:id/artifacts", async (req, res, next) => {
  try {
    const links = await listWorkflowArtifactLinks(req.params.id);
    res.json(links);
  } catch (error) {
    next(error);
  }
});

app.get("/api/workflow-jobs/:id/events", async (req, res, next) => {
  try {
    const job = await readWorkflowJob(req.params.id);
    const allEvents = Array.isArray(job.events) ? job.events : [];
    const after = String(req.query?.after || "");
    const limit = Math.min(Math.max(Number(req.query?.limit || 100), 1), 500);
    const afterIndex = after ? allEvents.findIndex((event) => event.id === after) : -1;
    const events = allEvents.slice(afterIndex >= 0 ? afterIndex + 1 : 0).slice(-limit);
    res.json({
      ok: true,
      jobId: job.id,
      total: allEvents.length,
      events,
      latestEventId: allEvents.at(-1)?.id || "",
      updatedAt: job.updatedAt || ""
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/workflow-jobs/:id/next", async (req, res) => {
  try {
    const result = await runWorkflowNextAction(req.params.id, req.body || {});
    res.json({
      ...result,
      job: result.job ? toClientWorkflowJob(result.job, { includeEvents: true }) : null
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "Workflow next action failed", code: error.code || "" });
  }
});

app.get("/api/workflow-jobs/:id/next", async (req, res) => {
  try {
    const result = await getWorkflowNextActionPreflight(req.params.id, req.query || {});
    res.json(result);
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "Workflow next action preflight failed", code: error.code || "" });
  }
});

app.post("/api/workflow-jobs/:id/next/preflight", async (req, res) => {
  try {
    const result = await getWorkflowNextActionPreflight(req.params.id, req.body || {});
    res.json(result);
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "Workflow next action preflight failed", code: error.code || "" });
  }
});

app.post("/api/workflow-jobs/:id/continue-remaining/preflight", async (req, res) => {
  try {
    res.json(await getWorkflowContinuationPreflight(req.params.id, req.body || {}));
  } catch (error) {
    res.status(400).json({
      ok: false,
      code: error.code || "WORKFLOW_CONTINUATION_PREFLIGHT_FAILED",
      error: error.message || "workflow continuation preflight failed",
      preflight: error.preflight || null
    });
  }
});

app.post("/api/workflow-jobs/:id/continue-remaining", async (req, res) => {
  try {
    const result = await runWorkflowContinuation(req.params.id, req.body || {});
    res.status(result.ok ? 200 : 400).json(result);
  } catch (error) {
    res.status(error.code === "EXTERNAL_IMAGE_SPEND_CONFIRMATION_REQUIRED" ? 409 : 400).json({
      ok: false,
      code: error.code || "WORKFLOW_CONTINUATION_FAILED",
      error: error.message || "workflow continuation failed",
      preflight: error.preflight || null
    });
  }
});

app.get("/api/workflow-jobs/:id/artifacts/:artifactKey", async (req, res, next) => {
  try {
    const artifact = await resolveWorkflowArtifact(req.params.id, req.params.artifactKey, "");
    res.type(artifact.contentType);
    if (req.query?.download === "1" || artifact.inline === false) {
      res.download(artifact.path, artifact.fileName);
      return;
    }
    res.sendFile(artifact.path);
  } catch (error) {
    next(error);
  }
});

app.get("/api/workflow-jobs/:id/artifacts/:artifactKey/:pageId", async (req, res, next) => {
  try {
    const artifact = await resolveWorkflowArtifact(req.params.id, req.params.artifactKey, req.params.pageId || "");
    res.type(artifact.contentType);
    if (req.query?.download === "1" || artifact.inline === false) {
      res.download(artifact.path, artifact.fileName);
      return;
    }
    res.sendFile(artifact.path);
  } catch (error) {
    next(error);
  }
});

app.get("/api/workflow-jobs/:id/logs/download", async (req, res, next) => {
  try {
    const bundle = await buildWorkflowLogBundle(req.params.id);
    res.download(bundle.path, bundle.fileName);
  } catch (error) {
    next(error);
  }
});

app.post("/api/workflow-jobs/:id/source/render", async (req, res, next) => {
  try {
    await updateWorkflowStage(req.params.id, {
      stage: "source_rendered",
      status: "running",
      message: "Rendering source pages",
      details: { requestedBy: "api" }
    });
    const job = await renderWorkflowSource(req.params.id);
    res.json(toClientWorkflowJob(job, { includeEvents: true }));
  } catch (error) {
    try {
      const job = await updateWorkflowStage(req.params.id, {
        stage: "source_rendered",
        status: "failed",
        message: error.message || "Source render failed",
        details: { requestedBy: "api" }
      });
      res.status(400).json(toClientWorkflowJob(job, { includeEvents: true }));
    } catch {
      next(error);
    }
  }
});

app.post("/api/workflow-jobs/:id/visual/sample", async (req, res, next) => {
  try {
    let currentJob = await readWorkflowJob(req.params.id);
    const body = withExternalImageAuthorization(req.body || {}, getExternalImageAuthorizationStatus(currentJob, { scope: "visual-sample", imageCalls: 1 }));
    await assertCodexPptApprovals(req.params.id, CODEX_PPT_VISUAL_SAMPLE_GATES);
    assertWorkflowInformationAssetMapReady(currentJob);
    const sampleSelection = resolveWorkflowVisualSampleSelection(currentJob, body);
    assertVisualSampleSelectionAllowed(sampleSelection);
    const samplePageNumber = sampleSelection?.pageNumber || 1;
    const samplePageId = `page_${String(samplePageNumber).padStart(3, "0")}`;
    const sampleSourceOcrPages = getWorkflowVisualSourceOcrPageIds(currentJob, [samplePageNumber]);
    const sampleOcrCoverage = sampleSourceOcrPages.length ? getWorkflowOcrCoverage(currentJob, { pages: sampleSourceOcrPages }) : null;
    if (sampleOcrCoverage && !sampleOcrCoverage.complete) {
      currentJob = await runWorkflowOcr(req.params.id, {
        source: "rendered",
        pages: sampleSourceOcrPages.join(","),
        maxPages: 1,
        preserveWorkflowStage: true,
        requestedBy: "visual-sample-source-ocr"
      });
    }
    if (sampleSourceOcrPages.length) assertWorkflowOcrTextHintsReady(currentJob, { pages: sampleSourceOcrPages });
    assertWorkflowVisualGenerationAllowed(body);
    const sampleOptions = { ...body, pageNumber: samplePageNumber };
    await updateWorkflowStage(req.params.id, {
      stage: "visual_sample_ready",
      status: "running",
      message: "Generating visual sample",
      details: { pageNumber: samplePageNumber, sampleSelection: sampleSelection?.mode || "", dryRun: Boolean(body?.dryRun) }
    });
    const job = await generateWorkflowVisualSample(req.params.id, sampleOptions);
    res.json(toClientWorkflowJob(job, { includeEvents: true }));
  } catch (error) {
    if (["CODEX_PPT_NON_REPRESENTATIVE_SAMPLE_REQUIRES_OPT_IN", "CODEX_PPT_SAMPLE_PAGE_NOT_FOUND"].includes(error.code || "")) {
      res.status(409).json({
        ok: false,
        error: error.message || "Visual sample page selection is blocked",
        code: error.code,
        pageNumber: error.pageNumber || null,
        recommendedPageNumber: error.recommendedPageNumber || null
      });
      return;
    }
    if (isCodexPptApprovalError(error)) {
      res.status(409).json(formatCodexPptApprovalError(error));
      return;
    }
    try {
      const job = await updateWorkflowStage(req.params.id, {
        stage: "visual_sample_ready",
        status: "failed",
        message: error.message || "Visual sample generation failed",
        details: { requestedBy: "api", code: error.code || "", coverage: error.coverage || null }
      });
      res.status(400).json(toClientWorkflowJob(job, { includeEvents: true }));
    } catch {
      next(error);
    }
  }
});

app.post("/api/workflow-jobs/:id/codex-ppt/information-assets", async (req, res, next) => {
  try {
    await assertCodexPptApprovals(req.params.id, CODEX_PPT_VISUAL_SAMPLE_GATES);
    const job = await buildWorkflowInformationAssetMap(req.params.id, req.body || {});
    res.json(toClientWorkflowJob(job, { includeEvents: true }));
  } catch (error) {
    if (isCodexPptApprovalError(error)) {
      res.status(409).json(formatCodexPptApprovalError(error));
      return;
    }
    try {
      const job = await updateWorkflowStage(req.params.id, {
        stage: "source_rendered",
        status: "failed",
        message: error.message || "Information asset analysis failed",
        details: { requestedBy: "api" }
      });
      res.status(400).json(toClientWorkflowJob(job, { includeEvents: true }));
    } catch {
      next(error);
    }
  }
});

app.post("/api/workflow-jobs/:id/visual/generate", async (req, res, next) => {
  try {
    const currentJob = await readWorkflowJob(req.params.id);
    const pageCount = getWorkflowVisualTargetPages(currentJob).length;
    const requestedPages = parsePageSelection(req.body?.pages || req.body?.pageNumbers || "", pageCount);
    const sample = currentJob.artifacts?.visualSample || {};
    const samplePageNumber = Number(sample.pageNumber || String(sample.pageId || "").match(/\d+/)?.[0] || 0);
    const retainedSampleReady = Boolean(samplePageNumber && sample.path && sample.sha256 && isCodexPptSampleApprovalCurrent(currentJob));
    const externalImageCalls = requestedPages.filter((pageNumber) => !retainedSampleReady || pageNumber !== samplePageNumber).length;
    const body = withExternalImageAuthorization(req.body || {}, getExternalImageAuthorizationStatus(currentJob, {
      scope: "full-deck",
      imageCalls: externalImageCalls,
      pages: requestedPages
    }));
    const isTwoPageTest = requestedPages.length > 0 && requestedPages.length <= 2;
    await assertCodexPptApprovals(
      req.params.id,
      isTwoPageTest ? CODEX_PPT_VISUAL_TEST_GATES : CODEX_PPT_VISUAL_DECK_GATES
    );
    assertWorkflowInformationAssetMapReady(currentJob);
    const sourceOcrPages = getWorkflowVisualSourceOcrPageIds(currentJob, requestedPages);
    if (sourceOcrPages.length) assertWorkflowOcrTextHintsReady(currentJob, { pages: sourceOcrPages });
    assertWorkflowVisualGenerationAllowed(body);
    await updateWorkflowStage(req.params.id, {
      stage: "visual_generating",
      status: "running",
      message: "Generating visual images",
      details: { pages: body?.pages || body?.pageNumbers || "all", dryRun: Boolean(body?.dryRun) }
    });
    const job = await generateWorkflowVisualImages(req.params.id, body);
    res.json(toClientWorkflowJob(job, { includeEvents: true }));
  } catch (error) {
    if (isCodexPptApprovalError(error)) {
      res.status(409).json(formatCodexPptApprovalError(error));
      return;
    }
    try {
      const job = await updateWorkflowStage(req.params.id, {
        stage: "visual_generating",
        status: "failed",
        message: error.message || "Visual image generation failed",
        details: { requestedBy: "api" }
      });
      res.status(400).json(toClientWorkflowJob(job, { includeEvents: true }));
    } catch {
      next(error);
    }
  }
});

app.get("/api/workflow-jobs/:id/codex-ppt/slide-tasks", async (req, res, next) => {
  try {
    const tasks = await listWorkflowCodexPptSlideTasks(req.params.id, req.query || {});
    res.json(tasks);
  } catch (error) {
    next(error);
  }
});

app.post("/api/workflow-jobs/:id/codex-ppt/slide-tasks/sync", async (req, res, next) => {
  try {
    await assertCodexPptApprovals(req.params.id, CODEX_PPT_VISUAL_DECK_GATES);
    const tasks = await syncWorkflowCodexPptSlideTasks(req.params.id, req.body || {});
    res.json(tasks);
  } catch (error) {
    if (isCodexPptApprovalError(error)) {
      res.status(409).json(formatCodexPptApprovalError(error));
      return;
    }
    res.status(400).json({ ok: false, error: error.message || "codex-ppt slide task sync failed" });
  }
});

app.post("/api/workflow-jobs/:id/codex-ppt/slide-tasks/run-batch/preflight", async (req, res) => {
  try {
    const result = await getWorkflowCodexPptSlideBatchPreflight(req.params.id, req.body || {});
    res.json(result);
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "codex-ppt slide batch preflight failed" });
  }
});

app.post("/api/workflow-jobs/:id/codex-ppt/slide-tasks/reset-non-product", async (req, res) => {
  try {
    const result = await resetWorkflowNonProductCodexPptSlides(req.params.id, req.body || {});
    if (result.preview === false) {
      const postResetPreflight = await getWorkflowCodexPptSlideBatchPreflight(req.params.id, {
        maxPages: result.reset || result.candidateCount || 200,
        assembleImageDeck: true,
        prepareEditable: true,
        buildEditablePrompts: true,
        syncEditableWorkerTasks: true
      }).catch((error) => ({
        ok: false,
        ready: false,
        startReady: false,
        error: error.message || "post-reset preflight failed"
      }));
      res.json({ ...result, postResetPreflight });
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "codex-ppt non-product slide reset failed" });
  }
});

app.post("/api/workflow-jobs/:id/codex-ppt/slide-tasks/run-batch", async (req, res) => {
  try {
    await assertCodexPptApprovals(req.params.id, CODEX_PPT_VISUAL_DECK_GATES);
    const result = await runWorkflowCodexPptSlideBatch(req.params.id, req.body || {});
    res.status(result.ok ? 200 : 400).json(result);
  } catch (error) {
    if (isCodexPptApprovalError(error)) {
      res.status(409).json(formatCodexPptApprovalError(error));
      return;
    }
    res.status(400).json({ ok: false, error: error.message || "codex-ppt slide batch failed" });
  }
});

app.post("/api/workflow-jobs/:id/codex-ppt/slide-tasks/:pageId/claim", async (req, res, next) => {
  try {
    await assertCodexPptApprovals(req.params.id, CODEX_PPT_VISUAL_DECK_GATES);
    const tasks = await claimWorkflowCodexPptSlideTask(req.params.id, req.params.pageId, req.body || {});
    res.json(tasks);
  } catch (error) {
    if (isCodexPptApprovalError(error)) {
      res.status(409).json(formatCodexPptApprovalError(error));
      return;
    }
    res.status(400).json({ ok: false, error: error.message || "codex-ppt slide task claim failed" });
  }
});

app.post("/api/workflow-jobs/:id/codex-ppt/slide-tasks/:pageId/heartbeat", async (req, res) => {
  try {
    const tasks = await heartbeatWorkflowCodexPptSlideTask(req.params.id, req.params.pageId, req.body || {});
    res.json(tasks);
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "codex-ppt slide task heartbeat failed" });
  }
});

app.post("/api/workflow-jobs/:id/codex-ppt/slide-tasks/:pageId/complete", async (req, res) => {
  try {
    await assertCodexPptApprovals(req.params.id, CODEX_PPT_VISUAL_DECK_GATES);
    const tasks = await completeWorkflowCodexPptSlideTask(req.params.id, req.params.pageId, req.body || {});
    res.json(tasks);
  } catch (error) {
    if (isCodexPptApprovalError(error)) {
      res.status(409).json(formatCodexPptApprovalError(error));
      return;
    }
    res.status(400).json({ ok: false, error: error.message || "codex-ppt slide task complete failed" });
  }
});

app.post("/api/workflow-jobs/:id/codex-ppt/slide-tasks/:pageId/reset", async (req, res) => {
  try {
    const tasks = await resetWorkflowCodexPptSlideTask(req.params.id, req.params.pageId, req.body || {});
    res.json(tasks);
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "codex-ppt slide task reset failed" });
  }
});

app.post("/api/workflow-jobs/:id/image-deck/assemble", async (req, res, next) => {
  try {
    assertWorkflowImageDeckReviewReady(await readWorkflowJob(req.params.id));
    await updateWorkflowStage(req.params.id, {
      stage: "image_deck_ready",
      status: "running",
      message: "Assembling image deck",
      details: { requestedBy: "api" }
    });
    const job = await assembleWorkflowImageDeck(req.params.id, req.body || {});
    res.json(toClientWorkflowJob(job, { includeEvents: true }));
  } catch (error) {
    if (error?.code === "IMAGE_DECK_REVIEW_REQUIRED") {
      res.status(error.status || 409).json({
        ok: false,
        error: error.message || "Image deck review is required before assembly.",
        code: error.code,
        summary: error.summary || null
      });
      return;
    }
    try {
      const job = await updateWorkflowStage(req.params.id, {
        stage: "image_deck_ready",
        status: "failed",
        message: error.message || "Image deck assembly failed",
        details: { requestedBy: "api" }
      });
      res.status(400).json(toClientWorkflowJob(job, { includeEvents: true }));
    } catch {
      next(error);
    }
  }
});

app.post("/api/workflow-jobs/:id/ocr/run", async (req, res, next) => {
  const preserveWorkflowStage = req.body?.preserveWorkflowStage === true;
  try {
    if (!preserveWorkflowStage) {
      await updateWorkflowStage(req.params.id, {
        stage: "ocr_ready",
        status: "running",
        message: "Running OCR",
        details: { minConfidence: req.body?.minConfidence || 0.35 }
      });
    }
    const job = await runWorkflowOcr(req.params.id, req.body || {});
    res.json(toClientWorkflowJob(job, { includeEvents: true }));
  } catch (error) {
    try {
      if (preserveWorkflowStage) return next(error);
      const job = await updateWorkflowStage(req.params.id, {
        stage: "ocr_ready",
        status: "failed",
        message: error.message || "OCR failed",
        details: { requestedBy: "api" }
      });
      res.status(400).json(toClientWorkflowJob(job, { includeEvents: true }));
    } catch {
      next(error);
    }
  }
});

app.post("/api/workflow-jobs/:id/ocr/text-hints/correct", async (req, res, next) => {
  try {
    const job = await correctWorkflowOcrTextHint(req.params.id, req.body || {});
    res.json(toClientWorkflowJob(job, { includeEvents: true }));
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "OCR text correction failed" });
  }
});

app.post("/api/workflow-jobs/:id/editable/doctor", async (req, res, next) => {
  try {
    const result = await testEditableRuntime(req.body || {});
    res.status(result.ok ? 200 : 400).json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/workflow-jobs/:id/editable/prepare/preflight", async (req, res, next) => {
  try {
    res.json(await getWorkflowEditablePreparePreflight(req.params.id, req.query || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/workflow-jobs/:id/editable/prepare/preflight", async (req, res, next) => {
  try {
    res.json(await getWorkflowEditablePreparePreflight(req.params.id, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/workflow-jobs/:id/editable/prepare", async (req, res, next) => {
  try {
    await updateWorkflowStage(req.params.id, {
      stage: "editable_prepared",
      status: "running",
      message: "Preparing editppt run",
      details: { requestedBy: "api", force: Boolean(req.body?.force) }
    });
    const job = await prepareWorkflowEditableRun(req.params.id, req.body || {});
    res.json(toClientWorkflowJob(job, { includeEvents: true }));
  } catch (error) {
    try {
      const job = await updateWorkflowStage(req.params.id, {
        stage: "editable_prepared",
        status: "failed",
        message: error.message || "Editable prepare failed",
        details: { requestedBy: "api" }
      });
      res.status(400).json(toClientWorkflowJob(job, { includeEvents: true }));
    } catch {
      next(error);
    }
  }
});

app.post("/api/workflow-jobs/:id/editable/fresh-run-recovery/preflight", async (req, res) => {
  try {
    res.json(await buildFreshRunRecoveryPreflight(req.params.id));
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "Fresh editable run recovery preflight failed" });
  }
});

async function createFreshEditableRunRollbackSnapshot(job = {}) {
  const runDir = job.artifacts?.editableRun?.path || "";
  const runRoot = runDir ? path.dirname(runDir) : "";
  const backupRoot = path.join(job.dirs?.editableRun || job.rootDir, `.fresh-run-rollback-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const snapshot = JSON.parse(JSON.stringify(job));
  if (runRoot && fsSync.existsSync(runRoot)) {
    await fs.rm(backupRoot, { recursive: true, force: true });
    await fs.cp(runRoot, backupRoot, { recursive: true });
  }
  return { jobId: job.id, snapshot, runRoot, backupRoot, hadRunRoot: Boolean(runRoot && fsSync.existsSync(backupRoot)) };
}

async function cleanupFreshEditableRunRollbackSnapshot(rollback = {}) {
  if (rollback.backupRoot) await fs.rm(rollback.backupRoot, { recursive: true, force: true });
}

async function restoreFreshEditableRunRollbackSnapshot(rollback = {}) {
  if (!rollback.snapshot?.id) return;
  if (rollback.hadRunRoot && rollback.runRoot && rollback.backupRoot && fsSync.existsSync(rollback.backupRoot)) {
    await fs.rm(rollback.runRoot, { recursive: true, force: true });
    await fs.cp(rollback.backupRoot, rollback.runRoot, { recursive: true });
  }
  await saveWorkflowJob(rollback.snapshot);
  await cleanupFreshEditableRunRollbackSnapshot(rollback);
}

app.post("/api/workflow-jobs/:id/editable/fresh-run-recovery", async (req, res, next) => {
  try {
    const maxConcurrentPages = req.body?.maxConcurrentPages || 6;
    const reason = cleanClientText(req.body?.reason || "fresh editable run recovery for accepted stale page evidence");
    const currentJob = await readWorkflowJob(req.params.id);
    if (req.body?.confirmRouteB !== true) {
      const error = new Error("Route B requires explicit user confirmation before fresh editable run recovery.");
      error.status = 409;
      throw error;
    }
    if (!isImageDeckReviewApproved(currentJob.artifacts || {})) {
      const error = new Error("Image deck review must be approved before fresh editable run recovery.");
      error.status = 409;
      throw error;
    }
    const rollback = await createFreshEditableRunRollbackSnapshot(currentJob);
    let invalidatedJob = null;
    let preparedJob = null;
    let promptedJob = null;
    let briefs = null;
    let tasks = null;
    let job = null;
    try {
      await updateWorkflowStage(req.params.id, {
        stage: "editable_prepared",
        status: "running",
        message: "Rebuilding fresh editppt run",
        details: {
          requestedBy: "api",
          force: true,
          localOnly: true,
          reason
        }
      });
      invalidatedJob = await invalidateWorkflowEditableRebuildEvidence(req.params.id, { reason });
      const { pages: _pages, pageIds: _pageIds, pageId: _pageId, page: _page, ...prepareBody } = req.body || {};
      preparedJob = await prepareWorkflowEditableRun(req.params.id, {
        ...prepareBody,
        force: true,
        maxConcurrentPages,
        reason
      });
      promptedJob = await buildWorkflowEditableWorkerPrompts(req.params.id, {
        pages: req.body?.pages,
        reason: `${reason}; rebuild editable prompts after fresh run recovery`
      });
      briefs = await buildWorkflowWorkerBriefs(req.params.id, {
        pages: req.body?.pages,
        reason: `${reason}; rebuild worker briefs after fresh run recovery`
      });
      tasks = await syncWorkflowEditableWorkerTasks(req.params.id, {
        reason: `${reason}; sync worker tasks after fresh run recovery`
      });
      job = await readWorkflowJob(req.params.id);
      await cleanupFreshEditableRunRollbackSnapshot(rollback);
    } catch (freshRecoveryError) {
      await restoreFreshEditableRunRollbackSnapshot(rollback).catch((restoreError) => {
        console.error("FRESH_EDITABLE_RUN_ROLLBACK_FAILED", restoreError);
      });
      freshRecoveryError.freshRollbackRestored = true;
      throw freshRecoveryError;
    }
    res.json({
      ok: true,
      jobId: req.params.id,
      localOnly: true,
      externalImageSpendRequired: false,
      message: "Fresh editppt run, editable prompts, and page worker queue were rebuilt locally.",
      invalidated: {
        stage: invalidatedJob.currentStage,
        previousEvidenceCleared: true
      },
      prepared: {
        pageCount: preparedJob.artifacts?.editableRun?.pageCount || preparedJob.artifacts?.visualImages?.length || 0,
        runDir: preparedJob.artifacts?.editableRun?.path || "",
        workspacePointerPath: preparedJob.artifacts?.editableRun?.workspacePointerPath || ""
      },
      prompts: {
        count: Array.isArray(promptedJob.artifacts?.editableWorkerPrompts) ? promptedJob.artifacts.editableWorkerPrompts.length : 0,
        path: promptedJob.artifacts?.editableWorkerPromptBundle?.path || ""
      },
      briefs: {
        count: briefs.index?.pageCount || briefs.index?.briefs?.length || 0,
        path: briefs.index?.path || path.join(briefs.outDir || "", "index.json"),
        outDir: briefs.outDir || ""
      },
      tasks: {
        summary: tasks.summary || null,
        tasks: tasks.tasks || []
      },
      job: toClientWorkflowJob(job, { includeEvents: true })
    });
  } catch (error) {
    try {
      if (error.status) {
        const current = await readWorkflowJob(req.params.id).catch(() => null);
        res.status(error.status).json({
          ok: false,
          error: error.message || "Fresh editable run recovery failed",
          ...(current ? { job: toClientWorkflowJob(current, { includeEvents: true }) } : {})
        });
        return;
      }
      if (error.freshRollbackRestored) {
        const restoredJob = await readWorkflowJob(req.params.id);
        res.status(400).json({
          ok: false,
          restored: true,
          error: error.message || "Fresh editable run recovery failed",
          job: toClientWorkflowJob(restoredJob, { includeEvents: true })
        });
        return;
      }
      const job = await updateWorkflowStage(req.params.id, {
        stage: "editable_prepared",
        status: "failed",
        message: error.message || "Fresh editable run recovery failed",
        details: { requestedBy: "api", localOnly: true }
      });
      res.status(400).json({
        ok: false,
        error: error.message || "Fresh editable run recovery failed",
        job: toClientWorkflowJob(job, { includeEvents: true })
      });
    } catch {
      next(error);
    }
  }
});

app.get("/api/workflow-jobs/:id/editable/status", async (req, res, next) => {
  try {
    const status = await getWorkflowEditableStatus(req.params.id, req.query || {});
    res.json(status);
  } catch (error) {
    next(error);
  }
});

app.post("/api/workflow-jobs/:id/editable/hints", async (req, res, next) => {
  try {
    await updateWorkflowStage(req.params.id, {
      stage: "editable_prepared",
      status: "running",
      message: "Regenerating editppt text hints",
      details: { requestedBy: "api" }
    });
    const job = await regenerateWorkflowEditableHints(req.params.id, req.body || {});
    res.json(toClientWorkflowJob(job, { includeEvents: true }));
  } catch (error) {
    try {
      const job = await updateWorkflowStage(req.params.id, {
        stage: "editable_prepared",
        status: "failed",
        message: error.message || "Editable text hints regeneration failed",
        details: { requestedBy: "api" }
      });
      res.status(400).json(toClientWorkflowJob(job, { includeEvents: true }));
    } catch {
      next(error);
    }
  }
});

app.post("/api/workflow-jobs/:id/editable/next", async (req, res, next) => {
  try {
    const job = await getWorkflowEditableNext(req.params.id, req.body || {});
    res.json(toClientWorkflowJob(job, { includeEvents: true }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/workflow-jobs/:id/editable/prompts", async (req, res, next) => {
  try {
    const job = await buildWorkflowEditableWorkerPrompts(req.params.id, req.body || {});
    res.json(toClientWorkflowJob(job, { includeEvents: true }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/workflow-jobs/:id/editable/prompts", async (req, res, next) => {
  try {
    const prompts = await listWorkflowEditableWorkerPrompts(req.params.id, req.query || {});
    res.json(prompts);
  } catch (error) {
    next(error);
  }
});

app.post("/api/workflow-jobs/:id/editable/worker-briefs", async (req, res) => {
  try {
    const briefs = await buildWorkflowWorkerBriefs(req.params.id, req.body || {});
    res.json(briefs);
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "Worker briefs build failed" });
  }
});

app.get("/api/workflow-jobs/:id/editable/worker-runs", async (req, res) => {
  try {
    const runs = await listWorkflowEditableWorkerRuns(req.params.id);
    res.json(runs);
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "Worker runs read failed" });
  }
});

app.post("/api/workflow-jobs/:id/editable/worker-runs/preflight", async (req, res) => {
  try {
    const result = await getWorkflowEditableWorkerBatchPreflight(req.params.id, req.body || {});
    res.json(result);
  } catch (error) {
    res.status(Number(error.status || 400)).json({ ok: false, code: error.code || "", error: error.message || "Worker batch preflight failed" });
  }
});

app.post("/api/workflow-jobs/:id/editable/page-spec-provider/probe", async (req, res) => {
  try {
    const result = await getWorkflowPageSpecProviderProbe(req.params.id, req.body || {});
    res.status(result.ok ? 200 : 400).json(result);
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "Page spec provider probe failed" });
  }
});

app.get("/api/workflow-jobs/:id/editable/worker-runs/:runId/log", async (req, res) => {
  try {
    const download = req.query?.download === "1";
    const log = await getWorkflowEditableWorkerRunLog(req.params.id, req.params.runId, {
      download,
      tailBytes: req.query?.tailBytes || req.query?.tail
    });
    res.type("text/plain; charset=utf-8");
    if (download) {
      res.download(log.path, log.fileName);
      return;
    }
    res.send(log.content);
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "Worker run log read failed" });
  }
});

app.post("/api/workflow-jobs/:id/editable/worker-runs", async (req, res) => {
  try {
    const result = await startWorkflowEditableWorkerBatch(req.params.id, req.body || {});
    res.json(result);
  } catch (error) {
    res.status(Number(error.status || 400)).json({ ok: false, code: error.code || "", error: error.message || "Worker batch start failed" });
  }
});

app.post("/api/workflow-jobs/:id/editable/worker-runs/:runId/cancel", async (req, res) => {
  try {
    const result = await cancelWorkflowEditableWorkerRun(req.params.id, req.params.runId, req.body || {});
    res.json(result);
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "Worker batch cancel failed" });
  }
});

app.get("/api/workflow-jobs/:id/editable/worker-briefs", async (req, res) => {
  try {
    const briefs = await getWorkflowWorkerBriefs(req.params.id);
    res.json(briefs);
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "Worker briefs read failed" });
  }
});

app.get("/api/workflow-jobs/:id/editable/worker-tasks", async (req, res, next) => {
  try {
    const tasks = await listWorkflowEditableWorkerTasks(req.params.id, req.query || {});
    res.json(tasks);
  } catch (error) {
    next(error);
  }
});

app.post("/api/workflow-jobs/:id/editable/worker-tasks/sync", async (req, res, next) => {
  try {
    const tasks = await syncWorkflowEditableWorkerTasks(req.params.id, req.body || {});
    res.json(tasks);
  } catch (error) {
    next(error);
  }
});

app.post("/api/workflow-jobs/:id/editable/worker-tasks/sync/preflight", async (req, res) => {
  try {
    res.json(await buildEditableWorkerTaskSyncPreflight(req.params.id, req.body || {}));
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "Editable worker task sync preflight failed" });
  }
});

app.post("/api/workflow-jobs/:id/editable/worker-tasks/:pageId/claim", async (req, res, next) => {
  try {
    const tasks = await claimWorkflowEditableWorkerTask(req.params.id, req.params.pageId, req.body || {});
    res.json(tasks);
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "Worker task claim failed" });
  }
});

app.post("/api/workflow-jobs/:id/editable/worker-tasks/:pageId/heartbeat", async (req, res, next) => {
  try {
    const tasks = await heartbeatWorkflowEditableWorkerTask(req.params.id, req.params.pageId, req.body || {});
    res.json(tasks);
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "Worker task heartbeat failed" });
  }
});

app.post("/api/workflow-jobs/:id/editable/worker-tasks/:pageId/complete", async (req, res, next) => {
  try {
    const tasks = await completeWorkflowEditableWorkerTask(req.params.id, req.params.pageId, req.body || {});
    res.json(tasks);
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "Worker task complete failed" });
  }
});

app.post("/api/workflow-jobs/:id/editable/worker-tasks/:pageId/reset", async (req, res, next) => {
  try {
    const tasks = await resetWorkflowEditableWorkerTask(req.params.id, req.params.pageId, req.body || {});
    res.json(tasks);
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "Worker task reset failed" });
  }
});

app.post("/api/workflow-jobs/:id/editable/worker-tasks/:pageId/repair-openable", async (req, res) => {
  try {
    const result = await repairWorkflowEditablePageOpenability(req.params.id, req.params.pageId, req.body || {});
    res.json(result);
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "Worker task openable repair failed" });
  }
});

app.post("/api/workflow-jobs/:id/pages/:pageId/retry", async (req, res) => {
  try {
    const result = await retryWorkflowPage(req.params.id, req.params.pageId, req.body || {});
    res.json(result);
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "Page retry failed" });
  }
});

app.post("/api/workflow-jobs/:id/visual-quality/retry-preflight", async (req, res) => {
  try {
    const result = await getVisualQualityRetryPreflight(req.params.id, req.body || {});
    res.json(result);
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "Visual quality retry preflight failed" });
  }
});

app.post("/api/workflow-jobs/:id/final-visual-qa/retry-preflight", async (req, res) => {
  try {
    const result = await getFinalVisualQaRetryPreflight(req.params.id, req.body || {});
    res.json(result);
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "Final visual QA retry preflight failed" });
  }
});

app.post("/api/workflow-jobs/:id/final-visual-qa/retry", async (req, res) => {
  try {
    const result = await retryFinalVisualQaWorkflowPages(req.params.id, req.body || {});
    if (result.ok === false) {
      const failedPages = (result.results || []).filter((item) => item?.ok === false);
      const detail = failedPages.length
        ? failedPages.map((item) => `${item.pageId}: ${item.error || "reset failed"}`).join("; ")
        : "one or more pages were not reset";
      res.status(409).json({
        ...result,
        error: `Final visual QA retry was only partially applied: ${detail}`
      });
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error.message || "Final visual QA retry failed",
      preflight: error.preflight || null
    });
  }
});

app.post("/api/workflow-jobs/:id/pages/retry-failed", async (req, res) => {
  try {
    const result = await retryFailedWorkflowPages(req.params.id, req.body || {});
    res.json(result);
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "Failed page bulk retry failed" });
  }
});

app.post("/api/workflow-jobs/:id/pages/retry-stale-evidence", async (req, res) => {
  try {
    const result = await retryStaleWorkflowPageEvidence(req.params.id, req.body || {});
    res.json(result);
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "Stale page evidence retry failed" });
  }
});

app.post("/api/workflow-jobs/:id/editable/dispatch", async (req, res, next) => {
  try {
    const job = await dispatchWorkflowEditablePage(req.params.id, req.body || {});
    res.json(toClientWorkflowJob(job, { includeEvents: true }));
  } catch (error) {
    if (Number(error.status || 0) === 409) {
      res.status(409).json({ ok: false, code: error.code || "WORKFLOW_GATE_BLOCKED", error: error.message || "Workflow gate blocked editable page dispatch" });
      return;
    }
    try {
      const job = await updateWorkflowStage(req.params.id, {
        stage: "pages_running",
        status: "failed",
        message: error.message || "Editable page dispatch failed",
        details: { requestedBy: "api" }
      });
      res.status(400).json(toClientWorkflowJob(job, { includeEvents: true }));
    } catch {
      next(error);
    }
  }
});

app.post("/api/workflow-jobs/:id/editable/record", async (req, res, next) => {
  try {
    const job = await recordWorkflowEditablePage(req.params.id, req.body || {});
    res.json(toClientWorkflowJob(job, { includeEvents: true }));
  } catch (error) {
    try {
      const job = await updateWorkflowStage(req.params.id, {
        stage: "pages_running",
        status: "failed",
        message: error.message || "Editable page record failed",
        details: { pageId: req.body?.pageId || req.body?.page, agentId: req.body?.agentId || "" }
      });
      res.status(error.code === "EDITABLE_VISUAL_FIDELITY_FAILED" ? 409 : 400).json({
        ...toClientWorkflowJob(job, { includeEvents: true }),
        ok: false,
        error: error.message || "Editable page record failed",
        code: error.code || "EDITABLE_PAGE_RECORD_FAILED",
        details: error.details || null
      });
    } catch {
      next(error);
    }
  }
});

app.post("/api/workflow-jobs/:id/editable/local-rebuild", async (req, res, next) => {
  try {
    await updateWorkflowStage(req.params.id, {
      stage: "pages_running",
      status: "running",
      message: "Running single-page local editable rebuild",
      details: { requestedBy: "api", agentId: req.body?.agentId || "main" }
    });
    const job = await rebuildWorkflowEditableLocalPage(req.params.id, req.body || {});
    res.json(toClientWorkflowJob(job, { includeEvents: true }));
  } catch (error) {
    try {
      const job = await updateWorkflowStage(req.params.id, {
        stage: "pages_running",
        status: "failed",
        message: error.message || "Single-page local editable rebuild failed",
        details: { requestedBy: "api" }
      });
      res.status(400).json(toClientWorkflowJob(job, { includeEvents: true }));
    } catch {
      next(error);
    }
  }
});

app.post("/api/workflow-jobs/:id/editable/finalize", async (req, res, next) => {
  try {
    await updateWorkflowStage(req.params.id, {
      stage: "finalizing",
      status: "running",
      message: "Finalizing editable PPTX",
      details: { requestedBy: "api" }
    });
    const job = await finalizeWorkflowEditableRun(req.params.id, req.body || {});
    res.json(toClientWorkflowJob(job, { includeEvents: true }));
  } catch (error) {
    try {
      const job = await updateWorkflowStage(req.params.id, {
        stage: "finalizing",
        status: "failed",
        message: error.message || "Editable finalize failed",
        details: { requestedBy: "api" }
      });
      res.status(400).json(toClientWorkflowJob(job, { includeEvents: true }));
    } catch {
      next(error);
    }
  }
});

app.patch("/api/workflow-jobs/:id/stage", async (req, res, next) => {
  try {
    const job = await updateWorkflowStage(req.params.id, {
      stage: req.body?.stage,
      status: req.body?.status,
      message: req.body?.message || "",
      details: req.body?.details || {}
    });
    res.json(toClientWorkflowJob(job, { includeEvents: true }));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/workflow-jobs/:id/pages/:pageNumber", async (req, res, next) => {
  try {
    const job = await updateWorkflowPage(req.params.id, {
      pageNumber: req.params.pageNumber,
      status: req.body?.status,
      message: req.body?.message || "",
      details: req.body?.details || {}
    });
    res.json(toClientWorkflowJob(job, { includeEvents: true }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/workflow-jobs/:id/events", async (req, res, next) => {
  try {
    const job = await appendWorkflowEvent(req.params.id, {
      type: req.body?.type || "workflow.note",
      message: req.body?.message || "",
      details: req.body?.details || {}
    });
    res.json(toClientWorkflowJob(job, { includeEvents: true }));
  } catch (error) {
    next(error);
  }
});

async function expandUploadsWithPptxImages(uploads = []) {
  const derived = [];
  const enrichedUploads = [];
  for (const file of uploads) {
    const nextFile = { ...file };
    if (/\.pptx$/i.test(file.originalName || file.path || "")) {
      try {
        nextFile.aestheticDiagnosis = compactAestheticReport(await analyzePptxAesthetic(file));
      } catch (error) {
        nextFile.aestheticDiagnosis = {
          version: 1,
          deckName: file.originalName || path.basename(file.path || ""),
          error: error.message || "PPTX aesthetic analysis failed",
          overallScore: null,
          slides: []
        };
        console.warn(`PPTX aesthetic analysis failed for ${file.originalName || file.id}: ${error.message}`);
      }
      try {
        nextFile.extractionAudit = await auditPptxIntake(file);
      } catch (error) {
        nextFile.extractionAudit = {
          version: 1,
          deckName: file.originalName || path.basename(file.path || ""),
          error: error.message || "PPTX intake audit failed",
          slideCount: 0,
          slides: [],
          warnings: ["pptx-intake-audit-failed"]
        };
        console.warn(`PPTX intake audit failed for ${file.originalName || file.id}: ${error.message}`);
      }
    }
    enrichedUploads.push(nextFile);
    try {
      derived.push(...await extractPptxImages(file));
    } catch (error) {
      console.warn(`PPTX media extraction failed for ${file.originalName || file.id}: ${error.message}`);
    }
  }
  return [...enrichedUploads, ...derived];
}

function makeAestheticDiagnosisEvent(materialBrief = {}) {
  const diagnosis = materialBrief.sourceReport?.aestheticDiagnosis;
  if (!diagnosis) return null;
  return makeEvent("aesthetic-diagnosis", `Old deck aesthetic diagnosis: ${diagnosis.overallScore ?? "-"} / low-score ${(diagnosis.lowScoreSlides || []).length} slides`, {
    overallScore: diagnosis.overallScore,
    lowScoreSlides: diagnosis.lowScoreSlides || [],
    highDensitySlides: diagnosis.highDensitySlides || [],
    slideCount: diagnosis.slideCount || 0
  });
}

async function createJob(req, res, mode) {
  const uploads = await expandUploadsWithPptxImages(await getUploads(req.body.fileIds || []));
  const allStyleReferences = await listStyleReferences();
  const styleReferences = filterStyleReferencesForInput(allStyleReferences, req.body);
  const extracted = [];
  for (const file of uploads) {
    try {
      extracted.push({ name: file.originalName, text: await extractText(file) });
    } catch (error) {
      extracted.push({ name: file.originalName, text: `Extraction failed: ${error.message}` });
    }
  }
  const materialBrief = buildMaterialBrief([
    ...extracted,
    {
      name: "输入说明",
      text: [
        req.body.projectName ? `Project: ${req.body.projectName}` : "",
        req.body.audience ? `Audience: ${req.body.audience}` : "",
        req.body.copyMode ? `Mode: ${req.body.copyMode}` : "",
        req.body.notes ? `Notes: ${req.body.notes}` : "",
        Array.isArray(req.body.materials) && req.body.materials.length ? `Materials: ${req.body.materials.join(", ")}` : ""
      ].filter(Boolean).join("\n")
    }
  ]);
  materialBrief.preferences = {
    primaryProduct: req.body.primaryProduct || "",
    includeToc: req.body.includeToc !== false,
    includeRiskChecklist: req.body.includeRiskChecklist !== false
  };
  attachSourceRecognitionReport(materialBrief, uploads);
  await attachCloudSourceAnalysis(materialBrief, uploads, "source-intake");
  const baseRoutePlan = routeDeck({ mode, input: { ...req.body, styleReferences }, materialBrief, uploads });
  const routePlan = applyOutlinePlan(baseRoutePlan, req.body.outlinePlan);
  const input = { ...req.body, extracted, materialBrief, routePlan, styleReferences: styleReferences.map(compactStyleReference) };
  const ai = await generateDeckPlan(input, mode);
  let validated = validateDeck(ai.deck, routePlan);
  const imageBinding = applySourceImageSlots(validated.deck, routePlan, uploads);
  if (imageBinding.report.changedSlides) validated = validateDeck(imageBinding.deck, routePlan);
  materialBrief.imageSlotReport = imageBinding.report;
  const events = [
    makeEvent("route", `Route: ${routePlan.deckType} / ${routePlan.targetSlides} slides / ${routePlan.layoutSequence.map((step) => step.layout).join(" > ")}`, {
      deckType: routePlan.deckType,
      targetSlides: routePlan.targetSlides,
      layoutSequence: routePlan.layoutSequence.map((step) => step.layout),
      reasons: routePlan.routingReasons
    }),
    makeEvent("upload", `Read ${uploads.length} uploaded files`, { files: uploads.map((file) => file.originalName) }),
    makeEvent("extract", materialBrief.summary || "资料已抽取", { inputStrength: materialBrief.inputStrength, charCount: materialBrief.charCount, pageCount: materialBrief.pageCount, confirmationFields: materialBrief.confirmationFields }),
    makeEvent(ai.aiUsed ? "ai" : "fallback", ai.aiUsed ? `AI design plan generated: ${ai.provider?.model || "unknown"}` : "Local fallback design plan generated", { warning: ai.warning || null, provider: ai.provider || null }),
    makeEvent("validate", `Validation completed: ${validated.warnings.length} warnings`, { warnings: validated.warnings }),
    makeEvent("render", "开始生成 PPTX")
  ];
  const aestheticEvent = makeAestheticDiagnosisEvent(materialBrief);
  if (aestheticEvent) events.splice(3, 0, aestheticEvent);
  const job = {
    id: makeId("job"),
    mode,
    status: "ready",
    input,
    deck: validated.deck,
    quality: enrichQuality(validated.quality, uploads, materialBrief, routePlan),
    aiUsed: ai.aiUsed,
    aiProvider: ai.provider || null,
    warning: [ai.warning, ...validated.warnings].filter(Boolean).join("; ") || null,
    files: uploads,
    exports: {},
    previewImages: [],
    events,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  attachAssetFirstState(job, materialBrief, routePlan);
  await ensureVisualTargetSampleForJob(job, { steps: req.body?.visualTargetSteps || 8 });
  await ensureVisualProjectForJob(job);
  await maybeRunOneClickVisualProject(job, req.body || {});
  job.exports.pptx = await buildDeck(job);
  job.exports.editablePptx = job.exports.pptx;
  if (job.visualProject?.visualTargetPptxPath) job.exports.visualTargetPptx = job.visualProject.visualTargetPptxPath;
  job.exportMeta = collectExportMeta(job.exports);
  addEvent(job, "rendered", "PPTX 已生成", { pptx: job.exports.pptx });
  await refreshPreview(job, "已生成");
  await saveJob(job);
  res.json(toClientJob(job));
}

async function buildAgentContext(req, mode) {
  const uploads = await expandUploadsWithPptxImages(await getUploads(req.body.fileIds || []));
  const allStyleReferences = await listStyleReferences();
  const styleReferences = filterStyleReferencesForInput(allStyleReferences, req.body);
  const extracted = [];
  for (const file of uploads) {
    try {
      extracted.push({ name: file.originalName, text: await extractText(file) });
    } catch (error) {
      extracted.push({ name: file.originalName, text: `Extraction failed: ${error.message}` });
    }
  }
  const materialBrief = buildMaterialBrief([
    ...extracted,
    {
      name: "输入说明",
      text: [
        req.body.projectName ? `Project: ${req.body.projectName}` : "",
        req.body.audience ? `Audience: ${req.body.audience}` : "",
        req.body.copyMode ? `Mode: ${req.body.copyMode}` : "",
        req.body.notes ? `Notes: ${req.body.notes}` : "",
        Array.isArray(req.body.materials) && req.body.materials.length ? `Materials: ${req.body.materials.join(", ")}` : ""
      ].filter(Boolean).join("\n")
    }
  ]);
  materialBrief.preferences = {
    primaryProduct: req.body.primaryProduct || "",
    includeToc: req.body.includeToc !== false,
    includeRiskChecklist: req.body.includeRiskChecklist !== false
  };
  attachSourceRecognitionReport(materialBrief, uploads);
  await attachCloudSourceAnalysis(materialBrief, uploads, "agent-source-intake");
  const baseRoutePlan = routeDeck({ mode, input: { ...req.body, styleReferences }, materialBrief, uploads });
  const routePlan = applyOutlinePlan(baseRoutePlan, req.body.outlinePlan);
  const input = { ...req.body, extracted, materialBrief, routePlan, styleReferences: styleReferences.map(compactStyleReference) };
  return { uploads, extracted, materialBrief, baseRoutePlan, routePlan, input };
}

async function runAgentJob(req, res, mode) {
  const agentStartedAt = new Date().toISOString();
  const agentSteps = [];
  const recordStep = (id, label, status = "done", summary = "", details = {}) => {
    agentSteps.push({ id, label, status, summary, details, at: new Date().toISOString() });
  };

  recordStep("intent", "识别任务意图", "done", mode === "optimize" ? "优化 PPT" : "生成 PPT");
  recordStep("extract", "读取资料", "running", "正在抽取上传资料和用户需求");
  const { uploads, materialBrief, routePlan: initialRoutePlan, input } = await buildAgentContext(req, mode);
  let routePlan = initialRoutePlan;
  const styleProofConfirmation = await buildStyleProofConfirmation(req.body.styleProofJobId);
  if (styleProofConfirmation) {
    input.styleProofConfirmation = styleProofConfirmation;
    recordStep("style-confirm", "读取已确认样稿", "done", `${styleProofConfirmation.title || styleProofConfirmation.id} / ${styleProofConfirmation.reviewStatus || "reviewed"}`, styleProofConfirmation);
  } else if (req.body.styleProofJobId) {
    recordStep("style-confirm", "读取已确认样稿", "warn", "未找到对应样稿，按当前风格配置继续生成");
  }
  const agentDecision = buildAgentDecision(mode, req.body, uploads, materialBrief, routePlan);
  const agentPlan = buildAgentPlan(agentDecision, routePlan);
  agentSteps[agentSteps.length - 1] = { ...agentSteps[agentSteps.length - 1], status: "done", summary: materialBrief.summary || "资料已读取" };

  recordStep("route", "Plan route", "done", `${routePlan.deckType} / ${routePlan.targetSlides} slides`, {
    layouts: routePlan.layoutSequence?.map((item) => item.layout) || []
  });
  recordStep("generate", "生成结构化 Deck", "running", "正在调用 AI 或本地 fallback");
  const ai = await generateDeckPlan(input, mode);
  let validated = validateDeck(ai.deck, routePlan);
  const initialImageBinding = applySourceImageSlots(validated.deck, routePlan, uploads);
  if (initialImageBinding.report.changedSlides) validated = validateDeck(initialImageBinding.deck, routePlan);
  materialBrief.imageSlotReport = initialImageBinding.report;
  let quality = enrichQuality(validated.quality, uploads, materialBrief, routePlan);
  agentSteps[agentSteps.length - 1] = {
    ...agentSteps[agentSteps.length - 1],
    status: "done",
    summary: ai.aiUsed ? `AI 已生成：${ai.provider?.model || "unknown"}` : "已使用本地 fallback",
    details: { warning: ai.warning || null }
  };

  recordStep("validate", "Delivery QA", "done", `${validated.deck.slides?.length || 0} slides / ${validated.warnings.length} warnings`);
  const firstAssessment = classifyAgentQuality(validated.deck, quality, routePlan, materialBrief);
  const agentFixes = [];
  if (shouldAgentAutoRepair(firstAssessment)) {
    recordStep("repair", "自动修复", "running", "发现可修复问题，执行 1 轮自动修复", firstAssessment);
    const beforeQuality = summarizeAgentQuality(quality);
    const repair = repairDeckForDelivery(validated.deck, routePlan, uploads, materialBrief);
    validated = validateDeck(repair.deck, routePlan);
    const repairedImageBinding = applySourceImageSlots(validated.deck, routePlan, uploads);
    if (repairedImageBinding.report.changedSlides) validated = validateDeck(repairedImageBinding.deck, routePlan);
    materialBrief.imageSlotReport = repairedImageBinding.report;
    quality = enrichQuality(validated.quality, uploads, materialBrief, routePlan);
    const afterAssessment = classifyAgentQuality(validated.deck, quality, routePlan, materialBrief);
    const fix = {
      triggered: true,
      changes: [...(repair.summary?.changes || []), ...(repairedImageBinding.report.changedSlides ? ["bound-source-image-slots"] : [])],
      before: beforeQuality,
      after: summarizeAgentQuality(quality),
      beforeIssues: firstAssessment,
      afterIssues: afterAssessment
    };
    agentFixes.push(fix);
    agentSteps[agentSteps.length - 1] = { ...agentSteps[agentSteps.length - 1], status: "done", summary: `Auto repaired ${fix.changes.length || 1} issue groups`, details: fix };
  } else {
    recordStep("repair", "自动修复", "skipped", "未发现需要自动修复的阻断问题");
  }

  const events = [
    makeEvent("route", `Route: ${routePlan.deckType} / ${routePlan.targetSlides} slides / ${routePlan.layoutSequence.map((step) => step.layout).join(" > ")}`, {
      deckType: routePlan.deckType,
      targetSlides: routePlan.targetSlides,
      layoutSequence: routePlan.layoutSequence.map((step) => step.layout),
      reasons: routePlan.routingReasons
    }),
    makeEvent("upload", `Read ${uploads.length} uploaded files`, { files: uploads.map((file) => file.originalName) }),
    makeEvent("extract", materialBrief.summary || "资料已抽取", { inputStrength: materialBrief.inputStrength, charCount: materialBrief.charCount, pageCount: materialBrief.pageCount, confirmationFields: materialBrief.confirmationFields }),
    makeEvent("agent", `Agent plan: ${agentDecision.intent} / ${agentDecision.autonomy}`, { agentPlan, agentDecision }),
    ...(styleProofConfirmation ? [makeEvent("style-confirmed", `已继承确认样稿：${styleProofConfirmation.title || styleProofConfirmation.id}`, styleProofConfirmation)] : []),
    ...(agentFixes.length ? [makeEvent("agent-repair", "Agent 已自动修复 1 轮", agentFixes[0])] : []),
    makeEvent(ai.aiUsed ? "ai" : "fallback", ai.aiUsed ? `AI design plan generated: ${ai.provider?.model || "unknown"}` : "Local fallback design plan generated", { warning: ai.warning || null, provider: ai.provider || null }),
    makeEvent("validate", `Validation completed: ${validated.warnings.length} warnings`, { warnings: validated.warnings }),
    makeEvent("render", "开始生成 PPTX")
  ];
  const job = {
    id: makeId("job"),
    mode,
    status: "ready",
    input,
    deck: validated.deck,
    quality,
    agentPlan,
    agentSteps,
    agentDecision,
    agentFixes,
    agentStartedAt,
    agentFinishedAt: null,
    aiUsed: ai.aiUsed,
    aiProvider: ai.provider || null,
    warning: [ai.warning, ...validated.warnings].filter(Boolean).join("; ") || null,
    files: uploads,
    exports: {},
    previewImages: [],
    events,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  attachAssetFirstState(job, materialBrief, routePlan);
  recordStep("visual-target", "生成视觉目标样稿", "running", "正在尝试本地 img2 视觉目标样稿");
  const visualTargetSample = await ensureVisualTargetSampleForJob(job, { steps: req.body?.visualTargetSteps || 8 });
  agentSteps[agentSteps.length - 1] = {
    ...agentSteps[agentSteps.length - 1],
    status: visualTargetSample.generated ? "done" : "warn",
    summary: visualTargetSample.generated ? "视觉目标样稿已生成；最终 PPTX 仍从 SceneGraph 渲染" : `视觉目标样稿未生成：${visualTargetSample.reason || visualTargetSample.status}`,
    details: visualTargetSample
  };
  await ensureVisualProjectForJob(job);
  recordStep("visual-project", "生成逐页视觉目标", "running", "按 codex-ppt 式 prompts 生成 origin_image，并保持最终 PPTX 可编辑");
  const visualProjectRun = await maybeRunOneClickVisualProject(job, req.body || {});
  agentSteps[agentSteps.length - 1] = {
    ...agentSteps[agentSteps.length - 1],
    status: visualProjectRun?.status === "blocked" ? "warn" : visualProjectRun?.skipped ? "skipped" : "done",
    summary: visualProjectRun?.skipped
      ? visualProjectRun.reason
      : `origin_image ${job.visualProject?.generatedImages || 0}/${job.visualProject?.slideCount || 0}; visual-target.pptx ${job.visualProject?.visualTargetPptxPath ? "ready" : "pending"}`,
    details: visualProjectRun || {}
  };
  recordStep("render", "生成 PPTX", "running", "正在生成 PPTX 文件");
  job.exports.pptx = await buildDeck(job);
  job.exports.editablePptx = job.exports.pptx;
  if (job.visualProject?.visualTargetPptxPath) job.exports.visualTargetPptx = job.visualProject.visualTargetPptxPath;
  job.exportMeta = collectExportMeta(job.exports);
  agentSteps[agentSteps.length - 1] = { ...agentSteps[agentSteps.length - 1], status: "done", summary: "PPTX 已生成", details: { pptx: job.exports.pptx } };
  addEvent(job, "rendered", "PPTX 已生成", { pptx: job.exports.pptx });
  recordStep("preview", "刷新预览", "running", "正在生成预览图");
  await refreshPreview(job, "已生成");
  const cloudVisualReview = await reviewDeckVisuals({ stage: "final-deck", deck: job.deck, quality: job.quality, routePlan, materialBrief, previewImages: job.previewImages || [] });
  addEvent(job, "cloud-visual-review", cloudVisualReview.used ? "Cloud visual review: " + cloudVisualReview.status : "Cloud visual review skipped: " + (cloudVisualReview.reason || "not available"), cloudVisualReview);
  job.cloudReviews = [...(job.cloudReviews || []), cloudVisualReview];
  job.imageSupplementPlan = buildImageSupplementPlan({ deck: job.deck, routePlan, materialBrief, files: uploads, cloudReviews: job.cloudReviews, visualFixes: [] });
  let latestCloudVisualReview = cloudVisualReview;
  if (shouldRepairVisualReview(cloudVisualReview)) {
    const repair = repairFinalDeckForVisualReview(job.deck, routePlan, materialBrief, uploads, cloudVisualReview, job.imageSupplementPlan);
    if (repair.summary.changes.length) {
      let repairedValidation = validateDeck(repair.deck, routePlan);
      const repairedImageBinding = applySourceImageSlots(repairedValidation.deck, routePlan, uploads);
      if (repairedImageBinding.report.changedSlides) repairedValidation = validateDeck(repairedImageBinding.deck, routePlan);
      materialBrief.imageSlotReport = repairedImageBinding.report;
      job.deck = repairedValidation.deck;
      job.quality = enrichQuality(repairedValidation.quality, uploads, materialBrief, routePlan);
      job.warning = [ai.warning, ...repairedValidation.warnings].filter(Boolean).join("; ") || null;
      job.exports.pptx = await buildDeck(job);
      job.exportMeta = collectExportMeta(job.exports);
      addEvent(job, "visual-auto-repair", "Final deck auto-repaired after cloud visual review", repair.summary);
      await refreshPreview(job, "visual auto repair applied");
      const repairedCloudVisualReview = await reviewDeckVisuals({ stage: "final-deck-repaired", deck: job.deck, quality: job.quality, routePlan, materialBrief, previewImages: job.previewImages || [] });
      job.cloudReviews.push(repairedCloudVisualReview);
      latestCloudVisualReview = repairedCloudVisualReview;
      job.visualFixes = [...(job.visualFixes || []), {
        stage: "final-deck",
        before: cloudVisualReview,
        after: repairedCloudVisualReview,
        changes: repair.summary.changes,
        imagePlanChanges: repair.summary.imagePlanChanges || [],
        at: new Date().toISOString()
      }];
      addEvent(job, "cloud-visual-review", repairedCloudVisualReview.used ? "Cloud visual review after repair: " + repairedCloudVisualReview.status : "Cloud visual review after repair skipped: " + (repairedCloudVisualReview.reason || "not available"), repairedCloudVisualReview);
    }
  }
  let finalAssessment = classifyAgentQuality(job.deck, job.quality, routePlan, materialBrief, job.previewImages || []);
  let finalReview = buildAgentReview("final-deck", job.deck, job.quality, routePlan, materialBrief, uploads, job.previewImages || [], latestCloudVisualReview);
  job.imageSupplementPlan = buildImageSupplementPlan({ deck: job.deck, routePlan, materialBrief, files: uploads, cloudReviews: job.cloudReviews || [], visualFixes: job.visualFixes || [] });
  if (job.imageSupplementPlan?.needed) addEvent(job, "image-supplement-plan", "视觉复审后生成补图/复用原图计划", job.imageSupplementPlan);
  const autoLocal = await maybeAutoApplyLocalImageSupplement(job, routePlan, materialBrief, job.imageSupplementPlan, { stage: "final-deck-auto-local" });
  if (autoLocal.generated) {
    latestCloudVisualReview = autoLocal.cloudVisualReview || latestCloudVisualReview;
    routePlan = autoLocal.routePlan || routePlan;
    job.imageSupplementPlan = buildImageSupplementPlan({ deck: job.deck, routePlan, materialBrief, files: job.files || [], cloudReviews: job.cloudReviews || [], visualFixes: job.visualFixes || [] });
    finalAssessment = classifyAgentQuality(job.deck, job.quality, routePlan, materialBrief, job.previewImages || []);
    finalReview = buildAgentReview("final-deck", job.deck, job.quality, routePlan, materialBrief, job.files || uploads, job.previewImages || [], latestCloudVisualReview);
  }
  agentSteps[agentSteps.length - 1] = { ...agentSteps[agentSteps.length - 1], status: "done", summary: (job.previewImages || []).filter(Boolean).length + " preview images", details: { ...finalAssessment, cloudVisualReview: latestCloudVisualReview, visualFixes: job.visualFixes || [] } };
  job.agentSteps = agentSteps;
  job.agentReviews = [...(job.agentReviews || []), finalReview];
  job.agentDecision = { ...agentDecision, finalAssessment, autoRepaired: agentFixes.length > 0 || Boolean(job.visualFixes?.length) };
  job.agentFinishedAt = new Date().toISOString();
  if (finalAssessment.blocking.length) {
    job.warning = [job.warning, "Agent QA still has blocking issues: " + finalAssessment.blocking.join("; ")].filter(Boolean).join("; ");
  }
  await saveJob(job);
  res.json(toClientJob(job));
}

async function createStylePreviewJob(req, res, mode) {
  const { uploads, materialBrief, routePlan, input } = await buildAgentContext(req, mode);
  const ai = await generateDeckPlan({ ...input, styleProof: true }, mode);
  const validated = validateDeck(ai.deck, routePlan);
  const proofSlides = buildStyleProofSlides(validated.deck, routePlan, uploads);
  const proofRoutePlan = {
    ...routePlan,
    targetSlides: proofSlides.length,
    layoutSequence: proofSlides.map((slide, index) => ({
      index: index + 1,
      layout: slide.layout,
      title: slide.title,
      purpose: slide.visualIntent || slide.subtitle || "",
      storyRole: slide.storyRole || "风格确认"
    }))
  };
  const proofDeck = {
    title: `${validated.deck.title || input.projectName || "PPT"} 风格样稿`,
    summary: "用于确认整套 PPT 的视觉调性、图片处理、标题层级和信息密度。",
    slides: proofSlides
  };
  let proofValidation = validateDeck(proofDeck, proofRoutePlan);
  const proofImageBinding = applySourceImageSlots(proofValidation.deck, routePlan, uploads);
  if (proofImageBinding.report.changedSlides) proofValidation = validateDeck(proofImageBinding.deck, proofRoutePlan);
  materialBrief.imageSlotReport = proofImageBinding.report;
  const proofQuality = enrichQuality(proofValidation.quality, uploads, materialBrief, proofRoutePlan);
  const proofReview = buildAgentReview("style-preview", proofValidation.deck, proofQuality, proofRoutePlan, materialBrief, uploads);
  const job = {
    id: makeId("styleproof"),
    mode: "style-preview",
    status: "style-preview",
    input: { ...input, styleProof: true, fullRoutePlan: routePlan, routePlan: proofRoutePlan },
    deck: proofValidation.deck,
    quality: proofQuality,
    aiUsed: ai.aiUsed,
    aiProvider: ai.provider || null,
    warning: [ai.warning, ...proofValidation.warnings].filter(Boolean).join("; ") || null,
    files: uploads,
    exports: {},
    previewImages: [],
    agentReviews: [proofReview],
    events: [
      makeEvent("agent-review", "样稿已完成多 Agent 复审", proofReview),
      makeEvent("style-preview", `Style preview: ${input.style || routePlan.recommendedTheme || "default"} / ${proofSlides.length} slides`, {
        style: input.style || routePlan.recommendedTheme,
        sourceSlides: proofSlides.map((slide) => slide.title),
        styleReferences: routePlan.styleReferenceStrategy?.count || 0
      }),
      makeEvent(ai.aiUsed ? "ai" : "fallback", ai.aiUsed ? `AI style preview generated: ${ai.provider?.model || "unknown"}` : "Local fallback style preview generated", { provider: ai.provider || null })
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  job.exports.pptx = await buildDeck(job);
  job.exportMeta = collectExportMeta(job.exports);
  addEvent(job, "rendered", "风格样稿 PPTX 已生成", { pptx: job.exports.pptx });
  await refreshPreview(job, "风格样稿已生成");
  const cloudVisualReview = await reviewDeckVisuals({ stage: "style-preview", deck: job.deck, quality: job.quality, routePlan: proofRoutePlan, materialBrief, previewImages: job.previewImages || [] });
  job.cloudReviews = [cloudVisualReview];
  addEvent(job, "cloud-visual-review", cloudVisualReview.used ? `Cloud visual review: ${cloudVisualReview.status}` : `Cloud visual review skipped: ${cloudVisualReview.reason || "not available"}`, cloudVisualReview);
  if (shouldRepairVisualReview(cloudVisualReview)) {
    const beforeReview = cloudVisualReview;
    const repair = repairStyleProofForVisualReview(job.deck, proofRoutePlan, materialBrief, uploads, cloudVisualReview);
    let repairedValidation = validateDeck(repair.deck, proofRoutePlan);
    const repairedImageBinding = applySourceImageSlots(repairedValidation.deck, routePlan, uploads);
    if (repairedImageBinding.report.changedSlides) repairedValidation = validateDeck(repairedImageBinding.deck, proofRoutePlan);
    materialBrief.imageSlotReport = repairedImageBinding.report;
    job.deck = repairedValidation.deck;
    job.quality = enrichQuality(repairedValidation.quality, uploads, materialBrief, proofRoutePlan);
    job.warning = [ai.warning, ...repairedValidation.warnings].filter(Boolean).join("; ") || null;
    job.exports.pptx = await buildDeck(job);
    job.exports.editablePptx = job.exports.pptx;
    if (job.visualProject?.visualTargetPptxPath) job.exports.visualTargetPptx = job.visualProject.visualTargetPptxPath;
    job.exportMeta = collectExportMeta(job.exports);
    addEvent(job, "visual-auto-repair", "样稿已按云端视觉复审自动修复 1 轮", repair.summary);
    await refreshPreview(job, "样稿已自动修复");
    const repairedCloudReview = await reviewDeckVisuals({ stage: "style-preview-repaired", deck: job.deck, quality: job.quality, routePlan: proofRoutePlan, materialBrief, previewImages: job.previewImages || [] });
    job.cloudReviews.push(repairedCloudReview);
    job.visualFixes = [{
      stage: "style-preview",
      before: beforeReview,
      after: repairedCloudReview,
      changes: repair.summary.changes,
      at: new Date().toISOString()
    }];
    addEvent(job, "cloud-visual-review", repairedCloudReview.used ? `修复后云端视觉复审：${repairedCloudReview.status}` : `修复后云端视觉复审跳过：${repairedCloudReview.reason || "not available"}`, repairedCloudReview);
  }
  let latestCloudReview = job.cloudReviews.at(-1) || cloudVisualReview;
  job.imageSupplementPlan = buildImageSupplementPlan({ deck: job.deck, routePlan: proofRoutePlan, materialBrief, files: uploads, cloudReviews: job.cloudReviews || [], visualFixes: job.visualFixes || [] });
  if (job.imageSupplementPlan?.needed) addEvent(job, "image-supplement-plan", "样稿视觉复审后生成补图/复用原图计划", job.imageSupplementPlan);
  const autoLocal = await maybeAutoApplyLocalImageSupplement(job, proofRoutePlan, materialBrief, job.imageSupplementPlan, { stage: "style-preview-auto-local" });
  if (autoLocal.generated) {
    latestCloudReview = autoLocal.cloudVisualReview || latestCloudReview;
    job.imageSupplementPlan = buildImageSupplementPlan({ deck: job.deck, routePlan: proofRoutePlan, materialBrief, files: job.files || [], cloudReviews: job.cloudReviews || [], visualFixes: job.visualFixes || [] });
  }
  job.agentReviews = [buildAgentReview("style-preview", job.deck, job.quality, proofRoutePlan, materialBrief, job.files || uploads, job.previewImages || [], latestCloudReview)];
  await saveJob(job);
  res.json(toClientJob(job));
}

async function ensureVisualTargetSampleForJob(job, options = {}) {
  ensureSceneGraphForJob(job);
  if (job.visualTarget?.sample?.status === "generated" && job.visualTarget.sample.imagePath) {
    return { status: "generated", generated: false, skipped: "already-generated", imagePath: job.visualTarget.sample.imagePath };
  }
  const prompt = cleanClientText(options.prompt) || buildVisualTargetSamplePrompt(job.visualTarget);
  const status = await checkLocalImageStatus();
  if (!status.ok && options.allowCloudFallback !== false) {
    const cloudResult = await tryCloudVisualTargetSample(job, prompt, {
      ...options,
      localReason: status.reason || "local image backend unavailable"
    });
    if (cloudResult.generated) return cloudResult;
  }
  if (!status.ok) {
    job.visualTarget = {
      ...(job.visualTarget || {}),
      sample: {
        ...(job.visualTarget?.sample || {}),
        status: "pending-local-image",
        prompt,
        reason: status.reason || "local image backend unavailable"
      }
    };
    job.sceneGraphRepair = {
      ...(job.sceneGraphRepair || {}),
      status: job.sceneGraphRepair?.status || "planned",
      actions: [
        ...(job.sceneGraphRepair?.actions || []),
        { slideId: "deck", action: "generate-visual-target-sample", status: "pending", reason: job.visualTarget.sample.reason }
      ],
      pendingCount: Number(job.sceneGraphRepair?.pendingCount || 0) + 1
    };
    addEvent(job, "visual-target-sample", "Visual target sample pending: local image backend unavailable", { reason: job.visualTarget.sample.reason });
    return { status: "pending-local-image", generated: false, reason: job.visualTarget.sample.reason };
  }
  try {
    const record = await generateLocalImage({
      prompt,
      width: options.width || 1280,
      height: options.height || 720,
      steps: Number(options.steps || 8),
      seed: options.seed || Date.now(),
      prefix: `visual_target_${job.id}`,
      textSafeArea: "No readable text should be generated; this is composition-only."
    });
    const visualRecord = { ...record, materialRole: "visual-target-reference" };
    job.files = [...(job.files || []), visualRecord];
    job.visualTarget = {
      ...(job.visualTarget || {}),
      sample: {
        ...(job.visualTarget?.sample || {}),
        status: "generated",
        prompt,
        imageId: record.id,
        imagePath: record.path,
        imageName: record.originalName,
        provider: record.provider,
        createdAt: record.createdAt,
        purpose: "visual reference only; not used as final PPT background"
      }
    };
    job.sceneGraphRepair = {
      ...(job.sceneGraphRepair || {}),
      completed: [
        ...(job.sceneGraphRepair?.completed || []),
        { slideId: "deck", action: "generate-visual-target-sample", status: "done", imageId: record.id }
      ]
    };
    addEvent(job, "visual-target-sample", "Visual target sample generated as SceneGraph reference only", { image: record.originalName, provider: record.provider });
    ensureSceneGraphForJob(job);
    return { status: "generated", generated: true, imageId: record.id, imageName: record.originalName, provider: record.provider };
  } catch (error) {
    if (options.allowCloudFallback !== false) {
      const cloudResult = await tryCloudVisualTargetSample(job, prompt, {
        ...options,
        localReason: error.message || "local image generation failed"
      });
      if (cloudResult.generated) return cloudResult;
    }
    job.visualTarget = {
      ...(job.visualTarget || {}),
      sample: {
        ...(job.visualTarget?.sample || {}),
        status: "pending-cloud-image",
        prompt,
        reason: error.message || "local image generation failed"
      }
    };
    job.sceneGraphRepair = {
      ...(job.sceneGraphRepair || {}),
      status: "planned",
      actions: [
        ...(job.sceneGraphRepair?.actions || []),
        { slideId: "deck", action: "cloud-visual-target-sample", status: "pending", reason: job.visualTarget.sample.reason }
      ],
      pendingCount: Number(job.sceneGraphRepair?.pendingCount || 0) + 1
    };
    addEvent(job, "visual-target-sample-error", "Visual target sample failed locally; cloud handling is pending", { reason: job.visualTarget.sample.reason });
    return { status: "pending-cloud-image", generated: false, reason: job.visualTarget.sample.reason };
  }
}

async function tryCloudVisualTargetSample(job, prompt, options = {}) {
  try {
    const record = await generateCloudImage({
      prompt,
      width: options.width || 1280,
      height: options.height || 720,
      prefix: `visual_target_cloud_${job.id}`,
      textSafeArea: "No readable text should be generated; this is composition-only.",
      materialRole: "visual-target-reference"
    });
    job.files = [...(job.files || []), record];
    job.visualTarget = {
      ...(job.visualTarget || {}),
      sample: {
        ...(job.visualTarget?.sample || {}),
        status: "generated",
        prompt,
        imageId: record.id,
        imagePath: record.path,
        imageName: record.originalName,
        provider: record.provider,
        createdAt: record.createdAt,
        purpose: "visual reference only; not used as final PPT background",
        fallback: { from: "local-image", reason: options.localReason || "" }
      }
    };
    job.sceneGraphRepair = {
      ...(job.sceneGraphRepair || {}),
      completed: [
        ...(job.sceneGraphRepair?.completed || []),
        { slideId: "deck", action: "cloud-visual-target-sample", status: "done", imageId: record.id }
      ]
    };
    addEvent(job, "visual-target-sample", "Cloud visual target sample generated as SceneGraph reference only", { image: record.originalName, provider: record.provider, localReason: options.localReason || "" });
    ensureSceneGraphForJob(job);
    return { status: "generated", generated: true, fallback: "cloud-image", imageId: record.id, imageName: record.originalName, provider: record.provider, localReason: options.localReason || "" };
  } catch (error) {
    return { status: "pending-cloud-image", generated: false, reason: error.message || "cloud image generation failed", localReason: options.localReason || "" };
  }
}

async function buildStyleProofConfirmation(styleProofJobId = "") {
  const id = cleanClientText(styleProofJobId);
  if (!id) return null;
  const proofJob = await getJob(id).catch(() => null);
  if (!proofJob || proofJob.mode !== "style-preview") return null;
  const latestReview = Array.isArray(proofJob.agentReviews) ? proofJob.agentReviews.at(-1) : null;
  const latestCloudReview = Array.isArray(proofJob.cloudReviews) ? proofJob.cloudReviews.at(-1) : null;
  const latestFix = Array.isArray(proofJob.visualFixes) ? proofJob.visualFixes.at(-1) : null;
  const routePlan = proofJob.input?.routePlan || null;
  return {
    id: proofJob.id,
    title: proofJob.deck?.title || "",
    confirmedAt: new Date().toISOString(),
    sampleSlides: (proofJob.deck?.slides || []).slice(0, 4).map((slide, index) => ({
      index: index + 1,
      layout: slide.layout,
      title: slide.title,
      visualIntent: slide.visualIntent,
      imageSlots: normalizeClientList(slide.imageSlots).slice(0, 4)
    })),
    previewCount: (proofJob.previewImages || []).filter(Boolean).length,
    style: routePlan?.recommendedTheme || proofJob.input?.style || "",
    styleFingerprint: routePlan?.styleReferenceStrategy?.fingerprint || null,
    aestheticPlan: routePlan?.aestheticPlan ? {
      theme: routePlan.aestheticPlan.theme,
      visualGrammar: routePlan.aestheticPlan.visualGrammar,
      globalComposition: routePlan.aestheticPlan.globalComposition
    } : null,
    reviewStatus: latestReview?.status || latestCloudReview?.status || "unknown",
    agentFindings: (latestReview?.agents || []).map((agent) => ({
      name: agent.name,
      status: agent.status,
      findings: (agent.findings || []).slice(0, 3)
    })).slice(0, 8),
    cloudVisualReview: latestCloudReview ? {
      used: Boolean(latestCloudReview.used),
      status: latestCloudReview.status || "unknown",
      summary: latestCloudReview.summary || latestCloudReview.reason || "",
      scores: latestCloudReview.scores || null,
      findings: (latestCloudReview.findings || []).slice(0, 5),
      fixSuggestions: (latestCloudReview.fixSuggestions || []).slice(0, 5)
    } : null,
    visualFix: latestFix ? {
      changes: latestFix.changes || [],
      afterStatus: latestFix.after?.status || ""
    } : null,
    imageSupplementPlan: proofJob.imageSupplementPlan ? {
      needed: Boolean(proofJob.imageSupplementPlan.needed),
      status: proofJob.imageSupplementPlan.status,
      targets: (proofJob.imageSupplementPlan.targets || []).slice(0, 4).map((item) => ({
        slide: item.slide,
        title: item.title,
        reason: item.reason,
        action: item.action
      }))
    } : null
  };
}

function buildStyleProofSlides(deck = {}, routePlan = {}, uploads = []) {
  const slides = Array.isArray(deck.slides) ? deck.slides : [];
  const diagnosis = routePlan?.sourceReport?.aestheticDiagnosis || {};
  const priorityPages = [
    ...(diagnosis.lowScoreSlides || []),
    ...(diagnosis.highDensitySlides || [])
  ].map((item) => Number(item)).filter(Boolean);
  const imageNames = uploads
    .filter((file) => /^image\//.test(file.mimeType || "") || /\.(png|jpe?g|webp|svg)$/i.test(file.originalName || file.path || ""))
    .map((file) => file.originalName)
    .filter(Boolean);
  const picked = [];
  const add = (slide) => {
    if (!slide || picked.includes(slide)) return;
    picked.push(slide);
  };
  for (const page of priorityPages) add(slides[page - 1]);
  add(slides[0]);
  add(slides.find((slide) => ["visual", "product-detail", "bundle"].includes(slide.layout)));
  add(slides.find((slide) => ["pricing", "compare", "cards"].includes(slide.layout)));
  add(slides.find((slide) => slide.layout === "closing") || slides.at(-1));
  const proof = picked.filter(Boolean).slice(0, 4).map((slide, index) => ({
    ...slide,
    storyRole: slide.storyRole || "风格确认样稿",
    imageSlots: (slide.imageSlots && slide.imageSlots.length ? slide.imageSlots : imageNames.slice(index, index + 2)).filter(Boolean)
  }));
  if (imageNames.length && !proof.some((slide) => slide.layout === "visual")) {
    proof.splice(Math.min(1, proof.length), 0, {
      layout: "visual",
      title: routePlan.deckType ? `${routePlan.deckType} visual style sample` : "Visual style sample",
      subtitle: "Confirm image presentation, whitespace, color, and title hierarchy",
      storyRole: "风格确认样稿",
      contentSource: "用户图片",
      visualIntent: "Use uploaded PPT/images to validate image presentation style.",
      bullets: ["Keep source image subject", "Control text density", "Keep one visual system"],
      dataPoints: [],
      imageSlots: imageNames.slice(0, 3),
      speakerNotes: "This page validates image treatment for the whole PPT."
    });
  }
  return proof.slice(0, 4);
}

function shouldRepairVisualReview(review = {}) {
  return Boolean(review?.used && ["block", "warn"].includes(review.status));
}

function repairStyleProofForVisualReview(deck = {}, routePlan = {}, materialBrief = {}, files = [], review = {}) {
  const sourceReport = materialBrief.sourceReport || {};
  const styleFingerprint = routePlan?.styleReferenceStrategy?.fingerprint || {};
  const imageNames = files
    .filter(isImageUpload)
    .map((file) => cleanClientText(file.originalName || path.basename(file.path || "")))
    .filter(Boolean);
  const imagesByPage = files.filter(isImageUpload).reduce((map, file) => {
    const page = Number(file.sourceSlide || 0);
    if (!page) return map;
    if (!map.has(page)) map.set(page, []);
    map.get(page).push(file);
    return map;
  }, new Map());
  const sourcePages = Array.isArray(sourceReport.pages) ? sourceReport.pages : [];
  const reviewText = [review.summary, ...(review.findings || []), ...(review.fixSuggestions || [])].join(" ");
  const needsStrongerStyle = /style|tone|weak|generic|match|visual|festival|culture|color|plain/i.test(reviewText);
  const needsImageRepair = /placeholder|image|photo|visual|product|source|missing|empty|material/i.test(reviewText);
  const changes = [];
  const slides = (deck.slides || []).map((slide, index) => {
    const routeStep = routePlan?.layoutSequence?.[index] || {};
    const sourcePage = inferSourcePage(routeStep, slide, index);
    const pageImages = sourcePage ? imagesByPage.get(sourcePage) || [] : [];
    const fallbackPage = sourcePages.find((page) => Number(page.imageCount || 0) > 0 && Number(page.page || 0) !== sourcePage);
    const fallbackImages = fallbackPage ? imagesByPage.get(Number(fallbackPage.page)) || [] : [];
    const nextImages = uniqueTextList([...pageImages, ...normalizeClientList(slide.imageSlots), ...fallbackImages, ...imageNames]).slice(0, slide.layout === "closing" ? 2 : 4);
    const next = {
      ...slide,
      imageSlots: needsImageRepair && nextImages.length ? nextImages : normalizeClientList(slide.imageSlots)
    };
    if (needsStrongerStyle) {
      next.visualIntent = [
        cleanClientText(next.visualIntent),
        styleFingerprint.prompt ? "Strengthen style fingerprint: " + styleFingerprint.prompt : "",
        "Avoid generic gray-white placeholder feel; strengthen recognizable visual direction."
      ].filter(Boolean).join(" ");
      next.speakerNotes = [
        cleanClientText(next.speakerNotes),
        "This page should prove the style direction instead of looking like a generic business template."
      ].filter(Boolean).join(" ");
      if (index === 0) next.subtitle = (next.subtitle || "") + " | style refined";
    }
    if (needsImageRepair && next.imageSlots.length) {
      next.bullets = uniqueTextList([
        ...(next.bullets || []),
        "优先使用原稿产品图，减少占位感。",
        "让图片承载案例和产品信息，而不是只做装饰。"
      ]).slice(0, 4);
    }
    if (needsImageRepair && index === slidesVisualRepairIndex(deck.slides || [])) {
      next.layout = "visual";
      next.title = next.title || "原稿产品视觉样稿";
      next.storyRole = "视觉风格确认";
    }
    return next;
  });
  if (needsStrongerStyle) changes.push("strengthened-style-fingerprint");
  if (needsImageRepair) changes.push("rebound-source-images");
  if (!changes.length) changes.push("recorded-visual-review-noop");
  return {
    deck: { ...deck, slides },
    summary: {
      changes,
      reviewStatus: review.status,
      findings: [...(review.findings || []), ...(review.fixSuggestions || [])].slice(0, 8)
    }
  };
}

function repairFinalDeckForVisualReview(deck = {}, routePlan = {}, materialBrief = {}, files = [], review = {}, imagePlan = null) {
  const reviewText = cleanClientText([review.summary, ...(review.findings || []), ...(review.fixSuggestions || [])].join(" "));
  const styleFingerprint = routePlan?.styleReferenceStrategy?.fingerprint || {};
  const needsStrongerStyle = /style|tone|weak|generic|match|visual|festival|culture|color|plain/i.test(reviewText);
  const needsImageRepair = /placeholder|image|photo|visual|product|source|missing|empty|material/i.test(reviewText);
  const needsDensityRepair = /文字|太密|密度|拥挤|层级|阅读压力/i.test(reviewText);
  const sourceReport = materialBrief.sourceReport || {};
  const sourcePages = Array.isArray(sourceReport.pages) ? sourceReport.pages : [];
  const imageFiles = files.filter(isImageUpload);
  const sourceImagesByPage = imageFiles.reduce((map, file) => {
    const page = Number(file.sourceSlide || 0);
    if (!page) return map;
    if (!map.has(page)) map.set(page, []);
    map.get(page).push(file);
    return map;
  }, new Map());
  const allImageNames = imageFiles
    .map((file) => cleanClientText(file.originalName || path.basename(file.path || "")))
    .filter(Boolean);
  const imagePlanResult = needsImageRepair && imagePlan?.items?.length
    ? applyImageSupplementPlanToDeck(deck, imagePlan, files, routePlan)
    : { deck, summary: { changes: [] } };
  const changes = [];
  if (imagePlanResult.summary?.changedSlides) changes.push("applied-image-supplement-plan");
  const slides = (imagePlanResult.deck.slides || []).map((slide, index) => {
    const routeStep = routePlan?.layoutSequence?.[index] || {};
    const next = {
      ...slide,
      bullets: normalizeClientList(slide.bullets),
      dataPoints: normalizeClientList(slide.dataPoints),
      imageSlots: normalizeImageSlotsForLayout(slide.layout || routeStep.layout || "", slide.imageSlots)
    };
    const sourcePage = inferSourcePage(routeStep, slide, index);
    const pageImages = sourcePage ? sourceImagesByPage.get(sourcePage) || [] : [];
    const fallbackPage = sourcePages.find((page) => Number(page.imageCount || 0) > 0 && Number(page.page || 0) !== sourcePage);
    const fallbackImages = fallbackPage ? sourceImagesByPage.get(Number(fallbackPage.page)) || [] : [];
    const preferredImages = chooseVisualSourceImages(pageImages, files, slide, routeStep)
      .concat(chooseVisualSourceImages(fallbackImages, files, slide, routeStep))
      .map((file) => cleanClientText(file.originalName || path.basename(file.path || "")))
      .filter(Boolean);
    const shouldCarryImage = ["cover", "visual", "product-detail", "bundle"].includes(next.layout || routeStep.layout)
      || /image|visual|product|pack|case|hero/i.test([next.title, next.subtitle, next.visualIntent, routeStep.purpose].join(" "));
    if (needsImageRepair && shouldCarryImage) {
      const targetLayout = imageSlotLimitForLayout(next.layout || routeStep.layout || "") ? (next.layout || routeStep.layout) : "visual";
      const nextSlots = uniqueTextList([...preferredImages, ...next.imageSlots, ...allImageNames]).slice(0, imageSlotLimitForLayout(targetLayout));
      if (nextSlots.length && nextSlots.join("|") !== next.imageSlots.join("|")) {
        next.imageSlots = nextSlots;
        changes.push("strengthened-source-image-use");
      }
      if (!["cover", "closing"].includes(next.layout) && next.imageSlots.length && !["visual", "product-detail", "bundle"].includes(next.layout)) {
        next.layout = index <= 1 ? "visual" : "product-detail";
        changes.push("converted-to-image-led-layout");
      }
    }
    if (needsStrongerStyle) {
      next.visualIntent = uniqueTextList([
        cleanClientText(next.visualIntent),
        styleFingerprint.prompt ? "Strengthen confirmed style fingerprint: " + styleFingerprint.prompt : "",
        routePlan?.recommendedTheme ? "Keep " + routePlan.recommendedTheme + " colors, whitespace, texture, and decoration rhythm." : "",
        "Avoid generic business-template feeling; use background, imagery, and details to carry style."
      ]).join(" ");
      next.speakerNotes = uniqueTextList([
        cleanClientText(next.speakerNotes),
        "Keep source facts while strengthening the confirmed visual direction."
      ]).join(" ");
      if (index === 0 && routePlan?.recommendedTheme && !String(next.subtitle || "").includes(routePlan.recommendedTheme)) {
        next.subtitle = [cleanClientText(next.subtitle), routePlan.recommendedTheme].filter(Boolean).join("; ");
      }
      changes.push("strengthened-confirmed-style");
    }
    if (needsDensityRepair) {
      const maxBullets = ["cover", "quote", "visual"].includes(next.layout) ? 2 : 3;
      if (next.bullets.length > maxBullets) {
        next.bullets = next.bullets.slice(0, maxBullets).map(shortenBullet);
        changes.push("reduced-text-density");
      }
      if (next.dataPoints.length > 5) {
        next.dataPoints = next.dataPoints.slice(0, 5);
        changes.push("reduced-data-density");
      }
    }
    return next;
  });
  return {
    deck: { ...imagePlanResult.deck, slides, summary: cleanClientText(imagePlanResult.deck.summary) || cleanClientText(deck.summary) || "已按整套视觉复审修复" },
    summary: {
      changes: uniqueTextList(changes),
      imagePlanChanges: imagePlanResult.summary?.changes || [],
      reviewStatus: review.status || "unknown",
      reviewFindings: [...(review.findings || []), ...(review.fixSuggestions || [])].slice(0, 8)
    }
  };
}

function slidesVisualRepairIndex(slides = []) {
  const visualIndex = slides.findIndex((slide) => ["visual", "product-detail", "bundle"].includes(slide.layout));
  return visualIndex === -1 ? Math.min(1, Math.max(0, slides.length - 1)) : visualIndex;
}

function buildImageSupplementPlan({ deck = {}, routePlan = {}, materialBrief = {}, files = [], cloudReviews = [], visualFixes = [] } = {}) {
  const latestReview = [...cloudReviews].reverse().find((review) => review && review.used) || cloudReviews.at(-1) || null;
  const reviewText = cleanClientText([
    latestReview?.summary,
    ...(latestReview?.findings || []),
    ...(latestReview?.fixSuggestions || [])
  ].join(" "));
  const reviewNeedsImages = Boolean(latestReview?.used && ["block", "warn"].includes(latestReview.status) && /占位|缺图|图片|原图|产品|主视觉|视觉|纯色|空白|素材|generate|image|photo|placeholder/i.test(reviewText));
  const sourceReport = materialBrief.sourceReport || {};
  const imageSlotReport = materialBrief.imageSlotReport || {};
  const styleFingerprint = routePlan?.styleReferenceStrategy?.fingerprint || {};
  const reusableImageFiles = files.filter(isReusableSourceImage);
  const sourceImagesByPage = reusableImageFiles.reduce((map, file) => {
    const page = Number(file.sourceSlide || 0);
    if (!page) return map;
    if (!map.has(page)) map.set(page, []);
    map.get(page).push(file);
    return map;
  }, new Map());
  const looseImages = reusableImageFiles
    .filter((file) => !Number(file.sourceSlide || 0))
    .map((file) => cleanClientText(file.originalName || path.basename(file.path || "")))
    .filter(Boolean);
  const slides = Array.isArray(deck.slides) ? deck.slides : [];
  const candidateSlides = slides
    .map((slide, index) => {
      const routeStep = routePlan?.layoutSequence?.[index] || {};
      const sourcePage = inferSourcePage(routeStep, slide, index);
      const sourceImageFiles = sourcePage ? sourceImagesByPage.get(sourcePage) || [] : [];
      const sourceImages = chooseVisualSourceImages(sourceImageFiles, reusableImageFiles, slide, routeStep).map((file) => cleanClientText(file.originalName || path.basename(file.path || "")));
      const currentSlots = normalizeClientList(slide.imageSlots);
      const layout = slide.layout || routeStep.layout;
      const shouldHaveVisual = ["cover", "visual", "product-detail", "bundle"].includes(layout) || sourceImages.length || currentSlots.length;
      if (!shouldHaveVisual && !sourceImages.length && !currentSlots.length) return null;
      if (currentSlots.length && !sourceImages.length) return null;
      const lacksReliableImage = shouldHaveVisual && !sourceImages.length && !currentSlots.length;
      const hasSourceButWeak = shouldHaveVisual && sourceImages.length && (!currentSlots.length || !currentSlots.some((slot) => sourceImages.includes(slot)) || reviewNeedsImages);
      if (!reviewNeedsImages && !lacksReliableImage && !hasSourceButWeak) return null;
      const action = sourceImages.length ? "use-source-image" : looseImages.length ? "use-uploaded-image" : "need-remote-generation";
      const foregroundCandidate = action !== "need-remote-generation" && /product-detail|bundle|visual|产品|单品|礼盒|包装|主图|抠图|前景|cutout|foreground/i.test([slide.layout, slide.title, slide.subtitle, slide.visualIntent, routeStep.purpose].join(" "));
      const materialRole = foregroundCandidate
        ? "foreground-cutout-candidate"
        : "background-atmosphere";
      return {
        slide: index + 1,
        title: cleanClientText(slide.title) || "Slide " + (index + 1),
        layout: slide.layout || routeStep.layout || "",
        sourcePage,
        currentImageSlots: currentSlots,
        availableSourceImages: sourceImages.slice(0, 6),
        availableUploadedImages: sourceImages.length ? [] : looseImages.slice(0, 6),
        action,
        materialRole,
        needsCutout: materialRole === "foreground-cutout-candidate",
        mattingStatus: materialRole === "foreground-cutout-candidate" ? "planned-not-implemented" : "not-needed",
        reason: sourceImages.length
          ? "Source page has reusable images; reuse them before generating new material."
          : looseImages.length
            ? "Slide needs stronger visual material; select from uploaded images first."
            : "Slide lacks reusable images; use local Z-Image first and cloud only as fallback.",
        remotePrompt: buildRemoteImagePrompt(slide, routePlan, styleFingerprint)
      };
    })
    .filter(Boolean)
    .slice(0, 8);
  const needed = Boolean(candidateSlides.length);
  return {
    needed,
    status: needed ? "needs-human-confirmation" : "not-needed",
    stage: latestReview?.stage || null,
    trigger: latestReview?.used ? String(latestReview.status || "unknown") + ":" + String(latestReview.summary || "") : "local-structure-check",
    sourceFacts: {
      oldDeck: Boolean(sourceReport.hasOldDeck),
      sourcePages: sourceReport.pageCount || 0,
      sourceImages: sourceReport.imageCount || 0,
      boundImageSlots: imageSlotReport.boundSlides || 0,
      visualFixRounds: visualFixes.length || 0
    },
    policy: [
      "Style reference images are for color, whitespace, texture, and layout only; they are not factual source images.",
      "PPT optimization should reuse original-deck images first; zero-shot generation should prefer uploaded user material.",
      "Local Z-Image is preferred for background and atmosphere supplements; cloud image is fallback and must be marked.",
      "Supplement images must not fabricate brands, prices, specifications, or promises."
    ],
    items: candidateSlides,
    nextActions: needed
      ? ["Confirm whether to reuse original images", "For missing-image slides use local Z-Image or uploaded material first", "Run visual QA again after supplementing images"]
      : ["No blocking image supplement need found"]
  };
}

function buildRemoteImagePrompt(slide = {}, routePlan = {}, styleFingerprint = {}) {
  const theme = routePlan?.recommendedTheme || "business presentation";
  const style = styleFingerprint?.prompt || "";
  const slideIndex = Number(slide.index || slide.slide || 0);
  const pagePlan = (routePlan?.aestheticPlan?.pagePlans || []).find((plan) => Number(plan.index) === slideIndex)
    || (routePlan?.aestheticPlan?.pagePlans || []).find((plan) => plan.layout === slide.layout)
    || null;
  const facts = uniqueTextList([slide.title, slide.subtitle, ...(slide.bullets || []), ...(slide.dataPoints || [])]).slice(0, 5).join("; ");
  return [
    pagePlan?.comfyPrompt || "Create a PPT visual asset for: " + (cleanClientText(slide.title) || "presentation slide") + ".",
    "Style: " + theme + (style ? "; " + style : "") + ".",
    pagePlan?.textSafeArea ? "Keep this text-safe area visually quiet: " + pagePlan.textSafeArea + "." : "Leave a clear empty text-safe area.",
    pagePlan?.layers ? "Layer plan: background=" + pagePlan.layers.background + ", text=" + pagePlan.layers.text + ", image=" + pagePlan.layers.image + ", ornament=" + pagePlan.layers.ornament + "." : "",
    facts ? "Must preserve factual content only as abstract context, do not invent product specs/prices: " + facts + "." : "Do not invent product specs, prices, logos, certifications, or brand claims.",
    "No readable fake text, no fake logos, no misleading product claims."
  ].filter(Boolean).join(" ");
}

function buildLocalImagePrompt(item = {}, routePlan = {}) {
  const pagePlan = findAestheticPagePlan(routePlan, item);
  const theme = routePlan?.aestheticPlan?.theme || routePlan?.recommendedTheme || "premium business presentation";
  return [
    pagePlan?.comfyPrompt || routePlan?.aestheticPlan?.comfy?.basePrompt || "premium " + theme + " presentation background",
    pagePlan?.textSafeArea ? "keep the planned text-safe area visually quiet: " + pagePlan.textSafeArea : "large clean empty area reserved for text overlay",
    pagePlan?.layers ? "poster-like PPT layer plan: background " + pagePlan.layers.background + ", image area " + pagePlan.layers.image + ", ornament " + pagePlan.layers.ornament : "",
    "abstract visual support only, no factual product claims",
    "no readable text, no letters, no numbers, no Chinese characters, no captions, no labels, no logo, no watermark",
    "clean editable PPT background, 16:9 composition"
  ].filter(Boolean).join(", ");
}

function buildCloudCutoutPrompt(item = {}, routePlan = {}) {
  return [
    "Remove the background and return a transparent PNG cutout for PowerPoint composition.",
    "Slide: " + (item.title || item.slide || "") + ".",
    "Deck style: " + (routePlan?.recommendedTheme || routePlan?.aestheticPlan?.theme || "presentation") + ".",
    "Preserve the main subject edges. Do not add new text, logos, products, labels, shadows, or claims."
  ].filter(Boolean).join(" ");
}

function findAestheticPagePlan(routePlan = {}, item = {}) {
  return (routePlan?.aestheticPlan?.pagePlans || []).find((plan) => Number(plan.index) === Number(item.slide || 0))
    || (routePlan?.aestheticPlan?.pagePlans || []).find((plan) => plan.layout === item.layout)
    || null;
}

function localImageAutoConfig() {
  const env = globalThis.process?.env || {};
  return {
    enabled: env.LOCAL_IMAGE_AUTO_SUPPLEMENT !== "false",
    maxTargets: Math.max(0, Math.min(6, Number(env.LOCAL_IMAGE_AUTO_LIMIT || 3))),
    width: Number(env.LOCAL_IMAGE_AUTO_WIDTH || 768),
    height: Number(env.LOCAL_IMAGE_AUTO_HEIGHT || 768),
    steps: Number(env.LOCAL_IMAGE_AUTO_STEPS || 8)
  };
}

function needsCutoutAsset(item = {}) {
  const text = cleanClientText([item.title, item.layout, item.reason, item.remotePrompt].join(" "));
  return /product-detail|bundle|cards|visual|产品|单品|礼盒|包装|主图|抠图|透明|前景|cutout|transparent|foreground|hero/i.test(text)
    && !/background|底图|氛围|纹理/i.test(text);
}

function annotateMaterialTarget(item = {}) {
  const cutout = needsCutoutAsset(item);
  return {
    ...item,
    materialRole: cutout ? "foreground-cutout-candidate" : "background-atmosphere",
    needsCutout: cutout,
    mattingStatus: cutout ? "planned-not-implemented" : "not-needed"
  };
}

async function generateSupplementImageForItem(job, item, routePlan = {}, options = {}) {
  const pagePlan = findAestheticPagePlan(routePlan, item);
  const localPrompt = buildLocalImagePrompt(item, routePlan);
  try {
    const status = await checkLocalImageStatus();
    if (!status.ok) throw new Error(status.reason || "local image backend unavailable");
    const record = await generateLocalImage({
      prompt: localPrompt,
      width: options.width || 768,
      height: options.height || 768,
      steps: options.steps || 8,
      seed: options.seed || Date.now() + Number(item.slide || 0),
      textSafeArea: pagePlan?.textSafeArea || "",
      prefix: "job_" + job.id + "_slide_" + item.slide + "_zimage"
    });
    annotateGeneratedSupplementRecord(record, item, "local-zimage");
    return { record, provider: record.provider || "local-zimage", fallback: false };
  } catch (localError) {
    if (options.allowCloudFallback === false) throw localError;
    try {
      const record = await generateCloudImage({
        prompt: item.remotePrompt || localPrompt,
        width: options.width || 1024,
        height: options.height || 1024,
        prefix: "job_" + job.id + "_slide_" + item.slide + "_cloud",
        textSafeArea: pagePlan?.textSafeArea || "",
        materialRole: item.materialRole || "background-atmosphere"
      });
      annotateGeneratedSupplementRecord(record, item, "cloud-image");
      record.fallback = { from: "local-image", reason: localError.message || "local image generation failed" };
      addEvent(job, "cloud-image-fallback", "云端补图已执行：本地不可用或失败", {
        slide: item.slide,
        title: item.title,
        localReason: record.fallback.reason,
        image: record.originalName
      });
      return { record, provider: record.provider || "cloud-image", fallback: true, localReason: record.fallback.reason };
    } catch (cloudError) {
      const failure = {
        slide: item.slide,
        title: item.title,
        action: "need-remote-generation",
        status: "pending-cloud-image",
        localReason: localError.message || "local image generation failed",
        cloudReason: cloudError.message || "cloud image generation failed",
        at: new Date().toISOString()
      };
      job.imageSupplementFailures = [...(job.imageSupplementFailures || []), failure];
      job.sceneGraphRepair = {
        ...(job.sceneGraphRepair || {}),
        status: "planned",
        actions: [
          ...(job.sceneGraphRepair?.actions || []),
          { slideId: "slide_" + String(item.slide || 0).padStart(2, "0"), action: "bind-or-generate-independent-image", status: "pending", reason: failure.cloudReason }
        ],
        pendingCount: Number(job.sceneGraphRepair?.pendingCount || 0) + 1
      };
      addEvent(job, "cloud-image-fallback-failed", "本地和云端补图均未完成，已记录待处理", failure);
      return { record: null, provider: "none", fallback: true, failed: true, failure };
    }
  }
}

function annotateGeneratedSupplementRecord(record, item, source = "") {
  record.sourceSlide = Number(item.slide || 0);
  record.materialRole = item.materialRole;
  record.needsCutout = item.needsCutout;
  record.mattingStatus = item.mattingStatus;
  if (source) record.source = source;
  return record;
}

async function maybeAutoApplyLocalImageSupplement(job, routePlan, materialBrief, plan, options = {}) {
  const config = localImageAutoConfig();
  if (!config.enabled || !plan?.needed || !config.maxTargets) return { generated: 0, skipped: "disabled-or-not-needed" };
  const status = await checkLocalImageStatus();
  if (!status.ok) {
    addEvent(job, "local-image-auto-skip", "Local image auto supplement skipped: " + (status.reason || "offline"), { status });
  }
  const targets = (plan.items || [])
    .filter((item) => item.action === "need-remote-generation")
    .map(annotateMaterialTarget)
    .slice(0, config.maxTargets);
  if (!targets.length) return { generated: 0, skipped: "no-local-generation-targets" };
  const generated = [];
  for (const item of targets) {
    const generatedRecord = await generateSupplementImageForItem(job, item, routePlan, {
      width: options.width || config.width,
      height: options.height || config.height,
      steps: options.steps || config.steps,
      seed: (options.seed || Date.now()) + Number(item.slide || 0),
      allowCloudFallback: options.allowCloudFallback !== false
    });
    const record = generatedRecord.record;
    if (!record) {
      generated.push({ item, failed: true, failure: generatedRecord.failure });
      continue;
    }
    let slotRecord = record;
    let matting = null;
    if (item.needsCutout) {
      matting = await cutoutImage(record, { prompt: buildCloudCutoutPrompt(item, routePlan) });
      record.matting = matting;
      record.mattingStatus = matting.status || "failed";
      if (matting.record) {
        slotRecord = matting.record;
        job.files = [...(job.files || []), record, slotRecord];
      } else {
        job.files = [...(job.files || []), record];
      }
    } else {
      job.files = [...(job.files || []), record];
    }
    generated.push({ item, record: slotRecord, originalRecord: record, matting });
    const slideIndex = Number(item.slide || 0) - 1;
    if (job.deck?.slides?.[slideIndex]) {
      const slide = job.deck.slides[slideIndex];
      const slotLimit = imageSlotLimitForLayout(slide.layout || "");
      slide.imageSlots = slotLimit
        ? uniqueTextList([slotRecord.originalName, ...normalizeClientList(slide.imageSlots)]).slice(0, slotLimit)
        : [];
      slide.visualIntent = [
        cleanClientText(slide.visualIntent),
        item.needsCutout
          ? "Local Z-Image generated a foreground material candidate; local matting was attempted first, with cloud matting fallback only if needed."
          : "Local Z-Image generated a background or atmosphere material; it is visual material, not a factual source."
      ].filter(Boolean).join(" ");
    }
  }
  const nextRoutePlan = syncRoutePlanWithSlides(routePlan, job.deck.slides || [], options.stage || "auto-local-image-supplement");
  if (job.input) {
    job.input.routePlan = nextRoutePlan;
    job.input.materialBrief = materialBrief;
  }
  const validated = validateDeck(job.deck, nextRoutePlan);
  job.deck = validated.deck;
  job.quality = enrichQuality(validated.quality, job.files || [], materialBrief, nextRoutePlan);
  job.warning = validated.warnings.length ? validated.warnings.join("; ") : job.warning;
  addEvent(job, "local-image-auto-supplement", "Auto supplement generated " + generated.filter((entry) => !entry.failed && entry.record).length + " PPT materials", {
    provider: "local-first-cloud-fallback",
    generated: generated.filter((entry) => !entry.failed && entry.record).map(({ item, record, originalRecord }) => ({
      slide: item.slide,
      title: item.title,
      image: originalRecord?.originalName || record.originalName,
      materialRole: originalRecord?.materialRole || record.materialRole,
      needsCutout: originalRecord?.needsCutout || false,
      mattingStatus: originalRecord?.mattingStatus || record.mattingStatus,
      finalImage: record.originalName,
      mattingMethod: originalRecord?.matting?.method || null,
      prompt: originalRecord?.prompt || record.prompt,
      seed: originalRecord?.seed || record.seed,
      visualQa: originalRecord?.visualQa || record.visualQa || null
    }))
  });
  job.exports.pptx = await buildDeck(job);
  job.exportMeta = collectExportMeta(job.exports);
  await refreshPreview(job, "Auto image supplement applied");
  const cloudVisualReview = await reviewDeckVisuals({ stage: options.stage || String(job.mode || "job") + "-auto-local-image", deck: job.deck, quality: job.quality, routePlan: nextRoutePlan, materialBrief, previewImages: job.previewImages || [] });
  job.cloudReviews = [...(job.cloudReviews || []), cloudVisualReview];
  addEvent(job, "cloud-visual-review", cloudVisualReview.used ? "Cloud visual review after local materials: " + cloudVisualReview.status : "Cloud visual review after local materials skipped: " + (cloudVisualReview.reason || "not available"), cloudVisualReview);
  return { generated: generated.filter((entry) => !entry.failed && entry.record).length, failed: generated.filter((entry) => entry.failed || !entry.record).length, generatedRecords: generated, routePlan: nextRoutePlan, cloudVisualReview };
}

function applyImageSupplementPlanToDeck(deck = {}, plan = {}, files = [], routePlan = null) {
  const itemsBySlide = new Map((plan?.items || []).map((item) => [Number(item.slide || 0), item]));
  const changes = [];
  const slides = (deck.slides || []).map((slide, index) => {
    const item = itemsBySlide.get(index + 1);
    if (!item) return slide;
    const routeStep = routePlan?.layoutSequence?.[index] || {};
    const currentLayout = slide.layout || routeStep.layout || "";
    const targetLayout = ["cover", "closing"].includes(currentLayout)
      ? currentLayout
      : imageSlotLimitForLayout(currentLayout) ? currentLayout : "visual";
    const slotLimit = imageSlotLimitForLayout(targetLayout);
    if (!slotLimit) return { ...slide, imageSlots: [] };
    const sourcePage = Number(item.sourcePage || inferSourcePage(routeStep, slide, index) || 0);
    const sourceFiles = files.filter((file) => isImageUpload(file) && Number(file.sourceSlide || 0) === sourcePage);
    const preferred = chooseVisualSourceImages(sourceFiles, files, slide, routeStep)
      .map((file) => cleanClientText(file.originalName || path.basename(file.path || "")))
      .filter(Boolean)
      .slice(0, 3);
    const fallback = normalizeClientList(item.availableSourceImages).slice(0, 3);
    const nextSlots = uniqueTextList([...preferred, ...fallback, ...normalizeClientList(slide.imageSlots)]).slice(0, slotLimit);
    if (!nextSlots.length) return slide;
    changes.push({
      slide: index + 1,
      title: cleanClientText(slide.title),
      action: item.action,
      sourcePage,
      before: normalizeClientList(slide.imageSlots),
      after: nextSlots
    });
    return {
      ...slide,
      layout: targetLayout,
      imageSlots: nextSlots,
      visualIntent: [
        cleanClientText(slide.visualIntent),
        "已按补图计划优先复用原稿同页大图，并重新跑视觉质检。"
      ].filter(Boolean).join(" ")
    };
  });
  return {
    deck: { ...deck, slides },
    summary: {
      changedSlides: changes.length,
      changes,
      policy: plan?.policy || []
    }
  };
}

app.post("/api/workflow-outline/plan", async (req, res, next) => {
  try {
    const uploads = await expandUploadsWithPptxImages(await getUploads(req.body.fileIds || []));
    const extracted = [];
    for (const file of uploads) {
      try {
        extracted.push({ name: file.originalName, text: await extractText(file) });
      } catch (error) {
        extracted.push({ name: file.originalName, text: "Extraction failed: " + error.message });
      }
    }
    const materialBrief = buildMaterialBrief([
      ...extracted,
      {
        name: "输入说明",
        text: [
          req.body.projectName ? "Project: " + req.body.projectName : "",
          req.body.audience ? "Audience: " + req.body.audience : "",
          req.body.copyMode ? "Mode: " + req.body.copyMode : "",
          req.body.notes ? "Notes: " + req.body.notes : "",
          Array.isArray(req.body.materials) && req.body.materials.length ? "Materials: " + req.body.materials.join(", ") : ""
        ].filter(Boolean).join("\n")
      }
    ]);
    materialBrief.preferences = {
      primaryProduct: req.body.primaryProduct || "",
      includeToc: req.body.includeToc !== false,
      includeRiskChecklist: req.body.includeRiskChecklist !== false
    };
    attachSourceRecognitionReport(materialBrief, uploads);
    const outlinePlan = buildSkillFirstOutlineDraft({ input: req.body, materialBrief, uploads });
    res.json({
      ok: true,
      outlinePlan,
      materialBrief: {
        summary: materialBrief.summary,
        inputStrength: materialBrief.inputStrength,
        confirmationFields: materialBrief.confirmationFields || [],
        imageCount: materialBrief.imageCount || 0,
        priceCount: materialBrief.prices?.length || 0,
        productCount: materialBrief.productCandidates?.length || 0,
        pageCount: materialBrief.pageCount || 0,
        charCount: materialBrief.charCount || 0,
        sourceReport: materialBrief.sourceReport || null,
        routingReasons: outlinePlan.routingReasons || []
      }
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs/outline", async (req, res, next) => {
  try {
    const uploads = await expandUploadsWithPptxImages(await getUploads(req.body.fileIds || []));
    const extracted = [];
    for (const file of uploads) {
      try {
        extracted.push({ name: file.originalName, text: await extractText(file) });
      } catch (error) {
        extracted.push({ name: file.originalName, text: "Extraction failed: " + error.message });
      }
    }
    const materialBrief = buildMaterialBrief([
      ...extracted,
      {
        name: "输入说明",
        text: [
          req.body.projectName ? "Project: " + req.body.projectName : "",
          req.body.audience ? "Audience: " + req.body.audience : "",
          req.body.copyMode ? "Mode: " + req.body.copyMode : "",
          req.body.notes ? "Notes: " + req.body.notes : "",
          Array.isArray(req.body.materials) && req.body.materials.length ? "Materials: " + req.body.materials.join(", ") : ""
        ].filter(Boolean).join("\n")
      }
    ]);
    materialBrief.preferences = {
      primaryProduct: req.body.primaryProduct || "",
      includeToc: req.body.includeToc !== false,
      includeRiskChecklist: req.body.includeRiskChecklist !== false
    };
    attachSourceRecognitionReport(materialBrief, uploads);
    const allStyleReferences = await listStyleReferences();
    const styleReferences = filterStyleReferencesForInput(allStyleReferences, req.body);
    const routePlan = routeDeck({ mode: req.body.mode || "generate", input: { ...req.body, styleReferences }, materialBrief, uploads });
    res.json({
      ok: true,
      outlinePlan: routePlan,
      materialBrief: {
        summary: materialBrief.summary,
        inputStrength: materialBrief.inputStrength,
        confirmationFields: materialBrief.confirmationFields || [],
        imageCount: materialBrief.imageCount || 0,
        priceCount: materialBrief.prices?.length || 0,
        productCount: materialBrief.productCandidates?.length || 0,
        pageCount: materialBrief.pageCount || 0,
        charCount: materialBrief.charCount || 0,
        sourceReport: materialBrief.sourceReport || null,
        routingReasons: routePlan.routingReasons || []
      }
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs/generate", async (req, res, next) => {
  try {
    rejectLegacyGenerator(res);
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs/optimize", async (req, res, next) => {
  try {
    rejectLegacyGenerator(res);
  } catch (error) {
    next(error);
  }
});

function rejectLegacyGenerator(res) {
  return res.status(410).json({
    ok: false,
    code: "LEGACY_GENERATOR_REMOVED",
    error: "旧版一键生成器已移除。请使用 Skill-first 工作流：codex-ppt 生成图片型 PPT，再通过 image-to-editable-ppt/editppt 重建可编辑 PPT。"
  });
}

app.post("/api/jobs/style-preview", async (req, res, next) => {
  try {
    rejectLegacyGenerator(res);
  } catch (error) {
    next(error);
  }
});

app.get("/api/jobs", async (_req, res, next) => {
  try {
    const jobs = await listJobs();
    const normalized = [];
    const errors = [];
    for (const job of jobs) {
      try {
        normalized.push(toClientJob(job));
      } catch (error) {
        errors.push({ id: job?.id || "unknown", error: error.message || "job normalization failed" });
        normalized.push(toSafeClientJob(job, error));
      }
    }
    res.json({ jobs: normalized, errors });
  } catch (error) {
    next(error);
  }
});

app.get("/api/design-system", async (_req, res, next) => {
  try {
    const references = await listStyleReferences();
    res.json({
      legacyTemplatesRemoved: true,
      themes: [],
      layouts: [],
      templatePacks: [],
      skillRules: {
        "codex-ppt": [
          "先生成视觉统一的图片型 PPT",
          "样张确认后再进入全量图片页生成",
          "外部图片 API 调用前必须记录额度授权"
        ],
        "image-to-editable-ppt": [
          "只接收图片型 PPT / PDF / 页面图片作为重建源",
          "页面级任务必须有真实产物证据",
          "最终交付以 editable-final.pptx 和 validation 证据为准"
        ]
      },
      styleReferences: references.map(normalizeStyleReference)
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/jobs/:id", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "任务不存在。" });
    res.json(toClientJob(job));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/jobs/:id", async (req, res, next) => {
  try {
    const deleted = await deleteJob(req.params.id);
    if (!deleted) return res.status(404).json({ error: "任务不存在。" });
    res.json({ ok: true, deleted: { id: deleted.id, title: deleted.deck?.title || "" } });
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs/:id/slides/:slideIndex/revise", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "任务不存在。" });
    const slideIndex = Number(req.params.slideIndex);
    const beforeLayout = job.deck?.slides?.[slideIndex]?.layout || null;
    const result = await reviseSlide(job.deck, slideIndex, req.body.instruction || "");
    const routePlan = job.input?.routePlan || null;
    const validated = validateDeck(result.deck, routePlan);
    pushUndo(job, "Undo revise slide " + (slideIndex + 1));
    job.deck = validated.deck;
    job.quality = enrichQuality(validated.quality, job.files || [], job.input?.materialBrief, routePlan);
    job.aiUsed = job.aiUsed || result.aiUsed;
    job.aiProvider = result.provider || job.aiProvider || null;
    job.warning = [result.warning, ...validated.warnings].filter(Boolean).join("; ") || job.warning;
    const afterLayout = job.deck?.slides?.[slideIndex]?.layout || null;
    addEvent(job, result.aiUsed ? "revise" : "fallback", "Slide " + (slideIndex + 1) + " revision applied", { instruction: req.body.instruction || "", beforeLayout, afterLayout, warnings: validated.warnings });
    job.updatedAt = new Date().toISOString();
    job.exports.pptx = await buildDeck(job);
    job.exportMeta = collectExportMeta(job.exports);
    addEvent(job, "rendered", "PPTX regenerated after revision", { pptx: job.exports.pptx });
    await refreshPreview(job, "regenerated");
    await saveJob(job);
    res.json(toClientJob(job));
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs/:id/visual-target/sample", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    ensureSceneGraphForJob(job);
    const prompt = cleanClientText(req.body?.prompt) || buildVisualTargetSamplePrompt(job.visualTarget);
    const status = await checkLocalImageStatus();
    if (!status.ok) {
      job.visualTarget = {
        ...(job.visualTarget || {}),
        sample: {
          ...(job.visualTarget?.sample || {}),
          status: "pending-local-image",
          prompt,
          reason: status.reason || "local image backend unavailable"
        }
      };
      job.sceneGraphRepair = {
        ...(job.sceneGraphRepair || {}),
        status: job.sceneGraphRepair?.status || "planned",
        actions: [
          ...(job.sceneGraphRepair?.actions || []),
          { slideId: "deck", action: "generate-visual-target-sample", status: "pending", reason: job.visualTarget.sample.reason }
        ],
        pendingCount: Number(job.sceneGraphRepair?.pendingCount || 0) + 1
      };
      addEvent(job, "visual-target-sample", "Visual target sample pending: local image backend unavailable", { reason: job.visualTarget.sample.reason });
      job.updatedAt = new Date().toISOString();
      await saveJob(job);
      res.json(toClientJob(job));
      return;
    }
    const record = await generateLocalImage({
      prompt,
      width: 1280,
      height: 720,
      steps: Number(req.body?.steps || 8),
      seed: req.body?.seed || Date.now(),
      prefix: "visual_target_" + job.id,
      textSafeArea: "No readable text should be generated; this is composition-only."
    });
    job.files = [...(job.files || []), { ...record, materialRole: "visual-target-reference" }];
    job.visualTarget = {
      ...(job.visualTarget || {}),
      sample: {
        ...(job.visualTarget?.sample || {}),
        status: "generated",
        prompt,
        imageId: record.id,
        imagePath: record.path,
        imageName: record.originalName,
        provider: record.provider,
        createdAt: record.createdAt,
        purpose: "visual reference only; not used as final PPT background"
      }
    };
    job.sceneGraphRepair = {
      ...(job.sceneGraphRepair || {}),
      completed: [
        ...(job.sceneGraphRepair?.completed || []),
        { slideId: "deck", action: "generate-visual-target-sample", status: "done", imageId: record.id }
      ]
    };
    addEvent(job, "visual-target-sample", "Visual target sample generated as SceneGraph reference only", { image: record.originalName, provider: record.provider });
    job.updatedAt = new Date().toISOString();
    await saveJob(job);
    res.json(toClientJob(job));
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs/:id/slides/:slideIndex/update", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "任务不存在。" });
    const slideIndex = Number(req.params.slideIndex);
    const currentSlide = job.deck?.slides?.[slideIndex];
    if (!currentSlide) return res.status(404).json({ error: "页面不存在。" });
    const incoming = req.body.slide || {};
    const canvasEdits = normalizeCanvasEdits(incoming.canvasEdits || currentSlide.canvasEdits);
    const nextSlide = {
      ...currentSlide,
      layout: cleanClientText(incoming.layout) || currentSlide.layout,
      title: cleanClientText(incoming.title) || currentSlide.title,
      subtitle: cleanClientText(incoming.subtitle),
      storyRole: cleanClientText(incoming.storyRole) || currentSlide.storyRole,
      contentSource: cleanClientText(incoming.contentSource) || currentSlide.contentSource,
      visualIntent: cleanClientText(incoming.visualIntent) || currentSlide.visualIntent,
      speakerNotes: cleanClientText(incoming.speakerNotes),
      bullets: normalizeClientList(incoming.bullets),
      dataPoints: normalizeClientList(incoming.dataPoints),
      imageSlots: normalizeImageSlotsForLayout(incoming.layout || currentSlide.layout, incoming.imageSlots),
      canvasEdits,
      canvasEditsEnabled: Boolean(canvasEdits) || Boolean(currentSlide.canvasEditsEnabled)
    };
    pushUndo(job, "Undo manual edit slide " + (slideIndex + 1));
    job.deck = {
      ...job.deck,
      slides: job.deck.slides.map((slide, index) => (index === slideIndex ? nextSlide : slide))
    };
    const routePlan = syncRoutePlanWithSlides(job.input?.routePlan || null, job.deck.slides || [], "manual-edit");
    if (job.input) job.input.routePlan = routePlan;
    const validated = validateDeck(job.deck, routePlan);
    job.deck = validated.deck;
    job.sceneGraphOverrides = buildSceneGraphOverridesForSlide(job.sceneGraphOverrides, slideIndex, job.deck.slides[slideIndex], incoming);
    job.quality = enrichQuality(validated.quality, job.files || [], job.input?.materialBrief, routePlan);
    job.warning = validated.warnings.length ? validated.warnings.join("; ") : job.warning;
    addEvent(job, "manual-edit", "Slide " + (slideIndex + 1) + " manual edit saved", { warnings: validated.warnings });
    job.updatedAt = new Date().toISOString();
    job.exports.pptx = await buildDeck(job);
    job.exportMeta = collectExportMeta(job.exports);
    await refreshPreview(job, "refreshed");
    await saveJob(job);
    res.json(toClientJob(job));
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs/:id/slides/:slideIndex/action", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "任务不存在。" });
    const slideIndex = Number(req.params.slideIndex);
    const action = cleanClientText(req.body.action);
    const slides = job.deck?.slides || [];
    if (!slides[slideIndex]) return res.status(404).json({ error: "页面不存在。" });
    let nextSlides = [...slides];
    let nextIndex = slideIndex;
    if (action === "duplicate") {
      const source = slides[slideIndex];
      nextSlides.splice(slideIndex + 1, 0, {
        ...source,
        title: (source.title || "Untitled slide") + " copy"
      });
      nextIndex = slideIndex + 1;
    } else if (action === "insert-after" || action === "insert-before") {
      const layout = cleanClientText(req.body.layout) || "section";
      const defaults = getInsertedSlideDefaults(layout);
      const insertIndex = action === "insert-before" ? slideIndex : slideIndex + 1;
      nextSlides.splice(insertIndex, 0, {
        layout,
        title: defaults.title,
        subtitle: defaults.subtitle,
        storyRole: defaults.storyRole,
        contentSource: "User input",
        bullets: defaults.bullets,
        dataPoints: defaults.dataPoints,
        imageSlots: [],
        visualIntent: defaults.visualIntent,
        speakerNotes: ""
      });
      nextIndex = insertIndex;
    } else if (action === "delete") {
      if (slides.length <= 1) return res.status(400).json({ error: "At least one slide is required" });
      nextSlides.splice(slideIndex, 1);
      nextIndex = Math.max(0, Math.min(slideIndex, nextSlides.length - 1));
    } else if (action === "move-up") {
      if (slideIndex > 0) {
        [nextSlides[slideIndex - 1], nextSlides[slideIndex]] = [nextSlides[slideIndex], nextSlides[slideIndex - 1]];
        nextIndex = slideIndex - 1;
      }
    } else if (action === "move-down") {
      if (slideIndex < slides.length - 1) {
        [nextSlides[slideIndex + 1], nextSlides[slideIndex]] = [nextSlides[slideIndex], nextSlides[slideIndex + 1]];
        nextIndex = slideIndex + 1;
      }
    } else if (action === "move-to") {
      const toIndex = Math.max(0, Math.min(nextSlides.length - 1, Number(req.body.toIndex)));
      const [moved] = nextSlides.splice(slideIndex, 1);
      nextSlides.splice(toIndex, 0, moved);
      nextIndex = toIndex;
    } else {
      return res.status(400).json({ error: "Unknown slide action" });
    }
    pushUndo(job, "Undo slide action: " + action);
    job.deck = { ...job.deck, slides: nextSlides };
    const routePlan = syncRoutePlanWithSlides(job.input?.routePlan || null, nextSlides, action);
    if (job.input) job.input.routePlan = routePlan;
    const validated = validateDeck(job.deck, routePlan);
    job.deck = validated.deck;
    job.quality = enrichQuality(validated.quality, job.files || [], job.input?.materialBrief, routePlan);
    job.warning = validated.warnings.length ? validated.warnings.join("; ") : job.warning;
    addEvent(job, "slide-action", "Slide action completed: " + action, { action, from: slideIndex, to: nextIndex, slideCount: job.deck.slides.length });
    job.updatedAt = new Date().toISOString();
    job.exports.pptx = await buildDeck(job);
    job.exportMeta = collectExportMeta(job.exports);
    await refreshPreview(job, "slide structure refreshed");
    await saveJob(job);
    res.json({ ...toClientJob(job), selectedSlide: nextIndex });
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs/:id/export", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "任务不存在。" });
    const formats = req.body.formats || ["pptx"];
    if (formats.includes("pdf") || formats.includes("png")) {
      ensureSceneGraphForJob(job);
      const exportQuality = enrichQuality(job.quality || {}, job.files || [], job.input?.materialBrief || {}, job.input?.routePlan || null);
      const exportQa = buildHybridQa(job, { ...exportQuality, sceneGraphQa: job.sceneGraphQa, visualCompare: job.visualCompare }, job.previewImages || []);
      const exportGate = buildFinalExportGate({ formats, hybridQa: exportQa, allowBlockedExport: req.body.allowBlockedExport });
      if (exportGate.blocked) {
        job.exportWarning = exportGate.reason;
        addEvent(job, "export-blocked", job.exportWarning, { formats, hybridQa: exportQa, exportGate });
        job.updatedAt = new Date().toISOString();
        await saveJob(job);
        res.status(409).json({ ...toClientJob(job), error: job.exportWarning, exportBlocked: true });
        return;
      }
      try {
        const result = await exportWithPowerPoint(job.exports.pptx, formats.filter((item) => item !== "pptx"));
        job.exports = { ...job.exports, ...result };
        job.exportMeta = collectExportMeta(job.exports);
        job.exportWarning = null;
        addEvent(job, "export", "Export completed: " + formats.join(", "), result);
      } catch (error) {
        job.exportWarning = "PDF/PNG export failed: " + error.message;
        addEvent(job, "export-error", job.exportWarning, { formats });
      }
    }
    job.updatedAt = new Date().toISOString();
    await saveJob(job);
    res.json(toClientJob(job));
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs/:id/preview", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "任务不存在。" });
    if (!job.exports?.pptx) return res.status(400).json({ error: "当前任务还没有 PPTX 文件。" });
    await refreshPreview(job, "regenerated");
    job.updatedAt = new Date().toISOString();
    await saveJob(job);
    res.json(toClientJob(job));
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs/:id/rewrite", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "任务不存在。" });
    const instruction = cleanClientText(req.body.instruction);
    if (!instruction) return res.status(400).json({ error: "Please enter rewrite instruction" });
    const beforeLayouts = (job.deck?.slides || []).map((slide) => slide.layout);
    pushUndo(job, "Undo deck rewrite: " + instruction);
    job.deck = rewriteDeckLocally(job.deck, instruction);
    const routePlan = job.input?.routePlan || null;
    const validated = validateDeck(job.deck, routePlan);
    job.deck = validated.deck;
    job.quality = enrichQuality(validated.quality, job.files || [], job.input?.materialBrief, routePlan);
    job.warning = validated.warnings.length ? validated.warnings.join("; ") : job.warning;
    addEvent(job, "deck-rewrite", "Deck rewritten by instruction", {
      instruction,
      beforeLayouts,
      afterLayouts: job.deck.slides.map((slide) => slide.layout)
    });
    job.updatedAt = new Date().toISOString();
    job.exports.pptx = await buildDeck(job);
    job.exportMeta = collectExportMeta(job.exports);
    await refreshPreview(job, "deck rewrite refreshed");
    await saveJob(job);
    res.json(toClientJob(job));
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs/:id/repair", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "任务不存在。" });
    pushUndo(job, "Undo delivery QA repair");
    let routePlan = job.input?.routePlan || null;
    const report = repairDeckForDelivery(job.deck, routePlan, job.files || [], job.input?.materialBrief || {});
    job.deck = report.deck;
    routePlan = syncRoutePlanWithSlides(routePlan, job.deck.slides || [], "repair");
    if (job.input) job.input.routePlan = routePlan;
    const validated = validateDeck(job.deck, routePlan);
    job.deck = validated.deck;
    job.quality = enrichQuality(validated.quality, job.files || [], job.input?.materialBrief, routePlan);
    job.warning = validated.warnings.length ? validated.warnings.join("; ") : null;
    addEvent(job, "delivery-repair", "Delivery QA repair completed", report.summary);
    job.updatedAt = new Date().toISOString();
    job.exports.pptx = await buildDeck(job);
    job.exportMeta = collectExportMeta(job.exports);
    await refreshPreview(job, "delivery repair refreshed");
    await saveJob(job);
    res.json(toClientJob(job));
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs/:id/apply-image-supplement", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "任务不存在。" });
    pushUndo(job, "Undo image supplement plan");
    let routePlan = job.input?.routePlan || null;
    const materialBrief = job.input?.materialBrief || {};
    const report = applyImageSupplementPlanToDeck(job.deck, job.imageSupplementPlan, job.files || [], routePlan);
    job.deck = report.deck;
    const imageBinding = applySourceImageSlots(job.deck, routePlan, job.files || []);
    job.deck = imageBinding.deck;
    materialBrief.imageSlotReport = imageBinding.report;
    routePlan = syncRoutePlanWithSlides(routePlan, job.deck.slides || [], "image-supplement");
    if (job.input) {
      job.input.routePlan = routePlan;
      job.input.materialBrief = materialBrief;
    }
    const validated = validateDeck(job.deck, routePlan);
    job.deck = validated.deck;
    job.quality = enrichQuality(validated.quality, job.files || [], materialBrief, routePlan);
    job.warning = validated.warnings.length ? validated.warnings.join("; ") : null;
    addEvent(job, "image-supplement-apply", "Image supplement plan applied and rerendered", report.summary);
    job.updatedAt = new Date().toISOString();
    job.exports.pptx = await buildDeck(job);
    job.exportMeta = collectExportMeta(job.exports);
    await refreshPreview(job, "image supplement applied");
    const cloudVisualReview = await reviewDeckVisuals({ stage: String(job.mode || "job") + "-image-supplement", deck: job.deck, quality: job.quality, routePlan, materialBrief, previewImages: job.previewImages || [] });
    job.cloudReviews = [...(job.cloudReviews || []), cloudVisualReview];
    addEvent(job, "cloud-visual-review", cloudVisualReview.used ? "Cloud visual review after image supplement: " + cloudVisualReview.status : "Cloud visual review after image supplement skipped: " + (cloudVisualReview.reason || "not available"), cloudVisualReview);
    job.imageSupplementPlan = buildImageSupplementPlan({ deck: job.deck, routePlan, materialBrief, files: job.files || [], cloudReviews: job.cloudReviews || [], visualFixes: job.visualFixes || [] });
    job.agentReviews = [...(job.agentReviews || []), buildAgentReview(job.mode === "style-preview" ? "style-preview" : "final-deck", job.deck, job.quality, routePlan, materialBrief, job.files || [], job.previewImages || [], cloudVisualReview)];
    await saveJob(job);
    res.json(toClientJob(job));
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs/:id/apply-local-image-supplement", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "任务不存在。" });
    const routePlan = job.input?.routePlan || null;
    const materialBrief = job.input?.materialBrief || {};
    const plan = job.imageSupplementPlan || buildImageSupplementPlan({ deck: job.deck, routePlan, materialBrief, files: job.files || [], cloudReviews: job.cloudReviews || [], visualFixes: job.visualFixes || [] });
    const targets = (plan.items || []).filter((item) => item.action === "need-remote-generation").map(annotateMaterialTarget).slice(0, 3);
    if (!targets.length) {
      res.status(400).json({ error: "当前补图计划没有需要本地生成的页面；可先复用原稿图或重新跑视觉质检。" });
      return;
    }
    pushUndo(job, "撤销本地 Z-Image 补图");
    const generated = [];
    for (const item of targets) {
      const generatedRecord = await generateSupplementImageForItem(job, item, routePlan, {
        width: req.body?.width || 768,
        height: req.body?.height || 768,
        steps: req.body?.steps || 8,
        seed: req.body?.seed || Date.now() + Number(item.slide || 0),
        allowCloudFallback: req.body?.allowCloudFallback !== false
      });
      const record = generatedRecord.record;
      if (!record) {
        generated.push({ item, failed: true, failure: generatedRecord.failure });
        continue;
      }
      let slotRecord = record;
      let matting = null;
      if (item.needsCutout) {
        matting = await cutoutImage(record, { prompt: buildCloudCutoutPrompt(item, routePlan) });
        record.matting = matting;
        record.mattingStatus = matting.status || "failed";
        if (matting.record) {
          slotRecord = matting.record;
          job.files = [...(job.files || []), record, slotRecord];
        } else {
          job.files = [...(job.files || []), record];
        }
      } else {
        job.files = [...(job.files || []), record];
      }
      generated.push({ item, record: slotRecord, originalRecord: record, matting });
      const slideIndex = Number(item.slide || 0) - 1;
      if (job.deck?.slides?.[slideIndex]) {
        const slide = job.deck.slides[slideIndex];
        const slotLimit = imageSlotLimitForLayout(slide.layout || "");
        slide.imageSlots = slotLimit
          ? uniqueTextList([slotRecord.originalName, ...normalizeClientList(slide.imageSlots)]).slice(0, slotLimit)
          : [];
        slide.visualIntent = [
          cleanClientText(slide.visualIntent),
          item.needsCutout
            ? "Foreground material generated local-first; matting is local-first and cloud only as fallback."
            : "AI supplement image generated as visual material only, not a factual source."
        ].filter(Boolean).join(" ");
      }
    }
    let nextRoutePlan = syncRoutePlanWithSlides(routePlan, job.deck.slides || [], "local-image-supplement");
    if (job.input) {
      job.input.routePlan = nextRoutePlan;
      job.input.materialBrief = materialBrief;
    }
    const validated = validateDeck(job.deck, nextRoutePlan);
    job.deck = validated.deck;
    job.quality = enrichQuality(validated.quality, job.files || [], materialBrief, nextRoutePlan);
    job.warning = validated.warnings.length ? validated.warnings.join("; ") : null;
    addEvent(job, "local-image-supplement", "Manual supplement generated " + generated.filter((entry) => !entry.failed && entry.record).length + " PPT materials", {
      provider: "local-first-cloud-fallback",
      generated: generated.filter((entry) => !entry.failed && entry.record).map(({ item, record, originalRecord }) => ({
        slide: item.slide,
        title: item.title,
        image: originalRecord?.originalName || record.originalName,
        prompt: originalRecord?.prompt || record.prompt,
        seed: originalRecord?.seed || record.seed,
        materialRole: originalRecord?.materialRole || record.materialRole,
        needsCutout: originalRecord?.needsCutout || false,
        mattingStatus: originalRecord?.mattingStatus || record.mattingStatus,
        finalImage: record.originalName,
        mattingMethod: originalRecord?.matting?.method || null,
        workflowPath: originalRecord?.comfy?.workflowPath || record.comfy?.workflowPath || null,
        visualQa: originalRecord?.visualQa || record.visualQa || null
      }))
    });
    job.updatedAt = new Date().toISOString();
    job.exports.pptx = await buildDeck(job);
    job.exportMeta = collectExportMeta(job.exports);
    await refreshPreview(job, "local image supplement applied");
    const cloudVisualReview = await reviewDeckVisuals({ stage: String(job.mode || "job") + "-local-image-supplement", deck: job.deck, quality: job.quality, routePlan: nextRoutePlan, materialBrief, previewImages: job.previewImages || [] });
    job.cloudReviews = [...(job.cloudReviews || []), cloudVisualReview];
    addEvent(job, "cloud-visual-review", cloudVisualReview.used ? "Cloud visual review after local image supplement: " + cloudVisualReview.status : "Cloud visual review after local image supplement skipped: " + (cloudVisualReview.reason || "not available"), cloudVisualReview);
    job.imageSupplementPlan = buildImageSupplementPlan({ deck: job.deck, routePlan: nextRoutePlan, materialBrief, files: job.files || [], cloudReviews: job.cloudReviews || [], visualFixes: job.visualFixes || [] });
    job.agentReviews = [...(job.agentReviews || []), buildAgentReview(job.mode === "style-preview" ? "style-preview" : "final-deck", job.deck, job.quality, nextRoutePlan, materialBrief, job.files || [], job.previewImages || [], cloudVisualReview)];
    await saveJob(job);
    res.json(toClientJob(job));
  } catch (error) {
    next(error);
  }
});

async function maybeRunOneClickVisualProject(job = {}, body = {}) {
  if (body.autoVisualProject === false || body.visualProjectMode === "manual") {
    addEvent(job, "visual-project", "Visual project auto generation skipped by request", { mode: "manual" });
    return { status: "skipped", skipped: true, reason: "visual project generation is manual for this request" };
  }
  attachAssetFirstState(job, job.input?.materialBrief || {}, job.input?.routePlan || {});
  await ensureVisualProjectForJob(job);
  const maxSlides = resolveVisualProjectMaxSlides(body, job.deck?.slides?.length || 0);
  if (maxSlides === 0) {
    addEvent(job, "visual-project", "Visual project prepared without slide image generation", { maxSlides });
    return { status: "prepared", skipped: true, reason: "visual project prepared; origin_image generation deferred" };
  }
  try {
    const generation = await generateVisualProjectSlides(job, {
      maxSlides,
      overwrite: Boolean(body.visualProjectOverwrite),
      generateImage: (slideJob) => generateVisualProjectSlideImage(job, slideJob, body || {})
    });
    normalizeExportAliases(job);
    if (job.visualProject?.visualTargetPptxPath) job.exports.visualTargetPptx = job.visualProject.visualTargetPptxPath;
    job.exportMeta = collectExportMeta(job.exports || {});
    addEvent(job, "visual-project-generate", "One-click visual project generation " + generation.status, {
      ...generation,
      maxSlides: maxSlides === Infinity ? "all" : maxSlides
    });
    return generation;
  } catch (error) {
    const generation = {
      status: "blocked",
      blockerCount: 1,
      blockers: [{ id: "visual-project", reason: error.message || "visual project generation failed" }],
      updatedAt: new Date().toISOString()
    };
    job.visualProject = {
      ...(job.visualProject || {}),
      status: "blocked",
      generation,
      warnings: [...(job.visualProject?.warnings || []), generation.blockers[0].reason]
    };
    addEvent(job, "visual-project-blocked", "One-click visual project generation blocked", generation);
    return generation;
  }
}

function resolveVisualProjectMaxSlides(body = {}, slideCount = 0) {
  const raw = body.visualProjectMaxSlides ?? body.maxVisualProjectSlides ?? body.maxSlides;
  if (raw === "all" || raw === undefined || raw === null || raw === "") return Infinity;
  if (raw === "none" || raw === "manual" || raw === false) return 0;
  const value = Number(raw);
  if (!Number.isFinite(value)) return Infinity;
  return Math.max(0, Math.min(Math.max(slideCount || 0, 1), Math.floor(value)));
}

app.post("/api/jobs/:id/visual-project/generate", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    attachAssetFirstState(job, job.input?.materialBrief || {}, job.input?.routePlan || {});
    const maxSlides = req.body?.maxSlides === "all" ? Infinity : Math.max(1, Math.min(12, Number(req.body?.maxSlides || 3)));
    const overwrite = Boolean(req.body?.overwrite);
    const generation = await generateVisualProjectSlides(job, {
      maxSlides,
      overwrite,
      generateImage: (slideJob) => generateVisualProjectSlideImage(job, slideJob, req.body || {})
    });
    normalizeExportAliases(job);
    if (job.visualProject?.visualTargetPptxPath) job.exports.visualTargetPptx = job.visualProject.visualTargetPptxPath;
    job.exportMeta = collectExportMeta(job.exports || {});
    addEvent(job, "visual-project-generate", "Visual project slide generation " + generation.status, generation);
    job.updatedAt = new Date().toISOString();
    await saveJob(job);
    res.json(toClientJob(job));
  } catch (error) {
    next(error);
  }
});

async function generateVisualProjectSlideImage(job = {}, slideJob = {}, options = {}) {
  const prompt = cleanClientText(options.prompt || slideJob.prompt);
  const prefix = `visual_project_${job.id}_${slideJob.id}`;
  const seedBase = Number(options.seed || Date.now());
  const seed = seedBase + Number(slideJob.index || slideJob.id?.match(/\d+/)?.[0] || 0);
  const cloudPreferred = options.cloudVisualProject !== false && options.visualProjectBackend !== "local-first";
  if (cloudPreferred && process.env.OPENAI_API_KEY) {
    try {
      return await generateCloudImage({
        prompt,
        width: Number(options.width || 1280),
        height: Number(options.height || 720),
        prefix: `visual_project_cloud_${job.id}_${slideJob.id}`,
        textSafeArea: "Avoid readable text; reserve safe title/body regions for editable PPT text.",
        materialRole: "visual-target-reference"
      });
    } catch (error) {
      addEvent(job, "visual-project-cloud-fallback", "Cloud visual target generation failed; trying local image backend", {
        slideId: slideJob.id,
        reason: error.message || "cloud image generation failed"
      });
    }
  }
  const localStatus = await checkLocalImageStatus();
  if (localStatus.ok) {
    return generateLocalImage({
      prompt,
      width: Number(options.width || 1280),
      height: Number(options.height || 720),
      steps: Number(options.steps || 8),
      seed,
      prefix,
      textSafeArea: "Avoid readable text; reserve safe title/body regions for editable PPT text."
    });
  }
  if (options.allowCloudFallback === false) throw new Error(localStatus.reason || "local image backend unavailable");
  return generateCloudImage({
    prompt,
    width: Number(options.width || 1280),
    height: Number(options.height || 720),
    prefix: `visual_project_cloud_${job.id}_${slideJob.id}`,
    textSafeArea: "Avoid readable text; reserve safe title/body regions for editable PPT text.",
    materialRole: "visual-target-reference"
  });
}

app.post("/api/jobs/:id/rescan-local-image-qa", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "任务不存在。" });
    const routePlan = job.input?.routePlan || null;
    let checked = 0;
    let warned = 0;
    for (const file of job.files || []) {
      if (!(file.source === "local-zimage" || file.provider === "comfyui-zimage")) continue;
      if (!file.path || !fsSync.existsSync(file.path)) continue;
      const pagePlan = findAestheticPagePlan(routePlan, { slide: file.sourceSlide });
      file.visualQa = await analyzeGeneratedImage(file.path, { textSafeArea: pagePlan?.textSafeArea || "" }).catch((error) => ({
        version: 1,
        source: "local-pixel-qa",
        status: "warn",
        risks: ["qa-failed"],
        error: error.message || "visual QA failed"
      }));
      checked += 1;
      if (file.visualQa.status !== "pass") warned += 1;
    }
    const materialBrief = job.input?.materialBrief || {};
    job.quality = enrichQuality(job.quality || {}, job.files || [], materialBrief, routePlan);
    addEvent(job, "local-image-qa", "Local image QA rerun: " + checked + " checked, " + warned + " warned", { checked, warned, localImageQa: job.quality.localImageQa });
    job.updatedAt = new Date().toISOString();
    await saveJob(job);
    res.json(toClientJob(job));
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs/:id/undo", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "任务不存在。" });
    const snapshot = (job.undoStack || []).pop();
    if (!snapshot) return res.status(400).json({ error: "No undo snapshot available" });
    job.deck = snapshot.deck;
    if (snapshot.input) job.input = snapshot.input;
    const routePlan = job.input?.routePlan || null;
    const validated = validateDeck(job.deck, routePlan);
    job.deck = validated.deck;
    job.quality = enrichQuality(validated.quality, job.files || [], job.input?.materialBrief, routePlan);
    job.warning = validated.warnings.length ? validated.warnings.join("; ") : job.warning;
    addEvent(job, "undo", snapshot.label || "Undid previous action", { remaining: job.undoStack.length });
    job.updatedAt = new Date().toISOString();
    job.exports.pptx = await buildDeck(job);
    job.exportMeta = collectExportMeta(job.exports);
    await refreshPreview(job, "撤销后已刷新");
    await saveJob(job);
    res.json(toClientJob(job));
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs/:id/feedback", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "任务不存在。" });
    job.feedback = { rating: req.body.rating, comment: req.body.comment || "", createdAt: new Date().toISOString() };
    job.updatedAt = new Date().toISOString();
    await saveJob(job);
    res.json(toClientJob(job));
  } catch (error) {
    next(error);
  }
});

app.use("/api", (req, res) => {
  res.status(404).json({
    ok: false,
    code: "API_ROUTE_NOT_FOUND",
    error: `API route not found: ${req.method} ${req.originalUrl}`
  });
});

const distDir = path.join(rootDir, "dist");
const distIndex = path.join(distDir, "index.html");
if (fsSync.existsSync(distIndex)) {
  app.use(express.static(distDir));
  app.use((_req, res) => res.sendFile(distIndex));
} else {
  app.use((_req, res) => {
    res.status(503).send("Frontend build is missing. Run npm.cmd run build, then restart the PPT tool.");
  });
}

app.use((error, _req, res, _next) => {
  console.error(error);
  const status = Number(error.status || error.statusCode || 500);
  res.status(status >= 400 && status < 600 ? status : 500).json({
    ok: false,
    error: error.message || "Server error",
    code: error.code || "",
    finalGate: error.finalGate || undefined
  });
});

await cleanupAbandonedWorkflowJobLocks().catch((error) => {
  console.warn(`Workflow lock cleanup skipped: ${error?.message || error}`);
});

app.listen(port, localAccess.host, () => {
  console.log(`PPT Design Tool running at http://${localAccess.host}:${port} (${localAccess.accessMode})`);
});

function isCodexPptApprovalError(error) {
  return /^CODEX_PPT_/.test(String(error?.code || ""));
}

function getCodexPptBackendRefreshState(job = {}) {
  const image = getProviderConfig().image || {};
  const decision = job.artifacts?.codexPptBackendDecision || {};
  const runtime = {
    configured: Boolean(image.configured),
    enabled: image.enabled !== false,
    baseUrl: image.baseUrl || "",
    model: image.model || ""
  };
  const approved = {
    provider: decision.provider || decision.backend?.provider || "",
    baseUrl: decision.baseUrl || decision.backend?.baseUrl || "",
    model: decision.model || decision.backend?.model || "",
    source: decision.source || ""
  };
  const modelMatches = !approved.model || !runtime.model || approved.model === runtime.model;
  const baseUrlMatches = !approved.baseUrl || !runtime.baseUrl || normalizeEndpoint(approved.baseUrl) === normalizeEndpoint(runtime.baseUrl);
  const approvedLooksDryRun = /\b(regression|dry[-_\s]?run|passthrough|source[-_\s]?page[-_\s]?passthrough)\b/i.test([
    approved.source,
    approved.provider,
    approved.model,
    approved.baseUrl
  ].join(" "));
  const runtimeReady = Boolean(runtime.configured && runtime.enabled && runtime.model);
  return {
    runtime,
    approved,
    runtimeReady,
    modelMatches,
    baseUrlMatches,
    approvedLooksDryRun,
    needsRefresh: !decision.path || approvedLooksDryRun || !modelMatches || !baseUrlMatches
  };
}

function normalizeEndpoint(value = "") {
  return String(value || "").trim().replace(/\/+$/, "");
}

function formatCodexPptApprovalError(error) {
  return {
    ok: false,
    code: error.code,
    error: error.message || "codex-ppt workflow requirement failed",
    missing: error.missing || [],
    required: error.required || [],
    requiredArtifact: error.requiredArtifact || "",
    backend: error.backend || null,
    provider: error.provider || "",
    dryRun: Boolean(error.dryRun),
    passthrough: Boolean(error.passthrough),
    requiredConfirmation: error.requiredConfirmation || ""
  };
}

function withExternalImageAuthorization(body = {}, authorization = {}) {
  if (body.confirmExternalImageSpend || body.confirmSpend || body.confirmImageApiSpend) return body;
  if (!authorization?.persisted) return body;
  body.confirmExternalImageSpend = true;
  body.authorizationSource = "authorization-ledger";
  return body;
}

function toClientWorkflowJob(job, options = {}) {
  const includeEvents = Boolean(options.includeEvents);
  const primaryWorkflow = options.primaryWorkflow || null;
  const primaryWorkflowId = primaryWorkflow?.id || getPrimaryWorkflowJobId();
  const isPrimaryWorkflow = Boolean(primaryWorkflowId && job.id === primaryWorkflowId);
  const internal = isInternalWorkflowJob(job);
  const stageValues = Object.values(job.stages || {});
  const pageValues = Array.isArray(job.pages) ? job.pages : [];
  const failedPages = pageValues.filter((page) => page.status === "failed").length;
  const runningPages = pageValues.filter((page) => page.status === "running" || page.status === "retrying").length;
  const recordedPages = pageValues.filter((page) => page.status === "recorded").length;
  const lifecycle = job.lifecycle || {};
  const archived = isArchivedWorkflowJob(job);
  const sourceName = workflowSourceName(job);
  const sourcePages = workflowSourcePageCount(job);
  const finalPages = workflowFinalPageCount(job);
  const recordedEditablePages = workflowRecordedEditablePageCount(job);
  return {
    id: job.id,
    kind: job.kind,
    internal,
    archived,
    lifecycle,
    status: job.status,
    currentStage: job.currentStage,
    stageStatus: job.stageStatus,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    rootDir: job.rootDir,
    dirs: job.dirs,
    input: job.input || {},
    sourceName,
    sourcePages,
    finalPages,
    recordedEditablePages,
    isSample: Boolean(sourcePages && finalPages && finalPages < sourcePages),
    primaryWorkflowState: {
      isPrimary: isPrimaryWorkflow,
      primaryJobId: primaryWorkflowId,
      primaryFound: primaryWorkflow ? primaryWorkflow.found !== false : true,
      sourceName: primaryWorkflow?.sourceName || "",
      sourcePages: primaryWorkflow?.sourcePages || 0,
      finalPages: primaryWorkflow?.finalPages || 0,
      recordedEditablePages: primaryWorkflow?.recordedEditablePages || 0,
      isSample: Boolean(primaryWorkflow?.isSample)
    },
    sourceMeta: job.sourceMeta || job.artifacts?.sourceMeta || null,
    artifacts: job.artifacts || {},
    primaryWorkflow: primaryWorkflow?.id === job.id ? {
      isPrimary: true,
      sourceName: primaryWorkflow.sourceName || "",
      sourcePages: primaryWorkflow.sourcePages || 0,
      finalPages: primaryWorkflow.finalPages || 0,
      recordedEditablePages: primaryWorkflow.recordedEditablePages || 0,
      isSample: Boolean(primaryWorkflow.isSample)
    } : null,
    constraints: job.constraints || {},
    stages: job.stages || {},
    stageSummary: {
      total: WORKFLOW_STAGE_ORDER.length,
      complete: stageValues.filter((stage) => stage.status === "complete").length,
      running: stageValues.filter((stage) => stage.status === "running").length,
      failed: stageValues.filter((stage) => stage.status === "failed").length,
      pending: stageValues.filter((stage) => stage.status === "pending").length
    },
    pages: pageValues,
    pageSummary: {
      total: pageValues.length,
      recorded: recordedPages,
      running: runningPages,
      failed: failedPages
    },
    errors: job.errors || [],
    eventCount: Array.isArray(job.events) ? job.events.length : 0,
    events: includeEvents ? job.events || [] : []
  };
}

function getPrimaryWorkflowJobId() {
  const configured = String(globalThis.process?.env?.PPT_AGENT_PRIMARY_JOB_ID || "").trim();
  return configured || DEFAULT_PRIMARY_WORKFLOW_JOB_ID;
}

function canExposeWorkflowJob(job = null, primaryJob = null) {
  if (!job?.id) return false;
  if (!isInternalWorkflowJob(job)) return true;
  return Boolean(primaryJob?.id && job.id === primaryJob.id);
}

function assertWorkflowOcrTextHintsReady(job = {}, options = {}) {
  const artifact = job.artifacts?.ocrTextHints || {};
  const coverage = getWorkflowOcrCoverage(job, options);
  if ((artifact.path || artifact.relativePath) && coverage.complete) return;
  const error = new Error("Source-page OCR text hints are required before visual image generation.");
  error.status = 409;
  error.code = "OCR_TEXT_HINTS_REQUIRED";
  error.coverage = coverage;
  throw error;
}

function buildPrimaryWorkflowPayload(job = null) {
  const primaryId = getPrimaryWorkflowJobId();
  if (!primaryId) {
    return {
      id: "",
      found: false,
      configured: false,
      sourceName: "",
      sourcePages: 0,
      finalPages: 0,
      recordedEditablePages: 0,
      deliveryLevel: "not-configured",
      deliveryHint: "",
      isSample: false,
      job: null
    };
  }
  if (!job?.id) {
    return {
      id: primaryId,
      found: false,
      configured: true,
      sourceName: "",
      sourcePages: 0,
      finalPages: 0,
      recordedEditablePages: 0,
      deliveryLevel: "unknown",
      deliveryHint: "主验收任务未找到。",
      isSample: false,
      job: null
    };
  }
  const sourcePages = workflowSourcePageCount(job);
  const finalPages = workflowFinalPageCount(job);
  const recordedEditablePages = workflowRecordedEditablePageCount(job);
  const deliveryLevel = buildPrimaryWorkflowDeliveryLevel({ sourcePages, finalPages, recordedEditablePages });
  const payload = {
    id: job.id,
    found: true,
    configured: true,
    sourceName: workflowSourceName(job),
    sourcePages,
    finalPages,
    recordedEditablePages,
    deliveryLevel,
    deliveryHint: primaryWorkflowDeliveryHint(deliveryLevel),
    isSample: Boolean(sourcePages && finalPages && finalPages < sourcePages),
    job: null
  };
  return payload;
}

function buildPrimaryWorkflowListItem(primaryWorkflow = {}) {
  return {
    id: primaryWorkflow.id,
    kind: "ppt-rebuild-workflow",
    internal: true,
    archived: false,
    status: "primary_summary",
    currentStage: "primary_summary",
    stageStatus: "",
    createdAt: "",
    updatedAt: "",
    input: { sourceOriginalName: primaryWorkflow.sourceName || "" },
    sourceName: primaryWorkflow.sourceName || "",
    sourcePages: primaryWorkflow.sourcePages || 0,
    finalPages: primaryWorkflow.finalPages || 0,
    recordedEditablePages: primaryWorkflow.recordedEditablePages || 0,
    deliveryLevel: primaryWorkflow.deliveryLevel || "",
    deliveryHint: primaryWorkflow.deliveryHint || "",
    isSample: Boolean(primaryWorkflow.isSample),
    primaryWorkflowState: {
      isPrimary: true,
      primaryJobId: primaryWorkflow.id,
      primaryFound: primaryWorkflow.found !== false,
      sourceName: primaryWorkflow.sourceName || "",
      sourcePages: primaryWorkflow.sourcePages || 0,
      finalPages: primaryWorkflow.finalPages || 0,
      recordedEditablePages: primaryWorkflow.recordedEditablePages || 0,
      deliveryLevel: primaryWorkflow.deliveryLevel || "",
      deliveryHint: primaryWorkflow.deliveryHint || "",
      isSample: Boolean(primaryWorkflow.isSample)
    },
    sourceMeta: primaryWorkflow.sourcePages ? { pageCount: primaryWorkflow.sourcePages } : null,
    artifacts: {},
    primaryWorkflow: {
      isPrimary: true,
      sourceName: primaryWorkflow.sourceName || "",
      sourcePages: primaryWorkflow.sourcePages || 0,
      finalPages: primaryWorkflow.finalPages || 0,
      recordedEditablePages: primaryWorkflow.recordedEditablePages || 0,
      deliveryLevel: primaryWorkflow.deliveryLevel || "",
      deliveryHint: primaryWorkflow.deliveryHint || "",
      isSample: Boolean(primaryWorkflow.isSample)
    },
    constraints: {},
    stages: {},
    stageSummary: { total: 0, complete: 0, running: 0, failed: 0, pending: 0 },
    pages: [],
    pageSummary: { total: 0, recorded: 0, running: 0, failed: 0 },
    errors: [],
    eventCount: 0,
    events: []
  };
}

function workflowSourceName(job = {}) {
  return cleanWorkflowString(
    job.input?.sourceOriginalName
    || job.artifacts?.source?.originalName
    || job.artifacts?.codexPptOutline?.title
    || job.artifacts?.codexPptStyle?.title
    || ""
  );
}

function buildPrimaryWorkflowDeliveryLevel({ sourcePages = 0, finalPages = 0, recordedEditablePages = 0 } = {}) {
  if (!sourcePages) return "unknown";
  if (!finalPages) return recordedEditablePages ? "editable-pages-recorded" : "not-finalized";
  if (finalPages < sourcePages) return "sample-draft";
  if (finalPages > sourcePages) return "page-count-mismatch";
  return "needs-delivery-review";
}

function primaryWorkflowDeliveryHint(level = "") {
  const hints = {
    unknown: "源文件页数未知，请先检查工作流。",
    "not-finalized": "还没有生成最终可编辑 PPT。",
    "editable-pages-recorded": "页面已重建，等待合成最终 PPT。",
    "sample-draft": "已生成小样本 final，完整交付还没覆盖全部页面。",
    "page-count-mismatch": "最终 PPT 页数与源文件不一致，请移除重复或异常页面后重新合成。",
    "needs-delivery-review": "20/20 已合成，但还需要交付门禁和人工视觉复核。"
  };
  return hints[level] || "请打开交付复核查看当前状态。";
}

function cleanWorkflowString(value = "") {
  return String(value || "").trim();
}

function workflowSourcePageCount(job = {}) {
  return numberOrZero(job.sourceMeta?.pageCount)
    || numberOrZero(job.artifacts?.sourceMeta?.pageCount)
    || countArray(job.artifacts?.renderedPages)
    || countArray(job.artifacts?.visualImages);
}

function workflowFinalPageCount(job = {}) {
  return numberOrZero(job.artifacts?.editableFinal?.summary?.page_count)
    || numberOrZero(job.artifacts?.editableFinal?.pptxEditability?.slideCount)
    || numberOrZero(job.finalValidation?.slides);
}

function workflowRecordedEditablePageCount(job = {}) {
  const tasks = Array.isArray(job.artifacts?.editableWorkerTasks) ? job.artifacts.editableWorkerTasks : [];
  if (tasks.length) {
    return tasks.filter((task) => task?.status === "recorded").length;
  }
  const editablePages = Array.isArray(job.artifacts?.editablePages) ? job.artifacts.editablePages : [];
  if (editablePages.length) return editablePages.length;
  return workflowFinalPageCount(job);
}

function countArray(value) {
  return Array.isArray(value) ? value.length : 0;
}

function numberOrZero(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function isTruthyQuery(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ""));
}

function readWorkflowCleanupOptions(input = {}) {
  return {
    categories: input.categories || "internal,regression,probe",
    includeArchived: isTruthyQuery(input.includeArchived),
    olderThanHours: Number(input.olderThanHours || 0),
    limit: Number(input.limit || 200)
  };
}

function isArchivedWorkflowJob(job = {}) {
  return Boolean(job.lifecycle?.archivedAt);
}

function toClientJob(job) {
  const { undoStack: _undoStack, ...publicJob } = job;
  normalizeExportAliases(job);
  const derivedQuality = enrichQuality(job.quality || {}, job.files || [], job.input?.materialBrief || {}, job.input?.routePlan || null);
  const normalizedDeck = normalizeDeckImageSlotsForLayouts(job.deck);
  const derivedImageSupplementPlan = buildImageSupplementPlan({
    deck: normalizedDeck,
    routePlan: job.input?.routePlan || null,
    materialBrief: job.input?.materialBrief || {},
    files: job.files || [],
    cloudReviews: job.cloudReviews || [],
    visualFixes: job.visualFixes || []
  });
  const editableRebuildPlan = buildEditableRebuildPlan({
    uploads: job.files || [],
    materialBrief: job.input?.materialBrief || {},
    routePlan: job.input?.routePlan || {},
    deck: normalizedDeck
  });
  const assetManifest = job.assetManifest || buildAssetManifest({
    files: job.files || [],
    materialBrief: job.input?.materialBrief || {},
    deck: normalizedDeck
  });
  const assetManifestQa = job.assetManifestQa || validateAssetManifest(assetManifest);
  const sceneJob = { ...job, deck: normalizedDeck, imageSupplementPlan: derivedImageSupplementPlan, editableRebuildPlan };
  sceneJob.assetManifest = assetManifest;
  sceneJob.assetManifestQa = assetManifestQa;
  ensureSceneGraphForJob(sceneJob);
  const visualTargetForClient = attachVisualTargetSampleUrl(sceneJob.visualTarget, sceneJob.files || []);
  const toOutputUrl = (file, options = {}) => {
    if (!file) return file;
    if (Array.isArray(file)) return file.map((item) => toOutputUrl(item, options));
    if (typeof file !== "string") return file;
    const normalized = path.normalize(file);
    if (!normalized.startsWith(outputDir) || !fsSync.existsSync(normalized)) return null;
    const relative = path.relative(outputDir, normalized).split(path.sep).map(encodeURIComponent).join("/");
    const version = options.cacheBust ? "?v=" + Math.round(fsSync.statSync(normalized).mtimeMs) : "";
    return "/outputs/" + relative + version;
  };
  const previewImages = (job.previewImages || []).map((file) => toOutputUrl(file, { cacheBust: true }));
  const visualProject = normalizeVisualProjectForClient(sceneJob.visualProject, toOutputUrl);
  const slideCount = job.deck?.slides?.length || 0;
  const repairedPreviewImages = previewImages.length === slideCount ? previewImages : previewImages.length && previewImages.every(Boolean) ? previewImages : repairPreviewImages(job, { cacheBust: true });
  const hybridQa = buildHybridQa(sceneJob, { ...derivedQuality, sceneGraphQa: sceneJob.sceneGraphQa, visualCompare: sceneJob.visualCompare }, repairedPreviewImages);
  return {
    ...publicJob,
    deck: normalizedDeck,
    quality: derivedQuality,
    imageSupplementPlan: derivedImageSupplementPlan,
    assetManifest,
    assetManifestQa,
    editableRebuildPlan,
    visualProject,
    visualTarget: visualTargetForClient,
    sceneGraph: sceneJob.sceneGraph,
    sceneGraphQa: sceneJob.sceneGraphQa,
    sceneGraphOverrides: sceneJob.sceneGraphOverrides || null,
    visualCompare: sceneJob.visualCompare,
    sceneGraphRepair: sceneJob.sceneGraphRepair,
    hybridQa,
    pipeline: buildPipelineSnapshot(sceneJob, { ...derivedQuality, sceneGraphQa: sceneJob.sceneGraphQa, visualCompare: sceneJob.visualCompare }, repairedPreviewImages),
    editReadiness: buildEditReadiness(sceneJob, { ...derivedQuality, sceneGraphQa: sceneJob.sceneGraphQa, visualCompare: sceneJob.visualCompare }, repairedPreviewImages),
    canUndo: Boolean(job.undoStack?.length),
    undoLabel: job.undoStack?.at(-1)?.label || null,
    input: normalizeInput(job.input),
    files: (job.files || []).map(normalizeUploadRecord),
    exports: Object.fromEntries(Object.entries(job.exports || {}).map(([key, value]) => [key, toOutputUrl(value)])),
    exportMeta: job.exportMeta || collectExportMeta(job.exports || {}),
    previewImages: repairedPreviewImages
  };
}

function buildPipelineSnapshot(job = {}, quality = {}, previewImages = []) {
  const routePlan = job.input?.routePlan || {};
  const materialBrief = job.input?.materialBrief || {};
  const sourceReport = materialBrief.sourceReport || {};
  const deckSlides = Array.isArray(job.deck?.slides) ? job.deck.slides : [];
  const imagePlan = job.imageSupplementPlan || {};
  const editablePlan = job.editableRebuildPlan || {};
  const assetManifest = job.assetManifest || {};
  const assetManifestQa = job.assetManifestQa || {};
  const visualProject = job.visualProject || {};
  const sceneGraphQa = job.sceneGraphQa || quality.sceneGraphQa || {};
  const visualCompare = job.visualCompare || quality.visualCompare || {};
  const pptxEditability = quality.pptxEditability || job.quality?.pptxEditability || {};
  const sceneGraphRepair = job.sceneGraphRepair || {};
  const cloudReviews = Array.isArray(job.cloudReviews) ? job.cloudReviews : [];
  const editReadiness = buildEditReadiness(job, quality, previewImages);
  const hasSource = Boolean(sourceReport.hasOldDeck || materialBrief.charCount || (job.files || []).length);
  const sourceWarnings = [...(sourceReport.warnings || []), ...(sourceReport.extractionAudit?.warnings || [])].filter(Boolean);
  const visualReview = cloudReviews.at(-1) || null;
  const stage = (id, label, status, summary, extra = {}) => ({
    id,
    label,
    status,
    summary,
    warnings: extra.warnings || [],
    errors: extra.errors || [],
    metrics: extra.metrics || {}
  });
  const stages = [
    stage("source-intake", "Source intake", hasSource ? (sourceWarnings.length ? "warn" : "pass") : "skipped", hasSource ? "Extracted text, images, and source records" : "No uploaded source; generate from conversation", {
      warnings: sourceWarnings,
      metrics: {
        files: (job.files || []).length,
        pages: sourceReport.pageCount || materialBrief.pageCount || 0,
        extractedImages: sourceReport.extractedImageCount || sourceReport.imageCount || 0
      }
    }),
    stage("source-analysis", "Local/cloud analysis", sourceReport.cloudSourceAnalysis?.status === "block" ? "block" : sourceReport.cloudSourceAnalysis?.status === "warn" ? "warn" : "pass", sourceReport.cloudSourceAnalysis ? "Merged local diagnosis and cloud review" : "Used local rules and material brief", {
      warnings: sourceReport.cloudSourceAnalysis?.findings || [],
      metrics: {
        aestheticScore: sourceReport.aestheticDiagnosis?.overallScore || null,
        textPages: sourceReport.textPageCount || 0
      }
    }),
    stage("asset-manifest", "Asset manifest", assetManifestQa.status === "block" ? "block" : assetManifestQa.status === "warn" ? "warn" : assetManifest.assets?.length ? "pass" : "warn", assetManifest.assets?.length ? "Locked asset identity and background rules" : "Asset manifest is waiting for source/material content", {
      warnings: [...(assetManifestQa.errors || []), ...(assetManifestQa.warnings || []), ...(assetManifest.warnings || [])],
      metrics: {
        assets: assetManifest.assets?.length || 0,
        critical: assetManifest.criticalCount || 0,
        backgroundBlocked: assetManifest.backgroundBlockedCount || 0
      }
    }),
    stage("route-plan", "Smart routing", routePlan.layoutSequence?.length ? "pass" : "block", routePlan.designDirectorStrategy ? "Design-first route generated" : "Standard route generated", {
      metrics: {
        deckType: routePlan.deckType || "",
        theme: routePlan.recommendedTheme || "",
        slides: routePlan.layoutSequence?.length || 0
      }
    }),
    stage("visual-project", "Visual project", visualProject.status === "ready" ? "pass" : visualProject.status ? "warn" : "skipped", visualProject.status ? "codex-ppt style outline/spec/prompts prepared" : "Visual project not initialized yet", {
      warnings: visualProject.warnings || [],
      metrics: {
        slides: visualProject.slideCount || 0,
        generatedImages: visualProject.generatedImages || 0,
        visualTargetPptx: visualProject.visualTargetPptxPath ? "yes" : "no"
      }
    }),
    stage("asset-pipeline", "Asset pipeline", imagePlan.needed ? (editReadiness.ready ? "pass" : "warn") : "skipped", imagePlan.needed ? "Generated reuse/supplement/cutout plan" : "No extra asset processing needed", {
      warnings: editReadiness.blockingIssues || [],
      metrics: {
        targets: imagePlan.targets?.length || imagePlan.items?.length || 0,
        actions: imagePlan.actions?.length || 0
      }
    }),
    stage("editable-manifest", "Editable manifest", editablePlan.candidate ? (editablePlan.status === "active" ? "pass" : "warn") : "skipped", editablePlan.candidate ? "Generated per-page object manifest and fake-editable QA" : "Not an image-to-editable rebuild case", {
      warnings: editablePlan.warnings || [],
      metrics: {
        pages: editablePlan.pageCount || 0,
        inputType: editablePlan.inputType || "",
        riskyPages: (editablePlan.pages || []).filter((page) => page.qa?.fakeEditableRisk).length
      }
    }),
    stage("scene-graph", "Editable SceneGraph", sceneGraphQa.status === "block" ? "block" : sceneGraphQa.status === "warn" ? "warn" : "pass", sceneGraphQa.slideCount ? "Editable source generated; PPTX renders from SceneGraph" : "SceneGraph not generated yet", {
      warnings: [...(sceneGraphQa.errors || []), ...(sceneGraphQa.warnings || [])],
      metrics: {
        slides: sceneGraphQa.slideCount || 0,
        textBoxes: sceneGraphQa.textBoxes || 0,
        shapes: sceneGraphQa.shapeCount || 0,
        images: sceneGraphQa.imageCount || 0
      }
    }),
    stage("visual-target-qa", "Visual target QA", visualCompare.status === "warn" ? "warn" : "pass", visualCompare.score ? "Structure consistency score " + visualCompare.score : "Visual target brief generated; preview-level compare pending", {
      warnings: (visualCompare.items || []).flatMap((item) => (item.warnings || []).map((warning) => String(item.slideId) + ":" + warning)).slice(0, 8),
      metrics: {
        score: visualCompare.score || 0,
        method: visualCompare.method || ""
      }
    }),
    stage("scene-repair", "Repair log", sceneGraphRepair.status === "blocked" ? "block" : sceneGraphRepair.status === "planned" ? "warn" : "pass", sceneGraphRepair.status === "planned" ? "Planned " + (sceneGraphRepair.pendingCount || sceneGraphRepair.actions?.length || 0) + " SceneGraph repairs" : "No SceneGraph auto repair needed", {
      warnings: [...(sceneGraphRepair.blockers || []), ...(sceneGraphRepair.actions || []).map((item) => String(item.slideId) + ":" + item.action)].slice(0, 8),
      metrics: {
        pending: sceneGraphRepair.pendingCount || 0,
        completed: sceneGraphRepair.completed?.length || 0
      }
    }),
    stage("pptx-editability", "PPTX editability", pptxEditability.status === "warn" ? "warn" : "pass", pptxEditability.slideCount ? "Text boxes " + (pptxEditability.nativeTextBoxes || 0) + " / structural shapes " + (pptxEditability.nativeNonTextShapes || 0) + " / pictures " + (pptxEditability.nativePictures || 0) : "Waiting for PPTX OpenXML inspection", {
      warnings: pptxEditability.warnings || [],
      metrics: {
        slides: pptxEditability.slideCount || 0,
        textBoxes: pptxEditability.nativeTextBoxes || 0,
        shapes: pptxEditability.nativeShapes || 0,
        nonTextShapes: pptxEditability.nativeNonTextShapes || 0,
        pictures: pptxEditability.nativePictures || 0,
        fullSlidePictures: pptxEditability.fullSlidePictures || 0
      }
    }),
    stage("editable-render", "Editable render", deckSlides.length ? "pass" : "block", deckSlides.length ? "Editable PPTX structure and preview generated" : "Deck not generated yet", {
      metrics: {
        slides: deckSlides.length,
        previewImages: (previewImages || []).filter(Boolean).length
      }
    }),
    stage("visual-review", "Visual review", visualReview?.status || (quality.agentReview?.status === "block" ? "block" : quality.agentReview?.status === "warn" ? "warn" : "pass"), visualReview?.summary || "Rule QA completed", {
      warnings: [...(visualReview?.findings || []), ...(quality.agentReview?.repairable || [])].filter(Boolean),
      metrics: visualReview?.scores || {}
    }),
    stage("edit-readiness", "Edit readiness", editReadiness.ready ? "pass" : "block", editReadiness.ready ? "Materials and preview are ready for online editing" : "Material/preview/quality issues still need handling", {
      warnings: editReadiness.blockingIssues || [],
      metrics: {
        actions: editReadiness.actions?.length || 0
      }
    })
  ];
  return {
    stages,
    slideJobs: buildSlideJobs(deckSlides, routePlan, imagePlan, editablePlan),
    blockingReasons: stages.filter((item) => item.status === "block").flatMap((item) => item.errors.length ? item.errors : item.warnings.length ? item.warnings : [item.summary]),
    lastCompletedStage: [...stages].reverse().find((item) => item.status === "pass")?.id || null
  };
}

function toSafeClientJob(job = {}, error = null) {
  return {
    id: job.id || "unknown",
    mode: job.mode || "unknown",
    status: "normalization-error",
    deck: job.deck || { title: "Unreadable job", slides: [] },
    files: (job.files || []).map((file) => {
      try {
        return normalizeUploadRecord(file);
      } catch {
        return file;
      }
    }),
    exports: {},
    previewImages: [],
    warning: error?.message || "Job could not be normalized",
    createdAt: job.createdAt || "",
    updatedAt: job.updatedAt || "",
    editReadiness: {
      status: "blocked",
      ready: false,
      summary: "This historical job could not be normalized after schema changes.",
      blockingIssues: [error?.message || "job normalization failed"],
      actions: ["create-new-job"]
    }
  };
}

function normalizeExportAliases(job = {}) {
  job.exports = job.exports || {};
  if (job.exports.pptx && !job.exports.editablePptx) job.exports.editablePptx = job.exports.pptx;
  if (job.visualProject?.visualTargetPptxPath && !job.exports.visualTargetPptx) job.exports.visualTargetPptx = job.visualProject.visualTargetPptxPath;
  return job.exports;
}

function buildSceneGraphOverridesForSlide(existing = {}, slideIndex = 0, slide = {}, incoming = {}) {
  const id = `slide_${String(slideIndex + 1).padStart(2, "0")}`;
  const dataPoints = normalizeClientList(incoming.dataPoints ?? slide.dataPoints);
  const bullets = normalizeClientList(incoming.bullets ?? slide.bullets);
  const texts = {
    title: cleanClientText(incoming.title ?? slide.title),
    subtitle: cleanClientText(incoming.subtitle ?? slide.subtitle ?? slide.visualIntent),
    ...Object.fromEntries(bullets.map((value, index) => [`bullet_${index + 1}`, value])),
    ...Object.fromEntries(dataPoints.map((value, index) => [`data_${index + 1}`, value]))
  };
  return {
    ...(existing || {}),
    slides: {
      ...((existing || {}).slides || {}),
      [id]: {
        source: "online-editor",
        updatedAt: new Date().toISOString(),
        texts,
        meta: {
          slideIndex: slideIndex + 1,
          reason: "manual-slide-save"
        }
      }
    }
  };
}

function attachAssetFirstState(job = {}, materialBrief = {}, routePlan = {}) {
  job.assetManifest = buildAssetManifest({
    files: job.files || [],
    materialBrief,
    deck: job.deck || {}
  });
  job.assetManifestQa = validateAssetManifest(job.assetManifest);
  job.input = {
    ...(job.input || {}),
    materialBrief,
    routePlan,
    assetManifestSummary: {
      status: job.assetManifest.status,
      assetCount: job.assetManifest.assets?.length || 0,
      criticalCount: job.assetManifest.criticalCount || 0,
      backgroundBlockedCount: job.assetManifest.backgroundBlockedCount || 0
    }
  };
  return job;
}

function buildSlideJobs(slides = [], routePlan = {}, imagePlan = {}, editablePlan = {}) {
  const planItems = Array.isArray(imagePlan.items) ? imagePlan.items : [];
  const editablePages = Array.isArray(editablePlan.pages) ? editablePlan.pages : [];
  return slides.map((slide, index) => {
    const routeStep = routePlan.layoutSequence?.[index] || {};
    const materialActions = planItems.filter((item) => Number(item.slideIndex) === index || Number(item.slideNumber) === index + 1);
    const editablePage = editablePages[index] || null;
    return {
      id: "slide_" + String(index + 1).padStart(2, "0"),
      index: index + 1,
      title: slide.title || routeStep.title || "Slide " + (index + 1),
      role: slide.storyRole || routeStep.storyRole || routeStep.kind || "",
      layout: slide.layout || routeStep.layout || "",
      status: editablePage?.qa?.fakeEditableRisk ? "needs-editable-qa" : materialActions.some((item) => /need|pending|failed/i.test(item.status || item.action || "")) ? "needs-asset" : "editable-ready",
      sourcePage: routeStep.evidence || "",
      requiredAssets: [...(slide.imageSlots || []), ...materialActions.map((item) => item.fileName || item.source || item.reason).filter(Boolean)].slice(0, 6),
      qa: {
        editable: true,
        editableManifest: editablePage ? {
          status: editablePage.qa?.fakeEditableRisk ? "warn" : "planned",
          textBoxes: editablePage.editableManifest?.text_boxes?.length || 0,
          images: editablePage.editableManifest?.images?.length || 0,
          warnings: editablePage.qa?.warnings || []
        } : null,
        imageLed: ["cover", "visual", "product-detail", "bundle"].includes(slide.layout),
        textLoad: cleanClientText([slide.subtitle, ...(slide.bullets || []), ...(slide.dataPoints || [])].join(" ")).length
      }
    };
  });
}

function buildEditReadiness(job = {}, quality = {}, previewImages = []) {
  const blockingIssues = [];
  const suggestions = [];
  const actions = [];
  const plan = job.imageSupplementPlan || {};
  const planItems = Array.isArray(plan.items) ? plan.items : [];
  const pendingGeneration = planItems.filter((item) => item.action === "need-remote-generation");
  const pendingReuse = planItems.filter((item) => item.action === "use-source-image" || item.action === "use-uploaded-image");
  const plannedMatting = planItems.filter((item) => item.needsCutout && !["local-pass", "cloud-pass", "not-needed"].includes(item.mattingStatus));
  const failedMattingFiles = (job.files || []).filter((file) => file.needsCutout && ["failed", "cloud-failed", "local-failed"].includes(file.mattingStatus));
  const generatedWithoutMatting = (job.files || []).filter((file) => file.needsCutout && ["planned-not-implemented"].includes(file.mattingStatus));
  const localQa = quality.localImageQa || {};
  const renderQa = quality.renderImageQa || {};
  const latestCloud = Array.isArray(job.cloudReviews) ? job.cloudReviews.at(-1) : null;
  const slideCount = job.deck?.slides?.length || 0;
  const previewCount = (previewImages || []).filter(Boolean).length;
  const editablePlan = job.editableRebuildPlan || {};
  const sceneGraphQa = job.sceneGraphQa || quality.sceneGraphQa || {};
  const visualCompare = job.visualCompare || quality.visualCompare || {};
  const pptxEditability = quality.pptxEditability || job.quality?.pptxEditability || {};
  if (sceneGraphQa.status === "block") {
    blockingIssues.push("SceneGraph blocked: " + ((sceneGraphQa.errors || []).slice(0, 1).join("") || "editable source QA failed"));
    actions.push("repair-scene-graph");
  } else if (sceneGraphQa.status === "warn") {
    suggestions.push("SceneGraph editability needs review: " + ((sceneGraphQa.warnings || []).slice(0, 1).join("") || "warning"));
    actions.push("review-scene-graph");
  }
  if (visualCompare.status === "warn") {
    suggestions.push("Visual target consistency needs review: score " + (visualCompare.score || 0));
    actions.push("review-visual-compare");
  }
  if (pptxEditability.status === "warn" || pptxEditability.editable === false) {
    blockingIssues.push("PPTX editability check failed: " + ((pptxEditability.warnings || []).join(" / ") || "native object check failed"));
    actions.push("review-pptx-editability");
  }
  if (editablePlan.candidate) {
    suggestions.push("Object-level editable rebuild: " + (editablePlan.pageCount || 0) + " manifest pages generated; verify text, images, and backgrounds are separated.");
    actions.push("review-editable-manifest");
  }
  if (editablePlan.warnings?.length) suggestions.push(editablePlan.warnings[0]);
  if (plan.needed && pendingReuse.length) {
    suggestions.push("There are " + pendingReuse.length + " pages with reusable source/uploaded images that can be bound as page materials.");
    actions.push("apply-image-supplement");
  }
  if (plan.needed && pendingGeneration.length) {
    blockingIssues.push("There are " + pendingGeneration.length + " pages needing local generated material or cloud fallback.");
    actions.push("apply-local-image-supplement");
  }
  if (plannedMatting.length || generatedWithoutMatting.length) {
    blockingIssues.push("There are " + (plannedMatting.length + generatedWithoutMatting.length) + " foreground materials needing cutout confirmation.");
    actions.push("apply-local-image-supplement");
  }
  if (failedMattingFiles.length) {
    blockingIssues.push(failedMattingFiles.length + " material cutouts failed and need retry or cloud handling.");
    actions.push("apply-local-image-supplement");
  }
  if (localQa.warnCount) {
    suggestions.push("Local image QA has " + localQa.warnCount + " risks; review before formal delivery.");
    actions.push("rescan-local-image-qa");
  }
  if (renderQa.warningCount) blockingIssues.push("Image placement QA has " + renderQa.warningCount + " crop/whitespace risks");
  if (latestCloud?.status === "block") {
    blockingIssues.push("Cloud visual review is block; apply feedback before final delivery.");
    actions.push("repair-visual-review");
  }
  if (slideCount && previewCount !== slideCount) blockingIssues.push("Preview image count mismatch: " + previewCount + "/" + slideCount);
  const uniqueActions = [...new Set(actions)];
  const ready = blockingIssues.length === 0;
  const status = ready ? (suggestions.length ? "ready-with-suggestions" : "ready") : "blocked";
  return {
    status,
    ready,
    summary: ready
      ? (suggestions.length ? "Ready for online editing with QA suggestions before final export" : "Materials, preview, and image QA are ready for online editing")
      : "Asset pipeline is incomplete; finish supplement/cutout/QA before online editing.",
    issues: [...new Set([...blockingIssues, ...suggestions])].slice(0, 8),
    blockingIssues: [...new Set(blockingIssues)].slice(0, 8),
    suggestions: [...new Set(suggestions)].slice(0, 8),
    actions: uniqueActions,
    facts: {
      slideCount,
      previewCount,
      pendingImageItems: plan.needed ? planItems.length : 0,
      pendingGeneration: pendingGeneration.length,
      pendingReuse: pendingReuse.length,
      plannedMatting: plannedMatting.length + generatedWithoutMatting.length,
      failedMatting: failedMattingFiles.length,
      localQaWarnings: localQa.warnCount || 0,
      renderQaWarnings: renderQa.warningCount || 0,
      editableManifestPages: editablePlan.pageCount || 0,
      editableManifestWarnings: editablePlan.warnings?.length || 0,
      sceneGraphTextBoxes: sceneGraphQa.textBoxes || 0,
      sceneGraphShapes: sceneGraphQa.shapeCount || 0,
      visualCompareScore: visualCompare.score || 0,
      pptxTextBoxes: pptxEditability.nativeTextBoxes || 0,
      pptxShapes: pptxEditability.nativeShapes || 0,
      pptxNonTextShapes: pptxEditability.nativeNonTextShapes || 0,
      pptxPictures: pptxEditability.nativePictures || 0,
      pptxFullSlidePictures: pptxEditability.fullSlidePictures || 0
    }
  };
}

function attachSourceRecognitionReport(materialBrief = {}, uploads = []) {
  materialBrief.sourceReport = buildSourceRecognitionReport(materialBrief, uploads);
  materialBrief.pages = mergeSourceDiagnosticsIntoPages(materialBrief.pages || [], materialBrief.sourceReport);
  return materialBrief;
}

async function attachCloudSourceAnalysis(materialBrief = {}, uploads = [], stage = "source-intake") {
  if (!materialBrief.sourceReport?.hasOldDeck) return null;
  const analysis = await reviewSourceIntake({ materialBrief, uploads, stage });
  materialBrief.sourceReport.cloudSourceAnalysis = analysis;
  return analysis;
}

function buildSourceRecognitionReport(materialBrief = {}, uploads = []) {
  const pages = Array.isArray(materialBrief.pages) ? materialBrief.pages : [];
  const sourceDecks = (uploads || []).filter((file) => /\.(ppt|pptx)$/i.test(file.originalName || file.path || ""));
  const aestheticDiagnosis = mergeAestheticDiagnostics(sourceDecks);
  const extractionAudit = mergeExtractionAudits(sourceDecks);
  const diagnosticSlides = new Map((aestheticDiagnosis?.slides || []).map((slide) => [Number(slide.page), slide]));
  const extractedImages = (uploads || []).filter((file) => Number(file.sourceSlide || 0) > 0);
  const looseImages = (uploads || []).filter((file) => isImageUpload(file) && !Number(file.sourceSlide || 0));
  const mediaProfiles = (uploads || []).map((file) => file.mediaProfile).filter(Boolean);
  const imageRoleCounts = countBy((uploads || []).filter(isImageUpload), (file) => file.materialRole || file.mediaProfile?.role || "material");
  const imagesBySlide = extractedImages.reduce((map, file) => {
    const slide = Number(file.sourceSlide || 0);
    if (!slide) return map;
    if (!map.has(slide)) map.set(slide, []);
    map.get(slide).push(file);
    return map;
  }, new Map());
  const pageNumbers = uniqueNumbers([
    ...pages.map((page) => Number(page.page || 0)),
    ...extractedImages.map((file) => Number(file.sourceSlide || 0))
  ]);
  const pageReports = pageNumbers.map((pageNumber) => {
    const page = pages.find((item) => Number(item.page || 0) === pageNumber) || {};
    const diagnostic = diagnosticSlides.get(pageNumber) || null;
    const pageText = cleanClientText(page.text || "");
    const images = imagesBySlide.get(pageNumber) || [];
    return {
      page: pageNumber,
      title: cleanClientText(page.title) || "Page " + pageNumber,
      textChars: pageText.length,
      textPreview: pageText.slice(0, 160),
      imageCount: images.length,
      images: images.map((file) => cleanClientText(file.originalName || path.basename(file.path || ""))).filter(Boolean).slice(0, 12),
      sourceSlideType: diagnostic?.type || null,
      diagnosisScore: diagnostic?.diagnosisScore ?? null,
      layoutStrategy: diagnostic?.layoutStrategy || null,
      diagnosisProblems: diagnostic?.problems || [],
      diagnosisSuggestions: diagnostic?.suggestions || [],
      metrics: diagnostic?.metrics || null,
      status: pageText.length && images.length ? "text+image" : pageText.length ? "text-only" : images.length ? "image-only" : "empty"
    };
  });
  const emptyPages = pageReports.filter((page) => page.status === "empty");
  const imageOnlyPages = pageReports.filter((page) => page.status === "image-only");
  const textOnlyPages = pageReports.filter((page) => page.status === "text-only");
  const warnings = [
    sourceDecks.length && !pageReports.length ? "old-deck-no-page-text" : "",
    extractedImages.length && !pages.length ? "images-without-page-text" : "",
    emptyPages.length ? "empty-pages:" + emptyPages.map((page) => page.page).slice(0, 8).join(",") : "",
    imageOnlyPages.length ? "image-only-pages:" + imageOnlyPages.map((page) => page.page).slice(0, 8).join(",") : "",
    textOnlyPages.length && extractedImages.length ? "text-only-pages:" + textOnlyPages.map((page) => page.page).slice(0, 8).join(",") : "",
    ...(extractionAudit?.warnings || [])
  ].filter(Boolean);
  return {
    hasOldDeck: Boolean(sourceDecks.length),
    sourceDecks: sourceDecks.map((file) => ({
      id: file.id || null,
      name: cleanClientText(file.originalName || path.basename(file.path || "")),
      size: file.size || fileMeta(file.path)?.bytes || null
    })),
    pageCount: pageReports.length || materialBrief.pageCount || 0,
    textPageCount: pages.length,
    imageCount: extractedImages.length + looseImages.length,
    extractedImageCount: extractedImages.length,
    looseImageCount: looseImages.length,
    boundImageCount: extractedImages.filter((file) => pageNumbers.includes(Number(file.sourceSlide || 0))).length,
    imageRoleCounts,
    mediaProfiles: mediaProfiles.slice(0, 80),
    extractionAudit,
    aestheticDiagnosis,
    pages: pageReports.slice(0, 60),
    looseImages: looseImages.map((file) => cleanClientText(file.originalName || path.basename(file.path || ""))).filter(Boolean).slice(0, 24),
    warnings
  };
}

function mergeExtractionAudits(sourceDecks = []) {
  const audits = sourceDecks.map((file) => file.extractionAudit).filter(Boolean);
  if (!audits.length) return null;
  const slides = audits.flatMap((audit) => audit.slides || []);
  const warnings = audits.flatMap((audit) => [
    ...(audit.warnings || []),
    audit.error ? "extraction-audit-failed:" + (audit.deckName || "pptx") : ""
  ].filter(Boolean));
  const missingImageRefs = audits.reduce((sum, audit) => sum + Number(audit.missingImageRefs || 0), 0);
  const linkedImageRefs = audits.reduce((sum, audit) => sum + Number(audit.linkedImageRefs || 0), 0);
  return {
    version: 1,
    deckCount: audits.length,
    deckNames: audits.map((audit) => audit.deckName).filter(Boolean),
    slideCount: audits.reduce((sum, audit) => sum + Number(audit.slideCount || 0), 0),
    textSlideCount: audits.reduce((sum, audit) => sum + Number(audit.textSlideCount || 0), 0),
    embeddedImageRefs: audits.reduce((sum, audit) => sum + Number(audit.embeddedImageRefs || 0), 0),
    extractedImageRefs: audits.reduce((sum, audit) => sum + Number(audit.extractedImageRefs || 0), 0),
    linkedImageRefs,
    missingImageRefs,
    confidence: missingImageRefs || linkedImageRefs || warnings.length ? "medium" : "high",
    slides: slides.slice(0, 80),
    warnings: [...new Set(warnings)].slice(0, 20)
  };
}

function mergeAestheticDiagnostics(sourceDecks = []) {
  const reports = sourceDecks.map((file) => file.aestheticDiagnosis).filter(Boolean);
  if (!reports.length) return null;
  const slides = reports.flatMap((report) => report.slides || []);
  const validScores = reports.map((report) => Number(report.overallScore)).filter((value) => Number.isFinite(value));
  return {
    version: 1,
    deckCount: reports.length,
    deckNames: reports.map((report) => report.deckName).filter(Boolean),
    overallScore: validScores.length ? Math.round(validScores.reduce((sum, value) => sum + value, 0) / validScores.length) : null,
    lowScoreSlides: uniqueNumbers(reports.flatMap((report) => report.lowScoreSlides || [])),
    highDensitySlides: uniqueNumbers(reports.flatMap((report) => report.highDensitySlides || [])),
    slides: slides.slice(0, 80),
    warnings: reports.flatMap((report) => report.error ? ["analysis-failed:" + (report.deckName || "pptx")] : [])
  };
}

function mergeSourceDiagnosticsIntoPages(pages = [], sourceReport = {}) {
  const diagnosticSlides = new Map((sourceReport.aestheticDiagnosis?.slides || []).map((slide) => [Number(slide.page), slide]));
  return (pages || []).map((page) => {
    const diagnostic = diagnosticSlides.get(Number(page.page || 0));
    if (!diagnostic) return page;
    return {
      ...page,
      sourceSlideType: diagnostic.type,
      diagnosisScore: diagnostic.diagnosisScore,
      layoutStrategy: diagnostic.layoutStrategy,
      diagnosisProblems: diagnostic.problems || [],
      diagnosisSuggestions: diagnostic.suggestions || [],
      metrics: diagnostic.metrics || null
    };
  });
}

function isImageUpload(file = {}) {
  return /\.(png|jpe?g|svg|webp)$/i.test(file.originalName || file.path || "") || /^image\//.test(file.mimeType || "");
}

function isReusableSourceImage(file = {}) {
  if (!isImageUpload(file)) return false;
  const source = String(file.source || "").toLowerCase();
  const role = String(file.materialRole || file.mediaProfile?.role || "").toLowerCase();
  return !file.duplicate && !["local-zimage", "cloud-image", "style-reference"].includes(source) && role !== "style-reference";
}

function uniqueNumbers(values = []) {
  return [...new Set(values.map((value) => Number(value || 0)).filter((value) => Number.isFinite(value) && value > 0))].sort((a, b) => a - b);
}

function countBy(items = [], keyFn = () => "unknown") {
  return items.reduce((acc, item) => {
    const key = cleanClientText(keyFn(item) || "unknown") || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function applySourceImageSlots(deck = {}, routePlan = null, uploads = []) {
  const slides = Array.isArray(deck.slides) ? deck.slides.map((slide) => ({ ...slide })) : [];
  const imageFiles = (uploads || []).filter(isImageUpload);
  const imageNames = imageFiles.map((file) => cleanClientText(file.originalName || path.basename(file.path || ""))).filter(Boolean);
  const sourceImagesBySlide = imageFiles.reduce((map, file) => {
    const sourceSlide = Number(file.sourceSlide || 0);
    if (!sourceSlide) return map;
    if (!map.has(sourceSlide)) map.set(sourceSlide, []);
    map.get(sourceSlide).push(file);
    return map;
  }, new Map());
  const routeSteps = Array.isArray(routePlan?.layoutSequence) ? routePlan.layoutSequence : [];
  const pageReports = routePlan?.sourceReport?.pages || [];
  const bindings = [];
  let changedSlides = 0;

  const nextSlides = slides.map((slide, index) => {
    const current = normalizeClientList(slide.imageSlots);
    const routeStep = findBestRouteStepForSlide(slide, index, routeSteps);
    const slotLimit = imageSlotLimitForLayout(slide.layout || routeStep?.layout || "");
    const sourcePage = inferSourcePage(routeStep, slide, index);
    const pageImageFiles = sourcePage ? sourceImagesBySlide.get(sourcePage) || [] : [];
    const pageImages = chooseVisualSourceImages(pageImageFiles, imageFiles, slide, routeStep).map((file) => cleanClientText(file.originalName || path.basename(file.path || "")));
    const routeImages = normalizeClientList(routeStep?.imageSlots);
    const titleImages = matchImagesByText(imageNames, [slide.title, slide.subtitle, slide.visualIntent, ...(slide.bullets || [])].join(" "));
    const fallbackImages = shouldHaveImages(slide, routeStep, pageImages, routeImages, titleImages) ? imageNames.slice(index % Math.max(imageNames.length, 1), index % Math.max(imageNames.length, 1) + 3) : [];
    const recommended = slotLimit ? uniqueTextList([...pageImages, ...routeImages, ...titleImages, ...current, ...fallbackImages]).slice(0, slotLimit) : [];
    const shouldReplace = recommended.length && !sameListPrefix(current, recommended);
    const normalizedCurrent = normalizeImageSlotsForLayout(slide.layout || routeStep?.layout || "", current);
    const nextSlots = shouldReplace ? recommended : normalizedCurrent;
    if (!sameListPrefix(current, nextSlots)) changedSlides += 1;
    bindings.push({
      slide: index + 1,
      title: cleanClientText(slide.title),
      layout: slide.layout || "",
      routeIndex: routeStep?.index || null,
      sourcePage,
      before: current,
      after: nextSlots,
      matchedBy: pageImages.length ? "source-slide" : routeImages.length ? "route-step" : titleImages.length ? "title-match" : fallbackImages.length ? "fallback" : "none",
      sourceTextChars: sourcePage ? pageReports.find((page) => Number(page.page) === sourcePage)?.textChars || null : null
    });
    return {
      ...slide,
      imageSlots: nextSlots
    };
  });

  return {
    deck: { ...deck, slides: nextSlides },
    report: {
      imageCount: imageNames.length,
      sourceImageCount: imageFiles.filter((file) => Number(file.sourceSlide || 0) > 0).length,
      changedSlides,
      boundSlides: bindings.filter((item) => item.after.length).length,
      sourceBoundSlides: bindings.filter((item) => item.matchedBy === "source-slide").length,
      bindings: bindings.slice(0, 60)
    }
  };
}

function imageSlotLimitForLayout(layout = "") {
  if (layout === "cover") return 2;
  if (layout === "visual") return 3;
  if (layout === "product-detail") return 2;
  if (layout === "bundle") return 3;
  if (layout === "closing") return 1;
  return 0;
}

function normalizeImageSlotsForLayout(layout = "", slots = []) {
  const limit = imageSlotLimitForLayout(layout);
  return limit ? normalizeClientList(slots).slice(0, limit) : [];
}

function normalizeDeckImageSlotsForLayouts(deck = {}) {
  if (!Array.isArray(deck.slides)) return deck;
  return {
    ...deck,
    slides: deck.slides.map((slide) => ({
      ...slide,
      imageSlots: normalizeImageSlotsForLayout(slide.layout || "", slide.imageSlots)
    }))
  };
}

function findBestRouteStepForSlide(slide = {}, index = 0, routeSteps = []) {
  if (!routeSteps.length) return null;
  const indexed = routeSteps[index];
  const slideKey = normalizeForImageMatch([slide.title, slide.subtitle, slide.storyRole].join(" "));
  const scored = routeSteps.map((step, stepIndex) => {
    const stepKey = normalizeForImageMatch([step.title, step.purpose, step.storyRole, step.evidence].join(" "));
    let score = 0;
    if (stepIndex === index) score += 8;
    if (step.layout && slide.layout && step.layout === slide.layout) score += 6;
    if (step.imageSlots?.length) score += 5;
    if (slideKey && stepKey) {
      if (stepKey.includes(slideKey) || slideKey.includes(stepKey)) score += 10;
      for (const token of tokenizeForImageMatch(slideKey)) {
        if (token.length >= 2 && stepKey.includes(token)) score += token.length >= 4 ? 4 : 2;
      }
    }
    return { step, score };
  }).sort((a, b) => b.score - a.score);
  return scored[0]?.score > 0 ? scored[0].step : indexed || null;
}

function inferSourcePage(routeStep = null, slide = {}, index = 0) {
  const routePage = extractSourcePage([routeStep?.evidence, routeStep?.sourceLabel, routeStep?.title, routeStep?.purpose].join(" "));
  if (routePage) return routePage;
  const slidePage = extractSourcePage([slide.title, slide.subtitle, slide.contentSource, slide.visualIntent, slide.speakerNotes].join(" "));
  if (slidePage) return slidePage;
  if (routeStep?.sourceType === "original-ppt" && Number(routeStep.index || 0)) return Number(routeStep.index);
  return index + 1;
}

function extractSourcePage(value = "") {
  const text = String(value || "");
  const match = text.match(/(?:slide|page|p)\s*(\d{1,3})/i) || text.match(/(\d{1,3})\s*(?:\/|\bof\b)/i);
  return match ? Number(match[1]) : null;
}

function shouldHaveImages(slide = {}, routeStep = {}, pageImages = [], routeImages = [], titleImages = []) {
  if (pageImages.length || routeImages.length || titleImages.length) return true;
  if (["cover", "visual", "product-detail", "bundle", "cards"].includes(slide.layout || routeStep?.layout)) return true;
  return /图片|原图|产品图|包装|效果|视觉|image|photo/i.test([slide.title, slide.subtitle, slide.visualIntent, routeStep?.purpose].join(" "));
}

function matchImagesByText(imageNames = [], text = "") {
  const tokens = tokenizeForImageMatch(normalizeForImageMatch(text));
  if (!tokens.length) return [];
  return imageNames
    .map((name, index) => {
      const normalizedName = normalizeForImageMatch(name);
      const score = tokens.reduce((sum, token) => sum + (token.length >= 2 && normalizedName.includes(token) ? token.length : 0), 0);
      return { name, index, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.name)
    .slice(0, 4);
}

function chooseVisualSourceImages(sourceFiles = [], allFiles = [], slide = {}, routeStep = {}) {
  const local = sortSourceImagesForSlide(sourceFiles, slide, routeStep, allFiles);
  const localBest = local[0] || null;
  const localBestWeak = !localBest || Number(localBest.size || 0) < 80_000 || sourceImageScore(localBest, "", allFiles) < 12;
  if (!localBestWeak) return local;
  const globalStrong = sortSourceImagesForSlide(
    allFiles.filter((file) => isImageUpload(file) && Number(file.sourceSlide || 0) > 0 && Number(file.size || 0) >= 250_000),
    slide,
    routeStep,
    allFiles
  );
  return uniqueImageFiles([...globalStrong.slice(0, 2), ...local]);
}

function uniqueImageFiles(files = []) {
  const seen = new Set();
  return files.filter((file) => {
    const key = file?.id || file?.path || file?.originalName;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortSourceImagesForSlide(files = [], slide = {}, routeStep = {}, allFiles = []) {
  const text = normalizeForImageMatch([slide.title, slide.subtitle, slide.visualIntent, routeStep?.title, routeStep?.purpose].join(" "));
  return [...files].sort((a, b) => sourceImageScore(b, text, allFiles) - sourceImageScore(a, text, allFiles));
}

function sourceImageScore(file = {}, text = "", allFiles = []) {
  const name = normalizeForImageMatch(file.originalName || path.basename(file.path || ""));
  const role = String(file.materialRole || file.mediaProfile?.role || "").toLowerCase();
  const size = Number(file.size || 0);
  const wantsBackground = /cover|hero|visual|background|poster|封面|主视觉|底图|背景|海报|场景/.test(text);
  const wantsForeground = /product|detail|bundle|pack|box|产品|单品|礼盒|包装|主图|素材|抠图|前景/.test(text);
  let score = 0;
  if (size >= 1_000_000) score += 60;
  else if (size >= 250_000) score += 42;
  else if (size >= 80_000) score += 24;
  else if (size >= 20_000) score += 8;
  else score -= 42;
  if (role === "background") score += wantsForeground && !wantsBackground ? -6 : 22;
  if (role === "foreground") score += wantsBackground && !wantsForeground ? -4 : 20;
  if (role === "material") score += 8;
  if (role === "decor") score -= 24;
  if (role === "style-reference") score -= 80;
  for (const token of tokenizeForImageMatch(text)) {
    if (token.length >= 2 && name.includes(token)) score += token.length >= 4 ? 8 : 3;
  }
  if (/product|pack|box|detail|render|产品|包装|礼盒|细节|实物|效果/.test(name)) score += 18;
  if (/logo|brand|标志|品牌/.test(name)) score -= 8;
  if (/background|bg|shape|line|map|grid|背景|底图|线条|地图/.test(name)) score += wantsBackground ? 16 : -8;
  if (size && allFiles.filter((item) => Number(item.size || 0) === size).length >= 3) score -= 45;
  return score;
}

function tokenizeForImageMatch(value = "") {
  const text = normalizeForImageMatch(value);
  const chinese = text.match(/[\u4e00-\u9fa5]{2,8}/g) || [];
  const latin = text.match(/[a-z0-9]{2,}/g) || [];
  return [...new Set([...chinese, ...latin])].slice(0, 24);
}

function normalizeForImageMatch(value = "") {
  return String(value || "").toLowerCase().replace(/\s+/g, "").replace(/[^\u4e00-\u9fa5a-z0-9]/g, "");
}

function uniqueTextList(values = []) {
  return [...new Set(values.map(cleanClientText).filter(Boolean))];
}

function sameListPrefix(current = [], next = []) {
  if (!current.length && !next.length) return true;
  if (!current.length || !next.length) return false;
  const normalizedCurrent = current.map(normalizeForImageMatch);
  const normalizedNext = next.map(normalizeForImageMatch);
  return normalizedCurrent.length === normalizedNext.length && normalizedCurrent.every((item, index) => item === normalizedNext[index]);
}

function compactQualityAestheticDiagnosis(diagnosis = null) {
  if (!diagnosis) return null;
  return {
    version: diagnosis.version || 1,
    deckName: diagnosis.deckName || "",
    slideCount: diagnosis.slideCount || 0,
    overallScore: Number.isFinite(Number(diagnosis.overallScore)) ? Number(diagnosis.overallScore) : null,
    lowScoreSlides: (diagnosis.lowScoreSlides || []).slice(0, 24),
    highDensitySlides: (diagnosis.highDensitySlides || []).slice(0, 24),
    warnings: (diagnosis.warnings || []).slice(0, 8),
    summary: diagnosis.summary || "",
    slides: (diagnosis.slides || []).slice(0, 24).map((slide) => ({
      page: slide.page,
      title: slide.title,
      type: slide.type || slide.sourceSlideType || "unknown",
      diagnosisScore: slide.diagnosisScore,
      layoutStrategy: slide.layoutStrategy,
      metrics: slide.metrics || {},
      problems: (slide.problems || []).slice(0, 3),
      suggestions: (slide.suggestions || []).slice(0, 3)
    }))
  };
}

function enrichQuality(quality, files = [], materialBrief = {}, routePlan = null) {
  const imageCount = (files || []).filter((file) => /\.(png|jpe?g|svg|webp)$/i.test(file.originalName || file.path || "") || /^image\//.test(file.mimeType || "")).length;
  const localImageQa = summarizeLocalImageQa(files);
  const aestheticDiagnosis = compactQualityAestheticDiagnosis(materialBrief?.sourceReport?.aestheticDiagnosis || routePlan?.sourceReport?.aestheticDiagnosis || quality.aestheticDiagnosis);
  return {
    ...quality,
    imageCount,
    localImageQa,
    aestheticDiagnosis,
    routePlan: routePlan ? {
      deckType: routePlan.deckType,
      inputStrength: routePlan.inputStrength,
      targetSlides: routePlan.targetSlides,
      recommendedTheme: routePlan.recommendedTheme,
      templatePack: routePlan.templatePack || null,
      layoutCount: routePlan.layoutSequence?.length || 0,
      layouts: (routePlan.layoutSequence || []).map((step) => step.layout),
      hasVisual: Boolean(routePlan.imageStrategy?.hasImages),
      hasPricing: (routePlan.layoutSequence || []).some((step) => step.layout === "pricing"),
      hasRiskChecklist: Boolean(routePlan.riskStrategy?.includeRiskChecklist),
      styleFingerprint: routePlan.styleReferenceStrategy?.fingerprint || null,
      aestheticPlan: routePlan.aestheticPlan ? {
        system: routePlan.aestheticPlan.system,
        theme: routePlan.aestheticPlan.theme,
        themeSlug: routePlan.aestheticPlan.themeSlug,
        visualGrammar: routePlan.aestheticPlan.visualGrammar,
        globalComposition: routePlan.aestheticPlan.globalComposition,
        generationPolicy: routePlan.aestheticPlan.generationPolicy,
        comfy: routePlan.aestheticPlan.comfy,
        pagePlans: (routePlan.aestheticPlan.pagePlans || []).map((plan) => ({
          index: plan.index,
          layout: plan.layout,
          title: plan.title,
          layers: plan.layers,
          textSafeArea: plan.textSafeArea,
          textSafePriority: plan.textSafePriority,
          imagePolicy: plan.imagePolicy,
          ornamentPolicy: plan.ornamentPolicy,
          comfyPrompt: plan.comfyPrompt,
          qualityGate: plan.qualityGate
        }))
      } : null,
      reasons: routePlan.routingReasons || []
    } : quality.routePlan || null,
    material: {
      fileCount: materialBrief?.fileCount || files.length || 0,
      uploadedFileCount: materialBrief?.uploadedFileCount || files.length || 0,
      inputStrength: materialBrief?.inputStrength || "strong",
      imageCount: materialBrief?.imageCount || imageCount,
      confirmationFields: materialBrief?.confirmationFields || [],
      missing: materialBrief?.missing || {},
      charCount: materialBrief?.charCount || 0,
      bodyCharCount: materialBrief?.bodyCharCount || 0,
      pageCount: materialBrief?.pageCount || null,
      sourceReport: materialBrief?.sourceReport || null,
      imageSlotReport: materialBrief?.imageSlotReport || null,
      productCount: materialBrief?.productCandidates?.length || 0,
      structuredProductCount: materialBrief?.products?.length || 0,
      priceCount: materialBrief?.prices?.length || 0,
      highlightCount: materialBrief?.highlights?.length || 0
    }
  };
}

function buildAgentDecision(mode, input = {}, uploads = [], materialBrief = {}, routePlan = {}) {
  const hasOldDeck = mode === "optimize" || uploads.some((file) => /\.(ppt|pptx)$/i.test(file.originalName || file.path || ""));
  const text = cleanClientText([input.notes, input.copyMode, input.projectName].filter(Boolean).join(" "));
  const wantsEdit = /修改|改写|优化|重排|重新排版|升级|高级|渲染/.test(text);
  const intent = hasOldDeck && wantsEdit ? "优化 PPT" : hasOldDeck ? "重排 PPT" : materialBrief.inputStrength === "empty" ? "零资料初稿" : "新建 PPT";
  return {
    intent,
    autonomy: "confirm-outline-then-auto-repair-once",
    inputStrength: materialBrief.inputStrength || "strong",
    routeType: routePlan.deckType || "自动",
    targetSlides: routePlan.targetSlides || 0,
    hasConfirmedOutline: Boolean(input.outlinePlan?.layoutSequence?.length),
    hasOldDeck,
    needsHumanOutlineGate: true
  };
}

function buildAgentPlan(decision = {}, routePlan = {}) {
  return {
    name: "AI PPT Agent v1",
    summary: (decision.intent || "PPT task") + ": confirm outline, generate, QA, and auto-repair once.",
    steps: ["Read materials", "Classify intent", "Plan confirmable outline", "Generate deck", "Delivery QA", "Auto repair once if needed", "Generate PPTX and preview"],
    route: {
      deckType: routePlan.deckType,
      targetSlides: routePlan.targetSlides,
      layouts: routePlan.layoutSequence?.map((step) => step.layout) || [],
      reasons: routePlan.routingReasons || []
    }
  };
}

function classifyAgentQuality(deck = {}, quality = {}, routePlan = null, materialBrief = {}, previewImages = null) {
  const slides = Array.isArray(deck.slides) ? deck.slides : [];
  const blocking = [];
  const repairable = [];
  const hints = [];
  const expectedSlides = Number(routePlan?.layoutSequence?.length || routePlan?.targetSlides || 0);
  const actualSlides = slides.length;
  if (!actualSlides) blocking.push("No slides generated");
  if (expectedSlides && Math.abs(actualSlides - expectedSlides) >= 2) blocking.push("Slide count deviates: expected " + expectedSlides + ", actual " + actualSlides);
  if (slides.some((slide) => !cleanClientText(slide.title))) repairable.push("Some slides have empty titles");
  if (slides.some((slide) => !cleanClientText([slide.title, slide.subtitle, ...(slide.bullets || []), ...(slide.dataPoints || [])].join(" ")))) repairable.push("Some slides are too empty");
  const routeScore = Number(quality.routeAdherence?.score);
  if (Number.isFinite(routeScore) && routeScore < 0.75) repairable.push("Route match is low: " + Math.round(routeScore * 100) + "%");
  if ((quality.routingWarnings || []).some((item) => /repeat/i.test(String(item)))) repairable.push("Repeated layout sequence detected");
  if (slides.some((slide) => slide.layout === "pricing" && !/\d/.test([...(slide.bullets || []), ...(slide.dataPoints || [])].join(" ")))) repairable.push("Pricing slide lacks numeric data");
  const hasImageMaterial = Number(materialBrief.imageCount || quality.material?.imageCount || 0) > 0;
  if (hasImageMaterial && slides.some((slide) => slide.layout === "visual" && !(slide.imageSlots || []).length)) repairable.push("Visual slide lacks image slots");
  if (quality.renderImageQa?.warningCount) repairable.push("Image placement has crop/ratio risks: " + quality.renderImageQa.warningCount);
  if (Array.isArray(previewImages) && actualSlides && previewImages.filter(Boolean).length !== actualSlides) blocking.push("Preview image count mismatch: " + previewImages.filter(Boolean).length + "/" + actualSlides);
  if (routePlan?.designDirectorStrategy) {
    const layouts = slides.map((slide) => slide.layout);
    const imageLedCount = slides.filter((slide) => ["cover", "visual", "product-detail", "bundle"].includes(slide.layout) && (slide.imageSlots || []).length).length;
    const longTextSlides = slides.filter((slide) => (slide.bullets || []).length > 3 || cleanClientText([slide.subtitle, ...(slide.bullets || [])].join(" ")).length > 180);
    if (hasImageMaterial && imageLedCount < Math.min(3, Math.ceil(slides.length / 4))) repairable.push("Not enough image-led slides for visual-first deck");
    if (longTextSlides.length) repairable.push("Text is too heavy on " + longTextSlides.length + " slides; compress to proposal copy.");
    if ((layouts.filter((layout) => layout === "cards").length || 0) >= Math.ceil(slides.length / 2)) repairable.push("Too many card-layout slides; page rhythm is too templated");
  }
  if ((materialBrief.confirmationFields || []).length) hints.push("Needs manual confirmation: " + materialBrief.confirmationFields.join(", "));
  if (materialBrief.inputStrength === "weak" || materialBrief.inputStrength === "empty") hints.push("Input is weak; generated content needs human review");
  const aestheticDiagnosis = quality.aestheticDiagnosis || materialBrief.sourceReport?.aestheticDiagnosis || {};
  if (Number.isFinite(Number(aestheticDiagnosis.overallScore)) && Number(aestheticDiagnosis.overallScore) < 72) repairable.push("Old deck aesthetic score is low: " + aestheticDiagnosis.overallScore);
  if ((aestheticDiagnosis.lowScoreSlides || []).length) repairable.push("Old deck low-score slides: " + aestheticDiagnosis.lowScoreSlides.slice(0, 6).join(", "));
  return { blocking: [...new Set(blocking)], repairable: [...new Set(repairable)], hints: [...new Set(hints)] };
}

function buildAgentReview(stage, deck = {}, quality = {}, routePlan = null, materialBrief = {}, files = [], previewImages = null, cloudVisualReview = null) {
  const assessment = classifyAgentQuality(deck, quality, routePlan, materialBrief, previewImages);
  const sourceReport = materialBrief.sourceReport || quality.material?.sourceReport || {};
  const imageSlotReport = materialBrief.imageSlotReport || quality.material?.imageSlotReport || {};
  const routeScore = Number(quality.routeAdherence?.score);
  const styleRefs = routePlan?.styleReferenceStrategy?.count || 0;
  const styleFingerprint = routePlan?.styleReferenceStrategy?.fingerprint || quality.routePlan?.styleFingerprint || null;
  const localImageQa = quality.localImageQa || summarizeLocalImageQa(files);
  const renderImageQa = quality.renderImageQa || {};
  const aestheticDiagnosis = quality.aestheticDiagnosis || sourceReport.aestheticDiagnosis || {};
  const previewCount = Array.isArray(previewImages) ? previewImages.filter(Boolean).length : null;
  const slides = Array.isArray(deck.slides) ? deck.slides : [];
  const agents = [
    {
      id: "brain",
      name: "Brain Agent",
      role: "Controls task stage and whether generation can continue",
      status: assessment.blocking.length ? "block" : assessment.repairable.length ? "warn" : "pass",
      findings: [...assessment.blocking, ...assessment.repairable, ...assessment.hints].slice(0, 6)
    },
    {
      id: "route",
      name: "Route Agent",
      role: "Checks deck type, slide count, layout queue, and routing adherence",
      status: Number.isFinite(routeScore) && routeScore < 0.75 ? "warn" : "pass",
      findings: [
        routePlan?.deckType ? "Type: " + routePlan.deckType : "",
        routePlan?.targetSlides ? "Target slides: " + routePlan.targetSlides : "",
        Number.isFinite(routeScore) ? "Route match: " + Math.round(routeScore * 100) + "%" : "",
        ...(quality.routingWarnings || []).slice(0, 3)
      ].filter(Boolean)
    },
    {
      id: "source",
      name: "Material Agent",
      role: "Checks source text, images, page binding, and generated image slots",
      status: localImageQa.warnCount ? "warn" : sourceReport.hasOldDeck && !sourceReport.boundImageCount ? "warn" : "pass",
      findings: [
        sourceReport.pageCount ? "Source pages: " + sourceReport.pageCount : "",
        sourceReport.imageCount ? "Source images: " + sourceReport.imageCount : "",
        sourceReport.boundImageCount ? "Bound source images: " + sourceReport.boundImageCount : "",
        imageSlotReport.boundSlides ? "Bound slide image slots: " + imageSlotReport.boundSlides : "",
        localImageQa.total ? "Local QA: " + localImageQa.passCount + "/" + localImageQa.total + " passed" : "",
        renderImageQa.total ? "Image placement: " + renderImageQa.total + " objects, risks " + (renderImageQa.warningCount || 0) : "",
        renderImageQa.warnings?.length ? "Placement risks: " + renderImageQa.warnings.slice(0, 3).join(", ") : "",
        localImageQa.risks?.length ? "Risks: " + localImageQa.risks.slice(0, 3).join(", ") : ""
      ].filter(Boolean)
    },
    {
      id: "aesthetic-diagnosis",
      name: "Aesthetic Diagnosis Agent",
      role: "Checks old PPT density, hierarchy, color, whitespace, image risk, and rebuild strategy",
      status: Number.isFinite(Number(aestheticDiagnosis.overallScore)) && Number(aestheticDiagnosis.overallScore) < 72 ? "warn" : (aestheticDiagnosis.lowScoreSlides || []).length ? "warn" : "pass",
      findings: [
        Number.isFinite(Number(aestheticDiagnosis.overallScore)) ? "Diagnosis score: " + aestheticDiagnosis.overallScore : "",
        (aestheticDiagnosis.lowScoreSlides || []).length ? "Low-score slides: " + aestheticDiagnosis.lowScoreSlides.slice(0, 8).join(", ") : "",
        (aestheticDiagnosis.highDensitySlides || []).length ? "High-density slides: " + aestheticDiagnosis.highDensitySlides.slice(0, 8).join(", ") : "",
        ...((aestheticDiagnosis.slides || []).flatMap((slide) => slide.problems || []).map((item) => item.message || item).filter(Boolean).slice(0, 3))
      ].filter(Boolean)
    },
    {
      id: "style",
      name: "Style Agent",
      role: "Checks style library, style proof coverage, and visual tone constraints",
      status: styleRefs || routePlan?.recommendedTheme ? "pass" : "warn",
      findings: [
        routePlan?.recommendedTheme ? "Style: " + routePlan.recommendedTheme : "",
        styleRefs ? "Reference images: " + styleRefs : "No custom style reference images",
        styleFingerprint?.prompt ? "Fingerprint: " + styleFingerprint.prompt : "",
        stage === "style-preview" ? "Style proof stage: review before human confirmation" : "Final deck stage: follow confirmed style"
      ].filter(Boolean)
    },
    {
      id: "delivery",
      name: "Delivery Agent",
      role: "Checks PPTX, preview, export, and editability risks",
      status: assessment.blocking.length ? "block" : quality.warningCount > 3 ? "warn" : "pass",
      findings: [
        "Slides: " + slides.length,
        previewCount !== null ? "Preview: " + previewCount + "/" + slides.length : "",
        "Warnings: " + (quality.warningCount || 0),
        quality.imageSlotCount ? "Image slots: " + quality.imageSlotCount : "",
        localImageQa.warnCount ? "Local image risks: " + localImageQa.warnCount : "",
        renderImageQa.warningCount ? "Ratio/crop risks: " + renderImageQa.warningCount : ""
      ].filter(Boolean)
    }
  ];
  if (cloudVisualReview) {
    agents.push({
      id: "cloud-visual",
      name: "Cloud Visual Agent",
      role: "Reviews preview aesthetics, density, image use, and delivery impression",
      status: cloudVisualReview.used ? cloudVisualReview.status || "warn" : "warn",
      findings: [
        cloudVisualReview.used ? cloudVisualReview.summary : "Cloud visual review not completed: " + (cloudVisualReview.reason || "not available"),
        ...(cloudVisualReview.findings || []).slice(0, 4),
        cloudVisualReview.scores ? "Scores: style " + (cloudVisualReview.scores.style ?? "-") + " / layout " + (cloudVisualReview.scores.layout ?? "-") + " / density " + (cloudVisualReview.scores.density ?? "-") + " / image " + (cloudVisualReview.scores.imageUse ?? "-") : ""
      ].filter(Boolean)
    });
  }
  return {
    stage,
    createdAt: new Date().toISOString(),
    status: agents.some((agent) => agent.status === "block") ? "block" : agents.some((agent) => agent.status === "warn") ? "warn" : "pass",
    nextGate: stage === "style-preview" ? "human-style-confirmation" : "editable-export",
    cloudVisualReview: cloudVisualReview || null,
    agents
  };
}

function summarizeLocalImageQa(files = []) {
  const records = (files || []).filter((file) => file.source === "local-zimage" || file.provider === "comfyui-zimage");
  const qaRecords = records.map((file) => file.visualQa).filter(Boolean);
  const warnRecords = qaRecords.filter((qa) => qa.status !== "pass");
  const risks = uniqueTextList(warnRecords.flatMap((qa) => qa.risks || [])).slice(0, 8);
  return {
    total: records.length,
    checked: qaRecords.length,
    passCount: qaRecords.filter((qa) => qa.status === "pass").length,
    warnCount: warnRecords.length,
    risks,
    items: records.map((file) => ({
      id: file.id,
      name: file.originalName,
      slide: file.sourceSlide || null,
      status: file.visualQa?.status || "unchecked",
      risks: file.visualQa?.risks || [],
      metrics: file.visualQa ? {
        full: file.visualQa.full,
        textSafe: file.visualQa.textSafe
      } : null,
      workflowPath: file.comfy?.workflowPath || null
    })).slice(0, 12)
  };
}

function shouldAgentAutoRepair(assessment = {}) {
  return Boolean(assessment.blocking?.length || assessment.repairable?.length);
}

function summarizeAgentQuality(quality = {}) {
  return {
    slideCount: quality.slideCount || 0,
    warningCount: quality.warningCount || 0,
    routeScore: quality.routeAdherence?.score ?? null,
    usedLayouts: quality.usedLayouts || []
  };
}

async function refreshPreview(job, successVerb = "generated") {
  const options = arguments[2] || {};
  job.deck = normalizeDeckImageSlotsForLayouts(job.deck);
  const routePlan = job.input?.routePlan || null;
  const materialBrief = job.input?.materialBrief || {};
  if (routePlan) {
    const validated = validateDeck(job.deck, routePlan);
    job.deck = normalizeDeckImageSlotsForLayouts(validated.deck);
    const previousQuality = job.quality || {};
    job.quality = enrichQuality({
      ...previousQuality,
      ...validated.quality,
      pptxEditability: previousQuality.pptxEditability || validated.quality.pptxEditability,
      sceneGraphQa: previousQuality.sceneGraphQa || validated.quality.sceneGraphQa,
      visualCompare: previousQuality.visualCompare || validated.quality.visualCompare
    }, job.files || [], materialBrief, routePlan);
    job.warning = validated.warnings.length ? validated.warnings.join("; ") : "";
  }
  const result = await renderPptxPreview(job.exports.pptx);
  job.previewImages = result.images || [];
  job.previewWarning = result.error ? "PNG preview generation failed: " + result.error : null;
  addEvent(
    job,
    result.error ? "preview-error" : "preview",
    result.error ? job.previewWarning : successVerb + " " + job.previewImages.length + " preview images",
    { count: job.previewImages.length, error: result.error || null }
  );
  await updateSceneGraphPreviewCompare(job);
  if (options.allowSceneGraphRepair !== false && hasAutoRepairableSceneGraphActions(job.sceneGraphRepair)) {
    addEvent(job, "scenegraph-auto-repair", "SceneGraph repair applied after preview QA", {
      actions: (job.sceneGraphRepair.actions || []).map((item) => item.action).slice(0, 8)
    });
    job.exports.pptx = await buildDeck(job);
    job.exportMeta = collectExportMeta(job.exports);
    await refreshPreview(job, "SceneGraph repair rendered", { allowSceneGraphRepair: false });
  }
}

function hasAutoRepairableSceneGraphActions(repairRecord = {}) {
  if (repairRecord.status !== "planned") return false;
  const autoRepairable = new Set(["increase-or-bind-image-area", "rebuild-native-text-boxes", "increase-visual-hierarchy", "move-text-away-from-busy-region"]);
  return (repairRecord.actions || []).some((item) => autoRepairable.has(item.action));
}

async function updateSceneGraphPreviewCompare(job) {
  ensureSceneGraphForJob(job);
  const previewQa = [];
  for (const imageUrl of job.previewImages || []) {
    const filePath = resolveOutputUrlToFile(imageUrl);
    if (!filePath || !fsSync.existsSync(filePath)) continue;
    try {
      previewQa.push(await analyzeGeneratedImage(filePath, { textSafeArea: "" }));
    } catch (error) {
      previewQa.push({
        version: 1,
        source: "local-pixel-qa",
        status: "warn",
        risks: ["preview-qa-failed:" + (error.message || "unknown")],
        full: null,
        textSafe: null
      });
    }
  }
  let targetQa = null;
  const targetPath = job.visualTarget?.sample?.imagePath;
  if (targetPath && fsSync.existsSync(targetPath)) {
    try {
      targetQa = await analyzeGeneratedImage(targetPath, { textSafeArea: "" });
    } catch (error) {
      targetQa = {
        version: 1,
        source: "local-pixel-qa",
        status: "warn",
        risks: ["visual-target-qa-failed:" + (error.message || "unknown")],
        full: null,
        textSafe: null
      };
    }
  }
  job.visualCompare = compareRenderedPreviewToVisualTarget({
    sceneGraph: job.sceneGraph,
    visualTarget: job.visualTarget,
    previewImages: job.previewImages || [],
    previewQa,
    targetQa
  });
  job.sceneGraphRepair = buildSceneGraphRepairRecord(job.sceneGraph, job.visualCompare, job.sceneGraphQa);
  addEvent(job, "scenegraph-preview-qa", "SceneGraph/PPTX preview QA " + job.visualCompare.score, {
    status: job.visualCompare.status,
    method: job.visualCompare.method,
    score: job.visualCompare.score,
    warnings: job.visualCompare.warnings || []
  });
}

function resolveOutputUrlToFile(value = "") {
  const pathname = String(value || "").split("?")[0];
  if (pathname && fsSync.existsSync(pathname)) {
    const resolvedPath = path.resolve(pathname);
    return resolvedPath.startsWith(path.resolve(outputDir)) ? resolvedPath : null;
  }
  if (!pathname.startsWith("/outputs/")) return null;
  const parts = pathname.slice("/outputs/".length).split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  const resolved = path.resolve(outputDir, ...parts);
  const outputRoot = path.resolve(outputDir);
  return resolved.startsWith(outputRoot) ? resolved : null;
}

function normalizeInput(input = {}) {
  return {
    ...input,
    extracted: (input.extracted || []).map((item) => ({ ...item, name: decodeMaybeMojibake(item.name) }))
  };
}

function filterStyleReferencesForInput(references = [], input = {}, routePlan = null) {
  return references
    .map((record) => ({
      ...record,
      name: decodeMaybeMojibake(record.name || ""),
      tone: decodeMaybeMojibake(record.tone || ""),
      themeName: decodeMaybeMojibake(record.themeName || "")
    }))
    .filter((record) => record.id || record.path || record.originalName)
    .slice(0, 24);
}

function normalizeUploadRecord(file) {
  if (!file) return file;
  const normalized = path.normalize(file.path || "");
  const isImage = /\.(png|jpe?g|svg|webp)$/i.test(file.originalName || file.path || "") || /^image\//.test(file.mimeType || "");
  const uploadUrl = normalized.startsWith(uploadDir) && fsSync.existsSync(normalized)
    ? "/uploads/" + path.relative(uploadDir, normalized).split(path.sep).map(encodeURIComponent).join("/")
    : null;
  return { ...file, originalName: decodeMaybeMojibake(file.originalName), uploadUrl: isImage ? uploadUrl : null };
}

function attachVisualTargetSampleUrl(visualTarget = null, files = []) {
  if (!visualTarget?.sample) return visualTarget;
  const sample = visualTarget.sample || {};
  const record = (files || []).find((file) => file.id && file.id === sample.imageId) || (files || []).find((file) => sample.imagePath && path.normalize(file.path || "") === path.normalize(sample.imagePath));
  const normalized = record ? normalizeUploadRecord(record) : null;
  return {
    ...visualTarget,
    sample: {
      ...sample,
      imageUrl: normalized?.uploadUrl || null
    }
  };
}

function normalizeVisualProjectForClient(project = null, toOutputUrl = (value) => value) {
  if (!project) return null;
  const pathKeys = [
    "projectDir",
    "outlinePath",
    "deckSpecPath",
    "promptsDir",
    "originImageDir",
    "sceneGraphDir",
    "slideJobsPath",
    "slideRunStatePath",
    "slideSceneGraphManifestPath",
    "contactSheetPath",
    "visualTargetPptxPath"
  ];
  const urls = {};
  for (const key of pathKeys) {
    if (project[key]) urls[key.replace(/Path$|Dir$/, "Url")] = toOutputUrl(project[key], { cacheBust: true });
  }
  const originImages = fsSync.existsSync(project.originImageDir || "")
    ? fsSync.readdirSync(project.originImageDir)
      .filter((name) => /^slide_\d+\.(png|jpe?g|webp)$/i.test(name))
      .sort()
      .map((name, index) => {
        const filePath = path.join(project.originImageDir, name);
        return {
          slide: index + 1,
          name,
          path: filePath,
          url: toOutputUrl(filePath, { cacheBust: true })
        };
      })
    : [];
  return {
    ...project,
    originImages,
    urls
  };
}

function normalizeStyleReference(record) {
  if (!record) return record;
  const normalized = path.normalize(record.path || "");
  const imageUrl = normalized.startsWith(uploadDir) && fsSync.existsSync(normalized)
    ? "/uploads/" + path.relative(uploadDir, normalized).split(path.sep).map(encodeURIComponent).join("/")
    : null;
  const defaultTheme = { name: "可选参考图", slug: "skill-first-reference" };
  return {
    ...record,
    name: decodeMaybeMojibake(record.name),
    themeName: defaultTheme.name,
    themeSlug: defaultTheme.slug,
    originalName: decodeMaybeMojibake(record.originalName),
    styleFingerprint: record.styleFingerprint || null,
    imageUrl
  };
}

function compactStyleReference(record) {
  const defaultTheme = { name: "可选参考图", slug: "skill-first-reference" };
  return {
    id: record.id,
    name: decodeMaybeMojibake(record.name),
    tone: record.tone || "",
    themeName: defaultTheme.name,
    themeSlug: defaultTheme.slug,
    originalName: decodeMaybeMojibake(record.originalName),
    styleFingerprint: record.styleFingerprint || null
  };
}

function collectExportMeta(exports = {}) {
  return Object.fromEntries(Object.entries(exports).map(([key, value]) => [key, fileMeta(value)]));
}

function fileMeta(value) {
  if (Array.isArray(value)) return value.map(fileMeta);
  if (typeof value !== "string" || !fsSync.existsSync(value)) return null;
  const stats = fsSync.statSync(value);
  return { bytes: stats.size, label: formatBytes(stats.size) };
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function buildCodexPptDirectorReply({ text = "", files = [], job = null, activeStep = "" } = {}) {
  const lower = text.toLowerCase();
  const hasSource = files.length > 0;
  const hasPpt = files.some((file) => /\.(ppt|pptx)$/i.test(file.originalName || ""));
  const slideCount = job?.deck?.slides?.length || 0;
  const visualProject = job?.visualProject || null;
  const visualReady = visualProject?.generatedImages && visualProject.generatedImages >= visualProject.slideCount;
  const hasPptx = Boolean(job?.exports?.editablePptx || job?.exports?.pptx || job?.exports?.visualTargetPptx);
  const facts = [
    hasSource ? `已关联 ${files.length} 个素材${hasPpt ? "，包含 PPT/PPTX" : ""}` : "尚未关联素材文件",
    job ? `当前任务 ${job.id}，${slideCount || 0} 页` : "尚未创建任务",
    visualProject ? `视觉项目 ${visualProject.generatedImages || 0}/${visualProject.slideCount || 0}` : "尚未准备视觉项目",
    hasPptx ? "已有可下载 PPTX" : "尚未输出 PPTX"
  ];

  if (!hasSource && !job) {
    return {
      role: "assistant",
      title: "先给我材料或主题",
      text: "可以。我会按 codex-ppt-director 流程做：先读材料，再确认大纲、风格和样张，最后并行生成整套 PPT。现在还没有素材；你可以上传 PPT/PDF/图片，或者直接输入主题。",
      facts,
      actions: [{ id: "focus-upload", label: "先上传资料", kind: "navigate", step: "materials" }]
    };
  }

  if (hasSource && !job) {
    return {
      role: "assistant",
      title: hasPpt ? "我会先按原 PPT 做源文件诊断" : "我会先整理材料结构",
      text: "下一步建议先生成可确认的大纲。这个智能体不会直接跳到整套生成，因为图片式 PPT 一旦方向错，返工成本很高；先确认页数、每页角色和保留信息更稳。",
      facts,
      actions: [
        { id: "plan-outline", label: "生成大纲", kind: "client", event: "plan-outline" },
        ...(/直接|一键|开始|生成/.test(text) ? [{ id: "create-job", label: "按当前大纲创建任务", kind: "client", event: "create-job" }] : [])
      ]
    };
  }

  if (job && !visualProject) {
    return {
      role: "assistant",
      title: "任务已创建，可以进入样张阶段",
      text: "当前已经有任务和大纲。按 PPT 智能体流程，下一步应确认视觉方向并生成 1 页样张。样张通过后，再启动页面任务生成其余页面。",
      facts,
      actions: [
        { id: "open-generate", label: "进入生成阶段", kind: "navigate", step: "generate" },
        { id: "create-visual-project", label: "准备视觉项目", kind: "client", event: "visual-sample" }
      ]
    };
  }

  if (job && visualProject && !visualReady) {
    return {
      role: "assistant",
      title: "视觉项目还没生成完整",
      text: "我看到视觉项目已经准备，但页面图片还没齐。严谨做法是先看样张；如果你已经认可风格，可以继续生成视觉项目。正式 codex-ppt 流程里，整套生成最好按页面任务逐页记录。",
      facts,
      actions: [
        { id: "generate-sample", label: "生成视觉样张", kind: "client", event: "visual-sample" },
        { id: "generate-visual", label: "生成视觉项目", kind: "client", event: "visual-project" }
      ]
    };
  }

  if (job && visualReady && !hasPptx) {
    return {
      role: "assistant",
      title: "页面已齐，可以组装 PPTX",
      text: "origin_image 已经齐了。下一步是 QA 接触表、写入备注并组装 PPTX。如果 Python 不可用，可以走 Node 组装兜底。",
      facts,
      actions: [{ id: "open-export", label: "进入导出", kind: "navigate", step: "export" }]
    };
  }

  if (/问题|怎么|链路|页面任务|子代理|agent|智能体/.test(lower + text)) {
    return {
      role: "assistant",
      title: "这个智能体的分工",
      text: "主智能体负责读材料、确认大纲、确认风格、样张验收、状态记录、质量检查和组装；页面任务只负责单页图片或单页重建。这样可以并行处理，同时避免多个任务同时改同一套文件。",
      facts,
      actions: [{ id: "open-status", label: "看状态", kind: "navigate", step: activeStep || "preview" }]
    };
  }

  return {
    role: "assistant",
    title: "当前可以继续微调或导出",
    text: "这套任务已经有结果。你可以让我检查某一页、重生成某页、换风格，或者进入导出。若目标是 editable PPT，需要走另一条可编辑重建链路。",
    facts,
    actions: [
      { id: "open-preview", label: "看预览", kind: "navigate", step: "preview" },
      { id: "open-export", label: "去导出", kind: "navigate", step: "export" }
    ]
  };
}

function buildSkillFirstDirectorReply({ text = "", files = [], workflowJob = null, compliance = {}, delivery = {}, activeStep = "" } = {}) {
  const lower = text.toLowerCase();
  const counts = compliance?.counts || {};
  const runbook = compliance?.runbook || {};
  const deliveryStatus = delivery?.status || {};
  const finalGate = delivery?.finalGate || {};
  const nextStep = deliveryStatus.nextStep || {};
  const blockers = Array.isArray(runbook.blockers) ? runbook.blockers : [];
  const nextActions = [
    ...(Array.isArray(runbook.nextActions) ? runbook.nextActions : []),
    ...(Array.isArray(deliveryStatus.nextActions) ? deliveryStatus.nextActions : [])
  ].map(normalizeDirectorNextAction).filter(Boolean);
  const sourcePages = countDirectorValue(counts.sourcePages, workflowJob?.artifacts?.renderedPages?.length);
  const slideTotal = countDirectorValue(counts.codexPptSlideJobs, sourcePages);
  const slideRecorded = countDirectorValue(counts.codexPptSlideRecorded, counts.visualPages);
  const editPrepared = Boolean(compliance?.editppt?.prepared);
  const finalReady = finalGate.productReady === true || deliveryStatus.level === "ready";
  const facts = [
    workflowJob?.id ? `工作流：${workflowJob.id}` : "",
    `当前阶段：${workflowStageLabel(workflowJob?.currentStage || workflowJob?.status || "created")}`,
    `源页面：${sourcePages}`,
    `codex-ppt 图片页：${slideRecorded}/${slideTotal}`,
    `editppt：${editPrepared ? "已准备" : "未准备"}`,
    `交付：${finalReady ? "可交付" : workflowDeliveryLabel(finalGate.level || deliveryStatus.level)}`
  ].filter(Boolean);
  const primaryNext = nextActions[0] || (nextStep.label ? normalizeDirectorNextAction(`${nextStep.label}：${nextStep.reason || "按工作流面板继续"}`) : "");
  const actions = [
    { id: "open-workflow", label: "打开工作流", event: "open-workflow" },
    { id: "refresh-workflow", label: "刷新状态", event: "refresh-workflow" }
  ];

  if (/问题|怎么|链路|agent|智能体|区别|skill|流程/.test(`${lower} ${text}`)) {
    return {
      role: "assistant",
      title: "当前采用两段 Skill 工作流",
      text: "这条产品链路以 codex-ppt 负责视觉统一的图片型 PPT，再由 image-to-editable-ppt/editppt 重建可编辑 PPT。旧模板生成器不作为主流程；我会根据工作流证据、确认关卡和交付门禁判断下一步。",
      facts,
      actions
    };
  }

  if (blockers.length) {
    return {
      role: "assistant",
      title: "工作流当前需要处理阻塞项",
      text: `当前卡在「${runbook.currentTitle || workflowStageLabel(workflowJob?.currentStage)}」。优先处理：${blockers.slice(0, 2).join("；")}。处理后再刷新状态，避免跳过确认关卡或交付门禁。`,
      facts,
      actions
    };
  }

  if (finalReady) {
    return {
      role: "assistant",
      title: "最终文件已达到交付条件",
      text: "工作流显示最终可编辑 PPT 已通过交付门禁。建议打开工作流检查交付中心，下载 editable-final.pptx、validation.json 和日志包。",
      facts,
      actions
    };
  }

  if (primaryNext) {
    return {
      role: "assistant",
      title: runbook.currentTitle || nextStep.label || "继续当前工作流",
      text: `下一步建议：${primaryNext}。我会按现有 Skill-first 状态推进，不会回到旧模板或旧一键生成链路。`,
      facts,
      actions
    };
  }

  return {
    role: "assistant",
    title: "继续当前 Skill-first 工作流",
    text: "当前还没有明确阻塞项。建议打开工作流面板，按 codex-ppt 确认、图片型 PPT、editppt 重建、最终交付门禁的顺序继续。",
    facts,
    actions
  };
}

function countDirectorValue(value, fallback = 0) {
  const number = Number(value ?? fallback ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function workflowStageLabel(stage = "") {
  const labels = {
    created: "已创建",
    source_ready: "源文件就绪",
    source_rendered: "源页面已渲染",
    visual_sample_ready: "codex-ppt 样张就绪",
    visual_generating: "codex-ppt 图片生成中",
    image_deck_ready: "图片型 PPT 就绪",
    ocr_ready: "OCR 文字提示就绪",
    editable_prepared: "editppt 已准备",
    pages_running: "页面重建中",
    finalizing: "正在生成最终 PPT",
    complete: "已完成",
    failed: "失败"
  };
  return labels[stage] || stage || "未开始";
}

function workflowDeliveryLabel(level = "") {
  if (level === "ready") return "已通过";
  if (level === "draft") return "草稿可下载";
  if (level === "blocked") return "被门禁阻止";
  if (level === "pending") return "待处理";
  return level || "待处理";
}

function normalizeDirectorNextAction(value = "") {
  return cleanClientText(value)
    .replace(/^下一步[:：]\s*/i, "")
    .replace(/codex slide workers/gi, "执行 codex-ppt 图片页任务")
    .replace(/sync codex slide tasks/gi, "同步 codex-ppt 图片页任务")
    .replace(/approve outline\/style\/backend/gi, "确认大纲、风格和后端")
    .replace(/start page workers/gi, "启动可编辑页面任务")
    .replace(/finalize editable/gi, "生成最终可编辑 PPT")
    .replace(/\bworker\b/gi, "worker");
}

function cleanClientText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function hydrateProductVisualActionPayload(report = {}, readinessAlignment = {}) {
  const readinessJobId = readinessAlignment?.matchesLatestReport ? readinessAlignment.latestReadinessJobId || "" : "";
  if (!readinessJobId) return report;
  const hydrateNext = (next = null) => {
    if (!next || !Array.isArray(next.productActions)) return next;
    return {
      ...next,
      productActions: next.productActions.map((action) => {
        if (action?.id !== "product-visual-sample-run") return action;
        return {
          ...action,
          body: {
            ...(action.body || {}),
            confirmPromptPreview: true,
            promptPreviewJobId: readinessJobId
          }
        };
      })
    };
  };
  const productVisualNext = hydrateNext(report.productVisualNext);
  const acceptanceProductVisualNext = hydrateNext(report.acceptance?.productVisualNext);
  const latestProductVisualNext = hydrateNext(report.latest?.productVisualNext);
  const latestAcceptanceProductVisualNext = hydrateNext(report.latest?.acceptance?.productVisualNext);
  return {
    ...report,
    productVisualNext,
    acceptance: report.acceptance
      ? {
        ...report.acceptance,
        productVisualNext: acceptanceProductVisualNext || productVisualNext
      }
      : report.acceptance,
    latest: report.latest
      ? {
        ...report.latest,
        productVisualNext: latestProductVisualNext || productVisualNext,
        acceptance: report.latest.acceptance
          ? {
            ...report.latest.acceptance,
            productVisualNext: latestAcceptanceProductVisualNext || latestProductVisualNext || productVisualNext
          }
          : report.latest.acceptance
      }
      : report.latest
  };
}

function alignProductVisualReadinessWithLatestReport(report = {}, productVisualReadiness = {}) {
  const latest = report?.latest || null;
  const readiness = productVisualReadiness?.latest || productVisualReadiness || {};
  const latestJobId = latest?.jobId || "";
  const readinessJobId = readiness?.result?.jobId || readiness?.jobId || "";
  const reportSourcePath = normalizeComparablePath(latest?.sourcePath || "");
  const readinessSourcePath = normalizeComparablePath(readiness?.sourcePath || readiness?.result?.sourceRender?.source || "");
  const reportTargetPages = Number(latest?.productVisualNext?.targetPages || latest?.acceptance?.targetPages || latest?.sourceRender?.renderedPages || 0);
  const readinessTargetPages = Number(readiness?.maxPages || readiness?.result?.sourceRender?.targetSlideCount || readiness?.result?.sourceRender?.renderedPages || 0);
  const reportTime = Date.parse(latest?.writtenAt || "");
  const readinessTime = Date.parse(readiness?.endedAt || readiness?.startedAt || "");
  const hasReport = Boolean(latestJobId);
  const hasReadiness = Boolean(productVisualReadiness?.exists && readinessJobId);
  const sameSource = Boolean(reportSourcePath && readinessSourcePath && reportSourcePath === readinessSourcePath);
  const sameTargetPages = Boolean(reportTargetPages && readinessTargetPages && readinessTargetPages >= reportTargetPages);
  const freshEnough = Number.isFinite(reportTime) && Number.isFinite(readinessTime) ? readinessTime >= reportTime : true;
  const matchesLatestReport = Boolean(hasReport && hasReadiness && sameSource && sameTargetPages && freshEnough);
  const stale = Boolean(hasReadiness && hasReport && !matchesLatestReport);
  const reasons = [];
  if (stale && !sameSource) reasons.push("源文件不一致");
  if (stale && !sameTargetPages) reasons.push("目标页数不足");
  if (stale && !freshEnough) reasons.push("预检时间早于最新验收报告");
  return {
    latestReportJobId: latestJobId,
    latestReadinessJobId: readinessJobId,
    latestReportWrittenAt: latest?.writtenAt || "",
    latestReadinessEndedAt: readiness?.endedAt || readiness?.startedAt || "",
    matchesLatestReport,
    stale,
    reason: stale
      ? `产品级视觉预检已过期：${reasons.join("、") || "状态不匹配"}。请重新运行无费用产品视觉预检。`
      : ""
  };
}

function normalizeComparablePath(value = "") {
  return String(value || "").trim().replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
}

function pushUndo(job, label = "撤销上一步操作") {
  if (!job?.deck?.slides?.length) return;
  const snapshot = {
    label,
    createdAt: new Date().toISOString(),
    deck: JSON.parse(JSON.stringify(job.deck)),
    input: JSON.parse(JSON.stringify(job.input || {}))
  };
  job.undoStack = [...(job.undoStack || []), snapshot].slice(-10);
}

function applyOutlinePlan(baseRoutePlan, outlinePlan = null) {
  if (!outlinePlan || !Array.isArray(outlinePlan.layoutSequence) || !outlinePlan.layoutSequence.length) return baseRoutePlan;
  const layoutSequence = outlinePlan.layoutSequence.map((step, index) => ({
    ...step,
    index: index + 1,
    layout: cleanClientText(step.layout) || "section",
    title: cleanClientText(step.title) || "Slide " + (index + 1),
    purpose: cleanClientText(step.purpose) || cleanClientText(step.visualIntent) || "Generate content from confirmed outline",
    storyRole: cleanClientText(step.storyRole) || cleanClientText(step.kind) || "Content",
    kind: cleanClientText(step.kind) || cleanClientText(step.layout) || "section",
    imageSlots: Array.isArray(step.imageSlots) ? step.imageSlots.map(cleanClientText).filter(Boolean) : [],
    sourceType: cleanClientText(step.sourceType) || "inferred",
    sourceLabel: cleanClientText(step.sourceLabel) || "",
    evidence: cleanClientText(step.evidence) || "",
    needsConfirmation: Boolean(step.needsConfirmation)
  }));
  return {
    ...baseRoutePlan,
    ...outlinePlan,
    recommendedTheme: baseRoutePlan.recommendedTheme,
    templatePack: baseRoutePlan.templatePack,
    styleReferenceStrategy: baseRoutePlan.styleReferenceStrategy,
    aestheticPlan: baseRoutePlan.aestheticPlan,
    targetSlides: layoutSequence.length,
    layoutSequence,
    sections: layoutSequence.map((step) => ({ index: step.index, title: step.title, layout: step.layout, purpose: step.purpose, storyRole: step.storyRole })),
    storyArc: layoutSequence.map((step) => step.index + ". " + step.storyRole + ": " + step.title).join(" > "),
    routingReasons: [...(baseRoutePlan.routingReasons || []), "outlinePlan=confirmed"]
  };
}

function syncRoutePlanWithSlides(routePlan = null, slides = [], reason = "manual") {
  if (!routePlan?.layoutSequence?.length) return routePlan;
  const layoutSequence = slides.map((slide, index) => {
    const previous = routePlan.layoutSequence[index] || {};
    return {
      ...previous,
      index: index + 1,
      layout: slide.layout || previous.layout || "section",
      title: cleanClientText(slide.title) || previous.title || "Slide " + (index + 1),
      purpose: previous.purpose || cleanClientText(slide.visualIntent) || cleanClientText(slide.subtitle) || "Page adjusted manually",
      storyRole: cleanClientText(slide.storyRole) || previous.storyRole || "Manual adjustment",
      kind: previous.kind || slide.layout || "section",
      imageSlots: Array.isArray(slide.imageSlots) ? slide.imageSlots.map(cleanClientText).filter(Boolean) : previous.imageSlots || []
    };
  });
  return {
    ...routePlan,
    targetSlides: layoutSequence.length,
    layoutCount: layoutSequence.length,
    layoutSequence,
    sections: layoutSequence.map((step) => ({ index: step.index, title: step.title, layout: step.layout, purpose: step.purpose, storyRole: step.storyRole })),
    storyArc: layoutSequence.map((step) => step.index + ". " + step.storyRole + ": " + step.title).join(" -> "),
    routingReasons: [...(routePlan.routingReasons || []), "manual-slide-action=" + reason, "routePlan=synced-to-current-deck"]
  };
}

function getInsertedSlideDefaults(layout = "section") {
  const defaults = {
    cover: { title: "新增封面", subtitle: "补充项目标题和核心主张", storyRole: "开场定位", bullets: ["用一句话说明项目价值"], dataPoints: [], visualIntent: "用主标题和主视觉建立第一印象" },
    visual: { title: "新增视觉页", subtitle: "补充图片素材或视觉意图", storyRole: "视觉证据", bullets: ["说明这张图片想证明什么"], dataPoints: [], visualIntent: "优先放入产品图、包装图、截图或效果图" },
    section: { title: "新增章节", subtitle: "补充这一部分的结论", storyRole: "章节承接", bullets: ["在这里补充当前页要点"], dataPoints: [], visualIntent: "用简洁章节页承接前后内容" },
    toc: { title: "目录", subtitle: "补充阅读路径", storyRole: "阅读路径", bullets: ["第一部分", "第二部分", "第三部分"], dataPoints: [], visualIntent: "用列表说明整套 PPT 的结构" },
    kpi: { title: "关键指标", subtitle: "补充指标口径和数据来源", storyRole: "关键证据", bullets: ["指标一待补齐", "指标二待补齐", "指标三待补齐"], dataPoints: ["指标一", "指标二", "指标三"], visualIntent: "用大数字或指标卡展示关键信息" },
    pricing: { title: "价格梯度", subtitle: "补充报价、档位和主推理由", storyRole: "预算决策", bullets: ["入门档待补齐", "主推档待补齐", "升级档待补齐"], dataPoints: ["入门档", "主推档", "升级档"], visualIntent: "用价格卡说明不同预算选择" },
    "product-detail": { title: "产品详情", subtitle: "补充规格、卖点和适用场景", storyRole: "方案证据", bullets: ["规格待补齐", "卖点待补齐", "场景待补齐"], dataPoints: [], visualIntent: "用产品图和信息条展示单品信息" },
    bundle: { title: "组合推荐", subtitle: "补充不同场景下的推荐组合", storyRole: "推荐方案", bullets: ["入门组合", "主推组合", "升级组合"], dataPoints: [], visualIntent: "用三栏卡片表达组合推荐" },
    "risk-checklist": { title: "风险与待确认", subtitle: "补充需要人工确认的信息", storyRole: "风险控制", bullets: ["价格待确认", "规格待确认", "图片授权待确认"], dataPoints: [], visualIntent: "用清单结构呈现待确认项" },
    compare: { title: "方案对比", subtitle: "补充方案差异和推荐理由", storyRole: "差异证明", bullets: ["方案 A", "方案 B", "推荐理由"], dataPoints: [], visualIntent: "用左右对比说明差异" },
    timeline: { title: "推进路径", subtitle: "补充阶段、节奏和交付动作", storyRole: "落地路径", bullets: ["阶段一", "阶段二", "阶段三"], dataPoints: [], visualIntent: "用时间线展示推进步骤" },
    cards: { title: "核心要点", subtitle: "补充 3-5 个关键卖点或判断", storyRole: "卖点证明", bullets: ["要点一", "要点二", "要点三"], dataPoints: [], visualIntent: "用卡片拆分关键信息" },
    quote: { title: "核心话术", subtitle: "补充可直接复述的一句话", storyRole: "表达锚点", bullets: ["把这一页讲成一句清楚的话"], dataPoints: [], visualIntent: "用大标题强化记忆点" },
    closing: { title: "下一步行动", subtitle: "补充确认事项和交付动作", storyRole: "下一步行动", bullets: ["确认资料", "输出正式稿", "进入交付"], dataPoints: [], visualIntent: "用行动清单收束整套 PPT" }
  };
  return defaults[layout] || defaults.section;
}

function repairDeckForDelivery(deck = {}, routePlan = null, files = [], materialBrief = {}) {
  const slides = Array.isArray(deck.slides) ? deck.slides.map((slide) => ({ ...slide })) : [];
  const imageFiles = files
    .filter((file) => /^image\//.test(file.mimeType || "") || /\.(png|jpe?g|webp|svg)$/i.test(file.originalName || ""))
    .map((file) => cleanClientText(file.originalName || file.filename || "image"))
    .filter(Boolean);
  const changes = [];
  if (!slides.length) {
    slides.push(getInsertedSlideDefaults("cover"), getInsertedSlideDefaults("cards"), getInsertedSlideDefaults("closing"));
    changes.push("added-minimum-slides");
  }

  if (slides[0] && slides[0].layout !== "cover") {
    slides[0].layout = "cover";
    changes.push("fixed-cover");
  }
  if (slides.length > 1 && !["closing", "quote"].includes(slides.at(-1).layout)) {
    slides[slides.length - 1].layout = "closing";
    changes.push("fixed-closing");
  }

  const routeLayouts = routePlan?.layoutSequence?.map((step) => step.layout).filter(Boolean) || [];
  if (routeLayouts.length && slides.length !== routeLayouts.length) {
    while (slides.length > routeLayouts.length) {
      slides.splice(Math.max(1, slides.length - 2), 1);
      changes.push("trimmed-to-route-count");
    }
    while (slides.length < routeLayouts.length) {
      const insertAt = Math.max(1, slides.length - 1);
      const layout = routeLayouts[slides.length] || "section";
      slides.splice(insertAt, 0, getInsertedSlideDefaults(layout));
      changes.push("filled-route-count");
    }
  }
  if (routeLayouts.length === slides.length) {
    slides.forEach((slide, index) => {
      if (index > 0 && index < slides.length - 1 && routeLayouts[index] && slide.layout !== routeLayouts[index]) {
        slide.layout = routeLayouts[index];
        changes.push("aligned-route");
      }
    });
  }

  const layoutCycle = ["cards", "kpi", "compare", "timeline", "quote", "product-detail", "risk-checklist"];
  if (slides.length >= 5) {
    const used = new Set(slides.map((slide) => slide.layout));
    let cursor = 0;
    for (let index = 1; used.size < 3 && index < slides.length - 1; index += 1) {
      slides[index].layout = layoutCycle[cursor % layoutCycle.length];
      used.add(slides[index].layout);
      cursor += 1;
      changes.push("increased-layout-variety");
    }
  }

  for (let index = 2; index < slides.length; index += 1) {
    if (slides[index].layout === slides[index - 1].layout && slides[index].layout === slides[index - 2].layout) {
      slides[index - 1].layout = layoutCycle[index % layoutCycle.length];
      changes.push("broke-layout-repeat");
    }
  }

  slides.forEach((slide, index) => {
    slide.bullets = normalizeClientList(slide.bullets).slice(0, slide.layout === "pricing" ? 4 : 5);
    slide.dataPoints = normalizeClientList(slide.dataPoints).slice(0, 8);
    slide.imageSlots = normalizeImageSlotsForLayout(slide.layout, slide.imageSlots);
    if (!slide.title) {
      slide.title = index === 0 ? deck.title || "Project cover" : "Slide " + (index + 1);
      changes.push("filled-title");
    }
    if (!slide.storyRole) {
      slide.storyRole = slide.layout === "closing" ? "Next step" : slide.layout === "pricing" ? "Budget decision" : "Content";
      changes.push("filled-story-role");
    }
    if (!slide.visualIntent) {
      slide.visualIntent = slide.layout === "visual" ? "Use uploaded images or material slots as the main visual." : "Keep clear hierarchy and whitespace within the current template.";
      changes.push("filled-visual-intent");
    }
    if (!slide.speakerNotes) {
      slide.speakerNotes = "Explain the conclusion, evidence, and next action for: " + slide.title;
      changes.push("filled-speaker-notes");
    }
    if (slide.layout === "visual" && imageFiles.length && !slide.imageSlots.length) {
      slide.imageSlots = normalizeImageSlotsForLayout(slide.layout, imageFiles);
      changes.push("filled-image-slots");
    }
    if (slide.layout === "pricing") {
      const pricingText = [...slide.bullets, ...slide.dataPoints].join(" ");
      if (!/\d/.test(pricingText)) {
        slide.bullets = ["价格/报价待人工确认", ...slide.bullets].slice(0, 4);
        slide.contentSource = "待人工确认";
        changes.push("marked-pricing-confirmation");
      }
    }
    if ((materialBrief.confirmationFields || []).length && !slide.contentSource) {
      slide.contentSource = "用户输入 + 系统推断";
      changes.push("filled-content-source");
    }
  });

  const confirmationFields = materialBrief.confirmationFields || [];
  if (confirmationFields.length && !slides.some((slide) => slide.layout === "risk-checklist")) {
    const riskSlide = {
      ...getInsertedSlideDefaults("risk-checklist"),
      title: "待确认事项清单",
      bullets: confirmationFields.slice(0, 6),
      contentSource: "待人工确认",
      speakerNotes: "这里集中说明还不能被当作最终结论的信息，避免伪造价格、规格、库存或品牌承诺。"
    };
    const targetCount = Number(routePlan?.targetSlides || routePlan?.layoutSequence?.length || 0);
    if (!targetCount || slides.length < targetCount) {
      const insertAt = Math.max(1, slides.length - 1);
      slides.splice(insertAt, 0, riskSlide);
      changes.push("added-risk-checklist");
    } else {
      changes.push("kept-source-pages-over-risk-insert");
    }
  }

  return {
    deck: {
      ...deck,
      slides,
      summary: cleanClientText(deck.summary) || "已完成交付自检修复"
    },
    summary: {
      changes: [...new Set(changes)],
      slideCount: slides.length,
      imageSlots: slides.reduce((sum, slide) => sum + normalizeClientList(slide.imageSlots).length, 0)
    }
  };
}

function rewriteDeckLocally(deck = {}, instruction = "") {
  const text = instruction.toLowerCase();
  const reduceText = /少字|减字|减少文字|精简|简洁|高级|克制|不要堆字/i.test(instruction);
  const salesTone = /销售|成交|战卡|话术|主推/i.test(instruction);
  const clientTone = /客户|提案|对外|沟通|client|proposal|external|customer/i.test(instruction);
  const premiumTone = /高级|克制|画册|品牌|质感/i.test(instruction);
  const actionTone = /下一步|行动|落地|推进|交付/i.test(instruction);
  const techTone = /技术|数据|指标|kpi|分析/i.test(text);
  const slides = (deck.slides || []).map((slide, index, all) => {
    const next = { ...slide };
    if (reduceText) next.bullets = (next.bullets || []).slice(0, next.layout === "pricing" ? 3 : 2).map(shortenBullet);
    if (salesTone) {
      next.title = salesTitleForDeck(next.title, next.layout);
      next.speakerNotes = salesNotesForSlide(next);
      if (next.layout === "section" && index > 0) next.layout = "cards";
    }
    if (clientTone) {
      next.subtitle = next.subtitle || "面向客户沟通的清晰版本";
      next.contentSource = next.contentSource || "用户资料";
      next.speakerNotes = clientNotesForSlide(next);
    }
    if (premiumTone) {
      next.title = shortenTitle(next.title);
      next.bullets = (next.bullets || []).slice(0, 3).map(shortenBullet);
      if (["cards", "section"].includes(next.layout) && index > 0 && index < all.length - 1) next.layout = "quote";
    }
    if (techTone && ["cards", "section"].includes(next.layout) && index > 0 && index < all.length - 1) {
      next.layout = index % 2 ? "kpi" : "compare";
      next.dataPoints = next.dataPoints?.length ? next.dataPoints : (next.bullets || []).slice(0, 3);
    }
    if (actionTone && index === all.length - 1) {
      next.layout = "closing";
      next.title = "下一步行动";
      next.bullets = ["确认最终资料和报价", "补齐图片、规格和交期", "输出客户版 PPTX", "收集反馈继续迭代"];
      next.speakerNotes = "收尾时直接落到行动：谁确认、补什么、什么时候给下一版。";
    }
    next.visualIntent = next.visualIntent || "根据整份改写指令优化表达和页面结构。";
    return next;
  });
  return {
    ...deck,
    summary: appendRewriteSummary(deck.summary, instruction),
    slides
  };
}

function appendRewriteSummary(summary = "", instruction = "") {
  const base = cleanClientText(summary);
  const note = "Batch rewrite: " + instruction;
  return base.includes(note) ? base : [base, note].filter(Boolean).join("; ").slice(0, 180);
}

function shortenTitle(title = "") {
  return cleanClientText(title).replace(/^(about|for|based on)/i, "").slice(0, 24) || "Core Point";
}

function shortenBullet(value = "") {
  const text = cleanClientText(value).replace(/^(first|second|therefore|so)[:\uFF1A\s]*/i, "");
  return text.length > 24 ? text.slice(0, 24) + "..." : text;
}

function salesTitleForDeck(title = "", layout = "") {
  const clean = shortenTitle(title);
  if (layout === "pricing") return "Price Tiers and Recommendation";
  if (layout === "quote") return "Client-Ready Message";
  if (layout === "risk-checklist") return "Before-Deal Checklist";
  if (/recommend|deal|price|action/i.test(clean)) return clean;
  return clean + ": Recommendation";
}

function salesNotesForSlide(slide = {}) {
  const first = (slide.bullets || [])[0] || slide.subtitle || slide.title;
  return "Lead with the conclusion, then explain why the client should choose it: " + first;
}

function clientNotesForSlide(slide = {}) {
  const first = (slide.bullets || [])[0] || slide.title;
  return "When presenting this slide to the client, avoid internal jargon and state the value and evidence directly: " + first;
}

function normalizeClientList(value) {
  if (Array.isArray(value)) return value.map(cleanClientText).filter(Boolean);
  return String(value || "")
    .split(/\r?\n|[; "]/)
    .map(cleanClientText)
    .filter(Boolean);
}

function normalizeCanvasEdits(value = {}) {
  if (!value || typeof value !== "object") return null;
  const result = {};
  for (const key of Object.keys(value)) {
    if (!isAllowedCanvasEditKey(key)) continue;
    const box = value[key]?.box;
    if (!box || typeof box !== "object") continue;
    const type = normalizeCanvasEditType(value[key]?.type, key);
    const next = {
      type,
      box: {
        x: clampNumber(box.x, 0, 96),
        y: clampNumber(box.y, 0, 96),
        w: clampNumber(box.w, 4, 96),
        h: clampNumber(box.h, 3, 96)
      }
    };
    if (type === "text" && value[key]?.style && typeof value[key].style === "object") {
      next.style = normalizeCanvasTextStyleForSave(value[key].style);
    }
    if (type === "image") {
      next.fit = ["contain", "cover"].includes(value[key]?.fit) ? value[key].fit : "contain";
      next.opacity = clampNumber(value[key]?.opacity ?? 1, 0.15, 1);
    }
    if (type === "shape") {
      next.fill = normalizeHexForSave(value[key]?.fill, "#eef3ff");
      next.line = normalizeHexForSave(value[key]?.line, next.fill);
      next.radius = clampNumber(value[key]?.radius ?? 0, 0, 24);
      next.opacity = clampNumber(value[key]?.opacity ?? 1, 0.1, 1);
    }
    result[key] = next;
  }
  return Object.keys(result).length ? result : null;
}

function isAllowedCanvasEditKey(key = "") {
  return ["title", "subtitle", "bullets", "visualIntent", "speakerNotes"].includes(key)
    || /^bullet_\d{1,2}$/.test(key)
    || /^data_\d{1,2}$/.test(key)
    || /^asset_\d{1,2}$/.test(key)
    || /^shape_\d{1,2}$/.test(key);
}

function normalizeCanvasEditType(type = "", key = "") {
  if (type === "image" || /^asset_\d+/.test(key)) return "image";
  if (type === "shape" || /^shape_\d+/.test(key)) return "shape";
  return "text";
}

function normalizeCanvasTextStyleForSave(style = {}) {
  const color = normalizeHexForSave(style.color, "#263238");
  return {
    fontSize: clampNumber(style.fontSize, 6, 72),
    fontWeight: String(style.fontWeight || "400"),
    color,
    textAlign: ["left", "center", "right"].includes(style.textAlign) ? style.textAlign : "left",
    lineHeight: clampNumber(style.lineHeight, 1, 2.4),
    letterSpacing: clampNumber(style.letterSpacing, 0, 8)
  };
}

function normalizeHexForSave(value, fallback = "#263238") {
  const color = String(value || "").trim();
  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  if (/^[0-9a-f]{6}$/i.test(color)) return `#${color}`;
  return fallback;
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function decodeMaybeMojibake(value = "") {
  const candidates = [
    String(value),
    Buffer.from(String(value), "latin1").toString("utf8")
  ];
  return candidates.sort((a, b) => scoreDecodedName(b) - scoreDecodedName(a))[0];
}

function scoreDecodedName(value) {
  let score = 0;
  if (/[\u4e00-\u9fa5]/.test(value)) score += 4;
  if (/[a-z0-9]/i.test(value)) score += 1;
  if (/[脙脗芒陇氓莽]/.test(value)) score -= 3;
  if (/[锟�]/.test(value)) score -= 8;
  return score;
}

function repairPreviewImages(job, options = {}) {
  const pngDir = path.join(outputDir, job.id, "exports", "png");
  if (!fsSync.existsSync(pngDir)) return [];
  return fsSync.readdirSync(pngDir)
    .filter((name) => name.toLowerCase().endsWith(".png"))
    .sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }))
    .map((name) => {
      const file = path.join(pngDir, name);
      const version = options.cacheBust ? "?v=" + Math.round(fsSync.statSync(file).mtimeMs) : "";
      return "/outputs/" + [job.id, "exports", "png", name].map(encodeURIComponent).join("/") + version;
    });
}

async function readEnvFile() {
  try {
    return parseEnv(await fs.readFile(envPath, "utf8"));
  } catch {
    return {};
  }
}

async function writeEnvFile(values) {
  const existing = await readEnvFile();
  const merged = { ...existing, ...values };
  const orderedKeys = [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_MODEL",
    "OPENAI_IMAGE_MODEL",
    "PROVIDER_TIMEOUT_MS",
    "PROVIDER_MAX_RETRIES",
    "PROVIDER_CONCURRENCY",
    "OCR_PROVIDER",
    "OCR_PYTHON_PATH",
    "PORT"
  ];
  const lines = orderedKeys.map((key) => key + "=" + formatEnvValue(merged[key] || ""));
  const rest = Object.keys(merged)
    .filter((key) => !orderedKeys.includes(key))
    .sort()
    .map((key) => key + "=" + formatEnvValue(merged[key] || ""));
  await fs.writeFile(envPath, [...lines, ...rest].join("\n") + "\n", "utf8");
}

function parseEnv(text = "") {
  const result = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function formatEnvValue(value) {
  const text = String(value || "");
  return /[\s#"'\\]/.test(text) ? JSON.stringify(text) : text;
}

function normalizeBaseUrl(value) {
  return String(value || "https://api.openai.com/v1").trim().replace(/\/$/, "");
}

async function fetchOpenAiCompatible(baseUrl, endpoint, options) {
  const errors = [];
  for (const candidate of getCompatibleBaseUrls(baseUrl)) {
    const url = candidate + endpoint;
    try {
      const response = await fetch(url, options);
      if (response.ok && isJsonResponse(response)) return { response, url };
      errors.push({ response, url });
      if (response.ok || ![404, 405].includes(response.status)) continue;
    } catch (error) {
      errors.push({ error, url });
    }
  }
  const last = errors.at(-1);
  if (last?.response) return last;
  throw new Error(last?.error?.message || "连接失败，请检查 Base URL。");
}

function getCompatibleBaseUrls(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  const candidates = [normalized];
  if (!/\/v\d+(\/|$)/.test(normalized)) candidates.push(normalized + "/v1");
  return [...new Set(candidates)];
}

function stripEndpoint(url, endpoint) {
  return String(url || "").endsWith(endpoint) ? String(url).slice(0, -endpoint.length) : normalizeBaseUrl(url);
}

function isJsonResponse(response) {
  return /application\/json/i.test(response.headers.get("content-type") || "");
}

async function readProviderError(response) {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  if (/application\/json/i.test(contentType)) {
    try {
      const data = JSON.parse(text);
      return data.error?.message || data.message || text.slice(0, 280);
    } catch {
      return text.slice(0, 280);
    }
  }
  if (/^\s*</.test(text)) {
    return "服务返回了网页而不是 JSON。请检查 Base URL，OpenAI 兼容服务通常需要以 /v1 结尾。";
  }
  return text.slice(0, 280);
}

function maskSecret(value = "") {
  if (!value) return "";
  if (value.length <= 10) return "已配置";
  return value.slice(0, 5) + "..." + value.slice(-4);
}
