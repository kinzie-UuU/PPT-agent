import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

const requests = new Map();
const TTL_MS = 24 * 60 * 60 * 1000;
const recordRoot = path.join(os.tmpdir(), "ppt-agent-idempotency");
const DISK_PRUNE_INTERVAL_MS = 60 * 1000;
let lastDiskPruneAt = 0;

export function requestIdempotency(req, res, next) {
  if (!req.path?.startsWith("/api/") || !["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
  const requestId = String(req.get("X-PPT-Agent-Request-Id") || "").trim();
  if (!requestId) return next();
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(requestId)) {
    return res.status(400).json({ ok: false, code: "INVALID_REQUEST_ID", error: "Invalid request id" });
  }

  pruneExpired();
  const key = `${req.method}:${req.path}:${requestId}`;
  const fingerprint = requestFingerprint(req);
  const existing = requests.get(key);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      return res.status(409).json({ ok: false, code: "REQUEST_ID_CONFLICT", error: "Request id was reused with a different payload" });
    }
    return replay(existing, res);
  }
  if (fs.existsSync(recoveringRecordPath(key))) {
    return res.status(409).json({ ok: false, code: "REQUEST_IN_PROGRESS", error: "Another process is recovering the original request." });
  }
  const persisted = readRecord(key);
  let recoveredRecordPath = "";
  if (persisted) {
    if (persisted.fingerprint !== fingerprint) {
      return res.status(409).json({ ok: false, code: "REQUEST_ID_CONFLICT", error: "Request id was reused with a different payload" });
    }
    if (persisted.state === "complete" && persisted.response) return replayPersisted(persisted.response, res);
    if (isProcessAlive(persisted.pid)) {
      return res.status(409).json({ ok: false, code: "REQUEST_IN_PROGRESS", error: "The original request is still running." });
    }
    if (String(req.get("X-PPT-Agent-Recover-Pending") || "") !== "1") {
      return res.status(409).json({
        ok: false,
        code: "REQUEST_RECOVERY_REQUIRED",
        error: "The original request may have survived a service restart. Refresh workflow state, then retry the same action to recover it."
      });
    }
    if (!isAutomaticRecoverySafe(req)) {
      return res.status(409).json({
        ok: false,
        code: "REQUEST_MANUAL_RECONCILIATION_REQUIRED",
        error: "The original write may already have produced side effects. Verify workflow state before explicitly discarding the pending request marker."
      });
    }
    recoveredRecordPath = claimAbandonedRecord(key);
    if (!recoveredRecordPath) {
      return res.status(409).json({ ok: false, code: "REQUEST_IN_PROGRESS", error: "Another process is recovering the original request." });
    }
  }

  let settle;
  const entry = {
    fingerprint,
    createdAt: Date.now(),
    expiresAt: Date.now() + TTL_MS,
    response: null,
    completed: new Promise((resolve) => { settle = resolve; })
  };
  writeRecord(key, { state: "pending", fingerprint, pid: process.pid, createdAt: entry.createdAt, expiresAt: entry.expiresAt });
  if (recoveredRecordPath) {
    try { fs.unlinkSync(recoveredRecordPath); } catch {}
  }
  entry.expiryTimer = setTimeout(() => {
    if (entry.response) return;
    requests.delete(key);
    settle(null);
  }, TTL_MS);
  entry.expiryTimer.unref?.();
  requests.set(key, entry);

  const originalJson = res.json.bind(res);
  res.json = (payload) => {
    if (!entry.response) {
      entry.response = { status: res.statusCode, payload };
      writeRecord(key, { state: "complete", fingerprint, response: entry.response, createdAt: entry.createdAt, expiresAt: entry.expiresAt });
      clearTimeout(entry.expiryTimer);
      settle(entry.response);
    }
    return originalJson(payload);
  };
  next();
}

function replayPersisted(response, res) {
  res.set("X-PPT-Agent-Idempotent-Replay", "1");
  return res.status(response.status).json(response.payload);
}

async function replay(entry, res) {
  const response = entry.response || await entry.completed;
  if (!response) return res.status(409).json({ ok: false, code: "REQUEST_RESULT_UNAVAILABLE", error: "Original request did not produce a reusable result" });
  res.set("X-PPT-Agent-Idempotent-Replay", "1");
  return res.status(response.status).json(response.payload);
}

function requestFingerprint(req) {
  return crypto.createHash("sha256")
    .update(JSON.stringify({ query: req.query || {}, body: req.body || null }))
    .digest("hex");
}

function pruneExpired() {
  const now = Date.now();
  for (const [key, entry] of requests) {
    if (entry.expiresAt <= now) requests.delete(key);
  }
  if (now - lastDiskPruneAt < DISK_PRUNE_INTERVAL_MS) return;
  lastDiskPruneAt = now;
  try {
    for (const name of fs.readdirSync(recordRoot)) {
      const file = path.join(recordRoot, name);
      try {
        const stat = fs.statSync(file);
        if (name.endsWith(".tmp") || name.endsWith(".recovering")) {
          if (now - stat.mtimeMs > TTL_MS) fs.unlinkSync(file);
          continue;
        }
        if (!name.endsWith(".json")) continue;
        const record = JSON.parse(fs.readFileSync(file, "utf8"));
        if (Number(record.expiresAt || 0) <= now) fs.unlinkSync(file);
      } catch {}
    }
  } catch {}
}

function claimAbandonedRecord(key) {
  const file = recordPath(key);
  const recovering = recoveringRecordPath(key);
  try {
    fs.renameSync(file, recovering);
    const record = JSON.parse(fs.readFileSync(recovering, "utf8"));
    fs.writeFileSync(recovering, `${JSON.stringify({ ...record, recoveryPid: process.pid, recoveryStartedAt: Date.now() })}\n`, "utf8");
    return recovering;
  } catch {
    return "";
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function isAutomaticRecoverySafe(req) {
  return req.method === "POST" && /\/preflight$/.test(req.path || "");
}

export function resolveIdempotencyRecord({ method, requestPath, requestId }) {
  const normalizedMethod = String(method || "").trim().toUpperCase();
  const normalizedPath = String(requestPath || "").trim();
  const normalizedId = String(requestId || "").trim();
  if (!normalizedMethod || !normalizedPath.startsWith("/api/") || !normalizedId) {
    const error = new Error("method, requestPath and requestId are required");
    error.status = 400;
    error.code = "INVALID_IDEMPOTENCY_RESOLUTION";
    throw error;
  }
  const key = `${normalizedMethod}:${normalizedPath}:${normalizedId}`;
  const active = requests.get(key);
  if (active && !active.response) {
    const error = new Error("The request is still running in this service process");
    error.status = 409;
    error.code = "REQUEST_IN_PROGRESS";
    throw error;
  }
  if (active?.response) {
    const error = new Error("The request already has a reusable completed result");
    error.status = 409;
    error.code = "IDEMPOTENCY_RESULT_ALREADY_COMPLETE";
    throw error;
  }
  const persisted = readRecord(key);
  if (persisted?.state === "complete") {
    const error = new Error("The request already has a reusable completed result");
    error.status = 409;
    error.code = "IDEMPOTENCY_RESULT_ALREADY_COMPLETE";
    throw error;
  }
  if (persisted?.pid && isProcessAlive(persisted.pid)) {
    const error = new Error("The request owner process is still running");
    error.status = 409;
    error.code = "REQUEST_IN_PROGRESS";
    throw error;
  }
  const recoveringFile = recoveringRecordPath(key);
  if (fs.existsSync(recoveringFile)) {
    const recoveryStat = fs.statSync(recoveringFile);
    const recovery = JSON.parse(fs.readFileSync(recoveringFile, "utf8"));
    const recoveryActive = recovery?.recoveryPid
      ? isProcessAlive(recovery.recoveryPid)
      : Date.now() - recoveryStat.mtimeMs <= 10000;
    if (recoveryActive) {
      const error = new Error("The request is currently being recovered by another process");
      error.status = 409;
      error.code = "REQUEST_IN_PROGRESS";
      throw error;
    }
  }
  requests.delete(key);
  let removed = false;
  for (const file of [recordPath(key), recoveringRecordPath(key)]) {
    try {
      fs.unlinkSync(file);
      removed = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return { removed, method: normalizedMethod, requestPath: normalizedPath, requestId: normalizedId };
}

function recordPath(key) {
  return path.join(recordRoot, `${crypto.createHash("sha256").update(key).digest("hex")}.json`);
}

function recoveringRecordPath(key) {
  return `${recordPath(key)}.recovering`;
}

function readRecord(key) {
  const file = recordPath(key);
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Number(record.expiresAt || 0) <= Date.now()) {
      fs.unlinkSync(file);
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

function writeRecord(key, record) {
  fs.mkdirSync(recordRoot, { recursive: true });
  const file = recordPath(key);
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(record)}\n`, "utf8");
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) {
      try { fs.unlinkSync(temp); } catch {}
    }
  }
}

export function requestIdempotencyCacheSize() {
  pruneExpired();
  return requests.size;
}
