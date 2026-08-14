import crypto from "crypto";
import { execFile as execFileCallback } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";

const lockTails = new Map();
const lockRoot = path.join(os.tmpdir(), "ppt-agent-job-locks");
const LOCK_WAIT_MS = 120000;
const LOCK_HEARTBEAT_MS = 30000;
const INVALID_LOCK_GRACE_MS = 10000;
const processToken = crypto.randomUUID();
const processStartedAt = Date.now() - Math.round(process.uptime() * 1000);
const processMarker = path.join(lockRoot, `process-${process.pid}-${processToken}.alive`);
const execFile = promisify(execFileCallback);
const processStartCache = new Map();
let processMarkerStarted = false;

export async function withWorkflowJobLock(jobId, operation) {
  const key = String(jobId || "").trim();
  if (!key) return operation();

  const previous = lockTails.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => {}).then(() => gate);
  lockTails.set(key, tail);

  await previous.catch(() => {});
  let fileLease = null;
  try {
    fileLease = await acquireFileLease(key);
    return await operation();
  } finally {
    try {
      await releaseFileLease(fileLease);
    } finally {
      release();
      if (lockTails.get(key) === tail) lockTails.delete(key);
    }
  }
}

async function acquireFileLease(key) {
  await ensureProcessMarker();
  const file = path.join(lockRoot, `${crypto.createHash("sha256").update(key).digest("hex")}.lock`);
  const reclaimFile = `${file}.reclaim`;
  const token = crypto.randomUUID();
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    if (await fileExists(reclaimFile)) {
      const reclaimOwner = await readLease(reclaimFile);
      const reclaimStat = reclaimOwner ? null : await fs.stat(reclaimFile).catch(() => null);
      const reclaimInvalid = reclaimStat && Date.now() - reclaimStat.mtimeMs > INVALID_LOCK_GRACE_MS;
      if ((reclaimOwner && !(await isLeaseOwnerAlive(reclaimOwner, reclaimFile))) || reclaimInvalid) {
        await removeAbandonedLeaseFile(reclaimFile, reclaimOwner);
      }
      await delay(50);
      continue;
    }
    let created = false;
    try {
      await fs.writeFile(file, JSON.stringify({ token, pid: process.pid, processToken, processStartedAt, key, createdAt: new Date().toISOString() }), { encoding: "utf8", flag: "wx" });
      created = true;
      const handle = await fs.open(file, "r+");
      const heartbeat = setInterval(() => {
        const now = new Date();
        handle.utimes(now, now).catch(() => {});
      }, LOCK_HEARTBEAT_MS);
      heartbeat.unref?.();
      return { file, token, handle, heartbeat };
    } catch (error) {
      if (created && !(await removeOwnedLeaseFile(file, token))) error.code = "WORKFLOW_JOB_LOCK_ROLLBACK_FAILED";
      if (error?.code !== "EEXIST") throw error;
      const owner = await readLease(file);
      const stat = owner ? null : await fs.stat(file).catch(() => null);
      const invalidAbandoned = stat && Date.now() - stat.mtimeMs > INVALID_LOCK_GRACE_MS;
      if (owner?.abandoned || (owner?.pid && !(await isLeaseOwnerAlive(owner, file))) || invalidAbandoned) await reclaimAbandonedLease(file, reclaimFile, key);
      await delay(50);
    }
  }
  const error = new Error(`Timed out waiting for workflow job lock: ${key}`);
  error.code = "WORKFLOW_JOB_LOCK_TIMEOUT";
  throw error;
}

async function reclaimAbandonedLease(file, reclaimFile, key) {
  const token = crypto.randomUUID();
  let handle;
  let created = false;
  try {
    await fs.writeFile(reclaimFile, JSON.stringify({ token, pid: process.pid, processToken, processStartedAt, key, createdAt: new Date().toISOString() }), { encoding: "utf8", flag: "wx" });
    created = true;
    handle = await fs.open(reclaimFile, "r+");
  } catch (error) {
    await handle?.close().catch(() => {});
    if (created && !(await removeOwnedLeaseFile(reclaimFile, token))) error.code = "WORKFLOW_JOB_LOCK_ROLLBACK_FAILED";
    if (error?.code === "EEXIST") return false;
    throw error;
  }
  try {
    const guard = await readLease(reclaimFile);
    if (guard?.token !== token) return false;
    const owner = await readLease(file);
    const stat = owner ? null : await fs.stat(file).catch(() => null);
    if (!owner?.abandoned && ((!owner?.pid && (!stat || Date.now() - stat.mtimeMs <= INVALID_LOCK_GRACE_MS)) || (owner?.pid && await isLeaseOwnerAlive(owner, file)))) return false;
    const staleFile = `${file}.stale.${crypto.randomUUID()}`;
    await fs.rename(file, staleFile);
    await fs.unlink(staleFile).catch(() => {});
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  } finally {
    await handle.close().catch(() => {});
    if (!(await removeOwnedLeaseFile(reclaimFile, token))) {
      const error = new Error(`Failed to release workflow reclaim lease: ${key}`);
      error.code = "WORKFLOW_JOB_LOCK_ROLLBACK_FAILED";
      throw error;
    }
  }
}

async function readLease(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function isLeaseOwnerAlive(owner, leaseFile = "") {
  if (!owner?.pid || !isProcessAlive(owner.pid)) return false;
  const actualStartedAt = await getProcessStartedAt(owner.pid);
  if (owner.processStartedAt && actualStartedAt) {
    return Math.abs(Number(owner.processStartedAt) - actualStartedAt) <= 5000;
  }
  if (!owner.processToken) {
    const leaseCreatedAt = Date.parse(owner.createdAt || "");
    if (actualStartedAt && Number.isFinite(leaseCreatedAt) && actualStartedAt > leaseCreatedAt + 5000) return false;
    return true;
  }
  const marker = path.join(lockRoot, `process-${owner.pid}-${owner.processToken}.alive`);
  return fileExists(marker);
}

async function getProcessStartedAt(pid) {
  const numericPid = Number(pid);
  if (numericPid === process.pid) return processStartedAt;
  const cached = processStartCache.get(numericPid);
  if (cached && Date.now() - cached.checkedAt < 5000) return cached.startedAt;
  if (process.platform !== "win32") return 0;
  try {
    const { stdout } = await execFile("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Process -Id ${numericPid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`
    ], { windowsHide: true, timeout: 5000 });
    const startedAt = Date.parse(String(stdout || "").trim()) || 0;
    processStartCache.set(numericPid, { startedAt, checkedAt: Date.now() });
    return startedAt;
  } catch {
    return 0;
  }
}

async function ensureProcessMarker() {
  if (processMarkerStarted) return;
  await fs.mkdir(lockRoot, { recursive: true });
  await fs.writeFile(processMarker, JSON.stringify({ pid: process.pid, processToken, processStartedAt, createdAt: new Date().toISOString() }), "utf8");
  const heartbeat = setInterval(() => {
    const now = new Date();
    fs.utimes(processMarker, now, now).catch(() => {});
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref?.();
  processMarkerStarted = true;
}

async function removeAbandonedLeaseFile(file, observed) {
  const quarantine = `${file}.stale.${crypto.randomUUID()}`;
  try {
    await fs.rename(file, quarantine);
  } catch (error) {
    if (["ENOENT", "EACCES", "EPERM"].includes(error?.code)) return false;
    throw error;
  }
  const moved = await readLease(quarantine);
  const sameOwner = observed?.token ? moved?.token === observed.token : !moved;
  if (!sameOwner) {
    await fs.rename(quarantine, file).catch(() => {});
    return false;
  }
  await fs.unlink(quarantine).catch(() => {});
  return true;
}

async function removeOwnedLeaseFile(file, token) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await readLease(file);
    if (current?.token !== token) return true;
    try {
      await fs.unlink(file);
      return true;
    } catch (error) {
      if (!["EACCES", "EPERM", "EBUSY"].includes(error?.code)) break;
      await delay(50);
    }
  }
  const quarantine = `${file}.rollback.${crypto.randomUUID()}`;
  try {
    await fs.rename(file, quarantine);
    await fs.unlink(quarantine).catch(() => {});
    return true;
  } catch {}
  const current = await readLease(file);
  if (current?.token !== token) return true;
  try {
    await fs.writeFile(file, JSON.stringify({ ...current, pid: 0, processToken: "", abandoned: true, abandonedAt: new Date().toISOString() }), "utf8");
    return true;
  } catch {
    return false;
  }
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function releaseFileLease(lease) {
  if (!lease?.file || !lease.token) return;
  if (lease.heartbeat) clearInterval(lease.heartbeat);
  await lease.handle?.close().catch(() => {});
  if (!(await removeOwnedLeaseFile(lease.file, lease.token))) {
    const error = new Error(`Failed to release workflow job lock: ${lease.file}`);
    error.code = "WORKFLOW_JOB_LOCK_ROLLBACK_FAILED";
    throw error;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function workflowJobLockCount() {
  return lockTails.size;
}

export async function cleanupAbandonedWorkflowJobLocks() {
  await ensureProcessMarker();
  const now = Date.now();
  let removed = 0;
  for (const name of await fs.readdir(lockRoot)) {
    if (!name.endsWith(".lock") && !name.endsWith(".reclaim")) continue;
    const file = path.join(lockRoot, name);
    const owner = await readLease(file);
    const stat = owner ? null : await fs.stat(file).catch(() => null);
    const abandoned = Boolean(owner?.abandoned) || (owner?.pid
      ? !(await isLeaseOwnerAlive(owner, file))
      : Boolean(stat && now - stat.mtimeMs > INVALID_LOCK_GRACE_MS));
    if (!abandoned) continue;
    if (name.endsWith(".lock")) {
      if (await reclaimAbandonedLease(file, `${file}.reclaim`, owner?.key || name)) removed += 1;
    } else if (await removeAbandonedLeaseFile(file, owner)) {
      removed += 1;
    }
  }
  return removed;
}
