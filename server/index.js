import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fsSync from "fs";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import { addUpload, ensureDirs, getJob, getUploads, listJobs, makeId, outputDir, rootDir, saveJob, uploadDir } from "./store.js";
import { buildDeck, exportWithPowerPoint, extractText, renderPptxPreview } from "./ppt.js";
import { generateDeckPlan, reviseSlide } from "./ai.js";
import { validateDeck } from "./validateDeck.js";
import { getDesignSystem } from "./designSystem.js";
import { buildMaterialBrief } from "./materialBrief.js";
import { routeDeck } from "./deckRouter.js";
import { addEvent, makeEvent } from "./events.js";

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

app.post("/api/uploads", upload.array("files"), async (req, res, next) => {
  try {
    const records = [];
    for (const file of req.files || []) records.push(await addUpload(file));
    res.json({ files: records });
  } catch (error) {
    next(error);
  }
});

async function createJob(req, res, mode) {
  const uploads = await getUploads(req.body.fileIds || []);
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
  const baseRoutePlan = routeDeck({ mode, input: req.body, materialBrief, uploads });
  const routePlan = applyOutlinePlan(baseRoutePlan, req.body.outlinePlan);
  const input = { ...req.body, extracted, materialBrief, routePlan };
  const ai = await generateDeckPlan(input, mode);
  const validated = validateDeck(ai.deck, routePlan);
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

app.post("/api/jobs/outline", async (req, res, next) => {
  try {
    const uploads = await getUploads(req.body.fileIds || []);
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
        productCount: materialBrief.productCandidates?.length || 0
      }
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs/generate", async (req, res, next) => {
  try {
    await createJob(req, res, "generate");
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs/optimize", async (req, res, next) => {
  try {
    await createJob(req, res, "optimize");
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

app.get("/api/design-system", (_req, res) => {
  res.json(getDesignSystem());
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
      imageSlots: normalizeClientList(incoming.imageSlots)
    };
    pushUndo(job, `撤销第 ${slideIndex + 1} 页手动编辑`);
    job.deck = {
      ...job.deck,
      slides: job.deck.slides.map((slide, index) => (index === slideIndex ? nextSlide : slide))
    };
    const routePlan = job.input?.routePlan || null;
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
    } else if (action === "insert-after") {
      const layout = cleanClientText(req.body.layout) || "section";
      const defaults = getInsertedSlideDefaults(layout);
      nextSlides.splice(slideIndex + 1, 0, {
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
      nextIndex = slideIndex + 1;
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
    } else {
      return res.status(400).json({ error: "未知页面操作" });
    }
    pushUndo(job, `撤销页面操作：${action}`);
    job.deck = { ...job.deck, slides: nextSlides };
    const routePlan = job.input?.routePlan || null;
    const validated = validateDeck(job.deck, routePlan);
    job.deck = validated.deck;
    job.quality = enrichQuality(validated.quality, job.files || [], job.input?.materialBrief, routePlan);
    job.warning = validated.warnings.length ? validated.warnings.join("；") : job.warning;
    addEvent(job, "slide-action", `页面操作完成：${action}`, { action, from: slideIndex, to: nextIndex, slideCount: job.deck.slides.length });
    job.updatedAt = new Date().toISOString();
    job.exports.pptx = await buildDeck(job);
    job.exportMeta = collectExportMeta(job.exports);
    await refreshPreview(job, "页面结构已刷新");
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
  return {
    ...publicJob,
    canUndo: Boolean(job.undoStack?.length),
    undoLabel: job.undoStack?.at(-1)?.label || null,
    input: normalizeInput(job.input),
    files: (job.files || []).map(normalizeUploadRecord),
    exports: Object.fromEntries(Object.entries(job.exports || {}).map(([key, value]) => [key, toOutputUrl(value)])),
    exportMeta: job.exportMeta || collectExportMeta(job.exports || {}),
    previewImages: previewImages.length && previewImages.every(Boolean) ? previewImages : repairPreviewImages(job, { cacheBust: true })
  };
}

function enrichQuality(quality, files = [], materialBrief = {}, routePlan = null) {
  const imageCount = (files || []).filter((file) => /\.(png|jpe?g|svg|webp)$/i.test(file.originalName || file.path || "") || /^image\//.test(file.mimeType || "")).length;
  return {
    ...quality,
    imageCount,
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
      productCount: materialBrief?.productCandidates?.length || 0,
      structuredProductCount: materialBrief?.products?.length || 0,
      priceCount: materialBrief?.prices?.length || 0,
      highlightCount: materialBrief?.highlights?.length || 0
    }
  };
}

async function refreshPreview(job, successVerb = "已生成") {
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

function normalizeInput(input = {}) {
  return {
    ...input,
    extracted: (input.extracted || []).map((item) => ({ ...item, name: decodeMaybeMojibake(item.name) }))
  };
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
    imageSlots: Array.isArray(step.imageSlots) ? step.imageSlots.map(cleanClientText).filter(Boolean) : []
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
