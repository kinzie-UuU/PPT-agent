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
  { themeName: "轻盈渐变风", name: "销售提案 / 战卡模板", scenario: "销售战卡、客户提案、节日礼盒", coreLayouts: ["pricing", "product-detail", "quote", "risk-checklist"] },
  { themeName: "东方自然风", name: "礼盒 / 节日 / 文化产品模板", scenario: "节日礼盒、食品茶饮、文化产品", coreLayouts: ["visual", "product-detail", "bundle", "pricing"] },
  { themeName: "黑白画册风", name: "品牌画册 / 高端产品模板", scenario: "品牌手册、设计汇报、高端产品介绍", coreLayouts: ["section", "visual", "quote", "product-detail"] },
  { themeName: "蓝白科技风", name: "技术方案 / 数据汇报模板", scenario: "技术方案、产品分析、数据汇报", coreLayouts: ["toc", "kpi", "compare", "timeline"] },
  { themeName: "暗黑科技风", name: "发布会 / 趋势报告模板", scenario: "新品发布、技术演示、趋势报告", coreLayouts: ["cover", "kpi", "timeline", "closing"] }
];

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
  { id: "materials", number: "01", title: "资料", desc: "上传与补充需求" },
  { id: "outline", number: "02", title: "大纲", desc: "确认页面路线" },
  { id: "generate", number: "03", title: "生成", desc: "选择生成方式" },
  { id: "preview", number: "04", title: "预览编辑", desc: "看稿并改单页" },
  { id: "export", number: "05", title: "导出", desc: "输出文件" },
  { id: "feedback", number: "06", title: "反馈", desc: "评分与留言" }
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
  async styleGroups() {
    const response = await fetch("/api/style-groups", { cache: "no-store" });
    return readJson(response);
  },
  async createStyleGroup(body) {
    return this.create("/api/style-groups", body);
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
  async updateStyleReference(id, body) {
    const response = await fetch(`/api/style-references/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return readJson(response);
  }
};

async function readJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "璇锋眰澶辫触");
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
  return /Failed to fetch|fetch failed|NetworkError|Load failed|鏈湴鏈嶅姟杩炴帴澶辫触|鏈湴鏈嶅姟鍝嶅簲瓒呮椂/i.test(message);
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
  const [styleGroups, setStyleGroups] = useState([]);
  const [templatePacks, setTemplatePacks] = useState(FALLBACK_TEMPLATE_PACKS);
  const [skillRules, setSkillRules] = useState({});
  const [styleReferences, setStyleReferences] = useState([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [generationProgress, setGenerationProgress] = useState({ active: false, mode: "", value: 0, label: "" });
  const [stylePreviewJob, setStylePreviewJob] = useState(null);
  const [stylePreviewBusy, setStylePreviewBusy] = useState(false);
  const [styleConfirmed, setStyleConfirmed] = useState(false);
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
      setJob(null);
      setFiles([]);
      setFileIds([]);
      setSelectedSlide(0);
      setActiveStep("materials");
      setStatus("");
    }).catch(() => {});
    api.designSystem().then((data) => {
      const nextThemes = data.themes || [];
      if (nextThemes.length && !nextThemes.some((theme) => isMojibake(theme.name || theme.bestFor))) setThemes(nextThemes);
      const nextPacks = data.templatePacks || [];
      if (nextPacks.length && !nextPacks.some((pack) => isMojibake(pack.name || pack.scenario))) setTemplatePacks(nextPacks);
      setSkillRules(data.skillRules || {});
      setStyleReferences(data.styleReferences || []);
      setStyleGroups(data.styleGroups || []);
    }).catch(() => {});
    api.styleReferences().then((data) => setStyleReferences(data.references || [])).catch(() => {});
    api.styleGroups().then((data) => setStyleGroups(data.groups || [])).catch(() => {});
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
  const inferredMaterials = useMemo(() => inferMaterialTypes(files), [files]);
  const completion = useMemo(() => getCompletion({ form, fileIds, job }), [form, fileIds, job]);
  const stepState = useMemo(() => getStepState({ activeStep, fileIds, job, formats }), [activeStep, fileIds, job, formats]);

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
  }

  function updateDraft(name, value) {
    setDraft((current) => ({ ...current, [name]: value }));
  }

  function validatePreparation() {
    if (!form.notes.trim() && fileIds.length === 0) {
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
      setFiles((current) => [...current, ...(data.files || [])]);
      setFileIds((current) => [...current, ...(data.files || []).map((file) => file.id)]);
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
        ...form,
        projectName: getEffectiveProjectName(form, files),
        fileIds,
        materials: inferredMaterials,
        outlinePlan: confirmedOutline,
        styleProofJobId: stylePreviewJob?.id || "",
        mode
      });
      setJob(data);
      setSelectedSlide(0);
      setActiveStep("preview");
      setRightPanelMode("edit");
      setJobs((current) => [data, ...current.filter((item) => item.id !== data.id)]);
      setStatus(data.warning || "任务已完成，可以预览和导出。");
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

  async function createStylePreview(confirmedOutline = null) {
    if (!validatePreparation()) return;
    const mode = getGenerationMode();
    setError("");
    setStylePreviewBusy(true);
    setStyleConfirmed(false);
    setStatus("正在生成风格确认样张...");
    try {
      const data = await api.create("/api/jobs/style-preview", {
        ...form,
        projectName: getEffectiveProjectName(form, files),
        fileIds,
        materials: inferredMaterials,
        outlinePlan: confirmedOutline,
        mode
      });
      setStylePreviewJob(data);
      setJobs((current) => [data, ...current.filter((item) => item.id !== data.id)]);
      setStatus(data.warning || "风格样张已生成，请先确认视觉调性，再生成完整 PPT。");
    } catch (err) {
      setError(getErrorMessage(err));
      setStatus("");
    } finally {
      setStylePreviewBusy(false);
    }
  }

  async function planOutline() {
    if (!validatePreparation()) return;
    setError("");
    setOutlineBusy(true);
    setStatus("正在生成可确认大纲...");
    try {
      const data = await api.create("/api/jobs/outline", {
        ...form,
        projectName: getEffectiveProjectName(form, files),
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
    setStatus("正在按补图计划复用原稿图片并重绘样稿...");
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
    setSettingsStatus("正在加入风格参考库...");
    try {
      const data = await api.uploadStyleReferences(files, meta);
      setStyleReferences((current) => [...(data.references || []), ...current]);
      setSettingsStatus("风格参考已加入，后续生成会参考它的调性。");
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
      setSettingsStatus("已从风格参考库删除。");
    } catch (err) {
      setSettingsStatus(getErrorMessage(err));
    } finally {
      setSettingsBusy(false);
    }
  }

  async function createStyleGroup(payload) {
    setSettingsBusy(true);
    setSettingsStatus("");
    try {
      const data = await api.createStyleGroup(payload);
      if (data.group) {
        setStyleGroups((current) => [data.group, ...current.filter((item) => item.id !== data.group.id && item.name !== data.group.name)]);
        setSettingsStatus("自定义风格库已创建，可以把参考图归到这个库里。");
      }
      return data.group;
    } catch (err) {
      setSettingsStatus(getErrorMessage(err));
      return null;
    } finally {
      setSettingsBusy(false);
    }
  }

  async function updateStyleReference(id, payload) {
    setSettingsBusy(true);
    setSettingsStatus("");
    try {
      const data = await api.updateStyleReference(id, payload);
      if (data.reference) {
        setStyleReferences((current) => current.map((item) => (item.id === id ? data.reference : item)));
        setSettingsStatus("风格参考图已更新分组。");
      }
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
    setStatus("姝ｅ湪鍒犻櫎鍘嗗彶浠诲姟...");
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
    setStatus("姝ｅ湪鎵归噺鍒犻櫎鍘嗗彶浠诲姟...");
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
    setStatus("姝ｅ湪淇鍘嗗彶浠诲姟...");
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
    setStatus("姝ｅ湪閲嶆柊鐢熸垚棰勮鍥?..");
    try {
      const data = await api.create(`/api/jobs/${job.id}/preview`, {});
      setJob(data);
      setJobs((current) => [data, ...current.filter((item) => item.id !== data.id)]);
      setStatus(data.previewWarning || "棰勮鍥惧凡閲嶆柊鐢熸垚銆?");
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
    setStatus("姝ｅ湪鎸夋柊妯℃澘閲嶆柊娓叉煋 PPT...");
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
    setRevision((current) => current ? `${current}锛?{text}` : text);
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
        next.splice(index + 1, 0, { ...next[index], title: `${next[index].title || "鏈懡鍚嶉〉"} 鍓湰` });
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

  const showRightPanel = activeStep === "preview" || rightPanelMode !== "closed";
  const visibleRightPanelMode = rightPanelMode === "closed" ? "edit" : rightPanelMode;

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
                <div className="chat-box">
                  <label className="chat-plus" title={UI.uploadTitle}>
                    <input type="file" multiple onChange={uploadFiles} />
                    <span>+</span>
                  </label>
                  <input
                    className="chat-prompt"
                    value={form.notes}
                    onChange={(e) => update("notes", e.target.value)}
                    placeholder={UI.promptPlaceholder}
                  />
                  <div className="chat-toolbar">
                    <small>{selectedFileNames || UI.uploadHint}</small>
                    <button className="send-button" type="button" onClick={planOutline} disabled={outlineBusy} aria-label={UI.sendOutline}>
                      {outlineBusy ? "..." : "→"}
                    </button>
                  </div>
                </div>
                <div className="outline-strategy-toggle" role="group" aria-label={UI.regenerateOutline}>
                  <button className={form.outlineStrategy !== "regenerate" ? "active" : ""} type="button" onClick={() => update("outlineStrategy", "keep-source")}>
                    <b>{UI.keepSourceOutline}</b>
                    <span>{UI.keepSourceDesc}</span>
                  </button>
                  <button className={form.outlineStrategy === "regenerate" ? "active" : ""} type="button" onClick={() => update("outlineStrategy", "regenerate")}>
                    <b>{UI.regenerateOutline}</b>
                    <span>{UI.regenerateDesc}</span>
                  </button>
                </div>
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
            <SectionCard title="生成 PPT" desc="根据当前资料和已确认的大纲生成 Deck、PPTX 与预览图。">
              <div className="readiness">
                <Metric label="资料文件" value={fileIds.length} />
                <Metric label="大纲状态" value={outlinePlan?.layoutSequence?.length ? "已确认" : "未确认"} />
                <Metric label="需求完整度" value={`${completion}%`} />
              </div>
              {generationProgress.active && <GenerationProgress progress={generationProgress} />}
              <StylePreviewGate
                busy={stylePreviewBusy}
                confirmed={styleConfirmed}
                job={stylePreviewJob}
                onConfirm={() => setStyleConfirmed(true)}
                onCreate={() => createStylePreview(outlinePlan)}
                onReset={() => {
                  setStyleConfirmed(false);
                  setStylePreviewJob(null);
                }}
              />
              <div className="action-grid single-action">
                <button className="primary-action" onClick={() => createJob(getGenerationMode(), outlinePlan)} disabled={generationProgress.active || stylePreviewBusy || !styleConfirmed || !outlinePlan?.layoutSequence?.length}>
                  <b>{generationProgress.active ? "正在生成 PPT" : "生成完整 PPT"}</b>
                  <span>{styleConfirmed ? "已确认样式，将按该风格输出完整 PPTX。" : "请先生成并确认风格样张。"}</span>
                </button>
              </div>
            </SectionCard>
          )}

          {activeStep === "preview" && (
            <SectionCard title="预览与单页编辑" desc="左侧选页，中间看稿并可直接编辑，右侧修改当前页。">
              <PreviewCanvas
                currentImage={currentImage}
                currentSlide={currentSlide}
                currentStyle={currentStyle}
                currentTemplate={currentTemplate}
                draft={draft}
                dirty={dirty}
                focusPreview={focusPreview}
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
            </SectionCard>
          )}

          {activeStep === "export" && (
            <SectionCard title="导出文件" desc="选择需要的格式。PPTX 直接生成，PDF/PNG 调用本机 PowerPoint。">
              <div className="export-layout">
                <div className="format-list">
                  {["pptx", "pdf", "png"].map((format) => (
                    <label className="format-option" key={format}>
                      <input type="checkbox" checked={formats.includes(format)} onChange={() => setFormats((current) => toggle(current, format))} />
                      <span>{format.toUpperCase()}</span>
                    </label>
                  ))}
                  <button className="btn primary wide" onClick={exportJob} disabled={!job || formats.length === 0}>开始导出</button>
                </div>
                <DownloadLinks job={job} />
              </div>
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
            {[
              ["edit", "编辑"],
              ["ai", "AI"],
              ["status", "状态"],
              ["history", "历史"]
            ].map(([id, label]) => (
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
              job={job}
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
              job={job}
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
          {visibleRightPanelMode === "status" && <StatusPanel job={job} files={files} fileIds={fileIds} status={status} error={error} connection={connection} localImage={localImage} skillRules={skillRules} onRepairDelivery={repairDelivery} onApplyImageSupplement={applyImageSupplement} onApplyLocalImageSupplement={applyLocalImageSupplement} onRescanLocalImageQa={rescanLocalImageQa} />}
          {visibleRightPanelMode === "history" && <HistoryPanel jobs={jobs} onSelect={selectJob} onDelete={deleteHistoryJob} onDeleteMany={deleteHistoryJobs} onRepair={repairHistoryJob} />}
          {visibleRightPanelMode === "settings" && (
            <SettingsPanel
              config={apiConfig}
              busy={settingsBusy}
              status={settingsStatus}
              models={availableModels}
              themes={themes}
              styleGroups={styleGroups}
              onChange={setApiConfig}
              onSave={saveApiConfig}
              onTest={testApiConfig}
              onDetectModels={detectModels}
              styleReferences={styleReferences}
              onCreateStyleGroup={createStyleGroup}
              onUpdateStyleReference={updateStyleReference}
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

function PreviewCanvas({ currentImage, currentSlide, currentStyle, currentTemplate, draft, dirty, focusPreview, job, liveSlide, selectedSlide, setFocusPreview, setSelectedSlide, slides, updateDraft, onSaveText, onRetryPreview, previewBusy, templateBusy, templateHit, themes = [], templatePacks = [], onRerenderTemplate }) {
  const editableSlide = dirty ? liveSlide : currentSlide;
  return (
    <div className={`preview-stage ${focusPreview ? "focus" : ""}`}>
      <div className="stage-toolbar">
        <div>
          <b>{dirty ? liveSlide?.title : currentSlide?.title || "等待生成"}</b>
          <span>第 {selectedSlide + 1} 页 · {LAYOUT_LABELS[currentSlide?.layout] || currentSlide?.layout || "自动版式"}{(dirty ? liveSlide?.storyRole : currentSlide?.storyRole) ? ` · ${dirty ? liveSlide?.storyRole : currentSlide?.storyRole}` : ""}</span>
        </div>
        <div className="template-switcher">
          <span>{currentTemplate?.name || "当前模板"} · {templateHit.label}</span>
          <select value={currentStyle} onChange={(event) => onRerenderTemplate?.(event.target.value)} disabled={!job || dirty || templateBusy}>
            {themes.map((theme) => {
              const pack = findTemplatePack(templatePacks, theme);
              return <option key={theme.name} value={theme.name}>{pack?.name || theme.name}</option>;
            })}
          </select>
        </div>
        <div className="stage-controls">
          <button onClick={() => setSelectedSlide((value) => Math.max(0, value - 1))} disabled={!job || selectedSlide === 0}>上一页</button>
          <button onClick={() => setSelectedSlide((value) => Math.min(slides.length - 1, value + 1))} disabled={!job || selectedSlide >= slides.length - 1}>下一页</button>
          <button onClick={() => setFocusPreview((value) => !value)} disabled={!job}>{focusPreview ? "返回编辑" : "专注预览"}</button>
        </div>
      </div>
      <div className="large-slide">
        <div className="editable-slide-stage">
          {currentImage ? <img src={currentImage} alt={`第 ${selectedSlide + 1} 页大图预览`} /> : currentSlide ? <SlideVisual slide={editableSlide} job={job} slideIndex={selectedSlide} /> : <div className="empty-preview">生成后这里显示大图预览</div>}
          {currentSlide ? <CanvasTextLayer draft={draft} slide={editableSlide} updateDraft={updateDraft} onSave={() => onSaveText?.(draft)} /> : null}
        </div>
      </div>
      {job?.previewWarning ? <div className="preview-warning"><div><b>PNG 预览图未生成，当前使用网页预览</b><span>{job.previewWarning}</span></div><button type="button" onClick={onRetryPreview} disabled={previewBusy}>{previewBusy ? "正在重试" : "重新生成预览图"}</button></div> : null}
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
      <div className="edit-mode-title"><div><b>直接编辑当前页</b>{dirty ? <strong>未保存</strong> : <strong className="saved">已同步</strong>}</div><span>保存后会重新生成 PPTX 和预览。</span></div>
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

const CANVAS_FIELDS = [
  { key: "title", label: "标题", fallback: "", box: { x: 58, y: 24, w: 34, h: 13 } },
  { key: "subtitle", label: "副标题", fallback: "", box: { x: 58, y: 42, w: 34, h: 10 } },
  { key: "bullets", label: "要点", fallback: "", box: { x: 58, y: 58, w: 34, h: 20 } }
];

function CanvasTextLayer({ draft = {}, slide = {}, updateDraft, onSave }) {
  const [drag, setDrag] = useState(null);
  const edits = normalizeCanvasEdits(draft.canvasEdits || slide.canvasEdits);
  const values = {
    title: draft.title ?? slide.title ?? "",
    subtitle: draft.subtitle ?? slide.subtitle ?? "",
    bullets: draft.bullets ?? toBulletList(slide.bullets).join("\n")
  };

  function patchCanvasEdit(key, patch) {
    const current = normalizeCanvasEdits(draft.canvasEdits || slide.canvasEdits);
    updateDraft?.("canvasEdits", {
      ...current,
      [key]: { ...current[key], ...patch }
    });
  }

  function patchText(key, value) {
    updateDraft?.(key, value);
  }

  function startDrag(event, key) {
    event.preventDefault();
    event.stopPropagation();
    const box = edits[key]?.box || CANVAS_FIELDS.find((item) => item.key === key)?.box;
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
      {CANVAS_FIELDS.map((field) => {
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
              value={values[field.key] || field.fallback}
              onChange={(event) => patchText(field.key, event.target.value)}
              onBlur={onSave}
              onClick={(event) => event.stopPropagation()}
            />
          </div>
        );
      })}
    </div>
  );
}

function normalizeCanvasEdits(value = {}) {
  const edits = typeof value === "object" && value ? value : {};
  return CANVAS_FIELDS.reduce((acc, field) => {
    const box = edits[field.key]?.box || field.box;
    acc[field.key] = {
      ...edits[field.key],
      box: {
        x: clamp(Number(box.x ?? field.box.x), 0, 96),
        y: clamp(Number(box.y ?? field.box.y), 0, 96),
        w: clamp(Number(box.w ?? field.box.w), 8, 96),
        h: clamp(Number(box.h ?? field.box.h), 5, 96)
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
    ...((quality.localImageQa?.risks || []).map((item) => `\u672a\u8bbe\u7f6e`)),
    ...((quality.renderImageQa?.warnings || []).map((item) => `\u672a\u8bbe\u7f6e`)),
    ...getBlockingWarnings(job),
    job.warning,
    job.previewWarning,
    job.exportWarning,
    ...(material.confirmationFields?.length ? [`\u672a\u8bbe\u7f6e`] : [])
  ].filter((item) => item && !isNonBlockingWarning(item)).slice(0, 3);
}

function renderQaRiskLabel(value = "") {
  const map = {
    "cover-crops-too-much": "\u672a\u8bbe\u7f6e",
    "contain-leaves-too-much-empty-space": "\u672a\u8bbe\u7f6e",
    "landscape-scene-should-be-hero-or-background": "\u672a\u8bbe\u7f6e"
  };
  return map[value] || value;
}

function localQaRiskLabel(value = "") {
  const map = {
    "image-may-be-too-blank": "\u672a\u8bbe\u7f6e",
    "text-safe-area-too-busy": "\u672a\u8bbe\u7f6e",
    "possible-readable-text-or-labels": "\u672a\u8bbe\u7f6e",
    "possible-small-dark-text-or-labels": "\u672a\u8bbe\u7f6e",
    "high-contrast-foreground-may-include-text": "\u672a\u8bbe\u7f6e",
    "qa-failed": "\u672a\u8bbe\u7f6e"
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
        <span>{decision.hasOldDeck ? "\u672a\u8bbe\u7f6e" : "?? PPT ??"}</span>
      </div>
      <div className="agent-record-grid">
        <RecordBlock title="\u672a\u8bbe\u7f6e" value={decision.intent || "PPT ??"} detail={`${inputStrengthLabel(decision.inputStrength || material.inputStrength)} ? ${decision.targetSlides || route.targetSlides || job?.deck?.slides?.length || 0} ?`} />
        <RecordBlock title="\u672a\u8bbe\u7f6e" value={`\u672a\u8bbe\u7f6e`} detail={`?? ${material.charCount || 0} ? ? ?? ${material.imageCount || 0} ? ?? ${material.priceCount || 0}`} />
        <RecordBlock title="\u672a\u8bbe\u7f6e" value={route.deckType || decision.routeType || "\u672a\u8bbe\u7f6e"} detail={routeReasons.slice(0, 2).join("?") || "\u672a\u8bbe\u7f6e"} />
        <RecordBlock title="\u672a\u8bbe\u7f6e" value={fixes.length ? `\u672a\u8bbe\u7f6e` : "\u672a\u8bbe\u7f6e"} detail={fixes[0]?.changes?.slice(0, 2).join("?") || "\u672a\u8bbe\u7f6e"} />
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

function SourceRecognitionCard({ report }) {
  if (!report) return null;
  const pages = Array.isArray(report.pages) ? report.pages : [];
  const slotReport = report.imageSlotReport || null;
  const statusLabel = { "text+image": "??+??", "text-only": "\u672a\u8bbe\u7f6e", "image-only": "\u672a\u8bbe\u7f6e", empty: "??" };
  return (
    <div className="source-report-card">
      <b>{"\u8d44\u6599\u8bc6\u522b"}</b>
      <p>{report.hasOldDeck ? "\u672a\u8bbe\u7f6e" : "\u672a\u8bbe\u7f6e"}</p>
      <div className="source-report-stats">
        <span><strong>{report.pageCount || 0}</strong>?</span>
        <span><strong>{report.textPageCount || 0}</strong>{"\u6587\u5b57\u9875"}</span>
        <span><strong>{report.imageCount || 0}</strong>??</span>
        <span><strong>{report.boundImageCount || 0}</strong>{"\u5df2\u7ed1\u5b9a\u56fe\u7247"}</span>
      </div>
      {slotReport ? (
        <div className="source-slot-summary">
          <span>{"\u5df2\u5339\u914d"}{slotReport.boundSlides || 0} {"\u4e2a\u56fe\u69fd"}</span>
          <span>{"\u6765\u81ea\u539f\u7a3f"}{slotReport.sourceBoundSlides || 0} {"\u9875"}</span>
          <span>{"\u5df2\u66ff\u6362"}{slotReport.changedSlides || 0} {"\u9875"}</span>
        </div>
      ) : null}
      {report.warnings?.length ? <div className="source-report-warnings">{report.warnings.slice(0, 4).map((item) => <span key={item}>{item}</span>)}</div> : null}
      {pages.length ? (
        <div className="source-page-list">
          {pages.slice(0, 10).map((page) => (
            <div className={`source-page-row ${page.status || "empty"}`} key={page.page}>
              <span>#{page.page}</span>
              <div>
                <b>{page.title || `? ${page.page} ?`}</b>
                <small>{page.textChars || 0} ? / {page.imageCount || 0} ? / {statusLabel[page.status] || page.status || "??"}</small>
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
  const statusLabel = latest.status === "block" ? "\u672a\u8bbe\u7f6e" : latest.status === "warn" ? "\u672a\u8bbe\u7f6e" : "??";
  const stageLabel = latest.stage === "style-preview" ? "\u672a\u8bbe\u7f6e" : "\u672a\u8bbe\u7f6e";
  return (
    <div className={`agent-review-card ${latest.status || "pass"}`}>
      <div className="agent-review-head"><b>Agent {"\u590d\u5ba1"}</b><span>{stageLabel} ? {statusLabel}</span></div>
      <p>{latest.nextGate === "human-style-confirmation" ? "\u672a\u8bbe\u7f6e" : "\u672a\u8bbe\u7f6e"}</p>
      {latest.cloudVisualReview ? (
        <div className={`cloud-review-summary ${latest.cloudVisualReview.status || "warn"}`}>
          <strong>{latest.cloudVisualReview.used ? "\u672a\u8bbe\u7f6e" : "\u672a\u8bbe\u7f6e"}</strong>
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
  const actionLabel = { "use-source-image": "\u672a\u8bbe\u7f6e", "use-uploaded-image": "\u672a\u8bbe\u7f6e", "need-remote-generation": "\u672a\u8bbe\u7f6e" };
  return (
    <div className="image-supplement-card">
      <div className="image-supplement-head"><b>{"\u8865\u56fe\u8ba1\u5212"}</b><span>{plan.status === "needs-human-confirmation" ? "\u5f85\u786e\u8ba4" : "\u5df2\u68c0\u67e5"}</span></div>
      <p>{"\u68c0\u67e5\u54ea\u4e9b\u9875\u9700\u8981\u539f\u56fe\u590d\u7528\u3001\u4e0a\u4f20\u56fe\u6216\u8fdc\u7a0b\u751f\u56fe\u8865\u9f50\u3002"}</p>
      <div className="image-supplement-facts"><span>{"\u6e90\u9875"} {plan.sourceFacts?.sourcePages || 0} {"\u9875"}</span><span>{"\u6e90\u56fe"} {plan.sourceFacts?.sourceImages || 0} {"\u5f20"}</span><span>{"\u5df2\u7ed1\u5b9a"} {plan.sourceFacts?.boundImageSlots || 0} {"\u4e2a"}</span><span>{"\u4fee\u590d"} {plan.sourceFacts?.visualFixRounds || 0} {"\u8f6e"}</span></div>
      {items.length ? <div className="image-supplement-list">{items.slice(0, 5).map((item) => <div className={item.action || "need-remote-generation"} key={`${item.slide}-${item.title}`}><strong>#{item.slide} {item.title}</strong><small>{actionLabel[item.action] || item.action} ? {item.reason}</small>{item.availableSourceImages?.length ? <em>{"\u53ef\u7528\u56fe\u7247"}{item.availableSourceImages.slice(0, 2).join(" / ")}</em> : null}</div>)}</div> : null}
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
      <p>{plan.theme || "\u672a\u8bbe\u7f6e"} ? {plan.system || "poster-layer-system"}</p>
      <div><span>{pagePlans.length} {"\u9875\u7b56\u7565"}</span><span>{plan.generationPolicy?.localFirst ? "\u672c\u5730\u4f18\u5148" : "\u4e91\u7aef\u4f18\u5148"}</span><span>{plan.comfy?.workflowMustBeSaved ? "\u4fdd\u5b58\u8282\u70b9" : "\u65e0\u8282\u70b9"}</span></div>
      {plan.globalComposition ? <small>{[plan.globalComposition.background, `\u672a\u8bbe\u7f6e`, `\u672a\u8bbe\u7f6e`].filter(Boolean).join("?")}</small> : null}
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
      <p>{Number.isFinite(score) ? `${score} ?` : "\u672a\u8bbe\u7f6e"} / {diagnosis.slideCount || slides.length || 0} ?</p>
      <div><span>{low.length ? `\u672a\u8bbe\u7f6e` : "\u672a\u8bbe\u7f6e"}</span><span>{dense.length ? `\u672a\u8bbe\u7f6e` : "\u672a\u8bbe\u7f6e"}</span></div>
      {slides.length ? <ul className="local-qa-list">{slides.slice(0, 5).map((slide) => <li className={Number(slide.diagnosisScore) < 72 ? "warn" : "pass"} key={slide.page}><strong>#{slide.page} {slide.type || "unknown"} / {slide.diagnosisScore ?? "-"} ?</strong><span>{slide.layoutStrategy || "structured_summary"} / {(slide.problems || []).map((item) => item.message || item).slice(0, 2).join(" / ") || "\u672a\u8bbe\u7f6e"}</span></li>)}</ul> : null}
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
      <p>{confirmation.title || confirmation.id} ? {confirmation.previewCount || 0} {"\u5f20\u6837\u5f20"} ? {"\u590d\u5ba1"} {confirmation.reviewStatus || "\u672a\u8bbe\u7f6e"}</p>
      <div><span>{confirmation.style || "\u672a\u8bbe\u7f6e"}</span><span>{confirmation.styleFingerprint?.prompt ? "\u672a\u8bbe\u7f6e" : "\u672a\u8bbe\u7f6e"}</span><span>{fix?.changes?.length ? `\u672a\u8bbe\u7f6e` : "\u672a\u8bbe\u7f6e"}</span></div>
      {cloud.summary ? <small>{cloud.used ? cloud.summary : `\u672a\u8bbe\u7f6e`}</small> : null}
    </div>
  );
}

function LocalImageQaCard({ qa, onRescan }) {
  if (!qa?.total) return null;
  const items = Array.isArray(qa.items) ? qa.items : [];
  return (
    <div className={`route-card local-qa-card ${qa.warnCount ? "warning" : ""}`}>
      <div className="local-qa-head"><b>{"\u672c\u5730\u56fe QA"}</b>{onRescan ? <button type="button" onClick={onRescan}>{"\u91cd\u626b"}</button> : null}</div>
      <p>{qa.passCount || 0}/{qa.total} {"\u901a\u8fc7"} ? {qa.checked || 0} {"\u5f20\u5df2\u68c0\u67e5"}</p>
      <div><span>{qa.warnCount ? `\u672a\u8bbe\u7f6e` : "\u672a\u8bbe\u7f6e"}</span><span>{qa.risks?.length ? qa.risks.map(localQaRiskLabel).slice(0, 2).join(" / ") : "\u672a\u8bbe\u7f6e"}</span></div>
      {items.length ? <ul className="local-qa-list">{items.slice(0, 5).map((item) => <li className={item.status === "pass" ? "pass" : "warn"} key={item.id || item.name}><strong>{item.slide ? `#${item.slide} ` : ""}{item.status === "pass" ? "??" : "??"}</strong><span>{item.risks?.length ? item.risks.map(localQaRiskLabel).join("?") : "\u672a\u8bbe\u7f6e"}</span></li>)}</ul> : null}
    </div>
  );
}

function RenderImageQaCard({ qa }) {
  if (!qa?.total) return null;
  const items = Array.isArray(qa.items) ? qa.items : [];
  return (
    <div className={`route-card local-qa-card ${qa.warningCount ? "warning" : ""}`}>
      <div className="local-qa-head"><b>{"\u56fe\u7247\u6bd4\u4f8b QA"}</b></div>
      <p>{qa.total} {"\u5f20\u56fe\u7247"} ? {qa.warningCount || 0} {"\u4e2a\u88c1\u526a/\u7559\u767d\u98ce\u9669"}</p>
      <div><span>{"\u6700\u5927\u88c1\u526a"} {Math.round((qa.maxCropLoss || 0) * 100)}%</span><span>{"\u6700\u5c0f\u586b\u5145"} {Math.round((qa.minFillRatio || 1) * 100)}%</span></div>
      {items.length ? <ul className="local-qa-list">{items.slice(0, 5).map((item, index) => <li className="warn" key={`${item.slideIndex}-${item.source}-${index}`}><strong>? {item.slideIndex} ? ? {item.mode}</strong><span>{(item.warnings || []).map(renderQaRiskLabel).join("?")} ? ?? {item.imageWidth}x{item.imageHeight}</span></li>)}</ul> : null}
    </div>
  );
}

function StatusPanel({ job, files, fileIds, status, error, connection, localImage, skillRules, onRepairDelivery, onApplyImageSupplement, onApplyLocalImageSupplement, onRescanLocalImageQa }) {
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
      {job ? <div className={`status-summary ${statusTone}`}><div><b>{statusTone === "pass" ? "\u5df2\u901a\u8fc7" : statusTone === "warn" ? "\u9700\u68c0\u67e5" : "\u9700\u4fee\u590d"}</b><span>{job.deck?.slides?.length || 0} {"\u9875"} ? {"\u8def\u7531"} {Number.isFinite(routeScore) ? `${Math.round(routeScore * 100)}%` : "-"} ? {(job.previewImages || []).filter(Boolean).length} {"\u5f20\u9884\u89c8"}</span></div><button type="button" onClick={() => setShowDetails((value) => !value)}>{showDetails ? "\u6536\u8d77" : "\u8be6\u60c5"}</button></div> : null}
      {job?.agentPlan ? <div className={`agent-card ${job.agentDecision?.autoRepaired ? "repaired" : "checked"}`}><b>{job.agentPlan.name || "AI PPT Agent"}</b><p>{job.agentDecision?.intent || "PPT ??"} ? {job.agentDecision?.autoRepaired ? "\u672a\u8bbe\u7f6e" : "\u672a\u8bbe\u7f6e"}</p><div>{(job.agentSteps || []).slice(-5).map((step) => <span className={step.status || "done"} key={`${step.id}-${step.at}`}><strong>{step.label}</strong>{step.summary || step.status}</span>)}</div>{job.agentDecision?.finalAssessment?.hints?.length ? <small>{job.agentDecision.finalAssessment.hints.join("?")}</small> : null}</div> : null}
      {job?.agentPlan ? <AgentWorkRecord job={job} files={files} /> : null}
      {job?.agentReviews?.length ? <AgentReviewCard reviews={job.agentReviews} visualFixes={job.visualFixes || []} /> : null}
      <ImageSupplementPlanCard plan={job?.imageSupplementPlan} onApply={onApplyImageSupplement} onApplyLocal={onApplyLocalImageSupplement} localImage={localImage} />
      {showDetails ? <ul className="status-list"><li><b>{fileIds.length}</b><span>{"\u4e0a\u4f20\u6587\u4ef6"}</span></li><li><b>{job?.deck?.slides?.length || 0}</b><span>{"\u5df2\u751f\u6210\u9875"}</span></li><li><b>{job?.aiUsed ? "AI" : "\u672c\u5730"}</b><span>{"\u751f\u6210\u6a21\u5f0f"}</span></li></ul> : null}
      <div className={`health-card ${connection?.state || "checking"}`}><span className={connection?.state === "offline" ? "state-dot error" : connection?.state === "online" ? "state-dot active" : "state-dot checking"} /><div><b>{connection?.state === "offline" ? "\u672c\u5730\u79bb\u7ebf" : connection?.state === "online" ? "\u672c\u5730\u5728\u7ebf" : "\u68c0\u67e5\u4e2d"}</b><p>{connection?.message || "\u6b63\u5728\u68c0\u67e5..."}</p></div></div>
      <div className={`health-card ${localImage?.state || "checking"}`}><span className={localImage?.state === "offline" ? "state-dot error" : localImage?.state === "online" ? "state-dot active" : "state-dot checking"} /><div><b>{localImage?.state === "online" ? "\u751f\u56fe\u5728\u7ebf" : localImage?.state === "offline" ? "\u751f\u56fe\u79bb\u7ebf" : "\u68c0\u67e5\u751f\u56fe"}</b><p>{localImage?.message || "\u68c0\u67e5 Z-Image / ComfyUI..."}</p></div></div>
      {routeSummary ? <div className="route-card"><b>{"\u667a\u80fd\u8def\u7531"}</b><p>{routeSummary.deckType || "\u672a\u77e5"} ? {routeSummary.recommendedTheme || "\u672a\u8bbe\u7f6e\u98ce\u683c"}</p><div><span>{routeSummary.targetSlides || job?.deck?.slides?.length || 0} {"\u9875"}</span><span>{routeSummary.layoutSequence?.length || 0} {"\u4e2a\u7248\u5f0f"}</span><span>{routeSummary.imageStrategy?.hasImageSlides ? "\u542b\u56fe\u7247\u9875" : "\u65e0\u56fe\u7247\u9875"}</span><span>{routeSummary.riskStrategy?.includeRiskChecklist ? "\u542b\u98ce\u9669\u9875" : "\u65e0\u98ce\u9669\u9875"}</span></div></div> : null}
      <StyleProofConfirmationCard confirmation={job?.input?.styleProofConfirmation} />
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

function SettingsPanel({ config, busy, status, models, themes = [], styleGroups = [], styleReferences = [], onChange, onSave, onTest, onDetectModels, onCreateStyleGroup, onUpdateStyleReference, onUploadStyleReference, onDeleteStyleReference }) {
  const [styleName, setStyleName] = useState("");
  const [styleTone, setStyleTone] = useState("");
  const [groupName, setGroupName] = useState("");
  const [groupTone, setGroupTone] = useState("");
  const builtinThemes = themes.length ? themes : FALLBACK_THEMES;
  const themeOptions = [...builtinThemes, ...styleGroups];
  const defaultThemeName = themeOptions[0]?.name || "";
  const [styleTheme, setStyleTheme] = useState(defaultThemeName);
  useEffect(() => {
    if (defaultThemeName && !themeOptions.some((theme) => theme.name === styleTheme)) setStyleTheme(defaultThemeName);
  }, [defaultThemeName, styleTheme, themeOptions]);
  const groupedStyleReferences = themeOptions.map((theme) => ({ theme, references: styleReferences.filter((item) => (item.themeName || defaultThemeName) === theme.name) }));
  const selectedStyleReferences = groupedStyleReferences.find(({ theme }) => theme.name === styleTheme)?.references || [];
  const orphanStyleReferences = styleReferences.filter((item) => item.themeName && !themeOptions.some((theme) => theme.name === item.themeName));
  function update(name, value) { onChange((current) => ({ ...current, [name]: value })); }
  function handleStyleUpload(event) {
    const files = event.target.files;
    if (files?.length) {
      const theme = themeOptions.find((item) => item.name === styleTheme) || themeOptions[0] || {};
      onUploadStyleReference(files, { name: styleName, tone: styleTone, themeName: theme.name || styleTheme, themeSlug: theme.slug || "" });
      setStyleName("");
      setStyleTone("");
    }
    event.target.value = "";
  }
  async function handleCreateGroup() {
    const group = await onCreateStyleGroup?.({ name: groupName, tone: groupTone, bestFor: groupTone });
    if (group?.name) { setStyleTheme(group.name); setGroupName(""); setGroupTone(""); }
  }
  return (
    <div className="side-section settings-panel">
      <h2>API {"\u8bbe\u7f6e"}</h2>
      <div className={`api-state ${config.hasApiKey ? "ready" : "missing"}`}><span className={config.hasApiKey ? "state-dot active" : "state-dot error"} /><div><b>{config.hasApiKey ? "AI \u5df2\u914d\u7f6e" : "\u672a\u914d\u7f6e API Key"}</b><p>{config.hasApiKey ? `\u5f53\u524d Key: ${config.maskedApiKey || "-"}` : "\u672a\u914d\u7f6e\uff0c\u5c06\u4f7f\u7528\u672c\u5730\u6a21\u677f\u751f\u6210"}</p></div></div>
      <Field label="OpenAI API Key"><input type="password" value={config.apiKey || ""} onChange={(event) => update("apiKey", event.target.value)} placeholder={config.hasApiKey ? "\u7559\u7a7a\u5219\u4fdd\u7559\u5df2\u4fdd\u5b58\u7684 Key" : "sk-..."} autoComplete="off" /></Field>
      <Field label="Base URL"><input value={config.baseUrl || ""} onChange={(event) => update("baseUrl", event.target.value)} placeholder="https://api.openai.com/v1" /></Field>
      <Field label="Model"><select value={config.model || ""} onChange={(event) => update("model", event.target.value)}>{models?.length ? models.map((model) => <option key={model} value={model}>{model}</option>) : <option value={config.model || "gpt-4.1-mini"}>{config.model || "gpt-4.1-mini"}</option>}</select></Field>
      <div className="button-row tight"><button className="btn primary" type="button" onClick={onSave} disabled={busy}>{"\u4fdd\u5b58\u914d\u7f6e"}</button><button className="btn ghost" type="button" onClick={onTest} disabled={busy}>{"\u6d4b\u8bd5\u8fde\u63a5"}</button><button className="btn ghost" type="button" onClick={onDetectModels} disabled={busy}>{"\u68c0\u6d4b\u6a21\u578b"}</button></div>
      {status ? <div className="settings-status">{status}</div> : null}
      <div className="settings-divider" />
      <h2>{"\u98ce\u683c\u5e93\u5206\u7ec4"}</h2>
      <p className="settings-note">{"\u5148\u65b0\u5efa\u4e00\u4e2a\u98ce\u683c\u7ec4\uff0c\u518d\u628a\u53c2\u8003\u56fe\u5f52\u5230\u8fd9\u4e2a\u7ec4\u3002"}</p>
      <Field label="\u5206\u7ec4\u540d\u79f0"><input value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="\u4f8b\u5982\uff1a\u4e1c\u65b9\u81ea\u7136\u98ce" /></Field>
      <Field label="\u8c03\u6027\u8bf4\u660e"><textarea className="compact-textarea" value={groupTone} onChange={(event) => setGroupTone(event.target.value)} placeholder="\u4f8b\u5982\uff1a\u7559\u767d\u3001\u81ea\u7136\u7eb9\u7406\u3001\u4f4e\u9971\u548c\u3002" /></Field>
      <button className="btn ghost" type="button" onClick={handleCreateGroup} disabled={busy || !groupName.trim()}>{"\u65b0\u589e\u98ce\u683c\u7ec4"}</button>
      {styleGroups.length ? <div className="custom-style-groups">{styleGroups.map((group) => <button type="button" key={group.id || group.slug || group.name} onClick={() => setStyleTheme(group.name)}>{group.name}</button>)}</div> : null}
      <div className="settings-divider" />
      <Field label="\u5f53\u524d\u98ce\u683c\u7ec4"><select value={styleTheme} onChange={(event) => setStyleTheme(event.target.value)}>{themeOptions.map((theme) => <option key={theme.slug || theme.name} value={theme.name}>{theme.name}</option>)}</select></Field>
      <h2>{"\u98ce\u683c\u53c2\u8003\u5e93"}</h2>
      <p className="settings-note">{"\u4e0a\u4f20\u98ce\u683c\u53c2\u8003\u56fe\uff0c\u540e\u7eed\u751f\u6210 PPT 会\u53c2\u8003\u8272\u5f69\u3001\u7559\u767d\u3001\u8d28\u611f\u548c\u753b\u9762\u5bc6\u5ea6\u3002"}</p>
      <Field label="\u53c2\u8003\u540d\u79f0"><input value={styleName} onChange={(event) => setStyleName(event.target.value)} placeholder="\u4f8b\u5982\uff1a\u9ad8\u7aef\u793c\u76d2\u753b\u518c" /></Field>
      <Field label="\u98ce\u683c\u8bf4\u660e"><textarea className="compact-textarea" value={styleTone} onChange={(event) => setStyleTone(event.target.value)} placeholder="\u4f8b\u5982\uff1a\u4f4e\u9971\u548c\u3001\u514b\u5236\u3001\u6807\u9898\u5927\u7559\u767d" /></Field>
      <label className="style-upload"><input type="file" accept="image/*" multiple onChange={handleStyleUpload} disabled={busy} /><span>{"\u6dfb\u52a0\u98ce\u683c\u53c2\u8003\u56fe"}</span></label>
      <div className="style-current-gallery"><div className="style-current-gallery-head"><b>{"\u5f53\u524d\u7ec4\u56fe\u7247"}</b><span>{selectedStyleReferences.length} {"\u5f20"}</span></div>{selectedStyleReferences.length ? <div className="style-thumb-grid">{selectedStyleReferences.map((item) => <img key={item.id} src={item.imageUrl} alt={item.name || item.originalName || "\u53c2\u8003\u56fe"} />)}</div> : <p className="empty">{"\u8fd9\u4e2a\u7ec4\u8fd8\u6ca1\u6709\u53c2\u8003\u56fe"}</p>}</div>
      <div className="style-reference-list">
        {groupedStyleReferences.map(({ theme, references }) => <div className={`style-reference-group ${theme.name === styleTheme ? "active" : ""}`} key={theme.slug || theme.name}><button type="button" className="style-reference-group-head" onClick={() => setStyleTheme(theme.name)}><span>{theme.name}</span><small>{references.length} {"\u5f20"}</small></button>{references.length ? references.map((item) => <StyleReferenceItem key={item.id} item={item} busy={busy} themeOptions={themeOptions} onUpdate={onUpdateStyleReference} onDelete={onDeleteStyleReference} />) : <p className="empty">{"\u6682\u65e0\u53c2\u8003\u56fe"}</p>}</div>)}
        {orphanStyleReferences.length ? <div className="style-reference-group"><div className="style-reference-group-head"><span>{"\u672a\u5206\u7ec4"}</span><small>{orphanStyleReferences.length} {"\u5f20"}</small></div>{orphanStyleReferences.map((item) => <StyleReferenceItem key={item.id} item={item} busy={busy} themeOptions={themeOptions} onUpdate={onUpdateStyleReference} onDelete={onDeleteStyleReference} />)}</div> : null}
        {!styleReferences.length ? <p className="empty">{"\u6682\u65e0\u98ce\u683c\u53c2\u8003"}</p> : null}
      </div>
    </div>
  );
}

function StyleReferenceItem({ item, busy, themeOptions = [], onUpdate, onDelete }) {
  function moveToTheme(themeName) {
    const theme = themeOptions.find((option) => option.name === themeName) || {};
    onUpdate?.(item.id, { themeName: theme.name || themeName, themeSlug: theme.slug || "" });
  }
  return (
    <div className="style-reference-item">
      {item.imageUrl ? <img src={item.imageUrl} alt={item.name || item.originalName} /> : <span className="style-reference-fallback">IMG</span>}
      <div><b>{item.name || item.originalName || "\u672a\u8bbe\u7f6e"}</b><p>{item.tone || "\u672a\u8bbe\u7f6e"}</p>{item.styleFingerprint?.prompt ? <small className="style-fingerprint">{item.styleFingerprint.prompt}</small> : null}<select value={item.themeName || ""} onChange={(event) => moveToTheme(event.target.value)} disabled={busy}>{themeOptions.map((theme) => <option key={theme.slug || theme.id || theme.name} value={theme.name}>{theme.name}</option>)}</select></div>
      <button type="button" onClick={() => onDelete(item.id)} disabled={busy}>??</button>
    </div>
  );
}

function DownloadLinks({ job, compact = false }) {
  if (!job) return null;
  const links = [];
  if (job.exports?.pptx) links.push(["PPTX", job.exports.pptx, job.exportMeta?.pptx?.label]);
  if (job.exports?.pdf) links.push(["PDF", job.exports.pdf, job.exportMeta?.pdf?.label]);
  (job.exports?.png || []).forEach((url, index) => links.push([`PNG ${index + 1}`, url, job.exportMeta?.png?.[index]?.label]));
  if (links.length === 0) return <p className="empty">{"\u6682\u65e0\u5bfc\u51fa\u6587\u4ef6"}</p>;
  return <div className={compact ? "download-links compact" : "download-links"}>{links.map(([label, url, size]) => <a key={`${label}-${url}`} href={url} target="_blank" rel="noreferrer">{label}{size ? <small>{size}</small> : null}</a>)}</div>;
}

function SectionCard({ title, desc, children, className = "" }) {
  return <section className={`section-card ${className}`.trim()}>{(title || desc) ? <header>{title ? <h2>{title}</h2> : null}{desc ? <p>{desc}</p> : null}</header> : null}{children}</section>;
}

function Field({ label, children }) { return <div className="field"><label>{label}</label>{children}</div>; }
function Metric({ label, value }) { return <div className="metric"><b>{value}</b><span>{label}</span></div>; }

function GenerationProgress({ progress }) {
  const value = Math.max(0, Math.min(100, progress?.value || 0));
  return <div className="generation-progress"><div><b>{progress?.mode === "optimize" ? "正在优化旧 PPT" : "正在生成 PPT"}</b><span>{progress?.label || "正在处理，请稍等..."}</span></div><strong>{value}%</strong><em><i style={{ width: `${value}%` }} /></em></div>;
}

function StylePreviewGate({ busy, confirmed, job, onConfirm, onCreate, onReset }) {
  const images = job?.previewImages || [];
  const latestReview = Array.isArray(job?.agentReviews) ? job.agentReviews.at(-1) : null;
  const latestCloudReview = Array.isArray(job?.cloudReviews) ? job.cloudReviews.at(-1) : latestReview?.cloudVisualReview || null;
  const reviewStatus = latestReview?.status || latestCloudReview?.status || "";
  const canConfirm = Boolean(job && !busy && reviewStatus !== "block");
  return (
    <div className={`style-proof-card ${confirmed ? "confirmed" : ""}`}>
      <div className="style-proof-head">
        <div>
          <b>风格样稿确认</b>
          <span>{job ? `已生成 ${images.length || 0} 张样稿预览，并已完成自动质检。` : "先生成 3-4 页最终样式，人工确认后再输出整套 PPT。"}</span>
        </div>
        <div className="button-row tight">
          <button className="btn ghost" type="button" onClick={onCreate} disabled={busy}>{busy ? "正在生成样稿" : job ? "重新生成样稿" : "生成风格样稿"}</button>
          <button className="btn primary" type="button" onClick={onConfirm} disabled={!canConfirm}>{confirmed ? "风格已确认" : "确认这个风格"}</button>
          {job ? <button className="btn ghost" type="button" onClick={onReset} disabled={busy}>取消确认</button> : null}
        </div>
      </div>
      {latestReview ? <div className={`style-proof-qa ${latestReview.status || "pass"}`}><strong>样稿自动质检：{latestReview.status === "block" ? "需处理" : latestReview.status === "warn" ? "需确认" : "通过"}</strong><span>{latestReview.nextGate === "human-style-confirmation" ? "质检通过后进入人工风格确认。" : "已记录质检结果。"}</span>{latestCloudReview ? <small>{latestCloudReview.used ? (latestCloudReview.summary || latestCloudReview.status) : `云端视觉复审未完成：${latestCloudReview.reason || "not available"}`}</small> : null}<div>{(latestReview.agents || []).slice(0, 5).map((agent) => <em className={agent.status || "pass"} key={agent.id || agent.name}>{agent.name}：{agent.status === "block" ? "需处理" : agent.status === "warn" ? "需确认" : "通过"}</em>)}</div></div> : null}
      {images.length ? <div className="style-proof-grid">{images.slice(0, 4).map((url, index) => <img key={`${url}-${index}`} src={url} alt={`风格样稿 ${index + 1}`} />)}</div> : null}
      {job?.exports?.pptx ? <a className="style-proof-link" href={job.exports.pptx} target="_blank" rel="noreferrer">打开样稿 PPTX</a> : null}
    </div>
  );
}

function toggle(list, item) {
  return list.includes(item) ? list.filter((value) => value !== item) : [...list, item];
}

function toBulletList(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  return String(value).split(/[\r\n;；。]+/).map((item) => item.trim()).filter(Boolean);
}

function normalizePreviewPrices(slide = {}) {
  const data = toBulletList(slide.dataPoints);
  const source = data.length ? data : toBulletList(slide.bullets);
  const tiers = ["\u672a\u8bbe\u7f6e", "\u672a\u8bbe\u7f6e", "\u672a\u8bbe\u7f6e", "\u672a\u8bbe\u7f6e", "\u672a\u8bbe\u7f6e", "\u672a\u8bbe\u7f6e"];
  const entries = source.slice(0, 6).map((item, index) => {
    const text = String(item || "");
    const price = text.match(/\d+(?:\.\d+)?/)?.[0] || String(index + 1);
    const label = text.replace(price, "").replace(/[?,??;\-]/g, " ").trim() || tiers[index] || ("? " + (index + 1) + " ?");
    return {
      tier: tiers[index] || ("? " + (index + 1) + " ?"),
      price,
      label,
      note: index === 0 ? "\u672a\u8bbe\u7f6e" : index === source.length - 1 ? "\u672a\u8bbe\u7f6e" : "\u672a\u8bbe\u7f6e",
      accented: /recommended|upgrade|premium/i.test(text) || index === 1
    };
  });
  return entries.length ? entries : [{ tier: "\u672a\u8bbe\u7f6e", price: "01", label: slide.title || "\u672a\u8bbe\u7f6e", note: "\u672a\u8bbe\u7f6e", accented: true }];
}

function buildPreviewProductFacts(slide = {}) {
  const text = [slide.title, slide.subtitle, ...toBulletList(slide.bullets), ...toBulletList(slide.dataPoints)].join(" ");
  const price = text.match(/\d+(?:\.\d+)?/)?.[0] || "\u672a\u8bbe\u7f6e";
  const spec = text.match(/\d{2,4}\s*[xX*]\s*\d{2,4}(?:\s*[xX*]\s*\d{2,4})?\s*(?:mm|cm)?/i)?.[0] || "\u672a\u8bbe\u7f6e";
  const scene = toBulletList(slide.bullets).find((item) => /scene|client|gift|benefit/i.test(item)) || slide.subtitle || "按客户预算匹配";
  return [
    { label: "??", value: price },
    { label: "??", value: spec },
    { label: "??", value: String(scene).slice(0, 28) }
  ];
}
function makeSlideDraft(slide = {}) {
  return {
    layout: slide?.layout || "section",
    title: slide?.title || "",
    subtitle: slide?.subtitle || "",
    storyRole: slide?.storyRole || "",
    contentSource: slide?.contentSource || "\u672a\u8bbe\u7f6e",
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
  const images = (job?.files || []).filter((file) => file.uploadUrl);
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
  if (mode === "optimize") {
    if (value < 35) return "\u672a\u8bbe\u7f6e";
    if (value < 62) return "\u672a\u8bbe\u7f6e";
    if (value < 82) return "\u672a\u8bbe\u7f6e";
    return "\u672a\u8bbe\u7f6e";
  }
  if (value < 30) return "\u672a\u8bbe\u7f6e";
  if (value < 55) return "\u672a\u8bbe\u7f6e";
  if (value < 78) return "\u672a\u8bbe\u7f6e";
  return "\u672a\u8bbe\u7f6e";
}

function getStepState({ activeStep, fileIds, job, formats }) {
  return Object.fromEntries(STEPS.map((step) => {
    if (step.id === activeStep) return [step.id, UI.current];
    if (step.id === "materials") return [step.id, fileIds.length ? UI.done : UI.pending];
    if (step.id === "outline") return [step.id, job ? UI.done : UI.optional];
    if (step.id === "generate") return [step.id, job ? UI.done : UI.pending];
    if (step.id === "preview") return [step.id, job ? UI.editable : UI.waitingGenerate];
    if (step.id === "export") return [step.id, job && formats.length ? UI.exportable : UI.pending];
    return [step.id, job?.feedback ? UI.done : UI.optional];
  }));
}

function fileExt(name = "") { const ext = name.split(".").pop(); return ext ? ext.slice(0, 4).toUpperCase() : "FILE"; }
function getEffectiveProjectName(form = {}, files = []) { if (form.projectName?.trim()) return form.projectName.trim(); const fromNotes = String(form.notes || "").match(/[一-龥A-Za-z0-9][一-龥A-Za-z0-9s-]{3,28}/)?.[0]?.trim(); if (fromNotes) return fromNotes; const fromFile = files[0]?.originalName?.replace(/.[^.]+$/, "")?.trim(); return fromFile || "\u672a\u8bbe\u7f6e"; }

function inferMaterialTypes(files = []) {
  const types = new Set();
  for (const file of files) {
    const name = String(file?.originalName || file?.path || "").toLowerCase();
    if (/.(png|jpe?g|webp|gif|svg)$/.test(name)) types.add("\u672a\u8bbe\u7f6e");
    if (/.(ppt|pptx)$/.test(name)) types.add("? PPT");
    if (/.(doc|docx|pdf|txt|md)$/.test(name)) types.add("\u672a\u8bbe\u7f6e");
    if (/.(xls|xlsx|csv)$/.test(name)) types.add("\u672a\u8bbe\u7f6e");
    if (/price|moq|quote|delivery/.test(name)) types.add("价格 / 交付");
    if (/brand/.test(name)) types.add("品牌资料");
    if (/compare|competitor/.test(name)) types.add("竞品资料");
    if (/product|pack|sku/.test(name)) types.add("产品资料");
  }
  return [...types];
}

function formatBytes(value) { if (!value) return "\u672a\u8bbe\u7f6e"; if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`; return `${(value / 1024 / 1024).toFixed(1)} MB`; }
function inputStrengthLabel(value) { if (value === "strong") return "\u672a\u8bbe\u7f6e"; if (value === "weak") return "\u672a\u8bbe\u7f6e"; if (value === "empty") return "\u672a\u8bbe\u7f6e"; return "\u672a\u8bbe\u7f6e"; }
function uniqueList(items = []) { return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))]; }

function getOutlineSourceMeta(step = {}) {
  const type = step.sourceType || (step.kind === "source" ? "original-ppt" : "");
  if (type === "original-ppt") return { label: step.sourceLabel || "\u672a\u8bbe\u7f6e", tone: "source-original", evidence: step.evidence || "" };
  if (type === "extracted") return { label: step.sourceLabel || "\u672a\u8bbe\u7f6e", tone: "source-extracted", evidence: step.evidence || "" };
  if (type === "needs-confirmation" || step.needsConfirmation) return { label: step.sourceLabel || "\u672a\u8bbe\u7f6e", tone: "source-confirm", evidence: step.evidence || "" };
  if (["prices", "products", "productDetail", "visual", "compare", "bundle"].includes(step.kind)) return { label: "\u672a\u8bbe\u7f6e", tone: "source-extracted", evidence: step.evidence || "" };
  if (["risks", "assumptions"].includes(step.kind)) return { label: "\u672a\u8bbe\u7f6e", tone: "source-confirm", evidence: step.evidence || "" };
  return { label: step.sourceLabel || "AI ??", tone: "source-inferred", evidence: step.evidence || "" };
}

function formatDuration(seconds = 0) { const value = Math.max(0, Number(seconds) || 0); if (value < 60) return `${value}s`; if (value < 3600) return `${Math.floor(value / 60)}m`; return `${Math.floor(value / 3600)}h ${Math.floor((value % 3600) / 60)}m`; }
function isMojibake(value = "") { return /[�]|Ã|ç|閿|鐢/.test(String(value)); }
function findTemplatePack(packs = [], theme = {}) { return packs.find((pack) => pack.themeName === theme.name || pack.themeSlug === theme.slug); }

function makeOutlineStep(layout = "section") {
  const map = { cover: ["\u672a\u8bbe\u7f6e", "\u672a\u8bbe\u7f6e", "\u672a\u8bbe\u7f6e"], visual: ["\u672a\u8bbe\u7f6e", "\u672a\u8bbe\u7f6e", "\u672a\u8bbe\u7f6e"], section: ["\u672a\u8bbe\u7f6e", "\u672a\u8bbe\u7f6e", "\u672a\u8bbe\u7f6e"], toc: ["\u672a\u8bbe\u7f6e", "\u672a\u8bbe\u7f6e", "\u672a\u8bbe\u7f6e"], kpi: ["\u672a\u8bbe\u7f6e", "\u672a\u8bbe\u7f6e", "\u672a\u8bbe\u7f6e"], pricing: ["\u672a\u8bbe\u7f6e", "\u672a\u8bbe\u7f6e", "\u672a\u8bbe\u7f6e"], "product-detail": ["\u672a\u8bbe\u7f6e", "\u672a\u8bbe\u7f6e", "\u672a\u8bbe\u7f6e"], bundle: ["\u672a\u8bbe\u7f6e", "\u672a\u8bbe\u7f6e", "\u672a\u8bbe\u7f6e"], "risk-checklist": ["\u672a\u8bbe\u7f6e", "\u672a\u8bbe\u7f6e", "\u672a\u8bbe\u7f6e"], compare: ["\u672a\u8bbe\u7f6e", "\u672a\u8bbe\u7f6e", "\u672a\u8bbe\u7f6e"], timeline: ["\u672a\u8bbe\u7f6e", "\u672a\u8bbe\u7f6e", "\u672a\u8bbe\u7f6e"], cards: ["\u672a\u8bbe\u7f6e", "\u672a\u8bbe\u7f6e", "\u672a\u8bbe\u7f6e"], quote: ["\u672a\u8bbe\u7f6e", "\u672a\u8bbe\u7f6e", "\u672a\u8bbe\u7f6e"], closing: ["\u672a\u8bbe\u7f6e", "\u672a\u8bbe\u7f6e", "\u672a\u8bbe\u7f6e"] };
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
  const signalChars = text.replace(/[?sd.,??/\|:?;?()[]{}?-_*]/g, "").length;
  if (questionMarks >= 6 && questionMarks > signalChars * 0.25) return false;
  if (/<!doctype|not valid JSON/i.test(job.warning || "")) return false;
  return true;
}

function isPreferredStartupJob(job = {}) { if (!isRestorableJob(job)) return false; const slideCount = job.deck?.slides?.length || 0; const previewCount = (job.previewImages || []).filter(Boolean).length; const routeScore = Number(job.quality?.routeAdherence?.score ?? 1); const warningCount = Number(job.quality?.warningCount || job.quality?.warnings?.length || 0); if (!slideCount || previewCount < slideCount) return false; if (warningCount > 12 && routeScore < 0.5) return false; return true; }
function jobHealthClass(job = {}) { const score = Number(job.quality?.routeAdherence?.score ?? 1); const slideCount = job.deck?.slides?.length || 0; const previewCount = (job.previewImages || []).filter(Boolean).length; const blockingWarnings = getBlockingWarnings(job).length; if (!slideCount || previewCount < slideCount || score < 0.5) return "bad"; if (blockingWarnings || score < 0.85) return "warn"; return "good"; }
function jobHealthLabel(job = {}) { const cls = jobHealthClass(job); const slideCount = job.deck?.slides?.length || 0; const previewCount = (job.previewImages || []).filter(Boolean).length; const score = Number(job.quality?.routeAdherence?.score ?? 1); if (cls === "bad") return `\u9700\u4fee\u590d ? ${slideCount}\u9875 ? \u8def\u7531${Math.round(score * 100)}% ? \u9884\u89c8${previewCount}`; if (cls === "warn") return `\u53ef\u68c0\u67e5 ? ${slideCount}\u9875 ? \u8def\u7531${Math.round(score * 100)}%`; return `\u53ef\u7ee7\u7eed ? ${slideCount}\u9875`; }

createRoot(document.getElementById("root")).render(<App />);
