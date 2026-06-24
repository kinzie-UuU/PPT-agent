import { useEffect, useMemo, useState } from "react";
import { api, getErrorMessage } from "../api/client.js";

export function useWorkflowWorkerConsole({ job, promptCount, onRefresh, onRunStep }) {
  const [promptBundle, setPromptBundle] = useState(null);
  const [workerTaskBundle, setWorkerTaskBundle] = useState(null);
  const [workerBriefBundle, setWorkerBriefBundle] = useState(null);
  const [workerRunBundle, setWorkerRunBundle] = useState(null);
  const [workerBatchPreflightBundle, setWorkerBatchPreflightBundle] = useState(null);
  const [promptLoading, setPromptLoading] = useState(false);
  const [promptError, setPromptError] = useState("");
  const [selectedPageId, setSelectedPageId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [confirmSpawned, setConfirmSpawned] = useState(false);
  const [acceptOfflineTextHints, setAcceptOfflineTextHints] = useState(false);

  const prompts = useMemo(() => Array.isArray(promptBundle?.prompts) ? promptBundle.prompts : [], [promptBundle]);
  const workerTasks = useMemo(() => Array.isArray(workerTaskBundle?.tasks) ? workerTaskBundle.tasks : [], [workerTaskBundle]);
  const workerBriefs = useMemo(() => Array.isArray(workerBriefBundle?.index?.briefs) ? workerBriefBundle.index.briefs : [], [workerBriefBundle]);
  const selectedPrompt = prompts.find((prompt) => prompt.pageId === selectedPageId) || prompts[0] || null;
  const selectedTask = workerTasks.find((task) => task.pageId === (selectedPrompt?.pageId || selectedPageId)) || null;
  const selectedBrief = workerBriefs.find((brief) => brief.pageId === (selectedPrompt?.pageId || selectedPageId)) || null;
  const selectedPromptIsLocal = selectedPrompt?.executionMode === "local";

  useEffect(() => {
    setPromptBundle(null);
    setWorkerTaskBundle(null);
    setWorkerBriefBundle(null);
    setWorkerRunBundle(null);
    setWorkerBatchPreflightBundle(null);
    setPromptError("");
    setSelectedPageId("");
    setConfirmSpawned(false);
    setAcceptOfflineTextHints(false);
    if (job?.id && promptCount) {
      loadPrompts(job.id);
      loadWorkerTasks(job.id);
      loadWorkerBriefs(job.id);
      loadWorkerRuns(job.id);
      loadWorkerBatchPreflight(job.id);
    }
  }, [job?.id, promptCount]);

  useEffect(() => {
    if (!selectedPageId && prompts.length) setSelectedPageId(prompts[0].pageId);
  }, [prompts, selectedPageId]);

  async function loadPrompts(id = job?.id) {
    if (!id) return;
    setPromptLoading(true);
    setPromptError("");
    try {
      const bundle = await api.workflowEditablePrompts(id);
      setPromptBundle(bundle);
    } catch (err) {
      setPromptError(getErrorMessage(err));
    } finally {
      setPromptLoading(false);
    }
  }

  async function loadWorkerTasks(id = job?.id) {
    if (!id) return;
    try {
      const bundle = await api.workflowWorkerTasks(id);
      setWorkerTaskBundle(bundle);
    } catch (err) {
      setPromptError(getErrorMessage(err));
    }
  }

  async function loadWorkerBriefs(id = job?.id) {
    if (!id) return;
    try {
      const bundle = await api.workflowWorkerBriefs(id);
      setWorkerBriefBundle(bundle);
    } catch (err) {
      setPromptError(getErrorMessage(err));
    }
  }

  async function loadWorkerRuns(id = job?.id) {
    if (!id) return;
    try {
      const bundle = await api.workflowWorkerRuns(id);
      setWorkerRunBundle(bundle);
    } catch (err) {
      setPromptError(getErrorMessage(err));
    }
  }

  async function loadWorkerBatchPreflight(id = job?.id, options = {}) {
    if (!id) return null;
    try {
      const bundle = await api.workflowWorkerBatchPreflight(id, {
        mode: options.mode || "model",
        maxPages: options.maxPages || workerTaskBundle?.summary?.ready || promptCount || 20,
        pages: options.pages || "",
        agentPrefix: options.agentPrefix || "product-page-worker",
        confirmExternalImageSpend: Boolean(options.confirmExternalImageSpend),
        acceptOfflineTextHints: Boolean(options.acceptOfflineTextHints),
        offlineTextHintsReason: options.offlineTextHintsReason || "",
        autoFinalize: Boolean(options.autoFinalize)
      });
      setWorkerBatchPreflightBundle(bundle);
      return bundle;
    } catch (err) {
      setPromptError(getErrorMessage(err));
      return null;
    }
  }

  async function startWorkerBatch(options = {}) {
    if (!job?.id) return;
    setPromptLoading(true);
    setPromptError("");
    try {
      const bundle = await api.startWorkflowWorkerBatch(job.id, {
        mode: options.mode || "model",
        maxPages: options.maxPages || 20,
        pages: options.pages || "",
        agentPrefix: options.agentPrefix || "product-page-worker",
        confirmExternalImageSpend: Boolean(options.confirmExternalImageSpend),
        acceptOfflineTextHints: Boolean(options.acceptOfflineTextHints),
        offlineTextHintsReason: options.offlineTextHintsReason || "",
        autoFinalize: Boolean(options.autoFinalize)
      });
      setWorkerRunBundle(bundle.runs || bundle);
      await loadWorkerTasks(job.id);
      await loadWorkerBatchPreflight(job.id, options);
      await onRefresh?.();
    } catch (err) {
      setPromptError(getErrorMessage(err));
    } finally {
      setPromptLoading(false);
    }
  }

  async function buildWorkerBriefs() {
    if (!job?.id) return;
    setPromptLoading(true);
    setPromptError("");
    try {
      const pages = prompts.length ? prompts.map((prompt) => prompt.pageId).join(",") : "";
      const bundle = await api.buildWorkflowWorkerBriefs(job.id, {
        pages,
        agentId: agentId.trim() || "worker-001"
      });
      setWorkerBriefBundle(bundle);
      await onRefresh?.();
    } catch (err) {
      setPromptError(getErrorMessage(err));
    } finally {
      setPromptLoading(false);
    }
  }

  async function syncWorkerTasks() {
    if (!job?.id) return;
    setPromptLoading(true);
    setPromptError("");
    try {
      const bundle = await api.syncWorkflowWorkerTasks(job.id);
      setWorkerTaskBundle(bundle);
      if (!promptBundle && Array.isArray(bundle.prompts)) setPromptBundle({ prompts: bundle.prompts });
      await loadWorkerBatchPreflight(job.id);
    } catch (err) {
      setPromptError(getErrorMessage(err));
    } finally {
      setPromptLoading(false);
    }
  }

  async function claimWorkerTask() {
    const pageId = selectedPrompt?.pageId || selectedPageId;
    const trimmedAgentId = selectedPromptIsLocal ? "main" : agentId.trim();
    if (!job?.id || !pageId) {
      setPromptError("请先选择一个页面任务。");
      return;
    }
    if (!trimmedAgentId) {
      setPromptError("请输入真实页面任务的智能体 ID。");
      return;
    }
    if (!selectedPromptIsLocal && !confirmSpawned) {
      setPromptError("认领前请先确认真实页面任务已经启动。");
      return;
    }
    if (!acceptOfflineTextHints && !job?.artifacts?.editableTextHintsAcknowledgement?.accepted) {
      setPromptError("PaddleOCR 令牌未配置。派发前请确认使用离线内置文字提示，或先配置 PaddleOCR。");
      return;
    }
    setPromptLoading(true);
    setPromptError("");
    try {
      const bundle = await api.workflowWorkerTaskAction(job.id, pageId, "claim", {
        agentId: trimmedAgentId,
        confirmSpawned: !selectedPromptIsLocal,
        local: selectedPromptIsLocal,
        acceptOfflineTextHints,
        offlineTextHintsReason: "前端页面任务控制台确认"
      });
      setWorkerTaskBundle(bundle);
    } catch (err) {
      setPromptError(getErrorMessage(err));
    } finally {
      setPromptLoading(false);
    }
  }

  async function runWorkerAction(action) {
    const pageId = selectedPrompt?.pageId || selectedPageId;
    const localMode = selectedPrompt?.executionMode === "local";
    const trimmedAgentId = localMode ? "main" : agentId.trim();
    if (!pageId) {
      setPromptError("请先选择一个页面提示。");
      return;
    }
    if (!trimmedAgentId) {
      setPromptError("请输入真实页面任务的智能体 ID。");
      return;
    }
    if (action === "dispatch" && !localMode && !confirmSpawned) {
      setPromptError("派发前请先确认这个页面任务已经启动。");
      return;
    }
    if (action === "dispatch" && !acceptOfflineTextHints && !job?.artifacts?.editableTextHintsAcknowledgement?.accepted) {
      setPromptError("PaddleOCR 令牌未配置。派发前请确认使用离线内置文字提示，或先配置 PaddleOCR。");
      return;
    }
    setPromptError("");
    await onRunStep?.(
      action === "dispatch" ? "editable/dispatch" : "editable/record",
      action === "dispatch"
        ? { pageId, agentId: trimmedAgentId, confirmSpawned: !localMode, local: localMode, acceptOfflineTextHints, offlineTextHintsReason: "前端页面任务控制台确认" }
        : { pageId, agentId: trimmedAgentId },
      action === "dispatch" ? "正在登记真实页面任务派发..." : "正在记录页面任务结果..."
    );
    await loadPrompts();
    await loadWorkerTasks();
  }

  async function resetSelectedWorkerTask() {
    const pageId = selectedPrompt?.pageId || selectedPageId;
    if (!job?.id || !pageId) {
      setPromptError("请先选择一个页面任务。");
      return;
    }
    setPromptLoading(true);
    setPromptError("");
    try {
      const bundle = await api.workflowWorkerTaskAction(job.id, pageId, "reset", {
        reason: "前端手动重试",
        agentId: selectedTask?.agentId || agentId.trim() || "",
        confirmLost: selectedTask?.status === "running" || selectedTask?.status === "claimed"
      });
      setWorkerTaskBundle(bundle);
    } catch (err) {
      setPromptError(getErrorMessage(err));
    } finally {
      setPromptLoading(false);
    }
  }

  return {
    agentId,
    acceptOfflineTextHints,
    claimWorkerTask,
    confirmSpawned,
    promptError,
    promptLoading,
    prompts,
    runWorkerAction,
    selectedBrief,
    selectedPageId,
    selectedPrompt,
    selectedTask,
    setAgentId,
    setAcceptOfflineTextHints,
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
  };
}
