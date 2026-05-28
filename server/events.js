export function makeEvent(type, message, details = {}) {
  return {
    type,
    message,
    details,
    createdAt: new Date().toISOString()
  };
}

export function addEvent(job, type, message, details = {}) {
  job.events = [...(job.events || []), makeEvent(type, message, details)];
  return job;
}
