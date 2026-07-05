import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, getErrorMessage, isConnectionError } from "./api/client.js";
import { deriveWorkflowDeliveryStatus } from "./workflow/deliveryStatus.js";
import { getWorkflowGuidedAction } from "./workflow/guidedAction.js";
import { useWorkflowWorkerConsole } from "./workflow/useWorkflowWorkerConsole.js";
import "./styles.css";

const SKILL_FIRST_RULES = {
  "codex-ppt": [
    "先生成视觉统一的图片型 PPT",
    "样张确认后再进入全量图片页生成",
    "外部图片 API 调用前必须记录额度授权"
  ],
  "image-to-editable-ppt": [
    "只接收图片型 PPT / PDF / 页面图片作为重建源",
    "页面级任务必须有真实产物证据",
    "最终交付以可编辑 PPT 和校验证据为准"
  ]
};

const LAYOUT_LABELS = {
  cover: "\u5c01\u9762",
  visual: "\u4e3b\u89c6\u89c9",
  section: "\u7ae0\u8282",
  toc: "\u76ee\u5f55",
  kpi: "\u6570\u636e",
  pricing: "\u9884\u7b97",
  "product-detail": "\u8be6\u60c5",
  bundle: "\u5206\u7ec4",
  "risk-checklist": "\u786e\u8ba4",
  compare: "\u5bf9\u6bd4",
  timeline: "\u6d41\u7a0b",
  cards: "\u5361\u7247",
  quote: "\u89c2\u70b9",
  closing: "\u6536\u5c3e"
};

const QUICK_ACTIONS = ["\u6807\u9898\u66f4\u9500\u552e\u5316", "\u6539\u6210\u4ef7\u683c\u68af\u5ea6\u9875", "\u8bb2\u7a3f\u66f4\u53e3\u8bed", "\u51cf\u5c11\u6587\u5b57\u66f4\u9ad8\u7ea7", "\u5f3a\u5316\u4e0b\u4e00\u6b65\u52a8\u4f5c"];
const DECK_ACTIONS = ["\u6574\u4efd\u51cf\u5c11\u6587\u5b57\u66f4\u9ad8\u7ea7", "\u6539\u6210\u5ba2\u6237\u63d0\u6848\u53e3\u543b", "\u5f3a\u5316\u9500\u552e\u8bdd\u672f\u548c\u4e0b\u4e00\u6b65\u884c\u52a8", "\u6539\u6210\u6280\u672f\u6570\u636e\u6c47\u62a5\u98ce\u683c"];

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
  { id: "materials", number: "01", title: "\u8d44\u6599\u8bc6\u522b", desc: "\u62bd\u53d6\u6587\u5b57 / \u56fe\u7247 / \u7d20\u6750\u8eab\u4efd" },
  { id: "outline", number: "02", title: "\u5927\u7eb2\u89c4\u5212", desc: "\u9875\u9762\u89d2\u8272\u548c\u53d9\u4e8b\u8def\u7ebf" },
  { id: "generate", number: "03", title: "\u751f\u6210", desc: "视觉统一 / 可编辑重建" },
  { id: "preview", number: "04", title: "\u590d\u6838", desc: "\u9875\u9762\u8bc1\u636e / \u4ea4\u4ed8\u9884\u89c8" },
  { id: "export", number: "05", title: "\u4ea4\u4ed8", desc: "最终可编辑 PPT" }
];

const CODEX_PPT_APPROVAL_GATES = [
  { id: "outline", label: "大纲" },
  { id: "style", label: "视觉风格" },
  { id: "backend", label: "生图后端" },
  { id: "sample", label: "样张" },
  { id: "fullDeck", label: "全量生成" }
];

function uniqueIds(ids = []) {
  return [...new Set(ids.filter(Boolean))];
}

function formatReadyApprovalGateLabels(gates = []) {
  const labels = gates.map((gate) => gate.label).filter(Boolean);
  return labels.length ? labels.join("、") : "无";
}

const CODEX_PPT_NO_COST_APPROVAL_GATES = [
  { id: "outline", label: "大纲", artifactKey: "codexPptOutline" },
  { id: "style", label: "视觉风格", artifactKey: "codexPptStyle" },
  { id: "backend", label: "生图后端", artifactKey: "codexPptBackendDecision" }
];
const LEGACY_CODEX_PPT_STYLE_RE = /轻盈渐变风|东方自然风|黑白画册风|蓝白科技风|暗黑科技风|旧模板|旧版模板|模板包|template[-_\s]?pack/i;

function getApprovedCodexPptGateSet(job = {}) {
  return new Set((Array.isArray(job?.artifacts?.codexPptApprovals) ? job.artifacts.codexPptApprovals : [])
    .filter((item) => item?.status === "approved" && item.gate)
    .map((item) => item.gate));
}

function getNoCostCodexApprovalSummary(job = {}) {
  const approved = getApprovedCodexPptGateSet(job);
  const ready = CODEX_PPT_NO_COST_APPROVAL_GATES.filter((gate) => {
    const artifact = job?.artifacts?.[gate.artifactKey];
    if (gate.id === "style" && looksLikeLegacyCodexPptStyle(artifact)) return false;
    return !approved.has(gate.id) && Boolean(artifact?.path || artifact?.relativePath);
  });
  return {
    ready,
    readyCount: ready.length,
    labelText: formatReadyApprovalGateLabels(ready),
    approvedCount: CODEX_PPT_NO_COST_APPROVAL_GATES.filter((gate) => approved.has(gate.id)).length,
    total: CODEX_PPT_NO_COST_APPROVAL_GATES.length
  };
}

function looksLikeLegacyCodexPptStyle(artifact = {}) {
  const text = [
    artifact?.styleBrief,
    artifact?.title,
    artifact?.source,
    artifact?.path,
    artifact?.relativePath,
    artifact?.markdownPath,
    artifact?.markdownRelativePath
  ].filter(Boolean).join(" ");
  return LEGACY_CODEX_PPT_STYLE_RE.test(text);
}

const UI_TEXT_REPLACEMENTS = [
  ["Product v1 acceptance", "产品级 v1 验收"],
  ["v1 acceptance needs evidence", "v1 验收仍缺少证据"],
  ["v1 acceptance pending", "v1 验收待处理"],
  ["v1 acceptance blocked", "v1 验收被阻断"],
  ["v1 acceptance ready", "v1 验收就绪"],
  ["Record sample spend authorization", "记录样张额度授权"],
  ["Record full-deck spend authorization", "记录全量额度授权"],
  ["Regenerate product visual sample", "重新生成产品级视觉样张"],
  ["Generate product visual sample", "生成产品级视觉样张"],
  ["Approve product visual sample", "确认产品级视觉样张"],
  ["Approve full-deck generation", "确认全量生成"],
  ["Confirm codex-ppt image API usage", "确认 codex-ppt 图片 API 用量"],
  ["Confirm external image API usage", "确认外部图片 API 用量"],
  ["Configure external image runtime", "配置外部图片运行环境"],
  ["Current workflow step", "当前工作流步骤"],
  ["Current delivery step", "当前交付步骤"],
  ["Spend authorization", "额度授权"],
  ["Spend authorization ledger", "额度授权账本"],
  ["Product sample preflight", "产品样张预检"],
  ["Waiting for image API confirmation", "等待图片 API 确认"],
  ["Guided preflight", "引导预检"],
  ["Ready before run", "运行前已就绪"],
  ["Confirmation required", "需要确认"],
  ["Manual step", "需要手动处理"],
  ["Blocked before run", "运行前被阻断"],
  ["Checking next action", "正在检查下一步"],
  ["codex-ppt visual preflight", "codex-ppt 视觉预检"],
  ["Ready to generate visuals", "已可生成视觉页"],
  ["Needs spend confirmation", "需要确认额度"],
  ["Runtime evidence", "运行环境证据"],
  ["Runtime matches approval", "运行环境与确认一致"],
  ["Worker batch preflight", "页面批处理预检"],
  ["Ready to start", "可以开始"],
  ["Needs confirmation", "需要确认"],
  ["Blocked", "被阻断"],
  ["Sample gate guard", "样张确认保护"],
  ["Sample gate approved", "样张已确认"],
  ["Product sample required", "需要产品级样张"],
  ["Ready for human review", "等待人工复核"],
  ["Waiting for sample evidence", "等待样张证据"],
  ["codex-ppt full-deck image stage", "codex-ppt 全量图片阶段"],
  ["Cost estimate", "费用预估"],
  ["Workflow cleanup", "工作流清理"],
  ["Preview cleanup", "预览清理页"],
  ["Archive cleanup candidates", "归档清理候选"],
  ["Source render", "源文件渲染"],
  ["Image deck", "图片型 PPT"],
  ["Editable rebuild", "可编辑重建"],
  ["Delivery gate", "交付门禁"],
  ["Ready", "就绪"],
  ["Pending", "待处理"],
  ["Running", "运行中"],
  ["Recorded", "已记录"],
  ["Failed", "失败"],
  ["Missing", "缺失"],
  ["Configured", "已配置"],
  ["Required", "必需"],
  ["Available", "可用"],
  ["Optional", "可选"],
  ["Online", "在线"],
  ["Offline", "离线"],
  ["Final ready", "最终文件就绪"],
  ["Not ready", "未就绪"],
  ["Not started", "未开始"],
  ["not_started", "未开始"],
  ["In workflow", "工作流中"],
  ["Sample ready", "样张就绪"],
  ["Rebuild stage", "重建阶段"],
  ["Image PPT", "图片型 PPT"],
  ["Sample approval", "样张确认"],
  ["Worker queue", "页面任务队列"],
  ["Upload files", "上传文件"],
  ["Local image", "本地生图"],
  ["connected", "已连接"],
  ["Local image not ready", "本地生图未就绪"],
  ["Product doctor complete", "产品环境检查完成"],
  ["All required product runtime checks passed", "所有必需运行环境检查通过"],
  ["Node.js runtime", "Node.js 运行时"],
  ["Workflow job directory", "工作流任务目录"],
  ["LLM provider", "对话模型服务商"],
  ["Fresh editable run", "重建 fresh editable run"],
  ["Editable task sync", "同步可编辑页面任务"],
  ["Editable worker batch", "可编辑页面 worker 批处理"],
  ["Local editable preparation must run before model page workers can select pages.", "需要先完成本地可编辑重建准备，model 页面 worker 才能选择页面。"],
  ["Editable rebuild needs local preparation before model workers can run; no external image or LLM call is needed for this preparation.", "可编辑重建需要先做本地准备；这一步不调用外部图片 API，也不调用 LLM。"],
  ["Run fresh editable run recovery first; this clears stale editable evidence and rebuilds editppt inputs.", "先重建 fresh editable run，清理过期可编辑证据并重新准备 editppt 输入。"],
  ["Run editable worker task sync after fresh recovery.", "fresh run 重建后，同步可编辑页面任务。"],
  ["Then rerun this readiness preflight before starting model page workers.", "然后重新检查总预检，再启动 model 页面 worker。"],
  ["Confirm LLM provider recovery.", "确认对话模型服务商已经恢复。"],
  ["Confirm external spend before running model editable workers.", "运行 model 可编辑 worker 前，先确认外部额度消耗。"],
  ["Run 1-2 pages first, then review page-level PPTX output.", "先跑 1-2 页，再复核页面级 PPTX 输出。"],
  ["Image provider", "图片 API"],
  ["OCR provider", "OCR"],
  ["editppt runtime", "editppt 运行时"],
  ["image-to-editable-ppt contract", "image-to-editable-ppt 契约"],
  ["v0.3-compatible", "v0.3 兼容"],
  ["legacy-or-unknown", "旧版或未知"],
  ["PDF renderer", "PDF 渲染器"],
  ["pdftoppm available", "pdftoppm 可用"],
  ["doctor passed", "doctor 通过"],
  ["registered", "已注册"],
  ["Brief / outline source", "需求简述/大纲来源"],
  ["QA blocked", "QA 已阻断"],
  ["Product-ready", "产品可交付"],
  ["Draft only", "仅草稿"],
  ["Blocked file", "文件被阻断"],
  ["Diagnostics", "诊断"],
  ["Final QA checklist", "最终 QA 清单"],
  ["Page count parity", "页数一致性"],
  ["Page worker evidence", "页面任务证据"],
  ["Finalize evidence", "最终生成证据"],
  ["codex-ppt evidence", "视觉统一证据"],
  ["manual-review", "人工复核"],
  ["user input", "用户输入"],
  ["user materials", "用户资料"],
  ["user images", "用户图片"],
  ["system inference + needs manual confirmation", "系统推断 + 需要人工确认"],
  ["system inference", "系统推断"],
  ["needs manual confirmation", "需要人工确认"],
  ["unknown", "未知"],
  ["generated", "已生成"],
  ["items", "项"],
  ["required", "必需"],
  ["confirmed", "已确认"],
  ["recorded", "已记录"],
  ["missing", "缺失"],
  ["pending", "待处理"],
  ["ready", "就绪"],
  ["blocked", "阻断"],
  ["warning", "注意"],
  ["pass", "通过"],
  ["review", "需复核"],
  ["manual", "手动"],
  ["mutating", "会改动"],
  ["read-only", "只读"],
  ["not required", "不需要"],
  ["not detected", "未发现"],
  ["detected", "已发现"],
  ["refresh", "刷新"],
  ["current", "当前"],
  ["waiting", "等待中"]
];

function uiZh(value = "") {
  let text = String(value ?? "");
  if (!text) return "";
  for (const [from, to] of UI_TEXT_REPLACEMENTS) {
    text = text.split(from).join(to);
  }
  return text
    .replace(/\bpage\(s\)/g, "页")
    .replace(/\bslide task\(s\)/g, "个图片页任务")
    .replace(/\bselected\b/g, "已选择")
    .replace(/\btotal\b/g, "总计")
    .replace(/\bcall\(s\)/g, "次调用")
    .replace(/\bimage calls?\b/gi, "图片调用")
    .replace(/\bprovider pending\b/gi, "服务商待确认")
    .replace(/\bconfigured runtime\b/gi, "已配置运行环境")
    .replace(/\bruntime pending\b/gi, "运行环境待确认");
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
    projectName: "",
    audience: "",
    pageCount: "系统推荐",
    notes: "",
    copyMode: "先确认大纲和样张，再重建可编辑 PPT",
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
  const [skillRules] = useState(SKILL_FIRST_RULES);
  const [styleReferences, setStyleReferences] = useState([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [generationProgress, setGenerationProgress] = useState({ active: false, mode: "", value: 0, label: "" });
  const [intakeDraft, setIntakeDraft] = useState("");
  const [intakeMessages, setIntakeMessages] = useState([]);
  const [directorDraft, setDirectorDraft] = useState("");
  const [directorBusy, setDirectorBusy] = useState(false);
  const [directorMessages, setDirectorMessages] = useState([
    {
      id: "director_welcome",
      role: "assistant",
      title: "PPT 智能体",
      text: "我会先把源稿重制成视觉统一的新版本，再重建为可编辑 PPT。先上传源文件或输入需求，然后按确认关卡继续。",
      facts: ["视觉统一版本", "可编辑 PPTX", "质量检查"],
      actions: [
        { id: "focus-upload", label: "上传文件", kind: "navigate", step: "materials" },
        { id: "open-workflow", label: "打开工作流", event: "open-workflow" }
      ]
    }
  ]);
  const [activeStep, setActiveStep] = useState("generate");
  const [rightPanelMode, setRightPanelMode] = useState("agent");
  const [focusPreview, setFocusPreview] = useState(false);
  const [connection, setConnection] = useState({ state: "checking", message: "正在检查本地服务..." });
  const [localImage, setLocalImage] = useState({ state: "checking", message: "正在检查本地生图服务..." });
  const [doctor, setDoctor] = useState({ state: "checking", message: "正在检查产品运行环境..." });
  const [previewBusy, setPreviewBusy] = useState(false);
  const [apiConfig, setApiConfig] = useState({ apiKey: "", maskedApiKey: "", hasApiKey: false, baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini", pageSpecModel: "gpt-4.1-mini", imageModel: "gpt-image-2" });
  const [availableModels, setAvailableModels] = useState([]);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [draft, setDraft] = useState(makeSlideDraft(null));
  const [insertLayout, setInsertLayout] = useState("section");
  const [draggedSlide, setDraggedSlide] = useState(null);
  const [dropTargetSlide, setDropTargetSlide] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [workflowJob, setWorkflowJob] = useState(null);
  const [workflowJobs, setWorkflowJobs] = useState([]);
  const [primaryWorkflow, setPrimaryWorkflow] = useState(null);
  const [workflowShowArchived, setWorkflowShowArchived] = useState(false);
  const [workflowBusy, setWorkflowBusy] = useState(false);

  useEffect(() => {
    api.styleReferences().then((data) => setStyleReferences(data.references || [])).catch(() => {});
    api.workflowJobsMeta()
      .then((meta) => {
        const id = meta?.primaryWorkflowJobId || "";
        if (!id) return null;
        setPrimaryWorkflow((current) => current?.id ? current : { id, found: true });
        return api.workflowJob(id);
      })
      .then((primaryJob) => {
        if (primaryJob?.id) {
          setWorkflowJob((current) => current?.id ? current : primaryJob);
          setWorkflowJobs((current) => uniqueWorkflowJobs([primaryJob, ...current]));
        }
      })
      .catch(() => {});
    loadWorkflowJobs({ restoreLatest: true });
    api.config().then((data) => {
      setApiConfig((current) => ({ ...current, ...data, apiKey: "" }));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (workflowJob?.id || !primaryWorkflow?.id || primaryWorkflow.found === false) return;
    let active = true;
    api.workflowJob(primaryWorkflow.id)
      .then((job) => {
        if (active && job?.id) setWorkflowJob(job);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [primaryWorkflow?.id, primaryWorkflow?.found, workflowJob?.id]);

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
          message: data.ok ? ((data.provider || "本地生图") + " 已连接") : (data.reason || "本地生图未就绪"),
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
          message: data.uptime ? "本地在线 " + formatDuration(data.uptime) : "本地在线",
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

  useEffect(() => {
    let active = true;
    async function checkDoctor() {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 70000);
      try {
        const data = await api.doctor(controller.signal);
        if (!active) return;
        setDoctor({
          state: data.level || (data.ok ? "ready" : "blocked"),
          message: data.summary || "产品运行环境检查完成",
          details: data
        });
      } catch (error) {
        if (!active) return;
        setDoctor({ state: "blocked", message: getErrorMessage(error) });
      } finally {
        window.clearTimeout(timer);
      }
    }
    checkDoctor();
    return () => {
      active = false;
    };
  }, []);

  const slides = job?.deck?.slides || [];
  const currentSlide = slides[selectedSlide];
  const currentImage = job?.previewImages?.[selectedSlide];
  const savedDraft = useMemo(() => makeSlideDraft(currentSlide), [currentSlide]);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(savedDraft), [draft, savedDraft]);
  const liveSlide = useMemo(() => draftToSlide(currentSlide, draft), [currentSlide, draft]);
  const selectedFileNames = useMemo(() => files.map((file) => file.originalName).join(" / "), [files]);
  const hasUploadedMaterials = files.length > 0;
  const intakeReadiness = useMemo(() => getIntakeReadiness(form.notes, files), [form.notes, files]);
  const inferredMaterials = useMemo(() => inferMaterialTypes(files), [files]);
  const completion = useMemo(() => getCompletion({ form, fileIds, job }), [form, fileIds, job]);
  const stepState = useMemo(() => getStepState({ activeStep, fileIds, job, formats }), [activeStep, fileIds, job, formats]);
  const finalExportBlocked = isJobBlockedForFinal(job);
  const noCostApprovalSummary = useMemo(() => getNoCostCodexApprovalSummary(workflowJob), [workflowJob]);

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

  function submitIntakeMessage() {
    const text = intakeDraft.trim();
    if (!text && fileIds.length === 0) return;
    const userText = text || "我已上传资料，请先理解内容。";
    const intent = analyzeIntakeMessage(userText, { files, notes: form.notes });
    const now = Date.now();
    setIntakeMessages((current) => [
      ...current,
      { id: "user-" + now, role: "user", text: userText },
      { id: "assistant-" + now, role: "assistant", text: intent.reply, kind: intent.kind }
    ]);
    if (text && intent.actionable) {
      setForm((current) => ({ ...current, notes: [current.notes, text].filter(Boolean).join("\n") }));
    }
    setIntakeDraft("");
    setError("");
    setStatus(intent.actionable ? "需求已记录。你可以继续补充细节，或开始生成大纲。" : "已按对话处理，未创建 PPT 需求。");
  }

  function handleIntakeKeyDown(event) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent?.isComposing) return;
    event.preventDefault();
    submitIntakeMessage();
  }

  function validatePreparation(nextForm = form) {
    if (!nextForm.notes.trim() && fileIds.length === 0) {
      setError("请至少填写一句需求，或上传一份资料。");
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
          { id: "upload-" + now, role: "user", text: `已上传 ${uploaded.length} 个文件：${names}` },
          { id: "upload-reply-" + now, role: "assistant", text: "资料已收到。接下来可以继续补充要求，或创建 PPT 重制任务。" }
        ]);
      }
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
    if (!window.confirm("删除上传文件 " + (file.originalName || file.id) + "？本地源文件也会被移除。")) return;
    setError("");
    setStatus("正在删除上传文件...");
    try {
      await api.remove("/api/uploads/" + file.id);
      setFiles((current) => current.filter((item) => item.id !== file.id));
      setFileIds((current) => current.filter((id) => id !== file.id));
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

  async function runWorkflowRebuildPipeline() {
    const sourceUploadId = fileIds[0];
    if (!sourceUploadId) {
      setError("请先上传 PPT/PDF/图片作为可编辑重建源文件。");
      setActiveStep("materials");
      return;
    }
    setWorkflowBusy(true);
    setError("");
    setStatus("正在创建可编辑重建 workflow...");
    try {
      let next = await api.createWorkflowJob({
        sourceUploadId,
        mode: "ppt-rebuild",
        notes: "frontend-workflow-pipeline"
      });
      setWorkflowJob(next);
      await loadWorkflowJobs({ activeId: next.id });

      const run = async (action, body, label) => {
        setStatus(label);
        next = await api.workflowAction(next.id, action, body);
        setWorkflowJob(next);
        return next;
      };

      await run("source/render", {}, "正在渲染源页面...");
      setStatus("正在记录大纲证据...");
      next = await api.recordCodexPptOutline(next.id, buildCodexPptOutlineRecordBody("frontend-upload-skill-first"));
      setWorkflowJob(next);
      setStatus("正在记录视觉风格和生成方式...");
      next = await api.recordCodexPptStyle(next.id, buildCodexPptStyleRecordBody("frontend-upload-skill-first"));
      next = await api.recordCodexPptBackend(next.id, buildCodexPptBackendRecordBody("frontend-upload-skill-first"));
      setWorkflowJob(next);
      await loadWorkflowJobs({ activeId: next.id });
      setStatus("重制任务已创建。请复核源页面，确认大纲、视觉方向和生成方式后，再生成视觉样张。");
    } catch (err) {
      setError(getErrorMessage(err));
      setStatus("");
    } finally {
      setWorkflowBusy(false);
    }
  }

  async function runBriefWorkflowPipeline() {
    const sourceBrief = buildSkillFirstBriefSource({ form, outlinePlan, files, inferredMaterials });
    if (!sourceBrief.trim()) {
      setError("创建 PPT 重制任务前，请先输入需求简述或确认大纲。");
      setActiveStep("materials");
      return;
    }
    setWorkflowBusy(true);
    setError("");
    setStatus("正在根据需求创建 PPT 重制任务...");
    try {
      let next = await api.createWorkflowJob({
        sourceBrief,
        sourceOriginalName: getEffectiveProjectName(form, files) + "-brief.md",
        sourceMimeType: "text/markdown",
        mode: "codex-ppt-brief",
        notes: "frontend-brief-skill-first-workflow"
      });
      setWorkflowJob(next);
      await loadWorkflowJobs({ activeId: next.id });

      setStatus("正在渲染简述来源...");
      next = await api.workflowAction(next.id, "source/render", {});
      setWorkflowJob(next);
      setStatus("正在记录大纲证据...");
      next = await api.recordCodexPptOutline(next.id, buildCodexPptOutlineRecordBody("frontend-brief-skill-first", sourceBrief));
      setWorkflowJob(next);
      setStatus("正在记录视觉风格和生成方式...");
      next = await api.recordCodexPptStyle(next.id, buildCodexPptStyleRecordBody("frontend-brief-skill-first"));
      next = await api.recordCodexPptBackend(next.id, buildCodexPptBackendRecordBody("frontend-brief-skill-first"));
      setWorkflowJob(next);
      await loadWorkflowJobs({ activeId: next.id });
      setStatus("简述重制任务已创建。请确认大纲、视觉方向和生成方式后，再生成视觉样张。");
    } catch (err) {
      setError(getErrorMessage(err));
      setStatus("");
    } finally {
      setWorkflowBusy(false);
    }
  }

  async function startSkillFirstWorkflow() {
    if (!fileIds.length) {
      await runBriefWorkflowPipeline();
      return;
    }
    await runWorkflowRebuildPipeline();
  }

  function buildCodexPptOutlineRecordBody(source, sourceBrief = "") {
    return {
      outlinePlan,
      source,
      sourceBrief: sourceBrief || buildSkillFirstBriefSource({ form, outlinePlan, files, inferredMaterials }),
      title: getEffectiveProjectName(form, files),
      recordedBy: "frontend-skill-first",
      notes: "codex-ppt outline artifact required before outline approval"
    };
  }

  function buildCodexPptStyleRecordBody(source) {
    return {
      source,
      title: getEffectiveProjectName(form, files),
      styleBrief: "以源页内容、用户说明和可选参考图作为视觉依据；codex-ppt 负责统一调性、留白、层级和页面节奏，不套用旧模板包或固定版式。",
      audience: form.audience || "",
      references: files.map((file) => file.originalName || file.id).filter(Boolean),
      recordedBy: "frontend-skill-first",
      notes: "codex-ppt style artifact required before style approval"
    };
  }

  function buildCodexPptBackendRecordBody(source) {
    return {
      source,
      recordedBy: "frontend-skill-first",
      notes: "codex-ppt backend artifact required before backend approval"
    };
  }

  async function loadWorkflowJobs({ activeId = "", includeArchived = workflowShowArchived, restoreLatest = false } = {}) {
    try {
      const data = await api.workflowJobs({ includeArchived });
      const primary = data.primaryWorkflow || null;
      setPrimaryWorkflow(primary);
      const nextJobs = uniqueWorkflowJobs([primary?.job, ...(data.jobs || [])]).filter(isUserWorkflowJob);
      setWorkflowJobs(nextJobs);
      const active = activeId ? nextJobs.find((item) => item.id === activeId) : null;
      const latest = restoreLatest ? selectDefaultWorkflowJob(nextJobs, primary) : null;
      if (active || (restoreLatest && (!workflowJob || isInternalWorkflowJob(workflowJob)) && latest)) {
        const selected = active || latest;
        const hydrated = selected?.id ? await api.workflowJob(selected.id).catch(() => selected) : selected;
        setWorkflowJob(hydrated);
      } else if (restoreLatest && !latest && (!workflowJob || isInternalWorkflowJob(workflowJob))) {
        setWorkflowJob(null);
      }
      return nextJobs;
    } catch {
      return [];
    }
  }

  async function toggleWorkflowArchive(jobId, archive = true) {
    if (!jobId) return;
    setWorkflowBusy(true);
    setError("");
    try {
      const body = {
        reason: archive ? "Archived from workflow workspace" : "Restored from workflow workspace",
        archivedBy: "operator",
        restoredBy: "operator"
      };
      const next = archive
        ? await api.archiveWorkflowJob(jobId, body)
        : await api.restoreWorkflowJob(jobId, body);
      if (!archive) setWorkflowJob(next);
      const nextJobs = await loadWorkflowJobs({ activeId: archive ? "" : next.id, includeArchived: workflowShowArchived, restoreLatest: archive });
      if (archive && workflowJob?.id === jobId) {
        setWorkflowJob(nextJobs.find((item) => !item.archived) || null);
      }
      setStatus(archive ? "工作流已归档，产物仍保留在磁盘。" : "工作流已恢复。");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setWorkflowBusy(false);
    }
  }

  async function setWorkflowArchiveVisibility(nextShowArchived) {
    setWorkflowShowArchived(nextShowArchived);
    await loadWorkflowJobs({ activeId: workflowJob?.id || "", includeArchived: nextShowArchived, restoreLatest: true });
  }

  async function selectWorkflowJob(id) {
    if (!id) return;
    setWorkflowBusy(true);
    setError("");
    try {
      const next = await api.workflowJob(id);
      setWorkflowJob(next);
      setStatus("已切换 workflow。");
      await loadWorkflowJobs({ activeId: id });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setWorkflowBusy(false);
    }
  }

  async function refreshWorkflowJob() {
    if (!workflowJob?.id) return;
    setWorkflowBusy(true);
    setError("");
    try {
      const next = await api.workflowJob(workflowJob.id);
      setWorkflowJob(next);
      await loadWorkflowJobs({ activeId: next.id });
      setStatus("workflow 状态已刷新。");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setWorkflowBusy(false);
    }
  }

  async function runWorkflowStep(action, body = {}, label = "正在执行 workflow 阶段...") {
    if (!workflowJob?.id) return;
    setWorkflowBusy(true);
    setError("");
    setStatus(label);
    try {
      const next = await api.workflowAction(workflowJob.id, action, body);
      setWorkflowJob(next);
      setStatus("workflow 阶段已完成。");
    } catch (err) {
      setError(getErrorMessage(err));
      setStatus("");
    } finally {
      setWorkflowBusy(false);
    }
  }

  async function runWorkflowNextAction(label = "正在执行下一步 PPT 重制任务...", body = {}) {
    if (!workflowJob?.id) return null;
    setWorkflowBusy(true);
    setError("");
    setStatus(label);
    try {
      const result = await api.workflowNextAction(workflowJob.id, { ...body, requestedBy: "frontend-guided-next" });
      if (result.job) {
        setWorkflowJob(result.job);
        await loadWorkflowJobs({ activeId: result.job.id });
      }
      setStatus(result.manualRequired ? uiZh(result.reason || "需要手动处理。") : result.didRun ? "工作流下一步已完成。" : uiZh(result.reason || "工作流已刷新。"));
      return result;
    } catch (err) {
      setError(getErrorMessage(err));
      setStatus("");
      return null;
    } finally {
      setWorkflowBusy(false);
    }
  }

  async function approveNoCostCodexGates() {
    if (!workflowJob?.id || !noCostApprovalSummary.readyCount) return;
    setWorkflowBusy(true);
    setError("");
    setStatus(`正在确认 ${noCostApprovalSummary.labelText}，不会生成图片...`);
    try {
      for (const gate of noCostApprovalSummary.ready) {
        const preflight = await api.preflightCodexPptGate(workflowJob.id, gate.id, { note: `frontend-main-${gate.id}-approval` });
        if (!preflight.ready && !preflight.passed) {
          throw new Error(preflight.error || `${gate.label} 还不能确认`);
        }
        await api.approveCodexPptGate(workflowJob.id, gate.id, {
          note: `frontend-main-${gate.id}-approval`,
          approvedBy: "frontend-skill-first"
        });
      }
      const next = await api.workflowJob(workflowJob.id);
      setWorkflowJob(next);
      await loadWorkflowJobs({ activeId: next.id });
      setActiveStep("generate");
      setStatus(`已确认 ${noCostApprovalSummary.labelText}。这一步未生成图片，样张前仍需要外部图片 API 授权。`);
      window.setTimeout(() => document.getElementById("workflow-compliance-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    } catch (err) {
      setError(getErrorMessage(err));
      setStatus("");
    } finally {
      setWorkflowBusy(false);
    }
  }

  function getGenerationMode() {
    return files.some((file) => /\.(ppt|pptx)$/i.test(file.originalName || "")) ? "optimize" : "generate";
  }

  function getRequestFormForFiles(current = form) {
    return hasUploadedMaterials ? current : { ...current, outlineStrategy: "regenerate" };
  }

  async function planOutline(formOverride = null) {
    const requestForm = getRequestFormForFiles(formOverride || form);
    if (!validatePreparation(requestForm)) return;
    setError("");
    setOutlineBusy(true);
    setStatus("正在生成可确认大纲...");
    try {
      const data = await api.planWorkflowOutline({
        ...requestForm,
        projectName: getEffectiveProjectName(requestForm, files),
        fileIds,
        materials: inferredMaterials,
        mode: getGenerationMode()
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
      setStatus("本地图片 QA 已刷新，文字污染和安全区风险已重新计算。");
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
      setStatus(sampleStatus === "generated" ? "视觉目标样张已生成。最终 PPT 仍会以 SceneGraph 渲染。" : "视觉目标样张已排队。请确认本地生图服务在线。");
      setRightPanelMode("status");
    } catch (err) {
      setError(getErrorMessage(err));
      setStatus("");
    }
  }

  async function generateDirectorVisualProject() {
    if (!job?.id) return;
    setError("");
    setStatus("正在按 PPT 智能体流程生成视觉项目...");
    try {
      const data = await api.generateVisualProject(job.id, { maxSlides: "all", overwrite: false });
      setJob(data);
      setJobs((current) => [data, ...current.filter((item) => item.id !== data.id)]);
      const generated = data.visualProject?.generatedImages || 0;
      const total = data.visualProject?.slideCount || 0;
      setStatus("视觉项目已更新：" + generated + "/" + total + " 页。");
      setRightPanelMode("agent");
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
      setStatus("QA 已阻断：当前 editable PPTX 只作为草稿保留，修复阻断项后才能正式导出 PDF/PNG。");
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

  async function saveApiConfig() {
    setSettingsBusy(true);
    setError("");
    try {
      const data = await api.saveConfig(apiConfig);
      setApiConfig((current) => ({ ...current, ...data, apiKey: "" }));
      setStatus("API \u914d\u7f6e\u5df2\u4fdd\u5b58\uff0c\u540e\u7eed\u751f\u6210\u4f1a\u4f7f\u7528\u8fd9\u4efd\u914d\u7f6e\u3002");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSettingsBusy(false);
    }
  }

  async function savePaddleOcrToken() {
    const token = String(apiConfig.paddleOcrToken || "").trim();
    if (!token) {
      setError("请先粘贴 editppt 兼容 OCR 令牌；主流程已使用本地开源 OCR。");
      return;
    }
    setSettingsBusy(true);
    setError("");
    setStatus("正在把 editppt 兼容 OCR 令牌保存到配置...");
    try {
      const data = await api.savePaddleOcrToken({ paddleOcrToken: token });
      setApiConfig((current) => ({
        ...current,
        paddleOcrToken: "",
        editppt: data.editppt || current.editppt
      }));
      setStatus("editppt 兼容 OCR 令牌已保存。主流程仍优先使用本地 PaddleOCR / RapidOCR 文字提示。");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSettingsBusy(false);
    }
  }

  async function testApiConfig() {
    setSettingsBusy(true);
    setStatus("\u6b63\u5728\u6d4b\u8bd5 API \u8fde\u63a5...");
    setError("");
    try {
      const data = await api.testConfig(apiConfig);
      if (data.usedBaseUrl) {
        setApiConfig((current) => ({ ...current, baseUrl: data.usedBaseUrl }));
      }
      setStatus(data.message || "API \u8fde\u63a5\u6210\u529f\u3002");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSettingsBusy(false);
    }
  }

  async function testImageApiConfig() {
    setSettingsBusy(true);
    setStatus("正在测试外部图片 API 配置...");
    setError("");
    try {
      const data = await api.testProvider({
        ...apiConfig,
        target: "image",
        generateProbe: false
      });
      const image = data.result?.image || {};
      if (!image.ok) throw new Error(image.error || "图片 API 配置测试失败。");
      const provider = image.provider || {};
      setStatus(image.message || `图片 API 已配置：${provider.model || apiConfig.imageModel || "图片模型"} / ${provider.baseUrl || apiConfig.baseUrl || "服务商"}。`);
    } catch (err) {
      setError(getErrorMessage(err));
      setStatus("");
    } finally {
      setSettingsBusy(false);
    }
  }
  async function detectModels() {
    setSettingsBusy(true);
    setStatus("\u6b63\u5728\u68c0\u6d4b\u53ef\u7528\u6a21\u578b...");
    setError("");
    try {
      const data = await api.models(apiConfig);
      const models = data.models || [];
      const imageModels = data.imageModels || [];
      setAvailableModels(models);
      const nextModel = models.length && !models.includes(apiConfig.model) ? models[0] : apiConfig.model;
      const nextPageSpecModel = models.length && !models.includes(apiConfig.pageSpecModel) ? nextModel : (apiConfig.pageSpecModel || nextModel);
      const nextImageModel = imageModels.length && !imageModels.includes(apiConfig.imageModel) ? imageModels[0] : (apiConfig.imageModel || "gpt-image-2");
      setApiConfig((current) => ({
        ...current,
        baseUrl: data.usedBaseUrl || current.baseUrl,
        model: nextModel,
        pageSpecModel: nextPageSpecModel,
        imageModel: nextImageModel
      }));
      setStatus(models.length ? `\u5df2\u68c0\u6d4b\u5230 ${models.length} \u4e2a\u53ef\u7528\u6a21\u578b\uff0c\u5df2\u81ea\u52a8\u4f7f\u7528 ${data.usedBaseUrl || apiConfig.baseUrl}\u3002` : "\u6ca1\u6709\u68c0\u6d4b\u5230\u53ef\u7528\u804a\u5929\u6a21\u578b\u3002");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSettingsBusy(false);
    }
  }

  async function uploadStyleReference(files, meta) {
    if (!files?.length) return;
    setSettingsBusy(true);
    setStatus("正在加入可选参考图...");
    try {
      const data = await api.uploadStyleReferences(files, meta);
      setStyleReferences((current) => [...(data.references || []), ...current]);
      setStatus("可选参考图已加入，后续生成会参考这组调性。");
    } catch (err) {
      setStatus(getErrorMessage(err));
    } finally {
      setSettingsBusy(false);
    }
  }

  async function deleteStyleReference(id) {
    setSettingsBusy(true);
    setStatus("");
    try {
      await api.deleteStyleReference(id);
      setStyleReferences((current) => current.filter((item) => item.id !== id));
      setStatus("已删除可选参考图。");
    } catch (err) {
      setStatus(getErrorMessage(err));
    } finally {
      setSettingsBusy(false);
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

  async function sendDirectorMessage(textOverride = "") {
    const text = (textOverride || directorDraft).trim();
    if (!text || directorBusy) return;
    const userMessage = { id: `director_user_${Date.now()}`, role: "user", text };
    setDirectorMessages((current) => [...current, userMessage]);
    setDirectorDraft("");
    setDirectorBusy(true);
    setError("");
    try {
      const reply = await api.directorChat({
        message: text,
        fileIds,
        jobId: job?.id || "",
        workflowJobId: workflowJob?.id || "",
        workflowStage: workflowJob?.currentStage || workflowJob?.status || "",
        skillFirst: true,
        activeStep
      });
      setDirectorMessages((current) => [...current, { ...reply, id: `director_reply_${Date.now()}` }]);
    } catch (err) {
      setDirectorMessages((current) => [...current, {
        id: `director_error_${Date.now()}`,
        role: "assistant",
        title: "连接失败",
        text: getErrorMessage(err),
        facts: [],
        actions: []
      }]);
    } finally {
      setDirectorBusy(false);
    }
  }

  function handleDirectorKeyDown(event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendDirectorMessage();
    }
  }

  async function handleDirectorAction(action = {}) {
    if (action.kind === "navigate" && action.step) {
      setActiveStep(action.step);
      return;
    }
    if (action.event === "plan-outline") {
      setActiveStep("outline");
      await planOutline();
      return;
    }
    if (action.event === "create-job") {
      if (!outlinePlan?.layoutSequence?.length) await planOutline();
      await startSkillFirstWorkflow();
      return;
    }
    if (action.event === "open-workflow") {
      setActiveStep("generate");
      return;
    }
    if (action.event === "refresh-workflow") {
      setActiveStep("generate");
      await refreshWorkflowJob();
      return;
    }
    if (action.event === "visual-sample") {
      setActiveStep("generate");
      await generateVisualTargetSample();
      return;
    }
    if (action.event === "visual-project") {
      setActiveStep("generate");
      await generateDirectorVisualProject();
    }
  }

  const editBlocked = Boolean(job?.editReadiness && job.editReadiness.ready === false);
  const hasEditableContext = Boolean(job && currentSlide && !editBlocked);
  const allowAdvancedEdit = activeStep === "preview" && hasEditableContext;
  const useDualRouteDashboard = activeStep === "generate";
  const showRightPanel = !useDualRouteDashboard && ((activeStep === "preview" && Boolean(job)) || rightPanelMode !== "closed");
  const visibleRightPanelMode = rightPanelMode === "closed"
    ? "status"
    : (!allowAdvancedEdit && ["edit", "ai"].includes(rightPanelMode) ? "status" : rightPanelMode);
  const rightPanelTabs = allowAdvancedEdit
    ? [["status", "状态"], ["edit", "高级修正"], ["history", "历史"]]
    : [["status", "状态"], ["history", "历史"]];

  return (
    <div className="workspace-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" role="img">
              <path d="M12 2.6c5.2 0 9.4 4.2 9.4 9.4s-4.2 9.4-9.4 9.4S2.6 17.2 2.6 12 6.8 2.6 12 2.6Z" />
              <path d="M7.7 13.5 13.4 6.8h3l-5.7 6.7h3.7l-3.8 3.7H7.7v-3.7Z" />
            </svg>
          </span>
          <span className="brand-name">PPT Agent</span>
          <span className="topbar-pill"><span className={topbarStateClass} />本地已连接</span>
          <span className="topbar-pill"><span className="pill-check" />模型正常</span>
        </div>
        <div className="topbar-actions">
          <button className="topbar-tool" type="button">健康检查</button>
          <button className="topbar-icon" type="button" aria-label="设置">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.4A3.6 3.6 0 1 1 12 15.6 3.6 3.6 0 0 1 12 8.4Zm7.2 3.6c0-.5-.1-1-.2-1.5l2-1.5-2-3.4-2.4 1a7 7 0 0 0-2.5-1.4L13.8 2h-4l-.4 3.2A7 7 0 0 0 7 6.6l-2.5-1-2 3.4 2 1.5a7.5 7.5 0 0 0 0 3l-2 1.5 2 3.4 2.5-1c.7.6 1.5 1 2.4 1.3l.4 3.3h4l.4-3.3a7 7 0 0 0 2.5-1.4l2.4 1 2-3.4-2-1.5c.1-.5.2-1 .2-1.5Z" /></svg>
          </button>
          <span className="topbar-avatar">A</span>
          <button className="topbar-mode" type="button">本地模式</button>
        </div>
      </header>

      {!useDualRouteDashboard ? (
        <WorkflowStrip activeStep={activeStep} completion={completion} rightPanelMode={rightPanelMode} setActiveStep={setActiveStep} setRightPanelMode={toggleSettingsPanel} stepState={stepState} />
      ) : null}

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
          {activeStep !== "generate" ? (
            <WorkflowPrimaryJobNotice
              currentJob={workflowJob}
              onOpenDelivery={() => setActiveStep("export")}
              onOpenPrimary={() => primaryWorkflow?.id && selectWorkflowJob(primaryWorkflow.id)}
              primaryWorkflow={primaryWorkflow}
            />
          ) : null}
          {activeStep === "materials" && (
            <SectionCard className="intake-card">
              <div className="chat-intake">
                <div className="intake-agent-panel">
                  <div>
                    <b>PPT 智能体</b>
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
                    {["说明重制流程", "重制现有 PPT", "从需求创建任务", "先确认素材"].map((item) => (
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
                      {outlineBusy ? "..." : "发送"}
                    </button>
                  </div>
                </div>
                {hasUploadedMaterials && (
                  <div className="outline-strategy-toggle" role="group" aria-label={UI.regenerateOutline}>
                    <button className={form.outlineStrategy !== "regenerate" ? "active" : ""} type="button" onClick={() => update("outlineStrategy", "keep-source")}>
                      <b>保留源稿重制</b>
                      <span>保留页序、主题和素材，按重制流程生成可编辑 PPTX</span>
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
                    <span>{intakeReadiness.ready ? "这里会先生成可确认的大纲，不会直接生成完整 PPT。" : uiZh(intakeReadiness.nextQuestion)}</span>
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
                <details className="workflow-advanced-panel workflow-agent-advanced">
                  <summary>
                    <span>高级详情 / 环境与工作流</span>
                    <small>查看服务、模型、OCR、关卡和当前任务状态。</small>
                  </summary>
                  <SkillFirstProductConsole
                    approvalSummary={noCostApprovalSummary}
                    busy={workflowBusy || generationProgress.active}
                    fileCount={fileIds.length}
                    hasBrief={Boolean(form.notes.trim() || outlinePlan?.layoutSequence?.length)}
                    job={workflowJob}
                    jobCount={workflowJobs.length}
                    onApproveNoCostGates={approveNoCostCodexGates}
                    onCreate={startSkillFirstWorkflow}
                    onOpenWorkflow={() => setActiveStep("generate")}
                    onRefresh={() => loadWorkflowJobs({ activeId: workflowJob?.id || "", restoreLatest: !workflowJob?.id })}
                    status={deriveWorkflowDeliveryStatus(workflowJob, [])}
                  />
                  <ProductReadinessPanel
                    connection={connection}
                    doctor={doctor}
                    job={workflowJob}
                    localImage={localImage}
                    status={deriveWorkflowDeliveryStatus(workflowJob, [])}
                  />
                </details>
              </div>
            </SectionCard>
          )}

          {activeStep === "outline" && (
            <SectionCard className="outline-card" title="确认大纲" desc="正式生成前，先确认页序、版式、标题和每页目标。">
              <div className="readiness">
                <Metric label="资料文件" value={fileIds.length} />
                <Metric label="自动识别素材" value={inferredMaterials.length ? `${inferredMaterials.length} 类` : "待处理"} />
                <Metric label="需求完整度" value={`${completion}%`} />
              </div>
              <div className="outline-panel">
                <div>
                  <b>大纲方案</b>
                  <span>{outlineBrief ? `${inputStrengthLabel(outlineBrief.inputStrength)} / 产品 ${outlineBrief.productCount || 0} / 价格 ${outlineBrief.priceCount || 0} / 图片 ${outlineBrief.imageCount || 0}` : "先生成页序、版式、标题和页面目标，再确认生成。"} </span>
                </div>
                <div className="button-row tight">
                  <button className="btn ghost" type="button" onClick={planOutline} disabled={outlineBusy}>{outlineBusy ? "正在生成大纲" : "重新生成大纲"}</button>
                  <button className="btn primary" type="button" onClick={() => setActiveStep("generate")} disabled={!outlinePlan?.layoutSequence?.length}>确认大纲并生成</button>
                </div>
                {outlinePlan?.layoutSequence?.length ? (
                  <div className="outline-list outline-card-list">
                    <div className="outline-digest">
                      <strong>叙事线</strong>
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
                        <div className="outline-actions" aria-label={"page " + (index + 1) + " actions"}>
                          <button type="button" title="上移页面" aria-label="上移页面" onClick={() => outlineAction(index, "move-up")} disabled={index === 0}>上移</button>
                          <button type="button" title="下移页面" aria-label="下移页面" onClick={() => outlineAction(index, "move-down")} disabled={index === outlinePlan.layoutSequence.length - 1}>下移</button>
                          <button type="button" title="在后面插入" aria-label="在后面插入" onClick={() => outlineAction(index, "insert-after")}>+</button>
                          <button type="button" title="复制页面" aria-label="复制页面" onClick={() => outlineAction(index, "duplicate")}>复制</button>
                          <button type="button" title="删除页面" aria-label="删除页面" onClick={() => outlineAction(index, "delete")} disabled={outlinePlan.layoutSequence.length <= 1}>删除</button>
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
            <>
              <DualRouteDashboard
                busy={workflowBusy || generationProgress.active}
                files={files}
                hasInput={Boolean(fileIds.length || form.notes.trim() || outlinePlan?.layoutSequence?.length)}
                job={workflowJob}
                jobs={workflowJobs}
                notes={form.notes}
                noCostApprovalSummary={noCostApprovalSummary}
                onApproveNoCostGates={approveNoCostCodexGates}
                onCreateWorkflow={startSkillFirstWorkflow}
                onNotesChange={(value) => update("notes", value)}
                onOpenArtifacts={() => document.getElementById("workflow-artifact-review-panel")?.scrollIntoView({ behavior: "smooth", block: "start" })}
                onOpenDelivery={() => setActiveStep("export")}
                onOpenEditable={() => document.getElementById("editable-page-worker-panel")?.scrollIntoView({ behavior: "smooth", block: "start" })}
                onOpenVisual={() => document.getElementById("codex-slide-worker-panel")?.scrollIntoView({ behavior: "smooth", block: "start" })}
                onRefresh={refreshWorkflowJob}
                onSelectJob={selectWorkflowJob}
                onUploadFiles={uploadFiles}
              />
            <SectionCard title="生成可编辑 PPT" desc="确认大纲、视觉方向和生成方式后，创建 PPT 重制任务并重建可编辑 PPTX。">
              <DualRouteWorkbench
                busy={workflowBusy || generationProgress.active}
                hasInput={Boolean(fileIds.length || form.notes.trim() || outlinePlan?.layoutSequence?.length)}
                job={workflowJob}
                noCostApprovalSummary={noCostApprovalSummary}
                onApproveNoCostGates={approveNoCostCodexGates}
                onCreateWorkflow={startSkillFirstWorkflow}
                onOpenArtifacts={() => document.getElementById("workflow-artifact-review-panel")?.scrollIntoView({ behavior: "smooth", block: "start" })}
                onOpenDelivery={() => setActiveStep("export")}
                onOpenEditable={() => document.getElementById("editable-page-worker-panel")?.scrollIntoView({ behavior: "smooth", block: "start" })}
                onOpenMaterials={() => setActiveStep("materials")}
                onOpenVisual={() => document.getElementById("codex-slide-worker-panel")?.scrollIntoView({ behavior: "smooth", block: "start" })}
              />
              <WorkflowUserGuidePanel
                busy={workflowBusy || generationProgress.active}
                hasInput={Boolean(fileIds.length || form.notes.trim() || outlinePlan?.layoutSequence?.length)}
                job={workflowJob}
                onCreateWorkflow={startSkillFirstWorkflow}
                onGoMaterials={() => setActiveStep("materials")}
                onGoNext={() => document.getElementById("workflow-agent-simple")?.scrollIntoView({ behavior: "smooth", block: "start" })}
              />
              <div className="readiness">
                <Metric label="资料文件" value={fileIds.length} />
                <Metric label="大纲状态" value={outlinePlan?.layoutSequence?.length ? "已确认" : "未确认"} />
                <Metric label="需求完整度" value={`${completion}%`} />
              </div>
              {generationProgress.active ? <GenerationProgress progress={generationProgress} /> : null}
              <div className="action-grid single-action">
                {workflowJob?.id ? (
                  <button className="primary-action" onClick={noCostApprovalSummary.readyCount ? approveNoCostCodexGates : () => document.getElementById("workflow-compliance-panel")?.scrollIntoView({ behavior: "smooth", block: "start" })} disabled={workflowBusy || generationProgress.active}>
                    <b>{noCostApprovalSummary.readyCount ? "确认就绪关卡（不生成图片）" : "继续当前工作流"}</b>
                    <span>{noCostApprovalSummary.readyCount ? `可无费用确认：${noCostApprovalSummary.labelText}。确认后再生成产品级样张。` : "沿用下面的引导步骤继续当前任务，不重复创建工作流。"}</span>
                  </button>
                ) : (
                  <button className="primary-action" onClick={startSkillFirstWorkflow} disabled={workflowBusy || generationProgress.active || (!fileIds.length && !form.notes.trim() && !outlinePlan?.layoutSequence?.length)}>
                    <b>{workflowBusy ? "正在创建重制任务" : "创建 PPT 重制任务"}</b>
                    <span>先确认视觉方向，再进入可编辑重建；最终文件通过交付检查后才开放下载。</span>
                  </button>
                )}
              </div>
              <details className="workflow-advanced-panel workflow-agent-advanced">
                <summary>
                  <span>高级详情 / 任务与证据</span>
                  <small>查看 worker、页面任务、产物、校验和恢复动作。</small>
                </summary>
                <WorkflowRebuildPanel
                  busy={workflowBusy}
                  files={files}
                  hasBrief={Boolean(form.notes.trim() || outlinePlan?.layoutSequence?.length)}
                  job={workflowJob}
                  jobs={workflowJobs}
                  onRefresh={refreshWorkflowJob}
                  onRefreshList={() => loadWorkflowJobs({ activeId: workflowJob?.id || "" })}
                  onRunPipeline={startSkillFirstWorkflow}
                  onRunNextAction={runWorkflowNextAction}
                  onRunStep={runWorkflowStep}
                  onSelectJob={selectWorkflowJob}
                  onToggleArchive={toggleWorkflowArchive}
                  onToggleArchivedVisibility={setWorkflowArchiveVisibility}
                  showArchived={workflowShowArchived}
                />
              </details>
            </SectionCard>
            </>
          )}

          {activeStep === "preview" && (
            <SectionCard title="复核页面证据" desc="查看源页、视觉页、可编辑重建和校验证据；必要时再进入高级修正。">
              {!job ? (
                <StageEmptyState
                  title="还没有可复核结果"
                  body="先上传资料或输入需求，完成视觉统一和可编辑重建后，这里会显示页面证据和交付预览。"
                  action="回到资料识别"
                  onAction={() => setActiveStep("materials")}
                />
              ) : (
                <>
                  <div className="skill-first-review-notice">
                    <b>复核以工作流证据为准</b>
                    <span>这里用于检查页面预览和必要修正；产品交付状态以校验证据、页面任务记录和最终 PPT 门禁为准。</span>
                  </div>
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
                  />
                </>
              )}
            </SectionCard>
          )}

          {activeStep === "export" && (
            <SectionCard title="交付文件" desc="最终只交付可编辑 PPT；图片型 PPT、校验证据和日志包作为中间产物与证据查看。">
              <WorkflowDeliveryPortal
                job={workflowJob}
                onCreateWorkflow={startSkillFirstWorkflow}
                onGoMaterials={() => setActiveStep("materials")}
                onOpenPageTasks={() => {
                  setActiveStep("generate");
                  window.setTimeout(() => document.getElementById("editable-page-worker-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }), 120);
                }}
                onOpenWorkflow={() => {
                  setActiveStep("generate");
                  window.setTimeout(() => document.getElementById("workflow-artifact-review-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }), 120);
                }}
              />
            </SectionCard>
          )}

        </main>

        {showRightPanel && (
        <aside className="right-panel">
          <div className="panel-tabs">
            <button className={visibleRightPanelMode === "agent" ? "active" : ""} type="button" onClick={() => setRightPanelMode("agent")}>助手</button>
            {rightPanelTabs.map(([id, label]) => (
              <button className={visibleRightPanelMode === id ? "active" : ""} key={id} onClick={() => setRightPanelMode(id)}>{label}</button>
            ))}
            <button className={visibleRightPanelMode === "settings" ? "active" : ""} type="button" onClick={() => setRightPanelMode("settings")}>设置</button>
          </div>
          {visibleRightPanelMode === "agent" && (
            <DirectorChatPanel
              busy={directorBusy}
              draft={directorDraft}
              files={files}
              job={job}
              messages={directorMessages}
              setDraft={setDirectorDraft}
              workflowJob={workflowJob}
              onAction={handleDirectorAction}
              onKeyDown={handleDirectorKeyDown}
              onSend={() => sendDirectorMessage()}
              onSuggestion={sendDirectorMessage}
            />
          )}
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
          {visibleRightPanelMode === "status" && (
            workflowJob ? (
              <WorkflowSideStatusPanel
                connection={connection}
                doctor={doctor}
                job={workflowJob}
                jobs={workflowJobs}
                localImage={localImage}
                onOpenWorkflow={() => setActiveStep("generate")}
                onRefresh={refreshWorkflowJob}
              />
            ) : (
              <ProductOnlyStatusPanel
                connection={connection}
                doctor={doctor}
                localImage={localImage}
                onOpenMaterials={() => setActiveStep("materials")}
                onOpenWorkflow={() => setActiveStep("generate")}
              />
            )
          )}
          {visibleRightPanelMode === "history" && (
            <WorkflowHistoryPanel
              activeId={workflowJob?.id || ""}
              busy={workflowBusy}
              jobs={workflowJobs}
              onRefresh={() => loadWorkflowJobs({ activeId: workflowJob?.id || "" })}
              onSelect={(id) => {
                setActiveStep("generate");
                selectWorkflowJob(id);
              }}
              onToggleArchive={toggleWorkflowArchive}
              onToggleArchivedVisibility={setWorkflowArchiveVisibility}
              showArchived={workflowShowArchived}
            />
          )}
          {visibleRightPanelMode === "settings" && (
            <SettingsPanel
              config={apiConfig}
              busy={settingsBusy}
              models={availableModels}
              onChange={setApiConfig}
              onSave={saveApiConfig}
              onSavePaddleOcrToken={savePaddleOcrToken}
              onTest={testApiConfig}
              onTestImage={testImageApiConfig}
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

function DualRouteDashboard({
  busy = false,
  files = [],
  hasInput = false,
  job = null,
  jobs = [],
  notes = "",
  noCostApprovalSummary = null,
  onApproveNoCostGates,
  onCreateWorkflow,
  onNotesChange,
  onOpenArtifacts,
  onOpenDelivery,
  onOpenEditable,
  onOpenVisual,
  onRefresh,
  onSelectJob,
  onUploadFiles
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const state = buildDualRouteState(job);
  const currentTitle = job?.input?.sourceOriginalName?.replace(/\.[^.]+$/, "") || job?.input?.projectName || "当前任务";
  const sourcePages = state.routeA.sourceLabel;
  const editablePages = state.routeB.editableLabel;
  const imageDeckHref = job?.id && state.routeA.imageDeckReady
    ? `/api/workflow-jobs/${encodeURIComponent(job.id)}/artifacts/image-deck?download=1`
    : "";
  const finalHref = job?.id && state.routeB.finalReady
    ? `/api/workflow-jobs/${encodeURIComponent(job.id)}/artifacts/final-pptx?download=1`
    : "";
  const primaryAction = !job?.id
    ? onCreateWorkflow
    : noCostApprovalSummary?.readyCount
      ? onApproveNoCostGates
      : state.routeA.imageDeckReady
        ? onOpenEditable
        : onOpenVisual;
  const primaryLabel = !job?.id
    ? "新建任务"
    : noCostApprovalSummary?.readyCount
      ? "确认就绪关卡"
      : state.routeA.imageDeckReady
        ? "继续转可编辑 PPT"
        : "继续生成图片版 PPT";
  const canRunPrimary = !busy && (job?.id || hasInput);
  const taskRows = uniqueWorkflowJobs([job, ...jobs]).filter(Boolean).slice(0, 5);
  const events = Array.isArray(job?.events) ? job.events.slice(-7).reverse() : [];
  const canCreateFromPanel = !busy && Boolean(files.length || notes.trim());

  return (
    <div className="dual-dashboard">
      <aside className="dual-dashboard-left">
        <button className="dual-new-task" type="button" onClick={() => setCreateOpen(true)}>+ 新建任务</button>
        <div className="dual-task-head">
          <h2>任务列表</h2>
          <div><span className="active">进行中</span><span>已完成</span><span>已失败</span></div>
        </div>
        <div className="dual-task-list">
          {taskRows.length ? taskRows.map((item) => {
            const active = item?.id && item.id === job?.id;
            const rowState = buildDualRouteState(item);
            const pages = rowState.routeA.visualLabel || workflowJobLabel(item);
            return (
              <button className={`dual-task-row ${active ? "active" : ""}`} type="button" key={item.id} onClick={() => item.id && onSelectJob?.(item.id)}>
                <b>{item.input?.sourceOriginalName?.replace(/\.[^.]+$/, "") || shortWorkflowId(item.id)}</b>
                <span>{pages} · {rowState.routeB.editableLabel} 可编辑</span>
                <em>{routeStatusLabel(rowState.routeB.status)}</em>
              </button>
            );
          }) : <p>暂无任务，先上传材料创建。</p>}
        </div>
      </aside>

      <section className="dual-dashboard-main">
        <div className="dual-task-titlebar">
          <div>
            <h1>{currentTitle}</h1>
            <span>{job?.createdAt ? `创建于 ${formatEventTime(job.createdAt)}` : "等待创建任务"} · {sourcePages}</span>
          </div>
          <button className="btn" type="button" onClick={onRefresh} disabled={!job?.id || busy}>任务详情</button>
        </div>
        <div className="dual-stage-alert">阶段交付：先完成图片版 PPT，再按需进入可编辑重建</div>
        {createOpen ? (
          <section className="dual-create-panel">
            <div className="dual-create-head">
              <div>
                <h2>新建 PPT 任务</h2>
                <span>在当前工作台完成材料上传和需求录入，不跳回旧流程。</span>
              </div>
              <button className="btn" type="button" onClick={() => setCreateOpen(false)}>收起</button>
            </div>
            <div className="dual-create-grid">
              <label className="dual-upload-box">
                <input type="file" multiple onChange={onUploadFiles} />
                <b>上传 PPT / PDF / 图片 / 文档</b>
                <span>{files.length ? `已选择 ${files.length} 个文件` : "点击选择文件，或先填写需求直接创建"}</span>
              </label>
              <label className="dual-brief-box">
                <span>任务需求</span>
                <textarea
                  value={notes}
                  onChange={(event) => onNotesChange?.(event.target.value)}
                  placeholder="例如：把这份中秋提案重做成更高级的图片版 PPT，图片版先交付，可编辑版后续再做。"
                />
              </label>
            </div>
            {files.length ? (
              <div className="dual-file-chips">
                {files.slice(0, 6).map((file) => (
                  <span key={file.id || file.originalName}><b>{fileExt(file.originalName)}</b>{file.originalName || file.id}</span>
                ))}
              </div>
            ) : null}
            <div className="dual-create-actions">
              <span>{canCreateFromPanel ? "准备就绪：会先进入图片版 PPT 生成路线。" : "请先上传材料，或填写一句任务需求。"}</span>
              <button className="btn primary" type="button" onClick={onCreateWorkflow} disabled={!canCreateFromPanel}>
                {busy ? "正在创建..." : "创建任务"}
              </button>
            </div>
          </section>
        ) : null}
        <RouteLane
          accent="visual"
          badge="路线 A"
          title="图片版 PPT"
          summary={state.routeA.summary}
          status={state.routeA.status}
          steps={state.routeA.steps}
          metrics={[
            ["源页", state.routeA.sourceLabel],
            ["图片页", state.routeA.visualLabel],
            ["图片 PPT", state.routeA.imageDeckReady ? "已组装" : "待组装"]
          ]}
          actions={[
            imageDeckHref ? { label: "下载图片版 PPT", href: imageDeckHref, primary: true } : null,
            { label: "查看问题", onClick: onOpenArtifacts, disabled: !job?.id },
            { label: state.routeA.imageDeckReady ? "查看图片页证据" : "继续图片阶段", onClick: onOpenVisual, disabled: !job?.id || busy }
          ].filter(Boolean)}
        />
        <RouteLane
          accent="editable"
          badge="路线 B"
          title="可编辑 PPT"
          summary={state.routeB.summary}
          status={state.routeB.status}
          steps={state.routeB.steps}
          metrics={[
            ["可编辑页", editablePages],
            ["人工复核", state.routeB.reviewReady ? "已记录" : "待复核"],
            ["最终交付", state.routeB.finalReady ? "可下载" : "未完成"]
          ]}
          actions={[
            finalHref ? { label: "下载可编辑 PPT", href: finalHref, primary: true } : null,
            { label: primaryLabel, onClick: primaryAction, disabled: !canRunPrimary, primary: !finalHref },
            { label: "打开交付复核", onClick: onOpenDelivery, disabled: !job?.id }
          ].filter(Boolean)}
        />
        <div className="dual-progress-overview">
          <span><b>{state.routeA.visualLabel}</b>图片页</span>
          <span><b>{editablePages}</b>可编辑页</span>
          <span><b>{state.routeB.reviewReady ? "已复核" : "待复核"}</b>人工复核</span>
          <span className={state.routeB.reviewReady ? "ready" : "warn"}><b>{state.routeB.reviewReady ? "可交付" : "完整可编辑交付未完成"}</b>最终状态</span>
        </div>
      </section>

      <aside className="dual-dashboard-right">
        <div className="dual-side-card next">
          <h2>下一步建议</h2>
          <strong>{state.nextAction}</strong>
          <ul>
            <li className={state.routeA.imageDeckReady ? "done" : "active"}>图片版已经完成，可以下载交付</li>
            <li className={state.routeB.finalReady ? "done" : "active"}>如需可编辑版，点击继续处理</li>
            <li>可编辑重建会消耗更多时间和资源</li>
          </ul>
        </div>
        <div className="dual-side-card">
          <h2>当前状态</h2>
          <p><span className="dot green" />图片版：{routeStatusLabel(state.routeA.status)}</p>
          <p><span className="dot blue" />可编辑版：{routeStatusLabel(state.routeB.status)}</p>
        </div>
        <div className="dual-side-card logs">
          <div className="dual-side-tabs"><b>日志</b><span>证据</span><span>高级诊断</span></div>
          {events.length ? events.map((event, index) => (
            <p key={`${event.type || "event"}-${index}`}>
              <span className={`dot ${index % 2 ? "blue" : "green"}`} />
              {formatEventTime(event.createdAt || event.time || event.timestamp)} {uiZh(event.message || event.type || "workflow event")}
            </p>
          )) : (
            <p><span className="dot blue" />等待任务日志</p>
          )}
          <button className="btn wide" type="button" onClick={onOpenArtifacts} disabled={!job?.id}>查看全部日志</button>
        </div>
      </aside>
    </div>
  );
}

function DualRouteWorkbench({
  busy = false,
  hasInput = false,
  job = null,
  noCostApprovalSummary = null,
  onApproveNoCostGates,
  onCreateWorkflow,
  onOpenArtifacts,
  onOpenDelivery,
  onOpenEditable,
  onOpenMaterials,
  onOpenVisual
}) {
  const state = buildDualRouteState(job);
  const canStart = hasInput && !busy;
  const canContinue = Boolean(job?.id && !busy);
  const imageDeckHref = job?.id && state.routeA.imageDeckReady
    ? `/api/workflow-jobs/${encodeURIComponent(job.id)}/artifacts/image-deck?download=1`
    : "";
  const finalHref = job?.id && state.routeB.finalReady
    ? `/api/workflow-jobs/${encodeURIComponent(job.id)}/artifacts/final-pptx?download=1`
    : "";
  const primaryActionLabel = !job?.id
    ? "创建图片版 PPT 任务"
    : noCostApprovalSummary?.readyCount
      ? "确认就绪关卡"
      : state.routeA.imageDeckReady
        ? "继续转可编辑 PPT"
        : "继续生成图片版 PPT";
  const primaryAction = !job?.id
    ? onCreateWorkflow
    : noCostApprovalSummary?.readyCount
      ? onApproveNoCostGates
      : state.routeA.imageDeckReady
        ? onOpenEditable
        : onOpenVisual;
  const primaryDisabled = !job?.id ? !canStart : !canContinue;

  return (
    <div className="dual-route-workbench">
      <div className="dual-route-hero">
        <div>
          <span>阶段交付</span>
          <h2>先完成图片版 PPT，再按需进入可编辑重建</h2>
          <p>{state.message}</p>
        </div>
        <div className="dual-route-actions">
          <button className="btn primary" type="button" onClick={primaryAction} disabled={primaryDisabled}>
            {busy ? "处理中..." : primaryActionLabel}
          </button>
          {imageDeckHref ? <a className="btn" href={imageDeckHref}>下载图片版 PPT</a> : null}
          {finalHref ? <a className="btn" href={finalHref}>下载可编辑 PPT</a> : null}
          {!job?.id ? <button className="btn ghost" type="button" onClick={onOpenMaterials}>补充材料</button> : null}
        </div>
      </div>

      <div className="dual-route-grid">
        <RouteLane
          accent="visual"
          badge="路线 A"
          title="图片版 PPT"
          summary={state.routeA.summary}
          status={state.routeA.status}
          steps={state.routeA.steps}
          metrics={[
            ["源页", state.routeA.sourceLabel],
            ["图片页", state.routeA.visualLabel],
            ["图片 PPT", state.routeA.imageDeckReady ? "已组装" : "待组装"]
          ]}
          actions={[
            imageDeckHref ? { label: "下载图片版 PPT", href: imageDeckHref, primary: true } : null,
            { label: state.routeA.imageDeckReady ? "查看图片页证据" : "继续图片阶段", onClick: onOpenVisual, disabled: !job?.id || busy },
            { label: "查看问题", onClick: onOpenArtifacts, disabled: !job?.id }
          ].filter(Boolean)}
        />
        <RouteLane
          accent="editable"
          badge="路线 B"
          title="可编辑 PPT"
          summary={state.routeB.summary}
          status={state.routeB.status}
          steps={state.routeB.steps}
          metrics={[
            ["可编辑页", state.routeB.editableLabel],
            ["人工复核", state.routeB.reviewReady ? "已记录" : "待复核"],
            ["最终交付", state.routeB.finalReady ? "可下载" : "未完成"]
          ]}
          actions={[
            finalHref ? { label: "下载可编辑 PPT", href: finalHref, primary: true } : null,
            { label: state.routeA.imageDeckReady ? "继续转可编辑 PPT" : "等待图片版完成", onClick: onOpenEditable, disabled: !state.routeA.imageDeckReady || busy },
            { label: "打开交付复核", onClick: onOpenDelivery, disabled: !job?.id }
          ].filter(Boolean)}
        />
      </div>

      <div className="dual-route-next">
        <div>
          <b>下一步建议</b>
          <span>{state.nextAction}</span>
        </div>
        <div>
          <b>当前任务</b>
          <span>{job?.input?.sourceOriginalName || job?.input?.sourceBrief || "先上传材料或输入需求"}</span>
        </div>
        <div>
          <b>高级信息</b>
          <span>worker、provider、artifact 和日志继续保留在下方高级诊断区。</span>
        </div>
      </div>
    </div>
  );
}

function RouteLane({ accent = "visual", actions = [], badge, metrics = [], status = "pending", steps = [], summary, title }) {
  const primaryAction = actions.find((action) => action.primary) || actions[0];
  const secondaryActions = actions.filter((action) => action !== primaryAction);
  const completionMetric = metrics[1] || metrics[0] || ["进度", "-"];
  const completionTitle = accent === "visual" && status === "ready"
    ? "图片版 PPT 已完成"
    : accent === "editable" && status === "ready"
      ? "可编辑 PPT 已完成"
      : accent === "editable"
        ? "可编辑重建尚未开始"
        : "图片版 PPT 生成中";
  return (
    <section className={`route-lane ${accent} ${status}`}>
      <div className="route-lane-head">
        <span className="route-icon" aria-hidden="true">
          {accent === "visual" ? (
            <svg viewBox="0 0 24 24"><path d="M5 5h14v14H5V5Zm2 2v10h10V7H7Zm1.5 8 2.8-3.2 2 2.2 1.2-1.3L17 15H8.5Zm1.2-5.4a1.4 1.4 0 1 1 2.8 0 1.4 1.4 0 0 1-2.8 0Z" /></svg>
          ) : (
            <svg viewBox="0 0 24 24"><path d="M6 4h12v16H6V4Zm2 2v12h8V6H8Zm1.5 2.5h5v1.6h-5V8.5Zm0 3.2h5v1.6h-5v-1.6Zm0 3.2h3.2v1.6H9.5v-1.6Z" /></svg>
          )}
        </span>
        <div>
          <span>{badge}</span>
          <h3>{title} <em>{routeStatusLabel(status)}</em></h3>
          <p>{summary}</p>
        </div>
      </div>
      <div className="route-stepper">
        {steps.map((step, index) => (
          <div className={`route-step ${step.state}`} key={step.label}>
            <i>{String(index + 1).padStart(2, "0")}</i>
            <span>{step.label}</span>
            <small>{step.detail}</small>
          </div>
        ))}
      </div>
      <div className="route-completion">
        <div>
          <b>{completionTitle}</b>
          <span>当前为 {completionMetric[1]} {completionMetric[0]}</span>
        </div>
        <div className="route-actions">
          {secondaryActions.map((action) => action.href ? (
            <a className="btn" href={action.href} key={action.label}>{action.label}</a>
          ) : (
            <button className="btn" type="button" onClick={action.onClick} disabled={action.disabled} key={action.label}>
              {action.label}
            </button>
          ))}
          {primaryAction ? primaryAction.href ? (
            <a className="btn primary" href={primaryAction.href}>{primaryAction.label}</a>
          ) : (
            <button className="btn primary" type="button" onClick={primaryAction.onClick} disabled={primaryAction.disabled}>
              {primaryAction.label}
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function buildDualRouteState(job = null) {
  const artifacts = job?.artifacts || {};
  const sourcePages = artifactCountNumber(artifacts.renderedPages || artifacts.sourcePages || artifacts.source);
  const visualPages = artifactCountNumber(artifacts.visualImages);
  const codexTasks = Array.isArray(job?.codexPptSlideTasks?.tasks) ? job.codexPptSlideTasks.tasks : [];
  const recordedVisualPages = codexTasks.filter((task) => task.status === "recorded").length;
  const imagePageCount = Math.max(visualPages, recordedVisualPages);
  const expectedPages = Number(
    job?.input?.sourcePageCount
    || artifacts.source?.pageCount
    || artifacts.ocrTextHints?.pageCount
    || artifacts.editableFinal?.summary?.expectedPages
    || sourcePages
    || imagePageCount
    || 0
  );
  const imageDeckReady = Boolean(artifacts.imageDeck?.path || artifacts.imageDeck?.relativePath);
  const editableTasks = Array.isArray(job?.editableWorkerTasks?.tasks) ? job.editableWorkerTasks.tasks : [];
  const recordedEditablePages = editableTasks.filter((task) => task.status === "recorded").length
    || Number(artifacts.pageEvidence?.summary?.readyPages || artifacts.editableFinal?.summary?.recordedPages || 0);
  const finalPages = Number(artifacts.editableFinal?.summary?.page_count || artifacts.editableFinal?.pptxEditability?.slideCount || 0);
  const finalReady = Boolean(artifacts.editableFinal?.path && (!expectedPages || finalPages >= expectedPages));
  const reviewReady = artifacts.manualReview?.status === "approved";
  const routeAReady = Boolean(imageDeckReady);
  const routeBStarted = Boolean(recordedEditablePages || finalPages || artifacts.editableRun);
  const routeBReady = Boolean(finalReady && reviewReady);
  const routeAStatus = routeAReady ? "ready" : job?.id ? "active" : "pending";
  const routeBStatus = routeBReady ? "ready" : routeBStarted ? "active" : routeAReady ? "optional" : "locked";
  const imageTotal = expectedPages || imagePageCount || sourcePages || 0;
  const editableTotal = expectedPages || editableTasks.length || finalPages || 0;

  return {
    message: imageDeckReady
      ? `图片版 PPT 已形成阶段交付；可继续进入可编辑重建。当前可编辑进度 ${formatProgress(recordedEditablePages || finalPages, editableTotal)}。`
      : job?.id
        ? "当前先推进图片版 PPT。完成图片页和图片型 PPT 后，再决定是否转成可编辑 PPT。"
        : "上传材料后先创建图片版 PPT 任务，可编辑重建作为第二阶段按需开启。",
    nextAction: !job?.id
      ? "先上传材料并创建图片版 PPT 任务。"
      : !imageDeckReady
        ? "优先完成路线 A：生成视觉页面并组装图片版 PPT。"
        : !routeBReady
          ? "图片版已可作为阶段交付；如需要对象级编辑，再继续路线 B。"
          : "可编辑 PPT 已完成交付门禁，可进入下载与复核。",
    routeA: {
      status: routeAStatus,
      imageDeckReady,
      sourceLabel: sourcePages ? `${sourcePages} 页` : "待解析",
      visualLabel: imageTotal ? formatProgress(imagePageCount, imageTotal) : imagePageCount ? `${imagePageCount} 页` : "待生成",
      summary: imageDeckReady
        ? "图片版 PPT 已组装，可先下载交付或作为可编辑重建输入。"
        : "先把源稿重绘成视觉统一的图片页面，再组装成图片型 PPT。",
      steps: [
        { label: "上传材料", detail: sourcePages ? "材料已上传完成" : "等待材料", state: job?.id || sourcePages ? "done" : "pending" },
        { label: "生成视觉页面", detail: imageTotal ? `${formatProgress(imagePageCount, imageTotal)} 页已完成` : "等待生成", state: imagePageCount ? (imageTotal && imagePageCount >= imageTotal ? "done" : "active") : job?.id ? "active" : "pending" },
        { label: "组装图片 PPT", detail: imageDeckReady ? "PPT 已组装完成" : "等待组装", state: imageDeckReady ? "done" : imagePageCount ? "active" : "pending" },
        { label: "下载图片版", detail: imageDeckReady ? "可下载交付物" : "等待交付", state: imageDeckReady ? "done" : "pending" }
      ]
    },
    routeB: {
      status: routeBStatus,
      finalReady,
      reviewReady,
      editableLabel: editableTotal ? formatProgress(recordedEditablePages || finalPages, editableTotal) : routeBStarted ? `${recordedEditablePages || finalPages} 页` : "未开始",
      summary: routeAReady
        ? "按需进入 OCR、页面理解和逐页对象级重建；完整交付仍需人工复核。"
        : "等待图片版 PPT 完成后再开启，避免把两套 Skill 混成黑盒。",
      steps: [
        { label: "选择图片版", detail: imageDeckReady ? "选择已完成的图片版" : "等待图片版", state: imageDeckReady ? "done" : "locked" },
        { label: "OCR / 页面理解", detail: artifacts.ocrTextHints?.path || artifacts.editableHints?.summary ? "识别文字与版式" : "等待识别", state: artifacts.ocrTextHints?.path || artifacts.editableHints?.summary ? "done" : imageDeckReady ? "active" : "locked" },
        { label: "逐页重建", detail: editableTotal ? `${formatProgress(recordedEditablePages || finalPages, editableTotal)} 可编辑页` : "重建为可编辑元素", state: recordedEditablePages || finalPages ? (editableTotal && (recordedEditablePages || finalPages) >= editableTotal ? "done" : "active") : imageDeckReady ? "pending" : "locked" },
        { label: "人工复核", detail: reviewReady ? "校对与调整内容" : "等待人工复核", state: reviewReady ? "done" : finalPages ? "active" : "pending" },
        { label: "下载可编辑版", detail: finalReady ? "生成可编辑 PPT" : "等待最终交付", state: finalReady ? "done" : "pending" }
      ]
    }
  };
}

function formatProgress(done = 0, total = 0) {
  const current = Math.max(0, Number(done || 0));
  const max = Math.max(0, Number(total || 0));
  return max ? `${Math.min(current, max)}/${max}` : `${current}`;
}

function routeStatusLabel(status = "") {
  if (status === "ready") return "已完成";
  if (status === "active") return "进行中";
  if (status === "optional") return "可选继续";
  if (status === "locked") return "等待前置";
  return "待开始";
}

function WorkflowStrip({ activeStep, completion, rightPanelMode, setActiveStep, setRightPanelMode, stepState }) {
  const currentStep = STEPS.find((step) => step.id === activeStep);
  return (
    <div className="workflow-strip">
      <div className="workflow-current">
        <span>{"\u5f53\u524d\u9636\u6bb5"}</span>
        <b>{currentStep?.title || "\u5de5\u4f5c\u53f0"}</b>
        <em><i style={{ width: `${completion}%` }} /></em>
      </div>
      <div className="workflow-steps">
        {STEPS.map((step, index, list) => (
          <button className={activeStep === step.id ? "active" : ""} type="button" key={step.id} onClick={() => setActiveStep(step.id)}>
            <strong>{step.title}</strong>
            <span>{stepState[step.id]}</span>
            {index < list.length - 1 ? <i /> : null}
          </button>
        ))}
      </div>
      <button className="workflow-settings" type="button" onClick={() => setRightPanelMode(rightPanelMode === "settings" ? "history" : "settings")}>{"\u8bbe\u7f6e"}</button>
    </div>
  );
}

function WorkflowPrimaryJobNotice({ currentJob = null, onOpenDelivery, onOpenPrimary, primaryWorkflow = null }) {
  if (!primaryWorkflow?.id) return null;
  const currentIsPrimary = currentJob?.id === primaryWorkflow.id;
  const primaryFound = primaryWorkflow.found !== false;
  const sourceName = primaryWorkflow.sourceName || "主验收任务未找到";
  const currentSourceName = currentJob?.input?.sourceOriginalName || currentJob?.artifacts?.source?.originalName || currentJob?.title || currentJob?.id || "未选择任务";
  const sourcePages = Number(primaryWorkflow.sourcePages || 0);
  const finalPages = Number(primaryWorkflow.finalPages || 0);
  const recordedEditablePages = Number(primaryWorkflow.recordedEditablePages || 0);
  const deliveryHint = primaryWorkflow.deliveryHint || "请打开交付复核查看当前状态。";
  const deliveryLabel = primaryWorkflow.deliveryLevel === "needs-delivery-review"
    ? "等待交付复核"
    : primaryWorkflow.deliveryLevel === "sample-draft"
      ? "小样本草稿"
      : primaryWorkflow.deliveryLevel === "editable-pages-recorded"
        ? "待合成 final"
        : primaryWorkflow.deliveryLevel === "not-finalized"
          ? "未生成 final"
          : "待检查";
  const completedLabel = sourcePages ? `${recordedEditablePages}/${sourcePages}` : recordedEditablePages || "未记录";
  const isSample = Boolean(primaryWorkflow.isSample || (sourcePages && finalPages && finalPages < sourcePages));
  const finalLabel = finalPages && sourcePages ? `${finalPages}/${sourcePages}` : finalPages || "未生成";
  const sampleLabel = isSample
    ? `小样本：final 还差 ${Math.max(0, sourcePages - finalPages)} 页`
    : "全量任务";
  const noticeTitle = !primaryFound
    ? "主验收任务未找到"
    : currentIsPrimary
    ? `当前主验收任务：${finalLabel} final，${deliveryLabel}`
    : "当前不是主验收任务";
  const noticeText = !primaryFound
    ? `配置的主验收任务 ${shortWorkflowId(primaryWorkflow.id)} 不在当前工作区。`
    : currentIsPrimary
    ? "这里显示的是当前产品级验收样本，后续判断以这个任务为准。"
    : `你现在打开的是其他任务；主验收任务是 ${sourceName}。`;
  return (
    <section className={`workflow-primary-notice ${currentIsPrimary && primaryFound ? "active" : "mismatch"}`}>
      <div>
        <b>{noticeTitle}</b>
        <span>{noticeText}</span>
      </div>
      <div className="workflow-primary-notice-facts">
        <span><b>{sourceName}</b>文件</span>
        <span><b>{shortWorkflowId(primaryWorkflow.id)}</b>job id</span>
        <span><b>{sourcePages || "未知"}</b>源页数</span>
        <span><b>{completedLabel}</b>已完成可编辑页</span>
        <span><b>{finalLabel}</b>当前 final</span>
        <span><b>{deliveryLabel}</b>交付状态</span>
        <span><b>{sampleLabel}</b>当前范围</span>
        <span><b>{currentSourceName}</b>正在查看</span>
      </div>
      {!currentIsPrimary && primaryFound ? (
        <button className="btn primary" type="button" onClick={onOpenPrimary} disabled={!onOpenPrimary}>
          切换到主验收任务
        </button>
      ) : null}
      {currentIsPrimary && primaryFound ? (
        <div className="workflow-primary-notice-actions">
          <span>{deliveryHint}</span>
          <button className="btn primary" type="button" onClick={onOpenDelivery} disabled={!onOpenDelivery}>
            查看交付复核
          </button>
        </div>
      ) : null}
    </section>
  );
}

function SkillFirstProductConsole({ approvalSummary = null, busy, fileCount = 0, hasBrief = false, job = null, jobCount = 0, onApproveNoCostGates, onCreate, onOpenWorkflow, onRefresh, onRefreshStyleEvidence, status, styleRefreshAction = null, styleRefreshBusy = false }) {
  const hasInput = fileCount > 0 || hasBrief;
  const workflowHasSource = Boolean(job?.artifacts?.source || job?.input?.sourceOriginalName || job?.input?.sourceBrief);
  const sourceCount = fileCount || (workflowHasSource ? 1 : 0);
  const flowStatus = status || deriveWorkflowDeliveryStatus(job, []);
  const activeLabel = job?.id ? workflowJobLabel(job) : "未选择工作流";
  const currentStage = job?.currentStage || job?.status || "not_started";
  const finalPath = job?.artifacts?.editableFinal?.path || "";
  const finalReady = workflowDeliveryFact({ delivery: flowStatus, finalPath }).state === "ready";
  const steps = [
    { key: "source", title: "输入", state: hasInput || workflowHasSource ? "ready" : "waiting" },
    { key: "codex", title: "视觉统一", state: job?.artifacts?.visualImages?.length || job?.artifacts?.imageDeck ? "ready" : job?.id ? "working" : "waiting" },
    { key: "editable", title: "可编辑重建", state: job?.artifacts?.editableRun ? "ready" : job?.id ? "working" : "waiting" },
    { key: "workers", title: "逐页重建", state: job?.artifacts?.editableWorkerPrompts?.length ? "ready" : job?.id ? "working" : "waiting" },
    { key: "final", title: "最终 PPTX", state: finalReady ? "ready" : "waiting" }
  ];

  return (
    <div className="skill-first-console">
      <div className="skill-first-console-head">
        <div>
          <b>PPT 智能重制流程</b>
          <span>先把源稿统一成新的视觉版本，再重建为可编辑 PPTX。</span>
        </div>
        <div className={`skill-first-status ${flowStatus.level || "pending"}`}>
          <strong>{uiZh(flowStatus.title || "交付状态")}</strong>
          <span>{uiZh(flowStatus.summary || "等待工作流")}</span>
        </div>
      </div>
      <div className="skill-first-flow">
        {steps.map((step, index) => (
          <div className={`skill-first-flow-step ${step.state}`} key={step.key}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <b>{step.title}</b>
            <small>{uiZh(step.state)}</small>
          </div>
        ))}
      </div>
      <div className="skill-first-console-meta">
        <Metric label="源文件" value={sourceCount} />
        <Metric label="工作流" value={jobCount} />
        <Metric label="当前阶段" value={uiZh(currentStage)} />
        <Metric label="当前工作流" value={activeLabel} />
      </div>
      {job?.id && styleRefreshAction ? (
        <div className="skill-first-next-card style-refresh">
          <div>
            <b>下一步：刷新风格证据</b>
            <span>当前视觉风格证据仍带旧模板调性，先刷新为 PPT 重制任务证据。</span>
            <small>{uiZh(styleRefreshAction.detail || "这一步只更新本地证据，不生成图片，也不调用外部图片 API。")}</small>
          </div>
          <button className="btn primary" type="button" onClick={onRefreshStyleEvidence} disabled={busy || styleRefreshBusy || !onRefreshStyleEvidence}>
            {styleRefreshBusy ? "正在刷新..." : "刷新风格证据"}
          </button>
        </div>
      ) : job?.id && approvalSummary?.readyCount ? (
        <div className="skill-first-next-card no-cost">
          <div>
            <b>下一步：无费用确认</b>
            <span>可无费用确认：{approvalSummary.labelText}。这一步只记录任务证据，不生成图片。</span>
            <small>生成样张和全量图片前，会单独要求外部图片 API 授权。</small>
          </div>
          <button className="btn primary" type="button" onClick={onApproveNoCostGates} disabled={busy}>
            确认这些关卡
          </button>
        </div>
      ) : null}
      <div className="skill-first-console-actions">
        {job?.id ? (
          <>
            <button className="btn primary" type="button" onClick={onOpenWorkflow}>
              继续工作流
            </button>
            <button className="btn ghost" type="button" onClick={onCreate} disabled={busy || !hasInput}>
              {busy ? "处理中..." : "创建新工作流"}
            </button>
          </>
        ) : (
          <>
            <button className="btn primary" type="button" onClick={onCreate} disabled={busy || !hasInput}>
              {busy ? "处理中..." : "创建 PPT 重制任务"}
            </button>
            <button className="btn ghost" type="button" onClick={onOpenWorkflow}>
              打开工作流控制台
            </button>
          </>
        )}
        <button className="btn ghost" type="button" onClick={onRefresh} disabled={busy}>
          刷新工作流
        </button>
      </div>
      {!hasInput ? (
        <p className="skill-first-console-note">
          {job?.id
            ? "已恢复当前工作流。打开工作流控制台继续；只有创建新工作流时才需要重新上传文件或输入需求。"
            : "创建产品级工作流前，请上传 PPT/PDF/图片或提交需求简述。"}
        </p>
      ) : null}
    </div>
  );
}

function formatOcrProviderDetail(check = null, provider = {}) {
  const details = check?.details || {};
  const primary = details.provider || provider?.provider || "";
  const fallback = details.fallbackProvider || provider?.fallbackProvider || "";
  const probe = details.probe || {};
  if (primary && fallback && fallback !== primary) {
    const suffix = probe.primaryReady === false && probe.fallbackReady ? "（当前使用兜底）" : "";
    return `${primary}，兜底 ${fallback}${suffix}`;
  }
  return check?.message || primary || "";
}

function ProductReadinessPanel({ connection, doctor, job = null, localImage, status }) {
  const providers = connection?.details?.providers || {};
  const artifacts = job?.artifacts || {};
  const doctorChecks = Array.isArray(doctor?.details?.checks) ? doctor.details.checks : [];
  const doctorCheckById = new Map(doctorChecks.map((check) => [check.id, check]));
  const ocrDoctorCheck = doctorCheckById.get("ocr-provider") || null;
  const imageEditDoctorCheck = doctorCheckById.get("image-edit-provider") || null;
  const failedDoctorChecks = doctorChecks.filter((check) => !check.ok);
  const visibleDoctorChecks = doctorChecks.filter((check) => [
    "node",
    "workflow-root",
    "llm-provider",
    "image-provider",
    "image-edit-provider",
    "ocr-provider",
    "editppt",
    "image-to-editable-contract",
    "powerpoint",
    "pdf-renderer"
  ].includes(check.id));
  const checks = [
    {
      id: "service",
      label: "本地服务",
      value: connection?.state === "online" ? "在线" : "离线",
      state: connection?.state === "online" ? "ready" : "blocked",
      detail: connection?.details?.version ? `v${connection.details.version}` : connection?.message || "等待服务"
    },
    {
      id: "llm",
      label: "对话模型",
      value: providers.llm?.configured ? "已配置" : "缺失",
      state: providers.llm?.configured ? "ready" : "blocked",
      detail: providers.llm?.model || "请设置 API Key 和对话模型"
    },
    {
      id: "image",
      label: "图片 API",
      value: providers.image?.configured && providers.image?.enabled ? "已配置" : "必需",
      state: providers.image?.configured && providers.image?.enabled ? "ready" : "blocked",
      detail: providers.image?.model || "codex-ppt 视觉页生成必需"
    },
    {
      id: "image-edit",
      label: "参考图重绘",
      value: imageEditDoctorCheck ? (imageEditDoctorCheck.ok ? "可用" : "需处理") : providers.image?.supportsImageEdit ? "可用" : "需处理",
      state: imageEditDoctorCheck ? (imageEditDoctorCheck.ok ? "ready" : "blocked") : providers.image?.supportsImageEdit ? "ready" : "blocked",
      detail: imageEditDoctorCheck?.message || providers.image?.editEndpoint || "产品样张需要源页参考图重绘"
    },
    {
      id: "ocr",
      label: "OCR",
      value: ocrDoctorCheck ? (ocrDoctorCheck.ok ? "可用" : "需处理") : providers.ocr?.enabled ? "检查中" : "可选",
      state: ocrDoctorCheck ? (ocrDoctorCheck.ok ? "ready" : "blocked") : providers.ocr?.enabled ? "working" : "pending",
      detail: formatOcrProviderDetail(ocrDoctorCheck, providers.ocr) || localImage?.details?.provider || "用于可编辑重建的文字提示"
    },
    {
      id: "codex",
      label: "codex-ppt",
      value: artifacts.imageDeck ? "图片型 PPT" : artifacts.visualSample ? "样张就绪" : job?.id ? "工作流中" : "未开始",
      state: artifacts.imageDeck || artifacts.visualSample ? "ready" : job?.id ? "working" : "pending",
      detail: artifacts.imageDeck ? shortPath(artifacts.imageDeck.relativePath || artifacts.imageDeck.path) : "大纲、风格、后端、样张、全量确认关卡"
    },
    {
      id: "editable",
      label: "可编辑 PPT",
      value: artifacts.editableFinal?.path ? "最终文件就绪" : artifacts.editableRun ? "重建阶段" : "未就绪",
      state: artifacts.editableFinal?.path ? "ready" : artifacts.editableRun ? "working" : "pending",
      detail: artifacts.editableFinal?.path ? shortPath(artifacts.editableFinal.path) : "image-to-editable-ppt/editppt 重建"
    }
  ];
  const readyCount = checks.filter((item) => item.state === "ready").length;
  const blockedCount = checks.filter((item) => item.state === "blocked").length;
  const overallState = blockedCount ? "blocked" : readyCount === checks.length ? "ready" : job?.id ? "working" : "pending";
  const overallLabel = overallState === "ready" ? "产品链路就绪" : overallState === "blocked" ? "需要配置" : overallState === "working" ? "工作流进行中" : "可以开始";
  const nextAction = uiZh(status?.summary || (job?.id ? "打开工作流控制台，按推荐下一步继续。" : "上传 PPT/PDF/图片或输入需求简述，然后创建 PPT 重制任务。"));

  return (
    <div className={`product-readiness-panel ${overallState}`}>
      <div className="product-readiness-head">
        <div>
          <b>产品就绪度</b>
          <span>codex-ppt 到可编辑 PPT 管线的实时状态。</span>
        </div>
        <div>
          <strong>{overallLabel}</strong>
          <small>{readyCount}/{checks.length} 就绪</small>
        </div>
      </div>
      <div className="product-readiness-grid">
        {checks.map((item) => (
          <div className={`product-readiness-card ${item.state}`} key={item.id}>
            <span>{uiZh(item.label)}</span>
            <b>{uiZh(item.value)}</b>
            <small title={uiZh(item.detail)}>{uiZh(item.detail)}</small>
          </div>
        ))}
      </div>
      <div className="product-readiness-next">
        <span>下一步</span>
        <b>{nextAction}</b>
      </div>
      <div className={`product-doctor-strip ${doctor?.state || "checking"}`}>
        <div>
          <span>环境检查</span>
          <b>{uiZh(doctor?.message || "正在检查产品运行环境...")}</b>
        </div>
        <small>{doctorChecks.length ? `${doctorChecks.length - failedDoctorChecks.length}/${doctorChecks.length} 项通过` : "等待中"}</small>
      </div>
      {visibleDoctorChecks.length ? (
        <div className="product-doctor-grid">
          {visibleDoctorChecks.map((check) => (
            <div className={check.ok ? "pass" : "fail"} key={check.id}>
              <span>{uiZh(check.label)}</span>
              <b>{check.ok ? "通过" : "失败"}</b>
              <small title={uiZh(check.message)}>{uiZh(check.message || "-")}</small>
              {!check.ok && check.nextAction ? <em title={uiZh(check.nextAction)}>{uiZh(check.nextAction)}</em> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function WorkflowRebuildPanel({ busy, files = [], hasBrief = false, job, jobs = [], onRefresh, onRefreshList, onRunNextAction, onRunPipeline, onRunStep, onSelectJob, onToggleArchive, onToggleArchivedVisibility, showArchived = false }) {
  const sourceName = files[0]?.originalName
    || job?.input?.sourceOriginalName
    || (job?.input?.sourceBrief ? "需求简述 / 大纲来源" : "")
    || job?.artifacts?.source?.originalName
    || shortPath(job?.artifacts?.source?.relativePath || job?.artifacts?.source?.path)
    || (hasBrief ? "需求简述 / 大纲来源" : "未选择来源");
  const stages = workflowStageRows(job);
  const artifacts = job?.artifacts || {};
  const workflowAcceptanceSourceName = job?.artifacts?.source?.originalName || job?.input?.sourceOriginalName || "";
  const canUseWorkflowAcceptanceSource = Boolean(job?.id && /\.pptx$/i.test(workflowAcceptanceSourceName || job?.artifacts?.source?.path || ""));
  const promptCount = Array.isArray(artifacts.editableWorkerPrompts) ? artifacts.editableWorkerPrompts.length : 0;
  const nextStage = artifacts.editableNext?.next?.stage || artifacts.editableRun?.next?.stage || "";
  const finalPath = artifacts.editableFinal?.path || "";
  const hasWorkflowInput = files.length > 0 || hasBrief;
  const {
    acceptOfflineTextHints,
    agentId,
    claimWorkerTask,
    confirmSpawned,
    promptError,
    promptLoading,
    prompts,
    runWorkerAction,
    selectedPageId,
    selectedPrompt,
    selectedTask,
    setAcceptOfflineTextHints,
    setAgentId,
    setConfirmSpawned,
    setSelectedPageId,
    syncWorkerTasks,
    loadPrompts,
    loadWorkerTasks,
    loadWorkerRuns,
    loadWorkerBatchPreflight,
    buildWorkerBriefs,
    startWorkerBatch,
    resetSelectedWorkerTask,
    workerTaskBundle,
    workerBatchPreflightBundle,
    workerRunBundle,
    workerTasks
  } = useWorkflowWorkerConsole({ job, promptCount, onRefresh, onRunStep });
  const [deliveryBundle, setDeliveryBundle] = useState(null);
  const [artifactBundle, setArtifactBundle] = useState(null);
  const [complianceBundle, setComplianceBundle] = useState(null);
  const [costBundle, setCostBundle] = useState(null);
  const [authorizationBundle, setAuthorizationBundle] = useState(null);
  const [v1ReadinessBundle, setV1ReadinessBundle] = useState(null);
  const [v1AcceptanceReport, setV1AcceptanceReport] = useState(null);
  const [v1AcceptanceRun, setV1AcceptanceRun] = useState(null);
  const [v1AcceptanceSourcePath, setV1AcceptanceSourcePath] = useState("");
  const [v1AcceptanceRunBusy, setV1AcceptanceRunBusy] = useState(false);
  const [v1AcceptanceRunMessage, setV1AcceptanceRunMessage] = useState("");
  const [v1AcceptancePreflight, setV1AcceptancePreflight] = useState(null);
  const [v1AcceptancePreflightBusy, setV1AcceptancePreflightBusy] = useState(false);
  const [productVisualReadiness, setProductVisualReadiness] = useState(null);
  const [productVisualReadinessBusy, setProductVisualReadinessBusy] = useState(false);
  const [productVisualReadinessMessage, setProductVisualReadinessMessage] = useState("");
  const [productVisualSamplePreflight, setProductVisualSamplePreflight] = useState(null);
  const [productVisualSamplePreflightBusy, setProductVisualSamplePreflightBusy] = useState(false);
  const [productVisualSamplePreflightMessage, setProductVisualSamplePreflightMessage] = useState("");
  const [productVisualSamplePromptPreview, setProductVisualSamplePromptPreview] = useState(null);
  const [productVisualSamplePromptPreviewBusy, setProductVisualSamplePromptPreviewBusy] = useState(false);
  const [productVisualSamplePromptPreviewMessage, setProductVisualSamplePromptPreviewMessage] = useState("");
  const [productVisualSampleRunResult, setProductVisualSampleRunResult] = useState(null);
  const [productVisualSampleRunBusy, setProductVisualSampleRunBusy] = useState(false);
  const [productVisualSampleRunMessage, setProductVisualSampleRunMessage] = useState("");
  const [productVisualSampleApprovalPreflight, setProductVisualSampleApprovalPreflight] = useState(null);
  const [productVisualSampleApprovalBusy, setProductVisualSampleApprovalBusy] = useState(false);
  const [productVisualSampleApprovalMessage, setProductVisualSampleApprovalMessage] = useState("");
  const [productVisualFullDeckPreflight, setProductVisualFullDeckPreflight] = useState(null);
  const [productVisualFullDeckPreflightBusy, setProductVisualFullDeckPreflightBusy] = useState(false);
  const [productVisualFullDeckPreflightMessage, setProductVisualFullDeckPreflightMessage] = useState("");
  const [productVisualFullDeckApprovalPreflight, setProductVisualFullDeckApprovalPreflight] = useState(null);
  const [productVisualFullDeckApprovalBusy, setProductVisualFullDeckApprovalBusy] = useState(false);
  const [productVisualFullDeckApprovalMessage, setProductVisualFullDeckApprovalMessage] = useState("");
  const [productVisualFullDeckRunResult, setProductVisualFullDeckRunResult] = useState(null);
  const [productVisualFullDeckRunBusy, setProductVisualFullDeckRunBusy] = useState(false);
  const [productVisualFullDeckRunMessage, setProductVisualFullDeckRunMessage] = useState("");
  const [editablePreparePreflight, setEditablePreparePreflight] = useState(null);
  const [editablePreparePreflightBusy, setEditablePreparePreflightBusy] = useState(false);
  const [editablePreparePreflightMessage, setEditablePreparePreflightMessage] = useState("");
  const [pageSpecProviderProbe, setPageSpecProviderProbe] = useState(null);
  const [pageSpecProviderProbeBusy, setPageSpecProviderProbeBusy] = useState(false);
  const [pageSpecProviderProbeMessage, setPageSpecProviderProbeMessage] = useState("");
  const latestProductVisualNext = v1AcceptanceReport?.latest?.productVisualNext
    || v1AcceptanceReport?.latest?.acceptance?.productVisualNext
    || v1AcceptanceReport?.productVisualNext
    || v1AcceptanceReport?.acceptance?.productVisualNext
    || {};
  const productVisualTargetPages = clamp(Number(latestProductVisualNext.targetPages || 15), 1, 50);
  const [productVisualFullDeckMode, setProductVisualFullDeckMode] = useState("test");
  const [productVisualFullDeckPages, setProductVisualFullDeckPages] = useState("1,2");
  const productVisualFullDeckCustomPages = productVisualFullDeckPages.trim();
  const productVisualFullDeckPageSelection = parsePageSelectionInput(productVisualFullDeckCustomPages, productVisualTargetPages);
  const productVisualFullDeckCustomCount = productVisualFullDeckPageSelection.count;
  const productVisualFullDeckCustomValid = productVisualFullDeckMode !== "custom" || productVisualFullDeckPageSelection.valid;
  const productVisualFullDeckTargetPages = productVisualFullDeckMode === "test"
    ? Math.min(2, productVisualTargetPages)
    : productVisualFullDeckMode === "custom"
      ? productVisualFullDeckCustomCount
      : productVisualTargetPages;
  const productVisualFullDeckRequestBody = {
    maxPages: productVisualFullDeckTargetPages,
    ...(productVisualFullDeckMode === "custom" ? { pages: productVisualFullDeckCustomPages || "1,2" } : {})
  };
  const [eventsBundle, setEventsBundle] = useState(null);
  const [codexSlideBundle, setCodexSlideBundle] = useState(null);
  const [codexSlideLoading, setCodexSlideLoading] = useState(false);
  const [codexSlideError, setCodexSlideError] = useState("");
  const [focusedUnifiedTask, setFocusedUnifiedTask] = useState(null);
  const [guidedActionNote, setGuidedActionNote] = useState("");
  const [pageRetryBusy, setPageRetryBusy] = useState("");
  const [pageRetryError, setPageRetryError] = useState("");
  const [confirmEditableImageSpend, setConfirmEditableImageSpend] = useState(false);
  const [confirmLlmProviderRecovered, setConfirmLlmProviderRecovered] = useState(false);
  const [confirmCodexImageSpend, setConfirmCodexImageSpend] = useState(false);
  const [confirmVisualSampleSpend, setConfirmVisualSampleSpend] = useState(false);
  const [authorizationBusy, setAuthorizationBusy] = useState("");
  const [authorizationMessage, setAuthorizationMessage] = useState("");
  const [styleRefreshBusy, setStyleRefreshBusy] = useState(false);
  const [styleRefreshMessage, setStyleRefreshMessage] = useState("");
  const [codexSlideBatchPreflightBundle, setCodexSlideBatchPreflightBundle] = useState(null);
  const [guidedPreflightBundle, setGuidedPreflightBundle] = useState(null);
  const [cleanupBundle, setCleanupBundle] = useState(null);
  const [cleanupBusy, setCleanupBusy] = useState("");
  const [cleanupMessage, setCleanupMessage] = useState("");
  const localDeliveryStatus = deriveWorkflowDeliveryStatus(job, workerTasks);
  const deliveryStatus = deliveryBundle?.status || localDeliveryStatus;
  const deliveryGate = deliveryBundle?.finalGate || null;
  const guidedDelivery = {
    level: deliveryGate?.level || deliveryStatus.level || "pending",
    title: uiZh(deliveryGate?.title || deliveryStatus.title || "交付状态"),
    label: uiZh(deliveryGate?.label || deliveryStatus.summary || "未就绪")
  };
  const codexSlideTasks = Array.isArray(codexSlideBundle?.tasks)
    ? codexSlideBundle.tasks
    : Array.isArray(artifacts.codexPptSlideWorkerTasks)
      ? artifacts.codexPptSlideWorkerTasks
      : [];
  const hasVisualImages = Array.isArray(artifacts.visualImages) && artifacts.visualImages.length > 0;
  const hasRecordedCodexSlideImages = codexSlideTasks.some((task) => task.status === "recorded" && task.imagePath);
  const canAssembleImageDeck = hasVisualImages || hasRecordedCodexSlideImages;
  const editableBatchReadyCount = workerTaskBundle?.summary?.ready || prompts.length || 20;
  const editableBatchPreflight = workerBatchPreflightBundle || null;
  const editableImageProvider = editableBatchPreflight?.provider || costBundle?.providers?.image || {};
  const editableImageModel = editableImageProvider.model || "已配置图片模型";
  const editableBatchSelectedCount = editableBatchPreflight?.selectedCount || editableBatchReadyCount;
  const editableBatchDefaultPageLimit = Math.max(1, Math.min(2, editableBatchReadyCount || promptCount || workerTasks.length || 1));
  const editableWorkerBatchStartReady = Boolean(
    job?.id
    && promptCount
    && editableBatchPreflight?.startReady
    && !(workerTaskBundle?.summary?.total > 0 && workerTaskBundle?.summary?.recorded === workerTaskBundle?.summary?.total)
  );
  const editableWorkerAuthorization = editableBatchPreflight?.authorization || null;
  const editableWorkerAuthorizationPersisted = Boolean(editableWorkerAuthorization?.persisted);
  const editableWorkerImageCalls = editableWorkerAuthorization?.imageCalls || editableBatchSelectedCount || 0;
  const editableImageSpendConfirmed = confirmEditableImageSpend || editableWorkerAuthorizationPersisted;
  const editableLlmProviderRecoveryRequired = Boolean(editableBatchPreflight?.requiredConfirmations?.llmProviderRecovered?.required);
  const editableLlmProviderRecovered = !editableLlmProviderRecoveryRequired
    || confirmLlmProviderRecovered
    || Boolean(editableBatchPreflight?.requiredConfirmations?.llmProviderRecovered?.confirmed);
  const editableOfflineHintsAccepted = acceptOfflineTextHints || Boolean(job?.artifacts?.editableTextHintsAcknowledgement?.accepted);
  const approvedCodexPptGates = new Set((complianceBundle?.codexPpt?.approvals?.gates || [])
    .filter((gate) => gate.passed)
    .map((gate) => gate.id));
  const canGenerateVisualSample = ["outline", "style", "backend"].every((gate) => approvedCodexPptGates.has(gate));
  const canGenerateVisualDeck = canGenerateVisualSample && ["sample", "fullDeck"].every((gate) => approvedCodexPptGates.has(gate));
  const canRunProductVisualSample = canGenerateVisualSample && confirmVisualSampleSpend;
  const productStyleAction = (v1ReadinessBundle?.actionGroups?.style || [])
    .find((action) => action.targetStepId === "refresh-style-approval");
  const productSampleAction = (v1ReadinessBundle?.actionGroups?.codexSlide || [])
    .find((action) => action.targetStepId === "generate-sample");
  const productSampleProvider = v1ReadinessBundle?.checks
    ?.find((check) => check.id === "provider-runtime")
    ?.evidence?.runtimeKey || v1ReadinessBundle?.codexSlideBatchPreflight?.provider?.model || "";
  const codexFullDeckImageCalls = v1ReadinessBundle?.codexSlideBatchPreflight?.cost?.imageCalls || codexSlideTasks.length || 0;
  const baseGuidedAction = getWorkflowGuidedAction(complianceBundle?.runbook, {
    job,
    canAssembleImageDeck,
    canGenerateVisualDeck,
    canGenerateVisualSample,
    nextStage,
    promptCount
  });
  const guidedAction = productStyleAction ? {
    title: "刷新视觉风格证据",
    label: "刷新风格证据",
    description: productStyleAction.detail || "当前风格证据仍包含旧模板调性，需要先刷新为 PPT 重制任务证据。",
    kind: "style-refresh",
    action: "refresh-codex-ppt-style-evidence",
    message: "正在刷新视觉风格证据...",
    disabled: false
  } : baseGuidedAction;
  const guidedPreflightBody = useMemo(() => ({
    ...(guidedAction?.body || {}),
    ...(guidedAction?.action === "visual/sample" ? { confirmExternalImageSpend: confirmVisualSampleSpend } : {}),
    ...(guidedAction?.action === "visual/generate" ? { confirmExternalImageSpend: confirmCodexImageSpend } : {})
  }), [guidedAction?.action, confirmCodexImageSpend, confirmVisualSampleSpend]);
  const selectedEditableStatus = selectedTask?.status || (selectedPrompt ? "ready" : "pending");
  const selectedEditableMode = selectedPrompt?.executionMode === "local" ? "image-to-editable-ppt 单页重建" : "真实页面任务";
  const selectedEditablePath = shortPath(selectedTask?.pageResult || selectedTask?.relativePath || selectedPrompt?.relativePath || selectedPrompt?.promptFile);
  const selectedEditableNext = getEditableWorkerNextAction({ selectedPrompt, selectedTask, nextStage });
  const selectedEditableOutputReady = Boolean(selectedTask?.evidence?.outputContractOk);
  const selectedEditableIssue = formatEditableTaskIssue(selectedTask);
  const focusedEditableTask = focusedUnifiedTask?.skillId === "image-to-editable-ppt" ? focusedUnifiedTask : null;
  const focusedEditableTaskLabel = focusedEditableTask?.taskId || "";
  const workerRuns = Array.isArray(workerRunBundle?.runs) ? workerRunBundle.runs : [];
  const latestWorkerRun = workerRuns[0] || null;
  const latestFailedWorkerRun = workerRuns.find((run) => run.failureAnalysis) || null;
  const latestFailure = latestFailedWorkerRun?.failureAnalysis || null;
  const latestFailurePages = Array.isArray(latestFailure?.pages) ? latestFailure.pages.filter(Boolean) : [];
  const latestFailurePageSelection = latestFailurePages.join(",");
  const editableBatchPreflightSelection = Array.isArray(editableBatchPreflight?.selectedPageIds)
    ? editableBatchPreflight.selectedPageIds.filter(Boolean).join(",")
    : "";
  const latestFailurePreflightReady = Boolean(
    latestFailurePageSelection
      && editableBatchPreflight?.startReady
      && editableBatchPreflightSelection === latestFailurePageSelection
  );

  useEffect(() => {
    if (focusedEditableTaskLabel) setSelectedPageId(focusedEditableTaskLabel);
  }, [focusedEditableTaskLabel]);

  useEffect(() => {
    if (!job?.id || latestWorkerRun?.status !== "running") return undefined;
    const timer = window.setInterval(() => {
      loadWorkerRuns(job.id);
      loadWorkerTasks(job.id);
      onRefresh?.();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [job?.id, latestWorkerRun?.id, latestWorkerRun?.status]);

  useEffect(() => {
    if (!job?.id) {
      setDeliveryBundle(null);
      setArtifactBundle(null);
      setComplianceBundle(null);
      setCostBundle(null);
      setAuthorizationBundle(null);
      setV1ReadinessBundle(null);
      setV1AcceptanceReport(null);
      setV1AcceptanceRun(null);
      setEventsBundle(null);
      setCodexSlideBundle(null);
      setCodexSlideBatchPreflightBundle(null);
      setEditablePreparePreflight(null);
      setEditablePreparePreflightMessage("");
      setCodexSlideError("");
      return;
    }
    const controller = new AbortController();
    Promise.allSettled([
      api.workflowDeliveryStatus(job.id, controller.signal),
      api.workflowArtifacts(job.id, controller.signal),
      api.workflowCompliance(job.id, controller.signal),
      api.workflowCostEstimate(job.id, controller.signal),
      api.workflowAuthorizations(job.id, controller.signal),
      api.workflowV1Readiness(job.id, controller.signal),
      api.latestV1Acceptance(controller.signal),
      api.v1AcceptanceRunStatus(controller.signal),
      api.workflowEvents(job.id, { limit: 80 }, controller.signal)
    ]).then(([deliveryResult, artifactResult, complianceResult, costResult, authorizationResult, v1ReadinessResult, v1AcceptanceResult, v1AcceptanceRunResult, eventsResult]) => {
      setDeliveryBundle(deliveryResult.status === "fulfilled" ? deliveryResult.value : null);
      setArtifactBundle(artifactResult.status === "fulfilled" ? artifactResult.value : null);
      setComplianceBundle(complianceResult.status === "fulfilled" ? complianceResult.value : null);
      setCostBundle(costResult.status === "fulfilled" ? costResult.value : null);
      setAuthorizationBundle(authorizationResult.status === "fulfilled" ? authorizationResult.value : null);
      setV1ReadinessBundle(v1ReadinessResult.status === "fulfilled" ? v1ReadinessResult.value : null);
      setV1AcceptanceReport(v1AcceptanceResult.status === "fulfilled" ? v1AcceptanceResult.value : null);
      setProductVisualReadiness(v1AcceptanceResult.status === "fulfilled" ? v1AcceptanceResult.value?.productVisualReadiness || null : null);
      setProductVisualSamplePreflight(null);
      setProductVisualFullDeckPreflight(null);
      setProductVisualFullDeckRunMessage("");
      setV1AcceptanceRun(v1AcceptanceRunResult.status === "fulfilled" ? v1AcceptanceRunResult.value : null);
      setEventsBundle(eventsResult.status === "fulfilled" ? eventsResult.value : null);
    });
    return () => controller.abort();
  }, [job?.id, job?.updatedAt, workerTasks.length]);

  useEffect(() => {
    if (!job?.id) {
      setEditablePreparePreflight(null);
      setEditablePreparePreflightMessage("");
      return undefined;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api.workflowEditablePreparePreflight(job.id, {})
        .then((bundle) => {
          if (!controller.signal.aborted) setEditablePreparePreflight(bundle);
        })
        .catch((error) => {
          if (!controller.signal.aborted) {
            setEditablePreparePreflight({
              ok: false,
              ready: false,
              startReady: false,
              error: getErrorMessage(error),
              blockingIssues: [getErrorMessage(error)]
            });
          }
        });
    }, 150);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [job?.id, job?.updatedAt, artifacts.imageDeck?.path, artifacts.visualQuality?.path]);

  useEffect(() => {
    if (v1AcceptanceRun?.run?.status !== "running") return undefined;
    const timer = window.setInterval(() => {
      api.v1AcceptanceRunStatus()
        .then((bundle) => setV1AcceptanceRun(bundle))
        .catch(() => {});
      api.latestV1Acceptance()
        .then((bundle) => setV1AcceptanceReport(bundle))
        .catch(() => {});
    }, 3000);
    return () => window.clearInterval(timer);
  }, [v1AcceptanceRun?.run?.status]);

  useEffect(() => {
    if (!job?.id) {
      setCodexSlideBundle(null);
      setCodexSlideBatchPreflightBundle(null);
      setGuidedPreflightBundle(null);
      setCodexSlideError("");
      return;
    }
    loadCodexSlideTasks(job.id);
  }, [job?.id]);

  useEffect(() => {
    if (!job?.id || !guidedAction) {
      setGuidedPreflightBundle(null);
      return undefined;
    }
    if (guidedAction.kind === "style-refresh") {
      setGuidedPreflightBundle({
        ok: true,
        preview: true,
        didRun: false,
        jobId: job.id,
        action: guidedAction.action,
        title: guidedAction.title,
        summary: guidedAction.description,
        startReady: true,
        manualRequired: false,
        requiredConfirmation: "",
        externalImageCalls: 0,
        mutatesWorkflow: true,
        blockingIssues: [],
        warnings: [],
        reason: "可以先刷新视觉风格证据；此操作只更新本地工作流证据，不调用外部图片 API。"
      });
      return undefined;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api.workflowNextActionPreflight(job.id, guidedPreflightBody)
        .then((bundle) => {
          if (!controller.signal.aborted) setGuidedPreflightBundle(bundle);
        })
        .catch((error) => {
          if (!controller.signal.aborted) {
            setGuidedPreflightBundle({
              ok: false,
              startReady: false,
              error: getErrorMessage(error),
              blockingIssues: [getErrorMessage(error)]
            });
          }
        });
    }, 160);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [job?.id, job?.updatedAt, guidedAction?.kind, guidedAction?.action, confirmCodexImageSpend, confirmVisualSampleSpend]);

  useEffect(() => {
    if (!job?.id) return undefined;
    const readyCount = codexSlideTasks.filter((task) => task.status === "ready" || task.status === "failed").length;
    const timer = window.setTimeout(() => {
      loadCodexSlideBatchPreflight(job.id, {
        maxPages: readyCount || codexSlideTasks.length || 20,
        confirmExternalImageSpend: confirmCodexImageSpend,
        assembleImageDeck: true,
        prepareEditable: true,
        buildEditablePrompts: true,
        syncEditableWorkerTasks: true
      });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [job?.id, job?.updatedAt, codexSlideTasks.length, codexSlideBundle?.summary?.ready, codexSlideBundle?.summary?.failed, confirmCodexImageSpend]);

  useEffect(() => {
    if (!job?.id || !promptCount) return undefined;
    const timer = window.setTimeout(() => {
      loadWorkerBatchPreflight(job.id, {
        mode: "model",
        maxPages: editableBatchDefaultPageLimit,
        agentPrefix: "product-page-worker",
        confirmLlmProviderRecovered,
        acceptOfflineTextHints: editableOfflineHintsAccepted,
        autoFinalize: true
      });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [job?.id, job?.updatedAt, promptCount, editableBatchDefaultPageLimit, editableImageSpendConfirmed, confirmLlmProviderRecovered, editableOfflineHintsAccepted]);

  async function loadCodexSlideTasks(id = job?.id) {
    if (!id) return;
    setCodexSlideLoading(true);
    setCodexSlideError("");
    try {
      setCodexSlideBundle(await api.codexPptSlideTasks(id));
    } catch (error) {
      setCodexSlideError(getErrorMessage(error));
    } finally {
      setCodexSlideLoading(false);
    }
  }

  async function loadCodexSlideBatchPreflight(id = job?.id, options = {}) {
    if (!id) return;
    try {
      setCodexSlideBatchPreflightBundle(await api.codexPptSlideBatchPreflight(id, options));
    } catch (error) {
      setCodexSlideBatchPreflightBundle({
        ok: false,
        ready: false,
        startReady: false,
        error: getErrorMessage(error)
      });
    }
  }

  async function refreshEditablePreparePreflight() {
    if (!job?.id) return;
    setEditablePreparePreflightBusy(true);
    setEditablePreparePreflightMessage("");
    try {
      const result = await api.workflowEditablePreparePreflight(job.id, {});
      setEditablePreparePreflight(result);
      setEditablePreparePreflightMessage(result.ready ? "准备预检通过，可以进入 editppt。" : "准备条件未满足，请查看阻断项。");
    } catch (error) {
      const message = getErrorMessage(error);
      setEditablePreparePreflight({
        ok: false,
        ready: false,
        startReady: false,
        error: message,
        blockingIssues: [message]
      });
      setEditablePreparePreflightMessage(message);
    } finally {
      setEditablePreparePreflightBusy(false);
    }
  }

  async function probePageSpecProvider() {
    if (!job?.id || pageSpecProviderProbeBusy) return;
    setPageSpecProviderProbeBusy(true);
    setPageSpecProviderProbeMessage("");
    try {
      const pageId = selectedPrompt?.pageId || selectedPageId || "";
      const result = await api.probeWorkflowPageSpecProvider(job.id, {
        pages: pageId,
        maxPages: 1,
        visionProbe: true,
        maxRetries: 0
      });
      setPageSpecProviderProbe(result);
      setPageSpecProviderProbeMessage(result.message || "页面重建模型检测完成。");
      await loadWorkerBatchPreflight(job.id, {
        mode: "model",
        maxPages: editableBatchDefaultPageLimit,
        agentPrefix: "product-page-worker",
        acceptOfflineTextHints: editableOfflineHintsAccepted,
        autoFinalize: true
      });
    } catch (error) {
      const data = error?.data || {};
      setPageSpecProviderProbe(data.ok === false ? data : null);
      setPageSpecProviderProbeMessage(data.message || getErrorMessage(error));
    } finally {
      setPageSpecProviderProbeBusy(false);
    }
  }

  async function syncCodexSlideTasks() {
    if (!job?.id) return;
    setCodexSlideLoading(true);
    setCodexSlideError("");
    try {
      setCodexSlideBundle(await api.syncCodexPptSlideTasks(job.id, {}));
      await loadCodexSlideBatchPreflight(job.id, {
        confirmExternalImageSpend: confirmCodexImageSpend,
        assembleImageDeck: true,
        prepareEditable: true,
        buildEditablePrompts: true,
        syncEditableWorkerTasks: true
      });
      await onRefresh?.();
    } catch (error) {
      setCodexSlideError(getErrorMessage(error));
    } finally {
      setCodexSlideLoading(false);
    }
  }

  async function startCodexSlideBatch() {
    if (!job?.id) return;
    const preflight = codexSlideBatchPreflightBundle || await api.codexPptSlideBatchPreflight(job.id, {
      maxPages: codexSlideTasks.filter((task) => task.status === "ready" || task.status === "failed").length || codexSlideTasks.length || 20,
      confirmExternalImageSpend: confirmCodexImageSpend,
      assembleImageDeck: true,
      prepareEditable: true,
      buildEditablePrompts: true,
      syncEditableWorkerTasks: true
    });
    if (!preflight.startReady) {
      const issue = [...(preflight.blockingIssues || []), ...(preflight.warnings || [])].join(" ") || "Codex-ppt slide batch preflight is not start-ready.";
      setCodexSlideError(uiZh(issue));
      setCodexSlideBatchPreflightBundle(preflight);
      return;
    }
    const readyCount = preflight.selectedCount || codexSlideBundle?.summary?.ready || codexSlideTasks.filter((task) => task.status === "ready" || task.status === "failed").length || 1;
    const confirmed = window.confirm(`将运行 ${readyCount} 个视觉统一图片页任务，组装图片型 PPT，并准备可编辑重建。此操作可能消耗图片 API 额度，是否继续？`);
    if (!confirmed) return;
    setCodexSlideLoading(true);
    setCodexSlideError("");
    try {
      const result = await api.runCodexPptSlideBatch(job.id, {
        maxPages: readyCount,
        pages: preflight.startBody?.pages || "",
        agentPrefix: "product-codex-slide-batch",
        confirmExternalImageSpend: confirmCodexImageSpend,
        assembleImageDeck: true,
        prepareEditable: true,
        buildEditablePrompts: true,
        syncEditableWorkerTasks: true,
        editableMaxConcurrentPages: 6
      });
      setCodexSlideBundle(result.taskBundle || result);
      await loadCodexSlideBatchPreflight(job.id, {
        confirmExternalImageSpend: confirmCodexImageSpend,
        assembleImageDeck: true,
        prepareEditable: true,
        buildEditablePrompts: true,
        syncEditableWorkerTasks: true
      });
      await onRefresh?.();
    } catch (error) {
      setCodexSlideError(getErrorMessage(error));
    } finally {
      setCodexSlideLoading(false);
    }
  }

  async function continueRemainingPagesFromPartialFinal(option = {}) {
    if (!job?.id) return;
    setCodexSlideLoading(true);
    setCodexSlideError("");
    setGuidedActionNote("正在检查剩余页面生成条件...");
    try {
      const preflight = await api.workflowContinuationPreflight(job.id, {
        confirmExternalImageSpend: false
      });
      setGuidedPreflightBundle({
        ...guidedPreflightBundle,
        continuationPreflight: preflight
      });
      const calls = preflight.externalImageCalls || option.externalImageCalls || 0;
      const pages = preflight.partialFinal?.numericPageSelection || preflight.pageSelection || option.pageSelection || "";
      if (!preflight.ready) {
        const issue = [...(preflight.blockingIssues || []), ...(preflight.warnings || [])].join(" ") || "剩余页面预检未通过。";
        setCodexSlideError(uiZh(issue));
        setGuidedActionNote("");
        return;
      }
      const confirmed = window.confirm(`将继续处理剩余页面 ${pages}，预计调用 ${calls} 次 gpt-image-2 图片 API。确认后会真实生成图片型 PPT，并准备 image-to-editable-ppt 重建。是否继续？`);
      if (!confirmed) {
        setGuidedActionNote("已取消继续生成剩余页面。");
        return;
      }
      setGuidedActionNote(`正在启动剩余 ${preflight.remainingPages || calls || ""} 页真实生成...`);
      const result = await api.workflowContinueRemaining(job.id, {
        confirmExternalImageSpend: true,
        requestedBy: "frontend-continue-remaining-pages",
        reason: "用户在 Agent 工作台确认继续生成部分 final 后的剩余页面"
      });
      if (result.result?.taskBundle) setCodexSlideBundle(result.result.taskBundle);
      await loadCodexSlideBatchPreflight(job.id, {
        confirmExternalImageSpend: true,
        assembleImageDeck: true,
        prepareEditable: true,
        buildEditablePrompts: true,
        syncEditableWorkerTasks: true
      });
      await onRefresh?.();
      setGuidedActionNote(result.ok ? "剩余页面图片型 PPT 生成批次已完成或已进入下一阶段，请继续查看可编辑重建状态。" : "剩余页面批次已返回，但存在失败页，请查看失败恢复。");
    } catch (error) {
      const data = error?.data || {};
      if (data.preflight) {
        setGuidedPreflightBundle({
          ...(guidedPreflightBundle || {}),
          continuationPreflight: data.preflight,
          blockingIssues: data.preflight.blockingIssues || [getErrorMessage(error)]
        });
      }
      setCodexSlideError(getErrorMessage(error));
      setGuidedActionNote("");
    } finally {
      setCodexSlideLoading(false);
    }
  }

  async function startEditableWorkerBatch() {
    if (!editableOfflineHintsAccepted) {
      setPageRetryError("启动后台页面批处理前，请先运行本地 OCR 文字提示，或确认使用 editppt 离线内置文字提示。");
      return;
    }
    if (!editableImageSpendConfirmed) {
      setPageRetryError("启动后台页面批处理前，请确认外部图片 API 额度使用。");
      return;
    }
    if (!editableLlmProviderRecovered) {
      setPageRetryError("启动后台页面批处理前，请先确认对话模型服务商已充值或已切换，额度/鉴权问题已经处理。");
      return;
    }
    const preflight = await loadWorkerBatchPreflight(job.id, {
      mode: "model",
      maxPages: editableBatchDefaultPageLimit,
      agentPrefix: "product-page-worker",
      confirmLlmProviderRecovered,
      acceptOfflineTextHints: editableOfflineHintsAccepted,
      autoFinalize: true
    });
    if (!preflight?.ready) {
      setPageRetryError(`页面批处理预检被阻断：${uiZh((preflight?.blockingIssues || []).join(" ") || "未就绪")}`);
      return;
    }
    if (!preflight?.startReady) {
      setPageRetryError(`页面批处理需要确认：${uiZh((preflight?.warnings || []).join(" ") || "缺少确认")}`);
      return;
    }
    const confirmed = window.confirm(`将使用 ${preflight.provider?.model || editableImageModel} 运行 ${preflight.selectedCount || editableBatchDefaultPageLimit} 个可编辑重建页面任务。此操作可能消耗外部图片 API 额度，是否继续？`);
    if (!confirmed) return;
    setPageRetryError("");
    await startWorkerBatch({
      mode: "model",
      maxPages: preflight.selectedCount || editableBatchDefaultPageLimit,
      pages: preflight.startBody?.pages || "",
      agentPrefix: "product-page-worker",
      confirmLlmProviderRecovered,
      acceptOfflineTextHints: editableOfflineHintsAccepted,
      offlineTextHintsReason: "frontend background worker batch confirmation",
      autoFinalize: true
    });
    await loadWorkerRuns();
  }

  function focusUnifiedTask(detail) {
    if (!detail) return;
    setFocusedUnifiedTask(detail);
    if (detail.skillId === "image-to-editable-ppt" && detail.taskId) {
      setSelectedPageId(detail.taskId);
    }
    const targetId = detail.skillId === "codex-ppt" ? "codex-slide-worker-panel" : "editable-page-worker-panel";
    setTimeout(() => document.getElementById(targetId)?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  function focusCodexSlideWorker() {
    setTimeout(() => document.getElementById("codex-slide-worker-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  function focusDeliveryNextStep(step = {}) {
    const targetId = deliveryStepTargetId(step.id);
    if (!targetId) return;
    if (targetId === "workflow-settings-panel") {
      setRightPanelMode("settings");
    }
    setTimeout(() => document.getElementById(targetId)?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  async function retryUnifiedTask(detail) {
    if (!job?.id || !detail?.taskId) return;
    const busyKey = detail.key || `${detail.skillId}:${detail.taskId}`;
    setPageRetryBusy(busyKey);
    setPageRetryError("");
    try {
      await api.retryWorkflowPage(job.id, detail.taskId, {
        skillId: detail.skillId,
        reason: "product retry from unified task board"
      });
      await Promise.allSettled([
        onRefresh?.(),
        detail.skillId === "codex-ppt" ? loadCodexSlideTasks(job.id) : loadWorkerTasks()
      ]);
    } catch (error) {
      setPageRetryError(getErrorMessage(error));
    } finally {
      setPageRetryBusy("");
    }
  }

  async function retryAllFailedUnifiedTasks() {
    if (!job?.id) return;
    setPageRetryBusy("bulk-failed");
    setPageRetryError("");
    try {
      const result = await api.retryFailedWorkflowPages(job.id, {
        reason: "product bulk retry from failed recovery panel"
      });
      if (!result.retried && result.requested) {
        setPageRetryError("没有可重置的失败页面任务。");
      }
      await Promise.allSettled([
        onRefresh?.(),
        loadCodexSlideTasks(job.id),
        loadWorkerTasks()
      ]);
    } catch (error) {
      setPageRetryError(getErrorMessage(error));
    } finally {
      setPageRetryBusy("");
    }
  }

  async function resetLatestFailurePages() {
    if (!job?.id || !latestFailurePages.length || pageRetryBusy) return;
    const pageText = latestFailurePages.join(",");
    const confirmed = window.confirm(`将重置失败页 ${pageText} 的页面任务状态。\n\n这一步只清理本地失败/锁定状态，不调用外部 API，不覆盖已成功页面。重置后仍需先做预检，再手动启动重跑。是否继续？`);
    if (!confirmed) return;
    setPageRetryBusy("reset-latest-failure");
    setPageRetryError("");
    try {
      for (const pageId of latestFailurePages) {
        await api.workflowWorkerTaskAction(job.id, pageId, "reset", {
          reason: "frontend reset latest failed editable page before retry",
          confirmLost: true
        });
      }
      setEditableBatchPreflight(null);
      await Promise.allSettled([
        onRefresh?.(),
        loadWorkerTasks(job.id),
        loadWorkerRuns(job.id),
        loadWorkerBatchPreflight(job.id, {
          mode: "model",
          pages: pageText,
          maxPages: latestFailurePages.length || 1,
          agentPrefix: "product-page-worker",
          confirmLlmProviderRecovered,
          acceptOfflineTextHints: editableOfflineHintsAccepted,
          autoFinalize: true
        })
      ]);
      setPageRetryError(`已重置 ${pageText}。下一步请先做重跑预检，通过后再启动单页重跑。`);
    } catch (error) {
      setPageRetryError(getErrorMessage(error));
    } finally {
      setPageRetryBusy("");
    }
  }

  async function runGuidedAction() {
    if (!guidedAction || guidedAction.disabled) return;
    setGuidedActionNote("");
    if (guidedAction.kind === "focus") {
      setGuidedActionNote(guidedAction.note || guidedAction.message || "");
      if (guidedAction.targetId) {
        setTimeout(() => document.getElementById(guidedAction.targetId)?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
      }
      return;
    }
    if (guidedAction.kind === "sync-codex-slides") {
      const result = await onRunNextAction?.(guidedAction.message || "正在执行下一步 PPT 重制任务...");
      if (result?.manualRequired) setGuidedActionNote(result.reason || "");
      await loadCodexSlideTasks(job.id);
      return;
    }
    if (guidedAction.kind === "load-prompts") {
      await loadPrompts();
      return;
    }
    if (guidedAction.kind === "style-refresh") {
      await refreshCodexPptStyleEvidence();
      setGuidedActionNote("已刷新视觉风格证据；下一步请重新确认风格关卡。");
      return;
    }
    if (guidedAction.kind === "workflow") {
      if (guidedAction.action === "visual/sample" && !confirmVisualSampleSpend) {
        setGuidedActionNote("生成产品级 codex-ppt 样张前，请确认 1 次外部图片 API 调用。");
        return;
      }
      if (guidedAction.action === "visual/generate" && !confirmCodexImageSpend) {
        setGuidedActionNote("生成完整 codex-ppt 图片型 PPT 前，请确认外部图片 API 用量。");
        return;
      }
      const body = {
        ...(guidedAction.body || {}),
        ...(guidedAction.action === "visual/sample" ? { confirmExternalImageSpend: confirmVisualSampleSpend } : {}),
        ...(guidedAction.action === "visual/generate" ? { confirmExternalImageSpend: confirmCodexImageSpend } : {})
      };
      const result = await onRunNextAction?.(guidedAction.message || "正在执行下一步 PPT 重制任务...", body);
      if (result?.manualRequired) setGuidedActionNote(uiZh(result.reason || ""));
    }
  }

  async function recordExternalImageAuthorization(scope = "visual-sample", requestedImageCalls = null) {
    if (!job?.id) return;
    let imageCalls = Number(requestedImageCalls || 0) || (scope === "full-deck" ? codexFullDeckImageCalls : scope === "editable-workers" ? editableWorkerImageCalls : 1);
    setAuthorizationBusy(scope);
    setAuthorizationMessage("");
    try {
      let pageSelection = "";
      let pageNumbers = [];
      if (scope === "editable-workers") {
        const preflight = editableBatchPreflight?.selectedPageIds?.length
          ? editableBatchPreflight
          : await loadWorkerBatchPreflight(job.id, {
            mode: "model",
            maxPages: editableBatchDefaultPageLimit,
            agentPrefix: "product-page-worker",
            acceptOfflineTextHints: editableOfflineHintsAccepted,
            autoFinalize: true
          });
        const selectedPageIds = Array.isArray(preflight?.selectedPageIds) ? preflight.selectedPageIds : [];
        pageSelection = selectedPageIds.join(",");
        pageNumbers = pageNumbersFromWorkflowPageIds(selectedPageIds);
        imageCalls = Number(preflight?.authorization?.imageCalls || selectedPageIds.length || imageCalls || 0);
        if (!pageSelection || !imageCalls) {
          setAuthorizationMessage("页面任务预检还没有选中可重建页面，暂不能记录页面级额度授权。");
          return;
        }
        const confirmed = window.confirm(
          `将记录 ${imageCalls} 次 gpt-image-2 图片 API 额度授权。\n\n页面范围：${pageSelection}\n\n这一步只记录授权账本，不会立刻启动 worker；但后续启动 image-to-editable-ppt 页面 worker 会真实调用外部模型/图片服务并可能消耗额度。是否继续？`
        );
        if (!confirmed) {
          setAuthorizationMessage("已取消页面任务额度授权。");
          return;
        }
      }
      const result = await api.authorizeExternalImageSpend(job.id, {
        scope,
        imageCalls,
        ...(scope === "editable-workers" ? {
          pageSelection,
          pageNumbers,
          targetPages: imageCalls,
          mode: "model"
        } : {}),
        confirmedBy: "frontend-operator",
        reason: `前端操作员确认 ${scope} 外部图片 API 用量。`
      });
      setAuthorizationBundle({
        ok: true,
        jobId: job.id,
        externalImageSpend: [
          ...(authorizationBundle?.externalImageSpend || []),
          result.authorization
        ],
        summary: result.summary
      });
      setAuthorizationMessage(`已记录 ${imageCalls} 次${scope === "visual-sample" ? "样张" : scope === "editable-workers" ? "页面任务" : "全量"}外部图片 API 授权。`);
      const refreshes = [onRefresh?.()];
      if (scope === "editable-workers") {
        setConfirmEditableImageSpend(true);
        refreshes.push(
          loadWorkerBatchPreflight(job.id, {
            mode: "model",
            maxPages: editableBatchDefaultPageLimit,
            agentPrefix: "product-page-worker",
            acceptOfflineTextHints: editableOfflineHintsAccepted,
            autoFinalize: true
          }),
          loadWorkerTasks(job.id),
          loadWorkerRuns(job.id),
          api.workflowDeliveryStatus(job.id).then(setDeliveryBundle)
        );
        setAuthorizationMessage(`已记录 ${imageCalls} 次页面任务外部图片 API 授权，并刷新页面批处理预检。`);
      } else if (scope === "full-deck") {
        setConfirmCodexImageSpend(true);
        refreshes.push(
          loadCodexSlideBatchPreflight(job.id, {
            confirmExternalImageSpend: true,
            assembleImageDeck: true,
            prepareEditable: true,
            buildEditablePrompts: true,
            syncEditableWorkerTasks: true
          }),
          api.workflowV1Readiness(job.id).then(setV1ReadinessBundle)
        );
        setAuthorizationMessage(`已记录 ${imageCalls} 次全量 codex-ppt 图片 API 授权，并刷新图片页批处理预检。`);
      } else {
        refreshes.push(api.workflowV1Readiness(job.id).then(setV1ReadinessBundle));
      }
      await Promise.allSettled(refreshes);
    } catch (error) {
      setAuthorizationMessage(uiZh(getErrorMessage(error)));
    } finally {
      setAuthorizationBusy("");
    }
  }

  async function refreshCodexPptStyleEvidence() {
    if (!job?.id) return;
    setStyleRefreshBusy(true);
    setStyleRefreshMessage("");
    try {
      await api.recordCodexPptStyle(job.id, buildRefreshedCodexPptStyleBody(job));
      setStyleRefreshMessage("已刷新视觉风格证据；请重新确认视觉风格关卡。");
      await onRefresh?.();
    } catch (error) {
      setStyleRefreshMessage(uiZh(getErrorMessage(error)));
    } finally {
      setStyleRefreshBusy(false);
    }
  }

  async function preflightRealPptAcceptanceRun(useWorkflowSource = false) {
    const fromWorkflow = useWorkflowSource === true;
    const sourcePath = v1AcceptanceSourcePath.trim();
    if (!fromWorkflow && !sourcePath) {
      setV1AcceptanceRunMessage("请先填写本地 PPTX 路径。");
      return;
    }
    if (fromWorkflow && !canUseWorkflowAcceptanceSource) {
      setV1AcceptanceRunMessage("当前工作流源文件不是 PPTX，不能作为真实 15 页验收输入。");
      return;
    }
    setV1AcceptancePreflightBusy(true);
    setV1AcceptanceRunMessage("");
    try {
      const result = await api.preflightV1AcceptanceRun(fromWorkflow ? { workflowJobId: job.id, maxPages: 15 } : { sourcePath, maxPages: 15 });
      setV1AcceptancePreflight(result);
      setV1AcceptanceRunMessage(result.ready ? "真实验收预检通过，可以启动验收任务。" : uiZh(result.summary || "真实验收预检未通过。"));
    } catch (error) {
      setV1AcceptanceRunMessage(uiZh(getErrorMessage(error)));
    } finally {
      setV1AcceptancePreflightBusy(false);
    }
  }

  async function startRealPptAcceptanceRun(useWorkflowSource = false) {
    const fromWorkflow = useWorkflowSource === true;
    const sourcePath = v1AcceptanceSourcePath.trim();
    if (!fromWorkflow && !sourcePath) {
      setV1AcceptanceRunMessage("请先填写本地 PPTX 路径。");
      return;
    }
    if (fromWorkflow && !canUseWorkflowAcceptanceSource) {
      setV1AcceptanceRunMessage("当前工作流源文件不是 PPTX，不能作为真实 15 页验收输入。");
      return;
    }
    setV1AcceptanceRunBusy(true);
    setV1AcceptanceRunMessage("");
    try {
      const result = await api.startV1AcceptanceRun(fromWorkflow ? { workflowJobId: job.id, maxPages: 15 } : { sourcePath, maxPages: 15 });
      setV1AcceptanceRun(result);
      setV1AcceptanceRunMessage("真实 15 页验收已启动，运行中会自动刷新状态。");
      const latest = await api.latestV1Acceptance().catch(() => null);
      if (latest) setV1AcceptanceReport(latest);
    } catch (error) {
      setV1AcceptanceRunMessage(uiZh(getErrorMessage(error)));
      const status = await api.v1AcceptanceRunStatus().catch(() => null);
      if (status) setV1AcceptanceRun(status);
    } finally {
      setV1AcceptanceRunBusy(false);
    }
  }

  async function runProductVisualReadiness() {
    setProductVisualReadinessBusy(true);
    setProductVisualReadinessMessage("");
    setProductVisualSamplePreflight(null);
    setProductVisualSamplePreflightMessage("");
    setProductVisualSamplePromptPreview(null);
    setProductVisualSamplePromptPreviewMessage("");
    setProductVisualSampleRunResult(null);
    setProductVisualSampleRunMessage("");
    setProductVisualSampleApprovalPreflight(null);
    setProductVisualSampleApprovalMessage("");
    setProductVisualFullDeckPreflight(null);
    setProductVisualFullDeckPreflightMessage("");
    setProductVisualFullDeckRunResult(null);
    setProductVisualFullDeckRunMessage("");
    try {
      const result = await api.runProductVisualReadiness({ maxPages: productVisualTargetPages });
      setProductVisualReadiness(result);
      const jobId = result.result?.jobId || result.workflowJobId || "";
      const step = result.result?.runbook?.currentTitle || result.result?.runbook?.currentStep || "等待真实样张授权";
      setProductVisualReadinessMessage(`无费用产品视觉预检通过${jobId ? `，${jobId}` : ""}，下一步：${step}。`);
      const latest = await api.latestV1Acceptance().catch(() => null);
      if (latest) {
        setV1AcceptanceReport(latest);
        setProductVisualReadiness(latest.productVisualReadiness || result);
      }
    } catch (error) {
      setProductVisualReadinessMessage(uiZh(getErrorMessage(error)));
    } finally {
      setProductVisualReadinessBusy(false);
    }
  }

  async function preflightProductVisualSample() {
    setProductVisualSamplePreflightBusy(true);
    setProductVisualSamplePreflightMessage("");
    setProductVisualSamplePromptPreview(null);
    setProductVisualSamplePromptPreviewMessage("");
    setProductVisualSampleRunResult(null);
    setProductVisualSampleRunMessage("");
    setProductVisualSampleApprovalPreflight(null);
    setProductVisualSampleApprovalMessage("");
    setProductVisualFullDeckPreflight(null);
    setProductVisualFullDeckPreflightMessage("");
    setProductVisualFullDeckRunResult(null);
    setProductVisualFullDeckRunMessage("");
    try {
      const result = await api.preflightProductVisualSample({});
      setProductVisualSamplePreflight(result);
      setProductVisualSamplePreflightMessage(result.readyIfConfirmed
        ? `真实样张条件已满足：确认后将使用 ${result.externalImageCalls || 1} 次图片 API。`
        : uiZh(result.summary || "真实样张条件未满足。"));
    } catch (error) {
      setProductVisualSamplePreflightMessage(uiZh(getErrorMessage(error)));
    } finally {
      setProductVisualSamplePreflightBusy(false);
    }
  }

  async function previewProductVisualSamplePrompt() {
    setProductVisualSamplePromptPreviewBusy(true);
    setProductVisualSamplePromptPreviewMessage("");
    try {
      const result = await api.previewProductVisualSamplePrompt({});
      setProductVisualSamplePromptPreview(result);
      setProductVisualSamplePromptPreviewMessage(result.ready
        ? "样张 prompt 已生成预览；该步骤不调用图片 API。"
        : uiZh(result.summary || "样张 prompt 暂不可预览。"));
      if (result.preflight) setProductVisualSamplePreflight(result.preflight);
    } catch (error) {
      setProductVisualSamplePromptPreviewMessage(uiZh(getErrorMessage(error)));
    } finally {
      setProductVisualSamplePromptPreviewBusy(false);
    }
  }

  async function preflightProductVisualFullDeck() {
    if (!productVisualFullDeckCustomValid) {
      setProductVisualFullDeckPreflight(null);
      setProductVisualFullDeckPreflightMessage(productVisualFullDeckPageSelection.message);
      return;
    }
    setProductVisualFullDeckPreflightBusy(true);
    setProductVisualFullDeckPreflightMessage("");
    setProductVisualFullDeckRunResult(null);
    setProductVisualFullDeckRunMessage("");
    try {
      const result = await api.preflightProductVisualFullDeck(productVisualFullDeckRequestBody);
      setProductVisualFullDeckPreflight(result);
      setProductVisualFullDeckPreflightMessage(result.readyIfConfirmed
        ? `全量生成条件已满足：确认后将使用 ${result.externalImageCalls || 15} 次图片 API。`
        : uiZh(result.summary || "全量生成条件未满足。"));
    } catch (error) {
      setProductVisualFullDeckPreflightMessage(uiZh(getErrorMessage(error)));
    } finally {
      setProductVisualFullDeckPreflightBusy(false);
    }
  }

  function changeProductVisualFullDeckMode(mode) {
    const nextMode = mode === "full" ? "full" : mode === "custom" ? "custom" : "test";
    setProductVisualFullDeckMode(nextMode);
    setProductVisualFullDeckPreflight(null);
    setProductVisualFullDeckPreflightMessage("");
    setProductVisualFullDeckRunResult(null);
    setProductVisualFullDeckRunMessage("");
  }

  async function runProductVisualSample() {
    if (!productVisualSamplePreflight?.readyIfConfirmed) {
      setProductVisualSampleRunMessage("请先检查真实样张条件。");
      return;
    }
    const confirmed = window.confirm("将使用 1 次外部图片 API 生成真实 codex-ppt 视觉样张。确认继续？");
    if (!confirmed) return;
    setProductVisualSampleRunBusy(true);
    setProductVisualSampleRunMessage("");
    setProductVisualFullDeckPreflight(null);
    setProductVisualFullDeckPreflightMessage("");
    setProductVisualFullDeckApprovalPreflight(null);
    setProductVisualFullDeckApprovalMessage("");
    try {
      const result = await api.runProductVisualSample({
        confirmExternalImageSpend: true,
        confirmProductVisualSample: true,
        confirmPromptPreview: true,
        promptPreviewJobId: productVisualSamplePreflight.jobId,
        confirmedBy: "frontend-operator",
        reason: "前端确认产品级 v1 真实样张生成"
      });
      setProductVisualSampleRunResult(result);
      setProductVisualSampleRunMessage(result.summary || "真实样张已生成，请复核后确认样张关卡。");
      const latest = await api.latestV1Acceptance().catch(() => null);
      if (latest) setV1AcceptanceReport(latest);
      const nextPreflight = await api.preflightProductVisualSample({}).catch(() => null);
      if (nextPreflight) setProductVisualSamplePreflight(nextPreflight);
      const approvalPreflight = await api.preflightProductVisualSampleApproval({}).catch(() => null);
      if (approvalPreflight) {
        setProductVisualSampleApprovalPreflight(approvalPreflight);
        setProductVisualSampleApprovalMessage(approvalPreflight.ready ? "样张已可确认，复核后点击确认样张关卡。" : uiZh(approvalPreflight.summary || ""));
      }
    } catch (error) {
      if (error.data?.preflight) {
        setProductVisualSamplePreflight(error.data.preflight);
      }
      setProductVisualSampleRunResult(null);
      setProductVisualSampleRunMessage(uiZh(error.data?.preflight?.summary || getErrorMessage(error)));
    } finally {
      setProductVisualSampleRunBusy(false);
    }
  }

  async function preflightProductVisualSampleApproval() {
    setProductVisualSampleApprovalBusy(true);
    setProductVisualSampleApprovalMessage("");
    try {
      const result = await api.preflightProductVisualSampleApproval({});
      setProductVisualSampleApprovalPreflight(result);
      setProductVisualSampleApprovalMessage(result.ready
        ? "样张已可确认，复核后点击确认样张关卡。"
        : uiZh(result.summary || "样张确认条件未满足。"));
    } catch (error) {
      if (error.data?.preflight) {
        setProductVisualSampleApprovalPreflight(error.data.preflight);
      }
      setProductVisualSampleApprovalMessage(uiZh(error.data?.preflight?.summary || getErrorMessage(error)));
    } finally {
      setProductVisualSampleApprovalBusy(false);
    }
  }

  async function approveProductVisualSample() {
    const confirmed = window.confirm("确认当前真实样张已经人工复核通过，并进入全量视觉生成预检？此操作不会调用图片 API。");
    if (!confirmed) return;
    setProductVisualSampleApprovalBusy(true);
    setProductVisualSampleApprovalMessage("");
    try {
      const result = await api.approveProductVisualSample({
        ...productVisualFullDeckRequestBody,
        confirmedBy: "frontend-operator",
        note: "前端复核通过产品级 v1 真实样张"
      });
      setProductVisualSampleApprovalMessage(result.summary || "样张关卡已确认。");
      setProductVisualFullDeckMode("test");
      setProductVisualFullDeckPages("1,2");
      setConfirmLatestProductVisualFullDeck(false);
      const latest = await api.latestV1Acceptance().catch(() => null);
      if (latest) setV1AcceptanceReport(latest);
      if (result.fullDeckPreflight?.ok) {
        setProductVisualFullDeckPreflight(result.fullDeckPreflight);
        setProductVisualFullDeckPreflightMessage(result.fullDeckPreflight.readyIfConfirmed
          ? `视觉生成条件已满足：确认后将使用 ${result.fullDeckPreflight.externalImageCalls || productVisualFullDeckTargetPages} 次图片 API。`
          : uiZh(result.fullDeckPreflight.summary || "全量生成条件未满足。"));
      }
      const approvalPreflight = await api.preflightProductVisualSampleApproval({}).catch(() => null);
      if (approvalPreflight) setProductVisualSampleApprovalPreflight(approvalPreflight);
    } catch (error) {
      setProductVisualSampleApprovalMessage(uiZh(getErrorMessage(error)));
    } finally {
      setProductVisualSampleApprovalBusy(false);
    }
  }

  async function preflightProductVisualFullDeckApproval() {
    if (!productVisualFullDeckCustomValid) {
      setProductVisualFullDeckApprovalPreflight(null);
      setProductVisualFullDeckApprovalMessage(productVisualFullDeckPageSelection.message);
      return;
    }
    setProductVisualFullDeckApprovalBusy(true);
    setProductVisualFullDeckApprovalMessage("");
    try {
      const result = await api.preflightProductVisualFullDeckApproval(productVisualFullDeckRequestBody);
      setProductVisualFullDeckApprovalPreflight(result);
      setProductVisualFullDeckApprovalMessage(result.ready
        ? "全量关卡已可确认；该步骤不会调用图片 API。"
        : uiZh(result.summary || "全量确认条件未满足。"));
    } catch (error) {
      if (error.data?.preflight) {
        setProductVisualFullDeckApprovalPreflight(error.data.preflight);
      }
      setProductVisualFullDeckApprovalMessage(uiZh(error.data?.preflight?.summary || getErrorMessage(error)));
    } finally {
      setProductVisualFullDeckApprovalBusy(false);
    }
  }

  async function approveProductVisualFullDeck() {
    if (!productVisualFullDeckCustomValid) {
      setProductVisualFullDeckApprovalMessage(productVisualFullDeckPageSelection.message);
      return;
    }
    const confirmed = window.confirm("确认当前样张效果可以进入全量视觉生成关卡？此操作不会调用图片 API。");
    if (!confirmed) return;
    setProductVisualFullDeckApprovalBusy(true);
    setProductVisualFullDeckApprovalMessage("");
    try {
      const result = await api.approveProductVisualFullDeck({
        ...productVisualFullDeckRequestBody,
        confirmedBy: "frontend-operator",
        note: "前端确认产品级 v1 全量视觉生成关卡"
      });
      setProductVisualFullDeckApprovalMessage(result.summary || "全量生成关卡已确认。");
      setProductVisualFullDeckMode("test");
      setProductVisualFullDeckPages("1,2");
      setConfirmLatestProductVisualFullDeck(false);
      const latest = await api.latestV1Acceptance().catch(() => null);
      if (latest) setV1AcceptanceReport(latest);
      const approvalPreflight = await api.preflightProductVisualFullDeckApproval(productVisualFullDeckRequestBody).catch(() => null);
      if (approvalPreflight) setProductVisualFullDeckApprovalPreflight(approvalPreflight);
      if (result.fullDeckPreflight?.ok) {
        setProductVisualFullDeckPreflight(result.fullDeckPreflight);
        setProductVisualFullDeckPreflightMessage(result.fullDeckPreflight.readyIfConfirmed
          ? `视觉生成条件已满足：确认后将使用 ${result.fullDeckPreflight.externalImageCalls || productVisualFullDeckTargetPages} 次图片 API。`
          : uiZh(result.fullDeckPreflight.summary || "全量生成条件未满足。"));
      }
    } catch (error) {
      setProductVisualFullDeckApprovalMessage(uiZh(getErrorMessage(error)));
    } finally {
      setProductVisualFullDeckApprovalBusy(false);
    }
  }

  async function runProductVisualFullDeck() {
    if (!productVisualFullDeckCustomValid) {
      setProductVisualFullDeckRunMessage(productVisualFullDeckPageSelection.message);
      return;
    }
    if (!productVisualFullDeckPreflight?.readyIfConfirmed) {
      setProductVisualFullDeckRunMessage("请先检查全量生成条件。");
      return;
    }
    const imageCalls = productVisualFullDeckPreflight.externalImageCalls || 15;
    const targetLabel = productVisualFullDeckMode === "test"
      ? `${productVisualFullDeckTargetPages} 页测试`
      : productVisualFullDeckMode === "custom"
        ? `指定 ${productVisualFullDeckTargetPages} 页`
        : `${productVisualFullDeckTargetPages} 页全量`;
    const confirmed = window.confirm(`将使用 ${imageCalls} 次外部图片 API 生成${targetLabel}视觉统一图片页并组装图片型 PPT。确认继续？`);
    if (!confirmed) return;
    setProductVisualFullDeckRunBusy(true);
    setProductVisualFullDeckRunMessage("");
    try {
      const result = await api.runProductVisualFullDeck({
        ...productVisualFullDeckRequestBody,
        confirmExternalImageSpend: true,
        confirmProductVisualFullDeck: true,
        confirmedBy: "frontend-operator",
        reason: "前端确认产品级 v1 全量视觉生成"
      });
      setProductVisualFullDeckRunResult(result);
      setProductVisualFullDeckRunMessage(result.summary || `${targetLabel}图片型 PPT 中间产物已生成。下一步进入 image-to-editable-ppt 可编辑重建。`);
      const latest = await api.latestV1Acceptance().catch(() => null);
      if (latest) setV1AcceptanceReport(latest);
      const nextPreflight = await api.preflightProductVisualFullDeck(productVisualFullDeckRequestBody).catch(() => null);
      if (nextPreflight) setProductVisualFullDeckPreflight(nextPreflight);
    } catch (error) {
      if (error.data?.preflight) {
        setProductVisualFullDeckPreflight(error.data.preflight);
      }
      setProductVisualFullDeckRunResult(null);
      setProductVisualFullDeckRunMessage(uiZh(error.data?.preflight?.summary || getErrorMessage(error)));
    } finally {
      setProductVisualFullDeckRunBusy(false);
    }
  }

  async function previewWorkflowCleanup() {
    setCleanupBusy("preview");
    setCleanupMessage("");
    try {
      const result = await api.previewWorkflowCleanup({ categories: "internal,regression,probe", limit: 200 });
      setCleanupBundle(result);
      setCleanupMessage(result.candidateCount ? `发现 ${result.candidateCount} 个清理候选。` : "没有发现清理候选。");
    } catch (error) {
      setCleanupMessage(getErrorMessage(error));
    } finally {
      setCleanupBusy("");
    }
  }

  async function archiveWorkflowCleanup() {
    setCleanupBusy("archive");
    setCleanupMessage("");
    try {
      const result = await api.archiveWorkflowCleanup({
        categories: "internal,regression,probe",
        limit: 200,
        archivedBy: "frontend-cleanup",
        reason: "从清理面板归档内部回归/探测工作流"
      });
      setCleanupBundle(result);
      setCleanupMessage(`已归档 ${result.archivedCount || 0} 个清理候选，产物仍保留在磁盘。`);
      await onRefreshList?.();
    } catch (error) {
      setCleanupMessage(getErrorMessage(error));
    } finally {
      setCleanupBusy("");
    }
  }

  return (
    <div className="workflow-rebuild-panel">
      <div className="workflow-rebuild-head">
        <div>
          <b>双技能 PPT 工作流</b>
          <span>先把源页面重绘为 codex-ppt 图片型 PPT，再通过 image-to-editable-ppt/editppt 重建可编辑 PPTX。</span>
        </div>
        <div className="workflow-rebuild-actions">
          <select value={job?.id || ""} onChange={(event) => onSelectJob?.(event.target.value)} disabled={busy || !jobs.length}>
            {jobs.length ? jobs.map((item) => (
              <option key={item.id} value={item.id}>{workflowJobLabel(item)}</option>
            )) : <option value="">暂无工作流</option>}
          </select>
          <button className="btn ghost" type="button" onClick={() => onToggleArchivedVisibility?.(!showArchived)} disabled={busy}>
            {showArchived ? "隐藏已归档" : "显示已归档"}
          </button>
          {job?.archived ? (
            <button className="btn ghost" type="button" onClick={() => onToggleArchive?.(job.id, false)} disabled={busy || !job?.id}>恢复工作流</button>
          ) : (
            <button className="btn ghost" type="button" onClick={() => onToggleArchive?.(job?.id, true)} disabled={busy || !job?.id}>归档当前</button>
          )}
          <button className="btn ghost" type="button" onClick={onRefreshList} disabled={busy}>刷新列表</button>
          <button className="btn primary" type="button" onClick={onRunPipeline} disabled={busy || !hasWorkflowInput}>{busy ? "运行中..." : "创建工作流"}</button>
          <button className="btn ghost" type="button" onClick={onRefresh} disabled={busy || !job?.id}>刷新当前</button>
        </div>
      </div>
      <div className="workflow-rebuild-meta">
        <Metric label="源文件" value={sourceName} />
        <Metric label="工作流" value={job?.id ? job.id.replace(/^workflow_/, "") : "未创建"} />
        <Metric label="下一步" value={uiZh(nextStage || job?.currentStage || "待处理")} />
        <Metric label="页面提示" value={promptCount} />
      </div>
      <WorkflowAgentDashboard
        artifacts={artifacts}
        busy={busy}
        codexSlideTasks={codexSlideTasks}
        delivery={guidedDelivery}
        finalPath={finalPath}
        guidedAction={guidedAction}
        hasWorkflowInput={hasWorkflowInput}
        job={job}
        onCreateWorkflow={onRunPipeline}
        onRunGuidedAction={runGuidedAction}
        readinessBundle={v1ReadinessBundle}
        sourceName={sourceName}
        stages={stages}
        workerTasks={workerTasks}
      />
      <div className="workflow-guided-action">
        <div>
          <b>{uiZh(guidedAction?.title || "推荐下一步")}</b>
          <span>{uiZh(guidedAction?.description || complianceBundle?.runbook?.summary || "创建或选择工作流后继续。")}</span>
        </div>
        <div className={`workflow-guided-delivery ${guidedDelivery.level}`}>
          <strong>{guidedDelivery.title}</strong>
          <span>{guidedDelivery.label}</span>
        </div>
        <button type="button" onClick={runGuidedAction} disabled={busy || !guidedAction || guidedAction.disabled}>
          {uiZh(guidedAction?.label || "待处理")}
        </button>
      </div>
      <div className="workflow-guided-confirmations">
        <label className="workflow-confirm external-spend">
          <input type="checkbox" checked={confirmVisualSampleSpend} onChange={(event) => setConfirmVisualSampleSpend(event.target.checked)} />
          <span>确认视觉样张生成需要 1 次外部图片 API 调用。</span>
        </label>
        <label className="workflow-confirm external-spend">
          <input type="checkbox" checked={confirmCodexImageSpend} onChange={(event) => setConfirmCodexImageSpend(event.target.checked)} />
          <span>确认完整视觉图片生成会使用外部图片 API。</span>
        </label>
      </div>
      {productStyleAction ? (
        <ProductStyleRefreshCard
          action={productStyleAction}
          busy={styleRefreshBusy}
          message={styleRefreshMessage}
          onRefresh={refreshCodexPptStyleEvidence}
        />
      ) : null}
      {productSampleAction ? (
        <ProductSamplePreflightCard
          action={productSampleAction}
          confirmed={confirmVisualSampleSpend}
          blocked={!confirmVisualSampleSpend}
          provider={productSampleProvider}
          onFocus={() => focusDeliveryNextStep({ id: productSampleAction.targetStepId || "generate-sample" })}
        />
      ) : null}
      <GuidedNextActionPreflightCard
        bundle={guidedPreflightBundle}
        guidedAction={guidedAction}
        onContinueRemaining={continueRemainingPagesFromPartialFinal}
      />
      {guidedActionNote ? <p className="workflow-guided-note">{guidedActionNote}</p> : null}
      {pageRetryError ? <p className="workflow-error">{pageRetryError}</p> : null}
      <details className="workflow-advanced-panel workflow-product-advanced">
        <summary>高级详情</summary>
        <p>这里保留给开发和排障：工作流地图、验收门禁、费用、页面任务队列、日志和手动恢复操作。正常使用优先看上面的智能体摘要和下一步按钮。</p>
        <ProductWorkflowMapPanel
          complianceBundle={complianceBundle}
          deliveryGate={deliveryGate}
          job={job}
          tasks={{
            codexSlideTasks,
            editableTasks: workerTasks
          }}
        />
        <ProductV1AcceptancePanel
          authorizationBusy={authorizationBusy}
          acceptanceReport={v1AcceptanceReport}
          acceptanceRun={v1AcceptanceRun}
          acceptanceRunBusy={v1AcceptanceRunBusy}
          acceptanceRunMessage={v1AcceptanceRunMessage}
          acceptancePreflight={v1AcceptancePreflight}
          acceptancePreflightBusy={v1AcceptancePreflightBusy}
          acceptanceSourcePath={v1AcceptanceSourcePath}
          canUseWorkflowAcceptanceSource={canUseWorkflowAcceptanceSource}
          bundle={v1ReadinessBundle}
          onAcceptanceSourcePathChange={setV1AcceptanceSourcePath}
          onAuthorize={recordExternalImageAuthorization}
          onFocusDeliveryStep={focusDeliveryNextStep}
          onPreflightAcceptanceFromWorkflow={() => preflightRealPptAcceptanceRun(true)}
          onPreflightAcceptanceRun={preflightRealPptAcceptanceRun}
          onPreflightProductVisualFullDeck={preflightProductVisualFullDeck}
          onPreflightProductVisualFullDeckApproval={preflightProductVisualFullDeckApproval}
          onPreflightProductVisualSample={preflightProductVisualSample}
          onPreflightProductVisualSampleApproval={preflightProductVisualSampleApproval}
          onPreviewProductVisualSamplePrompt={previewProductVisualSamplePrompt}
          onApproveProductVisualFullDeck={approveProductVisualFullDeck}
          onApproveProductVisualSample={approveProductVisualSample}
          onRunProductVisualReadiness={runProductVisualReadiness}
          onRunProductVisualFullDeck={runProductVisualFullDeck}
          onRunProductVisualSample={runProductVisualSample}
          onProductVisualFullDeckModeChange={changeProductVisualFullDeckMode}
          onProductVisualFullDeckPagesChange={setProductVisualFullDeckPages}
          onRetryFailedPages={retryAllFailedUnifiedTasks}
          onStartAcceptanceFromWorkflow={() => startRealPptAcceptanceRun(true)}
          onStartAcceptanceRun={startRealPptAcceptanceRun}
          onStartEditableWorkerBatch={startEditableWorkerBatch}
          productVisualReadiness={productVisualReadiness}
          productVisualReadinessBusy={productVisualReadinessBusy}
          productVisualReadinessMessage={productVisualReadinessMessage}
          recoveryBusy={pageRetryBusy || (promptLoading ? "prompt-loading" : "")}
          productVisualFullDeckPreflight={productVisualFullDeckPreflight}
          productVisualFullDeckPreflightBusy={productVisualFullDeckPreflightBusy}
          productVisualFullDeckPreflightMessage={productVisualFullDeckPreflightMessage}
          productVisualFullDeckApprovalPreflight={productVisualFullDeckApprovalPreflight}
          productVisualFullDeckApprovalBusy={productVisualFullDeckApprovalBusy}
          productVisualFullDeckApprovalMessage={productVisualFullDeckApprovalMessage}
          productVisualFullDeckRunBusy={productVisualFullDeckRunBusy}
          productVisualFullDeckRunMessage={productVisualFullDeckRunMessage}
          productVisualSamplePreflight={productVisualSamplePreflight}
          productVisualSamplePreflightBusy={productVisualSamplePreflightBusy}
          productVisualSamplePreflightMessage={productVisualSamplePreflightMessage}
          productVisualSamplePromptPreview={productVisualSamplePromptPreview}
          productVisualSamplePromptPreviewBusy={productVisualSamplePromptPreviewBusy}
          productVisualSamplePromptPreviewMessage={productVisualSamplePromptPreviewMessage}
          productVisualSampleApprovalPreflight={productVisualSampleApprovalPreflight}
          productVisualSampleApprovalBusy={productVisualSampleApprovalBusy}
          productVisualSampleApprovalMessage={productVisualSampleApprovalMessage}
          productVisualSampleRunResult={productVisualSampleRunResult}
          productVisualSampleRunBusy={productVisualSampleRunBusy}
          productVisualSampleRunMessage={productVisualSampleRunMessage}
          productVisualFullDeckRunResult={productVisualFullDeckRunResult}
          onRefreshStyleEvidence={refreshCodexPptStyleEvidence}
          styleRefreshBusy={styleRefreshBusy}
          styleRefreshMessage={styleRefreshMessage}
          workflowAcceptanceSourceName={workflowAcceptanceSourceName}
        />
        <WorkflowCostEstimatePanel bundle={costBundle} />
        <WorkflowCodexDeckStatus
          artifacts={artifacts}
          busy={busy}
          canAssembleImageDeck={canAssembleImageDeck}
          canSync={canGenerateVisualDeck}
          complianceBundle={complianceBundle}
          loading={codexSlideLoading}
          onAssemble={() => onRunStep("image-deck/assemble", {}, "正在组装图片型 PPT...")}
          onFocusWorker={focusCodexSlideWorker}
          onSync={syncCodexSlideTasks}
          tasks={codexSlideTasks}
        />
        <details className="workflow-advanced-panel workflow-manual-controls">
          <summary>手动 workflow 控制</summary>
        <p>这些控制用于恢复或运营测试。正常产品流程应优先使用上方推荐步骤。</p>
        <div className="workflow-step-actions">
        <button type="button" onClick={() => onRunStep("source/render", {}, "正在渲染源页面...")} disabled={busy || !job?.id}>渲染源文件</button>
        <button type="button" onClick={() => onRunStep("visual/sample", { confirmExternalImageSpend: confirmVisualSampleSpend }, "正在生成 codex-ppt 视觉样张...")} disabled={busy || !job?.id || !canRunProductVisualSample}>生成样张</button>
        <button type="button" onClick={() => syncCodexSlideTasks()} disabled={busy || !job?.id || !canGenerateVisualDeck}>同步图片页队列</button>
        <button type="button" onClick={() => onRunStep("visual/generate", { confirmExternalImageSpend: confirmCodexImageSpend }, "正在生成视觉统一图片页...")} disabled={busy || !job?.id || !canGenerateVisualDeck || !confirmCodexImageSpend}>生成图片页</button>
        <button type="button" onClick={() => onRunStep("image-deck/assemble", {}, "正在组装图片型 PPT...")} disabled={busy || !canAssembleImageDeck}>组装图片 PPT</button>
        <button type="button" onClick={() => onRunStep("editable/prepare", { force: true, maxConcurrentPages: 6 }, "正在准备 editppt 运行...")} disabled={busy || !job?.artifacts?.imageDeck}>准备 editppt</button>
        <button type="button" onClick={() => onRunStep("editable/hints", {}, "正在重新生成 editppt 文字提示...")} disabled={busy || !job?.artifacts?.editableRun}>重建文字提示</button>
        <button type="button" onClick={() => onRunStep("editable/local-rebuild", { agentId: "main", allowTextDominantLocal: true, acceptOfflineTextHints, offlineTextHintsReason: "frontend limited local rebuild confirmation" }, "正在运行受限单页重建...")} disabled={busy || nextStage !== "rebuild_page_locally"}>受限单页重建</button>
        <button type="button" onClick={() => onRunStep("editable/prompts", {}, "正在构建页面提示...")} disabled={busy || !job?.artifacts?.editableRun}>构建提示</button>
        <button type="button" onClick={() => loadPrompts()} disabled={busy || promptLoading || !job?.id || !promptCount}>{promptLoading ? "加载中..." : "加载提示"}</button>
        <button type="button" onClick={() => onRunStep("editable/finalize", {}, "正在构建最终可编辑 PPTX...")} disabled={busy || nextStage !== "finalize"}>生成最终 PPTX</button>
        </div>
        <WorkflowExternalSpendAuthorizationPanel
          bundle={authorizationBundle}
          busy={authorizationBusy}
          canAuthorizeFullDeck={confirmCodexImageSpend}
          canAuthorizeSample={confirmVisualSampleSpend}
          fullDeckImageCalls={codexFullDeckImageCalls}
          message={authorizationMessage}
          onAuthorize={recordExternalImageAuthorization}
          provider={productSampleProvider}
        />
        </details>
        <details className="workflow-cleanup-panel">
        <summary>工作流清理</summary>
        <p>预览并软归档内部回归、冒烟和探测工作流；用户工作流和文件不会被删除。</p>
        <div className="workflow-cleanup-actions">
          <button type="button" onClick={previewWorkflowCleanup} disabled={busy || Boolean(cleanupBusy)}>
            {cleanupBusy === "preview" ? "预览中..." : "预览清理项"}
          </button>
          <button type="button" onClick={archiveWorkflowCleanup} disabled={busy || Boolean(cleanupBusy) || !cleanupBundle?.candidateCount}>
            {cleanupBusy === "archive" ? "归档中..." : "归档清理候选"}
          </button>
          <span>{cleanupMessage || "软清理只归档工作流，产物仍可通过已归档工作流恢复。"}</span>
        </div>
        {cleanupBundle ? (
          <div className="workflow-cleanup-summary">
            <WorkflowArtifact label="候选项" value={cleanupBundle.candidateCount || 0} />
            <WorkflowArtifact label="已归档" value={cleanupBundle.archivedCount || 0} />
            <WorkflowArtifact label="内部项" value={cleanupBundle.reasonCounts?.internal || 0} />
            <WorkflowArtifact label="探测项" value={cleanupBundle.reasonCounts?.probe || 0} />
          </div>
        ) : null}
        </details>
        <div className="workflow-overview-grid">
        <div className="workflow-overview-card">
          <div className="workflow-overview-card-head">
            <b>工作流阶段</b>
            <span>{stages.filter((stage) => stage.status === "done").length}/{stages.length} 已完成</span>
          </div>
          <div className="workflow-stage-list">
            {stages.map((stage) => (
              <div className={`workflow-stage-row ${stage.status}`} key={stage.id}>
                <span>{stage.label}</span>
                <b>{workflowStatusLabel(stage.status)}</b>
                <small>{stage.message || "等待执行"}</small>
              </div>
            ))}
          </div>
        </div>
        <div className="workflow-overview-card">
          <div className="workflow-overview-card-head">
            <b>产物</b>
            <span>这里只展示真实文件</span>
          </div>
          <div className="workflow-artifact-grid">
            <WorkflowArtifact label="已渲染页面" value={artifactCount(artifacts.renderedPages)} />
            <WorkflowArtifact label="视觉图片" value={artifactCount(artifacts.visualImages)} />
            <WorkflowArtifact label="图片型 PPT" value={shortPath(artifacts.imageDeck?.relativePath || artifacts.imageDeck?.path)} />
            <WorkflowArtifact label="editppt 运行目录" value={shortPath(artifacts.editableRun?.path)} />
            <WorkflowArtifact label="文字提示" value={artifacts.editableHints?.summary ? `${artifacts.editableHints.summary.readyPages || 0}/${artifacts.editableHints.summary.pageCount || 0} 页 / ${artifacts.editableHints.summary.textLineCount || 0} 行` : "待处理"} />
            <WorkflowArtifact label="页面简报" value={artifacts.workerBriefs ? `${artifacts.workerBriefs.pageCount || 0} 页` : "待处理"} />
            <WorkflowArtifact label="最终 PPTX" value={shortPath(finalPath) || "等待页面任务"} />
          </div>
          <WorkflowTextHintEvidencePanel artifacts={artifacts} artifactBundle={artifactBundle} job={job} onRefresh={onRefresh} />
        </div>
        </div>
        <div className="workflow-status-grid">
        <WorkflowCompliancePanel artifactBundle={artifactBundle} bundle={complianceBundle} job={job} onRefresh={onRefresh} />
        <WorkflowDeliverySummary artifactBundle={artifactBundle} bundle={deliveryBundle} status={deliveryStatus} />
        </div>
        <details className="workflow-operator-panel">
        <summary>操作队列</summary>
        <WorkflowEventLogPanel bundle={eventsBundle} job={job} />
        <WorkflowUnifiedSkillTaskBoard
          codexSlideTasks={codexSlideTasks}
          codexSummary={codexSlideBundle?.summary}
          editablePromptCount={promptCount}
          editableSummary={workerTaskBundle?.summary}
          editableTasks={workerTasks}
          finalPath={finalPath}
          nextStage={nextStage}
          onFocusTask={focusUnifiedTask}
          onRetryFailedTasks={retryAllFailedUnifiedTasks}
          onRetryTask={retryUnifiedTask}
          retryBusyKey={pageRetryBusy}
        />
        <WorkflowCodexSlideTaskPanel
          batchPreflight={codexSlideBatchPreflightBundle}
          bundle={codexSlideBundle}
          confirmImageSpend={confirmCodexImageSpend}
          error={codexSlideError}
          focusTask={focusedUnifiedTask?.skillId === "codex-ppt" ? focusedUnifiedTask : null}
          jobId={job?.id || ""}
          loading={codexSlideLoading}
          onBatchPreflightChange={setCodexSlideBatchPreflightBundle}
          onBundleChange={setCodexSlideBundle}
          onRefreshJob={onRefresh}
          onRefresh={() => loadCodexSlideTasks()}
          onRunBatch={startCodexSlideBatch}
          onSetConfirmImageSpend={setConfirmCodexImageSpend}
          onSync={syncCodexSlideTasks}
          tasks={codexSlideTasks}
        />
        <WorkflowArtifactReviewPanel artifactBundle={artifactBundle} job={job} onRefresh={onRefresh} />
        </details>
        <WorkflowEditablePreparePreflightPanel
          bundle={editablePreparePreflight}
          busy={busy || editablePreparePreflightBusy}
          message={editablePreparePreflightMessage}
          onPrepare={() => onRunStep("editable/prepare", { force: true, maxConcurrentPages: 6 }, "正在准备 editppt 运行...")}
          onRefresh={refreshEditablePreparePreflight}
        />
        <div className="workflow-worker-console" id="editable-page-worker-panel">
          <div className="workflow-worker-console-head">
            <div>
              <b>可编辑页面任务</b>
              <span>可编辑重建页面任务只有在真实页面重建结果存在后才允许记录。</span>
            </div>
            <small>{workerTaskBundle?.summary?.recorded || 0}/{workerTaskBundle?.summary?.total ?? workerTasks.length} 已记录</small>
          </div>
          <div className={`workflow-worker-current-task ${selectedEditableStatus}`}>
            <div>
              <span>当前页面</span>
              <b>{selectedPrompt?.pageId || selectedPageId || "未选择页面"}</b>
              <small>{selectedEditableMode}</small>
            </div>
            <div>
              <span>状态</span>
              <b>{workerTaskStatusLabel(selectedEditableStatus)}</b>
              <small>{selectedEditableNext}</small>
            </div>
            <div>
              <span>提示/结果</span>
              <b>{selectedEditablePath || "待处理"}</b>
              <small>{selectedEditableIssue || selectedTask?.agentId || agentId || "未分配"}</small>
            </div>
          </div>
          {focusedEditableTaskLabel ? (
            <div className="workflow-focus-notice">
              <b>已定位详情面板</b>
              <span>来自统一 Skill 任务板：{focusedEditableTaskLabel}</span>
            </div>
          ) : null}
          <div className="workflow-worker-controls">
            <label>
              <span>页面</span>
              <select value={selectedPrompt?.pageId || selectedPageId} onChange={(event) => setSelectedPageId(event.target.value)} disabled={!prompts.length}>
                {prompts.length ? prompts.map((prompt) => <option value={prompt.pageId} key={prompt.pageId}>{prompt.pageId}</option>) : <option value="">等待提示</option>}
              </select>
            </label>
            <label>
              <span>智能体 ID</span>
              <input value={agentId} onChange={(event) => setAgentId(event.target.value)} placeholder="真实页面重建任务的智能体 ID" />
            </label>
            <label className="workflow-confirm">
              <input type="checkbox" checked={confirmSpawned} onChange={(event) => setConfirmSpawned(event.target.checked)} />
              <span>真实页面任务已启动</span>
            </label>
          </div>
          <div className="workflow-offline-hints-confirm">
            <label className="workflow-confirm">
              <input type="checkbox" checked={acceptOfflineTextHints || Boolean(job?.artifacts?.editableTextHintsAcknowledgement?.accepted)} onChange={(event) => setAcceptOfflineTextHints(event.target.checked)} disabled={Boolean(job?.artifacts?.editableTextHintsAcknowledgement?.accepted)} />
              <span>本地 OCR 文字提示未被此工作流确认；允许使用 editppt 离线内置文字提示。</span>
            </label>
            <small>主流程优先使用本地 PaddleOCR / RapidOCR。若当前工作流没有本地 OCR 证据，需要先确认可接受 editppt 离线提示。</small>
          </div>
          <div className="workflow-offline-hints-confirm">
            <label className="workflow-confirm external-spend">
              <input type="checkbox" checked={editableWorkerAuthorizationPersisted} readOnly disabled />
              <span>页面级额度授权账本状态</span>
            </label>
            <small>已选择 {editableBatchSelectedCount} 个页面任务。服务商：{editableImageModel}。启动模型批处理前，需要先记录覆盖这些页面的额度授权账本。</small>
            <small>页面级授权账本：{editableWorkerAuthorizationPersisted ? "已记录" : "未记录"}；页面：{editableWorkerAuthorization?.pageSelection || editableBatchPreflight?.selectedPageIds?.join("、") || "等待预检"}。后端只认页面级授权账本，单纯勾选或请求体确认不会启动模型 worker。</small>
            <div className={`workflow-editable-spend-ledger ${editableWorkerAuthorizationPersisted ? "ready" : "missing"}`}>
              <div>
                <b>{editableWorkerAuthorizationPersisted ? "页面任务额度已记录" : "页面任务额度未记录"}</b>
                <span>{editableWorkerImageCalls || 0} 次可编辑重建页面调用；页面：{editableWorkerAuthorization?.pageSelection || editableBatchPreflight?.selectedPageIds?.join("、") || "等待预检"}</span>
              </div>
              <button type="button" onClick={() => recordExternalImageAuthorization("editable-workers", editableWorkerImageCalls)} disabled={authorizationBusy === "editable-workers" || !editableWorkerImageCalls}>
                {authorizationBusy === "editable-workers" ? "正在记录..." : "记录页面任务额度授权"}
              </button>
            </div>
          </div>
          <WorkflowWorkerBatchPreflightPanel bundle={editableBatchPreflight} />
          <WorkflowEditableFailureRecoveryCard
            failure={latestFailure}
            onOpenLog={() => latestFailedWorkerRun?.logHref && window.open(latestFailedWorkerRun.logHref, "_blank", "noopener,noreferrer")}
            onPreflight={() => loadWorkerBatchPreflight(job.id, {
              mode: "model",
              pages: latestFailurePageSelection || selectedPrompt?.pageId || selectedPageId,
              maxPages: latestFailurePages.length || 1,
              agentPrefix: "product-page-worker",
              confirmLlmProviderRecovered,
              acceptOfflineTextHints: editableOfflineHintsAccepted,
              autoFinalize: true
            })}
            onResetPages={resetLatestFailurePages}
            onSelectPage={(pageId) => setSelectedPageId(pageId)}
            onStartPage={() => startWorkerBatch({
              mode: "model",
              pages: latestFailurePageSelection || selectedPrompt?.pageId || selectedPageId,
              maxPages: latestFailurePages.length || 1,
              agentPrefix: "product-page-worker",
              confirmLlmProviderRecovered: true,
              acceptOfflineTextHints: editableOfflineHintsAccepted,
              autoFinalize: true
            })}
            preflightBusy={promptLoading}
            resetBusy={pageRetryBusy === "reset-latest-failure"}
            run={latestFailedWorkerRun}
            startReady={latestFailurePreflightReady}
          />
          <div className={`workflow-worker-runner ${pageSpecProviderProbe?.ok ? "complete" : pageSpecProviderProbe ? "failed" : "unknown"}`}>
            <div>
              <b>页面重建模型检测</b>
              <span>{pageSpecProviderProbe?.provider?.model || editableBatchPreflight?.pageSpecProvider?.model || editableBatchPreflight?.llmProvider?.model || "等待检测"}</span>
            </div>
            <small>{pageSpecProviderProbeMessage || "检测当前对话模型是否支持图片输入、JSON 输出和非空响应；不生成图片，不启动 worker。"}</small>
            {pageSpecProviderProbe ? (
              <div className="workflow-worker-runner-links">
                <span>文本 JSON：{pageSpecProviderProbe.checks?.textJson?.ok ? "通过" : "失败"}</span>
                <span>图片 JSON：{pageSpecProviderProbe.checks?.visionJson?.ok ? "通过" : "失败"}</span>
                <span>非空输出：{pageSpecProviderProbe.checks?.nonEmpty ? "通过" : "失败"}</span>
              </div>
            ) : null}
          </div>
          {editableLlmProviderRecoveryRequired ? (
            <div className="workflow-offline-hints-confirm workflow-llm-recovery-confirm">
              <label className="workflow-confirm">
                <input
                  type="checkbox"
                  checked={confirmLlmProviderRecovered}
                  onChange={(event) => setConfirmLlmProviderRecovered(event.target.checked)}
                />
                <span>我已处理对话模型服务商额度/鉴权问题，可以重新启动可编辑页面重建。</span>
              </label>
              <small>{uiZh(editableBatchPreflight?.recentProviderFailure?.message || "最近一次可编辑重建失败来自对话模型服务商，启动前请先充值或切换模型服务商。")}</small>
            </div>
          ) : null}
          <div className="workflow-worker-primary-actions">
            <button type="button" onClick={claimWorkerTask} disabled={busy || promptLoading || !selectedPrompt || selectedTask?.status === "recorded"}>1. 认领任务</button>
            <button type="button" onClick={() => runWorkerAction("dispatch")} disabled={busy || promptLoading || !selectedPrompt || selectedTask?.status === "recorded"}>2. 派发任务</button>
            <button
              type="button"
              onClick={() => runWorkerAction("record")}
              disabled={busy || promptLoading || !selectedPrompt || selectedTask?.status === "recorded" || !selectedEditableOutputReady}
              title={!selectedEditableOutputReady ? "页面产物还没有通过契约检查，暂不能记录。" : ""}
            >3. 记录结果</button>
            <button type="button" onClick={resetSelectedWorkerTask} disabled={busy || promptLoading || !selectedPrompt || selectedTask?.status === "recorded"}>重置</button>
          </div>
          <div className="workflow-worker-secondary-actions">
            <button type="button" onClick={syncWorkerTasks} disabled={busy || promptLoading || !job?.id || !promptCount}>同步队列</button>
            <button type="button" onClick={() => loadWorkerTasks()} disabled={busy || promptLoading || !job?.id || !promptCount}>刷新队列</button>
            <button type="button" onClick={startEditableWorkerBatch} disabled={busy || promptLoading || !editableWorkerBatchStartReady}>启动后台批处理</button>
            <button type="button" onClick={probePageSpecProvider} disabled={busy || promptLoading || pageSpecProviderProbeBusy || !job?.id}>{pageSpecProviderProbeBusy ? "检测中..." : "检测页面重建模型"}</button>
            <button type="button" onClick={() => loadWorkerRuns()} disabled={busy || promptLoading || !job?.id}>刷新运行器</button>
            <button type="button" onClick={buildWorkerBriefs} disabled={busy || promptLoading || !job?.id || !promptCount}>生成简报</button>
          </div>
          {promptError ? <p className="workflow-error">{promptError}</p> : null}
          {latestWorkerRun ? (
            <div className={`workflow-worker-runner ${latestWorkerRun.status || "unknown"}`}>
              <div>
                <b>后台页面批处理</b>
                <span>{uiZh(latestWorkerRun.status || "未知")} / {latestWorkerRun.mode || "model"} / pid {latestWorkerRun.pid || "-"}</span>
              </div>
              <code>{latestWorkerRun.relativeLogPath || latestWorkerRun.logPath || "日志待生成"}</code>
              <small>{formatWorkerRunSummary(latestWorkerRun)}</small>
              {latestWorkerRun.failureAnalysis ? (
                <small>{latestWorkerRun.failureAnalysis.title}：{latestWorkerRun.failureAnalysis.reason}</small>
              ) : null}
              <div className="workflow-worker-runner-links">
                {latestWorkerRun.logHref ? <a href={latestWorkerRun.logHref} target="_blank" rel="noreferrer">打开日志</a> : null}
                {latestWorkerRun.logDownloadHref ? <a href={latestWorkerRun.logDownloadHref}>下载日志</a> : null}
              </div>
            </div>
          ) : null}
          <div className="workflow-task-summary">
            <WorkflowArtifact label="任务总数" value={workerTaskBundle?.summary?.total ?? workerTasks.length} />
            <WorkflowArtifact label="就绪" value={workerTaskBundle?.summary?.ready ?? 0} />
            <WorkflowArtifact label="运行中" value={workerTaskBundle?.summary?.running ?? 0} />
            <WorkflowArtifact label="已记录" value={workerTaskBundle?.summary?.recorded ?? 0} />
            <WorkflowArtifact label="失败" value={workerTaskBundle?.summary?.failed ?? 0} />
          </div>
          <div className="workflow-task-list">
            {workerTasks.length ? workerTasks.map((task) => (
              <div className={`workflow-task-row ${task.status}`} key={task.pageId}>
                <b>{task.pageId}</b>
                <span>{task.statusLabel || workerTaskStatusLabel(task.status)}</span>
              <small>{formatEditableTaskIssue(task) || task.evidence?.validationError || task.agentId || task.error || task.relativePath || "等待真实页面任务"}</small>
              </div>
            )) : <div>等待同步页面任务。</div>}
          </div>
          {selectedPrompt ? (
            <div className="workflow-handoff-card">
              <div>
                <b>页面任务已准备</b>
                <span>{selectedPrompt.pageId} / 通过后台批处理继续，不需要手动复制命令</span>
              </div>
              <code>{selectedPrompt.relativePath || selectedPrompt.pageId}</code>
            </div>
          ) : null}
          <div className="workflow-prompt-view">
            <div>
              <b>{selectedPrompt?.pageId || "未选择页面"}</b>
              <span>{selectedEditablePath || "等待后台任务"}</span>
            </div>
            <div>页面重建提示已由后台任务管理；产品界面不再展示或复制原始 prompt。</div>
          </div>
        </div>
      </details>
      <div className="workflow-note">默认流程会先确认视觉方向，再生成统一版本并进入可编辑重建；受限单页路径只用于恢复和诊断。</div>
    </div>
  );
}

function WorkflowAgentMainGuidePanel({ busy = false, hasInput = false, job = null, onCreateWorkflow, onGoMaterials, onGoNext }) {
  const finalGenerated = Boolean(job?.artifacts?.editableFinal?.path);
  const finalReady = Boolean(finalGenerated && job?.artifacts?.manualReview?.status === "approved");
  const imageDeckReady = Boolean(job?.artifacts?.imageDeck?.path);
  const finalHref = finalReady && job?.id ? `/api/workflow-jobs/${encodeURIComponent(job.id)}/artifacts/final-pptx?download=1` : "";
  const steps = [
    {
      id: "source",
      title: "准备源文件",
      desc: hasInput ? "源 PPT、PDF、图片或需求说明已准备。" : "先上传 PPT/PDF/图片，或写一段生成需求。",
      state: hasInput ? "ready" : "active",
      action: <button type="button" onClick={onGoMaterials}>{hasInput ? "查看资料" : "去上传"}</button>
    },
    {
      id: "workflow",
      title: "创建工作流",
      desc: job?.id ? "当前工作流已创建，后续只会继续它。" : "创建后按视觉统一到可编辑重建的主线推进。",
      state: job?.id ? "ready" : hasInput ? "active" : "pending",
      action: job?.id
        ? <button type="button" onClick={onGoNext}>继续任务</button>
        : <button type="button" onClick={onCreateWorkflow} disabled={busy || !hasInput}>{busy ? "创建中..." : "创建工作流"}</button>
    },
    {
      id: "visual",
      title: "生成图片型 PPT",
      desc: "先确认样张，再用图片模型生成视觉统一的图片页。",
      state: imageDeckReady ? "ready" : job?.id ? "active" : "pending",
      action: <button type="button" onClick={onGoNext} disabled={!job?.id}>查看下一步</button>
    },
    {
      id: "editable",
      title: "重建可编辑 PPT",
      desc: finalReady ? "最终可编辑 PPTX 已复核。" : finalGenerated ? "可编辑 PPTX 已生成，等待复核。" : "系统会把视觉页重建为对象级可编辑 PPT。",
      state: finalReady ? "ready" : finalGenerated || imageDeckReady ? "active" : "pending",
      action: finalHref
        ? <a href={finalHref}>下载可编辑 PPT</a>
        : imageDeckReady
          ? <button type="button" onClick={onGoNext}>继续可编辑重建</button>
          : <span>等待结果</span>
    }
  ];
  return (
    <div className="workflow-user-guide agent-main-guide" aria-label="PPT 智能体主流程">
      <div className="workflow-user-guide-head">
        <div>
          <b>PPT 智能体主流程</b>
          <span>普通使用只看这 4 步。页面任务、验收门禁和日志已经收进下方高级详情。</span>
        </div>
        <small>{job?.id ? `当前任务：${job.id.replace(/^workflow_/, "")}` : "还没创建任务"}</small>
      </div>
      <div className="workflow-user-guide-steps">
        {steps.map((step, index) => (
          <div className={`workflow-user-guide-step ${step.state}`} key={step.id}>
            <strong>{String(index + 1).padStart(2, "0")}</strong>
            <b>{step.title}</b>
            <span>{step.desc}</span>
            {step.action}
          </div>
        ))}
      </div>
      <WorkflowProductBoundaryCard />
    </div>
  );
}

function WorkflowUserGuidePanel({ busy = false, hasInput = false, job = null, onCreateWorkflow, onGoMaterials, onGoNext }) {
  const finalGenerated = Boolean(job?.artifacts?.editableFinal?.path);
  const finalReady = Boolean(finalGenerated && job?.artifacts?.manualReview?.status === "approved");
  const imageDeckReady = Boolean(job?.artifacts?.imageDeck?.path);
  const finalHref = finalReady && job?.id ? `/api/workflow-jobs/${encodeURIComponent(job.id)}/artifacts/final-pptx?download=1` : "";
  const steps = [
    {
      id: "source",
      title: "准备资料",
      desc: hasInput ? "资料或需求已准备。" : "先上传 PPT/PDF/图片，或写一句需求。",
      state: hasInput ? "ready" : "active",
      action: <button type="button" onClick={onGoMaterials}>{hasInput ? "查看资料" : "去上传"}</button>
    },
    {
      id: "workflow",
      title: "创建任务",
      desc: job?.id ? "工作流已创建，后续不会重复创建。" : "创建后会按两套 Skill 主线推进。",
      state: job?.id ? "ready" : hasInput ? "active" : "pending",
      action: job?.id
        ? <button type="button" onClick={onGoNext}>继续任务</button>
        : <button type="button" onClick={onCreateWorkflow} disabled={busy || !hasInput}>{busy ? "创建中" : "创建工作流"}</button>
    },
    {
      id: "next",
      title: "按下一步",
      desc: "智能体会提示样张确认、全量生成、可编辑重建。",
      state: job?.id && !finalReady ? "active" : finalReady ? "ready" : "pending",
      action: <button type="button" onClick={onGoNext} disabled={!job?.id}>看下一步</button>
    },
    {
      id: "download",
      title: "下载结果",
      desc: finalReady ? "最终可编辑 PPTX 已复核。" : finalGenerated ? "可编辑 PPTX 已生成，等待人工复核。" : imageDeckReady ? "视觉统一版本已生成，下一步进入可编辑重建。" : "完成后这里会出现最终可编辑 PPT 下载入口。",
      state: finalReady ? "ready" : finalGenerated || imageDeckReady ? "active" : "pending",
      action: finalHref
        ? <a href={finalHref}>下载可编辑 PPT</a>
        : imageDeckReady
          ? <button type="button" onClick={onGoNext}>继续可编辑重建</button>
          : <span>等待结果</span>
    }
  ];
  return (
    <div className="workflow-user-guide" aria-label="四步测试向导">
      <div className="workflow-user-guide-head">
        <div>
          <b>按这 4 步测试</b>
          <span>不需要理解内部任务、页面清单或日志；先按这里走，出问题再打开高级详情。</span>
        </div>
        <small>{job?.id ? "当前任务：" + job.id.replace(/^workflow_/, "") : "还没创建任务"}</small>
      </div>
      <div className="workflow-user-guide-steps">
        {steps.map((step, index) => (
          <div className={`workflow-user-guide-step ${step.state}`} key={step.id}>
            <strong>{String(index + 1).padStart(2, "0")}</strong>
            <b>{step.title}</b>
            <span>{step.desc}</span>
            {step.action}
          </div>
        ))}
      </div>
      <WorkflowProductBoundaryCard />
    </div>
  );
}

function WorkflowProductBoundaryCard() {
  const items = [
    {
      title: "工具目标",
      text: "做成完整 PPT Agent：先生成视觉统一版本，再重建最终可编辑 PPT。"
    },
    {
      title: "当前限制",
      text: "图片型 PPT 只是中间产物；OCR 只是文字提示。当前真实阻塞在可编辑重建用到的对话模型服务商额度/余额，不是 gpt-image-2。"
    },
    {
      title: "完成标准",
      text: "最终文件必须是新的 editable-final.pptx，PowerPoint 能打开，文字/形状可编辑，并且通过交付门禁；作废旧文件不能交付。"
    }
  ];
  return (
    <div className="workflow-product-boundary" aria-label="产品目标和交付边界">
      {items.map((item) => (
        <div key={item.title}>
          <b>{item.title}</b>
          <span>{item.text}</span>
        </div>
      ))}
    </div>
  );
}

function WorkflowAgentDashboard({ artifacts = {}, busy = false, codexSlideTasks = [], delivery = {}, finalPath = "", guidedAction = null, hasWorkflowInput = false, job = null, onCreateWorkflow, onRunGuidedAction, readinessBundle = null, sourceName = "", stages = [], workerTasks = [] }) {
  const currentStage = stages.find((stage) => stage.status === "running" || stage.status === "blocked" || stage.status === "pending") || stages[stages.length - 1] || null;
  const doneCount = stages.filter((stage) => stage.status === "done").length;
  const totalCount = stages.length || 1;
  const progress = Math.round((doneCount / totalCount) * 100);
  const visualRecorded = codexSlideTasks.filter((task) => task.status === "recorded").length;
  const visualTotal = codexSlideTasks.length || artifactCountNumber(artifacts.visualImages);
  const editableRecorded = workerTasks.filter((task) => task.status === "recorded").length;
  const editableTotal = workerTasks.length || artifactCountNumber(artifacts.editableWorkerPrompts);
  const imageDeckPath = artifacts.imageDeck?.relativePath || artifacts.imageDeck?.path || "";
  const deliveryFact = workflowDeliveryFact({ delivery, finalPath, readinessBundle });
  const finalLabel = finalPath
    ? deliveryFact.state === "ready"
      ? "最终可编辑 PPT 可下载"
      : deliveryFact.state === "blocked"
        ? "最终可编辑 PPT 被阻断"
        : "最终可编辑 PPT 等待门禁"
    : imageDeckPath ? "图片型 PPT 中间产物已生成" : "等待生成";
  const finalHint = finalPath
    ? deliveryFact.state === "ready"
      ? "交付门禁已通过，可以下载最终 PPT。"
      : deliveryFact.state === "blocked"
        ? "最终 PPT 已被交付门禁阻断，需要先修复失败证据。"
        : "最终 PPTX 已出现，但还不能作为交付文件下载。"
    : imageDeckPath
      ? "下一步进入可编辑重建。"
      : "完成后会显示最终可编辑 PPT 下载入口。";
  const actionLabel = job?.id ? uiZh(guidedAction?.label || "查看下一步") : "创建工作流";
  const actionDisabled = busy || (job?.id ? (!guidedAction || guidedAction.disabled) : !hasWorkflowInput);
  const runAction = job?.id ? onRunGuidedAction : onCreateWorkflow;
  const deliveryNextStep = readinessBundle?.deliveryNextStep || readinessBundle?.delivery?.nextStep || null;
  const pageEvidenceAction = (readinessBundle?.actionGroups?.pageEvidence || []).find((action) => action?.id === "retry-stale-page-evidence") || null;
  const showRecoveryBanner = Boolean(job?.id && (deliveryNextStep?.id === "retry-stale-page-evidence" || deliveryNextStep?.actionId === "retry-stale-page-evidence" || pageEvidenceAction));
  const recoveryPages = Array.isArray(pageEvidenceAction?.pages) ? pageEvidenceAction.pages : [];
  return (
    <div className="workflow-agent-simple agent-dashboard" id="workflow-agent-simple" aria-label="PPT 智能体当前任务">
      <div className="workflow-agent-simple-head">
        <div>
          <span>PPT 智能体</span>
          <b>{job?.id ? "继续当前任务" : "从这里开始"}</b>
          <small>{job?.id ? uiZh(guidedAction?.description || "我会按视觉统一到可编辑重建的顺序推进。") : "上传文件或输入需求后，我会先创建 PPT 重制任务。"}</small>
        </div>
        <div className={`workflow-agent-delivery ${delivery.level || "pending"}`}>
          <strong>{delivery.title || "交付状态"}</strong>
          <small>{delivery.label || "未开始"}</small>
        </div>
      </div>
      <div className="workflow-agent-progress">
        <div>
          <span>当前阶段</span>
          <b>{uiZh(currentStage?.label || "等待创建工作流")}</b>
          <small>{uiZh(currentStage?.message || sourceName || "先选择资料或输入需求")}</small>
        </div>
        <div>
          <span>整体进度</span>
          <b>{doneCount}/{totalCount}</b>
          <small>{progress}%</small>
        </div>
        <div>
          <span>当前结果</span>
          <b>{finalLabel}</b>
          <small>{finalHint}</small>
        </div>
      </div>
      {showRecoveryBanner ? (
        <div className="workflow-agent-recovery-banner">
          <div>
            <span>交付阻断</span>
            <b>{uiZh(deliveryNextStep?.label || pageEvidenceAction?.label || "重置过期页面证据")}</b>
            <small>{uiZh(deliveryNextStep?.reason || pageEvidenceAction?.detail || "页面任务证据已过期，需要先重置这些页面，再重跑可编辑重建。")}</small>
          </div>
          <div className="workflow-agent-recovery-meta">
            <span>{recoveryPages.length ? `${recoveryPages.length} 页需要恢复` : "需要恢复页面"}</span>
            {recoveryPages.slice(0, 4).map((pageId) => <em key={pageId}>{pageId}</em>)}
            <button type="button" onClick={onRunGuidedAction} disabled={busy || guidedAction?.action !== "retry-stale-page-evidence"}>
              {busy ? "处理中..." : "先重置证据"}
            </button>
          </div>
          <small>重跑页面任务前仍会要求确认外部图片 API 额度，不会静默消耗。</small>
        </div>
      ) : null}
      <div className="workflow-agent-steps">
        <WorkflowAgentFact label="源稿" value={sourceName || "待选择"} state={job?.artifacts?.source || sourceName !== "未选择来源" ? "ready" : "pending"} />
        <WorkflowAgentFact label="图片型 PPT" value={visualTotal ? `${visualRecorded}/${visualTotal} 页` : "待生成"} state={visualTotal && visualRecorded >= visualTotal ? "ready" : visualRecorded ? "working" : "pending"} />
        <WorkflowAgentFact label="可编辑重建" value={editableTotal ? `${editableRecorded}/${editableTotal} 页` : "待重建"} state={editableTotal && editableRecorded >= editableTotal ? "ready" : editableRecorded ? "working" : "pending"} />
        <WorkflowAgentFact label="交付" value={deliveryFact.value} state={deliveryFact.state} />
      </div>
      <div className="workflow-agent-next">
        <button type="button" onClick={runAction} disabled={actionDisabled}>
          {busy ? "处理中..." : actionLabel}
        </button>
        <span>{job?.id ? uiZh(guidedAction?.note || "按下一步推进即可。") : "创建工作流不会直接消耗图片 API；真正生成图片前会再次让你确认。"}</span>
      </div>
    </div>
  );
}

function WorkflowAgentSimplePanel({ artifacts = {}, busy = false, codexSlideTasks = [], delivery = {}, finalPath = "", guidedAction = null, hasWorkflowInput = false, job = null, onCreateWorkflow, onRunGuidedAction, readinessBundle = null, sourceName = "", stages = [], workerTasks = [] }) {
  const currentStage = stages.find((stage) => stage.status === "running" || stage.status === "blocked" || stage.status === "pending") || stages[stages.length - 1] || null;
  const doneCount = stages.filter((stage) => stage.status === "done").length;
  const totalCount = stages.length || 1;
  const progress = Math.round((doneCount / totalCount) * 100);
  const visualRecorded = codexSlideTasks.filter((task) => task.status === "recorded").length;
  const visualTotal = codexSlideTasks.length || artifactCountNumber(artifacts.visualImages);
  const editableRecorded = workerTasks.filter((task) => task.status === "recorded").length;
  const editableTotal = workerTasks.length || artifactCountNumber(artifacts.editableWorkerPrompts);
  const imageDeckPath = artifacts.imageDeck?.relativePath || artifacts.imageDeck?.path || "";
  const deliveryFact = workflowDeliveryFact({ delivery, finalPath, readinessBundle });
  const finalLabel = finalPath
    ? deliveryFact.state === "ready"
      ? shortPath(finalPath)
      : deliveryFact.state === "blocked"
        ? "最终 PPT 被阻断"
        : "最终 PPT 等待门禁"
    : imageDeckPath ? "图片型 PPT 中间产物已生成" : "等待生成";
  const finalHint = finalPath
    ? deliveryFact.state === "ready"
      ? "交付门禁已通过，可以下载最终 PPT"
      : deliveryFact.state === "blocked"
        ? "最终 PPT 已被交付门禁阻断，需要先修复失败证据"
        : "最终 PPTX 已出现，但还不能作为交付文件下载"
    : imageDeckPath
      ? "下一步进入可编辑重建"
      : "完成后会显示最终可编辑 PPT 下载入口";
  const actionLabel = job?.id ? uiZh(guidedAction?.label || "查看下一步") : "创建工作流";
  const actionDisabled = busy || (job?.id ? (!guidedAction || guidedAction.disabled) : !hasWorkflowInput);
  const runAction = job?.id ? onRunGuidedAction : onCreateWorkflow;
  const deliveryNextStep = readinessBundle?.deliveryNextStep || readinessBundle?.delivery?.nextStep || null;
  const pageEvidenceAction = (readinessBundle?.actionGroups?.pageEvidence || []).find((action) => action?.id === "retry-stale-page-evidence") || null;
  const showRecoveryBanner = Boolean(job?.id && (deliveryNextStep?.id === "retry-stale-page-evidence" || deliveryNextStep?.actionId === "retry-stale-page-evidence" || pageEvidenceAction));
  const recoveryPages = Array.isArray(pageEvidenceAction?.pages) ? pageEvidenceAction.pages : [];
  return (
    <div className="workflow-agent-simple" id="workflow-agent-simple" aria-label="PPT 智能体简版进度">
      <div className="workflow-agent-simple-head">
        <div>
          <span>PPT 智能体</span>
          <b>{job?.id ? "继续当前任务" : "从这里开始"}</b>
          <small>{job?.id ? uiZh(guidedAction?.description || "我会按视觉统一到可编辑重建的顺序推进。") : "上传文件或输入需求后，我会先创建 PPT 重制任务。"}</small>
        </div>
        <div className={`workflow-agent-delivery ${delivery.level || "pending"}`}>
          <strong>{delivery.title || "交付状态"}</strong>
          <small>{delivery.label || "未开始"}</small>
        </div>
      </div>
      <div className="workflow-agent-progress">
        <div>
          <span>当前</span>
          <b>{uiZh(currentStage?.label || "等待创建工作流")}</b>
          <small>{uiZh(currentStage?.message || sourceName || "先选择资料或输入需求")}</small>
        </div>
        <div>
          <span>进度</span>
          <b>{doneCount}/{totalCount}</b>
          <small>{progress}%</small>
        </div>
        <div>
          <span>结果</span>
          <b>{finalLabel}</b>
          <small>{finalHint}</small>
        </div>
      </div>
      {showRecoveryBanner ? (
        <div className="workflow-agent-recovery-banner">
          <div>
            <span>交付阻断</span>
            <b>{uiZh(deliveryNextStep?.label || pageEvidenceAction?.label || "重置过期页面证据")}</b>
            <small>{uiZh(deliveryNextStep?.reason || pageEvidenceAction?.detail || "页面任务证据已过期，需要先重置这些页面，再重跑可编辑重建页面任务。")}</small>
          </div>
          <div className="workflow-agent-recovery-meta">
            <span>{recoveryPages.length ? `${recoveryPages.length} 页需恢复` : "需恢复页面"}</span>
            {recoveryPages.slice(0, 4).map((pageId) => <em key={pageId}>{pageId}</em>)}
            <button type="button" onClick={onRunGuidedAction} disabled={busy || guidedAction?.action !== "retry-stale-page-evidence"}>
              {busy ? "处理中..." : "先重置证据"}
            </button>
          </div>
          <small>重跑可编辑页面任务前仍会要求确认外部图片 API 额度，不会静默消耗。</small>
        </div>
      ) : null}
      <div className="workflow-agent-steps">
        <WorkflowAgentFact label="源稿" value={sourceName || "待选择"} state={job?.artifacts?.source || sourceName !== "未选择来源" ? "ready" : "pending"} />
        <WorkflowAgentFact label="视觉重绘" value={visualTotal ? `${visualRecorded}/${visualTotal} 页` : "待生成"} state={visualTotal && visualRecorded >= visualTotal ? "ready" : visualRecorded ? "working" : "pending"} />
        <WorkflowAgentFact label="可编辑重建" value={editableTotal ? `${editableRecorded}/${editableTotal} 页` : "待重建"} state={editableTotal && editableRecorded >= editableTotal ? "ready" : editableRecorded ? "working" : "pending"} />
        <WorkflowAgentFact label="交付" value={deliveryFact.value} state={deliveryFact.state} />
      </div>
      <div className="workflow-agent-next">
        <button type="button" onClick={runAction} disabled={actionDisabled}>
          {busy ? "处理中..." : actionLabel}
        </button>
        <span>{job?.id ? uiZh(guidedAction?.note || "按下一步推进即可。") : "不会直接消耗图片 API；真正生成图片前会再让你确认。"}</span>
      </div>
    </div>
  );
}

function WorkflowAgentFact({ label, state = "pending", value }) {
  return (
    <div className={`workflow-agent-fact ${state}`}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function workflowDeliveryFact({ delivery = {}, finalPath = "", readinessBundle = null } = {}) {
  const finalGate = readinessBundle?.delivery?.finalGate || readinessBundle?.finalGate || null;
  const gateLevel = finalGate?.level || delivery?.level || "";
  const downloadable = finalGate
    ? Boolean(finalGate.productReady || finalGate.downloadable)
    : Boolean(finalPath && delivery?.level === "ready");
  if (downloadable) return { value: "可下载", state: "ready" };
  if (gateLevel === "blocked") return { value: "被阻断", state: "blocked" };
  if (finalPath) return { value: "等待门禁", state: gateLevel || "warning" };
  return { value: "未完成", state: gateLevel || "pending" };
}

function ProductWorkflowMapPanel({ complianceBundle = null, deliveryGate = null, job = null, tasks = {} }) {
  const steps = buildProductWorkflowMap({ complianceBundle, deliveryGate, job, tasks });
  const current = steps.find((step) => step.state === "working" || step.state === "blocked" || step.state === "pending") || steps[steps.length - 1];
  const readyCount = steps.filter((step) => step.state === "ready").length;
  return (
    <div className="product-workflow-map" aria-label="产品工作流地图">
      <div className="product-workflow-map-head">
        <div>
          <b>产品工作流地图</b>
          <span>源稿进入视觉统一版本，再重建为最终可编辑 PPTX。</span>
        </div>
        <div>
          <strong>{current?.label || "就绪"}</strong>
          <small>{readyCount}/{steps.length} 个检查点就绪</small>
        </div>
      </div>
      <div className="product-workflow-steps">
        {steps.map((step, index) => (
          <div className={`product-workflow-step ${step.state}`} key={step.id}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <b>{step.label}</b>
            <small>{step.detail}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProductV1AcceptancePanel({ acceptanceReport = null, acceptanceRun = null, acceptanceRunBusy = false, acceptanceRunMessage = "", acceptancePreflight = null, acceptancePreflightBusy = false, acceptanceSourcePath = "", authorizationBusy = "", bundle = null, canUseWorkflowAcceptanceSource = false, onAcceptanceSourcePathChange, onApproveProductVisualFullDeck, onApproveProductVisualSample, onAuthorize, onFocusDeliveryStep, onPreflightAcceptanceFromWorkflow, onPreflightAcceptanceRun, onPreflightProductVisualFullDeck, onPreflightProductVisualFullDeckApproval, onPreflightProductVisualSample, onPreflightProductVisualSampleApproval, onPreviewProductVisualSamplePrompt, onProductVisualFullDeckModeChange, onProductVisualFullDeckPagesChange, onRefreshStyleEvidence, onRetryFailedPages, onRunProductVisualReadiness, onRunProductVisualFullDeck, onRunProductVisualSample, onStartAcceptanceFromWorkflow, onStartAcceptanceRun, onStartEditableWorkerBatch, productVisualFullDeckApprovalBusy = false, productVisualFullDeckApprovalMessage = "", productVisualFullDeckApprovalPreflight = null, productVisualFullDeckMode = "test", productVisualFullDeckPages = "1,2", productVisualFullDeckPageSelection = null, productVisualFullDeckPreflight = null, productVisualFullDeckPreflightBusy = false, productVisualFullDeckPreflightMessage = "", productVisualFullDeckRunBusy = false, productVisualFullDeckRunMessage = "", productVisualFullDeckRunResult = null, productVisualFullDeckTargetPages = 2, productVisualReadiness = null, productVisualReadinessBusy = false, productVisualReadinessMessage = "", productVisualSampleApprovalBusy = false, productVisualSampleApprovalMessage = "", productVisualSampleApprovalPreflight = null, productVisualSamplePreflight = null, productVisualSamplePreflightBusy = false, productVisualSamplePreflightMessage = "", productVisualSamplePromptPreview = null, productVisualSamplePromptPreviewBusy = false, productVisualSamplePromptPreviewMessage = "", productVisualSampleRunBusy = false, productVisualSampleRunMessage = "", productVisualSampleRunResult = null, productVisualTargetPages = 15, recoveryBusy = "", styleRefreshBusy = false, styleRefreshMessage = "", workflowAcceptanceSourceName = "" }) {
  if (!bundle?.checks?.length) {
    return (
      <div className="product-v1-acceptance pending">
        <div className="product-v1-acceptance-head">
          <div>
            <b>产品级 v1 验收</b>
            <span>创建或选择工作流后，这里会显示交付证据。</span>
          </div>
          <strong>等待中</strong>
        </div>
      </div>
    );
  }
  const visibleChecks = bundle.checks.slice(0, 12);
  const deliveryNextStep = bundle.deliveryNextStep || bundle.delivery?.nextStep || null;
  const workerEvidence = bundle.workerEvidence || {};
  const codexSlidePreflight = bundle.codexSlideBatchPreflight || null;
  const batchPreflight = bundle.workerBatchPreflight || workerEvidence.batchPreflight || null;
  const providerCheck = bundle.checks.find((check) => check.id === "provider-runtime") || null;
  const styleCheck = bundle.checks.find((check) => check.id === "codex-ppt-approval-chain") || null;
  const realDeckCheck = bundle.checks.find((check) => check.id === "real-deck-acceptance-target") || null;
  const imageDeckCheck = bundle.checks.find((check) => check.id === "image-deck") || null;
  const textHintCheck = bundle.checks.find((check) => check.id === "ocr-text-hint-coverage") || null;
  const qualityCheck = bundle.checks.find((check) => check.id === "page-final-evidence-quality") || null;
  const finalCheck = bundle.checks.find((check) => check.id === "final-editable-pptx") || null;
  const downloadCheck = bundle.checks.find((check) => check.id === "validation-and-downloads") || null;
  const providerActions = bundle.actionGroups?.provider || [];
  const authorizationActions = bundle.actionGroups?.authorization || [];
  return (
    <div className={`product-v1-acceptance ${bundle.level || "pending"}`}>
      <div className="product-v1-acceptance-head">
        <div>
          <b>产品级 v1 验收</b>
          <span>{uiZh(bundle.summary || "当前工作流的验收证据。")}</span>
        </div>
        <div>
          <strong>{uiZh(bundle.title || "v1 验收")}</strong>
          <small>{bundle.counts?.pass || 0}/{bundle.counts?.total || visibleChecks.length} 通过</small>
        </div>
      </div>
      <ProductV1ScopeSummary imageDeckCheck={imageDeckCheck} textHintCheck={textHintCheck} />
      <div className="product-v1-acceptance-grid">
        {visibleChecks.map((check) => (
          <div className={`product-v1-check ${check.status}`} key={check.id}>
            <span>{uiZh(check.label)}</span>
            <b>{v1AcceptanceStatusLabel(check.status)}</b>
            <small title={uiZh(check.detail)}>{uiZh(check.detail)}</small>
          </div>
        ))}
      </div>
      <ProductV1RealDeckAcceptanceCard
        acceptanceReport={acceptanceReport}
        acceptanceRun={acceptanceRun}
        acceptanceRunBusy={acceptanceRunBusy}
        acceptanceRunMessage={acceptanceRunMessage}
        acceptancePreflight={acceptancePreflight}
        acceptancePreflightBusy={acceptancePreflightBusy}
        acceptanceSourcePath={acceptanceSourcePath}
        canUseWorkflowAcceptanceSource={canUseWorkflowAcceptanceSource}
        check={realDeckCheck}
        finalCheck={finalCheck}
        onAcceptanceSourcePathChange={onAcceptanceSourcePathChange}
        onPreflightAcceptanceFromWorkflow={onPreflightAcceptanceFromWorkflow}
        onPreflightAcceptanceRun={onPreflightAcceptanceRun}
        onPreflightProductVisualFullDeck={onPreflightProductVisualFullDeck}
        onPreflightProductVisualFullDeckApproval={onPreflightProductVisualFullDeckApproval}
        onPreflightProductVisualSample={onPreflightProductVisualSample}
        onPreflightProductVisualSampleApproval={onPreflightProductVisualSampleApproval}
        onPreviewProductVisualSamplePrompt={onPreviewProductVisualSamplePrompt}
        onApproveProductVisualFullDeck={onApproveProductVisualFullDeck}
        onApproveProductVisualSample={onApproveProductVisualSample}
        onRunProductVisualReadiness={onRunProductVisualReadiness}
        onRunProductVisualFullDeck={onRunProductVisualFullDeck}
        onRunProductVisualSample={onRunProductVisualSample}
        onProductVisualFullDeckModeChange={onProductVisualFullDeckModeChange}
        onProductVisualFullDeckPagesChange={onProductVisualFullDeckPagesChange}
        onStartAcceptanceFromWorkflow={onStartAcceptanceFromWorkflow}
        onStartAcceptanceRun={onStartAcceptanceRun}
        productVisualReadiness={productVisualReadiness}
        productVisualReadinessBusy={productVisualReadinessBusy}
        productVisualReadinessMessage={productVisualReadinessMessage}
        productVisualFullDeckPreflight={productVisualFullDeckPreflight}
        productVisualFullDeckPreflightBusy={productVisualFullDeckPreflightBusy}
        productVisualFullDeckPreflightMessage={productVisualFullDeckPreflightMessage}
        productVisualFullDeckApprovalPreflight={productVisualFullDeckApprovalPreflight}
        productVisualFullDeckApprovalBusy={productVisualFullDeckApprovalBusy}
        productVisualFullDeckApprovalMessage={productVisualFullDeckApprovalMessage}
        productVisualFullDeckRunBusy={productVisualFullDeckRunBusy}
        productVisualFullDeckRunMessage={productVisualFullDeckRunMessage}
          productVisualFullDeckRunResult={productVisualFullDeckRunResult}
          productVisualFullDeckMode={productVisualFullDeckMode}
          productVisualFullDeckPages={productVisualFullDeckPages}
          productVisualFullDeckPageSelection={productVisualFullDeckPageSelection}
          productVisualFullDeckTargetPages={productVisualFullDeckTargetPages}
        productVisualTargetPages={productVisualTargetPages}
        productVisualSamplePreflight={productVisualSamplePreflight}
        productVisualSamplePreflightBusy={productVisualSamplePreflightBusy}
        productVisualSamplePreflightMessage={productVisualSamplePreflightMessage}
        productVisualSamplePromptPreview={productVisualSamplePromptPreview}
        productVisualSamplePromptPreviewBusy={productVisualSamplePromptPreviewBusy}
        productVisualSamplePromptPreviewMessage={productVisualSamplePromptPreviewMessage}
        productVisualSampleApprovalBusy={productVisualSampleApprovalBusy}
        productVisualSampleApprovalMessage={productVisualSampleApprovalMessage}
        productVisualSampleApprovalPreflight={productVisualSampleApprovalPreflight}
        productVisualSampleRunBusy={productVisualSampleRunBusy}
        productVisualSampleRunMessage={productVisualSampleRunMessage}
        productVisualSampleRunResult={productVisualSampleRunResult}
        workerEvidence={workerEvidence}
        workflowAcceptanceSourceName={workflowAcceptanceSourceName}
      />
      <ProductV1TextHintCoverageCard check={textHintCheck} />
      <ProductV1QualityEvidenceCard check={qualityCheck} />
      <ProductV1DownloadGateCard check={downloadCheck} />
      <ProductV1StyleEvidenceSummary
        actions={bundle.actionGroups?.style || []}
        busy={styleRefreshBusy}
        check={styleCheck}
        message={styleRefreshMessage}
        onRefreshStyleEvidence={onRefreshStyleEvidence}
      />
      <ProductV1LlmRecoveryCard
        bundle={batchPreflight}
        deliveryNextStep={deliveryNextStep}
        onFocusDeliveryStep={onFocusDeliveryStep}
        onRetryFailedPages={onRetryFailedPages}
        onStartEditableWorkerBatch={onStartEditableWorkerBatch}
        recoveryBusy={recoveryBusy}
      />
      {deliveryNextStep ? (
        <div className="product-v1-delivery-next">
          <div>
            <span>当前交付步骤</span>
            <b>{uiZh(deliveryNextStep.label)}</b>
            <small>{uiZh(deliveryNextStep.reason)}</small>
            <button type="button" onClick={() => onFocusDeliveryStep?.(deliveryNextStep)}>打开步骤面板</button>
          </div>
          <div className="product-v1-worker-facts">
            <span><b>{workerEvidence.ready || 0}</b>就绪</span>
            <span><b>{workerEvidence.running || 0}</b>运行中</span>
            <span><b>{workerEvidence.recorded || 0}</b>已记录</span>
            <span><b>{workerEvidence.failed || 0}</b>失败</span>
          </div>
        </div>
      ) : null}
      <ProductV1AuthorizationSummary
        authorizationBusy={authorizationBusy}
        actions={authorizationActions}
        bundle={bundle.authorization || null}
        onAuthorize={onAuthorize}
        onFocusDeliveryStep={onFocusDeliveryStep}
      />
      {codexSlidePreflight ? (
        <ProductV1CodexSlidePreflightSummary
          actions={bundle.actionGroups?.codexSlide || []}
          bundle={codexSlidePreflight}
          resetPreview={bundle.codexSlideResetPreview || null}
          onFocusDeliveryStep={onFocusDeliveryStep}
        />
      ) : null}
      {providerCheck ? (
        <ProductV1ProviderRuntimeSummary
          actions={providerActions}
          check={providerCheck}
          onFocusDeliveryStep={onFocusDeliveryStep}
        />
      ) : null}
      {batchPreflight ? <ProductV1WorkerPreflightSummary actions={bundle.actionGroups?.preflight || []} bundle={batchPreflight} /> : null}
      {bundle.nextActions?.length ? (
        <div className="product-v1-next">
          <span>下一条证据</span>
          <b>{uiZh(bundle.nextActions[0])}</b>
        </div>
      ) : null}
    </div>
  );
}

function ProductV1ScopeSummary({ imageDeckCheck = null, textHintCheck = null }) {
  const imageEvidence = imageDeckCheck?.evidence || {};
  const textEvidence = textHintCheck?.evidence || {};
  const sourcePages = Number(imageEvidence.sourcePages || textEvidence.sourcePages || 0);
  const currentScopePages = Number(imageEvidence.currentScopePages || textEvidence.expectedPages || 0);
  const partial = Boolean(imageEvidence.partial || textEvidence.partialScope);
  if (!sourcePages && !currentScopePages) return null;
  return (
    <div className={`product-v1-scope-summary ${partial ? "partial" : "full"}`}>
      <div>
        <span>当前处理范围</span>
        <b>{partial ? `${currentScopePages}/${sourcePages} 页测试范围` : `${currentScopePages || sourcePages} 页全量范围`}</b>
        <small>{partial ? `当前证据只覆盖测试页，完整 v1 仍需跑完 ${sourcePages} 页。` : "当前证据已按完整源稿范围统计。"}</small>
      </div>
      <div>
        <span>图片型 PPT</span>
        <b>{v1AcceptanceStatusLabel(imageDeckCheck?.status)}</b>
        <small>{uiZh(imageDeckCheck?.detail || "等待 codex-ppt 图片型 PPT 证据。")}</small>
      </div>
      <div>
        <span>OCR / 文字提示</span>
        <b>{v1AcceptanceStatusLabel(textHintCheck?.status)}</b>
        <small>{uiZh(textHintCheck?.detail || "等待 OCR 或 editppt 文字提示。")}</small>
      </div>
    </div>
  );
}

function ProductV1TextHintCoverageCard({ check = null }) {
  if (!check) return null;
  const evidence = check.evidence || {};
  const state = check.status === "pass" ? "pass" : check.status === "warning" ? "warning" : "pending";
  const coverage = Number(evidence.coverageRatio || 0);
  const percent = Math.round(Math.max(0, Math.min(1, coverage)) * 100);
  return (
    <div className={`product-v1-text-hints ${state}`}>
      <div className="product-v1-text-hints-head">
        <div>
          <span>OCR 文字提示</span>
          <b>{check.status === "pass" ? "文字提示已满足 v1 验收" : evidence.hasAnyTextHints ? "文字提示仍需复核" : "等待文字提示证据"}</b>
          <small>{uiZh(check.detail || "等待 OCR 或 editppt 文字提示。")}</small>
        </div>
        <strong>{v1AcceptanceStatusLabel(check.status)}</strong>
      </div>
      <div className="product-v1-text-hints-facts">
        <span>范围<b>{evidence.partialScope ? `${evidence.expectedPages || 0}/${evidence.sourcePages || 0} 测试` : `${evidence.expectedPages || 0} 页`}</b></span>
        <span>覆盖页数<b>{evidence.coveredPages || 0}/{evidence.expectedPages || 0}</b></span>
        <span>覆盖率<b>{percent}%</b></span>
        <span>OCR 文字<b>{evidence.ocrTextCount || 0}</b></span>
        <span>低置信<b>{evidence.lowConfidenceCount || 0}</b></span>
        <span>已修正<b>{evidence.correctedCount || 0}</b></span>
        <span>文字提示<b>{evidence.editableReadyPages || 0}/{evidence.editableHintPageCount || 0}</b></span>
      </div>
    </div>
  );
}

function ProductV1QualityEvidenceCard({ check = null }) {
  if (!check) return null;
  const evidence = check.evidence || {};
  const state = check.status === "pass" ? "pass" : check.status === "warning" ? "warning" : "pending";
  const riskCount = Number(evidence.manifestIssueCount || 0)
    + Number(evidence.finalIssueCount || 0)
    + Number(evidence.fullSlidePictures || 0);
  return (
    <div className={`product-v1-quality-evidence ${state}`}>
      <div className="product-v1-quality-evidence-head">
        <div>
          <span>页面证据质量</span>
          <b>{check.status === "pass" ? "页面与最终证据已满足 v1 验收" : evidence.hasAnyEvidence ? "页面与最终证据仍需复核" : "等待页面与最终证据"}</b>
          <small>{uiZh(check.detail || "等待页面重建证据、清单、校验证据和最终文件哈希。")}</small>
        </div>
        <strong>{v1AcceptanceStatusLabel(check.status)}</strong>
      </div>
      <div className="product-v1-quality-evidence-facts">
        <span>完整页面<b>{evidence.completePages || 0}/{evidence.totalPages || 0}</b></span>
        <span>manifest 合同<b>{evidence.manifestContractPages || 0}</b></span>
        <span>页面校验<b>{evidence.validationPassedPages || 0}</b></span>
        <span>页面 hash<b>{evidence.hashMatchedPages || 0}</b></span>
        <span>最终校验<b>{evidence.finalValidationPassed ? "通过" : "待通过"}</b></span>
        <span>最终 hash<b>{evidence.finalHashMatched ? "一致" : "待确认"}</b></span>
        <span>整页大图<b>{evidence.fullSlidePictures || 0}</b></span>
        <span>风险项<b>{riskCount}</b></span>
      </div>
    </div>
  );
}

function ProductV1DownloadGateCard({ check = null }) {
  if (!check) return null;
  const evidence = check.evidence || {};
  const missingLinks = Array.isArray(evidence.missingLinks) ? evidence.missingLinks : [];
  const requiredLinks = Array.isArray(evidence.requiredLinks) ? evidence.requiredLinks : [];
  const state = check.status === "pass" ? "pass" : check.status === "warning" ? "warning" : "pending";
  return (
    <div className={`product-v1-download-gate ${state}`}>
      <div className="product-v1-download-gate-head">
        <div>
          <b>{check.status === "pass" ? "下载验收已通过" : evidence.finalDownloadable ? "下载材料未齐" : "最终 PPTX 暂不可交付下载"}</b>
          <small>{uiZh(check.detail || "等待最终产物和校验证据。")}</small>
        </div>
        <strong>{v1AcceptanceStatusLabel(check.status)}</strong>
      </div>
      <div className="product-v1-download-gate-facts">
        <span>最终 PPTX<b>{evidence.finalDownloadable ? "可下载" : "被阻断"}</b></span>
        <span>门禁状态<b>{uiZh(evidence.finalGateLevel || "待处理")}</b></span>
        <span>必需下载<b>{requiredLinks.length || 4} 项</b></span>
        <span>缺少项<b>{missingLinks.length ? missingLinks.join(", ") : "无"}</b></span>
      </div>
    </div>
  );
}

function ProductV1StyleEvidenceSummary({ actions = [], busy = false, check = null, message = "", onRefreshStyleEvidence }) {
  const style = check?.evidence?.style || {};
  if (!check && !actions.length && !style.exists) return null;
  const legacy = Boolean(style.legacy || actions.length);
  const state = legacy ? "warning" : style.exists ? "ready" : "pending";
  return (
    <div className={`product-v1-style-evidence ${state}`}>
      <div>
        <span>视觉风格证据</span>
        <b>{legacy ? "需要刷新风格证据" : style.exists ? "风格证据可用" : "等待风格证据"}</b>
        <small>{legacy ? `检测到历史风格痕迹${style.legacyToken ? `，${style.legacyToken}` : ""}` : uiZh(check?.detail || "记录 PPT 重制任务的视觉风格说明。")}</small>
      </div>
      <div className="product-v1-style-facts">
        <span>证据<b>{style.exists ? "存在" : "缺少"}</b></span>
        <span>来源<b>{style.source || "未记录"}</b></span>
        <span>历史风格<b>{legacy ? "需刷新" : "未发现"}</b></span>
      </div>
      {actions.length ? (
        <div className="product-v1-style-actions">
          <span>风格操作</span>
          {actions.slice(0, 2).map((action) => (
            <button key={action.id || action.detail} type="button" onClick={onRefreshStyleEvidence} disabled={busy || !onRefreshStyleEvidence}>
              {busy ? "正在刷新..." : uiZh(action.detail)}
            </button>
          ))}
        </div>
      ) : null}
      {message ? <small>{message}</small> : null}
    </div>
  );
}

function summarizeCompletionPreflightResult(result = {}) {
  if (!result || typeof result !== "object") return "预检已完成。";
  if (result.readyIfUserConfirmed) return result.summary || "预检通过；执行前仍需人工确认服务商已恢复。";
  if (result.readyIfConfirmed) return result.summary || "预检通过；下一步仍需明确确认额度后才能执行。";
  if (result.startReady) return result.summary || "预检通过；已具备启动条件，执行前仍需确认额度。";
  if (result.ready) return result.summary || "预检通过。";
  const blockingIssues = Array.isArray(result.blockingIssues) ? result.blockingIssues : [];
  if (blockingIssues.length) return uiZh(blockingIssues.slice(0, 2).join("；"));
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  if (warnings.length) return uiZh(warnings.slice(0, 2).join("；"));
  if (result.error) return uiZh(result.error);
  if (result.summary) return uiZh(result.summary);
  return "预检已完成，请查看高级详情。";
}

function ProductV1RealDeckAcceptanceCard({ acceptanceReport = null, acceptanceRun = null, acceptanceRunBusy = false, acceptanceRunMessage = "", acceptancePreflight = null, acceptancePreflightBusy = false, acceptanceSourcePath = "", canUseWorkflowAcceptanceSource = false, check = null, finalCheck = null, onAcceptanceSourcePathChange, onApproveProductVisualFullDeck, onApproveProductVisualSample, onPreflightAcceptanceFromWorkflow, onPreflightAcceptanceRun, onPreflightProductVisualFullDeck, onPreflightProductVisualFullDeckApproval, onPreflightProductVisualSample, onPreflightProductVisualSampleApproval, onPreviewProductVisualSamplePrompt, onProductVisualFullDeckModeChange, onProductVisualFullDeckPagesChange, onRunProductVisualReadiness, onRunProductVisualFullDeck, onRunProductVisualSample, onStartAcceptanceFromWorkflow, onStartAcceptanceRun, productVisualFullDeckApprovalBusy = false, productVisualFullDeckApprovalMessage = "", productVisualFullDeckApprovalPreflight = null, productVisualFullDeckMode = "test", productVisualFullDeckPages = "1,2", productVisualFullDeckPageSelection = null, productVisualFullDeckPreflight = null, productVisualFullDeckPreflightBusy = false, productVisualFullDeckPreflightMessage = "", productVisualFullDeckRunBusy = false, productVisualFullDeckRunMessage = "", productVisualFullDeckRunResult = null, productVisualFullDeckTargetPages = 2, productVisualReadiness = null, productVisualReadinessBusy = false, productVisualReadinessMessage = "", productVisualSampleApprovalBusy = false, productVisualSampleApprovalMessage = "", productVisualSampleApprovalPreflight = null, productVisualSamplePreflight = null, productVisualSamplePreflightBusy = false, productVisualSamplePreflightMessage = "", productVisualSamplePromptPreview = null, productVisualSamplePromptPreviewBusy = false, productVisualSamplePromptPreviewMessage = "", productVisualSampleRunBusy = false, productVisualSampleRunMessage = "", productVisualSampleRunResult = null, productVisualTargetPages = 15, workerEvidence = {}, workflowAcceptanceSourceName = "" }) {
  const [confirmLatestProductVisualSample, setConfirmLatestProductVisualSample] = useState(false);
  const [confirmLatestProductVisualFullDeck, setConfirmLatestProductVisualFullDeck] = useState(false);
  const [completionPreflightBusy, setCompletionPreflightBusy] = useState("");
  const [completionPreflightResults, setCompletionPreflightResults] = useState({});
  const [confirmCompletionLocalPreparation, setConfirmCompletionLocalPreparation] = useState({});
  if (!check && !finalCheck) return null;
  const evidence = check?.evidence || {};
  const finalEvidence = finalCheck?.evidence || {};
  const latestReport = acceptanceReport?.latest || null;
  const acceptance = latestReport?.acceptance || acceptanceReport?.acceptance || null;
  const phaseProgress = acceptance?.phaseProgress || latestReport?.phaseProgress || acceptanceReport?.phaseProgress || null;
  const sourcePages = Number(evidence.sourcePages || 0);
  const finalPages = Number(finalEvidence.finalPages || 0);
  const recordedPages = Number(workerEvidence.recorded || 0);
  const totalPages = Number(workerEvidence.total || sourcePages || 0);
  const reportPages = Number(latestReport?.sourceRender?.renderedPages || 0);
  const reportVisualImages = Number(latestReport?.visual?.visualImages || 0);
  const reportEditableFinal = latestReport?.editable?.final?.path || latestReport?.artifacts?.editableFinal || "";
  const reportReady = Boolean(acceptance?.ready) || (!acceptance && Boolean(latestReport?.ok && reportPages >= 15 && latestReport?.visual?.imageDeck && reportEditableFinal));
  const isRealDeckTarget = check?.status === "pass";
  const isProductReady = finalCheck?.status === "pass" && Boolean(finalEvidence.productReady);
  const state = (isRealDeckTarget && isProductReady) || reportReady ? "pass" : acceptance?.level === "fail" ? "fail" : isRealDeckTarget ? "warning" : "pending";
  const acceptanceMissing = Array.isArray(acceptance?.missing) ? acceptance.missing : [];
  const acceptanceCounts = acceptance?.counts || {};
  const productVisualNext = latestReport?.productVisualNext || acceptance?.productVisualNext || acceptanceReport?.productVisualNext || null;
  const completionAudit = acceptance?.completionAudit || latestReport?.completionAudit || acceptanceReport?.completionAudit || null;
  const completionAuditNextSteps = Array.isArray(completionAudit?.nextSteps) ? completionAudit.nextSteps : [];
  const completionExecutionPlan = completionAudit?.executionPlan || null;
  const completionExecutionSteps = Array.isArray(completionExecutionPlan?.steps) ? completionExecutionPlan.steps : [];
  const completionCurrentAction = completionExecutionPlan?.currentAction || null;
  const currentActionPaidAction = completionCurrentAction?.paidAction || null;
  const currentActionIsProductVisualSample = currentActionPaidAction?.id === "product-visual-sample-run";
  const currentActionResultKey = completionCurrentAction
    ? `${completionCurrentAction.stepId || completionCurrentAction.noCostPreflight?.id || "current-action"}:current`
    : "";
  const currentActionPreflightResult = currentActionResultKey ? completionPreflightResults[currentActionResultKey] : null;
  const canRunCurrentActionPreflight = Boolean(
    completionCurrentAction?.noCostPreflight?.path
    && completionCurrentAction.noCostPreflight.safeToRunAutomatically === true
    && !completionCurrentAction.noCostPreflight.paidImageGeneration
  );
  const completionAuditBlockerSummary = completionAudit?.blockerSummary || null;
  const productActions = Array.isArray(productVisualNext?.productActions) ? productVisualNext.productActions : [];
  const productVisualCalls = productVisualNext?.externalImageCalls || {};
  const productVisualSpendPlan = productVisualNext?.spendPlan || null;
  const productVisualSpendSteps = Array.isArray(productVisualSpendPlan?.steps) ? productVisualSpendPlan.steps : [];
  const productCompletionReady = completionAudit ? Boolean(completionAudit.ready) : Boolean(acceptance?.ready);
  const productCompletionState = productCompletionReady ? "ready" : completionAudit?.level === "blocked" || productVisualNext?.status === "action-required" || acceptance?.level === "fail" ? "blocked" : "pending";
  const auditMissingChecks = Array.isArray(completionAudit?.missingRequiredChecks) ? completionAudit.missingRequiredChecks : [];
  const productCompletionMissingLabel = auditMissingChecks.length
    ? auditMissingChecks.slice(0, 2).map((item) => uiZh(item.label || item.id)).join("、")
    : acceptanceMissing.length
    ? acceptanceMissing.slice(0, 2).map((item) => uiZh(item.label || item.id)).join("、")
    : productVisualNext?.missingCheckId
      ? uiZh(productVisualNext.missingCheckId)
      : "无";
  const productCompletionSummary = completionAudit?.summary ? uiZh(completionAudit.summary) : productCompletionReady
    ? "真实 15 页验收已覆盖产品级交付要求。"
    : productVisualNext?.requiresExplicitSpendConfirmation
      ? `还差 ${productCompletionMissingLabel}；下一步需要你明确确认外部图片 API 后，先样张再全量。`
      : `还差 ${productCompletionMissingLabel}；请按下一步补齐验收证据。`;
  const productCompletionNextCalls = Number(completionAudit?.nextStepExternalImageCalls ?? completionAudit?.nextStep?.externalImageCalls ?? 0);
  const productCompletionRemainingCalls = Number(completionAudit?.remainingExternalImageCalls ?? productVisualSpendPlan?.totalExternalImageCalls ?? productVisualCalls.total ?? 0);
  const productVisualRangeOptions = [
    {
      id: "test",
      title: "先试 2 页",
      detail: "适合先看跨页风格、信息密度和画面质量。",
      action: productActions.find((action) => action.id === "product-visual-test-deck-run")
    },
    {
      id: "custom",
      title: "只跑指定页",
      detail: "适合重跑问题页或先挑关键页验证。",
      action: productActions.find((action) => action.id === "product-visual-custom-pages-run")
    },
    {
      id: "full",
      title: "生成全部",
      detail: "样张和测试页确认后，再生成完整图片型 PPT。",
      action: productActions.find((action) => action.id === "product-visual-full-deck-run")
    }
  ].filter((item) => item.action);
  const productVisualAgentNextAction = buildProductVisualAgentNextAction({
    productVisualNext,
    productVisualSamplePreflight,
    productVisualSampleRunResult,
    productVisualSampleApprovalPreflight,
    productVisualFullDeckApprovalPreflight,
    productVisualFullDeckPreflight,
    productVisualFullDeckRunResult,
    fullDeckTargetPages: Number(productVisualFullDeckTargetPages || 2)
  });
  const productVisualReadinessLatest = productVisualReadiness?.latest || productVisualReadiness || null;
  const productVisualResult = productVisualReadinessLatest?.result || productVisualReadiness?.result || null;
  const productVisualReadinessStale = Boolean(productVisualReadiness?.stale);
  const productVisualReadinessReason = uiZh(productVisualReadiness?.reason || "产品级视觉预检来自旧验收任务，请重新运行无费用产品视觉预检。");
  const samplePreflightChecks = Array.isArray(productVisualSamplePreflight?.checks) ? productVisualSamplePreflight.checks : [];
  const samplePreflightState = productVisualSamplePreflight?.readyIfConfirmed ? "pass" : productVisualSamplePreflight ? "warning" : "idle";
  const sampleExecutionSnapshot = productVisualSamplePreflight?.executionSnapshot || null;
  const sampleAuthorizationPreview = productVisualSamplePreflight?.authorizationPreview || null;
  const samplePromptPreviewStatus = productVisualSamplePreflight?.promptPreviewStatus || null;
  const fullDeckPreflightChecks = Array.isArray(productVisualFullDeckPreflight?.checks) ? productVisualFullDeckPreflight.checks : [];
  const fullDeckPreflightState = productVisualFullDeckPreflight?.readyIfConfirmed ? "pass" : productVisualFullDeckPreflight ? "warning" : "idle";
  const fullDeckExecutionSnapshot = productVisualFullDeckPreflight?.executionSnapshot || null;
  const samplePromptMatchesPreflight = promptPreviewMatchesSamplePreflight(productVisualSamplePreflight, productVisualSamplePromptPreview?.promptPreview);
  const canRunLatestProductVisualSample = Boolean(productVisualSamplePreflight?.readyIfConfirmed && samplePromptMatchesPreflight && confirmLatestProductVisualSample && !productVisualSampleRunBusy && onRunProductVisualSample);
  const canPreviewCurrentActionSamplePrompt = Boolean(currentActionIsProductVisualSample && productVisualSamplePreflight?.readyIfConfirmed && onPreviewProductVisualSamplePrompt && !productVisualSamplePromptPreviewBusy);
  const canRunCurrentActionPaidSample = Boolean(currentActionIsProductVisualSample && canRunLatestProductVisualSample);
  const canApproveLatestProductVisualSample = Boolean(productVisualSampleApprovalPreflight?.ready && !productVisualSampleApprovalBusy && onApproveProductVisualSample);
  const canApproveLatestProductVisualFullDeck = Boolean(productVisualFullDeckApprovalPreflight?.ready && !productVisualFullDeckApprovalBusy && onApproveProductVisualFullDeck);
  const customPagesReady = productVisualFullDeckMode !== "custom" || Boolean(productVisualFullDeckPageSelection?.valid);
  const canRunLatestProductVisualFullDeck = Boolean(customPagesReady && productVisualFullDeckPreflight?.readyIfConfirmed && confirmLatestProductVisualFullDeck && !productVisualFullDeckRunBusy && onRunProductVisualFullDeck);
  const fullDeckTargetPages = clamp(Number(productVisualFullDeckTargetPages || (productVisualFullDeckMode === "test" ? 2 : productVisualTargetPages)), 1, productVisualTargetPages || 50);
  const fullDeckTargetLabel = productVisualFullDeckMode === "test"
    ? `${fullDeckTargetPages} 页测试`
    : productVisualFullDeckMode === "custom"
      ? `指定 ${fullDeckTargetPages} 页`
      : `${fullDeckTargetPages} 页全量`;
  const fullDeckSelectedPagesLabel = Array.isArray(productVisualFullDeckPreflight?.pages) && productVisualFullDeckPreflight.pages.length
    ? productVisualFullDeckPreflight.pages.join(",")
    : productVisualFullDeckMode === "custom"
      ? productVisualFullDeckPages || "-"
      : `1-${fullDeckTargetPages}`;
  async function runCompletionSafePreflight(step) {
    const preflight = step?.safePreflight || null;
    if (!preflight?.path || preflight.safeToRunAutomatically !== true || preflight.paidImageGeneration) return;
    const resultKey = step.id || preflight.id || preflight.path;
    setCompletionPreflightBusy(resultKey);
    setCompletionPreflightResults((prev) => ({
      ...prev,
      [resultKey]: { status: "running", message: "正在运行无费用预检..." }
    }));
    try {
      const result = await api.create(preflight.path, preflight.body || {});
      const resultSummary = summarizeCompletionPreflightResult(result);
      if (preflight.id === "product-visual-sample-preflight" || preflight.path === "/api/v1-acceptance/product-visual-sample/preflight") {
        const nextJobId = result?.jobId || "";
        const previousJobId = productVisualSamplePreflight?.jobId || "";
        setProductVisualSamplePreflight(result);
        setProductVisualSamplePreflightMessage(resultSummary);
        if (nextJobId && nextJobId !== previousJobId) {
          setProductVisualSamplePromptPreview(null);
          setProductVisualSamplePromptPreviewMessage("");
          setConfirmLatestProductVisualSample(false);
        }
      }
      setCompletionPreflightResults((prev) => ({
        ...prev,
        [resultKey]: {
          status: result?.ready || result?.readyIfConfirmed || result?.ok ? "pass" : "warning",
          message: resultSummary,
          raw: result
        }
      }));
    } catch (error) {
      setCompletionPreflightResults((prev) => ({
        ...prev,
        [resultKey]: {
          status: "fail",
          message: error.message || "无费用预检失败。",
          raw: error.data || null
        }
      }));
    } finally {
      setCompletionPreflightBusy("");
    }
  }
  async function runCompletionLocalPreparationPreflight(action) {
    const preflight = action?.preflight || null;
    if (!preflight?.path || preflight.safeToRunAutomatically !== true || preflight.paidImageGeneration) return;
    const resultKey = action.id || preflight.path;
    setCompletionPreflightBusy(resultKey);
    setCompletionPreflightResults((prev) => ({
      ...prev,
      [resultKey]: { status: "running", message: "\u6b63\u5728\u8fd0\u884c\u672c\u5730\u51c6\u5907\u9884\u68c0..." }
    }));
    try {
      const result = await api.create(preflight.path, preflight.body || {});
      setCompletionPreflightResults((prev) => ({
        ...prev,
        [resultKey]: {
          status: result?.ready || result?.startReady || result?.ok ? "pass" : "warning",
          message: summarizeCompletionPreflightResult(result),
          raw: result
        }
      }));
    } catch (error) {
      setCompletionPreflightResults((prev) => ({
        ...prev,
        [resultKey]: {
          status: "fail",
          message: error.message || "\u672c\u5730\u51c6\u5907\u9884\u68c0\u5931\u8d25\u3002",
          raw: error.data || null
        }
      }));
    } finally {
      setCompletionPreflightBusy("");
    }
  }
  async function runCompletionLocalPreparationAction(action) {
    if (!action?.path || action.paidImageGeneration || Number(action.externalImageCalls || 0) > 0) return;
    const resultKey = action.id || action.path;
    if (!confirmCompletionLocalPreparation[resultKey]) return;
    setCompletionPreflightBusy(`${resultKey}:run`);
    setCompletionPreflightResults((prev) => ({
      ...prev,
      [resultKey]: { status: "running", message: "\u6b63\u5728\u6267\u884c\u672c\u5730\u51c6\u5907\uff0c\u4e0d\u4f1a\u8c03\u7528\u5916\u90e8 API..." }
    }));
    try {
      const result = await api.create(action.path, action.body || {});
      setCompletionPreflightResults((prev) => ({
        ...prev,
        [resultKey]: {
          status: result?.ok === false ? "warning" : "pass",
          message: uiZh(result?.message || "本地准备已完成；请重新检查可编辑重建总状态。"),
          raw: result
        }
      }));
      setConfirmCompletionLocalPreparation((prev) => ({ ...prev, [resultKey]: false }));
    } catch (error) {
      setCompletionPreflightResults((prev) => ({
        ...prev,
        [resultKey]: {
          status: "fail",
          message: uiZh(error.message || "本地准备执行失败。"),
          raw: error.data || null
        }
      }));
    } finally {
      setCompletionPreflightBusy("");
    }
  }
  async function runCompletionProviderPreflight(step) {
    const preflight = step?.providerPreflight || null;
    if (!preflight?.path || preflight.safeToRunAutomatically !== true || preflight.paidImageGeneration) return;
    const resultKey = `${step.id || preflight.id || preflight.path}:provider`;
    setCompletionPreflightBusy(resultKey);
    setCompletionPreflightResults((prev) => ({
      ...prev,
      [resultKey]: { status: "running", message: "\u6b63\u5728\u68c0\u67e5 LLM provider \u6062\u590d\u72b6\u6001..." }
    }));
    try {
      const result = await api.create(preflight.path, preflight.body || {});
      setCompletionPreflightResults((prev) => ({
        ...prev,
        [resultKey]: {
          status: result?.ready || result?.readyIfUserConfirmed || result?.ok ? "pass" : "warning",
          message: summarizeCompletionPreflightResult(result),
          raw: result
        }
      }));
    } catch (error) {
      setCompletionPreflightResults((prev) => ({
        ...prev,
        [resultKey]: {
          status: "fail",
          message: error.message || "LLM provider \u6062\u590d\u9884\u68c0\u5931\u8d25\u3002",
          raw: error.data || null
        }
      }));
    } finally {
      setCompletionPreflightBusy("");
    }
  }
  async function runCompletionReadinessPreflight(step) {
    const preflight = step?.readinessPreflight || null;
    if (!preflight?.path || preflight.safeToRunAutomatically !== true || preflight.paidImageGeneration) return;
    const resultKey = `${step.id || preflight.id || preflight.path}:readiness`;
    setCompletionPreflightBusy(resultKey);
    setCompletionPreflightResults((prev) => ({
      ...prev,
      [resultKey]: { status: "running", message: "\u6b63\u5728\u68c0\u67e5\u53ef\u7f16\u8f91\u91cd\u5efa\u603b\u72b6\u6001..." }
    }));
    try {
      const result = await api.create(preflight.path, preflight.body || {});
      setCompletionPreflightResults((prev) => ({
        ...prev,
        [resultKey]: {
          status: result?.ready || result?.readyIfConfirmed || result?.ok ? "pass" : "warning",
          message: summarizeCompletionPreflightResult(result),
          raw: result
        }
      }));
    } catch (error) {
      setCompletionPreflightResults((prev) => ({
        ...prev,
        [resultKey]: {
          status: "fail",
          message: error.message || "\u53ef\u7f16\u8f91\u91cd\u5efa\u603b\u9884\u68c0\u5931\u8d25\u3002",
          raw: error.data || null
        }
      }));
    } finally {
      setCompletionPreflightBusy("");
    }
  }
  const run = acceptanceRun?.run || null;
  const runIsActive = Boolean(acceptanceRun?.active || run?.status === "running");
  const preflightChecks = Array.isArray(acceptancePreflight?.checks) ? acceptancePreflight.checks : [];
  const failedPreflightChecks = preflightChecks.filter((item) => !item.ok);
  const runStatusLabel = run?.status === "complete" ? "已完成" : run?.status === "failed" ? "失败" : runIsActive ? "运行中" : "未运行";
  return (
    <div className={`product-v1-real-deck ${state}`}>
      <div className="product-v1-real-deck-head">
        <div>
          <span>真实 15 页 PPT 验收</span>
          <b>{isProductReady ? "已满足 v1 真实交付目标" : isRealDeckTarget ? "已进入真实 15 页验收，等待最终可编辑结果" : "还不能声明 v1 完成"}</b>
          <small>{uiZh(check?.detail || "声明 v1 前，需要用真实 15 页 PPTX 跑完整流程。")}</small>
        </div>
        <strong>{isProductReady ? "通过" : isRealDeckTarget ? "进行中" : "缺证据"}</strong>
      </div>
      <div className="product-v1-real-deck-facts">
        <span>源文件<b>{evidence.sourceName || "待选择"}</b></span>
        <span>源页数<b>{sourcePages || "待渲染"}</b></span>
        <span>页面记录<b>{recordedPages}/{totalPages || sourcePages || 0}</b></span>
        <span>最终页数<b>{finalPages || "待生成"}</b></span>
      </div>
      <div className={`product-v1-completion-strip ${productCompletionState}`}>
        <div>
          <span>完整性判定</span>
          <b>{productCompletionReady ? "完整产品级验收已通过" : "还不能算完整 Agent"}</b>
          <small>{productCompletionSummary}</small>
        </div>
        <div>
          <span>当前阻断</span>
          <b>{productCompletionReady ? "无" : productCompletionMissingLabel}</b>
          <small>{acceptance?.summary ? uiZh(acceptance.summary) : "以真实验收报告为准，不用工程验证链路替代。"}</small>
        </div>
        <div>
          <span>下一步成本</span>
          <b>{productCompletionNextCalls ? `${productCompletionNextCalls} 次图片 API` : "无图片调用"}</b>
          <small>{productCompletionRemainingCalls ? `完整剩余路径预计 ${productCompletionRemainingCalls} 次图片 API；不会自动调用，需要你逐步确认。` : "当前动作不消耗图片额度。"}</small>
        </div>
      </div>
      <div className="product-v1-real-deck-report">
        <span>最近真实验收</span>
        {latestReport ? (
          <div>
            <b>{latestReport.ok ? "已有报告" : "报告失败"} / {latestReport.jobId || "未知任务"}</b>
            <small>{latestReport.sourcePath || "未记录源文件"}</small>
            <div className="product-v1-real-deck-report-facts">
              <em>源页 {reportPages || 0}</em>
              <em>图片页 {reportVisualImages || 0}</em>
              <em>{latestReport.visual?.imageDeck ? "图片型 PPT 已记录" : "图片型 PPT 缺失"}</em>
              <em>{reportEditableFinal ? "可编辑结果已记录" : "可编辑结果未完成"}</em>
            </div>
            {acceptance ? (
              <div className="product-v1-real-deck-acceptance">
                <b>{acceptance.ready ? "真实验收通过" : "真实验收未通过"}</b>
                <small>{uiZh(acceptance.summary || "")}</small>
                <div>
                  <em>通过 {acceptanceCounts.pass || 0}</em>
                  <em>失败 {acceptanceCounts.fail || 0}</em>
                  <em>待处理 {acceptanceCounts.pending || 0}</em>
                  <em>警告 {acceptanceCounts.warning || 0}</em>
                </div>
                {acceptanceMissing.length ? <small>缺失：{acceptanceMissing.slice(0, 3).map((item) => uiZh(item.label || item.id)).join("、")}</small> : null}
              </div>
            ) : null}
            <ProductV1PhaseProgress progress={phaseProgress} />
            {productVisualNext && productVisualNext.status !== "pass" ? (
              <div className="product-v1-product-visual-next">
                <div>
                  <span>产品级视觉下一步</span>
                  <b>{uiZh(productVisualNext.title || "等待产品级视觉重绘")}</b>
                  <small>{uiZh(productVisualNext.summary || "需要先确认样张，再生成全量图片型 PPT。")}</small>
                </div>
                <div className={`product-v1-completion-audit ${productCompletionReady ? "ready" : "blocked"}`}>
                  <div>
                    <span>完整性结论</span>
                    <b>{productCompletionReady ? "已满足产品级验收" : "尚未完整"}</b>
                    <small>{productCompletionReady ? "当前证据已经覆盖真实验收要求。" : `剩余阻断：${productCompletionMissingLabel}`}</small>
                  </div>
                  <div>
                    <span>外部 API</span>
                    <b>{productVisualSpendPlan?.totalExternalImageCalls ?? productVisualCalls.total ?? 0} 次图片调用</b>
                    <small>{productVisualNext.requiresExplicitSpendConfirmation ? "必须逐步确认，工具不会自动花费。" : "当前下一步不需要图片调用。"}</small>
                  </div>
                  {completionAudit?.nextStep ? (
                    <div>
                      <span>后端审计下一步</span>
                      <b>{uiZh(completionAudit.nextStep.label || completionAudit.nextStep.id)}</b>
                      <small>{uiZh(completionAudit.nextStep.detail || "")}</small>
                    </div>
                  ) : null}
                  {completionAuditBlockerSummary?.note ? (
                    <div>
                      <span>阻塞判断</span>
                      <b>{completionAuditBlockerSummary.editableProductMissing ? "可编辑重建仍需处理" : completionAuditBlockerSummary.productVisualMissing ? "视觉重绘仍需处理" : "等待验收"}</b>
                      <small>{uiZh(completionAuditBlockerSummary.note)}</small>
                    </div>
                  ) : null}
                </div>
                {completionExecutionSteps.length ? (
                  <div className="product-v1-execution-plan">
                    <div>
                      <span>执行顺序</span>
                      <b>{uiZh(completionExecutionPlan?.summary || "按产品主线逐步补齐验收。")}</b>
                    </div>
                    {completionCurrentAction ? (
                      <div className="product-v1-current-action">
                        <span>当前可执行</span>
                        <b>{uiZh(completionCurrentAction.label || completionCurrentAction.stepId)}</b>
                        <small>
                          {completionCurrentAction.noCostPreflight?.label ? `先做无费用预检：${uiZh(completionCurrentAction.noCostPreflight.label)}。` : ""}
                          {completionCurrentAction.paidAction?.label ? `确认后动作：${uiZh(completionCurrentAction.paidAction.label)}。` : ""}
                          {completionCurrentAction.externalImageCalls ? `预计 ${completionCurrentAction.externalImageCalls} 次图片 API。` : ""}
                        </small>
                        {canRunCurrentActionPreflight ? (
                          <button
                            type="button"
                            onClick={() => runCompletionSafePreflight({
                              id: currentActionResultKey,
                              safePreflight: completionCurrentAction.noCostPreflight
                            })}
                            disabled={Boolean(completionPreflightBusy)}
                          >
                            {completionPreflightBusy === currentActionResultKey ? "预检中..." : "运行无费用预检"}
                          </button>
                        ) : null}
                        {currentActionPreflightResult ? (
                          <small className={`completion-preflight-result ${currentActionPreflightResult.status}`}>
                            {uiZh(currentActionPreflightResult.message)}
                          </small>
                        ) : null}
                        {currentActionIsProductVisualSample ? (
                          <div className="product-v1-current-action-paid-gate">
                            <small>
                              {productVisualSamplePreflight?.readyIfConfirmed
                                ? samplePromptMatchesPreflight
                                  ? "样张 prompt 已预览匹配；勾选确认后可以生成真实样张。"
                                  : "样张条件已满足；请先预览当前 prompt，确认源页和要求无误。"
                                : "请先运行无费用预检，确认样张生成条件。"}
                            </small>
                            <div>
                              <button type="button" onClick={onPreviewProductVisualSamplePrompt} disabled={!canPreviewCurrentActionSamplePrompt}>
                                {productVisualSamplePromptPreviewBusy ? "预览中..." : "预览样张 prompt"}
                              </button>
                              <label>
                                <input
                                  type="checkbox"
                                  checked={confirmLatestProductVisualSample}
                                  onChange={(event) => setConfirmLatestProductVisualSample(event.target.checked)}
                                  disabled={!productVisualSamplePreflight?.readyIfConfirmed || !samplePromptMatchesPreflight || productVisualSampleRunBusy}
                                />
                                <span>我确认消耗 1 次外部图片 API 生成真实 codex-ppt 样张</span>
                              </label>
                            </div>
                            <button type="button" onClick={onRunProductVisualSample} disabled={!canRunCurrentActionPaidSample}>
                              {productVisualSampleRunBusy ? "生成中..." : "确认生成真实样张"}
                            </button>
                            {productVisualSampleRunMessage ? <small>{uiZh(productVisualSampleRunMessage)}</small> : null}
                            {productVisualSampleRunResult?.sampleLink?.href ? (
                              <a href={productVisualSampleRunResult.sampleLink.href} target="_blank" rel="noreferrer">打开生成的真实样张</a>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    <div>
                      {completionExecutionSteps.map((step) => (
                        <em className={step.status || "pending"} key={step.id}>
                          {step.order || ""}. {uiZh(step.label || step.id)}
                          {step.externalImageCalls ? ` / ${step.externalImageCalls} 次图片 API` : ""}
                          {step.blockedUntil ? ` / 后置：${uiZh(step.blockedUntil)}` : ""}
                        </em>
                      ))}
                    </div>
                  </div>
                ) : null}
                {completionAuditNextSteps.length > 1 ? (
                  <div className="product-v1-completion-next-steps">
                    {completionAuditNextSteps.map((step) => {
                      const resultKey = step.id || step.safePreflight?.id || step.label;
                      const preflightResult = completionPreflightResults[resultKey];
                      const readinessResultKey = `${resultKey}:readiness`;
                      const readinessResult = completionPreflightResults[readinessResultKey];
                      const providerResultKey = `${resultKey}:provider`;
                      const providerResult = completionPreflightResults[providerResultKey];
                      const canRunReadinessPreflight = Boolean(step.readinessPreflight?.path && step.readinessPreflight.safeToRunAutomatically === true && !step.readinessPreflight.paidImageGeneration);
                      const canRunSafePreflight = Boolean(step.safePreflight?.path && step.safePreflight.safeToRunAutomatically === true && !step.safePreflight.paidImageGeneration);
                      const canRunProviderPreflight = Boolean(step.providerPreflight?.path && step.providerPreflight.safeToRunAutomatically === true && !step.providerPreflight.paidImageGeneration);
                      return (
                        <div key={resultKey}>
                          <span>{step.area === "image-to-editable-ppt" ? "可编辑重建" : step.area === "codex-ppt" ? "视觉重绘" : "交付验收"}</span>
                          <b>{uiZh(step.label || step.id)}</b>
                          <small>{uiZh(step.detail || "")}</small>
                          {step.blockedUntil ? <small className="completion-sequence-warning">{uiZh(step.blockedUntil)}</small> : null}
                          {step.readinessPreflight ? <code>总预检：{uiZh(step.readinessPreflight.label || step.readinessPreflight.id)}</code> : null}
                          {canRunReadinessPreflight ? (
                            <button type="button" onClick={() => runCompletionReadinessPreflight(step)} disabled={Boolean(completionPreflightBusy)}>
                              {completionPreflightBusy === readinessResultKey ? "总预检中..." : "检查可编辑重建总状态"}
                            </button>
                          ) : null}
                          {readinessResult ? <small className={`completion-preflight-result ${readinessResult.status}`}>{uiZh(readinessResult.message)}</small> : null}
                          {readinessResult?.raw?.acceptancePlan ? <EditableRebuildAcceptancePlan plan={readinessResult.raw.acceptancePlan} /> : null}
                          {step.providerPreflight ? <code>LLM 预检：{uiZh(step.providerPreflight.label || step.providerPreflight.id)}</code> : null}
                          {canRunProviderPreflight ? (
                            <button type="button" onClick={() => runCompletionProviderPreflight(step)} disabled={Boolean(completionPreflightBusy)}>
                              {completionPreflightBusy === providerResultKey ? "LLM 预检中..." : "检查 LLM 恢复状态"}
                            </button>
                          ) : null}
                          {providerResult ? <small className={`completion-preflight-result ${providerResult.status}`}>{uiZh(providerResult.message)}</small> : null}
                          {Array.isArray(step.localPreparation) && step.localPreparation.length ? (
                            <code>本地准备：{step.localPreparation.map((action) => uiZh(action.label || action.id)).join(" / ")}</code>
                          ) : null}
                          {Array.isArray(step.localPreparation) && step.localPreparation.length ? (
                            <div className="completion-local-prep-warning">
                              <small>{"\u672c\u5730\u51c6\u5907\u9700\u8981\u4eba\u5de5\u786e\u8ba4\uff1a\u4e0d\u4f1a\u8c03\u7528\u5916\u90e8 API\uff0c\u4f46\u4f1a\u91cd\u5efa\u8fd0\u884c\u76ee\u5f55\u6216\u5237\u65b0\u4efb\u52a1\u961f\u5217\u3002"}</small>
                              {step.localPreparation.map((action) => {
                                const localResultKey = action.id || action.preflight?.path || action.path;
                                const localResult = completionPreflightResults[localResultKey];
                                const canRunLocalPreflight = Boolean(action.preflight?.path && action.preflight.safeToRunAutomatically === true && !action.preflight.paidImageGeneration);
                                const canRunLocalAction = Boolean(action.path && !action.paidImageGeneration && Number(action.externalImageCalls || 0) === 0);
                                const localActionBusy = completionPreflightBusy === `${localResultKey}:run`;
                                const localActionConfirmed = Boolean(confirmCompletionLocalPreparation[localResultKey]);
                                return (
                                  <div className="completion-local-prep-action" key={localResultKey}>
                                    <em>{uiZh(action.sideEffect || action.label || action.id)}</em>
                                    {canRunLocalPreflight ? (
                                      <button type="button" onClick={() => runCompletionLocalPreparationPreflight(action)} disabled={Boolean(completionPreflightBusy)}>
                                        {completionPreflightBusy === localResultKey ? "\u672c\u5730\u9884\u68c0\u4e2d..." : "\u5148\u68c0\u67e5\u672c\u5730\u51c6\u5907"}
                                      </button>
                                    ) : null}
                                    {canRunLocalAction ? (
                                      <label className="completion-local-prep-confirm">
                                        <input
                                          type="checkbox"
                                          checked={localActionConfirmed}
                                          onChange={(event) => setConfirmCompletionLocalPreparation((prev) => ({ ...prev, [localResultKey]: event.target.checked }))}
                                          disabled={Boolean(completionPreflightBusy)}
                                        />
                                        <span>{"我确认执行本地准备；它会刷新本地运行证据，但不会调用外部 API。"}</span>
                                      </label>
                                    ) : null}
                                    {canRunLocalAction ? (
                                      <button type="button" onClick={() => runCompletionLocalPreparationAction(action)} disabled={Boolean(completionPreflightBusy) || !localActionConfirmed}>
                                        {localActionBusy ? "执行本地准备中..." : "执行本地准备"}
                                      </button>
                                    ) : null}
                                    {localResult ? <small className={`completion-preflight-result ${localResult.status}`}>{uiZh(localResult.message)}</small> : null}
                                  </div>
                                );
                              })}
                            </div>
                          ) : null}
                          {step.safePreflight ? <code>先预检：{uiZh(step.safePreflight.label || step.safePreflight.id)}</code> : null}
                          {step.paidAction ? <code>确认后执行：{uiZh(step.paidAction.label || step.paidAction.id)}</code> : null}
                          {step.paidAction?.requiresLlmProviderRecovery ? (
                            <small className="completion-provider-warning">{"\u6267\u884c\u524d\u5fc5\u987b\u5148\u786e\u8ba4 LLM provider \u5df2\u6062\u590d\uff1b\u8be5\u52a8\u4f5c\u53ef\u80fd\u6d88\u8017\u5916\u90e8\u989d\u5ea6\u3002"}</small>
                          ) : null}
                          {canRunSafePreflight ? (
                            <button type="button" onClick={() => runCompletionSafePreflight(step)} disabled={Boolean(completionPreflightBusy)}>
                              {completionPreflightBusy === resultKey ? "预检中..." : "运行无费用预检"}
                            </button>
                          ) : null}
                          {preflightResult ? <small className={`completion-preflight-result ${preflightResult.status}`}>{uiZh(preflightResult.message)}</small> : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
                <ProductVisualFlowGuide
                  fullDeckMode={productVisualFullDeckMode}
                  fullDeckPreflight={productVisualFullDeckPreflight}
                  fullDeckRunResult={productVisualFullDeckRunResult}
                  readiness={productVisualResult}
                  sampleApprovalPreflight={productVisualSampleApprovalPreflight}
                  samplePreflight={productVisualSamplePreflight}
                  samplePromptMatchesPreflight={samplePromptMatchesPreflight}
                  sampleRunResult={productVisualSampleRunResult}
                  targetPages={productVisualTargetPages}
                />
                {productVisualAgentNextAction ? (
                  <div className={`product-v1-agent-next-action ${productVisualAgentNextAction.level}`}>
                    <div>
                      <span>Agent 推荐下一步</span>
                      <b>{productVisualAgentNextAction.title}</b>
                      <small>{productVisualAgentNextAction.detail}</small>
                    </div>
                    <strong>{productVisualAgentNextAction.badge}</strong>
                  </div>
                ) : null}
                <div className="product-v1-product-visual-next-facts">
                  <em>当前模式 {productVisualNext.currentMode || "未生成"}</em>
                  <em>目标页数 {productVisualNext.targetPages || 15}</em>
                  <em>样张调用 {productVisualCalls.sample || 0}</em>
                  <em>全量调用 {productVisualCalls.fullDeck || 0}</em>
                </div>
                {productVisualSpendPlan ? (
                  <div className="product-v1-product-visual-spend-plan">
                    <div>
                      <span>外部图片 API 计划</span>
                      <b>共 {productVisualSpendPlan.totalExternalImageCalls ?? productVisualCalls.total ?? 0} 次</b>
                      <small>{productVisualSpendPlan.requiresExplicitSpendConfirmation ? "分阶段确认后才会调用，不会自动消耗额度。" : "当前阶段不会调用图片 API。"}</small>
                    </div>
                    {productVisualSpendSteps.length ? (
                      <div>
                        {productVisualSpendSteps.map((step) => (
                          <em className={step.paidImageGeneration ? "paid" : "safe"} key={step.id}>
                            {step.order || ""}. {uiZh(step.label || step.id)}：{step.externalImageCalls || 0} 次
                          </em>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {productVisualRangeOptions.length ? (
                  <div className="product-v1-product-visual-range-options">
                    {productVisualRangeOptions.map((option) => (
                      <div className={option.id === productVisualFullDeckMode ? "active" : ""} key={option.id}>
                        <b>{option.title}</b>
                        <span>{option.action.externalImageCalls || 0} 次图片 API</span>
                        <small>{option.detail}</small>
                        <em>{option.action.body?.pages ? `页码 ${option.action.body.pages}` : `最多 ${option.action.body?.maxPages || productVisualTargetPages || 15} 页`}</em>
                      </div>
                    ))}
                  </div>
                ) : null}
                {productActions.length ? (
                  <div className="product-v1-product-visual-actions-contract">
                    {productActions.map((action) => (
                      <div className={action.paidImageGeneration ? "paid" : "safe"} key={action.id}>
                        <b>{uiZh(action.label || action.id)}</b>
                        <span>{action.method && action.path ? `${action.method} ${action.path}` : uiZh(action.kind || "本地动作")}</span>
                        <small>{uiZh(action.description || "")}</small>
                        <em>{action.paidImageGeneration ? `会消耗 ${action.externalImageCalls || 0} 次图片 API` : "不生成图片"}</em>
                      </div>
                    ))}
                  </div>
                ) : null}
                <small>工具不会自动消耗外部图片额度；只有明确授权后才会调用图片 API。</small>
                <div className="product-v1-product-visual-target-mode">
                  <div>
                    <span>图片页生成目标</span>
                    <b>{fullDeckTargetLabel}</b>
                    <small>建议先跑 2 页测试，确认跨页风格一致后再跑全量。</small>
                  </div>
                  <div>
                    <button type="button" className={productVisualFullDeckMode === "test" ? "active" : ""} onClick={() => onProductVisualFullDeckModeChange?.("test")}>
                      2 页测试
                    </button>
                    <button type="button" className={productVisualFullDeckMode === "custom" ? "active" : ""} onClick={() => onProductVisualFullDeckModeChange?.("custom")}>
                      指定页
                    </button>
                    <button type="button" className={productVisualFullDeckMode === "full" ? "active" : ""} onClick={() => onProductVisualFullDeckModeChange?.("full")}>
                      全量 {productVisualTargetPages || 15} 页
                    </button>
                  </div>
                  {productVisualFullDeckMode === "custom" ? (
                    <label className="product-v1-product-visual-custom-pages">
                      <span>页码范围</span>
                      <input
                        type="text"
                        value={productVisualFullDeckPages}
                        onChange={(event) => onProductVisualFullDeckPagesChange?.(event.target.value)}
                        placeholder="例如 1,3,5-6"
                      />
                      <small>{productVisualFullDeckPageSelection?.message || "只会把这些页传给 codex-ppt 真实图片页生成；仍需你确认外部图片 API。"}</small>
                    </label>
                  ) : null}
                </div>
                <div className="product-v1-product-visual-next-actions">
                  <button type="button" onClick={onRunProductVisualReadiness} disabled={productVisualReadinessBusy || !onRunProductVisualReadiness}>
                    {productVisualReadinessBusy ? "预检中..." : "运行无费用预检"}
                  </button>
                  <button type="button" onClick={onPreflightProductVisualSample} disabled={productVisualSamplePreflightBusy || !onPreflightProductVisualSample || !productVisualResult || productVisualReadinessStale}>
                    {productVisualSamplePreflightBusy ? "检查中..." : "检查真实样张条件"}
                  </button>
                  <button type="button" onClick={onPreflightProductVisualFullDeck} disabled={productVisualFullDeckPreflightBusy || !onPreflightProductVisualFullDeck || !productVisualResult || productVisualReadinessStale || !customPagesReady}>
                    {productVisualFullDeckPreflightBusy ? "检查中..." : `检查 ${fullDeckTargetLabel} 条件`}
                  </button>
                  <small>{productVisualReadinessMessage || "只检查服务商、源文件渲染、大纲、视觉风格和生成方式，不生成图片。"}</small>
                </div>
                {productVisualReadinessStale ? (
                  <div className="product-v1-product-visual-stale">
                    <b>产品视觉预检已过期</b>
                    <small>{productVisualReadinessReason}</small>
                    <em>最新验收 {productVisualReadiness.latestReportJobId || "-"}</em>
                    <em>当前预检 {productVisualReadiness.latestReadinessJobId || "-"}</em>
                  </div>
                ) : null}
                {productVisualResult ? (
                  <div className="product-v1-product-visual-readiness-result">
                    <em>预检任务 {productVisualResult.jobId || "-"}</em>
                    <em>源页 {productVisualResult.sourceRender?.renderedPages || 0}</em>
                    <em>模型 {productVisualResult.provider?.model || "-"}</em>
                    <em>下一步 {productVisualResult.runbook?.currentTitle || productVisualResult.runbook?.currentStep || "-"}</em>
                  </div>
                ) : null}
                {productVisualSamplePreflight ? (
                  <div className={`product-v1-product-visual-sample-preflight ${samplePreflightState}`}>
                    <div>
                      <span>真实样张预检</span>
                      <b>{productVisualSamplePreflight.readyIfConfirmed ? "可授权生成样张" : "条件未满足"}</b>
                      <small>{productVisualSamplePreflightMessage || uiZh(productVisualSamplePreflight.summary || "")}</small>
                    </div>
                    <div>
                      <em>任务 {productVisualSamplePreflight.jobId || "-"}</em>
                      <em>动作 {productVisualSamplePreflight.nextAction || "visual/sample"}</em>
                      <em>图片调用 {productVisualSamplePreflight.externalImageCalls || 1}</em>
                      <em>确认 {productVisualSamplePreflight.requiredConfirmation || "externalImageSpend"}</em>
                      {samplePromptPreviewStatus ? <em className={samplePromptPreviewStatus.ready ? "pass" : "warn"}>Prompt 证据 {samplePromptPreviewStatus.label || (samplePromptPreviewStatus.ready ? "已保存" : "需预览")}</em> : null}
                    </div>
                    {sampleExecutionSnapshot ? (
                      <ProductVisualExecutionSnapshot snapshot={sampleExecutionSnapshot} />
                    ) : null}
                    {sampleAuthorizationPreview ? (
                      <ProductVisualAuthorizationPreview preview={sampleAuthorizationPreview} />
                    ) : null}
                    <div className="product-v1-product-visual-prompt-preview-actions">
                      <button type="button" onClick={onPreviewProductVisualSamplePrompt} disabled={productVisualSamplePromptPreviewBusy || !productVisualSamplePreflight.readyIfConfirmed || !onPreviewProductVisualSamplePrompt}>
                        {productVisualSamplePromptPreviewBusy ? "预览中..." : "预览样张 prompt"}
                      </button>
                      <small>{productVisualSamplePromptPreviewMessage || samplePromptPreviewStatus?.message || "预览不会生成图片，也不会调用外部图片 API。"}</small>
                    </div>
                    {productVisualSamplePromptPreview?.promptPreview ? (
                      <ProductVisualPromptPreview expectedJobId={productVisualSamplePreflight.jobId} preview={productVisualSamplePromptPreview.promptPreview} />
                    ) : null}
                    {samplePreflightChecks.length ? (
                      <div>
                        {samplePreflightChecks.slice(0, 6).map((item) => <em className={item.ok ? "pass" : "warn"} key={item.id}>{uiZh(item.label || item.id)}</em>)}
                      </div>
                    ) : null}
                    <label className="product-v1-product-visual-sample-confirm">
                      <input type="checkbox" checked={confirmLatestProductVisualSample} onChange={(event) => setConfirmLatestProductVisualSample(event.target.checked)} disabled={!productVisualSamplePreflight.readyIfConfirmed || !samplePromptMatchesPreflight || productVisualSampleRunBusy} />
                      <span>{samplePromptMatchesPreflight ? "我确认使用 1 次外部图片 API 生成真实 codex-ppt 样张。" : "请先预览当前预检任务的样张 prompt，再确认生成真实样张。"}</span>
                    </label>
                    <button type="button" onClick={onRunProductVisualSample} disabled={!canRunLatestProductVisualSample}>
                      {productVisualSampleRunBusy ? "生成中..." : "生成真实样张"}
                    </button>
                    {productVisualSampleRunMessage ? <small>{uiZh(productVisualSampleRunMessage)}</small> : null}
                    {productVisualSampleRunResult ? (
                      <div className="product-v1-product-visual-run-result">
                        <span>样张证据</span>
                        <em>任务 {productVisualSampleRunResult.jobId || "-"}</em>
                        <em>模型 {productVisualSampleRunResult.provider?.model || "-"}</em>
                        <em>图片调用 {productVisualSampleRunResult.externalImageCalls || 1}</em>
                        <em>hash {shortHash(productVisualSampleRunResult.sample?.sha256 || "")}</em>
                        {productVisualSampleRunResult.sampleLink?.href ? <a href={productVisualSampleRunResult.sampleLink.href} target="_blank" rel="noreferrer">打开样张</a> : null}
                      </div>
                    ) : null}
                    <div className={`product-v1-product-visual-sample-approval ${productVisualSampleApprovalPreflight?.ready ? "pass" : productVisualSampleApprovalPreflight ? "warning" : "idle"}`}>
                      <div>
                        <span>样张确认关卡</span>
                        <b>{productVisualSampleApprovalPreflight?.ready ? "可确认样张" : productVisualSampleApprovalPreflight ? "等待合格样张" : "尚未检查"}</b>
                        <small>{productVisualSampleApprovalMessage || uiZh(productVisualSampleApprovalPreflight?.summary || "生成真实样张后，在这里检查并确认样张关卡。")}</small>
                      </div>
                      {productVisualSampleApprovalPreflight ? (
                        <div>
                          <em>任务 {productVisualSampleApprovalPreflight.jobId || "-"}</em>
                          <em>动作 {productVisualSampleApprovalPreflight.nextAction || "codex-ppt/approvals/sample/approve"}</em>
                          <em>图片调用 {productVisualSampleApprovalPreflight.externalImageCalls || 0}</em>
                          <em>{productVisualSampleApprovalPreflight.paidImageGeneration ? "会生成图片" : "不生成图片"}</em>
                          {productVisualSampleApprovalPreflight.sampleLink?.href ? <a href={productVisualSampleApprovalPreflight.sampleLink.href} target="_blank" rel="noreferrer">打开样张</a> : null}
                        </div>
                      ) : null}
                      {productVisualSampleApprovalPreflight?.sampleReviewChecklist ? (
                        <ProductVisualSampleReviewChecklist checklist={productVisualSampleApprovalPreflight.sampleReviewChecklist} />
                      ) : null}
                      {productVisualSampleApprovalPreflight?.nextStagePlan ? (
                        <ProductVisualNextStagePlan plan={productVisualSampleApprovalPreflight.nextStagePlan} />
                      ) : null}
                      {Array.isArray(productVisualSampleApprovalPreflight?.blockingIssues) && productVisualSampleApprovalPreflight.blockingIssues.length ? (
                        <div>
                          {productVisualSampleApprovalPreflight.blockingIssues.slice(0, 4).map((item) => {
                            const message = typeof item === "string" ? item : item?.message || item?.code || "样张未通过";
                            return <em className="warn" key={message}>{uiZh(message)}</em>;
                          })}
                        </div>
                      ) : null}
                      <div className="product-v1-product-visual-sample-approval-actions">
                        <button type="button" onClick={onPreflightProductVisualSampleApproval} disabled={productVisualSampleApprovalBusy || !onPreflightProductVisualSampleApproval}>
                          {productVisualSampleApprovalBusy ? "检查中..." : "检查样张确认"}
                        </button>
                        <button type="button" onClick={onApproveProductVisualSample} disabled={!canApproveLatestProductVisualSample}>
                          {productVisualSampleApprovalBusy ? "确认中..." : "确认样张关卡"}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : productVisualSamplePreflightMessage ? <small>{productVisualSamplePreflightMessage}</small> : null}
                <div className={`product-v1-product-visual-sample-approval ${productVisualFullDeckApprovalPreflight?.ready ? "pass" : productVisualFullDeckApprovalPreflight ? "warning" : "idle"}`}>
                  <div>
                    <span>全量生成关卡</span>
                    <b>{productVisualFullDeckApprovalPreflight?.ready ? "可确认全量" : productVisualFullDeckApprovalPreflight ? "等待样张确认" : "尚未检查"}</b>
                    <small>{productVisualFullDeckApprovalMessage || uiZh(productVisualFullDeckApprovalPreflight?.summary || "样张确认后，在这里检查并确认全量生成关卡；该步骤不调用图片 API。")}</small>
                  </div>
                  {productVisualFullDeckApprovalPreflight ? (
                    <div>
                      <em>任务 {productVisualFullDeckApprovalPreflight.jobId || "-"}</em>
                      <em>动作 {productVisualFullDeckApprovalPreflight.nextAction || "codex-ppt/approvals/fullDeck/approve"}</em>
                      <em>图片调用 {productVisualFullDeckApprovalPreflight.externalImageCalls || 0}</em>
                      <em>{productVisualFullDeckApprovalPreflight.paidImageGeneration ? "会生成图片" : "不生成图片"}</em>
                      {productVisualFullDeckApprovalPreflight.sampleLink?.href ? <a href={productVisualFullDeckApprovalPreflight.sampleLink.href} target="_blank" rel="noreferrer">打开样张</a> : null}
                    </div>
                  ) : null}
                  {productVisualFullDeckApprovalPreflight?.sampleReviewChecklist ? (
                    <ProductVisualSampleReviewChecklist checklist={productVisualFullDeckApprovalPreflight.sampleReviewChecklist} />
                  ) : null}
                  {productVisualFullDeckApprovalPreflight?.nextStagePlan ? (
                    <ProductVisualNextStagePlan plan={productVisualFullDeckApprovalPreflight.nextStagePlan} />
                  ) : null}
                  {Array.isArray(productVisualFullDeckApprovalPreflight?.blockingIssues) && productVisualFullDeckApprovalPreflight.blockingIssues.length ? (
                    <div>
                      {productVisualFullDeckApprovalPreflight.blockingIssues.slice(0, 4).map((item) => {
                        const message = typeof item === "string" ? item : item?.message || item?.code || "全量关卡未通过";
                        return <em className="warn" key={message}>{uiZh(message)}</em>;
                      })}
                    </div>
                  ) : null}
                  <div className="product-v1-product-visual-sample-approval-actions">
                    <button type="button" onClick={onPreflightProductVisualFullDeckApproval} disabled={productVisualFullDeckApprovalBusy || !onPreflightProductVisualFullDeckApproval}>
                      {productVisualFullDeckApprovalBusy ? "检查中..." : "检查全量确认"}
                    </button>
                    <button type="button" onClick={onApproveProductVisualFullDeck} disabled={!canApproveLatestProductVisualFullDeck}>
                      {productVisualFullDeckApprovalBusy ? "确认中..." : "确认全量关卡"}
                    </button>
                  </div>
                </div>
                {productVisualFullDeckPreflight ? (
                  <div className={`product-v1-product-visual-sample-preflight ${fullDeckPreflightState}`}>
                    <div>
                      <span>{fullDeckTargetLabel}生成预检</span>
                      <b>{productVisualFullDeckPreflight.readyIfConfirmed ? `可授权生成 ${fullDeckTargetLabel}` : `${fullDeckTargetLabel} 条件未满足`}</b>
                      <small>{productVisualFullDeckPreflightMessage || uiZh(productVisualFullDeckPreflight.summary || "")}</small>
                    </div>
                    <div>
                      <em>任务 {productVisualFullDeckPreflight.jobId || "-"}</em>
                      <em>动作 {productVisualFullDeckPreflight.nextAction || "visual/generate"}</em>
                      <em>生成页码 {fullDeckSelectedPagesLabel}</em>
                      <em>图片调用 {productVisualFullDeckPreflight.externalImageCalls || productVisualCalls.fullDeck || 15}</em>
                      <em>确认 {productVisualFullDeckPreflight.requiredConfirmation || "externalImageSpend"}</em>
                      <em className={productVisualFullDeckPreflight.styleLock?.locked ? "pass" : "warn"}>
                        风格锁 {productVisualFullDeckPreflight.styleLock?.locked ? "已建立" : "未建立"}
                      </em>
                    </div>
                    {productVisualFullDeckPreflight.styleLock ? (
                      <small>
                        {productVisualFullDeckPreflight.styleLock.locked
                          ? `将使用已确认样张作为统一风格参考：${productVisualFullDeckPreflight.styleLock.sampleRelativePath || "visual sample"}`
                          : "全量生成前必须先生成并确认真实样张，否则页面风格和字体容易漂移。"}
                      </small>
                    ) : null}
                    {fullDeckExecutionSnapshot ? (
                      <ProductVisualExecutionSnapshot snapshot={fullDeckExecutionSnapshot} />
                    ) : null}
                    {fullDeckPreflightChecks.length ? (
                      <div>
                        {fullDeckPreflightChecks.slice(0, 8).map((item) => <em className={item.ok ? "pass" : "warn"} key={item.id}>{uiZh(item.label || item.id)}</em>)}
                      </div>
                    ) : null}
                    <label className="product-v1-product-visual-sample-confirm">
                      <input type="checkbox" checked={confirmLatestProductVisualFullDeck} onChange={(event) => setConfirmLatestProductVisualFullDeck(event.target.checked)} disabled={!productVisualFullDeckPreflight.readyIfConfirmed || productVisualFullDeckRunBusy} />
                      <span>我确认使用 {productVisualFullDeckPreflight.externalImageCalls || productVisualCalls.fullDeck || fullDeckTargetPages} 次外部图片 API，生成页码 {fullDeckSelectedPagesLabel} 的 {fullDeckTargetLabel} 视觉统一图片页。</span>
                    </label>
                    <button type="button" onClick={onRunProductVisualFullDeck} disabled={!canRunLatestProductVisualFullDeck}>
                      {productVisualFullDeckRunBusy ? "生成中..." : `生成${fullDeckTargetLabel}图片型 PPT`}
                    </button>
                    {productVisualFullDeckRunMessage ? <small>{uiZh(productVisualFullDeckRunMessage)}</small> : null}
                    {productVisualFullDeckRunResult ? (
                      <div className="product-v1-product-visual-run-result">
                        <span>{fullDeckTargetLabel}视觉证据</span>
                        <em>任务 {productVisualFullDeckRunResult.jobId || "-"}</em>
                        <em>模型 {productVisualFullDeckRunResult.provider?.model || "-"}</em>
                        <em>图片调用 {productVisualFullDeckRunResult.externalImageCalls || productVisualCalls.fullDeck || 15}</em>
                        <em>图片页 {(productVisualFullDeckRunResult.visualImageLinks || []).length}</em>
                        {productVisualFullDeckRunResult.imageDeckLink?.href ? <a href={productVisualFullDeckRunResult.imageDeckLink.href}>查看图片型 PPT 中间产物</a> : null}
                        <ProductVisualQualityReport result={productVisualFullDeckRunResult} />
                      </div>
                    ) : null}
                    {productVisualFullDeckPreflight.blockingIssues?.length ? <small>阻断：{productVisualFullDeckPreflight.blockingIssues.slice(0, 3).map((item) => uiZh(item)).join("；")}</small> : null}
                  </div>
                ) : productVisualFullDeckPreflightMessage ? <small>{productVisualFullDeckPreflightMessage}</small> : null}
                {productVisualNext.commands?.noCostReadiness ? <code>{productVisualNext.commands.noCostReadiness}</code> : null}
              </div>
            ) : null}
            {latestReport.reportPath ? <code>{latestReport.reportPath}</code> : null}
          </div>
        ) : (
          <div>
            <b>还没有真实验收报告</b>
            <small>运行推荐命令后会写入 workspace/v1-acceptance/latest-real-ppt-regression.json。</small>
          </div>
        )}
      </div>
      <div className="product-v1-real-deck-command">
        <span>推荐验收命令</span>
        <code>{acceptanceReport?.recommendedCommand || "npm.cmd run regression:real-ppt -- --source \"C:\\path\\to\\deck.pptx\" --max-pages 15"}</code>
      </div>
      <div className={`product-v1-real-deck-runner ${run?.status || "idle"}`}>
        <div>
          <span>页面内真实验收</span>
          <b>{runStatusLabel}</b>
          <small>{run?.message || "填写本地 PPTX 路径后，可直接从工具内启动 dry-run 真实验收。"}</small>
        </div>
        <div className="product-v1-real-deck-runner-current">
          <button type="button" onClick={onStartAcceptanceFromWorkflow} disabled={acceptanceRunBusy || runIsActive || !canUseWorkflowAcceptanceSource}>
            使用当前工作流源 PPT 验收
          </button>
          <small>{workflowAcceptanceSourceName || "当前工作流没有可用 PPTX 源文件。"}</small>
        </div>
        <div className={`product-v1-real-deck-preflight ${acceptancePreflight?.ready ? "pass" : failedPreflightChecks.length ? "fail" : "idle"}`}>
          <div>
            <span>真实验收预检</span>
            <b>{acceptancePreflightBusy ? "正在检查..." : acceptancePreflight ? (acceptancePreflight.ready ? "预检通过" : "预检未通过") : "未检查"}</b>
            <small>{acceptancePreflight?.summary || "先检查 PPTX 页数、PowerPoint、OCR、editppt 和 API 配置，再启动长任务。"}</small>
          </div>
          <div className="product-v1-real-deck-preflight-actions">
            <button type="button" onClick={() => onPreflightAcceptanceRun?.(false)} disabled={acceptancePreflightBusy || runIsActive || !acceptanceSourcePath.trim()}>
              {acceptancePreflightBusy ? "检查中..." : "检查本地路径"}
            </button>
            <button type="button" onClick={onPreflightAcceptanceFromWorkflow} disabled={acceptancePreflightBusy || runIsActive || !canUseWorkflowAcceptanceSource}>
              检查当前工作流源
            </button>
          </div>
          {acceptancePreflight ? (
            <div className="product-v1-real-deck-preflight-facts">
              <em>页数 {acceptancePreflight.slideCount || 0}/{acceptancePreflight.targetPages || 15}</em>
              <em>通过 {preflightChecks.length - failedPreflightChecks.length}</em>
              <em>失败 {failedPreflightChecks.length}</em>
            </div>
          ) : null}
          {failedPreflightChecks.length ? (
            <div className="product-v1-real-deck-preflight-errors">
              {failedPreflightChecks.slice(0, 4).map((item) => <small key={item.id}>{uiZh(item.message || item.id)}</small>)}
            </div>
          ) : null}
        </div>
        <div className="product-v1-real-deck-runner-form">
          <input
            value={acceptanceSourcePath}
            onChange={(event) => onAcceptanceSourcePathChange?.(event.target.value)}
            placeholder="C:\\path\\to\\deck.pptx"
            disabled={acceptanceRunBusy || runIsActive}
          />
          <button type="button" onClick={() => onStartAcceptanceRun?.(false)} disabled={acceptanceRunBusy || runIsActive || !acceptanceSourcePath.trim()}>
            {acceptanceRunBusy ? "启动中..." : runIsActive ? "运行中" : "启动真实验收"}
          </button>
        </div>
        {run?.logRelativePath ? <code>{run.logRelativePath}</code> : null}
        {acceptanceRunMessage ? <small>{acceptanceRunMessage}</small> : null}
      </div>
      <p>只有真实 15 页 PPT、图片型 PPT、可编辑 PPT、校验证据和日志包都具备证据后，才能把产品级 v1 视为完成。</p>
    </div>
  );
}

function ProductVisualAuthorizationPreview({ preview = null }) {
  if (!preview) return null;
  const checks = Array.isArray(preview.checklist) ? preview.checklist : [];
  const artifactHref = preview.promptPreview?.artifactLink?.href || "";
  return (
    <div className={`product-v1-product-visual-authorization-preview ${preview.status === "ready-after-user-confirmation" ? "ready" : "blocked"}`}>
      <div>
        <span>外部图片调用确认</span>
        <b>{uiZh(preview.label || "真实样张授权摘要")}</b>
        <small>{uiZh(preview.confirmationText || "确认前不会调用外部图片 API。")}</small>
      </div>
      <div>
        <em>模型 {preview.provider?.model || "-"}</em>
        <em>接口 {preview.provider?.editEndpoint || "/images/edits"}</em>
        <em>图片调用 {preview.externalImageCalls || 0}</em>
        <em>任务 {preview.workflowJobId || "-"}</em>
      </div>
      {checks.length ? (
        <div>
          {checks.map((item) => (
            <em className={item.ok ? "pass" : "warn"} key={item.id}>
              {uiZh(item.label || item.id)} {item.value || ""}
            </em>
          ))}
        </div>
      ) : null}
      {artifactHref ? <a href={artifactHref} target="_blank" rel="noreferrer">打开 Prompt 证据</a> : null}
      <small>{preview.safeToRunAutomatically ? "当前动作可自动执行。" : "该动作不能自动执行，必须由你勾选确认后才会调用。"}</small>
    </div>
  );
}

function ProductVisualFlowGuide({
  fullDeckMode = "test",
  fullDeckPreflight = null,
  fullDeckRunResult = null,
  readiness = null,
  sampleApprovalPreflight = null,
  samplePreflight = null,
  samplePromptMatchesPreflight = false,
  sampleRunResult = null,
  targetPages = 15
}) {
  const sampleReady = Boolean(samplePreflight?.readyIfConfirmed);
  const sampleGenerated = Boolean(sampleRunResult?.sampleLink?.href || sampleApprovalPreflight?.sampleLink?.href);
  const sampleApproved = Boolean(sampleApprovalPreflight?.passed || sampleApprovalPreflight?.preflight?.passed);
  const styleLocked = Boolean(fullDeckPreflight?.styleLock?.locked);
  const testReady = Boolean(fullDeckPreflight?.readyIfConfirmed && fullDeckMode === "test");
  const imageDeckReady = Boolean(fullDeckRunResult?.imageDeckLink?.href || fullDeckRunResult?.imageDeck?.path);
  const styleReview = fullDeckRunResult?.visualQuality?.summary?.styleConsistency || null;
  const activeStep = !readiness
    ? "readiness"
    : !sampleGenerated
      ? "sample"
      : !sampleApproved
        ? "approve-sample"
        : !imageDeckReady
          ? "test"
          : styleReview?.status === "review"
            ? "review"
            : "full";
  const steps = [
    {
      id: "readiness",
      title: "1. 无费用预检",
      detail: readiness ? "源文件、模型和关卡已检查。" : "先确认源文件、模型、OCR 和 codex-ppt 关卡。",
      status: readiness ? "done" : activeStep === "readiness" ? "active" : "pending",
      cost: "不调用 API"
    },
    {
      id: "sample",
      title: "2. 生成真实样张",
      detail: sampleGenerated ? "样张已生成，下一步人工看风格。" : sampleReady && samplePromptMatchesPreflight ? "可以确认后生成 1 页真实样张。" : "先预览样张 prompt，再确认 1 次图片 API。",
      status: sampleGenerated ? "done" : activeStep === "sample" ? "active" : "pending",
      cost: "1 次图片 API"
    },
    {
      id: "approve-sample",
      title: "3. 确认样张并建立风格锁",
      detail: styleLocked ? "风格锁已建立，全量页会携带样张参考。" : sampleGenerated ? "打开样张看字体、色彩、版式，满意后确认。" : "等待真实样张。",
      status: styleLocked ? "done" : activeStep === "approve-sample" ? "active" : "pending",
      cost: "不调用 API"
    },
    {
      id: "test",
      title: "4. 先试 2 页",
      detail: imageDeckReady && fullDeckMode === "test" ? "测试图片版已生成，请看风格一致性 QA。" : testReady ? "建议先生成 2 页测试，不要直接全量。" : "等待风格锁和测试预检。",
      status: imageDeckReady ? "done" : activeStep === "test" ? "active" : "pending",
      cost: "通常 2 次图片 API"
    },
    {
      id: "full",
      title: `5. 再跑全量 ${targetPages || 15} 页`,
      detail: styleReview?.status === "review" ? `当前测试/图片版仍有 ${styleReview.driftCount || 0} 页风格需复核，先别全量。` : imageDeckReady ? "测试页合格后再切到全量生成。" : "等待测试页通过。",
      status: activeStep === "full" ? "active" : styleReview?.status === "pass" ? "ready" : "pending",
      cost: `${targetPages || 15} 次图片 API`
    }
  ];
  const next = steps.find((step) => step.status === "active") || steps.find((step) => step.status === "ready") || steps.at(-1);
  return (
    <div className="product-v1-flow-guide">
      <div className="product-v1-flow-guide-head">
        <div>
          <span>推荐执行顺序</span>
          <b>{next?.title || "等待下一步"}</b>
          <small>{next?.detail || "按样张、风格锁、2 页测试、全量生成的顺序执行。"}</small>
        </div>
        <strong>{next?.cost || "不调用 API"}</strong>
      </div>
      <div className="product-v1-flow-guide-steps">
        {steps.map((step) => (
          <div className={step.status} key={step.id}>
            <b>{step.title}</b>
            <span>{step.detail}</span>
            <em>{step.cost}</em>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProductVisualExecutionSnapshot({ snapshot = null }) {
  if (!snapshot) return null;
  const blockingIssues = Array.isArray(snapshot.blockingIssues) ? snapshot.blockingIssues : [];
  return (
    <div className={`product-v1-product-visual-execution-snapshot ${snapshot.status === "ready-after-confirmation" ? "ready" : "blocked"}`}>
      <div>
        <span>执行快照</span>
        <b>{uiZh(snapshot.label || "产品级视觉生成")}</b>
        <small>{uiZh(snapshot.confirmationText || "该步骤必须确认后才会调用外部图片 API。")}</small>
      </div>
      <div>
        <em>任务 {snapshot.workflowJob?.id || "-"}</em>
        <em>模型 {snapshot.provider?.model || "-"}</em>
        <em>目标页 {snapshot.targetPages || 0}</em>
        <em>图片 API {snapshot.externalImageCalls || 0} 次</em>
        <em>确认 {snapshot.requiredConfirmation || "externalImageSpend"}</em>
      </div>
      <small>{snapshot.source?.path || "未记录源文件"}</small>
      {blockingIssues.length ? (
        <div>
          {blockingIssues.slice(0, 4).map((item) => {
            const message = typeof item === "string" ? item : item?.message || item?.code || "条件未满足";
            return <em className="warn" key={message}>{uiZh(message)}</em>;
          })}
        </div>
      ) : null}
    </div>
  );
}

function ProductVisualPromptPreview({ expectedJobId = "", preview = null }) {
  if (!preview) return null;
  const sourceHref = preview.sourcePageLink?.href || "";
  const artifactHref = preview.artifactLink?.href || "";
  const matchesPreflightJob = promptPreviewMatchesSamplePreflight({ jobId: expectedJobId }, preview);
  return (
    <div className="product-v1-product-visual-prompt-preview">
      <div>
        <span>样张 prompt 预览</span>
        <b>{preview.pageId || `第 ${preview.pageNumber || 1} 页`}</b>
        <small>{uiZh(preview.instruction || "本预览不生成图片，不调用外部 API。")}</small>
      </div>
      <div>
        <em>模型 {preview.provider?.model || "-"}</em>
        <em>图片 API {preview.externalImageCalls || 1} 次</em>
        <em>输入 {preview.imageInputMode === "source-page-edit" ? "源页参考图重绘" : "文本生图"}</em>
        <em>prompt {preview.promptLength || 0} 字符</em>
        <em className={matchesPreflightJob ? "pass" : "warn"}>{matchesPreflightJob ? "预检一致" : "需重新预览"}</em>
        {sourceHref ? <a href={sourceHref} target="_blank" rel="noreferrer">打开源页</a> : null}
        {artifactHref ? <a href={artifactHref} target="_blank" rel="noreferrer">打开 Prompt 证据</a> : null}
      </div>
      <small>{matchesPreflightJob ? "该 prompt 使用当前最新样张预检的源页；这里只预览，不生成图片。" : "该 prompt 可能来自旧预检任务，请重新点击预览样张 prompt。"}</small>
      <small>{uiZh(preview.styleBrief || "")}</small>
      <p>{uiZh(preview.promptExcerpt || preview.prompt || "")}</p>
    </div>
  );
}

function promptPreviewMatchesSamplePreflight(preflight = null, preview = null) {
  const jobId = preflight?.jobId || "";
  if (!jobId || !preview) return false;
  const sourceHref = preview.sourcePageLink?.href || "";
  return Boolean(sourceHref && sourceHref.includes(jobId));
}

function ProductVisualQualityReport({ result = null }) {
  const quality = result?.visualQuality || null;
  const summary = quality?.summary || {};
  const [retryPreflight, setRetryPreflight] = useState(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewMessage, setReviewMessage] = useState("");
  useEffect(() => {
    let cancelled = false;
    if (!result?.jobId || (!quality && !result?.visualQualityLink?.href)) {
      setRetryPreflight(null);
      return;
    }
    api.visualQualityRetryPreflight(result.jobId, {})
      .then((data) => { if (!cancelled) setRetryPreflight(data); })
      .catch((error) => { if (!cancelled) setRetryPreflight({ ok: false, error: getErrorMessage(error) }); });
    return () => { cancelled = true; };
  }, [result?.jobId, quality?.path, result?.visualQualityLink?.href]);
  if (!quality && !result?.visualQualityLink?.href) return null;
  const status = summary.failedCount ? "fail" : summary.reviewCount ? "review" : "pass";
  const styleConsistency = summary.styleConsistency || {};
  const retryCandidates = Array.isArray(retryPreflight?.candidates) ? retryPreflight.candidates : [];
  const canApproveReview = Boolean(result?.jobId && status === "review" && !summary.failedCount);
  async function approveVisualReview() {
    if (!canApproveReview || reviewBusy) return;
    setReviewBusy(true);
    setReviewMessage("");
    try {
      await api.approveWorkflowVisualQualityReview(result.jobId, {
        reviewer: "frontend-operator",
        note: "visual quality report reviewed before editable rebuild"
      });
      setReviewMessage("视觉复核已确认，可继续进入可编辑重建。");
    } catch (error) {
      setReviewMessage(getErrorMessage(error));
    } finally {
      setReviewBusy(false);
    }
  }
  return (
    <div className={`product-v1-product-visual-quality ${status}`}>
      <div>
        <span>视觉质量证据</span>
        <b>{status === "pass" ? "本地 QA 通过" : status === "fail" ? "存在失败页" : "需要人工复核"}</b>
        <small>{summary.manualReviewRequired ? "源页含可读标题或正文，请对照源页确认标题、Logo 和主视觉没有丢失。" : "已完成本地像素检查。"}</small>
      </div>
      <div>
        <em>页数 {summary.pageCount || 0}</em>
        <em>通过 {summary.passCount || 0}</em>
        <em>复核 {summary.reviewCount || 0}</em>
        <em>失败 {summary.failedCount || 0}</em>
        <em className={styleConsistency.status === "pass" ? "pass" : styleConsistency.status === "review" ? "warn" : ""}>
          风格一致性 {styleConsistency.status === "pass" ? "通过" : styleConsistency.status === "review" ? `需复核 ${styleConsistency.driftCount || 0} 页` : "数据不足"}
        </em>
        {summary.primaryReason ? <em>{uiZh(summary.primaryReason)}</em> : null}
        {result.visualQualityLink?.href ? <a href={result.visualQualityLink.href} target="_blank" rel="noreferrer">打开质量报告</a> : null}
        {canApproveReview ? <button type="button" onClick={approveVisualReview} disabled={reviewBusy}>{reviewBusy ? "确认中" : "确认视觉复核"}</button> : null}
        {reviewMessage ? <em>{reviewMessage}</em> : null}
      </div>
      {retryPreflight ? (
        <div className="product-v1-product-visual-retry-preflight">
          <b>{retryPreflight.resetReady ? "可重生风险页" : retryCandidates.length ? "风险页需要处理" : "未发现必须重生页"}</b>
          <small>{retryPreflight.resetReady ? `建议先重置 ${retryPreflight.resettableCount || 0} 页 codex-ppt 图片任务，再确认 ${retryPreflight.requiredConfirmations?.externalImageSpend?.imageCalls || 0} 次图片 API 后重跑。` : retryPreflight.error || (retryPreflight.warnings || retryPreflight.blockingIssues || []).join(" / ") || "当前质量报告没有必须重生的标题/文字弱化页。"}</small>
          {retryCandidates.length ? (
            <div>
              {retryCandidates.slice(0, 6).map((page) => (
                <em className={page.codexTask?.resettable ? "warn" : "fail"} key={page.pageId}>{page.pageId}：{(page.reasons || []).map(uiZh).join(" / ") || "需要复核"}</em>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function EditableRebuildAcceptancePlan({ plan = null }) {
  if (!plan) return null;
  const confirmations = Array.isArray(plan.requiredConfirmations) ? plan.requiredConfirmations : [];
  const artifacts = Array.isArray(plan.expectedArtifacts) ? plan.expectedArtifacts : [];
  const checks = Array.isArray(plan.acceptanceChecks) ? plan.acceptanceChecks : [];
  const recovery = Array.isArray(plan.failureRecovery) ? plan.failureRecovery : [];
  const pageLabel = Array.isArray(plan.selectedPageIds) && plan.selectedPageIds.length ? plan.selectedPageIds.join("、") : "待选择";
  return (
    <div className="editable-rebuild-acceptance-plan">
      <div className="editable-rebuild-acceptance-head">
        <div>
          <span>1-2 页真实闭环验收</span>
          <b>{plan.readyIfConfirmed ? "条件已具备，等待确认后启动" : "仍需补齐启动条件"}</b>
          <small>只用于说明启动和验收标准；不会自动调用外部 API。</small>
        </div>
        <strong>{plan.estimatedExternalImageCalls || 0} 次图片 API</strong>
      </div>
      <div className="editable-rebuild-acceptance-facts">
        <span>页面<b>{pageLabel}</b></span>
        <span>任务<b>{plan.selectedCount || 0} 页</b></span>
        <span>静默消耗<b>{plan.noSilentSpend ? "禁止" : "未声明"}</b></span>
      </div>
      {confirmations.length ? (
        <div className="editable-rebuild-acceptance-section">
          <span>启动前确认</span>
          <div>
            {confirmations.map((item) => (
              <em className={item.satisfied ? "pass" : "warn"} key={item.id || item.label}>
                {uiZh(item.label || item.id)}：{item.satisfied ? "已满足" : "待确认"}{item.evidence ? ` / ${uiZh(item.evidence)}` : ""}
              </em>
            ))}
          </div>
        </div>
      ) : null}
      {artifacts.length ? (
        <div className="editable-rebuild-acceptance-section">
          <span>必须产物</span>
          <div>{artifacts.slice(0, 6).map((item) => <em key={item}>{uiZh(item)}</em>)}</div>
        </div>
      ) : null}
      {checks.length ? (
        <div className="editable-rebuild-acceptance-section">
          <span>通过标准</span>
          <div>{checks.map((item) => <em key={item.id || item.label}>{uiZh(item.label || item.id)}</em>)}</div>
        </div>
      ) : null}
      {recovery.length ? <small>失败恢复：{recovery.slice(0, 2).map(uiZh).join("；")}</small> : null}
    </div>
  );
}

function ProductVisualSampleReviewChecklist({ checklist = null }) {
  if (!checklist) return null;
  const items = Array.isArray(checklist.items) ? checklist.items : [];
  return (
    <div className={`product-v1-product-visual-review-checklist ${checklist.status || "blocked"}`}>
      <div>
        <span>样张复核清单</span>
        <b>{checklist.passed ? "样张关卡已确认" : checklist.ready ? "可人工复核" : "等待真实样张"}</b>
        <small>{uiZh(checklist.instruction || "请先打开样张复核，再确认样张关卡。")}</small>
      </div>
      <div className="product-v1-product-visual-review-actions">
        {checklist.sampleLink?.href ? <a href={checklist.sampleLink.href} target="_blank" rel="noreferrer">打开样张复核</a> : null}
        {checklist.sourcePageLink?.href ? <a href={checklist.sourcePageLink.href} target="_blank" rel="noreferrer">打开源页对照</a> : null}
      </div>
      {items.length ? (
        <div>
          {items.map((item) => (
            <em className={item.ok ? "pass" : "warn"} key={item.id}>
              {uiZh(item.label || item.id)}：{uiZh(item.detail || (item.ok ? "通过" : "待处理"))}
            </em>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ProductV1PhaseProgress({ progress = null }) {
  if (!progress || !Array.isArray(progress.phases)) return null;
  const phases = progress.phases;
  const current = phases.find((phase) => phase.id === progress.currentPhaseId) || phases.find((phase) => phase.status !== "done") || null;
  return (
    <div className={`product-v1-phase-progress ${progress.blocked ? "blocked" : progress.done >= progress.total ? "done" : "working"}`}>
      <div className="product-v1-phase-progress-head">
        <div>
          <span>整体阶段进度</span>
          <b>{progress.done || 0}/{progress.total || phases.length} 阶段完成</b>
          <small>{uiZh(progress.summary || "根据真实验收证据自动判断当前完成度。")}</small>
        </div>
        <strong>{progress.percent || 0}%</strong>
      </div>
      {current ? (
        <div className={`product-v1-phase-current ${current.status}`}>
          <span>当前重点</span>
          <b>{uiZh(current.label)}</b>
          <small>{uiZh(current.detail || "继续补齐该阶段证据。")}</small>
        </div>
      ) : null}
      <div className="product-v1-phase-grid">
        {phases.map((phase) => (
          <div className={`product-v1-phase-item ${phase.status}`} key={phase.id}>
            <span>{uiZh(phase.status === "done" ? "完成" : phase.status === "blocked" ? "阻断" : phase.status === "working" ? "进行中" : "待处理")}</span>
            <b>{uiZh(phase.label)}</b>
            <small>{uiZh(phase.detail || "")}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

function buildProductVisualAgentNextAction({
  productVisualNext = null,
  productVisualSamplePreflight = null,
  productVisualSampleRunResult = null,
  productVisualSampleApprovalPreflight = null,
  productVisualFullDeckApprovalPreflight = null,
  productVisualFullDeckPreflight = null,
  productVisualFullDeckRunResult = null,
  fullDeckTargetPages = 2
} = {}) {
  if (!productVisualNext || productVisualNext.status === "pass") return null;
  if (productVisualFullDeckRunResult?.imageDeckLink?.href || productVisualFullDeckRunResult?.imageDeck?.path) {
    return {
      level: "safe",
      title: "检查 15 页真实验收",
      detail: "全量图片型 PPT 已有结果，下一步运行真实验收报告，确认可编辑重建和交付门禁。",
      badge: "不生成图片"
    };
  }
  if (productVisualFullDeckPreflight?.readyIfConfirmed) {
    const calls = Math.max(1, Number(fullDeckTargetPages || productVisualNext?.targetPages || 15));
    return {
      level: "paid",
      title: `生成 ${calls} 页图片型 PPT`,
      detail: `需要先勾选确认，会调用外部图片 API ${calls} 次；建议先用 2 页测试确认跨页风格。`,
      badge: `${calls} 次图片 API`
    };
  }
  if (productVisualFullDeckApprovalPreflight?.ready) {
    return {
      level: "safe",
      title: "确认全量生成关卡",
      detail: "样张已经具备继续全量的条件；确认关卡本身不会生成图片。",
      badge: "不生成图片"
    };
  }
  if (productVisualSampleApprovalPreflight?.ready) {
    return {
      level: "safe",
      title: "人工确认样张关卡",
      detail: "先打开样张和源页对照，确认视觉方向可用后再进入全量预检。",
      badge: "人工复核"
    };
  }
  if (productVisualSampleRunResult?.sampleLink?.href || productVisualSampleRunResult?.visualSample?.imagePath) {
    return {
      level: "safe",
      title: "检查样张确认条件",
      detail: "真实样张已经生成，下一步检查是否能进入人工确认关卡。",
      badge: "不生成图片"
    };
  }
  if (productVisualSamplePreflight?.readyIfConfirmed) {
    return {
      level: "paid",
      title: "生成 1 页真实样张",
      detail: "需要先勾选确认，会调用外部图片 API 1 次；样张通过后才允许全量生成。",
      badge: "1 次图片 API"
    };
  }
  return {
    level: "safe",
    title: "检查真实样张条件",
    detail: "先运行无费用预检或样张预检，确认源页、模型、关卡都已就绪。",
    badge: "不生成图片"
  };
}

function ProductVisualNextStagePlan({ plan = null }) {
  if (!plan) return null;
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const blockers = Array.isArray(plan.blockers) ? plan.blockers : [];
  return (
    <div className={`product-v1-product-visual-next-stage-plan ${plan.status || "blocked"}`}>
      <div>
        <span>下一阶段计划</span>
        <b>{uiZh(plan.nextRecommendedAction || "等待样张确认")}</b>
        <small>
          2 页测试预计 {plan.estimatedTwoPageImageCalls || plan.recommendedTestPages || 0} 次图片调用；
          全量预计 {plan.estimatedFullDeckImageCalls || plan.targetPages || 0} 次图片调用。
        </small>
      </div>
      {steps.length ? (
        <div className="product-v1-product-visual-next-stage-steps">
          {steps.map((step) => (
            <em className={step.status === "done" || step.status === "ready" ? "pass" : "warn"} key={step.id}>
              {uiZh(step.label || step.id)}：{uiZh(step.detail || step.status || "")}
            </em>
          ))}
        </div>
      ) : null}
      {blockers.length ? (
        <div className="product-v1-product-visual-next-stage-blockers">
          {blockers.slice(0, 4).map((item) => <em className="warn" key={item}>{uiZh(item)}</em>)}
        </div>
      ) : null}
    </div>
  );
}

function ProductV1LlmRecoveryCard({ bundle = null, deliveryNextStep = null, onFocusDeliveryStep, onRetryFailedPages, onStartEditableWorkerBatch, recoveryBusy = "" }) {
  const providerFailure = bundle?.providerFailure || {};
  const recentProviderFailure = bundle?.recentProviderFailure || {};
  const recoveryConfirmation = bundle?.confirmations?.llmProviderRecovered || {};
  const recoveryPlan = bundle?.llmRecoveryPlan || deliveryNextStep?.recoveryPlan || {};
  const isLlmStep = ["fix-llm-provider", "fix-llm-provider-quota", "fix-llm-provider-auth"].includes(deliveryNextStep?.id || deliveryNextStep?.actionId || "");
  const hasLlmFailure = Boolean(providerFailure.blocked || recentProviderFailure.found || recoveryConfirmation.required || isLlmStep);
  if (!hasLlmFailure) return null;
  const isAuth = providerFailure.kind === "provider-auth-failed" || recentProviderFailure.kind === "provider-auth-failed" || deliveryNextStep?.actionId === "fix-llm-provider-auth";
  const isTimeout = providerFailure.kind === "provider-timeout" || recentProviderFailure.kind === "provider-timeout";
  const isQuota = providerFailure.kind === "provider-quota-exhausted" || recentProviderFailure.kind === "provider-quota-exhausted";
  const llmProvider = bundle?.llmProvider || recentProviderFailure.currentProvider?.llm || providerFailure.currentProvider?.llm || {};
  const imageProvider = bundle?.imageProvider || bundle?.provider || {};
  const planSteps = Array.isArray(recoveryPlan.steps) && recoveryPlan.steps.length ? recoveryPlan.steps : [
    isAuth
      ? "检查页面重建模型的 API Key、Base URL 和鉴权状态。"
      : isTimeout
        ? "切换更稳定的页面重建模型，或稍后重试；这里不是 OCR 问题。"
        : "充值、切换或降级页面重建模型；这里不需要改 OCR 或 gpt-image-2。",
    "重置受影响页面任务，保留已成功页面。",
    "点击“检测页面重建模型”，确认图片输入、JSON 输出和非空响应都通过。",
    "通过后只重跑受影响页面，再重新合成最终 PPT。"
  ];
  const failedPages = recoveryPlan.pages?.length ? recoveryPlan.pages.join("、") : recentProviderFailure.pages?.length ? recentProviderFailure.pages.join("、") : "";
  const title = isAuth
    ? "页面重建模型鉴权失败"
    : isTimeout
      ? "页面重建模型请求超时"
      : isQuota
        ? "页面重建模型额度不足"
        : "页面重建模型不可用";
  const recoveryConfirmed = Boolean(recoveryConfirmation.confirmed || !recoveryConfirmation.required);
  const resetBusy = recoveryBusy === "bulk-failed";
  const startBusy = recoveryBusy === "prompt-loading";
  return (
    <div className={`product-v1-llm-recovery ${isAuth ? "auth" : isTimeout ? "timeout" : "quota"}`}>
      <div>
        <span>当前阻塞</span>
        <b>{title}</b>
        <small>{uiZh(deliveryNextStep?.reason || recentProviderFailure.message || providerFailure.message || "可编辑重建需要先恢复对话模型服务商。")}</small>
      </div>
      <div className="product-v1-llm-recovery-steps">
        {planSteps.slice(0, 4).map((step, index) => (
          <span key={`${index}-${step}`}><b>{index + 1}</b>{uiZh(step)}</span>
        ))}
      </div>
      <div className="product-v1-llm-recovery-facts">
        <span>对话模型<b>{llmProvider.model || "待确认"}</b></span>
        <span>图片模型<b>{imageProvider.model || "gpt-image-2"}</b></span>
        <span>失败页面<b>{failedPages || "待重跑页"}</b></span>
        <span>恢复确认<b>{recoveryConfirmation.confirmed ? "已确认" : recoveryConfirmation.required ? "未确认" : "不需要"}</b></span>
      </div>
      <div className="product-v1-llm-recovery-actions">
        <button type="button" onClick={onRetryFailedPages} disabled={!onRetryFailedPages || resetBusy}>
          {resetBusy ? "正在重置失败页..." : "1. 重置失败页"}
        </button>
        <button
          type="button"
          onClick={onStartEditableWorkerBatch}
          disabled={!onStartEditableWorkerBatch || !recoveryConfirmed || startBusy}
          title={!recoveryConfirmed ? "请先确认对话模型服务商已恢复。" : ""}
        >
          {startBusy ? "正在检查页面任务..." : "2. 重新启动可编辑重建"}
        </button>
        <button type="button" onClick={() => onFocusDeliveryStep?.(deliveryNextStep || { id: "fix-llm-provider" })}>
          打开模型设置与高级重跑入口
        </button>
      </div>
      {!recoveryConfirmed ? <small>重新启动前需要先确认对话模型服务商已经充值、切换或修复鉴权。</small> : null}
    </div>
  );
}

function ProductV1AuthorizationSummary({ actions = [], authorizationBusy = "", bundle = null, onAuthorize, onFocusDeliveryStep }) {
  const sample = bundle?.sample || null;
  const fullDeck = bundle?.fullDeck || null;
  const pendingActions = Array.isArray(actions) ? actions : [];
  if (!sample && !fullDeck && !pendingActions.length) return null;
  const sampleState = sample?.required ? (sample.persisted ? "已记录" : "缺少") : "不需要";
  const fullDeckState = fullDeck?.required ? (fullDeck.persisted ? "已记录" : "缺少") : "不需要";
  const state = pendingActions.length ? "warning" : "ready";
  return (
    <div className={`product-v1-authorization ${state}`}>
      <div>
        <span>额度授权</span>
        <b>{pendingActions.length ? "需要记录授权" : "授权账本已匹配"}</b>
        <small>授权记录会保存当前图片模型和服务商；记录授权不会生成图片。</small>
      </div>
      <div className="product-v1-authorization-facts">
        <span>样张<b>{sampleState}</b></span>
        <span>全量<b>{fullDeckState}</b></span>
        <span>模型<b>{sample?.provider?.model || fullDeck?.provider?.model || "已配置运行环境"}</b></span>
      </div>
      {pendingActions.length ? (
        <div className="product-v1-authorization-actions">
          {pendingActions.slice(0, 2).map((action) => (
            <button
              className={action.severity || "warning"}
              key={action.id || action.detail}
              type="button"
              onClick={() => onAuthorize ? onAuthorize(action.scope || "visual-sample") : onFocusDeliveryStep?.({ id: action.targetStepId || "record-sample-authorization" })}
              disabled={authorizationBusy === action.scope}
            >
              {authorizationBusy === action.scope ? "正在记录授权..." : uiZh(action.detail)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ProductSamplePreflightCard({ action = null, blocked = false, confirmed = false, provider = "", onFocus }) {
  if (!action) return null;
  const imageCalls = action.imageCalls || 1;
  const confirmation = action.requiresConfirmation || "externalImageSpend";
  return (
    <div className={`product-sample-preflight ${confirmed ? "ready" : "blocked"}`}>
      <div>
        <span>产品样张预检</span>
        <b>{confirmed ? "已可生成 1 页产品样张" : "等待图片 API 确认"}</b>
        <small>{uiZh(action.detail || "确认样张前，需要先生成 1 页产品级 codex-ppt 样张。")}</small>
      </div>
      <div className="product-sample-preflight-facts">
        <span>图片调用<b>{imageCalls}</b></span>
        <span>模型<b>{provider || "已配置运行环境"}</b></span>
        <span>确认状态<b>{confirmed ? "已确认" : uiZh(confirmation)}</b></span>
        <span>状态<b>{blocked ? "阻断" : "就绪"}</b></span>
      </div>
      <button type="button" onClick={onFocus}>
        打开样张步骤
      </button>
    </div>
  );
}

function WorkflowExternalSpendAuthorizationPanel({ bundle = null, busy = "", canAuthorizeFullDeck = false, canAuthorizeSample = false, fullDeckImageCalls = 0, message = "", onAuthorize, provider = "" }) {
  const records = Array.isArray(bundle?.externalImageSpend) ? bundle.externalImageSpend : [];
  const summary = bundle?.summary || {};
  const latest = summary.latest || records.at(-1) || null;
  return (
    <div className="workflow-spend-authorization" id="workflow-authorization-panel">
      <div>
        <span>额度授权账本</span>
        <b>{records.length ? `${records.length} 条授权记录` : "还没有持久化授权"}</b>
        <small>{provider || latest?.model || "已配置图片运行环境"} / 已授权图片调用：{summary.totalImageCalls || 0}</small>
      </div>
      <div className="workflow-spend-authorization-actions">
        <button type="button" onClick={() => onAuthorize?.("visual-sample")} disabled={!canAuthorizeSample || busy === "visual-sample"}>
          {busy === "visual-sample" ? "正在记录..." : "记录样张授权"}
        </button>
        <button type="button" onClick={() => onAuthorize?.("full-deck")} disabled={!canAuthorizeFullDeck || !fullDeckImageCalls || busy === "full-deck"}>
          {busy === "full-deck" ? "正在记录..." : `记录全量授权：${fullDeckImageCalls || 0}`}
        </button>
      </div>
      {latest ? (
        <div className="workflow-spend-authorization-latest">
          <span>{latest.scope === "visual-sample" ? "样张" : latest.scope === "full-deck" ? "全量" : latest.scope}</span>
          <b>{latest.imageCalls} 次调用</b>
          <small>{latest.model || "模型待确认"} / {latest.confirmedAt ? new Date(latest.confirmedAt).toLocaleTimeString() : ""}</small>
        </div>
      ) : null}
      {message ? <p>{message}</p> : null}
    </div>
  );
}

function GuidedNextActionPreflightCard({ bundle = null, guidedAction = null, onContinueRemaining }) {
  if (!bundle && !guidedAction) return null;
  const requiredConfirmation = bundle?.requiredConfirmation || "";
  const blocked = Boolean(bundle?.blockingIssues?.length || bundle?.error);
  const level = bundle?.startReady ? "ready" : requiredConfirmation ? "warning" : bundle?.manualRequired ? "manual" : blocked ? "blocked" : "pending";
  const title = bundle?.startReady
    ? "运行前已就绪"
    : requiredConfirmation
      ? "需要确认"
      : bundle?.manualRequired
        ? "需要手动处理"
        : blocked
          ? "运行前被阻断"
          : "正在检查下一步";
  const actionLabel = uiZh(bundle?.action || guidedAction?.action || guidedAction?.kind || "无");
  const message = uiZh(bundle?.reason || bundle?.summary || guidedAction?.description || "预检会判断推荐动作是否可以开始。");
  const issues = [...(bundle?.blockingIssues || []), ...(bundle?.warnings || [])].filter(Boolean);
  const authorization = bundle?.authorization || null;
  const recovery = bundle?.recovery || null;
  const recoveryPages = Array.isArray(recovery?.pages) ? recovery.pages : [];
  const nextOptions = Array.isArray(bundle?.nextOptions) ? bundle.nextOptions : [];
  function focusNextOption(option = {}) {
    if (option.id === "continue-remaining-pages") {
      onContinueRemaining?.(option);
      return;
    }
    const target = option.targetPanel || "";
    if (!target) return;
    const element = document.getElementById(target);
    if (element) element.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  return (
    <div className={`guided-next-preflight ${level}`}>
      <div>
        <span>引导预检</span>
        <b>{title}</b>
        <small>{message}</small>
      </div>
      <div className="guided-next-preflight-facts">
        <span>动作<b>{actionLabel}</b></span>
        <span>图片调用<b>{bundle?.externalImageCalls || 0}</b></span>
        <span>确认项<b>{requiredConfirmation ? uiZh(requiredConfirmation) : "无"}</b></span>
        <span>模式<b>{bundle?.manualRequired ? "手动" : bundle?.mutatesWorkflow ? "会改动" : "只读"}</b></span>
        {authorization?.required ? <span>账本<b>{authorization.persisted ? "已记录" : "缺少"}</b></span> : null}
      </div>
      {recovery ? (
        <div className="guided-next-recovery-plan">
          <span>恢复计划</span>
          <b>{uiZh(recovery.nextAction || "等待下一步")}</b>
          <small>{uiZh(recovery.message || "")}</small>
          {recoveryPages.length ? (
            <div className="guided-next-recovery-pages">
              {recoveryPages.slice(0, 8).map((pageId) => <em key={pageId}>{pageId}</em>)}
            </div>
          ) : null}
          {recovery.externalImageConfirmationRequired ? <small>重跑可编辑页面任务前需要确认外部图片 API 额度。</small> : null}
        </div>
      ) : null}
      {nextOptions.length ? (
        <div className="guided-next-options">
          <span>可选下一步</span>
          {nextOptions.map((option) => (
            <button
              key={option.id || option.label}
              type="button"
              className={option.requiresExternalImageConfirmation ? "warning" : "primary"}
              onClick={() => focusNextOption(option)}
            >
              <b>{uiZh(option.label || option.id)}</b>
              <small>{uiZh(option.detail || "")}</small>
              {option.externalImageCalls ? <em>{option.externalImageCalls} 次图片 API</em> : null}
            </button>
          ))}
        </div>
      ) : null}
      {authorization?.warning ? <small className="guided-next-preflight-issue">{uiZh(authorization.warning)}</small> : null}
      {issues.length ? <small className="guided-next-preflight-issue">{uiZh(issues.slice(0, 2).join(" "))}</small> : null}
    </div>
  );
}

function ProductV1CodexSlidePreflightSummary({ actions = [], bundle = null, onFocusDeliveryStep, resetPreview = null }) {
  if (!bundle) return null;
  const state = bundle.startReady ? "ready" : bundle.ready ? "warning" : "blocked";
  const external = bundle.confirmations?.externalImageSpend || {};
  const backendRuntime = bundle.backendRuntime || {};
  const backendCurrent = Boolean(backendRuntime.backendMatchesRuntime && !backendRuntime.approvedBackendLooksDryRun);
  const issues = bundle.blockingIssues?.length ? bundle.blockingIssues : bundle.warnings || [];
  return (
    <div className={`product-v1-codex-preflight ${state}`}>
      <div>
        <span>codex-ppt 视觉预检</span>
        <b>{bundle.startReady ? "已可生成视觉页" : bundle.ready ? "需要确认额度" : "被阻断或已记录"}</b>
        <small>{bundle.selectedCount || 0} 已选择 / {bundle.counts?.total || 0} 个图片页任务 / {bundle.provider?.model || "服务商待确认"}</small>
      </div>
      <div className="product-v1-codex-facts">
        <span>确认关卡<b>{bundle.approvals?.ready ? "就绪" : `${bundle.approvals?.approved?.length || 0}/${bundle.approvals?.required?.length || 5}`}</b></span>
        <span>图片调用<b>{bundle.cost?.imageCalls || 0}</b></span>
        <span>可重置项<b>{resetPreview?.candidateCount || 0}</b></span>
        <span>外部 API<b>{external.required ? (external.confirmed ? "已确认" : "必需") : "不需要"}</b></span>
        <span>后端确认<b>{backendCurrent ? "当前" : "需刷新"}</b></span>
      </div>
      {actions.length ? (
        <div className="product-v1-codex-actions">
          <span>视觉生成动作</span>
          {actions.slice(0, 3).map((action) => (
            <button
              className={action.severity || "warning"}
              key={action.id || action.detail}
              type="button"
              onClick={() => onFocusDeliveryStep?.({ id: action.targetStepId || "generate-image-deck" })}
            >
              {uiZh(action.detail)}
            </button>
          ))}
        </div>
      ) : null}
      {issues.length ? <small>{uiZh(issues.slice(0, 2).join(" "))}</small> : null}
    </div>
  );
}

function ProductV1ProviderRuntimeSummary({ actions = [], check = null, onFocusDeliveryStep }) {
  if (!check) return null;
  const evidence = check.evidence || {};
  const runtime = evidence.runtime || {};
  const approvedBackend = evidence.approvedBackend || {};
  const state = check.status === "pass" ? "ready" : check.status === "fail" ? "blocked" : "warning";
  const runtimeLabel = evidence.runtimeKey || [runtime.model, runtime.baseUrl].filter(Boolean).join(" @ ") || "运行环境待确认";
  const backendLabel = evidence.approvedBackendKey || [approvedBackend.provider, approvedBackend.model, approvedBackend.baseUrl].filter(Boolean).join(" @ ") || "后端证据待确认";
  return (
    <div className={`product-v1-provider-runtime ${state}`}>
      <div>
        <span>运行环境证据</span>
        <b>{evidence.backendMatchesRuntime ? "运行环境与确认一致" : "运行环境证据需要刷新"}</b>
        <small>{runtimeLabel}</small>
      </div>
      <div className="product-v1-provider-facts">
        <span>已确认后端<b>{backendLabel}</b></span>
        <span>验证链路证据<b>{evidence.approvedBackendLooksDryRun ? "已发现" : "未发现"}</b></span>
      </div>
      {actions.length ? (
        <div className="product-v1-provider-actions">
          <span>服务商操作</span>
          {actions.slice(0, 2).map((action) => (
            <button
              key={action.id || action.detail}
              type="button"
              onClick={() => onFocusDeliveryStep?.({ id: action.targetStepId || "generate-image-deck" })}
            >
              {uiZh(action.detail)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ProductStyleRefreshCard({ action = null, busy = false, message = "", onRefresh }) {
  if (!action) return null;
  return (
    <div className="product-style-refresh-card">
      <div>
        <span>下一步</span>
        <b>刷新视觉风格证据</b>
        <small>{uiZh(action.detail || "当前风格证据需要重新记录后再继续。")}</small>
      </div>
      <button type="button" onClick={onRefresh} disabled={busy || !onRefresh}>
        {busy ? "正在刷新..." : "刷新风格证据（不生成图片）"}
      </button>
      {message ? <small>{message}</small> : null}
    </div>
  );
}

function llmFailureTitle(kind = "", suffix = "") {
  const text = kind === "provider-quota-exhausted"
    ? "对话模型额度不足"
    : kind === "provider-auth-failed"
      ? "对话模型鉴权失败"
      : kind === "provider-timeout"
        ? "页面重建模型超时"
        : kind === "provider-empty-response"
          ? "页面重建模型空响应"
          : "对话模型不可用";
  return suffix ? `${suffix}：${text}` : text;
}

function ProductV1WorkerPreflightSummary({ actions = [], bundle = null }) {
  if (!bundle) return null;
  const state = bundle.startReady ? "ready" : bundle.ready ? "warning" : "blocked";
  const external = bundle.confirmations?.externalImageSpend || {};
  const offline = bundle.confirmations?.offlineTextHints || {};
  const providerFailure = bundle.providerFailure || {};
  const recentProviderFailure = bundle.recentProviderFailure || {};
  const llmProvider = bundle.llmProvider || providerFailure.currentProvider?.llm || {};
  const imageProvider = bundle.imageProvider || bundle.provider || {};
  const issues = bundle.blockingIssues?.length ? bundle.blockingIssues : bundle.warnings || [];
  const showLlmRecovery = Boolean(providerFailure.blocked || recentProviderFailure.found);
  const llmRecoveryTitle = providerFailure.blocked
    ? llmFailureTitle(providerFailure.kind, "不能启动重建")
    : llmFailureTitle(recentProviderFailure.kind, "上次失败");
  const llmRecoveryMessage = providerFailure.message || recentProviderFailure.message || "请先充值或切换对话模型服务商，再重跑可编辑重建页面任务。";
  return (
    <div className={`product-v1-worker-preflight ${state}`}>
      <div>
        <span>页面批处理预检</span>
        <b>{bundle.startReady ? "可以开始" : bundle.ready ? "需要确认" : "被阻断"}</b>
        <small>{bundle.selectedCount || 0} 已选择 / {bundle.counts?.total || 0} 总计 / 图片模型 {imageProvider.model || "待确认"}</small>
      </div>
      <div className="product-v1-worker-preflight-checks">
        <span className={external.required && !external.confirmed ? "warn" : "ok"}>外部 API {external.required ? (external.confirmed ? "已确认" : "必需") : "不需要"}</span>
        <span className={offline.confirmed ? "ok" : "warn"}>文字提示 {offline.confirmed ? "已接受" : "需要确认"}</span>
        <span className={llmProvider.model ? "ok" : "warn"}>对话模型 {llmProvider.model || "待确认"}</span>
      </div>
      {showLlmRecovery ? (
        <div className="product-v1-worker-provider-recovery">
          <b>{llmRecoveryTitle}</b>
          <span>{uiZh(llmRecoveryMessage)}</span>
          <small>这是可编辑重建用到的对话模型，不是 OCR，也不是 gpt-image-2 图片生成。确认图片 API 用量后，仍需要先保证对话模型服务商可用。</small>
        </div>
      ) : null}
      {actions.length ? (
        <div className="product-v1-preflight-actions">
          <span>启动前需要</span>
          {actions.slice(0, 3).map((action) => <b className={action.severity || "warning"} key={action.id || action.detail}>{uiZh(action.detail)}</b>)}
        </div>
      ) : null}
      {issues.length ? <small>{uiZh(issues.slice(0, 2).join(" "))}</small> : null}
    </div>
  );
}

function SampleApprovalGuard({ gate = null, sampleArtifact = null, sampleHref = "", sampleLooksNonProduct = false }) {
  if (!gate) return null;
  const ui = gate.ui || {};
  const hasSample = Boolean(sampleArtifact?.path);
  const state = gate.passed ? "ready" : sampleLooksNonProduct ? "blocked" : ui.canApprove ? "ready" : "pending";
  const statusLabel = gate.passed
    ? "样张关卡已确认"
    : sampleLooksNonProduct
      ? "需要产品级样张"
      : ui.canApprove
        ? "等待人工复核"
        : "等待样张证据";
  const reviewChecklist = sampleLooksNonProduct
    ? ["拒绝验证链路/透传证据", "使用已确认的图片运行环境重新生成 1 页产品样张", "复核新图片后再确认样张"]
    : hasSample
      ? ["打开视觉样张", "检查风格一致性和文字可读性", "只有确认是产品级生成证据后再通过"]
      : ["生成 1 页产品级视觉样张", "确认图片运行环境和额度", "回到这里确认样张关卡"];
  return (
    <div className={`sample-approval-guard ${state}`}>
      <div>
        <span>样张确认保护</span>
        <b>{statusLabel}</b>
        <small>{uiZh(ui.reason || "样张确认用于防止用非产品证据启动全量生成。")}</small>
      </div>
      <div className="sample-approval-guard-facts">
        <span>产物<b>{hasSample ? "存在" : "缺少"}</b></span>
        <span>证据<b>{sampleLooksNonProduct ? "非产品" : hasSample ? "产品候选" : "待处理"}</b></span>
        <span>确认按钮<b>{ui.canApprove ? "可用" : "阻断"}</b></span>
      </div>
      <div className="sample-approval-guard-checklist">
        {reviewChecklist.map((item) => <span key={item}>{item}</span>)}
      </div>
      {sampleHref ? <a href={sampleHref} target="_blank" rel="noreferrer">打开样张证据</a> : null}
    </div>
  );
}

function WorkflowCodexDeckStatus({ artifacts = {}, busy = false, canAssembleImageDeck = false, canSync = false, complianceBundle = null, loading = false, onAssemble, onFocusWorker, onSync, tasks = [] }) {
  const gateMap = new Map((complianceBundle?.codexPpt?.approvals?.gates || []).map((gate) => [gate.id, Boolean(gate.passed)]));
  const sampleReady = Boolean(artifacts.visualSample?.path && gateMap.get("sample"));
  const fullDeckApproved = Boolean(gateMap.get("fullDeck"));
  const summary = artifacts.codexPptSlideWorkerTasks?.length && !tasks.length
    ? summarizeCodexTasks(artifacts.codexPptSlideWorkerTasks)
    : summarizeCodexTasks(tasks, complianceBundle?.codexPpt?.slideState);
  const total = summary.total || 0;
  const recorded = summary.recorded || 0;
  const failed = summary.failed || 0;
  const queueReady = total > 0;
  const visualImages = Array.isArray(artifacts.visualImages) ? artifacts.visualImages.length : 0;
  const imageDeckPath = shortPath(artifacts.imageDeck?.relativePath || artifacts.imageDeck?.path || "");
  const deckSpecPath = shortPath(artifacts.codexPptDeckSpec?.relativePath || artifacts.codexPptDeckSpec?.path || "");
  const imageProvider = complianceBundle?.providers?.image || {};
  const providerReady = Boolean(imageProvider.enabled && imageProvider.configured);
  const providerLabel = providerReady
    ? `${imageProvider.model || "图片模型"} / ${imageProvider.baseUrl || "已配置服务商"}`
    : imageProvider.enabled === false
      ? "图片 API 已停用"
      : "图片 API 未配置";
  const progress = imageDeckPath ? 100 : total ? Math.round((recorded / total) * 100) : 0;
  const stageItems = [
    { key: "sample", label: "样张", value: sampleReady ? "已确认" : artifacts.visualSample?.path ? "待复核" : "待处理", state: sampleReady ? "done" : artifacts.visualSample?.path ? "active" : "pending" },
    { key: "fullDeck", label: "全量", value: fullDeckApproved ? "已授权" : "待确认", state: fullDeckApproved ? "done" : sampleReady ? "active" : "pending" },
    { key: "queue", label: "图片页队列", value: queueReady ? `${recorded}/${total}` : "未同步", state: failed ? "blocked" : recorded && recorded >= total ? "done" : queueReady ? "active" : fullDeckApproved ? "active" : "pending" },
    { key: "deck", label: "图片型 PPT", value: imageDeckPath || (visualImages ? `${visualImages} 张图片` : "待处理"), state: imageDeckPath ? "done" : canAssembleImageDeck ? "active" : "pending" }
  ];

  return (
    <section className="workflow-codex-deck-status">
      <div className="workflow-codex-deck-head">
        <div>
          <b>codex-ppt 全量图片阶段</b>
          <span>样张确认后，同步图片页任务，记录生成图片，再组装图片型 PPT。</span>
        </div>
        <div className={`workflow-codex-deck-progress ${failed ? "blocked" : imageDeckPath ? "done" : queueReady ? "active" : "pending"}`}>
          <strong>{imageDeckPath ? "图片型 PPT 已就绪" : queueReady ? `${recorded}/${total} 已记录` : "等待队列"}</strong>
          <span>{deckSpecPath || "同步队列后会创建 deck_spec"}</span>
        </div>
        <div className={`workflow-codex-provider-pill ${providerReady ? "ready" : "warning"}`}>
          <strong>{providerReady ? "外部图片 API" : "需要图片 API"}</strong>
          <span>{providerLabel}</span>
        </div>
      </div>
      <div className="workflow-codex-stage-list">
        {stageItems.map((item) => (
          <div className={`workflow-codex-stage ${item.state}`} key={item.key}>
            <span>{item.label}</span>
            <b>{item.value}</b>
          </div>
        ))}
      </div>
      <div className="workflow-codex-progress-bar" aria-label="codex-ppt slide progress">
        <i style={{ width: `${progress}%` }} />
      </div>
      <div className="workflow-codex-deck-actions">
        <button type="button" onClick={onSync} disabled={busy || loading || !canSync}>{loading ? "同步中..." : queueReady ? "刷新队列" : "同步图片页队列"}</button>
        <button type="button" onClick={onFocusWorker} disabled={busy || !queueReady}>打开图片页任务</button>
        <button type="button" onClick={onAssemble} disabled={busy || !canAssembleImageDeck}>组装图片 PPT</button>
      </div>
    </section>
  );
}

function summarizeCodexTasks(tasks = [], slideState = {}) {
  const normalized = Array.isArray(tasks) ? tasks : [];
  const total = Number(slideState?.total || normalized.length || 0);
  const recorded = Number(slideState?.recorded || normalized.filter((task) => task.status === "recorded").length || 0);
  const failed = Number(slideState?.failed || normalized.filter((task) => task.status === "failed").length || 0);
  const ready = Number(normalized.filter((task) => task.status === "ready").length || 0);
  const running = Number(normalized.filter((task) => task.status === "claimed" || task.status === "running").length || 0);
  return { total, recorded, failed, ready, running };
}

function WorkflowCostEstimatePanel({ bundle = null }) {
  if (!bundle) return null;
  const imageOps = bundle.operations?.imageGenerations || {};
  const editableOps = bundle.operations?.editablePages || {};
  const unknown = Array.isArray(bundle.unknownCostItems) ? bundle.unknownCostItems.length : 0;
  const level = bundle.pricingConfigured ? "ready" : unknown ? "warning" : "pending";
  return (
    <div className={`workflow-cost-panel ${level}`}>
      <div className="workflow-cost-head">
        <div>
          <b>费用预估</b>
          <span>{uiZh(bundle.duration?.label || "等待工作流范围")} / {bundle.pageCount || 0} 页</span>
        </div>
        <strong>{formatUsd(bundle.knownTotalUsd)}{unknown ? "+" : ""}</strong>
      </div>
      <div className="workflow-cost-grid">
        <WorkflowArtifact label="图片 API" value={`${(imageOps.sampleRemaining || 0) + (imageOps.deckRemaining || 0)} 次调用`} />
        <WorkflowArtifact label="可编辑页面" value={`${editableOps.remaining || 0}/${editableOps.totalExpected || 0}`} />
        <WorkflowArtifact label="已知费用" value={formatUsd(bundle.knownTotalUsd)} />
        <WorkflowArtifact label="定价" value={bundle.pricingConfigured ? "已配置" : `${unknown} 项未知`} />
      </div>
      {bundle.warnings?.length ? <p>{uiZh(bundle.warnings[0])}</p> : <p>这是规划估算，不是服务商账单。</p>}
    </div>
  );
}

function WorkflowWorkerBatchPreflightPanel({ bundle = null }) {
  if (!bundle) return null;
  const state = bundle.startReady ? "ready" : bundle.ready ? "warning" : "blocked";
  const external = bundle.requiredConfirmations?.externalImageSpend || {};
  const offline = bundle.requiredConfirmations?.offlineTextHints || {};
  const providerFailure = bundle.providerFailure || {};
  const recentProviderFailure = bundle.recentProviderFailure || {};
  const editablePages = bundle.cost?.editablePages || {};
  const activeRunner = bundle.activeRunner || null;
  const textHints = bundle.textHints || {};
  const modelPageWorkers = bundle.modelPageWorkers || null;
  const modelPageWorkerPages = Array.isArray(modelPageWorkers?.pages) ? modelPageWorkers.pages : [];
  const issues = bundle.blockingIssues?.length ? bundle.blockingIssues : bundle.warnings || [];
  const failedProvider = providerFailure.failedProvider?.llm || providerFailure.failedProvider || {};
  const currentProvider = providerFailure.currentProvider?.llm || providerFailure.currentProvider || {};
  return (
    <div className={`workflow-worker-preflight ${state}`}>
      <div className="workflow-worker-preflight-head">
        <div>
          <b>{bundle.startReady ? "批处理预检就绪" : bundle.ready ? "批处理需要确认" : "批处理预检被阻断"}</b>
          <span>{bundle.selectedCount || 0} 个页面任务已选择 / {bundle.mode || "模型"} 模式</span>
        </div>
        <strong>{bundle.startReady ? "就绪" : bundle.ready ? "需确认" : "阻断"}</strong>
      </div>
      <div className="workflow-worker-preflight-grid">
        <WorkflowArtifact label="对话模型" value={bundle.llmProvider?.model || "未配置"} />
        <WorkflowArtifact label="图片模型" value={bundle.imageProvider?.model || bundle.provider?.model || "未配置"} />
        <WorkflowArtifact label="已选择" value={`${bundle.selectedCount || 0}/${bundle.counts?.total || 0}`} />
        <WorkflowArtifact label="运行模式" value={bundle.mode === "model" ? "模型重建" : "本地实验"} />
        <WorkflowArtifact label="文字提示" value={textHints.source ? `${textHints.source} / ${textHints.readyPages || 0} 页 / ${textHints.textLineCount || 0} 行` : "未就绪"} />
        <WorkflowArtifact label="剩余可编辑页" value={`${editablePages.remaining ?? 0}/${editablePages.totalExpected ?? 0}`} />
        <WorkflowArtifact label="估算" value={bundle.cost?.knownTotalUsd ? formatUsd(bundle.cost.knownTotalUsd) : (bundle.cost?.unknownCostItems?.length ? "未知" : "无费用")} />
      </div>
      <div className="workflow-worker-preflight-checks">
        <span className={external.required && !external.confirmed ? "warn" : "ok"}>外部额度 {external.required ? (external.confirmed ? "已确认" : "必需") : "不需要"}</span>
        <span className={offline.confirmed ? "ok" : "warn"}>文字提示 {offline.required ? (offline.confirmed ? "已接受" : "需要确认") : "已就绪"}</span>
        {activeRunner ? <span className="warn">运行中的任务 {activeRunner.id}</span> : null}
      </div>
      {providerFailure.blocked ? (
        <div className="workflow-worker-preflight-checks">
          <span className="fail">{llmFailureTitle(providerFailure.kind)}</span>
          <span>{uiZh(providerFailure.message)}</span>
          <span>阻断来源是对话模型，不是 OCR，也不是 gpt-image-2 图片出图。</span>
          {currentProvider.model ? <span>当前对话模型：{currentProvider.model}{currentProvider.baseUrl ? ` @ ${currentProvider.baseUrl}` : ""}</span> : null}
          {failedProvider.model ? <span>失败记录：{failedProvider.model}{failedProvider.baseUrl ? ` @ ${failedProvider.baseUrl}` : ""}</span> : null}
        </div>
      ) : null}
      {!providerFailure.blocked && recentProviderFailure.found ? (
        <div className="workflow-worker-preflight-checks">
          <span className="warn">{llmFailureTitle(recentProviderFailure.kind, "上次失败")}</span>
          <span>{uiZh(recentProviderFailure.message)}</span>
          <span>这不是 OCR 问题，也不是 gpt-image-2 出图问题；确认启动前请先确认对话模型服务商可用。</span>
        </div>
      ) : null}
      {modelPageWorkers ? (
        <div className="workflow-worker-preflight-checks">
          <span className={modelPageWorkers.missingCount ? "warn" : "ok"}>
            模型页预检 {modelPageWorkers.readyCount || 0}/{modelPageWorkers.pageCount || modelPageWorkerPages.length || 0}
          </span>
          <span>{(modelPageWorkers.checkedFiles || []).join(" / ")}</span>
          {modelPageWorkers.missingCount ? <span className="warn">生成页面简报后再启动批处理：{modelPageWorkers.missingSummary || `${modelPageWorkers.missingCount} 页缺少文件`}</span> : null}
        </div>
      ) : null}
      {activeRunner?.logHref ? (
        <div className="workflow-worker-preflight-links">
          <a href={activeRunner.logHref} target="_blank" rel="noreferrer">打开运行日志</a>
          {activeRunner.logDownloadHref ? <a href={activeRunner.logDownloadHref}>下载日志</a> : null}
        </div>
      ) : null}
      {issues.length ? <p>{uiZh(issues.slice(0, 2).join(" "))}</p> : <p>预检确认队列、模型和可编辑运行目录已满足受控批处理启动条件。</p>}
    </div>
  );
}

function WorkflowEditableFailureRecoveryCard({
  failure = null,
  onOpenLog,
  onPreflight,
  onResetPages,
  onSelectPage,
  onStartPage,
  preflightBusy = false,
  resetBusy = false,
  run = null,
  startReady = false
}) {
  if (!failure) return null;
  const pages = Array.isArray(failure.pages) ? failure.pages.filter(Boolean) : [];
  const recoveryPlan = failure.recoveryPlan || {};
  const recoverySteps = Array.isArray(recoveryPlan.steps) ? recoveryPlan.steps : [];
  const pageText = pages.length ? pages.join("、") : "受影响页面";
  const imageProviderOverloaded = failure.kind === "image-provider-overloaded" || recoveryPlan.imageProviderRetryRecommended;
  const complexityLabel = imageProviderOverloaded
    ? "不适用：图片 API 过载"
    : recoveryPlan.lowComplexityRecommended
      ? "建议启用"
      : "按预检判断";
  const canRetry = Boolean(failure.canRetryPages && pages.length);
  const canStart = Boolean(canRetry && startReady && onStartPage && !preflightBusy);
  const canReset = Boolean(canRetry && onResetPages && !resetBusy && !preflightBusy);
  function confirmStart() {
    if (!canStart) return;
    const confirmed = window.confirm(
      imageProviderOverloaded
        ? `将稍后重跑 ${pageText}。上次失败原因是图片 API 服务过载，不是 OCR 或成功页问题。\n\n此操作会重新调用 gpt-image-2 生成该页图片资产并重建可编辑 PPT，可能消耗额度；已成功页面不会被覆盖。是否继续？`
        : `将重跑 ${pageText} 的可编辑页面重建。此操作会调用外部模型/图片服务，可能消耗额度。已成功页面不会被覆盖。是否继续？`
    );
    if (confirmed) onStartPage?.();
  }
  return (
    <div className="workflow-editable-failure-card">
      <div className="workflow-editable-failure-head">
        <div>
          <b>最近失败恢复</b>
          <span>{failure.title || "页面重建失败"}</span>
        </div>
        <strong>{run?.status ? uiZh(run.status) : "失败"}</strong>
      </div>
      <div className="workflow-editable-failure-grid">
        <WorkflowArtifact label="影响页面" value={pageText} />
        <WorkflowArtifact label="失败类型" value={failure.kind || "worker-command-failed"} />
        <WorkflowArtifact label="运行记录" value={run?.id || "-"} />
        <WorkflowArtifact label="成功页保护" value={recoveryPlan.preserveSuccessfulPages ? "只重跑失败页" : "待确认"} />
        <WorkflowArtifact label="低复杂度模式" value={complexityLabel} />
        <WorkflowArtifact label="重跑后合成" value={recoveryPlan.autoFinalize ? "自动尝试" : "手动合成 final"} />
      </div>
      <p>{uiZh(failure.reason || "可编辑页面重建没有完成。")}</p>
      <small>{uiZh(failure.recommendedAction || "先查看日志，再只重跑受影响页面。")}</small>
      {recoverySteps.length ? (
        <div className="workflow-editable-failure-flow">
          {recoverySteps.map((step, index) => (
            <span key={step.id || step.label || index}>
              {index + 1}. {uiZh(step.label || step.id)}
              {step.detail ? <small>{uiZh(step.detail)}</small> : null}
            </span>
          ))}
        </div>
      ) : (
        <div className="workflow-editable-failure-flow">
          <span>1. 重置失败页</span>
          <span>2. 重跑前预检</span>
          <span>3. 只重跑影响页</span>
          <span>4. 重新合成 final</span>
        </div>
      )}
      <div className="workflow-editable-failure-actions">
        {pages.slice(0, 4).map((pageId) => (
          <button type="button" key={pageId} onClick={() => onSelectPage?.(pageId)}>
            定位 {pageId}
          </button>
        ))}
        <button type="button" onClick={onOpenLog} disabled={!run?.logHref}>打开日志</button>
        <button type="button" onClick={onResetPages} disabled={!canReset}>
          {resetBusy ? "重置中..." : "重置失败页"}
        </button>
        <button type="button" onClick={onPreflight} disabled={!canRetry || preflightBusy}>
          {preflightBusy ? "预检中..." : "先做重跑预检"}
        </button>
        <button type="button" onClick={confirmStart} disabled={!canStart}>
          {startReady ? (failure.retryLabel || "确认并重跑") : "预检通过后重跑"}
        </button>
      </div>
      {!startReady ? <em>重跑按钮需要先对这些失败页面完成预检，避免误用其他页的预检结果。</em> : null}
    </div>
  );
}

function WorkflowEditablePreparePreflightPanel({ bundle = null, busy = false, message = "", onPrepare, onRefresh }) {
  const state = bundle?.ready || bundle?.startReady ? "ready" : bundle ? "blocked" : "pending";
  const checks = Array.isArray(bundle?.checks) ? bundle.checks : [];
  const blockingIssues = Array.isArray(bundle?.blockingIssues) ? bundle.blockingIssues : [];
  const warnings = Array.isArray(bundle?.warnings) ? bundle.warnings : [];
  const qualitySummary = bundle?.visualQuality?.summary || {};
  return (
    <section className={`workflow-editable-prepare-preflight ${state}`}>
      <div className="workflow-editable-prepare-head">
        <div>
          <b>image-to-editable-ppt 准备</b>
          <span>{bundle?.summary || "检查图片型 PPT 是否已经可以交给 editppt 重建。"}</span>
        </div>
        <strong>{state === "ready" ? "可准备 editppt" : state === "blocked" ? "准备条件未满足" : "等待预检"}</strong>
      </div>
      <div className="workflow-editable-prepare-grid">
        <WorkflowArtifact label="输入页数" value={bundle ? `${bundle.inputCount || 0} 页` : "待检查"} />
        <WorkflowArtifact label="图片型 PPT" value={bundle?.imageDeck?.path ? `${bundle.imageDeck.pageCount || 0} 页` : "未就绪"} />
        <WorkflowArtifact label="视觉复核" value={bundle?.visualQuality?.path ? `${qualitySummary.reviewCount || 0} 复核 / ${qualitySummary.failedCount || 0} 失败` : "未生成"} />
        <WorkflowArtifact label="运行环境" value={bundle?.runtime?.python || "待检查"} />
      </div>
      {checks.length ? (
        <div className="workflow-editable-prepare-checks">
          {checks.map((check) => (
            <span className={check.ok ? "ok" : "fail"} key={check.id || check.label}>
              {uiZh(check.label || check.id || "检查项")}：{check.ok ? "通过" : "失败"}
            </span>
          ))}
        </div>
      ) : null}
      {blockingIssues.length ? (
        <div className="workflow-editable-prepare-list blocked">
          <b>阻断项</b>
          {blockingIssues.slice(0, 4).map((item, index) => <span key={`${index}-${item}`}>{uiZh(item)}</span>)}
        </div>
      ) : warnings.length ? (
        <div className="workflow-editable-prepare-list warning">
          <b>注意项</b>
          {warnings.slice(0, 4).map((item, index) => <span key={`${index}-${item}`}>{uiZh(item)}</span>)}
        </div>
      ) : null}
      <div className="workflow-editable-prepare-actions">
        <button type="button" onClick={onRefresh} disabled={busy}>刷新预检</button>
        <button type="button" onClick={onPrepare} disabled={busy || !bundle?.startReady}>准备 editppt</button>
        {message ? <span>{uiZh(message)}</span> : <span>此步骤不消耗外部图片 API，只准备可编辑重建运行目录。</span>}
      </div>
    </section>
  );
}

function WorkflowEventLogPanel({ bundle = null, job = null }) {
  const events = Array.isArray(bundle?.events)
    ? bundle.events
    : Array.isArray(job?.events)
      ? job.events.slice(-80)
      : [];
  const latest = events.at(-1);
  return (
    <div className="workflow-event-log-panel">
      <div className="workflow-event-log-head">
        <div>
          <b>工作流事件日志</b>
          <span>最近的状态变化、失败、重试、确认和产物更新。</span>
        </div>
        <small>共 {bundle?.total ?? events.length} 条</small>
      </div>
      {events.length ? (
        <div className="workflow-event-list">
          {events.slice(-12).reverse().map((event, index) => (
            <div className={eventLevel(event)} key={event.id || `${event.type}-${index}`}>
              <span>{formatEventTime(event.createdAt)}</span>
              <b>{event.type || "workflow.event"}</b>
              <small>{uiZh(event.message || "-")}</small>
            </div>
          ))}
        </div>
      ) : (
        <p className="workflow-event-empty">还没有工作流事件。</p>
      )}
      {latest ? <p className="workflow-event-latest">最新：{latest.type || "事件"} / {formatEventTime(latest.createdAt)}</p> : null}
    </div>
  );
}

function eventLevel(event = {}) {
  const text = `${event.type || ""} ${event.message || ""}`.toLowerCase();
  if (/fail|error|blocked/.test(text)) return "blocked";
  if (/reset|retry|warning|warn/.test(text)) return "warning";
  if (/complete|ready|recorded|approved|finalized/.test(text)) return "ready";
  return "pending";
}

function formatEventTime(value = "") {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 19);
  return date.toLocaleTimeString();
}

function formatUsd(value = 0) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return "$0.00";
  return `$${number.toFixed(number < 1 ? 4 : 2)}`;
}
function WorkflowUnifiedSkillTaskBoard({ codexSlideTasks = [], codexSummary = null, editablePromptCount = 0, editableSummary = null, editableTasks = [], finalPath = "", nextStage = "", onFocusTask, onRetryFailedTasks, onRetryTask, retryBusyKey = "" }) {
  const codex = buildUnifiedTaskLane({
    id: "codex-ppt",
    title: "视觉统一图片页",
    summary: codexSummary,
    tasks: codexSlideTasks,
    empty: "样张和全量确认后，同步 codex 图片页任务。",
    next: codexSlideTasks.length
      ? "派发真实图片页任务，然后记录生成图片路径。"
      : "先确认样张和全量生成，再同步图片页任务。"
  });
  const editable = buildUnifiedTaskLane({
    id: "image-to-editable-ppt",
    title: "image-to-editable-ppt 可编辑页",
    summary: editableSummary,
    tasks: editableTasks,
    empty: editablePromptCount ? "页面提示已存在，请同步可编辑页任务。" : "请先准备 editppt 并生成页面提示。",
    next: finalPath
      ? "最终可编辑 PPTX 已组装。"
      : nextStage === "finalize"
        ? "所有页面记录后运行 editppt finalize。"
        : nextStage === "rebuild_page_locally"
          ? "运行 image-to-editable-ppt 受限单页重建路径。"
          : "派发页面任务，并记录通过校验的页面结果。"
  });
  const total = codex.total + editable.total;
  const recorded = codex.recorded + editable.recorded;
  const running = codex.running + editable.running;
  const failed = codex.failed + editable.failed;
  const boardLevel = failed ? "blocked" : total && recorded >= total ? "ready" : running ? "running" : "pending";
  const lanes = [codex, editable];
  const [selectedTaskKey, setSelectedTaskKey] = useState("");
  const selectedTask = findUnifiedTask(lanes, selectedTaskKey) || findFirstUnifiedTask(lanes);
  const failedTasks = collectFailedUnifiedTasks(lanes);
  return (
    <div className={`workflow-unified-board ${boardLevel}`}>
      <div className="workflow-unified-head">
        <div>
          <b>统一 Skill 任务板</b>
          <span>集中查看视觉统一图片页任务和可编辑重建页面任务。</span>
        </div>
        <small>{recorded}/{total || 0} 已记录</small>
      </div>
      <div className="workflow-unified-metrics">
        <WorkflowArtifact label="任务总数" value={total || 0} />
        <WorkflowArtifact label="运行中" value={running || 0} />
        <WorkflowArtifact label="已记录" value={recorded || 0} />
        <WorkflowArtifact label="失败" value={failed || 0} />
      </div>
      <WorkflowFailedTaskRecoveryPanel
        failedTasks={failedTasks}
        onFocusTask={onFocusTask}
        onRetryFailedTasks={onRetryFailedTasks}
        onRetryTask={onRetryTask}
        retryBusyKey={retryBusyKey}
        onSelectTask={setSelectedTaskKey}
      />
      <div className="workflow-unified-lanes">
        {lanes.map((lane) => (
          <WorkflowUnifiedTaskLane
            key={lane.id}
            lane={lane}
            onSelectTask={setSelectedTaskKey}
            selectedTaskKey={selectedTask?.key || selectedTaskKey}
          />
        ))}
      </div>
      <WorkflowUnifiedTaskDetail detail={selectedTask} onFocusTask={onFocusTask} onRetryTask={onRetryTask} retryBusyKey={retryBusyKey} />
    </div>
  );
}

function WorkflowFailedTaskRecoveryPanel({ failedTasks = [], onFocusTask, onRetryFailedTasks, onRetryTask, retryBusyKey = "", onSelectTask }) {
  if (!failedTasks.length) return null;
  const bulkBusy = retryBusyKey === "bulk-failed";
  return (
    <div className="workflow-failed-recovery">
      <div className="workflow-failed-recovery-head">
        <div>
          <b>失败页面恢复</b>
          <span>失败的视觉统一和可编辑重建页面任务会集中在这里重试。</span>
        </div>
        <div className="workflow-failed-recovery-actions">
          <small>{failedTasks.length} 个失败</small>
          <button type="button" onClick={() => onRetryFailedTasks?.()} disabled={bulkBusy}>
            {bulkBusy ? "正在重试全部..." : "重试全部失败项"}
          </button>
        </div>
      </div>
      <div className="workflow-failed-recovery-list">
        {failedTasks.map((task) => (
          <div className="workflow-failed-recovery-row" key={task.key}>
            <div>
              <b>{task.taskId}</b>
              <span>{task.skillTitle}</span>
              <small>{shortPath(task.primaryPath) || task.agentId || task.nextAction}</small>
            </div>
            <button type="button" onClick={() => { onSelectTask?.(task.key); onFocusTask?.(task); }}>定位</button>
            <button type="button" onClick={() => onRetryTask?.(task)} disabled={retryBusyKey === task.key}>
              {retryBusyKey === task.key ? "正在重试..." : "重试"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function WorkflowUnifiedTaskLane({ lane, onSelectTask, selectedTaskKey }) {
  return (
    <div className={`workflow-unified-lane ${lane.level}`} data-skill={lane.id}>
      <div>
        <b>{lane.title}</b>
        <span>{lane.next}</span>
      </div>
      <div className="workflow-unified-lane-stats">
        <span>{lane.ready} 就绪</span>
        <span>{lane.running} 运行中</span>
        <span>{lane.recorded} 已记录</span>
        <span>{lane.failed} 失败</span>
      </div>
      <div className="workflow-unified-task-list">
        {lane.tasks.length ? lane.tasks.slice(0, 8).map((task) => {
          const key = unifiedTaskKey(lane.id, task);
          return (
          <button className={`${task.status || "ready"} ${key === selectedTaskKey ? "active" : ""}`} key={key} type="button" onClick={() => onSelectTask?.(key)}>
            <b>{unifiedTaskLabel(task)}</b>
            <em>{task.statusLabel || workerTaskStatusLabel(task.status || "ready")}</em>
          </button>
        );
        }) : <p>{lane.empty}</p>}
      </div>
    </div>
  );
}

function WorkflowUnifiedTaskDetail({ detail, onFocusTask, onRetryTask, retryBusyKey = "" }) {
  if (!detail) {
    return (
      <div className="workflow-unified-detail empty">
        <b>Skill 任务详情</b>
        <span>还没有选择页面任务。</span>
      </div>
    );
  }
  return (
    <div className={`workflow-unified-detail ${detail.level || "pending"}`}>
      <div className="workflow-unified-detail-head">
        <div>
          <b>Skill 任务详情</b>
          <span>{detail.skillTitle} / {detail.taskId}</span>
        </div>
        <small>{detail.statusLabel || workerTaskStatusLabel(detail.status || "ready")}</small>
      </div>
      <div className="workflow-unified-detail-grid">
        <WorkflowArtifact label="归属" value={detail.agentId || "未分配"} />
        <WorkflowArtifact label="提示/结果路径" value={shortPath(detail.primaryPath) || "待处理"} />
        <WorkflowArtifact label="边界" value={detail.boundary} />
        <WorkflowArtifact label="校验状态" value={detail.validationLabel || "待校验"} />
        <WorkflowArtifact label="下一步" value={detail.nextAction} />
      </div>
      <div className="workflow-unified-detail-actions">
        <button type="button" onClick={() => onFocusTask?.(detail)}>定位详情面板</button>
        <button type="button" onClick={() => onRetryTask?.(detail)} disabled={detail.status === "recorded" || retryBusyKey === detail.key}>
          {retryBusyKey === detail.key ? "正在重试..." : "重试页面"}
        </button>
      </div>
    </div>
  );
}

function buildUnifiedTaskLane({ id, title, summary = null, tasks = [], empty = "", next = "" }) {
  const normalizedTasks = Array.isArray(tasks) ? tasks : [];
  const ready = Number(summary?.ready ?? normalizedTasks.filter((task) => task.status === "ready").length);
  const running = Number(summary?.running ?? normalizedTasks.filter((task) => task.status === "claimed" || task.status === "running" || task.status === "dispatched").length);
  const recorded = Number(summary?.recorded ?? normalizedTasks.filter((task) => task.status === "recorded").length);
  const failed = Number(summary?.failed ?? normalizedTasks.filter((task) => task.status === "failed").length);
  const total = Number(summary?.total ?? normalizedTasks.length);
  const level = failed ? "blocked" : total && recorded >= total ? "ready" : running ? "running" : "pending";
  return { id, title, tasks: normalizedTasks, empty, next, ready, running, recorded, failed, total, level };
}

function findUnifiedTask(lanes = [], key = "") {
  if (!key) return null;
  for (const lane of lanes) {
    const task = lane.tasks.find((item) => unifiedTaskKey(lane.id, item) === key);
    if (task) return buildUnifiedTaskDetail(lane, task);
  }
  return null;
}

function findFirstUnifiedTask(lanes = []) {
  for (const lane of lanes) {
    if (lane.tasks.length) return buildUnifiedTaskDetail(lane, lane.tasks[0]);
  }
  return null;
}

function collectFailedUnifiedTasks(lanes = []) {
  return lanes.flatMap((lane) => (lane.tasks || [])
    .filter((task) => (task.status || "ready") === "failed")
    .map((task) => buildUnifiedTaskDetail(lane, task)));
}

function buildUnifiedTaskDetail(lane, task) {
  const status = task.status || "ready";
  const isCodex = lane.id === "codex-ppt";
  const taskId = unifiedTaskLabel(task);
  const primaryPath = isCodex
    ? task.imagePath || task.promptFile || task.relativePath || ""
    : task.pageResult || task.promptFile || task.relativePath || task.pageDir || "";
  const nextAction = isCodex
    ? status === "recorded"
      ? "所有图片页记录后组装图片型 PPT。"
      : status === "running" || status === "claimed"
        ? "从图片页任务记录生成图片路径。"
        : status === "failed"
          ? "修复图片页任务阻断后重置。"
          : "启动真实图片页任务，然后认领任务。"
    : status === "recorded"
      ? "所有页面 manifest 记录后，生成最终可编辑 PPTX。"
      : status === "running" || status === "claimed"
        ? "页面产物通过 editppt 校验后再记录。"
        : status === "failed"
          ? "检查校验输出，带智能体证据重置后重新派发。"
          : "使用生成的页面提示派发真实页面任务。";
  return {
    key: unifiedTaskKey(lane.id, task),
    skillId: lane.id,
    skillTitle: lane.title,
    taskId,
    status,
    statusLabel: task.statusLabel || workerTaskStatusLabel(status),
    validationStatus: task.validationStatus || "",
    validationLabel: task.validationStatus === "passed" ? "校验通过" : task.validationStatus === "failed" ? "校验失败" : task.generated ? "已生成待校验" : "待生成",
    level: status === "failed" ? "blocked" : status === "recorded" ? "ready" : status === "running" || status === "claimed" ? "running" : "pending",
    agentId: task.agentId || "",
    primaryPath,
    boundary: isCodex ? "仅处理图片页" : "可编辑页面产物",
    nextAction
  };
}

function unifiedTaskKey(laneId, task = {}) {
  return `${laneId}:${task.pageId || task.slideId || task.pageNumber || "task"}`;
}

function unifiedTaskLabel(task = {}) {
  return task.pageId || task.slideId || (task.pageNumber ? `page_${String(task.pageNumber).padStart(3, "0")}` : "task");
}

function WorkflowCodexSlideBatchPreflightPanel({ bundle = null, confirmImageSpend = false, onSetConfirmImageSpend }) {
  if (!bundle) return null;
  const state = bundle.startReady ? "ready" : bundle.ready ? "warning" : "blocked";
  const external = bundle.requiredConfirmations?.externalImageSpend || {};
  const backendRuntime = bundle.backendRuntime || {};
  const backendCurrent = Boolean(backendRuntime.backendMatchesRuntime && !backendRuntime.approvedBackendLooksDryRun);
  const issues = bundle.blockingIssues?.length ? bundle.blockingIssues : bundle.warnings || [];
  return (
    <div className={`workflow-worker-preflight codex-slide-batch-preflight ${state}`}>
      <div className="workflow-worker-preflight-head">
        <div>
          <b>{bundle.startReady ? "Codex 图片页批处理就绪" : bundle.ready ? "需要确认图片 API 用量" : "Codex 图片页批处理被阻断"}</b>
          <span>{bundle.selectedCount || 0} 个已选图片页任务 / {bundle.mode || "product"} 模式</span>
        </div>
        <strong>{bundle.startReady ? "就绪" : bundle.ready ? "需确认" : "阻断"}</strong>
      </div>
      <div className="workflow-worker-preflight-grid">
        <WorkflowArtifact label="已选择" value={`${bundle.selectedCount || 0}/${bundle.counts?.total || 0}`} />
        <WorkflowArtifact label="就绪" value={bundle.counts?.ready || 0} />
        <WorkflowArtifact label="服务商" value={bundle.provider?.model || "未配置"} />
        <WorkflowArtifact label="图片调用" value={bundle.cost?.imageCalls || 0} />
        <WorkflowArtifact label="后端确认" value={backendCurrent ? "当前一致" : "需刷新"} />
      </div>
      <div className="workflow-worker-preflight-checks">
        <span className={external.required && !external.confirmed ? "warn" : "ok"}>外部额度 {external.required ? (external.confirmed ? "已确认" : "必需") : "不需要"}</span>
        <span className={bundle.approvals?.ready ? "ok" : "warn"}>审批关卡 {bundle.approvals?.ready ? "就绪" : `${bundle.approvals?.approved?.length || 0}/${bundle.approvals?.required?.length || 5}`}</span>
        <span className={backendCurrent ? "ok" : "warn"}>后端确认 {backendCurrent ? "当前一致" : "需要刷新"}</span>
      </div>
      <label className="workflow-confirm workflow-preflight-confirm">
        <input type="checkbox" checked={confirmImageSpend} onChange={(event) => onSetConfirmImageSpend?.(event.target.checked)} />
        <span>确认视觉图片生成会使用外部图片 API</span>
      </label>
      {issues.length ? <p>{uiZh(issues.slice(0, 2).join(" "))}</p> : <p>预检确认视觉图片任务已满足受控批处理启动条件。</p>}
    </div>
  );
}

function WorkflowCodexSlideTaskPanel({ batchPreflight = null, bundle, confirmImageSpend = false, error, focusTask = null, jobId, loading, onBatchPreflightChange, onBundleChange, onRefresh, onRefreshJob, onRunBatch, onSetConfirmImageSpend, onSync, tasks = [] }) {
  const [selectedPageId, setSelectedPageId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [workerName, setWorkerName] = useState("");
  const [confirmSpawned, setConfirmSpawned] = useState(false);
  const [imagePath, setImagePath] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [qaNote, setQaNote] = useState("");
  const [actionBusy, setActionBusy] = useState("");
  const [actionError, setActionError] = useState("");
  const [actionNotice, setActionNotice] = useState("");
  const summary = bundle?.summary || {
    total: tasks.length,
    ready: tasks.filter((task) => task.status === "ready").length,
    running: tasks.filter((task) => task.status === "claimed" || task.status === "running").length,
    recorded: tasks.filter((task) => task.status === "recorded").length,
    failed: tasks.filter((task) => task.status === "failed").length
  };
  const selectedTask = tasks.find((task) => task.pageId === selectedPageId) || tasks[0] || null;
  const resolvedPageId = selectedTask?.pageId || selectedPageId;
  const prompts = Array.isArray(bundle?.prompts) ? bundle.prompts : [];
  const selectedPrompt = prompts.find((prompt) => prompt.pageId === resolvedPageId) || null;
  const selectedSlideStatus = selectedTask?.status || (selectedTask ? "ready" : "pending");
  const selectedSlidePath = shortPath(selectedTask?.imagePath || selectedTask?.relativePath || selectedPrompt?.path || selectedTask?.promptFile);
  const selectedSlideNext = getCodexSlideWorkerNextAction({ selectedTask, hasImagePath: Boolean(imagePath.trim()) });

  useEffect(() => {
    if (!selectedPageId && tasks.length) setSelectedPageId(tasks[0].pageId);
  }, [tasks, selectedPageId]);

  useEffect(() => {
    if (focusTask?.taskId) setSelectedPageId(focusTask.taskId);
  }, [focusTask?.taskId]);

  async function runCodexSlideAction(action) {
    if (!jobId || !resolvedPageId) {
      setActionError("请先选择一个视觉统一图片页任务。");
      return;
    }
    const trimmedAgentId = agentId.trim();
    if (!trimmedAgentId) {
      setActionError("必须填写智能体 ID。");
      return;
    }
    if (action === "claim" && !confirmSpawned) {
      setActionError("记录派发前，请确认真实图片页任务已启动。");
      return;
    }
    if (action === "complete" && !imagePath.trim()) {
      setActionError("必须填写结果图片路径。");
      return;
    }
    setActionBusy(action);
    setActionError("");
    setActionNotice("");
    try {
      const body = action === "claim"
        ? {
          agentId: trimmedAgentId,
          workerName: workerName.trim(),
          confirmSpawned: true,
          spawned: true,
          message: "claimed from frontend codex slide task panel"
        }
        : action === "complete"
          ? {
            agentId: trimmedAgentId,
            workerName: workerName.trim(),
            imagePath: imagePath.trim(),
            provider: provider.trim(),
            model: model.trim(),
            qaNote: qaNote.trim(),
            source: "external-slide-worker"
          }
          : {
            agentId: selectedTask?.agentId || trimmedAgentId,
            reason: "manual retry from frontend codex slide task panel"
          };
      const nextBundle = await api.codexPptSlideTaskAction(jobId, resolvedPageId, action, body);
      onBundleChange?.(nextBundle);
      setActionNotice(action === "reset" ? "图片页任务已重置为就绪。" : action === "claim" ? "图片页任务已认领。" : "图片页结果已记录。");
      await onRefreshJob?.();
    } catch (actionError) {
      setActionError(getErrorMessage(actionError));
    } finally {
      setActionBusy("");
    }
  }

  async function resetNonProductSlideEvidence() {
    if (!jobId) return;
    setActionBusy("reset-non-product");
    setActionError("");
    setActionNotice("");
    try {
      const preview = await api.resetNonProductCodexPptSlides(jobId, {});
      const count = preview.candidateCount || 0;
      if (!count) {
        setActionNotice("没有可重置的验证链路/透传视觉图片页结果。");
        return;
      }
      const confirmed = window.confirm(`将 ${count} 个验证链路/透传视觉图片页结果重置为就绪，以便用当前图片运行环境重新生成。已有文件不会删除，是否继续？`);
      if (!confirmed) return;
      const result = await api.resetNonProductCodexPptSlides(jobId, {
        confirmNonProductReset: true,
        reason: "frontend reset dry-run codex-ppt slide evidence for product runtime rerun"
      });
      onBundleChange?.(result.taskBundle || result);
      if (result.postResetPreflight) onBatchPreflightChange?.(result.postResetPreflight);
      const post = result.postResetPreflight || {};
      const selected = post.selectedCount || result.reset || count;
      const confirmation = post.requiredConfirmations?.externalImageSpend?.required ? " 运行服务商批处理前，请确认外部图片 API 用量。" : "";
      setActionNotice(`已重置 ${result.reset || count} 个验证结果。${selected} 个图片页任务已可用产品运行环境重跑。${confirmation}`);
      await onRefreshJob?.();
    } catch (resetError) {
      setActionError(getErrorMessage(resetError));
    } finally {
      setActionBusy("");
    }
  }

  return (
    <div className="workflow-worker-console codex-slide-worker-console" id="codex-slide-worker-panel">
      <div className="workflow-worker-console-head">
        <div>
          <b>Codex 图片页任务</b>
          <span>codex-ppt 全量图片任务，会在样张/全量确认后派发给真实图片页任务。</span>
        </div>
        <small>{loading ? "加载中" : `${summary.recorded || 0}/${summary.total || 0} 已记录`}</small>
      </div>
      <div className={`workflow-worker-current-task ${selectedSlideStatus}`}>
        <div>
          <span>已选图片页</span>
          <b>{resolvedPageId || "未选择图片页"}</b>
          <small>视觉统一图片页</small>
        </div>
        <div>
          <span>状态</span>
          <b>{workerTaskStatusLabel(selectedSlideStatus)}</b>
          <small>{selectedSlideNext}</small>
        </div>
        <div>
          <span>提示/结果</span>
          <b>{selectedSlidePath || "待处理"}</b>
          <small>{selectedTask?.agentId || agentId || "未分配"}</small>
        </div>
      </div>
      {error || actionError ? <p className="workflow-error">{error || actionError}</p> : null}
      {actionNotice ? <p className="workflow-notice">{actionNotice}</p> : null}
      <div className="workflow-task-summary">
        <WorkflowArtifact label="总数" value={summary.total || 0} />
        <WorkflowArtifact label="就绪" value={summary.ready || 0} />
        <WorkflowArtifact label="运行中" value={summary.running || 0} />
        <WorkflowArtifact label="已记录" value={summary.recorded || 0} />
        <WorkflowArtifact label="失败" value={summary.failed || 0} />
      </div>
      <WorkflowCodexSlideBatchPreflightPanel
        bundle={batchPreflight}
        confirmImageSpend={confirmImageSpend}
        onSetConfirmImageSpend={onSetConfirmImageSpend}
      />
      <div className="workflow-worker-controls codex-slide-controls">
        <label>
          <span>图片页</span>
          <select value={resolvedPageId || ""} onChange={(event) => setSelectedPageId(event.target.value)} disabled={!tasks.length}>
            {tasks.length ? tasks.map((task) => <option value={task.pageId} key={task.pageId}>{task.pageId}</option>) : <option value="">无任务</option>}
          </select>
        </label>
        <label>
          <span>智能体 ID</span>
          <input value={agentId} onChange={(event) => setAgentId(event.target.value)} placeholder="真实图片页任务的智能体 ID" />
        </label>
        <label>
          <span>任务名称</span>
          <input value={workerName} onChange={(event) => setWorkerName(event.target.value)} placeholder="可选" />
        </label>
        <label className="workflow-confirm">
          <input type="checkbox" checked={confirmSpawned} onChange={(event) => setConfirmSpawned(event.target.checked)} />
          <span>真实图片页任务已启动</span>
        </label>
      </div>
      <div className="codex-slide-result-grid">
        <label>
          <span>结果图片路径</span>
          <input value={imagePath} onChange={(event) => setImagePath(event.target.value)} placeholder="图片页任务返回的绝对路径" />
        </label>
        <label>
          <span>服务商</span>
          <input value={provider} onChange={(event) => setProvider(event.target.value)} placeholder="已确认的图片后端" />
        </label>
        <label>
          <span>模型</span>
          <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="图片模型" />
        </label>
        <label>
          <span>QA 备注</span>
          <input value={qaNote} onChange={(event) => setQaNote(event.target.value)} placeholder="简短视觉 QA 备注" />
        </label>
      </div>
      <div className="workflow-worker-primary-actions">
        <button type="button" onClick={() => runCodexSlideAction("claim")} disabled={loading || actionBusy || !selectedTask || selectedTask.status === "recorded"}>{actionBusy === "claim" ? "正在认领..." : "1. 认领真实图片页任务"}</button>
        <button type="button" onClick={() => runCodexSlideAction("complete")} disabled={loading || actionBusy || !selectedTask || selectedTask.status === "recorded"}>{actionBusy === "complete" ? "正在记录..." : "2. 记录图片页结果"}</button>
        <button type="button" onClick={() => runCodexSlideAction("reset")} disabled={loading || actionBusy || !selectedTask || selectedTask.status === "recorded"}>{actionBusy === "reset" ? "正在重置..." : "重置"}</button>
      </div>
      <div className="workflow-worker-secondary-actions">
        <button type="button" onClick={onSync} disabled={loading}>同步任务</button>
        <button type="button" onClick={onRunBatch} disabled={loading || !tasks.length || summary.recorded >= summary.total || !batchPreflight?.startReady}>运行服务商批处理</button>
        <button type="button" onClick={resetNonProductSlideEvidence} disabled={loading || actionBusy || !tasks.length}>{actionBusy === "reset-non-product" ? "正在预览..." : "重置验证结果"}</button>
        <button type="button" onClick={onRefresh} disabled={loading}>刷新任务</button>
      </div>
      {selectedTask ? (
        <div className="workflow-handoff-card codex-slide-handoff-card">
          <div>
            <b>视觉统一图片页已准备</b>
            <span>{resolvedPageId || "图片页"} / 优先使用服务商批处理，不需要手动复制命令</span>
          </div>
          <code>{selectedPrompt?.path || selectedTask?.promptFile || ""}</code>
        </div>
      ) : null}
      <div className="workflow-task-list">
        {tasks.length ? tasks.map((task) => (
          <button className={`workflow-task-row ${task.status} ${task.pageId === resolvedPageId ? "active" : ""}`} key={task.pageId} type="button" onClick={() => setSelectedPageId(task.pageId)}>
            <b>{task.pageId}</b>
            <span>{workerTaskStatusLabel(task.status)}</span>
            <small>{task.agentId || task.imagePath || task.relativePath || task.promptFile || "等待图片页任务"}</small>
          </button>
        )) : <p>还没有视觉统一图片页任务。全量确认后同步，会创建提示任务和运行状态。</p>}
      </div>
    </div>
  );
}

function WorkflowTextHintEvidencePanel({ artifacts = {}, artifactBundle = null, job = null, onRefresh }) {
  const links = artifactBundle?.links || [];
  const ocrSummary = artifacts.ocrTextHints || {};
  const editableSummary = artifacts.editableHints?.summary || {};
  const ocrLinks = links.filter((link) => link.key === "ocr-text-hints" || link.key === "ocr-page");
  const editableHintLinks = links.filter((link) => link.key === "editable-text-hint");
  const ocrTextHintsLink = ocrLinks.find((link) => link.key === "ocr-text-hints") || null;
  const [ocrHints, setOcrHints] = useState({ loading: false, data: null, error: "" });
  const [correctionDrafts, setCorrectionDrafts] = useState({});
  const [correctionBusy, setCorrectionBusy] = useState("");
  const [correctionMessage, setCorrectionMessage] = useState("");
  const hasEvidence = Boolean(ocrSummary.path || editableSummary.pageCount || ocrLinks.length || editableHintLinks.length);
  useEffect(() => {
    if (!ocrTextHintsLink?.href) {
      setOcrHints({ loading: false, data: null, error: "" });
      setCorrectionDrafts({});
      return undefined;
    }
    const controller = new AbortController();
    setOcrHints({ loading: true, data: null, error: "" });
    fetch(ocrTextHintsLink.href, { cache: "no-store", signal: controller.signal })
      .then((response) => response.json().then((data) => {
        if (!response.ok) throw new Error(data.error || "OCR 文字提示读取失败");
        return data;
      }))
      .then((data) => {
        setOcrHints({ loading: false, data, error: "" });
        const drafts = {};
        getLowConfidenceOcrLines(data).forEach((item) => {
          drafts[`${item.pageId}:${item.line.id}`] = item.line.text || "";
        });
        setCorrectionDrafts(drafts);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setOcrHints({ loading: false, data: null, error: getErrorMessage(error) });
      });
    return () => controller.abort();
  }, [ocrTextHintsLink?.href]);
  const lowConfidenceLines = getLowConfidenceOcrLines(ocrHints.data).slice(0, 6);
  async function saveCorrection(item) {
    const key = `${item.pageId}:${item.line.id}`;
    const text = String(correctionDrafts[key] || "").trim();
    if (!job?.id || !text || correctionBusy) return;
    setCorrectionBusy(key);
    setCorrectionMessage("");
    try {
      await api.correctWorkflowOcrTextHint(job.id, {
        pageId: item.pageId,
        lineId: item.line.id,
        text,
        markRequired: true,
        correctedBy: "operator"
      });
      setCorrectionMessage("OCR 文本修正已保存，并同步到工作流文字提示证据。");
      await onRefresh?.();
    } catch (error) {
      setCorrectionMessage(getErrorMessage(error));
    } finally {
      setCorrectionBusy("");
    }
  }
  if (!hasEvidence) {
    return (
      <div className="workflow-text-hint-evidence pending">
        <div>
          <b>文字提示证据</b>
          <span>等待 OCR 或 editppt 文字提示生成；后续可用于检查可编辑重建的文字约束。</span>
        </div>
        <div className="workflow-text-hint-facts">
          <span>OCR<b>待处理</b></span>
          <span>文字提示<b>待处理</b></span>
          <span>低置信文字<b>待检测</b></span>
        </div>
      </div>
    );
  }
  return (
    <div className="workflow-text-hint-evidence ready">
      <div>
        <b>文字提示证据</b>
        <span>用于核对 OCR 覆盖、低置信文字和可编辑重建提示。</span>
      </div>
      <div className="workflow-text-hint-facts">
        <span>OCR 页数<b>{ocrSummary.pageCount ?? ocrLinks.filter((link) => link.key === "ocr-page").length}</b></span>
        <span>OCR 文字<b>{ocrSummary.textCount ?? 0}</b></span>
        <span>低置信文字<b>{ocrSummary.lowConfidenceCount ?? 0}</b></span>
        <span>文字提示<b>{editableSummary.readyPages ?? 0}/{editableSummary.pageCount ?? 0}</b></span>
        <span>提示文字行<b>{editableSummary.textLineCount ?? 0}</b></span>
      </div>
      {(ocrLinks.length || editableHintLinks.length) ? (
        <div className="workflow-text-hint-links">
          {[...ocrLinks, ...editableHintLinks].slice(0, 8).map((link) => (
            <a key={`${link.key}-${link.pageId || link.fileName}`} href={link.href} target="_blank" rel="noreferrer">
              <b>{link.label}</b>
              <span>{formatFileSize(link.size)} / {link.fileName}</span>
            </a>
          ))}
        </div>
      ) : null}
      <div className="workflow-ocr-corrections">
        <div>
          <b>低置信文字复核</b>
          <span>{ocrHints.loading ? "正在读取 OCR 文字..." : lowConfidenceLines.length ? "可直接修正低置信 OCR 文本。" : ocrHints.error || "暂无低置信 OCR 文本。"}</span>
        </div>
        {lowConfidenceLines.length ? lowConfidenceLines.map((item) => {
          const key = `${item.pageId}:${item.line.id}`;
          return (
            <label key={key}>
              <span>{item.pageId} / {item.line.id} / 置信度 {Math.round(Number(item.line.confidence || 0) * 100)}%</span>
              <input
                value={correctionDrafts[key] || ""}
                onChange={(event) => setCorrectionDrafts((current) => ({ ...current, [key]: event.target.value }))}
              />
              <button type="button" onClick={() => saveCorrection(item)} disabled={correctionBusy === key || !String(correctionDrafts[key] || "").trim()}>
                {correctionBusy === key ? "保存中..." : "保存修正"}
              </button>
            </label>
          );
        }) : null}
        {correctionMessage ? <small>{correctionMessage}</small> : null}
      </div>
    </div>
  );
}

function getLowConfidenceOcrLines(data = null) {
  return (Array.isArray(data?.pages) ? data.pages : []).flatMap((page) => {
    const pageId = page.pageId || "";
    return (Array.isArray(page.ocrLines) ? page.ocrLines : [])
      .filter((line) => line?.low_confidence && !line.corrected)
      .map((line) => ({ pageId, line }));
  });
}

function WorkflowArtifactReviewPanel({ artifactBundle, job, onRefresh }) {
  const links = artifactBundle?.links || [];
  const rows = useMemo(() => buildWorkflowReviewRows(links), [links]);
  const [selectedReviewPageId, setSelectedReviewPageId] = useState("");
  const selectedRow = rows.find((row) => row.pageId === selectedReviewPageId) || rows[0] || null;
  const [pageValidation, setPageValidation] = useState({ loading: false, data: null, error: "" });
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState("");
  const manualReview = job?.artifacts?.manualReview || null;
  const reviewApproved = manualReview?.status === "approved";
  useEffect(() => {
    if (rows.length && !rows.some((row) => row.pageId === selectedReviewPageId)) {
      setSelectedReviewPageId(rows[0].pageId);
    }
  }, [rows, selectedReviewPageId]);
  useEffect(() => {
    const href = selectedRow?.validation?.href || "";
    if (!href) {
      setPageValidation({ loading: false, data: null, error: "" });
      return undefined;
    }
    const controller = new AbortController();
    setPageValidation({ loading: true, data: null, error: "" });
    fetch(href, { cache: "no-store", signal: controller.signal })
      .then((response) => response.json().then((data) => {
        if (!response.ok) throw new Error(data.error || "页面校验读取失败");
        return data;
      }))
      .then((data) => setPageValidation({ loading: false, data, error: "" }))
      .catch((error) => {
        if (controller.signal.aborted) return;
        setPageValidation({ loading: false, data: null, error: getErrorMessage(error) });
      });
    return () => controller.abort();
  }, [selectedRow?.validation?.href]);
  if (!rows.length) return null;
  const readyRows = rows.filter((row) => row.visual).length;
  const rebuiltRows = rows.filter((row) => row.rebuild && row.validation).length;
  async function approveManualReview() {
    if (!job?.id || reviewBusy) return;
    setReviewBusy(true);
    setReviewError("");
    try {
      await api.approveWorkflowManualReview(job.id, {
        reviewer: "operator",
        note: `Reviewed ${rebuiltRows}/${rows.length} rebuilt page preview(s)`
      });
      await onRefresh?.();
    } catch (error) {
      setReviewError(getErrorMessage(error));
    } finally {
      setReviewBusy(false);
    }
  }
  async function resetManualReview() {
    if (!job?.id || reviewBusy) return;
    setReviewBusy(true);
    setReviewError("");
    try {
      await api.resetWorkflowManualReview(job.id, {
        reviewer: "operator",
        note: "Manual review reset from workflow review panel"
      });
      await onRefresh?.();
    } catch (error) {
      setReviewError(getErrorMessage(error));
    } finally {
      setReviewBusy(false);
    }
  }
  return (
    <div className="workflow-review-panel" id="workflow-artifact-review-panel">
      <div className="workflow-review-head">
        <div>
          <b>页面复核</b>
          <span>{readyRows}/{rows.length} 页已有视觉图片；{rebuiltRows}/{rows.length} 页已有重建预览和页面校验。</span>
        </div>
        <div className="workflow-review-actions">
          <span>{reviewApproved ? `已复核 ${manualReview.approvedAt || ""}` : "等待人工复核"}</span>
          <button type="button" onClick={approveManualReview} disabled={reviewBusy || !job?.artifacts?.editableFinal?.path || rebuiltRows < rows.length}>{reviewBusy ? "正在保存..." : "标记已复核"}</button>
          <button type="button" onClick={resetManualReview} disabled={reviewBusy || !reviewApproved}>重置</button>
        </div>
      </div>
      {reviewError ? <p className="workflow-error">{reviewError}</p> : null}
      <div className="workflow-review-preview">
        <WorkflowReviewPreviewCard title="源页面" pageId={selectedRow.pageId} link={selectedRow.source} />
        <WorkflowReviewPreviewCard title="codex-ppt 目标图" pageId={selectedRow.pageId} link={selectedRow.visual} emptyText="等待目标图" />
        <WorkflowReviewPreviewCard title="可编辑预览" pageId={selectedRow.pageId} link={selectedRow.rebuild} emptyText="等待可编辑重建" />
        <WorkflowReviewPreviewCard title="最终对比图" pageId={selectedRow.pageId} link={selectedRow.compare} emptyText="等待最终 QA" />
      </div>
      <WorkflowReviewValidation data={pageValidation.data} error={pageValidation.error} loading={pageValidation.loading} row={selectedRow} />
      <div className="workflow-review-list">
        {rows.map((row) => (
          <div className={`workflow-review-row ${row.rebuild && row.validation ? "ready" : "missing"} ${row.pageId === selectedRow.pageId ? "active" : ""}`} key={row.pageId} onClick={() => setSelectedReviewPageId(row.pageId)}>
            <b>{row.pageId}</b>
            {row.source ? <a href={row.source.href} target="_blank" rel="noreferrer">源页</a> : <span>无源页</span>}
            {row.visual ? <a href={row.visual.href} target="_blank" rel="noreferrer">目标图</a> : <span>等待目标图</span>}
            {row.rebuild ? <a href={row.rebuild.href} target="_blank" rel="noreferrer">预览</a> : <span>等待预览</span>}
            {row.compare ? <a href={row.compare.href} target="_blank" rel="noreferrer">对比</a> : <span>等待对比</span>}
            {row.validation ? <a href={row.validation.href} target="_blank" rel="noreferrer">校验</a> : <span>无校验</span>}
            {row.pptx ? <a href={row.pptx.href} target="_blank" rel="noreferrer">PPT</a> : <span>无 PPT</span>}
            <small>{row.rebuild && row.validation && row.compare ? "可复核最终结果" : row.rebuild && row.validation ? "可复核可编辑预览" : row.visual ? "可先对比目标图" : "尚未进入完整重建链路"}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

function WorkflowReviewValidation({ data, error, loading, row }) {
  const issueCount = data ? countWorkflowPageValidationIssues(data) : 0;
  const passed = data?.passed === true && issueCount === 0;
  const statusText = loading ? "正在读取页面校验..." : error ? "校验读取失败" : data ? (passed ? "页面校验通过" : "页面校验有问题") : "无页面校验";
  return (
    <div className={`workflow-review-validation ${passed ? "passed" : data || error ? "warn" : "empty"}`}>
      <div>
        <b>{row?.pageId || "page"} / {statusText}</b>
        <span>{data ? `${data.editable_text_shapes ?? 0} 段文字 / ${data.images ?? 0} 张图片 / ${data.shape_count ?? 0} 个图形` : row?.validation ? "校验待读取" : "校验未记录"}</span>
      </div>
      {error ? <small>{error}</small> : null}
      {data && issueCount ? <small>{summarizeWorkflowPageValidationIssues(data)}</small> : null}
      {data?.page_contract_violations?.length ? <small>{data.page_contract_violations.slice(0, 2).join(" / ")}</small> : null}
    </div>
  );
}

function WorkflowReviewPreviewCard({ emptyText = "缺少产物", link, pageId, title }) {
  return (
    <div className={`workflow-review-preview-card ${link ? "ready" : "empty"}`}>
      <div>
        <b>{title}</b>
        <span>{pageId}</span>
      </div>
      {link ? (
        <a href={link.href} target="_blank" rel="noreferrer">
          <img src={link.href} alt={`${pageId} ${title}`} />
        </a>
      ) : (
        <span className="workflow-review-empty">{emptyText}</span>
      )}
    </div>
  );
}

function WorkflowDeliveryPortal({ job = null, onCreateWorkflow, onGoMaterials, onOpenPageTasks, onOpenWorkflow }) {
  const [deliveryBundle, setDeliveryBundle] = useState(null);
  const [artifactBundle, setArtifactBundle] = useState(null);
  const [loading, setLoading] = useState(false);
  const [recoveryBusy, setRecoveryBusy] = useState("");
  const [recoveryMessage, setRecoveryMessage] = useState("");
  const [recoveryResult, setRecoveryResult] = useState(null);
  const [authorizationBusy, setAuthorizationBusy] = useState("");
  const [workerPreflightBusy, setWorkerPreflightBusy] = useState(false);
  const [workerPreflightBundle, setWorkerPreflightBundle] = useState(null);
  const [deliveryWorkerRunBundle, setDeliveryWorkerRunBundle] = useState(null);
  const [workerStartBusy, setWorkerStartBusy] = useState(false);
  const [deliveryLlmRecoveredConfirmed, setDeliveryLlmRecoveredConfirmed] = useState(false);
  const [deliveryWorkerBatchSize, setDeliveryWorkerBatchSize] = useState(2);
  const [error, setError] = useState("");
  const status = deliveryBundle?.status || deriveWorkflowDeliveryStatus(job, []);
  const deliveryWorkerPageIds = workflowWorkerPageIds(status);
  const deliveryWorkerBatchLimit = deliveryWorkerBatchSize === "all"
    ? deliveryWorkerPageIds.length
    : Math.max(1, Math.min(Number(deliveryWorkerBatchSize || 2), deliveryWorkerPageIds.length || 1));
  const deliverySelectedWorkerPageIds = deliveryWorkerPageIds.slice(0, deliveryWorkerBatchLimit);
  const deliverySelectedWorkerPageSelection = deliverySelectedWorkerPageIds.join(",");
  const deliveryWorkerRuns = Array.isArray(deliveryWorkerRunBundle?.runs) ? deliveryWorkerRunBundle.runs : [];
  const latestDeliveryRun = deliveryWorkerRuns[0] || null;
  const latestDeliveryFailedRun = deliveryWorkerRuns.find((run) => run.failureAnalysis) || null;
  const latestDeliveryFailure = latestDeliveryFailedRun?.failureAnalysis || null;
  const latestDeliveryFailurePages = Array.isArray(latestDeliveryFailure?.pages) ? latestDeliveryFailure.pages.filter(Boolean) : [];
  const latestDeliveryFailurePageSelection = latestDeliveryFailurePages.join(",");
  const deliveryPreflightSelection = workflowPreflightPageSelection(workerPreflightBundle);
  const latestDeliveryFailurePreflightReady = Boolean(
    latestDeliveryFailurePageSelection
      && workerPreflightBundle?.startReady
      && workflowPageSelectionsMatch(deliveryPreflightSelection, latestDeliveryFailurePageSelection)
  );

  function toggleDeliveryLlmRecovered(confirmed) {
    setDeliveryLlmRecoveredConfirmed(Boolean(confirmed));
    setWorkerPreflightBundle(null);
    setRecoveryMessage(Boolean(confirmed)
      ? "已确认页面重建模型服务可用；请重新执行启动前预检。"
      : "已取消页面重建模型恢复确认。");
  }

  async function loadDelivery(id = job?.id, signal) {
    if (!id) return;
    setLoading(true);
    setError("");
    try {
      const [delivery, artifacts] = await Promise.all([
        api.workflowDeliveryStatus(id, signal),
        api.workflowArtifacts(id, signal)
      ]);
      setDeliveryBundle(delivery);
      setArtifactBundle(artifacts);
    } catch (loadError) {
      if (signal?.aborted) return;
      setError(getErrorMessage(loadError));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }

  async function loadDeliveryWorkerRuns(id = job?.id, signal) {
    if (!id) return null;
    try {
      const result = await api.workflowWorkerRuns(id, signal);
      setDeliveryWorkerRunBundle(result);
      return result;
    } catch (loadError) {
      if (!signal?.aborted) setDeliveryWorkerRunBundle(null);
      return null;
    }
  }

  useEffect(() => {
    if (!job?.id || latestDeliveryRun?.status !== "running") return undefined;
    const timer = window.setInterval(() => {
      loadDelivery(job.id);
      loadDeliveryWorkerRuns(job.id);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [job?.id, latestDeliveryRun?.id, latestDeliveryRun?.status]);

  async function retryStalePageEvidence() {
    if (!job?.id || recoveryBusy) return;
    setRecoveryBusy("stale-page-evidence");
    setRecoveryMessage("");
    setRecoveryResult(null);
    setError("");
    try {
      const result = await api.retryStaleWorkflowPageEvidence(job.id, {
        apply: true,
        reason: "frontend reset stale editable page evidence for product rerun"
      });
      setRecoveryResult(result);
      setRecoveryMessage(result.retried
        ? `已重置 ${result.retried} 页过期证据，请回到工作流启动页面任务重跑。`
        : "没有发现需要重置的过期页面证据。");
      setRecoveryMessage(result.recovery?.message || (result.retried
        ? `已重置 ${result.retried} 页过期证据。下一步请重跑这些可编辑页面任务；启动模型页面任务前仍需确认外部图片 API 额度。`
        : "没有发现需要重置的过期页面证据。"));
      await Promise.allSettled([loadDelivery(job.id), loadDeliveryWorkerRuns(job.id)]);
    } catch (recoveryError) {
      setError(getErrorMessage(recoveryError));
    } finally {
      setRecoveryBusy("");
    }
  }

  async function previewStalePageEvidence() {
    if (!job?.id || recoveryBusy) return;
    setRecoveryBusy("stale-page-evidence-preview");
    setRecoveryMessage("");
    setRecoveryResult(null);
    setError("");
    try {
      const result = await api.retryStaleWorkflowPageEvidence(job.id, {
        dryRun: true,
        reason: "frontend preview stale editable page evidence recovery"
      });
      setRecoveryResult(result);
      setRecoveryMessage(result.recovery?.message || (result.requested
        ? `检测到 ${result.requested} 页过期证据。此预览未重置任务，也不会调用外部图片 API。`
        : "没有发现需要重置的过期页面证据。"));
    } catch (recoveryError) {
      setError(getErrorMessage(recoveryError));
    } finally {
      setRecoveryBusy("");
    }
  }

  async function refreshEditableRunForStaleEvidence() {
    if (!job?.id || recoveryBusy) return;
    setRecoveryBusy("fresh-editable-run");
    setRecoveryMessage("");
    setError("");
    try {
      const result = await api.refreshWorkflowEditableRun(job.id, {
        force: true,
        maxConcurrentPages: 6,
        reason: "frontend fresh editable run recovery for accepted stale page evidence"
      });
      const tasks = result.tasks || {};
      setRecoveryMessage(`已重建可编辑运行目录、页面提示和任务队列。当前 ${tasks.summary?.ready || 0}/${tasks.summary?.total || 0} 页可重跑；启动页面任务前仍需确认外部图片 API 额度。`);
      setRecoveryResult((current) => current ? {
        ...current,
        freshEditableRun: {
          ...(current.freshEditableRun || current.recovery?.freshEditableRun || {}),
          refreshed: true,
          refreshedAt: new Date().toISOString(),
          taskSummary: tasks.summary || null
        }
      } : current);
      await Promise.allSettled([loadDelivery(job.id), loadDeliveryWorkerRuns(job.id)]);
    } catch (freshRunError) {
      setError(getErrorMessage(freshRunError));
    } finally {
      setRecoveryBusy("");
    }
  }

  async function previewFinalVisualQaRetry() {
    if (!job?.id || recoveryBusy) return;
    setRecoveryBusy("final-visual-qa-preview");
    setRecoveryMessage("");
    setRecoveryResult(null);
    setError("");
    try {
      const result = await api.finalVisualQaRetryPreflight(job.id, {});
      setRecoveryResult({ finalVisualQa: result });
      setRecoveryMessage(result.resettableCount
        ? `检测到 ${result.resettableCount} 个视觉 QA 失败页可以重置：${(result.resetPages || []).join(", ")}。预检不会修改任务，也不会调用外部 API。`
        : "没有发现可以重置的视觉 QA 失败页。");
    } catch (retryError) {
      setError(getErrorMessage(retryError));
    } finally {
      setRecoveryBusy("");
    }
  }

  async function retryFinalVisualQaPages() {
    if (!job?.id || recoveryBusy) return;
    setRecoveryBusy("final-visual-qa-retry");
    setRecoveryMessage("");
    setError("");
    try {
      const result = await api.retryFinalVisualQaPages(job.id, {
        apply: true,
        reason: "frontend reset final visual QA failed editable pages"
      });
      setRecoveryResult({ finalVisualQa: result });
      setRecoveryMessage(result.recovery?.message || `已重置 ${result.retried || 0} 个视觉 QA 失败页。下一步请启动这些 image-to-editable-ppt 页面 worker。`);
      await loadDelivery(job.id);
    } catch (retryError) {
      setError(getErrorMessage(retryError));
    } finally {
      setRecoveryBusy("");
    }
  }

  async function recomposeEditableFinal() {
    if (!job?.id || recoveryBusy) return;
    const gateChecks = deliveryBundle?.finalGate?.checks || {};
    const coverage = deliveryBundle?.coverage || {};
    const sourcePages = Number(gateChecks.sourcePages || coverage.sourcePages || job?.sourcePages || job?.sourceMeta?.pageCount || 0);
    const finalPages = Number(gateChecks.finalPages || coverage.finalPages || job?.finalPages || job?.artifacts?.editableFinal?.summary?.page_count || 0);
    const isPartial = Boolean(sourcePages && finalPages && finalPages < sourcePages);
    const confirmed = window.confirm(
      isPartial
        ? `将重新合成当前 ${finalPages}/${sourcePages} 页小样本 PPT。\n\n这一步只使用已经成功记录的可编辑页面，不会调用 gpt-image-2 或页面重建模型，也不会把它标记成完整产品交付。是否继续？`
        : "将基于当前已记录页面重新合成 editable-final.pptx。\n\n这一步不调用外部 API；最终下载仍然受页数、可编辑性、PowerPoint 打开性和人工复核门禁控制。是否继续？"
    );
    if (!confirmed) return;
    setRecoveryBusy("editable-finalize");
    setRecoveryMessage("");
    setError("");
    try {
      const result = await api.finalizeWorkflowEditableRun(job.id, {
        requestedBy: "frontend-delivery-portal",
        allowPartialSample: isPartial,
        reason: isPartial ? "recompose current partial sample final from delivery portal" : "recompose editable final from delivery portal"
      });
      const pages = result?.artifacts?.editableFinal?.summary?.page_count || result?.finalPages || finalPages || 0;
      setRecoveryMessage(isPartial
        ? `已重新合成当前 ${pages || finalPages} 页小样本 final。完整产品交付仍需覆盖全部 ${sourcePages} 页并完成复核。`
        : `已重新合成 editable-final.pptx，共 ${pages || "当前"} 页。请继续查看交付门禁和人工复核状态。`);
      await Promise.allSettled([loadDelivery(job.id), loadDeliveryWorkerRuns(job.id)]);
    } catch (finalizeError) {
      setError(getErrorMessage(finalizeError));
    } finally {
      setRecoveryBusy("");
    }
  }

  async function authorizeEditableWorkerSpend() {
    if (!job?.id || authorizationBusy) return;
    setAuthorizationBusy("editable-workers");
    setRecoveryMessage("");
    setError("");
    try {
      const nextAuthorization = status?.nextStep?.authorization || {};
      if (status?.nextStep?.id !== "start-page-workers" || !nextAuthorization.required || nextAuthorization.persisted) {
        setRecoveryMessage("当前不需要记录页面重建额度授权。");
        return;
      }
      const workerPageSelection = deliverySelectedWorkerPageSelection || workflowWorkerPageSelection(status);
      const preflightPageSelection = workflowPreflightPageSelection(workerPreflightBundle);
      const preflightMatchesSelection = workflowPageSelectionsMatch(preflightPageSelection, workerPageSelection);
      const preflight = workerPreflightBundle && preflightMatchesSelection ? workerPreflightBundle : await previewEditableWorkerStart();
      const external = preflight?.requiredConfirmations?.externalImageSpend || {};
      const selectedPageIds = Array.isArray(preflight?.selectedPageIds) ? preflight.selectedPageIds : [];
      if (!preflight?.ready || !external.required || external.confirmed || !selectedPageIds.length) {
        setRecoveryMessage("额度授权未记录：请先完成启动前预检，并确认有可重建页面需要外部图片额度。");
        return;
      }
      const readyPages = workflowFactNumber(status, "就绪重建页面");
      const imageCalls = Number(preflight?.authorization?.imageCalls || external.imageCalls || selectedPageIds.length || readyPages || 0);
      if (!Number.isFinite(imageCalls) || imageCalls <= 0) {
        setRecoveryMessage("额度授权未记录：预检没有返回有效的图片额度调用次数。");
        return;
      }
      const pageSelection = selectedPageIds.join(",");
      const confirmed = window.confirm(
        `将记录 ${imageCalls} 次 gpt-image-2 图片 API 额度授权。\n\n页面范围：${pageSelection || "未指定"}\n\n这一步只记录授权账本，不会立刻启动 worker；但后续点击“确认并启动重建”会真实调用外部模型/图片服务并可能消耗额度。是否继续？`
      );
      if (!confirmed) {
        setRecoveryMessage("已取消页面任务额度授权。");
        return;
      }
      await api.authorizeExternalImageSpend(job.id, {
        scope: "editable-workers",
        imageCalls,
        pageSelection,
        pageNumbers: pageNumbersFromWorkflowPageIds(selectedPageIds),
        targetPages: imageCalls,
        mode: "model",
        confirmedBy: "frontend-delivery-portal",
        reason: `交付中心确认 ${imageCalls} 次可编辑页面重建外部图片 API 用量${pageSelection ? `，页面：${pageSelection}` : ""}。`
      });
      setRecoveryMessage(`已记录 ${imageCalls} 次页面任务外部图片 API 授权${pageSelection ? `（${pageSelection}）` : ""}。下一步打开页面任务区，启动 image-to-editable-ppt 页面 worker。`);
      await Promise.allSettled([loadDelivery(job.id), loadDeliveryWorkerRuns(job.id), previewEditableWorkerStart()]);
    } catch (authorizationError) {
      setError(getErrorMessage(authorizationError));
    } finally {
      setAuthorizationBusy("");
    }
  }

  async function previewEditableWorkerStart() {
    if (!job?.id) return null;
    const workerPageSelection = deliverySelectedWorkerPageSelection || workflowWorkerPageSelection(status);
    const workerPageIds = deliverySelectedWorkerPageIds.length ? deliverySelectedWorkerPageIds : workflowWorkerPageIds(status);
    if (!workerPageSelection) {
      setRecoveryMessage("页面 worker 预检被阻断：后端没有返回明确的待重建页码，请先刷新交付状态或进入页面任务区选择页面。");
      return null;
    }
    setWorkerPreflightBusy(true);
    setError("");
    try {
      const result = await api.workflowWorkerBatchPreflight(job.id, {
        mode: "model",
        pages: workerPageSelection,
        maxPages: workerPageIds.length || 1,
        agentPrefix: "product-page-worker",
        confirmLlmProviderRecovered: deliveryLlmRecoveredConfirmed,
        acceptOfflineTextHints: true,
        autoFinalize: true
      });
      setWorkerPreflightBundle(result);
      const external = result.requiredConfirmations?.externalImageSpend || {};
      const llmRecovery = result.requiredConfirmations?.llmProviderRecovered || {};
      if (result.startReady) {
        setRecoveryMessage("页面 worker 启动前预检已通过。进入页面任务区后，可以启动后台批处理。");
      } else if (external.required && !external.confirmed) {
        setRecoveryMessage("页面 worker 预检完成：还需要先记录外部图片 API 额度授权。");
      } else if (llmRecovery.required && !llmRecovery.confirmed) {
        setRecoveryMessage("页面 worker 预检完成：需要先确认 LLM provider 额度/鉴权已恢复。");
      } else {
        setRecoveryMessage("页面 worker 预检完成，请查看下方预检详情。");
      }
      return result;
    } catch (preflightError) {
      setError(getErrorMessage(preflightError));
      return null;
    } finally {
      setWorkerPreflightBusy(false);
    }
  }

  async function previewLatestFailureWorkerStart() {
    if (!job?.id || !latestDeliveryFailurePageSelection) return null;
    setWorkerPreflightBusy(true);
    setError("");
    try {
      const result = await api.workflowWorkerBatchPreflight(job.id, {
        mode: "model",
        pages: latestDeliveryFailurePageSelection,
        maxPages: latestDeliveryFailurePages.length || 1,
        agentPrefix: "product-page-worker",
        confirmLlmProviderRecovered: deliveryLlmRecoveredConfirmed,
        acceptOfflineTextHints: true,
        autoFinalize: true
      });
      setWorkerPreflightBundle(result);
      setRecoveryMessage(latestDeliveryFailure?.kind === "image-provider-overloaded"
        ? "已完成失败页重跑预检：上次失败是图片 API 服务过载。服务恢复后可只重跑该页；成功页不会被覆盖。"
        : result.startBody?.lowComplexityPageSpec
          ? "已完成失败页重跑预检：检测到最近模型超时，本次会使用低复杂度页面规格模式。"
          : "已完成失败页重跑预检。");
      return result;
    } catch (failureError) {
      setError(getErrorMessage(failureError));
      return null;
    } finally {
      setWorkerPreflightBusy(false);
    }
  }

  async function startLatestFailureWorker() {
    if (!job?.id || workerStartBusy || !latestDeliveryFailurePageSelection) return;
    setWorkerStartBusy(true);
    setError("");
    try {
      const preflightPageSelection = workflowPreflightPageSelection(workerPreflightBundle);
      const preflightMatchesFailure = workflowPageSelectionsMatch(preflightPageSelection, latestDeliveryFailurePageSelection);
      const preflight = workerPreflightBundle?.startReady && preflightMatchesFailure ? workerPreflightBundle : await previewLatestFailureWorkerStart();
      if (!preflight?.ready) {
        setRecoveryMessage(`失败页重跑预检被阻断：${uiZh((preflight?.blockingIssues || []).join(" ") || "未就绪")}`);
        return;
      }
      if (!preflight.startReady) {
        setRecoveryMessage(`失败页还不能重跑：${uiZh((preflight.warnings || []).join(" ") || "缺少额度或服务商确认")}`);
        return;
      }
      const startBody = preflight.startBody || {};
      const llmRecovery = preflight.requiredConfirmations?.llmProviderRecovered || {};
      const lowComplexityNote = startBody.lowComplexityPageSpec ? "\n\n检测到页面重建模型最近超时，本次会使用低复杂度页面规格模式，优先降低再次 524 的概率。" : "";
      const imageCalls = Number(startBody.externalImageCallBudget || preflight.externalImageCalls || preflight.authorization?.imageCalls || 0);
      const imageCallNote = imageCalls ? `\n\n本次预计最多使用 ${imageCalls} 次 gpt-image-2 图片调用。` : "";
      const overloadNote = latestDeliveryFailure?.kind === "image-provider-overloaded"
        ? "\n\n上次失败原因是图片 API 服务过载；如果服务商仍然过载，本页会再次失败，但不会污染已成功页面。"
        : "";
      const confirmed = window.confirm(`将只重跑 ${latestDeliveryFailurePageSelection}。成功页不会被覆盖；此操作会调用外部模型/图片服务并可能消耗额度。是否继续？${imageCallNote}${overloadNote}${lowComplexityNote}`);
      if (!confirmed) return;
      const result = await api.startWorkflowWorkerBatch(job.id, {
        mode: "model",
        maxPages: preflight.selectedCount || startBody.maxPages || latestDeliveryFailurePages.length || 1,
        pages: startBody.pages || latestDeliveryFailurePageSelection,
        agentPrefix: startBody.agentPrefix || "product-page-worker",
        confirmExternalImageSpend: true,
        confirmLlmProviderRecovered: Boolean(llmRecovery.required ? llmRecovery.confirmed : false),
        acceptOfflineTextHints: true,
        lowComplexityPageSpec: Boolean(startBody.lowComplexityPageSpec),
        externalImageCallBudget: startBody.externalImageCallBudget || preflight.externalImageCalls || preflight.authorization?.imageCalls || undefined,
        externalImageCallsPerPage: startBody.externalImageCallsPerPage || preflight.externalImageCallsPerPage || undefined,
        offlineTextHintsReason: "delivery portal explicit failed-page retry confirmation",
        autoFinalize: true
      });
      setRecoveryMessage(`已启动失败页重跑：${result.runner?.id || result.runId || "运行器已创建"}。`);
      await Promise.allSettled([loadDelivery(job.id), loadDeliveryWorkerRuns(job.id), previewLatestFailureWorkerStart()]);
    } catch (startError) {
      setError(getErrorMessage(startError));
    } finally {
      setWorkerStartBusy(false);
    }
  }

  async function resetLatestDeliveryFailurePages() {
    if (!job?.id || !latestDeliveryFailurePages.length || recoveryBusy) return;
    const pageText = latestDeliveryFailurePages.join(",");
    const confirmed = window.confirm(`将重置失败页 ${pageText} 的页面任务状态。\n\n这一步只清理本地失败/锁定状态，不调用外部 API，不覆盖已成功页面。重置后仍需先做预检，再手动启动重跑。是否继续？`);
    if (!confirmed) return;
    setRecoveryBusy("reset-latest-failure");
    setRecoveryMessage("");
    setError("");
    try {
      for (const pageId of latestDeliveryFailurePages) {
        await api.workflowWorkerTaskAction(job.id, pageId, "reset", {
          reason: "frontend delivery reset latest failed editable page before retry",
          confirmLost: true
        });
      }
      setWorkerPreflightBundle(null);
      setRecoveryMessage(`已重置 ${pageText}。下一步请先做重跑预检，通过后再启动单页重跑；已成功页面不会被覆盖。`);
      await Promise.allSettled([
        loadDelivery(job.id),
        loadDeliveryWorkerRuns(job.id),
        previewLatestFailureWorkerStart()
      ]);
    } catch (resetError) {
      setError(getErrorMessage(resetError));
    } finally {
      setRecoveryBusy("");
    }
  }

  async function startEditableWorkerFromDelivery() {
    if (!job?.id || workerStartBusy) return;
    setWorkerStartBusy(true);
    setError("");
    try {
      const workerPageSelection = deliverySelectedWorkerPageSelection || workflowWorkerPageSelection(status);
      const preflightPageSelection = workflowPreflightPageSelection(workerPreflightBundle);
      const preflightMatchesStatus = workflowPageSelectionsMatch(preflightPageSelection, workerPageSelection);
      const preflight = workerPreflightBundle?.startReady && preflightMatchesStatus ? workerPreflightBundle : await previewEditableWorkerStart();
      if (!preflight?.ready) {
        setRecoveryMessage(`页面 worker 预检被阻断：${uiZh((preflight?.blockingIssues || []).join(" ") || "未就绪")}`);
        return;
      }
      if (!preflight.startReady) {
        setRecoveryMessage(`页面 worker 还不能启动：${uiZh((preflight.warnings || []).join(" ") || "缺少额度或服务商确认")}`);
        return;
      }
      const startBody = preflight.startBody || {};
      const llmRecovery = preflight.requiredConfirmations?.llmProviderRecovered || {};
      const lowComplexityNote = startBody.lowComplexityPageSpec ? "\n\n检测到页面重建模型最近超时，本次会使用低复杂度页面规格模式，优先降低再次 524 的概率。" : "";
      const imageCalls = Number(startBody.externalImageCallBudget || preflight.externalImageCalls || preflight.authorization?.imageCalls || 0);
      const imageCallNote = imageCalls ? `\n\n本批预计最多使用 ${imageCalls} 次 gpt-image-2 图片调用。` : "";
      const confirmed = window.confirm(`将启动 ${preflight.selectedCount || 0} 个 image-to-editable-ppt 页面 worker。此操作会调用外部图片/模型服务，可能消耗额度。成功页会保留，失败页后续单独重跑。是否继续？${imageCallNote}${lowComplexityNote}`);
      if (!confirmed) return;
      const result = await api.startWorkflowWorkerBatch(job.id, {
        mode: "model",
        maxPages: preflight.selectedCount || startBody.maxPages || deliverySelectedWorkerPageIds.length || 2,
        pages: startBody.pages || (preflight.selectedPageIds || []).join(","),
        agentPrefix: startBody.agentPrefix || "product-page-worker",
        confirmExternalImageSpend: true,
        confirmLlmProviderRecovered: Boolean(llmRecovery.required ? llmRecovery.confirmed : false),
        acceptOfflineTextHints: true,
        lowComplexityPageSpec: Boolean(startBody.lowComplexityPageSpec),
        externalImageCallBudget: startBody.externalImageCallBudget || preflight.externalImageCalls || preflight.authorization?.imageCalls || undefined,
        externalImageCallsPerPage: startBody.externalImageCallsPerPage || preflight.externalImageCallsPerPage || undefined,
        offlineTextHintsReason: "delivery portal explicit worker start confirmation",
        autoFinalize: true
      });
      setRecoveryMessage(`已启动后台页面批处理：${result.runner?.id || result.runId || "运行器已创建"}。请在页面任务区查看日志和进度。`);
      await Promise.allSettled([loadDelivery(job.id), loadDeliveryWorkerRuns(job.id), previewEditableWorkerStart()]);
    } catch (startError) {
      setError(getErrorMessage(startError));
    } finally {
      setWorkerStartBusy(false);
    }
  }

  useEffect(() => {
    if (!job?.id) {
      setDeliveryBundle(null);
      setArtifactBundle(null);
      setError("");
      setRecoveryMessage("");
      setRecoveryResult(null);
      setWorkerPreflightBundle(null);
      setDeliveryWorkerRunBundle(null);
      setWorkerStartBusy(false);
      setDeliveryLlmRecoveredConfirmed(false);
      setLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    loadDelivery(job.id, controller.signal);
    loadDeliveryWorkerRuns(job.id, controller.signal);
    return () => controller.abort();
  }, [job?.id, job?.updatedAt]);

  if (!job?.id) {
    return (
      <StageEmptyState
        title="暂无可交付文件"
        body="先创建 PPT 重制任务。完成视觉统一和可编辑重建后，这里会出现中间版本、可编辑 PPT、校验证据和日志包。"
        action="回到资料识别"
        onAction={onGoMaterials}
      />
    );
  }

  return (
    <div className="workflow-delivery-portal">
      <div className="workflow-delivery-portal-head">
        <div>
          <b>双技能交付中心</b>
          <span>只展示两套核心技能工作流产生的正式产物和诊断文件；辅助 PDF/PNG 导出不作为主交付入口。</span>
        </div>
        <div>
          <button className="btn ghost" type="button" onClick={onOpenWorkflow}>打开工作流</button>
          <button className="btn ghost" type="button" onClick={() => loadDelivery()} disabled={loading}>{loading ? "刷新中..." : "刷新交付"}</button>
          <button className="btn ghost" type="button" onClick={onCreateWorkflow}>新建工作流</button>
        </div>
      </div>
      {error ? <p className="workflow-error">{error}</p> : null}
      {recoveryMessage ? <p className="workflow-note">{recoveryMessage}</p> : null}
      {recoveryResult ? (
        <WorkflowPageEvidenceRecoveryResult
          freshRunBusy={recoveryBusy === "fresh-editable-run"}
          onFreshEditableRun={refreshEditableRunForStaleEvidence}
          onOpenPageTasks={onOpenPageTasks || onOpenWorkflow}
          result={recoveryResult}
        />
      ) : null}
      {loading && !deliveryBundle ? <p className="workflow-note">正在读取交付状态和产物链接...</p> : null}
      <WorkflowPlainAgentDashboardClean
        bundle={deliveryBundle}
        job={job}
        onAuthorizeEditableWorkerSpend={authorizeEditableWorkerSpend}
        onOpenPageTasks={onOpenPageTasks || onOpenWorkflow}
        onOpenWorkflow={onOpenWorkflow}
        onPreviewEditableWorkerStart={previewEditableWorkerStart}
        onStartEditableWorker={startEditableWorkerFromDelivery}
        onToggleLlmRecovered={toggleDeliveryLlmRecovered}
        latestWorkerRun={latestDeliveryRun}
        selectedWorkerBatchSize={deliveryWorkerBatchSize}
        selectedWorkerPageIds={deliverySelectedWorkerPageIds}
        onChangeWorkerBatchSize={(value) => {
          setDeliveryWorkerBatchSize(value === "all" ? "all" : Number(value || 2));
          setWorkerPreflightBundle(null);
        }}
        status={status}
        llmRecoveredConfirmed={deliveryLlmRecoveredConfirmed}
        workerPreflight={workerPreflightBundle}
        workerPreflightBusy={workerPreflightBusy}
        workerStartBusy={workerStartBusy}
        authorizationBusy={authorizationBusy === "editable-workers"}
      />
      <WorkflowEditableFailureRecoveryCard
        failure={latestDeliveryFailure}
        onOpenLog={() => latestDeliveryFailedRun?.logHref && window.open(latestDeliveryFailedRun.logHref, "_blank", "noopener,noreferrer")}
        onPreflight={previewLatestFailureWorkerStart}
        onResetPages={resetLatestDeliveryFailurePages}
        onSelectPage={onOpenPageTasks || onOpenWorkflow}
        onStartPage={startLatestFailureWorker}
        preflightBusy={workerPreflightBusy}
        resetBusy={recoveryBusy === "reset-latest-failure"}
        run={latestDeliveryFailedRun}
        startReady={latestDeliveryFailurePreflightReady}
      />
      <WorkflowDeliverySummary
        artifactBundle={artifactBundle}
        bundle={deliveryBundle}
        job={job}
        authorizationBusy={authorizationBusy}
        onAuthorizeEditableWorkerSpend={authorizeEditableWorkerSpend}
        onOpenPageTasks={onOpenPageTasks || onOpenWorkflow}
        onOpenWorkflow={onOpenWorkflow}
        onPreviewEditableWorkerStart={previewEditableWorkerStart}
        onPreviewFinalVisualQaRetry={previewFinalVisualQaRetry}
        onStartEditableWorker={startEditableWorkerFromDelivery}
        onPreviewStalePageEvidence={previewStalePageEvidence}
        onRefreshDelivery={() => loadDelivery(job.id)}
        onRetryFinalVisualQaPages={retryFinalVisualQaPages}
        onRetryStalePageEvidence={retryStalePageEvidence}
        onRecomposeEditableFinal={recomposeEditableFinal}
        retryBusy={recoveryBusy}
        status={status}
        workerPreflight={workerPreflightBundle}
        workerPreflightBusy={workerPreflightBusy}
        workerStartBusy={workerStartBusy}
      />
    </div>
  );
}

function WorkflowPlainAgentDashboardClean({ authorizationBusy = false, bundle = null, job = null, latestWorkerRun = null, llmRecoveredConfirmed = false, onAuthorizeEditableWorkerSpend, onChangeWorkerBatchSize, onOpenPageTasks, onOpenWorkflow, onPreviewEditableWorkerStart, onStartEditableWorker, onToggleLlmRecovered, selectedWorkerBatchSize = 2, selectedWorkerPageIds = [], status = {}, workerPreflight = null, workerPreflightBusy = false, workerStartBusy = false }) {
  const gate = bundle?.finalGate || null;
  const checks = gate?.checks || {};
  const coverage = bundle?.coverage || {};
  const sourcePages = Number(checks.sourcePages || coverage.sourcePages || job?.sourcePages || job?.sourceMeta?.pageCount || job?.artifacts?.sourceMeta?.pageCount || 0);
  const finalPages = Number(checks.finalPages || coverage.finalPages || job?.finalPages || job?.artifacts?.editableFinal?.summary?.page_count || 0);
  const remainingPages = Math.max(0, sourcePages - finalPages);
  const nextStep = status?.nextStep || {};
  const workerPages = Array.isArray(nextStep.pages) ? nextStep.pages : [];
  const workerPageCount = workerPages.length || remainingPages || 0;
  const workerPageSelection = workflowWorkerPageSelection(status);
  const batchPlan = nextStep.batchPlan || {};
  const selectedBatchPageIds = Array.isArray(selectedWorkerPageIds) ? selectedWorkerPageIds.filter(Boolean) : [];
  const selectedBatchPageSelection = selectedBatchPageIds.join(",");
  const selectedBatchCount = selectedBatchPageIds.length || Math.min(workerPageCount || 0, 2);
  const imageCallsPerPage = Number(nextStep.externalImageCallsPerPage || batchPlan.externalImageCallsPerPage || 8);
  const selectedBatchImageCalls = selectedBatchCount * imageCallsPerPage;
  const defaultBatchPages = Array.isArray(batchPlan.defaultBatchPages) ? batchPlan.defaultBatchPages.filter(Boolean) : [];
  const defaultBatchLabel = defaultBatchPages.length ? defaultBatchPages.join(",") : selectedBatchPageSelection || workerPageSelection;
  const hasFinal = Boolean(finalPages || bundle?.final?.artifact || job?.artifacts?.editableFinal);
  const productReady = gate?.productReady === true || status?.level === "ready";
  const isPartialFinal = Boolean(hasFinal && sourcePages && finalPages && finalPages < sourcePages);
  const needsWorkerStart = nextStep.id === "start-page-workers";
  const needsAuthorization = Boolean(needsWorkerStart && nextStep.authorization?.required && !nextStep.authorization?.persisted);
  const workerPreflightSelection = workflowPreflightPageSelection(workerPreflight);
  const preflightMatchesStatus = workflowPageSelectionsMatch(workerPreflightSelection, selectedBatchPageSelection || workerPageSelection);
  const preflightReady = Boolean(workerPreflight?.startReady === true && preflightMatchesStatus);
  const externalConfirmation = workerPreflight?.requiredConfirmations?.externalImageSpend || {};
  const llmRecovery = workerPreflight?.requiredConfirmations?.llmProviderRecovered || {};
  const needsLlmRecovery = Boolean(workerPreflight && llmRecovery.required && !llmRecovery.confirmed);
  const modelPageWorkersReady = Boolean(workerPreflight?.modelPageWorkers?.ready || workerPreflight?.modelPageWorkers?.missingCount === 0);
  const preflightCanAuthorize = Boolean(
    workerPreflight?.ready
      && workerPageSelection
      && preflightMatchesStatus
      && Array.isArray(workerPreflight?.selectedPageIds)
      && workerPreflight.selectedPageIds.length
  );
  const sourceName = job?.sourceName || job?.input?.sourceOriginalName || job?.artifacts?.source?.originalName || job?.title || "当前 PPT";
  const manualReview = job?.artifacts?.manualReview || {};
  const manualReviewRecorded = checks.manualReviewRecorded === true;
  const sampleReviewRecorded = Boolean(manualReviewRecorded && isPartialFinal);
  const fullReviewRecorded = Boolean(manualReviewRecorded && !isPartialFinal && checks.fullSourceCoverage === true);
  const blocked = status?.level === "blocked" || gate?.level === "blocked";
  const authorizationLabel = selectedBatchImageCalls ? `授权本批 ${selectedBatchImageCalls} 次图片额度` : "确认图片额度";
  const workerPageLabel = workerPageCount ? `继续剩余 ${workerPageCount} 页` : "继续剩余页面";
  const title = productReady
    ? "最终 PPT 已可交付"
    : isPartialFinal
      ? `当前只有 ${finalPages}/${sourcePages} 页小样本`
      : needsWorkerStart
        ? "可编辑重建还没完成"
        : blocked
          ? "当前任务被交付门禁拦住"
          : "PPT Agent 正在处理";
  const summary = productReady
    ? "页数、可编辑性、PowerPoint 打开检查和人工复核都已通过，可以下载最终产品级 PPT。"
    : isPartialFinal
      ? `已有 ${finalPages} 页可编辑结果，但完整交付必须覆盖全部 ${sourcePages} 页。下一步是继续重建剩余页面，或先复核当前小样本。`
      : needsWorkerStart
        ? `还有 ${workerPageCount || "若干"} 页等待 image-to-editable-ppt 重建。建议先小批量运行，本次默认选择 ${selectedBatchCount || 0} 页。`
        : blocked
          ? "工程细节保留在高级详情里。普通操作先看这里的下一步按钮。"
          : "继续等待后台任务或刷新状态。";
  const facts = [
    { label: "当前文件", value: sourceName },
    { label: "源文件页数", value: sourcePages || "未知" },
    { label: "可编辑 PPT", value: sourcePages && finalPages ? `${finalPages}/${sourcePages}` : finalPages || "未生成" },
    { label: "待重建页数", value: workerPageCount || remainingPages || 0 },
    { label: "本批页数", value: selectedBatchCount || "待选择" },
    { label: "本批预计额度", value: selectedBatchImageCalls ? `${selectedBatchImageCalls} 次` : "待预检" }
  ];
  const steps = [
    { label: "上传源文件", detail: sourcePages ? `${sourcePages} 页` : "等待源文件", done: Boolean(sourcePages || job?.source?.path || job?.input?.path) },
    { label: "生成图片型 PPT", detail: checks.codexPptSlideRunComplete === true ? "20/20 已完成" : "等待 codex-ppt", done: checks.codexPptSlideRunComplete === true },
    { label: "转成可编辑 PPT", detail: sourcePages && finalPages ? `${finalPages}/${sourcePages}` : "等待重建", done: checks.fullSourceCoverage === true, current: needsWorkerStart || isPartialFinal },
    { label: "人工复核", detail: fullReviewRecorded ? "完整复核已记录" : sampleReviewRecorded ? "小样本已复核" : hasFinal ? "等待复核" : "等待最终 PPT", done: fullReviewRecorded, current: hasFinal && !fullReviewRecorded },
    { label: "下载最终 PPT", detail: productReady ? "最终产品级" : isPartialFinal ? "仅小样本草稿" : "等待门禁", done: productReady, current: productReady }
  ];
  const launchChecklist = needsWorkerStart ? [
    { label: "页面材料", value: workerPreflight ? (modelPageWorkersReady ? "已就绪" : "缺少材料") : "待预检", state: workerPreflight ? (modelPageWorkersReady ? "ready" : "blocked") : "pending" },
    { label: "模型状态", value: workerPreflight ? (llmRecovery.required ? (llmRecovery.confirmed ? "已确认恢复" : "待确认恢复") : "无需确认") : "待预检", state: workerPreflight ? (llmRecovery.required ? (llmRecovery.confirmed ? "ready" : "warning") : "ready") : "pending" },
    { label: "图片额度", value: workerPreflight ? (externalConfirmation.required ? (externalConfirmation.confirmed ? "已授权" : `${externalConfirmation.imageCalls || selectedBatchImageCalls || "待确认"} 次待确认`) : "无需授权") : `${selectedBatchImageCalls || "待确认"} 次待确认`, state: workerPreflight ? (externalConfirmation.required ? (externalConfirmation.confirmed ? "ready" : "warning") : "ready") : "warning" },
    { label: "启动状态", value: preflightReady ? "预检通过，等待人工启动" : workerPreflight ? "未就绪" : "待预检", state: preflightReady ? "ready" : "pending" }
  ] : [];
  const llmRecoveryLabel = llmRecovery.required
    ? llmRecovery.confirmed
      ? "模型恢复已确认"
      : "需要确认模型恢复"
    : "模型状态正常";
  const nextCopy = productReady
    ? "下载区在下方；这是最终产品级文件。"
    : needsAuthorization && needsLlmRecovery
      ? `先确认页面重建模型已恢复，再授权 ${selectedBatchImageCalls || "本批"} 次图片额度。`
      : needsAuthorization
        ? `先点“启动前预检”，再点“${authorizationLabel}”，最后启动本批页面重建。`
        : needsLlmRecovery
          ? "确认页面重建模型服务已经恢复，再重新执行启动前预检。"
          : preflightReady
            ? `预检已通过，可以点“确认并启动 ${selectedBatchCount || "本批"} 页重建”。`
            : needsWorkerStart
              ? `先选择本次运行页数，再做启动前预检，确认 ${selectedBatchCount || "这些"} 页、图片额度和模型状态。`
              : isPartialFinal
                ? "先复核当前小样本；完整交付仍需要继续剩余页面。"
                : "查看下方高级详情，定位当前阻断。";

  return (
    <section className={`workflow-agent-dashboard ${productReady ? "ready" : blocked ? "blocked" : "working"}`}>
      <div className="workflow-agent-dashboard-head">
        <div>
          <b>PPT Agent 工作台</b>
          <strong>{title}</strong>
          <span>{summary}</span>
        </div>
        <button className="btn ghost" type="button" onClick={onOpenWorkflow} disabled={!onOpenWorkflow}>查看完整工作流</button>
      </div>
      <div className="workflow-agent-dashboard-facts">
        {facts.map((fact) => <span key={fact.label}><b>{fact.value}</b>{fact.label}</span>)}
      </div>
      <div className="workflow-agent-dashboard-steps" aria-label="PPT Agent 主流程">
        {steps.map((step, index) => {
          const state = step.done ? "done" : step.current ? "current" : "pending";
          return (
            <span className={state} key={step.label}>
              <b>{index + 1}</b>
              <strong>{step.label}</strong>
              <small>{step.detail}</small>
            </span>
          );
        })}
      </div>
      <div className="workflow-agent-dashboard-next">
        <div>
          <b>推荐下一步</b>
          <span>{nextCopy}</span>
        </div>
        <div className="workflow-agent-dashboard-actions">
          {needsWorkerStart ? (
            <>
              <label className="workflow-agent-dashboard-batch">
                <span>本次运行</span>
                <select value={selectedWorkerBatchSize} onChange={(event) => onChangeWorkerBatchSize?.(event.target.value)} disabled={!onChangeWorkerBatchSize || workerPreflightBusy || workerStartBusy}>
                  <option value={1}>先跑 1 页</option>
                  <option value={2}>先跑 2 页</option>
                  <option value={5}>跑 5 页</option>
                  <option value="all">跑完剩余页</option>
                </select>
              </label>
              <button className="btn" type="button" onClick={onPreviewEditableWorkerStart} disabled={workerPreflightBusy || !onPreviewEditableWorkerStart}>
                {workerPreflightBusy ? "预检中..." : "启动前预检"}
              </button>
              <button className="btn" type="button" onClick={onAuthorizeEditableWorkerSpend} disabled={authorizationBusy || !needsAuthorization || !preflightCanAuthorize || !onAuthorizeEditableWorkerSpend}>
                {authorizationBusy ? "记录中..." : authorizationLabel}
              </button>
              <label className={`workflow-agent-dashboard-confirm ${needsLlmRecovery ? "warning" : llmRecovery.confirmed ? "ready" : ""}`}>
                <input
                  type="checkbox"
                  checked={llmRecoveredConfirmed || Boolean(llmRecovery.confirmed)}
                  onChange={(event) => onToggleLlmRecovered?.(event.target.checked)}
                  disabled={!onToggleLlmRecovered || !workerPreflight || !llmRecovery.required}
                />
                <span>{llmRecoveryLabel}</span>
              </label>
              <button className="btn primary" type="button" onClick={onStartEditableWorker} disabled={workerStartBusy || !preflightReady || !onStartEditableWorker}>
                {workerStartBusy ? "启动中..." : `确认并启动 ${selectedBatchCount || ""} 页重建`}
              </button>
            </>
          ) : null}
          {isPartialFinal ? <button className="btn" type="button" onClick={onOpenWorkflow} disabled={!onOpenWorkflow}>复核当前小样本</button> : null}
          <button className="btn ghost" type="button" onClick={onOpenPageTasks} disabled={!onOpenPageTasks}>{needsWorkerStart ? workerPageLabel : "打开页面任务"}</button>
        </div>
      </div>
      {needsWorkerStart ? (
        <div className="workflow-agent-dashboard-worker-range">
          <b>待处理页面</b>
          <span>{selectedBatchPageSelection || workerPageSelection || "等待后端返回页码"}</span>
          <small>默认本批：{defaultBatchLabel || "等待选择"}；预计 {selectedBatchImageCalls || batchPlan.defaultBatchExternalImageCalls || 0} 次图片 API。{uiZh(batchPlan.whyBatch || "这里只启动本批页面；成功页会保留，失败页后续单独重跑。选择“跑完剩余页”前请确认额度和模型稳定性。")}</small>
          {batchPlan.preserveSuccessfulPages ? <em>成功页会保留；失败页可以后续单独重跑。</em> : null}
        </div>
      ) : null}
      <WorkflowAgentWorkerRunStatusClean run={latestWorkerRun} />
      {launchChecklist.length ? (
        <div className="workflow-agent-dashboard-checklist" aria-label="启动前确认清单">
          {launchChecklist.map((item) => (
            <span className={item.state} key={item.label}>
              <b>{item.label}</b>
              {item.value}
            </span>
          ))}
        </div>
      ) : null}
      <details className="workflow-agent-dashboard-advanced">
        <summary>高级详情在哪里？</summary>
        <p>页面任务、模型配置、产物链接和校验结果都保留在下方，不放在普通入口里。</p>
      </details>
    </section>
  );
}

function WorkflowAgentWorkerRunStatusClean({ run = null }) {
  if (!run) return null;
  const status = String(run.status || "unknown");
  const running = status === "running";
  const failed = status === "failed";
  const complete = status === "complete";
  const pageText = run.pages || (Array.isArray(run.selectedPageIds) ? run.selectedPageIds.join(",") : "未记录");
  const succeeded = Number(run.succeeded || run.summary?.succeeded || 0);
  const failedCount = Number(run.failed || run.summary?.failed || 0);
  const title = running
    ? "本批正在重建"
    : complete
      ? "最近一批已完成"
      : failed
        ? "最近一批失败"
        : "最近一批状态";
  const detail = failed && run.failureAnalysis?.reason
    ? run.failureAnalysis.reason
    : running
      ? "页面 worker 正在运行，状态会自动刷新。"
      : complete
        ? "本批页面已经返回，交付门禁会继续检查页面证据。"
        : "可以打开日志查看这批页面的详细过程。";
  return (
    <div className={`workflow-agent-worker-run ${status}`}>
      <div>
        <b>{title}</b>
        <span>{uiZh(detail)}</span>
      </div>
      <div className="workflow-agent-worker-run-facts">
        <span><b>{pageText}</b>页码</span>
        <span><b>{succeeded}</b>成功</span>
        <span><b>{failedCount}</b>失败</span>
        <span><b>{run.lowComplexityPageSpec ? "已启用" : "未启用"}</b>低复杂度</span>
      </div>
      <div className="workflow-agent-worker-run-actions">
        {run.logHref ? <a className="btn ghost" href={run.logHref} target="_blank" rel="noreferrer">查看日志</a> : null}
        {run.logDownloadHref ? <a className="btn ghost" href={run.logDownloadHref}>下载日志</a> : null}
      </div>
    </div>
  );
}

function WorkflowPlainAgentDashboard({ authorizationBusy = false, bundle = null, job = null, latestWorkerRun = null, llmRecoveredConfirmed = false, onAuthorizeEditableWorkerSpend, onChangeWorkerBatchSize, onOpenPageTasks, onOpenWorkflow, onPreviewEditableWorkerStart, onStartEditableWorker, onToggleLlmRecovered, selectedWorkerBatchSize = 2, selectedWorkerPageIds = [], status = {}, workerPreflight = null, workerPreflightBusy = false, workerStartBusy = false }) {
  const gate = bundle?.finalGate || null;
  const checks = gate?.checks || {};
  const sourcePages = Number(checks.sourcePages || bundle?.coverage?.sourcePages || job?.sourcePages || job?.sourceMeta?.pageCount || job?.artifacts?.sourceMeta?.pageCount || 0);
  const finalPages = Number(checks.finalPages || bundle?.coverage?.finalPages || job?.finalPages || job?.artifacts?.editableFinal?.summary?.page_count || 0);
  const remainingPages = Math.max(0, sourcePages - finalPages);
  const nextStep = status?.nextStep || {};
  const workerPages = Array.isArray(nextStep.pages) ? nextStep.pages : [];
  const workerPageCount = workerPages.length || workflowFactNumber(status, "就绪重建页面");
  const externalImageCalls = Number(nextStep.externalImageCalls || nextStep.authorization?.imageCalls || workerPageCount || 0);
  const hasFinal = Boolean(finalPages || bundle?.final?.artifact || job?.artifacts?.editableFinal);
  const productReady = gate?.productReady === true || status?.level === "ready";
  const isPartialFinal = Boolean(hasFinal && sourcePages && finalPages && finalPages < sourcePages);
  const manualReview = job?.artifacts?.manualReview || {};
  const manualReviewRecorded = checks.manualReviewRecorded === true;
  const sampleReviewRecorded = Boolean(manualReviewRecorded && isPartialFinal);
  const fullReviewRecorded = Boolean(manualReviewRecorded && !isPartialFinal && checks.fullSourceCoverage === true);
  const needsWorkerStart = nextStep.id === "start-page-workers";
  const needsAuthorization = Boolean(needsWorkerStart && nextStep.authorization?.required && !nextStep.authorization?.persisted);
  const stepAuthorizationRequired = Boolean(needsWorkerStart && (nextStep.authorization?.required || nextStep.externalImageCalls));
  const workerPageSelection = workflowWorkerPageSelection(status);
  const batchPlan = nextStep.batchPlan || {};
  const selectedBatchPageIds = Array.isArray(selectedWorkerPageIds) ? selectedWorkerPageIds.filter(Boolean) : [];
  const selectedBatchPageSelection = selectedBatchPageIds.join(",");
  const selectedBatchCount = selectedBatchPageIds.length || Math.min(workerPageCount || remainingPages || 0, 2);
  const selectedBatchImageCalls = selectedBatchCount * Number(nextStep.externalImageCallsPerPage || 8);
  const defaultBatchPages = Array.isArray(batchPlan.defaultBatchPages) ? batchPlan.defaultBatchPages.filter(Boolean) : [];
  const defaultBatchLabel = defaultBatchPages.length ? defaultBatchPages.join(",") : selectedBatchPageSelection || workerPageSelection;
  const workerPageLabel = workerPageCount
    ? `继续剩余 ${workerPageCount} 页`
    : "继续剩余页面";
  const authorizationLabel = selectedBatchImageCalls
    ? `授权本批 ${selectedBatchImageCalls} 次图片额度`
    : "确认图片额度";
  const sourceName = job?.sourceName || job?.input?.sourceOriginalName || job?.artifacts?.source?.originalName || job?.title || "当前 PPT";
  const workerPreflightSelection = workflowPreflightPageSelection(workerPreflight);
  const preflightMatchesStatus = workflowPageSelectionsMatch(workerPreflightSelection, selectedBatchPageSelection || workerPageSelection);
  const preflightReady = Boolean(workerPreflight?.startReady === true && preflightMatchesStatus);
  const preflightCanAuthorize = Boolean(
    workerPreflight?.ready
      && workerPageSelection
      && preflightMatchesStatus
      && Array.isArray(workerPreflight?.selectedPageIds)
      && workerPreflight.selectedPageIds.length
  );
  const externalConfirmation = workerPreflight?.requiredConfirmations?.externalImageSpend || {};
  const llmRecovery = workerPreflight?.requiredConfirmations?.llmProviderRecovered || {};
  const needsLlmRecovery = Boolean(workerPreflight && llmRecovery.required && !llmRecovery.confirmed);
  const modelPageWorkersReady = Boolean(workerPreflight?.modelPageWorkers?.ready || workerPreflight?.modelPageWorkers?.missingCount === 0);
  const launchChecklist = needsWorkerStart ? [
    {
      label: "页面材料",
      value: workerPreflight ? (modelPageWorkersReady ? "已就绪" : "缺少材料") : "待预检",
      state: workerPreflight ? (modelPageWorkersReady ? "ready" : "blocked") : "pending"
    },
    {
      label: "模型恢复",
      value: workerPreflight ? (llmRecovery.required ? (llmRecovery.confirmed ? "已确认" : "待确认") : "无需确认") : "待预检",
      state: workerPreflight ? (llmRecovery.required ? (llmRecovery.confirmed ? "ready" : "warning") : "ready") : "pending"
    },
    {
      label: "图片额度",
      value: workerPreflight
        ? (externalConfirmation.required ? (externalConfirmation.confirmed ? "已授权" : `${externalConfirmation.imageCalls || selectedBatchImageCalls || externalImageCalls || "待确认"} 次待确认`) : "无需授权")
        : (stepAuthorizationRequired ? `${selectedBatchImageCalls || externalImageCalls || "待确认"} 次待确认` : "待预检"),
      state: workerPreflight
        ? (externalConfirmation.required ? (externalConfirmation.confirmed ? "ready" : "warning") : "ready")
        : (stepAuthorizationRequired ? "warning" : "pending")
    },
    {
      label: "启动状态",
      value: preflightReady ? "预检通过，待人工启动" : workerPreflight ? "未就绪" : "待预检",
      state: preflightReady ? "ready" : "pending"
    }
  ] : [];
  const llmRecoveryLabel = llmRecovery.required
    ? llmRecovery.confirmed
      ? "模型恢复已确认"
      : "需要确认模型恢复"
    : "模型状态正常";
  const blocked = status?.level === "blocked" || gate?.level === "blocked";
  const title = productReady
    ? "最终 PPT 已可交付"
    : isPartialFinal
        ? `当前只有 ${finalPages}/${sourcePages} 页小样本`
      : needsWorkerStart
        ? "可编辑重建还没完成"
        : blocked
          ? "当前任务被交付门禁拦住"
          : "PPT Agent 正在处理中";
  const summary = productReady
    ? "已经通过页数、可编辑性、PowerPoint 打开和人工复核检查，可以下载最终产品级 PPT。"
    : isPartialFinal
      ? `已经有 ${finalPages} 页可编辑结果，但完整交付需要覆盖全部 ${sourcePages} 页。下一步是继续重建剩余页面，或先复核当前小样本。`
      : needsWorkerStart
        ? `还有 ${workerPageCount || remainingPages || "若干"} 页等待可编辑页面重建。建议先小批量运行，本次默认选择 ${selectedBatchCount || 0} 页。`
        : blocked
          ? "下面会保留工程详情；普通操作先看这里的下一步按钮。"
          : "继续等待后台任务或刷新状态。";
  const facts = [
    { label: "当前文件", value: sourceName },
    { label: "源文件页数", value: sourcePages || "未知" },
    { label: "可编辑 PPT", value: sourcePages && finalPages ? `${finalPages}/${sourcePages}` : finalPages || "未生成" },
    { label: "待重建页数", value: workerPageCount || remainingPages || 0 },
    { label: "本批页数", value: selectedBatchCount || "待选择" },
    { label: "本批预计额度", value: selectedBatchImageCalls || "待预检" }
  ];
  const steps = [
    { label: "上传源文件", detail: sourcePages ? `${sourcePages} 页` : "等待源文件", done: Boolean(sourcePages || job?.source?.path || job?.input?.path) },
    { label: "生成图片型 PPT", detail: checks.codexPptSlideRunComplete === true ? "20/20 已完成" : "等待 codex-ppt", done: checks.codexPptSlideRunComplete === true },
    { label: "转成可编辑 PPT", detail: sourcePages && finalPages ? `${finalPages}/${sourcePages}` : "等待重建", done: checks.fullSourceCoverage === true, current: needsWorkerStart || isPartialFinal },
    {
      label: "人工复核",
      detail: fullReviewRecorded ? "完整复核已记录" : sampleReviewRecorded ? "小样本已复核" : hasFinal ? "等待复核" : "等待最终 PPT",
      done: fullReviewRecorded,
      current: hasFinal && !fullReviewRecorded
    },
    { label: "下载最终 PPT", detail: productReady ? "最终产品级" : isPartialFinal ? "仅小样本草稿" : "等待门禁", done: productReady, current: productReady }
  ];

  return (
    <section className={`workflow-agent-dashboard ${productReady ? "ready" : blocked ? "blocked" : "working"}`}>
      <div className="workflow-agent-dashboard-head">
        <div>
          <b>PPT Agent 工作台</b>
          <strong>{title}</strong>
          <span>{summary}</span>
        </div>
        <button className="btn ghost" type="button" onClick={onOpenWorkflow} disabled={!onOpenWorkflow}>查看完整工作流</button>
      </div>
      <div className="workflow-agent-dashboard-facts">
        {facts.map((fact) => (
          <span key={fact.label}><b>{fact.value}</b>{fact.label}</span>
        ))}
      </div>
      <div className="workflow-agent-dashboard-steps" aria-label="PPT Agent 主流程">
        {steps.map((step, index) => {
          const state = step.done ? "done" : step.current ? "current" : "pending";
          return (
            <span className={state} key={step.label}>
              <b>{index + 1}</b>
              <strong>{step.label}</strong>
              <small>{step.detail}</small>
            </span>
          );
        })}
      </div>
      <div className="workflow-agent-dashboard-next">
        <div>
          <b>推荐下一步</b>
          <span>
            {productReady
              ? "下载区在下方；这是最终产品级文件。"
              : needsAuthorization && needsLlmRecovery
                ? `先确认页面重建模型已恢复，再授权 ${externalImageCalls || workerPageCount || "本批"} 次图片额度。`
                : needsAuthorization
                  ? `先点“启动前预检”，再点“${authorizationLabel}”，最后启动本批页面重建。`
                : needsLlmRecovery
                  ? "确认页面重建模型服务已经恢复，再重新执行启动前预检。"
                : preflightReady
                  ? `预检已通过，可以点“确认并启动 ${selectedBatchCount || "本批"} 页重建”。`
                  : needsWorkerStart
                    ? `先选择本次运行页数，再做启动前预检，确认 ${selectedBatchCount || "这些"} 页、图片额度和模型状态。`
                    : isPartialFinal
                      ? "先复核当前小样本；完整交付仍需继续剩余页面。"
                      : "查看下方高级详情，定位当前阻断。"}
          </span>
        </div>
        <div className="workflow-agent-dashboard-actions">
          {needsWorkerStart ? (
            <>
              <label className="workflow-agent-dashboard-batch">
                <span>本次运行</span>
                <select value={selectedWorkerBatchSize} onChange={(event) => onChangeWorkerBatchSize?.(event.target.value)} disabled={!onChangeWorkerBatchSize || workerPreflightBusy || workerStartBusy}>
                  <option value={1}>先跑 1 页</option>
                  <option value={2}>先跑 2 页</option>
                  <option value={5}>跑 5 页</option>
                  <option value="all">跑完剩余页</option>
                </select>
              </label>
              <button className="btn" type="button" onClick={onPreviewEditableWorkerStart} disabled={workerPreflightBusy || !onPreviewEditableWorkerStart}>
                {workerPreflightBusy ? "预检中..." : "启动前预检"}
              </button>
              <button className="btn" type="button" onClick={onAuthorizeEditableWorkerSpend} disabled={authorizationBusy || !needsAuthorization || !preflightCanAuthorize || !onAuthorizeEditableWorkerSpend}>
                {authorizationBusy ? "记录中..." : authorizationLabel}
              </button>
              <label className={`workflow-agent-dashboard-confirm ${needsLlmRecovery ? "warning" : llmRecovery.confirmed ? "ready" : ""}`}>
                <input
                  type="checkbox"
                  checked={llmRecoveredConfirmed || Boolean(llmRecovery.confirmed)}
                  onChange={(event) => onToggleLlmRecovered?.(event.target.checked)}
                  disabled={!onToggleLlmRecovered || !workerPreflight || !llmRecovery.required}
                />
                <span>{llmRecoveryLabel}</span>
              </label>
              <button className="btn primary" type="button" onClick={onStartEditableWorker} disabled={workerStartBusy || !preflightReady || !onStartEditableWorker}>
                {workerStartBusy ? "启动中..." : `确认并启动 ${selectedBatchCount || ""} 页重建`}
              </button>
            </>
          ) : null}
          {isPartialFinal ? <button className="btn" type="button" onClick={onOpenWorkflow} disabled={!onOpenWorkflow}>复核当前小样本</button> : null}
          <button className="btn ghost" type="button" onClick={onOpenPageTasks} disabled={!onOpenPageTasks}>{needsWorkerStart ? workerPageLabel : "打开页面任务"}</button>
        </div>
      </div>
      {needsWorkerStart ? (
        <div className="workflow-agent-dashboard-worker-range">
          <b>待处理页面</b>
          <span>{selectedBatchPageSelection || workerPageSelection || "等待后端返回页码"}</span>
          <small>默认本批：{defaultBatchLabel || "等待选择"}；预计 {selectedBatchImageCalls || batchPlan.defaultBatchExternalImageCalls || 0} 次图片 API。{uiZh(batchPlan.whyBatch || "这里只启动本批页面；成功页会保留，失败页后续单独重跑。选择“跑完剩余页”前请确认额度和模型稳定性。")}</small>
          {batchPlan.preserveSuccessfulPages ? <em>成功页会保留；失败页可以后续单独重跑。</em> : null}
        </div>
      ) : null}
      <WorkflowAgentWorkerRunStatus run={latestWorkerRun} />
      {launchChecklist.length ? (
        <div className="workflow-agent-dashboard-checklist" aria-label="启动前确认清单">
          {launchChecklist.map((item) => (
            <span className={item.state} key={item.label}>
              <b>{item.label}</b>
              {item.value}
            </span>
          ))}
        </div>
      ) : null}
      <details className="workflow-agent-dashboard-advanced">
        <summary>高级详情在哪里</summary>
        <p>页面任务、模型配置、产物链接和校验结果都保留在下方，不放在普通入口里。</p>
      </details>
    </section>
  );
}

function WorkflowAgentWorkerRunStatus({ run = null }) {
  if (!run) return null;
  const status = String(run.status || "unknown");
  const running = status === "running";
  const failed = status === "failed";
  const complete = status === "complete";
  const pageText = run.pages || (Array.isArray(run.selectedPageIds) ? run.selectedPageIds.join(",") : "未记录");
  const succeeded = Number(run.succeeded || run.summary?.succeeded || 0);
  const failedCount = Number(run.failed || run.summary?.failed || 0);
  const title = running
    ? "本批正在重建"
    : complete
      ? "最近一批已完成"
      : failed
        ? "最近一批失败"
        : "最近一批状态";
  const detail = failed && run.failureAnalysis?.reason
    ? run.failureAnalysis.reason
    : running
      ? "页面 worker 正在运行，状态会自动刷新。"
      : complete
        ? "本批页面已经返回，交付门禁会继续检查页面证据。"
        : "可打开日志查看这批页面的详细过程。";
  return (
    <div className={`workflow-agent-worker-run ${status}`}>
      <div>
        <b>{title}</b>
        <span>{uiZh(detail)}</span>
      </div>
      <div className="workflow-agent-worker-run-facts">
        <span><b>{pageText}</b>页码</span>
        <span><b>{succeeded}</b>成功</span>
        <span><b>{failedCount}</b>失败</span>
        <span><b>{run.lowComplexityPageSpec ? "已启用" : "未启用"}</b>低复杂度</span>
      </div>
      <div className="workflow-agent-worker-run-actions">
        {run.logHref ? <a className="btn ghost" href={run.logHref} target="_blank" rel="noreferrer">查看日志</a> : null}
        {run.logDownloadHref ? <a className="btn ghost" href={run.logDownloadHref}>下载日志</a> : null}
      </div>
    </div>
  );
}

function WorkflowDeliverySummary({ artifactBundle, authorizationBusy = "", bundle, job = null, onAuthorizeEditableWorkerSpend, onOpenPageTasks, onOpenWorkflow, onPreviewEditableWorkerStart, onPreviewFinalVisualQaRetry, onPreviewStalePageEvidence, onRefreshDelivery, onRecomposeEditableFinal, onRetryFinalVisualQaPages, onRetryStalePageEvidence, onStartEditableWorker, retryBusy = "", status, workerPreflight = null, workerPreflightBusy = false, workerStartBusy = false }) {
  const validation = bundle?.validation?.data || null;
  const finalGate = bundle?.finalGate || null;
  const stalePageIds = stalePageEvidenceIds(bundle?.pageEvidence);
  const keyLinks = new Set(["final-pptx", "draft-final-pptx", "validation", "source-meta", "image-deck", "log-bundle"]);
  const links = (artifactBundle?.links || []).filter((link) => keyLinks.has(link.key));
  const finalLinks = links.filter((link) => link.key === "final-pptx" || link.key === "draft-final-pptx");
  const evidenceLinks = links.filter((link) => link.key !== "final-pptx" && link.key !== "draft-final-pptx");
  const logBundleLink = links.find((link) => link.key === "log-bundle") || null;
  const finalDownloadState = getFinalDownloadState(finalGate);
  const [manualReviewBusy, setManualReviewBusy] = useState(false);
  const [manualReviewError, setManualReviewError] = useState("");
  const [pageReviewBusy, setPageReviewBusy] = useState("");
  const [pageReviewError, setPageReviewError] = useState("");

  async function approveFinalManualReview() {
    if (!job?.id || manualReviewBusy) return;
    const finalArtifact = bundle?.final?.artifact || job?.artifacts?.editableFinal || null;
    const sourcePages = Number(bundle?.finalGate?.checks?.sourcePages || bundle?.coverage?.sourcePages || job?.sourcePages || job?.sourceMeta?.pageCount || job?.artifacts?.sourceMeta?.pageCount || 0);
    const finalPages = Number(bundle?.finalGate?.checks?.finalPages || bundle?.coverage?.finalPages || finalArtifact?.summary?.page_count || finalArtifact?.pptxEditability?.slideCount || 0);
    const isSampleReview = Boolean(sourcePages && finalPages && finalPages < sourcePages);
    const reviewScopeText = finalPages
      ? isSampleReview
        ? `\n\n本次只记录当前小样本复核：${finalPages}/${sourcePages} 页。完整产品交付仍需要跑完全部页面并重新复核。`
        : `\n\n本次复核范围：${finalPages} 页完整最终 PPT。`
      : "";
    const confirmed = window.confirm(`确认已经逐页对比 codex-ppt 目标图、可编辑预览和页面校验，并将当前最终 PPT 标记为人工复核通过？${reviewScopeText}`);
    if (!confirmed) return;
    setManualReviewBusy(true);
    setManualReviewError("");
    try {
      await api.approveWorkflowManualReview(job.id, {
        reviewer: "operator",
        note: `Final delivery visual review approved from delivery panel${finalPages ? ` for ${finalPages}/${sourcePages || finalPages} page(s)` : ""}.`
      });
      await onRefreshDelivery?.();
    } catch (error) {
      setManualReviewError(getErrorMessage(error));
    } finally {
      setManualReviewBusy(false);
    }
  }

  async function markPageVisualReview(pageId, status) {
    if (!job?.id || !pageId || pageReviewBusy) return null;
    setPageReviewBusy(pageId);
    setPageReviewError("");
    try {
      const result = await api.markWorkflowPageReview(job.id, pageId, {
        status,
        reviewer: "operator",
        note: `Marked ${pageId} as ${status} from page visual review workbench.`
      });
      await onRefreshDelivery?.();
      return result?.artifacts?.pageVisualReview?.marks?.[pageId] || { pageId, status };
    } catch (error) {
      setPageReviewError(getErrorMessage(error));
      return null;
    } finally {
      setPageReviewBusy("");
    }
  }

  return (
    <div className={`workflow-delivery-summary ${status.level}`} id="workflow-delivery-panel">
      <div className="workflow-delivery-head">
        <div>
          <b>{status.title}</b>
          <span>{status.summary}</span>
        </div>
      </div>
      <div className="workflow-delivery-facts">
        {status.facts.map((fact) => (
          <span key={fact.label}><b>{fact.value}</b>{fact.label}</span>
        ))}
      </div>
      {status.nextStep ? (
        <div className="workflow-delivery-next">
          <b>下一步</b>
          <span>{uiZh(status.nextStep.label)}：{uiZh(status.nextStep.reason)}</span>
        </div>
      ) : null}
      {status.warnings.length ? (
        <div className="workflow-delivery-warnings">
          {status.warnings.map((warning) => <span key={warning}>{warning}</span>)}
        </div>
      ) : null}
      {finalGate ? <WorkflowFinalGateV2 gate={finalGate} /> : null}
      {finalGate ? (
        <WorkflowFinalReviewCalloutV2
          finalArtifact={bundle?.final?.artifact || job?.artifacts?.editableFinal || null}
          finalEvidence={bundle?.finalEvidence}
          gate={finalGate}
          manualReview={job?.artifacts?.manualReview || null}
          onApprove={approveFinalManualReview}
          onOpenWorkflow={onOpenWorkflow}
          reviewBusy={manualReviewBusy}
        />
      ) : null}
      {finalGate ? (
        <WorkflowPartialFinalNextPanel
          coverage={bundle?.coverage}
          gate={finalGate}
          onContinueRemaining={onOpenPageTasks || onOpenWorkflow}
          onReviewCurrent={onOpenWorkflow}
        />
      ) : null}
      {manualReviewError ? <p className="workflow-error">{manualReviewError}</p> : null}
      <WorkflowEditableWorkerRecoveryAction
        busy={authorizationBusy === "editable-workers"}
        finalGate={finalGate}
        onAuthorize={onAuthorizeEditableWorkerSpend}
        onOpenPageTasks={onOpenPageTasks || onOpenWorkflow}
        onPreview={onPreviewEditableWorkerStart}
        preflight={workerPreflight}
        preflightBusy={workerPreflightBusy}
        onStart={onStartEditableWorker}
        startBusy={workerStartBusy}
        status={status}
      />
      <WorkflowEditableFinalizeAction
        busy={retryBusy === "editable-finalize"}
        bundle={bundle}
        job={job}
        onRecompose={onRecomposeEditableFinal}
      />
      {stalePageIds.length ? (
        <WorkflowStalePageEvidenceRecoveryV2
          busy={retryBusy === "stale-page-evidence"}
          previewBusy={retryBusy === "stale-page-evidence-preview"}
          onOpenPageTasks={onOpenPageTasks || onOpenWorkflow}
          onPreview={onPreviewStalePageEvidence}
          onRetry={onRetryStalePageEvidence}
          pageIds={stalePageIds}
        />
      ) : null}
      {finalGate ? (
        <WorkflowFinalQualityChecklist
          coverage={bundle?.coverage}
          finalEvidence={bundle?.finalEvidence}
          gate={finalGate}
          pageEvidence={bundle?.pageEvidence}
          validation={validation}
        />
      ) : null}
      <WorkflowPageVisualReviewWorkbench
        artifactBundle={artifactBundle}
        busyPageId={pageReviewBusy}
        onApproveFinalReview={approveFinalManualReview}
        onMarkPage={markPageVisualReview}
        onOpenPageTasks={onOpenPageTasks || onOpenWorkflow}
        pageEvidence={bundle?.pageEvidence}
        pageVisualReview={job?.artifacts?.pageVisualReview || null}
        reviewBusy={manualReviewBusy}
      />
      {pageReviewError ? <p className="workflow-error">{pageReviewError}</p> : null}
      <WorkflowFinalVisualQaPanel
        finalEvidence={bundle?.finalEvidence}
        onOpenPageTasks={onOpenPageTasks || onOpenWorkflow}
        onPreviewRetry={onPreviewFinalVisualQaRetry}
        onRetry={onRetryFinalVisualQaPages}
        retryBusy={retryBusy}
      />
      {finalGate ? (
        <WorkflowManualReviewSummaryV2
          finalArtifact={bundle?.final?.artifact || job?.artifacts?.editableFinal || null}
          gate={finalGate}
          manualReview={job?.artifacts?.manualReview || null}
          onOpenWorkflow={onOpenWorkflow}
        />
      ) : null}
      <WorkflowDeliveryValidationSummary validation={validation} validationBundle={bundle?.validation} />
      <WorkflowDiagnosticBundleSummary link={logBundleLink} status={status} />
      {links.length ? (
        <div className="workflow-delivery-link-groups">
          <div className={`workflow-delivery-link-group final ${finalDownloadState.state}`}>
            <div className="workflow-delivery-link-group-head">
              <b>最终可编辑 PPT</b>
              <span>{finalDownloadState.message}</span>
            </div>
            <div className="workflow-delivery-links">
              {finalLinks.length ? (
                finalLinks.map((link) => (
                  <WorkflowDeliveryArtifactLinkV2
                    finalGate={finalGate}
                    key={`${link.key}-${link.pageId || ""}`}
                    link={link}
                  />
                ))
              ) : (
                <span className="workflow-delivery-missing-link">等待生成新的最终可编辑 PPT</span>
              )}
            </div>
          </div>
          {evidenceLinks.length ? (
            <div className="workflow-delivery-link-group evidence">
              <div className="workflow-delivery-link-group-head">
                <b>中间产物与证据</b>
                <span>图片型 PPT 是 codex-ppt 中间产物，不是最终交付。</span>
              </div>
              <div className="workflow-delivery-links">
                {evidenceLinks.map((link) => (
                  <WorkflowDeliveryArtifactLinkV2
                    finalGate={finalGate}
                    key={`${link.key}-${link.pageId || ""}`}
                    link={link}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {status.nextActions.length ? (
        <div className="workflow-delivery-actions">
          {status.nextActions.map((action) => <span key={action}>{action}</span>)}
        </div>
      ) : null}
    </div>
  );
}

function WorkflowEditableFinalizeAction({ busy = false, bundle = null, job = null, onRecompose }) {
  const gate = bundle?.finalGate || {};
  const checks = gate?.checks || {};
  const coverage = bundle?.coverage || {};
  const sourcePages = Number(checks.sourcePages || coverage.sourcePages || job?.sourcePages || job?.sourceMeta?.pageCount || 0);
  const finalPages = Number(checks.finalPages || coverage.finalPages || job?.finalPages || job?.artifacts?.editableFinal?.summary?.page_count || 0);
  const hasFinal = Boolean(checks.hasFinal || finalPages || bundle?.final?.artifact || job?.artifacts?.editableFinal);
  const isPartial = Boolean(sourcePages && finalPages && finalPages < sourcePages);
  const canRecompose = Boolean(onRecompose && hasFinal);
  if (!hasFinal) return null;
  return (
    <div className={`workflow-editable-finalize-action ${isPartial ? "sample" : "full"}`}>
      <div>
        <b>{isPartial ? "重新合成当前小样本 final" : "重新合成可编辑 final"}</b>
        <span>
          {isPartial
            ? `当前只有 ${finalPages}/${sourcePages} 页。这个动作只刷新小样本草稿，不会解锁最终产品级下载。`
            : "使用已经成功记录的页面重新打包 editable-final.pptx，不调用外部图片 API 或页面重建模型。"}
        </span>
      </div>
      <button className="btn" type="button" onClick={onRecompose} disabled={busy || !canRecompose}>
        {busy ? "正在合成..." : isPartial ? "重新合成小样本 PPT" : "重新合成最终 PPT"}
      </button>
    </div>
  );
}

function WorkflowEditableWorkerRecoveryAction({ busy = false, finalGate = null, onAuthorize, onOpenPageTasks, onPreview, onStart, preflight = null, preflightBusy = false, startBusy = false, status = {} }) {
  if (status?.nextStep?.id !== "start-page-workers") return null;
  const step = status.nextStep || {};
  const readyPages = workflowFactNumber(status, "就绪重建页面");
  const failedPages = workflowFactNumber(status, "失败页面");
  const finalBlocked = finalGate?.level === "blocked";
  const stepAuthorization = step.authorization || {};
  const stepPageSelection = step.pageSelection || (Array.isArray(step.pages) ? step.pages.join(",") : "");
  const stepImageCalls = Number(step.externalImageCalls || stepAuthorization.imageCalls || readyPages || 0);
  const startLabel = readyPages ? `确认并启动 ${readyPages} 页重建` : "确认并启动 worker";
  const authorizeLabel = stepImageCalls ? `授权 ${stepImageCalls} 次图片额度` : "记录页面任务额度授权";
  const external = preflight?.requiredConfirmations?.externalImageSpend || {};
  const llmRecovery = preflight?.requiredConfirmations?.llmProviderRecovered || {};
  if (!readyPages || failedPages) return null;
  return (
    <div className={`workflow-editable-worker-recovery ${finalBlocked ? "blocked" : "ready"}`}>
      <div>
        <b>剩余页面等待转成可编辑 PPT</b>
        <span>这些页面已回到 image-to-editable-ppt 队列。先预检，再授权图片额度，最后启动真实页面 worker。</span>
        <small>预计 {readyPages} 页 / {stepImageCalls || readyPages} 次图片 API 调用；后端启动前还会再次预检 LLM provider、OCR 提示和额度记录。</small>
        {stepAuthorization.required ? (
          <small>
            页面级授权账本：{stepAuthorization.persisted ? "已记录" : "缺少"}；
            页面：{stepPageSelection || "等待预检"}；
            范围：{stepAuthorization.scope || "editable-workers"}。
          </small>
        ) : null}
      </div>
      <div className="workflow-editable-worker-recovery-actions">
        <button className="btn" type="button" onClick={onPreview} disabled={preflightBusy || !onPreview}>
          {preflightBusy ? "预检中..." : "启动前预检"}
        </button>
        <button className="btn" type="button" onClick={onAuthorize} disabled={busy || !onAuthorize}>
          {busy ? "正在记录..." : authorizeLabel}
        </button>
        <button className="btn primary" type="button" onClick={onOpenPageTasks}>
          查看这批页面
        </button>
        <button className="btn danger" type="button" onClick={onStart} disabled={startBusy || !preflight?.startReady || !onStart} title={!preflight?.startReady ? "请先完成启动前预检和额度授权。" : "将启动真实 image-to-editable-ppt 页面 worker，可能消耗外部 API 额度。"}>
          {startBusy ? "启动中..." : startLabel}
        </button>
      </div>
      {preflight ? (
        <div className="workflow-editable-worker-recovery-preflight">
          <div>
            <b>{preflight.startReady ? "预检通过，可以去页面任务区启动" : preflight.ready ? "预检通过，但还需要确认项" : "预检存在阻断项"}</b>
            <span>
              已选择 {(preflight.selectedPageIds || []).join("、") || `${preflight.selectedCount || 0} 页`}；
              图片额度 {external.required ? external.confirmed ? "已确认" : "待确认" : "不需要"}；
              LLM 恢复 {llmRecovery.required ? llmRecovery.confirmed ? "已确认" : "待确认" : "不需要"}。
            </span>
          </div>
          <WorkflowWorkerBatchPreflightPanel bundle={preflight} />
        </div>
      ) : null}
    </div>
  );
}

function workflowFactNumber(status = {}, label = "") {
  const fact = Array.isArray(status.facts) ? status.facts.find((item) => item.label === label) : null;
  const value = Number(fact?.value || 0);
  return Number.isFinite(value) ? value : 0;
}

function workflowWorkerPageIds(status = {}) {
  const nextStep = status?.nextStep || {};
  if (Array.isArray(nextStep.pages)) return nextStep.pages.filter(Boolean);
  if (nextStep.pageSelection) return String(nextStep.pageSelection).split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

function workflowWorkerPageSelection(status = {}) {
  const nextStep = status?.nextStep || {};
  if (nextStep.pageSelection) return String(nextStep.pageSelection).trim();
  return workflowWorkerPageIds(status).join(",");
}

function workflowPreflightPageSelection(preflight = null) {
  if (!preflight) return "";
  if (preflight.startBody?.pages) return String(preflight.startBody.pages).trim();
  if (preflight.pages) return String(preflight.pages).trim();
  if (Array.isArray(preflight.selectedPageIds)) return preflight.selectedPageIds.filter(Boolean).join(",");
  return "";
}

function normalizeWorkflowPageSelection(value = "") {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const number = String(item).match(/(\d+)/)?.[1];
      return number ? `page_${String(Number(number)).padStart(3, "0")}` : item;
    })
    .sort()
    .join(",");
}

function workflowPageSelectionsMatch(left = "", right = "") {
  const normalizedLeft = normalizeWorkflowPageSelection(left);
  const normalizedRight = normalizeWorkflowPageSelection(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function pageNumbersFromWorkflowPageIds(pageIds = []) {
  if (!Array.isArray(pageIds)) return [];
  return pageIds
    .map((pageId) => String(pageId || "").match(/(\d+)/)?.[1])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function WorkflowStalePageEvidenceRecovery({ busy = false, onRetry, pageIds = [] }) {
  return (
    <div className="workflow-failed-recovery stale-evidence">
      <div className="workflow-failed-recovery-head">
        <div>
          <b>页面证据需要重跑</b>
          <span>这些页的 editppt 记录哈希和当前产物不一致，需要重置后重新运行页面任务。</span>
        </div>
        <div className="workflow-failed-recovery-actions">
          <small>{pageIds.length} 页</small>
          <button type="button" onClick={onRetry} disabled={busy}>
            {busy ? "正在重置..." : "重置过期页面证据"}
          </button>
        </div>
      </div>
      <div className="workflow-failed-recovery-list">
        {pageIds.slice(0, 8).map((pageId) => (
          <div className="workflow-failed-recovery-row" key={pageId}>
            <div>
              <b>{pageId}</b>
              <span>可编辑重建页面任务</span>
              <small>重置后进入可编辑页面任务队列重跑</small>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function WorkflowPageEvidenceRecoveryResult({ freshRunBusy = false, onFreshEditableRun, onOpenPageTasks, result = null }) {
  const retried = Number(result?.retried || 0);
  const pages = Array.isArray(result?.stalePageCandidates)
    ? result.stalePageCandidates
    : Array.isArray(result?.candidates)
      ? result.candidates
      : Array.isArray(result?.recovery?.pages)
        ? result.recovery.pages
        : [];
  const preflight = result?.workerBatchPreflight || result?.workerBatchPreview || null;
  const preflightIssues = [...(preflight?.blockingIssues || []), ...(preflight?.warnings || [])].filter(Boolean);
  const needsExternalConfirmation = Boolean(result?.recovery?.externalImageConfirmationRequired);
  const freshEditableRun = result?.freshEditableRun || result?.recovery?.freshEditableRun || null;
  const needsFreshEditableRun = Boolean(freshEditableRun?.required && !freshEditableRun?.refreshed);
  return (
    <div className="workflow-page-evidence-result">
      <div>
        <b>{retried ? "过期证据已重置" : "没有发现过期证据"}</b>
        <span>
          {retried
            ? `已完成 ${retried} 页本地证据重置。下一步进入可编辑重建页面任务区，重新派发并记录这些页面。`
            : "当前没有需要重置的页面证据，可以刷新交付状态或继续检查页面任务。"}
        </span>
        {needsExternalConfirmation ? (
          <small>重置本身不调用外部图片 API；真正重跑页面任务前，仍需要确认 gpt-image-2 等外部图片 API 额度。</small>
        ) : (
          <small>本次操作只更新本地任务证据状态，不会消耗外部 API 额度。</small>
        )}
        {preflight ? (
          <div className={`workflow-page-evidence-preflight ${preflight.startReady ? "ready" : preflight.ready ? "warning" : "blocked"}`}>
            <b>{preflight.startReady ? "页面任务已可启动" : preflight.ready ? "页面任务还需确认" : "页面任务预检未通过"}</b>
            <span>待跑 {preflight.selectedCount || 0} 页：{(preflight.selectedPageIds || []).slice(0, 8).join("、") || "暂无可跑页面"}</span>
            {preflightIssues.length ? <small>{preflightIssues.map(uiZh).join("；")}</small> : null}
          </div>
        ) : null}
        {freshEditableRun?.required ? (
          <div className={`workflow-page-evidence-preflight ${freshEditableRun.refreshed ? "ready" : "warning"}`}>
            <b>{freshEditableRun.refreshed ? "fresh editable run 已重建" : "需要 fresh editable run"}</b>
            <span>这些页已经被旧运行目录接收，不能原地重置；需要先重建可编辑运行目录、提示和页面任务。</span>
            <small>本步骤只做本地准备，不调用外部图片 API；后续重跑可编辑页面任务前仍会要求额度确认。</small>
          </div>
        ) : null}
      </div>
      <div className="workflow-page-evidence-result-actions">
        {pages.length ? <small>{pages.slice(0, 6).join("、")}{pages.length > 6 ? ` 等 ${pages.length} 页` : ""}</small> : null}
        {needsFreshEditableRun ? (
          <button className="btn" type="button" onClick={onFreshEditableRun} disabled={freshRunBusy}>
            {freshRunBusy ? "正在重建..." : "重建可编辑运行目录"}
          </button>
        ) : null}
        <button className="btn primary" type="button" onClick={onOpenPageTasks}>去页面任务区</button>
      </div>
    </div>
  );
}

function getFinalDownloadState(finalGate = null) {
  if (!finalGate) {
    return {
      state: "pending",
      message: "最终可编辑 PPT 生成后会在这里显示下载状态。"
    };
  }
  if (finalGate.productReady) {
    return {
      state: "ready",
      message: "交付门禁已通过，可以下载最终可编辑 PPT。"
    };
  }
  if (finalGate.downloadable) {
    return {
      state: "downloadable",
      message: "当前测试范围已通过阻断门禁，可以下载；完整产品验收仍需覆盖全部源页。"
    };
  }
  const reasons = [...(finalGate.reasons || []), ...(finalGate.warnings || [])].map(String);
  const waitingForReview = finalGate.checks?.hasFinal === true
    && finalGate.checks?.validationPassed === true
    && finalGate.checks?.editabilityPassed === true
    && finalGate.checks?.powerPointOpenable === true
    && finalGate.checks?.noFullSlideRaster === true
    && finalGate.checks?.manualReviewRecorded !== true
    && reasons.some((reason) => reason.includes("final-visual-qa-needs-review") || reason.includes("人工复核") || reason.includes("视觉 QA"));
  if (waitingForReview) {
    return {
      state: "review",
      message: "最终 PPT 已生成并通过结构检查；请先完成页面视觉复核，复核通过后再下载。"
    };
  }
  return {
    state: "blocked",
    message: "最终 PPT 仍有阻断项，需要修复后才能下载。"
  };
}

function WorkflowStalePageEvidenceRecoveryV2({ busy = false, onOpenPageTasks, onPreview, onRetry, pageIds = [], previewBusy = false }) {
  const pagesLabel = pageIds.slice(0, 8).join("、");
  return (
    <div className="workflow-failed-recovery stale-evidence">
      <div className="workflow-failed-recovery-head">
        <div>
          <b>页面证据需要重置</b>
          <span>这些页的可编辑重建记录和当前产物不一致，需要先重置证据，再重新运行页面任务。</span>
          <small>本操作只重置本地任务证据，不会调用外部图片 API；后续重跑页面任务前仍会要求额度确认。</small>
        </div>
        <div className="workflow-failed-recovery-actions">
          <small>{pageIds.length} 页待处理</small>
          <button type="button" onClick={onPreview} disabled={busy || previewBusy}>
            {previewBusy ? "正在预览..." : "预览恢复计划"}
          </button>
          <button type="button" onClick={onRetry} disabled={busy}>
            {busy ? "正在重置..." : "只重置过期证据"}
          </button>
          <button type="button" onClick={onOpenPageTasks}>
            打开页面任务区
          </button>
        </div>
      </div>
      <div className="workflow-recovery-next-steps">
        <span>1. 重置证据：免费，只更新本地状态。</span>
        <span>2. 打开工作流：进入可编辑重建页面任务区。</span>
        <span>3. 重跑页面：确认外部图片 API 额度后再执行。</span>
      </div>
      <div className="workflow-failed-recovery-list">
        {pageIds.slice(0, 8).map((pageId) => (
          <div className="workflow-failed-recovery-row" key={pageId}>
            <div>
              <b>{pageId}</b>
              <span>可编辑重建页面任务</span>
              <small>重置后回到页面任务队列，等待重新派发和记录。</small>
            </div>
          </div>
        ))}
      </div>
      {pageIds.length > 8 ? <small>还有 {pageIds.length - 8} 页未展开显示。</small> : null}
      {pagesLabel ? <small>本次候选页：{pagesLabel}</small> : null}
    </div>
  );
}

function WorkflowDeliveryArtifactLinkV2({ finalGate = null, link }) {
  const isFinal = link.key === "final-pptx";
  const isDraftFinal = link.key === "draft-final-pptx";
  const isLogBundle = link.key === "log-bundle";
  const finalBlocked = isFinal && (finalGate?.downloadable === false || link.blocked);
  const finalDownloadable = isFinal && !finalBlocked && (finalGate?.downloadable === true || finalGate?.productReady === true);
  const linkState = isFinal
    ? finalGate?.productReady
      ? "ready"
      : finalBlocked
        ? "blocked disabled"
        : finalDownloadable
          ? "downloadable"
          : "draft"
    : isDraftFinal
      ? "draft downloadable"
    : isDraftFinal
      ? "小样本草稿"
    : isLogBundle
      ? "diagnostic"
      : "reference";
  const label = isFinal ? link.label || finalGate?.label || "最终 PPTX" : isDraftFinal ? link.label || "小样本草稿 PPTX" : link.label;
  const suffix = isFinal
    ? finalGate?.productReady
      ? "产品可交付"
      : finalBlocked
        ? "文件被阻断"
        : finalDownloadable
          ? "当前范围可下载"
          : "仅草稿"
    : isLogBundle
      ? "诊断"
      : "参考";
  const meta = `${suffix} · ${isLogBundle && !link.size ? "按需生成" : formatFileSize(link.size)} · ${link.fileName}`;
  const blockedReason = uiZh(link.blockedReason || finalGate?.reasons?.[0] || "");
  const nextAction = uiZh(link.nextAction || "先处理交付门禁提示，再下载最终 PPTX。");
  const className = `workflow-delivery-link ${linkState}`;
  if (finalBlocked) {
    return (
      <span
        aria-disabled="true"
        className={className}
        role="link"
        title={blockedReason || "交付门禁阻断，修复后才能下载最终 PPTX"}
      >
        <b>{label}</b>
        <span>{meta}</span>
        {blockedReason ? <small>{blockedReason}</small> : null}
        <small>{nextAction}</small>
      </span>
    );
  }
  return (
    <a className={className} href={link.href} target="_blank" rel="noreferrer">
      <b>{label}</b>
      <span>{meta}</span>
      {isDraftFinal && link.warning ? <small>{uiZh(link.warning)}</small> : null}
    </a>
  );
}

function WorkflowDiagnosticBundleSummary({ link = null, status = {} }) {
  return (
    <div className="workflow-diagnostic-bundle">
      <div>
        <b>诊断包</b>
        <span>{link ? "可下载当前任务的排障证据。" : "任务创建后会提供日志包下载。"}</span>
      </div>
      <div className="workflow-diagnostic-bundle-facts">
        <span>任务状态<b>{uiZh(status.title || "待生成")}</b></span>
        <span>生成方式<b>{link?.size ? "已生成" : "按需生成"}</b></span>
        <span>文件内容<b>状态 / 事件 / 错误 / 产物 / 门禁</b></span>
        <span>安全范围<b>不包含密钥</b></span>
      </div>
      <small>用于把失败现场交给 Agent 复盘：包含 workflow-state.json、events.json、errors.json、artifacts.json、delivery-status.json 和安全日志。</small>
    </div>
  );
}

function WorkflowDeliveryArtifactLink({ finalGate = null, link }) {
  const isFinal = link.key === "final-pptx";
  const isLogBundle = link.key === "log-bundle";
  const finalBlocked = isFinal && finalGate?.downloadable === false;
  const linkState = isFinal
    ? finalGate?.productReady
      ? "ready"
      : finalBlocked
        ? "blocked disabled"
        : "draft"
    : isLogBundle
      ? "diagnostic"
      : "reference";
  const label = isFinal ? finalGate?.label || link.label : link.label;
  const suffix = isFinal
    ? finalGate?.productReady
      ? "产品可交付"
      : finalBlocked
        ? "文件被阻断"
        : "仅草稿"
    : isLogBundle
      ? "诊断"
      : "参考";
  const meta = `${suffix} - ${isLogBundle && !link.size ? "按需生成" : formatFileSize(link.size)} - ${link.fileName}`;
  const className = `workflow-delivery-link ${linkState}`;
  if (finalBlocked) {
    return (
      <span
        aria-disabled="true"
        className={className}
        role="link"
        title="交付门禁阻断，修复后才能下载最终 PPTX"
      >
        <b>{label}</b>
        <span>{meta}</span>
      </span>
    );
  }
  return (
    <a className={className} href={link.href} target="_blank" rel="noreferrer">
      <b>{label}</b>
      <span>{meta}</span>
    </a>
  );
}

function WorkflowFinalGateV2({ gate }) {
  const reasons = Array.isArray(gate?.reasons) ? gate.reasons : [];
  const warnings = Array.isArray(gate?.warnings) ? gate.warnings : [];
  const checks = gate?.checks || {};
  const items = [
    ["validationPassed", "最终校验", checks.validationPassed],
    ["editabilityPassed", "对象可编辑", checks.editabilityPassed],
    ["noFullSlideRaster", "无整页截图", checks.noFullSlideRaster],
    ["pageEvidenceComplete", "页面证据", checks.pageEvidenceComplete],
    ["powerPointOpenable", "PowerPoint 可打开", checks.powerPointOpenable],
    ["manualReviewRecorded", "人工复核", checks.manualReviewRecorded],
    ["fullSourceCoverage", "全页覆盖", checks.fullSourceCoverage]
  ];
  const title = gate?.level === "ready"
    ? "最终交付门禁已通过"
    : gate?.level === "blocked"
      ? "最终交付门禁被阻断"
      : gate?.level === "draft"
        ? "当前仅可作为草稿"
        : "最终交付门禁待处理";
  const summary = checks.hasFinal
    ? "最终 PPTX 已生成；下载前必须通过结构、可编辑性、视觉复核和页数覆盖检查。"
    : "完成可编辑重建后，这里会显示最终 PPTX 的交付检查。";
  return (
    <div className={`workflow-final-gate ${gate?.level || "pending"}`}>
      <div>
        <b>{title}</b>
        <span>{summary}</span>
      </div>
      <div className="workflow-final-gate-checks">
        {items.map(([id, label, passed]) => (
          <span className={passed ? "pass" : "warn"} key={id}>{label}</span>
        ))}
      </div>
      {reasons.length ? (
        <div className="workflow-final-gate-list blocked">
          {reasons.map((reason) => <span key={reason}>{uiZh(reason)}</span>)}
        </div>
      ) : null}
      {warnings.length ? (
        <div className="workflow-final-gate-list">
          {warnings.map((warning) => <span key={warning}>{uiZh(warning)}</span>)}
        </div>
      ) : null}
    </div>
  );
}

function WorkflowFinalReviewCalloutV2({ finalArtifact = null, finalEvidence = null, gate = null, manualReview = null, onApprove, onOpenWorkflow, reviewBusy = false }) {
  const checks = gate?.checks || {};
  const reasons = Array.isArray(gate?.reasons) ? gate.reasons : [];
  const reviewRecorded = checks.manualReviewRecorded === true || manualReview?.status === "approved";
  const hasFinal = checks.hasFinal === true || Boolean(finalArtifact?.path);
  const reviewOnly = hasFinal
    && checks.validationPassed === true
    && checks.editabilityPassed === true
    && checks.powerPointOpenable === true
    && checks.noFullSlideRaster === true
    && !reviewRecorded
    && reasons.some((reason) => reason.includes("final-visual-qa-needs-review") || reason.includes("视觉 QA") || reason.includes("人工复核"));
  if (!reviewOnly) return null;
  const visualQa = finalEvidence?.summary?.visualQa || {};
  const reviewedPages = visualQa?.pageCount || finalEvidence?.summary?.expectedPages || finalArtifact?.summary?.page_count || checks.finalPages || 0;
  const finalSize = finalArtifact?.size || finalEvidence?.summary?.finalSize || 0;
  return (
    <div className="workflow-final-review-callout">
      <div className="workflow-final-review-copy">
        <b>最终 PPT 已生成，等待视觉复核</b>
        <span>结构校验、PowerPoint 打开、对象可编辑和整页截图风险检查已经通过；当前阻断不是文件损坏，而是需要人工对比目标图和可编辑预览。</span>
      </div>
      <div className="workflow-final-review-facts">
        <span>最终文件<b>{finalSize ? formatFileSize(finalSize) : "已生成"}</b></span>
        <span>复核范围<b>{reviewedPages || "待确认"} 页</b></span>
        <span>人工复核<b>未记录</b></span>
        <span>下载状态<b>门禁阻断</b></span>
      </div>
      <div className="workflow-final-review-actions">
        <button className="btn primary" type="button" onClick={onOpenWorkflow} disabled={!onOpenWorkflow}>
          打开页面复核区
        </button>
        <button className="btn success" type="button" onClick={onApprove} disabled={reviewBusy || !onApprove || !hasFinal}>
          {reviewBusy ? "正在记录..." : "标记复核通过"}
        </button>
        <small>在复核区逐页查看 codex-ppt 目标图、可编辑预览、页面校验和资产分离结果。</small>
        <small>复核通过后会解锁当前测试范围下载；完整产品交付仍需要覆盖全部源页。</small>
      </div>
    </div>
  );
}

function WorkflowPartialFinalNextPanel({ coverage = null, gate = null, onContinueRemaining, onReviewCurrent }) {
  const sourcePages = Number(gate?.checks?.sourcePages || coverage?.sourcePages || 0);
  const finalPages = Number(gate?.checks?.finalPages || coverage?.finalPages || 0);
  const remainingPages = Math.max(0, sourcePages - finalPages);
  if (!sourcePages || !finalPages || remainingPages <= 0) return null;
  return (
    <div className="workflow-partial-final-next">
      <div>
        <b>当前是 {finalPages}/{sourcePages} 页小样本</b>
        <span>你可以先复核当前结果，也可以确认额度后继续生成剩余 {remainingPages} 页。</span>
      </div>
      <div className="workflow-partial-final-actions">
        <button className="btn primary" type="button" onClick={onReviewCurrent} disabled={!onReviewCurrent}>
          复核当前 {finalPages} 页样例
        </button>
        <button className="btn" type="button" onClick={onContinueRemaining} disabled={!onContinueRemaining}>
          继续剩余 {remainingPages} 页
        </button>
      </div>
      <small>继续剩余页会再次涉及 gpt-image-2 图片 API 和页面规格模型调用，执行前必须显式确认额度。</small>
    </div>
  );
}

function WorkflowManualReviewSummaryV2({ finalArtifact = null, gate = null, manualReview = null, onOpenWorkflow }) {
  const recorded = gate?.checks?.manualReviewRecorded === true;
  const hasFinal = gate?.checks?.hasFinal === true || Boolean(finalArtifact?.path);
  const sourcePages = Number(gate?.checks?.sourcePages || manualReview?.sourcePages || 0);
  const finalPages = Number(gate?.checks?.finalPages || manualReview?.finalPages || finalArtifact?.summary?.page_count || 0);
  const partialReview = Boolean(sourcePages && finalPages && finalPages < sourcePages);
  const scopeLabel = partialReview ? `小样本 ${finalPages}/${sourcePages}` : recorded ? "完整复核" : "待记录";
  return (
    <div className={`workflow-manual-review-summary ${recorded ? "passed" : hasFinal ? "warn" : "missing"}`}>
      <div className="workflow-manual-review-head">
        <div>
          <b>人工复核门禁</b>
          <span>{recorded ? "已记录与当前最终 PPTX 匹配的人工复核。" : hasFinal ? "最终 PPTX 已生成，但还没有记录人工视觉复核。" : "最终 PPTX 生成后才能记录人工复核。"}</span>
        </div>
        <strong>{recorded ? "已复核" : hasFinal ? "待复核" : "未开始"}</strong>
      </div>
      <div className="workflow-manual-review-facts">
        <span>复核状态<b>{recorded ? "已通过" : "未记录"}</b></span>
        <span>复核页数<b>{manualReview?.reviewedPageCount ?? 0}</b></span>
        <span>复核范围<b>{scopeLabel}</b></span>
        <span>复核人<b>{manualReview?.reviewer || "待记录"}</b></span>
        <span>绑定文件<b>{recorded ? "已匹配" : "待匹配"}</b></span>
      </div>
      {partialReview ? <small>当前人工复核只对应小样本；完整产品交付需要覆盖全部源页面后重新复核。</small> : null}
      {manualReview?.approvedAt ? <small>复核时间：{manualReview.approvedAt}</small> : null}
      {manualReview?.note ? <small>备注：{manualReview.note}</small> : null}
      {!recorded ? (
        <button type="button" onClick={onOpenWorkflow} disabled={!hasFinal}>
          打开页面复核区
        </button>
      ) : null}
    </div>
  );
}

function WorkflowFinalReviewCallout({ finalArtifact = null, finalEvidence = null, gate = null, manualReview = null, onApprove, onOpenWorkflow, reviewBusy = false }) {
  const checks = gate?.checks || {};
  const visualQa = finalEvidence?.summary?.visualQa || null;
  const reasons = [...(gate?.reasons || []), ...(finalEvidence?.issues || []), ...(visualQa?.blockingIssues || [])].map(String);
  const reviewRecorded = checks.manualReviewRecorded === true || manualReview?.status === "approved";
  const hasFinal = checks.hasFinal === true || Boolean(finalArtifact?.path || finalEvidence?.finalPath);
  const reviewOnly = hasFinal
    && gate?.level === "blocked"
    && checks.validationPassed === true
    && checks.editabilityPassed === true
    && checks.powerPointOpenable === true
    && checks.noFullSlideRaster === true
    && !reviewRecorded
    && reasons.some((reason) => reason.includes("final-visual-qa-needs-review") || reason.includes("视觉 QA") || reason.includes("人工复核"));
  if (!reviewOnly) return null;
  const pages = Array.isArray(visualQa?.pages) ? visualQa.pages : [];
  const reviewedPages = pages.length || visualQa?.pageCount || finalEvidence?.summary?.expectedPages || 0;
  const finalSize = finalArtifact?.size || finalEvidence?.summary?.finalSize || 0;
  const pageIssues = Array.isArray(visualQa?.pageIssues) ? visualQa.pageIssues.length : 0;
  return (
    <div className="workflow-final-review-callout">
      <div className="workflow-final-review-copy">
        <b>最终 PPT 已生成，等待视觉复核</b>
        <span>结构校验、PowerPoint 打开性、可编辑对象和整页截图风险已经通过；当前阻断不是文件损坏，而是需要人工对比目标图和可编辑预览后确认。</span>
      </div>
      <div className="workflow-final-review-facts">
        <span>最终文件<b>{finalSize ? formatFileSize(finalSize) : "已生成"}</b></span>
        <span>复核范围<b>{reviewedPages || "待确认"} 页</b></span>
        <span>页面问题<b>{pageIssues ? `${pageIssues} 项` : "未发现"}</b></span>
        <span>人工复核<b>未记录</b></span>
      </div>
      <div className="workflow-final-review-actions">
        <button className="btn primary" type="button" onClick={onOpenWorkflow} disabled={!onOpenWorkflow}>
          打开页面复核区
        </button>
        <button className="btn success" type="button" onClick={onApprove} disabled={reviewBusy || !onApprove || !hasFinal}>
          {reviewBusy ? "正在记录..." : "标记复核通过"}
        </button>
        <small>在复核区逐页查看 codex-ppt 目标图、可编辑预览和页面校验，通过后点击“标记已复核”。</small>
        <small>复核通过后会解锁当前测试范围下载；完整产品交付仍需要覆盖全部源页。</small>
      </div>
    </div>
  );
}

function WorkflowManualReviewSummary({ finalArtifact = null, gate = null, manualReview = null, onOpenWorkflow }) {
  const recorded = gate?.checks?.manualReviewRecorded === true;
  const hasFinal = gate?.checks?.hasFinal === true || Boolean(finalArtifact?.path);
  const reviewStatus = manualReview?.status || "";
  const state = recorded ? "passed" : hasFinal ? "warn" : "missing";
  const sourcePages = Number(gate?.checks?.sourcePages || manualReview?.sourcePages || 0);
  const finalPages = Number(gate?.checks?.finalPages || manualReview?.finalPages || finalArtifact?.summary?.page_count || 0);
  const partialReview = Boolean(sourcePages && finalPages && finalPages < sourcePages);
  const scopeLabel = partialReview ? `小样本 ${finalPages}/${sourcePages}` : recorded ? "完整复核" : "待记录";
  return (
    <div className={`workflow-manual-review-summary ${state}`}>
      <div className="workflow-manual-review-head">
        <div>
          <b>人工复核门禁</b>
          <span>{recorded ? "已记录与当前最终 PPTX 匹配的人工复核。" : hasFinal ? "最终 PPTX 已生成，但还没有记录人工复核。" : "最终 PPTX 生成后才能记录人工复核。"}</span>
        </div>
        <strong>{recorded ? "已复核" : hasFinal ? "待复核" : "未开始"}</strong>
      </div>
      <div className="workflow-manual-review-facts">
        <span>复核状态<b>{reviewStatus === "approved" ? "已批准" : reviewStatus === "reset" ? "已重置" : "未记录"}</b></span>
        <span>复核页数<b>{manualReview?.reviewedPageCount ?? 0}</b></span>
        <span>复核范围<b>{scopeLabel}</b></span>
        <span>复核人<b>{manualReview?.reviewer || "待记录"}</b></span>
        <span>绑定文件<b>{manualReview?.finalSize && finalArtifact?.size === manualReview.finalSize ? "匹配" : recorded ? "已匹配" : "待匹配"}</b></span>
      </div>
      {partialReview ? <small>当前人工复核只对应小样本；完整产品交付需要覆盖全部源页面后重新复核。</small> : null}
      {manualReview?.approvedAt ? <small>复核时间：{manualReview.approvedAt}</small> : null}
      {manualReview?.note ? <small>备注：{manualReview.note}</small> : null}
      {!recorded ? (
        <button type="button" onClick={onOpenWorkflow} disabled={!hasFinal}>
          打开页面复核区
        </button>
      ) : null}
    </div>
  );
}

function WorkflowDeliveryValidationSummary({ validation = null, validationBundle = null }) {
  const exists = validationBundle?.exists === true;
  const artifact = validationBundle?.artifact || null;
  const error = validationBundle?.error || "";
  const issueGroups = buildFinalValidationIssueGroups(validation);
  const issueCount = issueGroups.reduce((sum, group) => sum + group.count, 0);
  const pageCountAligned = Boolean(validation && Number(validation.expected_pages || 0) === Number(validation.slides || 0));
  const state = validation?.passed === true && !issueCount ? "passed" : validation || error ? "warn" : "missing";
  return (
    <div className={`workflow-delivery-validation-summary ${state}`}>
      <div className="workflow-delivery-validation-head">
        <div>
          <b>最终校验</b>
          <span>{validation ? (validation.passed === true ? "校验通过，可以进入交付门禁复核。" : "校验未通过，需要处理问题后再交付。") : exists ? "校验证据存在但读取失败。" : "还没有最终校验证据。"}</span>
        </div>
        <strong>{validation?.passed === true ? "通过" : validation ? "未通过" : "缺失"}</strong>
      </div>
      <div className="workflow-delivery-validation-facts">
        <span>页数<b>{validation ? `${validation.slides ?? "?"}/${validation.expected_pages ?? "?"}` : "待生成"}</b></span>
        <span>页数一致<b>{validation ? (pageCountAligned ? "是" : "否") : "待校验"}</b></span>
        <span>问题数<b>{validation ? issueCount : "待校验"}</b></span>
        <span>文件<b>{artifact?.fileName || artifact?.relativePath || "校验证据"}</b></span>
      </div>
      {issueGroups.length ? (
        <div className="workflow-delivery-validation-issues">
          {issueGroups.map((group) => (
            <span key={group.id}><b>{group.label}</b>{group.summary}</span>
          ))}
        </div>
      ) : validation ? (
        <small>未发现缺页、页面校验失败、契约违规、缺失部件或警告。</small>
      ) : (
        <small>{error || "完成最终合成后，这里会直接展示校验证据摘要。"}</small>
      )}
    </div>
  );
}

function buildFinalValidationIssueGroups(validation = null) {
  if (!validation) return [];
  const groups = [
    ["page_manifests_missing", "页面清单缺失"],
    ["page_validation_missing", "页面校验缺失"],
    ["failed_page_validations", "页面校验失败"],
    ["page_contract_violations", "页面契约违规"],
    ["notes_hash_mismatches", "备注哈希不一致"],
    ["missing_parts", "缺失部件"],
    ["warnings", "警告"]
  ];
  return groups
    .map(([id, label]) => {
      const items = Array.isArray(validation[id]) ? validation[id] : [];
      return {
        id,
        label,
        count: items.length,
        summary: items.length ? `${items.length} 项：${items.slice(0, 2).map((item) => typeof item === "string" ? item : JSON.stringify(item)).join(" / ")}` : "0 项"
      };
    })
    .filter((group) => group.count > 0);
}

function WorkflowFinalGate({ gate }) {
  const reasons = Array.isArray(gate?.reasons) ? gate.reasons : [];
  const warnings = Array.isArray(gate?.warnings) ? gate.warnings : [];
  const checks = gate?.checks || {};
  const invalidatedFinal = gate?.invalidatedFinal || null;
  const gateCopy = finalGateCopy(gate);
  const checkItems = [
    ["validationPassed", "最终校验", checks.validationPassed],
    ["editabilityPassed", "对象可编辑", checks.editabilityPassed],
    ["noFullSlideRaster", "无整页栅格", checks.noFullSlideRaster],
    ["noExperimentalEvidence", "正式链路", checks.noExperimentalEvidence],
    ["codexPptOutlineRecorded", "大纲证据", checks.codexPptOutlineRecorded],
    ["codexPptStyleRecorded", "视觉风格", checks.codexPptStyleRecorded],
    ["codexPptBackendDecisionRecorded", "生图后端证据", checks.codexPptBackendDecisionRecorded],
    ["codexPptApprovalsComplete", "确认关卡", checks.codexPptApprovalsComplete],
    ["codexPptSampleRecorded", "视觉样张", checks.codexPptSampleRecorded],
    ["codexPptBackendFixed", "后端一致", checks.codexPptBackendFixed],
    ["codexPptSlideRunComplete", "图片页任务", checks.codexPptSlideRunComplete],
    ["pageEvidenceComplete", "页面重建证据", checks.pageEvidenceComplete],
    ["finalEvidenceComplete", "最终生成证据", checks.finalEvidenceComplete],
    ["manualReviewRecorded", "人工复核", checks.manualReviewRecorded]
  ];
  return (
    <div className={`workflow-final-gate ${gate?.level || "pending"}`}>
      <div>
        <b>{gateCopy.title}</b>
        <span>{gateCopy.summary}</span>
      </div>
      <div className="workflow-final-gate-checks">
        {checkItems.map(([id, label, passed]) => (
          <span className={passed ? "pass" : "warn"} key={id}>{label}</span>
        ))}
      </div>
      {reasons.length ? (
        <div className="workflow-final-gate-list blocked">
          {reasons.map((reason) => <span key={reason}>{uiZh(reason)}</span>)}
        </div>
      ) : null}
      {warnings.length ? (
        <div className="workflow-final-gate-list">
          {warnings.map((warning) => <span key={warning}>{uiZh(warning)}</span>)}
        </div>
      ) : null}
      {invalidatedFinal?.exists ? (
        <div className="workflow-final-gate-list blocked">
          <span>旧最终 PPT 已作废：磁盘上仍有旧文件，但它不属于当前可编辑重建证据，不能作为交付文件。</span>
          {invalidatedFinal.invalidatedReason ? <span>作废原因：{uiZh(invalidatedFinal.invalidatedReason)}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function finalGateCopy(gate = {}) {
  const checks = gate?.checks || {};
  const reasons = [...(gate?.reasons || []), ...(gate?.warnings || [])].map(String);
  const onlyNeedsVisualReview = gate?.level === "blocked"
    && checks.hasFinal === true
    && checks.validationPassed === true
    && checks.editabilityPassed === true
    && checks.powerPointOpenable === true
    && checks.noFullSlideRaster === true
    && checks.manualReviewRecorded !== true
    && reasons.some((reason) => reason.includes("final-visual-qa-needs-review") || reason.includes("视觉 QA") || reason.includes("人工复核"));
  if (onlyNeedsVisualReview) {
    return {
      title: "最终 PPT 已生成，等待视觉复核",
      summary: "最终文件已经通过结构、打开性和可编辑性检查；下载前还需要人工对比目标图和可编辑预览，并记录复核结果。"
    };
  }
  if (gate?.level === "ready") {
    return {
      title: "最终交付门禁已通过",
      summary: "最终可编辑 PPTX 已通过结构、可编辑性和工作流证据检查，可以作为产品交付。"
    };
  }
  if (gate?.level === "draft") {
    return {
      title: "仅可作为可编辑草稿",
      summary: "最终 PPTX 已存在，但仍有警告项；复核或补齐证据前，不应声明为产品级交付。"
    };
  }
  if (gate?.level === "blocked") {
    return {
      title: "最终交付被阻断",
      summary: "存在必须修复的失败任务、校验失败或证据缺口，当前不能下载为正式最终 PPT。"
    };
  }
  return {
    title: "最终交付门禁待处理",
    summary: "工作流尚未生成最终可编辑 PPTX；请继续页面重建、记录和最终组装。"
  };
}

function WorkflowFinalVisualQaPanel({ finalEvidence = null, onOpenPageTasks, onPreviewRetry, onRetry, retryBusy = "" }) {
  const visualQa = finalEvidence?.summary?.visualQa || null;
  if (!visualQa || visualQa.status === "not_applicable") return null;
  const pages = Array.isArray(visualQa.pages) ? visualQa.pages : [];
  const failedPages = pages.filter((page) => Array.isArray(page.issues) && page.issues.length);
  const statusText = visualQa.status === "pass" ? "通过" : visualQa.status === "failed" ? "未通过" : "待复核";
  const pageText = failedPages.length
    ? `发现 ${failedPages.length}/${visualQa.pageCount || pages.length || 0} 页需要处理`
    : `已检查 ${visualQa.pageCount || pages.length || 0} 页`;
  return (
    <div className={`workflow-final-visual-qa ${visualQa.status}`}>
      <div className="workflow-final-visual-qa-head">
        <div>
          <b>视觉 QA</b>
          <span>对比 codex-ppt 目标图和 image-to-editable-ppt 重建预览，防止结构通过但视觉明显跑偏。</span>
        </div>
        <strong>{statusText}</strong>
      </div>
      <div className="workflow-final-visual-qa-summary">
        <span>检查范围<b>{pageText}</b></span>
        <span>人工复核<b>{visualQa.manualReviewCurrent ? "已记录" : "未记录"}</b></span>
        <span>阻断项<b>{(visualQa.blockingIssues || []).length || 0}</b></span>
      </div>
      {failedPages.length ? (
        <div className="workflow-final-visual-qa-pages">
          {failedPages.slice(0, 8).map((page) => (
            <div className="workflow-final-visual-qa-page" key={page.pageId}>
              <div>
                <b>{page.pageId}</b>
                <span>{page.issues.map(describeVisualQaIssue).join("；")}</span>
              </div>
              <div className="workflow-final-visual-qa-metrics">
                <span>目标图 <b>{formatFileSize(page.targetSize)}</b></span>
                <span>重建预览 <b>{formatFileSize(page.previewSize)}</b></span>
                <span>比例 <b>{formatRatio(page.previewToTargetBytes)}</b></span>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {failedPages.length > 8 ? <small>还有 {failedPages.length - 8} 页未展开，请在高级详情里查看完整证据。</small> : null}
      {visualQa.status === "failed" ? (
        <div className="workflow-final-visual-qa-next">
          <span>下一步：回到页面任务，优先重跑这些失败页；重跑前先检查对话模型额度和 image-to-editable-ppt 页面 worker 证据。</span>
          <div>
            {onPreviewRetry ? (
              <button className="btn ghost" type="button" onClick={onPreviewRetry} disabled={Boolean(retryBusy)}>
                {retryBusy === "final-visual-qa-preview" ? "预检中..." : "预检重跑"}
              </button>
            ) : null}
            {onRetry ? (
              <button className="btn ghost danger" type="button" onClick={onRetry} disabled={Boolean(retryBusy)}>
                {retryBusy === "final-visual-qa-retry" ? "重置中..." : "重置失败页"}
              </button>
            ) : null}
            {onOpenPageTasks ? <button className="btn ghost" type="button" onClick={onOpenPageTasks}>打开页面任务</button> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function describeVisualQaIssue(issue = "") {
  const text = String(issue || "");
  if (text === "preview-too-small-simplified") return "重建预览明显过度简化";
  if (text === "editable-preview-missing") return "缺少可编辑重建预览";
  if (text === "target-visual-missing") return "缺少 codex-ppt 目标图";
  if (text === "preview-aspect-ratio-mismatch") return "预览比例和目标图不一致";
  if (text === "asset-contact-sheet-missing") return "缺少资产分离联系表";
  return uiZh(text);
}

function formatRatio(value = 0) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return "-";
  return `${Math.round(number * 100)}%`;
}

function WorkflowFinalQualityChecklist({ coverage = null, finalEvidence = null, gate, pageEvidence = null, validation = null }) {
  const checks = buildFinalQualityChecks({ coverage, finalEvidence, gate, pageEvidence, validation });
  const passed = checks.filter((check) => check.pass).length;
  return (
    <div className="workflow-final-quality-checklist">
      <div className="workflow-final-quality-head">
        <div>
          <b>最终 QA 清单</b>
          <span>把可编辑 PPTX 视为产品可交付前，必须通过这些硬性检查。</span>
        </div>
        <small>{passed}/{checks.length} 通过</small>
      </div>
      <div className="workflow-final-quality-grid">
        {checks.map((check) => (
          <div className={`workflow-final-quality-item ${check.pass ? "pass" : "warn"}`} key={check.id}>
            <b>{check.label}</b>
            <span>{check.detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function buildFinalQualityChecks({ coverage = null, finalEvidence = null, gate = {}, pageEvidence = null, validation = null }) {
  const gateChecks = gate?.checks || {};
  const pageSummary = pageEvidence?.summary || {};
  const finalIssues = Array.isArray(finalEvidence?.issues) ? finalEvidence.issues : [];
  const sourcePages = Number(coverage?.sourcePages || 0);
  const finalPages = Number(coverage?.finalPages || 0);
  const validationExpected = Number(coverage?.validationExpectedPages || validation?.expected_pages || 0);
  const validationSlides = Number(coverage?.validationSlides || validation?.slides || 0);
  const pageCountPass = Boolean(finalPages && (!sourcePages || finalPages === sourcePages) && (!validationExpected || finalPages === validationExpected) && (!validationSlides || finalPages === validationSlides));
  const codexPass = Boolean(
    gateChecks.codexPptOutlineRecorded
    && gateChecks.codexPptStyleRecorded
    && gateChecks.codexPptBackendDecisionRecorded
    && gateChecks.codexPptApprovalsComplete
    && gateChecks.codexPptSampleRecorded
    && gateChecks.codexPptBackendFixed
    && gateChecks.codexPptSlideRunComplete
  );
  return [
    {
      id: "page-count-parity",
      label: "页数一致性",
      pass: pageCountPass,
      detail: `源文件 ${sourcePages || "?"} / 最终 ${finalPages || "?"} / 校验 ${validationSlides || validationExpected || "?"}`
    },
    {
      id: "page-worker-evidence",
      label: "页面任务证据",
      pass: Boolean(gateChecks.pageEvidenceComplete),
      detail: `${pageSummary.completePages || 0}/${pageSummary.total || 0} 套页面产物完整`
    },
    {
      id: "finalize-evidence",
      label: "最终生成证据",
      pass: Boolean(gateChecks.finalEvidenceComplete),
      detail: finalIssues.length ? `发现 ${finalIssues.length} 个问题` : "运行摘要、校验、输出副本和哈希证据完整"
    },
    {
      id: "validation",
      label: "最终校验",
      pass: Boolean(gateChecks.validationPassed),
      detail: validation ? `${validation.passed === true ? "通过" : "未通过"} / 期望 ${validation.expected_pages ?? "?"} / 幻灯片 ${validation.slides ?? "?"}` : "校验 JSON 未加载"
    },
    {
      id: "editability",
      label: "可编辑性风险",
      pass: Boolean(gateChecks.editabilityPassed && gateChecks.noFullSlideRaster),
      detail: gateChecks.noFullSlideRaster ? "未发现整页栅格风险" : "存在整页栅格风险"
    },
    {
      id: "codex-ppt-evidence",
      label: "视觉统一证据",
      pass: codexPass,
      detail: codexPass ? "审批、后端、样张和图片页运行证据完整" : "缺少视觉统一审批或图片页运行证据"
    },
    {
      id: "manual-review",
      label: "人工复核",
      pass: Boolean(gateChecks.manualReviewRecorded),
      detail: gateChecks.manualReviewRecorded ? "操作员复核已记录" : "仍等待操作员复核"
    }
  ];
}

function WorkflowPageVisualReviewWorkbench({ artifactBundle = null, busyPageId = "", onApproveFinalReview, onMarkPage, onOpenPageTasks, pageEvidence = null, pageVisualReview = null, reviewBusy = false }) {
  const persistedMarks = pageVisualReview?.marks || {};
  const [marks, setMarks] = useState(persistedMarks);
  useEffect(() => {
    setMarks(persistedMarks);
  }, [pageVisualReview?.updatedAt]);
  const pages = Array.isArray(pageEvidence?.pages) ? pageEvidence.pages : [];
  if (!pages.length) return null;
  const linkIndex = buildWorkflowArtifactLinkIndex(artifactBundle?.links || []);
  const completePages = pages.filter((page) => page.complete).length;
  const markedPages = Object.keys(marks).length;
  const persistedSummary = pageVisualReview?.summary || {};
  const incompletePages = pages.length - completePages;
  const canRecordFinalReview = Boolean(pageEvidence?.complete && onApproveFinalReview);
  async function markPage(pageId, value) {
    const previous = marks[pageId] || null;
    setMarks((current) => ({
      ...current,
      [pageId]: {
        ...(typeof previous === "object" ? previous : {}),
        pageId,
        status: value,
        pending: true
      }
    }));
    const saved = await onMarkPage?.(pageId, value);
    if (saved) {
      setMarks((current) => ({ ...current, [pageId]: saved }));
    } else {
      setMarks((current) => {
        const next = { ...current };
        if (previous) next[pageId] = previous;
        else delete next[pageId];
        return next;
      });
    }
  }
  return (
    <div className="workflow-page-review-workbench">
      <div className="workflow-page-review-head">
        <div>
          <b>逐页人工复核</b>
          <span>按页对比 codex-ppt 目标图、可编辑 PPT 预览、页面校验和资产分离结果。</span>
          <small>页面标记用于当前复核视图；真正打开最终下载门禁仍需点击“记录人工复核”。</small>
        </div>
        <div className="workflow-page-review-actions">
          <small>{completePages}/{pages.length} 页证据完整；{markedPages} 页已保存标记；需重跑 {persistedSummary.rerunCount || 0} 页</small>
          <button className="btn ghost" type="button" onClick={onOpenPageTasks} disabled={!onOpenPageTasks}>重跑/查看页面任务</button>
          <button className="btn primary" type="button" onClick={onApproveFinalReview} disabled={!canRecordFinalReview || reviewBusy}>
            {reviewBusy ? "记录中..." : "记录人工复核"}
          </button>
        </div>
      </div>
      {incompletePages ? (
        <div className="workflow-page-review-alert">
          <b>当前还不能做最终产品级复核</b>
          <span>还有 {incompletePages} 页缺少完整证据。先重跑这些页，成功页会保留，失败页单独处理。</span>
        </div>
      ) : null}
      <div className="workflow-page-review-list">
        {pages.map((page) => (
          <WorkflowPageVisualReviewRow
            key={page.pageId}
            busy={busyPageId === page.pageId}
            links={linkIndex.get(page.pageId) || {}}
            mark={marks[page.pageId]?.status || marks[page.pageId] || ""}
            onMark={markPage}
            onOpenPageTasks={onOpenPageTasks}
            page={page}
          />
        ))}
      </div>
    </div>
  );
}

function WorkflowPageVisualReviewRow({ busy = false, links = {}, mark = "", onMark, onOpenPageTasks, page = {} }) {
  const pageId = page.pageId || "";
  const target = links["visual-page"];
  const preview = links["rebuild-preview"];
  const contact = links["asset-contact-sheet"];
  const validation = links["page-validation"];
  const complete = page.complete === true;
  const state = complete ? "complete" : page.status === "failed" ? "failed" : "pending";
  const issues = Array.isArray(page.issues) ? page.issues : [];
  const issueText = issues.length ? issues.slice(0, 4).map(describePageEvidenceIssue).join("；") : "证据完整";
  return (
    <div className={`workflow-page-review-row ${state} ${mark ? `marked-${mark}` : ""}`}>
      <div className="workflow-page-review-title">
        <b>{pageId}</b>
        <span>{complete ? "证据完整，可进入人工视觉复核" : "等待补齐页面重建证据"}</span>
        <small>{issueText}{issues.length > 4 ? `；另有 ${issues.length - 4} 项` : ""}</small>
      </div>
      <div className="workflow-page-review-previews">
        <WorkflowPageReviewThumb link={target} label="目标图" />
        <WorkflowPageReviewThumb link={preview} label="可编辑预览" />
        <WorkflowPageReviewThumb link={contact} label="资产分离" />
      </div>
      <div className="workflow-page-review-evidence">
        <span className={page.validationPassed ? "pass" : "warn"}>校验<b>{page.validationPassed ? "通过" : "缺失/失败"}</b></span>
        <span className={page.pagePptxOpenable ? "pass" : "warn"}>PPT 打开<b>{page.pagePptxOpenable ? "通过" : "失败"}</b></span>
        <span className={page.manifestContractOk ? "pass" : "warn"}>对象证据<b>{page.manifestContractOk ? "完整" : "缺失"}</b></span>
        {validation?.href ? <a href={validation.href} target="_blank" rel="noreferrer">查看校验</a> : <em>校验未生成</em>}
      </div>
      <div className="workflow-page-review-mark">
        <button type="button" className={mark === "pass" ? "active" : ""} onClick={() => onMark?.(pageId, "pass")} disabled={busy || !complete}>{busy ? "保存中" : "通过"}</button>
        <button type="button" className={mark === "accept" ? "active" : ""} onClick={() => onMark?.(pageId, "accept")} disabled={busy || !complete}>暂时接受</button>
        <button type="button" className={mark === "rerun" ? "active danger" : "danger"} onClick={() => onMark?.(pageId, "rerun")} disabled={busy}>需要重跑</button>
        {mark === "rerun" && onOpenPageTasks ? <button type="button" onClick={onOpenPageTasks}>去重跑</button> : null}
      </div>
    </div>
  );
}

function WorkflowPageReviewThumb({ label = "", link = null }) {
  return (
    <a className={`workflow-page-review-thumb ${link?.href ? "ready" : "missing"}`} href={link?.href || undefined} target="_blank" rel="noreferrer" aria-disabled={!link?.href}>
      {link?.href ? <img src={link.href} alt={label} loading="lazy" /> : <span>待生成</span>}
      <b>{label}</b>
    </a>
  );
}

function buildWorkflowArtifactLinkIndex(links = []) {
  const index = new Map();
  for (const link of Array.isArray(links) ? links : []) {
    if (!link?.pageId || !link.key) continue;
    const pageId = String(link.pageId);
    if (!index.has(pageId)) index.set(pageId, {});
    index.get(pageId)[link.key] = link;
  }
  return index;
}

function describePageEvidenceIssue(issue = "") {
  const text = String(issue || "");
  const labels = {
    "missing-dispatch-evidence": "缺少派发记录",
    "missing-page_manifest": "缺少页面对象清单",
    "missing-page_pptx": "缺少单页 PPT",
    "missing-preview": "缺少可编辑预览",
    "missing-contact_sheet": "缺少资产分离图",
    "missing-validation": "缺少页面校验",
    "missing-page_result": "缺少页面结果",
    "validation-not-passed": "页面校验未通过",
    "page-result-shape-invalid": "页面结果格式异常",
    "manifest-json-invalid": "对象清单格式异常",
    "missing-recorded-hashes": "缺少哈希记录",
    "missing-record-evidence": "缺少记录证据",
    "page-pptx-powerpoint-open-failed": "PowerPoint 打开失败"
  };
  if (labels[text]) return labels[text];
  if (text.startsWith("hash-mismatch-")) return "产物哈希不匹配";
  return uiZh(text);
}

function stalePageEvidenceIds(pageEvidence = null) {
  const pages = Array.isArray(pageEvidence?.pages) ? pageEvidence.pages : [];
  return pages
    .filter((page) => Array.isArray(page.issues) && page.issues.some((issue) => /^hash-mismatch-/.test(String(issue || ""))))
    .map((page) => page.pageId)
    .filter(Boolean);
}

function WorkflowCompliancePanel({ artifactBundle = null, bundle, job, onRefresh }) {
  const checks = Array.isArray(bundle?.checks) ? bundle.checks : [];
  const [approvalBusy, setApprovalBusy] = useState("");
  const [approvalError, setApprovalError] = useState("");
  const [approvalPreflights, setApprovalPreflights] = useState({});
  const approvalGates = Array.isArray(bundle?.codexPpt?.approvals?.gates) ? bundle.codexPpt.approvals.gates : [];
  const approvalMap = new Map(approvalGates.map((gate) => [gate.id, gate]));
  const runbook = bundle?.runbook || null;
  const sampleArtifact = job?.artifacts?.visualSample || bundle?.codexPpt?.sample?.artifact || null;
  const sampleLink = (artifactBundle?.links || []).find((link) => link.key === "visual-sample") || null;
  const sampleHref = sampleLink?.href || (job?.id && sampleArtifact?.path ? `/api/workflow-jobs/${encodeURIComponent(job.id)}/artifacts/visual-sample` : "");
  const sampleIsImage = /\.(png|jpe?g|webp|gif|svg)$/i.test(sampleLink?.fileName || sampleArtifact?.path || "");
  const backendRefresh = getBackendRuntimeRefreshState({ bundle, job });
  const approvalGateStates = CODEX_PPT_APPROVAL_GATES.map((gate) => {
    const passed = Boolean(approvalMap.get(gate.id)?.passed);
    const baseUi = getCodexApprovalGateUiState(gate.id, { approvalMap, bundle, job, passed });
    const preflight = approvalPreflights[gate.id] || null;
    return {
      ...gate,
      passed,
      preflight,
      ui: mergeApprovalPreflightUi(baseUi, preflight, passed)
    };
  });
  const readyApprovalGates = approvalGateStates.filter((gate) => !gate.passed && gate.ui.canApprove);
  const readyApprovalGateLabels = formatReadyApprovalGateLabels(readyApprovalGates);
  const sampleGateState = approvalGateStates.find((gate) => gate.id === "sample") || null;
  const sampleLooksNonProduct = looksLikeNonProductVisualSample(sampleArtifact);

  useEffect(() => {
    if (!job?.id) {
      setApprovalPreflights({});
      return undefined;
    }
    let active = true;
    async function loadApprovalPreflights() {
      const entries = await Promise.all(CODEX_PPT_APPROVAL_GATES.map(async (gate) => {
        try {
          return [gate.id, await api.preflightCodexPptGate(job.id, gate.id)];
        } catch (error) {
          return [gate.id, {
            ok: false,
            gate: gate.id,
            ready: false,
            error: getErrorMessage(error),
            blockers: [getErrorMessage(error)]
          }];
        }
      }));
      if (active) setApprovalPreflights(Object.fromEntries(entries));
    }
    loadApprovalPreflights();
    return () => {
      active = false;
    };
  }, [job?.id, bundle?.updatedAt, sampleArtifact?.path, sampleArtifact?.dryRun, backendRefresh.needsRefresh]);

  async function runApproval(gate, action) {
    if (!job?.id || !gate) return;
    setApprovalBusy(`${gate}:${action}`);
    setApprovalError("");
    try {
      if (action === "reset") await api.resetCodexPptGate(job.id, gate);
      else {
        if (gate === "outline" && !job.artifacts?.codexPptOutline?.path) {
          await api.recordCodexPptOutline(job.id, {
            source: "frontend-manual-outline-approval",
            recordedBy: "frontend-skill-first",
            notes: "Auto-recorded before outline approval from current workflow source."
          });
        }
        if (gate === "style" && !job.artifacts?.codexPptStyle?.path) {
          await api.recordCodexPptStyle(job.id, {
            source: "frontend-manual-style-approval",
            recordedBy: "frontend-skill-first",
            notes: "Auto-recorded before style approval from current workflow source."
          });
        }
        if (gate === "backend" && !job.artifacts?.codexPptBackendDecision?.path) {
          await api.recordCodexPptBackend(job.id, {
            source: "frontend-manual-backend-approval",
            recordedBy: "frontend-skill-first",
            notes: "Auto-recorded before backend approval from current provider configuration."
          });
        }
        const preflight = await api.preflightCodexPptGate(job.id, gate, { note: `frontend-${gate}-approval` });
        if (!preflight.ready && !preflight.passed) {
          throw new Error(preflight.error || `codex-ppt ${gate} approval is not ready`);
        }
        await api.approveCodexPptGate(job.id, gate, { note: `frontend-${gate}-approval` });
      }
      await onRefresh?.();
    } catch (error) {
      setApprovalError(getErrorMessage(error));
    } finally {
      setApprovalBusy("");
    }
  }

  async function refreshBackendRuntimeApproval() {
    if (!job?.id || !backendRefresh.needsRefresh) return;
    setApprovalBusy("backend:refresh-runtime");
    setApprovalError("");
    try {
      await api.refreshCodexPptBackendApproval(job.id, {
        source: "frontend-runtime-backend-refresh",
        recordedBy: "frontend-skill-first",
        policy: "使用当前已配置的外部图片运行环境生成 codex-ppt 产品级视觉页。",
        fallbackStatus: "产品级视觉生成不接受回归验证、透传、本地绘制、页面截图或手工叠加作为替代证据。",
        notes: `已从 ${backendRefresh.approvedLabel || "旧后端证据"} 刷新到 ${backendRefresh.runtimeLabel || "当前图片运行环境"}。`,
        note: "frontend-runtime-backend-refresh",
        approvedBy: "frontend-skill-first",
        reason: "frontend runtime backend approval refresh"
      });
      await onRefresh?.();
    } catch (error) {
      setApprovalError(getErrorMessage(error));
    } finally {
      setApprovalBusy("");
    }
  }

  async function approveReadyGates() {
    if (!job?.id || !readyApprovalGates.length) return;
    setApprovalBusy("ready:approve");
    setApprovalError("");
    try {
      for (const gate of readyApprovalGates) {
        const preflight = await api.preflightCodexPptGate(job.id, gate.id, { note: `frontend-ready-${gate.id}-approval` });
        if (!preflight.ready && !preflight.passed) {
          throw new Error(preflight.error || `codex-ppt ${gate.id} approval is not ready`);
        }
        await api.approveCodexPptGate(job.id, gate.id, { note: `frontend-ready-${gate.id}-approval` });
      }
      await onRefresh?.();
    } catch (error) {
      setApprovalError(getErrorMessage(error));
    } finally {
      setApprovalBusy("");
    }
  }

  if (!bundle && !checks.length) {
    return (
      <div className="workflow-compliance-panel pending" id="workflow-compliance-panel">
        <div className="workflow-compliance-head">
          <div>
            <b>Skill 路径等待检查</b>
            <span>等待工作流诊断结果。</span>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className={`workflow-compliance-panel ${bundle.level || "pending"}`} id="workflow-compliance-panel">
      <div className="workflow-compliance-head">
        <div>
          <b>{uiZh(bundle.title || "Skill 路径状态")}</b>
          <span>{uiZh(bundle.summary || "正在检查 codex-ppt 和 image-to-editable-ppt 对齐情况。")}</span>
        </div>
        <small>{bundle.updatedAt ? new Date(bundle.updatedAt).toLocaleTimeString() : ""}</small>
      </div>
      <div className="workflow-compliance-grid">
        {checks.map((check) => (
          <div className={`workflow-compliance-check ${check.status || "pending"}`} key={check.id}>
            <span>{uiZh(check.status || "pending")}</span>
            <b>{uiZh(check.label)}</b>
            <small>{uiZh(check.detail)}</small>
          </div>
        ))}
      </div>
      <div className="workflow-compliance-counts">
        <span><b>{bundle.counts?.approvalGates ?? 0}/{bundle.counts?.approvalGatesTotal ?? 0}</b> 关卡</span>
        <span><b>{bundle.counts?.visualPages ?? 0}</b> 视觉页</span>
        <span><b>{bundle.counts?.textHintPages ?? 0}/{bundle.counts?.textHintPagesTotal ?? 0}</b> 文字提示</span>
        <span><b>{bundle.counts?.promptPages ?? 0}</b> 页面提示</span>
        <span><b>{bundle.counts?.recordedPages ?? 0}</b> 已记录</span>
        <span><b>{bundle.counts?.pageEvidencePages ?? 0}/{bundle.counts?.pageEvidenceTotal ?? 0}</b> 页面证据</span>
        <span><b>{bundle.counts?.finalEvidenceComplete ? "通过" : "检查"}</b> 最终证据</span>
        <span><b>{bundle.editppt?.doctor?.ok ? "通过" : "检查"}</b> doctor</span>
        <span><b>{uiZh(bundle.editppt?.nextStage || "unknown")}</b> editppt 下一步</span>
      </div>
      {runbook ? <WorkflowSkillRunbook runbook={runbook} /> : null}
      <div className="workflow-approval-toolbar">
        <div>
          <b>codex-ppt 确认关卡</b>
          <span>{readyApprovalGates.length ? `可无费用确认：${readyApprovalGateLabels}` : "还没有可确认的关卡。"}</span>
          <small>确认这些关卡只记录证据，不会生成图片；样张和全量图片前会另行要求外部图片 API 授权。</small>
        </div>
        <button type="button" onClick={approveReadyGates} disabled={!job?.id || !readyApprovalGates.length || approvalBusy === "ready:approve"}>
          {approvalBusy === "ready:approve" ? "正在确认..." : "确认所有就绪关卡（不生成图片）"}
        </button>
      </div>
      {backendRefresh.needsRefresh ? (
        <div className="workflow-backend-refresh">
          <div>
            <b>需要刷新后端运行环境确认</b>
            <span>{uiZh(backendRefresh.reason)}</span>
            <small>{backendRefresh.approvedLabel || "缺少已确认后端"} -&gt; {backendRefresh.runtimeLabel || "缺少当前运行环境"}</small>
          </div>
          <button type="button" onClick={refreshBackendRuntimeApproval} disabled={!job?.id || approvalBusy === "backend:refresh-runtime"}>
            {approvalBusy === "backend:refresh-runtime" ? "正在刷新..." : "刷新后端确认"}
          </button>
        </div>
      ) : null}
      {sampleArtifact?.path ? (
        <div className={`workflow-sample-evidence ${sampleLooksNonProduct ? "warning" : ""}`}>
          <div>
            <b>视觉样张证据</b>
            <span>{sampleLooksNonProduct ? "这个样张像验证链路或透传证据。请先重新生成产品级样张，再审批。" : "审批样张前请先检查这张图。全量图片生成只能在样张审批后进行。"}</span>
          </div>
          {sampleHref ? <a href={sampleHref} target="_blank" rel="noreferrer">打开样张</a> : null}
          {sampleHref && sampleIsImage ? <img src={sampleHref} alt="codex-ppt 视觉样张" /> : null}
        </div>
      ) : null}
      <SampleApprovalGuard
        gate={sampleGateState}
        sampleArtifact={sampleArtifact}
        sampleHref={sampleHref}
        sampleLooksNonProduct={sampleLooksNonProduct}
      />
      <div className="workflow-approval-gates">
        {approvalGateStates.map((gate) => {
          const gateUi = gate.ui;
          const passed = gate.passed;
          const blockers = Array.isArray(gateUi.blockers) && gateUi.blockers.length
            ? gateUi.blockers
            : !passed && !gateUi.canApprove
              ? [gateUi.reason]
              : [];
          return (
            <div className={`workflow-approval-gate ${gateUi.status}`} key={gate.id}>
              <span>{gateUi.label}</span>
              <b>{gate.label}</b>
              <small>{uiZh(gateUi.reason)}</small>
              {gate.preflight && !passed ? (
                <small className="workflow-approval-preflight">
                  后端预检：{gate.preflight.ready ? "就绪" : uiZh(gate.preflight.code || "blocked")}
                </small>
              ) : null}
              {blockers.length ? (
                <div className="workflow-approval-blockers">
                  {blockers.slice(0, 3).map((blocker) => <em key={blocker}>{uiZh(blocker)}</em>)}
                </div>
              ) : null}
              <div className="workflow-approval-gate-actions">
                <button
                  type="button"
                  title={!gateUi.canApprove && !passed ? gateUi.reason : ""}
                  onClick={() => runApproval(gate.id, "approve")}
                  disabled={!job?.id || approvalBusy === `${gate.id}:approve` || passed || !gateUi.canApprove}
                >批准</button>
                <button type="button" onClick={() => runApproval(gate.id, "reset")} disabled={!job?.id || approvalBusy === `${gate.id}:reset` || !passed}>重置</button>
              </div>
            </div>
          );
        })}
      </div>
      {approvalError ? <p className="workflow-error">{approvalError}</p> : null}
      {bundle.warnings?.length ? (
        <div className="workflow-compliance-warnings">
          {bundle.warnings.map((warning) => <span key={warning}>{uiZh(warning)}</span>)}
        </div>
      ) : null}
      {bundle.nextActions?.length ? (
        <div className="workflow-compliance-actions">
          {bundle.nextActions.map((action) => <span key={action}>{uiZh(action)}</span>)}
        </div>
      ) : null}
    </div>
  );
}

function WorkflowSkillRunbook({ runbook }) {
  const steps = Array.isArray(runbook?.steps) ? runbook.steps : [];
  return (
    <div className={`workflow-runbook ${runbook?.level || "working"}`}>
      <div className="workflow-runbook-head">
        <div>
          <b>{uiZh(runbook?.currentTitle || "任务运行手册")}</b>
          <span>{uiZh(runbook?.summary || "等待下一步 PPT 重制任务。")}</span>
        </div>
        <small>{uiZh(runbook?.level || "working")}</small>
      </div>
      <div className="workflow-runbook-steps">
        {steps.map((step) => (
          <div className={`workflow-runbook-step ${step.status || "pending"}`} key={step.id}>
            <span>{uiZh(step.status || "pending")}</span>
            <b>{uiZh(step.title)}</b>
            <small>{uiZh(step.action || step.summary)}</small>
          </div>
        ))}
      </div>
      {runbook?.allowedActions?.length ? (
        <div className="workflow-runbook-actions">
          {runbook.allowedActions.map((action) => <span key={action}>{uiZh(action)}</span>)}
        </div>
      ) : null}
      {runbook?.blockers?.length ? (
        <div className="workflow-runbook-blockers">
          {runbook.blockers.map((blocker) => <span key={blocker}>{uiZh(blocker)}</span>)}
        </div>
      ) : null}
    </div>
  );
}

function buildWorkflowReviewRows(links = []) {
  const rows = new Map();
  for (const link of links) {
    if (!link?.pageId || !["rendered-page", "visual-page", "rebuild-preview", "final-compare", "page-validation", "page-result", "page-pptx"].includes(link.key)) continue;
    const row = rows.get(link.pageId) || { pageId: link.pageId, source: null, visual: null, rebuild: null, validation: null, result: null, pptx: null };
    if (link.key === "rendered-page") row.source = link;
    if (link.key === "visual-page") row.visual = link;
    if (link.key === "rebuild-preview") row.rebuild = link;
    if (link.key === "final-compare") row.compare = link;
    if (link.key === "page-validation") row.validation = link;
    if (link.key === "page-result") row.result = link;
    if (link.key === "page-pptx") row.pptx = link;
    rows.set(link.pageId, row);
  }
  return [...rows.values()].sort((a, b) => a.pageId.localeCompare(b.pageId));
}

function countWorkflowPageValidationIssues(data = {}) {
  return [
    data.missing_required_text,
    data.missing_parts,
    data.missing_relationship_targets,
    data.missing_asset_provenance,
    data.missing_manifest_images,
    data.missing_provenance_sources,
    data.invalid_asset_provenance,
    data.media_hash_mismatches,
    data.page_contract_violations,
    data.warnings
  ].reduce((total, items) => total + (Array.isArray(items) ? items.length : 0), data.media_manifest_mismatch ? 1 : 0);
}

function summarizeWorkflowPageValidationIssues(data = {}) {
  const parts = [
    ["missing text", data.missing_required_text],
    ["missing parts", data.missing_parts],
    ["missing relationships", data.missing_relationship_targets],
    ["missing asset provenance", data.missing_asset_provenance],
    ["invalid asset provenance", data.invalid_asset_provenance],
    ["hash mismatch", data.media_hash_mismatches],
    ["page contract", data.page_contract_violations],
    ["warnings", data.warnings]
  ].filter(([, items]) => Array.isArray(items) && items.length);
  if (data.media_manifest_mismatch) parts.push(["media manifest mismatch", [true]]);
  return parts.map(([label, items]) => `${label} ${items.length}`).join(" / ");
}

function formatFileSize(size = 0) {
  const value = Number(size || 0);
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function WorkflowArtifact({ label, value }) {
  return (
    <div className="workflow-artifact">
      <span>{label}</span>
      <b title={String(value || "")}>{value || "pending"}</b>
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
                  {selectedSlide === index && dirty ? <SlideVisual slide={liveSlide} job={job} slideIndex={index} compact /> : job.previewImages?.[index] ? <img src={job.previewImages[index]} alt={"page " + (index + 1)} /> : <SlideVisual slide={slide} job={job} slideIndex={index} compact />}
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <b>{selectedSlide === index && dirty ? liveSlide.title : slide.title}</b>
                </button>
                <div className="rail-actions">
                  <button type="button" title="上移" onClick={() => onSlideAction?.("move-up", { slideIndex: index })} disabled={!job || dirty || index === 0}>上移</button>
                  <button type="button" title="下移" onClick={() => onSlideAction?.("move-down", { slideIndex: index })} disabled={!job || dirty || index >= slides.length - 1}>下移</button>
                  <button type="button" title="复制" onClick={() => onSlideAction?.("duplicate", { slideIndex: index })} disabled={!job || dirty}>复制</button>
                  <button type="button" title="删除" className="danger" onClick={() => onSlideAction?.("delete", { slideIndex: index })} disabled={!job || dirty || slides.length <= 1}>删除</button>
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
      <span>{files.length ? `已上传 ${files.length} 个文件` : "等待上传或输入简述"}</span>
      <span>{outlinePlan?.layoutSequence?.length ? `大纲 ${outlinePlan.layoutSequence.length} 页` : "请先生成或确认大纲"}</span>
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
        <span key={`${step.layout}-${index}`}>{String(index + 1).padStart(2, "0")} / {step.title || step.layout}</span>
      )) : <span>还没有大纲。请先在中间面板生成可确认的大纲。</span>}
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
          {actions.has("apply-image-supplement") ? <button className={blocked ? "btn primary" : "btn ghost"} type="button" onClick={onApplyImageSupplement}>{blocked ? "先复用已有绑定素材" : "可选：绑定已有素材"}</button> : null}
          {actions.has("apply-local-image-supplement") ? <button className="btn primary" type="button" onClick={onApplyLocalImageSupplement} disabled={localImage?.state !== "online"}>{localImage?.state === "online" ? "生成本地补图" : "等待本地生图服务"}</button> : null}
          {actions.has("rescan-local-image-qa") ? <button className="btn ghost" type="button" onClick={onRescanLocalImageQa}>重新扫描图片 QA</button> : null}
        </div>
      ) : null}
    </div>
  );
}

function PreviewCanvas({ currentImage, currentSlide, draft, dirty, editBlocked = false, focusPreview, job, liveSlide, selectedSlide, setFocusPreview, setSelectedSlide, slides, updateDraft, onSaveText, onRetryPreview, previewBusy }) {
  const editableSlide = dirty ? liveSlide : currentSlide;
  const [layerMode, setLayerMode] = useState("preview");
  const textLayerActive = layerMode === "text";
  const assetLayerActive = layerMode === "asset";
  const shapeLayerActive = layerMode === "shape";
  return (
    <div className={`preview-stage ${focusPreview ? "focus" : ""} layer-${layerMode}`}>
      <HybridPreviewStrip job={job} currentImage={currentImage} selectedSlide={selectedSlide} />
      <div className="stage-toolbar">
        <div>
          <b>{dirty ? liveSlide?.title : currentSlide?.title || "等待生成"}</b>
          <span>第 {selectedSlide + 1} 页 / {LAYOUT_LABELS[currentSlide?.layout] || currentSlide?.layout || "自动版式"}{(dirty ? liveSlide?.storyRole : currentSlide?.storyRole) ? ` / ${dirty ? liveSlide?.storyRole : currentSlide?.storyRole}` : ""}</span>
        </div>
        <div className="stage-controls">
          <button className={layerMode === "preview" ? "active" : ""} onClick={() => setLayerMode("preview")} disabled={!job}>预览</button>
          <button className={layerMode === "asset" ? "active" : ""} onClick={() => setLayerMode("asset")} disabled={!job || editBlocked}>素材层</button>
          <button className={layerMode === "shape" ? "active" : ""} onClick={() => setLayerMode("shape")} disabled={!job || editBlocked}>图形层</button>
          <button className={layerMode === "text" ? "active" : ""} onClick={() => setLayerMode("text")} disabled={!job || editBlocked}>文字层</button>
          <button onClick={() => setSelectedSlide((value) => Math.max(0, value - 1))} disabled={!job || selectedSlide === 0}>上一页</button>
          <button onClick={() => setSelectedSlide((value) => Math.min(slides.length - 1, value + 1))} disabled={!job || selectedSlide >= slides.length - 1}>下一页</button>
          <button onClick={() => setFocusPreview((value) => !value)} disabled={!job}>{focusPreview ? "返回编辑" : "专注预览"}</button>
        </div>
      </div>
      {currentSlide ? <LayerSeparationBar slide={editableSlide} job={job} slideIndex={selectedSlide} layerMode={layerMode} /> : null}
      <div className="large-slide">
        <div className="editable-slide-stage">
          {currentImage && layerMode === "preview" ? <img src={currentImage} alt={`第 ${selectedSlide + 1} 页预览`} /> : currentSlide ? <LayerBaseCanvas slide={editableSlide} job={job} slideIndex={selectedSlide} layerMode={layerMode} /> : <div className="empty-preview">生成后会在这里显示预览</div>}
          {currentSlide && assetLayerActive ? <CanvasAssetLayer draft={draft} slide={editableSlide} job={job} slideIndex={selectedSlide} updateDraft={updateDraft} onSave={() => onSaveText?.(draft)} /> : null}
          {currentSlide && shapeLayerActive ? <CanvasShapeLayer draft={draft} slide={editableSlide} updateDraft={updateDraft} onSave={() => onSaveText?.(draft)} /> : null}
          {currentSlide && textLayerActive ? <CanvasTextLayer draft={draft} slide={editableSlide} updateDraft={updateDraft} onSave={() => onSaveText?.(draft)} /> : null}
        </div>
      </div>
      {job?.previewWarning ? <div className="preview-warning"><div><b>PNG 预览未生成，暂时使用网页预览。</b><span>{job.previewWarning}</span></div><button type="button" onClick={onRetryPreview} disabled={previewBusy}>{previewBusy ? "正在重试" : "重新生成预览图"}</button></div> : null}
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
        <span>{sample.status === "generated" ? "方向图已生成" : uiZh(job.visualProject?.status || "pending")} / 不可编辑中间产物</span>
      </div>
      <div>
        <b>可编辑结果</b>
        <span>{currentImage ? `第 ${selectedSlide + 1} 页预览` : "等待 PPTX 渲染"} / 最终可编辑 PPT</span>
      </div>
      <div>
        <b>一致性</b>
        <span>{compare.score ? `${compare.score}/100` : "等待 QA"}</span>
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
  const decorationCount = buildCanvasShapeObjects(slide).length;
  return (
    <div className="layer-separation-bar">
      <span className={hasBackground ? "active" : ""}>底图 {hasBackground ? 1 : 0}</span>
      <span className={layerMode === "asset" || materialCount ? "active" : ""}>素材 {materialCount}</span>
      <span className={layerMode === "text" ? "active" : ""}>文字 {textCount}</span>
      <span className={layerMode === "shape" ? "active" : ""}>图形 {decorationCount}</span>
      <em>{layerMode === "text" ? "正在编辑文字层：拖动蓝色标签后保存回 PPTX。" : layerMode === "asset" ? "正在编辑素材层：拖动图片或从角落调整尺寸。" : layerMode === "shape" ? "正在编辑图形层：调整强调线、卡片和装饰块。" : "干净预览：已隐藏编辑框，避免遮挡预览图。"}</em>
    </div>
  );
}

function CanvasAssetLayer({ draft = {}, slide = {}, job, slideIndex = 0, updateDraft, onSave }) {
  const [gesture, setGesture] = useState(null);
  const [selectedLayerId, setSelectedLayerId] = useState("");
  const objects = useMemo(() => buildCanvasAssetObjects(job, slide, slideIndex), [job, slide, slideIndex]);
  const edits = normalizeCanvasEdits(draft.canvasEdits || slide.canvasEdits, objects);
  const selectedObject = objects.find((item) => item.key === selectedLayerId) || objects[0] || null;
  const selectedEdit = selectedObject ? edits[selectedObject.key] || selectedObject : null;

  useEffect(() => {
    if (!selectedLayerId && objects[0]?.key) setSelectedLayerId(objects[0].key);
    if (selectedLayerId && !objects.some((item) => item.key === selectedLayerId)) setSelectedLayerId(objects[0]?.key || "");
  }, [objects, selectedLayerId]);

  function patchCanvasEdit(key, patch) {
    const current = normalizeCanvasEdits(draft.canvasEdits || slide.canvasEdits, objects);
    updateDraft?.("canvasEdits", {
      ...current,
      [key]: { ...current[key], type: "image", ...patch }
    });
  }

  function startGesture(event, key, mode = "move") {
    event.preventDefault();
    event.stopPropagation();
    const box = edits[key]?.box || objects.find((item) => item.key === key)?.box;
    if (!box) return;
    setSelectedLayerId(key);
    setGesture({ key, mode, startX: event.clientX, startY: event.clientY, box: { ...box } });
  }

  useLayerGesture(gesture, setGesture, patchCanvasEdit, onSave);

  return (
    <div className="canvas-asset-layer">
      {selectedObject ? (
        <div className="layer-property-panel">
          <b>{selectedObject.label}</b>
          <label>适配<select value={selectedEdit?.fit || "contain"} onChange={(event) => patchCanvasEdit(selectedObject.key, { fit: event.target.value })}><option value="contain">完整显示</option><option value="cover">填满裁切</option></select></label>
          <label>透明度<input type="number" min="0.15" max="1" step="0.05" value={selectedEdit?.opacity ?? 1} onChange={(event) => patchCanvasEdit(selectedObject.key, { opacity: Number(event.target.value) })} /></label>
          <span>图片使用完整显示或填满裁切，避免变形。</span>
        </div>
      ) : null}
      {objects.length ? objects.map((object) => {
        const edit = edits[object.key] || object;
        const box = edit.box || object.box;
        return (
          <figure
            className={`canvas-asset-box ${selectedLayerId === object.key ? "selected" : ""}`}
            key={object.key}
            onClick={(event) => { event.stopPropagation(); setSelectedLayerId(object.key); }}
            onPointerDown={(event) => startGesture(event, object.key, "move")}
            style={{ left: `${box.x}%`, top: `${box.y}%`, width: `${box.w}%`, height: `${box.h}%`, opacity: edit.opacity ?? object.opacity ?? 1 }}
          >
            <img src={object.image.uploadUrl} alt={object.image.originalName || "asset image"} style={{ objectFit: edit.fit || object.fit || "contain" }} draggable="false" />
            <figcaption>{object.label} / {object.image.originalName || "未命名"}</figcaption>
            <button className="canvas-resize-handle" type="button" aria-label="缩放素材" onPointerDown={(event) => startGesture(event, object.key, "resize")} />
          </figure>
        );
      }) : <div className="canvas-empty-layer">这一页还没有绑定素材图。请填写图片槽位和素材名，或让 agent 重新匹配素材。</div>}
    </div>
  );
}

function CanvasShapeLayer({ draft = {}, slide = {}, updateDraft, onSave }) {
  const [gesture, setGesture] = useState(null);
  const [selectedLayerId, setSelectedLayerId] = useState("");
  const objects = useMemo(() => buildCanvasShapeObjects(slide), [slide]);
  const edits = normalizeCanvasEdits(draft.canvasEdits || slide.canvasEdits, objects);
  const selectedObject = objects.find((item) => item.key === selectedLayerId) || objects[0] || null;
  const selectedEdit = selectedObject ? edits[selectedObject.key] || selectedObject : null;

  useEffect(() => {
    if (!selectedLayerId && objects[0]?.key) setSelectedLayerId(objects[0].key);
    if (selectedLayerId && !objects.some((item) => item.key === selectedLayerId)) setSelectedLayerId(objects[0]?.key || "");
  }, [objects, selectedLayerId]);

  function patchCanvasEdit(key, patch) {
    const current = normalizeCanvasEdits(draft.canvasEdits || slide.canvasEdits, objects);
    updateDraft?.("canvasEdits", {
      ...current,
      [key]: { ...current[key], type: "shape", ...patch }
    });
  }

  function startGesture(event, key, mode = "move") {
    event.preventDefault();
    event.stopPropagation();
    const box = edits[key]?.box || objects.find((item) => item.key === key)?.box;
    if (!box) return;
    setSelectedLayerId(key);
    setGesture({ key, mode, startX: event.clientX, startY: event.clientY, box: { ...box } });
  }

  useLayerGesture(gesture, setGesture, patchCanvasEdit, onSave);

  return (
    <div className="canvas-shape-layer">
      {selectedObject ? (
        <div className="layer-property-panel">
          <b>{selectedObject.label}</b>
          <label>填充<input type="color" value={selectedEdit?.fill || selectedObject.fill} onChange={(event) => patchCanvasEdit(selectedObject.key, { fill: event.target.value })} /></label>
          <label>描边<input type="color" value={selectedEdit?.line || selectedObject.line} onChange={(event) => patchCanvasEdit(selectedObject.key, { line: event.target.value })} /></label>
          <label>圆角<input type="number" min="0" max="24" value={selectedEdit?.radius ?? selectedObject.radius} onChange={(event) => patchCanvasEdit(selectedObject.key, { radius: Number(event.target.value) })} /></label>
          <label>透明度<input type="number" min="0.1" max="1" step="0.05" value={selectedEdit?.opacity ?? selectedObject.opacity} onChange={(event) => patchCanvasEdit(selectedObject.key, { opacity: Number(event.target.value) })} /></label>
        </div>
      ) : null}
      {objects.map((object) => {
        const edit = edits[object.key] || object;
        const box = edit.box || object.box;
        return (
          <div
            className={`canvas-shape-box ${selectedLayerId === object.key ? "selected" : ""}`}
            key={object.key}
            onClick={(event) => { event.stopPropagation(); setSelectedLayerId(object.key); }}
            onPointerDown={(event) => startGesture(event, object.key, "move")}
            style={{
              left: `${box.x}%`,
              top: `${box.y}%`,
              width: `${box.w}%`,
              height: `${box.h}%`,
              background: edit.fill || object.fill,
              borderColor: edit.line || object.line,
              borderRadius: `${edit.radius ?? object.radius}px`,
              opacity: edit.opacity ?? object.opacity
            }}
          >
            <span>{object.label}</span>
            <button className="canvas-resize-handle" type="button" aria-label="缩放图形" onPointerDown={(event) => startGesture(event, object.key, "resize")} />
          </div>
        );
      })}
    </div>
  );
}

function EditorPanel({ deckRevision, dirty, draft, job, revision, savedDraft, setDeckRevision, setDraft, setRevision, updateDraft, onQuickAction, onRevise, onSaveText, onRewriteDeck, onUndoJob }) {
  return (
    <aside className="editor-panel">
      <div className="edit-mode-title"><div><b>直接编辑当前页</b>{dirty ? <strong>未保存</strong> : <strong className="saved">已同步</strong>}</div><span>保存后会写回 SceneGraph，并重新渲染 PPTX 和预览。</span></div>
      <Field label="版式"><button className="btn ghost wide undo-button" type="button" onClick={onUndoJob} disabled={!job?.canUndo || dirty}>{job?.undoLabel || "撤销上次修改"}</button><select value={draft.layout} onChange={(e) => updateDraft("layout", e.target.value)} disabled={!job}>{Object.entries(LAYOUT_LABELS).map(([value, label]) => <option key={value} value={value}>{label} / {value}</option>)}</select></Field>
      <Field label="标题"><input value={draft.title} onChange={(e) => updateDraft("title", e.target.value)} disabled={!job} /></Field>
      <Field label="副标题 / 摘要"><textarea className="compact-textarea" value={draft.subtitle} onChange={(e) => updateDraft("subtitle", e.target.value)} disabled={!job} /></Field>
      <Field label="叙事角色"><input value={draft.storyRole} onChange={(e) => updateDraft("storyRole", e.target.value)} disabled={!job} /></Field>
      <Field label="内容来源"><select value={draft.contentSource} onChange={(e) => updateDraft("contentSource", e.target.value)} disabled={!job}>{["user input", "user materials", "user images", "system inference", "needs manual confirmation", "system inference + needs manual confirmation"].map((item) => <option key={item} value={item}>{uiZh(item)}</option>)}</select></Field>
      <Field label="要点，每行一条"><textarea value={draft.bullets} onChange={(e) => updateDraft("bullets", e.target.value)} disabled={!job} /></Field>
      <details className="advanced-edit" open><summary>高级字段</summary><Field label="演讲备注"><textarea className="compact-textarea" value={draft.speakerNotes} onChange={(e) => updateDraft("speakerNotes", e.target.value)} disabled={!job} /></Field><Field label="视觉意图"><textarea className="compact-textarea" value={draft.visualIntent} onChange={(e) => updateDraft("visualIntent", e.target.value)} disabled={!job} /></Field><Field label="价格 / 数据点"><textarea className="compact-textarea" value={draft.dataPoints} onChange={(e) => updateDraft("dataPoints", e.target.value)} disabled={!job} /></Field><Field label="图片槽位 / 素材名"><textarea className="compact-textarea" value={draft.imageSlots} onChange={(e) => updateDraft("imageSlots", e.target.value)} disabled={!job} /></Field></details>
      <div className="button-row tight"><button className="btn primary" onClick={() => onSaveText(draft)} disabled={!job || !dirty}>保存当前页</button><button className="btn ghost" onClick={() => setDraft(savedDraft)} disabled={!job || !dirty}>放弃修改</button></div>
      <p className="save-hint">也可以按 Ctrl+S 保存当前页。</p>
      <div className="edit-separator" />
      <div className="edit-mode-title"><b>按指令改写</b><span>用于让系统改写文案或调整页面结构。</span></div>
      <div className="quick-actions">{QUICK_ACTIONS.map((item) => <button key={item} type="button" onMouseDown={(event) => { event.preventDefault(); onQuickAction(item); }} disabled={!job}>{item}</button>)}</div>
      <textarea value={revision} onChange={(e) => setRevision(e.target.value)} placeholder="例如：第 3 页产品矩阵太密，改成两行展示。" />
      <button className="btn primary wide" onClick={onRevise} disabled={!job || !revision.trim()}>应用到当前页</button>
      <div className="edit-separator" />
      <div className="edit-mode-title"><b>整份批量改写</b><span>用于统一口吻、减少文字或强化行动项。</span></div>
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
  title: { label: "Title", box: { x: 56, y: 18, w: 36, h: 13 }, fontSize: 28, bold: true },
  subtitle: { label: "Subtitle", box: { x: 56, y: 34, w: 36, h: 10 }, fontSize: 14 },
  visualIntent: { label: "Visual intent", box: { x: 56, y: 47, w: 36, h: 10 }, fontSize: 10 },
  speakerNotes: { label: "Speaker notes", box: { x: 56, y: 72, w: 36, h: 18 }, fontSize: 9 }
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

function useLayerGesture(gesture, setGesture, patchCanvasEdit, onSave) {
  useEffect(() => {
    if (!gesture) return undefined;
    function onMove(event) {
      const stage = document.querySelector(".editable-slide-stage");
      const rect = stage?.getBoundingClientRect();
      if (!rect) return;
      const dx = ((event.clientX - gesture.startX) / rect.width) * 100;
      const dy = ((event.clientY - gesture.startY) / rect.height) * 100;
      if (gesture.mode === "resize") {
        patchCanvasEdit(gesture.key, {
          box: {
            ...gesture.box,
            w: clamp(gesture.box.w + dx, 4, 96 - gesture.box.x),
            h: clamp(gesture.box.h + dy, 3, 96 - gesture.box.y)
          }
        });
        return;
      }
      patchCanvasEdit(gesture.key, {
        box: {
          ...gesture.box,
          x: clamp(gesture.box.x + dx, 0, 96),
          y: clamp(gesture.box.y + dy, 0, 96)
        }
      });
    }
    function onUp() {
      setGesture(null);
      onSave?.();
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [gesture, patchCanvasEdit, setGesture, onSave]);
}

function buildCanvasAssetObjects(job, slide = {}, slideIndex = 0) {
  const images = getSlideMaterialImages(job, slide, slideIndex);
  const boxes = buildAssetBoxes(slide.layout, images.length);
  return images.map((image, index) => ({
    key: `asset_${index}`,
    type: "image",
    label: `缁辩姵娼?${index + 1}`,
    image,
    box: boxes[index] || boxes[0] || { x: 58, y: 24, w: 28, h: 38 },
    fit: slide.layout === "cover" ? "cover" : "contain",
    opacity: 1
  }));
}

function buildCanvasShapeObjects(slide = {}) {
  const layout = slide.layout || "default";
  const boxes = CANVAS_LAYOUT_BOXES[layout] || CANVAS_LAYOUT_BOXES.default;
  const hasCards = ["cards", "pricing", "compare", "bundle", "product-detail", "risk-checklist", "kpi"].includes(layout);
  let shapeIndex = 0;
  const shapes = [];
  const pushShape = (item) => shapes.push({ key: `shape_${shapeIndex++}`, type: "shape", ...item });
  pushShape({ label: "Top accent line", box: { x: 0, y: 0, w: 100, h: 1.1 }, fill: "#2854d8", line: "#2854d8", radius: 0, opacity: 1 });
  if (["cover", "section", "quote"].includes(layout)) {
    pushShape({ label: "Side accent line", box: { x: 3.6, y: 10.4, w: 0.6, h: 64 }, fill: "#2854d8", line: "#2854d8", radius: 0, opacity: 1 });
  }
  pushShape({ label: "Content accent line", box: { x: boxes.title?.x || 8, y: clamp((boxes.subtitle?.y || boxes.title?.y || 16) + 14, 4, 90), w: boxes.title?.w || 42, h: 0.8 }, fill: "#2854d8", line: "#2854d8", radius: 0, opacity: 1 });
  if (hasCards) {
    const start = boxes.dataStart || boxes.bulletStart || CANVAS_LAYOUT_BOXES.default.dataStart;
    pushShape({ label: "信息卡片 1", box: { x: clamp(start.x - 2, 4, 88), y: clamp(start.y - 4, 8, 84), w: 28, h: 14 }, fill: "#eef3ff", line: "#d7e2ff", radius: 8, opacity: 0.92 });
    pushShape({ label: "信息卡片 2", box: { x: clamp(start.x + 30, 4, 88), y: clamp(start.y - 4, 8, 84), w: 28, h: 14 }, fill: "#f6f8fb", line: "#d9dee8", radius: 8, opacity: 0.92 });
  }
  return shapes;
}

function CanvasTextLayer({ draft = {}, slide = {}, updateDraft, onSave }) {
  const [drag, setDrag] = useState(null);
  const [selectedLayerId, setSelectedLayerId] = useState("");
  const canvasObjects = useMemo(() => buildCanvasObjects(draft, slide), [draft, slide]);
  const edits = normalizeCanvasEdits(draft.canvasEdits || slide.canvasEdits, canvasObjects);
  const selectedObject = canvasObjects.find((item) => item.key === selectedLayerId) || canvasObjects[0] || null;
  const selectedEdit = selectedObject ? edits[selectedObject.key] || { box: selectedObject.box, style: selectedObject.style } : null;

  useEffect(() => {
    if (!selectedLayerId && canvasObjects[0]?.key) setSelectedLayerId(canvasObjects[0].key);
    if (selectedLayerId && !canvasObjects.some((item) => item.key === selectedLayerId)) setSelectedLayerId(canvasObjects[0]?.key || "");
  }, [canvasObjects, selectedLayerId]);

  function patchCanvasEdit(key, patch) {
    const current = normalizeCanvasEdits(draft.canvasEdits || slide.canvasEdits, canvasObjects);
    updateDraft?.("canvasEdits", {
      ...current,
      [key]: { ...current[key], ...patch }
    });
  }

  function patchLayerStyle(key, patch) {
    const current = normalizeCanvasEdits(draft.canvasEdits || slide.canvasEdits, canvasObjects);
    const base = current[key] || {};
    patchCanvasEdit(key, { style: { ...(base.style || {}), ...patch } });
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
      onSave?.();
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [drag, onSave]);

  return (
    <div className="canvas-text-layer">
      {selectedObject ? (
        <div className="text-layer-property-panel">
          <b>{selectedObject.label}</b>
          <label>Font size<input type="number" min="6" max="72" value={selectedEdit?.style?.fontSize || selectedObject.style.fontSize} onChange={(event) => patchLayerStyle(selectedObject.key, { fontSize: Number(event.target.value) })} /></label>
          <label>Color<input type="color" value={selectedEdit?.style?.color || selectedObject.style.color} onChange={(event) => patchLayerStyle(selectedObject.key, { color: event.target.value })} /></label>
          <label>Weight<select value={selectedEdit?.style?.fontWeight || selectedObject.style.fontWeight} onChange={(event) => patchLayerStyle(selectedObject.key, { fontWeight: event.target.value })}><option value="400">Regular</option><option value="600">Semi bold</option><option value="800">Bold</option></select></label>
          <label>Align<select value={selectedEdit?.style?.textAlign || selectedObject.style.textAlign} onChange={(event) => patchLayerStyle(selectedObject.key, { textAlign: event.target.value })}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label>
          <label>Line height<input type="number" min="1" max="2.4" step="0.1" value={selectedEdit?.style?.lineHeight || selectedObject.style.lineHeight} onChange={(event) => patchLayerStyle(selectedObject.key, { lineHeight: Number(event.target.value) })} /></label>
          <label>Letter spacing<input type="number" min="0" max="8" step="0.2" value={selectedEdit?.style?.letterSpacing || selectedObject.style.letterSpacing} onChange={(event) => patchLayerStyle(selectedObject.key, { letterSpacing: Number(event.target.value) })} /></label>
        </div>
      ) : null}
      {canvasObjects.map((field) => {
        const edit = edits[field.key] || { box: field.box, style: field.style };
        const box = edit.box || field.box;
        const style = { ...field.style, ...(edit.style || {}) };
        return (
          <div
            className={`canvas-text-box canvas-${field.key} canvas-role-${field.role} ${selectedLayerId === field.key ? "selected" : ""}`}
            key={field.key}
            onClick={(event) => { event.stopPropagation(); setSelectedLayerId(field.key); }}
            style={{ left: `${box.x}%`, top: `${box.y}%`, width: `${box.w}%`, height: `${box.h}%` }}
          >
            <button type="button" className="canvas-drag-handle" onPointerDown={(event) => startDrag(event, field.key)} title="拖动调整位置">{field.label}</button>
            <textarea
              value={field.value || ""}
              onChange={(event) => patchText(field, event.target.value)}
              onBlur={onSave}
              onFocus={() => setSelectedLayerId(field.key)}
              onClick={(event) => { event.stopPropagation(); setSelectedLayerId(field.key); }}
              style={{
                fontSize: `${style.fontSize}px`,
                fontWeight: style.fontWeight,
                color: style.color,
                textAlign: style.textAlign,
                lineHeight: style.lineHeight,
                letterSpacing: `${style.letterSpacing}px`
              }}
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
    buildCanvasObject("title", "Title", draft.title ?? slide.title ?? "", boxes.title || CANVAS_FIELD_FALLBACKS.title.box),
    buildCanvasObject("subtitle", "Subtitle", draft.subtitle ?? slide.subtitle ?? "", boxes.subtitle || CANVAS_FIELD_FALLBACKS.subtitle.box)
  ];
  bullets.forEach((value, index) => {
    objects.push(buildCanvasObject(`bullet_${index}`, `Bullet ${index + 1}`, value, stackBox(boxes.bulletStart || CANVAS_LAYOUT_BOXES.default.bulletStart, index), "bullet", index));
  });
  if (["pricing", "kpi", "compare", "timeline", "product-detail"].includes(layout)) {
    dataPoints.forEach((value, index) => {
      objects.push(buildCanvasObject(`data_${index}`, `Data ${index + 1}`, value, stackBox(boxes.dataStart || CANVAS_LAYOUT_BOXES.default.dataStart, index), "dataPoint", index));
    });
  }
  return objects.filter((item) => String(item.value || "").trim());
}

function buildCanvasObject(key, label, value, box, path = key, index = null) {
  const role = key === "title" ? "title" : key === "subtitle" ? "subtitle" : path === "dataPoint" ? "data" : "body";
  const style = defaultCanvasTextStyle(role);
  return { key, type: "text", label, value: String(value || ""), box, path, index, role, style };
}

function defaultCanvasTextStyle(role = "body") {
  if (role === "title") return { fontSize: 30, fontWeight: "800", color: "#1f261f", textAlign: "left", lineHeight: 1.08, letterSpacing: 0 };
  if (role === "subtitle") return { fontSize: 14, fontWeight: "400", color: "#667085", textAlign: "left", lineHeight: 1.25, letterSpacing: 0 };
  if (role === "data") return { fontSize: 15, fontWeight: "700", color: "#2854d8", textAlign: "left", lineHeight: 1.15, letterSpacing: 0 };
  return { fontSize: 12, fontWeight: "400", color: "#263238", textAlign: "left", lineHeight: 1.28, letterSpacing: 0 };
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
    const type = field?.type || edits[key]?.type || inferCanvasEditType(key);
    const next = {
      ...edits[key],
      type,
      box: {
        x: clamp(Number(box.x ?? field?.box?.x), 0, 96),
        y: clamp(Number(box.y ?? field?.box?.y), 0, 96),
        w: clamp(Number(box.w ?? field?.box?.w), 4, 96),
        h: clamp(Number(box.h ?? field?.box?.h), 3, 96)
      }
    };
    if (type === "text") next.style = normalizeCanvasTextStyle(edits[key]?.style, field?.style);
    if (type === "image") {
      next.fit = ["contain", "cover"].includes(edits[key]?.fit || field?.fit) ? (edits[key]?.fit || field?.fit) : "contain";
      next.opacity = clamp(Number(edits[key]?.opacity ?? field?.opacity ?? 1), 0.15, 1);
    }
    if (type === "shape") {
      next.fill = normalizeHexColor(edits[key]?.fill || field?.fill, "#eef3ff");
      next.line = normalizeHexColor(edits[key]?.line || field?.line, next.fill);
      next.radius = clamp(Number(edits[key]?.radius ?? field?.radius ?? 0), 0, 24);
      next.opacity = clamp(Number(edits[key]?.opacity ?? field?.opacity ?? 1), 0.1, 1);
    }
    acc[key] = next;
    return acc;
  }, {});
}

function inferCanvasEditType(key = "") {
  if (/^asset_\d+/.test(key)) return "image";
  if (/^shape_\d+/.test(key)) return "shape";
  return "text";
}

function normalizeHexColor(value, fallback = "#263238") {
  const color = String(value || "").trim();
  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  if (/^[0-9a-f]{6}$/i.test(color)) return `#${color}`;
  return fallback;
}

function normalizeCanvasTextStyle(value = {}, fallback = {}) {
  const style = { ...defaultCanvasTextStyle("body"), ...(fallback || {}), ...(value || {}) };
  return {
    fontSize: clamp(Number(style.fontSize), 6, 72),
    fontWeight: String(style.fontWeight || "400"),
    color: /^#[0-9a-f]{6}$/i.test(style.color || "") ? style.color : "#263238",
    textAlign: ["left", "center", "right"].includes(style.textAlign) ? style.textAlign : "left",
    lineHeight: clamp(Number(style.lineHeight), 1, 2.4),
    letterSpacing: clamp(Number(style.letterSpacing), 0, 8)
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function countPageSelection(value = "", maxPages = 50) {
  return parsePageSelectionInput(value, maxPages).count;
}

function parsePageSelectionInput(value = "", maxPages = 50) {
  const text = String(value || "").trim();
  if (!text) return { valid: false, count: 1, pages: [], message: "请输入要生成的页码，例如 1,3,5-6。" };
  const pages = new Set();
  const invalidParts = [];
  for (const part of text.split(/[,\s，、]+/).map((item) => item.trim()).filter(Boolean)) {
    const range = part.match(/^(\d+)\s*[-~至]\s*(\d+)$/);
    if (range) {
      const rawStart = Number(range[1]);
      const rawEnd = Number(range[2]);
      if (rawStart < 1 || rawEnd < 1 || rawStart > (maxPages || 50) || rawEnd > (maxPages || 50)) {
        invalidParts.push(part);
        continue;
      }
      for (let page = Math.min(rawStart, rawEnd); page <= Math.max(rawStart, rawEnd); page += 1) pages.add(page);
      continue;
    }
    const page = Number(part);
    if (Number.isInteger(page) && page >= 1 && page <= (maxPages || 50)) {
      pages.add(page);
    } else {
      invalidParts.push(part);
    }
  }
  const list = [...pages].sort((a, b) => a - b);
  if (!list.length) return { valid: false, count: 1, pages: [], message: "没有解析到有效页码，请输入 1,3,5-6 这样的格式。" };
  if (invalidParts.length) return { valid: false, count: list.length, pages: list, message: `页码无效：${invalidParts.slice(0, 3).join("、")}。有效范围是 1-${maxPages || 50}。` };
  return {
    valid: true,
    count: list.length,
    pages: list,
    message: `将生成第 ${list.join("、")} 页，共 ${list.length} 次图片 API。`
  };
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
    { label: "\u8def\u7531", value: Number.isFinite(routeScore) ? `${Math.round(routeScore * 100)}%` : route.skillWorkflow?.name || "\u53cc\u6280\u80fd\u5de5\u4f5c\u6d41", state: Number.isFinite(routeScore) && routeScore < 0.75 ? "warn" : "pass" },
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
    ...(material.confirmationFields?.length ? [`待确认字段：${material.confirmationFields.slice(0, 3).join(" / ")}`] : [])
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
  if (value === "possible-title-or-text-loss") return "\u6807\u9898\u6216\u5173\u952e\u6587\u5b57\u53ef\u80fd\u88ab\u5f31\u5316";
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
        <b>智能工作记录</b>
        <span>{decision.hasOldDeck ? "源稿重制" : "新建 PPT"}</span>
      </div>
      <div className="agent-record-grid">
        <RecordBlock title="意图" value={uiZh(decision.intent || "PPT 生成")} detail={inputStrengthLabel(decision.inputStrength || material.inputStrength) + " / " + (decision.targetSlides || route.targetSlides || job?.deck?.slides?.length || 0) + " 页"} />
        <RecordBlock title="资料规模" value="已解析" detail={"文字 " + (material.charCount || 0) + " / 图片 " + (material.imageCount || 0) + " / 价格 " + (material.priceCount || 0)} />
        <RecordBlock title="智能路由" value={uiZh(route.deckType || decision.routeType || "pending")} detail={routeReasons.slice(0, 2).join(" / ") || "无原因"} />
        <RecordBlock title="自动修复" value={fixes.length ? fixes.length + " 轮" : "未触发"} detail={fixes[0]?.changes?.slice(0, 2).join(" / ") || "无修复"} />
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

function PipelineCard({ pipeline }) {
  if (!pipeline?.stages?.length) return null;
  const statusText = { pass: "通过", warn: "需检查", block: "阻断", skipped: "已跳过" };
  const jobs = Array.isArray(pipeline.slideJobs) ? pipeline.slideJobs : [];
  return (
    <div className="pipeline-card">
      <div className="pipeline-head">
        <b>设计流水线</b>
        <span>{uiZh(pipeline.lastCompletedStage || "pending")}</span>
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
      {pipeline.blockingReasons?.length ? <small className="pipeline-blockers">{pipeline.blockingReasons.slice(0, 2).map(uiZh).join(" / ")}</small> : null}
    </div>
  );
}

function EditableRebuildCard({ plan }) {
  if (!plan?.candidate) return null;
  const pages = Array.isArray(plan.pages) ? plan.pages : [];
  const statusLabel = plan.status === "active" ? "已规划" : plan.status === "warn" ? "需复核" : uiZh(plan.status || "pending");
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
        <span>{(plan.warnings || []).length} 个风险</span>
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
                <small>{textCount} 个文本框 / {imageCount} 个图片对象 / {uiZh(page.source?.status || "来源")}</small>
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
        <span>{uiZh(sample.status || target.status || "简述")}</span>
      </div>
      <p>{target.styleBrief || "视觉目标简述已生成。参考图只作为调性参考，不作为最终整页背景。"}</p>
      <div className="scenegraph-facts">
        <span>{target.engine || "visual-target"}</span>
        <span>{target.density || "密度待定"}</span>
        <span>{uiZh(sample.status || "样张未生成")}</span>
      </div>
      {sample.imageUrl ? <img className="visual-target-sample" src={sample.imageUrl} alt="visual target sample" /> : null}
      {sample.prompt ? <small className="scenegraph-warning">{sample.prompt.slice(0, 180)}</small> : null}
      {onGenerateSample ? <button className="btn ghost wide" type="button" onClick={onGenerateSample} disabled={localImage?.state !== "online"}>{localImage?.state === "online" ? "生成视觉目标图" : "等待本地生图服务"}</button> : null}
      {pages.length ? (
        <div className="scenegraph-page-list">
          {pages.slice(0, 5).map((page) => (
            <div className="pass" key={page.slideId}>
              <strong>{page.slideId} / {page.role}</strong>
              <small>{page.composition} / 图片优先级 {page.imagePriority}</small>
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
        <b>SceneGraph 可编辑源数据</b>
        <span>{uiZh(status)}</span>
      </div>
      <p>最终 PPTX 从 SceneGraph 渲染：文字是真实文本框，色块是图形，图片是独立对象。</p>
      <div className="scenegraph-facts">
        <span>{qa?.slideCount || slides.length || 0} 页</span>
        <span>{qa?.textBoxes || 0} 个文本框</span>
        <span>{qa?.shapeCount || 0} 形状</span>
        <span>{qa?.imageCount || 0} 图片</span>
      </div>
      {slides.length ? (
        <div className="scenegraph-page-list">
          {slides.slice(0, 6).map((slide) => (
            <div className="pass" key={slide.id}>
              <strong>#{String(slide.index).padStart(2, "0")} {slide.role}</strong>
              <small>{slide.texts?.length || 0} 段文字 / {slide.shapes?.length || 0} 个图形 / {slide.images?.length || 0} 张图片</small>
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
      <p>{compare.note || "检查 SceneGraph 渲染结构是否匹配视觉目标。后续可升级为截图级对比。"}</p>
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
      <p>{repair.policy || "只修复 SceneGraph，不把视觉图粘成最终背景。"}</p>
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
  const extractionAudit = report.extractionAudit || null;
  const cloudSource = report.cloudSourceAnalysis || null;
  const statusLabel = { "text+image": "text + image", "text-only": "text only", "image-only": "image only", empty: "empty" };
  return (
    <div className="source-report-card">
      <b>{"\u8d44\u6599\u8bc6\u522b"}</b>
      <p>{report.hasOldDeck ? "已从源稿识别文字、图片和页面结构。" : "已识别上传资料并抽取关键信息。"}</p>
      <div className="source-report-stats">
        <span><strong>{report.pageCount || 0}</strong> 页</span>
        <span><strong>{report.textPageCount || 0}</strong>{"\u6587\u5b57\u9875"}</span>
        <span><strong>{report.imageCount || 0}</strong> 图片</span>
        <span><strong>{report.boundImageCount || 0}</strong>{"\u5df2\u7ed1\u5b9a\u56fe\u7247"}</span>
      </div>
      {slotReport ? (
        <div className="source-slot-summary">
          <span>{"\u5df2\u5339\u914d"}{slotReport.boundSlides || 0} {"\u4e2a\u56fe\u69fd"}</span>
          <span>{"\u6765\u81ea\u539f\u7a3f"}{slotReport.sourceBoundSlides || 0} {"\u9875"}</span>
          <span>{"\u5df2\u66ff\u6362"}{slotReport.changedSlides || 0} {"\u9875"}</span>
        </div>
      ) : null}
      {extractionAudit ? (
        <div className={`source-slot-summary ${extractionAudit.confidence === "high" ? "pass" : "warning"}`}>
          <span>抽取审计 {extractionAudit.confidence || "medium"}</span>
          <span>文本 {extractionAudit.textSlideCount || 0}/{extractionAudit.slideCount || 0}</span>
          <span>图 {extractionAudit.extractedImageRefs || 0}/{extractionAudit.embeddedImageRefs || 0}</span>
          <span>{extractionAudit.linkedImageRefs || extractionAudit.missingImageRefs ? `已关联 / 缺失 ${extractionAudit.linkedImageRefs || 0}/${extractionAudit.missingImageRefs || 0}` : "无缺失记录"}</span>
        </div>
      ) : null}
      {cloudSource ? (
        <div className={`cloud-review-summary ${cloudSource.status || "warn"}`}>
          <strong>{cloudSource.used ? "云端源文件分析" : "未运行云端源文件分析"}</strong>
          <small>{cloudSource.used ? (cloudSource.summary || cloudSource.status) : (cloudSource.reason || "不可用")}</small>
        </div>
      ) : null}
      {report.warnings?.length ? <div className="source-report-warnings">{report.warnings.slice(0, 4).map((item) => <span key={item}>{item}</span>)}</div> : null}
      {pages.length ? (
        <div className="source-page-list">
          {pages.slice(0, 10).map((page) => (
            <div className={`source-page-row ${page.status || "empty"}`} key={page.page}>
              <span>#{page.page}</span>
              <div>
                <b>{page.title || "第 " + page.page + " 页"}</b>
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
  const statusLabel = latest.status === "block" ? "需要处理" : latest.status === "warn" ? "需要确认" : "已通过";
  const stageLabel = latest.stage === "style-preview" ? "视觉方向阶段" : "整套生成阶段";
  return (
    <div className={`agent-review-card ${latest.status || "pass"}`}>
      <div className="agent-review-head"><b>智能复审</b><span>{stageLabel} / {statusLabel}</span></div>
      <p>{latest.nextGate === "human-style-confirmation" ? "自动 QA 后等待人工确认风格。" : "已进入可编辑和导出检查。"}</p>
      {latest.cloudVisualReview ? (
        <div className={`cloud-review-summary ${latest.cloudVisualReview.status || "warn"}`}>
          <strong>{latest.cloudVisualReview.used ? "云端视觉复审" : "云端复审跳过"}</strong>
          <small>{latest.cloudVisualReview.used ? (latest.cloudVisualReview.summary || latest.cloudVisualReview.status) : (latest.cloudVisualReview.reason || "不可用")}</small>
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
  const actionLabel = { "use-source-image": "复用源图", "use-uploaded-image": "使用上传图", "need-remote-generation": "需要补图" };
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
      <p>{(Number.isFinite(score) ? score + " 分" : "未评分") + " / " + (diagnosis.slideCount || slides.length || 0) + " 页"}</p>
      <div><span>{low.length ? `低分页 ${low.length}` : "无低分页"}</span><span>{dense.length ? `高密度页面 ${dense.length}` : "密度正常"}</span></div>
      {slides.length ? (
        <ul className="local-qa-list">
          {slides.slice(0, 5).map((slide) => (
            <li className={Number(slide.diagnosisScore) < 72 ? "warn" : "pass"} key={slide.page}>
              <strong>#{slide.page} {uiZh(slide.type || "未知")} / {slide.diagnosisScore ?? "-"} 分</strong>
              <span>{slide.layoutStrategy || "structured_summary"} / {(slide.problems || []).map((item) => item.message || item).slice(0, 2).join(" / ") || "no issues"}</span>
            </li>
          ))}
        </ul>
      ) : null}
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
      <p>{confirmation.title || confirmation.id} / {confirmation.previewCount || 0} 张样图 / 复核 {uiZh(confirmation.reviewStatus || "未开始")}</p>
      <div><span>{confirmation.style || "未选择风格"}</span><span>{confirmation.styleFingerprint?.prompt ? "已抽取风格指纹" : "无风格指纹"}</span><span>{fix?.changes?.length ? "已修复 " + fix.changes.length + " 项" : "无自动修复"}</span></div>
      {cloud.summary ? <small>{cloud.used ? cloud.summary : "未运行云端复核"}</small> : null}
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
      <div><span>{qa.warnCount ? `风险 ${qa.warnCount}` : "全部通过"}</span><span>{qa.risks?.length ? qa.risks.map(localQaRiskLabel).slice(0, 2).join(" / ") : "无风险"}</span></div>
      {items.length ? (
        <ul className="local-qa-list">
          {items.slice(0, 5).map((item) => (
            <li className={item.status === "pass" ? "pass" : "warn"} key={item.id || item.name}>
              <strong>{item.slide ? `#${item.slide} ` : ""}{item.status === "pass" ? "通过" : "需检查"}</strong>
              <span>{item.risks?.length ? item.risks.map(localQaRiskLabel).join(" / ") : "无风险"}</span>
            </li>
          ))}
        </ul>
      ) : null}
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

function DirectorChatPanel({ busy, draft, files, job, messages, setDraft, workflowJob, onAction, onKeyDown, onSend, onSuggestion }) {
  const deliveryStatus = workflowJob ? deriveWorkflowDeliveryStatus(workflowJob, []) : null;
  const stageRows = workflowJob ? workflowStageRows(workflowJob) : [];
  const doneCount = stageRows.filter((row) => row.status === "done").length;
  const totalCount = stageRows.length || 0;
  const agentStatus = workflowJob
    ? `${doneCount}/${totalCount || "-"} 阶段 / ${uiZh(deliveryStatus?.summary || workflowJob.currentStage || workflowJob.status || "工作流中")}`
    : files.length
      ? `${files.length} 个材料 / 等待创建工作流`
      : "等待上传或输入需求";
  const suggestions = [
    "判断下一步该做什么",
    "解释当前工作流状态",
    "检查 codex-ppt 确认关卡",
    "检查 editppt 可编辑重建"
  ];
  return (
    <div className="director-chat-panel">
      <div className="director-head">
        <div>
          <b>PPT 智能体</b>
          <span>PPT 重制助手</span>
        </div>
        <small>{agentStatus}</small>
      </div>
      <div className="director-workflow-card">
        <span>{workflowJob ? "当前工作流" : "未创建工作流"}</span>
        <b>{workflowJob?.input?.sourceOriginalName || (workflowJob?.input?.sourceBrief ? "需求简述 / 大纲来源" : workflowJob?.id || "先上传文件或输入需求")}</b>
        <small>{workflowJob ? workflowJobLabel(workflowJob) : "创建后会进入视觉方向确认"}</small>
        <div>
          <button type="button" onClick={() => onAction?.({ event: "open-workflow" })} disabled={busy}>打开工作流</button>
          <button type="button" onClick={() => onAction?.({ event: "refresh-workflow" })} disabled={busy || !workflowJob?.id}>刷新状态</button>
        </div>
      </div>
      <div className="director-thread" aria-live="polite">
        {messages.map((message) => (
          <div className={`director-message ${message.role || "assistant"}`} key={message.id}>
            {message.title ? <b>{message.title}</b> : null}
            <p>{message.text}</p>
            {message.facts?.length ? (
              <div className="director-facts">
                {message.facts.map((fact) => <span key={fact}>{fact}</span>)}
              </div>
            ) : null}
            {message.actions?.length ? (
              <div className="director-actions">
                {message.actions.map((action) => (
                  <button type="button" key={action.id} onClick={() => onAction(action)}>{action.label}</button>
                ))}
              </div>
            ) : null}
          </div>
        ))}
        {busy ? <div className="director-message assistant"><p>正在判断当前状态...</p></div> : null}
      </div>
      <div className="director-suggestions">
        {suggestions.map((item) => <button type="button" key={item} onClick={() => onSuggestion(item)} disabled={busy}>{item}</button>)}
      </div>
      <div className="director-input">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="和 PPT 智能体说你的目标，例如：把上传的 PPT 按现代提案风重做，先出样张。"
        />
        <button className="btn primary" type="button" onClick={onSend} disabled={busy || !draft.trim()}>{busy ? "处理中" : "发送"}</button>
      </div>
    </div>
  );
}

function WorkflowSideStatusPanel({ connection, doctor, job, jobs = [], localImage, onOpenWorkflow, onRefresh }) {
  const deliveryStatus = deriveWorkflowDeliveryStatus(job, []);
  const providers = connection?.details?.providers || {};
  const llmReady = Boolean(providers.llm?.configured);
  const llmIssue = getWorkflowLlmIssue(job);
  const llmCardState = llmIssue ? "checking" : llmReady ? "online" : "offline";
  const imageReady = localImage?.state === "online" || Boolean(providers.image?.configured);
  const rows = workflowStageRows(job);
  const doneCount = rows.filter((row) => row.status === "done").length;
  const failedCount = rows.filter((row) => row.status === "failed").length;
  const sourcePages = Array.isArray(job?.artifacts?.renderedPages) ? job.artifacts.renderedPages.length : 0;
  const visualPages = Array.isArray(job?.artifacts?.visualImages) ? job.artifacts.visualImages.length : 0;
  const editablePages = job?.artifacts?.editableFinal?.summary?.page_count || job?.artifacts?.editableFinal?.pptxEditability?.slideCount || 0;
  const statusTone = failedCount ? "fail" : deliveryStatus.level === "ready" || deliveryStatus.level === "success" ? "pass" : "warn";
  return (
    <div className="side-section workflow-side-status">
      <h2>工作流状态</h2>
      <div className={`status-summary ${statusTone}`}>
        <div>
          <b>{uiZh(deliveryStatus.title || "交付状态")}</b>
          <span>{uiZh(deliveryStatus.summary || "等待工作流推进")}</span>
        </div>
        <button type="button" onClick={onRefresh}>刷新</button>
      </div>
      <div className="workflow-side-id">
        <b>{job?.input?.sourceOriginalName || (job?.input?.sourceBrief ? "需求简述 / 大纲来源" : "当前工作流")}</b>
        <span>{workflowJobLabel(job)}</span>
        <em className={`workflow-primary-badge ${job?.primaryWorkflowState?.isPrimary ? "primary" : "secondary"}`}>
          {job?.primaryWorkflowState?.isPrimary ? "当前主验收任务" : "非主验收任务"}
        </em>
      </div>
      <div className="workflow-side-metrics">
        <Metric label="任务数" value={jobs.length} />
        <Metric label="源页" value={sourcePages} />
        <Metric label="图片页" value={visualPages} />
        <Metric label="可编辑页" value={editablePages || "-"} />
      </div>
      <div className="workflow-side-stages">
        {rows.map((row) => (
          <div className={`workflow-side-stage ${row.status}`} key={row.id}>
            <span />
            <div>
              <b>{uiZh(row.label)}</b>
              <small>{workflowStatusLabel(row.status)}{row.message ? ` / ${uiZh(row.message)}` : ""}</small>
            </div>
          </div>
        ))}
      </div>
      <div className="workflow-side-actions">
        <button className="btn primary" type="button" onClick={onOpenWorkflow}>打开工作流控制台</button>
        <button className="btn ghost" type="button" onClick={onRefresh}>刷新当前任务</button>
      </div>
      <div className={`health-card ${connection?.state || "checking"}`}><span className={connection?.state === "offline" ? "state-dot error" : connection?.state === "online" ? "state-dot active" : "state-dot checking"} /><div><b>{connection?.state === "offline" ? "本地服务离线" : connection?.state === "online" ? "本地服务在线" : "正在检查服务"}</b><p>{uiZh(connection?.message || "正在检查...")}</p></div></div>
      <div className={`health-card ${llmCardState}`}><span className={llmIssue ? "state-dot checking" : llmReady ? "state-dot active" : "state-dot error"} /><div><b>{llmIssue ? "对话模型需确认" : llmReady ? "对话模型已配置" : "对话模型未就绪"}</b><p>{llmIssue?.message || (providers.llm?.model ? `${providers.llm.model}${providers.llm.baseUrl ? ` / ${providers.llm.baseUrl}` : ""}` : "可编辑重建需要可用的对话模型服务商")}</p></div></div>
      <div className={`health-card ${imageReady ? "online" : "offline"}`}><span className={imageReady ? "state-dot active" : "state-dot error"} /><div><b>{imageReady ? "图片 API 已配置" : "图片 API 未就绪"}</b><p>{providers.image?.model || uiZh(localImage?.message || "视觉图片生成需要外部图片 API")}</p></div></div>
      <div className={`health-card ${doctor?.state || "checking"}`}><span className={doctor?.state === "fail" ? "state-dot error" : doctor?.state === "pass" ? "state-dot active" : "state-dot checking"} /><div><b>{doctor?.state === "pass" ? "产品环境通过" : doctor?.state === "fail" ? "产品环境需检查" : "正在检查产品环境"}</b><p>{uiZh(doctor?.message || "-")}</p></div></div>
    </div>
  );
}

function ProductOnlyStatusPanel({ connection, doctor, localImage, onOpenMaterials, onOpenWorkflow }) {
  const serviceOnline = connection?.state === "online";
  const providers = connection?.details?.providers || {};
  const llmReady = Boolean(providers.llm?.configured);
  const imageReady = localImage?.state === "online" || Boolean(providers.image?.configured);
  const doctorChecks = Array.isArray(doctor?.details?.checks) ? doctor.details.checks : [];
  const failedChecks = doctorChecks.filter((check) => !check.ok);
  return (
    <div className="side-section product-only-status">
      <h2>Agent 状态</h2>
      <p className="panel-help">当前前端只保留围绕视觉统一和可编辑重建的 PPT Agent 主流程。</p>
      <div className={`health-card ${serviceOnline ? "online" : "offline"}`}>
        <span className={serviceOnline ? "state-dot active" : "state-dot error"} />
        <div>
          <b>{serviceOnline ? "本地服务在线" : "本地服务离线"}</b>
          <p>{uiZh(connection?.message || "等待本地服务状态")}</p>
        </div>
      </div>
      <div className={`health-card ${imageReady ? "online" : "offline"}`}>
        <span className={imageReady ? "state-dot active" : "state-dot error"} />
        <div>
          <b>{imageReady ? "图片 API 已配置" : "图片 API 未就绪"}</b>
          <p>{providers.image?.model || uiZh(localImage?.message || "视觉图片生成需要外部图片 API")}</p>
        </div>
      </div>
      <div className={`health-card ${llmReady ? "online" : "offline"}`}>
        <span className={llmReady ? "state-dot active" : "state-dot error"} />
        <div>
          <b>{llmReady ? "对话模型已配置" : "对话模型未就绪"}</b>
          <p>{providers.llm?.model ? `${providers.llm.model}${providers.llm.baseUrl ? ` / ${providers.llm.baseUrl}` : ""}` : "可编辑重建需要可用的对话模型服务商"}</p>
        </div>
      </div>
      <div className={`health-card ${failedChecks.length ? "offline" : "online"}`}>
        <span className={failedChecks.length ? "state-dot error" : "state-dot active"} />
        <div>
          <b>{failedChecks.length ? "环境仍需处理" : "环境检查通过"}</b>
          <p>{doctorChecks.length ? `${doctorChecks.length - failedChecks.length}/${doctorChecks.length} 项通过` : uiZh(doctor?.message || "等待环境检查")}</p>
        </div>
      </div>
      <div className="workflow-side-actions">
        <button className="btn primary" type="button" onClick={onOpenMaterials}>上传资料</button>
        <button className="btn ghost" type="button" onClick={onOpenWorkflow}>打开工作流</button>
      </div>
    </div>
  );
}

function getWorkflowLlmIssue(job = null) {
  const tasks = Array.isArray(job?.artifacts?.editableWorkerTasks) ? job.artifacts.editableWorkerTasks : [];
  const events = Array.isArray(job?.events) ? job.events : [];
  const text = [
    ...tasks.flatMap((task) => [task.message, task.error, task.evidence?.validationError]),
    ...events.flatMap((event) => [event.message, event.error, event.type])
  ].filter(Boolean).join("\n").toLowerCase();
  if (!text) return null;
  const auth = /provider auth|http\s*401|unauthorized|invalid.*api.*key|api.*key.*invalid|鉴权/.test(text);
  const quota = /provider quota|insufficient[_\s-]?quota|quota|balance|credit|billing|额度|余额/.test(text);
  if (!auth && !quota) return null;
  return {
    kind: auth ? "auth" : "quota",
    message: auth
      ? "这个工作流最近卡在对话模型鉴权；请检查对话模型 API Key / Base URL 后再重跑可编辑重建。"
      : "这个工作流最近卡在对话模型额度/余额；gpt-image-2 正常不代表可编辑重建可用。"
  };
}

function WorkflowHistoryPanel({ activeId = "", busy = false, jobs = [], onRefresh, onSelect, onToggleArchive, onToggleArchivedVisibility, showArchived = false }) {
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState("all");
  const filteredJobs = jobs.filter((item) => {
    const text = [
      item.id,
      item.input?.sourceOriginalName,
      item.input?.sourceBrief,
      item.currentStage,
      item.status
    ].filter(Boolean).join(" ").toLowerCase();
    return (!query.trim() || text.includes(query.trim().toLowerCase()))
      && (stage === "all" || item.currentStage === stage || item.status === stage);
  });
  const stages = [...new Set(jobs.map((item) => item.currentStage || item.status).filter(Boolean))].slice(0, 12);
  return (
    <div className="side-section workflow-history-panel">
      <h2>工作流历史</h2>
      <p className="panel-help">这里只显示 PPT Agent 的重制任务。</p>
      <div className="history-tools workflow-history-tools">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索工作流" />
        <select value={stage} onChange={(event) => setStage(event.target.value)}>
          <option value="all">全部阶段</option>
          {stages.map((item) => <option key={item} value={item}>{uiZh(item)}</option>)}
        </select>
        <button type="button" onClick={() => onToggleArchivedVisibility?.(!showArchived)} disabled={busy}>
          {showArchived ? "隐藏已归档" : "显示已归档"}
        </button>
        <button type="button" onClick={onRefresh} disabled={busy}>刷新列表</button>
      </div>
      <div className="history-list workflow-history-list">
        {filteredJobs.map((item) => {
          const active = item.id === activeId;
          const stageRows = workflowStageRows(item);
          const doneCount = stageRows.filter((row) => row.status === "done").length;
          const totalCount = stageRows.length || 1;
          const updatedAt = item.updatedAt || item.createdAt || "";
          const sourceName = item.input?.sourceOriginalName || (item.input?.sourceBrief ? "需求简述 / 大纲来源" : "");
          const primaryLabel = item.primaryWorkflowState?.isPrimary ? "主验收任务" : "非主验收";
          return (
            <div className={active ? "history-row workflow-history-row active" : "history-row workflow-history-row"} key={item.id}>
              <button type="button" onClick={() => onSelect?.(item.id)} disabled={busy}>
                <b>{sourceName || item.id}</b>
                <span>{workflowJobLabel(item)}</span>
                <span>{updatedAt ? new Date(updatedAt).toLocaleString() : "暂无更新时间"}</span>
                <em className={`workflow-primary-badge ${item.primaryWorkflowState?.isPrimary ? "primary" : "secondary"}`}>{primaryLabel}</em>
              </button>
              <span className={`history-quality ${workflowHistoryClass(item)}`}>
                {item.archived ? "已归档" : workflowStatusLabel(item.status || item.currentStage)}
              </span>
              <span className="workflow-history-progress">{doneCount}/{totalCount}</span>
              <button className="history-repair" type="button" onClick={() => onToggleArchive?.(item.id, !item.archived)} disabled={busy}>
                {item.archived ? "恢复" : "归档"}
              </button>
            </div>
          );
        })}
        {!filteredJobs.length ? <p className="empty">暂无 PPT 重制任务</p> : null}
      </div>
    </div>
  );
}

function SettingsPanel({ config, busy, models, styleReferences = [], onChange, onSave, onSavePaddleOcrToken, onTest, onTestImage, onDetectModels, onUploadStyleReference, onDeleteStyleReference }) {
  const [styleName, setStyleName] = useState("");
  const [styleTone, setStyleTone] = useState("");
  function update(name, value) { onChange((current) => ({ ...current, [name]: value })); }
  function handleStyleUpload(event) {
    const files = event.target.files;
    if (files?.length) {
      onUploadStyleReference(files, { name: styleName, tone: styleTone });
      setStyleName("");
      setStyleTone("");
    }
    event.target.value = "";
  }
  return (
    <div className="side-section settings-panel" id="workflow-settings-panel">
      <h2>{"API \u8bbe\u7f6e"}</h2>
      <div className={"api-state " + (config.hasApiKey ? "ready" : "missing")}><span className={config.hasApiKey ? "state-dot active" : "state-dot error"} /><div><b>{config.hasApiKey ? "AI 已配置" : "未配置 API Key"}</b><p>{config.hasApiKey ? "当前 Key: " + (config.maskedApiKey || "-") : "未配置，双技能生成会停在配置检查。"}</p></div></div>
      <Field label="OpenAI 密钥"><input type="password" value={config.apiKey || ""} onChange={(event) => update("apiKey", event.target.value)} placeholder={config.hasApiKey ? "\u7559\u7a7a\u5219\u4fdd\u7559\u5df2\u4fdd\u5b58\u7684 Key" : "sk-..."} autoComplete="off" /></Field>
      <Field label="接口地址"><input value={config.baseUrl || ""} onChange={(event) => update("baseUrl", event.target.value)} placeholder="https://api.openai.com/v1" /></Field>
      <Field label="对话模型"><select value={config.model || ""} onChange={(event) => update("model", event.target.value)}>{models?.length ? models.map((model) => <option key={model} value={model}>{model}</option>) : <option value={config.model || "gpt-4.1-mini"}>{config.model || "gpt-4.1-mini"}</option>}</select></Field>
      <p className="settings-note">对话模型用于大纲规划和可编辑页面重建。当前如果提示额度不足，需要先充值或切换这里的模型服务商。</p>
      <Field label="页面重建模型"><input value={config.pageSpecModel || ""} onChange={(event) => update("pageSpecModel", event.target.value)} placeholder={config.model || "gpt-4.1-mini"} /></Field>
      <p className="settings-note">页面重建模型专门用于 image-to-editable-ppt 的图片理解和 JSON 规格生成；它必须支持图片输入、JSON 输出和非空响应。</p>
      <Field label="图片模型"><input value={config.imageModel || ""} onChange={(event) => update("imageModel", event.target.value)} placeholder="gpt-image-2" /></Field>
      <p className="settings-note">图片模型用于 codex-ppt 样张和全量图片页生成。真正调用外部图片 API 前，工作流会再次要求确认。</p>
      <div className="button-row tight"><button className="btn primary" type="button" onClick={onSave} disabled={busy}>保存配置</button><button className="btn ghost" type="button" onClick={onTest} disabled={busy}>测试对话 API</button><button className="btn ghost" type="button" onClick={onTestImage} disabled={busy}>测试图片 API</button><button className="btn ghost" type="button" onClick={onDetectModels} disabled={busy}>检测模型</button></div>
      <div className="settings-divider" />
      <h2>可编辑重建 OCR</h2>
      <div className="api-state ready"><span className="state-dot active" /><div><b>本地开源 OCR</b><p>{formatOcrProviderDetail(null, { provider: config.ocrProvider, fallbackProvider: config.ocrFallbackProvider }) || "paddleocr-local，本地识别；rapidocr-local 兜底"}</p></div></div>
      <div className={"api-state " + (config.editppt?.textHints?.paddleToken === "set" ? "ready" : "missing")}><span className={config.editppt?.textHints?.paddleToken === "set" ? "state-dot active" : "state-dot error"} /><div><b>{config.editppt?.textHints?.paddleToken === "set" ? "editppt 兼容 OCR 令牌已配置" : "editppt 兼容 OCR 令牌未设置（可选）"}</b><p>{uiZh(config.editppt?.textHints?.selection || "unknown")} 文字提示 / 主流程优先使用本地 OCR</p></div></div>
      <Field label="editppt 兼容 OCR 令牌（可选）"><input type="password" value={config.paddleOcrToken || ""} onChange={(event) => update("paddleOcrToken", event.target.value)} placeholder={config.editppt?.textHints?.paddleToken === "set" ? "留空则保留已保存的令牌" : "可选：粘贴 editppt 兼容 OCR 令牌"} autoComplete="off" /></Field>
      <p className="settings-note">主流程使用本地 PaddleOCR / RapidOCR 生成文字提示；这里仅保留 editppt 兼容令牌入口。</p>
      <div className="button-row tight"><button className="btn ghost" type="button" onClick={onSavePaddleOcrToken} disabled={busy || !String(config.paddleOcrToken || "").trim()}>保存兼容 OCR 令牌</button></div>
      <div className="settings-divider" />
      <h2>可选参考图（非模板）</h2>
      <p className="settings-note">参考图只作为 codex-ppt 的色彩、留白、质感和画面密度约束，不是旧模板库，也不会锁死固定版式。</p>
      <Field label="参考名称"><input value={styleName} onChange={(event) => setStyleName(event.target.value)} placeholder="例如：客户提供的参考页 / 品牌视觉参考" /></Field>
      <Field label="调性说明"><textarea className="compact-textarea" value={styleTone} onChange={(event) => setStyleTone(event.target.value)} placeholder="例如：留白多、低饱和、纸感纹理、标题克制。" /></Field>
      <label className="style-upload"><input type="file" accept="image/*" multiple onChange={handleStyleUpload} disabled={busy} /><span>上传参考图</span></label>
      <div className="style-current-gallery"><div className="style-current-gallery-head"><b>{"\u5df2\u4e0a\u4f20\u53c2\u8003\u56fe"}</b><span>{styleReferences.length} {"\u5f20"}</span></div>{styleReferences.length ? <div className="style-thumb-grid">{styleReferences.slice(0, 12).map((item) => <img key={item.id} src={item.imageUrl} alt={item.name || item.originalName || "\u53c2\u8003\u56fe"} />)}</div> : <p className="empty">还没有可选参考图</p>}</div>
      <div className="style-reference-list">
        {styleReferences.length ? styleReferences.map((item) => <StyleReferenceItem key={item.id} item={item} busy={busy} onDelete={onDeleteStyleReference} />) : <p className="empty">暂无可选参考图</p>}
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
      {blocked ? <span className="download-warning">QA 已阻断：当前 PPTX 只是可编辑草稿，不能作为最终交付文件。</span> : null}
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
  const title = progress?.mode === "style-preview" ? "正在生成主视觉方向" : progress?.mode === "optimize" ? "正在重制现有 PPT" : "正在生成 PPT";
  return <div className="generation-progress"><div><b>{title}</b><span>{uiZh(progress?.label || "正在处理，请稍等...")}</span></div><strong>{value}%</strong><em><i style={{ width: `${value}%` }} /></em></div>;
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
  const tiers = ["基础", "推荐", "升级", "高级", "定制", "补充"];
  const entries = source.slice(0, 6).map((item, index) => {
    const text = String(item || "");
    const price = text.match(/\d+(?:\.\d+)?/)?.[0] || String(index + 1);
    const label = text.replace(price, "").replace(/[，。；、:：\-]/g, " ").trim() || tiers[index] || "Plan " + (index + 1);
    return {
      tier: tiers[index] || "Plan " + (index + 1),
      price,
      label,
        note: index === 0 ? "入门预算" : index === source.length - 1 ? "需要复核" : "推荐",
      accented: /recommended|upgrade|premium|推荐|升级|高配/i.test(text) || index === 1
    };
  });
  return entries.length ? entries : [{ tier: "推荐", price: "01", label: slide.title || "待处理", note: "需要复核", accented: true }];
}

function buildPreviewProductFacts(slide = {}) {
  const text = [slide.title, slide.subtitle, ...toBulletList(slide.bullets), ...toBulletList(slide.dataPoints)].join(" ");
  const price = text.match(/\d+(?:\.\d+)?/)?.[0] || "pending";
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

function normalizeMatchText(value = "") { return String(value).toLowerCase().replace(/\s+/g, "").replace(/[^\u4e00-\u9fa5a-z0-9]/g, ""); }
function tokenizeForMatch(value = "") { return [...new Set([...(value.match(/[\u4e00-\u9fa5]{2,8}/g) || []), ...(value.match(/[a-z0-9]{2,}/g) || [])])].slice(0, 24); }

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
    if (value < 30) return "正在读取资料、参考图和已确认大纲";
    if (value < 55) return "正在判断方向页和版式路线";
    if (value < 78) return "正在生成 3-4 页主视觉方向";
    if (value < 92) return "正在执行自动质检和视觉复审";
    return "正在打包 visual-target.pptx 和预览图";
  }
  if (mode === "optimize") {
    if (value < 35) return "正在解析源稿和素材";
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
    if (step.id === "generate") return [step.id, job ? UI.done : UI.pending];
    if (step.id === "preview") return [step.id, job ? (blocked ? UI.pending : UI.editable) : UI.waitingGenerate];
    if (step.id === "export") return [step.id, job && formats.length && !blocked ? UI.exportable : UI.pending];
    return [step.id, UI.pending];
  }));
}

function isJobBlockedForFinal(job) {
  return Boolean(job?.editReadiness?.ready === false || job?.editReadiness?.status === "blocked");
}

function workflowStageRows(job = {}) {
  const stages = job?.stages || {};
  const artifact = job?.artifacts || {};
  const rows = [
    ["source-render", "源稿渲染", artifact.renderedPages],
    ["visual-generate", "视觉重绘", artifact.visualImages],
    ["image-deck", "图片型 PPT", artifact.imageDeck],
    ["editable-prepare", "editppt prepare", artifact.editableRun],
    ["worker-prompts", "页面提示", artifact.editableWorkerPrompts],
    ["finalize", "合成可编辑 PPT", artifact.editableFinal]
  ];
  return rows.map(([id, label, output]) => {
    const stage = stages[id] || stages[id.replace("-", "_")] || {};
    const current = job?.currentStage === id;
    const done = Boolean(output) || stage.status === "completed";
    return {
      id,
      label,
      status: done ? "done" : current || stage.status === "running" ? "running" : stage.status === "failed" ? "failed" : "pending",
      message: stage.message || stage.error || stage.updatedAt || ""
    };
  });
}

function buildProductWorkflowMap({ complianceBundle = null, deliveryGate = null, job = null, tasks = {} } = {}) {
  const artifacts = job?.artifacts || {};
  const approvals = complianceBundle?.codexPpt?.approvals || {};
  const approvedCount = Number(approvals.passed || 0);
  const approvalTotal = Number(approvals.total || 5);
  const codexSlideTasks = Array.isArray(tasks.codexSlideTasks) ? tasks.codexSlideTasks : [];
  const editableTasks = Array.isArray(tasks.editableTasks) ? tasks.editableTasks : [];
  const sourcePages = Array.isArray(artifacts.renderedPages) ? artifacts.renderedPages.length : 0;
  const visualPages = Array.isArray(artifacts.visualImages) ? artifacts.visualImages.length : 0;
  const recordedCodexSlides = codexSlideTasks.filter((task) => task.status === "recorded" && task.imagePath).length;
  const failedCodexSlides = codexSlideTasks.filter((task) => task.status === "failed").length;
  const recordedEditablePages = editableTasks.filter((task) => task.status === "recorded").length;
  const failedEditablePages = editableTasks.filter((task) => task.status === "failed").length;
  const pendingEditablePages = editableTasks.filter((task) => task.status && task.status !== "recorded" && task.status !== "failed").length;
  const hasSource = sourcePages > 0;
  const hasImageDeck = Boolean(artifacts.imageDeck?.path || artifacts.imageDeck?.relativePath);
  const hasEditableRun = Boolean(artifacts.editableRun?.path || artifacts.editableRun?.relativePath);
  const hasEditableFinal = Boolean(artifacts.editableFinal?.path);
  const isDeliverable = deliveryGate?.downloadable === true || deliveryGate?.productReady === true;

  return [
    {
      id: "source",
      label: "源文件渲染",
      state: hasSource ? "ready" : job?.id ? "working" : "pending",
      detail: hasSource ? `${sourcePages} 页已渲染` : "创建工作流并渲染源页面"
    },
    {
      id: "codex-approvals",
      label: "codex-ppt 确认关卡",
      state: approvalTotal && approvedCount >= approvalTotal ? "ready" : approvedCount > 0 ? "working" : hasSource ? "working" : "pending",
      detail: approvalTotal ? `${approvedCount}/${approvalTotal} 项确认已记录` : "大纲、风格、后端、样张、全量生成"
    },
    {
      id: "image-deck",

      label: "图片型 PPT",
      state: hasImageDeck ? "ready" : failedCodexSlides ? "blocked" : visualPages || recordedCodexSlides ? "working" : "pending",
      detail: hasImageDeck ? "图片型 PPT 已组装" : failedCodexSlides ? `${failedCodexSlides} 个图片页任务失败` : `${visualPages || recordedCodexSlides} 个视觉页就绪`
    },
    {
      id: "editable-rebuild",
      label: "可编辑重建",
      state: hasEditableFinal ? "ready" : failedEditablePages ? "blocked" : hasEditableRun || recordedEditablePages || pendingEditablePages ? "working" : "pending",
      detail: hasEditableFinal ? "可编辑 PPTX 已生成" : failedEditablePages ? `${failedEditablePages} 个可编辑页失败` : `${recordedEditablePages}/${editableTasks.length || 0} 个可编辑页已记录`
    },
    {
      id: "delivery",
      label: "交付门禁",
      state: isDeliverable ? "ready" : deliveryGate?.level === "blocked" ? "blocked" : hasEditableFinal ? "working" : "pending",
      detail: uiZh(deliveryGate?.label || deliveryGate?.title || "最终质检、人工复核、下载")
    }
  ];
}

function workflowJobLabel(job = {}) {
  const id = shortWorkflowId(job.id);
  const sourcePages = Array.isArray(job.artifacts?.renderedPages) ? job.artifacts.renderedPages.length : 0;
  const visualPages = Array.isArray(job.artifacts?.visualImages) ? job.artifacts.visualImages.length : 0;
  const finalPages = job.artifacts?.editableFinal?.summary?.page_count || job.artifacts?.editableFinal?.pptxEditability?.slideCount || 0;
  const pages = finalPages ? `${finalPages} final` : visualPages ? `${visualPages} visual` : sourcePages ? `${sourcePages} source` : "new";
  const archived = job.archived ? " archived" : "";
  return `${id} 路 ${pages} 路 ${job.currentStage || job.status || "created"}${archived}`;
}

function shortWorkflowId(id = "") {
  return String(id || "").replace(/^workflow_/, "");
}

function uniqueWorkflowJobs(jobs = []) {
  const byId = new Map();
  for (const job of jobs) {
    if (!job?.id || byId.has(job.id)) continue;
    byId.set(job.id, job);
  }
  return [...byId.values()];
}

function selectDefaultWorkflowJob(jobs = [], primaryWorkflow = null) {
  const visibleJobs = Array.isArray(jobs) ? jobs.filter(Boolean) : [];
  if (!visibleJobs.length) return null;
  if (primaryWorkflow?.id) {
    const primary = visibleJobs.find((job) => job.id === primaryWorkflow.id);
    if (primary && !primary.archived) return primary;
  }
  const sorted = [...visibleJobs].sort(compareWorkflowRecency);
  return sorted.find(isActiveWorkflowJob)
    || sorted.find((job) => Boolean(job.artifacts?.editableFinal?.path))
    || sorted[0]
    || null;
}

function compareWorkflowRecency(a = {}, b = {}) {
  const bTime = Date.parse(b.updatedAt || b.createdAt || "") || 0;
  const aTime = Date.parse(a.updatedAt || a.createdAt || "") || 0;
  return bTime - aTime;
}

function isActiveWorkflowJob(job = {}) {
  if (job.archived) return false;
  if (job.artifacts?.editableFinal?.path) return false;
  return !["complete", "failed"].includes(job.currentStage || job.status || "");
}

function isUserWorkflowJob(job = {}) {
  if (job.primaryWorkflow?.isPrimary === true) return true;
  return !isInternalWorkflowJob(job);
}

function isInternalWorkflowJob(job = {}) {
  if (job.internal === true || job.input?.internal === true) return true;
  const text = [
    job.input?.mode,
    job.input?.sourceOriginalName,
    job.input?.notes,
    ...(Array.isArray(job.events) ? job.events.map((event) => `${event.type || ""} ${event.message || ""}`) : [])
  ].filter(Boolean).join(" ");
  return /\b(regression|smoke-e2e|product-visual-readiness|codex-slide-negative)\b/i.test(text);
}

function workflowStatusLabel(status = "") {
  if (status === "not_started") return "未开始";
  if (status === "done") return "完成";
  if (status === "running") return "运行中";
  if (status === "failed") return "失败";
  return "待处理";
}


function workflowHistoryClass(job = {}) {
  if (job.archived) return "warn";
  if (job.status === "failed" || job.currentStage === "failed") return "bad";
  if (job.status === "complete" || job.currentStage === "complete" || job.artifacts?.editableFinal?.path) return "good";
  return "warn";
}
function v1AcceptanceStatusLabel(status = "") {
  if (status === "pass") return "通过";
  if (status === "warning") return "需复核";
  if (status === "fail") return "阻断";
  return "待处理";
}

function workerTaskStatusLabel(status = "") {
  if (status === "ready") return "就绪";
  if (status === "claimed") return "已领取";
  if (status === "running") return "运行中";
  if (status === "recorded") return "已记录";
  if (status === "failed") return "失败";
  return "未知";
}

function formatEditableTaskIssue(task = null) {
  const issues = Array.isArray(task?.evidence?.outputContractIssues) ? task.evidence.outputContractIssues : [];
  if (issues.length) return `页面产物契约未通过：${issues.slice(0, 2).join("；")}`;
  return "";
}

function getEditableWorkerNextAction({ selectedPrompt = null, selectedTask = null, nextStage = "" } = {}) {
  if (!selectedPrompt) return "请先生成或读取页面提示。";
  if (!selectedTask) return "先同步队列，再领取当前页面。";
  if (selectedTask.status === "recorded") return "结果已记录，可以继续下一页或进入最终合成。";
  if (selectedTask.status === "failed") return "检查错误后重置重试。";
  if (selectedTask.status === "claimed" || selectedTask.status === "running" || selectedTask.status === "dispatched") return "等待页面任务输出，然后记录结果。";
  if (nextStage === "rebuild_page_locally") return "对当前单页运行 image-to-editable-ppt 受限重建。";
  return "确认页面任务已启动，然后领取或派发任务。";
}

function getCodexSlideWorkerNextAction({ selectedTask = null, hasImagePath = false } = {}) {
  if (!selectedTask) return "全量确认后同步 codex 图片页任务。";
  if (selectedTask.status === "recorded") return "图片页已记录；全部完成后可组装图片型 PPT。";
  if (selectedTask.status === "failed") return "检查阻断原因后重置重试。";
  if (selectedTask.status === "claimed" || selectedTask.status === "running") {
    return hasImagePath ? "记录生成图片路径。" : "等待图片页任务输出图片路径。";
  }
  return "确认真实图片页任务已启动，然后领取任务。";
}

function formatWorkerRunSummary(run = {}) {
  if (!run) return "";
  const task = run.taskSummary || run.summary?.taskSummary || null;
  const parts = [];
  if (run.succeeded !== null && run.succeeded !== undefined) parts.push(`succeeded ${run.succeeded}`);
  if (run.failed !== null && run.failed !== undefined) parts.push(`failed ${run.failed}`);
  if (task) parts.push(`recorded ${task.recorded || 0}/${task.total || 0}`);
  if (run.finalize?.ok) parts.push("finalized");
  if (run.finalize?.error) parts.push(`finalize failed: ${run.finalize.error}`);
  if (run.error) parts.push(run.error);
  if (!parts.length && run.startedAt) parts.push(run.startedAt);
  return parts.join(" / ");
}

function deliveryStepTargetId(stepId = "") {
  if (["fix-llm-provider", "fix-llm-provider-quota", "fix-llm-provider-auth"].includes(stepId)) return "workflow-settings-panel";
  if (["start-page-workers", "sync-page-workers", "wait-page-workers", "retry-failed-pages"].includes(stepId)) return "editable-page-worker-panel";
  if (["generate-image-deck"].includes(stepId)) return "codex-slide-worker-panel";
  if (["record-sample-authorization", "record-full-deck-authorization"].includes(stepId)) return "workflow-authorization-panel";
  if (["generate-sample", "approve-sample", "approve-fullDeck"].includes(stepId)) return "workflow-compliance-panel";
  if (["review-validation", "review-delivery", "retry-stale-page-evidence"].includes(stepId)) return "workflow-delivery-panel";
  if (["render-source", "prepare-editable", "finalize-editable", "continue-workflow", "refresh-backend-approval", "refresh-style-approval"].includes(stepId)) return "workflow-compliance-panel";
  return "";
}

function buildRefreshedCodexPptStyleBody(job = {}) {
  const sourceName = job.input?.sourceOriginalName || job.artifacts?.source?.originalName || "";
  const sourceBrief = job.input?.sourceBrief || job.input?.notes || "";
  const pageCount = Array.isArray(job.artifacts?.renderedPages) ? job.artifacts.renderedPages.length : 0;
  const briefParts = [
    "基于 codex-ppt 到 image-to-editable-ppt 的双技能主流程，重新记录整套 PPT 的视觉风格证据。",
    sourceName ? `源文件：${sourceName}。` : "",
    pageCount ? `已渲染源页面：${pageCount} 页。` : "",
    sourceBrief ? `用户需求 / 源稿简述：${sourceBrief}` : "",
    "风格目标：视觉统一、层级清晰、版式随页面角色变化；参考图和源页只作为调性约束，不沿用历史风格包名称。"
  ].filter(Boolean).join(" ");
  return {
    source: "frontend-refresh-skill-first-style",
    title: job.input?.sourceOriginalName || "双技能 codex-ppt 视觉风格",
    styleBrief: briefParts,
    audience: job.input?.audience || "",
    constraints: "Use codex-ppt to create image-based visual pages first, then use image-to-editable-ppt/editppt for editable reconstruction. Do not use historical local style names as product workflow evidence.",
    references: [sourceName].filter(Boolean),
    recordedBy: "frontend-skill-first",
    notes: "从产品级 v1 风格证据保护刷新；不会触发图片生成。",
    invalidateApprovals: true,
    invalidateReason: "style evidence refreshed for skill-first workflow"
  };
}

function mergeApprovalPreflightUi(ui = {}, preflight = null, passed = false) {
  if (!preflight || passed) return ui;
  if (preflight.ready) return {
    ...ui,
    canApprove: Boolean(ui.canApprove),
    blockers: Array.isArray(ui.blockers) ? ui.blockers : []
  };
  const backendBlockers = Array.isArray(preflight.blockers) && preflight.blockers.length
    ? preflight.blockers
    : [preflight.error || "Backend approval preflight is not ready."];
  return {
    ...ui,
    canApprove: false,
    label: "blocked",
    reason: preflight.error || ui.reason || "Backend approval preflight is not ready.",
    status: ui.status === "pass" ? "pass" : "warning",
    blockers: [...new Set([...backendBlockers, ...(Array.isArray(ui.blockers) ? ui.blockers : [])])]
  };
}

function getCodexApprovalGateUiState(gateId = "", { approvalMap = new Map(), bundle = null, job = null, passed = false } = {}) {
  if (passed) return { canApprove: false, label: "passed", reason: "approval evidence recorded", status: "pass" };
  const artifacts = job?.artifacts || {};
  const hasOutline = Boolean(artifacts.codexPptOutline?.path || bundle?.codexPpt?.outline?.path);
  const hasStyle = Boolean(artifacts.codexPptStyle?.path || bundle?.codexPpt?.style?.path);
  const styleLooksLegacy = looksLikeLegacyCodexPptStyle(artifacts.codexPptStyle || bundle?.codexPpt?.style);
  const hasBackend = Boolean(artifacts.codexPptBackendDecision?.path || bundle?.codexPpt?.backendDecision?.path);
  const sampleArtifact = artifacts.visualSample || bundle?.codexPpt?.sample?.artifact || null;
  const hasSample = Boolean(sampleArtifact?.path);
  const sampleLooksNonProduct = looksLikeNonProductVisualSample(sampleArtifact);
  const approved = (id) => Boolean(approvalMap.get(id)?.passed);
  const firstThreeApproved = ["outline", "style", "backend"].every(approved);
  if (gateId === "outline") {
    return hasOutline
      ? { canApprove: true, label: "ready", reason: "大纲证据已存在，可以确认。", status: "ready" }
      : { canApprove: false, label: "pending", reason: "请先生成或记录大纲证据。", status: "pending" };
  }
  if (gateId === "style") {
  if (hasStyle && styleLooksLegacy) return { canApprove: false, label: "blocked", reason: "当前视觉风格证据仍是历史调性，请先刷新视觉风格证据。", status: "warning", blockers: ["历史风格证据不能作为产品级重制流程确认依据。"] };
    return hasStyle
      ? { canApprove: true, label: "ready", reason: "视觉风格证据已存在，可以确认。", status: "ready" }
      : { canApprove: false, label: "pending", reason: "请先生成或记录视觉风格。", status: "pending" };
  }
  if (gateId === "backend") {
    return hasBackend
      ? { canApprove: true, label: "ready", reason: "图片后端已确认。", status: "ready" }
      : { canApprove: false, label: "pending", reason: "请先确认图片后端配置。", status: "pending" };
  }
  if (gateId === "sample") {
    if (!firstThreeApproved) return { canApprove: false, label: "pending", reason: "请先确认大纲、风格和后端。", status: "pending", blockers: ["样张复核前必须先完成大纲、风格和后端确认。"] };
    if (sampleLooksNonProduct) return { canApprove: false, label: "blocked", reason: "请先用已确认的图片运行环境重新生成产品级视觉样张。", status: "warning", blockers: ["验证链路或透传样张证据不能审批。", "请使用当前配置的图片运行环境生成一页产品级样张。"] };
    return hasSample
      ? { canApprove: true, label: "ready", reason: "样张已生成，可以复核。", status: "ready" }
      : { canApprove: false, label: "pending", reason: "请先生成一页视觉样张。", status: "pending", blockers: ["审批前需要先生成并检查一页视觉样张。"] };
  }
  if (gateId === "fullDeck") {
    if (!approved("sample")) return { canApprove: false, label: "pending", reason: "请先确认视觉样张。", status: "pending", blockers: ["产品样张关卡确认前，整套生成会保持锁定。"] };
    if (sampleLooksNonProduct) return { canApprove: false, label: "blocked", reason: "全量授权需要产品级视觉样张。", status: "warning", blockers: ["授权整套图片前，请先重新生成并确认产品级样张。"] };
    return hasSample
      ? { canApprove: true, label: "ready", reason: "样张已通过，可以授权整套生成。", status: "ready" }
      : { canApprove: false, label: "pending", reason: "缺少视觉样张证据。", status: "pending", blockers: ["全量授权前必须有视觉样张证据。"] };
  }
  return { canApprove: false, label: "pending", reason: "未知确认关卡。", status: "pending" };
}

function looksLikeNonProductVisualSample(sample = null) {
  if (!sample) return false;
  const text = [
    sample.source,
    sample.provider,
    sample.model,
    sample.baseUrl,
    sample.dryRun ? "dry-run" : "",
    sample.passthrough ? "passthrough" : ""
  ].join(" ");
  return Boolean(sample.dryRun || sample.passthrough) || /\b(regression|dry[-_\s]?run|dryrun|passthrough|source[-_\s]?page[-_\s]?passthrough)\b/i.test(text);
}

function getBackendRuntimeRefreshState({ bundle = null, job = null } = {}) {
  const provider = bundle?.providers?.image || {};
  const decision = bundle?.codexPpt?.backendDecision || job?.artifacts?.codexPptBackendDecision || {};
  const gates = Array.isArray(bundle?.codexPpt?.approvals?.gates) ? bundle.codexPpt.approvals.gates : [];
  const backendApproved = gates.some((gate) => gate.id === "backend" && gate.passed);
  const runtimeModel = provider.model || "";
  const runtimeBaseUrl = provider.baseUrl || "";
  const approvedModel = decision.model || "";
  const approvedBaseUrl = decision.baseUrl || "";
  const modelMatches = !approvedModel || !runtimeModel || approvedModel === runtimeModel;
  const baseUrlMatches = !approvedBaseUrl || !runtimeBaseUrl || normalizeEndpoint(approvedBaseUrl) === normalizeEndpoint(runtimeBaseUrl);
  const dryRunEvidence = /\b(regression|dry[-_\s]?run|passthrough|source[-_\s]?page[-_\s]?passthrough)\b/i.test([
    decision.source,
    decision.provider,
    decision.model,
    decision.baseUrl
  ].join(" "));
  const runtimeReady = Boolean(provider.configured && provider.enabled !== false && runtimeModel);
  const needsRefresh = Boolean(backendApproved && runtimeReady && (dryRunEvidence || !modelMatches || !baseUrlMatches));
  const approvedLabel = [decision.provider, approvedModel, normalizeEndpoint(approvedBaseUrl)].filter(Boolean).join(" @ ");
  const runtimeLabel = [runtimeModel, normalizeEndpoint(runtimeBaseUrl)].filter(Boolean).join(" @ ");
  return {
    needsRefresh,
    dryRunEvidence,
    approvedLabel,
    runtimeLabel,
    reason: dryRunEvidence
      ? "已确认的后端证据仍像回归验证、dry-run 或透传输出。"
      : "已确认的后端证据不再匹配当前图片运行环境。"
  };
}

function normalizeEndpoint(value = "") {
  return String(value || "").trim().replace(/\/+$/, "");
}

function artifactCount(value) {
  if (Array.isArray(value)) return value.length ? value.length + " 页" : "待处理";
  if (value?.count) return value.count + " 页";
  if (value?.pages?.length) return value.pages.length + " 页";
  if (value?.images?.length) return value.images.length + " 页";
  return value ? "已生成" : "待处理";
}

function artifactCountNumber(value) {
  if (Array.isArray(value)) return value.length;
  if (value?.count) return Number(value.count) || 0;
  if (value?.pages?.length) return value.pages.length;
  if (value?.images?.length) return value.images.length;
  return value ? 1 : 0;
}

function shortPath(value = "") {
  const text = String(value || "");
  if (!text) return "";
  const normalized = text.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.slice(-3).join("/");
}

function shortHash(value = "") {
  const text = String(value || "").trim();
  return text ? text.slice(0, 10) : "-";
}

function fileExt(name = "") { const ext = name.split(".").pop(); return ext ? ext.slice(0, 4).toUpperCase() : "FILE"; }
function getEffectiveProjectName(form = {}, files = []) {
  if (form.projectName?.trim()) return form.projectName.trim();
  const fromNotes = String(form.notes || "").match(/[\u4e00-\u9fa5A-Za-z0-9][\u4e00-\u9fa5A-Za-z0-9\s-]{3,28}/)?.[0]?.trim();
  if (fromNotes) return fromNotes;
  const fromFile = files[0]?.originalName?.replace(/\.[^.]+$/, "")?.trim();
  return fromFile || "未命名项目";
}

function buildSkillFirstBriefSource({ form = {}, outlinePlan = null, files = [], inferredMaterials = [] } = {}) {
  const outline = outlinePlan?.layoutSequence || [];
  const lines = [
    `项目：${getEffectiveProjectName(form, files)}`,
    form.audience ? `受众：${form.audience}` : "",
    form.pageCount ? `页数偏好：${form.pageCount}` : "",
    form.copyMode ? `文案模式：${form.copyMode}` : "",
    inferredMaterials.length ? `推断资料类型：${inferredMaterials.join("、")}` : "",
    files.length ? `已上传文件：${files.map((file) => file.originalName || file.id).filter(Boolean).join("、")}` : "已上传文件：无",
    "",
    "用户需求：",
    form.notes?.trim() || "未提供自由描述。",
    "",
    outline.length ? "已确认大纲：" : "",
    ...outline.map((step, index) => [
      `${index + 1}. ${step.title || LAYOUT_LABELS[step.layout] || step.layout || "未命名页面"}`,
      step.layout ? `   版式：${step.layout}` : "",
      step.purpose ? `   目的：${step.purpose}` : "",
      step.storyRole ? `   叙事角色：${step.storyRole}` : "",
      step.evidence ? `   证据：${step.evidence}` : ""
    ].filter(Boolean).join("\n"))
  ];
  return lines.filter((line) => line !== "").join("\n");
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
      reply: "我是 PPT 设计助手。你可以让我从零制作 PPT、重制源稿、提取 PDF/文档要点、统一风格、先出大纲、先出样张，并导出可编辑 PPTX。"
    };
  }
  if (/先问|问我|引导|不知道怎么说|帮我梳理/.test(normalized)) {
    return {
      kind: "question",
      actionable: false,
      reply: "可以。先回答三点：谁会看这份 PPT、希望他们做什么决定、整体风格想偏向哪一种？"
    };
  }
  if (/开始|继续|生成大纲|出大纲|下一步/.test(normalized) && readiness.ready) {
    return {
      kind: "ready",
      actionable: false,
      reply: "信息已经足够先规划。可以使用生成大纲动作，先得到一版可确认的大纲，再制作完整 PPT。"
    };
  }
  if (isVaguePptRequest(normalized) && !files.length) {
    return {
      kind: "question",
      actionable: false,
      reply: "可以做，但需求还比较宽。请补充主题、受众、大致页数和偏好的风格。"
    };
  }
  if (/优化|重塑|重做|改旧稿|旧\s*PPT|原稿/.test(normalized) && !files.length) {
    return {
      kind: "upload-needed",
      actionable: true,
      reply: "我理解你想重制源稿。请先上传 PPT/PDF/图片，我会先识别原文字、图片和素材，再判断是保留结构优化还是重新规划。"
    };
  }
  return {
    kind: readiness.ready ? "ready" : "collecting",
    actionable: true,
    reply: readiness.ready
      ? "需求已记录。当前信息足够先生成一版可确认的大纲，你仍然可以继续补充风格、受众或参考资料。"
      : `我已记录这条需求。还差一步：${readiness.nextQuestion}`
  };
}

function buildIntakeReply(text = "", files = []) {
  const normalized = String(text || "").trim();
  const hasFiles = files.length > 0;
  if (isMetaIntakeQuestion(normalized)) {
    return "我可以先和你聊清楚 PPT 目标、受众、风格和资料，再生成可确认的大纲；如果你上传现有 PPT/PDF/图片，我会先识别原文字、图片和素材身份，再决定是保留源稿重制还是重新规划。";
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
  return value.length < 18 && !/[，。；;？?]/.test(value);
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
      label: "需求可用",
      hint: "可以先生成大纲，后续再细化风格或素材。",
      nextQuestion: "信息已足够。"
    };
  }
  const missing = [];
  if (!hasTopic || !hasGoal) missing.push("主题和目标");
  if (!hasAudience) missing.push("受众");
  if (!hasStyle) missing.push("期望风格或参考");
  return {
    ready: false,
    label: text ? "正在收集需求" : "等待你发起对话",
    hint: text ? "我会先追问必要信息，再进入大纲生成。" : "你可以问我能做什么，也可以直接描述你需要的 PPT。",
    nextQuestion: "请补充 " + missing.slice(0, 2).join(" / ") + "。"
  };
}

function formatBytes(value) { if (!value) return "-"; if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`; return `${(value / 1024 / 1024).toFixed(1)} MB`; }
function inputStrengthLabel(value) { if (value === "strong") return "资料充足"; if (value === "weak") return "资料有限"; if (value === "empty") return "无资料"; return "资料待补充"; }
function uniqueList(items = []) { return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))]; }

function getOutlineSourceMeta(step = {}) {
  const type = step.sourceType || (step.kind === "source" ? "original-ppt" : "");
  if (type === "original-ppt") return { label: step.sourceLabel || "来自原 PPT", tone: "source-original", evidence: step.evidence || "" };
  if (type === "extracted") return { label: step.sourceLabel || "资料抽取", tone: "source-extracted", evidence: step.evidence || "" };
  if (type === "needs-confirmation" || step.needsConfirmation) return { label: step.sourceLabel || "需要确认", tone: "source-confirm", evidence: step.evidence || "" };
  if (["prices", "products", "productDetail", "visual", "compare", "bundle"].includes(step.kind)) return { label: "资料抽取", tone: "source-extracted", evidence: step.evidence || "" };
  if (["risks", "assumptions"].includes(step.kind)) return { label: "需要确认", tone: "source-confirm", evidence: step.evidence || "" };
  return { label: step.sourceLabel || "AI 推断", tone: "source-inferred", evidence: step.evidence || "" };
}

function formatDuration(seconds = 0) { const value = Math.max(0, Number(seconds) || 0); if (value < 60) return `${value}s`; if (value < 3600) return `${Math.floor(value / 60)}m`; return `${Math.floor(value / 3600)}h ${Math.floor((value % 3600) / 60)}m`; }
function isMojibake(value = "") { return ["閿", "鑴", "鑾", "闂", "闁"].some((token) => String(value).includes(token)); }

function makeOutlineStep(layout = "section") {
  const map = {
    cover: ["封面", "建立主题和第一视觉印象", "开场"],
    visual: ["视觉页", "用大图承载关键场景", "视觉证明"],
    section: ["章节页", "切换叙事章节", "过渡"],
    toc: ["目录", "解释整套结构", "导航"],
    kpi: ["关键指标", "突出数字和结果", "数据证明"],
    pricing: ["预算与规格", "呈现预算、规格和待确认数字", "数字依据"],
    "product-detail": ["详情页", "展示单个对象、模块或素材说明", "事实说明"],
    bundle: ["分组方案", "解释不同组别、档位或路径", "方案组织"],
    "risk-checklist": ["确认清单", "展示交付、事实和人工确认项", "边界确认"],
    compare: ["对比", "比较选项", "决策支持"],
    timeline: ["时间线", "解释里程碑和节奏", "执行路径"],
    cards: ["信息卡片", "拆分关键信息", "摘要"],
    quote: ["核心信息", "浓缩一句可复用表达", "记忆点"],
    closing: ["下一步行动", "以确认项收尾", "行动收口"]
  };
  const [title, purpose, storyRole] = map[layout] || map.section;
  return { layout, title, purpose, storyRole, kind: layout, imageSlots: [] };
}

function isRestorableJob(job = {}) {
  const deck = job.deck || {};
  const firstSlide = deck.slides?.[0] || {};
  const text = [deck.title, deck.summary, firstSlide.title, firstSlide.subtitle, ...(firstSlide.bullets || []), job.input?.projectName, job.input?.notes].filter(Boolean).join(" ");
  if (!text.trim()) return false;
  const questionMarks = (text.match(/\?/g) || []).length;
  const signalChars = text.replace(/[\s\d.,\uFF0C\u3002:;\uFF1A\uFF1B()\uFF08\uFF09[\]{}?!\uFF1F\uFF01_*\\-]/g, "").length;
  if (questionMarks >= 6 && questionMarks > signalChars * 0.25) return false;
  if (/<!doctype|not valid JSON/i.test(job.warning || "")) return false;
  return true;
}

function isFullDeckJob(job = {}) {
  const slideCount = job.deck?.slides?.length || 0;
  return job.mode !== "style-preview" && !job.input?.styleProof && slideCount > 4;
}

function isPreferredStartupJob(job = {}) { if (!isRestorableJob(job)) return false; const slideCount = job.deck?.slides?.length || 0; const previewCount = (job.previewImages || []).filter(Boolean).length; const routeScore = Number(job.quality?.routeAdherence?.score ?? 1); const warningCount = Number(job.quality?.warningCount || job.quality?.warnings?.length || 0); if (!slideCount || previewCount < slideCount) return false; if (warningCount > 12 && routeScore < 0.5) return false; return true; }

createRoot(document.getElementById("root")).render(<App />);
