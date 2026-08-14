export const api = {
  async upload(files) {
    const form = new FormData();
    [...files].forEach((file) => form.append("files", file));
    const requestKey = writeRequestKey("POST", "/api/uploads", [...files].map(fileFingerprint));
    const requestId = getOrCreateWriteRequestId(requestKey);
    let receivedResponse = false;
    try {
      const response = await fetchWithTimeout("/api/uploads", { method: "POST", body: form, headers: writeRequestHeaders(requestKey, requestId) }, 300000);
      receivedResponse = true;
      const data = await readJson(response);
      releaseWriteRequestId(requestKey, requestId);
      return data;
    } catch (error) {
      markWriteRequestRecoveryRequired(requestKey, requestId, error);
      if (!shouldRetainWriteRequestId(error, receivedResponse)) releaseWriteRequestId(requestKey, requestId);
      throw error;
    }
  },
  async create(path, body, options = {}) {
    const requestKey = writeRequestKey("POST", path, body);
    const requestId = options.requestId || getOrCreateWriteRequestId(requestKey);
    let receivedResponse = false;
    try {
      const response = await fetchWithTimeout(path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...writeRequestHeaders(requestKey, requestId)
        },
        body: JSON.stringify(body),
        signal: options.signal
      }, Number(options.timeoutMs || 300000));
      receivedResponse = true;
      const data = await readJson(response);
      releaseWriteRequestId(requestKey, requestId);
      return data;
    } catch (error) {
      markWriteRequestRecoveryRequired(requestKey, requestId, error);
      if (!shouldRetainWriteRequestId(error, receivedResponse)) releaseWriteRequestId(requestKey, requestId);
      throw error;
    }
  },
  async remove(path) {
    const requestKey = writeRequestKey("DELETE", path, null);
    const requestId = getOrCreateWriteRequestId(requestKey);
    let receivedResponse = false;
    try {
      const response = await fetchWithTimeout(path, {
        method: "DELETE",
        headers: writeRequestHeaders(requestKey, requestId)
      }, 60000);
      receivedResponse = true;
      const data = await readJson(response);
      releaseWriteRequestId(requestKey, requestId);
      return data;
    } catch (error) {
      markWriteRequestRecoveryRequired(requestKey, requestId, error);
      if (!shouldRetainWriteRequestId(error, receivedResponse)) releaseWriteRequestId(requestKey, requestId);
      throw error;
    }
  },
  async health(signal) {
    const response = await fetch("/api/health", { cache: "no-store", signal });
    return readJson(response);
  },
  async doctor(signal) {
    const response = await fetch("/api/doctor", { cache: "no-store", signal });
    return readJson(response);
  },
  async localImageStatus(signal) {
    const response = await fetch("/api/local-image/status", { cache: "no-store", signal });
    return readJson(response);
  },
  async rescanLocalImageQa(id) {
    return this.create(`/api/jobs/${id}/rescan-local-image-qa`, {});
  },
  async generateVisualTargetSample(id) {
    return this.create(`/api/jobs/${id}/visual-target/sample`, {});
  },
  async generateVisualProject(id, body = {}) {
    return this.create(`/api/jobs/${id}/visual-project/generate`, body);
  },
  async config() {
    const response = await fetch("/api/config", { cache: "no-store" });
    return readJson(response);
  },
  async saveConfig(body) {
    return this.create("/api/config", body);
  },
  async savePaddleOcrToken(body) {
    return this.create("/api/config/editppt/paddle-ocr-token", body);
  },
  async testConfig(body) {
    return this.create("/api/config/test", body);
  },
  async models(body) {
    return this.create("/api/config/models", body);
  },
  async testProvider(body) {
    return this.create("/api/providers/test", body);
  },
  async styleReferences() {
    const response = await fetch("/api/style-references", { cache: "no-store" });
    return readJson(response);
  },
  async uploadStyleReferences(files, meta = {}) {
    const form = new FormData();
    [...files].forEach((file) => form.append("files", file));
    Object.entries(meta).forEach(([key, value]) => form.append(key, value || ""));
    const requestKey = writeRequestKey("POST", "/api/style-references", { files: [...files].map(fileFingerprint), meta });
    const requestId = getOrCreateWriteRequestId(requestKey);
    let receivedResponse = false;
    try {
      const response = await fetchWithTimeout("/api/style-references", { method: "POST", body: form, headers: writeRequestHeaders(requestKey, requestId) }, 300000);
      receivedResponse = true;
      const data = await readJson(response);
      releaseWriteRequestId(requestKey, requestId);
      return data;
    } catch (error) {
      markWriteRequestRecoveryRequired(requestKey, requestId, error);
      if (!shouldRetainWriteRequestId(error, receivedResponse)) releaseWriteRequestId(requestKey, requestId);
      throw error;
    }
  },
  async deleteStyleReference(id) {
    return this.remove(`/api/style-references/${id}`);
  },
  async directorChat(body) {
    return this.create("/api/agents/codex-ppt-director/chat", body);
  },
  async workflowJob(id) {
    const response = await fetch(`/api/workflow-jobs/${id}`, { cache: "no-store" });
    return readJson(response);
  },
  async workflowDeliveryStatus(id, signal) {
    const response = await fetch(`/api/workflow-jobs/${id}/delivery-status`, { cache: "no-store", signal });
    return readJson(response);
  },
  async workflowCompliance(id, signal) {
    const response = await fetch(`/api/workflow-jobs/${id}/compliance`, { cache: "no-store", signal });
    return readJson(response);
  },
  async workflowCostEstimate(id, signal) {
    const response = await fetch(`/api/workflow-jobs/${id}/cost-estimate`, { cache: "no-store", signal });
    return readJson(response);
  },
  async workflowAuthorizations(id, signal) {
    const response = await fetch(`/api/workflow-jobs/${id}/authorizations`, { cache: "no-store", signal });
    return readJson(response);
  },
  async authorizeExternalImageSpend(id, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/authorizations/external-image-spend`, body);
  },
  async workflowV1Readiness(id, signal) {
    const response = await fetch(`/api/workflow-jobs/${id}/v1-readiness`, { cache: "no-store", signal });
    return readJson(response);
  },
  async latestV1Acceptance(signal) {
    const response = await fetch("/api/v1-acceptance", { cache: "no-store", signal });
    return readJson(response);
  },
  async v1AcceptanceRunStatus(signal) {
    const response = await fetch("/api/v1-acceptance/run", { cache: "no-store", signal });
    return readJson(response);
  },
  async preflightV1AcceptanceRun(body = {}) {
    return this.create("/api/v1-acceptance/preflight", body);
  },
  async startV1AcceptanceRun(body = {}) {
    return this.create("/api/v1-acceptance/run", body);
  },
  async runProductVisualReadiness(body = {}) {
    return this.create("/api/v1-acceptance/product-visual-readiness", body);
  },
  async preflightProductVisualSample(body = {}) {
    return this.create("/api/v1-acceptance/product-visual-sample/preflight", body);
  },
  async preflightProductVisualFullDeck(body = {}) {
    return this.create("/api/v1-acceptance/product-visual-full-deck/preflight", body);
  },
  async previewProductVisualSamplePrompt(body = {}) {
    return this.create("/api/v1-acceptance/product-visual-sample/prompt-preview", body);
  },
  async runProductVisualSample(body = {}) {
    return this.create("/api/v1-acceptance/product-visual-sample/run", body);
  },
  async preflightProductVisualSampleApproval(body = {}) {
    return this.create("/api/v1-acceptance/product-visual-sample/approval/preflight", body);
  },
  async approveProductVisualSample(body = {}) {
    return this.create("/api/v1-acceptance/product-visual-sample/approval/approve", body);
  },
  async preflightProductVisualFullDeckApproval(body = {}) {
    return this.create("/api/v1-acceptance/product-visual-full-deck/approval/preflight", body);
  },
  async approveProductVisualFullDeck(body = {}) {
    return this.create("/api/v1-acceptance/product-visual-full-deck/approval/approve", body);
  },
  async runProductVisualFullDeck(body = {}) {
    return this.create("/api/v1-acceptance/product-visual-full-deck/run", body);
  },
  async approveCodexPptGate(id, gate, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/codex-ppt/approvals/${gate}/approve`, body);
  },
  async preflightCodexPptGate(id, gate, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/codex-ppt/approvals/${gate}/preflight`, body);
  },
  async resetCodexPptGate(id, gate, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/codex-ppt/approvals/${gate}/reset`, body);
  },
  async planWorkflowOutline(body = {}) {
    return this.create("/api/workflow-outline/plan", body);
  },
  async recordCodexPptOutline(id, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/codex-ppt/outline`, body);
  },
  async recordCodexPptStyle(id, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/codex-ppt/style`, body);
  },
  async recordCodexPptBackend(id, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/codex-ppt/backend`, body);
  },
  async recordCodexPptInformationAssets(id, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/codex-ppt/information-assets`, body);
  },
  async refreshCodexPptBackendApproval(id, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/codex-ppt/backend/refresh-approval`, body);
  },
  async codexPptSlideTasks(id) {
    const response = await fetch(`/api/workflow-jobs/${id}/codex-ppt/slide-tasks`, { cache: "no-store" });
    return readJson(response);
  },
  async syncCodexPptSlideTasks(id, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/codex-ppt/slide-tasks/sync`, body);
  },
  async runCodexPptSlideBatch(id, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/codex-ppt/slide-tasks/run-batch`, body);
  },
  async codexPptSlideBatchPreflight(id, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/codex-ppt/slide-tasks/run-batch/preflight`, body);
  },
  async resetNonProductCodexPptSlides(id, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/codex-ppt/slide-tasks/reset-non-product`, body);
  },
  async codexPptSlideTaskAction(id, pageId, action, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/codex-ppt/slide-tasks/${pageId}/${action}`, body);
  },
  async workflowArtifacts(id, signal) {
    const response = await fetch(`/api/workflow-jobs/${id}/artifacts`, { cache: "no-store", signal });
    return readJson(response);
  },
  async markWorkflowPageReview(id, pageId, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/review/pages/${encodeURIComponent(pageId)}`, body);
  },
  async markImageDeckReviewPage(id, pageId, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/image-deck/review/pages/${encodeURIComponent(pageId)}`, body);
  },
  async markImageDeckReviewPagesForRerun(id, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/image-deck/review/rerun-pages`, body);
  },
  async approveImageDeckReview(id, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/image-deck/review/approve`, body);
  },
  async correctWorkflowOcrTextHint(id, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/ocr/text-hints/correct`, body);
  },
  async workflowEvents(id, params = {}, signal) {
    const query = new URLSearchParams();
    if (params.limit) query.set("limit", String(params.limit));
    if (params.after) query.set("after", String(params.after));
    const suffix = query.toString() ? `?${query.toString()}` : "";
    const response = await fetch(`/api/workflow-jobs/${id}/events${suffix}`, { cache: "no-store", signal });
    return readJson(response);
  },
  async workflowJobs(options = {}, signal) {
    let actualOptions = options || {};
    let actualSignal = signal;
    if (actualOptions && typeof actualOptions === "object" && "aborted" in actualOptions) {
      actualSignal = actualOptions;
      actualOptions = {};
    }
    const query = new URLSearchParams();
    if (actualOptions.includeArchived) query.set("includeArchived", "1");
    if (actualOptions.includeInternal) query.set("includeInternal", "1");
    if (Number.isFinite(Number(actualOptions.limit))) query.set("limit", String(Math.max(1, Number(actualOptions.limit))));
    if (Number.isFinite(Number(actualOptions.offset)) && Number(actualOptions.offset) > 0) query.set("offset", String(Math.max(0, Number(actualOptions.offset))));
    const suffix = query.toString() ? `?${query.toString()}` : "";
    const response = await fetch(`/api/workflow-jobs${suffix}`, { cache: "no-store", signal: actualSignal });
    return readJson(response);
  },
  async workflowJobsMeta(signal) {
    const response = await fetch("/api/workflow-jobs/meta", { cache: "no-store", signal });
    return readJson(response);
  },
  async createWorkflowJob(body) {
    return this.create("/api/workflow-jobs", body);
  },
  async workflowAction(id, action, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/${action}`, body);
  },
  async workflowNextAction(id, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/next`, body);
  },
  async workflowNextActionPreflight(id, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/next/preflight`, body);
  },
  async workflowContinuationPreflight(id, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/continue-remaining/preflight`, body);
  },
  async workflowContinueRemaining(id, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/continue-remaining`, body);
  },
  async archiveWorkflowJob(id, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/archive`, body);
  },
  async restoreWorkflowJob(id, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/restore`, body);
  },
  async previewWorkflowCleanup(options = {}, signal) {
    const query = new URLSearchParams();
    if (options.categories) query.set("categories", Array.isArray(options.categories) ? options.categories.join(",") : String(options.categories));
    if (options.includeArchived) query.set("includeArchived", "1");
    if (options.olderThanHours) query.set("olderThanHours", String(options.olderThanHours));
    if (options.limit) query.set("limit", String(options.limit));
    const suffix = query.toString() ? `?${query.toString()}` : "";
    const response = await fetch(`/api/workflow-jobs/cleanup/preview${suffix}`, { cache: "no-store", signal });
    return readJson(response);
  },
  async archiveWorkflowCleanup(body = {}) {
    return this.create("/api/workflow-jobs/cleanup/archive", body);
  },
  async workflowEditableStatus(id) {
    const response = await fetch(`/api/workflow-jobs/${id}/editable/status`, { cache: "no-store" });
    return readJson(response);
  },
  async workflowEditablePreparePreflight(id, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/editable/prepare/preflight`, body);
  },
  async workflowEditablePrompts(id) {
    const response = await fetch(`/api/workflow-jobs/${id}/editable/prompts`, { cache: "no-store" });
    return readJson(response);
  },
  async workflowWorkerTasks(id) {
    const response = await fetch(`/api/workflow-jobs/${id}/editable/worker-tasks`, { cache: "no-store" });
    return readJson(response);
  },
  async workflowWorkerBriefs(id) {
    const response = await fetch(`/api/workflow-jobs/${id}/editable/worker-briefs`, { cache: "no-store" });
    return readJson(response);
  },
  async buildWorkflowWorkerBriefs(id, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/editable/worker-briefs`, body);
  },
  async workflowWorkerRuns(id, signal) {
    const response = await fetch(`/api/workflow-jobs/${id}/editable/worker-runs`, { cache: "no-store", signal });
    return readJson(response);
  },
  async workflowWorkerBatchPreflight(id, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/editable/worker-runs/preflight`, body);
  },
  async probeWorkflowPageSpecProvider(id, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/editable/page-spec-provider/probe`, body);
  },
  async startWorkflowWorkerBatch(id, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/editable/worker-runs`, body);
  },
  async syncWorkflowWorkerTasks(id) {
    return this.create(`/api/workflow-jobs/${id}/editable/worker-tasks/sync`, {});
  },
  async refreshWorkflowEditableRun(id, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/editable/fresh-run-recovery`, body);
  },
  async finalizeWorkflowEditableRun(id, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/editable/finalize`, body);
  },
  async workflowWorkerTaskAction(id, pageId, action, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/editable/worker-tasks/${pageId}/${action}`, body);
  },
  async retryWorkflowPage(id, pageId, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/pages/${pageId}/retry`, body);
  },
  async visualQualityRetryPreflight(id, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/visual-quality/retry-preflight`, body);
  },
  async finalVisualQaRetryPreflight(id, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/final-visual-qa/retry-preflight`, body);
  },
  async retryFinalVisualQaPages(id, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/final-visual-qa/retry`, body);
  },
  async approveWorkflowVisualQualityReview(id, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/visual-quality/review/approve`, body);
  },
  async retryFailedWorkflowPages(id, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/pages/retry-failed`, body);
  },
  async retryStaleWorkflowPageEvidence(id, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/pages/retry-stale-evidence`, body);
  },
  async approveWorkflowManualReview(id, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/review/approve`, body);
  },
  async resetWorkflowManualReview(id, body = {}) {
    return this.create(`/api/workflow-jobs/${id}/review/reset`, body);
  }
};

async function readJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const workflowErrors = Array.isArray(data.errors) ? data.errors : [];
    const latestWorkflowError = workflowErrors[workflowErrors.length - 1] || null;
    const failedStage = Object.values(data.stages || {}).find((stage) => stage?.status === "failed") || null;
    const error = new Error(data.error || latestWorkflowError?.message || failedStage?.message || "请求失败");
    error.data = data;
    error.status = response.status;
    error.code = data.code || latestWorkflowError?.details?.code || failedStage?.details?.code || "";
    throw error;
  }
  return data;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const externalSignal = options.signal;
  const abortFromCaller = () => controller.abort(externalSignal?.reason || "caller-aborted");
  if (externalSignal?.aborted) abortFromCaller();
  else externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = window.setTimeout(() => controller.abort("request-timeout"), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted && !externalSignal?.aborted) {
      const timeoutError = new Error("本地服务响应超时，请刷新任务状态后再决定是否重试。");
      timeoutError.code = "REQUEST_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromCaller);
  }
}

const pendingWriteRequestIds = new Map();

function writeRequestKey(method, path, body) {
  return `${method}:${path}:${JSON.stringify(body ?? null)}`;
}

function fileFingerprint(file) {
  return { name: file?.name || "", size: Number(file?.size || 0), type: file?.type || "", lastModified: Number(file?.lastModified || 0) };
}

function getOrCreateWriteRequestId(key) {
  const existing = pendingWriteRequestIds.get(key);
  if (existing && existing.expiresAt > Date.now()) return existing.id;
  const persisted = readPersistedWriteRequestId(key);
  if (persisted) {
    pendingWriteRequestIds.set(key, persisted);
    return persisted.id;
  }
  const id = createRequestId();
  const entry = { id, expiresAt: Date.now() + 24 * 60 * 60 * 1000 };
  pendingWriteRequestIds.set(key, entry);
  persistWriteRequestId(key, entry);
  return id;
}

function releaseWriteRequestId(key, id) {
  if (pendingWriteRequestIds.get(key)?.id === id) {
    pendingWriteRequestIds.delete(key);
    removePersistedWriteRequestId(key, id);
  }
}

function shouldRetainWriteRequestId(error, receivedResponse) {
  const code = String(error?.code || error?.data?.code || "");
  return !receivedResponse || ["REQUEST_IN_PROGRESS", "REQUEST_RECOVERY_REQUIRED", "REQUEST_RESULT_UNAVAILABLE", "REQUEST_MANUAL_RECONCILIATION_REQUIRED"].includes(code);
}

function writeRequestHeaders(key, id) {
  const entry = pendingWriteRequestIds.get(key) || readPersistedWriteRequestId(key);
  return {
    "X-PPT-Agent-Request-Id": id,
    ...(entry?.recoverPending ? { "X-PPT-Agent-Recover-Pending": "1" } : {})
  };
}

function markWriteRequestRecoveryRequired(key, id, error) {
  const code = String(error?.code || error?.data?.code || "");
  if (code !== "REQUEST_RECOVERY_REQUIRED") return;
  const current = pendingWriteRequestIds.get(key);
  if (!current || current.id !== id) return;
  const entry = { ...current, recoverPending: true };
  pendingWriteRequestIds.set(key, entry);
  persistWriteRequestId(key, entry);
}

function writeRequestStorageKey(key) {
  let first = 2166136261;
  let second = 2246822519;
  for (let index = 0; index < key.length; index += 1) {
    const code = key.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ code, 3266489917);
  }
  return `ppt-agent-write-request:${(first >>> 0).toString(16)}${(second >>> 0).toString(16)}`;
}

function readPersistedWriteRequestId(key) {
  try {
    const storageKey = writeRequestStorageKey(key);
    const entry = JSON.parse(globalThis.localStorage?.getItem(storageKey) || "null");
    if (!entry?.id || Number(entry.expiresAt || 0) <= Date.now()) {
      globalThis.localStorage?.removeItem(storageKey);
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

function persistWriteRequestId(key, entry) {
  try {
    globalThis.localStorage?.setItem(writeRequestStorageKey(key), JSON.stringify(entry));
  } catch {}
}

function removePersistedWriteRequestId(key, id) {
  try {
    const storageKey = writeRequestStorageKey(key);
    const entry = JSON.parse(globalThis.localStorage?.getItem(storageKey) || "null");
    if (!entry?.id || entry.id === id) globalThis.localStorage?.removeItem(storageKey);
  } catch {}
}

function createRequestId() {
  return globalThis.crypto?.randomUUID?.() || `ppt-agent-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function getErrorMessage(error) {
  const code = String(error?.code || error?.data?.code || "");
  if (code === "REQUEST_TIMEOUT") return "本地服务响应超时。任务可能已经启动，请先刷新状态，确认后再重试。";
  if (code === "EDITABLE_WORKER_CONFIRM_LOST_REQUIRED") return "页面 worker 仍处于活动状态。请先确认该 worker 已停止，再执行重置。";
  if (["REQUEST_ID_CONFLICT", "REQUEST_IN_PROGRESS", "REQUEST_RESULT_UNAVAILABLE", "REQUEST_RECOVERY_REQUIRED"].includes(code)) return "这次操作可能已经执行，请先刷新任务状态；确认后再重试。";
  if (code === "REQUEST_MANUAL_RECONCILIATION_REQUIRED") return "上次写操作的结果不确定。为避免重复生成或重复扣额度，系统已停止自动重放；请先核对当前任务状态。";
  if (["IMAGE_DECK_VISUAL_QUALITY_REQUIRED", "IMAGE_DECK_VISUAL_QUALITY_INVALID", "IMAGE_DECK_VISUAL_QUALITY_STALE"].includes(code)) {
    return "当前图片页的本地质量检查尚未就绪，请稍后再试；系统会自动刷新，不会调用图片 API。";
  }
  if (["IMAGE_DECK_TEXT_QUALITY_REQUIRED", "IMAGE_DECK_SEMANTIC_QUALITY_BLOCKED"].includes(code)) {
    const pages = error?.data?.pages || error?.pages || [];
    return `${pages.length ? `第 ${pages.map((page) => Number(String(page).match(/\d+/)?.[0] || page)).join("、")} 页` : "当前图片页"}存在文字、数据、页码或页面角色问题，请先重做阻断页。`;
  }
  if (code === "IMAGE_DECK_RERUN_CONFIRMATION_REQUIRED") {
    return "重做页面会让所选页的后续结果失效，请先确认页码和影响范围。其他已成功页面会保留。";
  }
  if (code === "EXTERNAL_IMAGE_AUTHORIZATION_REQUIRED") {
    return "本次图片 API 授权缺失、已过期或已使用。请核对页码和预计调用量后重新确认。";
  }
  if (code === "OCR_TEXT_HINTS_REQUIRED") {
    return "样张页的源稿文字证据尚未准备完成，系统会自动补齐后再生成，不会额外消耗图片额度。";
  }
  if (code === "EDITABLE_PREPARE_REFRESH_REQUIRED") {
    return "部分图片页已经更新，请先刷新可编辑运行，再重建这些页面；其他已成功页面会保留。";
  }
  const message = error?.message || String(error || "");
  if (/Failed to fetch|fetch failed|NetworkError|Load failed/i.test(message)) {
    return "本地服务连接失败，请刷新页面或确认服务已启动。";
  }
  if (/abort/i.test(message)) return "本地服务响应超时，请稍后重试。";
  return message || "请求失败，请稍后重试。";
}

export function isConnectionError(message = "") {
  return /Failed to fetch|fetch failed|NetworkError|Load failed|本地服务连接失败|本地服务响应超时/i.test(message);
}
