import { getProviderConfig } from "./providers.js";
import { readWorkflowJob, saveWorkflowJob } from "./workflowJobs.js";
import { getWorkflowCostEstimate } from "./workflowCostEstimate.js";

const AUTHORIZATION_LIMIT = 50;
const AUTHORIZATION_TTL_MS = 30 * 60 * 1000;
const AUTHORIZATION_JOB_LOCKS = new Map();

export async function listWorkflowAuthorizations(jobId) {
  const job = await readWorkflowJob(jobId);
  const externalImageSpend = getExternalImageAuthorizations(job);
  return {
    ok: true,
    jobId,
    externalImageSpend,
    summary: summarizeExternalImageSpend(externalImageSpend)
  };
}

export function getExternalImageAuthorizationStatus(job = {}, options = {}) {
  const scope = normalizeScope(options.scope || "visual-sample");
  const requiredCalls = normalizeImageCalls(options.imageCalls || defaultImageCallsForScope(scope));
  const requestedPages = normalizeAuthorizationPages(options.pages || options.pageNumbers || options.pageSelection || options.pageIds || "");
  const requestedPageSelection = cleanString(options.pageSelection || options.pageIds || options.pages || options.pageNumbers || "");
  const provider = getProviderConfig().image || {};
  const records = getExternalImageAuthorizations(job)
    .filter((record) => authorizationIsAvailable(record))
    .filter((record) => normalizeScope(record.scope) === scope)
    .filter((record) => normalizeImageCalls(record.imageCalls) >= requiredCalls)
    .filter((record) => authorizationCoversPages(record, requestedPages))
    .filter((record) => providerMatches(record, provider));
  const latest = records.at(-1) || null;
  return {
    required: true,
    persisted: Boolean(latest),
    scope,
    imageCalls: requiredCalls,
    pageSelection: requestedPageSelection,
    pages: requestedPages,
    latest,
    provider: {
      configured: Boolean(provider.configured),
      enabled: Boolean(provider.enabled),
      baseUrl: provider.baseUrl || "",
      model: provider.model || ""
    },
    warning: latest ? "" : `No persisted external image spend authorization found for ${scope}${requestedPages.length ? ` pages ${requestedPages.join(",")}` : ""}.`
  };
}

export async function consumeExternalImageSpendAuthorization(jobId, options = {}) {
  return withAuthorizationJobLock(jobId, () => consumeExternalImageSpendAuthorizationUnlocked(jobId, options));
}

async function consumeExternalImageSpendAuthorizationUnlocked(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const status = getExternalImageAuthorizationStatus(job, options);
  const authorization = status.latest;
  if (!authorization?.id) {
    const error = new Error(status.warning || "No matching external image spend authorization is available.");
    error.status = 409;
    error.code = "EXTERNAL_IMAGE_AUTHORIZATION_REQUIRED";
    throw error;
  }
  const consumedAt = new Date().toISOString();
  const consumedBy = cleanString(options.consumedBy || options.requestedBy || options.runId || "workflow-run");
  const externalImageSpend = getExternalImageAuthorizations(job).map((record) => (
    record.id === authorization.id
      ? {
        ...record,
        consumedAt,
        consumedBy,
        consumedRunId: cleanString(options.runId || ""),
        consumedPageSelection: cleanString(options.pageSelection || options.pages || options.pageIds || ""),
        consumedPages: normalizeAuthorizationPages(options.pages || options.pageNumbers || options.pageSelection || options.pageIds || ""),
        consumedImageCalls: normalizeImageCalls(options.imageCalls || status.imageCalls)
      }
      : record
  ));
  job.artifacts = {
    ...(job.artifacts || {}),
    externalImageSpendAuthorizations: externalImageSpend
  };
  job.events = appendEvent(job.events, {
    type: "authorization.external_image_spend_consumed",
    message: `Consumed ${status.imageCalls} external image API call authorization(s) for ${status.scope}`,
    details: {
      authorizationId: authorization.id,
      scope: status.scope,
      imageCalls: status.imageCalls,
      pageSelection: cleanString(options.pageSelection || options.pages || options.pageIds || ""),
      pages: status.pages,
      consumedBy
    },
    createdAt: consumedAt
  });
  const saved = await saveWorkflowJob(job);
  return { ok: true, job: saved, authorization: externalImageSpend.find((record) => record.id === authorization.id) };
}

export async function authorizeExternalImageSpend(jobId, options = {}) {
  return withAuthorizationJobLock(jobId, () => authorizeExternalImageSpendUnlocked(jobId, options));
}

async function authorizeExternalImageSpendUnlocked(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const record = buildExternalImageSpendAuthorization(options);
  await assertPredictableSpendBudget(jobId, job, record);
  const externalImageSpend = [...getExternalImageAuthorizations(job), record].slice(-AUTHORIZATION_LIMIT);
  job.artifacts = {
    ...(job.artifacts || {}),
    externalImageSpendAuthorizations: externalImageSpend
  };
  job.events = appendEvent(job.events, {
    type: "authorization.external_image_spend",
    message: `Authorized ${record.imageCalls} external image API call(s) for ${record.scope}`,
    details: {
      authorizationId: record.id,
      scope: record.scope,
      imageCalls: record.imageCalls,
      pageSelection: record.pageSelection,
      pages: record.pages,
      provider: record.provider,
      baseUrl: record.baseUrl,
      model: record.model,
      confirmedBy: record.confirmedBy
    },
    createdAt: record.confirmedAt
  });
  const saved = await saveWorkflowJob(job);
  return {
    ok: true,
    job: saved,
    authorization: record,
    summary: summarizeExternalImageSpend(externalImageSpend)
  };
}

async function assertPredictableSpendBudget(jobId, job = {}, requested = {}) {
  const policy = job.constraints?.spendBudget || {};
  if (policy.enforcePredictableCost !== true) return;
  const estimate = await getWorkflowCostEstimate(jobId);
  if (!estimate.pricingConfigured || !estimate.budget?.ready) {
    const error = new Error("付费授权已停止：当前任务尚未形成完整、未超上限的费用报价。请先配置模型单价并刷新费用预估。");
    error.status = 409;
    error.code = "PREDICTABLE_COST_BUDGET_REQUIRED";
    error.details = { budget: estimate.budget, unknownCostItems: estimate.unknownCostItems };
    throw error;
  }
  const callBudget = evaluatePredictableImageCallBudget(policy, getExternalImageAuthorizations(job), requested);
  if (!callBudget.ready) {
    const error = new Error(`付费授权已停止：累计图片调用将达到 ${callBudget.projectedCalls} 次，超过任务上限 ${callBudget.maxImageCalls} 次。`);
    error.status = 409;
    error.code = "PREDICTABLE_COST_IMAGE_CALL_LIMIT";
    error.details = callBudget;
    throw error;
  }
}

export function evaluatePredictableImageCallBudget(policy = {}, records = [], requested = {}, now = Date.now()) {
  const consumedCalls = records.reduce((sum, item) => sum + (cleanString(item.consumedAt) ? normalizeImageCalls(item.consumedImageCalls || item.imageCalls) : 0), 0);
  const reservedCalls = records.reduce((sum, item) => {
    if (cleanString(item.consumedAt)) return sum;
    const expiresAt = Date.parse(item.expiresAt || "");
    return sum + (Number.isFinite(expiresAt) && expiresAt > now ? normalizeImageCalls(item.imageCalls) : 0);
  }, 0);
  const requestedCalls = normalizeImageCalls(requested.imageCalls);
  const maxImageCalls = normalizeImageCalls(policy.maxImageCalls);
  const projectedCalls = consumedCalls + reservedCalls + requestedCalls;
  return {
    ready: maxImageCalls > 0 && projectedCalls <= maxImageCalls,
    consumedCalls,
    reservedCalls,
    requestedCalls,
    projectedCalls,
    maxImageCalls
  };
}

function buildExternalImageSpendAuthorization(options = {}) {
  const provider = getProviderConfig().image || {};
  const scope = normalizeScope(options.scope || options.target || "visual-sample");
  const confirmedAt = new Date().toISOString();
  return {
    id: `auth_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    kind: "external_image_spend_authorization",
    scope,
    imageCalls: normalizeImageCalls(options.imageCalls || defaultImageCallsForScope(scope)),
    pageSelection: cleanString(options.pageSelection || options.pages || ""),
    pages: normalizeAuthorizationPages(options.pages || options.pageNumbers || options.pageSelection || ""),
    targetPages: normalizeImageCalls(options.targetPages || options.imageCalls || defaultImageCallsForScope(scope)),
    mode: cleanString(options.mode || options.targetMode || ""),
    provider: provider.provider || "openai-compatible-image",
    baseUrl: provider.baseUrl || "",
    model: provider.model || "",
    configured: Boolean(provider.configured),
    enabled: Boolean(provider.enabled),
    confirmedBy: cleanString(options.confirmedBy || options.requestedBy || "local-user"),
    reason: cleanString(options.reason || ""),
    confirmedAt,
    expiresAt: new Date(Date.parse(confirmedAt) + AUTHORIZATION_TTL_MS).toISOString(),
    consumedAt: "",
    consumedBy: "",
    consumedRunId: ""
  };
}

function summarizeExternalImageSpend(records = []) {
  const totalImageCalls = records.reduce((sum, record) => sum + normalizeImageCalls(record.imageCalls), 0);
  const latest = records.at(-1) || null;
  return {
    count: records.length,
    totalImageCalls,
    latest
  };
}

function getExternalImageAuthorizations(job = {}) {
  const records = job.artifacts?.externalImageSpendAuthorizations;
  return Array.isArray(records) ? records : [];
}

function authorizationIsAvailable(record = {}) {
  if (cleanString(record.consumedAt || "")) return false;
  const confirmedAt = Date.parse(record.confirmedAt || "");
  const expiresAt = Date.parse(record.expiresAt || "") || (Number.isFinite(confirmedAt) ? confirmedAt + AUTHORIZATION_TTL_MS : 0);
  return Boolean(expiresAt && expiresAt > Date.now());
}

function normalizeScope(value = "") {
  const raw = cleanString(value).toLowerCase();
  if (["sample", "visual-sample", "visual_sample", "codex-sample"].includes(raw)) return "visual-sample";
  if (["full", "fulldeck", "full-deck", "visual-deck", "codex-full-deck"].includes(raw)) return "full-deck";
  if (["editable", "editable-workers", "page-workers"].includes(raw)) return "editable-workers";
  return raw || "visual-sample";
}

function defaultImageCallsForScope(scope = "") {
  if (scope === "visual-sample") return 1;
  return 0;
}

function normalizeImageCalls(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(500, Math.round(number)));
}

function normalizePages(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => Number(item))
      .filter((item) => Number.isInteger(item) && item > 0)
      .slice(0, 50);
  }
  const raw = cleanString(value || "");
  if (!raw) return [];
  const pages = [];
  for (const token of raw.split(/[,\s，、;；]+/).map((item) => item.trim()).filter(Boolean)) {
    const range = token.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (Number.isInteger(start) && Number.isInteger(end) && start > 0 && end >= start) {
        for (let page = start; page <= end && pages.length < 50; page += 1) pages.push(page);
      }
      continue;
    }
    const page = Number(token);
    if (Number.isInteger(page) && page > 0) pages.push(page);
  }
  return [...new Set(pages)].slice(0, 50);
}

function normalizeAuthorizationPages(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.flatMap((item) => normalizeAuthorizationPages(item)))].slice(0, 50);
  }
  const raw = cleanString(value || "");
  if (!raw) return [];
  const pages = [];
  for (const token of raw.split(/[,;\s]+/).map((item) => item.trim()).filter(Boolean)) {
    const range = token.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (Number.isInteger(start) && Number.isInteger(end) && start > 0 && end >= start) {
        for (let page = start; page <= end && pages.length < 50; page += 1) pages.push(page);
      }
      continue;
    }
    const page = parsePageReference(token);
    if (page) pages.push(page);
  }
  return [...new Set(pages)].slice(0, 50);
}

function parsePageReference(value = "") {
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 ? value : 0;
  }
  const raw = cleanString(value || "").toLowerCase();
  if (/^\d+$/.test(raw)) return Number(raw);
  const pageId = raw.match(/^page[_-]?0*(\d+)$/);
  if (pageId) return Number(pageId[1]);
  return 0;
}

function authorizationCoversPages(record = {}, requestedPages = []) {
  const requested = Array.isArray(requestedPages)
    ? requestedPages.filter((page) => Number.isInteger(page) && page > 0)
    : [];
  if (!requested.length) return true;
  const authorized = normalizeAuthorizationPages(record.pages || record.pageNumbers || record.pageSelection || "");
  if (!authorized.length) return false;
  const authorizedSet = new Set(authorized);
  return requested.every((page) => authorizedSet.has(page));
}

function providerMatches(record = {}, provider = {}) {
  const recordModel = cleanString(record.model || "");
  const providerModel = cleanString(provider.model || "");
  const recordBaseUrl = cleanString(record.baseUrl || "").replace(/\/+$/, "");
  const providerBaseUrl = cleanString(provider.baseUrl || "").replace(/\/+$/, "");
  return Boolean(recordModel && providerModel && recordModel === providerModel && recordBaseUrl && providerBaseUrl && recordBaseUrl === providerBaseUrl);
}

function appendEvent(events = [], event) {
  return [...(Array.isArray(events) ? events : []), {
    id: `evt_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    ...event
  }].slice(-500);
}

async function withAuthorizationJobLock(jobId, operation) {
  const key = cleanString(jobId);
  const previous = AUTHORIZATION_JOB_LOCKS.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  AUTHORIZATION_JOB_LOCKS.set(key, current);
  await previous.catch(() => null);
  try {
    return await operation();
  } finally {
    release();
    if (AUTHORIZATION_JOB_LOCKS.get(key) === current) AUTHORIZATION_JOB_LOCKS.delete(key);
  }
}

function cleanString(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 1000);
}
