import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const FALLBACK_THEMES = [
  { name: "轻盈渐变风", bestFor: "销售战卡、客户提案、节日礼盒", colors: { bg: "F7FBFF", accent: "3158D4", soft: "EAF1FF" } },
  { name: "东方自然风", bestFor: "节日礼盒、文化产品、高级耐看方案", colors: { bg: "F7F3EA", accent: "68745E", soft: "EDE6D8" } },
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
  closing: "收束"
};

const QUICK_ACTIONS = ["标题更销售化", "改成价格梯度页", "讲稿更口语", "减少文字更高级", "强化下一步动作"];
const DECK_ACTIONS = ["整份减少文字更高级", "改成客户提案口吻", "强化销售话术和下一步行动", "改成技术数据汇报风格"];

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
  const [rating, setRating] = useState(4);
  const [comment, setComment] = useState("");
  const [activeStep, setActiveStep] = useState("materials");
  const [rightPanelMode, setRightPanelMode] = useState("closed");
  const [focusPreview, setFocusPreview] = useState(false);
  const [connection, setConnection] = useState({ state: "checking", message: "正在检查本地服务..." });
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
      setStatus("上传文件已删除。");
    } catch (err) {
      const message = getErrorMessage(err);
      if (!/Failed to fetch|fetch failed|NetworkError|Load failed|本地服务连接失败|本地服务响应超时/i.test(message)) {
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
        mode: "generate"
      });
      setOutlinePlan(data.outlinePlan || null);
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
    setStatus("正在按新模板重新渲染 PPT...");
    try {
      const data = await api.create(`/api/jobs/${job.id}/template`, { style });
      setJob(data);
      setJobs((current) => [data, ...current.filter((item) => item.id !== data.id)]);
      setForm((current) => ({ ...current, style }));
      setStatus(data.previewWarning || "已切换模板，PPTX 和预览已刷新。");
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
                  <label className="chat-plus" title="上传资料">
                    <input type="file" multiple onChange={uploadFiles} />
                    <span>+</span>
                  </label>
                  <input
                    className="chat-prompt"
                    value={form.notes}
                    onChange={(e) => update("notes", e.target.value)}
                    placeholder="一句话说清需求，也可以直接上传资料"
                  />
                  <div className="chat-toolbar">
                    <small>{selectedFileNames || "可上传 PPTX / DOCX / XLSX / PDF / 图片 / SVG"}</small>
                    <button className="send-button" type="button" onClick={planOutline} disabled={outlineBusy} aria-label="发送并生成大纲">
                      {outlineBusy ? "..." : "➜"}
                    </button>
                  </div>
                </div>
                <div className="outline-strategy-toggle" role="group" aria-label="大纲生成方式">
                  <button className={form.outlineStrategy !== "regenerate" ? "active" : ""} type="button" onClick={() => update("outlineStrategy", "keep-source")}>
                    <b>按原 PPT 大纲优化</b>
                    <span>保留页序、主题和原页素材，只重写与重排</span>
                  </button>
                  <button className={form.outlineStrategy === "regenerate" ? "active" : ""} type="button" onClick={() => update("outlineStrategy", "regenerate")}>
                    <b>重新生成大纲</b>
                    <span>重新组织叙事和页序，更像新提案</span>
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
                        <button className="file-delete" type="button" onClick={() => removeUploadedFile(file)}>删除</button>
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
              <div className="action-grid single-action">
                <button className="primary-action" onClick={() => createJob("generate", outlinePlan)} disabled={generationProgress.active || !outlinePlan?.layoutSequence?.length}>
                  <b>{generationProgress.active ? "正在生成 PPT" : "开始生成 PPT"}</b>
                  <span>使用已确认的大纲生成 Deck、PPTX 和预览图。</span>
                </button>
              </div>
            </SectionCard>
          )}

          {activeStep === "preview" && (
            <SectionCard title="预览与单页编辑" desc="左侧选页，中间看稿，右侧修改当前页。">
              <PreviewCanvas
                currentImage={currentImage}
                currentSlide={currentSlide}
                currentStyle={currentStyle}
                currentTemplate={currentTemplate}
                dirty={dirty}
                focusPreview={focusPreview}
                job={job}
                liveSlide={liveSlide}
                selectedSlide={selectedSlide}
                setFocusPreview={setFocusPreview}
                setSelectedSlide={setSelectedSlide}
                slides={slides}
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
          {visibleRightPanelMode === "status" && <StatusPanel job={job} files={files} fileIds={fileIds} status={status} error={error} connection={connection} skillRules={skillRules} onRepairDelivery={repairDelivery} />}
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
            <button className={panelMode === "slides" ? "active" : ""} type="button" onClick={() => setPanelMode("slides")}>页面</button>
            <button className={panelMode === "materials" ? "active" : ""} type="button" onClick={() => setPanelMode("materials")}>素材</button>
          </>
        ) : (
          <>
            <button className={panelMode === "materials" ? "active" : ""} type="button" onClick={() => { setPanelMode("materials"); setActiveStep("materials"); }}>资料</button>
            <button className={panelMode === "outline" ? "active" : ""} type="button" onClick={() => { setPanelMode("outline"); setActiveStep("outline"); }}>大纲</button>
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
        <span key={`${step.layout}-${index}`}>{String(index + 1).padStart(2, "0")} · {step.title || step.layout}</span>
      )) : <span>还没有大纲，先在中间生成可确认大纲。</span>}
    </div>
  );
}

function LegacyWorkspaceLeftPanel({ activeStep, contextMenu, dirty, draggedSlide, dropTargetSlide, files, insertLayout, job, liveSlide, outlinePlan, selectedSlide, setActiveStep, setContextMenu, setDraggedSlide, setDropTargetSlide, setInsertLayout, setSelectedSlide, slides, stepState, onSlideAction }) {
  const [panelMode, setPanelMode] = useState(job ? "slides" : "materials");
  useEffect(() => {
    setPanelMode(job ? "slides" : "materials");
  }, [job?.id]);
  return (
    <aside className="sidebar workspace-left" onClick={() => setContextMenu(null)}>
      {!job ? (
        <>
          <nav className="step-nav" aria-label="使用流程">
            {STEPS.map((step) => (
              <button className={activeStep === step.id ? "active" : ""} key={step.id} onClick={() => setActiveStep(step.id)}>
                <span>{step.number}</span>
                <b>{step.title}</b>
                <small>{stepState[step.id]}</small>
              </button>
            ))}
          </nav>
          <div className="left-summary">
            <b>资料状态</b>
            <span>{files.length ? `已上传 ${files.length} 个文件` : "等待上传资料或输入需求"}</span>
            <span>{outlinePlan?.layoutSequence?.length ? `大纲 ${outlinePlan.layoutSequence.length} 页` : "可先生成确认大纲"}</span>
          </div>
        </>
      ) : (
        <>
          <nav className="step-nav compact" aria-label="工作阶段">
            {STEPS.map((step) => (
              <button className={activeStep === step.id ? "active" : ""} key={step.id} onClick={() => setActiveStep(step.id)}>
                <span>{step.number}</span>
                <b>{step.title}</b>
              </button>
            ))}
          </nav>
          <div className="slide-rail">
            <div className="rail-insert">
              <select value={insertLayout} onChange={(event) => setInsertLayout(event.target.value)} disabled={dirty}>
                {Object.entries(LAYOUT_LABELS).map(([value, label]) => <option key={value} value={value}>新增：{label} / {value}</option>)}
              </select>
              <button type="button" onClick={() => onSlideAction?.("insert-after", { layout: insertLayout, slideIndex: selectedSlide })} disabled={dirty}>新增</button>
            </div>
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

function PreviewCanvas({ currentImage, currentSlide, currentStyle, currentTemplate, dirty, focusPreview, job, liveSlide, selectedSlide, setFocusPreview, setSelectedSlide, slides, onRetryPreview, previewBusy, templateBusy, templateHit, themes = [], templatePacks = [], onRerenderTemplate }) {
  return (
    <div className={`preview-stage ${focusPreview ? "focus" : ""}`}>
      <div className="stage-toolbar">
        <div>
          <b>{dirty ? liveSlide?.title : currentSlide?.title || "等待生成"}</b>
          <span>
            第 {selectedSlide + 1} 页 · {LAYOUT_LABELS[currentSlide?.layout] || currentSlide?.layout || "自动版式"}
            {(dirty ? liveSlide?.storyRole : currentSlide?.storyRole) ? ` · ${(dirty ? liveSlide?.storyRole : currentSlide?.storyRole)}` : ""}
          </span>
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
        {dirty && currentSlide ? <div className="live-preview-shell"><SlideVisual slide={liveSlide} job={job} slideIndex={selectedSlide} /></div> : currentImage ? <img src={currentImage} alt={`第 ${selectedSlide + 1} 页大图预览`} /> : currentSlide ? <SlideVisual slide={currentSlide} job={job} slideIndex={selectedSlide} /> : <div className="empty-preview">生成后这里显示大图预览</div>}
      </div>
      {job?.previewWarning && (
        <div className="preview-warning">
          <div>
            <b>PNG 预览图未生成，当前使用网页预览</b>
            <span>{job.previewWarning}</span>
          </div>
          <button type="button" onClick={onRetryPreview} disabled={previewBusy}>{previewBusy ? "正在重试" : "重新生成预览图"}</button>
        </div>
      )}
    </div>
  );
}

function AIPanel({ currentStyle, deckRevision, dirty, job, revision, setDeckRevision, setRevision, themes = [], templateBusy, templatePacks = [], onQuickAction, onRevise, onRewriteDeck, onRerenderTemplate }) {
  return (
    <div className="side-section ai-panel">
      <h2>AI 改写</h2>
      <div className="edit-mode-title">
        <b>改当前页</b>
        <span>适合重写标题、卖点、讲稿或当前页结构。</span>
      </div>
      <div className="quick-actions">
        {QUICK_ACTIONS.map((item) => (
          <button key={item} type="button" onMouseDown={(event) => { event.preventDefault(); onQuickAction(item); }} disabled={!job}>
            {item}
          </button>
        ))}
      </div>
      <textarea value={revision} onChange={(e) => setRevision(e.target.value)} placeholder="例如：第 3 页太密，改成两行展示，标题更销售化。" />
      <button className="btn primary wide" onClick={onRevise} disabled={!job || !revision.trim()}>应用到当前页</button>

      <div className="edit-separator" />
      <div className="edit-mode-title">
        <b>改整份 PPT</b>
        <span>适合统一口吻、减少文字、强化成交动作。</span>
      </div>
      <div className="quick-actions">
        {DECK_ACTIONS.map((item) => (
          <button key={item} type="button" onMouseDown={(event) => { event.preventDefault(); setDeckRevision(item); }} disabled={!job || dirty}>
            {item}
          </button>
        ))}
      </div>
      <textarea className="compact-textarea" value={deckRevision} onChange={(e) => setDeckRevision(e.target.value)} disabled={!job || dirty} placeholder="例如：整份减少文字，改成客户提案口吻，并强化最后一页下一步动作。" />
      <button className="btn primary wide" onClick={onRewriteDeck} disabled={!job || dirty || !deckRevision.trim()}>应用到整份 PPT</button>

      <div className="edit-separator" />
      <Field label="模板重渲染">
        <select value={currentStyle} onChange={(event) => onRerenderTemplate?.(event.target.value)} disabled={!job || dirty || templateBusy}>
          {themes.map((theme) => {
            const pack = findTemplatePack(templatePacks, theme);
            return <option key={theme.name} value={theme.name}>{pack?.name || theme.name}</option>;
          })}
        </select>
      </Field>
    </div>
  );
}

function EditorPanel({ currentSlide, deckRevision, dirty, draft, insertLayout, job, revision, savedDraft, selectedSlide, setDeckRevision, setDraft, setInsertLayout, setRevision, slides, updateDraft, onQuickAction, onRevise, onSaveText, onSlideAction, onRewriteDeck, onUndoJob }) {
  return (
    <aside className="editor-panel">
      <div className="edit-mode-title">
        <div>
          <b>直接编辑当前页</b>
          {dirty ? <strong>未保存</strong> : <strong className="saved">已同步</strong>}
        </div>
        <span>保存后重新生成 PPTX 和预览。</span>
      </div>
      <Field label="版式">
        <button className="btn ghost wide undo-button" type="button" onClick={onUndoJob} disabled={!job?.canUndo || dirty}>
          {job?.undoLabel || "撤销上一步"}
        </button>
        <select value={draft.layout} onChange={(e) => updateDraft("layout", e.target.value)} disabled={!job}>
          {Object.entries(LAYOUT_LABELS).map(([value, label]) => <option key={value} value={value}>{label} / {value}</option>)}
        </select>
      </Field>
      <Field label="标题">
        <input value={draft.title} onChange={(e) => updateDraft("title", e.target.value)} disabled={!job} />
      </Field>
      <Field label="副标题 / 摘要">
        <textarea className="compact-textarea" value={draft.subtitle} onChange={(e) => updateDraft("subtitle", e.target.value)} disabled={!job} />
      </Field>
      <Field label="叙事角色">
        <input value={draft.storyRole} onChange={(e) => updateDraft("storyRole", e.target.value)} disabled={!job} />
      </Field>
      <Field label="内容来源">
        <select value={draft.contentSource} onChange={(e) => updateDraft("contentSource", e.target.value)} disabled={!job}>
          {["用户输入", "用户资料", "用户图片", "系统推断", "待人工确认", "系统推断 + 待人工确认"].map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </Field>
      <Field label="要点（一行一条）">
        <textarea value={draft.bullets} onChange={(e) => updateDraft("bullets", e.target.value)} disabled={!job} />
      </Field>
      <details className="advanced-edit" open>
        <summary>高级字段</summary>
        <Field label="讲稿备注">
          <textarea className="compact-textarea" value={draft.speakerNotes} onChange={(e) => updateDraft("speakerNotes", e.target.value)} disabled={!job} />
        </Field>
        <Field label="视觉意图">
          <textarea className="compact-textarea" value={draft.visualIntent} onChange={(e) => updateDraft("visualIntent", e.target.value)} disabled={!job} />
        </Field>
        <Field label="价格 / 数据点（一行一条）">
          <textarea className="compact-textarea" value={draft.dataPoints} onChange={(e) => updateDraft("dataPoints", e.target.value)} disabled={!job} />
        </Field>
        <Field label="图片槽 / 素材名（一行一条）">
          <textarea className="compact-textarea" value={draft.imageSlots} onChange={(e) => updateDraft("imageSlots", e.target.value)} disabled={!job} />
        </Field>
      </details>
      <div className="button-row tight">
        <button className="btn primary" onClick={() => onSaveText(draft)} disabled={!job || !dirty}>保存当前页</button>
        <button className="btn ghost" onClick={() => setDraft(savedDraft)} disabled={!job || !dirty}>放弃修改</button>
      </div>
      <p className="save-hint">也可以按 Ctrl+S 保存当前页。</p>
      <div className="edit-separator" />
      <div className="edit-mode-title">
        <b>用指令改写当前页</b>
        <span>适合重写表达或调整页面结构。</span>
      </div>
      <div className="quick-actions">
        {QUICK_ACTIONS.map((item) => (
          <button key={item} type="button" onMouseDown={(event) => { event.preventDefault(); onQuickAction(item); }} disabled={!job}>
            {item}
          </button>
        ))}
      </div>
      <textarea value={revision} onChange={(e) => setRevision(e.target.value)} placeholder="例如：第 3 页产品矩阵太密，改成两行展示，标题更销售化。" />
      <button className="btn primary wide" onClick={onRevise} disabled={!job || !revision.trim()}>应用到当前页</button>
      <div className="edit-separator" />
      <div className="edit-mode-title">
        <b>整份批量改写</b>
        <span>适合统一口吻、减少全篇文字或强化成交动作。</span>
      </div>
      <div className="quick-actions">
        {DECK_ACTIONS.map((item) => (
          <button key={item} type="button" onMouseDown={(event) => { event.preventDefault(); setDeckRevision(item); }} disabled={!job || dirty}>
            {item}
          </button>
        ))}
      </div>
      <textarea className="compact-textarea" value={deckRevision} onChange={(e) => setDeckRevision(e.target.value)} disabled={!job || dirty} placeholder="例如：整份减少文字，改成客户提案口吻，并强化最后一页下一步动作。" />
      <button className="btn primary wide" onClick={onRewriteDeck} disabled={!job || dirty || !deckRevision.trim()}>应用到整份 PPT</button>
      {currentSlide ? null : <p className="empty">{"\u8fd9\u4e00\u7ec4\u8fd8\u6ca1\u6709\u53c2\u8003\u56fe\u3002"}</p>}
    </aside>
  );
}

function PreviewWorkbench({ currentImage, currentSlide, focusPreview, job, deckRevision, revision, selectedSlide, setDeckRevision, setFocusPreview, setRevision, setSelectedSlide, slides, onQuickAction, onRetryPreview, onRevise, onSaveText, onSlideAction, onRewriteDeck, onUndoJob, previewBusy, templateBusy, themes = [], templatePacks = [], onRerenderTemplate }) {
  const [draft, setDraft] = useState(makeSlideDraft(currentSlide));
  const [insertLayout, setInsertLayout] = useState("section");
  const [draggedSlide, setDraggedSlide] = useState(null);
  const [dropTargetSlide, setDropTargetSlide] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);

  useEffect(() => {
    setDraft(makeSlideDraft(currentSlide));
  }, [currentSlide, selectedSlide]);

  const savedDraft = useMemo(() => makeSlideDraft(currentSlide), [currentSlide]);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(savedDraft), [draft, savedDraft]);
  const liveSlide = useMemo(() => draftToSlide(currentSlide, draft), [currentSlide, draft]);
  const currentTemplate = getCurrentTemplate(job, templatePacks);
  const currentStyle = job?.input?.style || job?.quality?.routePlan?.recommendedTheme || "";
  const templateHit = getTemplateRenderHit(currentTemplate, dirty ? liveSlide : currentSlide);

  useEffect(() => {
    function handleKeydown(event) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && job && dirty) {
        event.preventDefault();
        onSaveText(draft);
      }
    }
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [dirty, draft, job, onSaveText]);

  function updateDraft(name, value) {
    setDraft((current) => ({ ...current, [name]: value }));
  }

  return (
    <div className={`preview-workbench ${focusPreview ? "focus" : ""}`} onClick={() => setContextMenu(null)}>
      <aside className="slide-rail" aria-label="幻灯片列表">
        {job && (
          <div className="rail-insert">
            <select value={insertLayout} onChange={(event) => setInsertLayout(event.target.value)} disabled={dirty}>
              {Object.entries(LAYOUT_LABELS).map(([value, label]) => <option key={value} value={value}>新增：{label} / {value}</option>)}
            </select>
            <button type="button" onClick={() => onSlideAction?.("insert-after", { layout: insertLayout, slideIndex: selectedSlide })} disabled={dirty}>新增页</button>
          </div>
        )}
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
        {contextMenu && (
          <div className="rail-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()}>
            <button type="button" onClick={() => { onSlideAction?.("insert-before", { layout: insertLayout, slideIndex: contextMenu.index }); setContextMenu(null); }}>在前面插入</button>
            <button type="button" onClick={() => { onSlideAction?.("insert-after", { layout: insertLayout, slideIndex: contextMenu.index }); setContextMenu(null); }}>在后面插入</button>
            <button type="button" onClick={() => { onSlideAction?.("duplicate", { slideIndex: contextMenu.index }); setContextMenu(null); }}>复制此页</button>
            <button type="button" className="danger" onClick={() => { onSlideAction?.("delete", { slideIndex: contextMenu.index }); setContextMenu(null); }} disabled={slides.length <= 1}>删除此页</button>
          </div>
        )}
        {!job && <p className="empty">还没有生成任务。</p>}
        <div className="edit-separator" />
        <div className="edit-mode-title">
          <b>整份批量改写</b>
          <span>适合统一口吻、减少全篇文字或强化成交动作。</span>
        </div>
        <div className="quick-actions">
          {DECK_ACTIONS.map((item) => (
            <button
              key={item}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                setDeckRevision(item);
              }}
              disabled={!job || dirty}
            >
              {item}
            </button>
          ))}
        </div>
        <textarea className="compact-textarea" value={deckRevision} onChange={(e) => setDeckRevision(e.target.value)} disabled={!job || dirty} placeholder="例如：整份减少文字，改成客户提案口吻，并强化最后一页下一步动作。" />
        <button className="btn primary wide" onClick={onRewriteDeck} disabled={!job || dirty || !deckRevision.trim()}>应用到整份 PPT</button>
      </aside>

      <div className="preview-stage">
        <div className="stage-toolbar">
          <div>
            <b>{dirty ? liveSlide?.title : currentSlide?.title || "等待生成"}</b>
            <span>
              第 {selectedSlide + 1} 页 · {LAYOUT_LABELS[currentSlide?.layout] || currentSlide?.layout || "自动版式"}
              {(dirty ? liveSlide?.storyRole : currentSlide?.storyRole) ? ` · ${(dirty ? liveSlide?.storyRole : currentSlide?.storyRole)}` : ""}
            </span>
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
          {dirty && currentSlide ? <div className="live-preview-shell"><SlideVisual slide={liveSlide} job={job} slideIndex={selectedSlide} /></div> : currentImage ? <img src={currentImage} alt={`第 ${selectedSlide + 1} 页大图预览`} /> : currentSlide ? <SlideVisual slide={currentSlide} job={job} slideIndex={selectedSlide} /> : <div className="empty-preview">生成后这里显示大图预览</div>}
        </div>
        {job?.previewWarning && (
          <div className="preview-warning">
            <div>
              <b>PNG 预览图未生成，当前使用网页预览</b>
              <span>{job.previewWarning}</span>
            </div>
            <button type="button" onClick={onRetryPreview} disabled={previewBusy}>{previewBusy ? "正在重试" : "重新生成预览图"}</button>
          </div>
        )}
      </div>

      <aside className="editor-panel">
        <div className="edit-mode-title">
          <div>
            <b>直接编辑当前页</b>
            {dirty ? <strong>有未保存修改</strong> : <strong className="saved">已同步</strong>}
          </div>
          <span>保存后会重新生成 PPTX 和预览图。</span>
        </div>
        <Field label="版式">
          <button className="btn ghost wide undo-button" type="button" onClick={onUndoJob} disabled={!job?.canUndo || dirty}>
            {job?.undoLabel || "撤销上一步"}
          </button>
          <div className="page-actions">
            <button type="button" onClick={() => onSlideAction?.("move-up")} disabled={!job || dirty || selectedSlide === 0}>上移</button>
            <button type="button" onClick={() => onSlideAction?.("move-down")} disabled={!job || dirty || selectedSlide >= slides.length - 1}>下移</button>
            <button type="button" onClick={() => onSlideAction?.("insert-after", { layout: insertLayout })} disabled={!job || dirty}>新增</button>
            <button type="button" onClick={() => onSlideAction?.("duplicate")} disabled={!job || dirty}>复制</button>
            <button type="button" className="danger" onClick={() => onSlideAction?.("delete")} disabled={!job || dirty || slides.length <= 1}>删除</button>
          </div>
          <select className="insert-layout-select" value={insertLayout} onChange={(event) => setInsertLayout(event.target.value)} disabled={!job || dirty}>
            {Object.entries(LAYOUT_LABELS).map(([value, label]) => <option key={value} value={value}>新增：{label} / {value}</option>)}
          </select>
          <select value={draft.layout} onChange={(e) => updateDraft("layout", e.target.value)} disabled={!job}>
            {Object.entries(LAYOUT_LABELS).map(([value, label]) => <option key={value} value={value}>{label} / {value}</option>)}
          </select>
        </Field>
        <Field label="标题">
          <input value={draft.title} onChange={(e) => updateDraft("title", e.target.value)} disabled={!job} />
        </Field>
        <Field label="副标题 / 摘要">
          <textarea className="compact-textarea" value={draft.subtitle} onChange={(e) => updateDraft("subtitle", e.target.value)} disabled={!job} />
        </Field>
        <Field label="叙事角色">
          <input value={draft.storyRole} onChange={(e) => updateDraft("storyRole", e.target.value)} disabled={!job} />
        </Field>
        <Field label="内容来源">
          <select value={draft.contentSource} onChange={(e) => updateDraft("contentSource", e.target.value)} disabled={!job}>
            {["用户输入", "用户资料", "用户图片", "系统推断", "待人工确认", "系统推断 + 待人工确认"].map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </Field>
        <Field label="要点（一行一条）">
          <textarea value={draft.bullets} onChange={(e) => updateDraft("bullets", e.target.value)} disabled={!job} />
        </Field>
        <Field label="讲稿备注">
          <textarea className="compact-textarea" value={draft.speakerNotes} onChange={(e) => updateDraft("speakerNotes", e.target.value)} disabled={!job} />
        </Field>
        <Field label="视觉意图">
          <textarea className="compact-textarea" value={draft.visualIntent} onChange={(e) => updateDraft("visualIntent", e.target.value)} disabled={!job} />
        </Field>
        <Field label="价格 / 数据点（一行一条）">
          <textarea className="compact-textarea" value={draft.dataPoints} onChange={(e) => updateDraft("dataPoints", e.target.value)} disabled={!job} />
        </Field>
        <Field label="图片槽 / 素材名（一行一条）">
          <textarea className="compact-textarea" value={draft.imageSlots} onChange={(e) => updateDraft("imageSlots", e.target.value)} disabled={!job} />
        </Field>
        <div className="button-row tight">
          <button className="btn primary" onClick={() => onSaveText(draft)} disabled={!job || !dirty}>保存当前页到 PPT</button>
          <button className="btn ghost" onClick={() => setDraft(savedDraft)} disabled={!job || !dirty}>放弃修改</button>
        </div>
        <p className="save-hint">也可以按 Ctrl+S 保存当前页文字。</p>
        <div className="edit-separator" />
        <div className="edit-mode-title">
          <b>用指令改写</b>
          <span>适合让系统帮你重写表达或调整页结构。</span>
        </div>
        <div className="quick-actions">
          {QUICK_ACTIONS.map((item) => (
            <button
              key={item}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                onQuickAction(item);
              }}
              disabled={!job}
            >
              {item}
            </button>
          ))}
        </div>
        <textarea value={revision} onChange={(e) => setRevision(e.target.value)} placeholder="例如：第 3 页产品矩阵太密，改成两行展示，标题更销售化。" />
        <button className="btn primary wide" onClick={onRevise} disabled={!job || !revision.trim()}>应用到当前页</button>
        <div className="edit-separator" />
        <div className="edit-mode-title">
          <b>整份批量改写</b>
          <span>适合统一口吻、减少全篇文字或强化成交动作。</span>
        </div>
        <div className="quick-actions">
          {DECK_ACTIONS.map((item) => (
            <button
              key={item}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                setDeckRevision(item);
              }}
              disabled={!job || dirty}
            >
              {item}
            </button>
          ))}
        </div>
        <textarea className="compact-textarea" value={deckRevision} onChange={(e) => setDeckRevision(e.target.value)} disabled={!job || dirty} placeholder="例如：整份减少文字，改成客户提案口吻，并强化最后一页下一步动作。" />
        <button className="btn primary wide" onClick={onRewriteDeck} disabled={!job || dirty || !deckRevision.trim()}>应用到整份 PPT</button>
      </aside>
    </div>
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
      <h3>{slide.title || "未命名页面"}</h3>
      {!compact && slide.subtitle ? <p>{slide.subtitle}</p> : null}
      <div className="slide-visual-body">
        {usePricingPreview ? (
          <PricingPreview entries={normalizePreviewPrices(slide)} />
        ) : useProductFacts ? (
          <>
            <div className="slide-visual-bullets">
              {bullets.length ? bullets.map((item, index) => (
                <span key={`${item}-${index}`}>{item}</span>
              )) : <span>{slide.visualIntent || "这一页会根据正文内容自动生成预览。"}</span>}
            </div>
            <ProductFactPreview facts={buildPreviewProductFacts(slide)} />
          </>
        ) : (
          <>
            <div className="slide-visual-bullets">
              {bullets.length ? bullets.map((item, index) => (
                <span key={`${item}-${index}`}>{item}</span>
              )) : <span>{slide.visualIntent || "这一页会根据正文内容自动生成预览。"}</span>}
            </div>
            {visualImage ? (
              <figure className="slide-visual-image">
                <img src={visualImage.uploadUrl} alt={visualImage.originalName || "上传图片素材"} />
                <figcaption>{visualImage.originalName || "上传图片素材"}</figcaption>
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
      <b>单品信息</b>
      {facts.map((fact) => (
        <span key={fact.label}><small>{fact.label}</small><strong>{fact.value}</strong></span>
      ))}
    </div>
  );
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
  const minLayoutVariety = Math.min(5, Math.max(2, Math.ceil(slideCount / 3)));
  return [
    {
      label: "页数",
      value: slideCount ? `${slideCount} 页` : "未生成",
      state: slideCount >= 5 ? "pass" : slideCount > 0 ? "warn" : "fail"
    },
    {
      label: "版式",
      value: `${usedLayouts.length || 0} 种`,
      state: usedLayouts.length >= minLayoutVariety ? "pass" : usedLayouts.length > 0 ? "warn" : "fail"
    },
    {
      label: "路由",
      value: Number.isFinite(routeScore) ? `${Math.round(routeScore * 100)}%` : route.templatePack?.name || "自动",
      state: Number.isFinite(routeScore) && routeScore < 0.75 ? "warn" : "pass"
    },
    {
      label: "图片",
      value: imageCount ? `${imageSlotCount} 槽` : "无图",
      state: imageCount && imageSlotCount === 0 ? "warn" : "pass"
    },
    {
      label: "待确认",
      value: confirmationCount ? `${confirmationCount} 项` : "已清",
      state: confirmationCount ? "warn" : "pass"
    },
    {
      label: "风险",
      value: riskCount ? `${riskCount} 项` : "通过",
      state: riskCount ? "warn" : "pass"
    },
    {
      label: "警告",
      value: warningCount ? `${warningCount} 条` : "通过",
      state: warningCount ? "warn" : "pass"
    }
  ];
}

function buildDeliveryIssues(job = {}) {
  if (!job) return [];
  const quality = job.quality || {};
  const material = quality.material || job.input?.materialBrief || {};
  return [
    ...(quality.risks || []),
    ...(quality.routingWarnings || []),
    ...getBlockingWarnings(job),
    job.warning,
    job.previewWarning,
    job.exportWarning,
    ...(material.confirmationFields?.length ? [`待确认：${material.confirmationFields.join("、")}`] : [])
  ].filter((item) => item && !isNonBlockingWarning(item)).slice(0, 3);
}

function getBlockingWarnings(job = {}) {
  return (job.quality?.warnings || []).filter((item) => !isNonBlockingWarning(item));
}

function isNonBlockingWarning(value = "") {
  const text = String(value || "");
  return /bullet.*(截断|已截断|瓒呰繃).*保护版式|bullet.*淇濇姢鐗堝紡/i.test(text);
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
  const confirmationItems = uniqueList([
    ...(material.confirmationFields || []),
    ...(finalAssessment.hints || [])
  ]);
  return (
    <div className="agent-record">
      <div className="agent-record-header">
        <b>Agent 工作记录</b>
        <span>{decision.hasOldDeck ? "旧 PPT 优化链路" : "新建 PPT 链路"}</span>
      </div>
      <div className="agent-record-grid">
        <RecordBlock title="识别了什么任务" value={decision.intent || "PPT 任务"} detail={`${inputStrengthLabel(decision.inputStrength || material.inputStrength)} · ${decision.targetSlides || route.targetSlides || job?.deck?.slides?.length || 0} 页`} />
        <RecordBlock title="用了哪些资料" value={`${files.length || material.fileCount || 0} 个文件`} detail={`正文 ${material.charCount || 0} 字 · 图片 ${material.imageCount || 0} · 价格 ${material.priceCount || 0}`} />
        <RecordBlock title="为什么这样规划" value={route.deckType || decision.routeType || "自动路由"} detail={routeReasons.slice(0, 2).join("；") || "按资料强弱、模板包和确认大纲规划"} />
        <RecordBlock title="自动修了什么" value={fixes.length ? `已修复 ${fixes.length} 轮` : "未触发自动修复"} detail={fixes[0]?.changes?.slice(0, 2).join("；") || "没有发现阻断级问题"} />
      </div>
      <div className="agent-record-section">
        <b>执行步骤</b>
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
        <b>还需要人工确认</b>
        {confirmationItems.length ? (
          <div className="confirm-chip-list">
            {confirmationItems.slice(0, 8).map((item) => <span key={item}>{item}</span>)}
          </div>
        ) : (
          <p>暂无明确待确认项。生成结果仍建议人工快速通读一遍。</p>
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

function StatusPanel({ job, files, fileIds, status, error, connection, skillRules, onRepairDelivery }) {
  const [showDetails, setShowDetails] = useState(false);
  const warnings = [error, job?.warning, job?.previewWarning, job?.exportWarning].filter(Boolean);
  const ruleGroups = Object.keys(skillRules || {});
  const ruleCount = ruleGroups.reduce((sum, group) => sum + (Array.isArray(skillRules[group]) ? skillRules[group].length : 0), 0);
  const routeSummary = job?.quality?.routePlan || job?.input?.routePlan || null;
  const deliveryChecks = buildDeliveryChecks(job);
  const deliveryIssues = buildDeliveryIssues(job);
  const warnChecks = deliveryChecks.filter((item) => item.state === "warn").length;
  const failChecks = deliveryChecks.filter((item) => item.state === "fail").length;
  const statusTone = failChecks ? "fail" : warnChecks || warnings.length ? "warn" : "pass";
  const routeScore = Number(job?.quality?.routeAdherence?.score);
  return (
    <div className="side-section">
      <h2>任务状态</h2>
      {job && (
        <div className={`status-summary ${statusTone}`}>
          <div>
            <b>{statusTone === "pass" ? "可以交付" : statusTone === "warn" ? "需要确认" : "需要处理"}</b>
            <span>{job.deck?.slides?.length || 0} 页 · 路由 {Number.isFinite(routeScore) ? `${Math.round(routeScore * 100)}%` : "自动"} · {(job.previewImages || []).filter(Boolean).length} 张预览</span>
          </div>
          <button type="button" onClick={() => setShowDetails((value) => !value)}>{showDetails ? "收起详情" : "查看详情"}</button>
        </div>
      )}
      {job?.agentPlan && (
        <div className={`agent-card ${job.agentDecision?.autoRepaired ? "repaired" : "checked"}`}>
          <b>{job.agentPlan.name || "AI PPT Agent"}</b>
          <p>{job.agentDecision?.intent || "PPT 任务"} · {job.agentDecision?.autoRepaired ? "已自动修复 1 轮" : "已完成自检"}</p>
          <div>
            {(job.agentSteps || []).slice(-5).map((step) => (
              <span className={step.status || "done"} key={`${step.id}-${step.at}`}>
                <strong>{step.label}</strong>
                {step.summary || step.status}
              </span>
            ))}
          </div>
          {job.agentDecision?.finalAssessment?.hints?.length ? (
            <small>{job.agentDecision.finalAssessment.hints.join("；")}</small>
          ) : null}
        </div>
      )}
      {job?.agentPlan && (
        <AgentWorkRecord job={job} files={files} />
      )}
      {showDetails && <ul className="status-list">
        <li><b>{fileIds.length}</b><span>已上传文件</span></li>
        <li><b>{job?.deck?.slides?.length || 0}</b><span>已生成页数</span></li>
        <li><b>{job?.aiUsed ? "AI" : "本地"}</b><span>生成模式</span></li>
      </ul>}
      <div className={`health-card ${connection?.state || "checking"}`}>
        <span className={connection?.state === "offline" ? "state-dot error" : connection?.state === "online" ? "state-dot active" : "state-dot checking"} />
        <div>
          <b>{connection?.state === "offline" ? "本地离线" : connection?.state === "online" ? "本地在线" : "正在检查"}</b>
          <p>{connection?.message || "正在检查本地服务..."}</p>
        </div>
      </div>
      {showDetails && connection?.details ? (
        <div className="diagnostic-grid">
          <span><b>版本</b>{connection.details.version || "-"}</span>
          <span><b>PID</b>{connection.details.pid || "-"}</span>
          <span><b>端口</b>{connection.details.port || "-"}</span>
          <span><b>AI</b>{connection.details.hasApiKey ? "已配置" : "未配置"}</span>
          <span className="wide"><b>模型</b>{connection.details.model || "-"}</span>
        </div>
      ) : null}
      {showDetails && routeSummary && (
        <div className="route-card">
          <b>智能路由已启用</b>
          <p>{routeSummary.deckType} / {inputStrengthLabel(routeSummary.inputStrength || job?.quality?.material?.inputStrength)} / {routeSummary.targetSlides} 页 / {routeSummary.recommendedTheme || "自动主题"}</p>
          {routeSummary.templatePack ? <p>模板：{routeSummary.templatePack.name}</p> : null}
          <div>
            <span>{routeSummary.layoutCount || routeSummary.layoutSequence?.length || 0} 页路线</span>
            <span>{routeSummary.hasVisual || routeSummary.imageStrategy?.hasImages ? "含图片页" : "无图片页"}</span>
            <span>{routeSummary.hasPricing || routeSummary.layoutSequence?.some?.((step) => step.layout === "pricing") ? "含价格页" : "无价格页"}</span>
            <span>{routeSummary.hasRiskChecklist || routeSummary.riskStrategy?.includeRiskChecklist ? "含风险清单" : "无风险清单"}</span>
          </div>
        </div>
      )}
      {showDetails && job?.quality?.material?.confirmationFields?.length ? (
        <div className="route-card warning">
          <b>待人工确认</b>
          <p>{job.quality.material.confirmationFields.join("、")}</p>
        </div>
      ) : null}
      {job && deliveryChecks.length > 0 && (
        <div className="delivery-card">
          <b>交付自检</b>
          <p>按结构化 Deck、路由、资料补齐和导出风险自动检查。</p>
          <div>
            {deliveryChecks.map((item) => (
              <span className={item.state} key={item.label}>
                <strong>{item.label}</strong>
                {item.value}
              </span>
            ))}
          </div>
          {deliveryIssues.length ? (
            <ul>
              {deliveryIssues.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}
            </ul>
          ) : null}
          {hasRepairableDeliveryIssues(job) && onRepairDelivery && (
            <button className="btn ghost wide" type="button" onClick={onRepairDelivery}>一键修复交付问题</button>
          )}
        </div>
      )}
      {showDetails && job && (
        <div className={`ai-card ${job.aiUsed ? "ready" : "fallback"}`}>
          <b>{job.aiUsed ? "本次任务使用 AI" : "本次任务使用本地模板"}</b>
          <p>{job.aiProvider?.model || connection?.details?.model || "未记录模型"} · {job.aiProvider?.baseUrl || "未记录接口"}</p>
          {job.aiProvider?.usage ? (
            <div>
              <span>输入 {job.aiProvider.usage.prompt_tokens ?? "-"}</span>
              <span>输出 {job.aiProvider.usage.completion_tokens ?? "-"}</span>
              <span>总计 {job.aiProvider.usage.total_tokens ?? "-"}</span>
            </div>
          ) : null}
        </div>
      )}
      {showDetails && ruleCount > 0 && (
        <div className="skill-card">
          <b>PPT 技能已接入</b>
          <p>{ruleGroups.length} 组规则 / {ruleCount} 条自检项会参与生成、预览和交付检查。</p>
          <div>
            {ruleGroups.map((group) => <span key={group}>{group}</span>)}
          </div>
        </div>
      )}
      {showDetails && files.length > 0 && (
        <div className="mini-files">
          {files.slice(0, 4).map((file) => <span key={file.id}>{file.originalName}</span>)}
        </div>
      )}
      {(status || warnings.length > 0) && (
        <div className={error ? "notice error" : "notice"}>
          <b>{error ? "需要处理" : "提示"}</b>
          <p>{error || warnings[0] || status}</p>
        </div>
      )}
      {showDetails && job?.events?.length > 0 && (
        <details className="event-details">
          <summary>查看任务日志</summary>
          {job.events.slice(-8).map((event, index) => (
            <div className="event-row" key={`${event.createdAt}-${index}`}>
              <b>{event.type}</b>
              <span>{event.message}</span>
            </div>
          ))}
        </details>
      )}
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
      <h2>历史记录</h2>
      <div className="history-tools">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索历史任务" />
        <select value={mode} onChange={(event) => setMode(event.target.value)}>
          <option value="all">全部</option>
          <option value="generate">生成</option>
          <option value="optimize">优化</option>
        </select>
        <button type="button" onClick={() => onDeleteMany(filteredJobs)} disabled={!filteredJobs.length}>清空当前筛选</button>
      </div>
      <div className="history-list">
        {filteredJobs.map((item) => (
          <div className="history-row" key={item.id}>
            <button type="button" onClick={() => onSelect(item)}>
            <b>{item.deck?.title || "未命名 PPT"}</b>
            <span>{new Date(item.createdAt).toLocaleString()} · {item.mode === "optimize" ? "优化旧 PPT" : "生成新 PPT"}</span>
            </button>
            <span className={`history-quality ${jobHealthClass(item)}`}>{jobHealthLabel(item)}</span>
            {jobHealthClass(item) !== "good" && <button className="history-repair" type="button" onClick={() => onRepair(item)}>修复</button>}
            <button className="history-delete" type="button" onClick={() => onDelete(item)}>删除</button>
          </div>
        ))}
        {jobs.length === 0 && <p className="empty">暂无历史任务。</p>}
      </div>
    </div>
  );
}

function ExportPanel({ job }) {
  return (
    <div className="side-section">
      <h2>导出结果</h2>
      <DownloadLinks job={job} compact />
      {!job && <p className="empty">生成后这里显示下载链接。</p>}
    </div>
  );
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
  const groupedStyleReferences = themeOptions.map((theme) => ({
    theme,
    references: styleReferences.filter((item) => (item.themeName || defaultThemeName) === theme.name)
  }));
  const selectedStyleReferences = groupedStyleReferences.find(({ theme }) => theme.name === styleTheme)?.references || [];
  const orphanStyleReferences = styleReferences.filter((item) => item.themeName && !themeOptions.some((theme) => theme.name === item.themeName));
  function update(name, value) {
    onChange((current) => ({ ...current, [name]: value }));
  }
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
    if (group?.name) {
      setStyleTheme(group.name);
      setGroupName("");
      setGroupTone("");
    }
  }

  return (
    <div className="side-section settings-panel">
      <h2>API 设置</h2>
      <div className={`api-state ${config.hasApiKey ? "ready" : "missing"}`}>
        <span className={config.hasApiKey ? "state-dot active" : "state-dot error"} />
        <div>
          <b>{config.hasApiKey ? "AI 已配置" : "未配置 API Key"}</b>
          <p>{config.hasApiKey ? `当前 Key：${config.maskedApiKey || "已保存"}` : "未配置时会使用本地模板生成。"}</p>
        </div>
      </div>
      <Field label="OpenAI API Key">
        <input
          type="password"
          value={config.apiKey || ""}
          onChange={(event) => update("apiKey", event.target.value)}
          placeholder={config.hasApiKey ? "留空则保留已保存的 Key" : "sk-..."}
          autoComplete="off"
        />
      </Field>
      <Field label="Base URL">
        <input value={config.baseUrl || ""} onChange={(event) => update("baseUrl", event.target.value)} placeholder="https://api.openai.com/v1" />
      </Field>
      <Field label="Model">
        <select value={config.model || ""} onChange={(event) => update("model", event.target.value)}>
          {models?.length ? models.map((model) => <option key={model} value={model}>{model}</option>) : <option value={config.model || "gpt-4.1-mini"}>{config.model || "gpt-4.1-mini"}</option>}
        </select>
      </Field>
      <div className="button-row tight">
        <button className="btn primary" type="button" onClick={onSave} disabled={busy}>保存配置</button>
        <button className="btn ghost" type="button" onClick={onTest} disabled={busy}>测试连接</button>
        <button className="btn ghost" type="button" onClick={onDetectModels} disabled={busy}>检测可用模型</button>
      </div>
      {status ? <div className="settings-status">{status}</div> : null}
      <div className="settings-divider" />
      <h2>{"\u81ea\u5b9a\u4e49\u98ce\u683c\u5e93"}</h2>
      <p className="settings-note">{"\u4e94\u4e2a\u5185\u7f6e\u98ce\u683c\u4e0d\u591f\u7528\u65f6\uff0c\u53ef\u4ee5\u65b0\u5efa\u4e00\u4e2a\u4e13\u5c5e\u98ce\u683c\u5e93\uff0c\u518d\u628a\u56fe\u7247\u5f52\u5230\u8fd9\u4e2a\u5e93\u3002"}</p>
      <Field label={"\u98ce\u683c\u5e93\u540d\u79f0"}>
        <input value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder={"\u4f8b\u5982\uff1a\u9ad8\u9971\u548c\u6f6e\u73a9\u5361\u7247\u98ce\u3001\u65b0\u4e2d\u5f0f\u793c\u76d2\u98ce"} />
      </Field>
      <Field label={"\u98ce\u683c\u5e93\u8c03\u6027"}>
        <textarea className="compact-textarea" value={groupTone} onChange={(event) => setGroupTone(event.target.value)} placeholder={"\u4f8b\u5982\uff1a\u9ad8\u9971\u548c\u3001\u5927\u8272\u5757\u3001\u5f3a\u5bf9\u6bd4\uff0c\u9002\u5408\u6f6e\u73a9\u4ea7\u54c1\u53d1\u5e03\u3002"} />
      </Field>
      <button className="btn ghost" type="button" onClick={handleCreateGroup} disabled={busy || !groupName.trim()}>{"\u65b0\u589e\u98ce\u683c\u5e93"}</button>
      {styleGroups.length ? (
        <div className="custom-style-groups">
          {styleGroups.map((group) => <button type="button" key={group.id || group.slug || group.name} onClick={() => setStyleTheme(group.name)}>{group.name}</button>)}
        </div>
      ) : null}
      <div className="settings-divider" />
      <div className="style-theme-picker">
        <Field label={"\u5bf9\u5e94\u98ce\u683c\u5206\u7ec4"}>
          <select value={styleTheme} onChange={(event) => setStyleTheme(event.target.value)}>
            {themeOptions.map((theme) => <option key={theme.slug || theme.name} value={theme.name}>{theme.name}</option>)}
          </select>
        </Field>
      </div>
      <h2>风格参考库</h2>
      <p className="settings-note">上传常用参考图，并写一句调性说明。后续生成 PPT 会参考这里的色彩、留白、质感和画面密度。</p>
      <Field label="参考名称">
        <input value={styleName} onChange={(event) => setStyleName(event.target.value)} placeholder="例如：高端礼盒画册、科技蓝白报告" />
      </Field>
      <Field label="调性说明">
        <textarea className="compact-textarea" value={styleTone} onChange={(event) => setStyleTone(event.target.value)} placeholder="例如：大留白、低饱和、精致包装特写、标题克制但有高级感。" />
      </Field>
      <label className="style-upload">
        <input type="file" accept="image/*" multiple onChange={handleStyleUpload} disabled={busy} />
        <span>添加风格参考图</span>
      </label>
      <div className="style-current-gallery">
        <div className="style-current-gallery-head">
          <b>{"\u5f53\u524d\u5206\u7ec4\u53c2\u8003\u56fe"}</b>
          <span>{selectedStyleReferences.length} {"\u5f20"}</span>
        </div>
        {selectedStyleReferences.length ? (
          <div className="style-thumb-grid">
            {selectedStyleReferences.map((item) => (
              <img key={item.id} src={item.imageUrl} alt={item.name || item.originalName || "\u98ce\u683c\u53c2\u8003"} />
            ))}
          </div>
        ) : <p className="empty">{"\u8fd9\u4e00\u7ec4\u8fd8\u6ca1\u6709\u53c2\u8003\u56fe\u3002"}</p>}
      </div>
      <div className="style-reference-list">
        {groupedStyleReferences.map(({ theme, references }) => (
          <div className={`style-reference-group ${theme.name === styleTheme ? "active" : ""}`} key={theme.slug || theme.name}>
            <button type="button" className="style-reference-group-head" onClick={() => setStyleTheme(theme.name)}>
              <span>{theme.name}</span>
              <small>{references.length} {"\u5f20"}</small>
            </button>
            {references.length ? references.map((item) => (
              <StyleReferenceItem key={item.id} item={item} busy={busy} themeOptions={themeOptions} onUpdate={onUpdateStyleReference} onDelete={onDeleteStyleReference} />
            )) : <p className="empty">{"\u8fd9\u4e00\u7ec4\u8fd8\u6ca1\u6709\u53c2\u8003\u56fe\u3002"}</p>}
          </div>
        ))}
        {orphanStyleReferences.length ? (
          <div className="style-reference-group">
            <div className="style-reference-group-head">
              <span>{"\u672a\u5339\u914d\u5206\u7ec4"}</span>
              <small>{orphanStyleReferences.length} {"\u5f20"}</small>
            </div>
            {orphanStyleReferences.map((item) => <StyleReferenceItem key={item.id} item={item} busy={busy} themeOptions={themeOptions} onUpdate={onUpdateStyleReference} onDelete={onDeleteStyleReference} />)}
          </div>
        ) : null}
        {!styleReferences.length ? <p className="empty">{"\u8fd8\u6ca1\u6709\u98ce\u683c\u53c2\u8003\u56fe\u3002"}</p> : null}
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
      <div>
        <b>{item.name || item.originalName || "\u98ce\u683c\u53c2\u8003"}</b>
        <p>{item.tone || "\u53c2\u8003\u8fd9\u5f20\u56fe\u7684\u8272\u5f69\u3001\u8d28\u611f\u3001\u7559\u767d\u548c\u7248\u5f0f\u8c03\u6027\u3002"}</p>
        <select value={item.themeName || ""} onChange={(event) => moveToTheme(event.target.value)} disabled={busy}>
          {themeOptions.map((theme) => <option key={theme.slug || theme.id || theme.name} value={theme.name}>{theme.name}</option>)}
        </select>
      </div>
      <button type="button" onClick={() => onDelete(item.id)} disabled={busy}>{"\u5220\u9664"}</button>
    </div>
  );
}

function DownloadLinks({ job, compact = false }) {
  if (!job) return null;
  const links = [];
  if (job.exports?.pptx) links.push(["PPTX", job.exports.pptx, job.exportMeta?.pptx?.label]);
  if (job.exports?.pdf) links.push(["PDF", job.exports.pdf, job.exportMeta?.pdf?.label]);
  (job.exports?.png || []).forEach((url, index) => links.push([`PNG ${index + 1}`, url, job.exportMeta?.png?.[index]?.label]));
  if (links.length === 0) return <p className="empty">还没有导出文件。</p>;
  return (
    <div className={compact ? "download-links compact" : "download-links"}>
      {links.map(([label, url, size]) => (
        <a key={`${label}-${url}`} href={url} target="_blank" rel="noreferrer">
          {label}
          {size ? <small>{size}</small> : null}
        </a>
      ))}
    </div>
  );
}

function SectionCard({ title, desc, children, className = "" }) {
  return (
    <section className={`section-card ${className}`.trim()}>
      {(title || desc) && (
        <header>
          {title ? <h2>{title}</h2> : null}
          {desc ? <p>{desc}</p> : null}
        </header>
      )}
      {children}
    </section>
  );
}

function Field({ label, children }) {
  return <div className="field"><label>{label}</label>{children}</div>;
}

function Metric({ label, value }) {
  return <div className="metric"><b>{value}</b><span>{label}</span></div>;
}

function GenerationProgress({ progress }) {
  const value = Math.max(0, Math.min(100, progress?.value || 0));
  return (
    <div className="generation-progress">
      <div>
        <b>{progress?.mode === "optimize" ? "正在优化旧 PPT" : "正在生成 PPT"}</b>
        <span>{progress?.label || "正在处理，请稍候..."}</span>
      </div>
      <strong>{value}%</strong>
      <em><i style={{ width: `${value}%` }} /></em>
    </div>
  );
}

function toggle(list, item) {
  return list.includes(item) ? list.filter((value) => value !== item) : [...list, item];
}

function toBulletList(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  return String(value).split(/[。；;]\s*/).map((item) => item.trim()).filter(Boolean);
}

function normalizePreviewPrices(slide = {}) {
  const data = toBulletList(slide.dataPoints);
  const source = data.length ? data : toBulletList(slide.bullets);
  const tiers = ["入门预算", "主推档位", "升级档位", "补充档位", "定制档位", "预留档位"];
  const entries = source.slice(0, 6).map((item, index) => {
    const text = String(item || "");
    const price = text.match(/[¥￥]?\s*\d+(?:\.\d+)?\s*(?:元|块|RMB)?/i)?.[0]?.replace(/\s+/g, "") || `${index + 1}`;
    const label = text.replace(price, "").replace(/[：:，,。；;\-]/g, " ").trim() || tiers[index] || `第 ${index + 1} 档`;
    return {
      tier: tiers[index] || `第 ${index + 1} 档`,
      price,
      label,
      note: index === 0 ? "基础福利和批量覆盖" : index === source.length - 1 ? "高端客户和形象礼赠" : "主流预算和重点推荐",
      accented: /主推|推荐|升级|高端/.test(text) || index === 1
    };
  });
  return entries.length ? entries : [{ tier: "价格梯度", price: "01", label: slide.title || "待补充报价", note: "补齐报价后自动形成卡片", accented: true }];
}

function buildPreviewProductFacts(slide = {}) {
  const text = [slide.title, slide.subtitle, ...toBulletList(slide.bullets), ...toBulletList(slide.dataPoints)].join(" ");
  const price = text.match(/[¥￥]?\d+(?:\.\d+)?\s*(?:元|块|RMB)?/i)?.[0] || "待确认";
  const spec = text.match(/\d{2,4}\s*[xX×*]\s*\d{2,4}(?:\s*[xX×*]\s*\d{2,4})?\s*(?:mm|cm|毫米|厘米)?/i)?.[0] || "待补齐";
  const scene = toBulletList(slide.bullets).find((item) => /场景|客户|员工|拜访|礼赠|福利/.test(item)) || slide.subtitle || "按客户预算匹配";
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
    contentSource: slide?.contentSource || "用户资料",
    bullets: toBulletList(slide?.bullets).join("\n"),
    speakerNotes: slide?.speakerNotes || "",
    visualIntent: slide?.visualIntent || "",
    dataPoints: toBulletList(slide?.dataPoints).join("\n"),
    imageSlots: toBulletList(slide?.imageSlots).join("\n")
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
    imageSlots: splitDraftLines(draft.imageSlots)
  };
}

function splitDraftLines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getSlideVisualImage(job, slide = {}, slideIndex = 0) {
  const images = (job?.files || []).filter((file) => file.uploadUrl);
  if (!images.length) return null;
  if (images.length === 1) return images[0];
  const slideText = normalizeMatchText([
    slide.title,
    slide.subtitle,
    slide.visualIntent,
    ...toBulletList(slide.bullets),
    ...toBulletList(slide.imageSlots)
  ].join(" "));
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
  if (layout === "cover" && /cover|hero|kv|logo|封面|主图|视觉/.test(name)) return 18;
  if (["visual", "product-detail", "cards"].includes(layout) && /product|pack|box|detail|包装|产品|礼盒|细节/.test(name)) return 16;
  return 0;
}

function normalizeMatchText(value = "") {
  return String(value).toLowerCase().replace(/\s+/g, "").replace(/[^\u4e00-\u9fa5a-z0-9]/g, "");
}

function tokenizeForMatch(value = "") {
  return [...new Set([
    ...(value.match(/[\u4e00-\u9fa5]{2,8}/g) || []),
    ...(value.match(/[a-z0-9]{2,}/g) || [])
  ])].slice(0, 24);
}

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
    if (value < 35) return "正在读取旧稿文本和截图";
    if (value < 62) return "正在重组页面结构";
    if (value < 82) return "正在生成新版 PPTX";
    return "正在刷新预览图";
  }
  if (value < 30) return "正在整理资料和生成路线";
  if (value < 55) return "正在调用 AI 生成内容";
  if (value < 78) return "正在生成 PPTX 文件";
  return "正在刷新预览图";
}

function getStepState({ activeStep, fileIds, job, formats }) {
  return Object.fromEntries(STEPS.map((step) => {
    if (step.id === activeStep) return [step.id, "当前"];
    if (step.id === "materials") return [step.id, fileIds.length ? "完成" : "待处理"];
    if (step.id === "outline") return [step.id, job ? "完成" : "可选"];
    if (step.id === "generate") return [step.id, job ? "完成" : "待处理"];
    if (step.id === "preview") return [step.id, job ? "可编辑" : "待生成"];
    if (step.id === "export") return [step.id, job && formats.length ? "可导出" : "待处理"];
    return [step.id, job?.feedback ? "完成" : "可选"];
  }));
}

function fileExt(name = "") {
  const ext = name.split(".").pop();
  return ext ? ext.slice(0, 4).toUpperCase() : "FILE";
}

function getEffectiveProjectName(form = {}, files = []) {
  if (form.projectName?.trim()) return form.projectName.trim();
  const fromNotes = String(form.notes || "").match(/[\u4e00-\u9fa5A-Za-z0-9][\u4e00-\u9fa5A-Za-z0-9\s-]{3,28}/)?.[0]?.trim();
  if (fromNotes) return fromNotes;
  const fromFile = files[0]?.originalName?.replace(/\.[^.]+$/, "")?.trim();
  return fromFile || "未命名 PPT";
}

function inferMaterialTypes(files = []) {
  const types = new Set();
  for (const file of files) {
    const name = String(file?.originalName || file?.path || "").toLowerCase();
    if (/\.(png|jpe?g|webp|gif|svg)$/.test(name)) types.add("图片素材");
    if (/\.(ppt|pptx)$/.test(name)) types.add("旧 PPT");
    if (/\.(doc|docx|pdf|txt|md)$/.test(name)) types.add("文案资料");
    if (/\.(xls|xlsx|csv)$/.test(name)) types.add("数据表");
    if (/price|报价|价格|moq|周期|交付/.test(name)) types.add("价格 / 交付");
    if (/brand|品牌|手册|规范/.test(name)) types.add("品牌资料");
    if (/竞品|compare|对比/.test(name)) types.add("竞品资料");
    if (/产品|包装|礼盒|规格|参数|sku/.test(name)) types.add("产品资料");
  }
  return [...types];
}

function formatBytes(value) {
  if (!value) return "未知大小";
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function inputStrengthLabel(value) {
  if (value === "strong") return "强资料";
  if (value === "weak") return "弱资料";
  if (value === "empty") return "零资料";
  return "资料强度自动";
}

function uniqueList(items = []) {
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))];
}

function getOutlineSourceMeta(step = {}) {
  const type = step.sourceType || (step.kind === "source" ? "original-ppt" : "");
  if (type === "original-ppt") {
    return { label: step.sourceLabel || "来自原 PPT", tone: "source-original", evidence: step.evidence || "" };
  }
  if (type === "extracted") {
    return { label: step.sourceLabel || "来自资料提取", tone: "source-extracted", evidence: step.evidence || "" };
  }
  if (type === "needs-confirmation" || step.needsConfirmation) {
    return { label: step.sourceLabel || "待人工确认", tone: "source-confirm", evidence: step.evidence || "" };
  }
  if (["prices", "products", "productDetail", "visual", "compare", "bundle"].includes(step.kind)) {
    return { label: "来自资料提取", tone: "source-extracted", evidence: step.evidence || "" };
  }
  if (["risks", "assumptions"].includes(step.kind)) {
    return { label: "待人工确认", tone: "source-confirm", evidence: step.evidence || "" };
  }
  return { label: step.sourceLabel || "AI 推断", tone: "source-inferred", evidence: step.evidence || "" };
}

function formatDuration(seconds = 0) {
  const value = Math.max(0, Number(seconds) || 0);
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.floor(value / 60)}m`;
  return `${Math.floor(value / 3600)}h ${Math.floor((value % 3600) / 60)}m`;
}

function isMojibake(value = "") {
  return /[�]|绔|鍞|杞|涓滄|ç|Ã|閿|鐢|璧/.test(String(value));
}

function findTemplatePack(packs = [], theme = {}) {
  return packs.find((pack) => pack.themeName === theme.name || pack.themeSlug === theme.slug);
}

function makeOutlineStep(layout = "section") {
  const map = {
    cover: ["新增封面", "说明项目名称、受众和核心主张。", "开场定位"],
    visual: ["新增视觉页", "承接图片、包装、截图或产品主视觉。", "视觉证据"],
    section: ["新增章节", "承接上一部分，说明本章节结论。", "章节承接"],
    toc: ["新增目录", "说明整份 PPT 的阅读路径。", "阅读路径"],
    kpi: ["新增关键指标", "用指标卡展示关键数据、口径和结论。", "关键证据"],
    pricing: ["新增价格页", "说明价格梯度、主推档位和适用预算。", "预算决策"],
    "product-detail": ["新增产品详情", "说明规格、卖点、场景和待确认信息。", "方案证据"],
    bundle: ["新增组合推荐", "给出入门、主推、升级三档组合。", "推荐方案"],
    "risk-checklist": ["新增风险清单", "列出价格、规格、交期、素材授权等待确认项。", "风险控制"],
    compare: ["新增对比页", "比较方案、档位、前后状态或能力差异。", "差异证明"],
    timeline: ["新增时间线", "说明阶段、节奏、交付或验证步骤。", "落地路径"],
    cards: ["新增卡片页", "拆分 3-5 个卖点、场景或判断。", "卖点证明"],
    quote: ["新增观点页", "沉淀一句可直接复述的核心表达。", "表达锚点"],
    closing: ["新增收尾页", "明确下一步行动、确认事项和交付动作。", "下一步行动"]
  };
  const [title, purpose, storyRole] = map[layout] || map.section;
  return { layout, title, purpose, storyRole, kind: layout, imageSlots: [] };
}

const TEMPLATE_RENDER_LAYOUTS = {
  "sales-proposal": ["cover", "pricing", "cards", "quote", "risk-checklist", "closing"],
  "seasonal-gift": ["cover", "visual", "pricing", "product-detail", "bundle", "closing"],
  "brand-editorial": ["cover", "visual", "quote", "cards", "product-detail", "closing"],
  "tech-solution": ["cover", "toc", "kpi", "compare", "timeline", "closing"],
  "launch-dark": ["cover", "section", "kpi", "visual", "timeline", "quote", "closing"]
};

function getCurrentTemplate(job = {}, packs = []) {
  const routePack = job?.quality?.routePlan?.templatePack || job?.input?.routePlan?.templatePack;
  return packs.find((pack) => pack.slug === routePack?.slug || pack.themeName === job?.input?.style || pack.name === routePack?.name) || routePack || null;
}

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
  const text = [
    deck.title,
    deck.summary,
    firstSlide.title,
    firstSlide.subtitle,
    ...(firstSlide.bullets || []),
    job.input?.projectName,
    job.input?.notes
  ].filter(Boolean).join(" ");
  if (!text.trim()) return false;
  const questionMarks = (text.match(/\?/g) || []).length;
  const signalChars = text.replace(/[?\s\d.,，。/\\|:：;；()[\]{}·\-_*]/g, "").length;
  if (questionMarks >= 6 && questionMarks > signalChars * 0.25) return false;
  if (/AI 返回不是 JSON|<!doctype|not valid JSON/i.test(job.warning || "")) return false;
  return true;
}

function isPreferredStartupJob(job = {}) {
  if (!isRestorableJob(job)) return false;
  const slideCount = job.deck?.slides?.length || 0;
  const previewCount = (job.previewImages || []).filter(Boolean).length;
  const routeScore = Number(job.quality?.routeAdherence?.score ?? 1);
  const warningCount = Number(job.quality?.warningCount || job.quality?.warnings?.length || 0);
  if (!slideCount || previewCount < slideCount) return false;
  if (warningCount > 12 && routeScore < 0.5) return false;
  return true;
}

function jobHealthClass(job = {}) {
  const score = Number(job.quality?.routeAdherence?.score ?? 1);
  const slideCount = job.deck?.slides?.length || 0;
  const previewCount = (job.previewImages || []).filter(Boolean).length;
  const blockingWarnings = getBlockingWarnings(job).length;
  if (!slideCount || previewCount < slideCount || score < 0.5) return "bad";
  if (blockingWarnings || score < 0.85) return "warn";
  return "good";
}

function jobHealthLabel(job = {}) {
  const cls = jobHealthClass(job);
  const slideCount = job.deck?.slides?.length || 0;
  const previewCount = (job.previewImages || []).filter(Boolean).length;
  const score = Number(job.quality?.routeAdherence?.score ?? 1);
  if (cls === "bad") return `需修复 · ${slideCount}页 · 路由${Math.round(score * 100)}% · 预览${previewCount}`;
  if (cls === "warn") return `可检查 · ${slideCount}页 · 路由${Math.round(score * 100)}%`;
  return `可继续 · ${slideCount}页`;
}

createRoot(document.getElementById("root")).render(<App />);
