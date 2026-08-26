#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { appendWorkflowEvent, archiveWorkflowJob, createWorkflowJob } from "../server/workflowJobs.js";

const baseUrl = String(process.env.PPT_TOOL_BASE_URL || "http://127.0.0.1:4180").replace(/\/+$/, "");
const root = path.join(process.cwd(), "workspace", "delivery-evidence", "performance");
const lifecycleStartedAt = new Date().toISOString();
await fs.mkdir(root, { recursive: true });
await writeLatestState({ status: "running", startedAt: lifecycleStartedAt, phase: "quality-gate" });
try {
  await runAcceptance();
} catch (error) {
  await writeLatestState({ status: "fail", startedAt: lifecycleStartedAt, finishedAt: new Date().toISOString(), phase: "performance-acceptance", error: error?.stack || error?.message || String(error) });
  throw error;
}

async function runAcceptance() {
const qualityGate = await assertQualityGate();
const jobId = process.env.PPT_TOOL_PERF_JOB_ID || qualityGate.evidenceJobId || await selectEvidenceJob();
const startedAt = new Date().toISOString();

await assertHealthy();
const checks = [];
checks.push(await benchmark("health-sequential", "/api/health", { samples: 40, coldMaxMs: 1000, p95MaxMs: 150, maxMs: 500 }));
checks.push(await benchmark("job-list-sequential", "/api/workflow-jobs?limit=20", { samples: 25, coldMaxMs: 2000, p95MaxMs: 250, maxMs: 1000 }));
checks.push(await benchmarkAfterCacheExpiry("job-list-after-cache-expiry", "/api/workflow-jobs?limit=20", {
  delayMs: 5200,
  expiryConcurrency: 10,
  samples: 5,
  coldMaxMs: 2000,
  p95MaxMs: 250,
  maxMs: 1000
}));
checks.push(await benchmarkWorkflowListMutationRace());
checks.push(await benchmark("ui-shell-sequential", "/", { samples: 25, coldMaxMs: 1500, p95MaxMs: 150, maxMs: 800, expectHtml: true }));
if (jobId) checks.push(await benchmark("delivery-status-sequential", `/api/workflow-jobs/${encodeURIComponent(jobId)}/delivery-status`, { samples: 20, coldMaxMs: 12000, coldTimeoutMs: 15000, p95MaxMs: 500, maxMs: 1500 }));
checks.push(await benchmarkConcurrent("health-concurrent-10", "/api/health", { batches: 4, concurrency: 10, coldMaxMs: 1000, p95MaxMs: 300, maxMs: 1000 }));

const failedChecks = checks.filter((check) => check.status !== "pass");
const evidence = {
  kind: "ppt-agent-local-control-plane-performance",
  version: 2,
  scope: "local-control-plane-only; excludes external model generation and editable reconstruction throughput",
  baseUrl,
  jobId,
  startedAt,
  finishedAt: new Date().toISOString(),
  noExternalApi: true,
  qualityGate,
  buildFingerprint: await collectBuildFingerprint(),
  status: failedChecks.length ? "fail" : "pass",
  failedChecks: failedChecks.map((check) => check.name),
  checks
};

const stamp = evidence.finishedAt.replace(/[:.]/g, "-");
const jsonPath = path.join(root, `${stamp}.json`);
const markdown = renderMarkdown(evidence);
await fs.writeFile(jsonPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
await fs.writeFile(path.join(root, `${stamp}.md`), markdown, "utf8");
await fs.writeFile(path.join(root, "latest.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
await fs.writeFile(path.join(root, "latest.md"), markdown, "utf8");

console.log(JSON.stringify({
  ok: evidence.status === "pass",
  kind: evidence.kind,
  jobId,
  qualityGate: { status: qualityGate.status, corpusFingerprint: qualityGate.corpusFingerprint, artifactAcceptanceStatus: qualityGate.artifactAcceptanceStatus },
  checks: checks.map(({ name, status, firstRequest, samples, p50Ms, p95Ms, maxMs }) => ({ name, status, firstRequestMs: firstRequest.elapsedMs, samples, p50Ms, p95Ms, maxMs })),
  evidence: path.relative(process.cwd(), jsonPath)
}, null, 2));

if (evidence.status !== "pass") process.exitCode = 1;
}

async function assertHealthy() {
  const response = await timedFetch("/api/health");
  if (!response.ok) throw new Error(`PPT Agent is not healthy at ${baseUrl}: HTTP ${response.status}`);
  const payload = JSON.parse(response.body);
  if (payload.ok !== true) throw new Error(`PPT Agent health payload is not ready at ${baseUrl}.`);
}

async function assertQualityGate() {
  const targeted = await readPassingEvidence("targeted-quality", (evidence) => (
    evidence.kind === "ppt-agent-targeted-quality-regression"
    && evidence.status === "pass"
    && evidence.selectedScenarioCount === 11
  ), "targeted quality regression");
  const selectionRace = await readPassingEvidence("workflow-selection-race", (evidence) => (
    evidence.kind === "ppt-agent-workflow-selection-race"
    && evidence.status === "pass"
    && evidence.scenario === "late-A-cannot-overwrite-selected-B"
  ), "workflow selection race");
  const contract = await readPassingEvidence("quality-contract-37x2", (evidence) => (
    evidence.kind === "ppt-agent-rule-contract-replay-37x2"
    && evidence.status === "pass"
    && evidence.selectedScenarioCount === 37
    && evidence.rounds === 2
  ), "37 x 2 rule contract");
  const qualityPath = path.join(process.cwd(), "workspace", "delivery-evidence", "quality-replay-37x2", "latest.json");
  const raw = await fs.readFile(qualityPath, "utf8").catch(() => "");
  if (!raw) throw new Error("Performance acceptance is blocked: real 37 x 2 quality evidence is missing.");
  const quality = JSON.parse(raw);
  if (quality.kind !== "ppt-agent-stored-artifact-quality-replay-37x2" || quality.qualityRegression?.status !== "pass" || quality.realPageCount < 35 || quality.syntheticPageCount > 2 || quality.corpusPageCount !== 37 || quality.rounds !== 2) {
    throw new Error("Performance acceptance is blocked: the latest quality evidence is not a passing real 37 x 2 replay.");
  }
  const changed = [];
  for (const entry of Array.isArray(quality.sourceFiles) ? quality.sourceFiles : []) {
    const current = await sha256File(path.resolve(entry.path)).catch(() => "");
    if (!current || current !== entry.sha256) changed.push(entry.path);
  }
  if (changed.length) throw new Error(`Performance acceptance is blocked: quality-tested source changed (${changed.join(", ")}).`);
  const orderedTimes = [targeted.finishedAt, selectionRace.finishedAt, contract.finishedAt, quality.startedAt].map((value) => Date.parse(value || ""));
  if (orderedTimes.some((value) => !Number.isFinite(value)) || orderedTimes[0] > orderedTimes[2] || orderedTimes[1] > orderedTimes[2] || orderedTimes[2] > orderedTimes[3]) {
    throw new Error("Performance acceptance is blocked: quality evidence was not produced in the required targeted -> contract -> artifact replay order.");
  }
  return {
    status: "pass",
    gateMeaning: "software-quality-regression-pass; historical artifact acceptance is tracked separately",
    artifactAcceptanceStatus: quality.artifactAcceptance?.status || "unknown",
    evidencePath: path.relative(process.cwd(), qualityPath),
    evidenceSha256: sha256(raw),
    corpusFingerprint: quality.corpusFingerprint,
    sourceFingerprint: quality.sourceFingerprint,
    evidenceJobId: quality.performanceEvidenceJobId || quality.corpus?.[0]?.jobId || "",
    verifiedSourceFiles: quality.sourceFiles?.length || 0,
    upstreamGates: {
      targeted: targeted.status,
      selectionRace: selectionRace.status,
      contract37x2: contract.status,
      artifactReplay37x2: quality.qualityRegression.status
    }
  };
}

async function readPassingEvidence(folder, predicate, label) {
  const evidencePath = path.join(process.cwd(), "workspace", "delivery-evidence", folder, "latest.json");
  const raw = await fs.readFile(evidencePath, "utf8").catch(() => "");
  if (!raw) throw new Error(`Performance acceptance is blocked: ${label} evidence is missing.`);
  const evidence = JSON.parse(raw);
  if (!predicate(evidence)) throw new Error(`Performance acceptance is blocked: ${label} evidence is not passing.`);
  const changed = [];
  for (const entry of Array.isArray(evidence.sourceFiles) ? evidence.sourceFiles : []) {
    const current = await sha256File(path.resolve(entry.path)).catch(() => "");
    if (!current || current !== entry.sha256) changed.push(entry.path);
  }
  if (changed.length) throw new Error(`Performance acceptance is blocked: ${label} source changed (${changed.join(", ")}).`);
  return evidence;
}

async function collectBuildFingerprint() {
  const candidates = [
    "package.json",
    "package-lock.json",
    "dist/index.html",
    "server/index.js",
    "server/doctor.js",
    "server/workflowPptMaster.js",
    "server/workflowDelivery.js",
    "server/workflowPageEvidence.js",
    "server/workflowFinalEvidence.js",
    "server/workflowJobs.js",
    "shared/workflowVisibility.js",
    "scripts/performance-acceptance.mjs"
  ];
  const assetRoot = path.join(process.cwd(), "dist", "assets");
  const assets = await fs.readdir(assetRoot).catch(() => []);
  candidates.push(...assets.filter((name) => /\.(?:js|css)$/.test(name)).sort().map((name) => path.join("dist", "assets", name)));
  const files = [];
  for (const relativePath of candidates) {
    const hash = await sha256File(path.resolve(relativePath)).catch(() => "");
    if (hash) files.push({ path: relativePath.replaceAll("\\", "/"), sha256: hash });
  }
  return { sha256: sha256(stableJson(files)), files };
}

async function benchmark(name, route, options) {
  const firstRequest = await timedFetch(route, { ...options, timeoutMs: options.coldTimeoutMs || 5000 });
  const results = [];
  for (let index = 0; index < options.samples; index += 1) results.push(await timedFetch(route, options));
  return summarize(name, results, options, firstRequest);
}

async function benchmarkConcurrent(name, route, options) {
  const firstRequest = await timedFetch(route, options);
  const results = [];
  for (let batch = 0; batch < options.batches; batch += 1) {
    results.push(...await Promise.all(Array.from({ length: options.concurrency }, () => timedFetch(route, options))));
  }
  return summarize(name, results, options, firstRequest);
}

async function benchmarkAfterCacheExpiry(name, route, options) {
  const primeRequest = await timedFetch(route, options);
  await new Promise((resolve) => setTimeout(resolve, options.delayMs));
  const expiryConcurrency = Math.max(1, Number(options.expiryConcurrency || 1));
  const expiredResults = await Promise.all(Array.from({ length: expiryConcurrency }, () => (
    timedFetch(route, { ...options, timeoutMs: options.coldTimeoutMs || 5000 })
  )));
  const [firstRequest, ...results] = expiredResults;
  for (let index = 0; index < options.samples; index += 1) results.push(await timedFetch(route, options));
  const summary = summarize(name, results, options, firstRequest);
  if (!primeRequest.ok) summary.status = "fail";
  return {
    ...summary,
    delayMs: options.delayMs,
    expiryConcurrency,
    primeRequest: {
      ok: primeRequest.ok === true,
      status: primeRequest.status || 0,
      elapsedMs: primeRequest.elapsedMs || 0,
      error: primeRequest.error || ""
    }
  };
}

async function benchmarkWorkflowListMutationRace() {
  const name = "job-list-expiry-write-race";
  const route = "/api/workflow-jobs?limit=20&includeInternal=1&includeArchived=1";
  const job = await createWorkflowJob({
    sourceBrief: "workflow list cache concurrency acceptance probe",
    projectName: "Workflow list cache race acceptance",
    mode: "regression-cache-race",
    internal: true,
    visibility: "internal"
  });
  try {
    const primeRequest = await timedFetch(route, { timeoutMs: 5000 });
    const primePayload = parseJsonBody(primeRequest.body);
    await new Promise((resolve) => setTimeout(resolve, 5200));
    const pendingRequests = Array.from({ length: 10 }, () => timedFetch(route, { timeoutMs: 5000 }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = await appendWorkflowEvent(job.id, {
      type: "cache.race.acceptance",
      message: "State write during an expired summary refresh"
    });
    const results = await Promise.all(pendingRequests);
    const finalRequest = await timedFetch(route, { timeoutMs: 5000 });
    const finalPayload = parseJsonBody(finalRequest.body);
    const finalJob = Array.isArray(finalPayload?.jobs) ? finalPayload.jobs.find((item) => item.id === job.id) : null;
    const elapsed = results.map((result) => result.elapsedMs).sort((left, right) => left - right);
    const errors = results.filter((result) => !result.ok);
    const allReadsContainProbe = results.every((result) => {
      const payload = parseJsonBody(result.body);
      return Array.isArray(payload?.jobs) && payload.jobs.some((item) => item.id === job.id);
    });
    const latestStateVisible = finalJob?.updatedAt === updated.updatedAt;
    const p50Ms = percentile(elapsed, 0.5);
    const p95Ms = percentile(elapsed, 0.95);
    const maxMs = elapsed.at(-1) || 0;
    const status = primeRequest.ok
      && Array.isArray(primePayload?.jobs)
      && primePayload.jobs.some((item) => item.id === job.id)
      && !errors.length
      && allReadsContainProbe
      && finalRequest.ok
      && latestStateVisible
      && p95Ms <= 500
      && maxMs <= 2000
      ? "pass"
      : "fail";
    return {
      name,
      status,
      firstRequest: {
        ok: results[0]?.ok === true,
        status: results[0]?.status || 0,
        elapsedMs: results[0]?.elapsedMs || 0,
        bytes: results[0]?.bytes || 0,
        error: results[0]?.error || ""
      },
      samples: results.length,
      errorCount: errors.length,
      errorRate: round(errors.length / Math.max(1, results.length)),
      p50Ms,
      p95Ms,
      maxMs,
      averageBytes: Math.round(results.reduce((sum, result) => sum + result.bytes, 0) / Math.max(1, results.length)),
      thresholds: { p95MaxMs: 500, maxMs: 2000, errorRateMax: 0 },
      mutation: {
        jobId: job.id,
        concurrentReads: results.length,
        allReadsContainProbe,
        latestStateVisible,
        expectedUpdatedAt: updated.updatedAt,
        observedUpdatedAt: finalJob?.updatedAt || ""
      },
      errors: errors.slice(0, 5).map(({ status: httpStatus, error }) => ({ httpStatus, error: error || "HTTP request failed" }))
    };
  } finally {
    await archiveWorkflowJob(job.id, {
      archivedBy: "performance-acceptance",
      reason: "Workflow list cache race acceptance completed"
    }).catch(() => {});
  }
}

function parseJsonBody(body) {
  try {
    return JSON.parse(String(body || ""));
  } catch {
    return null;
  }
}

async function timedFetch(route, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs || 5000));
  const started = performance.now();
  try {
    const response = await fetch(`${baseUrl}${route}`, {
      signal: controller.signal,
      headers: { accept: options.expectHtml ? "text/html" : "application/json", "cache-control": "no-store" }
    });
    const body = await response.text();
    if (options.expectHtml && !/<!doctype html>|<html/i.test(body)) throw new Error(`${route} did not return the UI shell.`);
    return { ok: response.ok, status: response.status, elapsedMs: round(performance.now() - started), bytes: Buffer.byteLength(body), body };
  } catch (error) {
    return { ok: false, status: 0, elapsedMs: round(performance.now() - started), bytes: 0, body: "", error: error?.message || String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

function summarize(name, results, options, firstRequest) {
  const elapsed = results.map((result) => result.elapsedMs).sort((left, right) => left - right);
  const errors = results.filter((result) => !result.ok);
  const p50Ms = percentile(elapsed, 0.5);
  const p95Ms = percentile(elapsed, 0.95);
  const maxMs = elapsed.at(-1) || 0;
  const firstRequestPassed = firstRequest?.ok === true && firstRequest.elapsedMs <= options.coldMaxMs;
  const status = firstRequestPassed && !errors.length && p95Ms <= options.p95MaxMs && maxMs <= options.maxMs ? "pass" : "fail";
  return {
    name,
    status,
    firstRequest: { ok: firstRequest?.ok === true, status: firstRequest?.status || 0, elapsedMs: firstRequest?.elapsedMs || 0, bytes: firstRequest?.bytes || 0, error: firstRequest?.error || "" },
    samples: results.length,
    errorCount: errors.length,
    errorRate: round(errors.length / Math.max(1, results.length)),
    p50Ms,
    p95Ms,
    maxMs,
    averageBytes: Math.round(results.reduce((sum, result) => sum + result.bytes, 0) / Math.max(1, results.length)),
    thresholds: { firstRequestMaxMs: options.coldMaxMs, p95MaxMs: options.p95MaxMs, maxMs: options.maxMs, errorRateMax: 0 },
    errors: errors.slice(0, 5).map(({ status: httpStatus, error }) => ({ httpStatus, error: error || "HTTP request failed" }))
  };
}

async function selectEvidenceJob() {
  const jobsRoot = path.join(process.cwd(), "workspace", "jobs");
  const entries = await fs.readdir(jobsRoot, { withFileTypes: true }).catch(() => []);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("workflow_")) continue;
    const statePath = path.join(jobsRoot, entry.name, "state.json");
    try {
      const state = JSON.parse(await fs.readFile(statePath, "utf8"));
      if (state.artifacts?.editableFinal?.path || state.artifacts?.visualImages?.length) candidates.push({ id: state.id, internal: state.internal === true, updatedAt: state.updatedAt || state.createdAt || "" });
    } catch {
      // Ignore incomplete historical jobs; the list endpoint is still benchmarked.
    }
  }
  return candidates.sort((left, right) => Number(left.internal) - Number(right.internal) || right.updatedAt.localeCompare(left.updatedAt))[0]?.id || "";
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  return values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * ratio) - 1))];
}

async function sha256File(filePath) {
  return sha256(await fs.readFile(filePath));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function round(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function renderMarkdown(evidence) {
  const rows = evidence.checks.map((check) => `| ${check.name} | ${check.status} | ${check.firstRequest.elapsedMs} | ${check.samples} | ${check.p50Ms} | ${check.p95Ms} | ${check.maxMs} | ${check.errorCount} |`).join("\n");
  return `# PPT Agent performance acceptance\n\n- Status: ${evidence.status}\n- Scope: ${evidence.scope}\n- Base URL: ${evidence.baseUrl}\n- Evidence job: ${evidence.jobId || "none"}\n- Software quality regression gate: ${evidence.qualityGate.status}\n- Historical artifact acceptance: ${evidence.qualityGate.artifactAcceptanceStatus}\n- Quality corpus: ${evidence.qualityGate.corpusFingerprint}\n- External API calls: 0\n\n| Check | Status | First request ms | Warm samples | P50 ms | P95 ms | Max ms | Errors |\n| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |\n${rows}\n`;
}

async function writeLatestState(state) {
  const payload = { kind: "ppt-agent-local-control-plane-performance", version: 3, baseUrl, ...state };
  await fs.writeFile(path.join(root, "latest.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(root, "latest.md"), `# PPT Agent performance acceptance\n\n- Status: ${payload.status}\n- Phase: ${payload.phase || "unknown"}\n- Error: ${payload.error || "none"}\n`, "utf8");
}
