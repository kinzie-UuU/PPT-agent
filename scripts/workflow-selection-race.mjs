#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { canApplyWorkflowJob, claimWorkflowSelection, isWorkflowSelectionCurrent, mergeWorkflowJobPage } from "../src/workflow/workflowSelectionGuard.js";

const evidenceRoot = path.join(process.cwd(), "workspace", "delivery-evidence", "workflow-selection-race");
const startedAt = new Date().toISOString();
await fs.mkdir(evidenceRoot, { recursive: true });
await writeEvidence({ status: "running", startedAt });

try {
  await runRace();
} catch (error) {
  await writeEvidence({ status: "fail", startedAt, finishedAt: new Date().toISOString(), error: error?.stack || error?.message || String(error) });
  throw error;
}

async function runRace() {
const selectionRef = { current: { epoch: 0, id: "" } };
let visibleJob = null;

async function delayedJob(id, delayMs) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  return { id };
}

async function select(id, delayMs) {
  const selection = claimWorkflowSelection(selectionRef, id);
  const job = await delayedJob(id, delayMs);
  if (isWorkflowSelectionCurrent(selectionRef, selection, job.id)) visibleJob = job;
}

await Promise.all([
  select("workflow_A", 40),
  new Promise((resolve) => setTimeout(resolve, 5)).then(() => select("workflow_B", 5))
]);

assert.equal(visibleJob?.id, "workflow_B", "A late response must not replace the user's newer B selection.");
assert.equal(canApplyWorkflowJob(selectionRef, "workflow_A"), false, "The unified state guard must reject any stale A write after selecting B.");
assert.equal(canApplyWorkflowJob(selectionRef, "workflow_B"), true, "The unified state guard must allow the current B write.");
const firstPage = Array.from({ length: 120 }, (_, index) => ({ id: `workflow_page_${String(index + 1).padStart(3, "0")}` }));
const olderSelectedJob = { id: "workflow_page_149" };
const selectedPage = mergeWorkflowJobPage([], firstPage, { activeJob: olderSelectedJob });
assert.equal(selectedPage[0]?.id, olderSelectedJob.id, "A selected job outside the first page must remain in the visible list after refresh.");
assert.equal(selectedPage.length, 121, "Merging the selected older job must not discard the first page.");
const appendedPage = mergeWorkflowJobPage(selectedPage, [firstPage[0], { id: "workflow_page_121" }], { activeJob: olderSelectedJob, append: true });
assert.equal(appendedPage.filter((job) => job.id === firstPage[0].id).length, 1, "Appending pages must deduplicate jobs by id.");
assert.ok(appendedPage.some((job) => job.id === "workflow_page_121"), "Appending must preserve newly loaded older jobs.");
const result = { status: "pass", startedAt, finishedAt: new Date().toISOString(), scenario: "late-A-cannot-overwrite-selected-B", paginationScenario: "selected-job-outside-first-page-remains-visible", visibleJobId: visibleJob.id };
await writeEvidence(result);
console.log(JSON.stringify({ ok: true, ...result }));
}

async function writeEvidence(state) {
  const sourceFiles = await Promise.all([
    "scripts/workflow-selection-race.mjs",
    "src/workflow/workflowSelectionGuard.js"
  ].map(async (file) => ({ path: file, sha256: crypto.createHash("sha256").update(await fs.readFile(path.resolve(file))).digest("hex") })));
  const payload = { kind: "ppt-agent-workflow-selection-race", version: 1, ...state, sourceFiles };
  await fs.writeFile(path.join(evidenceRoot, "latest.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(evidenceRoot, "latest.md"), `# Workflow selection race\n\n- Status: ${payload.status}\n- Scenario: ${payload.scenario || "pending"}\n- Error: ${payload.error || "none"}\n`, "utf8");
}
