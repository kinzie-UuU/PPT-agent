export function getWorkflowGuidedAction(runbook = {}, context = {}) {
  const { job, canAssembleImageDeck, canGenerateVisualDeck, canGenerateVisualSample, nextStage, promptCount } = context;
  const activeStep = (runbook.steps || []).find((step) => step.status === "blocked")
    || (runbook.steps || []).find((step) => step.status === "active");
  const action = String((runbook.allowedActions || [])[0] || activeStep?.action || "").trim();

  if (!job?.id) {
    return {
      title: "推荐下一步",
      label: "选择工作流",
      description: "先创建或恢复一个工作流，再运行双技能链路。",
      disabled: true
    };
  }

  if (!action) {
    return {
      title: runbook.currentTitle || "推荐下一步",
      label: "查看状态",
      description: runbook.summary || "当前状态没有可自动执行的下一步。",
      kind: "focus",
      targetId: "workflow-compliance-panel",
      note: "继续前先查看运行手册和交付门禁。"
    };
  }

  if (/approve outline\/style\/backend|approve fullDeck|approval/i.test(action)) {
    return {
      title: "需要审批",
      label: "打开审批",
      description: runbook.summary || "这一步需要明确的 codex-ppt 审批证据。",
      kind: "focus",
      targetId: "workflow-compliance-panel",
      note: "检查所需产物后，在 codex-ppt 审批区继续。"
    };
  }

  if (/codex slide worker|slide workers/i.test(action)) {
    return {
      title: "需要 codex-ppt 图片页任务",
      label: "打开图片页任务",
      description: runbook.summary || "全量图片页需要先生成并记录结果。",
      kind: "focus",
      targetId: "codex-slide-worker-panel",
      note: "优先使用后端批处理；需要人工接管时，再在任务面板认领并记录每页结果。"
    };
  }

  if (/editable\/dispatch|editable\/record|page workers/i.test(action)) {
    return {
      title: "需要可编辑页面任务",
      label: "打开页面任务",
      description: runbook.summary || "先启动真实 image-to-editable-ppt 页面重建任务，再派发和记录。",
      kind: "focus",
      targetId: "editable-page-worker-panel",
      note: "优先启动后端页面批处理；需要人工接管时，再从任务面板派发和记录。"
    };
  }

  if (/reset failed page workers/i.test(action)) {
    return {
      title: "需要重试",
      label: "查看失败任务",
      description: runbook.summary || "失败页面需要先检查再重试。",
      kind: "focus",
      targetId: "editable-page-worker-panel",
      note: "检查失败页面任务，修复原因后再重置并重跑。"
    };
  }

  if (/review\/approve/i.test(action)) {
    return {
      title: "需要人工复核",
      label: "打开复核",
      description: runbook.summary || "交付前需要复核最终产物。",
      kind: "focus",
      targetId: "workflow-delivery-panel",
      note: "逐页对比原始页、图片版和可编辑页，通过后再记录整套复核。"
    };
  }

  const workflowActions = {
    "source/render": {
      label: "渲染源文件",
      message: "正在渲染源文件页面...",
      body: {}
    },
    "visual/sample": {
      label: "生成样张",
      message: "正在生成 codex-ppt 视觉样张...",
      body: {},
      disabled: !canGenerateVisualSample
    },
    "visual/generate": {
      label: "生成图片整套",
      message: "正在生成 codex-ppt 图片型整套 PPT...",
      body: {},
      disabled: !canGenerateVisualDeck
    },
    "image-deck/assemble": {
      label: "组装图片 PPT",
      message: "正在组装图片型 PPT...",
      body: {},
      disabled: !canAssembleImageDeck
    },
    "editable/prepare": {
      label: "准备 editppt",
      message: "正在准备 editppt 运行...",
      body: { force: true, maxConcurrentPages: 6 },
      disabled: !job?.artifacts?.imageDeck
    },
    "editable/hints": {
      label: "刷新文字提示",
      message: "正在刷新 editppt 文字提示...",
      body: {},
      disabled: !job?.artifacts?.editableRun
    },
    "editable/prompts": {
      label: "生成页面提示",
      message: "正在生成页面重建提示...",
      body: {},
      disabled: !job?.artifacts?.editableRun
    },
    "editable/finalize": {
      label: "生成最终 PPTX",
      message: "正在生成最终可编辑 PPTX...",
      body: {},
      disabled: nextStage !== "finalize"
    },
    "retry-stale-page-evidence": {
      label: "重置过期页面证据",
      message: "正在重置过期页面证据...",
      body: {},
      disabled: false
    }
  };

  const matchedAction = Object.keys(workflowActions).find((key) => action === key || action.includes(key));
  if (matchedAction) {
    const record = workflowActions[matchedAction];
    return {
      title: runbook.currentTitle || "推荐下一步",
      label: record.label,
      description: runbook.summary || `执行 ${matchedAction}`,
      kind: "workflow",
      action: matchedAction,
      body: record.body,
      message: record.message,
      disabled: Boolean(record.disabled)
    };
  }

  if (/sync codex/i.test(action)) {
    return {
      title: "同步 codex-ppt 页面任务",
      label: "同步页面任务",
      description: runbook.summary || "创建或刷新 codex-ppt 图片页任务。",
      kind: "sync-codex-slides"
    };
  }

  if (/read prompts/i.test(action) && promptCount) {
    return {
      title: "读取页面提示",
      label: "读取提示",
      description: runbook.summary || "读取页面重建提示，便于复核和交接。",
      kind: "load-prompts"
    };
  }

  return {
    title: runbook.currentTitle || "推荐下一步",
    label: "打开运行手册",
    description: runbook.summary || `下一步：${action}`,
    kind: "focus",
    targetId: "workflow-compliance-panel",
    note: `需要手动处理：${action}`
  };
}
