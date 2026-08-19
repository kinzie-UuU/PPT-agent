import { getWorkflowDeliveryStatus } from "./workflowDelivery.js";
import { listWorkflowJobSummaries, readWorkflowJob } from "./workflowJobs.js";

const DEFAULT_THRESHOLDS = Object.freeze({
  minimumTasks: 20,
  minimumMaterialTypes: 4,
  minimumSuccessRate: 0.9,
  minimumPredictableBudgetRate: 1,
  maximumAverageRecoveryEvents: 0.5
});

export async function getWorkflowBusinessReadiness(options = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds || {}) };
  const limit = clampInteger(options.limit, 1, 100, 50);
  const summaries = (await listWorkflowJobSummaries())
    .filter((job) => !job.internal && !job.lifecycle?.archivedAt)
    .slice(0, limit);
  const evaluated = await mapWithConcurrency(summaries, 4, async (summary) => {
    const job = await readWorkflowJob(summary.id);
    const delivery = await getWorkflowDeliveryStatus(summary.id).catch(() => null);
    const ready = delivery?.finalGate?.productReady === true && delivery?.finalGate?.downloadable === true;
    const spendBudget = job.constraints?.spendBudget || {};
    const predictableBudget = spendBudget.enforcePredictableCost === true
      && Number.isFinite(Number(spendBudget.maxTotalUsd))
      && Number(spendBudget.maxTotalUsd) >= 0
      && Number(spendBudget.maxImageCalls) > 0;
    return {
      id: job.id,
      materialType: inferMaterialType(job.input || {}),
      ready,
      predictableBudget,
      recoveryEvents: countRecoveryEvents(job.events),
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    };
  });
  const readyTasks = evaluated.filter((item) => item.ready);
  const materialTypes = [...new Set(evaluated.map((item) => item.materialType))];
  const successRate = ratio(readyTasks.length, evaluated.length);
  const predictableBudgetRate = ratio(evaluated.filter((item) => item.predictableBudget).length, evaluated.length);
  const averageRecoveryEvents = readyTasks.length
    ? round(readyTasks.reduce((sum, item) => sum + item.recoveryEvents, 0) / readyTasks.length)
    : null;
  const checks = [
    makeCheck("task-volume", evaluated.length >= thresholds.minimumTasks, evaluated.length, thresholds.minimumTasks, "真实任务数量"),
    makeCheck("material-diversity", materialTypes.length >= thresholds.minimumMaterialTypes, materialTypes.length, thresholds.minimumMaterialTypes, "材料类型覆盖"),
    makeCheck("delivery-success-rate", successRate >= thresholds.minimumSuccessRate, successRate, thresholds.minimumSuccessRate, "完整交付成功率"),
    makeCheck("predictable-budget-rate", predictableBudgetRate >= thresholds.minimumPredictableBudgetRate, predictableBudgetRate, thresholds.minimumPredictableBudgetRate, "可预测预算覆盖率"),
    makeCheck("recovery-rate", averageRecoveryEvents !== null && averageRecoveryEvents <= thresholds.maximumAverageRecoveryEvents, averageRecoveryEvents, thresholds.maximumAverageRecoveryEvents, "成功任务平均恢复次数", "max")
  ];
  return {
    ok: true,
    ready: checks.every((check) => check.pass),
    verdict: checks.every((check) => check.pass) ? "repeatable-business-capability" : "engineering-capability-only",
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
    updatedAt: new Date().toISOString()
  };
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

function countRecoveryEvents(events = []) {
  return (Array.isArray(events) ? events : []).filter((event) => /retry|reset|recover|failed|error/i.test(String(event?.type || ""))).length;
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
