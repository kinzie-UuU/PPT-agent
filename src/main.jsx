import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const FALLBACK_THEMES = [
  { name: "轻盈渐变风", bestFor: "销售战卡、客户提案、节日礼盒", colors: { bg: "F7FBFF", accent: "3158D4", soft: "EAF1FF" } },
  { name: "东方自然风", bestFor: "节日礼盒、文化产品、高级方案", colors: { bg: "F7F3EA", accent: "68745E", soft: "EDE6D8" } },
  { name: "黑白画册风", bestFor: "品牌手册、设计汇报、高端产品介绍", colors: { bg: "FFFFFF", accent: "111111", soft: "EFEFEF" } },
  { name: "蓝白科技风", bestFor: "技术方案、产品分析、数据汇报", colors: { bg: "F6FAFF", accent: "3546A4", soft: "DDE8FF" } },
  { name: "暗黑科技风", bestFor: "新品发布、技术演示、趋势报告", colors: { bg: "05070B", accent: "19D3FF", soft: "111827" } }
];

const FALLBACK_TEMPLATE_PACKS = [
  { themeName: "轻盈渐变风", name: "销售提案 / 战卡方向", scenario: "销售战卡、客户提案、节日礼盒", coreLayouts: ["pricing", "product-detail", "quote", "risk-checklist"] },
  { themeName: "东方自然风", name: "礼盒 / 节日 / 文化产品方向", scenario: "节日礼盒、食品茶饮、文化产品", coreLayouts: ["visual", "product-detail", "bundle", "pricing"] },
  { themeName: "黑白画册风", name: "品牌画册 / 高端产品方向", scenario: "品牌手册、设计汇报、高端产品介绍", coreLayouts: ["section", "visual", "quote", "product-detail"] },
  { themeName: "蓝白科技风", name: "技术方案 / 数据汇报方向", scenario: "技术方案、产品分析、数据汇报", coreLayouts: ["toc", "kpi", "compare", "timeline"] },
  { themeName: "暗黑科技风", name: "发布会 / 趋势报告方向", scenario: "新品发布、技术演示、趋势报告", coreLayouts: ["cover", "kpi", "timeline", "closing"] }
];

const DESIGN_LED_INSTRUCTION = [
  "高级设计优化：不管是上传旧 PPT/PDF/图片，还是纯聊天生成，都按视觉优先的提案级 PPT 处理。",
  "必须先判断内容类型：销售提案、案例作品集、产品介绍、品牌手册、项目汇报、培训课件、招商方案或数据报告。",
  "必须抽取视觉 DNA：主色、背景、字体气质、图片语言、Logo/品牌露出、留白、装饰语言和页面密度。",
  "每页按内容角色选择固定版式策略：封面、案例大图、产品画廊、方案配置、对比矩阵、时间线、数据证据、风险清单、总结页。",
  "设计优先：图片/图表/证据优先，正文压缩，标题必须强，页面不能全部做成同一种卡片。",
  "输出必须是可在线编辑 PPTX：文字、图片、形状独立可编辑，不允许整页截图化。",
  "生成后视觉自检：如果像普通模板、文字过密、图片太小、层级弱、风格不统一或可编辑性不足，就自动返工。"
].join("\n");

const LAYOUT_LABELS = {
  cover: "封面",
  visual: "主视觉",
  section: "章节",
  toc: "目录",
  kpi: "数据",
  pricing: "价格",
  "product-detail": "单品",
  bundle: "组合",
  "risk-checklist": "清单",
  compare: "对比",
  timeline: "流程",
  cards: "卡片",
  quote: "观点",
  closing: "收尾"
};

const QUICK_ACTIONS = ["标题更销售化", "改成价格梯度页", "讲稿更口语", "减少文字更高级", "强化下一步动作"];
const DECK_ACTIONS = ["整份减少文字更高级", "改成客户提案口吻", "强化销售话术和下一步行动", "改成技术数据汇报风格"];

const cp = (...codes) => String.fromCodePoint(...codes);
const UI = {
  current: cp(0x5f53, 0x524d),
  done: cp(0x5b8c, 0x6210),
  pending: cp(0x5f85, 0x5904, 0x7406),
  optional: cp(0x53ef, 0x9009),
  editable: cp(0x53ef, 0x7f16, 0x8f91),
  waitingGenerate: cp(0x5f85, 0x751f, 0x6210),
  exportable: cp(0x53ef, 0x5bfc, 0x51fa),
  pages: cp(0x9875, 0x9762),
  materials: cp(0x7d20, 0x6750),
  data: cp(0x8d44, 0x6599),
  outline: cp(0x5927, 0x7eb2),
  uploadTitle: cp(0x4e0a, 0x4f20, 0x8d44, 0x6599),
  promptPlaceholder: cp(0x8f93, 0x5165, 0x9700, 0x6c42, 0xff0c, 0x6216, 0x4e0a, 0x4f20, 0x8d44, 0x6599),
  uploadHint: cp(0x53ef, 0x4e0a, 0x4f20) + " PPTX / DOCX / XLSX / PDF / " + cp(0x56fe, 0x7247) + " / SVG",
  sendOutline: cp(0x53d1, 0x9001, 0x5e76, 0x751f, 0x6210, 0x5927, 0x7eb2),
  keepSourceOutline: cp(0x6309, 0x539f) + " PPT " + cp(0x5927, 0x7eb2, 0x4f18, 0x5316),
  keepSourceDesc: cp(0x4fdd, 0x7559, 0x9875, 0x5e8f, 0x3001, 0x4e3b, 0x9898, 0x548c, 0x539f, 0x9875, 0x7d20, 0x6750),
  regenerateOutline: cp(0x91cd, 0x65b0, 0x751f, 0x6210, 0x5927, 0x7eb2),
  regenerateDesc: cp(0x91cd, 0x65b0, 0x7ec4, 0x7ec7, 0x53d9, 0x4e8b, 0x548c, 0x9875, 0x5e8f),
  delete: cp(0x5220, 0x9664)
};

const STEPS = [
  { id: "materials", number: "01", title: "资料识别", desc: "抽文本 / 图片 / 素材身份" },
  { id: "outline", number: "02", title: "大纲规划", desc: "页面角色和叙事路线" },
  { id: "generate", number: "03", title: "视觉方向", desc: "codex-ppt visual target" },
  { id: "visual-project", number: "04", title: "逐页生成", desc: "prompts / origin_image" },
  { id: "visual-qa", number: "05", title: "视觉 QA", desc: "contact sheet / 视觉稿" },
  { id: "preview", number: "06", title: "可编辑重建", desc: "Hybrid SceneGraph" },
  { id: "feedback", number: "07", title: "一致性 QA", desc: "视觉目标 vs 可编辑" },
  { id: "export", number: "08", title: "导出", desc: "editable-final.pptx" }
];

const api = {
  async upload(files) {
    const form = new FormData();
    [...files].forEach((file) => form.append("files", file));
    const response = await fetch("/api/uploads", { method: "POST", body: form });
    return readJson(response);
  },
  async create(path, body) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return readJson(response);
  },
  async remove(path) {
    const response = await fetch(path, { method: "DELETE" });
    return readJson(response);
  },
  async jobs() {
    const response = await fetch("/api/jobs");
    return readJson(response);
  },
  async job(id) {
    const response = await fetch(`/api/jobs/${id}`);
    return readJson(response);
  },
  async designSystem() {
    const response = await fetch("/api/design-system");
    return readJson(response);
  },
  async health(signal) {
    const response = await fetch("/api/health", { cache: "no-store", signal });
    return readJson(response);
  },
  async localImageStatus(signal) {
    const response = await fetch("/api/local-image/status", { cache: "no-store", signal });
    return readJson(response);
  },
  async rescanLocalImageQa(id) {
    return this.create(`/api/jobs/${id}/rescan-local-image-qa`, {});
  },
  async generateVisualTargetSample(id) {
    return this.create(`/api/jobs/${id}/visual-target/sample`, {});
  },
  async generateVisualProjectSlides(id, body = {}) {
    return this.create(`/api/jobs/${id}/visual-project/generate`, body);
  },
  async config() {
    const response = await fetch("/api/config", { cache: "no-store" });
    return readJson(response);
  },
  async saveConfig(body) {
    return this.create("/api/config", body);
  },
  async testConfig(body) {
    return this.create("/api/config/test", body);
  },
  async models(body) {
    return this.create("/api/config/models", body);
  },
  async styleReferences() {
    const response = await fetch("/api/style-references", { cache: "no-store" });
    return readJson(response);
  },
  async uploadStyleReferences(files, meta = {}) {
    const form = new FormData();
    [...files].forEach((file) => form.append("files", file));
    Object.entries(meta).forEach(([key, value]) => form.append(key, value || ""));
    const response = await fetch("/api/style-references", { method: "POST", body: form });
    return readJson(response);
  },
  async deleteStyleReference(id) {
    const response = await fetch(`/api/style-references/${id}`, { method: "DELETE" });
    return readJson(response);
  },
};

async function readJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function getErrorMessage(error) {
  const message = error?.message || String(error || "");
  if (/Failed to fetch|fetch failed|NetworkError|Load failed/i.test(message)) {
    return "本地服务连接失败，请刷新页面或确认服务已启动。";
  }
  if (/abort/i.test(message)) return "本地服务响应超时，请稍后重试。";
  return message || "请求失败，请稍后重试。";
}

function isConnectionError(message = "") {
  return /Failed to fetch|fetch failed|NetworkError|Load failed|本地服务连接失败|本地服务响应超时/i.test(message);
}

function uniqueIds(ids = []) {
  return [...new Set(ids.filter(Boolean))];
}

function mergeById(current = [], incoming = []) {
  const byId = new Map((current || []).filter((item) => item?.id).map((item) => [item.id, item]));
  for (const item of incoming || []) {
    if (!item?.id) continue;
    byId.set(item.id, { ...(byId.get(item.id) || {}), ...item });
  }
  return [...byId.values()];
}

function App() {
  const [form, setForm] = useState({
    projectName: "2026 端午礼盒",
    audience: "销售团队内部战卡",
    pageCount: "系统推荐",
    notes: "",
    style: "轻盈渐变风",
    copyMode: "先确认每页文案，再排版",
    outlineStrategy: "keep-source",
    primaryProduct: "",
    includeToc: true,
    includeRiskChecklist: true
  });
  const [fileIds, setFileIds] = useState([]);
  const [files, setFiles] = useState([]);
  const [job, setJob] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [selectedSlide, setSelectedSlide] = useState(0);
  const [revision, setRevision] = useState("");
  const [deckRevision, setDeckRevision] = useState("");
  const [outlinePlan, setOutlinePlan] = useState(null);
  const [outlineBusy, setOutlineBusy] = useState(false);
  const [outlineBrief, setOutlineBrief] = useState(null);
  const [outlineInsertLayout, setOutlineInsertLayout] = useState("section");
  const [formats, setFormats] = useState(["pptx", "pdf", "png"]);
  const [themes, setThemes] = useState(FALLBACK_THEMES);
  const [templatePacks, setTemplatePacks] = useState(FALLBACK_TEMPLATE_PACKS);
  const [skillRules, setSkillRules] = useState({});
  const [styleReferences, setStyleReferences] = useState([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [generationProgress, setGenerationProgress] = useState({ active: false, mode: "", value: 0, label: "" });
  const [stylePreviewJob, setStylePreviewJob] = useState(null);
  const [stylePreviewBusy, setStylePreviewBusy] = useState(false);
  const [styleConfirmed, setStyleConfirmed] = useState(false);
  const [intakeDraft, setIntakeDraft] = useState("");
  const [intakeMessages, setIntakeMessages] = useState([]);
  const [rating, setRating] = useState(4);
  const [comment, setComment] = useState("");
  const [activeStep, setActiveStep] = useState("materials");
  const [rightPanelMode, setRightPanelMode] = useState("closed");
  const [focusPreview, setFocusPreview] = useState(false);
  const [connection, setConnection] = useState({ state: "checking", message: "正在检查本地服务..." });
  const [localImage, setLocalImage] = useState({ state: "checking", message: "正在检查本地生图..." });
  const [previewBusy, setPreviewBusy] = useState(false);
  const [templateBusy, setTemplateBusy] = useState(false);
  const [apiConfig, setApiConfig] = useState({ apiKey: "", maskedApiKey: "", hasApiKey: false, baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" });
  const [availableModels, setAvailableModels] = useState([]);
  const [settingsStatus, setSettingsStatus] = useState("");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [draft, setDraft] = useState(makeSlideDraft(null));
  const [insertLayout, setInsertLayout] = useState("section");
  const [draggedSlide, setDraggedSlide] = useState(null);
  const [dropTargetSlide, setDropTargetSlide] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);

  useEffect(() => {
    api.jobs().then((data) => {
      const nextJobs = data.jobs || [];
      setJobs(nextJobs);
      const startupJob = nextJobs.find((item) => isFullDeckJob(item) && isPreferredStartupJob(item))
        || nextJobs.find((item) => isFullDeckJob(item) && isRestorableJob(item))
        || nextJobs.find(isPreferredStartupJob)
        || nextJobs.find(isRestorableJob)
        || null;
      setJob(startupJob);
      setFiles(startupJob?.files || []);
      setFileIds((startupJob?.files || []).map((file) => file.id).filter(Boolean));
      setSelectedSlide(0);
      setActiveStep(startupJob ? "preview" : "materials");
      setStatus(startupJob ? "已恢复最近任务" : "");
    }).catch(() => {});
    api.designSystem().then((data) => {
      const nextThemes = data.themes || [];
      if (nextThemes.length && !nextThemes.some((theme) => isMojibake(theme.name || theme.bestFor))) setThemes(nextThemes);
      const nextPacks = data.templatePacks || [];
      if (nextPacks.length && !nextPacks.some((pack) => isMojibake(pack.name || pack.scenario))) setTemplatePacks(nextPacks);
      setSkillRules(data.skillRules || {});
      setStyleReferences(data.styleReferences || []);
    }).catch(() => {});
    api.styleReferences().then((data) => setStyleReferences(data.references || [])).catch(() => {});
    api.config().then((data) => {
      setApiConfig((current) => ({ ...current, ...data, apiKey: "" }));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    let active = true;
    async function checkLocalImage() {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 3500);
      try {
        const data = await api.localImageStatus(controller.signal);
        if (!active) return;
        setLocalImage({
          state: data.ok ? "online" : "offline",
          message: data.ok ? `${data.provider || "本地生图"} 已连接` : (data.reason || "本地生图未就绪"),
          details: data
        });
      } catch {
        if (!active) return;
        setLocalImage({ state: "offline", message: "本地 Z-Image 未连接" });
      } finally {
        window.clearTimeout(timer);
      }
    }
    checkLocalImage();
    const interval = window.setInterval(checkLocalImage, 15000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let active = true;
    async function checkHealth() {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 2500);
      try {
        const data = await api.health(controller.signal);
        if (!active) return;
        setConnection({
          state: "online",
          message: data.uptime ? `本地在线 ${formatDuration(data.uptime)}` : "本地在线",
          details: data
        });
        setError((current) => (isConnectionError(current) ? "" : current));
      } catch {
        if (!active) return;
        setConnection({ state: "offline", message: "本地服务离线，请重新启动后刷新。" });
      } finally {
        window.clearTimeout(timer);
      }
    }
    checkHealth();
    const interval = window.setInterval(checkHealth, 8000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  const slides = job?.deck?.slides || [];
  const currentSlide = slides[selectedSlide];
  const currentImage = job?.previewImages?.[selectedSlide];
  const savedDraft = useMemo(() => makeSlideDraft(currentSlide), [currentSlide]);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(savedDraft), [draft, savedDraft]);
  const liveSlide = useMemo(() => draftToSlide(currentSlide, draft), [currentSlide, draft]);
  const currentTemplate = getCurrentTemplate(job, templatePacks);
  const currentStyle = job?.input?.style || job?.quality?.routePlan?.recommendedTheme || "";
  const templateHit = getTemplateRenderHit(currentTemplate, dirty ? liveSlide : currentSlide);
  const selectedFileNames = useMemo(() => files.map((file) => file.originalName).join("、"), [files]);
  const hasUploadedMaterials = files.length > 0;
  const intakeReadiness = useMemo(() => getIntakeReadiness(form.notes, files), [form.notes, files]);
  const inferredMaterials = useMemo(() => inferMaterialTypes(files), [files]);
  const completion = useMemo(() => getCompletion({ form, fileIds, job }), [form, fileIds, job]);
  const stepState = useMemo(() => getStepState({ activeStep, fileIds, job, formats }), [activeStep, fileIds, job, formats]);
  const finalExportBlocked = isJobBlockedForFinal(job);

  const topbarStateClass = error || connection.state === "offline" ? "state-dot error" : connection.state === "online" ? "state-dot active" : "state-dot checking";
  const topbarMessage = error || status || connection.message || "准备就绪";

  useEffect(() => {
    setDraft(makeSlideDraft(currentSlide));
  }, [currentSlide, selectedSlide]);

  useEffect(() => {
    function handleKeydown(event) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && job && dirty) {
        event.preventDefault();
        saveSlideText(draft);
      }
    }
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [dirty, draft, job]);

  useEffect(() => {
    if (!generationProgress.active) return undefined;
    const timer = window.setInterval(() => {
      setGenerationProgress((current) => {
        if (!current.active) return current;
        const nextValue = Math.min(92, current.value + (current.value < 50 ? 9 : current.value < 78 ? 5 : 2));
        return { ...current, value: nextValue, label: generationProgressLabel(nextValue, current.mode) };
      });
    }, 900);
    return () => window.clearInterval(timer);
  }, [generationProgress.active]);

  function update(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
    if (name === "style") {
      setStyleConfirmed(false);
      setStylePreviewJob(null);
    }
  }

  function updateDraft(name, value) {
    setDraft((current) => ({ ...current, [name]: value }));
  }

  function submitIntakeMessage() {
    const text = intakeDraft.trim();
    if (!text && fileIds.length === 0) return;
    const userText = text || "我已上传资料，请先理解内容。";
    const intent = analyzeIntakeMessage(userText, { files, notes: form.notes });
    const now = Date.now();
    setIntakeMessages((current) => [
      ...current,
      { id: `user-${now}`, role: "user", text: userText },
      { id: `assistant-${now}`, role: "assistant", text: intent.reply, kind: intent.kind }
    ]);
    if (text && intent.actionable) {
      setForm((current) => ({ ...current, notes: [current.notes, text].filter(Boolean).join("\n") }));
    }
    setIntakeDraft("");
    setError("");
    setStatus(intent.actionable ? "已记录这条需求，可以继续补充，或让系统开始理解并生成大纲。" : "已作为对话处理，没有把它当成 PPT 需求。");
  }

  function handleIntakeKeyDown(event) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent?.isComposing) return;
    event.preventDefault();
    submitIntakeMessage();
  }

  function validatePreparation(nextForm = form) {
    if (!nextForm.notes.trim() && fileIds.length === 0) {
      setError("请至少填写一句话需求，或上传一份资料。");
      setStatus("");
      setActiveStep("materials");
      return false;
    }
    return true;
  }

  async function uploadFiles(event) {
    setError("");
    setStatus("正在上传资料...");
    try {
      const data = await api.upload(event.target.files);
      const uploaded = data.files || [];
      setFiles((current) => mergeById(current, uploaded));
      setFileIds((current) => uniqueIds([...current, ...uploaded.map((file) => file.id)]));
      if (uploaded.length) {
        const names = uploaded.map((file) => file.originalName).filter(Boolean).join("、");
        const now = Date.now();
        setIntakeMessages((current) => [
          ...current,
          { id: `upload-${now}`, role: "user", text: `上传了 ${uploaded.length} 个资料：${names}` },
          { id: `upload-reply-${now}`, role: "assistant", text: "已收到资料。现在可以选择保留原稿结构优化，或重新规划叙事；也可以继续补充你的目标、受众和风格要求。" }
        ]);
      }
      setStylePreviewJob(null);
      setStyleConfirmed(false);
      setStatus("资料已上传，可以继续补充需求或开始生成。");
      setRightPanelMode("edit");
    } catch (err) {
      setError(getErrorMessage(err));
      setStatus("");
    } finally {
      event.target.value = "";
    }
  }

  async function removeUploadedFile(file) {
    if (!file?.id) return;
    if (!window.confirm(`删除已上传文件「${file.originalName || file.id}」？本地源文件也会删除。`)) return;
    setError("");
    setStatus("正在删除上传文件...");
    try {
      await api.remove(`/api/uploads/${file.id}`);
      setFiles((current) => current.filter((item) => item.id !== file.id));
      setFileIds((current) => current.filter((id) => id !== file.id));
      setStylePreviewJob(null);
      setStyleConfirmed(false);
      setStatus("上传文件已删除。");
    } catch (err) {
      const message = getErrorMessage(err);
      if (!isConnectionError(message)) {
        setFiles((current) => current.filter((item) => item.id !== file.id));
        setFileIds((current) => current.filter((id) => id !== file.id));
        setError("");
        setStatus("文件记录已清理。");
      } else {
        setError(message);
        setStatus("");
      }
    }
  }

  async function createJob(mode, confirmedOutline = null) {
    if (!validatePreparation()) return;
    const requestForm = getRequestFormForFiles(form);
    setError("");
    setStatus(mode === "optimize" ? "正在解析旧 PPT 并生成新版..." : "正在生成新 PPT...");
    setGenerationProgress({
      active: true,
      mode,
      value: 8,
      label: mode === "optimize" ? "正在读取旧稿内容" : "正在整理资料和生成路线"
    });
    try {
      const data = await api.create(mode === "optimize" ? "/api/jobs/optimize" : "/api/jobs/generate", {
        ...requestForm,
        projectName: getEffectiveProjectName(requestForm, files),
        fileIds,
        materials: inferredMaterials,
        outlinePlan: confirmedOutline,
        styleProofJobId: stylePreviewJob?.id || "",
        mode
      });
      setJob(data);
      setSelectedSlide(0);
      setActiveStep(data.visualProject?.generatedImages || data.visualTarget?.sample?.imageUrl ? "visual-qa" : "preview");
      setRightPanelMode("status");
      setJobs((current) => [data, ...current.filter((item) => item.id !== data.id)]);
      setStatus(data.warning || "一键链路已完成：可先审阅视觉目标与可编辑结果，再进入在线编辑或导出。");
      setGenerationProgress({ active: false, mode: "", value: 100, label: "生成完成" });
    } catch (err) {
      setError(getErrorMessage(err));
      setStatus("");
      setGenerationProgress({ active: false, mode: "", value: 0, label: "" });
    }
  }

  function getGenerationMode() {
    return files.some((file) => /\.(ppt|pptx)$/i.test(file.originalName || "")) ? "optimize" : "generate";
  }

  function getRequestFormForFiles(current = form) {
    return hasUploadedMaterials ? current : { ...current, outlineStrategy: "regenerate" };
  }

  async function createStylePreview(confirmedOutline = null) {
    if (!validatePreparation()) return;
    const mode = getGenerationMode();
    const requestForm = getRequestFormForFiles(form);
    setError("");
    setStylePreviewBusy(true);
    setStyleConfirmed(false);
    setStatus("正在生成主视觉方向图...");
    setGenerationProgress({
      active: true,
      mode: "style-preview",
      value: 10,
      label: "正在整理视觉方向资料和参考"
    });
    try {
      const data = await api.create("/api/jobs/style-preview", {
        ...requestForm,
        projectName: getEffectiveProjectName(requestForm, files),
        fileIds,
        materials: inferredMaterials,
        outlinePlan: confirmedOutline,
        mode
      });
      setStylePreviewJob(data);
      setJobs((current) => [data, ...current.filter((item) => item.id !== data.id)]);
      setStatus(data.warning || "主视觉方向已生成；满意就采用方向，不满意就重做方向。");
      setGenerationProgress({ active: false, mode: "", value: 100, label: "视觉方向生成完成" });
    } catch (err) {
      setError(getErrorMessage(err));
      setStatus("");
      setGenerationProgress({ active: false, mode: "", value: 0, label: "" });
    } finally {
      setStylePreviewBusy(false);
    }
  }

  function buildDesignLedForm(current = form) {
    const existingNotes = String(current.notes || "").trim();
    const notes = existingNotes && existingNotes.includes("高级设计优化")
      ? existingNotes
      : [existingNotes, DESIGN_LED_INSTRUCTION].filter(Boolean).join("\n\n");
    return {
      ...current,
      audience: current.audience || "对外展示 / 提案沟通 / 视觉化表达",
      copyMode: "高级设计优化：视觉优先，标题优先，图片优先，可编辑交付",
      reconstructionMode: "design-led",
      designDirectorMode: true,
      designPriority: "visual-first",
      editableOutput: true,
      outlineStrategy: "keep-source",
      includeToc: current.includeToc,
      includeRiskChecklist: true,
      notes
    };
  }

  async function activateDesignLedMode() {
    const nextForm = buildDesignLedForm();
    setForm(nextForm);
    setStylePreviewJob(null);
    setStyleConfirmed(false);
    setStatus("已切换为高级设计优化：视觉优先、可编辑交付，正在生成设计重构大纲...");
    await planOutline(nextForm);
  }

  async function planOutline(formOverride = null) {
    const requestForm = getRequestFormForFiles(formOverride || form);
    if (!validatePreparation(requestForm)) return;
    setError("");
    setOutlineBusy(true);
    setStatus("正在生成可确认大纲...");
    try {
      const data = await api.create("/api/jobs/outline", {
        ...requestForm,
        projectName: getEffectiveProjectName(requestForm, files),
        fileIds,
        materials: inferredMaterials,
        mode: getGenerationMode()
      });
      setOutlinePlan(data.outlinePlan || null);
      setStylePreviewJob(null);
      setStyleConfirmed(false);
      setOutlineBrief(data.materialBrief || null);
      setStatus("大纲已生成，可以调整后按确认大纲生成。");
      setActiveStep("outline");
      setRightPanelMode("edit");
    } catch (err) {
      setError(getErrorMessage(err));
      setStatus("");
    } finally {
      setOutlineBusy(false);
    }
  }

  async function revise() {
    if (!job || !revision.trim()) return;
    setError("");
    setStatus("正在修改当前页...");
    try {
      const data = await api.create(`/api/jobs/${job.id}/slides/${selectedSlide}/revise`, { instruction: revision });
      setJob(data);
      setRevision("");
      setStatus(data.warning || "当前页已更新。");
    } catch (err) {
      setError(getErrorMessage(err));
      setStatus("");
    }
  }

  async function rewriteDeck() {
    if (!job || !deckRevision.trim()) return;
    setError("");
    setStatus("正在批量改写整份 PPT...");
    try {
      const data = await api.create(`/api/jobs/${job.id}/rewrite`, { instruction: deckRevision });
      setJob(data);
      setJobs((current) => [data, ...current.filter((item) => item.id !== data.id)]);
      setDeckRevision("");
      setStatus(data.previewWarning || "整份 PPT 已批量改写，PPTX 和预览已刷新。");
      setRightPanelMode("edit");
    } catch (err) {
      setError(getErrorMessage(err));
      setStatus("");
    }
  }

  async function repairDelivery() {
    if (!job) return;
    setError("");
    setStatus("正在按交付自检修复 PPT...");
    try {
      const data = await api.create(`/api/jobs/${job.id}/repair`, {});
      setJob(data);
      setJobs((current) => [data, ...current.filter((item) => item.id !== data.id)]);
      setStatus(data.previewWarning || "交付自检修复完成，PPTX 和预览已刷新。");
      setRightPanelMode("status");
    } catch (err) {
      setError(getErrorMessage(err));
      setStatus("");
    }
  }

  async function applyImageSupplement() {
    if (!job?.imageSupplementPlan?.needed) return;
    setError("");
    setStatus("正在按补图计划复用原稿图片并重绘视觉方向...");
    try {
      const data = await api.create(`/api/jobs/${job.id}/apply-image-supplement`, {});
      setJob(data);
      setJobs((current) => [data, ...current.filter((item) => item.id !== data.id)]);
      setStatus(data.warning || data.previewWarning || "补图计划已执行，PPTX、预览图和云端视觉复审已刷新。");
      setRightPanelMode("status");
    } catch (err) {
      setError(getErrorMessage(err));
      setStatus("");
    }
  }

  async function applyLocalImageSupplement() {
    if (!job?.imageSupplementPlan?.needed) return;
    setError("");
    setStatus("正在调用本地 Z-Image 生成补图并刷新 PPT...");
    try {
      const data = await api.create(`/api/jobs/${job.id}/apply-local-image-supplement`, {});
      setJob(data);
      setJobs((current) => [data, ...current.filter((item) => item.id !== data.id)]);
      setStatus(data.warning || data.previewWarning || "本地 Z-Image 补图完成，PPTX 和预览已刷新。");
      setRightPanelMode("status");
    } catch (err) {
      setError(getErrorMessage(err));
      setStatus("");
    }
  }

  async function rescanLocalImageQa() {
    if (!job) return;
    setError("");
    setStatus("正在重新扫描本地生成图片 QA...");
    try {
      const data = await api.rescanLocalImageQa(job.id);
      setJob(data);
      setJobs((current) => [data, ...current.filter((item) => item.id !== data.id)]);
      setStatus("本地图 QA 已刷新，文字污染和安全区风险已重新计算。");
      setRightPanelMode("status");
    } catch (err) {
      setError(getErrorMessage(err));
      setStatus("");
    }
  }

  async function generateVisualTargetSample() {
    if (!job?.id) return;
    setError("");
    setStatus("正在生成视觉目标方向图...");
    try {
      const data = await api.generateVisualTargetSample(job.id);
      setJob(data);
      setJobs((current) => [data, ...current.filter((item) => item.id !== data.id)]);
      const sampleStatus = data.visualTarget?.sample?.status;
      setStatus(sampleStatus === "generated" ? "视觉目标方向图已生成；最终 PPT 仍从 SceneGraph 渲染。" : "视觉目标方向图已记录为待生成；请确认本地生图服务在线。");
      setRightPanelMode("status");
    } catch (err) {
      setError(getErrorMessage(err));
      setStatus("");
    }
  }

  async function generateVisualProjectSlides(maxSlides = 3) {
    if (!job?.id) return;
    setError("");
    setStatus("正在逐页生成视觉目标图...");
    try {
      const data = await api.generateVisualProjectSlides(job.id, { maxSlides });
      setJob(data);
      setJobs((current) => [data, ...current.filter((item) => item.id !== data.id)]);
      const project = data.visualProject || {};
      setStatus(project.status === "ready" ? "逐页视觉目标已完成，visual-target.pptx 已生成。" : `已生成 ${project.generatedImages || 0}/${project.slideCount || 0} 张视觉目标图。`);
      setActiveStep("visual-project");
      setRightPanelMode("status");
    } catch (err) {
      setError(getErrorMessage(err));
      setStatus("");
    }
  }

  async function undoJob() {
    if (!job?.canUndo) return;
    setError("");
    setStatus("正在撤销上一步操作...");
    try {
      const data = await api.create(`/api/jobs/${job.id}/undo`, {});
      setJob(data);
      setJobs((current) => [data, ...current.filter((item) => item.id !== data.id)]);
      setSelectedSlide(0);
      setStatus(data.previewWarning || "已撤销上一步，PPTX 和预览已刷新。");
    } catch (err) {
      setError(getErrorMessage(err));
      setStatus("");
    }
  }

  async function saveSlideText(slideDraft) {
    if (!job || !currentSlide) return;
    setError("");
    setStatus("正在保存当前页...");
    try {
      const data = await api.create(`/api/jobs/${job.id}/slides/${selectedSlide}/update`, { slide: slideDraft });
      setJob(data);
      setJobs((current) => [data, ...current.filter((item) => item.id !== data.id)]);
      setStatus("当前页已保存，PPT 和预览已刷新。");
    } catch (err) {
      setError(getErrorMessage(err));
      setStatus("");
    }
  }

  async function slideAction(action, payload = {}) {
    const actionSlide = Number.isFinite(payload.slideIndex) ? payload.slideIndex : selectedSlide;
    if (!job || actionSlide < 0) return;
    setError("");
    setStatus("正在调整页面结构...");
    try {
      const { slideIndex: _slideIndex, ...body } = payload;
      const data = await api.create(`/api/jobs/${job.id}/slides/${actionSlide}/action`, { action, ...body });
      setJob(data);
      setSelectedSlide(Number.isFinite(data.selectedSlide) ? data.selectedSlide : actionSlide);
      setJobs((current) => [data, ...current.filter((item) => item.id !== data.id)]);
      setStatus(data.previewWarning || "页面结构已更新，PPTX 和预览已刷新。");
    } catch (err) {
      setError(getErrorMessage(err));
      setStatus("");
    }
  }

  async function exportJob() {
    if (!job) return;
    if (finalExportBlocked && formats.some((format) => format !== "pptx")) {
      setError("");
      setStatus("QA blocked：当前 editable PPTX 已作为草稿保留，修复阻断项后才能正式导出 PDF/PNG。");
      setRightPanelMode("status");
      return;
    }
    setError("");
    setStatus("正在导出文件...");
    try {
      const data = await api.create(`/api/jobs/${job.id}/export`, { formats });
      setJob(data);
      setRightPanelMode("status");
      setStatus(data.exportWarning || "导出完成。");
    } catch (err) {
      setError(getErrorMessage(err));
      setStatus("");
    }
  }

  async function submitFeedback(skip = false) {
    if (!job) return;
    setError("");
    try {
      const data = await api.create(`/api/jobs/${job.id}/feedback`, { rating: skip ? null : rating, comment });
      setJob(data);
      setStatus(skip ? "已跳过反馈。" : "反馈已保存。");
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function saveApiConfig() {
    setSettingsBusy(true);
    setSettingsStatus("");
    setError("");
    try {
      const data = await api.saveConfig(apiConfig);
      setApiConfig((current) => ({ ...current, ...data, apiKey: "" }));
      setSettingsStatus("API 配置已保存，后续生成会使用这个配置。");
    } catch (err) {
      setSettingsStatus(getErrorMessage(err));
    } finally {
      setSettingsBusy(false);
    }
  }

  async function testApiConfig() {
    setSettingsBusy(true);
    setSettingsStatus("正在测试 API 连接...");
    setError("");
    try {
      const data = await api.testConfig(apiConfig);
      if (data.usedBaseUrl) {
        setApiConfig((current) => ({ ...current, baseUrl: data.usedBaseUrl }));
      }
      setSettingsStatus(data.message || "API 连接成功。");
    } catch (err) {
      setSettingsStatus(getErrorMessage(err));
    } finally {
      setSettingsBusy(false);
    }
  }

  async function detectModels() {
    setSettingsBusy(true);
    setSettingsStatus("正在检测可用模型...");
    setError("");
    try {
      const data = await api.models(apiConfig);
      const models = data.models || [];
      setAvailableModels(models);
      const nextModel = models.length && !models.includes(apiConfig.model) ? models[0] : apiConfig.model;
      setApiConfig((current) => ({
        ...current,
        baseUrl: data.usedBaseUrl || current.baseUrl,
        model: nextModel
      }));
      setSettingsStatus(models.length ? `已检测到 ${models.length} 个可用模型，已自动使用 ${data.usedBaseUrl || apiConfig.baseUrl}。` : "没有检测到可用聊天模型。");
    } catch (err) {
      setSettingsStatus(getErrorMessage(err));
    } finally {
      setSettingsBusy(false);
    }
  }

  async function uploadStyleReference(files, meta) {
    if (!files?.length) return;
    setSettingsBusy(true);
    setSettingsStatus("\u6b63\u5728\u52a0\u5165\u98ce\u683c\u53c2\u8003\u5e93...");
    try {
      const data = await api.uploadStyleReferences(files, meta);
      setStyleReferences((current) => [...(data.references || []), ...current]);
      setSettingsStatus("\u98ce\u683c\u53c2\u8003\u5df2\u52a0\u5165\uff0c\u540e\u7eed\u751f\u6210\u4f1a\u53c2\u8003\u8fd9\u7ec4\u8c03\u6027\u3002");
    } catch (err) {
      setSettingsStatus(getErrorMessage(err));
    } finally {
      setSettingsBusy(false);
    }
  }

  async function deleteStyleReference(id) {
    setSettingsBusy(true);
    setSettingsStatus("");
    try {
      await api.deleteStyleReference(id);
      setStyleReferences((current) => current.filter((item) => item.id !== id));
      setSettingsStatus("\u5df2\u4ece\u98ce\u683c\u53c2\u8003\u5e93\u5220\u9664\u3002");
    } catch (err) {
      setSettingsStatus(getErrorMessage(err));
    } finally {
      setSettingsBusy(false);
    }
  }

  function selectJob(item) {
    setJob(item);
    setFiles(item.files || []);
    setFileIds((item.files || []).map((file) => file.id).filter(Boolean));
    setSelectedSlide(0);
    setActiveStep("preview");
    setRightPanelMode("edit");
  }

  async function deleteHistoryJob(item) {
    if (!item?.id) return;
    if (!window.confirm(`删除历史任务「${item.deck?.title || item.id}」？对应导出文件也会删除。`)) return;
    setError("");
    setStatus("正在删除历史任务...");
    try {
      await api.remove(`/api/jobs/${item.id}`);
      setJobs((current) => current.filter((jobItem) => jobItem.id !== item.id));
      if (job?.id === item.id) {
        setJob(null);
        setFiles([]);
        setFileIds([]);
        setSelectedSlide(0);
        setActiveStep("materials");
      }
      setStatus("历史任务已删除。");
    } catch (err) {
      setError(getErrorMessage(err));
      setStatus("");
    }
  }

  async function deleteHistoryJobs(items = []) {
    const targets = items.filter(Boolean);
    if (!targets.length) return;
    if (!window.confirm(`批量删除 ${targets.length} 个历史任务？对应导出文件也会删除。`)) return;
    setError("");
    setStatus("正在批量删除历史任务...");
    try {
      for (const item of targets) await api.remove(`/api/jobs/${item.id}`);
      const targetIds = new Set(targets.map((item) => item.id));
      setJobs((current) => current.filter((item) => !targetIds.has(item.id)));
      if (job?.id && targetIds.has(job.id)) {
        setJob(null);
        setFiles([]);
        setFileIds([]);
        setSelectedSlide(0);
        setActiveStep("materials");
      }
      setStatus(`已删除 ${targets.length} 个历史任务。`);
    } catch (err) {
      setError(getErrorMessage(err));
      setStatus("");
    }
  }

  async function repairHistoryJob(item) {
    if (!item?.id) return;
    setError("");
    setStatus("正在修复历史任务...");
    try {
      const data = await api.create(`/api/jobs/${item.id}/repair`, {});
      setJobs((current) => [data, ...current.filter((historyItem) => historyItem.id !== data.id)]);
      if (job?.id === data.id) setJob(data);
      setStatus(data.previewWarning || "历史任务已修复。");
      setRightPanelMode("history");
    } catch (err) {
      setError(getErrorMessage(err));
      setStatus("");
    }
  }

  async function retryPreview() {
    if (!job || previewBusy) return;
    setPreviewBusy(true);
    setError("");
    setStatus("正在重新生成预览图...");
    try {
      const data = await api.create(`/api/jobs/${job.id}/preview`, {});
      setJob(data);
      setJobs((current) => [data, ...current.filter((item) => item.id !== data.id)]);
      setStatus(data.previewWarning || "预览图已重新生成。");
      setRightPanelMode("edit");
    } catch (err) {
      setError(getErrorMessage(err));
      setStatus("");
    } finally {
      setPreviewBusy(false);
    }
  }

  async function rerenderTemplate(style) {
    if (!job || !style || templateBusy) return;
    setTemplateBusy(true);
    setError("");
    setStatus("正在按新设计方向重新渲染 PPT...");
    try {
      const data = await api.create(`/api/jobs/${job.id}/template`, { style });
      setJob(data);
      setJobs((current) => [data, ...current.filter((item) => item.id !== data.id)]);
      setForm((current) => ({ ...current, style }));
      setStatus(data.previewWarning || "页面结构已更新，PPTX 和预览已刷新。");
      setRightPanelMode("status");
    } catch (err) {
      setError(getErrorMessage(err));
      setStatus("");
    } finally {
      setTemplateBusy(false);
    }
  }

  function appendQuickAction(text) {
    setRevision((current) => current ? `${current}；${text}` : text);
  }

  function updateOutlineStep(index, field, value) {
    setOutlinePlan((current) => {
      if (!current?.layoutSequence) return current;
      return {
        ...current,
        layoutSequence: current.layoutSequence.map((step, stepIndex) => (
          stepIndex === index ? { ...step, [field]: value } : step
        ))
      };
    });
  }

  function outlineAction(index, action) {
    setOutlinePlan((current) => {
      if (!current?.layoutSequence?.length) return current;
      const next = [...current.layoutSequence];
      if (action === "insert-after") {
        next.splice(index + 1, 0, makeOutlineStep(outlineInsertLayout));
      } else if (action === "duplicate") {
        next.splice(index + 1, 0, { ...next[index], title: `${next[index].title || "未命名页"} 副本` });
      } else if (action === "delete") {
        if (next.length <= 1) return current;
        next.splice(index, 1);
      } else if (action === "move-up" && index > 0) {
        [next[index - 1], next[index]] = [next[index], next[index - 1]];
      } else if (action === "move-down" && index < next.length - 1) {
        [next[index + 1], next[index]] = [next[index], next[index + 1]];
      }
      return { ...current, layoutSequence: next };
    });
  }

  function appendOutlineStep() {
    setOutlinePlan((current) => {
      if (!current?.layoutSequence?.length) return current;
      return { ...current, layoutSequence: [...current.layoutSequence, makeOutlineStep(outlineInsertLayout)] };
    });
  }

  function toggleSettingsPanel() {
    setRightPanelMode((current) => (current === "settings" ? (activeStep === "preview" ? "edit" : "closed") : "settings"));
  }

  const editBlocked = Boolean(job?.editReadiness && job.editReadiness.ready === false);
  const hasEditableContext = Boolean(job && currentSlide && !editBlocked);
  const showRightPanel = (activeStep === "preview" && Boolean(job)) || rightPanelMode !== "closed";
  const visibleRightPanelMode = rightPanelMode === "closed"
    ? (hasEditableContext ? "edit" : "status")
    : (!hasEditableContext && ["edit", "ai"].includes(rightPanelMode) ? "status" : rightPanelMode);
  const rightPanelTabs = hasEditableContext
    ? [["edit", "编辑"], ["ai", "AI"], ["history", "历史"]]
    : [["history", "历史"]];

  return (
    <div className="workspace-shell">
      <header className="topbar">
        <div>
          <span className="brand">PPT Design OS</span>
        </div>
        <div className="topbar-status">
          <span className={topbarStateClass} />
          <span>{topbarMessage}</span>
        </div>
      </header>

      <WorkflowStrip activeStep={activeStep} completion={completion} rightPanelMode={rightPanelMode} setActiveStep={setActiveStep} setRightPanelMode={toggleSettingsPanel} stepState={stepState} />

      <div className={`workspace-grid ${activeStep !== "preview" ? "no-left" : ""} ${!showRightPanel ? "solo-stage" : ""}`}>
        {activeStep === "preview" && (
          <WorkspaceLeftPanel
            activeStep={activeStep}
            contextMenu={contextMenu}
            dirty={dirty}
            draggedSlide={draggedSlide}
            dropTargetSlide={dropTargetSlide}
            files={files}
            insertLayout={insertLayout}
            job={job}
            liveSlide={liveSlide}
            outlinePlan={outlinePlan}
            selectedSlide={selectedSlide}
            setActiveStep={setActiveStep}
            setContextMenu={setContextMenu}
            setDraggedSlide={setDraggedSlide}
            setDropTargetSlide={setDropTargetSlide}
            setInsertLayout={setInsertLayout}
            setSelectedSlide={setSelectedSlide}
            slides={slides}
            stepState={stepState}
            onSlideAction={slideAction}
          />
        )}
        <main className="main-stage">
          {activeStep === "materials" && (
            <SectionCard className="intake-card">
              <div className="chat-intake">
                <div className="intake-agent-panel">
                  <div>
                    <b>PPT Agent</b>
                    <span>{intakeReadiness.label}</span>
                  </div>
                  <small>{intakeReadiness.hint}</small>
                </div>
                {intakeMessages.length > 0 && (
                  <div className="intake-thread" aria-live="polite">
                    {intakeMessages.map((message) => (
                      <div className={`intake-message ${message.role}`} key={message.id}>
                        {message.text}
                      </div>
                    ))}
                  </div>
                )}
                {!intakeMessages.length && (
                  <div className="intake-suggestions">
                    {["你可以干嘛？", "我要从零做一份提案 PPT", "我想优化旧 PPT", "先问我几个问题"].map((item) => (
                      <button type="button" key={item} onClick={() => setIntakeDraft(item)}>{item}</button>
                    ))}
                  </div>
                )}
                <div className="chat-box">
                  <label className="chat-plus" title={UI.uploadTitle}>
                    <input type="file" multiple onChange={uploadFiles} />
                    <span>+</span>
                  </label>
                  <input
                    className="chat-prompt"
                    value={intakeDraft}
                    onChange={(e) => setIntakeDraft(e.target.value)}
                    onKeyDown={handleIntakeKeyDown}
                    placeholder={UI.promptPlaceholder}
                  />
                  <div className="chat-toolbar">
                    <small>{selectedFileNames || UI.uploadHint}</small>
                    <button className="send-button" type="button" onClick={submitIntakeMessage} disabled={!intakeDraft.trim() && fileIds.length === 0} aria-label={UI.sendOutline}>
                      {outlineBusy ? "..." : "→"}
                    </button>
                  </div>
                </div>
                {hasUploadedMaterials && (
                  <div className="outline-strategy-toggle" role="group" aria-label={UI.regenerateOutline}>
                    <button className={form.outlineStrategy !== "regenerate" ? "active" : ""} type="button" onClick={() => update("outlineStrategy", "keep-source")}>
                      <b>优化旧 PPT</b>
                      <span>保留页序、主题和素材，重建为可编辑 PPTX</span>
                    </button>
                    <button className={form.outlineStrategy === "regenerate" ? "active" : ""} type="button" onClick={() => update("outlineStrategy", "regenerate")}>
                      <b>重新规划</b>
                      <span>重新组织叙事、页序和版式路线</span>
                    </button>
                  </div>
                )}
                {(form.notes.trim() || fileIds.length > 0) && (
                  <div className="intake-next-actions">
                    <button className="btn primary" type="button" onClick={() => planOutline()} disabled={outlineBusy || !intakeReadiness.ready}>
                      {outlineBusy ? "正在理解资料" : "开始理解并生成大纲"}
                    </button>
                    <span>{intakeReadiness.ready ? "不会直接生成完整 PPT，会先出可确认的大纲。" : intakeReadiness.nextQuestion}</span>
                  </div>
                )}
                {files.length > 0 && (
                  <div className="file-list compact-files">
                    {files.map((file) => (
                      <div className="file-row" key={file.id}>
                        {file.uploadUrl ? <img src={file.uploadUrl} alt={file.originalName} /> : <span className="file-icon">{fileExt(file.originalName)}</span>}
                        <div>
                          <b>{file.originalName}</b>
                          <small>{formatBytes(file.size)}</small>
                        </div>
                        <button className="file-delete" type="button" onClick={() => removeUploadedFile(file)}>{UI.delete}</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </SectionCard>
          )}

          {activeStep === "outline" && (
            <SectionCard className="outline-card" title="确认大纲" desc="先确认页序、版式、标题和每页用途，再进入最终生成。">
              <div className="readiness">
                <Metric label="资料文件" value={fileIds.length} />
                <Metric label="自动识别资料" value={inferredMaterials.length ? `${inferredMaterials.length} 类` : "待识别"} />
                <Metric label="需求完整度" value={`${completion}%`} />
              </div>
              <div className="outline-panel">
                <div>
                  <b>大纲方案</b>
                  <span>{outlineBrief ? `${inputStrengthLabel(outlineBrief.inputStrength)} / 产品 ${outlineBrief.productCount || 0} / 价格 ${outlineBrief.priceCount || 0} / 图片 ${outlineBrief.imageCount || 0}` : "先生成页序、版式、标题和每页用途，再确认生成。"}</span>
                </div>
                <div className="button-row tight">
                  <button className="btn ghost" type="button" onClick={planOutline} disabled={outlineBusy}>{outlineBusy ? "正在生成大纲" : "重新生成大纲"}</button>
                  <button className="btn primary" type="button" onClick={() => setActiveStep("generate")} disabled={!outlinePlan?.layoutSequence?.length}>确认大纲，进入生成</button>
                </div>
                {outlinePlan?.layoutSequence?.length ? (
                  <div className="outline-list outline-card-list">
                    <div className="outline-digest">
                      <strong>故事线</strong>
                      <span>{outlinePlan.layoutSequence.map((step, index) => `${index + 1}. ${step.title || LAYOUT_LABELS[step.layout] || step.layout}`).slice(0, 8).join(" / ")}</span>
                    </div>
                    <div className="outline-insert-bar">
                      <select value={outlineInsertLayout} onChange={(event) => setOutlineInsertLayout(event.target.value)}>
                        {Object.entries(LAYOUT_LABELS).map(([value, label]) => <option key={value} value={value}>新增版式：{label} / {value}</option>)}
                      </select>
                      <button className="btn ghost" type="button" onClick={appendOutlineStep}>追加到末尾</button>
                    </div>
                    {outlinePlan.layoutSequence.map((step, index) => (
                      <div className="outline-card-item" key={`${step.layout}-${index}`}>
                        <div className="outline-source-row">
                          <span className={`source-badge ${getOutlineSourceMeta(step).tone}`}>{getOutlineSourceMeta(step).label}</span>
                          {getOutlineSourceMeta(step).evidence ? <small>{getOutlineSourceMeta(step).evidence}</small> : null}
                        </div>
                        <div className="outline-card-index">
                          <span>{String(index + 1).padStart(2, "0")}</span>
                          <select value={step.layout || "section"} onChange={(event) => updateOutlineStep(index, "layout", event.target.value)}>
                            {Object.entries(LAYOUT_LABELS).map(([value, label]) => <option key={value} value={value}>{label} / {value}</option>)}
                          </select>
                        </div>
                        <div className="outline-card-fields">
                          <input value={step.title || ""} onChange={(event) => updateOutlineStep(index, "title", event.target.value)} placeholder="页面标题" />
                          <textarea value={step.purpose || ""} onChange={(event) => updateOutlineStep(index, "purpose", event.target.value)} placeholder="这一页的用途" />
                        </div>
                        <div className="outline-actions" aria-label={`第 ${index + 1} 页操作`}>
                          <button type="button" title="上移这一页" aria-label="上移这一页" onClick={() => outlineAction(index, "move-up")} disabled={index === 0}>↑</button>
                          <button type="button" title="下移这一页" aria-label="下移这一页" onClick={() => outlineAction(index, "move-down")} disabled={index === outlinePlan.layoutSequence.length - 1}>↓</button>
                          <button type="button" title="在后面新增一页" aria-label="在后面新增一页" onClick={() => outlineAction(index, "insert-after")}>+</button>
                          <button type="button" title="复制这一页" aria-label="复制这一页" onClick={() => outlineAction(index, "duplicate")}>⧉</button>
                          <button type="button" title="删除这一页" aria-label="删除这一页" onClick={() => outlineAction(index, "delete")} disabled={outlinePlan.layoutSequence.length <= 1}>×</button>
                        </div>
                        <small className="outline-action-hint">上移 / 下移 / 新增 / 复制 / 删除</small>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </SectionCard>
          )}

          {activeStep === "generate" && (
            <SectionCard title="一键提案级可编辑重构" desc="自动执行资料识别、视觉目标、SceneGraph 重建、PPTX 渲染和 QA；主视觉方向可选审阅。">
              <div className="readiness">
                <Metric label="资料文件" value={fileIds.length} />
                <Metric label="大纲状态" value={outlinePlan?.layoutSequence?.length ? "已确认" : "未确认"} />
                <Metric label="需求完整度" value={`${completion}%`} />
              </div>
              <GenerationGateFlow outlineReady={Boolean(outlinePlan?.layoutSequence?.length)} styleSelected={Boolean(form.style)} styleProofReady={Boolean(stylePreviewJob)} styleConfirmed={styleConfirmed} optionalStyleProof />
              <TemplatePreflightSelector
                style={form.style}
                themes={themes}
                templatePacks={templatePacks}
                styleReferences={styleReferences}
                onChange={(style) => update("style", style)}
              />
              {generationProgress.active && generationProgress.mode !== "style-preview" ? <GenerationProgress progress={generationProgress} /> : null}
              <StylePreviewGate
                busy={stylePreviewBusy}
                confirmed={styleConfirmed}
                job={stylePreviewJob}
                progress={generationProgress.mode === "style-preview" ? generationProgress : null}
                onConfirm={() => setStyleConfirmed(true)}
                onCreate={() => createStylePreview(outlinePlan)}
                onReset={() => {
                  setStyleConfirmed(false);
                  setStylePreviewJob(null);
                }}
                canCreate={Boolean(outlinePlan?.layoutSequence?.length && form.style)}
              />
              <div className="action-grid single-action">
                <button className="primary-action" onClick={() => createJob(getGenerationMode(), outlinePlan)} disabled={generationProgress.active || stylePreviewBusy || !outlinePlan?.layoutSequence?.length}>
                  <b>{generationProgress.active ? "正在跑完整链路" : "一键生成可编辑最终稿"}</b>
                  <span>{styleConfirmed ? "已采用视觉方向，将输出 editable-final.pptx。" : "未采用方向也可直接生成；系统会自动生成 visual target 并重建可编辑 PPTX。"}</span>
                </button>
              </div>
            </SectionCard>
          )}

          {activeStep === "visual-project" && (
            <SectionCard title="逐页视觉生产" desc="按 codex-ppt 链路准备 outline、deck_spec、prompts、slide_jobs 和 origin_image。">
              <VisualProjectWorkspace job={job} onGenerateSlides={generateVisualProjectSlides} />
            </SectionCard>
          )}

          {activeStep === "visual-qa" && (
            <SectionCard title="视觉目标 QA" desc="视觉目标是中间设计稿，不是最终可编辑文件；最终交付仍以 SceneGraph/PPTX 为准。">
              <HybridQaWorkspace job={job} selectedSlide={selectedSlide} setSelectedSlide={setSelectedSlide} currentImage={currentImage} />
            </SectionCard>
          )}

          {activeStep === "preview" && (
            <SectionCard title="预览与单页编辑" desc="左侧选页，中间看稿并可直接编辑，右侧修改当前页。">
              {!job ? (
                <StageEmptyState
                  title="还没有可编辑结果"
                  body="先上传资料或输入需求，完成视觉方向和 SceneGraph 重建后，这里才显示可编辑预览、素材层和文字层。"
                  action="回到资料识别"
                  onAction={() => setActiveStep("materials")}
                />
              ) : (
                <>
                  <EditReadinessGate
                    readiness={job?.editReadiness}
                    localImage={localImage}
                    onApplyImageSupplement={applyImageSupplement}
                    onApplyLocalImageSupplement={applyLocalImageSupplement}
                    onRescanLocalImageQa={rescanLocalImageQa}
                  />
                  <PreviewCanvas
                    currentImage={currentImage}
                    currentSlide={currentSlide}
                    currentStyle={currentStyle}
                    currentTemplate={currentTemplate}
                    draft={draft}
                    dirty={dirty}
                    focusPreview={focusPreview}
                    editBlocked={editBlocked}
                    job={job}
                    liveSlide={liveSlide}
                    selectedSlide={selectedSlide}
                    setFocusPreview={setFocusPreview}
                    setSelectedSlide={setSelectedSlide}
                    slides={slides}
                    updateDraft={updateDraft}
                    onSaveText={saveSlideText}
                    onRetryPreview={retryPreview}
                    previewBusy={previewBusy}
                    templateBusy={templateBusy}
                    templateHit={templateHit}
                    themes={themes}
                    templatePacks={templatePacks}
                    onRerenderTemplate={rerenderTemplate}
                  />
                </>
              )}
            </SectionCard>
          )}

          {activeStep === "export" && (
            <SectionCard title="导出文件" desc="选择需要的格式。PPTX 直接生成，PDF/PNG 调用本机 PowerPoint。">
              {!job ? (
                <StageEmptyState
                  title="暂无可导出文件"
                  body="生成整套 PPT 后，这里会出现 editable-final.pptx。visual-target.pptx 只作为中间视觉目标展示。"
                  action="回到资料识别"
                  onAction={() => setActiveStep("materials")}
                />
              ) : (
                <div className="export-layout">
                  <div className="format-list">
                    {["pptx", "pdf", "png"].map((format) => (
                      <label className="format-option" key={format}>
                        <input type="checkbox" checked={formats.includes(format)} onChange={() => setFormats((current) => toggle(current, format))} disabled={finalExportBlocked && format !== "pptx"} />
                        <span>{format.toUpperCase()}</span>
                      </label>
                    ))}
                    {finalExportBlocked ? <p className="export-blocked-note">QA blocked：当前只能保留可编辑 PPTX 草稿，PDF/PNG 正式导出需先修复阻断项。</p> : null}
                    <button className="btn primary wide" onClick={exportJob} disabled={formats.length === 0 || (finalExportBlocked && formats.some((format) => format !== "pptx"))}>开始导出</button>
                  </div>
                  <DownloadLinks job={job} />
                </div>
              )}
            </SectionCard>
          )}

          {activeStep === "feedback" && (
            <SectionCard title="评分与留言" desc="反馈会保存到当前任务记录里。">
              <div className="feedback-grid">
                <div className="score">
                  {[1, 2, 3, 4, 5].map((item) => <button className={item <= rating ? "active" : ""} key={item} onClick={() => setRating(item)}>{item}</button>)}
                </div>
                <Field label="留言">
                  <textarea value={comment} onChange={(e) => setComment(e.target.value)} />
                  <div className="button-row">
                    <button className="btn primary" onClick={() => submitFeedback(false)} disabled={!job}>提交反馈</button>
                    <button className="btn ghost" onClick={() => submitFeedback(true)} disabled={!job}>跳过</button>
                  </div>
                </Field>
              </div>
            </SectionCard>
          )}
        </main>

        {showRightPanel && (
        <aside className="right-panel">
          <div className="panel-tabs">
            {rightPanelTabs.map(([id, label]) => (
              <button className={visibleRightPanelMode === id ? "active" : ""} key={id} onClick={() => setRightPanelMode(id)}>{label}</button>
            ))}
            <button className={visibleRightPanelMode === "settings" ? "active" : ""} type="button" onClick={() => setRightPanelMode("settings")}>设置</button>
          </div>
          {visibleRightPanelMode === "edit" && (
            <EditorPanel
              currentSlide={currentSlide}
              deckRevision={deckRevision}
              dirty={dirty}
              draft={draft}
              insertLayout={insertLayout}
              job={editBlocked ? null : job}
              revision={revision}
              savedDraft={savedDraft}
              selectedSlide={selectedSlide}
              setDeckRevision={setDeckRevision}
              setDraft={setDraft}
              setInsertLayout={setInsertLayout}
              setRevision={setRevision}
              slides={slides}
              updateDraft={updateDraft}
              onQuickAction={appendQuickAction}
              onRevise={revise}
              onSaveText={saveSlideText}
              onSlideAction={slideAction}
              onRewriteDeck={rewriteDeck}
              onUndoJob={undoJob}
            />
          )}
          {visibleRightPanelMode === "ai" && (
            <AIPanel
              currentStyle={currentStyle}
              deckRevision={deckRevision}
              dirty={dirty}
              job={editBlocked ? null : job}
              revision={revision}
              setDeckRevision={setDeckRevision}
              setRevision={setRevision}
              themes={themes}
              templateBusy={templateBusy}
              templatePacks={templatePacks}
              onQuickAction={appendQuickAction}
              onRevise={revise}
              onRewriteDeck={rewriteDeck}
              onRerenderTemplate={rerenderTemplate}
            />
          )}
          {visibleRightPanelMode === "status" && <StatusPanel job={job} files={files} fileIds={fileIds} status={status} error={error} connection={connection} localImage={localImage} skillRules={skillRules} onRepairDelivery={repairDelivery} onApplyImageSupplement={applyImageSupplement} onApplyLocalImageSupplement={applyLocalImageSupplement} onRescanLocalImageQa={rescanLocalImageQa} onGenerateVisualTargetSample={generateVisualTargetSample} />}
          {visibleRightPanelMode === "history" && <HistoryPanel jobs={jobs} onSelect={selectJob} onDelete={deleteHistoryJob} onDeleteMany={deleteHistoryJobs} onRepair={repairHistoryJob} />}
          {visibleRightPanelMode === "settings" && (
            <SettingsPanel
              config={apiConfig}
              busy={settingsBusy}
              status={settingsStatus}
              models={availableModels}
              themes={themes}
              onChange={setApiConfig}
              onSave={saveApiConfig}
              onTest={testApiConfig}
              onDetectModels={detectModels}
              styleReferences={styleReferences}
              onUploadStyleReference={uploadStyleReference}
              onDeleteStyleReference={deleteStyleReference}
            />
          )}
        </aside>
        )}
      </div>
    </div>
  );
}

function WorkflowStrip({ activeStep, completion, rightPanelMode, setActiveStep, setRightPanelMode, stepState }) {
  const currentStep = STEPS.find((step) => step.id === activeStep);
  function openSettings() {
    setRightPanelMode("settings");
  }
  return (
    <div className="workflow-strip">
      <div className="workflow-current">
        <span>当前阶段</span>
        <b>{currentStep?.title || "工作台"}</b>
        <em><i style={{ width: `${completion}%` }} /></em>
      </div>
      <div className="workflow-steps">
        {STEPS.filter((step) => step.id !== "feedback").map((step, index, list) => (
          <button className={activeStep === step.id ? "active" : ""} type="button" key={step.id} onClick={() => setActiveStep(step.id)}>
            <strong>{step.title}</strong>
            <span>{stepState[step.id]}</span>
            {index < list.length - 1 ? <i /> : null}
          </button>
        ))}
      </div>
      <button className="workflow-settings" type="button" onClick={() => setRightPanelMode("settings")}>设置</button>
    </div>
  );
}

function WorkspaceLeftPanel({ contextMenu, dirty, draggedSlide, dropTargetSlide, files, insertLayout, job, liveSlide, outlinePlan, selectedSlide, setActiveStep, setContextMenu, setDraggedSlide, setDropTargetSlide, setInsertLayout, setSelectedSlide, slides, onSlideAction }) {
  const [panelMode, setPanelMode] = useState(job ? "slides" : "materials");
  useEffect(() => {
    setPanelMode(job ? "slides" : "materials");
  }, [job?.id]);

  return (
    <aside className="sidebar workspace-left" onClick={() => setContextMenu(null)}>
      <div className="left-panel-tabs">
        {job ? (
          <>
            <button className={panelMode === "slides" ? "active" : ""} type="button" onClick={() => setPanelMode("slides")}>{UI.pages}</button>
            <button className={panelMode === "materials" ? "active" : ""} type="button" onClick={() => setPanelMode("materials")}>{UI.materials}</button>
          </>
        ) : (
          <>
            <button className={panelMode === "materials" ? "active" : ""} type="button" onClick={() => { setPanelMode("materials"); setActiveStep("materials"); }}>{UI.data}</button>
            <button className={panelMode === "outline" ? "active" : ""} type="button" onClick={() => { setPanelMode("outline"); setActiveStep("outline"); }}>{UI.outline}</button>
          </>
        )}
      </div>

      {!job || panelMode === "materials" ? (
        panelMode === "outline" ? <OutlineNavigator outlinePlan={outlinePlan} /> : <MaterialNavigator files={files} outlinePlan={outlinePlan} />
      ) : (
        <>
          <div className="slide-rail">
            {slides.map((slide, index) => (
              <div
                className={`rail-card ${selectedSlide === index ? "active" : ""} ${draggedSlide === index ? "dragging" : ""} ${dropTargetSlide === index && draggedSlide !== index ? "drop-target" : ""}`}
                key={index}
                draggable={!!job && !dirty}
                onDragStart={() => setDraggedSlide(index)}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDropTargetSlide(index);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (Number.isFinite(draggedSlide) && draggedSlide !== index) onSlideAction?.("move-to", { slideIndex: draggedSlide, toIndex: index });
                  setDraggedSlide(null);
                  setDropTargetSlide(null);
                }}
                onDragEnd={() => {
                  setDraggedSlide(null);
                  setDropTargetSlide(null);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  if (!job || dirty) return;
                  setContextMenu({ index, x: event.clientX, y: event.clientY });
                }}
              >
                <button className="rail-select" type="button" onClick={() => setSelectedSlide(index)}>
                  {selectedSlide === index && dirty ? <SlideVisual slide={liveSlide} job={job} slideIndex={index} compact /> : job.previewImages?.[index] ? <img src={job.previewImages[index]} alt={`第 ${index + 1} 页`} /> : <SlideVisual slide={slide} job={job} slideIndex={index} compact />}
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <b>{selectedSlide === index && dirty ? liveSlide.title : slide.title}</b>
                </button>
                <div className="rail-actions">
                  <button type="button" title="上移" onClick={() => onSlideAction?.("move-up", { slideIndex: index })} disabled={!job || dirty || index === 0}>↑</button>
                  <button type="button" title="下移" onClick={() => onSlideAction?.("move-down", { slideIndex: index })} disabled={!job || dirty || index >= slides.length - 1}>↓</button>
                  <button type="button" title="复制" onClick={() => onSlideAction?.("duplicate", { slideIndex: index })} disabled={!job || dirty}>⧉</button>
                  <button type="button" title="删除" className="danger" onClick={() => onSlideAction?.("delete", { slideIndex: index })} disabled={!job || dirty || slides.length <= 1}>×</button>
                </div>
              </div>
            ))}
          </div>
          <div className="rail-insert rail-insert-bottom">
            <select value={insertLayout} onChange={(event) => setInsertLayout(event.target.value)} disabled={dirty}>
              {Object.entries(LAYOUT_LABELS).map(([value, label]) => <option key={value} value={value}>新增：{label} / {value}</option>)}
            </select>
            <button type="button" onClick={() => onSlideAction?.("insert-after", { layout: insertLayout, slideIndex: selectedSlide })} disabled={dirty}>新增</button>
          </div>
          {contextMenu && (
            <div className="rail-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()}>
              <button type="button" onClick={() => { onSlideAction?.("insert-before", { layout: insertLayout, slideIndex: contextMenu.index }); setContextMenu(null); }}>在前面插入</button>
              <button type="button" onClick={() => { onSlideAction?.("insert-after", { layout: insertLayout, slideIndex: contextMenu.index }); setContextMenu(null); }}>在后面插入</button>
              <button type="button" onClick={() => { onSlideAction?.("duplicate", { slideIndex: contextMenu.index }); setContextMenu(null); }}>复制此页</button>
              <button type="button" className="danger" onClick={() => { onSlideAction?.("delete", { slideIndex: contextMenu.index }); setContextMenu(null); }} disabled={slides.length <= 1}>删除此页</button>
            </div>
          )}
        </>
      )}
    </aside>
  );
}

function MaterialNavigator({ files = [], outlinePlan = null }) {
  return (
    <div className="left-summary">
      <b>资料导航</b>
      <span>{files.length ? `已上传 ${files.length} 个文件` : "等待上传资料或输入需求"}</span>
      <span>{outlinePlan?.layoutSequence?.length ? `大纲 ${outlinePlan.layoutSequence.length} 页` : "可先生成确认大纲"}</span>
      {files.slice(0, 8).map((file) => (
        <span className="left-file" key={file.id}>{file.originalName}</span>
      ))}
    </div>
  );
}

function OutlineNavigator({ outlinePlan = null }) {
  const steps = outlinePlan?.layoutSequence || [];
  return (
    <div className="left-summary outline-summary">
      <b>大纲草稿</b>
      {steps.length ? steps.slice(0, 12).map((step, index) => (
        <span key={`${step.layout}-${index}`}>{String(index + 1).padStart(2, "0")} 路 {step.title || step.layout}</span>
      )) : <span>还没有大纲，先在中间生成可确认大纲。</span>}
    </div>
  );
}

function EditReadinessGate({ readiness, localImage, onApplyImageSupplement, onApplyLocalImageSupplement, onRescanLocalImageQa }) {
  if (!readiness) return null;
  const blocked = readiness.ready === false || readiness.status === "blocked";
  const actions = new Set(readiness.actions || []);
  const visibleIssues = blocked ? (readiness.blockingIssues || readiness.issues || []) : (readiness.suggestions || []);
  const hasActionButtons = actions.size > 0;
  return (
    <div className={`edit-readiness-gate ${blocked ? "blocked" : "ready"}`}>
      <div>
        <b>{blocked ? "进入编辑前先补齐素材" : "可以进入在线编辑"}</b>
        <span>{readiness.summary}</span>
      </div>
      <div className="edit-readiness-facts">
        <span>预览 {readiness.facts?.previewCount || 0}/{readiness.facts?.slideCount || 0}</span>
        <span>待补图 {readiness.facts?.pendingGeneration || 0}</span>
        <span>待复用 {readiness.facts?.pendingReuse || 0}</span>
        <span>抠图 {readiness.facts?.plannedMatting || readiness.facts?.failedMatting || 0}</span>
        <span>QA {Number(readiness.facts?.localQaWarnings || 0) + Number(readiness.facts?.renderQaWarnings || 0)}</span>
      </div>
      {visibleIssues?.length ? <ul>{visibleIssues.map((item) => <li key={item}>{item}</li>)}</ul> : null}
      {hasActionButtons ? (
        <div className="button-row tight">
          {actions.has("apply-image-supplement") ? <button className={blocked ? "btn primary" : "btn ghost"} type="button" onClick={onApplyImageSupplement}>{blocked ? "先复用/绑定已有素材" : "可选绑定已有素材"}</button> : null}
          {actions.has("apply-local-image-supplement") ? <button className="btn primary" type="button" onClick={onApplyLocalImageSupplement} disabled={localImage?.state !== "online"}>{localImage?.state === "online" ? "本地补图并抠图" : "等待本地生图在线"}</button> : null}
          {actions.has("rescan-local-image-qa") ? <button className="btn ghost" type="button" onClick={onRescanLocalImageQa}>重扫图片 QA</button> : null}
        </div>
      ) : null}
    </div>
  );
}

function TemplatePreflightSelector({ style, themes = [], templatePacks = [], styleReferences = [], onChange }) {
  const selectedTheme = themes.find((theme) => theme.name === style) || themes[0] || {};
  const selectedPack = findTemplatePack(templatePacks, selectedTheme) || templatePacks.find((pack) => pack.themeName === style);
  const selectedRefs = styleReferences;
  const coreLayouts = (selectedPack?.coreLayouts || []).map((layout) => LAYOUT_LABELS[layout] || layout);
  return (
    <div className="template-preflight">
      <div>
        <b>{"\u8bbe\u8ba1\u65b9\u5411\u63a7\u5236\u53f0"}</b>
        <span>{"\u8fd9\u91cc\u9009\u7684\u662f\u6a21\u677f\u548c\u7248\u5f0f\u65b9\u5411\uff1b\u98ce\u683c\u53c2\u8003\u5e93\u662f\u72ec\u7acb\u8c03\u6027\u8f93\u5165\uff0c\u4f1a\u6574\u4f53\u5f71\u54cd\u56fe\u7247\u3001\u7559\u767d\u3001\u8272\u5f69\u548c\u6392\u7248\u8282\u594f\u3002"}</span>
      </div>
      <div className="template-preflight-controls">
        <label>
          <span>{"\u6a21\u677f / \u7248\u5f0f\u65b9\u5411"}</span>
          <select value={style || selectedTheme.name || ""} onChange={(event) => onChange?.(event.target.value)} title={"\u9009\u62e9\u6574\u5957 PPT \u7684\u7ed3\u6784\u548c\u7248\u5f0f\u503e\u5411"}>
            {themes.map((theme) => {
              const pack = findTemplatePack(templatePacks, theme);
              return <option key={theme.name} value={theme.name}>{formatDesignDirectionName(pack?.name || theme.name)}</option>;
            })}
          </select>
        </label>
        <div className={selectedRefs.length ? "style-library-call active" : "style-library-call"}>
          <span>{"\u98ce\u683c\u53c2\u8003\u5e93"}</span>
          <b>{selectedRefs.length ? selectedRefs.length + " \u5f20\u53c2\u8003\u56fe\u5df2\u63a5\u5165" : "\u6682\u65e0\u53c2\u8003\u56fe\uff0c\u4f7f\u7528\u5185\u7f6e\u8bbe\u8ba1\u89c4\u5219"}</b>
        </div>
      </div>
      <div className="template-preflight-meta">
        <span>{"\u9002\u5408\uff1a"}{selectedPack?.scenario || selectedTheme.bestFor || "\u6309\u5f53\u524d\u8d44\u6599\u81ea\u52a8\u9002\u914d"}</span>
        <span>{"\u7248\u5f0f\u7b56\u7565\uff1a"}{coreLayouts.join(" / ") || "\u81ea\u52a8\u7248\u5f0f"}</span>
        <span>{selectedRefs.length ? "\u53c2\u8003\u56fe\u53ea\u5f71\u54cd\u8c03\u6027\u548c\u7248\u5f0f\uff0c\u4e0d\u4f5c\u4e3a\u4e8b\u5b9e\u56fe\u7247\u76f4\u63a5\u590d\u5236" : "\u53ef\u5728\u8bbe\u7f6e\u91cc\u4e0a\u4f20\u4e00\u7ec4\u98ce\u683c\u53c2\u8003\u56fe"}</span>
      </div>
    </div>
  );
}

function GenerationGateFlow({ outlineReady, styleSelected, styleProofReady, styleConfirmed, optionalStyleProof = false }) {
  const styleProofMissing = optionalStyleProof && !Boolean(styleProofReady);
  const styleUnconfirmed = optionalStyleProof && !Boolean(styleConfirmed);
  const gates = [
    { label: "确认大纲", done: outlineReady },
    { label: "选择设计方向", done: styleSelected },
    { label: optionalStyleProof ? "方向审阅可选" : "方向自动质检", done: optionalStyleProof || styleProofReady, optional: styleProofMissing },
    { label: optionalStyleProof ? "直接进入全链路" : "人工确认风格", done: optionalStyleProof || styleConfirmed, optional: styleUnconfirmed }
  ];
  return (
    <div className="generation-gate-flow">
      {gates.map((gate, index) => (
        <div className={gate.done ? gate.optional ? "optional" : "done" : "pending"} key={gate.label}>
          <b>{String(index + 1).padStart(2, "0")}</b>
          <span>{gate.label}</span>
        </div>
      ))}
    </div>
  );
}

function PreviewCanvas({ currentImage, currentSlide, currentStyle, currentTemplate, draft, dirty, editBlocked = false, focusPreview, job, liveSlide, selectedSlide, setFocusPreview, setSelectedSlide, slides, updateDraft, onSaveText, onRetryPreview, previewBusy, templateBusy, templateHit, themes = [], templatePacks = [], onRerenderTemplate }) {
  const editableSlide = dirty ? liveSlide : currentSlide;
  const [layerMode, setLayerMode] = useState("preview");
  const textLayerActive = layerMode === "text";
  const assetLayerActive = layerMode === "asset";
  return (
    <div className={`preview-stage ${focusPreview ? "focus" : ""} layer-${layerMode}`}>
      <HybridPreviewStrip job={job} currentImage={currentImage} selectedSlide={selectedSlide} />
      <div className="stage-toolbar">
        <div>
          <b>{dirty ? liveSlide?.title : currentSlide?.title || "等待生成"}</b>
          <span>第 {selectedSlide + 1} 页 · {LAYOUT_LABELS[currentSlide?.layout] || currentSlide?.layout || "自动版式"}{(dirty ? liveSlide?.storyRole : currentSlide?.storyRole) ? ` · ${dirty ? liveSlide?.storyRole : currentSlide?.storyRole}` : ""}</span>
        </div>
        <div className="template-switcher">
          <span>切换设计方向并重渲染 · {formatDesignDirectionName(currentTemplate?.name || "当前设计方向")} · {templateHit.label}</span>
          <select value={currentStyle} onChange={(event) => onRerenderTemplate?.(event.target.value)} disabled={!job || dirty || templateBusy} title="切换设计方向后，会重渲染整套 PPT">
            {themes.map((theme) => {
              const pack = findTemplatePack(templatePacks, theme);
              return <option key={theme.name} value={theme.name}>{formatDesignDirectionName(pack?.name || theme.name)}</option>;
            })}
          </select>
        </div>
        <div className="stage-controls">
          <button className={layerMode === "preview" ? "active" : ""} onClick={() => setLayerMode("preview")} disabled={!job}>预览</button>
          <button className={layerMode === "asset" ? "active" : ""} onClick={() => setLayerMode("asset")} disabled={!job || editBlocked}>素材层</button>
          <button className={layerMode === "text" ? "active" : ""} onClick={() => setLayerMode("text")} disabled={!job || editBlocked}>文字层</button>
          <button onClick={() => setSelectedSlide((value) => Math.max(0, value - 1))} disabled={!job || selectedSlide === 0}>上一页</button>
          <button onClick={() => setSelectedSlide((value) => Math.min(slides.length - 1, value + 1))} disabled={!job || selectedSlide >= slides.length - 1}>下一页</button>
          <button onClick={() => setFocusPreview((value) => !value)} disabled={!job}>{focusPreview ? "返回编辑" : "专注预览"}</button>
        </div>
      </div>
      {currentSlide ? <LayerSeparationBar slide={editableSlide} job={job} slideIndex={selectedSlide} layerMode={layerMode} /> : null}
      <div className="large-slide">
        <div className="editable-slide-stage">
          {currentImage && layerMode === "preview" ? <img src={currentImage} alt={`第 ${selectedSlide + 1} 页大图预览`} /> : currentSlide ? <LayerBaseCanvas slide={editableSlide} job={job} slideIndex={selectedSlide} layerMode={layerMode} /> : <div className="empty-preview">生成后这里显示大图预览</div>}
          {currentSlide && assetLayerActive ? <CanvasAssetLayer slide={editableSlide} job={job} slideIndex={selectedSlide} /> : null}
          {currentSlide && textLayerActive ? <CanvasTextLayer draft={draft} slide={editableSlide} updateDraft={updateDraft} onSave={() => onSaveText?.(draft)} /> : null}
        </div>
      </div>
      {job?.previewWarning ? <div className="preview-warning"><div><b>PNG 预览图未生成，当前使用网页预览</b><span>{job.previewWarning}</span></div><button type="button" onClick={onRetryPreview} disabled={previewBusy}>{previewBusy ? "正在重试" : "重新生成预览图"}</button></div> : null}
    </div>
  );
}

function HybridPreviewStrip({ job, currentImage, selectedSlide = 0 }) {
  if (!job) return null;
  const sample = job.visualTarget?.sample || {};
  const compare = job.visualCompare || {};
  return (
    <div className="hybrid-preview-strip">
      <div>
        <b>视觉目标</b>
        <span>{sample.status === "generated" ? "方向图已生成" : job.visualProject?.status || "待生成"} / 不可编辑中间稿</span>
      </div>
      <div>
        <b>可编辑结果</b>
        <span>{currentImage ? `第 ${selectedSlide + 1} 页预览` : "等待 PPTX 渲染"} / editable-final.pptx</span>
      </div>
      <div>
        <b>一致性</b>
        <span>{compare.score ? `${compare.score}/100` : "待 QA"}</span>
      </div>
    </div>
  );
}

function LayerBaseCanvas({ slide = {}, job, slideIndex = 0, layerMode = "preview" }) {
  const layout = slide.layout || "auto";
  const visualImage = getSlideVisualImage(job, slide, slideIndex);
  const materialImages = getSlideMaterialImages(job, slide, slideIndex);
  return (
    <div className={`layer-base-canvas layout-${layout} mode-${layerMode}`}>
      {visualImage ? (
        <div
          className="layer-base-image"
          style={{ backgroundImage: `url("${visualImage.uploadUrl}")` }}
        />
      ) : null}
      <div className="layer-base-safe-area" />
      {materialImages.slice(0, 4).map((image, index) => {
        const box = buildAssetBoxes(layout, materialImages.length)[index] || { x: 60, y: 22 + index * 14, w: 24, h: 12 };
        return (
          <div
            className="layer-base-slot"
            key={`${image.id || image.uploadUrl}-${index}`}
            style={{ left: `${box.x}%`, top: `${box.y}%`, width: `${box.w}%`, height: `${box.h}%` }}
          />
        );
      })}
    </div>
  );
}

function LayerSeparationBar({ slide = {}, job, slideIndex = 0, layerMode = "preview" }) {
  const textCount = buildCanvasObjects(slide, slide).length;
  const materialCount = getSlideMaterialImages(job, slide, slideIndex).length;
  const hasBackground = Boolean(getSlideVisualImage(job, slide, slideIndex)) && ["cover", "visual", "product-detail", "bundle"].includes(slide.layout);
  const decorationCount = ["cover", "section", "quote", "closing"].includes(slide.layout) ? 2 : 1;
  return (
    <div className="layer-separation-bar">
      <span className={hasBackground ? "active" : ""}>底图 {hasBackground ? 1 : 0}</span>
      <span className={layerMode === "asset" || materialCount ? "active" : ""}>素材 {materialCount}</span>
      <span className={layerMode === "text" ? "active" : ""}>文字 {textCount}</span>
      <span>装饰 {decorationCount}</span>
      <em>{layerMode === "text" ? "正在编辑文字层：拖动蓝色标签移动对象，保存后写回 PPTX。" : layerMode === "asset" ? "正在查看素材层：只显示当前页绑定图片槽，不显示文字编辑框。" : "当前为干净预览：不叠加文字编辑框，避免和底图/预览图重复。"}</em>
    </div>
  );
}

function CanvasAssetLayer({ slide = {}, job, slideIndex = 0 }) {
  const images = getSlideMaterialImages(job, slide, slideIndex);
  const boxes = buildAssetBoxes(slide.layout, images.length);
  return (
    <div className="canvas-asset-layer">
      {images.length ? images.map((image, index) => {
        const box = boxes[index] || boxes[0];
        return (
          <figure className="canvas-asset-box" key={`${image.id || image.originalName}-${index}`} style={{ left: `${box.x}%`, top: `${box.y}%`, width: `${box.w}%`, height: `${box.h}%` }}>
            <img src={image.uploadUrl} alt={image.originalName || "素材图"} />
            <figcaption>素材 {index + 1} · {image.originalName || "未命名"}</figcaption>
          </figure>
        );
      }) : <div className="canvas-empty-layer">当前页没有绑定素材图。到右侧“图片槽 / 素材名”填写文件名，或让 Agent 重新匹配素材。</div>}
    </div>
  );
}

function AIPanel({ deckRevision, dirty, job, revision, setDeckRevision, setRevision, onQuickAction, onRevise, onRewriteDeck }) {
  return (
    <div className="side-section ai-panel">
      <h2>AI 改写</h2>
      <div className="edit-mode-title"><b>单页指令</b><span>让系统帮你重写当前页表达或结构。</span></div>
      <div className="quick-actions">{QUICK_ACTIONS.map((item) => <button key={item} type="button" onMouseDown={(event) => { event.preventDefault(); onQuickAction(item); }} disabled={!job}>{item}</button>)}</div>
      <textarea value={revision} onChange={(e) => setRevision(e.target.value)} placeholder="例如：第 3 页太密，改成两行展示，标题更销售化。" />
      <button className="btn primary wide" onClick={onRevise} disabled={!job || !revision.trim()}>应用到当前页</button>
      <div className="edit-separator" />
      <div className="edit-mode-title"><b>整份 PPT</b><span>适合统一口吻、减少文字或强化行动。</span></div>
      <div className="quick-actions">{DECK_ACTIONS.map((item) => <button key={item} type="button" onMouseDown={(event) => { event.preventDefault(); setDeckRevision(item); }} disabled={!job || dirty}>{item}</button>)}</div>
      <textarea className="compact-textarea" value={deckRevision} onChange={(e) => setDeckRevision(e.target.value)} disabled={!job || dirty} placeholder="例如：整份减少文字，改成客户提案口吻。" />
      <button className="btn primary wide" onClick={onRewriteDeck} disabled={!job || dirty || !deckRevision.trim()}>应用到整份 PPT</button>
    </div>
  );
}

function EditorPanel({ deckRevision, dirty, draft, job, revision, savedDraft, setDeckRevision, setDraft, setRevision, updateDraft, onQuickAction, onRevise, onSaveText, onRewriteDeck, onUndoJob }) {
  return (
    <aside className="editor-panel">
      <div className="edit-mode-title"><div><b>直接编辑当前页</b>{dirty ? <strong>未保存</strong> : <strong className="saved">已同步</strong>}</div><span>保存后写入 SceneGraph，并重新渲染 PPTX 和预览。</span></div>
      <Field label="版式"><button className="btn ghost wide undo-button" type="button" onClick={onUndoJob} disabled={!job?.canUndo || dirty}>{job?.undoLabel || "撤销上一轮修改"}</button><select value={draft.layout} onChange={(e) => updateDraft("layout", e.target.value)} disabled={!job}>{Object.entries(LAYOUT_LABELS).map(([value, label]) => <option key={value} value={value}>{label} / {value}</option>)}</select></Field>
      <Field label="标题"><input value={draft.title} onChange={(e) => updateDraft("title", e.target.value)} disabled={!job} /></Field>
      <Field label="副标题 / 摘要"><textarea className="compact-textarea" value={draft.subtitle} onChange={(e) => updateDraft("subtitle", e.target.value)} disabled={!job} /></Field>
      <Field label="叙事角色"><input value={draft.storyRole} onChange={(e) => updateDraft("storyRole", e.target.value)} disabled={!job} /></Field>
      <Field label="内容来源"><select value={draft.contentSource} onChange={(e) => updateDraft("contentSource", e.target.value)} disabled={!job}>{["用户输入", "用户资料", "用户图片", "系统推断", "待人工确认", "系统推断 + 待人工确认"].map((item) => <option key={item} value={item}>{item}</option>)}</select></Field>
      <Field label="要点（一行一条）"><textarea value={draft.bullets} onChange={(e) => updateDraft("bullets", e.target.value)} disabled={!job} /></Field>
      <details className="advanced-edit" open><summary>高级字段</summary><Field label="讲稿备注"><textarea className="compact-textarea" value={draft.speakerNotes} onChange={(e) => updateDraft("speakerNotes", e.target.value)} disabled={!job} /></Field><Field label="视觉意图"><textarea className="compact-textarea" value={draft.visualIntent} onChange={(e) => updateDraft("visualIntent", e.target.value)} disabled={!job} /></Field><Field label="价格 / 数据点"><textarea className="compact-textarea" value={draft.dataPoints} onChange={(e) => updateDraft("dataPoints", e.target.value)} disabled={!job} /></Field><Field label="图片槽 / 素材名"><textarea className="compact-textarea" value={draft.imageSlots} onChange={(e) => updateDraft("imageSlots", e.target.value)} disabled={!job} /></Field></details>
      <div className="button-row tight"><button className="btn primary" onClick={() => onSaveText(draft)} disabled={!job || !dirty}>保存当前页</button><button className="btn ghost" onClick={() => setDraft(savedDraft)} disabled={!job || !dirty}>放弃修改</button></div>
      <p className="save-hint">也可以按 Ctrl+S 保存当前页。</p>
      <div className="edit-separator" />
      <div className="edit-mode-title"><b>用指令改写</b><span>适合让系统帮你重写表达或调整页面结构。</span></div>
      <div className="quick-actions">{QUICK_ACTIONS.map((item) => <button key={item} type="button" onMouseDown={(event) => { event.preventDefault(); onQuickAction(item); }} disabled={!job}>{item}</button>)}</div>
      <textarea value={revision} onChange={(e) => setRevision(e.target.value)} placeholder="例如：第 3 页产品矩阵太密，改成两行展示。" />
      <button className="btn primary wide" onClick={onRevise} disabled={!job || !revision.trim()}>应用到当前页</button>
      <div className="edit-separator" />
      <div className="edit-mode-title"><b>整份批量改写</b><span>适合统一口吻、减少文字或强化行动。</span></div>
      <div className="quick-actions">{DECK_ACTIONS.map((item) => <button key={item} type="button" onMouseDown={(event) => { event.preventDefault(); setDeckRevision(item); }} disabled={!job || dirty}>{item}</button>)}</div>
      <textarea className="compact-textarea" value={deckRevision} onChange={(e) => setDeckRevision(e.target.value)} disabled={!job || dirty} placeholder="例如：整份减少文字，改成客户提案口吻。" />
      <button className="btn primary wide" onClick={onRewriteDeck} disabled={!job || dirty || !deckRevision.trim()}>应用到整份 PPT</button>
    </aside>
  );
}

function SlideVisual({ slide = {}, job, slideIndex = 0, compact = false }) {
  const bullets = toBulletList(slide.bullets).slice(0, compact ? 2 : 5);
  const dataPoints = toBulletList(slide.dataPoints).slice(0, compact ? 0 : 4);
  const layout = slide.layout || "auto";
  const visualImage = !compact ? getSlideVisualImage(job, slide, slideIndex) : null;
  const usePricingPreview = !compact && layout === "pricing";
  const useProductFacts = !compact && layout === "product-detail" && !visualImage;
  return (
    <div className={`slide-visual ${compact ? "compact" : ""} ${visualImage ? "has-image" : ""} layout-${layout}`}>
      <div className="slide-visual-topline">
        <span>{LAYOUT_LABELS[layout] || layout}</span>
        {slide.storyRole && !compact ? <span>{slide.storyRole}</span> : null}
        {slide.contentSource && !compact ? <span>{slide.contentSource}</span> : null}
        <i />
      </div>
      <h3>{slide.title || "\u672a\u547d\u540d\u9875"}</h3>
      {!compact && slide.subtitle ? <p>{slide.subtitle}</p> : null}
      <div className="slide-visual-body">
        {usePricingPreview ? (
          <PricingPreview entries={normalizePreviewPrices(slide)} />
        ) : useProductFacts ? (
          <>
            <div className="slide-visual-bullets">
              {bullets.length ? bullets.map((item, index) => (
                <span key={`${item}-${index}`}>{item}</span>
              )) : <span>{slide.visualIntent || "\u6682\u65e0\u8981\u70b9\uff0c\u4fdd\u5b58\u540e\u4f1a\u751f\u6210\u9884\u89c8\u3002"}</span>}
            </div>
            <ProductFactPreview facts={buildPreviewProductFacts(slide)} />
          </>
        ) : (
          <>
            <div className="slide-visual-bullets">
              {bullets.length ? bullets.map((item, index) => (
                <span key={`${item}-${index}`}>{item}</span>
              )) : <span>{slide.visualIntent || "\u6682\u65e0\u8981\u70b9\uff0c\u4fdd\u5b58\u540e\u4f1a\u751f\u6210\u9884\u89c8\u3002"}</span>}
            </div>
            {visualImage ? (
              <figure className="slide-visual-image">
                <img src={visualImage.uploadUrl} alt={visualImage.originalName || "\u53c2\u8003\u56fe\u7247"} />
                <figcaption>{visualImage.originalName || "\u53c2\u8003\u56fe\u7247"}</figcaption>
              </figure>
            ) : null}
            {!compact && (dataPoints.length > 0 || ["kpi", "compare", "timeline"].includes(layout)) ? (
              <div className="slide-visual-data">
                {(dataPoints.length ? dataPoints : bullets.slice(0, 3)).map((item, index) => (
                  <b key={`${item}-${index}`}>{item}</b>
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function PricingPreview({ entries }) {
  return (
    <div className="slide-visual-pricing">
      {entries.map((entry, index) => (
        <div className={`price-card ${entry.accented ? "accent" : ""}`} key={`${entry.price}-${index}`}>
          <span>{entry.tier}</span>
          <b>{entry.price}</b>
          <strong>{entry.label}</strong>
          <em>{entry.note}</em>
        </div>
      ))}
    </div>
  );
}

function ProductFactPreview({ facts }) {
  return (
    <div className="slide-visual-facts">
      <b>{"\u4ea7\u54c1\u4fe1\u606f"}</b>
      {facts.map((fact) => (
        <span key={fact.label}><small>{fact.label}</small><strong>{fact.value}</strong></span>
      ))}
    </div>
  );
}

const CANVAS_FIELD_FALLBACKS = {
  title: { label: "标题", box: { x: 56, y: 18, w: 36, h: 13 }, fontSize: 28, bold: true },
  subtitle: { label: "副标题", box: { x: 56, y: 34, w: 36, h: 10 }, fontSize: 14 },
  visualIntent: { label: "视觉意图", box: { x: 56, y: 47, w: 36, h: 10 }, fontSize: 10 },
  speakerNotes: { label: "讲稿备注", box: { x: 56, y: 72, w: 36, h: 18 }, fontSize: 9 }
};

const CANVAS_LAYOUT_BOXES = {
  cover: {
    title: { x: 8, y: 24, w: 48, h: 14 },
    subtitle: { x: 8, y: 42, w: 45, h: 8 },
    bulletStart: { x: 8, y: 58, w: 36, h: 5 }
  },
  cards: {
    title: { x: 8, y: 12, w: 50, h: 10 },
    subtitle: { x: 8, y: 25, w: 44, h: 7 },
    bulletStart: { x: 10, y: 40, w: 30, h: 5 },
    dataStart: { x: 53, y: 38, w: 34, h: 5 }
  },
  bundle: {
    title: { x: 8, y: 11, w: 48, h: 10 },
    subtitle: { x: 8, y: 24, w: 42, h: 7 },
    bulletStart: { x: 8, y: 39, w: 38, h: 5 },
    dataStart: { x: 54, y: 36, w: 34, h: 5 }
  },
  kpi: {
    title: { x: 8, y: 10, w: 48, h: 10 },
    subtitle: { x: 8, y: 23, w: 42, h: 7 },
    bulletStart: { x: 8, y: 58, w: 38, h: 5 },
    dataStart: { x: 14, y: 34, w: 24, h: 6 }
  },
  pricing: {
    title: { x: 8, y: 11, w: 42, h: 10 },
    subtitle: { x: 8, y: 24, w: 44, h: 8 },
    bulletStart: { x: 8, y: 40, w: 36, h: 5 },
    dataStart: { x: 52, y: 34, w: 36, h: 5 }
  },
  "product-detail": {
    title: { x: 8, y: 11, w: 42, h: 10 },
    subtitle: { x: 8, y: 25, w: 40, h: 8 },
    bulletStart: { x: 8, y: 42, w: 34, h: 5 },
    dataStart: { x: 52, y: 30, w: 34, h: 5 }
  },
  compare: {
    title: { x: 8, y: 10, w: 48, h: 10 },
    subtitle: { x: 8, y: 23, w: 42, h: 7 },
    bulletStart: { x: 8, y: 38, w: 35, h: 5 },
    dataStart: { x: 53, y: 38, w: 35, h: 5 }
  },
  "risk-checklist": {
    title: { x: 8, y: 12, w: 50, h: 10 },
    subtitle: { x: 8, y: 25, w: 44, h: 7 },
    bulletStart: { x: 10, y: 38, w: 46, h: 5 }
  },
  section: {
    title: { x: 10, y: 33, w: 58, h: 13 },
    subtitle: { x: 10, y: 51, w: 44, h: 8 },
    bulletStart: { x: 10, y: 65, w: 40, h: 5 }
  },
  closing: {
    title: { x: 12, y: 32, w: 54, h: 13 },
    subtitle: { x: 12, y: 50, w: 46, h: 8 },
    bulletStart: { x: 12, y: 64, w: 40, h: 5 }
  },
  default: {
    title: { x: 8, y: 11, w: 48, h: 10 },
    subtitle: { x: 8, y: 25, w: 48, h: 8 },
    bulletStart: { x: 8, y: 42, w: 42, h: 5 },
    dataStart: { x: 56, y: 36, w: 34, h: 5 }
  }
};

function CanvasTextLayer({ draft = {}, slide = {}, updateDraft, onSave }) {
  const [drag, setDrag] = useState(null);
  const canvasObjects = useMemo(() => buildCanvasObjects(draft, slide), [draft, slide]);
  const edits = normalizeCanvasEdits(draft.canvasEdits || slide.canvasEdits, canvasObjects);

  function patchCanvasEdit(key, patch) {
    const current = normalizeCanvasEdits(draft.canvasEdits || slide.canvasEdits);
    updateDraft?.("canvasEdits", {
      ...current,
      [key]: { ...current[key], ...patch }
    });
  }

  function patchText(object, value) {
    if (object.path === "bullet") {
      const next = [...toBulletList(draft.bullets ?? slide.bullets)];
      next[object.index] = value;
      updateDraft?.("bullets", next);
      return;
    }
    if (object.path === "dataPoint") {
      const next = [...toBulletList(draft.dataPoints ?? slide.dataPoints)];
      next[object.index] = value;
      updateDraft?.("dataPoints", next);
      return;
    }
    updateDraft?.(object.key, value);
  }

  function startDrag(event, key) {
    event.preventDefault();
    event.stopPropagation();
    const box = edits[key]?.box || canvasObjects.find((item) => item.key === key)?.box;
    if (!box) return;
    setDrag({
      key,
      startX: event.clientX,
      startY: event.clientY,
      box: { ...box }
    });
  }

  useEffect(() => {
    if (!drag) return undefined;
    function onMove(event) {
      const stage = document.querySelector(".editable-slide-stage");
      const rect = stage?.getBoundingClientRect();
      if (!rect) return;
      const nextX = clamp(drag.box.x + ((event.clientX - drag.startX) / rect.width) * 100, 0, 96);
      const nextY = clamp(drag.box.y + ((event.clientY - drag.startY) / rect.height) * 100, 0, 96);
      patchCanvasEdit(drag.key, { box: { ...drag.box, x: nextX, y: nextY } });
    }
    function onUp() {
      setDrag(null);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [drag]);

  return (
    <div className="canvas-text-layer">
      {canvasObjects.map((field) => {
        const edit = edits[field.key] || { box: field.box };
        const box = edit.box || field.box;
        return (
          <div
            className={`canvas-text-box canvas-${field.key}`}
            key={field.key}
            style={{ left: `${box.x}%`, top: `${box.y}%`, width: `${box.w}%`, height: `${box.h}%` }}
          >
            <button type="button" className="canvas-drag-handle" onPointerDown={(event) => startDrag(event, field.key)} title="拖动位置">{field.label}</button>
            <textarea
              value={field.value || ""}
              onChange={(event) => patchText(field, event.target.value)}
              onBlur={onSave}
              onClick={(event) => event.stopPropagation()}
            />
          </div>
        );
      })}
    </div>
  );
}

function buildCanvasObjects(draft = {}, slide = {}) {
  const layout = draft.layout || slide.layout || "default";
  const boxes = CANVAS_LAYOUT_BOXES[layout] || CANVAS_LAYOUT_BOXES.default;
  const bullets = toBulletList(draft.bullets ?? slide.bullets);
  const dataPoints = toBulletList(draft.dataPoints ?? slide.dataPoints);
  const objects = [
    buildCanvasObject("title", "标题", draft.title ?? slide.title ?? "", boxes.title || CANVAS_FIELD_FALLBACKS.title.box),
    buildCanvasObject("subtitle", "副标题", draft.subtitle ?? slide.subtitle ?? "", boxes.subtitle || CANVAS_FIELD_FALLBACKS.subtitle.box)
  ];
  bullets.forEach((value, index) => {
    objects.push(buildCanvasObject(`bullet_${index}`, `要点 ${index + 1}`, value, stackBox(boxes.bulletStart || CANVAS_LAYOUT_BOXES.default.bulletStart, index), "bullet", index));
  });
  if (["pricing", "kpi", "compare", "timeline", "product-detail"].includes(layout)) {
    dataPoints.forEach((value, index) => {
      objects.push(buildCanvasObject(`data_${index}`, `数据 ${index + 1}`, value, stackBox(boxes.dataStart || CANVAS_LAYOUT_BOXES.default.dataStart, index), "dataPoint", index));
    });
  }
  return objects.filter((item) => String(item.value || "").trim());
}

function buildCanvasObject(key, label, value, box, path = key, index = null) {
  return { key, label, value: String(value || ""), box, path, index };
}

function stackBox(startBox, index) {
  return {
    x: startBox.x,
    y: clamp(startBox.y + index * 7, 0, 92),
    w: startBox.w,
    h: startBox.h
  };
}

function normalizeCanvasEdits(value = {}, canvasObjects = []) {
  const edits = typeof value === "object" && value ? value : {};
  const known = new Map(canvasObjects.map((field) => [field.key, field]));
  const keys = new Set([...known.keys(), ...Object.keys(edits).filter((key) => /^[a-zA-Z][\w-]{0,40}$/.test(key))]);
  return [...keys].reduce((acc, key) => {
    const field = known.get(key);
    const box = edits[key]?.box || field?.box;
    if (!box) return acc;
    acc[key] = {
      ...edits[key],
      box: {
        x: clamp(Number(box.x ?? field?.box?.x), 0, 96),
        y: clamp(Number(box.y ?? field?.box?.y), 0, 96),
        w: clamp(Number(box.w ?? field?.box?.w), 8, 96),
        h: clamp(Number(box.h ?? field?.box?.h), 4, 96)
      }
    };
    return acc;
  }, {});
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function buildDeliveryChecks(job = {}) {
  if (!job?.deck?.slides?.length && !job?.quality) return [];
  const quality = job.quality || {};
  const material = quality.material || job.input?.materialBrief || {};
  const route = quality.routePlan || job.input?.routePlan || {};
  const slideCount = quality.slideCount || job.deck?.slides?.length || 0;
  const usedLayouts = quality.usedLayouts || Object.keys(quality.layoutCounts || {});
  const routeScore = Number(quality.routeAdherence?.score);
  const confirmationCount = Array.isArray(material.confirmationFields) ? material.confirmationFields.length : 0;
  const blockingWarnings = getBlockingWarnings(job);
  const warningCount = blockingWarnings.length + (job.previewWarning ? 1 : 0) + (job.exportWarning ? 1 : 0) + (job.warning && !isNonBlockingWarning(job.warning) ? 1 : 0);
  const riskCount = Array.isArray(quality.risks) ? quality.risks.length : 0;
  const imageCount = Number(material.imageCount || route.imageStrategy?.imageCount || 0);
  const imageSlotCount = Number(quality.imageSlotCount || 0);
  const localQa = quality.localImageQa || {};
  const renderQa = quality.renderImageQa || {};
  const aesthetic = quality.aestheticDiagnosis || material.sourceReport?.aestheticDiagnosis || {};
  const minLayoutVariety = Math.min(5, Math.max(2, Math.ceil(slideCount / 3)));
  return [
    { label: "\u9875\u6570", value: slideCount ? `${slideCount} \u9875` : "\u672a\u751f\u6210", state: slideCount >= 5 ? "pass" : slideCount > 0 ? "warn" : "fail" },
    { label: "\u7248\u5f0f", value: `${usedLayouts.length || 0} \u79cd`, state: usedLayouts.length >= minLayoutVariety ? "pass" : usedLayouts.length > 0 ? "warn" : "fail" },
    { label: "\u8def\u7531", value: Number.isFinite(routeScore) ? `${Math.round(routeScore * 100)}%` : route.templatePack?.name || "\u672a\u77e5", state: Number.isFinite(routeScore) && routeScore < 0.75 ? "warn" : "pass" },
    { label: "\u56fe\u7247", value: imageCount ? `${imageSlotCount} \u69fd` : "\u65e0\u56fe", state: imageCount && imageSlotCount === 0 ? "warn" : "pass" },
    { label: "\u672c\u5730\u56fe QA", value: localQa.total ? `${localQa.passCount || 0}/${localQa.total}` : "\u672a\u626b\u63cf", state: localQa.warnCount ? "warn" : "pass" },
    { label: "\u6bd4\u4f8b QA", value: renderQa.total ? `${renderQa.total} \u5f20` : "\u672a\u626b\u63cf", state: renderQa.warningCount ? "warn" : renderQa.total ? "pass" : "warn" },
    { label: "\u7f8e\u5b66\u8bca\u65ad", value: Number.isFinite(Number(aesthetic.overallScore)) ? `${aesthetic.overallScore} \u5206` : "\u672a\u8bca\u65ad", state: Number.isFinite(Number(aesthetic.overallScore)) ? Number(aesthetic.overallScore) < 72 ? "warn" : "pass" : material.sourceReport?.hasOldDeck ? "warn" : "pass" },
    { label: "\u98ce\u683c\u786e\u8ba4", value: job.mode === "style-preview" ? "\u6837\u5f20" : job.input?.styleProofConfirmation?.id ? "\u5df2\u786e\u8ba4" : "\u672a\u786e\u8ba4", state: job.mode === "style-preview" || job.input?.styleProofConfirmation?.id ? "pass" : "warn" },
    { label: "\u5f85\u786e\u8ba4", value: confirmationCount ? `${confirmationCount} \u9879` : "\u65e0", state: confirmationCount ? "warn" : "pass" },
    { label: "\u98ce\u9669", value: riskCount ? `${riskCount} \u9879` : "\u65e0", state: riskCount ? "warn" : "pass" },
    { label: "\u544a\u8b66", value: warningCount ? `${warningCount} \u9879` : "\u65e0", state: warningCount ? "warn" : "pass" }
  ];
}

function buildDeliveryIssues(job = {}) {
  if (!job) return [];
  const quality = job.quality || {};
  const material = quality.material || job.input?.materialBrief || {};
  return [
    ...(quality.risks || []),
    ...(quality.routingWarnings || []),
    ...((quality.localImageQa?.risks || []).map((item) => `本地图风险：${localQaRiskLabel(item)}`)),
    ...((quality.renderImageQa?.warnings || []).map((item) => `图片比例风险：${renderQaRiskLabel(item)}`)),
    ...getBlockingWarnings(job),
    job.warning,
    job.previewWarning,
    job.exportWarning,
    ...(material.confirmationFields?.length ? [`待确认：${material.confirmationFields.slice(0, 3).join(" / ")}`] : [])
  ].filter((item) => item && !isNonBlockingWarning(item)).slice(0, 3);
}

function renderQaRiskLabel(value = "") {
  const map = {
    "cover-crops-too-much": "封面裁切过多",
    "contain-leaves-too-much-empty-space": "留白过多",
    "landscape-scene-should-be-hero-or-background": "横图更适合作底图或主视觉"
  };
  return map[value] || value;
}

function localQaRiskLabel(value = "") {
  const map = {
    "image-may-be-too-blank": "图片主体偏弱",
    "text-safe-area-too-busy": "文字安全区过花",
    "possible-readable-text-or-labels": "图片内可能有可读文字",
    "possible-small-dark-text-or-labels": "图片内可能有小字",
    "high-contrast-foreground-may-include-text": "前景高对比内容需检查",
    "qa-failed": "图片检测失败"
  };
  return map[value] || value;
}

function getBlockingWarnings(job = {}) {
  return (job.quality?.warnings || []).filter((item) => !isNonBlockingWarning(item));
}

function isNonBlockingWarning(value = "") {
  const text = String(value || "");
  return /bullet/i.test(text) && /(截断|已截断|保护版式|truncated)/i.test(text);
}

function hasRepairableDeliveryIssues(job = {}) {
  if (!job) return false;
  const checks = buildDeliveryChecks(job);
  return checks.some((item) => item.state !== "pass");
}

function AgentWorkRecord({ job, files = [] }) {
  const decision = job?.agentDecision || {};
  const route = job?.quality?.routePlan || job?.input?.routePlan || job?.agentPlan?.route || {};
  const material = job?.quality?.material || job?.input?.materialBrief || {};
  const routeReasons = uniqueList([...(route.routingReasons || []), ...(job?.agentPlan?.route?.reasons || [])]);
  const fixes = job?.agentFixes || [];
  const finalAssessment = decision.finalAssessment || {};
  const confirmationItems = uniqueList([...(material.confirmationFields || []), ...(finalAssessment.hints || [])]);
  return (
    <div className="agent-record">
      <div className="agent-record-header">
        <b>Agent {"\u5de5\u4f5c\u8bb0\u5f55"}</b>
        <span>{decision.hasOldDeck ? "旧稿优化" : "新建 PPT"}</span>
      </div>
      <div className="agent-record-grid">
        <RecordBlock title="任务意图" value={decision.intent || "PPT 生成"} detail={`${inputStrengthLabel(decision.inputStrength || material.inputStrength)} / ${decision.targetSlides || route.targetSlides || job?.deck?.slides?.length || 0} 页`} />
        <RecordBlock title="资料规模" value="已解析" detail={`文字 ${material.charCount || 0} 字 / 图片 ${material.imageCount || 0} 张 / 价格 ${material.priceCount || 0} 条`} />
        <RecordBlock title="智能路由" value={route.deckType || decision.routeType || "待识别"} detail={routeReasons.slice(0, 2).join(" / ") || "暂无原因"} />
        <RecordBlock title="自动修复" value={fixes.length ? `${fixes.length} 轮` : "未触发"} detail={fixes[0]?.changes?.slice(0, 2).join(" / ") || "暂无修复"} />
      </div>
      <div className="agent-record-section">
        <b>{"\u6267\u884c\u6b65\u9aa4"}</b>
        <ol>
          {(job.agentSteps || []).map((step) => (
            <li className={step.status || "done"} key={`${step.id}-${step.at}`}>
              <span>{step.label}</span>
              <small>{step.summary || step.status}</small>
            </li>
          ))}
        </ol>
      </div>
      <div className="agent-record-section">
        <b>{"\u5f85\u786e\u8ba4\u4e8b\u9879"}</b>
        {confirmationItems.length ? (
          <div className="confirm-chip-list">
            {confirmationItems.slice(0, 8).map((item) => <span key={item}>{item}</span>)}
          </div>
        ) : (
          <p>{"\u6682\u65e0\u9700\u8981\u4eba\u5de5\u786e\u8ba4\u7684\u4e8b\u9879"}</p>
        )}
      </div>
    </div>
  );
}

function RecordBlock({ title, value, detail }) {
  return (
    <div className="record-block">
      <span>{title}</span>
      <b>{value}</b>
      <small>{detail}</small>
    </div>
  );
}

function VisualProjectWorkspace({ job, onGenerateSlides }) {
  const project = job?.visualProject || {};
  const manifest = job?.assetManifest || {};
  const qa = job?.assetManifestQa || {};
  const slideJobs = job?.pipeline?.slideJobs || [];
  if (!job) return <div className="visual-project-empty">先上传资料并生成任务，这里会显示 codex-ppt 式视觉生产链路。</div>;
  return (
    <div className="hybrid-workspace">
      <div className={`hybrid-card ${qa.status || "pass"}`}>
        <div className="hybrid-card-head"><b>素材中枢 Asset Manifest</b><span>{qa.status || manifest.status || "ready"}</span></div>
        <p>Logo、产品图、图表、价格和正文从一开始锁定身份，禁止混入底图。</p>
        <div className="hybrid-facts">
          <span>{manifest.assets?.length || 0} 素材</span>
          <span>{manifest.criticalCount || 0} 必须保留</span>
          <span>{manifest.backgroundBlockedCount || 0} 禁入底图</span>
        </div>
        {manifest.hardRules?.length ? <small>{manifest.hardRules.slice(0, 2).join(" / ")}</small> : null}
      </div>
      <div className={`hybrid-card ${project.status === "ready" ? "pass" : "warn"}`}>
        <div className="hybrid-card-head"><b>Visual Project</b><span>{project.status || "not-created"}</span></div>
        <p>生成 outline、deck_spec、逐页 prompt 和 slide_jobs；视觉目标 PPTX 只作为中间稿。</p>
        <div className="hybrid-facts">
          <span>{project.slideCount || 0} 页</span>
          <span>{project.generatedImages || 0} 张视觉图</span>
          <span>{project.generatedSceneGraphs || 0} 个可编辑页结构</span>
          <span>{project.visualTargetPptxPath ? "visual-target.pptx" : "待生成视觉 PPTX"}</span>
        </div>
        <div className="hybrid-links">
          {project.urls?.outlineUrl ? <a href={project.urls.outlineUrl} target="_blank" rel="noreferrer">outline.md</a> : null}
          {project.urls?.deckSpecUrl ? <a href={project.urls.deckSpecUrl} target="_blank" rel="noreferrer">deck_spec.json</a> : null}
          {project.urls?.slideJobsUrl ? <a href={project.urls.slideJobsUrl} target="_blank" rel="noreferrer">slide_jobs.json</a> : null}
          {project.urls?.slideSceneGraphManifestUrl ? <a href={project.urls.slideSceneGraphManifestUrl} target="_blank" rel="noreferrer">slide_scenegraphs.json</a> : null}
          {project.urls?.contactSheetUrl ? <a href={project.urls.contactSheetUrl} target="_blank" rel="noreferrer">contact sheet</a> : null}
          {project.urls?.visualTargetPptxUrl ? <a href={project.urls.visualTargetPptxUrl} target="_blank" rel="noreferrer">visual-target.pptx</a> : null}
        </div>
        {onGenerateSlides ? (
          <div className="button-row tight">
            <button className="btn primary" type="button" onClick={() => onGenerateSlides(3)}>生成 3 页视觉图</button>
            <button className="btn ghost" type="button" onClick={() => onGenerateSlides("all")}>全量生成</button>
          </div>
        ) : null}
        {project.warnings?.length ? <small>{project.warnings.slice(0, 3).join(" / ")}</small> : null}
        {project.originImages?.length ? (
          <div className="origin-image-strip">
            {project.originImages.slice(0, 12).map((item) => <img key={item.name} src={item.url} alt={item.name} title={item.name} />)}
          </div>
        ) : null}
      </div>
      <div className="hybrid-card wide">
        <div className="hybrid-card-head"><b>逐页 Worker 任务</b><span>{slideJobs.length || project.slideCount || 0}</span></div>
        <div className="hybrid-job-grid">
          {(slideJobs.length ? slideJobs : Array.from({ length: project.slideCount || 0 }, (_, index) => ({ id: `slide_${String(index + 1).padStart(2, "0")}`, index: index + 1, status: "pending" }))).slice(0, 16).map((item) => (
            <span className={item.status || "pending"} key={item.id}>
              <strong>{String(item.index || item.slide || "").padStart(2, "0")}</strong>
              {item.layout || item.role || item.status || "pending"}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function HybridQaWorkspace({ job, selectedSlide = 0, setSelectedSlide, currentImage }) {
  if (!job) return <div className="visual-project-empty">生成后这里会显示视觉目标与可编辑结果的双轨 QA。</div>;
  const target = job.visualTarget || {};
  const project = job.visualProject || {};
  const compare = job.visualCompare || {};
  const edit = job.quality?.pptxEditability || {};
  const sceneQa = job.sceneGraphQa || {};
  const hybridQa = job.hybridQa || {};
  const sample = target.sample || {};
  const sceneSlides = Array.isArray(job.sceneGraph?.slides) ? job.sceneGraph.slides : [];
  const slideCount = Math.max(sceneSlides.length, (project.originImages || []).length, (job.previewImages || []).length, project.slideCount || 0);
  const currentOriginImage = (project.originImages || []).find((item) => Number(item.slide) === selectedSlide + 1);
  const visualImage = currentOriginImage?.url || sample.imageUrl || null;
  const currentSceneSlide = sceneSlides[selectedSlide] || null;
  const categories = hybridQa.categories || {};
  const qaItems = [
    { label: "内容完整度", value: categories.content?.blockers?.length ? "阻断" : categories.content?.warnings?.length ? "需复核" : "通过", state: categories.content?.status || (sceneQa.warnings?.length ? "warn" : "pass") },
    { label: "素材完整度", value: `${job.assetManifest?.criticalCount || 0} 关键素材`, state: categories.assets?.status || (job.assetManifestQa?.status === "block" ? "block" : "pass") },
    { label: "视觉一致性", value: compare.score ? `${compare.score}/100` : "待对比", state: categories.visual?.status || compare.status || "warn" },
    { label: "可编辑完整度", value: `${edit.nativeTextBoxes || 0} 文本 / ${edit.nativeShapes || 0} shape`, state: categories.editable?.status || (edit.editable === false ? "block" : "pass") }
  ];
  return (
    <div className="dual-preview-workspace">
      {slideCount > 1 ? (
        <div className="dual-slide-selector" aria-label="选择双轨 QA 页码">
          {Array.from({ length: slideCount }, (_, index) => (
            <button
              className={index === selectedSlide ? "active" : ""}
              key={`dual-slide-${index}`}
              type="button"
              onClick={() => setSelectedSlide?.(index)}
            >
              {String(index + 1).padStart(2, "0")}
            </button>
          ))}
        </div>
      ) : null}
      <div className="dual-preview-grid">
        <div className="dual-preview-pane">
          <div className="dual-preview-head"><b>视觉目标</b><span>不可编辑 / 中间产物</span></div>
          {visualImage ? <img src={visualImage} alt="visual target" /> : <div className="dual-preview-empty">等待 visual target sample / origin_image</div>}
          <small>{currentOriginImage?.name || (project.visualTargetPptxPath ? "visual-target.pptx 已准备" : "origin_image 未齐，视觉目标 PPTX 待生成")}</small>
        </div>
        <div className="dual-preview-pane">
          <div className="dual-preview-head"><b>可编辑结果</b><span>最终交付 / SceneGraph</span></div>
          {currentImage ? <img src={currentImage} alt={`editable preview ${selectedSlide + 1}`} /> : <div className="dual-preview-empty">等待 PPTX 渲染预览</div>}
          <small>editable-final.pptx：文本、shape、独立图片由 SceneGraph 渲染。</small>
        </div>
      </div>
      <div className="hybrid-qa-grid">
        {qaItems.map((item) => <div className={`hybrid-qa-item ${item.state}`} key={item.label}><span>{item.label}</span><b>{item.value}</b></div>)}
      </div>
      <SlideSceneGraphAssetEvidence slide={currentSceneSlide} />
      <HybridQaDetail qa={hybridQa} />
      {compare.items?.length ? (
        <div className="hybrid-card wide">
          <div className="hybrid-card-head"><b>逐页一致性</b><span>{compare.method || "structural"}</span></div>
          <div className="hybrid-job-grid">
            {compare.items.slice(0, 12).map((item) => <span className={item.status || "pass"} key={item.slideId}><strong>{item.slideId}</strong>{item.score || 0}</span>)}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SlideSceneGraphAssetEvidence({ slide }) {
  if (!slide) return null;
  const images = Array.isArray(slide.images) ? slide.images : [];
  const texts = Array.isArray(slide.texts) ? slide.texts : [];
  const shapes = [...(slide.shapes || []), ...(slide.decorations || [])];
  const background = slide.layers?.background || {};
  const backgroundBlocked = Boolean(background.containsCriticalText || background.containsLogo || background.containsProductHero || background.containsKeyData);
  const visualTargetName = slide.source?.visualTargetImage ? slide.source.visualTargetImage.split(/[\\/]/).pop() : "";
  return (
    <div className={`hybrid-card wide ${backgroundBlocked ? "block" : "pass"}`}>
      <div className="hybrid-card-head">
        <b>当前页 SceneGraph 素材层</b>
        <span>{backgroundBlocked ? "背景违规" : "三层安全"}</span>
      </div>
      <div className="asset-evidence-grid">
        <span><b>{texts.length}</b> 文本框</span>
        <span><b>{shapes.length}</b> shape / 装饰</span>
        <span><b>{images.length}</b> 独立图片</span>
        <span><b>{background.forbiddenKinds?.length || 0}</b> 禁入底图类型</span>
      </div>
      <div className="asset-evidence-list">
        {visualTargetName ? (
          <div className="asset-evidence-row reference-only">
            <strong>{visualTargetName}</strong>
            <span>visual-target-reference-only</span>
            <small>不进入最终图片层 / 不作为 PPT 背景</small>
          </div>
        ) : null}
        {images.length ? images.slice(0, 4).map((image) => (
          <div className="asset-evidence-row" key={image.id || image.path || image.name}>
            <strong>{image.name || image.id || "image"}</strong>
            <span>{image.provenance?.selectionReason || image.provenance?.source || "independent-image"}</span>
            <small>
              {[image.role, image.provenance?.mattingStatus, image.provenance?.derived ? "derived" : "", image.fullSlide ? "full-slide-risk" : "editable-object"].filter(Boolean).join(" / ")}
            </small>
          </div>
        )) : <small>当前页没有独立图片对象；如果这是图片主导页，需要检查素材抽取或 imageSlots。</small>}
      </div>
      <small>
        背景层只允许氛围/纹理/光影；标题、正文、价格、Logo、产品主体和关键数据必须在文本框或独立图片对象里。
      </small>
    </div>
  );
}

function HybridQaDetail({ qa = {} }) {
  const categories = qa.categories || {};
  const rows = [
    ["内容 QA", categories.content],
    ["素材 QA", categories.assets],
    ["可编辑 QA", categories.editable],
    ["视觉 QA", categories.visual]
  ].filter(([, item]) => item);
  if (!rows.length) return null;
  return (
    <div className="hybrid-card wide">
      <div className="hybrid-card-head"><b>四类 QA</b><span>{qa.status || "pending"}</span></div>
      <div className="hybrid-qa-detail">
        {rows.map(([label, item]) => (
          <div className={`hybrid-qa-detail-row ${item.status}`} key={label}>
            <b>{label}</b>
            <span>{item.status}</span>
            <small>{[...(item.blockers || []), ...(item.warnings || [])].slice(0, 3).join(" / ") || "通过"}</small>
          </div>
        ))}
      </div>
      {qa.autoRepairLog?.length ? <small>自动返工：{qa.autoRepairLog.slice(0, 4).map((item) => `${item.type}:${item.status}`).join(" / ")}</small> : null}
    </div>
  );
}

function PipelineCard({ pipeline }) {
  if (!pipeline?.stages?.length) return null;
  const statusText = { pass: "通过", warn: "需检查", block: "阻断", skipped: "跳过" };
  const jobs = Array.isArray(pipeline.slideJobs) ? pipeline.slideJobs : [];
  return (
    <div className="pipeline-card">
      <div className="pipeline-head">
        <b>设计流水线</b>
        <span>{pipeline.lastCompletedStage || "pending"}</span>
      </div>
      <div className="pipeline-stage-list">
        {pipeline.stages.map((stage) => (
          <div className={`pipeline-stage ${stage.status || "skipped"}`} key={stage.id}>
            <span>{stage.label}</span>
            <b>{statusText[stage.status] || stage.status}</b>
            <small>{stage.summary}</small>
          </div>
        ))}
      </div>
      {jobs.length ? (
        <div className="pipeline-slide-jobs">
          {jobs.slice(0, 8).map((job) => (
            <span className={job.status || "editable-ready"} key={job.id}>
              <strong>{String(job.index).padStart(2, "0")}</strong>
              {job.layout || job.role || "slide"}
            </span>
          ))}
        </div>
      ) : null}
      {pipeline.blockingReasons?.length ? <small className="pipeline-blockers">{pipeline.blockingReasons.slice(0, 2).join(" / ")}</small> : null}
    </div>
  );
}

function EditableRebuildCard({ plan }) {
  if (!plan?.candidate) return null;
  const pages = Array.isArray(plan.pages) ? plan.pages : [];
  const statusLabel = plan.status === "active" ? "已规划" : plan.status === "warn" ? "需复核" : plan.status || "待处理";
  return (
    <div className={`editable-rebuild-card ${plan.status || "warn"}`}>
      <div className="editable-rebuild-head">
        <b>对象级可编辑重建</b>
        <span>{statusLabel}</span>
      </div>
      <p>{plan.reason}</p>
      <div className="editable-rebuild-facts">
        <span>{plan.inputType || "mixed"}</span>
        <span>{plan.pageCount || pages.length || 0} 页</span>
        <span>{(plan.warnings || []).length} 风险</span>
      </div>
      {plan.hardRules?.length ? (
        <ul>
          {plan.hardRules.slice(0, 3).map((rule) => <li key={rule}>{rule}</li>)}
        </ul>
      ) : null}
      {pages.length ? (
        <div className="editable-page-list">
          {pages.slice(0, 6).map((page) => {
            const manifest = page.editableManifest || {};
            const textCount = manifest.text_boxes?.length || 0;
            const imageCount = manifest.images?.length || 0;
            return (
              <div className={page.qa?.fakeEditableRisk ? "warn" : "pass"} key={page.pageId}>
                <strong>#{String(page.index).padStart(2, "0")} {page.title || page.pageId}</strong>
                <small>{textCount} 文本框 / {imageCount} 图片对象 / {page.source?.status || "source"}</small>
                {page.qa?.warnings?.length ? <em>{page.qa.warnings.slice(0, 2).join(" / ")}</em> : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {plan.warnings?.length ? <small className="editable-rebuild-warning">{plan.warnings.slice(0, 2).join(" / ")}</small> : null}
    </div>
  );
}

function VisualTargetCard({ target, onGenerateSample, localImage }) {
  if (!target) return null;
  const pages = Array.isArray(target.pageTargets) ? target.pageTargets : [];
  const sample = target.sample || {};
  return (
    <div className="scenegraph-card">
      <div className="scenegraph-head">
        <b>视觉目标方向图</b>
        <span>{sample.status || target.status || "brief"}</span>
      </div>
      <p>{target.styleBrief || "已生成视觉目标 brief；img2/codex-ppt 只作为风格参考，不作为最终整页背景。"}</p>
      <div className="scenegraph-facts">
        <span>{target.engine || "visual-target"}</span>
        <span>{target.density || "density"}</span>
        <span>{sample.status || "sample-not-generated"}</span>
      </div>
      {sample.imageUrl ? <img className="visual-target-sample" src={sample.imageUrl} alt="visual target sample" /> : null}
      {sample.prompt ? <small className="scenegraph-warning">{sample.prompt.slice(0, 180)}</small> : null}
      {onGenerateSample ? <button className="btn ghost wide" type="button" onClick={onGenerateSample} disabled={localImage?.state !== "online"}>{localImage?.state === "online" ? "生成视觉目标方向图" : "等待本地生图在线"}</button> : null}
      {pages.length ? (
        <div className="scenegraph-page-list">
          {pages.slice(0, 5).map((page) => (
            <div className="pass" key={page.slideId}>
              <strong>{page.slideId} / {page.role}</strong>
              <small>{page.composition} / image {page.imagePriority}</small>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SceneGraphCard({ graph, qa }) {
  if (!graph?.slides?.length && !qa) return null;
  const slides = Array.isArray(graph?.slides) ? graph.slides : [];
  const status = qa?.status || "pass";
  return (
    <div className={`scenegraph-card ${status}`}>
      <div className="scenegraph-head">
        <b>SceneGraph 可编辑真源</b>
        <span>{status}</span>
      </div>
      <p>最终 PPTX 从 SceneGraph 渲染：文本是真文本框，色块是 shape，图片是独立对象。</p>
      <div className="scenegraph-facts">
        <span>{qa?.slideCount || slides.length || 0} 页</span>
        <span>{qa?.textBoxes || 0} 文本框</span>
        <span>{qa?.shapeCount || 0} 形状</span>
        <span>{qa?.imageCount || 0} 图片</span>
      </div>
      {slides.length ? (
        <div className="scenegraph-page-list">
          {slides.slice(0, 6).map((slide) => (
            <div className="pass" key={slide.id}>
              <strong>#{String(slide.index).padStart(2, "0")} {slide.role}</strong>
              <small>{slide.texts?.length || 0} text / {slide.shapes?.length || 0} shapes / {slide.images?.length || 0} images</small>
            </div>
          ))}
        </div>
      ) : null}
      {qa?.warnings?.length || qa?.errors?.length ? <small className="scenegraph-warning">{[...(qa.errors || []), ...(qa.warnings || [])].slice(0, 2).join(" / ")}</small> : null}
    </div>
  );
}

function VisualCompareCard({ compare }) {
  if (!compare) return null;
  const items = Array.isArray(compare.items) ? compare.items : [];
  return (
    <div className={`scenegraph-card ${compare.status || "pass"}`}>
      <div className="scenegraph-head">
        <b>视觉一致性评分</b>
        <span>{compare.score || 0}</span>
      </div>
      <p>{compare.note || "检查 SceneGraph 渲染结构是否贴近视觉目标；后续可升级为截图级对比。"}</p>
      {items.length ? (
        <div className="scenegraph-page-list">
          {items.slice(0, 5).map((item) => (
            <div className={item.status || "pass"} key={item.slideId}>
              <strong>{item.slideId} / {item.score}</strong>
              <small>{item.warnings?.length ? item.warnings.join(" / ") : "结构通过"}</small>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SceneGraphRepairCard({ repair }) {
  if (!repair || repair.status === "not-needed") return null;
  const actions = Array.isArray(repair.actions) ? repair.actions : [];
  const completed = Array.isArray(repair.completed) ? repair.completed : [];
  return (
    <div className={`scenegraph-card ${repair.status === "blocked" ? "block" : "warn"}`}>
      <div className="scenegraph-head">
        <b>自动返工记录</b>
        <span>{repair.status}</span>
      </div>
      <p>{repair.policy || "只修 SceneGraph，不把视觉图贴成最终背景。"}</p>
      <div className="scenegraph-facts">
        <span>{actions.length} 待处理</span>
        <span>{completed.length} 已完成</span>
      </div>
      {actions.length ? (
        <div className="scenegraph-page-list">
          {actions.slice(0, 5).map((item, index) => (
            <div className="warn" key={`${item.slideId}-${item.action}-${index}`}>
              <strong>{item.slideId} / {item.action}</strong>
              <small>{item.reason || item.status}</small>
            </div>
          ))}
        </div>
      ) : null}
      {repair.blockers?.length ? <small className="scenegraph-warning">{repair.blockers.slice(0, 2).join(" / ")}</small> : null}
    </div>
  );
}

function SourceRecognitionCard({ report }) {
  if (!report) return null;
  const pages = Array.isArray(report.pages) ? report.pages : [];
  const slotReport = report.imageSlotReport || null;
  const templateProfile = report.templateProfile || null;
  const extractionAudit = report.extractionAudit || null;
  const cloudSource = report.cloudSourceAnalysis || null;
  const statusLabel = { "text+image": "文字+图片", "text-only": "仅文字", "image-only": "仅图片", empty: "空白" };
  return (
    <div className="source-report-card">
      <b>{"\u8d44\u6599\u8bc6\u522b"}</b>
      <p>{report.hasOldDeck ? "已识别旧 PPT 的文字、图片和页面结构。" : "已识别上传资料并抽取关键信息。"}</p>
      <div className="source-report-stats">
        <span><strong>{report.pageCount || 0}</strong>页</span>
        <span><strong>{report.textPageCount || 0}</strong>{"\u6587\u5b57\u9875"}</span>
        <span><strong>{report.imageCount || 0}</strong>张图片</span>
        <span><strong>{report.boundImageCount || 0}</strong>{"\u5df2\u7ed1\u5b9a\u56fe\u7247"}</span>
      </div>
      {slotReport ? (
        <div className="source-slot-summary">
          <span>{"\u5df2\u5339\u914d"}{slotReport.boundSlides || 0} {"\u4e2a\u56fe\u69fd"}</span>
          <span>{"\u6765\u81ea\u539f\u7a3f"}{slotReport.sourceBoundSlides || 0} {"\u9875"}</span>
          <span>{"\u5df2\u66ff\u6362"}{slotReport.changedSlides || 0} {"\u9875"}</span>
        </div>
      ) : null}
      {templateProfile ? (
        <div className="source-slot-summary">
          <span>{"\u6bcd\u7248"}{templateProfile.usedLayoutCount || 0}/{templateProfile.layoutCount || 0}</span>
          <span>{"\u53ef\u590d\u7528"}{templateProfile.reusableLayoutCount || 0}</span>
          <span>{templateProfile.warnings?.length ? `warning ${templateProfile.warnings.length}` : "\u5360\u4f4d\u7b26\u5df2\u8bc6\u522b"}</span>
        </div>
      ) : null}
      {extractionAudit ? (
        <div className={`source-slot-summary ${extractionAudit.confidence === "high" ? "pass" : "warning"}`}>
          <span>抽取审计 {extractionAudit.confidence || "medium"}</span>
          <span>文本 {extractionAudit.textSlideCount || 0}/{extractionAudit.slideCount || 0}</span>
          <span>图 {extractionAudit.extractedImageRefs || 0}/{extractionAudit.embeddedImageRefs || 0}</span>
          <span>{extractionAudit.linkedImageRefs || extractionAudit.missingImageRefs ? `外链/缺失 ${extractionAudit.linkedImageRefs || 0}/${extractionAudit.missingImageRefs || 0}` : "无缺失记录"}</span>
        </div>
      ) : null}
      {cloudSource ? (
        <div className={`cloud-review-summary ${cloudSource.status || "warn"}`}>
          <strong>{cloudSource.used ? "云端源稿分析" : "云端源稿分析未运行"}</strong>
          <small>{cloudSource.used ? (cloudSource.summary || cloudSource.status) : (cloudSource.reason || "not available")}</small>
        </div>
      ) : null}
      {report.warnings?.length ? <div className="source-report-warnings">{report.warnings.slice(0, 4).map((item) => <span key={item}>{item}</span>)}</div> : null}
      {pages.length ? (
        <div className="source-page-list">
          {pages.slice(0, 10).map((page) => (
            <div className={`source-page-row ${page.status || "empty"}`} key={page.page}>
              <span>#{page.page}</span>
              <div>
                <b>{page.title || `第 ${page.page} 页`}</b>
                <small>{page.textChars || 0} 字 / {page.imageCount || 0} 图 / {statusLabel[page.status] || page.status || "未知"}</small>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AgentReviewCard({ reviews = [], visualFixes = [] }) {
  const latest = Array.isArray(reviews) ? reviews.at(-1) : null;
  if (!latest) return null;
  const latestFix = Array.isArray(visualFixes) ? visualFixes.at(-1) : null;
  const statusLabel = latest.status === "block" ? "需处理" : latest.status === "warn" ? "需确认" : "通过";
  const stageLabel = latest.stage === "style-preview" ? "视觉方向阶段" : "整稿阶段";
  return (
    <div className={`agent-review-card ${latest.status || "pass"}`}>
      <div className="agent-review-head"><b>Agent {"\u590d\u5ba1"}</b><span>{stageLabel} / {statusLabel}</span></div>
      <p>{latest.nextGate === "human-style-confirmation" ? "自动质检后等待人工确认风格。" : "已进入可编辑与导出检查。"}</p>
      {latest.cloudVisualReview ? (
        <div className={`cloud-review-summary ${latest.cloudVisualReview.status || "warn"}`}>
          <strong>{latest.cloudVisualReview.used ? "云端视觉复审" : "云端复审跳过"}</strong>
          <small>{latest.cloudVisualReview.used ? (latest.cloudVisualReview.summary || latest.cloudVisualReview.status) : (latest.cloudVisualReview.reason || "not available")}</small>
        </div>
      ) : null}
      {latestFix ? <div className="visual-fix-summary"><strong>{"\u5df2\u81ea\u52a8\u4fee\u590d 1 \u8f6e"}</strong><small>{latestFix.changes?.join(" / ") || "\u5df2\u8bb0\u5f55\u4fee\u590d"}</small></div> : null}
      <div className="agent-review-list">
        {(latest.agents || []).map((agent) => <div className={agent.status || "pass"} key={agent.id}><strong>{agent.name}</strong><small>{agent.findings?.slice(0, 3).join(" / ") || agent.role}</small></div>)}
      </div>
    </div>
  );
}

function ImageSupplementPlanCard({ plan, onApply, onApplyLocal, localImage }) {
  if (!plan?.needed) return null;
  const items = Array.isArray(plan.items) ? plan.items : [];
  const localTargets = items.filter((item) => item.action === "need-remote-generation").length;
  const localReady = localImage?.state === "online";
  const actionLabel = { "use-source-image": "复用原图", "use-uploaded-image": "使用上传图", "need-remote-generation": "需要补图" };
  return (
    <div className="image-supplement-card">
      <div className="image-supplement-head"><b>{"\u8865\u56fe\u8ba1\u5212"}</b><span>{plan.status === "needs-human-confirmation" ? "\u5f85\u786e\u8ba4" : "\u5df2\u68c0\u67e5"}</span></div>
      <p>{"\u68c0\u67e5\u54ea\u4e9b\u9875\u9700\u8981\u539f\u56fe\u590d\u7528\u3001\u4e0a\u4f20\u56fe\u6216\u8fdc\u7a0b\u751f\u56fe\u8865\u9f50\u3002"}</p>
      <div className="image-supplement-facts"><span>{"\u6e90\u9875"} {plan.sourceFacts?.sourcePages || 0} {"\u9875"}</span><span>{"\u6e90\u56fe"} {plan.sourceFacts?.sourceImages || 0} {"\u5f20"}</span><span>{"\u5df2\u7ed1\u5b9a"} {plan.sourceFacts?.boundImageSlots || 0} {"\u4e2a"}</span><span>{"\u4fee\u590d"} {plan.sourceFacts?.visualFixRounds || 0} {"\u8f6e"}</span></div>
      {items.length ? <div className="image-supplement-list">{items.slice(0, 5).map((item) => <div className={item.action || "need-remote-generation"} key={`${item.slide}-${item.title}`}><strong>#{item.slide} {item.title}</strong><small>{actionLabel[item.action] || item.action} / {item.reason}</small>{item.availableSourceImages?.length ? <em>{"\u53ef\u7528\u56fe\u7247"}{item.availableSourceImages.slice(0, 2).join(" / ")}</em> : null}</div>)}</div> : null}
      <ul>{(plan.policy || []).slice(0, 4).map((item) => <li key={item}>{item}</li>)}</ul>
      {onApply ? <button className="btn primary wide" type="button" onClick={onApply}>{"\u6267\u884c\u8865\u56fe\u8ba1\u5212"}</button> : null}
      {onApplyLocal && localTargets > 0 ? <button className="btn ghost wide" type="button" onClick={onApplyLocal} disabled={!localReady}>{localReady ? `\u7528 Z-Image \u751f\u6210 ${Math.min(localTargets, 3)} \u5f20\u8865\u56fe` : "\u7b49\u5f85 Z-Image \u5c31\u7eea"}</button> : null}
    </div>
  );
}

function AestheticPlanCard({ plan }) {
  if (!plan) return null;
  const pagePlans = Array.isArray(plan.pagePlans) ? plan.pagePlans : [];
  const firstPrompt = pagePlans.find((item) => item.comfyPrompt)?.comfyPrompt || plan.comfy?.basePrompt || "";
  return (
    <div className="route-card aesthetic-card">
      <b>PPT {"\u7f8e\u5b66\u65b9\u6848"}</b>
      <p>{plan.theme || "未选择风格"} / {plan.system || "poster-layer-system"}</p>
      <div><span>{pagePlans.length} {"\u9875\u7b56\u7565"}</span><span>{plan.generationPolicy?.localFirst ? "\u672c\u5730\u4f18\u5148" : "\u4e91\u7aef\u4f18\u5148"}</span><span>{plan.comfy?.workflowMustBeSaved ? "\u4fdd\u5b58\u8282\u70b9" : "\u65e0\u8282\u70b9"}</span></div>
      {plan.globalComposition ? <small>{[plan.globalComposition.background, plan.globalComposition.textSafeArea, plan.globalComposition.assetPolicy].filter(Boolean).join(" / ")}</small> : null}
      {firstPrompt ? <em>{firstPrompt.slice(0, 180)}</em> : null}
    </div>
  );
}

function AestheticDiagnosisCard({ diagnosis }) {
  if (!diagnosis) return null;
  const score = Number(diagnosis.overallScore);
  const slides = Array.isArray(diagnosis.slides) ? diagnosis.slides : [];
  const low = diagnosis.lowScoreSlides || [];
  const dense = diagnosis.highDensitySlides || [];
  return (
    <div className={`route-card aesthetic-card ${Number.isFinite(score) && score < 72 ? "warning" : ""}`}>
      <b>{"\u7f8e\u5b66\u8bca\u65ad"}</b>
      <p>{Number.isFinite(score) ? `${score} 分` : "未评分"} / {diagnosis.slideCount || slides.length || 0} 页</p>
      <div><span>{low.length ? `低分页 ${low.length}` : "无低分页"}</span><span>{dense.length ? `高密度 ${dense.length}` : "密度正常"}</span></div>
      {slides.length ? <ul className="local-qa-list">{slides.slice(0, 5).map((slide) => <li className={Number(slide.diagnosisScore) < 72 ? "warn" : "pass"} key={slide.page}><strong>#{slide.page} {slide.type || "unknown"} / {slide.diagnosisScore ?? "-"} 分</strong><span>{slide.layoutStrategy || "structured_summary"} / {(slide.problems || []).map((item) => item.message || item).slice(0, 2).join(" / ") || "暂无问题"}</span></li>)}</ul> : null}
    </div>
  );
}

function StyleProofConfirmationCard({ confirmation }) {
  if (!confirmation?.id) return null;
  const cloud = confirmation.cloudVisualReview || {};
  const fix = confirmation.visualFix || null;
  return (
    <div className={`route-card style-proof-confirm-card ${confirmation.reviewStatus === "block" ? "warning" : ""}`}>
      <b>{"\u98ce\u683c\u786e\u8ba4"}</b>
      <p>{confirmation.title || confirmation.id} / {confirmation.previewCount || 0} {"\u5f20\u6837\u5f20"} / {"\u590d\u5ba1"} {confirmation.reviewStatus || "未开始"}</p>
      <div><span>{confirmation.style || "未选择风格"}</span><span>{confirmation.styleFingerprint?.prompt ? "已提取风格指纹" : "无风格指纹"}</span><span>{fix?.changes?.length ? `已修复 ${fix.changes.length} 项` : "未自动修复"}</span></div>
      {cloud.summary ? <small>{cloud.used ? cloud.summary : "云端复审未执行"}</small> : null}
    </div>
  );
}

function LocalImageQaCard({ qa, onRescan }) {
  if (!qa?.total) return null;
  const items = Array.isArray(qa.items) ? qa.items : [];
  return (
    <div className={`route-card local-qa-card ${qa.warnCount ? "warning" : ""}`}>
      <div className="local-qa-head"><b>{"\u672c\u5730\u56fe QA"}</b>{onRescan ? <button type="button" onClick={onRescan}>{"\u91cd\u626b"}</button> : null}</div>
      <p>{qa.passCount || 0}/{qa.total} {"\u901a\u8fc7"} / {qa.checked || 0} {"\u5f20\u5df2\u68c0\u67e5"}</p>
      <div><span>{qa.warnCount ? `风险 ${qa.warnCount}` : "全部通过"}</span><span>{qa.risks?.length ? qa.risks.map(localQaRiskLabel).slice(0, 2).join(" / ") : "暂无风险"}</span></div>
      {items.length ? <ul className="local-qa-list">{items.slice(0, 5).map((item) => <li className={item.status === "pass" ? "pass" : "warn"} key={item.id || item.name}><strong>{item.slide ? `#${item.slide} ` : ""}{item.status === "pass" ? "通过" : "需检查"}</strong><span>{item.risks?.length ? item.risks.map(localQaRiskLabel).join(" / ") : "暂无风险"}</span></li>)}</ul> : null}
    </div>
  );
}

function RenderImageQaCard({ qa }) {
  if (!qa?.total) return null;
  const items = Array.isArray(qa.items) ? qa.items : [];
  return (
    <div className={`route-card local-qa-card ${qa.warningCount ? "warning" : ""}`}>
      <div className="local-qa-head"><b>{"\u56fe\u7247\u6bd4\u4f8b QA"}</b></div>
      <p>{qa.total} {"\u5f20\u56fe\u7247"} / {qa.warningCount || 0} {"\u4e2a\u88c1\u526a/\u7559\u767d\u98ce\u9669"}</p>
      <div><span>{"\u6700\u5927\u88c1\u526a"} {Math.round((qa.maxCropLoss || 0) * 100)}%</span><span>{"\u6700\u5c0f\u586b\u5145"} {Math.round((qa.minFillRatio || 1) * 100)}%</span></div>
      {items.length ? <ul className="local-qa-list">{items.slice(0, 5).map((item, index) => <li className="warn" key={`${item.slideIndex}-${item.source}-${index}`}><strong>第 {item.slideIndex} 页 / {item.mode}</strong><span>{(item.warnings || []).map(renderQaRiskLabel).join(" / ")} / 原图 {item.imageWidth}x{item.imageHeight}</span></li>)}</ul> : null}
    </div>
  );
}

function StatusPanel({ job, files, fileIds, status, error, connection, localImage, skillRules, onRepairDelivery, onApplyImageSupplement, onApplyLocalImageSupplement, onRescanLocalImageQa, onGenerateVisualTargetSample }) {
  const [showDetails, setShowDetails] = useState(false);
  const warnings = [error, job?.warning, job?.previewWarning, job?.exportWarning].filter(Boolean);
  const ruleGroups = Object.keys(skillRules || {});
  const ruleCount = ruleGroups.reduce((sum, group) => sum + (Array.isArray(skillRules[group]) ? skillRules[group].length : 0), 0);
  const routeSummary = job?.quality?.routePlan || job?.input?.routePlan || null;
  const rawSourceReport = job?.quality?.material?.sourceReport || job?.input?.materialBrief?.sourceReport || null;
  const imageSlotReport = job?.quality?.material?.imageSlotReport || job?.input?.materialBrief?.imageSlotReport || null;
  const sourceReport = rawSourceReport ? { ...rawSourceReport, imageSlotReport } : null;
  const aestheticDiagnosis = job?.quality?.aestheticDiagnosis || rawSourceReport?.aestheticDiagnosis || null;
  const deliveryChecks = buildDeliveryChecks(job);
  const deliveryIssues = buildDeliveryIssues(job);
  const warnChecks = deliveryChecks.filter((item) => item.state === "warn").length;
  const failChecks = deliveryChecks.filter((item) => item.state === "fail").length;
  const statusTone = failChecks ? "fail" : warnChecks || warnings.length ? "warn" : "pass";
  const routeScore = Number(job?.quality?.routeAdherence?.score);
  return (
    <div className="side-section">
      <h2>{"\u72b6\u6001"}</h2>
      {job ? <div className={`status-summary ${statusTone}`}><div><b>{statusTone === "pass" ? "\u5df2\u901a\u8fc7" : statusTone === "warn" ? "\u9700\u68c0\u67e5" : "\u9700\u4fee\u590d"}</b><span>{job.deck?.slides?.length || 0} {"\u9875"} / {"\u8def\u7531"} {Number.isFinite(routeScore) ? `${Math.round(routeScore * 100)}%` : "-"} / {(job.previewImages || []).filter(Boolean).length} {"\u5f20\u9884\u89c8"}</span></div><button type="button" onClick={() => setShowDetails((value) => !value)}>{showDetails ? "\u6536\u8d77" : "\u8be6\u60c5"}</button></div> : null}
      <EditReadinessGate readiness={job?.editReadiness} localImage={localImage} onApplyImageSupplement={onApplyImageSupplement} onApplyLocalImageSupplement={onApplyLocalImageSupplement} onRescanLocalImageQa={onRescanLocalImageQa} />
      {job?.agentPlan ? <div className={`agent-card ${job.agentDecision?.autoRepaired ? "repaired" : "checked"}`}><b>{job.agentPlan.name || "AI PPT Agent"}</b><p>{job.agentDecision?.intent || "PPT 生成"} / {job.agentDecision?.autoRepaired ? "已自动修复" : "已完成检查"}</p><div>{(job.agentSteps || []).slice(-5).map((step) => <span className={step.status || "done"} key={`${step.id}-${step.at}`}><strong>{step.label}</strong>{step.summary || step.status}</span>)}</div>{job.agentDecision?.finalAssessment?.hints?.length ? <small>{job.agentDecision.finalAssessment.hints.join(" / ")}</small> : null}</div> : null}
      {job?.agentPlan ? <AgentWorkRecord job={job} files={files} /> : null}
      {job?.agentReviews?.length ? <AgentReviewCard reviews={job.agentReviews} visualFixes={job.visualFixes || []} /> : null}
      <ImageSupplementPlanCard plan={job?.imageSupplementPlan} onApply={onApplyImageSupplement} onApplyLocal={onApplyLocalImageSupplement} localImage={localImage} />
      {showDetails ? <ul className="status-list"><li><b>{fileIds.length}</b><span>{"\u4e0a\u4f20\u6587\u4ef6"}</span></li><li><b>{job?.deck?.slides?.length || 0}</b><span>{"\u5df2\u751f\u6210\u9875"}</span></li><li><b>{job?.aiUsed ? "AI" : "\u672c\u5730"}</b><span>{"\u751f\u6210\u6a21\u5f0f"}</span></li></ul> : null}
      <div className={`health-card ${connection?.state || "checking"}`}><span className={connection?.state === "offline" ? "state-dot error" : connection?.state === "online" ? "state-dot active" : "state-dot checking"} /><div><b>{connection?.state === "offline" ? "\u672c\u5730\u79bb\u7ebf" : connection?.state === "online" ? "\u672c\u5730\u5728\u7ebf" : "\u68c0\u67e5\u4e2d"}</b><p>{connection?.message || "\u6b63\u5728\u68c0\u67e5..."}</p></div></div>
      <div className={`health-card ${localImage?.state || "checking"}`}><span className={localImage?.state === "offline" ? "state-dot error" : localImage?.state === "online" ? "state-dot active" : "state-dot checking"} /><div><b>{localImage?.state === "online" ? "\u751f\u56fe\u5728\u7ebf" : localImage?.state === "offline" ? "\u751f\u56fe\u79bb\u7ebf" : "\u68c0\u67e5\u751f\u56fe"}</b><p>{localImage?.message || "\u68c0\u67e5 Z-Image / ComfyUI..."}</p></div></div>
      {routeSummary ? <div className="route-card"><b>{"\u667a\u80fd\u8def\u7531"}</b><p>{routeSummary.deckType || "\u672a\u77e5"} / {routeSummary.recommendedTheme || "\u672a\u8bbe\u7f6e\u98ce\u683c"}</p><div><span>{routeSummary.targetSlides || job?.deck?.slides?.length || 0} {"\u9875"}</span><span>{routeSummary.layoutSequence?.length || 0} {"\u4e2a\u7248\u5f0f"}</span><span>{routeSummary.imageStrategy?.hasImageSlides ? "\u542b\u56fe\u7247\u9875" : "\u65e0\u56fe\u7247\u9875"}</span><span>{routeSummary.riskStrategy?.includeRiskChecklist ? "\u542b\u98ce\u9669\u9875" : "\u65e0\u98ce\u9669\u9875"}</span></div></div> : null}
      <StyleProofConfirmationCard confirmation={job?.input?.styleProofConfirmation} />
      <PipelineCard pipeline={job?.pipeline} />
      <VisualTargetCard target={job?.visualTarget} onGenerateSample={onGenerateVisualTargetSample} localImage={localImage} />
      <SceneGraphCard graph={job?.sceneGraph} qa={job?.sceneGraphQa} />
      <VisualCompareCard compare={job?.visualCompare} />
      <SceneGraphRepairCard repair={job?.sceneGraphRepair} />
      <EditableRebuildCard plan={job?.editableRebuildPlan} />
      <SourceRecognitionCard report={sourceReport} />
      <AestheticDiagnosisCard diagnosis={aestheticDiagnosis} />
      <AestheticPlanCard plan={job?.aestheticPlan} />
      <LocalImageQaCard qa={job?.quality?.localImageQa} onRescan={onRescanLocalImageQa} />
      <RenderImageQaCard qa={job?.quality?.renderImageQa} />
      {deliveryChecks.length ? <div className="delivery-card"><div className="delivery-card-head"><b>{"\u4ea4\u4ed8\u81ea\u68c0"}</b><span>{failChecks ? "\u672a\u901a\u8fc7" : warnChecks ? "\u9700\u68c0\u67e5" : "\u901a\u8fc7"}</span></div><div className="delivery-check-grid">{deliveryChecks.map((item) => <span className={item.state} key={item.label}><strong>{item.label}</strong>{item.value}</span>)}</div>{deliveryIssues.length ? <ul>{deliveryIssues.map((item) => <li key={item}>{item}</li>)}</ul> : null}{hasRepairableDeliveryIssues(job) && onRepairDelivery ? <button className="btn primary wide" type="button" onClick={onRepairDelivery} disabled={status === "running"}>{"\u81ea\u52a8\u4fee\u590d\u4ea4\u4ed8\u95ee\u9898"}</button> : null}</div> : null}
      {warnings.length ? <div className="warning-box"><b>{"\u63d0\u793a"}</b><span>{warnings[0]}</span></div> : null}
      <details className="task-log"><summary>{"\u67e5\u770b\u4efb\u52a1\u65e5\u5fd7"}</summary>{(job?.events || []).map((event, index) => <div key={`${event.type}-${index}`}><strong>{event.type}</strong><span>{event.message}</span></div>)}</details>
      {showDetails && ruleCount ? <div className="rule-summary"><b>{"\u89c4\u5219"}</b><span>{ruleGroups.length} {"\u7ec4"} / {ruleCount} {"\u6761"}</span></div> : null}
    </div>
  );
}

function HistoryPanel({ jobs, onSelect, onDelete, onDeleteMany, onRepair }) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState("all");
  const filteredJobs = jobs.filter((item) => {
    const text = [item.deck?.title, item.mode, item.id].filter(Boolean).join(" ").toLowerCase();
    return (!query.trim() || text.includes(query.trim().toLowerCase())) && (mode === "all" || item.mode === mode);
  });
  return (
    <div className="side-section">
      <h2>{"\u5386\u53f2"}</h2>
      <div className="history-tools">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="\u641c\u7d22\u4efb\u52a1" />
        <select value={mode} onChange={(event) => setMode(event.target.value)}><option value="all">{"\u5168\u90e8"}</option><option value="generate">{"\u65b0\u5efa"}</option><option value="optimize">{"\u4f18\u5316"}</option></select>
        <button type="button" onClick={() => onDeleteMany(filteredJobs)} disabled={!filteredJobs.length}>{"\u6279\u91cf\u5220\u9664"}</button>
      </div>
      <div className="history-list">
        {filteredJobs.map((item) => (
          <div className="history-row" key={item.id}>
            <button type="button" onClick={() => onSelect(item)}><b>{item.deck?.title || "\u672a\u547d\u540d PPT"}</b><span>{new Date(item.createdAt).toLocaleString()} ? {item.mode === "optimize" ? "\u4f18\u5316 PPT" : "\u65b0\u5efa PPT"}</span></button>
            <span className={`history-quality ${jobHealthClass(item)}`}>{jobHealthLabel(item)}</span>
            {jobHealthClass(item) !== "good" ? <button className="history-repair" type="button" onClick={() => onRepair(item)}>{"\u4fee\u590d"}</button> : null}
            <button className="history-delete" type="button" onClick={() => onDelete(item)}>{"\u5220\u9664"}</button>
          </div>
        ))}
        {jobs.length === 0 ? <p className="empty">{"\u6682\u65e0\u5386\u53f2\u4efb\u52a1"}</p> : null}
      </div>
    </div>
  );
}

function ExportPanel({ job }) {
  return <div className="side-section"><h2>{"\u5bfc\u51fa"}</h2><DownloadLinks job={job} compact />{!job ? <p className="empty">{"\u751f\u6210\u540e\u53ef\u4e0b\u8f7d\u6587\u4ef6"}</p> : null}</div>;
}

function SettingsPanel({ config, busy, status, models, styleReferences = [], onChange, onSave, onTest, onDetectModels, onUploadStyleReference, onDeleteStyleReference }) {
  const [styleName, setStyleName] = useState("");
  const [styleTone, setStyleTone] = useState("");
  function update(name, value) { onChange((current) => ({ ...current, [name]: value })); }
  function handleStyleUpload(event) {
    const files = event.target.files;
    if (files?.length) {
      onUploadStyleReference(files, { name: styleName, tone: styleTone, themeName: "", themeSlug: "" });
      setStyleName("");
      setStyleTone("");
    }
    event.target.value = "";
  }
  return (
    <div className="side-section settings-panel">
      <h2>{"API \u8bbe\u7f6e"}</h2>
      <div className={"api-state " + (config.hasApiKey ? "ready" : "missing")}><span className={config.hasApiKey ? "state-dot active" : "state-dot error"} /><div><b>{config.hasApiKey ? "AI \u5df2\u914d\u7f6e" : "\u672a\u914d\u7f6e API Key"}</b><p>{config.hasApiKey ? "\u5f53\u524d Key: " + (config.maskedApiKey || "-") : "\u672a\u914d\u7f6e\uff0c\u5c06\u4f7f\u7528\u672c\u5730\u6a21\u677f\u751f\u6210"}</p></div></div>
      <Field label="OpenAI API Key"><input type="password" value={config.apiKey || ""} onChange={(event) => update("apiKey", event.target.value)} placeholder={config.hasApiKey ? "\u7559\u7a7a\u5219\u4fdd\u7559\u5df2\u4fdd\u5b58\u7684 Key" : "sk-..."} autoComplete="off" /></Field>
      <Field label="Base URL"><input value={config.baseUrl || ""} onChange={(event) => update("baseUrl", event.target.value)} placeholder="https://api.openai.com/v1" /></Field>
      <Field label="Model"><select value={config.model || ""} onChange={(event) => update("model", event.target.value)}>{models?.length ? models.map((model) => <option key={model} value={model}>{model}</option>) : <option value={config.model || "gpt-4.1-mini"}>{config.model || "gpt-4.1-mini"}</option>}</select></Field>
      <div className="button-row tight"><button className="btn primary" type="button" onClick={onSave} disabled={busy}>{"\u4fdd\u5b58\u914d\u7f6e"}</button><button className="btn ghost" type="button" onClick={onTest} disabled={busy}>{"\u6d4b\u8bd5\u8fde\u63a5"}</button><button className="btn ghost" type="button" onClick={onDetectModels} disabled={busy}>{"\u68c0\u6d4b\u6a21\u578b"}</button></div>
      {status ? <div className="settings-status">{status}</div> : null}
      <div className="settings-divider" />
      <h2>{"\u98ce\u683c\u53c2\u8003\u5e93"}</h2>
      <p className="settings-note">{"\u4e0a\u4f20\u4e00\u7ec4\u53c2\u8003\u56fe\uff0c\u7cfb\u7edf\u4f1a\u628a\u5b83\u4eec\u4f5c\u4e3a\u6574\u4f53\u8c03\u6027\u8f93\u5165\uff1a\u8272\u5f69\u3001\u7559\u767d\u3001\u8d28\u611f\u3001\u56fe\u7247\u6bd4\u4f8b\u3001\u6587\u5b57\u5bc6\u5ea6\u548c\u6392\u7248\u8282\u594f\u90fd\u4f1a\u53c2\u4e0e\u540e\u7eed PPT \u751f\u6210\u3002"}</p>
      <Field label={"\u53c2\u8003\u540d\u79f0"}><input value={styleName} onChange={(event) => setStyleName(event.target.value)} placeholder={"\u4f8b\u5982\uff1a\u4e1c\u65b9\u81ea\u7136\u98ce\u793c\u76d2\u53c2\u8003"} /></Field>
      <Field label={"\u8c03\u6027\u8bf4\u660e"}><textarea className="compact-textarea" value={styleTone} onChange={(event) => setStyleTone(event.target.value)} placeholder={"\u4f8b\u5982\uff1a\u7559\u767d\u591a\u3001\u4f4e\u9971\u548c\u3001\u7eb8\u611f\u7eb9\u7406\u3001\u6807\u9898\u514b\u5236\u3002"} /></Field>
      <label className="style-upload"><input type="file" accept="image/*" multiple onChange={handleStyleUpload} disabled={busy} /><span>{"\u4e0a\u4f20\u98ce\u683c\u53c2\u8003\u56fe"}</span></label>
      <div className="style-current-gallery"><div className="style-current-gallery-head"><b>{"\u5df2\u4e0a\u4f20\u53c2\u8003\u56fe"}</b><span>{styleReferences.length} {"\u5f20"}</span></div>{styleReferences.length ? <div className="style-thumb-grid">{styleReferences.slice(0, 12).map((item) => <img key={item.id} src={item.imageUrl} alt={item.name || item.originalName || "\u53c2\u8003\u56fe"} />)}</div> : <p className="empty">{"\u8fd8\u6ca1\u6709\u98ce\u683c\u53c2\u8003\u56fe"}</p>}</div>
      <div className="style-reference-list">
        {styleReferences.length ? styleReferences.map((item) => <StyleReferenceItem key={item.id} item={item} busy={busy} onDelete={onDeleteStyleReference} />) : <p className="empty">{"\u6682\u65e0\u98ce\u683c\u53c2\u8003"}</p>}
      </div>
    </div>
  );
}

function StyleReferenceItem({ item, busy, onDelete }) {
  return (
    <div className="style-reference-item">
      {item.imageUrl ? <img src={item.imageUrl} alt={item.name || item.originalName || "\u53c2\u8003\u56fe"} /> : <span className="style-reference-fallback">IMG</span>}
      <div><b>{item.name || item.originalName || "\u672a\u547d\u540d\u53c2\u8003"}</b><p>{item.tone || "\u53c2\u8003\u8272\u5f69\u3001\u7559\u767d\u3001\u8d28\u611f\u548c\u7248\u5f0f\u8282\u594f\u3002"}</p>{item.styleFingerprint?.prompt ? <small className="style-fingerprint">{item.styleFingerprint.prompt}</small> : null}</div>
      <button type="button" onClick={() => onDelete(item.id)} disabled={busy}>{"\u5220\u9664"}</button>
    </div>
  );
}

function DownloadLinks({ job, compact = false }) {
  if (!job) return null;
  const blocked = isJobBlockedForFinal(job);
  const links = [];
  if (job.exports?.editablePptx || job.exports?.pptx) links.push([blocked ? "editable-draft.pptx" : "editable-final.pptx", job.exports.editablePptx || job.exports.pptx, job.exportMeta?.editablePptx?.label || job.exportMeta?.pptx?.label]);
  if (job.exports?.visualTargetPptx) links.push(["visual-target.pptx", job.exports.visualTargetPptx, job.exportMeta?.visualTargetPptx?.label]);
  if (job.exports?.pdf) links.push(["PDF", job.exports.pdf, job.exportMeta?.pdf?.label]);
  (job.exports?.png || []).forEach((url, index) => links.push([`PNG ${index + 1}`, url, job.exportMeta?.png?.[index]?.label]));
  if (links.length === 0) return <p className="empty">暂无导出文件</p>;
  return (
    <div className={compact ? "download-links compact" : "download-links"}>
      {blocked ? <span className="download-warning">QA blocked: 当前 PPTX 是可编辑草稿，不能作为最终成品交付。</span> : null}
      {links.map(([label, url, size]) => <a key={`${label}-${url}`} href={url} target="_blank" rel="noreferrer">{label}{size ? <small>{size}</small> : null}</a>)}
    </div>
  );
}

function SectionCard({ title, desc, children, className = "" }) {
  return <section className={`section-card ${className}`.trim()}>{(title || desc) ? <header>{title ? <h2>{title}</h2> : null}{desc ? <p>{desc}</p> : null}</header> : null}{children}</section>;
}

function StageEmptyState({ title, body, action, onAction }) {
  return (
    <div className="stage-empty-state">
      <b>{title}</b>
      <span>{body}</span>
      {action ? <button className="btn primary" type="button" onClick={onAction}>{action}</button> : null}
    </div>
  );
}

function Field({ label, children }) { return <div className="field"><label>{label}</label>{children}</div>; }
function Metric({ label, value }) { return <div className="metric"><b>{value}</b><span>{label}</span></div>; }

function GenerationProgress({ progress }) {
  const value = Math.max(0, Math.min(100, progress?.value || 0));
  const title = progress?.mode === "style-preview" ? "正在生成主视觉方向" : progress?.mode === "optimize" ? "正在优化旧 PPT" : "正在生成 PPT";
  return <div className="generation-progress"><div><b>{title}</b><span>{progress?.label || "正在处理，请稍等..."}</span></div><strong>{value}%</strong><em><i style={{ width: `${value}%` }} /></em></div>;
}

function StylePreviewGate({ busy, confirmed, job, progress, onConfirm, onCreate, onReset, canCreate = true }) {
  const images = job?.previewImages || [];
  const latestReview = Array.isArray(job?.agentReviews) ? job.agentReviews.at(-1) : null;
  const latestCloudReview = Array.isArray(job?.cloudReviews) ? job.cloudReviews.at(-1) : latestReview?.cloudVisualReview || null;
  const reviewStatus = latestReview?.status || latestCloudReview?.status || "";
  const canConfirm = Boolean(job && !busy && reviewStatus !== "block");
  const criteria = ["图片必须是主角", "标题层级要强", "不像普通商务套壳", "最终仍重建为可编辑对象"];
  return (
    <div className={`style-proof-card ${confirmed ? "confirmed" : ""}`}>
      <div className="style-proof-head">
        <div>
          <b>主视觉方向审阅</b>
          <span>{job ? `已生成 ${images.length || 0} 张视觉方向图。这些只是 visual target，不是最终可编辑 PPT。` : "先生成 3-4 页主视觉方向图，用来判断气质、构图和图片权重；不满意就重做方向，不要进入最终生成。"}</span>
        </div>
        <div className="button-row tight">
          <button className="btn ghost" type="button" onClick={onCreate} disabled={busy || !canCreate}>{busy ? "正在生成方向图" : job ? "重做视觉方向" : canCreate ? "生成主视觉方向" : "先确认大纲和设计方向"}</button>
          {job && !busy ? <button className="btn primary" type="button" onClick={onConfirm} disabled={!canConfirm}>{confirmed ? "方向已采用" : "采用此方向"}</button> : null}
          {job ? <button className="btn ghost" type="button" onClick={onReset} disabled={busy}>撤销采用</button> : null}
        </div>
      </div>
      <div className="style-proof-criteria">
        {criteria.map((item) => <span key={item}>{item}</span>)}
      </div>
      {progress?.active ? <StyleProofProgress progress={progress} /> : null}
      {latestReview ? <div className={`style-proof-qa ${latestReview.status || "pass"}`}><strong>方向自动质检：{latestReview.status === "block" ? "需处理" : latestReview.status === "warn" ? "需人工判断" : "通过"}</strong><span>{latestReview.nextGate === "human-style-confirmation" ? "只代表可进入人工审阅，不代表最终 PPT 已完成。" : "已记录质检结果。"}</span>{latestCloudReview ? <small>{latestCloudReview.used ? (latestCloudReview.summary || latestCloudReview.status) : `云端视觉复审未完成：${latestCloudReview.reason || "not available"}`}</small> : null}<div>{(latestReview.agents || []).slice(0, 5).map((agent) => <em className={agent.status || "pass"} key={agent.id || agent.name}>{agent.name}：{agent.status === "block" ? "需处理" : agent.status === "warn" ? "需确认" : "通过"}</em>)}</div></div> : null}
      {images.length ? <div className="style-proof-grid">{images.slice(0, 4).map((url, index) => <figure key={`${url}-${index}`}><img src={url} alt={`主视觉方向 ${index + 1}`} /><figcaption>{index === 0 ? "方向基准" : `页面气质 ${index + 1}`}</figcaption></figure>)}</div> : null}
      {job?.exports?.pptx ? <a className="style-proof-link" href={job.exports.pptx} target="_blank" rel="noreferrer">打开 visual-target.pptx 中间稿</a> : null}
    </div>
  );
}

function StyleProofProgress({ progress }) {
  const value = Math.max(0, Math.min(100, progress?.value || 0));
  const stages = [
    { at: 10, label: "资料" },
    { at: 35, label: "路由" },
    { at: 60, label: "方向" },
    { at: 82, label: "质检" },
    { at: 95, label: "预览" }
  ];
  return (
    <div className="style-proof-progress">
      <div className="style-proof-progress-head">
        <b>视觉方向生成进度</b>
        <strong>{value}%</strong>
      </div>
      <span>{progress?.label || generationProgressLabel(value, "style-preview")}</span>
      <em><i style={{ width: `${value}%` }} /></em>
      <div className="style-proof-progress-steps">
        {stages.map((stage) => <small className={value >= stage.at ? "done" : ""} key={stage.label}>{stage.label}</small>)}
      </div>
    </div>
  );
}

function toggle(list, item) {
  return list.includes(item) ? list.filter((value) => value !== item) : [...list, item];
}

function toBulletList(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  return String(value).split(/[\r\n;,，；、]+/).map((item) => item.trim()).filter(Boolean);
}

function normalizePreviewPrices(slide = {}) {
  const data = toBulletList(slide.dataPoints);
  const source = data.length ? data : toBulletList(slide.bullets);
  const tiers = ["基础档", "推荐档", "升级档", "高配档", "定制档", "补充项"];
  const entries = source.slice(0, 6).map((item, index) => {
    const text = String(item || "");
    const price = text.match(/\d+(?:\.\d+)?/)?.[0] || String(index + 1);
    const label = text.replace(price, "").replace(/[，、；;\-]/g, " ").trim() || tiers[index] || `第 ${index + 1} 档`;
    return {
      tier: tiers[index] || `第 ${index + 1} 档`,
      price,
      label,
      note: index === 0 ? "入门预算" : index === source.length - 1 ? "需复核" : "可推荐",
      accented: /recommended|upgrade|premium|推荐|升级|高配/i.test(text) || index === 1
    };
  });
  return entries.length ? entries : [{ tier: "推荐档", price: "01", label: slide.title || "待补充", note: "需复核", accented: true }];
}

function buildPreviewProductFacts(slide = {}) {
  const text = [slide.title, slide.subtitle, ...toBulletList(slide.bullets), ...toBulletList(slide.dataPoints)].join(" ");
  const price = text.match(/\d+(?:\.\d+)?/)?.[0] || "待确认";
  const spec = text.match(/\d{2,4}\s*[xX*]\s*\d{2,4}(?:\s*[xX*]\s*\d{2,4})?\s*(?:mm|cm)?/i)?.[0] || "待确认";
  const scene = toBulletList(slide.bullets).find((item) => /scene|client|gift|benefit|客户|礼品|福利|场景/i.test(item)) || slide.subtitle || "按客户预算匹配";
  return [
    { label: "价格", value: price },
    { label: "规格", value: spec },
    { label: "场景", value: String(scene).slice(0, 28) }
  ];
}
function makeSlideDraft(slide = {}) {
  return {
    layout: slide?.layout || "section",
    title: slide?.title || "",
    subtitle: slide?.subtitle || "",
    storyRole: slide?.storyRole || "",
    contentSource: slide?.contentSource || "用户输入",
    bullets: toBulletList(slide?.bullets).join("\n"),
    speakerNotes: slide?.speakerNotes || "",
    visualIntent: slide?.visualIntent || "",
    dataPoints: toBulletList(slide?.dataPoints).join("\n"),
    imageSlots: toBulletList(slide?.imageSlots).join("\n"),
    canvasEdits: normalizeCanvasEdits(slide?.canvasEdits)
  };
}

function draftToSlide(slide = {}, draft = {}) {
  return {
    ...slide,
    layout: draft.layout || slide?.layout || "section",
    title: draft.title || "",
    subtitle: draft.subtitle || "",
    storyRole: draft.storyRole || "",
    contentSource: draft.contentSource || slide?.contentSource || "",
    bullets: splitDraftLines(draft.bullets),
    speakerNotes: draft.speakerNotes || "",
    visualIntent: draft.visualIntent || slide?.visualIntent || "",
    dataPoints: splitDraftLines(draft.dataPoints),
    imageSlots: splitDraftLines(draft.imageSlots),
    canvasEdits: normalizeCanvasEdits(draft.canvasEdits || slide?.canvasEdits)
  };
}

function splitDraftLines(value) {
  return String(value || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function getSlideVisualImage(job, slide = {}, slideIndex = 0) {
  const images = (job?.files || []).filter((file) => file.uploadUrl && file.materialRole !== "visual-target-reference");
  if (!images.length) return null;
  if (images.length === 1) return images[0];
  const slideText = normalizeMatchText([slide.title, slide.subtitle, slide.visualIntent, ...toBulletList(slide.bullets), ...toBulletList(slide.imageSlots)].join(" "));
  const scored = images.map((image, index) => {
    const name = normalizeMatchText(image.originalName || "");
    const tokenScore = tokenizeForMatch(slideText).reduce((sum, token) => sum + (name.includes(token) ? token.length : 0), 0);
    const layoutBonus = scoreImageLayout(name, slide.layout);
    const orderBonus = slideIndex === 0 ? Math.max(0, 4 - index) : Math.max(0, 2 - Math.abs(index - slideIndex));
    return { image, score: tokenScore + layoutBonus + orderBonus, index };
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored[0]?.image || images[slideIndex % images.length];
}

function getSlideMaterialImages(job, slide = {}, slideIndex = 0) {
  const images = (job?.files || []).filter((file) => file.uploadUrl && file.materialRole !== "visual-target-reference");
  if (!images.length) return [];
  const slots = toBulletList(slide.imageSlots).map(normalizeMatchText).filter(Boolean);
  const picked = [];
  for (const slot of slots) {
    const match = images.find((image) => normalizeMatchText(image.originalName || "").includes(slot) || slot.includes(normalizeMatchText(image.originalName || "")));
    if (match && !picked.some((item) => item.id === match.id)) picked.push(match);
  }
  if (picked.length) return picked.slice(0, 4);
  const visualImage = getSlideVisualImage(job, slide, slideIndex);
  if (visualImage && ["cover", "visual", "product-detail", "bundle"].includes(slide.layout)) return [visualImage];
  return [];
}

function buildAssetBoxes(layout = "", count = 1) {
  if (layout === "cover") return [{ x: 5, y: 8, w: 48, h: 78 }];
  if (layout === "product-detail" || layout === "visual") return [{ x: 6, y: 10, w: 42, h: 72 }];
  if (layout === "bundle" || count >= 3) {
    return [
      { x: 8, y: 18, w: 25, h: 48 },
      { x: 37, y: 18, w: 25, h: 48 },
      { x: 66, y: 18, w: 25, h: 48 },
      { x: 37, y: 68, w: 25, h: 20 }
    ];
  }
  return [
    { x: 58, y: 18, w: 34, h: 56 },
    { x: 58, y: 76, w: 34, h: 16 }
  ];
}

function scoreImageLayout(name, layout) {
  if (layout === "cover" && /cover|hero|kv|logo/.test(name)) return 18;
  if (["visual", "product-detail", "cards"].includes(layout) && /product|pack|box|detail|sku/.test(name)) return 16;
  return 0;
}

function normalizeMatchText(value = "") { return String(value).toLowerCase().replace(/s+/g, "").replace(/[^一-龥a-z0-9]/g, ""); }
function tokenizeForMatch(value = "") { return [...new Set([...(value.match(/[一-龥]{2,8}/g) || []), ...(value.match(/[a-z0-9]{2,}/g) || [])])].slice(0, 24); }

function getCompletion({ form, fileIds, job }) {
  let score = 0;
  if (form.projectName.trim()) score += 25;
  if (form.notes.trim()) score += 30;
  if (fileIds.length > 0) score += 25;
  if (job) score += 20;
  return Math.min(score, 100);
}

function generationProgressLabel(value = 0, mode = "") {
  if (mode === "style-preview") {
    if (value < 30) return "正在读取资料、设计方向和已确认大纲";
    if (value < 55) return "正在判断方向页和版式路线";
    if (value < 78) return "正在生成 3-4 页主视觉方向";
    if (value < 92) return "正在执行自动质检和视觉复审";
    return "正在打包 visual-target.pptx 和预览图";
  }
  if (mode === "optimize") {
    if (value < 35) return "正在解析旧 PPT 和素材";
    if (value < 62) return "正在诊断页面并生成重构路线";
    if (value < 82) return "正在渲染新版 PPTX 和预览图";
    return "正在执行导出质检";
  }
  if (value < 30) return "正在整理资料和生成路线";
  if (value < 55) return "正在生成页面结构和文案";
  if (value < 78) return "正在渲染 PPTX";
  return "正在生成预览图和执行质检";
}

function getStepState({ activeStep, fileIds, job, formats }) {
  const blocked = isJobBlockedForFinal(job);
  return Object.fromEntries(STEPS.map((step) => {
    if (step.id === activeStep) return [step.id, UI.current];
    if (step.id === "materials") return [step.id, fileIds.length ? UI.done : UI.pending];
    if (step.id === "outline") return [step.id, job ? UI.done : UI.optional];
    if (step.id === "generate") return [step.id, job?.visualTarget?.sample?.status === "generated" ? UI.done : job ? UI.optional : UI.pending];
    if (step.id === "visual-project") return [step.id, job?.visualProject?.status ? (job.visualProject.status === "ready" ? UI.done : job.visualProject.status === "blocked" ? UI.pending : UI.pending) : UI.pending];
    if (step.id === "visual-qa") return [step.id, blocked ? UI.pending : job?.visualCompare?.score ? UI.done : job ? UI.optional : UI.pending];
    if (step.id === "preview") return [step.id, job ? (blocked ? UI.pending : UI.editable) : UI.waitingGenerate];
    if (step.id === "export") return [step.id, job && formats.length && !blocked ? UI.exportable : UI.pending];
    return [step.id, job?.feedback ? UI.done : UI.optional];
  }));
}

function isJobBlockedForFinal(job) {
  return Boolean(job?.editReadiness?.ready === false || job?.editReadiness?.status === "blocked" || job?.hybridQa?.status === "block");
}

function fileExt(name = "") { const ext = name.split(".").pop(); return ext ? ext.slice(0, 4).toUpperCase() : "FILE"; }
function getEffectiveProjectName(form = {}, files = []) {
  if (form.projectName?.trim()) return form.projectName.trim();
  const fromNotes = String(form.notes || "").match(/[\u4e00-\u9fa5A-Za-z0-9][\u4e00-\u9fa5A-Za-z0-9\s-]{3,28}/)?.[0]?.trim();
  if (fromNotes) return fromNotes;
  const fromFile = files[0]?.originalName?.replace(/\.[^.]+$/, "")?.trim();
  return fromFile || "未命名项目";
}

function inferMaterialTypes(files = []) {
  const types = new Set();
  for (const file of files) {
    const name = String(file?.originalName || file?.path || "").toLowerCase();
    if (/\.(png|jpe?g|webp|gif|svg)$/.test(name)) types.add("图片素材");
    if (/\.(ppt|pptx)$/.test(name)) types.add("PPT");
    if (/\.(doc|docx|pdf|txt|md)$/.test(name)) types.add("文档资料");
    if (/\.(xls|xlsx|csv)$/.test(name)) types.add("表格资料");
    if (/price|moq|quote|delivery|价格|报价|交付/.test(name)) types.add("价格 / 交付");
    if (/brand|logo|品牌/.test(name)) types.add("品牌资料");
    if (/compare|competitor|竞品/.test(name)) types.add("竞品资料");
    if (/product|pack|sku|产品|包装|礼盒/.test(name)) types.add("产品资料");
  }
  return [...types];
}

function analyzeIntakeMessage(text = "", context = {}) {
  const normalized = String(text || "").trim();
  const files = context.files || [];
  const readiness = getIntakeReadiness([context.notes, normalized].filter(Boolean).join("\n"), files);
  if (isMetaIntakeQuestion(normalized)) {
    return {
      kind: "meta",
      actionable: false,
      reply: "我是一个 PPT 设计智能体。你可以直接和我聊：从零做 PPT、优化旧 PPT、提炼 PDF/文档、统一风格、先出大纲、先出样稿、再导出可编辑 PPTX。你不用先填表，我会先追问关键信息。"
    };
  }
  if (/先问|问我|引导|不知道怎么说|帮我梳理/.test(normalized)) {
    return {
      kind: "question",
      actionable: false,
      reply: "可以。先回答三个点就够：1. 这份 PPT 给谁看？2. 想让对方做什么决定？3. 偏商务、科技、东方自然、画册，还是你有参考图？"
    };
  }
  if (/开始|继续|生成大纲|出大纲|下一步/.test(normalized) && readiness.ready) {
    return {
      kind: "ready",
      actionable: false,
      reply: "信息已经够我先规划。点击下面的“开始理解并生成大纲”，我会先给你可确认的大纲，不会直接生成整套 PPT。"
    };
  }
  if (isVaguePptRequest(normalized) && !files.length) {
    return {
      kind: "question",
      actionable: false,
      reply: "可以做，但这句话还太宽。请补一句：主题是什么、给谁看、希望几页左右、偏什么风格。比如：做一份给销售团队看的端午礼盒提案，12 页，东方自然风。"
    };
  }
  if (/优化|重塑|重做|改旧稿|旧\s*PPT|原稿/.test(normalized) && !files.length) {
    return {
      kind: "upload-needed",
      actionable: true,
      reply: "我理解你想优化旧稿。请先上传 PPT/PDF/图片资料，我会识别原文字、图片、素材身份，再让你选择“保留结构优化”还是“重新规划”。"
    };
  }
  return {
    kind: readiness.ready ? "ready" : "collecting",
    actionable: true,
    reply: readiness.ready
      ? "我已经记录需求，信息足够先生成一版可确认的大纲。你也可以继续补充风格、受众或参考资料。"
      : `我已记录这条需求。还差一步：${readiness.nextQuestion}`
  };
}

function buildIntakeReply(text = "", files = []) {
  const normalized = String(text || "").trim();
  const hasFiles = files.length > 0;
  if (isMetaIntakeQuestion(normalized)) {
    return "我可以先和你聊清楚 PPT 目标、受众、风格和资料，再生成可确认的大纲；如果你上传旧 PPT/PDF/图片，我会先识别原文字、图片和素材身份，再决定是优化旧稿还是重新规划。";
  }
  if (hasFiles) {
    return "我已把这条补充需求记到当前资料里。你可以继续补充目标、受众、风格，或点击开始理解并生成大纲。";
  }
  return "我已记录这条需求。你可以继续补充，也可以让我先按这句话理解目标并生成一版可确认的大纲。";
}

function isMetaIntakeQuestion(text = "") {
  return /你可以干嘛|你能干嘛|能干嘛|怎么用|如何使用|可以做什么|有什么功能|help/i.test(String(text || ""));
}

function isVaguePptRequest(text = "") {
  const value = String(text || "").trim();
  if (!/ppt|PPT|幻灯片|演示|提案|汇报|路演/.test(value)) return false;
  return value.length < 18 && !/[，,。；;：:]/.test(value);
}

function getIntakeReadiness(notes = "", files = []) {
  const text = String(notes || "").trim();
  const hasFiles = files.length > 0;
  const hasTopic = /[\u4e00-\u9fa5A-Za-z0-9]{4,}/.test(text);
  const hasAudience = /客户|老板|领导|销售|团队|投资人|用户|渠道|内部|外部|评审|招商|经销商|学校|学生|老师|政府|甲方|乙方/.test(text);
  const hasGoal = /提案|汇报|介绍|路演|培训|发布|复盘|招商|销售|成交|说明|展示|优化|重塑|生成|制作|做一份|做个/.test(text);
  const hasStyle = /风格|参考|东方|自然|科技|画册|黑白|蓝白|暗黑|轻盈|渐变|高级|简洁|商务|品牌/.test(text);
  if (hasFiles) {
    return {
      ready: true,
      label: "已收到资料",
      hint: "可以先理解资料，再进入大纲确认。",
      nextQuestion: "可以补充目标、受众或风格，也可以先生成大纲。"
    };
  }
  if (hasTopic && hasGoal && (hasAudience || hasStyle)) {
    return {
      ready: true,
      label: "需求基本够用",
      hint: "可以先生成大纲，后面再补风格和素材。",
      nextQuestion: "信息够用。"
    };
  }
  const missing = [];
  if (!hasTopic || !hasGoal) missing.push("主题和用途");
  if (!hasAudience) missing.push("给谁看");
  if (!hasStyle) missing.push("希望的风格或参考");
  return {
    ready: false,
    label: text ? "正在收集需求" : "等待你发起对话",
    hint: text ? "我会先追问必要信息，再进入大纲。" : "你可以问能力，也可以直接说要做什么 PPT。",
    nextQuestion: `请补充${missing.slice(0, 2).join("、")}。`
  };
}

function formatBytes(value) { if (!value) return "-"; if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`; return `${(value / 1024 / 1024).toFixed(1)} MB`; }
function inputStrengthLabel(value) { if (value === "strong") return "资料充分"; if (value === "weak") return "资料偏少"; if (value === "empty") return "无资料"; return "资料待识别"; }function uniqueList(items = []) { return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))]; }

function getOutlineSourceMeta(step = {}) {
  const type = step.sourceType || (step.kind === "source" ? "original-ppt" : "");
  if (type === "original-ppt") return { label: step.sourceLabel || "来自原 PPT", tone: "source-original", evidence: step.evidence || "" };
  if (type === "extracted") return { label: step.sourceLabel || "资料抽取", tone: "source-extracted", evidence: step.evidence || "" };
  if (type === "needs-confirmation" || step.needsConfirmation) return { label: step.sourceLabel || "待确认", tone: "source-confirm", evidence: step.evidence || "" };
  if (["prices", "products", "productDetail", "visual", "compare", "bundle"].includes(step.kind)) return { label: "资料抽取", tone: "source-extracted", evidence: step.evidence || "" };
  if (["risks", "assumptions"].includes(step.kind)) return { label: "待确认", tone: "source-confirm", evidence: step.evidence || "" };
  return { label: step.sourceLabel || "AI 推断", tone: "source-inferred", evidence: step.evidence || "" };
}

function formatDuration(seconds = 0) { const value = Math.max(0, Number(seconds) || 0); if (value < 60) return `${value}s`; if (value < 3600) return `${Math.floor(value / 60)}m`; return `${Math.floor(value / 3600)}h ${Math.floor((value % 3600) / 60)}m`; }
function isMojibake(value = "") { return /[�]|Ã|ç|閿|鐢|锟|脙|莽|闁|閻/.test(String(value)); }
function findTemplatePack(packs = [], theme = {}) { return packs.find((pack) => pack.themeName === theme.name || pack.themeSlug === theme.slug); }
function formatDesignDirectionName(name = "") {
  return String(name || "").replace(/模板/g, "方向");
}

function makeOutlineStep(layout = "section") {
  const map = { cover: ["新封面", "建立主题和第一视觉印象", "开场"], visual: ["视觉页", "用大图承接核心场景", "视觉证明"], section: ["章节页", "切换叙事段落", "结构转场"], toc: ["目录", "说明整份内容结构", "导航"], kpi: ["关键指标", "突出数字和结果", "数据证明"], pricing: ["报价方案", "呈现价格与配置", "预算决策"], "product-detail": ["单品详情", "展示产品卖点和参数", "产品证明"], bundle: ["组合方案", "说明套餐和搭配逻辑", "组合推荐"], "risk-checklist": ["风险清单", "提示交付、价格和确认风险", "风险控制"], compare: ["对比分析", "比较不同选项", "辅助决策"], timeline: ["时间计划", "说明节点和推进节奏", "执行路径"], cards: ["要点卡片", "拆分关键信息", "卖点归纳"], quote: ["核心话术", "沉淀一句可复述表达", "记忆点"], closing: ["下一步行动", "收束确认事项", "行动收口"] };
  const [title, purpose, storyRole] = map[layout] || map.section;
  return { layout, title, purpose, storyRole, kind: layout, imageSlots: [] };
}

const TEMPLATE_RENDER_LAYOUTS = { "sales-proposal": ["cover", "pricing", "cards", "quote", "risk-checklist", "closing"], "seasonal-gift": ["cover", "visual", "pricing", "product-detail", "bundle", "closing"], "brand-editorial": ["cover", "visual", "quote", "cards", "product-detail", "closing"], "tech-solution": ["cover", "toc", "kpi", "compare", "timeline", "closing"], "launch-dark": ["cover", "section", "kpi", "visual", "timeline", "quote", "closing"] };
function getCurrentTemplate(job = {}, packs = []) { const routePack = job?.quality?.routePlan?.templatePack || job?.input?.routePlan?.templatePack; return packs.find((pack) => pack.slug === routePack?.slug || pack.themeName === job?.input?.style || pack.name === routePack?.name) || routePack || null; }
function getTemplateRenderHit(templatePack, slide = {}) {
  const layout = slide?.layout || "";
  const supported = TEMPLATE_RENDER_LAYOUTS[templatePack?.slug] || [];
  if (!templatePack?.slug) return { active: false, label: "通用渲染" };
  if (supported.includes(layout)) return { active: true, label: `${LAYOUT_LABELS[layout] || layout} 专属渲染` };
  return { active: false, label: `${LAYOUT_LABELS[layout] || layout || "当前页"} 通用渲染` };
}

function isRestorableJob(job = {}) {
  const deck = job.deck || {};
  const firstSlide = deck.slides?.[0] || {};
  const text = [deck.title, deck.summary, firstSlide.title, firstSlide.subtitle, ...(firstSlide.bullets || []), job.input?.projectName, job.input?.notes].filter(Boolean).join(" ");
  if (!text.trim()) return false;
  const questionMarks = (text.match(/\?/g) || []).length;
  const signalChars = text.replace(/[\s\d.,，。/\\|:：;；()（）[\]{}?？\-_*]/g, "").length;
  if (questionMarks >= 6 && questionMarks > signalChars * 0.25) return false;
  if (/<!doctype|not valid JSON/i.test(job.warning || "")) return false;
  return true;
}

function isFullDeckJob(job = {}) {
  const slideCount = job.deck?.slides?.length || 0;
  return job.mode !== "style-preview" && !job.input?.styleProof && slideCount > 4;
}

function isPreferredStartupJob(job = {}) { if (!isRestorableJob(job)) return false; const slideCount = job.deck?.slides?.length || 0; const previewCount = (job.previewImages || []).filter(Boolean).length; const routeScore = Number(job.quality?.routeAdherence?.score ?? 1); const warningCount = Number(job.quality?.warningCount || job.quality?.warnings?.length || 0); if (!slideCount || previewCount < slideCount) return false; if (warningCount > 12 && routeScore < 0.5) return false; return true; }
function jobHealthClass(job = {}) { const score = Number(job.quality?.routeAdherence?.score ?? 1); const slideCount = job.deck?.slides?.length || 0; const previewCount = (job.previewImages || []).filter(Boolean).length; const blockingWarnings = getBlockingWarnings(job).length; if (!slideCount || previewCount < slideCount || score < 0.5) return "bad"; if (blockingWarnings || score < 0.85) return "warn"; return "good"; }
function jobHealthLabel(job = {}) { const cls = jobHealthClass(job); const slideCount = job.deck?.slides?.length || 0; const previewCount = (job.previewImages || []).filter(Boolean).length; const score = Number(job.quality?.routeAdherence?.score ?? 1); if (cls === "bad") return `需修复 / ${slideCount}页 / 路由${Math.round(score * 100)}% / 预览${previewCount}`; if (cls === "warn") return `可检查 / ${slideCount}页 / 路由${Math.round(score * 100)}%`; return `可继续 / ${slideCount}页`; }

createRoot(document.getElementById("root")).render(<App />);
