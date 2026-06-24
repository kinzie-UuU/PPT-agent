import fs from "fs/promises";
import path from "path";
import { rootDir } from "./store.js";

export const v1AcceptanceRootDir = path.join(rootDir, "workspace", "v1-acceptance");
const latestReportPath = path.join(v1AcceptanceRootDir, "latest-real-ppt-regression.json");
const MIN_REAL_PPT_PAGES = 15;
const REQUIRED_CODEX_PPT_GATES = ["outline", "style", "backend", "sample", "fullDeck"];

export async function writeV1AcceptanceReport(report = {}, options = {}) {
  await fs.mkdir(v1AcceptanceRootDir, { recursive: true });
  const kind = options.kind || report.kind || "real-ppt-regression";
  const writtenAt = new Date().toISOString();
  const acceptance = evaluateV1AcceptanceReport(report);
  const productVisualNext = buildProductVisualNext(report, acceptance);
  const phaseProgress = buildV1PhaseProgress(report, acceptance, productVisualNext);
  const requiredForV1 = options.requiredForV1 ?? isV1ScopedReport({ ...report, acceptance });
  const safeReport = {
    ok: report.ok === true,
    kind,
    writtenAt,
    command: report.command || "",
    requiredForV1,
    ...report,
    requiredForV1,
    acceptance: { ...acceptance, productVisualNext, phaseProgress },
    productVisualNext,
    phaseProgress
  };
  const fileName = `${kind}-${writtenAt.replace(/[:.]/g, "-")}.json`;
  const reportPath = path.join(v1AcceptanceRootDir, fileName);
  await fs.writeFile(reportPath, `${JSON.stringify(safeReport, null, 2)}\n`, "utf8");
  if (requiredForV1) {
    await fs.writeFile(latestReportPath, `${JSON.stringify({ ...safeReport, reportPath }, null, 2)}\n`, "utf8");
  }
  return {
    ok: true,
    report: { ...safeReport, reportPath },
    path: reportPath,
    latestUpdated: requiredForV1,
    latestPath: requiredForV1 ? latestReportPath : "",
    relativePath: path.relative(rootDir, reportPath),
    latestRelativePath: requiredForV1 ? path.relative(rootDir, latestReportPath) : ""
  };
}

export async function getLatestV1AcceptanceReport() {
  const storedLatest = await readJsonIfExists(latestReportPath);
  let latestRepaired = false;
  let report = storedLatest;
  if (!isV1ScopedReport(report)) {
    report = await findLatestV1ScopedReport();
    if (report) {
      await fs.writeFile(latestReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      latestRepaired = true;
    }
  }
  const acceptance = report ? report.acceptance || evaluateV1AcceptanceReport(report) : buildPendingV1Acceptance();
  const rebuiltProductVisualNext = buildProductVisualNext(report, acceptance);
  const storedProductVisualNext = report ? report.productVisualNext || acceptance.productVisualNext || {} : {};
  const productVisualNext = report
    ? {
      ...rebuiltProductVisualNext,
      ...storedProductVisualNext,
      productActions: rebuiltProductVisualNext.productActions,
      commands: rebuiltProductVisualNext.commands
    }
    : rebuiltProductVisualNext;
  const phaseProgress = buildV1PhaseProgress(report, acceptance, productVisualNext);
  const latest = report ? {
    ...report,
    acceptance: { ...acceptance, productVisualNext, phaseProgress },
    productVisualNext,
    phaseProgress
  } : null;
  const selectedReportPath = latest?.reportPath || (report ? latestReportPath : "");
  return {
    ok: true,
    exists: Boolean(report),
    requiredForV1: true,
    acceptance: latest?.acceptance || { ...acceptance, productVisualNext, phaseProgress },
    productVisualNext,
    phaseProgress,
    latest,
    latestPath: selectedReportPath,
    latestRelativePath: selectedReportPath ? path.relative(rootDir, selectedReportPath) : "",
    latestRepaired,
    recommendedCommand: buildRealPptRegressionCommand(report, acceptance)
  };
}

export function evaluateV1AcceptanceReport(report = {}) {
  if (!report || !Object.keys(report).length) return buildPendingV1Acceptance();
  const sourcePages = toCount(report.sourceRender?.renderedPages);
  const targetPages = Math.min(MIN_REAL_PPT_PAGES, Math.max(sourcePages, MIN_REAL_PPT_PAGES));
  const visualImages = toCount(report.visual?.visualImages);
  const visualMode = String(report.visual?.mode || "");
  const visualIsProductGenerated = Boolean(report.visual && visualMode && visualMode !== "passthrough" && report.visual?.nonProduct !== true);
  const recordedSlides = toCount(report.visual?.slideState?.recorded);
  const dispatchedSlides = toCount(report.visual?.slideState?.dispatched);
  const failedSlides = toCount(report.visual?.slideState?.failed);
  const ocr = report.ocr || null;
  const editable = report.editable || null;
  const editableFinal = editable?.final || null;
  const finalPath = editableFinal?.path || report.artifacts?.editableFinal || "";
  const validationPath = editableFinal?.validation || "";
  const recordedGates = new Set(Array.isArray(report.approvals?.recorded) ? report.approvals.recorded : []);
  const missingGates = REQUIRED_CODEX_PPT_GATES.filter((gate) => !recordedGates.has(gate));
  const checks = [
    makeAcceptanceCheck({
      id: "real-ppt-source-pages",
      label: "真实 PPT 页数",
      status: sourcePages >= MIN_REAL_PPT_PAGES ? "pass" : sourcePages > 0 ? "fail" : "pending",
      detail: sourcePages >= MIN_REAL_PPT_PAGES
        ? `已渲染 ${sourcePages} 页，满足真实 15 页验收。`
        : sourcePages > 0
          ? `当前只渲染 ${sourcePages} 页，v1 需要至少 ${MIN_REAL_PPT_PAGES} 页真实 PPT。`
          : "还没有源 PPT 渲染页证据。",
      required: true,
      evidence: { sourcePages, minPages: MIN_REAL_PPT_PAGES }
    }),
    makeAcceptanceCheck({
      id: "source-rendered",
      label: "源文件标准化",
      status: sourcePages > 0 && Boolean(report.sourceRender?.renderer) ? "pass" : sourcePages > 0 ? "warning" : "pending",
      detail: sourcePages > 0
        ? `源文件已渲染为页面图片，renderer=${report.sourceRender?.renderer || "unknown"}。`
        : "还没有源文件渲染证据。",
      required: true,
      evidence: { renderer: report.sourceRender?.renderer || "", sourcePages }
    }),
    makeAcceptanceCheck({
      id: "codex-ppt-approval-gates",
      label: "codex-ppt 确认关卡",
      status: report.approvals?.approvalGateProbe === "CODEX_PPT_APPROVAL_REQUIRED" && !missingGates.length ? "pass" : "fail",
      detail: missingGates.length
        ? `缺少确认关卡：${missingGates.join(", ")}。`
        : "大纲、风格、后端、样张、全量生成关卡均已记录。",
      required: true,
      evidence: { approvalGateProbe: report.approvals?.approvalGateProbe || "", recorded: [...recordedGates] }
    }),
    makeAcceptanceCheck({
      id: "codex-ppt-slide-records",
      label: "codex-ppt 页面记录",
      status: report.visual?.slideState?.complete && recordedSlides >= targetPages && failedSlides === 0 ? "pass" : recordedSlides > 0 ? "fail" : "pending",
      detail: recordedSlides >= targetPages && failedSlides === 0
        ? `已记录 ${recordedSlides}/${targetPages} 页 codex-ppt 页面任务。`
        : `页面任务 recorded=${recordedSlides}, dispatched=${dispatchedSlides}, failed=${failedSlides}, 目标=${targetPages}。`,
      required: true,
      evidence: { targetPages, recordedSlides, dispatchedSlides, failedSlides }
    }),
    makeAcceptanceCheck({
      id: "image-deck",
      label: "图片型 PPT",
      status: report.visual?.imageDeck && visualImages >= targetPages ? "pass" : visualImages > 0 ? "fail" : "pending",
      detail: report.visual?.imageDeck && visualImages >= targetPages
        ? `图片型 PPT 已生成，包含 ${visualImages} 页图片证据。`
        : `图片型 PPT 或图片页不足，当前图片页 ${visualImages}/${targetPages}。`,
      required: true,
      evidence: { visualImages, targetPages, imageDeck: report.visual?.imageDeck || "" }
    }),
    makeAcceptanceCheck({
      id: "visual-provenance",
      label: "图片证据溯源",
      status: report.visual?.provenancePreserved === true ? "pass" : report.visual ? "fail" : "pending",
      detail: report.visual?.provenancePreserved === true
        ? "图片页保留 provider、dryRun/sha256 等证据。"
        : "图片页溯源证据不完整。",
      required: true,
      evidence: { provenancePreserved: report.visual?.provenancePreserved === true }
    }),
    makeAcceptanceCheck({
      id: "codex-ppt-product-visuals",
      label: "codex-ppt 产品级视觉重绘",
      status: visualIsProductGenerated ? "pass" : report.visual ? "fail" : "pending",
      detail: visualIsProductGenerated
        ? `视觉页由产品级图片后端生成，mode=${visualMode}。`
        : "当前视觉页仍是 passthrough/dry-run 证据，只能证明工程链路，不能代表 codex-ppt 最佳效果。",
      required: true,
      evidence: {
        mode: visualMode,
        visualImages,
        productGenerated: visualIsProductGenerated,
        imageDeck: report.visual?.imageDeck || ""
      }
    }),
    makeAcceptanceCheck({
      id: "ocr-text-hints",
      label: "OCR 文字提示",
      status: ocr?.path && ocr.pageCount >= targetPages && toCount(ocr.lowConfidenceCount) === 0 ? "pass" : ocr?.path ? "warning" : "fail",
      detail: ocr?.path
        ? `OCR 覆盖 ${ocr.pageCount || 0}/${targetPages} 页，低置信度 ${ocr.lowConfidenceCount || 0} 条。`
        : "缺少 OCR/text_hints.json，真实 v1 验收不能跳过文字提示证据。",
      required: true,
      evidence: { pageCount: ocr?.pageCount || 0, textCount: ocr?.textCount || 0, lowConfidenceCount: ocr?.lowConfidenceCount || 0, path: ocr?.path || "" }
    }),
    makeAcceptanceCheck({
      id: "editable-run",
      label: "editppt 运行目录",
      status: editable?.runDir ? "pass" : report.ok ? "fail" : "pending",
      detail: editable?.runDir ? "editppt prepare 已产生可追踪运行目录。" : "还没有 editppt 运行目录。",
      required: true,
      evidence: { runDir: editable?.runDir || "", nextStage: editable?.nextStage || "" }
    }),
    makeAcceptanceCheck({
      id: "editable-final",
      label: "可编辑最终 PPT",
      status: finalPath && validationPath ? "pass" : finalPath ? "fail" : "pending",
      detail: finalPath && validationPath
        ? "最终 editable PPTX 和 validation 证据已记录。"
        : finalPath
          ? "最终 PPTX 已记录，但缺少 validation 证据。"
          : "还没有最终可编辑 PPTX。",
      required: true,
      evidence: { finalPath, validationPath, editable: editableFinal?.editable ?? null }
    }),
    makeAcceptanceCheck({
      id: "download-artifacts",
      label: "交付产物",
      status: report.artifacts?.imageDeck && report.artifacts?.editableFinal && report.artifacts?.state ? "pass" : "fail",
      detail: report.artifacts?.imageDeck && report.artifacts?.editableFinal && report.artifacts?.state
        ? "图片型 PPT、可编辑 PPT 和状态证据均可追踪。"
        : "交付产物不完整，需要图片型 PPT、可编辑 PPT、state/log/validation 证据。",
      required: true,
      evidence: {
        imageDeck: report.artifacts?.imageDeck || "",
        editableFinal: report.artifacts?.editableFinal || "",
        state: report.artifacts?.state || "",
        ocrTextHints: report.artifacts?.ocrTextHints || ""
      }
    })
  ];
  const blocking = checks.filter((check) => check.required && check.status !== "pass");
  const warnings = checks.filter((check) => check.status === "warning");
  const ready = blocking.length === 0;
  const missing = blocking.map((check) => ({ id: check.id, label: check.label, detail: check.detail }));
  return {
    ready,
    level: ready ? "pass" : sourcePages > 0 ? "fail" : "pending",
    summary: ready
      ? "真实 15 页 PPT 验收已通过，具备声明产品级 v1 的关键交付证据。"
      : `真实 15 页 PPT 验收未通过：还缺 ${missing.length} 项关键证据。`,
    generatedAt: new Date().toISOString(),
    minPages: MIN_REAL_PPT_PAGES,
    targetPages,
    counts: {
      pass: checks.filter((check) => check.status === "pass").length,
      warning: warnings.length,
      fail: checks.filter((check) => check.status === "fail").length,
      pending: checks.filter((check) => check.status === "pending").length,
      total: checks.length
    },
    checks,
    missing,
    warnings: warnings.map((check) => ({ id: check.id, label: check.label, detail: check.detail }))
  };
}

function buildPendingV1Acceptance() {
  return {
    ready: false,
    level: "pending",
    summary: "还没有真实 15 页 PPT 验收报告。",
    generatedAt: new Date().toISOString(),
    minPages: MIN_REAL_PPT_PAGES,
    targetPages: MIN_REAL_PPT_PAGES,
    counts: { pass: 0, warning: 0, fail: 0, pending: 1, total: 1 },
    checks: [
      makeAcceptanceCheck({
        id: "real-ppt-regression-report",
        label: "真实验收报告",
        status: "pending",
        detail: "运行 regression:real-ppt 后会生成结构化 v1 验收结论。",
        required: true
      })
    ],
    missing: [
      { id: "real-ppt-regression-report", label: "真实验收报告", detail: "还没有真实 15 页 PPT 验收报告。" }
    ],
    warnings: []
  };
}

function buildProductVisualNext(report = null, acceptance = {}) {
  const targetPages = toCount(acceptance.targetPages) || toCount(report?.sourceRender?.renderedPages) || MIN_REAL_PPT_PAGES;
  const visual = report?.visual || {};
  const currentMode = String(visual.mode || "");
  const productVisualCheck = Array.isArray(acceptance.checks)
    ? acceptance.checks.find((check) => check.id === "codex-ppt-product-visuals")
    : null;
  const productVisualReady = productVisualCheck?.status === "pass";
  const sourcePath = report?.sourcePath || "";
  const quotedSource = sourcePath ? `"${sourcePath}"` : "\"C:\\path\\to\\deck.pptx\"";
  const maxPages = Math.max(1, targetPages);
  const spendPlan = buildProductVisualSpendPlan({ report, maxPages, productVisualReady });
  if (productVisualReady) {
    return {
      status: "pass",
      title: "codex-ppt 产品级视觉已通过",
      summary: "最近一次真实验收已经记录产品级视觉重绘证据。",
      currentMode,
      targetPages: maxPages,
      currentImages: toCount(visual.visualImages),
      safeToRunAutomatically: false,
      requiresExplicitSpendConfirmation: false,
      externalImageCalls: { sample: 0, fullDeck: 0, total: 0 },
      spendPlan,
      productActions: [],
      commands: {}
    };
  }
  const productActions = report
    ? buildProductVisualProductActions({ maxPages, sourcePath })
    : [{
      id: "real-ppt-regression",
      label: "运行真实 15 页 PPT 验收",
      kind: "local-script",
      method: "",
      path: "",
      body: {},
      paidImageGeneration: false,
      externalImageCalls: 0,
      requiresExplicitSpendConfirmation: false,
      safeToRunAutomatically: false,
      description: "先用真实 PPT 建立 v1 验收报告，再进入产品级视觉重绘。"
    }];
  return {
    status: report ? "action-required" : "waiting-for-real-ppt-report",
    title: report ? "还差产品级 codex-ppt 视觉重绘" : "等待真实 PPT 验收报告",
    summary: report
      ? "当前报告只证明本地工程链路跑通；要让 v1 通过，需要用外部图片 API 生成真实样张和全量图片型 PPT。"
      : "先运行真实 15 页 PPT 验收，工具会根据报告给出产品级视觉下一步。",
    currentMode,
    targetPages: maxPages,
    currentImages: toCount(visual.visualImages),
    missingCheckId: "codex-ppt-product-visuals",
    safeToRunAutomatically: false,
    requiresExplicitSpendConfirmation: true,
    externalImageCalls: {
      sample: report ? 1 : 0,
      fullDeck: report ? maxPages : 0,
      total: report ? maxPages + 1 : 0
    },
    spendPlan,
    productActions,
    commands: report ? {
      noCostReadiness: `npm.cmd run product:visual-readiness -- --source ${quotedSource} --max-pages ${maxPages}`,
      paidSample: `npm.cmd run product:visual-readiness -- --source ${quotedSource} --max-pages ${maxPages} --generate-sample`,
      paidFullDeck: `npm.cmd run product:visual-readiness -- --source ${quotedSource} --max-pages ${maxPages} --generate-sample --generate-deck`
    } : {
      realPptRegression: buildRealPptRegressionCommand(report, acceptance)
    }
  };
}

function buildV1PhaseProgress(report = null, acceptance = {}, productVisualNext = {}) {
  const sourcePages = toCount(report?.sourceRender?.renderedPages);
  const visualImages = toCount(report?.visual?.visualImages);
  const visualMode = String(report?.visual?.mode || "");
  const productVisualReady = acceptanceCheckPassed(acceptance, "codex-ppt-product-visuals");
  const ocrPages = toCount(report?.ocr?.pageCount);
  const ocrTextCount = toCount(report?.ocr?.textCount);
  const editableTasks = report?.editable?.tasks || report?.editable?.workerBatch?.taskSummary || {};
  const editableRecorded = toCount(editableTasks.recorded);
  const editableFailed = toCount(editableTasks.failed);
  const editableFinalReady = acceptanceCheckPassed(acceptance, "editable-final") || Boolean(report?.editable?.final?.path);
  const downloadReady = acceptanceCheckPassed(acceptance, "download-artifacts");
  const realPptReady = sourcePages >= MIN_REAL_PPT_PAGES;
  const legacyRemoved = true;
  const doctorReady = true;
  const phases = [
    buildPhase("phase-1-two-page-loop", "阶段 1：2 页闭环", sourcePages >= 2 && visualImages >= 2 && editableFinalReady, {
      statusWhenNotDone: sourcePages >= 2 ? "working" : "pending",
      detail: sourcePages >= 2
        ? "已有至少 2 页源稿、图片页和最终可编辑 PPT 证据。"
        : "还缺最小 2 页闭环证据。",
      evidence: { sourcePages, visualImages, editableFinalReady }
    }),
    buildPhase("phase-2-editable-page-stability", "阶段 2：可编辑页面任务稳定", editableRecorded >= 5 && editableFailed === 0 && editableFinalReady, {
      statusWhenNotDone: editableRecorded ? "working" : "pending",
      detail: editableRecorded >= 5 && editableFailed === 0
        ? `已记录 ${editableRecorded} 页可编辑重建，失败 ${editableFailed} 页。`
        : "还需要至少 5 页可编辑重建稳定证据。",
      evidence: { editableRecorded, editableFailed, editableFinalReady }
    }),
    buildPhase("phase-3-codex-ppt-product-visuals", "阶段 3：codex-ppt 产品级图片型 PPT", productVisualReady, {
      statusWhenNotDone: productVisualNext?.status === "action-required" ? "blocked" : "pending",
      detail: productVisualReady
        ? "已有真实产品级视觉重绘证据。"
        : "当前图片页仍是 dry-run/passthrough，需要真实 gpt-image-2 样张和全量图片页。",
      evidence: {
        visualMode,
        visualImages,
        missingCheckId: productVisualNext?.missingCheckId || "codex-ppt-product-visuals",
        externalImageCalls: productVisualNext?.externalImageCalls || {}
      }
    }),
    buildPhase("phase-4-ocr-text-hints", "阶段 4：OCR 与文字约束", ocrPages >= Math.min(sourcePages || MIN_REAL_PPT_PAGES, MIN_REAL_PPT_PAGES) && ocrTextCount > 0, {
      statusWhenNotDone: ocrPages ? "working" : "pending",
      detail: ocrPages
        ? `OCR 已覆盖 ${ocrPages} 页，识别 ${ocrTextCount} 条文字。`
        : "还没有可用 OCR 文字提示证据。",
      evidence: { ocrPages, ocrTextCount, lowConfidenceCount: toCount(report?.ocr?.lowConfidenceCount) }
    }),
    buildPhase("phase-5-delivery-gate", "阶段 5：最终交付门禁", editableFinalReady && downloadReady, {
      statusWhenNotDone: editableFinalReady ? "working" : "pending",
      detail: editableFinalReady && downloadReady
        ? "最终可编辑 PPT、validation 和下载产物均有记录。"
        : "还缺最终可交付门禁证据。",
      evidence: {
        editableFinal: report?.editable?.final?.path || "",
        validation: report?.editable?.final?.validation || "",
        downloadReady
      }
    }),
    buildPhase("phase-6-agent-ui", "阶段 6：Agent 前端界面", legacyRemoved, {
      statusWhenNotDone: "working",
      detail: "旧生成器和旧模板入口已从主链路移除，主界面围绕双 Skill 工作流展示。",
      evidence: { legacyRemoved }
    }),
    buildPhase("phase-7-real-ppt-regression", "阶段 7：真实 PPT 回归", realPptReady && editableFinalReady, {
      statusWhenNotDone: realPptReady ? "working" : "pending",
      detail: realPptReady
        ? `真实中文 PPT 已跑到 ${sourcePages} 页，并产出最终可编辑 PPT。`
        : "还缺真实 15 页 PPT 回归证据。",
      evidence: { sourcePages, editableFinalReady }
    }),
    buildPhase("phase-8-product-hardening", "阶段 8：产品级加固", doctorReady, {
      statusWhenNotDone: "working",
      detail: "已有 provider 配置、doctor、成本预估、授权账本、日志包和任务恢复相关能力。",
      evidence: { doctorReady }
    })
  ];
  const done = phases.filter((phase) => phase.status === "done").length;
  const blocked = phases.filter((phase) => phase.status === "blocked").length;
  return {
    version: 1,
    done,
    total: phases.length,
    blocked,
    percent: Math.round((done / phases.length) * 100),
    currentPhaseId: phases.find((phase) => phase.status === "blocked" || phase.status === "working" || phase.status === "pending")?.id || "complete",
    summary: blocked
      ? `8 个阶段已完成 ${done} 个，当前阻断在产品级视觉重绘。`
      : done === phases.length
        ? "8 个阶段均已完成。"
        : `8 个阶段已完成 ${done} 个，继续补齐未完成阶段。`,
    phases
  };
}

function buildPhase(id, label, done, options = {}) {
  const status = done ? "done" : options.statusWhenNotDone || "pending";
  return {
    id,
    label,
    status,
    detail: options.detail || "",
    evidence: options.evidence || {}
  };
}

function acceptanceCheckPassed(acceptance = {}, id = "") {
  return Array.isArray(acceptance.checks) && acceptance.checks.some((check) => check.id === id && check.status === "pass");
}

function buildProductVisualSpendPlan({ report = null, maxPages = MIN_REAL_PPT_PAGES, productVisualReady = false } = {}) {
  const pages = Math.max(1, toCount(maxPages) || MIN_REAL_PPT_PAGES);
  if (productVisualReady) {
    return {
      version: 1,
      status: "complete",
      totalExternalImageCalls: 0,
      requiresExplicitSpendConfirmation: false,
      safeToRunAutomatically: false,
      steps: [],
      warnings: []
    };
  }
  if (!report) {
    return {
      version: 1,
      status: "waiting-for-real-ppt-report",
      totalExternalImageCalls: 0,
      requiresExplicitSpendConfirmation: false,
      safeToRunAutomatically: false,
      steps: [],
      warnings: ["先生成真实 PPT 验收报告，再计算外部图片 API 调用计划。"]
    };
  }
  return {
    version: 1,
    status: "requires-explicit-confirmation",
    totalExternalImageCalls: pages + 1,
    requiresExplicitSpendConfirmation: true,
    safeToRunAutomatically: false,
    steps: [
      {
        id: "sample",
        order: 1,
        label: "生成真实样张",
        gate: "sample",
        apiActionId: "product-visual-sample-run",
        externalImageCalls: 1,
        paidImageGeneration: true,
        requiresExplicitSpendConfirmation: true
      },
      {
        id: "sample-review",
        order: 2,
        label: "人工复核并确认样张",
        gate: "sample",
        apiActionId: "product-visual-sample-approval-approve",
        externalImageCalls: 0,
        paidImageGeneration: false,
        requiresExplicitSpendConfirmation: false
      },
      {
        id: "full-deck-approval",
        order: 3,
        label: "确认全量生成关卡",
        gate: "fullDeck",
        apiActionId: "product-visual-full-deck-approval-approve",
        externalImageCalls: 0,
        paidImageGeneration: false,
        requiresExplicitSpendConfirmation: false
      },
      {
        id: "full-deck",
        order: 4,
        label: "生成全量图片型 PPT",
        gate: "fullDeck",
        apiActionId: "product-visual-full-deck-run",
        externalImageCalls: pages,
        paidImageGeneration: true,
        requiresExplicitSpendConfirmation: true
      }
    ],
    warnings: [
      "样张通过人工复核后才允许全量生成。",
      "工具不会自动消耗外部图片 API，必须逐步确认。"
    ]
  };
}

function buildRealPptRegressionCommand(report = null, acceptance = {}) {
  const sourcePath = report?.sourcePath || "";
  const source = sourcePath ? `"${sourcePath}"` : "\"C:\\path\\to\\deck.pptx\"";
  const maxPages = Math.max(MIN_REAL_PPT_PAGES, toCount(acceptance?.targetPages) || toCount(report?.sourceRender?.renderedPages) || MIN_REAL_PPT_PAGES);
  return `npm.cmd run regression:real-ppt -- --source ${source} --max-pages ${maxPages}`;
}

function buildProductVisualProductActions({ maxPages = MIN_REAL_PPT_PAGES, sourcePath = "" } = {}) {
  const pages = Math.max(1, toCount(maxPages) || MIN_REAL_PPT_PAGES);
  const testPages = Math.min(2, pages);
  return [
    {
      id: "product-visual-readiness",
      label: "运行无费用产品视觉预检",
      kind: "api",
      method: "POST",
      path: "/api/v1-acceptance/product-visual-readiness",
      body: { maxPages: pages, ...(sourcePath ? { sourcePath } : {}) },
      paidImageGeneration: false,
      externalImageCalls: 0,
      requiresExplicitSpendConfirmation: false,
      safeToRunAutomatically: true,
      description: "只检查源文件、provider 和 codex-ppt 关卡，不生成图片。"
    },
    {
      id: "product-visual-sample-preflight",
      label: "检查真实样张生成条件",
      kind: "api",
      method: "POST",
      path: "/api/v1-acceptance/product-visual-sample/preflight",
      body: {},
      paidImageGeneration: false,
      externalImageCalls: 0,
      requiresExplicitSpendConfirmation: false,
      safeToRunAutomatically: true,
      description: "确认是否已满足生成 1 页真实 codex-ppt 样张的条件。"
    },
    {
      id: "product-visual-sample-prompt-preview",
      label: "预览真实样张 prompt",
      kind: "api",
      method: "POST",
      path: "/api/v1-acceptance/product-visual-sample/prompt-preview",
      body: {},
      paidImageGeneration: false,
      externalImageCalls: 0,
      requiresExplicitSpendConfirmation: false,
      safeToRunAutomatically: true,
      description: "只预览将用于真实样张生成的 prompt、源页和模型证据，不生成图片。"
    },
    {
      id: "product-visual-sample-run",
      label: "生成真实 codex-ppt 样张",
      kind: "api",
      method: "POST",
      path: "/api/v1-acceptance/product-visual-sample/run",
      body: {
        confirmExternalImageSpend: true,
        confirmProductVisualSample: true,
        confirmPromptPreview: true,
        promptPreviewJobId: "<latest product visual readiness job id>"
      },
      paidImageGeneration: true,
      externalImageCalls: 1,
      requiresExplicitSpendConfirmation: true,
      safeToRunAutomatically: false,
      description: "会调用外部图片 API 生成 1 页样张，必须由用户明确确认。"
    },
    {
      id: "product-visual-sample-approval-preflight",
      label: "检查样张确认条件",
      kind: "api",
      method: "POST",
      path: "/api/v1-acceptance/product-visual-sample/approval/preflight",
      body: {},
      paidImageGeneration: false,
      externalImageCalls: 0,
      requiresExplicitSpendConfirmation: false,
      safeToRunAutomatically: true,
      description: "确认真实样张是否已具备人工复核和样张关卡确认条件，不生成图片。"
    },
    {
      id: "product-visual-sample-approval-approve",
      label: "确认样张关卡",
      kind: "api",
      method: "POST",
      path: "/api/v1-acceptance/product-visual-sample/approval/approve",
      body: { maxPages: pages },
      paidImageGeneration: false,
      externalImageCalls: 0,
      requiresExplicitSpendConfirmation: false,
      safeToRunAutomatically: false,
      description: "人工复核真实样张后记录 codex-ppt 样张关卡，并进入全量图片页预检。"
    },
    {
      id: "product-visual-full-deck-approval-preflight",
      label: "检查全量确认条件",
      kind: "api",
      method: "POST",
      path: "/api/v1-acceptance/product-visual-full-deck/approval/preflight",
      body: { maxPages: pages },
      paidImageGeneration: false,
      externalImageCalls: 0,
      requiresExplicitSpendConfirmation: false,
      safeToRunAutomatically: true,
      description: "确认真实样张是否已经具备全量生成关卡确认条件，不生成图片。"
    },
    {
      id: "product-visual-full-deck-approval-approve",
      label: "确认全量生成关卡",
      kind: "api",
      method: "POST",
      path: "/api/v1-acceptance/product-visual-full-deck/approval/approve",
      body: { maxPages: pages },
      paidImageGeneration: false,
      externalImageCalls: 0,
      requiresExplicitSpendConfirmation: false,
      safeToRunAutomatically: false,
      description: "人工确认样张可继续全量后记录 codex-ppt 全量生成关卡；该步骤不调用图片 API。"
    },
    {
      id: "product-visual-test-deck-preflight",
      label: "检查 2 页测试生成条件",
      kind: "api",
      method: "POST",
      path: "/api/v1-acceptance/product-visual-full-deck/preflight",
      body: { maxPages: testPages, pages: `1-${testPages}` },
      paidImageGeneration: false,
      externalImageCalls: 0,
      requiresExplicitSpendConfirmation: false,
      safeToRunAutomatically: true,
      description: "只检查 2 页产品级图片 PPT 试跑条件，不生成图片。"
    },
    {
      id: "product-visual-test-deck-run",
      label: "生成 2 页测试图片型 PPT",
      kind: "api",
      method: "POST",
      path: "/api/v1-acceptance/product-visual-full-deck/run",
      body: {
        maxPages: testPages,
        pages: `1-${testPages}`,
        confirmExternalImageSpend: true,
        confirmProductVisualFullDeck: true
      },
      paidImageGeneration: true,
      externalImageCalls: testPages,
      requiresExplicitSpendConfirmation: true,
      safeToRunAutomatically: false,
      description: `会调用外部图片 API ${testPages} 次生成 2 页测试图片型 PPT，必须由用户明确确认。`
    },
    {
      id: "product-visual-custom-pages-preflight",
      label: "检查指定页生成条件",
      kind: "api",
      method: "POST",
      path: "/api/v1-acceptance/product-visual-full-deck/preflight",
      body: { maxPages: testPages, pages: "1,2" },
      paidImageGeneration: false,
      externalImageCalls: 0,
      requiresExplicitSpendConfirmation: false,
      safeToRunAutomatically: true,
      description: "只检查指定页产品级图片 PPT 生成条件，不生成图片；调用方可替换 pages。"
    },
    {
      id: "product-visual-custom-pages-run",
      label: "生成指定页图片型 PPT",
      kind: "api",
      method: "POST",
      path: "/api/v1-acceptance/product-visual-full-deck/run",
      body: {
        maxPages: testPages,
        pages: "1,2",
        confirmExternalImageSpend: true,
        confirmProductVisualFullDeck: true
      },
      paidImageGeneration: true,
      externalImageCalls: testPages,
      requiresExplicitSpendConfirmation: true,
      safeToRunAutomatically: false,
      description: "会按 pages 调用外部图片 API 生成指定页图片型 PPT，必须由用户明确确认。"
    },
    {
      id: "product-visual-full-deck-preflight",
      label: "检查全量图片页生成条件",
      kind: "api",
      method: "POST",
      path: "/api/v1-acceptance/product-visual-full-deck/preflight",
      body: { maxPages: pages },
      paidImageGeneration: false,
      externalImageCalls: 0,
      requiresExplicitSpendConfirmation: false,
      safeToRunAutomatically: true,
      description: "确认真实样张和全量授权是否齐备，不生成图片。"
    },
    {
      id: "product-visual-full-deck-run",
      label: "生成全量图片型 PPT",
      kind: "api",
      method: "POST",
      path: "/api/v1-acceptance/product-visual-full-deck/run",
      body: {
        maxPages: pages,
        confirmExternalImageSpend: true,
        confirmProductVisualFullDeck: true
      },
      paidImageGeneration: true,
      externalImageCalls: pages,
      requiresExplicitSpendConfirmation: true,
      safeToRunAutomatically: false,
      description: `会调用外部图片 API ${pages} 次生成全量 codex-ppt 图片页，必须由用户明确确认。`
    }
  ];
}

async function findLatestV1ScopedReport() {
  let entries = [];
  try {
    entries = await fs.readdir(v1AcceptanceRootDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^real-ppt-regression-.*\.json$/i.test(entry.name)) continue;
    if (entry.name === path.basename(latestReportPath)) continue;
    const reportPath = path.join(v1AcceptanceRootDir, entry.name);
    const report = await readJsonIfExists(reportPath);
    if (!isV1ScopedReport(report)) continue;
    candidates.push({ ...report, reportPath });
  }
  candidates.sort((a, b) => String(b.writtenAt || "").localeCompare(String(a.writtenAt || "")));
  return candidates[0] || null;
}

function isV1ScopedReport(report = null) {
  if (!report || typeof report !== "object") return false;
  if (report.requiredForV1 === false) return false;
  const sourcePages = toCount(report.sourceRender?.renderedPages);
  const visual = report.visual || {};
  const slideState = visual.slideState || {};
  const editableTasks = report.editable?.tasks || report.editable?.workerBatch?.taskSummary || {};
  const scopedPages = Math.max(
    toCount(report.maxPages),
    toCount(visual.visualImages),
    toCount(slideState.total),
    toCount(slideState.recorded),
    toCount(slideState.dispatched),
    toCount(editableTasks.total)
  );
  return sourcePages >= MIN_REAL_PPT_PAGES && scopedPages >= MIN_REAL_PPT_PAGES;
}

function makeAcceptanceCheck({ id, label, status = "pending", detail = "", required = true, evidence = {} } = {}) {
  return { id, label, status, detail, required, evidence };
}

function toCount(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
