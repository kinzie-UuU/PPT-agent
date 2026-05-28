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
import { addEvent, makeEvent } from "./events.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = 4180;
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
    pid: globalThis.process?.pid || null,
    port,
    uptime: globalThis.process?.uptime ? Math.round(globalThis.process.uptime()) : null,
    time: new Date().toISOString()
  });
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
  const materialBrief = buildMaterialBrief(extracted);
  materialBrief.preferences = {
    primaryProduct: req.body.primaryProduct || "",
    includeToc: req.body.includeToc !== false,
    includeRiskChecklist: req.body.includeRiskChecklist !== false
  };
  const input = { ...req.body, extracted, materialBrief };
  const ai = await generateDeckPlan(input, mode);
  const validated = validateDeck(ai.deck);
  const events = [
    makeEvent("upload", `读取 ${uploads.length} 个上传文件`, { files: uploads.map((file) => file.originalName) }),
    makeEvent("extract", materialBrief.summary || "资料已抽取", { charCount: materialBrief.charCount, pageCount: materialBrief.pageCount }),
    makeEvent(ai.aiUsed ? "ai" : "fallback", ai.aiUsed ? "已使用 AI 生成设计计划" : "未使用 AI，已采用本地资料驱动 fallback", { warning: ai.warning || null }),
    makeEvent("validate", `校验完成，${validated.warnings.length} 个提示`, { warnings: validated.warnings }),
    makeEvent("render", "开始生成 PPTX")
  ];
  const job = {
    id: makeId("job"),
    mode,
    status: "ready",
    input,
    deck: validated.deck,
    quality: enrichQuality(validated.quality, uploads, materialBrief),
    aiUsed: ai.aiUsed,
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
  job.previewImages = await renderPptxPreview(job.exports.pptx);
  addEvent(job, "preview", job.previewImages.length ? `已生成 ${job.previewImages.length} 张预览图` : "未生成预览图，可能缺少 PowerPoint 导出能力", { count: job.previewImages.length });
  await saveJob(job);
  res.json(toClientJob(job));
}

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
    const validated = validateDeck(result.deck);
    job.deck = validated.deck;
    job.quality = enrichQuality(validated.quality, job.files || [], job.input?.materialBrief);
    job.aiUsed = job.aiUsed || result.aiUsed;
    job.warning = [result.warning, ...validated.warnings].filter(Boolean).join("；") || job.warning;
    const afterLayout = job.deck?.slides?.[slideIndex]?.layout || null;
    addEvent(job, result.aiUsed ? "revise" : "fallback", `第 ${slideIndex + 1} 页已应用修改指令`, { instruction: req.body.instruction || "", beforeLayout, afterLayout, warnings: validated.warnings });
    job.updatedAt = new Date().toISOString();
    job.exports.pptx = await buildDeck(job);
    job.exportMeta = collectExportMeta(job.exports);
    addEvent(job, "rendered", "修改后 PPTX 已重新生成", { pptx: job.exports.pptx });
    job.previewImages = await renderPptxPreview(job.exports.pptx);
    addEvent(job, "preview", job.previewImages.length ? `已刷新 ${job.previewImages.length} 张预览图` : "未生成预览图，可能缺少 PowerPoint 导出能力", { count: job.previewImages.length });
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
      title: cleanClientText(incoming.title) || currentSlide.title,
      subtitle: cleanClientText(incoming.subtitle),
      visualIntent: cleanClientText(incoming.visualIntent) || currentSlide.visualIntent,
      speakerNotes: cleanClientText(incoming.speakerNotes),
      bullets: normalizeClientList(incoming.bullets),
      dataPoints: normalizeClientList(incoming.dataPoints),
      imageSlots: normalizeClientList(incoming.imageSlots)
    };
    job.deck = {
      ...job.deck,
      slides: job.deck.slides.map((slide, index) => (index === slideIndex ? nextSlide : slide))
    };
    const validated = validateDeck(job.deck);
    job.deck = validated.deck;
    job.quality = enrichQuality(validated.quality, job.files || [], job.input?.materialBrief);
    job.warning = validated.warnings.length ? validated.warnings.join("；") : job.warning;
    addEvent(job, "manual-edit", `第 ${slideIndex + 1} 页文字已手动保存`, { warnings: validated.warnings });
    job.updatedAt = new Date().toISOString();
    job.exports.pptx = await buildDeck(job);
    job.exportMeta = collectExportMeta(job.exports);
    job.previewImages = await renderPptxPreview(job.exports.pptx);
    addEvent(job, "preview", job.previewImages.length ? `已刷新 ${job.previewImages.length} 张预览图` : "未生成预览图，可能缺少 PowerPoint 导出能力", { count: job.previewImages.length });
    await saveJob(job);
    res.json(toClientJob(job));
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
try {
  await fs.access(distDir);
  app.use(express.static(distDir));
  app.get("*", (_req, res) => res.sendFile(path.join(distDir, "index.html")));
} catch {
  const vite = await import("vite");
  const viteServer = await vite.createServer({
    root: rootDir,
    server: { middlewareMode: true },
    appType: "spa"
  });
  app.use(viteServer.middlewares);
}

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: error.message || "服务器错误" });
});

app.listen(port, () => {
  console.log(`PPT Design Tool running at http://127.0.0.1:${port}`);
});

function toClientJob(job) {
  const toOutputUrl = (file) => {
    if (!file) return file;
    if (Array.isArray(file)) return file.map(toOutputUrl);
    if (typeof file !== "string") return file;
    const normalized = path.normalize(file);
    if (!normalized.startsWith(outputDir) || !fsSync.existsSync(normalized)) return null;
    const relative = path.relative(outputDir, normalized).split(path.sep).map(encodeURIComponent).join("/");
    return `/outputs/${relative}`;
  };
  const previewImages = (job.previewImages || []).map(toOutputUrl);
  return {
    ...job,
    input: normalizeInput(job.input),
    files: (job.files || []).map(normalizeUploadRecord),
    exports: Object.fromEntries(Object.entries(job.exports || {}).map(([key, value]) => [key, toOutputUrl(value)])),
    exportMeta: job.exportMeta || collectExportMeta(job.exports || {}),
    previewImages: previewImages.length && previewImages.every(Boolean) ? previewImages : repairPreviewImages(job)
  };
}

function enrichQuality(quality, files = [], materialBrief = {}) {
  const imageCount = (files || []).filter((file) => /\.(png|jpe?g|svg|webp)$/i.test(file.originalName || file.path || "") || /^image\//.test(file.mimeType || "")).length;
  return {
    ...quality,
    imageCount,
    material: {
      fileCount: materialBrief?.fileCount || files.length || 0,
      charCount: materialBrief?.charCount || 0,
      pageCount: materialBrief?.pageCount || null,
      productCount: materialBrief?.productCandidates?.length || 0,
      structuredProductCount: materialBrief?.products?.length || 0,
      priceCount: materialBrief?.prices?.length || 0,
      highlightCount: materialBrief?.highlights?.length || 0
    }
  };
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

function repairPreviewImages(job) {
  const pngDir = path.join(outputDir, job.id, "exports", "png");
  if (!fsSync.existsSync(pngDir)) return [];
  return fsSync.readdirSync(pngDir)
    .filter((name) => name.toLowerCase().endsWith(".png"))
    .sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }))
    .map((name) => `/outputs/${[job.id, "exports", "png", name].map(encodeURIComponent).join("/")}`);
}
