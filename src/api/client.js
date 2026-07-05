export const api = {
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
  async remove(path) {
    const response = await fetch(path, { method: "DELETE" });
    return readJson(response);
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
    const response = await fetch("/api/style-references", { method: "POST", body: form });
    return readJson(response);
  },
  async deleteStyleReference(id) {
    const response = await fetch(`/api/style-references/${id}`, { method: "DELETE" });
    return readJson(response);
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
    const suffix = query.toString() ? `?${query.toString()}` : "";
    const response = await fetch(`/api/workflow-jobs${suffix}`, { cache: "no-store", signal: actualSignal });
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
    const error = new Error(data.error || "请求失败");
    error.data = data;
    error.status = response.status;
    error.code = data.code || "";
    throw error;
  }
  return data;
}

export function getErrorMessage(error) {
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
