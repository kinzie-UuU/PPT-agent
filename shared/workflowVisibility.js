const INTERNAL_WORKFLOW_PATTERN = /\b(regression|smoke-e2e|product-visual-readiness|codex-slide-negative)\b/i;

export function isInternalWorkflowJob(job = {}) {
  const visibility = String(job.visibility || job.input?.visibility || "").trim().toLowerCase();
  if (visibility === "public") return false;
  if (visibility === "internal") return true;
  if (job.internal === true || job.input?.internal === true) return true;

  const text = [
    job.input?.mode,
    job.input?.sourceOriginalName,
    job.input?.notes,
    ...(Array.isArray(job.events) ? job.events.map((event) => `${event.type || ""} ${event.message || ""}`) : [])
  ].filter(Boolean).join(" ");
  return INTERNAL_WORKFLOW_PATTERN.test(text);
}
