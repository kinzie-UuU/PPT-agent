export function claimWorkflowSelection(selectionRef, id = "") {
  const selection = {
    epoch: Number(selectionRef.current?.epoch || 0) + 1,
    id: String(id || "")
  };
  selectionRef.current = selection;
  return selection;
}

export function isWorkflowSelectionCurrent(selectionRef, selection, id = selection?.id || "") {
  return Boolean(selection)
    && Number(selectionRef.current?.epoch || 0) === selection.epoch
    && String(selectionRef.current?.id || "") === String(id || "");
}

export function canApplyWorkflowJob(selectionRef, nextJobId = "") {
  const selectedId = String(selectionRef.current?.id || "");
  const candidateId = String(nextJobId || "");
  return !candidateId || !selectedId || selectedId === candidateId;
}

export function mergeWorkflowJobPage(currentJobs = [], pageJobs = [], { activeJob = null, append = false } = {}) {
  const candidates = append
    ? [activeJob, ...currentJobs, ...pageJobs]
    : [activeJob, ...pageJobs];
  const byId = new Map();
  for (const job of candidates) {
    if (!job?.id || byId.has(job.id)) continue;
    byId.set(job.id, job);
  }
  return [...byId.values()];
}
