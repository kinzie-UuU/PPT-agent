import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fsSync from "fs";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import { addStyleGroup, addStyleReference, addUpload, deleteJob, deleteStyleGroup, deleteStyleReference, deleteUpload, ensureDirs, getJob, getUploads, listJobs, listStyleGroups, listStyleReferences, makeId, outputDir, rootDir, saveJob, updateStyleReference, uploadDir } from "./store.js";
import { buildDeck, exportWithPowerPoint, extractPptxImages, extractText, renderPptxPreview } from "./ppt.js";
import { generateDeckPlan, reviseSlide } from "./ai.js";
import { validateDeck } from "./validateDeck.js";
import { getDesignSystem } from "./designSystem.js";
import { buildMaterialBrief } from "./materialBrief.js";
import { routeDeck } from "./deckRouter.js";
import { addEvent, makeEvent } from "./events.js";
import { reviewDeckVisuals } from "./visualReview.js";
import { checkLocalImageStatus, generateLocalImage } from "./localImage.js";
import { analyzeGeneratedImage } from "./imageQa.js";
import { analyzePptxAesthetic, compactAestheticReport } from "./pptAesthetic.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(globalThis.process?.env?.PORT || 4180);
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

await ensureDirs();
app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use("/outputs", express.static(outputDir));
app.use("/uploads", express.static(uploadDir));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    status: "online",
    version: appVersion,
    pid: globalThis.process?.pid || null,
    port,
    uptime: globalThis.process?.uptime ? Math.round(globalThis.process.uptime()) : null,
    startedAt: serverStartedAt.toISOString(),
    rootDir,
    hasApiKey: Boolean(globalThis.process?.env?.OPENAI_API_KEY),
    model: globalThis.process?.env?.OPENAI_MODEL || "gpt-4.1-mini",
    time: new Date().toISOString()
  });
});

app.get("/api/config", (_req, res) => {
  const env = globalThis.process?.env || {};
  res.json({
    hasApiKey: Boolean(env.OPENAI_API_KEY),
    maskedApiKey: maskSecret(env.OPENAI_API_KEY),
    baseUrl: env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    model: env.OPENAI_MODEL || "gpt-4.1-mini"
  });
});

app.post("/api/config", async (req, res, next) => {
  try {
    const current = await readEnvFile();
    const nextConfig = {
      OPENAI_API_KEY: typeof req.body.apiKey === "string" && req.body.apiKey.trim() ? req.body.apiKey.trim() : current.OPENAI_API_KEY || "",
      OPENAI_BASE_URL: normalizeBaseUrl(req.body.baseUrl || current.OPENAI_BASE_URL || "https://api.openai.com/v1"),
      OPENAI_MODEL: String(req.body.model || current.OPENAI_MODEL || "gpt-4.1-mini").trim(),
      PORT: current.PORT || String(port)
    };
    await writeEnvFile(nextConfig);
    Object.assign(globalThis.process.env, nextConfig);
    res.json({
      ok: true,
      hasApiKey: Boolean(nextConfig.OPENAI_API_KEY),
      maskedApiKey: maskSecret(nextConfig.OPENAI_API_KEY),
      baseUrl: nextConfig.OPENAI_BASE_URL,
      model: nextConfig.OPENAI_MODEL
    });
  } catch (error) {
    next(error);
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
    const response = await fetchOpenAiCompatible(baseUrl, "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 8, temperature: 0 })
    });
    if (!response.response.ok) {
      const message = await readProviderError(response.response);
      res.status(400).json({ ok: false, error: message || `HTTP ${response.response.status}` });
      return;
    }
    res.json({
      ok: true,
      message: `API 连接成功，使用地址：${response.url}`,
      usedBaseUrl: stripEndpoint(response.url, "/chat/completions")
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
    const response = await fetchOpenAiCompatible(baseUrl, "/models", {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!response.response.ok) {
      const message = await readProviderError(response.response);
      res.status(400).json({ ok: false, error: message || `HTTP ${response.response.status}` });
      return;
    }
    const data = await response.response.json();
    const models = (data.data || [])
      .map((item) => item.id)
      .filter(Boolean)
      .filter((id) => !/embedding|audio|tts|whisper|image|moderation|realtime|transcribe/i.test(id))
      .sort((a, b) => a.localeCompare(b));
    res.json({
      ok: true,
      models,
      usedBaseUrl: stripEndpoint(response.url, "/models")
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "模型列表获取失败。" });
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
    res.json({ files: records });
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
    if (!updated) return res.status(404).json({ error: "风格参考图不存在" });
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

app.get("/api/style-groups", async (_req, res, next) => {
  try {
    const groups = await listStyleGroups();
    res.json({ groups: groups.map(normalizeStyleGroup) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/style-groups", async (req, res, next) => {
  try {
    const group = await addStyleGroup(req.body || {});
    res.json({ group: normalizeStyleGroup(group) });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/style-groups/:id", async (req, res, next) => {
  try {
    const deleted = await deleteStyleGroup(req.params.id);
    if (!deleted) return res.status(404).json({ error: "自定义风格库不存在" });
    res.json({ ok: true, deleted: normalizeStyleGroup(deleted) });
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
  return makeEvent("aesthetic-diagnosis", `旧稿美学诊断：${diagnosis.overallScore ?? "-"} 分 / 低分页 ${(diagnosis.lowScoreSlides || []).length} 页`, {
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
      extracted.push({ name: file.originalName, text: `资料抽取失败：${error.message}` });
    }
  }
  const materialBrief = buildMaterialBrief([
    ...extracted,
    {
      name: "输入说明",
      text: [
        req.body.projectName ? `项目名称：${req.body.projectName}` : "",
        req.body.audience ? `目标对象：${req.body.audience}` : "",
        req.body.copyMode ? `生成类型：${req.body.copyMode}` : "",
        req.body.notes ? `补充说明：${req.body.notes}` : "",
        Array.isArray(req.body.materials) && req.body.materials.length ? `资料类型：${req.body.materials.join("、")}` : ""
      ].filter(Boolean).join("\n")
    }
  ]);
  materialBrief.preferences = {
    primaryProduct: req.body.primaryProduct || "",
    includeToc: req.body.includeToc !== false,
    includeRiskChecklist: req.body.includeRiskChecklist !== false
  };
  attachSourceRecognitionReport(materialBrief, uploads);
  const baseRoutePlan = routeDeck({ mode, input: { ...req.body, styleReferences }, materialBrief, uploads });
  const routePlan = applyOutlinePlan(baseRoutePlan, req.body.outlinePlan);
  const input = { ...req.body, extracted, materialBrief, routePlan, styleReferences: styleReferences.map(compactStyleReference) };
  if (false && materialBrief.sourceReport?.aestheticDiagnosis) {
    const diagnosis = materialBrief.sourceReport.aestheticDiagnosis;
    recordStep?.("aesthetic-diagnosis", "旧稿美学诊断", "done", `${diagnosis.overallScore ?? "-"} 分 / 低分页 ${(diagnosis.lowScoreSlides || []).length} 页`, {
      overallScore: diagnosis.overallScore,
      lowScoreSlides: diagnosis.lowScoreSlides || [],
      highDensitySlides: diagnosis.highDensitySlides || []
    });
  }
  const ai = await generateDeckPlan(input, mode);
  let validated = validateDeck(ai.deck, routePlan);
  const imageBinding = applySourceImageSlots(validated.deck, routePlan, uploads);
  if (imageBinding.report.changedSlides) validated = validateDeck(imageBinding.deck, routePlan);
  materialBrief.imageSlotReport = imageBinding.report;
  const events = [
    makeEvent("route", `智能路由：${routePlan.deckType} / ${routePlan.targetSlides} 页 / ${routePlan.layoutSequence.map((step) => step.layout).join(" > ")}`, {
      deckType: routePlan.deckType,
      targetSlides: routePlan.targetSlides,
      layoutSequence: routePlan.layoutSequence.map((step) => step.layout),
      reasons: routePlan.routingReasons
    }),
    makeEvent("upload", `读取 ${uploads.length} 个上传文件`, { files: uploads.map((file) => file.originalName) }),
    makeEvent("extract", materialBrief.summary || "资料已抽取", { inputStrength: materialBrief.inputStrength, charCount: materialBrief.charCount, pageCount: materialBrief.pageCount, confirmationFields: materialBrief.confirmationFields }),
    makeEvent(ai.aiUsed ? "ai" : "fallback", ai.aiUsed ? `已使用 AI 生成设计计划：${ai.provider?.model || "unknown"}` : "未使用 AI，已采用本地资料驱动 fallback", { warning: ai.warning || null, provider: ai.provider || null }),
    makeEvent("validate", `校验完成，${validated.warnings.length} 个提示`, { warnings: validated.warnings }),
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
    warning: [ai.warning, ...validated.warnings].filter(Boolean).join("；") || null,
    files: uploads,
    exports: {},
    previewImages: [],
    events,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  job.exports.pptx = await buildDeck(job);
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
      extracted.push({ name: file.originalName, text: `资料抽取失败：${error.message}` });
    }
  }
  const materialBrief = buildMaterialBrief([
    ...extracted,
    {
      name: "输入说明",
      text: [
        req.body.projectName ? `项目名称：${req.body.projectName}` : "",
        req.body.audience ? `目标对象：${req.body.audience}` : "",
        req.body.copyMode ? `生成类型：${req.body.copyMode}` : "",
        req.body.notes ? `补充说明：${req.body.notes}` : "",
        Array.isArray(req.body.materials) && req.body.materials.length ? `资料类型：${req.body.materials.join("、")}` : ""
      ].filter(Boolean).join("\n")
    }
  ]);
  materialBrief.preferences = {
    primaryProduct: req.body.primaryProduct || "",
    includeToc: req.body.includeToc !== false,
    includeRiskChecklist: req.body.includeRiskChecklist !== false
  };
  attachSourceRecognitionReport(materialBrief, uploads);
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

  recordStep("intent", "识别任务意图", "done", mode === "optimize" ? "优化旧 PPT" : "生成新 PPT");
  recordStep("extract", "读取资料", "running", "正在抽取上传资料和用户需求");
  const { uploads, materialBrief, routePlan, input } = await buildAgentContext(req, mode);
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

  recordStep("route", "规划页面路线", "done", `${routePlan.deckType} / ${routePlan.targetSlides} 页`, {
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

  recordStep("validate", "交付自检", "done", `${validated.deck.slides?.length || 0} 页 / ${validated.warnings.length} 条提示`);
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
    agentSteps[agentSteps.length - 1] = { ...agentSteps[agentSteps.length - 1], status: "done", summary: `已自动修复 ${fix.changes.length || 1} 类问题`, details: fix };
  } else {
    recordStep("repair", "自动修复", "skipped", "未发现需要自动修复的阻断问题");
  }

  const events = [
    makeEvent("route", `智能路由：${routePlan.deckType} / ${routePlan.targetSlides} 页 / ${routePlan.layoutSequence.map((step) => step.layout).join(" > ")}`, {
      deckType: routePlan.deckType,
      targetSlides: routePlan.targetSlides,
      layoutSequence: routePlan.layoutSequence.map((step) => step.layout),
      reasons: routePlan.routingReasons
    }),
    makeEvent("upload", `读取 ${uploads.length} 个上传文件`, { files: uploads.map((file) => file.originalName) }),
    makeEvent("extract", materialBrief.summary || "资料已抽取", { inputStrength: materialBrief.inputStrength, charCount: materialBrief.charCount, pageCount: materialBrief.pageCount, confirmationFields: materialBrief.confirmationFields }),
    makeEvent("agent", `Agent 计划：${agentDecision.intent} / ${agentDecision.autonomy}`, { agentPlan, agentDecision }),
    ...(styleProofConfirmation ? [makeEvent("style-confirmed", `已继承确认样稿：${styleProofConfirmation.title || styleProofConfirmation.id}`, styleProofConfirmation)] : []),
    ...(agentFixes.length ? [makeEvent("agent-repair", "Agent 已自动修复 1 轮", agentFixes[0])] : []),
    makeEvent(ai.aiUsed ? "ai" : "fallback", ai.aiUsed ? `已使用 AI 生成设计计划：${ai.provider?.model || "unknown"}` : "未使用 AI，已采用本地资料驱动 fallback", { warning: ai.warning || null, provider: ai.provider || null }),
    makeEvent("validate", `校验完成：${validated.warnings.length} 条提示`, { warnings: validated.warnings }),
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
    warning: [ai.warning, ...validated.warnings].filter(Boolean).join("；") || null,
    files: uploads,
    exports: {},
    previewImages: [],
    events,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  recordStep("render", "生成 PPTX", "running", "正在生成 PPTX 文件");
  job.exports.pptx = await buildDeck(job);
  job.exportMeta = collectExportMeta(job.exports);
  agentSteps[agentSteps.length - 1] = { ...agentSteps[agentSteps.length - 1], status: "done", summary: "PPTX 已生成", details: { pptx: job.exports.pptx } };
  addEvent(job, "rendered", "PPTX 已生成", { pptx: job.exports.pptx });
  recordStep("preview", "刷新预览", "running", "正在生成预览图");
  await refreshPreview(job, "已生成");
  const cloudVisualReview = await reviewDeckVisuals({ stage: "final-deck", deck: job.deck, quality: job.quality, routePlan, materialBrief, previewImages: job.previewImages || [] });
  addEvent(job, "cloud-visual-review", cloudVisualReview.used ? `云端视觉复审：${cloudVisualReview.status}` : `云端视觉复审跳过：${cloudVisualReview.reason || "not available"}`, cloudVisualReview);
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
      job.warning = [ai.warning, ...repairedValidation.warnings].filter(Boolean).join("；") || null;
      job.exports.pptx = await buildDeck(job);
      job.exportMeta = collectExportMeta(job.exports);
      addEvent(job, "visual-auto-repair", "整稿已按云端视觉复审自动修复 1 轮", repair.summary);
      await refreshPreview(job, "整稿已自动修复");
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
      addEvent(job, "cloud-visual-review", repairedCloudVisualReview.used ? `整稿修复后云端视觉复审：${repairedCloudVisualReview.status}` : `整稿修复后云端视觉复审跳过：${repairedCloudVisualReview.reason || "not available"}`, repairedCloudVisualReview);
    }
  }
  const finalAssessment = classifyAgentQuality(job.deck, job.quality, routePlan, materialBrief, job.previewImages || []);
  const finalReview = buildAgentReview("final-deck", job.deck, job.quality, routePlan, materialBrief, uploads, job.previewImages || [], latestCloudVisualReview);
  job.imageSupplementPlan = buildImageSupplementPlan({ deck: job.deck, routePlan, materialBrief, files: uploads, cloudReviews: job.cloudReviews || [], visualFixes: job.visualFixes || [] });
  if (job.imageSupplementPlan?.needed) addEvent(job, "image-supplement-plan", "视觉复审后生成补图/复用原图计划", job.imageSupplementPlan);
  agentSteps[agentSteps.length - 1] = { ...agentSteps[agentSteps.length - 1], status: "done", summary: `${(job.previewImages || []).filter(Boolean).length} 张预览图`, details: { ...finalAssessment, cloudVisualReview: latestCloudVisualReview, visualFixes: job.visualFixes || [] } };
  job.agentSteps = agentSteps;
  job.agentReviews = [...(job.agentReviews || []), finalReview];
  job.agentDecision = { ...agentDecision, finalAssessment, autoRepaired: agentFixes.length > 0 || Boolean(job.visualFixes?.length) };
  job.agentFinishedAt = new Date().toISOString();
  if (finalAssessment.blocking.length) {
    job.warning = [job.warning, `Agent 自检仍有阻断问题：${finalAssessment.blocking.join("；")}`].filter(Boolean).join("；");
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
    title: `${validated.deck.title || input.projectName || "PPT"} 风格样张`,
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
    warning: [ai.warning, ...proofValidation.warnings].filter(Boolean).join("；") || null,
    files: uploads,
    exports: {},
    previewImages: [],
    agentReviews: [proofReview],
    events: [
      makeEvent("agent-review", "样稿已完成多 Agent 复审", proofReview),
      makeEvent("style-preview", `风格样张：${input.style || routePlan.recommendedTheme || ""} / ${proofSlides.length} 页`, {
        style: input.style || routePlan.recommendedTheme,
        sourceSlides: proofSlides.map((slide) => slide.title),
        styleReferences: routePlan.styleReferenceStrategy?.count || 0
      }),
      makeEvent(ai.aiUsed ? "ai" : "fallback", ai.aiUsed ? `已使用 AI 生成风格样张：${ai.provider?.model || "unknown"}` : "已使用本地 fallback 生成风格样张", { provider: ai.provider || null })
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  job.exports.pptx = await buildDeck(job);
  job.exportMeta = collectExportMeta(job.exports);
  addEvent(job, "rendered", "风格样张 PPTX 已生成", { pptx: job.exports.pptx });
  await refreshPreview(job, "风格样张已生成");
  const cloudVisualReview = await reviewDeckVisuals({ stage: "style-preview", deck: job.deck, quality: job.quality, routePlan: proofRoutePlan, materialBrief, previewImages: job.previewImages || [] });
  job.cloudReviews = [cloudVisualReview];
  addEvent(job, "cloud-visual-review", cloudVisualReview.used ? `云端视觉复审：${cloudVisualReview.status}` : `云端视觉复审跳过：${cloudVisualReview.reason || "not available"}`, cloudVisualReview);
  if (shouldRepairVisualReview(cloudVisualReview)) {
    const beforeReview = cloudVisualReview;
    const repair = repairStyleProofForVisualReview(job.deck, proofRoutePlan, materialBrief, uploads, cloudVisualReview);
    let repairedValidation = validateDeck(repair.deck, proofRoutePlan);
    const repairedImageBinding = applySourceImageSlots(repairedValidation.deck, routePlan, uploads);
    if (repairedImageBinding.report.changedSlides) repairedValidation = validateDeck(repairedImageBinding.deck, proofRoutePlan);
    materialBrief.imageSlotReport = repairedImageBinding.report;
    job.deck = repairedValidation.deck;
    job.quality = enrichQuality(repairedValidation.quality, uploads, materialBrief, proofRoutePlan);
    job.warning = [ai.warning, ...repairedValidation.warnings].filter(Boolean).join("；") || null;
    job.exports.pptx = await buildDeck(job);
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
  const latestCloudReview = job.cloudReviews.at(-1) || cloudVisualReview;
  job.imageSupplementPlan = buildImageSupplementPlan({ deck: job.deck, routePlan: proofRoutePlan, materialBrief, files: uploads, cloudReviews: job.cloudReviews || [], visualFixes: job.visualFixes || [] });
  if (job.imageSupplementPlan?.needed) addEvent(job, "image-supplement-plan", "样稿视觉复审后生成补图/复用原图计划", job.imageSupplementPlan);
  job.agentReviews = [buildAgentReview("style-preview", job.deck, job.quality, proofRoutePlan, materialBrief, uploads, job.previewImages || [], latestCloudReview)];
  await saveJob(job);
  res.json(toClientJob(job));
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
    storyRole: slide.storyRole || "风格确认样张",
    imageSlots: (slide.imageSlots && slide.imageSlots.length ? slide.imageSlots : imageNames.slice(index, index + 2)).filter(Boolean)
  }));
  if (imageNames.length && !proof.some((slide) => slide.layout === "visual")) {
    proof.splice(Math.min(1, proof.length), 0, {
      layout: "visual",
      title: routePlan.deckType ? `${routePlan.deckType}视觉调性` : "视觉调性样张",
      subtitle: "确认图片呈现、留白、色彩和标题层级。",
      storyRole: "风格确认样张",
      contentSource: "用户图片",
      visualIntent: "使用原 PPT 或上传素材验证图片展示方式。",
      bullets: ["保留原图主体", "控制文字密度", "统一东方自然风调性"],
      dataPoints: [],
      imageSlots: imageNames.slice(0, 3),
      speakerNotes: "这一页用于确认整套 PPT 的图片处理方式。"
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
  const needsStrongerStyle = /风格|东方|自然|节日|礼盒|文化|色彩|太素|识别不足|不像/.test(reviewText);
  const needsImageRepair = /占位|缺图|图片|产品|原图|灰白|纯色块/.test(reviewText);
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
        styleFingerprint.prompt ? `按风格指纹强化：${styleFingerprint.prompt}` : "",
        "避免通用灰白占位感，增加东方自然、节日礼盒、文化产品的识别度。"
      ].filter(Boolean).join(" ");
      next.speakerNotes = [
        cleanClientText(next.speakerNotes),
        "这一页要证明风格方向，而不是只呈现普通商务模板。"
      ].filter(Boolean).join(" ");
      if (index === 0) next.subtitle = `${next.subtitle || ""}｜东方自然风修正版`.replace(/^｜/, "");
    }
    if (needsImageRepair && next.imageSlots.length) {
      next.bullets = uniqueTextList([
        ...(next.bullets || []),
        "优先使用原稿产品图，减少占位感。",
        "让图片承担案例和产品信息，而不是只做装饰。"
      ]).slice(0, 4);
    }
    if (needsImageRepair && index === slidesVisualRepairIndex(deck.slides || [])) {
      next.layout = "visual";
      next.title = next.title || "原稿产品视觉样张";
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
  const needsStrongerStyle = /风格|东方|自然|节日|礼盒|文化|色彩|太素|识别不足|不像|匹配不足|不够强|调性/i.test(reviewText);
  const needsImageRepair = /占位|缺图|图片|产品图|原图|主视觉|视觉|纯色块|素材|说服力/i.test(reviewText);
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
      imageSlots: normalizeClientList(slide.imageSlots)
    };
    const sourcePage = inferSourcePage(routeStep, slide, index);
    const pageImages = sourcePage ? sourceImagesByPage.get(sourcePage) || [] : [];
    const fallbackPage = sourcePages.find((page) => Number(page.imageCount || 0) > 0 && Number(page.page || 0) !== sourcePage);
    const fallbackImages = fallbackPage ? sourceImagesByPage.get(Number(fallbackPage.page)) || [] : [];
    const preferredImages = chooseVisualSourceImages(pageImages, files, slide, routeStep)
      .concat(chooseVisualSourceImages(fallbackImages, files, slide, routeStep))
      .map((file) => cleanClientText(file.originalName || path.basename(file.path || "")))
      .filter(Boolean);
    const shouldCarryImage = ["cover", "visual", "product-detail", "bundle", "cards"].includes(next.layout || routeStep.layout)
      || /图|视觉|产品|包装|礼盒|案例|主视觉/i.test([next.title, next.subtitle, next.visualIntent, routeStep.purpose].join(" "));
    if (needsImageRepair && shouldCarryImage) {
      const nextSlots = uniqueTextList([...preferredImages, ...next.imageSlots, ...allImageNames]).slice(0, next.layout === "cover" ? 2 : 4);
      if (nextSlots.length && nextSlots.join("|") !== next.imageSlots.join("|")) {
        next.imageSlots = nextSlots;
        changes.push("strengthened-source-image-use");
      }
      if (!["cover", "closing", "pricing"].includes(next.layout) && next.imageSlots.length && !["visual", "product-detail", "bundle", "cards"].includes(next.layout)) {
        next.layout = index <= 1 ? "visual" : "product-detail";
        changes.push("converted-to-image-led-layout");
      }
    }
    if (needsStrongerStyle) {
      next.visualIntent = uniqueTextList([
        cleanClientText(next.visualIntent),
        styleFingerprint.prompt ? `按已确认风格指纹强化：${styleFingerprint.prompt}` : "",
        routePlan?.recommendedTheme ? `保持 ${routePlan.recommendedTheme} 的色彩、留白、质感和装饰节奏。` : "",
        "避免通用灰白商务模板感，让背景、图片和小装饰共同承担风格识别。"
      ]).join(" ");
      next.speakerNotes = uniqueTextList([
        cleanClientText(next.speakerNotes),
        "这一页要同时保留原始事实，并强化已确认样稿的视觉调性。"
      ]).join(" ");
      if (index === 0 && routePlan?.recommendedTheme && !String(next.subtitle || "").includes(routePlan.recommendedTheme)) {
        next.subtitle = [cleanClientText(next.subtitle), routePlan.recommendedTheme].filter(Boolean).join("｜");
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
    deck: { ...imagePlanResult.deck, slides, summary: cleanClientText(imagePlanResult.deck.summary) || cleanClientText(deck.summary) || "已按整稿视觉复审修复。" },
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
  const sourceImagesByPage = files.filter(isImageUpload).reduce((map, file) => {
    const page = Number(file.sourceSlide || 0);
    if (!page) return map;
    if (!map.has(page)) map.set(page, []);
    map.get(page).push(file);
    return map;
  }, new Map());
  const looseImages = files
    .filter((file) => isImageUpload(file) && !Number(file.sourceSlide || 0))
    .map((file) => cleanClientText(file.originalName || path.basename(file.path || "")))
    .filter(Boolean);
  const slides = Array.isArray(deck.slides) ? deck.slides : [];
  const candidateSlides = slides
    .map((slide, index) => {
      const routeStep = routePlan?.layoutSequence?.[index] || {};
      const sourcePage = inferSourcePage(routeStep, slide, index);
      const sourceImageFiles = sourcePage ? sourceImagesByPage.get(sourcePage) || [] : [];
      const sourceImages = chooseVisualSourceImages(sourceImageFiles, files, slide, routeStep).map((file) => cleanClientText(file.originalName || path.basename(file.path || "")));
      const currentSlots = normalizeClientList(slide.imageSlots);
      const shouldHaveVisual = ["cover", "visual", "product-detail", "bundle", "cards"].includes(slide.layout || routeStep.layout) || sourceImages.length || /图|视觉|产品|包装|礼盒|image|photo/i.test([slide.title, slide.subtitle, slide.visualIntent, routeStep.purpose].join(" "));
      const lacksReliableImage = shouldHaveVisual && !sourceImages.length && !currentSlots.length;
      const hasSourceButWeak = shouldHaveVisual && sourceImages.length && (!currentSlots.length || !currentSlots.some((slot) => sourceImages.includes(slot)) || reviewNeedsImages);
      if (!reviewNeedsImages && !lacksReliableImage && !hasSourceButWeak) return null;
      const action = sourceImages.length ? "use-source-image" : looseImages.length ? "use-uploaded-image" : "need-remote-generation";
      return {
        slide: index + 1,
        title: cleanClientText(slide.title) || `Slide ${index + 1}`,
        layout: slide.layout || routeStep.layout || "",
        sourcePage,
        currentImageSlots: currentSlots,
        availableSourceImages: sourceImages.slice(0, 6),
        availableUploadedImages: sourceImages.length ? [] : looseImages.slice(0, 6),
        action,
        reason: sourceImages.length
          ? "原稿该页有图片；应先复用原图并重新渲染验证，不直接跳到远端补图。"
          : looseImages.length
            ? "该页需要更强视觉素材，可先从用户上传图片中挑选。"
            : "该页缺少可复用图片，优先调用本地 Z-Image 生成底图；远端只作为兜底。",
        remotePrompt: buildRemoteImagePrompt(slide, routePlan, styleFingerprint)
      };
    })
    .filter(Boolean)
    .slice(0, 8);
  const needed = Boolean(reviewNeedsImages || candidateSlides.length);
  return {
    needed,
    status: needed ? "needs-human-confirmation" : "not-needed",
    stage: latestReview?.stage || null,
    trigger: latestReview?.used ? `${latestReview.status || "unknown"}:${latestReview.summary || ""}` : "local-structure-check",
    sourceFacts: {
      oldDeck: Boolean(sourceReport.hasOldDeck),
      sourcePages: sourceReport.pageCount || 0,
      sourceImages: sourceReport.imageCount || 0,
      boundImageSlots: imageSlotReport.boundSlides || 0,
      visualFixRounds: visualFixes.length || 0
    },
    policy: [
      "风格参考图只用于色彩、留白、质感和版式调性，不作为内容事实图直接使用。",
      "旧 PPT 优化优先复用原稿图片；从零生成优先使用用户上传素材。",
      "本地 Z-Image 优先补底图和氛围图；远端补图必须由用户确认，且生成图在交付记录中标记为 AI 补图。",
      "补图不得虚构品牌、价格、产品规格和承诺。"
    ],
    items: candidateSlides,
    nextActions: needed
      ? ["先确认是否复用原稿图", "缺图页优先调用本地 Z-Image 或上传素材", "补图后重新跑样稿视觉质检"]
      : ["当前未发现阻断级补图需求"]
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
    pagePlan?.comfyPrompt || `Create a PPT visual asset for: ${cleanClientText(slide.title) || "presentation slide"}.`,
    `Style: ${theme}${style ? `; ${style}` : ""}.`,
    pagePlan?.textSafeArea ? `Keep this text-safe area visually quiet: ${pagePlan.textSafeArea}.` : "Leave a clear empty text-safe area.",
    pagePlan?.layers ? `Layer plan: background=${pagePlan.layers.background}, text=${pagePlan.layers.text}, image=${pagePlan.layers.image}, ornament=${pagePlan.layers.ornament}.` : "",
    facts ? `Must preserve factual content only as abstract context, do not invent product specs/prices: ${facts}.` : "Do not invent product specs, prices, logos, certifications, or brand claims.",
    "No readable fake text, no fake logos, no misleading product claims."
  ].filter(Boolean).join(" ");
}

function buildLocalImagePrompt(item = {}, routePlan = {}) {
  const pagePlan = findAestheticPagePlan(routePlan, item);
  const theme = routePlan?.aestheticPlan?.theme || routePlan?.recommendedTheme || "premium business presentation";
  return [
    pagePlan?.comfyPrompt || routePlan?.aestheticPlan?.comfy?.basePrompt || `premium ${theme} presentation background`,
    pagePlan?.textSafeArea ? `keep the planned text-safe area visually quiet: ${pagePlan.textSafeArea}` : "large clean empty area reserved for text overlay",
    pagePlan?.layers ? `poster-like PPT layer plan: background ${pagePlan.layers.background}, image area ${pagePlan.layers.image}, ornament ${pagePlan.layers.ornament}` : "",
    "abstract visual support only, no factual product claims",
    "no readable text, no letters, no numbers, no Chinese characters, no captions, no labels, no logo, no watermark",
    "clean editable PPT background, 16:9 composition"
  ].filter(Boolean).join(", ");
}

function findAestheticPagePlan(routePlan = {}, item = {}) {
  return (routePlan?.aestheticPlan?.pagePlans || []).find((plan) => Number(plan.index) === Number(item.slide || 0))
    || (routePlan?.aestheticPlan?.pagePlans || []).find((plan) => plan.layout === item.layout)
    || null;
}

function applyImageSupplementPlanToDeck(deck = {}, plan = {}, files = [], routePlan = null) {
  const itemsBySlide = new Map((plan?.items || []).map((item) => [Number(item.slide || 0), item]));
  const changes = [];
  const slides = (deck.slides || []).map((slide, index) => {
    const item = itemsBySlide.get(index + 1);
    if (!item) return slide;
    const routeStep = routePlan?.layoutSequence?.[index] || {};
    const sourcePage = Number(item.sourcePage || inferSourcePage(routeStep, slide, index) || 0);
    const sourceFiles = files.filter((file) => isImageUpload(file) && Number(file.sourceSlide || 0) === sourcePage);
    const preferred = chooseVisualSourceImages(sourceFiles, files, slide, routeStep)
      .map((file) => cleanClientText(file.originalName || path.basename(file.path || "")))
      .filter(Boolean)
      .slice(0, 3);
    const fallback = normalizeClientList(item.availableSourceImages).slice(0, 3);
    const nextSlots = uniqueTextList([...preferred, ...fallback, ...normalizeClientList(slide.imageSlots)]).slice(0, 4);
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
      layout: ["cover", "closing"].includes(slide.layout) ? slide.layout : slide.layout || "visual",
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

app.post("/api/jobs/outline", async (req, res, next) => {
  try {
    const uploads = await expandUploadsWithPptxImages(await getUploads(req.body.fileIds || []));
    const extracted = [];
    for (const file of uploads) {
      try {
        extracted.push({ name: file.originalName, text: await extractText(file) });
      } catch (error) {
        extracted.push({ name: file.originalName, text: `资料抽取失败：${error.message}` });
      }
    }
    const materialBrief = buildMaterialBrief([
      ...extracted,
      {
        name: "输入说明",
        text: [
          req.body.projectName ? `项目名称：${req.body.projectName}` : "",
          req.body.audience ? `目标对象：${req.body.audience}` : "",
          req.body.copyMode ? `生成类型：${req.body.copyMode}` : "",
          req.body.notes ? `补充说明：${req.body.notes}` : "",
          Array.isArray(req.body.materials) && req.body.materials.length ? `资料类型：${req.body.materials.join("、")}` : ""
        ].filter(Boolean).join("\n")
      }
    ]);
    materialBrief.preferences = {
      primaryProduct: req.body.primaryProduct || "",
      includeToc: req.body.includeToc !== false,
      includeRiskChecklist: req.body.includeRiskChecklist !== false
    };
    attachSourceRecognitionReport(materialBrief, uploads);
    const routePlan = routeDeck({ mode: req.body.mode || "generate", input: req.body, materialBrief, uploads });
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
    await runAgentJob(req, res, "generate");
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs/optimize", async (req, res, next) => {
  try {
    await runAgentJob(req, res, "optimize");
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs/style-preview", async (req, res, next) => {
  try {
    const mode = req.body.mode === "optimize" ? "optimize" : "generate";
    await createStylePreviewJob(req, res, mode);
  } catch (error) {
    next(error);
  }
});

app.get("/api/jobs", async (_req, res, next) => {
  try {
    const jobs = await listJobs();
    res.json({ jobs: jobs.map(toClientJob) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/design-system", async (_req, res, next) => {
  try {
    const references = await listStyleReferences();
    const groups = await listStyleGroups();
    res.json({ ...getDesignSystem(), styleReferences: references.map(normalizeStyleReference), styleGroups: groups.map(normalizeStyleGroup) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/jobs/:id", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "任务不存在" });
    res.json(toClientJob(job));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/jobs/:id", async (req, res, next) => {
  try {
    const deleted = await deleteJob(req.params.id);
    if (!deleted) return res.status(404).json({ error: "任务不存在" });
    res.json({ ok: true, deleted: { id: deleted.id, title: deleted.deck?.title || "" } });
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs/:id/slides/:slideIndex/revise", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "任务不存在" });
    const slideIndex = Number(req.params.slideIndex);
    const beforeLayout = job.deck?.slides?.[slideIndex]?.layout || null;
    const result = await reviseSlide(job.deck, slideIndex, req.body.instruction || "");
    const routePlan = job.input?.routePlan || null;
    const validated = validateDeck(result.deck, routePlan);
    pushUndo(job, `撤销第 ${slideIndex + 1} 页指令改写`);
    job.deck = validated.deck;
    job.quality = enrichQuality(validated.quality, job.files || [], job.input?.materialBrief, routePlan);
    job.aiUsed = job.aiUsed || result.aiUsed;
    job.aiProvider = result.provider || job.aiProvider || null;
    job.warning = [result.warning, ...validated.warnings].filter(Boolean).join("；") || job.warning;
    const afterLayout = job.deck?.slides?.[slideIndex]?.layout || null;
    addEvent(job, result.aiUsed ? "revise" : "fallback", `第 ${slideIndex + 1} 页已应用修改指令`, { instruction: req.body.instruction || "", beforeLayout, afterLayout, warnings: validated.warnings });
    job.updatedAt = new Date().toISOString();
    job.exports.pptx = await buildDeck(job);
    job.exportMeta = collectExportMeta(job.exports);
    addEvent(job, "rendered", "修改后 PPTX 已重新生成", { pptx: job.exports.pptx });
    await refreshPreview(job, "已刷新");
    await saveJob(job);
    res.json(toClientJob(job));
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs/:id/slides/:slideIndex/update", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "任务不存在" });
    const slideIndex = Number(req.params.slideIndex);
    const currentSlide = job.deck?.slides?.[slideIndex];
    if (!currentSlide) return res.status(404).json({ error: "页面不存在" });
    const incoming = req.body.slide || {};
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
      imageSlots: normalizeClientList(incoming.imageSlots),
      canvasEdits: normalizeCanvasEdits(incoming.canvasEdits || currentSlide.canvasEdits)
    };
    pushUndo(job, `撤销第 ${slideIndex + 1} 页手动编辑`);
    job.deck = {
      ...job.deck,
      slides: job.deck.slides.map((slide, index) => (index === slideIndex ? nextSlide : slide))
    };
    const routePlan = syncRoutePlanWithSlides(job.input?.routePlan || null, job.deck.slides || [], "manual-edit");
    if (job.input) job.input.routePlan = routePlan;
    const validated = validateDeck(job.deck, routePlan);
    job.deck = validated.deck;
    job.quality = enrichQuality(validated.quality, job.files || [], job.input?.materialBrief, routePlan);
    job.warning = validated.warnings.length ? validated.warnings.join("；") : job.warning;
    addEvent(job, "manual-edit", `第 ${slideIndex + 1} 页文字已手动保存`, { warnings: validated.warnings });
    job.updatedAt = new Date().toISOString();
    job.exports.pptx = await buildDeck(job);
    job.exportMeta = collectExportMeta(job.exports);
    await refreshPreview(job, "已刷新");
    await saveJob(job);
    res.json(toClientJob(job));
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs/:id/slides/:slideIndex/action", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "任务不存在" });
    const slideIndex = Number(req.params.slideIndex);
    const action = cleanClientText(req.body.action);
    const slides = job.deck?.slides || [];
    if (!slides[slideIndex]) return res.status(404).json({ error: "页面不存在" });
    let nextSlides = [...slides];
    let nextIndex = slideIndex;
    if (action === "duplicate") {
      const source = slides[slideIndex];
      nextSlides.splice(slideIndex + 1, 0, {
        ...source,
        title: `${source.title || "未命名页面"} 副本`
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
        contentSource: "用户输入",
        bullets: defaults.bullets,
        dataPoints: defaults.dataPoints,
        imageSlots: [],
        visualIntent: defaults.visualIntent,
        speakerNotes: ""
      });
      nextIndex = insertIndex;
    } else if (action === "delete") {
      if (slides.length <= 1) return res.status(400).json({ error: "至少需要保留 1 页" });
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
      return res.status(400).json({ error: "未知页面操作" });
    }
    pushUndo(job, `撤销页面操作：${action}`);
    const previousPreviewImages = [...(job.previewImages || [])];
    job.skipPreviewRender = true;
    job.deck = { ...job.deck, slides: nextSlides };
    const routePlan = syncRoutePlanWithSlides(job.input?.routePlan || null, nextSlides, action);
    if (job.input) job.input.routePlan = routePlan;
    const validated = validateDeck(job.deck, routePlan);
    job.deck = validated.deck;
    job.quality = enrichQuality(validated.quality, job.files || [], job.input?.materialBrief, routePlan);
    job.warning = validated.warnings.length ? validated.warnings.join("；") : job.warning;
    addEvent(job, "slide-action", `页面操作完成：${action}`, { action, from: slideIndex, to: nextIndex, slideCount: job.deck.slides.length });
    job.updatedAt = new Date().toISOString();
    job.exports.pptx = await buildDeck(job);
    job.exportMeta = collectExportMeta(job.exports);
    await refreshPreview(job, "页面结构已刷新");
    syncPreviewAfterSlideAction(job, previousPreviewImages, action, slideIndex, nextIndex);
    await saveJob(job);
    res.json({ ...toClientJob(job), selectedSlide: nextIndex });
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs/:id/export", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "任务不存在" });
    const formats = req.body.formats || ["pptx"];
    if (formats.includes("pdf") || formats.includes("png")) {
      try {
        const result = await exportWithPowerPoint(job.exports.pptx, formats.filter((item) => item !== "pptx"));
        job.exports = { ...job.exports, ...result };
        job.exportMeta = collectExportMeta(job.exports);
        job.exportWarning = null;
        addEvent(job, "export", `导出完成：${formats.join(", ")}`, result);
      } catch (error) {
        job.exportWarning = `PDF/PNG 导出失败：${error.message}`;
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
    if (!job) return res.status(404).json({ error: "任务不存在" });
    if (!job.exports?.pptx) return res.status(400).json({ error: "当前任务还没有 PPTX 文件" });
    await refreshPreview(job, "已重新生成");
    job.updatedAt = new Date().toISOString();
    await saveJob(job);
    res.json(toClientJob(job));
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs/:id/template", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "任务不存在" });
    const style = cleanClientText(req.body.style);
    if (!style) return res.status(400).json({ error: "请选择模板" });
    const nextInput = { ...(job.input || {}), style };
    const materialBrief = nextInput.materialBrief || {};
    const routePlan = routeDeck({ mode: job.mode || "generate", input: nextInput, materialBrief, uploads: job.files || [] });
    pushUndo(job, `撤销切换模板：${routePlan.templatePack?.name || style}`);
    job.input = { ...nextInput, routePlan };
    job.quality = enrichQuality(job.quality || {}, job.files || [], materialBrief, routePlan);
    addEvent(job, "template", `已切换模板并重新渲染：${routePlan.templatePack?.name || style}`, {
      style,
      templatePack: routePlan.templatePack || null,
      layouts: routePlan.layoutSequence?.map((step) => step.layout) || []
    });
    job.updatedAt = new Date().toISOString();
    job.exports.pptx = await buildDeck(job);
    job.exportMeta = collectExportMeta(job.exports);
    await refreshPreview(job, "已按新模板刷新");
    await saveJob(job);
    res.json(toClientJob(job));
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs/:id/rewrite", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "任务不存在" });
    const instruction = cleanClientText(req.body.instruction);
    if (!instruction) return res.status(400).json({ error: "请输入整份改写指令" });
    const beforeLayouts = (job.deck?.slides || []).map((slide) => slide.layout);
    pushUndo(job, `撤销整份批量改写：${instruction}`);
    job.deck = rewriteDeckLocally(job.deck, instruction);
    const routePlan = job.input?.routePlan || null;
    const validated = validateDeck(job.deck, routePlan);
    job.deck = validated.deck;
    job.quality = enrichQuality(validated.quality, job.files || [], job.input?.materialBrief, routePlan);
    job.warning = validated.warnings.length ? validated.warnings.join("；") : job.warning;
    addEvent(job, "deck-rewrite", "整份 PPT 已按指令批量改写", {
      instruction,
      beforeLayouts,
      afterLayouts: job.deck.slides.map((slide) => slide.layout)
    });
    job.updatedAt = new Date().toISOString();
    job.exports.pptx = await buildDeck(job);
    job.exportMeta = collectExportMeta(job.exports);
    await refreshPreview(job, "整份改写已刷新");
    await saveJob(job);
    res.json(toClientJob(job));
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs/:id/repair", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "任务不存在" });
    pushUndo(job, "撤销交付自检修复");
    let routePlan = job.input?.routePlan || null;
    const report = repairDeckForDelivery(job.deck, routePlan, job.files || [], job.input?.materialBrief || {});
    job.deck = report.deck;
    routePlan = syncRoutePlanWithSlides(routePlan, job.deck.slides || [], "repair");
    if (job.input) job.input.routePlan = routePlan;
    const validated = validateDeck(job.deck, routePlan);
    job.deck = validated.deck;
    job.quality = enrichQuality(validated.quality, job.files || [], job.input?.materialBrief, routePlan);
    job.warning = validated.warnings.length ? validated.warnings.join("；") : null;
    addEvent(job, "delivery-repair", "交付自检修复已完成", report.summary);
    job.updatedAt = new Date().toISOString();
    job.exports.pptx = await buildDeck(job);
    job.exportMeta = collectExportMeta(job.exports);
    await refreshPreview(job, "交付自检修复已刷新");
    await saveJob(job);
    res.json(toClientJob(job));
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs/:id/apply-image-supplement", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "任务不存在" });
    pushUndo(job, "撤销补图计划执行");
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
    job.warning = validated.warnings.length ? validated.warnings.join("；") : null;
    addEvent(job, "image-supplement-apply", "已按补图计划复用原稿图并重绘", report.summary);
    job.updatedAt = new Date().toISOString();
    job.exports.pptx = await buildDeck(job);
    job.exportMeta = collectExportMeta(job.exports);
    await refreshPreview(job, "补图计划已执行");
    const cloudVisualReview = await reviewDeckVisuals({ stage: `${job.mode || "job"}-image-supplement`, deck: job.deck, quality: job.quality, routePlan, materialBrief, previewImages: job.previewImages || [] });
    job.cloudReviews = [...(job.cloudReviews || []), cloudVisualReview];
    addEvent(job, "cloud-visual-review", cloudVisualReview.used ? `补图后云端视觉复审：${cloudVisualReview.status}` : `补图后云端视觉复审跳过：${cloudVisualReview.reason || "not available"}`, cloudVisualReview);
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
    if (!job) return res.status(404).json({ error: "任务不存在" });
    const routePlan = job.input?.routePlan || null;
    const materialBrief = job.input?.materialBrief || {};
    const plan = job.imageSupplementPlan || buildImageSupplementPlan({ deck: job.deck, routePlan, materialBrief, files: job.files || [], cloudReviews: job.cloudReviews || [], visualFixes: job.visualFixes || [] });
    const targets = (plan.items || []).filter((item) => item.action === "need-remote-generation").slice(0, 3);
    if (!targets.length) {
      res.status(400).json({ error: "当前补图计划没有需要本地生成的页面；可先复用原稿图或重新跑视觉质检。" });
      return;
    }
    pushUndo(job, "撤销本地 Z-Image 补图");
    const generated = [];
    for (const item of targets) {
      const pagePlan = findAestheticPagePlan(routePlan, item);
      const record = await generateLocalImage({
        prompt: buildLocalImagePrompt(item, routePlan),
        width: req.body?.width || 768,
        height: req.body?.height || 768,
        steps: req.body?.steps || 8,
        seed: req.body?.seed || Date.now() + Number(item.slide || 0),
        textSafeArea: pagePlan?.textSafeArea || "",
        prefix: `job_${job.id}_slide_${item.slide}_zimage`
      });
      record.sourceSlide = Number(item.slide || 0);
      generated.push({ item, record });
      job.files = [...(job.files || []), record];
      const slideIndex = Number(item.slide || 0) - 1;
      if (job.deck?.slides?.[slideIndex]) {
        const slide = job.deck.slides[slideIndex];
        slide.imageSlots = uniqueTextList([record.originalName, ...normalizeClientList(slide.imageSlots)]).slice(0, 4);
        slide.visualIntent = [
          cleanClientText(slide.visualIntent),
          "已由本地 Z-Image 生成 AI 补图；该图仅作为视觉素材，不作为事实来源。"
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
    job.warning = validated.warnings.length ? validated.warnings.join("；") : null;
    addEvent(job, "local-image-supplement", `本地 Z-Image 已生成 ${generated.length} 张补图`, {
      provider: "comfyui-zimage",
      generated: generated.map(({ item, record }) => ({
        slide: item.slide,
        title: item.title,
        image: record.originalName,
        prompt: record.prompt,
        seed: record.seed,
        workflowPath: record.comfy?.workflowPath || null,
        visualQa: record.visualQa || null
      }))
    });
    job.updatedAt = new Date().toISOString();
    job.exports.pptx = await buildDeck(job);
    job.exportMeta = collectExportMeta(job.exports);
    await refreshPreview(job, "本地 Z-Image 补图已执行");
    const cloudVisualReview = await reviewDeckVisuals({ stage: `${job.mode || "job"}-local-image-supplement`, deck: job.deck, quality: job.quality, routePlan: nextRoutePlan, materialBrief, previewImages: job.previewImages || [] });
    job.cloudReviews = [...(job.cloudReviews || []), cloudVisualReview];
    addEvent(job, "cloud-visual-review", cloudVisualReview.used ? `本地补图后云端视觉复审：${cloudVisualReview.status}` : `本地补图后云端视觉复审跳过：${cloudVisualReview.reason || "not available"}`, cloudVisualReview);
    job.imageSupplementPlan = buildImageSupplementPlan({ deck: job.deck, routePlan: nextRoutePlan, materialBrief, files: job.files || [], cloudReviews: job.cloudReviews || [], visualFixes: job.visualFixes || [] });
    job.agentReviews = [...(job.agentReviews || []), buildAgentReview(job.mode === "style-preview" ? "style-preview" : "final-deck", job.deck, job.quality, nextRoutePlan, materialBrief, job.files || [], job.previewImages || [], cloudVisualReview)];
    await saveJob(job);
    res.json(toClientJob(job));
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs/:id/rescan-local-image-qa", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "任务不存在" });
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
    addEvent(job, "local-image-qa", `本地图片 QA 已重扫 ${checked} 张，${warned} 张有风险`, { checked, warned, localImageQa: job.quality.localImageQa });
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
    if (!job) return res.status(404).json({ error: "任务不存在" });
    const snapshot = (job.undoStack || []).pop();
    if (!snapshot) return res.status(400).json({ error: "没有可撤销的操作" });
    job.deck = snapshot.deck;
    if (snapshot.input) job.input = snapshot.input;
    const routePlan = job.input?.routePlan || null;
    const validated = validateDeck(job.deck, routePlan);
    job.deck = validated.deck;
    job.quality = enrichQuality(validated.quality, job.files || [], job.input?.materialBrief, routePlan);
    job.warning = validated.warnings.length ? validated.warnings.join("；") : job.warning;
    addEvent(job, "undo", snapshot.label || "已撤销上一步操作", { remaining: job.undoStack.length });
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
    if (!job) return res.status(404).json({ error: "任务不存在" });
    job.feedback = { rating: req.body.rating, comment: req.body.comment || "", createdAt: new Date().toISOString() };
    job.updatedAt = new Date().toISOString();
    await saveJob(job);
    res.json(toClientJob(job));
  } catch (error) {
    next(error);
  }
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
  res.status(500).json({ error: error.message || "服务器错误" });
});

app.listen(port, () => {
  console.log(`PPT Design Tool running at http://127.0.0.1:${port}`);
});

function toClientJob(job) {
  const { undoStack: _undoStack, ...publicJob } = job;
  const derivedQuality = enrichQuality(job.quality || {}, job.files || [], job.input?.materialBrief || {}, job.input?.routePlan || null);
  const toOutputUrl = (file, options = {}) => {
    if (!file) return file;
    if (Array.isArray(file)) return file.map((item) => toOutputUrl(item, options));
    if (typeof file !== "string") return file;
    const normalized = path.normalize(file);
    if (!normalized.startsWith(outputDir) || !fsSync.existsSync(normalized)) return null;
    const relative = path.relative(outputDir, normalized).split(path.sep).map(encodeURIComponent).join("/");
    const version = options.cacheBust ? `?v=${Math.round(fsSync.statSync(normalized).mtimeMs)}` : "";
    return `/outputs/${relative}${version}`;
  };
  const previewImages = (job.previewImages || []).map((file) => toOutputUrl(file, { cacheBust: true }));
  const slideCount = job.deck?.slides?.length || 0;
  return {
    ...publicJob,
    quality: derivedQuality,
    canUndo: Boolean(job.undoStack?.length),
    undoLabel: job.undoStack?.at(-1)?.label || null,
    input: normalizeInput(job.input),
    files: (job.files || []).map(normalizeUploadRecord),
    exports: Object.fromEntries(Object.entries(job.exports || {}).map(([key, value]) => [key, toOutputUrl(value)])),
    exportMeta: job.exportMeta || collectExportMeta(job.exports || {}),
    previewImages: previewImages.length === slideCount ? previewImages : previewImages.length && previewImages.every(Boolean) ? previewImages : repairPreviewImages(job, { cacheBust: true })
  };
}

function attachSourceRecognitionReport(materialBrief = {}, uploads = []) {
  materialBrief.sourceReport = buildSourceRecognitionReport(materialBrief, uploads);
  materialBrief.pages = mergeSourceDiagnosticsIntoPages(materialBrief.pages || [], materialBrief.sourceReport);
  return materialBrief;
}

function buildSourceRecognitionReport(materialBrief = {}, uploads = []) {
  const pages = Array.isArray(materialBrief.pages) ? materialBrief.pages : [];
  const sourceDecks = (uploads || []).filter((file) => /\.(ppt|pptx)$/i.test(file.originalName || file.path || ""));
  const aestheticDiagnosis = mergeAestheticDiagnostics(sourceDecks);
  const diagnosticSlides = new Map((aestheticDiagnosis?.slides || []).map((slide) => [Number(slide.page), slide]));
  const extractedImages = (uploads || []).filter((file) => Number(file.sourceSlide || 0) > 0);
  const looseImages = (uploads || []).filter((file) => isImageUpload(file) && !Number(file.sourceSlide || 0));
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
      title: cleanClientText(page.title) || `第 ${pageNumber} 页`,
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
    emptyPages.length ? `empty-pages:${emptyPages.map((page) => page.page).slice(0, 8).join(",")}` : "",
    imageOnlyPages.length ? `image-only-pages:${imageOnlyPages.map((page) => page.page).slice(0, 8).join(",")}` : "",
    textOnlyPages.length && extractedImages.length ? `text-only-pages:${textOnlyPages.map((page) => page.page).slice(0, 8).join(",")}` : ""
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
    aestheticDiagnosis,
    pages: pageReports.slice(0, 60),
    looseImages: looseImages.map((file) => cleanClientText(file.originalName || path.basename(file.path || ""))).filter(Boolean).slice(0, 24),
    warnings
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
    warnings: reports.flatMap((report) => report.error ? [`analysis-failed:${report.deckName || "pptx"}`] : [])
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

function uniqueNumbers(values = []) {
  return [...new Set(values.map((value) => Number(value || 0)).filter((value) => Number.isFinite(value) && value > 0))].sort((a, b) => a - b);
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
    const sourcePage = inferSourcePage(routeStep, slide, index);
    const pageImageFiles = sourcePage ? sourceImagesBySlide.get(sourcePage) || [] : [];
    const pageImages = chooseVisualSourceImages(pageImageFiles, imageFiles, slide, routeStep).map((file) => cleanClientText(file.originalName || path.basename(file.path || "")));
    const routeImages = normalizeClientList(routeStep?.imageSlots);
    const titleImages = matchImagesByText(imageNames, [slide.title, slide.subtitle, slide.visualIntent, ...(slide.bullets || [])].join(" "));
    const fallbackImages = shouldHaveImages(slide, routeStep, pageImages, routeImages, titleImages) ? imageNames.slice(index % Math.max(imageNames.length, 1), index % Math.max(imageNames.length, 1) + 3) : [];
    const recommended = uniqueTextList([...pageImages, ...routeImages, ...titleImages, ...current, ...fallbackImages]).slice(0, 8);
    const shouldReplace = recommended.length && !sameListPrefix(current, recommended);
    if (shouldReplace) changedSlides += 1;
    bindings.push({
      slide: index + 1,
      title: cleanClientText(slide.title),
      layout: slide.layout || "",
      routeIndex: routeStep?.index || null,
      sourcePage,
      before: current,
      after: shouldReplace ? recommended : current,
      matchedBy: pageImages.length ? "source-slide" : routeImages.length ? "route-step" : titleImages.length ? "title-match" : fallbackImages.length ? "fallback" : "none",
      sourceTextChars: sourcePage ? pageReports.find((page) => Number(page.page) === sourcePage)?.textChars || null : null
    });
    return {
      ...slide,
      imageSlots: shouldReplace ? recommended : current
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
  const match = text.match(/(?:第|slide|page)\s*(\d{1,3})\s*(?:页|頁)?/i);
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
  const size = Number(file.size || 0);
  let score = 0;
  if (size >= 1_000_000) score += 60;
  else if (size >= 250_000) score += 42;
  else if (size >= 80_000) score += 24;
  else if (size >= 20_000) score += 8;
  else score -= 42;
  for (const token of tokenizeForImageMatch(text)) {
    if (token.length >= 2 && name.includes(token)) score += token.length >= 4 ? 8 : 3;
  }
  if (/product|pack|box|detail|render|产品|包装|礼盒|细节|实物|效果/.test(name)) score += 18;
  if (/logo|brand|标志|品牌/.test(name)) score -= 8;
  if (/background|bg|shape|line|map|grid|背景|底图|线条|地图/.test(name)) score -= 14;
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
  const intent = hasOldDeck && wantsEdit ? "优化旧 PPT" : hasOldDeck ? "重排旧 PPT" : materialBrief.inputStrength === "empty" ? "零资料初稿" : "新建 PPT";
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
    summary: `${decision.intent || "PPT 任务"}：先确认大纲，再生成、自检并自动修复一轮。`,
    steps: ["读取资料", "判断任务意图", "规划可确认大纲", "按确认大纲生成 Deck", "交付自检", "必要时自动修复一轮", "生成 PPTX 和预览"],
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
  if (!actualSlides) blocking.push("没有生成任何页面");
  if (expectedSlides && Math.abs(actualSlides - expectedSlides) >= 2) blocking.push(`页数偏离明显：计划 ${expectedSlides} 页，实际 ${actualSlides} 页`);
  if (slides.some((slide) => !cleanClientText(slide.title))) repairable.push("存在空标题页面");
  if (slides.some((slide) => !cleanClientText([slide.title, slide.subtitle, ...(slide.bullets || []), ...(slide.dataPoints || [])].join(" ")))) repairable.push("存在内容过空页面");
  const routeScore = Number(quality.routeAdherence?.score);
  if (Number.isFinite(routeScore) && routeScore < 0.75) repairable.push(`路由匹配偏低：${Math.round(routeScore * 100)}%`);
  if ((quality.routingWarnings || []).some((item) => /连续|repeat/i.test(String(item)))) repairable.push("存在连续重复版式");
  if (slides.some((slide) => slide.layout === "pricing" && !/\d/.test([...(slide.bullets || []), ...(slide.dataPoints || [])].join(" ")))) repairable.push("价格页缺少明确数字");
  const hasImageMaterial = Number(materialBrief.imageCount || quality.material?.imageCount || 0) > 0;
  if (hasImageMaterial && slides.some((slide) => slide.layout === "visual" && !(slide.imageSlots || []).length)) repairable.push("图片页缺少图片槽");
  if (quality.renderImageQa?.warningCount) repairable.push(`图片放置存在比例/裁切风险：${quality.renderImageQa.warningCount} 处`);
  if (Array.isArray(previewImages) && actualSlides && previewImages.filter(Boolean).length !== actualSlides) blocking.push(`预览图数量不一致：${previewImages.filter(Boolean).length}/${actualSlides}`);
  if ((materialBrief.confirmationFields || []).length) hints.push(`待人工确认：${materialBrief.confirmationFields.join("、")}`);
  if (materialBrief.inputStrength === "weak" || materialBrief.inputStrength === "empty") hints.push("资料较弱，生成内容需人工复核");
  const aestheticDiagnosis = quality.aestheticDiagnosis || materialBrief.sourceReport?.aestheticDiagnosis || {};
  if (Number.isFinite(Number(aestheticDiagnosis.overallScore)) && Number(aestheticDiagnosis.overallScore) < 72) repairable.push(`旧稿美学诊断偏低：${aestheticDiagnosis.overallScore} 分`);
  if ((aestheticDiagnosis.lowScoreSlides || []).length) repairable.push(`旧稿低分页：${aestheticDiagnosis.lowScoreSlides.slice(0, 6).join("、")}`);
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
      name: "大脑 Agent",
      role: "总控任务阶段、是否进入人工确认或继续生成。",
      status: assessment.blocking.length ? "block" : assessment.repairable.length ? "warn" : "pass",
      findings: [...assessment.blocking, ...assessment.repairable, ...assessment.hints].slice(0, 6)
    },
    {
      id: "route",
      name: "路由 Agent",
      role: "检查 deck 类型、页数、layout 队列和路由遵守度。",
      status: Number.isFinite(routeScore) && routeScore < 0.75 ? "warn" : "pass",
      findings: [
        routePlan?.deckType ? `类型：${routePlan.deckType}` : "",
        routePlan?.targetSlides ? `目标页数：${routePlan.targetSlides}` : "",
        Number.isFinite(routeScore) ? `路由匹配：${Math.round(routeScore * 100)}%` : "",
        ...(quality.routingWarnings || []).slice(0, 3)
      ].filter(Boolean)
    },
    {
      id: "source",
      name: "素材 Agent",
      role: "检查原文、原图、页码绑定和生成页图片槽。",
      status: localImageQa.warnCount ? "warn" : sourceReport.hasOldDeck && !sourceReport.boundImageCount ? "warn" : "pass",
      findings: [
        sourceReport.pageCount ? `原稿页数：${sourceReport.pageCount}` : "",
        sourceReport.imageCount ? `原图：${sourceReport.imageCount} 张` : "",
        sourceReport.boundImageCount ? `绑定页码：${sourceReport.boundImageCount} 张` : "",
        imageSlotReport.boundSlides ? `生成页图片槽：${imageSlotReport.boundSlides} 页` : "",
        localImageQa.total ? `本地图 QA：${localImageQa.passCount}/${localImageQa.total} 通过` : "",
        renderImageQa.total ? `图片放置：${renderImageQa.total} 处，风险 ${renderImageQa.warningCount || 0}` : "",
        renderImageQa.warnings?.length ? `放置风险：${renderImageQa.warnings.slice(0, 3).join("、")}` : "",
        localImageQa.risks?.length ? `风险：${localImageQa.risks.slice(0, 3).join("、")}` : ""
      ].filter(Boolean)
    },
    {
      id: "aesthetic-diagnosis",
      name: "美学诊断 Agent",
      role: "检查旧 PPT 的信息密度、层级、色彩、留白、图片风险和重构策略。",
      status: Number.isFinite(Number(aestheticDiagnosis.overallScore)) && Number(aestheticDiagnosis.overallScore) < 72 ? "warn" : (aestheticDiagnosis.lowScoreSlides || []).length ? "warn" : "pass",
      findings: [
        Number.isFinite(Number(aestheticDiagnosis.overallScore)) ? `诊断分：${aestheticDiagnosis.overallScore}` : "",
        (aestheticDiagnosis.lowScoreSlides || []).length ? `低分页：${aestheticDiagnosis.lowScoreSlides.slice(0, 8).join("、")}` : "",
        (aestheticDiagnosis.highDensitySlides || []).length ? `高密度页：${aestheticDiagnosis.highDensitySlides.slice(0, 8).join("、")}` : "",
        ...((aestheticDiagnosis.slides || []).flatMap((slide) => slide.problems || []).map((item) => item.message || item).filter(Boolean).slice(0, 3))
      ].filter(Boolean)
    },
    {
      id: "style",
      name: "风格 Agent",
      role: "检查风格库、样稿覆盖和视觉调性约束。",
      status: styleRefs || routePlan?.recommendedTheme ? "pass" : "warn",
      findings: [
        routePlan?.recommendedTheme ? `风格：${routePlan.recommendedTheme}` : "",
        styleRefs ? `参考图：${styleRefs} 张` : "未使用自定义风格参考图",
        styleFingerprint?.prompt ? `指纹：${styleFingerprint.prompt}` : "",
        stage === "style-preview" ? "样稿阶段：先审再交给人工确认" : "整稿阶段：按已确认风格复审"
      ].filter(Boolean)
    },
    {
      id: "delivery",
      name: "交付 Agent",
      role: "检查 PPTX、预览、导出和可继续编辑风险。",
      status: assessment.blocking.length ? "block" : quality.warningCount > 3 ? "warn" : "pass",
      findings: [
        `页数：${slides.length}`,
        previewCount !== null ? `预览：${previewCount}/${slides.length}` : "",
        `警告：${quality.warningCount || 0}`,
        quality.imageSlotCount ? `图片槽：${quality.imageSlotCount}` : "",
        localImageQa.warnCount ? `本地图风险：${localImageQa.warnCount}` : "",
        renderImageQa.warningCount ? `比例/裁切风险：${renderImageQa.warningCount}` : ""
      ].filter(Boolean)
    }
  ];
  if (cloudVisualReview) {
    agents.push({
      id: "cloud-visual",
      name: "云端视觉 Agent",
      role: "读取样稿/整稿预览图，复审审美、密度、图片使用和交付观感。",
      status: cloudVisualReview.used ? cloudVisualReview.status || "warn" : "warn",
      findings: [
        cloudVisualReview.used ? cloudVisualReview.summary : `未完成云端视觉复审：${cloudVisualReview.reason || "not available"}`,
        ...(cloudVisualReview.findings || []).slice(0, 4),
        cloudVisualReview.scores ? `评分：风格 ${cloudVisualReview.scores.style ?? "-"} / 版式 ${cloudVisualReview.scores.layout ?? "-"} / 密度 ${cloudVisualReview.scores.density ?? "-"} / 图片 ${cloudVisualReview.scores.imageUse ?? "-"}` : ""
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

async function refreshPreview(job, successVerb = "已生成") {
  if (job.skipPreviewRender) {
    delete job.skipPreviewRender;
    addEvent(job, "preview-fast-sync", "预览已按页面操作快速同步", { count: (job.previewImages || []).filter(Boolean).length });
    return;
  }
  const result = await renderPptxPreview(job.exports.pptx);
  job.previewImages = result.images || [];
  job.previewWarning = result.error ? `PNG 预览生成失败：${result.error}` : null;
  addEvent(
    job,
    result.error ? "preview-error" : "preview",
    result.error ? job.previewWarning : `${successVerb} ${job.previewImages.length} 张预览图`,
    { count: job.previewImages.length, error: result.error || null }
  );
}

function syncPreviewAfterSlideAction(job, previousPreviewImages = [], action = "", slideIndex = 0, nextIndex = slideIndex) {
  const next = [...previousPreviewImages];
  if (action === "move-up" || action === "move-down" || action === "move-to") {
    const [moved] = next.splice(slideIndex, 1);
    next.splice(nextIndex, 0, moved || null);
  } else if (action === "duplicate") {
    next.splice(slideIndex + 1, 0, previousPreviewImages[slideIndex] || null);
  } else if (action === "delete") {
    next.splice(slideIndex, 1);
  } else if (action === "insert-after" || action === "insert-before") {
    next.splice(action === "insert-before" ? slideIndex : slideIndex + 1, 0, null);
  }
  const slideCount = job.deck?.slides?.length || 0;
  job.previewImages = next.slice(0, slideCount);
  while (job.previewImages.length < slideCount) job.previewImages.push(null);
  job.previewWarning = null;
  addEvent(job, "preview-fast-sync", `页面操作已快速同步预览：${action}`, {
    action,
    from: slideIndex,
    to: nextIndex,
    previewCount: job.previewImages.filter(Boolean).length,
    slideCount
  });
}

function normalizeInput(input = {}) {
  return {
    ...input,
    extracted: (input.extracted || []).map((item) => ({ ...item, name: decodeMaybeMojibake(item.name) }))
  };
}

function filterStyleReferencesForInput(references = [], input = {}, routePlan = null) {
  const themes = getDesignSystem().themes || [];
  const defaultTheme = themes[0]?.name || "";
  const selectedTheme = decodeMaybeMojibake(input.style || routePlan?.recommendedTheme || defaultTheme);
  const selectedThemeRecord = themes.find((theme) => theme.name === selectedTheme || theme.slug === selectedTheme) || themes[0] || {};
  const selectedThemeSlug = selectedThemeRecord.slug || "";
  return references.filter((record) => {
    const recordTheme = decodeMaybeMojibake(record.themeName || "");
    if (!recordTheme && !record.themeSlug) return selectedTheme === defaultTheme;
    return recordTheme === selectedTheme || recordTheme === selectedThemeRecord.name || record.themeSlug === selectedThemeSlug;
  });
}

function normalizeUploadRecord(file) {
  if (!file) return file;
  const normalized = path.normalize(file.path || "");
  const isImage = /\.(png|jpe?g|svg|webp)$/i.test(file.originalName || file.path || "") || /^image\//.test(file.mimeType || "");
  const uploadUrl = normalized.startsWith(uploadDir) && fsSync.existsSync(normalized)
    ? `/uploads/${path.relative(uploadDir, normalized).split(path.sep).map(encodeURIComponent).join("/")}`
    : null;
  return { ...file, originalName: decodeMaybeMojibake(file.originalName), uploadUrl: isImage ? uploadUrl : null };
}

function normalizeStyleReference(record) {
  if (!record) return record;
  const normalized = path.normalize(record.path || "");
  const imageUrl = normalized.startsWith(uploadDir) && fsSync.existsSync(normalized)
    ? `/uploads/${path.relative(uploadDir, normalized).split(path.sep).map(encodeURIComponent).join("/")}`
    : null;
  const defaultTheme = getDesignSystem().themes?.[0] || {};
  return {
    ...record,
    name: decodeMaybeMojibake(record.name),
    themeName: decodeMaybeMojibake(record.themeName || defaultTheme.name || ""),
    themeSlug: record.themeSlug || defaultTheme.slug || "",
    originalName: decodeMaybeMojibake(record.originalName),
    styleFingerprint: record.styleFingerprint || null,
    imageUrl
  };
}

function normalizeStyleGroup(record) {
  if (!record) return record;
  return {
    ...record,
    name: decodeMaybeMojibake(record.name),
    tone: decodeMaybeMojibake(record.tone || ""),
    bestFor: decodeMaybeMojibake(record.bestFor || record.tone || ""),
    custom: true
  };
}

function compactStyleReference(record) {
  const defaultTheme = getDesignSystem().themes?.[0] || {};
  return {
    id: record.id,
    name: decodeMaybeMojibake(record.name),
    tone: record.tone || "",
    themeName: decodeMaybeMojibake(record.themeName || defaultTheme.name || ""),
    themeSlug: record.themeSlug || defaultTheme.slug || "",
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
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function cleanClientText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
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
    title: cleanClientText(step.title) || `第 ${index + 1} 页`,
    purpose: cleanClientText(step.purpose) || cleanClientText(step.visualIntent) || "按确认大纲生成本页内容。",
    storyRole: cleanClientText(step.storyRole) || cleanClientText(step.kind) || "补充内容",
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
    targetSlides: layoutSequence.length,
    layoutSequence,
    sections: layoutSequence.map((step) => ({ index: step.index, title: step.title, layout: step.layout, purpose: step.purpose, storyRole: step.storyRole })),
    storyArc: layoutSequence.map((step) => `${step.index}. ${step.storyRole}: ${step.title}`).join(" → "),
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
      title: cleanClientText(slide.title) || previous.title || `第 ${index + 1} 页`,
      purpose: previous.purpose || cleanClientText(slide.visualIntent) || cleanClientText(slide.subtitle) || "手动调整后的页面",
      storyRole: cleanClientText(slide.storyRole) || previous.storyRole || "手动调整",
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
    storyArc: layoutSequence.map((step) => `${step.index}. ${step.storyRole}: ${step.title}`).join(" -> "),
    routingReasons: [...(routePlan.routingReasons || []), `manual-slide-action=${reason}`, "routePlan=synced-to-current-deck"]
  };
}

function getInsertedSlideDefaults(layout = "section") {
  const defaults = {
    cover: { title: "新增封面", subtitle: "补充项目标题和核心主张", storyRole: "开场定位", bullets: ["一句话说明项目价值"], dataPoints: [], visualIntent: "用主标题和主视觉建立第一印象。" },
    visual: { title: "新增视觉页", subtitle: "补充图片素材或视觉意图", storyRole: "视觉证据", bullets: ["说明这张图片想证明什么"], dataPoints: [], visualIntent: "优先放入产品图、包装图、截图或效果图。" },
    section: { title: "新增章节", subtitle: "补充这一部分的结论", storyRole: "章节承接", bullets: ["在这里补充当前页要点"], dataPoints: [], visualIntent: "用简洁章节页承接前后内容。" },
    toc: { title: "目录", subtitle: "补充阅读路径", storyRole: "阅读路径", bullets: ["第一部分", "第二部分", "第三部分"], dataPoints: [], visualIntent: "用列表说明整份 PPT 的结构。" },
    kpi: { title: "关键指标", subtitle: "补充指标口径和数据来源", storyRole: "关键证据", bullets: ["指标一待补齐", "指标二待补齐", "指标三待补齐"], dataPoints: ["指标一", "指标二", "指标三"], visualIntent: "用大数字或指标卡展示关键信息。" },
    pricing: { title: "价格梯度", subtitle: "补充报价、档位和主推理由", storyRole: "预算决策", bullets: ["入门档待补齐", "主推档待补齐", "升级档待补齐"], dataPoints: ["入门档", "主推档", "升级档"], visualIntent: "用价格卡说明不同预算选择。" },
    "product-detail": { title: "产品详情", subtitle: "补充规格、卖点和适用场景", storyRole: "方案证据", bullets: ["规格待补齐", "卖点待补齐", "场景待补齐"], dataPoints: [], visualIntent: "用产品图和信息条展示单品信息。" },
    bundle: { title: "组合推荐", subtitle: "补充不同场景下的推荐组合", storyRole: "推荐方案", bullets: ["入门组合", "主推组合", "升级组合"], dataPoints: [], visualIntent: "用三栏卡片表达组合推荐。" },
    "risk-checklist": { title: "风险与待确认", subtitle: "补充需要人工确认的信息", storyRole: "风险控制", bullets: ["价格待确认", "规格待确认", "图片授权待确认"], dataPoints: [], visualIntent: "用清单结构呈现待确认项。" },
    compare: { title: "方案对比", subtitle: "补充方案差异和推荐理由", storyRole: "差异证明", bullets: ["方案 A", "方案 B", "推荐理由"], dataPoints: [], visualIntent: "用左右对比说明差异。" },
    timeline: { title: "推进路径", subtitle: "补充阶段、节奏和交付动作", storyRole: "落地路径", bullets: ["阶段一", "阶段二", "阶段三"], dataPoints: [], visualIntent: "用时间线展示推进步骤。" },
    cards: { title: "核心要点", subtitle: "补充 3-5 个关键卖点或判断", storyRole: "卖点证明", bullets: ["要点一", "要点二", "要点三"], dataPoints: [], visualIntent: "用卡片拆分关键信息。" },
    quote: { title: "核心话术", subtitle: "补充可直接复述的一句话", storyRole: "表达锚点", bullets: ["把这一页讲成一句清楚的话"], dataPoints: [], visualIntent: "用大标题强化记忆点。" },
    closing: { title: "下一步行动", subtitle: "补充确认事项和交付动作", storyRole: "下一步行动", bullets: ["确认资料", "输出正式版", "进入交付"], dataPoints: [], visualIntent: "用行动清单收束整份 PPT。" }
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
    slide.imageSlots = normalizeClientList(slide.imageSlots).slice(0, 8);
    if (!slide.title) {
      slide.title = index === 0 ? deck.title || "项目首页" : `第 ${index + 1} 页`;
      changes.push("filled-title");
    }
    if (!slide.storyRole) {
      slide.storyRole = slide.layout === "closing" ? "下一步行动" : slide.layout === "pricing" ? "预算决策" : "内容承接";
      changes.push("filled-story-role");
    }
    if (!slide.visualIntent) {
      slide.visualIntent = slide.layout === "visual" ? "使用上传图片或素材槽作为页面主视觉。" : "按当前模板规则保持清晰层级和留白。";
      changes.push("filled-visual-intent");
    }
    if (!slide.speakerNotes) {
      slide.speakerNotes = `讲清「${slide.title}」这一页的结论、依据和下一步动作。`;
      changes.push("filled-speaker-notes");
    }
    if (slide.layout === "visual" && imageFiles.length && !slide.imageSlots.length) {
      slide.imageSlots = imageFiles.slice(0, 3);
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
    if (targetCount && slides.length >= targetCount) {
      const routeRiskIndex = (routePlan?.layoutSequence || []).findIndex((step) => step.layout === "risk-checklist");
      const replaceAt = routeRiskIndex >= 0
        ? routeRiskIndex
        : Math.max(1, Math.min(slides.length - 2, slides.findIndex((slide, index) => index > 0 && index < slides.length - 1 && !["cover", "closing"].includes(slide.layout))));
      slides[replaceAt] = { ...slides[replaceAt], ...riskSlide };
      changes.push("converted-slide-to-risk-checklist");
    } else {
      const insertAt = Math.max(1, slides.length - 1);
      slides.splice(insertAt, 0, riskSlide);
      changes.push("added-risk-checklist");
    }
  }

  return {
    deck: {
      ...deck,
      slides,
      summary: cleanClientText(deck.summary) || "已完成交付自检修复。"
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
  const clientTone = /客户|提案|对外|客户版/i.test(instruction);
  const premiumTone = /高级|克制|画册|品牌/i.test(instruction);
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
  const note = `已批量改写：${instruction}`;
  return base.includes(note) ? base : [base, note].filter(Boolean).join("；").slice(0, 180);
}

function shortenTitle(title = "") {
  return cleanClientText(title).replace(/^(关于|针对|基于)/, "").slice(0, 24) || "核心观点";
}

function shortenBullet(value = "") {
  const text = cleanClientText(value).replace(/^(首先|其次|同时|因此|所以)[，,、]*/, "");
  return text.length > 24 ? `${text.slice(0, 24)}…` : text;
}

function salesTitleForDeck(title = "", layout = "") {
  const clean = shortenTitle(title);
  if (layout === "pricing") return "价格梯度与主推档位";
  if (layout === "quote") return "客户可复述的成交话术";
  if (layout === "risk-checklist") return "成交前必须确认";
  if (/主推|成交|价格|行动/.test(clean)) return clean;
  return `${clean}：主推理由`;
}

function salesNotesForSlide(slide = {}) {
  const first = (slide.bullets || [])[0] || slide.subtitle || slide.title;
  return `这一页先讲结论，再讲客户为什么该选：${first}`;
}

function clientNotesForSlide(slide = {}) {
  const first = (slide.bullets || [])[0] || slide.title;
  return `对客户讲这一页时，避免内部术语，直接说明价值和依据：${first}`;
}

function normalizeClientList(value) {
  if (Array.isArray(value)) return value.map(cleanClientText).filter(Boolean);
  return String(value || "")
    .split(/\r?\n|[；;]/)
    .map(cleanClientText)
    .filter(Boolean);
}

function normalizeCanvasEdits(value = {}) {
  if (!value || typeof value !== "object") return null;
  const allowed = ["title", "subtitle", "bullets"];
  const result = {};
  for (const key of allowed) {
    const box = value[key]?.box;
    if (!box || typeof box !== "object") continue;
    result[key] = {
      box: {
        x: clampNumber(box.x, 0, 96),
        y: clampNumber(box.y, 0, 96),
        w: clampNumber(box.w, 8, 96),
        h: clampNumber(box.h, 5, 96)
      }
    };
  }
  return Object.keys(result).length ? result : null;
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
  if (/[ÃÂâ¤åç]/.test(value)) score -= 3;
  if (/[�]/.test(value)) score -= 8;
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
      const version = options.cacheBust ? `?v=${Math.round(fsSync.statSync(file).mtimeMs)}` : "";
      return `/outputs/${[job.id, "exports", "png", name].map(encodeURIComponent).join("/")}${version}`;
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
  const orderedKeys = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "PORT"];
  const lines = orderedKeys.map((key) => `${key}=${formatEnvValue(merged[key] || "")}`);
  const rest = Object.keys(merged)
    .filter((key) => !orderedKeys.includes(key))
    .sort()
    .map((key) => `${key}=${formatEnvValue(merged[key] || "")}`);
  await fs.writeFile(envPath, `${[...lines, ...rest].join("\n")}\n`, "utf8");
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
    const url = `${candidate}${endpoint}`;
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
  if (!/\/v\d+(\/|$)/.test(normalized)) candidates.push(`${normalized}/v1`);
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
  return `${value.slice(0, 5)}...${value.slice(-4)}`;
}
