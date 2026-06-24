import crypto from "crypto";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { readWorkflowJob } from "./workflowJobs.js";

const FINAL_VALIDATION_ARRAYS = [
  "page_manifests_missing",
  "page_validation_missing",
  "failed_page_validations",
  "page_contract_violations",
  "notes_hash_mismatches",
  "missing_parts"
];

export async function scanWorkflowFinalEvidence(jobOrId) {
  const job = typeof jobOrId === "string" ? await readWorkflowJob(jobOrId) : jobOrId;
  const artifacts = job?.artifacts || {};
  const editableRun = artifacts.editableRun || {};
  const final = artifacts.editableFinal || {};
  const runDir = resolveMaybe(final.runDir || editableRun.path);
  const finalPath = resolveMaybe(final.path);
  const sourceOutputPath = resolveMaybe(final.sourceOutputPath || final.summary?.output);
  const workspaceValidationPath = resolveMaybe(final.validation?.path);
  const runSummaryPath = runDir ? path.join(runDir, "final", "run_summary.json") : "";
  const runValidationPath = resolveMaybe(final.summary?.validation || (runDir ? path.join(runDir, "final", "validation.json") : ""));
  const deckManifestPath = resolveMaybe(editableRun.deckManifestPath || (runDir ? path.join(runDir, "deck_manifest.json") : ""));
  const pageJobsPath = resolveMaybe(editableRun.pageJobsPath || (runDir ? path.join(runDir, "page_jobs.json") : ""));
  const issues = [];

  const finalFile = statFile(finalPath);
  const sourceOutputFile = statFile(sourceOutputPath);
  const workspaceValidation = await readJsonIfFile(workspaceValidationPath);
  const runValidation = await readJsonIfFile(runValidationPath);
  const runSummary = await readJsonIfFile(runSummaryPath);
  const deckManifest = await readJsonIfFile(deckManifestPath);
  const pageJobs = await readJsonIfFile(pageJobsPath);

  if (!final.path) issues.push("final-artifact-missing");
  else if (!isInsidePath(finalPath, path.resolve(job.rootDir))) issues.push("final-artifact-outside-job-root");
  else if (!finalFile.exists) issues.push("final-artifact-file-missing");

  if (!workspaceValidationPath || !workspaceValidation.exists) issues.push("workspace-final-validation-missing");
  if (!runSummary.exists) issues.push("run-summary-missing");
  if (!runValidation.exists) issues.push("run-final-validation-missing");
  if (!sourceOutputPath || !sourceOutputFile.exists) issues.push("run-final-output-missing");
  if (runDir && sourceOutputPath && !isInsidePath(sourceOutputPath, runDir)) issues.push("run-output-outside-run-dir");
  if (runDir && runValidationPath && !isInsidePath(runValidationPath, runDir)) issues.push("run-validation-outside-run-dir");

  const validation = workspaceValidation.data || runValidation.data || {};
  const summary = runSummary.data || final.summary || {};
  const expectedPages = numberOrZero(validation.expected_pages || deckManifest.data?.page_count || pageJobs.data?.pages?.length || editableRun.pageCount || final.summary?.page_count);
  const validationSlides = numberOrZero(validation.slides);
  const summaryPages = numberOrZero(summary.page_count);
  const editabilitySlides = numberOrZero(final.pptxEditability?.slideCount);
  const pageJobCount = Array.isArray(pageJobs.data?.pages) ? pageJobs.data.pages.length : 0;

  if (workspaceValidation.exists && workspaceValidation.data?.passed !== true) issues.push("workspace-final-validation-not-passed");
  if (runValidation.exists && runValidation.data?.passed !== true) issues.push("run-final-validation-not-passed");
  if (runSummary.exists && summary.status !== "complete") issues.push("run-summary-not-complete");
  if (expectedPages && validationSlides && expectedPages !== validationSlides) issues.push("validation-page-count-mismatch");
  if (expectedPages && summaryPages && expectedPages !== summaryPages) issues.push("summary-page-count-mismatch");
  if (expectedPages && editabilitySlides && expectedPages !== editabilitySlides) issues.push("editability-slide-count-mismatch");
  if (expectedPages && pageJobCount && expectedPages !== pageJobCount) issues.push("page-jobs-count-mismatch");
  for (const key of FINAL_VALIDATION_ARRAYS) {
    if (Array.isArray(validation[key]) && validation[key].length) issues.push(`validation-${key}-not-empty`);
  }

  const finalHash = finalFile.exists ? await hashFile(finalPath).catch(() => "") : "";
  const sourceOutputHash = sourceOutputFile.exists ? await hashFile(sourceOutputPath).catch(() => "") : "";
  const hashesMatch = Boolean(finalHash && sourceOutputHash && finalHash === sourceOutputHash);
  if (finalHash && sourceOutputHash && !hashesMatch) issues.push("final-copy-hash-mismatch");
  if (finalFile.exists && sourceOutputFile.exists && finalFile.size !== sourceOutputFile.size) issues.push("final-copy-size-mismatch");

  const complete = Boolean(
    finalFile.exists
    && sourceOutputFile.exists
    && workspaceValidation.exists
    && runValidation.exists
    && runSummary.exists
    && workspaceValidation.data?.passed === true
    && runValidation.data?.passed === true
    && summary.status === "complete"
    && (!expectedPages || validationSlides === expectedPages)
    && (!summaryPages || summaryPages === expectedPages)
    && (!editabilitySlides || editabilitySlides === expectedPages)
    && hashesMatch
    && issues.length === 0
  );

  return {
    ok: true,
    complete,
    runDir,
    finalPath: final.path || "",
    sourceOutputPath: final.sourceOutputPath || summary.output || "",
    validationPath: final.validation?.path || "",
    issues: [...new Set(issues)],
    summary: {
      hasFinal: finalFile.exists,
      hasWorkspaceValidation: workspaceValidation.exists,
      hasRunValidation: runValidation.exists,
      hasRunSummary: runSummary.exists,
      validationPassed: workspaceValidation.data?.passed === true && runValidation.data?.passed === true,
      runSummaryComplete: summary.status === "complete",
      finalSize: finalFile.size,
      sourceOutputSize: sourceOutputFile.size,
      finalHash,
      sourceOutputHash,
      hashesMatch,
      expectedPages,
      validationSlides,
      summaryPages,
      editabilitySlides,
      pageJobCount,
      validationFailuresEmpty: FINAL_VALIDATION_ARRAYS.every((key) => !Array.isArray(validation[key]) || validation[key].length === 0)
    }
  };
}

function statFile(filePath = "") {
  if (!filePath) return { exists: false, size: 0 };
  if (!fsSync.existsSync(filePath)) return { exists: false, size: 0 };
  const stat = fsSync.statSync(filePath);
  return stat.isFile() ? { exists: true, size: stat.size } : { exists: false, size: 0 };
}

async function readJsonIfFile(filePath = "") {
  if (!filePath) return { exists: false, data: null, error: "" };
  if (!fsSync.existsSync(filePath) || !fsSync.statSync(filePath).isFile()) return { exists: false, data: null, error: "file not found" };
  try {
    return { exists: true, data: JSON.parse(await fs.readFile(filePath, "utf8")), error: "" };
  } catch (error) {
    return { exists: true, data: null, error: error.message || "failed to parse json" };
  }
}

function resolveMaybe(value = "") {
  const raw = String(value || "").trim();
  return raw ? path.resolve(raw) : "";
}

async function hashFile(filePath) {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function isInsidePath(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function numberOrZero(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}
