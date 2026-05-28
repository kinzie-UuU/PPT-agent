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
  async designSystem() {
    const response = await fetch("/api/design-system");
    return readJson(response);
  },
  async health(signal) {
    const response = await fetch("/api/health", { cache: "no-store", signal });
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
  const [formats, setFormats] = useState(["pptx", "pdf", "png"]);
  const [themes, setThemes] = useState(FALLBACK_THEMES);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [rating, setRating] = useState(4);
  const [comment, setComment] = useState("");
  const [materials, setMaterials] = useState(MATERIAL_OPTIONS.slice(0, 3));
  const [activeStep, setActiveStep] = useState("materials");
  const [rightPanelMode, setRightPanelMode] = useState("status");
  const [focusPreview, setFocusPreview] = useState(false);
  const [connection, setConnection] = useState({ state: "checking", message: "正在检查本地服务..." });

  useEffect(() => {
    api.jobs().then((data) => setJobs(data.jobs || [])).catch(() => {});
    api.designSystem().then((data) => {
      const nextThemes = data.themes || [];
      if (nextThemes.length && !nextThemes.some((theme) => isMojibake(theme.name || theme.bestFor))) setThemes(nextThemes);
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
          message: data.uptime ? `本地在线 ${formatDuration(data.uptime)}` : "本地在线"
        });
        setError((current) => (isConnectionError(current) ? "" : current));
      } catch {
        if (!active) return;
        setConnection({ state: "offline", message: "本地服务离线，请重新启动后刷新" });
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

  async function createJob(mode) {
    setError("");
    setStatus(mode === "optimize" ? "正在解析旧 PPT 并生成新版..." : "正在生成新 PPT...");
    try {
      const data = await api.create(mode === "optimize" ? "/api/jobs/optimize" : "/api/jobs/generate", {
        ...form,
        fileIds,
        materials,
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

  async function saveSlideText(slideDraft) {
    if (!job || !currentSlide) return;
    setError("");
    setStatus("正在保存当前页文字...");
    try {
      const data = await api.create(`/api/jobs/${job.id}/slides/${selectedSlide}/update`, { slide: slideDraft });
      setJob(data);
      setStatus("当前页文字已保存，PPT 和预览已刷新。");
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

  function selectJob(item) {
    setJob(item);
    setSelectedSlide(0);
    setActiveStep("preview");
    setRightPanelMode("status");
  }

  function appendQuickAction(text) {
    setRevision((current) => current ? `${current}；${text}` : text);
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
          <button className="icon-button" type="button" onClick={() => setRightPanelMode("status")}>设置</button>
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
            <SectionCard title="资料与需求" desc="先把输入收齐，后续生成质量会更稳定。">
              <div className="form-grid">
                <Field label="项目 / 产品名称"><input value={form.projectName} onChange={(e) => update("projectName", e.target.value)} /></Field>
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
                  <b>生成新 PPT</b>
                  <span>从资料和需求说明生成一版完整新稿。</span>
                </button>
                <button className="primary-action secondary" onClick={() => createJob("optimize")}>
                  <b>优化旧 PPT</b>
                  <span>读取旧稿文本和截图，重生成可编辑新版。</span>
                </button>
              </div>
              <div className="theme-row">
                {themes.map((theme) => (
                  <button className={`theme-card ${form.style === theme.name ? "active" : ""}`} key={theme.name} onClick={() => update("style", theme.name)}>
                    <span style={{ "--theme-bg": `#${theme.colors.bg}`, "--theme-soft": `#${theme.colors.soft}`, "--theme-accent": `#${theme.colors.accent}` }} />
                    <b>{theme.name}</b>
                    <small>{theme.bestFor}</small>
                  </button>
                ))}
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
                revision={revision}
                selectedSlide={selectedSlide}
                setFocusPreview={setFocusPreview}
                setRevision={setRevision}
                setSelectedSlide={setSelectedSlide}
                slides={slides}
                onQuickAction={appendQuickAction}
                onRevise={revise}
                onSaveText={saveSlideText}
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
              ["exports", "导出"]
            ].map(([id, label]) => (
              <button className={rightPanelMode === id ? "active" : ""} key={id} onClick={() => setRightPanelMode(id)}>{label}</button>
            ))}
          </div>
          {rightPanelMode === "status" && <StatusPanel job={job} files={files} fileIds={fileIds} status={status} error={error} connection={connection} />}
          {rightPanelMode === "history" && <HistoryPanel jobs={jobs} onSelect={selectJob} />}
          {rightPanelMode === "exports" && <ExportPanel job={job} />}
        </aside>
      </div>
    </div>
  );
}

function PreviewWorkbench({ currentImage, currentSlide, focusPreview, job, revision, selectedSlide, setFocusPreview, setRevision, setSelectedSlide, slides, onQuickAction, onRevise, onSaveText }) {
  const [draft, setDraft] = useState(makeSlideDraft(currentSlide));

  useEffect(() => {
    setDraft(makeSlideDraft(currentSlide));
  }, [currentSlide, selectedSlide]);

  const savedDraft = useMemo(() => makeSlideDraft(currentSlide), [currentSlide]);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(savedDraft), [draft, savedDraft]);

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
            {job.previewImages?.[index] ? <img src={job.previewImages[index]} alt={`第 ${index + 1} 页`} /> : <i />}
            <span>{String(index + 1).padStart(2, "0")}</span>
            <b>{slide.title}</b>
          </button>
        ))}
        {!job && <p className="empty">还没有生成任务。</p>}
      </aside>

      <div className="preview-stage">
        <div className="stage-toolbar">
          <div>
            <b>{currentSlide?.title || "等待生成"}</b>
            <span>第 {selectedSlide + 1} 页 · {LAYOUT_LABELS[currentSlide?.layout] || currentSlide?.layout || "自动版式"}</span>
          </div>
          <div className="stage-controls">
            <button onClick={() => setSelectedSlide((value) => Math.max(0, value - 1))} disabled={!job || selectedSlide === 0}>上一页</button>
            <button onClick={() => setSelectedSlide((value) => Math.min(slides.length - 1, value + 1))} disabled={!job || selectedSlide >= slides.length - 1}>下一页</button>
            <button onClick={() => setFocusPreview((value) => !value)} disabled={!job}>{focusPreview ? "返回编辑" : "专注预览"}</button>
          </div>
        </div>
        <div className="large-slide">
          {currentImage ? <img src={currentImage} alt={`第 ${selectedSlide + 1} 页大图预览`} /> : <div className="empty-preview">生成后这里显示大图预览</div>}
        </div>
      </div>

      <aside className="editor-panel">
        <div className="edit-mode-title">
          <div>
            <b>直接编辑文字</b>
            {dirty ? <strong>有未保存修改</strong> : <strong className="saved">已同步</strong>}
          </div>
          <span>保存后会重新生成 PPTX 和预览图。</span>
        </div>
        <Field label="标题">
          <input value={draft.title} onChange={(e) => updateDraft("title", e.target.value)} disabled={!job} />
        </Field>
        <Field label="副标题 / 摘要">
          <textarea className="compact-textarea" value={draft.subtitle} onChange={(e) => updateDraft("subtitle", e.target.value)} disabled={!job} />
        </Field>
        <Field label="要点（一行一条）">
          <textarea value={draft.bullets} onChange={(e) => updateDraft("bullets", e.target.value)} disabled={!job} />
        </Field>
        <Field label="讲稿备注">
          <textarea className="compact-textarea" value={draft.speakerNotes} onChange={(e) => updateDraft("speakerNotes", e.target.value)} disabled={!job} />
        </Field>
        <div className="button-row tight">
          <button className="btn primary" onClick={() => onSaveText(draft)} disabled={!job || !dirty}>保存文字到 PPT</button>
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
      </aside>
    </div>
  );
}

function StatusPanel({ job, files, fileIds, status, error, connection }) {
  const warnings = [error, job?.warning, job?.exportWarning].filter(Boolean);
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

function makeSlideDraft(slide = {}) {
  return {
    title: slide?.title || "",
    subtitle: slide?.subtitle || "",
    bullets: toBulletList(slide?.bullets).join("\n"),
    speakerNotes: slide?.speakerNotes || "",
    visualIntent: slide?.visualIntent || "",
    dataPoints: toBulletList(slide?.dataPoints).join("\n"),
    imageSlots: toBulletList(slide?.imageSlots).join("\n")
  };
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

function formatDuration(seconds = 0) {
  const value = Math.max(0, Number(seconds) || 0);
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.floor(value / 60)}m`;
  return `${Math.floor(value / 3600)}h ${Math.floor((value % 3600) / 60)}m`;
}

function isMojibake(value = "") {
  return /[�]|绔|鍞|杞|涓滄|ç|Ã|閿|鐢|璧/.test(String(value));
}

createRoot(document.getElementById("root")).render(<App />);
