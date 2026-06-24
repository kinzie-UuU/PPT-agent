export function deriveWorkflowDeliveryStatus(job = {}, loadedTasks = []) {
  const artifacts = job?.artifacts || {};
  const final = artifacts.editableFinal || {};
  const editability = final.pptxEditability || {};
  const tasks = Array.isArray(loadedTasks) && loadedTasks.length
    ? loadedTasks
    : Array.isArray(artifacts.editableWorkerTasks) ? artifacts.editableWorkerTasks : [];
  const events = Array.isArray(job?.events) ? job.events : [];
  const stages = Object.values(job?.stages || {});

  const sourcePages = numberOrZero(job?.sourceMeta?.pageCount) || countArray(artifacts.renderedPages);
  const renderedPages = countArray(artifacts.renderedPages);
  const visualPages = countArray(artifacts.visualImages);
  const imageDeckPages = numberOrZero(artifacts.imageDeck?.pageCount);
  const ocrPages = numberOrZero(artifacts.ocrTextHints?.pageCount);
  const promptPages = countArray(artifacts.editableWorkerPrompts);
  const readyPages = tasks.filter((task) => task.status === "ready").length;
  const runningPages = tasks.filter((task) => task.status === "running" || task.status === "claimed").length;
  const taskRecordedPages = tasks.filter((task) => task.status === "recorded").length;
  const failedPages = tasks.filter((task) => task.status === "failed").length;
  const validationReady = Boolean(final.validation?.path || job?.finalValidation);
  const validationPages = numberOrZero(job?.finalValidation?.expected_pages || job?.finalValidation?.slides);
  const finalPages = numberOrZero(final.summary?.page_count || editability.slideCount || validationPages);
  const hasFinal = hasArtifact(final);
  const recordedPages = Math.max(taskRecordedPages, hasFinal ? finalPages : 0);
  const processedPages = Math.max(finalPages, validationPages, promptPages, ocrPages, imageDeckPages, visualPages, recordedPages);
  const retryCount = events.filter((event) => /reset|retry/i.test(`${event.type || ""} ${event.message || ""}`)).length;
  const usesApprovedRaster = tasks.some((task) => /approval|approved|raster/i.test(`${task.message || ""} ${task.error || ""}`));
  const validationFailed = job?.finalValidation?.passed === false;
  const validationPassed = validationReady && job?.finalValidation?.passed === true;
  const editablePassed = editability.editable === true || editability.status === "pass";
  const partialDeck = Boolean(sourcePages && processedPages && processedPages < sourcePages);
  const failedStage = stages.some((stage) => stage?.status === "failed");

  let level = "pending";
  if (failedPages || failedStage || validationFailed) level = "blocked";
  else if (hasFinal && validationPassed && editablePassed && !partialDeck) level = "ready";
  else if (hasFinal) level = "warning";
  else if (processedPages || readyPages || runningPages) level = "working";

  const facts = [
    { label: "源页面", value: sourcePages || "未知" },
    { label: "已渲染页面", value: renderedPages || 0 },
    { label: "图片型 PPT 页面", value: imageDeckPages || 0 },
    { label: "就绪 worker 页面", value: readyPages || 0 },
    { label: "已记录页面", value: recordedPages || 0 },
    { label: "失败页面", value: failedPages || 0 },
    { label: "最终 PPTX", value: hasFinal ? "已生成" : "缺失" },
    { label: "重试次数", value: retryCount }
  ];

  const warnings = [];
  if (!sourcePages) warnings.push("源页面尚未渲染。");
  if (partialDeck) warnings.push(`当前输出只覆盖 ${processedPages}/${sourcePages} 个源页面。`);
  if (failedPages) warnings.push(`${failedPages} 个页面 worker 任务失败，需要重试。`);
  if (runningPages) warnings.push(`${runningPages} 个页面 worker 任务正在运行或已被认领。`);
  if (!validationReady) warnings.push("缺少最终校验 JSON。");
  if (validationFailed) warnings.push("最终校验 JSON 未通过。");
  if (hasFinal && !editablePassed) warnings.push("最终 PPTX 尚未通过对象级可编辑检查。");
  if (usesApprovedRaster) warnings.push("部分页面使用了已批准的栅格兜底证据，需要复核。");
  if (!hasFinal) warnings.push("editable-final.pptx 尚未生成。");

  const nextStep = chooseNextStep({
    sourcePages,
    renderedPages,
    visualPages,
    imageDeckPages,
    editableRunReady: Boolean(artifacts.editableRun?.path),
    promptPages,
    readyPages,
    runningPages,
    recordedPages,
    failedPages,
    hasFinal,
    validationReady,
    validationPassed,
    editablePassed
  });
  const nextActions = buildNextActions(nextStep, {
    sourcePages,
    readyPages,
    runningPages,
    recordedPages,
    failedPages,
    hasFinal,
    validationReady,
    editablePassed
  });

  return {
    level,
    title: titleForLevel(level),
    summary: summaryForLevel(level, { hasFinal, partialDeck, processedPages, sourcePages, validationPassed, editablePassed }),
    facts,
    warnings: uniqueStrings(warnings),
    nextStep,
    nextActions
  };
}

function chooseNextStep({
  sourcePages,
  renderedPages,
  visualPages,
  imageDeckPages,
  editableRunReady,
  promptPages,
  readyPages,
  runningPages,
  recordedPages,
  failedPages,
  hasFinal,
  validationReady,
  validationPassed,
  editablePassed
}) {
  if (!sourcePages || !renderedPages) {
    return makeNextStep("render-source", "渲染源页面", "把上传的 PPT/PDF/图片转换成标准页面 PNG。");
  }
  if (!visualPages || !imageDeckPages) {
    return makeNextStep("generate-image-deck", "生成图片型 PPT", "使用 codex-ppt 创建视觉幻灯片图片，并组装图片型 PPTX。");
  }
  if (!editableRunReady) {
    return makeNextStep("prepare-editable", "准备可编辑重建", "图片型 PPT 就绪后，运行 image-to-editable-ppt prepare。");
  }
  if (failedPages) {
    return makeNextStep("retry-failed-pages", "重试失败页面 worker", `${failedPages} 个失败页面必须先重置并重建。`);
  }
  if (runningPages) {
    return makeNextStep("wait-page-workers", "等待页面 worker", `${runningPages} 个页面 worker 仍在运行或已被认领。`);
  }
  if (!hasFinal && sourcePages && recordedPages < sourcePages && readyPages) {
    return makeNextStep("start-page-workers", "启动页面 worker 批处理", `${readyPages} 个就绪页面可以重建为可编辑幻灯片对象。`);
  }
  if (!hasFinal && sourcePages && recordedPages < sourcePages && promptPages) {
    return makeNextStep("sync-page-workers", "同步页面 worker 队列", "可编辑提示已存在，但就绪 worker 任务需要同步或刷新。");
  }
  if (!hasFinal && (!sourcePages || recordedPages >= sourcePages)) {
    return makeNextStep("finalize-editable", "生成最终可编辑 PPTX", "所有已记录页面现在可以组装并校验。");
  }
  if (hasFinal && (!validationReady || !validationPassed || !editablePassed)) {
    return makeNextStep("review-validation", "复核最终校验", "标记产品可交付前，需要处理校验或可编辑性警告。");
  }
  if (hasFinal) {
    return makeNextStep("review-delivery", "复核并下载", "复核最终 PPTX、校验 JSON、图片型 PPT 和日志包。");
  }
  return makeNextStep("continue-workflow", "继续工作流", "继续执行下一个可用工作流步骤。");
}

function buildNextActions(nextStep, {
  sourcePages,
  readyPages,
  runningPages,
  recordedPages,
  failedPages,
  hasFinal,
  validationReady,
  editablePassed
}) {
  const actions = [nextStep.label + ": " + nextStep.reason];
  if (failedPages) actions.push("打开 worker 队列，检查失败页面，只重试这些页面。");
  if (!hasFinal && readyPages) actions.push(`确认外部图片 API 用量后，为 ${readyPages} 个就绪页面运行受保护的 worker 批处理。`);
  if (!hasFinal && runningPages) actions.push("观察后台 worker 日志，直到所有页面已记录或失败。");
  if (!hasFinal && sourcePages && recordedPages >= sourcePages) actions.push("运行最终生成，创建 editable-final.pptx 和 editable-validation.json。");
  if (hasFinal && validationReady && editablePassed) actions.push("下载最终 PPTX、校验 JSON 和日志包。");
  return uniqueStrings(actions);
}

function makeNextStep(id, label, reason) {
  return { id, label, reason };
}

function titleForLevel(level) {
  if (level === "ready") return "可以交付";
  if (level === "warning") return "草稿需要复核";
  if (level === "blocked") return "交付被阻断";
  if (level === "working") return "工作流进行中";
  return "交付待处理";
}

function summaryForLevel(level, { hasFinal, partialDeck, processedPages, sourcePages, validationPassed, editablePassed }) {
  if (level === "ready") return "最终 PPTX 已生成，并通过校验和可编辑性检查。";
  if (level === "warning" && partialDeck) return `最终 PPTX 已生成，但只覆盖 ${processedPages}/${sourcePages} 个源页面。`;
  if (level === "warning" && hasFinal && (!validationPassed || !editablePassed)) return "最终 PPTX 已生成，但校验或可编辑性仍需复核。";
  if (level === "blocked") return "交付前必须先修复失败任务、失败阶段或失败校验。";
  if (level === "working") return "中间产物已存在，请继续页面重建、记录和最终组装。";
  return hasFinal ? "等待最终校验证据。" : "工作流尚未到达最终交付阶段。";
}

function countArray(value) {
  return Array.isArray(value) ? value.length : 0;
}

function numberOrZero(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function hasArtifact(artifact = {}) {
  return Boolean(artifact?.path);
}

function uniqueStrings(items = []) {
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))];
}
