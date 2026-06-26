import { getProviderConfig } from "./providers.js";
import { readWorkflowJob, saveWorkflowJob } from "./workflowJobs.js";

const AUTHORIZATION_LIMIT = 50;

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

export async function authorizeExternalImageSpend(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const record = buildExternalImageSpendAuthorization(options);
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

function buildExternalImageSpendAuthorization(options = {}) {
  const provider = getProviderConfig().image || {};
  const scope = normalizeScope(options.scope || options.target || "visual-sample");
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
    confirmedAt: new Date().toISOString()
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

function cleanString(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 1000);
}
