#!/usr/bin/env node
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.join(process.cwd(), "workspace", "delivery-evidence", "delivery-candidate");
const startedAt = new Date().toISOString();
const phases = [];
await fs.mkdir(root, { recursive: true });
await writeLatest({ status: "running", startedAt, currentPhase: "baseline", phases });

try {
  await runNpm("check", "baseline-check", 180000);
  await runNpm("smoke", "api-smoke", 180000);
  await runNpm("regression:skill-first", "skill-first-regression", 180000);
  await runNpm("quality:targeted", "targeted-quality-and-race", 180000);
  await runNpm("quality:contract-37x2", "rule-contract-37x2", 300000);
  await runNpm("quality:replay-37x2", "artifact-replay-37x2", 600000);
  await runNpm("build", "pre-performance-build", 180000);
  await runNpm("performance:acceptance", "performance-acceptance", 300000);
  await runNpm("build", "final-production-build", 180000);
  await runNpm("evidence:strict-ui", "strict-dual-state-ui-e2e", 600000);
  await runCommand("git", ["diff", "--check"], "final-diff-review", 120000);

  const upstreamEvidence = await collectAndValidateEvidence();
  const finishedAt = new Date().toISOString();
  const sourceFiles = await hashFiles([
    "package.json",
    "package-lock.json",
    "src/main.jsx",
    "src/styles.css",
    "src/api/client.js",
    "src/ui-v2/PptAgentWorkspace.jsx",
    "src/ui-v2/PptAgentWorkspace.module.css",
    "shared/workflowDeliveryStatus.js",
    "shared/workflowVisibility.js",
    "server/index.js",
    "server/workflowJobs.js",
    "server/workflowDelivery.js",
    "server/workflowPageEvidence.js",
    "server/workflowFinalEvidence.js",
    "scripts/delivery-candidate-acceptance.mjs",
    "scripts/skill-first-regression.mjs",
    "scripts/quality-replay-37x2.mjs",
    "scripts/quality-artifact-replay-37x2.mjs",
    "scripts/performance-acceptance.mjs",
    "scripts/smoke-workflow-e2e.mjs",
    "scripts/workflow-selection-race.mjs",
    "scripts/strict-ui-e2e.mjs",
    "scripts/strict-ui-e2e.playwright.js",
    "scripts/strict-ui-e2e-evidence.mjs"
  ]);
  const workingTreeFiles = await hashOptionalFiles(await listWorkingTreePaths());
  const baseCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), windowsHide: true })).stdout.trim();
  const evidence = {
    kind: "ppt-agent-delivery-candidate-acceptance",
    version: 1,
    status: "pass",
    softwareCandidateAcceptance: { status: "pass", deliverable: true },
    historicalArtifactAcceptance: {
      status: upstreamEvidence.artifactReplay37x2.artifactAcceptanceStatus || "unknown",
      deliverable: upstreamEvidence.artifactReplay37x2.artifactAcceptanceStatus === "pass"
    },
    syntheticReadyScope: "control-plane-only; not external generation quality evidence",
    startedAt,
    finishedAt,
    noCommit: true,
    noPush: true,
    noExternalModelApi: true,
    requiredOrder: phases.map((phase) => phase.id),
    phases,
    upstreamEvidence,
    sourceFiles,
    sourceFingerprint: sha256(stableJson(sourceFiles)),
    baseCommit,
    workingTreeFiles,
    workingTreeFingerprint: sha256(stableJson(workingTreeFiles))
  };
  await persistEvidence(evidence);
  console.log(JSON.stringify({ ok: true, status: evidence.status, phases: phases.length, sourceFingerprint: evidence.sourceFingerprint }, null, 2));
} catch (error) {
  const failedPhase = phases.find((phase) => phase.status === "fail")?.id || "evidence-validation";
  await writeLatest({
    status: "fail",
    startedAt,
    finishedAt: new Date().toISOString(),
    currentPhase: failedPhase,
    error: error?.stack || error?.message || String(error),
    phases
  });
  throw error;
}

async function runNpm(script, id, timeoutMs) {
  return runCommand(process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe", ["/d", "/s", "/c", `npm.cmd run ${script}`], id, timeoutMs);
}

async function runCommand(command, args, id, timeoutMs) {
  const phase = { id, status: "running", startedAt: new Date().toISOString(), finishedAt: "", elapsedMs: 0, log: "" };
  phases.push(phase);
  await writeLatest({ status: "running", startedAt, currentPhase: id, phases });
  const phaseStarted = Date.now();
  try {
    const result = await execFileAsync(command, args, {
      cwd: process.cwd(),
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 30 * 1024 * 1024
    });
    phase.status = "pass";
    phase.finishedAt = new Date().toISOString();
    phase.elapsedMs = Date.now() - phaseStarted;
    phase.log = `workspace/delivery-evidence/delivery-candidate/${id}.log`;
    await fs.writeFile(path.join(root, `${id}.log`), `${result.stdout || ""}${result.stderr || ""}`, "utf8");
    await writeLatest({ status: "running", startedAt, currentPhase: id, phases });
    return phase;
  } catch (error) {
    phase.status = "fail";
    phase.finishedAt = new Date().toISOString();
    phase.elapsedMs = Date.now() - phaseStarted;
    phase.log = `workspace/delivery-evidence/delivery-candidate/${id}.log`;
    await fs.writeFile(path.join(root, `${id}.log`), `${error.stdout || ""}${error.stderr || ""}\n${error.stack || error.message || error}`, "utf8");
    throw error;
  }
}

async function collectAndValidateEvidence() {
  const definitions = [
    ["targeted", "targeted-quality", (value) => value.status === "pass" && value.selectedScenarioCount === 11],
    ["selectionRace", "workflow-selection-race", (value) => value.status === "pass" && value.scenario === "late-A-cannot-overwrite-selected-B"],
    ["contract37x2", "quality-contract-37x2", (value) => value.status === "pass" && value.selectedScenarioCount === 37 && value.rounds === 2],
    ["artifactReplay37x2", "quality-replay-37x2", (value) => value.qualityRegression?.status === "pass" && value.corpusPageCount === 37 && value.rounds === 2],
    ["performance", "performance", (value) => value.status === "pass"],
    ["strictUi", "strict-ui-e2e", (value) => value.status === "dual-state-pass" && value.liveReadyDeliveryGate?.downloadable === true]
  ];
  const evidence = {};
  for (const [key, folder, predicate] of definitions) {
    const evidencePath = path.join(process.cwd(), "workspace", "delivery-evidence", folder, "latest.json");
    const raw = await fs.readFile(evidencePath, "utf8");
    const value = JSON.parse(raw);
    if (!predicate(value)) throw new Error(`Delivery candidate evidence is not passing: ${folder}.`);
    evidence[key] = {
      path: path.relative(process.cwd(), evidencePath).replaceAll("\\", "/"),
      sha256: sha256(raw),
      status: value.status || value.qualityRegression?.status || "unknown",
      qualityRegressionStatus: value.qualityRegression?.status || "",
      artifactAcceptanceStatus: value.artifactAcceptance?.status || "",
      startedAt: value.startedAt || "",
      finishedAt: value.finishedAt || "",
      sourceFingerprint: value.sourceFingerprint || "",
      fingerprint: value.fingerprint || value.corpusFingerprint || value.screenshotFingerprint || ""
    };
  }
  const order = [
    evidence.targeted.finishedAt,
    evidence.selectionRace.finishedAt,
    evidence.contract37x2.finishedAt,
    evidence.artifactReplay37x2.startedAt,
    evidence.performance.startedAt,
    evidence.strictUi.startedAt
  ].map((value) => Date.parse(value || ""));
  if (order.some((value) => !Number.isFinite(value)) || order[0] > order[2] || order[1] > order[2] || order[2] > order[3] || order[3] > order[4] || order[4] > order[5]) {
    throw new Error("Delivery candidate evidence timestamps do not match the required quality -> performance -> strict E2E order.");
  }
  return evidence;
}

async function persistEvidence(evidence) {
  const stamp = evidence.finishedAt.replace(/[:.]/g, "-");
  const json = `${JSON.stringify(evidence, null, 2)}\n`;
  const markdown = renderMarkdown(evidence);
  await fs.writeFile(path.join(root, `${stamp}.json`), json, "utf8");
  await fs.writeFile(path.join(root, `${stamp}.md`), markdown, "utf8");
  await fs.writeFile(path.join(root, "latest.json"), json, "utf8");
  await fs.writeFile(path.join(root, "latest.md"), markdown, "utf8");
}

async function writeLatest(state) {
  const payload = { kind: "ppt-agent-delivery-candidate-acceptance", version: 1, ...state };
  await fs.writeFile(path.join(root, "latest.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(root, "latest.md"), `# PPT Agent delivery candidate\n\n- Status: ${payload.status}\n- Current phase: ${payload.currentPhase || "complete"}\n- Error: ${payload.error || "none"}\n`, "utf8");
}

async function hashFiles(files) {
  const result = [];
  for (const file of files) result.push({ path: file, sha256: sha256(await fs.readFile(path.resolve(file))) });
  return result;
}

async function hashOptionalFiles(files) {
  const result = [];
  for (const file of files) {
    const buffer = await fs.readFile(path.resolve(file)).catch(() => null);
    result.push({ path: file, sha256: buffer ? sha256(buffer) : "deleted" });
  }
  return result;
}

async function listWorkingTreePaths() {
  const options = { cwd: process.cwd(), windowsHide: true, maxBuffer: 10 * 1024 * 1024 };
  const [tracked, untracked] = await Promise.all([
    execFileAsync("git", ["diff", "--name-only", "--no-renames", "-z", "HEAD", "--"], options),
    execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], options)
  ]);
  return [...new Set(`${tracked.stdout || ""}\0${untracked.stdout || ""}`.split("\0")
    .map((value) => value.trim().replaceAll("\\", "/"))
    .filter((value) => value && value !== "docs/delivery-readiness-status.md"))].sort();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function renderMarkdown(evidence) {
  const rows = evidence.phases.map((phase) => `| ${phase.id} | ${phase.status} | ${phase.elapsedMs} | ${phase.log} |`).join("\n");
  return `# PPT Agent delivery candidate acceptance\n\n- Software candidate acceptance: ${evidence.softwareCandidateAcceptance.status} (current source and production build are deliverable)\n- Historical PPT artifact acceptance: ${evidence.historicalArtifactAcceptance.status} (${evidence.historicalArtifactAcceptance.deliverable ? "deliverable" : "blocked; not a qualified PPT product delivery"})\n- Synthetic ready fixture: control-plane and download-gate evidence only; not external generation quality evidence\n- Overall software status: ${evidence.status}\n- Started: ${evidence.startedAt}\n- Finished: ${evidence.finishedAt}\n- Commit: no\n- Push: no\n- External model API: no\n- Source fingerprint: \`${evidence.sourceFingerprint}\`\n- Working tree fingerprint: \`${evidence.workingTreeFingerprint}\`\n\n| Phase | Status | Elapsed ms | Log |\n| --- | --- | ---: | --- |\n${rows}\n`;
}
