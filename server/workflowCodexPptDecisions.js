import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { rootDir } from "./store.js";
import { getProviderConfig } from "./providers.js";
import { readWorkflowJob, saveWorkflowJob } from "./workflowJobs.js";

export async function recordWorkflowCodexPptStyle(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const now = new Date().toISOString();
  const payload = {
    kind: "codex_ppt_style",
    version: 1,
    jobId: job.id,
    title: cleanString(options.title || job.input?.sourceOriginalName || "Codex PPT visual style"),
    styleBrief: cleanString(options.styleBrief || options.style || job.input?.style || defaultStyleBrief(job)),
    audience: cleanString(options.audience || ""),
    tone: cleanString(options.tone || ""),
    constraints: cleanString(options.constraints || "Keep one coherent visual identity while varying layouts by slide role."),
    references: normalizeReferences(options.references),
    source: cleanString(options.source || "workflow-style"),
    notes: cleanString(options.notes || ""),
    recordedBy: cleanString(options.recordedBy || "local-user"),
    recordedAt: now
  };
  if (options.invalidateApprovals) {
    invalidateStyleDependentApprovals(job, now, {
      reason: cleanString(options.invalidateReason || "codex-ppt style evidence refreshed"),
      requestedBy: payload.recordedBy
    });
  }
  return writeDecisionArtifact(job, {
    artifactKey: "codexPptStyle",
    fileStem: "style",
    eventType: "codex-ppt.style.recorded",
    eventMessage: "Recorded codex-ppt style decision",
    payload,
    markdown: buildStyleMarkdown(payload)
  });
}

function invalidateStyleDependentApprovals(job, now, { reason = "", requestedBy = "" } = {}) {
  const approvals = Array.isArray(job.artifacts?.codexPptApprovals) ? job.artifacts.codexPptApprovals : [];
  const invalidated = approvals
    .filter((item) => ["style", "sample", "fullDeck"].includes(item?.gate))
    .map((item) => item.gate);
  if (!invalidated.length) return;
  job.artifacts = {
    ...(job.artifacts || {}),
    codexPptApprovals: approvals.filter((item) => !["style", "sample", "fullDeck"].includes(item?.gate))
  };
  job.events = appendEvent(job.events, {
    type: "codex-ppt.style.approvals-invalidated",
    message: "Invalidated codex-ppt approvals after style evidence refresh",
    details: { invalidated, reason, requestedBy },
    createdAt: now
  });
}

export async function recordWorkflowCodexPptBackendDecision(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const now = new Date().toISOString();
  const configured = getProviderConfig().image || {};
  const backend = options.backend || {};
  const payload = {
    kind: "codex_ppt_backend_decision",
    version: 1,
    jobId: job.id,
    provider: cleanString(backend.provider || options.provider || configured.provider || configured.baseUrl || "configured-provider"),
    baseUrl: cleanString(backend.baseUrl || options.baseUrl || configured.baseUrl || ""),
    model: cleanString(backend.model || options.model || configured.model || ""),
    enabled: Boolean(configured.enabled),
    configured: Boolean(configured.configured),
    policy: cleanString(options.policy || "Use this fixed backend for sample and full-deck slide image generation."),
    fallbackStatus: cleanString(options.fallbackStatus || "No local drawing, HTML screenshot, or manual overlay fallback is approved for product visual generation."),
    source: cleanString(options.source || "workflow-backend"),
    notes: cleanString(options.notes || ""),
    recordedBy: cleanString(options.recordedBy || "local-user"),
    recordedAt: now
  };
  return writeDecisionArtifact(job, {
    artifactKey: "codexPptBackendDecision",
    fileStem: "backend",
    eventType: "codex-ppt.backend.recorded",
    eventMessage: "Recorded codex-ppt backend decision",
    payload,
    markdown: buildBackendMarkdown(payload)
  });
}

async function writeDecisionArtifact(job, { artifactKey, fileStem, eventType, eventMessage, payload, markdown }) {
  const decisionDir = path.join(job.rootDir, "codex-ppt");
  await fs.mkdir(decisionDir, { recursive: true });
  const jsonPath = path.join(decisionDir, `${fileStem}.json`);
  const markdownPath = path.join(decisionDir, `${fileStem}.md`);
  await fs.writeFile(jsonPath, JSON.stringify(payload, null, 2), "utf8");
  await fs.writeFile(markdownPath, markdown, "utf8");
  const [jsonStat, markdownStat] = await Promise.all([fs.stat(jsonPath), fs.stat(markdownPath)]);
  job.artifacts = {
    ...(job.artifacts || {}),
    [artifactKey]: {
      kind: payload.kind,
      path: jsonPath,
      markdownPath,
      relativePath: path.relative(rootDir, jsonPath),
      markdownRelativePath: path.relative(rootDir, markdownPath),
      source: payload.source,
      title: payload.title || "",
      provider: payload.provider || "",
      baseUrl: payload.baseUrl || "",
      model: payload.model || "",
      styleBrief: payload.styleBrief || "",
      configured: payload.configured,
      enabled: payload.enabled,
      size: jsonStat.size,
      markdownSize: markdownStat.size,
      sha256: await hashFile(jsonPath),
      markdownSha256: await hashFile(markdownPath),
      createdAt: payload.recordedAt
    }
  };
  job.events = appendEvent(job.events, {
    type: eventType,
    message: eventMessage,
    details: { source: payload.source, path: jsonPath },
    createdAt: payload.recordedAt
  });
  return saveWorkflowJob(job);
}

function buildStyleMarkdown(payload) {
  const lines = [
    `# ${payload.title}`,
    "",
    `- Source: ${payload.source}`,
    `- Recorded by: ${payload.recordedBy}`,
    `- Recorded at: ${payload.recordedAt}`,
    "",
    "## Style Brief",
    "",
    payload.styleBrief,
    "",
    "## Constraints",
    "",
    payload.constraints
  ];
  if (payload.audience) lines.push("", `- Audience: ${payload.audience}`);
  if (payload.tone) lines.push(`- Tone: ${payload.tone}`);
  if (payload.references.length) {
    lines.push("", "## References", "");
    for (const reference of payload.references) lines.push(`- ${reference}`);
  }
  if (payload.notes) lines.push("", "## Notes", "", payload.notes);
  return `${lines.join("\n")}\n`;
}

function buildBackendMarkdown(payload) {
  const lines = [
    "# Codex PPT Backend Decision",
    "",
    `- Source: ${payload.source}`,
    `- Provider: ${payload.provider || "unknown"}`,
    `- Base URL: ${payload.baseUrl || "not recorded"}`,
    `- Model: ${payload.model || "not recorded"}`,
    `- Enabled: ${payload.enabled ? "yes" : "no"}`,
    `- Configured: ${payload.configured ? "yes" : "no"}`,
    `- Recorded by: ${payload.recordedBy}`,
    `- Recorded at: ${payload.recordedAt}`,
    "",
    "## Policy",
    "",
    payload.policy,
    "",
    "## Fallback Status",
    "",
    payload.fallbackStatus
  ];
  if (payload.notes) lines.push("", "## Notes", "", payload.notes);
  return `${lines.join("\n")}\n`;
}

function defaultStyleBrief(job = {}) {
  const brief = cleanString(job.input?.sourceBrief || job.input?.notes || "");
  if (brief) return `Create a visually unified, premium presentation system based on the source brief: ${brief}`;
  return "Create a visually unified, premium business presentation system with clear hierarchy, restrained typography, and role-specific slide composition.";
}

function normalizeReferences(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => cleanString(item)).filter(Boolean).slice(0, 50);
}

async function hashFile(filePath) {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function appendEvent(events = [], event) {
  return [...(Array.isArray(events) ? events : []), {
    id: `evt_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
    ...event
  }].slice(-500);
}

function cleanString(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 1000);
}
