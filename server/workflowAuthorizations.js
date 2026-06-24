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
  const provider = getProviderConfig().image || {};
  const records = getExternalImageAuthorizations(job)
    .filter((record) => normalizeScope(record.scope) === scope)
    .filter((record) => normalizeImageCalls(record.imageCalls) >= requiredCalls)
    .filter((record) => providerMatches(record, provider));
  const latest = records.at(-1) || null;
  return {
    required: true,
    persisted: Boolean(latest),
    scope,
    imageCalls: requiredCalls,
    latest,
    provider: {
      configured: Boolean(provider.configured),
      enabled: Boolean(provider.enabled),
      baseUrl: provider.baseUrl || "",
      model: provider.model || ""
    },
    warning: latest ? "" : `No persisted external image spend authorization found for ${scope}.`
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
