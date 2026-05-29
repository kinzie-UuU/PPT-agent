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

const MATERIAL_OPTIONS = [
  "产品图 / 包装图",
  "产品参数 / 规格",
  "价格 / MOQ / 周期",
  "品牌手册",
  "竞品截图",
  "旧 PPT",
  "Word / PDF 文案",
  "Excel 数据表"
];

const QUICK_ACTIONS = ["标题更销售化", "改成价格梯度页", "讲稿更口语", "减少文字更高级", "强化下一步动作"];
const DECK_ACTIONS = ["整份减少文字更高级", "改成客户提案口吻", "强化销售话术和下一步行动", "改成技术数据汇报风格"];

const STEPS = [
  { id: "materials", number: "01", title: "资料", desc: "上传与补充需求" },
  { id: "generate", number: "02", title: "生成", desc: "选择生成方式" },
  { id: "preview", number: "03", title: "预览编辑", desc: "看稿并改单页" },
  { id: "export", number: "04", title: "导出", desc: "输出文件" },
  { id: "feedback", number: "05", title: "反馈", desc: "评分与留言" }
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
    audience: "销售团队 / 内部使用",
    pageCount: "系统推荐",
    notes: "做一份端午礼盒产品战卡，给销售团队内部使用；节日氛围高级耐看，不要太花；需要讲清卖点、价格逻辑和推荐话术。",
    style: "轻盈渐变风",
    copyMode: "先确认每页文案，再排版",
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
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [rating, setRating] = useState(4);
  const [comment, setComment] = useState("");
  const [materials, setMaterials] = useState(MATERIAL_OPTIONS.slice(0, 3));
  const [activeStep, setActiveStep] = useState("materials");
  const [rightPanelMode, setRightPanelMode] = useState("status");
  const [focusPreview, setFocusPreview] = useState(false);
  const [connection, setConnection] = useState({ state: "checking", message: "正在检查本地服务..." });
  const [previewBusy, setPreviewBusy] = useState(false);
  const [templateBusy, setTemplateBusy] = useState(false);
  const [apiConfig, setApiConfig] = useState({ apiKey: "", maskedApiKey: "", hasApiKey: false, baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" });
  const [availableModels, setAvailableModels] = useState([]);
  const [settingsStatus, setSettingsStatus] = useState("");
  const [settingsBusy, setSettingsBusy] = useState(false);

  useEffect(() => {
    api.jobs().then((data) => {
      const nextJobs = data.jobs || [];
      setJobs(nextJobs);
      const restorableJob = nextJobs.find(isRestorableJob) || nextJobs[0];
      if (restorableJob) {
        setJob(restorableJob);
        setFiles(restorableJob.files || []);
        setFileIds((restorableJob.files || []).map((file) => file.id).filter(Boolean));
        setSelectedSlide(0);
        setActiveStep("preview");
        setStatus(restorableJob === nextJobs[0] ? "已自动恢复最近一次任务。" : "最近一次任务内容异常，已自动恢复上一份正常任务。");
      }
    }).catch(() => {});
    api.designSystem().then((data) => {
      const nextThemes = data.themes || [];
      if (nextThemes.length && !nextThemes.some((theme) => isMojibake(theme.name || theme.bestFor))) setThemes(nextThemes);
      const nextPacks = data.templatePacks || [];
      if (nextPacks.length && !nextPacks.some((pack) => isMojibake(pack.name || pack.scenario))) setTemplatePacks(nextPacks);
      setSkillRules(data.skillRules || {});
    }).catch(() => {});
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
  const selectedFileNames = useMemo(() => files.map((file) => file.originalName).join("、"), [files]);
  const completion = useMemo(() => getCompletion({ form, fileIds, job }), [form, fileIds, job]);
  const stepState = useMemo(() => getStepState({ activeStep, fileIds, job, formats }), [activeStep, fileIds, job, formats]);

  const topbarStateClass = error || connection.state === "offline" ? "state-dot error" : connection.state === "online" ? "state-dot active" : "state-dot checking";
  const topbarMessage = error || status || connection.message || "准备就绪";

  function update(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
  }

  async function uploadFiles(event) {
    setError("");
    setStatus("正在上传资料...");
    try {
      const data = await api.upload(event.target.files);
      setFiles((current) => [...current, ...(data.files || [])]);
      setFileIds((current) => [...current, ...(data.files || []).map((file) => file.id)]);
      setStatus("资料已上传，可以继续补充需求或开始生成。");
      setRightPanelMode("status");
    } catch (err) {
      setError(getErrorMessage(err));
      setStatus("");
    } finally {
      event.target.value = "";
    }
  }

  async function createJob(mode, confirmedOutline = null) {
    setError("");
    setStatus(mode === "optimize" ? "正在解析旧 PPT 并生成新版..." : "正在生成新 PPT...");
    try {
      const data = await api.create(mode === "optimize" ? "/api/jobs/optimize" : "/api/jobs/generate", {
        ...form,
        fileIds,
        materials,
        outlinePlan: confirmedOutline,
        mode
      });
      setJob(data);
      setSelectedSlide(0);
      setActiveStep("preview");
      setRightPanelMode("status");
      setJobs((current) => [data, ...current.filter((item) => item.id !== data.id)]);
      setStatus(data.warning || "任务已完成，可以预览和导出。");
    } catch (err) {
      setError(getErrorMessage(err));
      setStatus("");
    }
  }

  async function planOutline() {
    setError("");
    setOutlineBusy(true);
    setStatus("正在生成可确认大纲...");
    try {
      const data = await api.create("/api/jobs/outline", {
        ...form,
        fileIds,
        materials,
        mode: "generate"
      });
      setOutlinePlan(data.outlinePlan || null);
      setOutlineBrief(data.materialBrief || null);
      setStatus("大纲已生成，可以调整后按确认大纲生成。");
      setRightPanelMode("status");
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
    if (!job || selectedSlide < 0) return;
    setError("");
    setStatus("正在调整页面结构...");
    try {
      const data = await api.create(`/api/jobs/${job.id}/slides/${selectedSlide}/action`, { action, ...payload });
      setJob(data);
      setSelectedSlide(Number.isFinite(data.selectedSlide) ? data.selectedSlide : selectedSlide);
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
      setRightPanelMode("exports");
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

  function selectJob(item) {
    setJob(item);
    setFiles(item.files || []);
    setFileIds((item.files || []).map((file) => file.id).filter(Boolean));
    setSelectedSlide(0);
    setActiveStep("preview");
    setRightPanelMode("status");
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
      setRightPanelMode("status");
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

  return (
    <div className="workspace-shell">
      <header className="topbar">
        <div>
          <span className="brand">PPT Design OS</span>
          <b>{form.projectName || job?.deck?.title || "未命名项目"}</b>
        </div>
        <div className="topbar-status">
          <span className={topbarStateClass} />
          <span>{topbarMessage}</span>
          <button className="icon-button" type="button" onClick={() => setRightPanelMode("settings")}>设置</button>
        </div>
      </header>

      <div className="workspace-grid">
        <aside className="sidebar">
          <nav className="step-nav" aria-label="使用流程">
            {STEPS.map((step) => (
              <button className={activeStep === step.id ? "active" : ""} key={step.id} onClick={() => setActiveStep(step.id)}>
                <span>{step.number}</span>
                <b>{step.title}</b>
                <small>{stepState[step.id]}</small>
              </button>
            ))}
          </nav>
        </aside>

        <main className="main-stage">
          <section className="stage-heading">
            <div>
              <p>当前步骤</p>
              <h1>{STEPS.find((step) => step.id === activeStep)?.title}</h1>
            </div>
            <div className="progress-strip" aria-label="准备进度">
              <span style={{ width: `${completion}%` }} />
            </div>
          </section>

          {activeStep === "materials" && (
            <SectionCard title="一键生成 PPT" desc="填一句需求，上传资料，系统会自动判断页数、版式路线和叙事结构。">
              <div className="form-grid">
                <Field label="项目 / 产品名称"><input value={form.projectName} onChange={(e) => update("projectName", e.target.value)} placeholder="例如：2026 端午礼盒销售战卡" /></Field>
                <Field label="使用对象">
                  <select value={form.audience} onChange={(e) => update("audience", e.target.value)}>
                    {["销售团队 / 内部使用", "客户提案", "管理层汇报", "自己使用"].map((item) => <option key={item}>{item}</option>)}
                  </select>
                </Field>
                <Field label="页数">
                  <select value={form.pageCount} onChange={(e) => update("pageCount", e.target.value)}>
                    {["系统推荐", "8 页轻量版", "12 页标准版", "19 页完整战卡"].map((item) => <option key={item}>{item}</option>)}
                  </select>
                </Field>
              </div>

              <div className="material-picker">
                {MATERIAL_OPTIONS.map((item) => (
                  <label className="check-pill" key={item}>
                    <input type="checkbox" checked={materials.includes(item)} onChange={() => setMaterials((current) => toggle(current, item))} />
                    <span>{item}</span>
                  </label>
                ))}
              </div>

              <label className="dropzone">
                <input type="file" multiple onChange={uploadFiles} />
                <b>拖拽或点击上传资料</b>
                <span>{selectedFileNames || "支持 PPTX / DOCX / XLSX / PDF / 图片 / SVG"}</span>
              </label>

              {files.length > 0 && (
                <div className="file-list">
                  {files.map((file) => (
                    <div className="file-row" key={file.id}>
                      {file.uploadUrl ? <img src={file.uploadUrl} alt={file.originalName} /> : <span className="file-icon">{fileExt(file.originalName)}</span>}
                      <div>
                        <b>{file.originalName}</b>
                        <small>{formatBytes(file.size)}</small>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <Field label="一句话需求 / 补充说明">
                <textarea value={form.notes} onChange={(e) => update("notes", e.target.value)} />
              </Field>

              <div className="one-click-panel">
                <div>
                  <b>准备好后直接生成</b>
                  <span>{fileIds.length ? `已上传 ${fileIds.length} 个文件，系统会自动提取资料。` : "没有上传资料时，会根据一句话需求生成可编辑初稿。"}</span>
                </div>
                <button className="primary-action compact" onClick={() => createJob("generate")}>
                  <b>一键生成 PPT</b>
                  <span>自动生成 Deck、PPTX 和预览图</span>
                </button>
              </div>

              <details className="advanced-options">
                <summary>高级生成设置</summary>
                <div className="theme-row">
                  {themes.map((theme) => {
                    const pack = findTemplatePack(templatePacks, theme);
                    return (
                    <button className={`theme-card ${form.style === theme.name ? "active" : ""}`} key={theme.name} onClick={() => update("style", theme.name)}>
                      <span style={{ "--theme-bg": `#${theme.colors.bg}`, "--theme-soft": `#${theme.colors.soft}`, "--theme-accent": `#${theme.colors.accent}` }} />
                      <b>{pack?.name || theme.name}</b>
                      <small>{pack?.scenario || theme.bestFor}</small>
                      {pack?.coreLayouts?.length ? <em>{pack.coreLayouts.slice(0, 4).map((item) => LAYOUT_LABELS[item] || item).join(" / ")}</em> : null}
                    </button>
                  );})}
                </div>
                <div className="orchestration-grid">
                  <Field label="主推产品">
                    <input value={form.primaryProduct} onChange={(e) => update("primaryProduct", e.target.value)} placeholder="例如：福禄粽享礼盒；留空则自动判断" />
                  </Field>
                  <label className="check">
                    <input type="checkbox" checked={form.includeToc} onChange={() => update("includeToc", !form.includeToc)} />
                    包含目录页
                  </label>
                  <label className="check">
                    <input type="checkbox" checked={form.includeRiskChecklist} onChange={() => update("includeRiskChecklist", !form.includeRiskChecklist)} />
                    包含风险清单
                  </label>
                </div>
              </details>
            </SectionCard>
          )}

          {activeStep === "generate" && (
            <SectionCard title="生成方式" desc="只保留两个主动作，避免在生成前做太多无效选择。">
              <div className="readiness">
                <Metric label="资料文件" value={fileIds.length} />
                <Metric label="已选资料类型" value={materials.length} />
                <Metric label="需求完整度" value={`${completion}%`} />
              </div>
              <div className="action-grid">
                <button className="primary-action" onClick={() => createJob("generate")}>
                  <b>一键生成 PPT</b>
                  <span>使用当前资料、需求和高级设置生成完整新稿。</span>
                </button>
                <button className="primary-action secondary" onClick={() => createJob("optimize")}>
                  <b>优化旧 PPT</b>
                  <span>读取旧稿文本和截图，重生成可编辑新版。</span>
                </button>
              </div>
              <div className="outline-panel">
                <div>
                  <b>先确认大纲</b>
                  <span>{outlineBrief ? `${inputStrengthLabel(outlineBrief.inputStrength)} / 产品 ${outlineBrief.productCount || 0} / 价格 ${outlineBrief.priceCount || 0} / 图片 ${outlineBrief.imageCount || 0}` : "先生成页序、版式、标题和每页用途，再确认生成。"}</span>
                </div>
                <div className="button-row tight">
                  <button className="btn ghost" type="button" onClick={planOutline} disabled={outlineBusy}>{outlineBusy ? "正在生成大纲" : "生成可确认大纲"}</button>
                  <button className="btn primary" type="button" onClick={() => createJob("generate", outlinePlan)} disabled={!outlinePlan?.layoutSequence?.length}>按已确认大纲生成</button>
                </div>
                {outlinePlan?.layoutSequence?.length ? (
                  <div className="outline-list">
                    <div className="outline-insert-bar">
                      <select value={outlineInsertLayout} onChange={(event) => setOutlineInsertLayout(event.target.value)}>
                        {Object.entries(LAYOUT_LABELS).map(([value, label]) => <option key={value} value={value}>新增版式：{label} / {value}</option>)}
                      </select>
                      <button className="btn ghost" type="button" onClick={appendOutlineStep}>追加到末尾</button>
                    </div>
                    {outlinePlan.layoutSequence.map((step, index) => (
                      <div className="outline-row" key={`${step.layout}-${index}`}>
                        <span>{String(index + 1).padStart(2, "0")}</span>
                        <select value={step.layout || "section"} onChange={(event) => updateOutlineStep(index, "layout", event.target.value)}>
                          {Object.entries(LAYOUT_LABELS).map(([value, label]) => <option key={value} value={value}>{label} / {value}</option>)}
                        </select>
                        <input value={step.title || ""} onChange={(event) => updateOutlineStep(index, "title", event.target.value)} />
                        <input value={step.purpose || ""} onChange={(event) => updateOutlineStep(index, "purpose", event.target.value)} />
                        <div className="outline-actions">
                          <button type="button" onClick={() => outlineAction(index, "move-up")} disabled={index === 0}>↑</button>
                          <button type="button" onClick={() => outlineAction(index, "move-down")} disabled={index === outlinePlan.layoutSequence.length - 1}>↓</button>
                          <button type="button" onClick={() => outlineAction(index, "insert-after")}>+</button>
                          <button type="button" onClick={() => outlineAction(index, "duplicate")}>⧉</button>
                          <button type="button" onClick={() => outlineAction(index, "delete")} disabled={outlinePlan.layoutSequence.length <= 1}>×</button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="theme-row">
                {themes.map((theme) => {
                  const pack = findTemplatePack(templatePacks, theme);
                  return (
                  <button className={`theme-card ${form.style === theme.name ? "active" : ""}`} key={theme.name} onClick={() => update("style", theme.name)}>
                    <span style={{ "--theme-bg": `#${theme.colors.bg}`, "--theme-soft": `#${theme.colors.soft}`, "--theme-accent": `#${theme.colors.accent}` }} />
                    <b>{pack?.name || theme.name}</b>
                    <small>{pack?.scenario || theme.bestFor}</small>
                    {pack?.coreLayouts?.length ? <em>{pack.coreLayouts.slice(0, 4).map((item) => LAYOUT_LABELS[item] || item).join(" / ")}</em> : null}
                  </button>
                );})}
              </div>
              <div className="orchestration-grid">
                <Field label="主推产品">
                  <input value={form.primaryProduct} onChange={(e) => update("primaryProduct", e.target.value)} placeholder="例如：福禄粽享礼盒；留空则自动判断" />
                </Field>
                <label className="check">
                  <input type="checkbox" checked={form.includeToc} onChange={() => update("includeToc", !form.includeToc)} />
                  包含目录页
                </label>
                <label className="check">
                  <input type="checkbox" checked={form.includeRiskChecklist} onChange={() => update("includeRiskChecklist", !form.includeRiskChecklist)} />
                  包含风险清单
                </label>
              </div>
            </SectionCard>
          )}

          {activeStep === "preview" && (
            <SectionCard title="预览与单页编辑" desc="左侧选页，中间看稿，右侧修改当前页。">
              <PreviewWorkbench
                currentImage={currentImage}
                currentSlide={currentSlide}
                focusPreview={focusPreview}
                job={job}
                deckRevision={deckRevision}
                revision={revision}
                selectedSlide={selectedSlide}
                setDeckRevision={setDeckRevision}
                setFocusPreview={setFocusPreview}
                setRevision={setRevision}
                setSelectedSlide={setSelectedSlide}
                slides={slides}
                onQuickAction={appendQuickAction}
                onRetryPreview={retryPreview}
                onRevise={revise}
                onSaveText={saveSlideText}
                onSlideAction={slideAction}
                onRewriteDeck={rewriteDeck}
                onUndoJob={undoJob}
                previewBusy={previewBusy}
                templateBusy={templateBusy}
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

        <aside className="right-panel">
          <div className="panel-tabs">
            {[
              ["status", "状态"],
              ["history", "历史"],
              ["exports", "导出"],
              ["settings", "设置"]
            ].map(([id, label]) => (
              <button className={rightPanelMode === id ? "active" : ""} key={id} onClick={() => setRightPanelMode(id)}>{label}</button>
            ))}
          </div>
          {rightPanelMode === "status" && <StatusPanel job={job} files={files} fileIds={fileIds} status={status} error={error} connection={connection} skillRules={skillRules} />}
          {rightPanelMode === "history" && <HistoryPanel jobs={jobs} onSelect={selectJob} />}
          {rightPanelMode === "exports" && <ExportPanel job={job} />}
          {rightPanelMode === "settings" && (
            <SettingsPanel
              config={apiConfig}
              busy={settingsBusy}
              status={settingsStatus}
              models={availableModels}
              onChange={setApiConfig}
              onSave={saveApiConfig}
              onTest={testApiConfig}
              onDetectModels={detectModels}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

function PreviewWorkbench({ currentImage, currentSlide, focusPreview, job, deckRevision, revision, selectedSlide, setDeckRevision, setFocusPreview, setRevision, setSelectedSlide, slides, onQuickAction, onRetryPreview, onRevise, onSaveText, onSlideAction, onRewriteDeck, onUndoJob, previewBusy, templateBusy, themes = [], templatePacks = [], onRerenderTemplate }) {
  const [draft, setDraft] = useState(makeSlideDraft(currentSlide));
  const [insertLayout, setInsertLayout] = useState("section");

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
    <div className={`preview-workbench ${focusPreview ? "focus" : ""}`}>
      <aside className="slide-rail" aria-label="幻灯片列表">
        {slides.map((slide, index) => (
          <button className={`rail-card ${selectedSlide === index ? "active" : ""}`} key={index} onClick={() => setSelectedSlide(index)}>
            {selectedSlide === index && dirty ? <SlideVisual slide={liveSlide} job={job} slideIndex={index} compact /> : job.previewImages?.[index] ? <img src={job.previewImages[index]} alt={`第 ${index + 1} 页`} /> : <SlideVisual slide={slide} job={job} slideIndex={index} compact />}
            <span>{String(index + 1).padStart(2, "0")}</span>
            <b>{selectedSlide === index && dirty ? liveSlide.title : slide.title}</b>
          </button>
        ))}
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
  const warningCount = (quality.warningCount || 0) + (job.previewWarning ? 1 : 0) + (job.exportWarning ? 1 : 0) + (job.warning ? 1 : 0);
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

function StatusPanel({ job, files, fileIds, status, error, connection, skillRules }) {
  const warnings = [error, job?.warning, job?.previewWarning, job?.exportWarning].filter(Boolean);
  const ruleGroups = Object.keys(skillRules || {});
  const ruleCount = ruleGroups.reduce((sum, group) => sum + (Array.isArray(skillRules[group]) ? skillRules[group].length : 0), 0);
  const routeSummary = job?.quality?.routePlan || job?.input?.routePlan || null;
  const deliveryChecks = buildDeliveryChecks(job);
  return (
    <div className="side-section">
      <h2>任务状态</h2>
      <ul className="status-list">
        <li><b>{fileIds.length}</b><span>已上传文件</span></li>
        <li><b>{job?.deck?.slides?.length || 0}</b><span>已生成页数</span></li>
        <li><b>{job?.aiUsed ? "AI" : "本地"}</b><span>生成模式</span></li>
      </ul>
      <div className={`health-card ${connection?.state || "checking"}`}>
        <span className={connection?.state === "offline" ? "state-dot error" : connection?.state === "online" ? "state-dot active" : "state-dot checking"} />
        <div>
          <b>{connection?.state === "offline" ? "本地离线" : connection?.state === "online" ? "本地在线" : "正在检查"}</b>
          <p>{connection?.message || "正在检查本地服务..."}</p>
        </div>
      </div>
      {connection?.details ? (
        <div className="diagnostic-grid">
          <span><b>版本</b>{connection.details.version || "-"}</span>
          <span><b>PID</b>{connection.details.pid || "-"}</span>
          <span><b>端口</b>{connection.details.port || "-"}</span>
          <span><b>AI</b>{connection.details.hasApiKey ? "已配置" : "未配置"}</span>
          <span className="wide"><b>模型</b>{connection.details.model || "-"}</span>
        </div>
      ) : null}
      {routeSummary && (
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
      {job?.quality?.material?.confirmationFields?.length ? (
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
        </div>
      )}
      {job && (
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
      {ruleCount > 0 && (
        <div className="skill-card">
          <b>PPT 技能已接入</b>
          <p>{ruleGroups.length} 组规则 / {ruleCount} 条自检项会参与生成、预览和交付检查。</p>
          <div>
            {ruleGroups.map((group) => <span key={group}>{group}</span>)}
          </div>
        </div>
      )}
      {files.length > 0 && (
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
      {job?.events?.length > 0 && (
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

function HistoryPanel({ jobs, onSelect }) {
  return (
    <div className="side-section">
      <h2>历史记录</h2>
      <div className="history-list">
        {jobs.slice(0, 8).map((item) => (
          <button key={item.id} onClick={() => onSelect(item)}>
            <b>{item.deck?.title || "未命名 PPT"}</b>
            <span>{new Date(item.createdAt).toLocaleString()} · {item.mode === "optimize" ? "优化旧 PPT" : "生成新 PPT"}</span>
          </button>
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

function SettingsPanel({ config, busy, status, models, onChange, onSave, onTest, onDetectModels }) {
  function update(name, value) {
    onChange((current) => ({ ...current, [name]: value }));
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

function SectionCard({ title, desc, children }) {
  return (
    <section className="section-card">
      <header>
        <h2>{title}</h2>
        <p>{desc}</p>
      </header>
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

function getStepState({ activeStep, fileIds, job, formats }) {
  return Object.fromEntries(STEPS.map((step) => {
    if (step.id === activeStep) return [step.id, "当前"];
    if (step.id === "materials") return [step.id, fileIds.length ? "完成" : "待处理"];
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

createRoot(document.getElementById("root")).render(<App />);
