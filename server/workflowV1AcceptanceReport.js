import fs from "fs/promises";
import fsSync from "fs";
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
  const completionAudit = buildCompletionAudit(report, acceptance, productVisualNext, phaseProgress);
  const requiredForV1 = options.requiredForV1 ?? isV1ScopedReport({ ...report, acceptance });
  const safeReport = {
    ok: report.ok === true,
    kind,
    writtenAt,
    command: report.command || "",
    requiredForV1,
    ...report,
    requiredForV1,
    acceptance: { ...acceptance, productVisualNext, phaseProgress, completionAudit },
    productVisualNext,
    phaseProgress,
    completionAudit
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
  const acceptance = report ? evaluateV1AcceptanceReport(report) : buildPendingV1Acceptance();
  const productVisualNext = buildProductVisualNext(report, acceptance);
  const phaseProgress = buildV1PhaseProgress(report, acceptance, productVisualNext);
  const completionAudit = buildCompletionAudit(report, acceptance, productVisualNext, phaseProgress);
  const latest = report ? {
    ...report,
    acceptance: { ...acceptance, productVisualNext, phaseProgress, completionAudit },
    productVisualNext,
    phaseProgress,
    completionAudit
  } : null;
  const selectedReportPath = latest?.reportPath || (report ? latestReportPath : "");
  return {
    ok: true,
    exists: Boolean(report),
    requiredForV1: true,
    acceptance: latest?.acceptance || { ...acceptance, productVisualNext, phaseProgress, completionAudit },
    productVisualNext,
    phaseProgress,
    completionAudit,
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
  const editableVisualFreshness = inspectEditableVisualFreshness(report);
  const editableProductRebuild = inspectEditableProductRebuild(report);
  const editableFinalStructurallyReady = Boolean(finalPath && validationPath && !editableVisualFreshness.stale);
  const editableFinalProductReady = Boolean(editableFinalStructurallyReady && editableProductRebuild.ready);
  const deliveryArtifactsStructurallyReady = Boolean(report.artifacts?.imageDeck && report.artifacts?.editableFinal && report.artifacts?.state);
  const deliveryArtifactsProductReady = Boolean(deliveryArtifactsStructurallyReady && editableProductRebuild.ready);
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
      id: "image-to-editable-product-rebuild",
      label: "image-to-editable-ppt 产品级重建",
      status: editableProductRebuild.ready ? "pass" : editableProductRebuild.hasEvidence ? "fail" : "pending",
      detail: editableProductRebuild.ready
        ? "可编辑 PPT 由模型页面 worker 重建，并包含产品级页面拆解证据。"
        : editableProductRebuild.hasEvidence
          ? editableProductRebuild.reason
          : "还没有 image-to-editable-ppt 页面重建证据。",
      required: true,
      evidence: editableProductRebuild
    }),
    makeAcceptanceCheck({
      id: "editable-final",
      label: "可编辑最终 PPT",
      status: editableFinalProductReady ? "pass" : finalPath ? "fail" : "pending",
      detail: editableFinalProductReady
        ? "最终可编辑 PPTX 和 validation 证据已记录，并来自 image-to-editable-ppt 产品级重建。"
        : finalPath
          ? editableVisualFreshness.stale
            ? "最终 PPTX 早于当前 codex-ppt 图片页，需要重新运行 image-to-editable-ppt。"
            : editableFinalStructurallyReady
              ? "最终 PPTX 只证明本地工程链路存在；缺少 image-to-editable-ppt 产品级页面重建，不能作为 v1 最终交付。"
              : "最终 PPTX 已记录，但缺少 validation 证据。"
          : "还没有最终可编辑 PPTX。",
      required: true,
      evidence: {
        finalPath,
        validationPath,
        editable: editableFinal?.editable ?? null,
        visualFreshness: editableVisualFreshness,
        productRebuildReady: editableProductRebuild.ready,
        structurallyReady: editableFinalStructurallyReady
      }
    }),
    makeAcceptanceCheck({
      id: "download-artifacts",
      label: "交付产物",
      status: deliveryArtifactsProductReady ? "pass" : "fail",
      detail: deliveryArtifactsProductReady
        ? "图片型 PPT、产品级可编辑 PPT 和状态证据均可追踪。"
        : deliveryArtifactsStructurallyReady
          ? "交付文件存在，但当前可编辑 PPT 不是 image-to-editable-ppt 产品级重建结果，下载交付必须继续阻断。"
          : "交付产物不完整，需要图片型 PPT、可编辑 PPT、state/log/validation 证据。",
      required: true,
      evidence: {
        imageDeck: report.artifacts?.imageDeck || "",
        editableFinal: report.artifacts?.editableFinal || "",
        state: report.artifacts?.state || "",
        ocrTextHints: report.artifacts?.ocrTextHints || "",
        productRebuildReady: editableProductRebuild.ready,
        structurallyReady: deliveryArtifactsStructurallyReady
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
    requiresExplicitSpendConfirmation: Boolean(report),
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
  const productVisualDeckReady = productVisualReady
    && acceptanceCheckPassed(acceptance, "codex-ppt-slide-records")
    && acceptanceCheckPassed(acceptance, "image-deck");
  const ocrPages = toCount(report?.ocr?.pageCount);
  const ocrTextCount = toCount(report?.ocr?.textCount);
  const editableTasks = report?.editable?.tasks || report?.editable?.workerBatch?.taskSummary || {};
  const editableRecorded = toCount(editableTasks.recorded);
  const editableFailed = toCount(editableTasks.failed);
  const editableProductReady = acceptanceCheckPassed(acceptance, "image-to-editable-product-rebuild");
  const editableFinalReady = acceptanceCheckPassed(acceptance, "editable-final");
  const downloadReady = acceptanceCheckPassed(acceptance, "download-artifacts");
  const realPptReady = sourcePages >= MIN_REAL_PPT_PAGES;
  const legacyRemoved = true;
  const doctorReady = true;
  const phases = [
    buildPhase("phase-1-two-page-loop", "阶段 1：2 页真实闭环", sourcePages >= 2 && visualImages >= 2 && editableFinalReady, {
      statusWhenNotDone: sourcePages >= 2 ? "working" : "pending",
      detail: sourcePages >= 2
        ? "已有至少 2 页源稿、图片页和最终可编辑 PPT 证据。"
        : "还缺至少 2 页闭环证据。",
      evidence: { sourcePages, visualImages, editableFinalReady }
    }),
    buildPhase("phase-2-editable-page-stability", "阶段 2：可编辑页面任务稳定", editableRecorded >= 5 && editableFailed === 0 && editableFinalReady && editableProductReady, {
      statusWhenNotDone: editableRecorded ? "working" : "pending",
      detail: editableRecorded >= 5 && editableFailed === 0 && editableProductReady
        ? `已记录 ${editableRecorded} 页可编辑重建，失败 ${editableFailed} 页。`
        : editableRecorded >= 5 && editableFailed === 0
          ? "当前有可编辑 PPT 证据，但仍是本地文本验证版，不是 image-to-editable-ppt 产品级重建。"
        : "还需要至少 5 页可编辑重建稳定证据。",
      evidence: { editableRecorded, editableFailed, editableFinalReady, editableProductReady }
    }),
    buildPhase("phase-3-codex-ppt-product-visuals", "阶段 3：codex-ppt 产品级图片型 PPT", productVisualDeckReady, {
      statusWhenNotDone: productVisualNext?.status === "action-required" ? "blocked" : "pending",
      detail: productVisualDeckReady
        ? "已有真实产品级视觉重绘和足量图片型 PPT 证据。"
        : productVisualReady
          ? "已有真实产品级视觉重绘证据，但图片页数量或页面任务记录还不足。"
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
  const currentPhase = phases.find((phase) => phase.status === "blocked" || phase.status === "working" || phase.status === "pending") || null;
  return {
    version: 1,
    done,
    total: phases.length,
    blocked,
    percent: Math.round((done / phases.length) * 100),
    currentPhaseId: currentPhase?.id || "complete",
    summary: blocked
      ? `8 个阶段已完成 ${done} 个，当前阻断在${currentPhase?.label || "未完成阶段"}。`
      : done === phases.length
        ? "8 个阶段均已完成。"
        : `8 个阶段已完成 ${done} 个，继续补齐未完成阶段。`,
    phases
  };
}

function buildCompletionAudit(report = null, acceptance = {}, productVisualNext = {}, phaseProgress = {}) {
  const missing = Array.isArray(acceptance.missing) ? acceptance.missing : [];
  const checks = Array.isArray(acceptance.checks) ? acceptance.checks : [];
  const missingRequiredChecks = checks
    .filter((check) => check.required && check.status !== "pass")
    .map((check) => ({
      id: check.id || "",
      label: check.label || check.id || "",
      status: check.status || "pending",
      detail: check.detail || ""
    }));
  const productVisualMissing = missingRequiredChecks.some((check) => check.id === "codex-ppt-product-visuals")
    || missing.some((item) => item.id === "codex-ppt-product-visuals");
  const editableProductMissing = missingRequiredChecks.some((check) => check.id === "image-to-editable-product-rebuild")
    || missing.some((item) => item.id === "image-to-editable-product-rebuild");
  const externalImageCalls = productVisualNext?.externalImageCalls || {};
  const visualRemainingImageCalls = productVisualMissing ? toCount(externalImageCalls.total) : 0;
  const editableSampleImageCalls = editableProductMissing ? 2 : 0;
  const sourcePages = toCount(report?.sourceRender?.renderedPages);
  const visualImages = toCount(report?.visual?.visualImages);
  const editableFinal = report?.editable?.final?.path || report?.artifacts?.editableFinal || "";
  const ready = Boolean(acceptance.ready);
  const blockerSummary = {
    productVisualMissing,
    editableProductMissing,
    imageProviderReady: Boolean(productVisualNext?.status !== "blocked"),
    llmProviderActionRequired: Boolean(editableProductMissing),
    note: productVisualMissing && editableProductMissing
      ? "视觉重绘和可编辑重建都缺产品级证据；gpt-image-2 只解决图片型 PPT，可编辑重建仍需要可用的对话模型服务商。"
      : editableProductMissing
        ? "当前主要缺口是 image-to-editable-ppt 产品级页面重建；请先确认对话模型服务商额度/鉴权已恢复。"
        : productVisualMissing
          ? "当前主要缺口是 codex-ppt 产品级视觉重绘；生成真实样张前必须确认外部图片 API 额度。"
          : ready
            ? "产品级验收已通过。"
            : "仍有真实验收必需证据未通过。"
  };
  const summary = ready
    ? "完整产品级验收已通过，可以声明 Agent v1 达到当前验收目标。"
    : productVisualMissing && editableProductMissing
      ? "尚未完整：当前同时缺少真实 gpt-image-2 产品级视觉重绘证据，以及 image-to-editable-ppt 产品级页面重建证据。"
      : productVisualMissing
      ? "尚未完整：当前只证明本地工程链路，缺少真实 gpt-image-2 产品级视觉重绘证据。"
      : editableProductMissing
        ? "尚未完整：当前可编辑 PPT 仍是本地文本验证版，缺少 image-to-editable-ppt 产品级页面重建证据。"
      : "尚未完整：仍有真实验收必需证据未通过。";
  const nextSteps = [];
  if (ready) {
    nextSteps.push({
      id: "complete",
      label: "可以交付",
      detail: "真实 15 页验收、产品级视觉、可编辑 PPT 和交付证据均已通过。",
      paidImageGeneration: false,
      externalImageCalls: 0,
      area: "delivery"
    });
  } else {
    if (productVisualMissing) {
      nextSteps.push({
        id: "generate-product-visual-sample",
        label: "生成 1 页真实产品级样张",
        detail: "用户明确确认外部图片 API 后，调用 gpt-image-2 生成 1 页样张；人工复核样张后再授权全量图片型 PPT。",
        paidImageGeneration: true,
        externalImageCalls: 1,
        area: "codex-ppt",
        safePreflight: {
          id: "product-visual-sample-preflight",
          label: "先检查真实样张生成条件",
          method: "POST",
          path: "/api/v1-acceptance/product-visual-sample/preflight",
          body: {},
          paidImageGeneration: false,
          externalImageCalls: 0,
          safeToRunAutomatically: true
        },
        paidAction: {
          id: "product-visual-sample-run",
          label: "确认后生成真实样张",
          method: "POST",
          path: "/api/v1-acceptance/product-visual-sample/run",
          body: {
            confirmExternalImageSpend: true,
            confirmProductVisualSample: true,
            confirmPromptPreview: true
          },
          paidImageGeneration: true,
          externalImageCalls: 1,
          requiresExplicitSpendConfirmation: true,
          safeToRunAutomatically: false
        }
      });
    }
    if (editableProductMissing) {
      const jobId = report?.jobId || report?.id || "";
      nextSteps.push({
        id: "recover-llm-and-run-model-editable-workers",
        label: "恢复 LLM 后重跑可编辑页面重建",
        detail: "先确认对话模型服务商额度/鉴权已恢复，再重建 fresh editable run，并以 mode=model 跑 1-2 页 image-to-editable-ppt 页面 worker。",
        paidImageGeneration: true,
        externalImageCalls: editableSampleImageCalls,
        area: "image-to-editable-ppt",
        order: productVisualMissing ? 2 : 1,
        dependsOn: productVisualMissing ? ["codex-ppt-product-visuals"] : [],
        blockedUntil: productVisualMissing ? "先完成 codex-ppt 产品级视觉样张和图片型 PPT；否则可编辑重建只能验证旧视觉证据，不能作为 v1 闭环。" : "",
        paidActionBlocked: Boolean(productVisualMissing),
        requiresLlmProviderRecovery: true,
        readinessPreflight: {
          id: "editable-rebuild-readiness-preflight",
          label: "检查可编辑重建总状态",
          method: "POST",
          path: "/api/v1-acceptance/editable-rebuild-readiness/preflight",
          body: {},
          paidImageGeneration: false,
          externalImageCalls: 0,
          llmApiCalls: 0,
          safeToRunAutomatically: true
        },
        providerPreflight: {
          id: "llm-provider-recovery-preflight",
          label: "先检查 LLM 恢复状态",
          method: "POST",
          path: "/api/v1-acceptance/llm-provider-recovery/preflight",
          body: {},
          paidImageGeneration: false,
          externalImageCalls: 0,
          llmApiCalls: 0,
          safeToRunAutomatically: true
        },
        localPreparation: jobId
          ? [
            {
              id: "fresh-editable-run-recovery",
              label: "重建 fresh editable run",
              method: "POST",
              path: `/api/workflow-jobs/${encodeURIComponent(jobId)}/editable/fresh-run-recovery`,
              preflight: {
                method: "POST",
                path: `/api/workflow-jobs/${encodeURIComponent(jobId)}/editable/fresh-run-recovery/preflight`,
                body: {},
                paidImageGeneration: false,
                externalImageCalls: 0,
                safeToRunAutomatically: true
              },
              body: {
                maxConcurrentPages: 6,
                reason: "v1 product editable rebuild recovery"
              },
              paidImageGeneration: false,
              externalImageCalls: 0,
              safeToRunAutomatically: false,
              requiresExplicitUserConfirmation: true,
              sideEffect: "会清掉旧的可编辑重建证据，并重新准备 editppt 运行目录。"
            },
            {
              id: "sync-editable-worker-tasks",
              label: "同步可编辑页面任务",
              method: "POST",
              path: `/api/workflow-jobs/${encodeURIComponent(jobId)}/editable/worker-tasks/sync`,
              preflight: {
                method: "POST",
                path: `/api/workflow-jobs/${encodeURIComponent(jobId)}/editable/worker-tasks/sync/preflight`,
                body: {},
                paidImageGeneration: false,
                externalImageCalls: 0,
                safeToRunAutomatically: true
              },
              body: {},
              paidImageGeneration: false,
              externalImageCalls: 0,
              safeToRunAutomatically: false,
              requiresExplicitUserConfirmation: true,
              sideEffect: "会根据新的页面提示刷新可编辑页面任务队列。"
            }
          ]
          : [],
        safePreflight: jobId
          ? {
            id: "editable-worker-batch-preflight",
            label: "先检查可编辑页面重建条件",
            method: "POST",
            path: `/api/workflow-jobs/${encodeURIComponent(jobId)}/editable/worker-runs/preflight`,
            body: {
              mode: "model",
              maxPages: 2,
              pages: "1-2",
              requireLlmProviderRecovery: true
            },
            paidImageGeneration: false,
            externalImageCalls: 0,
            safeToRunAutomatically: true
          }
          : null,
        paidAction: jobId
          ? {
            id: "editable-worker-batch-run",
            label: "确认后重跑可编辑页面任务",
            method: "POST",
            path: `/api/workflow-jobs/${encodeURIComponent(jobId)}/editable/worker-runs`,
            body: {
              mode: "model",
              maxPages: 2,
              pages: "1-2",
              confirmExternalImageSpend: true,
              confirmLlmProviderRecovered: true,
              requireLlmProviderRecovery: true
            },
            paidImageGeneration: true,
            externalImageCalls: 2,
            requiresExplicitSpendConfirmation: true,
            requiresLlmProviderRecovery: true,
            safeToRunAutomatically: false
          }
          : null
      });
    }
    if (!nextSteps.length) {
      nextSteps.push({
        id: "fix-v1-acceptance-evidence",
        label: "补齐真实验收缺口",
        detail: missingRequiredChecks[0]?.detail || acceptance.summary || "请根据真实验收缺口继续处理。",
        paidImageGeneration: false,
        externalImageCalls: 0,
        area: "acceptance"
      });
    }
  }
  const nextStep = nextSteps[0];
  const nextStepExternalImageCalls = toCount(nextStep?.externalImageCalls);
  const remainingExternalImageCalls = visualRemainingImageCalls + editableSampleImageCalls;
  const executionPlan = buildCompletionExecutionPlan(nextSteps, {
    ready,
    productVisualMissing,
    editableProductMissing
  });
  return {
    version: 1,
    ready,
    level: ready ? "pass" : productVisualMissing ? "blocked" : (acceptance.level || "pending"),
    title: ready ? "完整 Agent 验收已通过" : "还不能算完整 Agent",
    summary,
    sourcePages,
    visualImages,
    editableFinalReady: Boolean(editableFinal),
    requiredScope: {
      realPptPages: MIN_REAL_PPT_PAGES,
      productVisuals: true,
      editablePptx: true,
      deliveryEvidence: true
    },
    proven: {
      realPptReport: sourcePages >= MIN_REAL_PPT_PAGES,
      engineeringChain: Boolean(sourcePages >= MIN_REAL_PPT_PAGES && visualImages >= MIN_REAL_PPT_PAGES && editableFinal),
      productVisuals: !productVisualMissing && acceptanceCheckPassed(acceptance, "codex-ppt-product-visuals"),
      editableProductRebuild: acceptanceCheckPassed(acceptance, "image-to-editable-product-rebuild"),
      editableFinal: acceptanceCheckPassed(acceptance, "editable-final"),
      deliveryArtifacts: acceptanceCheckPassed(acceptance, "download-artifacts")
    },
    missingRequiredChecks,
    blockerSummary,
    blockerIds: missingRequiredChecks.map((check) => check.id),
    currentPhaseId: phaseProgress?.currentPhaseId || "",
    phaseSummary: phaseProgress?.summary || "",
    safeToRunAutomatically: false,
    requiresExplicitSpendConfirmation: Boolean(!ready && productVisualNext?.requiresExplicitSpendConfirmation),
    nextStepExternalImageCalls,
    remainingExternalImageCalls,
    costBreakdown: {
      nextStepExternalImageCalls,
      visualRemainingImageCalls,
      editableSampleImageCalls,
      totalRemainingExternalImageCalls: remainingExternalImageCalls,
      note: "这里只统计图片 API 次数估算；LLM 对话模型仍需单独确认额度/鉴权。"
    },
    nextStep,
    nextSteps,
    executionPlan
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

function buildCompletionExecutionPlan(nextSteps = [], options = {}) {
  const steps = [];
  const pushStep = (step = {}, extra = {}) => {
    if (!step.id) return;
    steps.push({
      id: step.id,
      order: extra.order || steps.length + 1,
      area: step.area || extra.area || "",
      label: step.label || step.id,
      detail: extra.detail || step.detail || "",
      status: extra.status || (step.blockedUntil ? "blocked" : "ready"),
      noCostPreflight: Boolean(step.safePreflight?.path || step.readinessPreflight?.path || step.providerPreflight?.path),
      paidImageGeneration: Boolean(step.paidImageGeneration),
      externalImageCalls: toCount(step.externalImageCalls),
      requiresExplicitSpendConfirmation: Boolean(step.paidAction?.requiresExplicitSpendConfirmation || step.paidImageGeneration),
      requiresLlmProviderRecovery: Boolean(step.requiresLlmProviderRecovery || step.paidAction?.requiresLlmProviderRecovery),
      dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn : [],
      blockedUntil: step.blockedUntil || ""
    });
  };
  if (options.ready) {
    pushStep({ id: "complete", label: "可以交付", detail: "真实验收已经通过。", area: "delivery" }, { status: "done" });
    return {
      version: 1,
      summary: "产品级验收已经完成。",
      currentOrder: 1,
      steps
    };
  }
  for (const step of nextSteps) {
    pushStep(step, {
      order: step.order || steps.length + 1,
      status: step.blockedUntil ? "blocked" : (step.paidImageGeneration ? "requires-confirmation" : "ready")
    });
  }
  const firstOpen = steps.find((step) => step.status !== "blocked") || steps[0] || null;
  const firstOpenSource = firstOpen ? nextSteps.find((step) => step.id === firstOpen.id) || {} : {};
  const currentAction = firstOpen ? {
    stepId: firstOpen.id,
    order: firstOpen.order,
    label: firstOpen.label,
    area: firstOpen.area,
    status: firstOpen.status,
    noCostPreflight: firstOpenSource.safePreflight || firstOpenSource.readinessPreflight || firstOpenSource.providerPreflight || null,
    paidAction: firstOpenSource.paidAction || null,
    externalImageCalls: firstOpen.externalImageCalls,
    requiresExplicitSpendConfirmation: firstOpen.requiresExplicitSpendConfirmation,
    safeToRunAutomatically: false
  } : null;
  return {
    version: 1,
    summary: options.productVisualMissing
      ? "先完成 codex-ppt 产品级视觉，再进入 image-to-editable-ppt 可编辑重建。"
      : options.editableProductMissing
        ? "视觉证据已就绪后，恢复 LLM 并运行 image-to-editable-ppt 页面重建。"
        : "继续补齐真实验收缺口。",
    currentOrder: firstOpen?.order || 0,
    currentAction,
    steps
  };
}

function acceptanceCheckPassed(acceptance = {}, id = "") {
  return Array.isArray(acceptance.checks) && acceptance.checks.some((check) => check.id === id && check.status === "pass");
}

function inspectEditableProductRebuild(report = {}) {
  const editable = report?.editable || {};
  const tasks = editable.tasks || editable.workerBatch?.taskSummary || {};
  const recordedPages = toCount(tasks.recorded);
  const failedPages = toCount(tasks.failed);
  const finalPath = editable.final?.path || report.artifacts?.editableFinal || "";
  const runDir = editable.runDir || "";
  const workerMode = String(editable.workerBatch?.mode || editable.mode || "").toLowerCase();
  const nonProductDelivery = Boolean(editable.workerBatch?.nonProductDelivery || editable.workerBatch?.experimentalLocalBatch);
  const localTextOnly = workerMode === "local" || nonProductDelivery;
  const pageEvidence = inspectEditablePageEvidence(runDir);
  const hasEvidence = Boolean(recordedPages || finalPath || runDir || workerMode || pageEvidence.pageCount);
  const ready = Boolean(
    hasEvidence
    && !localTextOnly
    && workerMode !== "passthrough"
    && recordedPages > 0
    && failedPages === 0
    && finalPath
    && pageEvidence.productPages > 0
    && pageEvidence.localTextOnlyPages === 0
  );
  let reason = "";
  if (localTextOnly) {
    reason = "当前 image-to-editable-ppt 输出来自 local-ocr-text-rebuild / 本地文本 worker，只能证明工程链路，不能代表产品级图片转可编辑。";
  } else if (!pageEvidence.productPages && pageEvidence.pageCount) {
    reason = "页面目录缺少模型页面 worker 的产品级拆解证据，不能确认图片/视觉对象已被重建。";
  } else if (!finalPath) {
    reason = "缺少最终可编辑 PPT 文件。";
  } else if (failedPages) {
    reason = `仍有 ${failedPages} 页可编辑重建失败。`;
  } else {
    reason = "缺少可验证的 image-to-editable-ppt 产品级页面 worker 证据。";
  }
  return {
    ready,
    hasEvidence,
    mode: workerMode || "",
    nonProductDelivery,
    localTextOnly,
    recordedPages,
    failedPages,
    finalPath,
    runDir,
    ...pageEvidence,
    reason
  };
}

function inspectEditablePageEvidence(runDir = "") {
  const evidence = {
    pageCount: 0,
    productPages: 0,
    localTextOnlyPages: 0,
    pagesWithRebuildSpec: 0,
    pagesWithVisualInventory: 0,
    sampleStrategies: []
  };
  if (!runDir || !fsSync.existsSync(runDir)) return evidence;
  const pagesDir = path.join(runDir, "pages");
  if (!fsSync.existsSync(pagesDir)) return evidence;
  const entries = fsSync.readdirSync(pagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^page_\d+/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const pageDir = path.join(pagesDir, entry.name);
    const manifest = readJsonSync(path.join(pageDir, "manifest.json")) || {};
    const strategy = String(manifest.page_strategy || manifest.strategy || "").trim();
    const hasRebuildSpec = fsSync.existsSync(path.join(pageDir, "page-rebuild-spec.json"));
    const visualInventoryCount = Array.isArray(manifest.visual_inventory) ? manifest.visual_inventory.length : 0;
    const imageCount = Array.isArray(manifest.images) ? manifest.images.length : 0;
    const localTextOnly = /local-ocr-text-rebuild|local text worker|text-only/i.test(strategy || manifest.notes || "");
    const productPage = !localTextOnly && (hasRebuildSpec || visualInventoryCount > 0 || imageCount > 0);
    evidence.pageCount += 1;
    if (hasRebuildSpec) evidence.pagesWithRebuildSpec += 1;
    if (visualInventoryCount || imageCount) evidence.pagesWithVisualInventory += 1;
    if (localTextOnly) evidence.localTextOnlyPages += 1;
    if (productPage) evidence.productPages += 1;
    if (strategy && evidence.sampleStrategies.length < 5 && !evidence.sampleStrategies.includes(strategy)) {
      evidence.sampleStrategies.push(strategy);
    }
  }
  return evidence;
}

function inspectEditableVisualFreshness(report = {}) {
  const currentImageTimes = [
    report.visual?.latestImageCreatedAt,
    ...(Array.isArray(report.visual?.images) ? report.visual.images.map((image) => image?.createdAt) : [])
  ].map(toTime).filter((time) => time > 0);
  const visualTimes = currentImageTimes.length
    ? currentImageTimes
    : [report.visual?.imageDeckCreatedAt].map(toTime).filter((time) => time > 0);
  const latestVisualAt = visualTimes.length ? Math.max(...visualTimes) : 0;
  const editableTimes = [
    report.editable?.runCreatedAt,
    report.editable?.hintsCreatedAt,
    report.editable?.final?.createdAt
  ].map(toTime).filter((time) => time > 0);
  const latestEditableAt = editableTimes.length ? Math.max(...editableTimes) : 0;
  const stale = Boolean(latestVisualAt && latestEditableAt && latestVisualAt > latestEditableAt);
  return {
    stale,
    latestVisualAt: latestVisualAt ? new Date(latestVisualAt).toISOString() : "",
    latestEditableAt: latestEditableAt ? new Date(latestEditableAt).toISOString() : ""
  };
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
    buildProductAction("product-visual-readiness", "运行无费用产品视觉预检", "/api/v1-acceptance/product-visual-readiness", {
      body: { maxPages: pages, ...(sourcePath ? { sourcePath } : {}) },
      description: "只检查源文件、provider 和 codex-ppt 关卡，不生成图片。",
      safeToRunAutomatically: true
    }),
    buildProductAction("product-visual-sample-preflight", "检查真实样张生成条件", "/api/v1-acceptance/product-visual-sample/preflight", {
      description: "确认是否已满足生成 1 页真实 codex-ppt 样张的条件。",
      safeToRunAutomatically: true
    }),
    buildProductAction("product-visual-sample-prompt-preview", "预览真实样张 prompt", "/api/v1-acceptance/product-visual-sample/prompt-preview", {
      description: "只预览将用于真实样张生成的 prompt、源页和模型证据，不生成图片。",
      safeToRunAutomatically: true
    }),
    buildProductAction("product-visual-sample-run", "生成真实 codex-ppt 样张", "/api/v1-acceptance/product-visual-sample/run", {
      body: {
        confirmExternalImageSpend: true,
        confirmProductVisualSample: true,
        confirmPromptPreview: true,
        promptPreviewJobId: "<latest product visual readiness job id>"
      },
      paidImageGeneration: true,
      externalImageCalls: 1,
      requiresExplicitSpendConfirmation: true,
      description: "会调用外部图片 API 生成 1 页样张，必须由用户明确确认。"
    }),
    buildProductAction("product-visual-sample-approval-preflight", "检查样张确认条件", "/api/v1-acceptance/product-visual-sample/approval/preflight", {
      description: "确认真实样张是否具备人工复核和样张关卡确认条件，不生成图片。",
      safeToRunAutomatically: true
    }),
    buildProductAction("product-visual-sample-approval-approve", "确认样张关卡", "/api/v1-acceptance/product-visual-sample/approval/approve", {
      body: { maxPages: pages },
      description: "人工复核真实样张后记录 codex-ppt 样张关卡，并进入全量图片页预检。"
    }),
    buildProductAction("product-visual-full-deck-approval-preflight", "检查全量确认条件", "/api/v1-acceptance/product-visual-full-deck/approval/preflight", {
      body: { maxPages: pages },
      description: "确认真实样张是否已经具备全量生成关卡确认条件，不生成图片。",
      safeToRunAutomatically: true
    }),
    buildProductAction("product-visual-full-deck-approval-approve", "确认全量生成关卡", "/api/v1-acceptance/product-visual-full-deck/approval/approve", {
      body: { maxPages: pages },
      description: "人工确认样张可继续全量后记录 codex-ppt 全量生成关卡；该步骤不调用图片 API。"
    }),
    buildProductAction("product-visual-test-deck-preflight", "检查 2 页测试生成条件", "/api/v1-acceptance/product-visual-full-deck/preflight", {
      body: { maxPages: testPages, pages: `1-${testPages}` },
      description: "只检查 2 页产品级图片 PPT 试跑条件，不生成图片。",
      safeToRunAutomatically: true
    }),
    buildProductAction("product-visual-test-deck-run", "生成 2 页测试图片型 PPT", "/api/v1-acceptance/product-visual-full-deck/run", {
      body: {
        maxPages: testPages,
        pages: `1-${testPages}`,
        confirmExternalImageSpend: true,
        confirmProductVisualFullDeck: true
      },
      paidImageGeneration: true,
      externalImageCalls: testPages,
      requiresExplicitSpendConfirmation: true,
      description: `会调用外部图片 API ${testPages} 次生成 2 页测试图片型 PPT，必须由用户明确确认。`
    }),
    buildProductAction("product-visual-custom-pages-preflight", "检查指定页生成条件", "/api/v1-acceptance/product-visual-full-deck/preflight", {
      body: { maxPages: testPages, pages: "1,2" },
      description: "只检查指定页产品级图片 PPT 生成条件，不生成图片；调用方可替换 pages。",
      safeToRunAutomatically: true
    }),
    buildProductAction("product-visual-custom-pages-run", "生成指定页图片型 PPT", "/api/v1-acceptance/product-visual-full-deck/run", {
      body: {
        maxPages: testPages,
        pages: "1,2",
        confirmExternalImageSpend: true,
        confirmProductVisualFullDeck: true
      },
      paidImageGeneration: true,
      externalImageCalls: testPages,
      requiresExplicitSpendConfirmation: true,
      description: "会按 pages 调用外部图片 API 生成指定页图片型 PPT，必须由用户明确确认。"
    }),
    buildProductAction("product-visual-full-deck-preflight", "检查全量图片页生成条件", "/api/v1-acceptance/product-visual-full-deck/preflight", {
      body: { maxPages: pages },
      description: "确认真实样张和全量授权是否齐备，不生成图片。",
      safeToRunAutomatically: true
    }),
    buildProductAction("product-visual-full-deck-run", "生成全量图片型 PPT", "/api/v1-acceptance/product-visual-full-deck/run", {
      body: {
        maxPages: pages,
        confirmExternalImageSpend: true,
        confirmProductVisualFullDeck: true
      },
      paidImageGeneration: true,
      externalImageCalls: pages,
      requiresExplicitSpendConfirmation: true,
      description: `会调用外部图片 API ${pages} 次生成全量 codex-ppt 图片页，必须由用户明确确认。`
    })
  ];
}

function buildProductAction(id, label, apiPath, options = {}) {
  return {
    id,
    label,
    kind: "api",
    method: "POST",
    path: apiPath,
    body: options.body || {},
    paidImageGeneration: Boolean(options.paidImageGeneration),
    externalImageCalls: toCount(options.externalImageCalls),
    requiresExplicitSpendConfirmation: Boolean(options.requiresExplicitSpendConfirmation),
    safeToRunAutomatically: Boolean(options.safeToRunAutomatically),
    description: options.description || ""
  };
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

function toTime(value = "") {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? time : 0;
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function readJsonSync(filePath = "") {
  try {
    return JSON.parse(fsSync.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}
