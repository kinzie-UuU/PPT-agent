import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { rootDir } from "./store.js";
import { getLatestV1AcceptanceReport, v1AcceptanceRootDir } from "./workflowV1AcceptanceReport.js";
import { readWorkflowJob } from "./workflowJobs.js";
import { getWorkflowNextActionPreflight } from "./workflowNextAction.js";
import { authorizeExternalImageSpend } from "./workflowAuthorizations.js";
import { approveCodexPptGate, preflightCodexPptGate } from "./workflowApprovals.js";
import { assembleWorkflowImageDeck, buildVisualPromptsPayload, generateWorkflowVisualImages, generateWorkflowVisualSample, getRenderedPages } from "./workflowVisuals.js";

const execFileAsync = promisify(execFile);
const latestProductVisualReadinessPath = path.join(v1AcceptanceRootDir, "latest-product-visual-readiness.json");
const PRODUCT_VISUAL_STYLE_BRIEF = "Unified premium business presentation system: clear hierarchy, precise alignment, consistent spacing, restrained palette, designed visual density, preserved short titles/logos/charts/icons, and clean text-safe regions for editable rebuild.";

export async function runProductVisualReadinessNoCost(options = {}) {
  const latest = await getLatestV1AcceptanceReport().catch(() => null);
  const sourceCandidate = await resolveProductVisualSource(options, latest);
  const sourcePath = resolveLocalSourcePath(sourceCandidate.sourcePath || "");
  if (!sourcePath || !fsSync.existsSync(sourcePath)) {
    const error = new Error("产品级视觉预检需要一个存在的本地 PPTX 源文件。");
    error.code = "PRODUCT_VISUAL_SOURCE_NOT_FOUND";
    error.status = 400;
    throw error;
  }
  if (!/\.pptx$/i.test(sourcePath)) {
    const error = new Error("产品级视觉预检当前只接收 .pptx 源文件。");
    error.code = "PRODUCT_VISUAL_SOURCE_NOT_PPTX";
    error.status = 400;
    throw error;
  }

  const maxPages = clampInteger(options.maxPages || latest?.productVisualNext?.targetPages, 1, 50, 15);
  const scriptPath = path.join(rootDir, "scripts", "product-visual-readiness.mjs");
  const args = [scriptPath, "--source", sourcePath, "--max-pages", String(maxPages)];
  const startedAt = new Date().toISOString();
  const { stdout, stderr } = await execFileAsync(process.execPath, args, {
    cwd: rootDir,
    env: stringifyEnv({
      ...globalThis.process.env,
      PPT_TOOL_BASE_URL: globalThis.process.env.PPT_TOOL_BASE_URL || `http://127.0.0.1:${globalThis.process.env.PORT || 4180}`
    }),
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: clampInteger(options.timeoutMs, 30000, 300000, 180000),
    windowsHide: true
  });
  const result = parseLastJson(stdout);
  if (result.paidImageGeneration === true || result.sample || result.visualDeck) {
    const error = new Error("产品级视觉无费用预检返回了生成产物，已拒绝作为安全预检结果。");
    error.code = "PRODUCT_VISUAL_READINESS_SPEND_GUARD";
    error.status = 500;
    throw error;
  }
  const payload = {
    ok: true,
    safeToRunAutomatically: true,
    paidImageGeneration: false,
    requiresExplicitSpendConfirmation: false,
    externalImageCalls: 0,
    sourcePath,
    sourceMode: sourceCandidate.sourceMode,
    workflowJobId: sourceCandidate.workflowJobId || "",
    maxPages,
    startedAt,
    endedAt: new Date().toISOString(),
    command: `node scripts/product-visual-readiness.mjs --source "${sourcePath}" --max-pages ${maxPages}`,
    result,
    stderr: String(stderr || "").slice(-4000)
  };
  await writeLatestProductVisualReadiness(payload);
  return payload;
}

export async function getLatestProductVisualReadiness() {
  const latest = await readJsonIfExists(latestProductVisualReadinessPath);
  return {
    ok: true,
    exists: Boolean(latest),
    latest,
    latestPath: latest ? latestProductVisualReadinessPath : "",
    latestRelativePath: latest ? path.relative(rootDir, latestProductVisualReadinessPath) : ""
  };
}

export async function getProductVisualSamplePreflight(options = {}) {
  const latestBundle = await getLatestProductVisualReadiness();
  const latest = latestBundle.latest || null;
  const jobId = String(options.workflowJobId || latest?.result?.jobId || latest?.workflowJobId || "").trim();
  const base = {
    ok: true,
    preview: true,
    paidImageGeneration: false,
    didRun: false,
    safeToRunAutomatically: true,
    requiresExplicitSpendConfirmation: false,
    nextRequiresExplicitSpendConfirmation: true,
    requiredConfirmation: "externalImageSpend",
    externalImageCalls: 1,
    nextAction: "visual/sample",
    ready: false,
    readyIfConfirmed: false,
    startReady: false,
    jobId,
    sourcePath: latest?.sourcePath || "",
    latestReadinessPath: latestBundle.latestPath || "",
    provider: latest?.result?.provider || null,
    runbook: latest?.result?.runbook || null,
    approvals: latest?.result?.approvals || null,
    checks: [],
    blockingIssues: [],
    warnings: [],
    executionSnapshot: null,
    updatedAt: new Date().toISOString()
  };

  if (!latest) {
    return withCheck(base, "latest-readiness", false, "请先运行无费用产品视觉预检。", {
      blockingIssues: ["缺少最新产品视觉预检结果。"]
    });
  }
  if (!jobId) {
    return withCheck(base, "workflow-job", false, "最新产品视觉预检没有记录 workflow job。", {
      blockingIssues: ["缺少可预检的 workflow job。"]
    });
  }
  const freshness = await getLatestReadinessFreshness(latest);
  if (!freshness.fresh) {
    return withCheck(base, "latest-readiness-fresh", false, freshness.reason, {
      code: "PRODUCT_VISUAL_READINESS_STALE",
      blockingIssues: [freshness.reason],
      freshness
    });
  }

  let job = null;
  try {
    job = await readWorkflowJob(jobId);
  } catch (error) {
    return withCheck(base, "workflow-job", false, `无法读取预检任务：${error.message || "unknown"}`, {
      blockingIssues: ["最新产品视觉预检任务不存在或已被清理。"]
    });
  }

  const blockedPreview = await getWorkflowNextActionPreflight(jobId, {
    requestedBy: "product-visual-sample-preflight"
  });
  const confirmedPreview = await getWorkflowNextActionPreflight(jobId, {
    requestedBy: "product-visual-sample-preflight",
    confirmExternalImageSpend: true
  });
  const action = String(confirmedPreview.action || blockedPreview.action || "").trim();
  const isSampleAction = action === "visual/sample" || action.includes("visual/sample");
  const provider = latest?.result?.provider || {};
  const imageEditReady = Boolean(provider.configured && provider.enabled && provider.supportsImageEdit !== false);
  const readyIfConfirmed = Boolean(isSampleAction && confirmedPreview.startReady && !confirmedPreview.didRun && imageEditReady);
  const blockingIssues = [
    ...(!isSampleAction ? [`当前运行手册下一步不是 visual/sample：${action || "无"}`] : []),
    ...(!imageEditReady ? ["图片 API 未声明支持源页参考图重绘，不能生成产品级样张。"] : []),
    ...(confirmedPreview.blockingIssues || [])
  ].filter(Boolean);
  const warnings = [
    ...(blockedPreview.requiredConfirmation ? ["生成真实样张前必须确认外部图片 API 额度。"] : []),
    ...(confirmedPreview.warnings || [])
  ].filter(Boolean);
  const checks = [
    { id: "latest-readiness", ok: true, label: "最新无费用预检", detail: latestBundle.latestRelativePath || "latest-product-visual-readiness.json" },
    { id: "workflow-job", ok: true, label: "预检任务", detail: jobId },
    { id: "runbook-action", ok: isSampleAction, label: "运行手册动作", detail: action || "无" },
    { id: "provider", ok: Boolean(provider.configured && provider.enabled), label: "图片 API", detail: provider.model || "未配置" },
    { id: "image-edit-provider", ok: imageEditReady, label: "源页参考图重绘", detail: imageEditReady ? (provider.editEndpoint || "/images/edits") : "未启用" },
    { id: "approval-gates", ok: Boolean(latest?.result?.approvals?.passed >= 3), label: "大纲/风格/后端", detail: `${latest?.result?.approvals?.passed || 0}/${latest?.result?.approvals?.total || 5}` },
    { id: "external-spend-confirmation", ok: Boolean(blockedPreview.requiredConfirmation === "externalImageSpend" || readyIfConfirmed), label: "额度确认门槛", detail: "1 次图片调用" }
  ];
  const executionSnapshot = buildExecutionSnapshot({
    phase: "sample",
    label: "真实 codex-ppt 样张",
    latest,
    job,
    provider: provider || confirmedPreview.authorization?.provider || base.provider,
    externalImageCalls: 1,
    targetPages: 1,
    requiredConfirmation: "externalImageSpend",
    readyIfConfirmed,
    blockingIssues
  });

  return {
    ...base,
    ready: readyIfConfirmed,
    readyIfConfirmed,
    startReady: false,
    action,
    job: {
      id: job.id,
      status: job.status || "",
      currentStage: job.currentStage || "",
      sourceOriginalName: job.input?.sourceOriginalName || ""
    },
    provider: provider || confirmedPreview.authorization?.provider || base.provider,
    runbook: confirmedPreview.compliance?.runbook || latest?.result?.runbook || base.runbook,
    approvals: latest?.result?.approvals || base.approvals,
    checks,
    blockingIssues,
    warnings,
    executionSnapshot,
    blockedPreview: compactPreflight(blockedPreview),
    confirmedPreview: compactPreflight(confirmedPreview),
    summary: readyIfConfirmed
      ? "已可在明确确认外部图片 API 额度后生成 1 页产品级视觉样张。"
      : "真实样张预检未通过，请先处理阻断项。",
    instruction: "本接口只做预检，不生成图片，不写入授权。"
  };
}

export async function getProductVisualFullDeckPreflight(options = {}) {
  const latestBundle = await getLatestProductVisualReadiness();
  const latest = latestBundle.latest || null;
  const jobId = String(options.workflowJobId || latest?.result?.jobId || latest?.workflowJobId || "").trim();
  const pageCount = clampInteger(
    options.maxPages || latest?.result?.sourceRender?.targetSlideCount || latest?.result?.sourceRender?.renderedPages || latest?.maxPages,
    1,
    50,
    15
  );
  const base = {
    ok: true,
    preview: true,
    paidImageGeneration: false,
    didRun: false,
    safeToRunAutomatically: true,
    requiresExplicitSpendConfirmation: false,
    nextRequiresExplicitSpendConfirmation: true,
    requiredConfirmation: "externalImageSpend",
    externalImageCalls: pageCount,
    nextAction: "visual/generate",
    ready: false,
    readyIfConfirmed: false,
    startReady: false,
    jobId,
    sourcePath: latest?.sourcePath || "",
    latestReadinessPath: latestBundle.latestPath || "",
    provider: latest?.result?.provider || null,
    runbook: latest?.result?.runbook || null,
    approvals: latest?.result?.approvals || null,
    checks: [],
    blockingIssues: [],
    warnings: [],
    executionSnapshot: null,
    updatedAt: new Date().toISOString()
  };

  if (!latest) {
    return withCheck(base, "latest-readiness", false, "请先运行无费用产品视觉预检。", {
      blockingIssues: ["缺少最新产品视觉预检结果。"]
    });
  }
  if (!jobId) {
    return withCheck(base, "workflow-job", false, "最新产品视觉预检没有记录 workflow job。", {
      blockingIssues: ["缺少可预检的 workflow job。"]
    });
  }
  const freshness = await getLatestReadinessFreshness(latest);
  if (!freshness.fresh) {
    return withCheck(base, "latest-readiness-fresh", false, freshness.reason, {
      code: "PRODUCT_VISUAL_READINESS_STALE",
      blockingIssues: [freshness.reason],
      freshness
    });
  }

  let job = null;
  try {
    job = await readWorkflowJob(jobId);
  } catch (error) {
    return withCheck(base, "workflow-job", false, `无法读取预检任务：${error.message || "unknown"}`, {
      blockingIssues: ["最新产品视觉预检任务不存在或已被清理。"]
    });
  }

  const renderedPageCount = Array.isArray(job.artifacts?.renderedPages) ? job.artifacts.renderedPages.length : pageCount;
  const calls = clampInteger(options.maxPages || renderedPageCount || pageCount, 1, 50, pageCount);
  const provider = latest?.result?.provider || {};
  const approved = getApprovedGateSet(job);
  const sample = job.artifacts?.visualSample || null;
  const sampleProduct = isSourceReferencedVisualSample(sample);
  const sampleApproved = approved.has("sample");
  const fullDeckApproved = approved.has("fullDeck");
  const providerReady = Boolean(provider.configured && provider.enabled && provider.model && provider.supportsImageEdit !== false);
  const blockingIssues = [
    ...(!providerReady ? ["图片 API 尚未配置完成，或未声明支持源页参考图重绘。"] : []),
    ...(!sample?.path ? ["缺少真实 codex-ppt 视觉样张。"] : []),
    ...(sample?.path && !sampleProduct ? ["当前样张仍是 dry-run/passthrough、缺少 sha256，或没有源页面图片参考证据，不能作为产品级样张。"] : []),
    ...(!sampleApproved ? ["样张关卡尚未确认。"] : []),
    ...(!fullDeckApproved ? ["全量生成关卡尚未授权。"] : []),
    ...(!renderedPageCount ? ["缺少可生成的源页面。"] : [])
  ];
  const checks = [
    { id: "latest-readiness", ok: true, label: "最新无费用预检", detail: latestBundle.latestRelativePath || "latest-product-visual-readiness.json" },
    { id: "workflow-job", ok: true, label: "预检任务", detail: jobId },
    { id: "provider", ok: Boolean(provider.configured && provider.enabled && provider.model), label: "图片 API", detail: provider.model || "未配置" },
    { id: "image-edit-provider", ok: providerReady, label: "源页参考图重绘", detail: provider.supportsImageEdit === false ? "未启用" : provider.editEndpoint || "/images/edits" },
    { id: "product-sample", ok: sampleProduct, label: "真实样张", detail: sample?.path ? path.relative(rootDir, sample.path) : "缺失" },
    { id: "sample-approval", ok: sampleApproved, label: "样张确认", detail: sampleApproved ? "已确认" : "待确认" },
    { id: "full-deck-approval", ok: fullDeckApproved, label: "全量授权", detail: fullDeckApproved ? "已授权" : "待授权" },
    { id: "source-pages", ok: Boolean(renderedPageCount), label: "目标页数", detail: `${renderedPageCount || calls} 页` },
    { id: "external-spend-confirmation", ok: true, label: "额度确认门槛", detail: `${calls} 次图片调用` }
  ];
  const readyIfConfirmed = blockingIssues.length === 0;
  const executionSnapshot = buildExecutionSnapshot({
    phase: "full-deck",
    label: "全量 codex-ppt 图片型 PPT",
    latest,
    job,
    provider,
    externalImageCalls: calls,
    targetPages: calls,
    requiredConfirmation: "externalImageSpend",
    readyIfConfirmed,
    blockingIssues
  });
  return {
    ...base,
    externalImageCalls: calls,
    ready: readyIfConfirmed,
    readyIfConfirmed,
    job: {
      id: job.id,
      status: job.status || "",
      currentStage: job.currentStage || "",
      sourceOriginalName: job.input?.sourceOriginalName || ""
    },
    provider,
    approvals: latest?.result?.approvals || base.approvals,
    runbook: latest?.result?.runbook || base.runbook,
    sample: sample ? {
      path: sample.path || "",
      provider: sample.provider || "",
      model: sample.model || "",
      dryRun: Boolean(sample.dryRun),
      sha256: sample.sha256 || ""
    } : null,
    checks,
    blockingIssues,
    executionSnapshot,
    warnings: readyIfConfirmed ? ["全量生成会调用外部图片 API；必须由用户再次明确确认。"] : [],
    summary: readyIfConfirmed
      ? `已可在明确确认外部图片 API 额度后生成 ${calls} 页产品级 codex-ppt 视觉图片。`
      : "全量产品级视觉生成条件未满足，请先处理阻断项。",
    instruction: "本接口只做全量生成预检，不生成图片，不写入授权。"
  };
}

export async function getProductVisualSamplePromptPreview(options = {}) {
  const preflight = await getProductVisualSamplePreflight(options);
  const jobId = preflight.jobId || "";
  const base = {
    ok: true,
    preview: true,
    paidImageGeneration: false,
    didRun: false,
    safeToRunAutomatically: true,
    requiresExplicitSpendConfirmation: false,
    nextRequiresExplicitSpendConfirmation: true,
    requiredConfirmation: "externalImageSpend",
    externalImageCalls: preflight.externalImageCalls || 1,
    ready: Boolean(preflight.readyIfConfirmed),
    jobId,
    preflight,
    updatedAt: new Date().toISOString()
  };
  if (!preflight.readyIfConfirmed || !jobId) {
    return {
      ...base,
      ready: false,
      promptPreview: null,
      summary: preflight.summary || "真实样张条件未满足，暂不能预览最终样张 prompt。"
    };
  }
  const job = await readWorkflowJob(jobId);
  const renderedPages = getRenderedPages(job);
  if (!renderedPages.length) {
    return {
      ...base,
      ready: false,
      promptPreview: null,
      summary: "缺少可用于样张生成的源页面图片。"
    };
  }
  const pageNumber = clampInteger(options.pageNumber || options.page || 1, 1, renderedPages.length, 1);
  const prompts = buildVisualPromptsPayload(job, renderedPages, options);
  const promptRecord = prompts.pages[pageNumber - 1] || null;
  const sourcePage = renderedPages[pageNumber - 1] || null;
  return {
    ...base,
    ready: true,
    promptPreview: {
      kind: "product_visual_sample_prompt_preview",
      pageNumber,
      pageId: sourcePage?.pageId || promptRecord?.pageId || "",
      sourcePagePath: sourcePage?.path || promptRecord?.sourcePagePath || "",
      sourcePageLink: sourcePage ? makeWorkflowArtifactLink(jobId, "rendered-page", sourcePage.pageId || `page_${String(pageNumber).padStart(3, "0")}`) : null,
      provider: preflight.provider || null,
      styleBrief: prompts.styleBrief || "",
      imageInputMode: "source-page-edit",
      sourceReferenceRequired: true,
      prompt: promptRecord?.prompt || "",
      promptExcerpt: excerptText(promptRecord?.prompt || "", 520),
      promptLength: String(promptRecord?.prompt || "").length,
      externalImageCalls: 1,
      instruction: "这是即将用于真实 codex-ppt 样张的 prompt 预览；本接口不生成图片，不消耗外部 API。"
    },
    summary: "真实样张 prompt 已可预览；确认无误后才进入 1 次外部图片 API 生成。"
  };
}

export async function runProductVisualSample(options = {}) {
  const preflight = await getProductVisualSamplePreflight(options);
  if (!preflight.readyIfConfirmed) {
    const error = new Error(preflight.summary || "真实样张条件未满足。");
    error.code = "PRODUCT_VISUAL_SAMPLE_PREFLIGHT_NOT_READY";
    error.status = 409;
    error.preflight = preflight;
    throw error;
  }
  if (!isConfirmed(options.confirmExternalImageSpend) || !isConfirmed(options.confirmProductVisualSample)) {
    const error = new Error("生成真实 codex-ppt 样张前必须明确确认 1 次外部图片 API 调用。");
    error.code = "PRODUCT_VISUAL_SAMPLE_CONFIRMATION_REQUIRED";
    error.status = 409;
    error.requiredConfirmation = "externalImageSpend";
    error.externalImageCalls = 1;
    error.preflight = preflight;
    throw error;
  }

  const jobId = preflight.jobId;
  const promptPreviewJobId = cleanString(options.promptPreviewJobId || options.promptPreviewWorkflowJobId || "");
  if (!isConfirmed(options.confirmPromptPreview) || promptPreviewJobId !== jobId) {
    const error = new Error("生成真实 codex-ppt 样张前，请先预览当前预检任务的样张 prompt 和源页。");
    error.code = "PRODUCT_VISUAL_SAMPLE_PROMPT_PREVIEW_REQUIRED";
    error.status = 409;
    error.requiredConfirmation = "promptPreview";
    error.expectedPromptPreviewJobId = jobId;
    error.promptPreviewJobId = promptPreviewJobId;
    error.preflight = preflight;
    throw error;
  }
  const authorization = await authorizeExternalImageSpend(jobId, {
    scope: "visual-sample",
    imageCalls: 1,
    confirmedBy: cleanString(options.confirmedBy || "frontend-operator"),
    reason: cleanString(options.reason || "产品级 v1 真实样张生成授权")
  });
  const job = await generateWorkflowVisualSample(jobId, {
    pageNumber: clampInteger(options.pageNumber || options.page, 1, 50, 1),
    confirmExternalImageSpend: true,
    requestedBy: "product-visual-sample-run",
    visualProfile: "product-v1-real-sample",
    note: "product-v1-real-sample",
    styleBrief: cleanString(options.styleBrief || options.style || "")
  });
  return {
    ok: true,
    paidImageGeneration: true,
    didRun: true,
    safeToRunAutomatically: false,
    externalImageCalls: 1,
    jobId,
    authorization: authorization.authorization,
    provider: preflight.provider,
    sample: job.artifacts?.visualSample || null,
    sampleLink: makeWorkflowArtifactLink(jobId, "visual-sample"),
    runbook: preflight.runbook,
    summary: "真实 codex-ppt 视觉样张已生成，请复核样张后再确认样张关卡。",
    job: {
      id: job.id,
      status: job.status || "",
      currentStage: job.currentStage || "",
      visualSample: Boolean(job.artifacts?.visualSample?.path)
    }
  };
}

export async function getProductVisualSampleApprovalPreflight(options = {}) {
  const latestBundle = await getLatestProductVisualReadiness();
  const latest = latestBundle.latest || null;
  const jobId = String(options.workflowJobId || latest?.result?.jobId || latest?.workflowJobId || "").trim();
  const base = {
    ok: true,
    preview: true,
    paidImageGeneration: false,
    didRun: false,
    safeToRunAutomatically: true,
    requiresExplicitSpendConfirmation: false,
    nextAction: "codex-ppt/approvals/sample/approve",
    ready: false,
    passed: false,
    jobId,
    latestReadinessPath: latestBundle.latestPath || "",
    sampleLink: jobId ? makeWorkflowArtifactLink(jobId, "visual-sample") : null,
    blockingIssues: [],
    updatedAt: new Date().toISOString()
  };
  if (!jobId) {
    return { ...base, blockingIssues: ["缺少最新产品视觉预检任务。"], summary: "请先运行无费用产品视觉预检。" };
  }
  const freshness = await getLatestReadinessFreshness(latest);
  if (!freshness.fresh) {
    return {
      ...base,
      code: "PRODUCT_VISUAL_READINESS_STALE",
      blockingIssues: [freshness.reason],
      freshness,
      summary: freshness.reason
    };
  }
  const job = await readWorkflowJob(jobId).catch(() => null);
  const preflight = await preflightCodexPptGate(jobId, { gate: "sample" });
  const localizedError = localizeSampleApprovalIssue(preflight.error || "");
  const localizedBlockers = (preflight.blockers || []).map(localizeSampleApprovalIssue).filter(Boolean);
  const sample = preflight.sample || job?.artifacts?.visualSample || null;
  const nextStagePlan = buildProductVisualNextStagePlan({
    latest,
    job,
    sample,
    sampleApproved: Boolean(preflight.passed),
    fullDeckApproved: false,
    requestedMaxPages: options.maxPages
  });
  const sampleReviewChecklist = buildSampleReviewChecklist({
    sample,
    provider: latest?.result?.provider || {},
    ready: Boolean(preflight.ready),
    passed: Boolean(preflight.passed),
    sampleLink: base.sampleLink,
    sourcePageLink: buildSourcePageLinkForSample(jobId, sample)
  });
  const checklistReady = Boolean(preflight.passed || (preflight.ready && !sampleReviewChecklist.missing.length));
  const checklistBlockers = sampleReviewChecklist.missing.length
    ? [`样张复核缺少：${sampleReviewChecklist.missing.join("、")}。请重新生成源页参考图重绘样张。`]
    : [];
  return {
    ...base,
    ready: checklistReady,
    passed: Boolean(preflight.passed),
    code: preflight.code || "",
    error: localizedError,
    blockers: localizedBlockers,
    blockingIssues: [...localizedBlockers, ...checklistBlockers],
    sample,
    sampleReviewChecklist,
    nextStagePlan,
    summary: preflight.passed
      ? "样张关卡已确认。"
      : checklistBlockers.length
        ? checklistBlockers[0]
      : preflight.ready
        ? "真实样张已满足确认条件，可确认样张关卡。"
        : localizedError || "样张关卡尚未满足确认条件。",
    preflight
  };
}

export async function approveProductVisualSample(options = {}) {
  const preflight = await getProductVisualSampleApprovalPreflight(options);
  if (preflight.passed) {
    return {
      ok: true,
      didRun: false,
      paidImageGeneration: false,
      safeToRunAutomatically: false,
      jobId: preflight.jobId,
      summary: "样张关卡已确认，无需重复确认。",
      preflight
    };
  }
  if (!preflight.ready) {
    const error = new Error(preflight.summary || "样张关卡尚未满足确认条件。");
    error.code = preflight.code || "PRODUCT_VISUAL_SAMPLE_APPROVAL_NOT_READY";
    error.status = 409;
    error.preflight = preflight;
    throw error;
  }
  const job = await approveCodexPptGate(preflight.jobId, {
    gate: "sample",
    note: cleanString(options.note || "产品级 v1 真实样张复核通过"),
    approvedBy: cleanString(options.approvedBy || options.confirmedBy || "frontend-operator")
  });
  const fullDeckPreflight = await getProductVisualFullDeckPreflight({
    workflowJobId: preflight.jobId,
    maxPages: options.maxPages
  }).catch((error) => ({
    ok: false,
    error: error.message || "全量生成预检失败"
  }));
  return {
    ok: true,
    didRun: true,
    paidImageGeneration: false,
    safeToRunAutomatically: false,
    jobId: preflight.jobId,
    sampleLink: makeWorkflowArtifactLink(preflight.jobId, "visual-sample"),
    fullDeckPreflight,
    summary: "样张关卡已确认，可以检查全量图片页生成条件。",
    job: {
      id: job.id,
      status: job.status || "",
      currentStage: job.currentStage || ""
    }
  };
}

export async function getProductVisualFullDeckApprovalPreflight(options = {}) {
  const latestBundle = await getLatestProductVisualReadiness();
  const latest = latestBundle.latest || null;
  const jobId = String(options.workflowJobId || latest?.result?.jobId || latest?.workflowJobId || "").trim();
  const base = {
    ok: true,
    preview: true,
    paidImageGeneration: false,
    didRun: false,
    safeToRunAutomatically: true,
    requiresExplicitSpendConfirmation: false,
    nextAction: "codex-ppt/approvals/fullDeck/approve",
    ready: false,
    passed: false,
    jobId,
    latestReadinessPath: latestBundle.latestPath || "",
    sampleLink: jobId ? makeWorkflowArtifactLink(jobId, "visual-sample") : null,
    blockingIssues: [],
    updatedAt: new Date().toISOString()
  };
  if (!jobId) {
    return { ...base, blockingIssues: ["缺少最新产品视觉预检任务。"], summary: "请先运行无费用产品视觉预检。" };
  }
  const freshness = await getLatestReadinessFreshness(latest);
  if (!freshness.fresh) {
    return {
      ...base,
      code: "PRODUCT_VISUAL_READINESS_STALE",
      blockingIssues: [freshness.reason],
      freshness,
      summary: freshness.reason
    };
  }
  const job = await readWorkflowJob(jobId).catch(() => null);
  const preflight = await preflightCodexPptGate(jobId, { gate: "fullDeck" });
  const localizedError = localizeFullDeckApprovalIssue(preflight.error || "");
  const localizedBlockers = (preflight.blockers || []).map(localizeFullDeckApprovalIssue).filter(Boolean);
  const sample = preflight.sample || job?.artifacts?.visualSample || null;
  const nextStagePlan = buildProductVisualNextStagePlan({
    latest,
    job,
    sample,
    sampleApproved: Boolean(preflight.ready || preflight.passed),
    fullDeckApproved: Boolean(preflight.passed),
    requestedMaxPages: options.maxPages
  });
  const sampleReviewChecklist = buildSampleReviewChecklist({
    sample,
    provider: latest?.result?.provider || {},
    ready: Boolean(preflight.ready),
    passed: Boolean(preflight.passed),
    sampleLink: base.sampleLink,
    sourcePageLink: buildSourcePageLinkForSample(jobId, sample)
  });
  return {
    ...base,
    ready: Boolean(preflight.ready),
    passed: Boolean(preflight.passed),
    code: preflight.code || "",
    error: localizedError,
    blockers: localizedBlockers,
    blockingIssues: localizedBlockers,
    sample,
    sampleReviewChecklist,
    nextStagePlan,
    summary: preflight.passed
      ? "全量生成关卡已确认。"
      : preflight.ready
        ? "真实样张已通过，可确认全量生成关卡。确认后仍需单独授权外部图片 API 才会生成全量页面。"
        : localizedError || "全量生成关卡尚未满足确认条件。",
    preflight
  };
}

export async function approveProductVisualFullDeck(options = {}) {
  const preflight = await getProductVisualFullDeckApprovalPreflight(options);
  if (preflight.passed) {
    const fullDeckPreflight = await getProductVisualFullDeckPreflight({
      workflowJobId: preflight.jobId,
      maxPages: options.maxPages
    }).catch((error) => ({
      ok: false,
      error: error.message || "全量生成预检失败"
    }));
    return {
      ok: true,
      didRun: false,
      paidImageGeneration: false,
      safeToRunAutomatically: false,
      jobId: preflight.jobId,
      fullDeckPreflight,
      summary: "全量生成关卡已确认，无需重复确认。",
      preflight
    };
  }
  if (!preflight.ready) {
    const error = new Error(preflight.summary || "全量生成关卡尚未满足确认条件。");
    error.code = preflight.code || "PRODUCT_VISUAL_FULL_DECK_APPROVAL_NOT_READY";
    error.status = 409;
    error.preflight = preflight;
    throw error;
  }
  const job = await approveCodexPptGate(preflight.jobId, {
    gate: "fullDeck",
    note: cleanString(options.note || "产品级 v1 全量视觉生成关卡确认"),
    approvedBy: cleanString(options.approvedBy || options.confirmedBy || "frontend-operator")
  });
  const fullDeckPreflight = await getProductVisualFullDeckPreflight({
    workflowJobId: preflight.jobId,
    maxPages: options.maxPages
  }).catch((error) => ({
    ok: false,
    error: error.message || "全量生成预检失败"
  }));
  return {
    ok: true,
    didRun: true,
    paidImageGeneration: false,
    safeToRunAutomatically: false,
    jobId: preflight.jobId,
    fullDeckPreflight,
    summary: "全量生成关卡已确认。下一步可检查全量生成条件，并在明确额度后生成全量图片型 PPT。",
    job: {
      id: job.id,
      status: job.status || "",
      currentStage: job.currentStage || ""
    }
  };
}

export async function runProductVisualFullDeck(options = {}) {
  const preflight = await getProductVisualFullDeckPreflight(options);
  if (!preflight.readyIfConfirmed) {
    const error = new Error(preflight.summary || "全量 codex-ppt 图片页生成条件未满足。");
    error.code = "PRODUCT_VISUAL_FULL_DECK_PREFLIGHT_NOT_READY";
    error.status = 409;
    error.preflight = preflight;
    throw error;
  }
  if (!isConfirmed(options.confirmExternalImageSpend) || !isConfirmed(options.confirmProductVisualFullDeck)) {
    const error = new Error(`生成全量 codex-ppt 图片型 PPT 前必须明确确认 ${preflight.externalImageCalls || 0} 次外部图片 API 调用。`);
    error.code = "PRODUCT_VISUAL_FULL_DECK_CONFIRMATION_REQUIRED";
    error.status = 409;
    error.requiredConfirmation = "externalImageSpend";
    error.externalImageCalls = preflight.externalImageCalls || 0;
    error.preflight = preflight;
    throw error;
  }

  const jobId = preflight.jobId;
  const imageCalls = clampInteger(preflight.externalImageCalls, 1, 50, 15);
  const authorization = await authorizeExternalImageSpend(jobId, {
    scope: "full-deck",
    imageCalls,
    confirmedBy: cleanString(options.confirmedBy || "frontend-operator"),
    reason: cleanString(options.reason || "产品级 v1 全量视觉生成授权")
  });
  const visualJob = await generateWorkflowVisualImages(jobId, {
    maxPages: imageCalls,
    pages: cleanString(options.pages || `1-${imageCalls}`),
    confirmExternalImageSpend: true,
    requestedBy: "product-visual-full-deck-run",
    visualProfile: "product-v1-real-full-deck",
    note: "product-v1-real-full-deck",
    styleBrief: cleanString(options.styleBrief || PRODUCT_VISUAL_STYLE_BRIEF)
  });
  const imageDeckJob = await assembleWorkflowImageDeck(jobId, {
    outName: "product-visual-image-deck.pptx"
  });
  const finalJob = imageDeckJob || visualJob;
  return {
    ok: true,
    paidImageGeneration: true,
    didRun: true,
    safeToRunAutomatically: false,
    externalImageCalls: imageCalls,
    jobId,
    authorization: authorization.authorization,
    provider: preflight.provider,
    visualImages: finalJob.artifacts?.visualImages || visualJob.artifacts?.visualImages || [],
    visualQuality: finalJob.artifacts?.visualQuality || visualJob.artifacts?.visualQuality || null,
    imageDeck: finalJob.artifacts?.imageDeck || null,
    imageDeckLink: makeWorkflowArtifactLink(jobId, "image-deck", "", { download: true }),
    visualQualityLink: makeWorkflowArtifactLink(jobId, "visual-quality"),
    visualImageLinks: buildVisualImageLinks(jobId, finalJob.artifacts?.visualImages || visualJob.artifacts?.visualImages || []),
    runbook: preflight.runbook,
    summary: "产品级 codex-ppt 全量视觉图片和图片型 PPT 已生成。",
    job: {
      id: finalJob.id,
      status: finalJob.status || "",
      currentStage: finalJob.currentStage || "",
      visualImages: Array.isArray(finalJob.artifacts?.visualImages) ? finalJob.artifacts.visualImages.length : 0,
      imageDeck: Boolean(finalJob.artifacts?.imageDeck?.path)
    }
  };
}

async function writeLatestProductVisualReadiness(payload = {}) {
  await fs.mkdir(v1AcceptanceRootDir, { recursive: true });
  await fs.writeFile(latestProductVisualReadinessPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function resolveProductVisualSource(options = {}, latest = null) {
  const workflowJobId = String(options.workflowJobId || "").trim();
  if (workflowJobId) {
    const job = await readWorkflowJob(workflowJobId);
    return {
      sourcePath: job.artifacts?.source?.path || "",
      sourceMode: "workflow-source",
      workflowJobId: job.id
    };
  }
  const sourcePath = String(options.sourcePath || "").trim()
    || latest?.latest?.sourcePath
    || latest?.productVisualNext?.sourcePath
    || "";
  return {
    sourcePath,
    sourceMode: options.sourcePath ? "local-path" : "latest-v1-acceptance",
    workflowJobId: ""
  };
}

function resolveLocalSourcePath(value = "") {
  const candidates = normalizeLocalPathCandidates(value);
  for (const candidate of candidates) {
    if (candidate && fsSync.existsSync(candidate)) return candidate;
  }
  return candidates[0] || "";
}

function normalizeLocalPathCandidates(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return [];
  const unquoted = raw.replace(/^\uFEFF/, "").replace(/^["']|["']$/g, "").trim();
  const variants = new Set([unquoted]);
  if (/^file:\/\//i.test(unquoted)) {
    try {
      variants.add(new URL(unquoted).pathname);
    } catch {
      variants.add(unquoted.replace(/^file:\/+/i, ""));
    }
  }
  for (const candidate of [...variants]) {
    try {
      variants.add(decodeURIComponent(candidate));
    } catch {
      // A pasted local path can contain a bare percent sign; keep the raw value.
    }
    if (/^[a-zA-Z]:[\\/]/.test(candidate)) {
      variants.add(candidate.replace(/[\\/]+/g, path.sep));
      variants.add(path.win32.normalize(candidate));
    }
  }
  return [...variants]
    .map((candidate) => candidate.replace(/^\/([a-zA-Z]:[\\/])/, "$1"))
    .map((candidate) => path.resolve(candidate))
    .filter(Boolean);
}

async function getLatestReadinessFreshness(readiness = {}) {
  const reportBundle = await getLatestV1AcceptanceReport().catch(() => null);
  const latestReport = reportBundle?.latest || null;
  const readinessJobId = readiness?.result?.jobId || readiness?.workflowJobId || "";
  const readinessSourceMode = String(readiness?.sourceMode || "").trim();
  const readinessSourcePath = normalizeComparablePath(readiness.sourcePath || readiness.result?.sourceRender?.source || "");
  const readinessTargetPages = Number(readiness.maxPages || readiness.result?.sourceRender?.targetSlideCount || readiness.result?.sourceRender?.renderedPages || 0);
  if (readinessJobId && ["workflow-source", "local-path"].includes(readinessSourceMode)) {
    return {
      fresh: true,
      stale: false,
      matchesLatestReport: false,
      latestReportJobId: latestReport?.jobId || "",
      latestReadinessJobId: readinessJobId,
      latestReadinessEndedAt: readiness.endedAt || readiness.startedAt || "",
      sourceMode: readinessSourceMode,
      reason: ""
    };
  }
  if (!latestReport || !readinessJobId) {
    return {
      fresh: true,
      stale: false,
      matchesLatestReport: Boolean(readinessJobId),
      reason: ""
    };
  }
  const reportSourcePath = normalizeComparablePath(latestReport.sourcePath || "");
  const reportTargetPages = Number(latestReport.productVisualNext?.targetPages || latestReport.acceptance?.targetPages || latestReport.sourceRender?.renderedPages || 0);
  const reportTime = Date.parse(latestReport.writtenAt || "");
  const readinessTime = Date.parse(readiness.endedAt || readiness.startedAt || "");
  const sameSource = Boolean(reportSourcePath && readinessSourcePath && reportSourcePath === readinessSourcePath);
  const sameTargetPages = Boolean(reportTargetPages && readinessTargetPages && readinessTargetPages >= reportTargetPages);
  const freshEnough = Number.isFinite(reportTime) && Number.isFinite(readinessTime) ? readinessTime >= reportTime : true;
  const matchesLatestReport = Boolean(sameSource && sameTargetPages && freshEnough);
  const reasons = [];
  if (!sameSource) reasons.push("源文件不一致");
  if (!sameTargetPages) reasons.push("目标页数不足");
  if (!freshEnough) reasons.push("预检早于最新验收报告");
  return {
    fresh: matchesLatestReport,
    stale: !matchesLatestReport,
    matchesLatestReport,
    latestReportJobId: latestReport.jobId || "",
    latestReadinessJobId: readinessJobId,
    latestReportWrittenAt: latestReport.writtenAt || "",
    latestReadinessEndedAt: readiness.endedAt || readiness.startedAt || "",
    reason: matchesLatestReport
      ? ""
      : `产品级视觉预检已过期：${reasons.join("、") || "状态不匹配"}。请重新运行无费用产品视觉预检。`
  };
}

function normalizeComparablePath(value = "") {
  return String(value || "").trim().replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
}

function parseLastJson(stdout = "") {
  const text = String(stdout || "").trim();
  const start = text.lastIndexOf("\n{");
  const jsonText = start >= 0 ? text.slice(start + 1) : text;
  return JSON.parse(jsonText);
}

function withCheck(base, id, ok, detail, patch = {}) {
  return {
    ...base,
    ...patch,
    checks: [
      ...(base.checks || []),
      { id, ok, label: id, detail }
    ],
    summary: detail
  };
}

function compactPreflight(preflight = {}) {
  return {
    ok: Boolean(preflight.ok),
    action: preflight.action || "",
    startReady: Boolean(preflight.startReady),
    didRun: Boolean(preflight.didRun),
    requiredConfirmation: preflight.requiredConfirmation || "",
    externalImageCalls: preflight.externalImageCalls || 0,
    reason: preflight.reason || "",
    blockingIssues: preflight.blockingIssues || [],
    warnings: preflight.warnings || [],
    code: preflight.code || ""
  };
}

function buildExecutionSnapshot({
  phase = "",
  label = "",
  latest = null,
  job = null,
  provider = null,
  externalImageCalls = 0,
  targetPages = 0,
  requiredConfirmation = "externalImageSpend",
  readyIfConfirmed = false,
  blockingIssues = []
} = {}) {
  const sourceRender = latest?.result?.sourceRender || {};
  const approvals = latest?.result?.approvals || {};
  const runbook = latest?.result?.runbook || {};
  const safeBlockingIssues = Array.isArray(blockingIssues) ? blockingIssues.filter(Boolean) : [];
  return {
    phase,
    label,
    status: readyIfConfirmed ? "ready-after-confirmation" : "blocked",
    paidImageGeneration: true,
    safeToRunAutomatically: false,
    requiresExplicitSpendConfirmation: true,
    requiredConfirmation,
    externalImageCalls: clampInteger(externalImageCalls, 0, 50, 0),
    targetPages: clampInteger(targetPages || sourceRender.targetSlideCount || sourceRender.renderedPages, 0, 50, 0),
    source: {
      path: latest?.sourcePath || sourceRender.source || "",
      renderedPages: Number(sourceRender.renderedPages || 0),
      targetSlideCount: Number(sourceRender.targetSlideCount || 0),
      renderer: sourceRender.renderer || ""
    },
    workflowJob: {
      id: job?.id || latest?.result?.jobId || latest?.workflowJobId || "",
      status: job?.status || "",
      currentStage: job?.currentStage || "",
      sourceOriginalName: job?.input?.sourceOriginalName || ""
    },
    provider: provider ? {
      configured: Boolean(provider.configured),
      enabled: Boolean(provider.enabled),
      baseUrl: provider.baseUrl || "",
      model: provider.model || ""
    } : null,
    approvals: {
      passed: Number(approvals.passed || 0),
      total: Number(approvals.total || 0),
      missing: Array.isArray(approvals.missing) ? approvals.missing : []
    },
    runbook: {
      currentStep: runbook.currentStep || "",
      currentTitle: runbook.currentTitle || "",
      allowedActions: Array.isArray(runbook.allowedActions) ? runbook.allowedActions : []
    },
    blockingIssues: safeBlockingIssues,
    confirmationText: readyIfConfirmed
      ? `确认后将调用外部图片 API ${clampInteger(externalImageCalls, 0, 50, 0)} 次。`
      : "当前条件未满足，不允许调用外部图片 API。",
    updatedAt: new Date().toISOString()
  };
}

function buildSampleReviewChecklist({
  sample = null,
  provider = {},
  ready = false,
  passed = false,
  sampleLink = null,
  sourcePageLink = null
} = {}) {
  const sampleBaseUrl = normalizeProviderEndpoint(sample?.baseUrl || "");
  const providerBaseUrl = normalizeProviderEndpoint(provider?.baseUrl || "");
  const sampleModel = cleanString(sample?.model || "");
  const providerModel = cleanString(provider?.model || "");
  const sourceReferenced = isSourceReferencedVisualSample(sample);
  const productGenerated = Boolean(sample?.path && sample?.sha256 && sample?.dryRun !== true && sample?.provider !== "passthrough");
  const modelMatches = Boolean(sampleModel && providerModel && sampleModel === providerModel);
  const baseUrlMatches = Boolean(sampleBaseUrl && providerBaseUrl && sampleBaseUrl === providerBaseUrl);
  const prerequisitesReady = Boolean(productGenerated && sourceReferenced && modelMatches && baseUrlMatches);
  const humanReviewReady = Boolean((ready || passed) && prerequisitesReady);
  const items = [
    {
      id: "sample-exists",
      label: "真实样张文件",
      ok: Boolean(sample?.path),
      detail: sample?.relativePath || sample?.path || "缺少样张文件"
    },
    {
      id: "product-generated",
      label: "非 passthrough / dry-run",
      ok: productGenerated,
      detail: productGenerated ? "样张来自真实图片生成并保留 hash" : "样张仍缺少真实生成证据"
    },
    {
      id: "sample-hash",
      label: "样张 hash",
      ok: Boolean(sample?.sha256),
      detail: sample?.sha256 ? String(sample.sha256).slice(0, 12) : "缺少 sha256"
    },
    {
      id: "source-reference",
      label: "源页参考图",
      ok: sourceReferenced,
      detail: sourceReferenced ? (sample?.sourceImagePath || sample?.sourcePagePath || "source-page-edit") : "缺少源页面图像输入证据"
    },
    {
      id: "model-match",
      label: "模型一致",
      ok: modelMatches,
      detail: sampleModel || providerModel ? `${sampleModel || "-"} / ${providerModel || "-"}` : "缺少模型证据"
    },
    {
      id: "endpoint-match",
      label: "图片 API 一致",
      ok: baseUrlMatches,
      detail: sampleBaseUrl || providerBaseUrl ? `${sampleBaseUrl || "-"} / ${providerBaseUrl || "-"}` : "缺少 API 地址证据"
    },
    {
      id: "human-review",
      label: "人工复核",
      ok: humanReviewReady,
      detail: humanReviewReady ? "可打开样张复核后确认关卡" : "样张尚未达到复核条件"
    }
  ];
  return {
    status: passed ? "approved" : humanReviewReady ? "ready-for-review" : "blocked",
    ready: humanReviewReady,
    passed,
    sampleLink,
    sourcePageLink,
    sample: sample ? {
      path: sample.path || "",
      relativePath: sample.relativePath || "",
      provider: sample.provider || "",
      baseUrl: sample.baseUrl || "",
      model: sample.model || "",
      source: sample.source || "",
      dryRun: Boolean(sample.dryRun),
      passthrough: Boolean(sample.passthrough || sample.provider === "passthrough"),
      sha256: sample.sha256 || "",
      pageNumber: sample.pageNumber || null,
      imageInputMode: sample.imageInputMode || "",
      sourceImagePath: sample.sourceImagePath || "",
      sourcePagePath: sample.sourcePagePath || ""
    } : null,
    items,
    missing: items.filter((item) => !item.ok).map((item) => item.label),
    instruction: ready || passed
      ? "请打开真实样张，人工确认版式方向可接受后，再确认样张关卡。"
      : "请先生成 1 页真实 codex-ppt 视觉样张，再进入人工复核。"
  };
}

function normalizeProviderEndpoint(value = "") {
  return String(value || "").trim().replace(/\/+$/, "").replace(/\/v\d+$/i, "").toLowerCase();
}

function isSourceReferencedVisualSample(sample = null) {
  return Boolean(
    sample?.path
    && sample?.sha256
    && sample?.dryRun !== true
    && sample?.provider !== "passthrough"
    && sample?.imageInputMode === "source-page-edit"
    && (sample?.sourceImagePath || sample?.sourcePagePath)
  );
}

function makeWorkflowArtifactLink(jobId, artifactKey, pageId = "", options = {}) {
  if (!jobId || !artifactKey) return null;
  const pagePart = pageId ? `/${encodeURIComponent(pageId)}` : "";
  const downloadPart = options.download ? "?download=1" : "";
  return {
    key: artifactKey,
    pageId: pageId || "",
    href: `/api/workflow-jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(artifactKey)}${pagePart}${downloadPart}`,
    download: Boolean(options.download)
  };
}

function buildSourcePageLinkForSample(jobId, sample = null) {
  if (!jobId || !sample) return null;
  const pageId = cleanString(sample.pageId || "");
  const pageNumber = Number(sample.pageNumber || 0);
  const fallbackPageId = Number.isInteger(pageNumber) && pageNumber > 0
    ? `page_${String(pageNumber).padStart(3, "0")}`
    : "";
  const sourcePath = cleanString(sample.sourceImagePath || sample.sourcePagePath || "");
  const sourceMatch = sourcePath.match(/page_(\d{3})\.(?:png|jpe?g|webp)$/i);
  const sourcePageId = sourceMatch ? `page_${sourceMatch[1]}` : "";
  const resolvedPageId = pageId || sourcePageId || fallbackPageId;
  return resolvedPageId ? makeWorkflowArtifactLink(jobId, "rendered-page", resolvedPageId) : null;
}

function buildProductVisualNextStagePlan({
  latest = null,
  job = null,
  sample = null,
  sampleApproved = false,
  fullDeckApproved = false,
  requestedMaxPages = null
} = {}) {
  const renderedPages = Array.isArray(job?.artifacts?.renderedPages) ? job.artifacts.renderedPages.length : 0;
  const targetPages = clampInteger(
    requestedMaxPages || renderedPages || latest?.result?.sourceRender?.targetSlideCount || latest?.result?.sourceRender?.renderedPages || latest?.maxPages,
    1,
    50,
    1
  );
  const testPages = clampInteger(Math.min(2, targetPages), 1, 2, 1);
  const sampleProduct = isSourceReferencedVisualSample(sample);
  const steps = [
    {
      id: "approve-sample",
      label: "确认样张关卡",
      status: sampleApproved ? "done" : sampleProduct ? "ready" : "blocked",
      externalImageCalls: 0,
      detail: sampleApproved ? "已确认" : sampleProduct ? "可人工复核后确认" : "等待真实源页重绘样张"
    },
    {
      id: "approve-full-deck",
      label: "确认全量关卡",
      status: fullDeckApproved ? "done" : sampleApproved ? "ready" : "blocked",
      externalImageCalls: 0,
      detail: fullDeckApproved ? "已确认" : sampleApproved ? "可确认全量生成关卡" : "需先确认样张"
    },
    {
      id: "run-two-page-test",
      label: "先跑 2 页测试",
      status: sampleApproved && fullDeckApproved ? "ready" : "blocked",
      externalImageCalls: testPages,
      detail: `推荐先生成 ${testPages} 页，确认跨页一致性`
    },
    {
      id: "run-full-deck",
      label: "生成全量图片型 PPT",
      status: sampleApproved && fullDeckApproved ? "ready" : "blocked",
      externalImageCalls: targetPages,
      detail: `全量预计 ${targetPages} 次图片调用`
    }
  ];
  const blockers = [
    ...(!sampleProduct ? ["缺少可复核的真实源页重绘样张。"] : []),
    ...(!sampleApproved ? ["样张关卡尚未确认。"] : []),
    ...(!fullDeckApproved ? ["全量生成关卡尚未确认。"] : [])
  ];
  return {
    status: blockers.length ? "blocked" : "ready",
    targetPages,
    recommendedTestPages: testPages,
    estimatedFullDeckImageCalls: targetPages,
    estimatedTwoPageImageCalls: testPages,
    nextRecommendedAction: !sampleApproved
      ? "先确认样张关卡"
      : !fullDeckApproved
        ? "确认全量生成关卡"
        : `先授权并生成 ${testPages} 页测试`,
    blockers,
    steps
  };
}

function buildVisualImageLinks(jobId, visualImages = []) {
  if (!Array.isArray(visualImages)) return [];
  return visualImages
    .slice(0, 50)
    .map((image, index) => makeWorkflowArtifactLink(jobId, "visual-page", image?.pageId || image?.id || `page_${String(index + 1).padStart(3, "0")}`))
    .filter(Boolean);
}

function isConfirmed(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function cleanString(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 1000);
}

function excerptText(value = "", maxLength = 520) {
  const text = cleanString(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function localizeSampleApprovalIssue(value = "") {
  const text = cleanString(value);
  if (!text) return "";
  if (/Generate one visual sample artifact/i.test(text) || /CODEX_PPT_SAMPLE_REQUIRED/.test(text)) {
    return "请先生成 1 页真实 codex-ppt 视觉样张，再确认样张关卡。";
  }
  if (/product visual sample/i.test(text) || /CODEX_PPT_SAMPLE_NON_PRODUCT/.test(text)) {
    return "当前样张不是产品级真实重绘样张，请使用已配置的图片 API 重新生成。";
  }
  if (/backend/i.test(text) || /CODEX_PPT_SAMPLE_BACKEND_MISMATCH/.test(text)) {
    return "当前样张与已确认的图片后端不一致，请用当前 gpt-image-2 后端重新生成样张。";
  }
  if (/prior approvals/i.test(text) || /CODEX_PPT_APPROVAL_REQUIRED/.test(text)) {
    return "请先完成大纲、风格和后端确认关卡，再进入样张确认。";
  }
  return text;
}

function localizeFullDeckApprovalIssue(value = "") {
  const text = cleanString(value);
  if (!text) return "";
  if (/sample/i.test(text) || /CODEX_PPT_SAMPLE_REQUIRED/.test(text)) {
    return "请先生成并确认 1 页真实 codex-ppt 视觉样张，再确认全量生成关卡。";
  }
  if (/prior approvals/i.test(text) || /CODEX_PPT_APPROVAL_REQUIRED/.test(text)) {
    return "请先完成大纲、风格、后端和样张确认关卡，再确认全量生成。";
  }
  if (/full.?deck/i.test(text)) {
    return "全量生成关卡尚未确认。";
  }
  return localizeSampleApprovalIssue(text) || text;
}

function getApprovedGateSet(job = {}) {
  return new Set((Array.isArray(job.artifacts?.codexPptApprovals) ? job.artifacts.codexPptApprovals : [])
    .filter((item) => item?.status === "approved" && item.gate)
    .map((item) => item.gate));
}

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function stringifyEnv(env = {}) {
  return Object.fromEntries(
    Object.entries(env)
      .filter(([key, value]) => key && value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)])
  );
}
