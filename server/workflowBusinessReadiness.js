import fs from "node:fs/promises";
import path from "node:path";
import { rootDir } from "./store.js";
import { getWorkflowDeliveryStatus } from "./workflowDelivery.js";
import { listWorkflowJobSummaries, readWorkflowJob, WORKFLOW_BUSINESS_POLICY_VERSION } from "./workflowJobs.js";

const DEFAULT_THRESHOLDS = Object.freeze({
  minimumTasks: 20,
  minimumMaterialTypes: 4,
  minimumSuccessRate: 0.9,
  minimumPredictableBudgetRate: 1,
  maximumAverageRecoveryEvents: 0.5
});
const CACHE_PATH = path.join(rootDir, "workspace", ".business-readiness-cache-v1.json");
let readinessSingleFlight = null;

export async function getWorkflowBusinessReadiness(options = {}) {
  if (readinessSingleFlight) return readinessSingleFlight;
  const run = evaluateWorkflowBusinessReadiness(options);
  readinessSingleFlight = run;
  try {
    return await run;
  } finally {
    if (readinessSingleFlight === run) readinessSingleFlight = null;
  }
}

async function evaluateWorkflowBusinessReadiness(options = {}) {
  const startedAtMs = Date.now();
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds || {}) };
  const policyVersion = String(options.policyVersion || WORKFLOW_BUSINESS_POLICY_VERSION);
  const limit = clampInteger(options.limit, 1, 100, 50);
  const allSummaries = await listWorkflowJobSummaries();
  const eligibleSummaries = allSummaries.filter((job) => !job.internal && !job.lifecycle?.archivedAt);
  const cohortSummaries = eligibleSummaries
    .filter((job) => job.businessReadiness?.policyVersion === policyVersion)
    .slice(0, limit);
  const cache = await readCache();
  const nextCacheTasks = { ...(cache.tasks || {}) };
  let cacheHits = 0;
  let cacheMisses = 0;
  const evaluated = await mapWithConcurrency(cohortSummaries, 4, async (summary) => {
    const cached = nextCacheTasks[summary.id];
    if (cached?.updatedAt === summary.updatedAt && cached?.policyVersion === policyVersion && cached?.result) {
      cacheHits += 1;
      return { ...cached.result, cacheHit: true };
    }
    cacheMisses += 1;
    const result = await evaluateBusinessTask(summary, policyVersion);
    nextCacheTasks[summary.id] = {
      updatedAt: summary.updatedAt,
      policyVersion,
      result
    };
    return { ...result, cacheHit: false };
  });
  if (cacheMisses) {
    await writeCache({ version: 1, updatedAt: new Date().toISOString(), tasks: nextCacheTasks }).catch(() => {});
  }
  const readyTasks = evaluated.filter((item) => item.ready);
  const materialTypes = [...new Set(evaluated.map((item) => item.materialType))];
  const successRate = ratio(readyTasks.length, evaluated.length);
  const predictableBudgetRate = ratio(evaluated.filter((item) => item.predictableBudget).length, evaluated.length);
  const averageRecoveryEvents = readyTasks.length
    ? round(readyTasks.reduce((sum, item) => sum + item.recoveryEvents, 0) / readyTasks.length)
    : null;
  const checks = [
    makeCheck("task-volume", evaluated.length >= thresholds.minimumTasks, evaluated.length, thresholds.minimumTasks, "当前策略真实任务数量"),
    makeCheck("material-diversity", materialTypes.length >= thresholds.minimumMaterialTypes, materialTypes.length, thresholds.minimumMaterialTypes, "当前策略材料类型覆盖"),
    makeCheck("delivery-success-rate", successRate >= thresholds.minimumSuccessRate, successRate, thresholds.minimumSuccessRate, "当前策略完整交付成功率"),
    makeCheck("predictable-budget-rate", predictableBudgetRate >= thresholds.minimumPredictableBudgetRate, predictableBudgetRate, thresholds.minimumPredictableBudgetRate, "当前策略可预测预算覆盖率"),
    makeCheck("recovery-rate", averageRecoveryEvents !== null && averageRecoveryEvents <= thresholds.maximumAverageRecoveryEvents, averageRecoveryEvents, thresholds.maximumAverageRecoveryEvents, "成功任务平均独立恢复次数", "max")
  ];
  const ready = checks.every((check) => check.pass);
  return {
    ok: true,
    version: 2,
    ready,
    verdict: ready ? "repeatable-business-capability" : "engineering-capability-only",
    cohort: {
      policyVersion,
      eligibleTasks: eligibleSummaries.length,
      evaluatedTasks: evaluated.length,
      legacyTasksExcluded: eligibleSummaries.length - cohortSummaries.length,
      rule: "Only real, non-internal, non-archived tasks enrolled in the current product policy are evaluated."
    },
    thresholds,
    metrics: {
      evaluatedTasks: evaluated.length,
      readyTasks: readyTasks.length,
      materialTypes,
      materialTypeCount: materialTypes.length,
      successRate,
      predictableBudgetRate,
      averageRecoveryEvents
    },
    checks,
    blockers: checks.filter((check) => !check.pass).map((check) => check.id),
    tasks: evaluated,
    performance: {
      durationMs: Date.now() - startedAtMs,
      cacheHits,
      cacheMisses,
      scannedSummaries: allSummaries.length
    },
    updatedAt: new Date().toISOString()
  };
}

async function evaluateBusinessTask(summary, policyVersion) {
  try {
    const job = await readWorkflowJob(summary.id);
    const delivery = await getWorkflowDeliveryStatus(summary.id);
    const ready = delivery?.finalGate?.productReady === true && delivery?.finalGate?.downloadable === true;
    const spendBudget = job.constraints?.spendBudget || {};
    const predictableBudget = spendBudget.enforcePredictableCost === true
      && Number.isFinite(Number(spendBudget.maxTotalUsd))
      && Number(spendBudget.maxTotalUsd) >= 0
      && Number(spendBudget.maxImageCalls) > 0;
    return {
      id: job.id,
      policyVersion,
      materialType: inferMaterialType(job.input || {}),
      ready,
      predictableBudget,
      recoveryEvents: countRecoveryEvents(job.events),
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      evaluationError: ""
    };
  } catch (error) {
    return {
      id: summary.id,
      policyVersion,
      materialType: inferMaterialType(summary.input || {}),
      ready: false,
      predictableBudget: false,
      recoveryEvents: null,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      evaluationError: error?.message || String(error)
    };
  }
}

function inferMaterialType(input = {}) {
  const name = String(input.sourceOriginalName || "").toLowerCase();
  const mime = String(input.sourceMimeType || "").toLowerCase();
  if (input.mode === "codex-ppt-brief" || input.sourceKind === "brief" || /\.md$|\.txt$/.test(name)) return "brief";
  if (/\.pptx?$/.test(name) || mime.includes("presentation")) return "ppt";
  if (/\.pdf$/.test(name) || mime.includes("pdf")) return "pdf";
  if (/\.(png|jpe?g|webp|gif|bmp|tiff?)$/.test(name) || mime.startsWith("image/")) return "image";
  if (/\.(docx?|rtf)$/.test(name) || mime.includes("word")) return "document";
  return "other";
}

export function countRecoveryEvents(events = []) {
  return (Array.isArray(events) ? events : []).filter((event) => {
    const type = String(event?.type || "");
    return type === "editable.reset"
      || type === "workflow.image_deck_pages_reset_for_rerun"
      || /(?:^|\.)(?:retry_requested|recovery_started|recovery_requested)$/.test(type);
  }).length;
}

function makeCheck(id, pass, actual, target, label, direction = "min") {
  return { id, label, pass, actual, target, direction };
}

function ratio(part, total) {
  return total ? round(part / total) : 0;
}

function round(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, worker));
  return results;
}

async function readCache() {
  try {
    const parsed = JSON.parse(await fs.readFile(CACHE_PATH, "utf8"));
    return parsed?.version === 1 && parsed.tasks && typeof parsed.tasks === "object" ? parsed : { version: 1, tasks: {} };
  } catch {
    return { version: 1, tasks: {} };
  }
}

async function writeCache(value) {
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.writeFile(CACHE_PATH, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
