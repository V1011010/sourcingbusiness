import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

const dataDir = config.dataDir || "data";
const dbPath = resolve(dataDir, "jobs.json");
const outboxPath = resolve(dataDir, "outbox.json");

function ensureFile(path, fallback) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(path)) writeFileSync(path, JSON.stringify(fallback, null, 2));
}

export function readJobs() {
  ensureFile(dbPath, { jobs: [] });
  return JSON.parse(readFileSync(dbPath, "utf8")).jobs;
}

export function writeJobs(jobs) {
  ensureFile(dbPath, { jobs: [] });
  writeFileSync(dbPath, JSON.stringify({ jobs }, null, 2));
}

export function upsertJob(job) {
  const jobs = readJobs();
  const index = jobs.findIndex((existing) => existing.id === job.id);
  if (index === -1) jobs.push(job);
  else jobs[index] = job;
  writeJobs(jobs);
  return job;
}

export function getJob(id) {
  return readJobs().find((job) => job.id === id || job.publicToken === id);
}

export function addTimeline(job, type, message, meta = {}) {
  job.timeline ||= [];
  job.timeline.push({
    id: randomUUID(),
    type,
    message,
    meta,
    at: new Date().toISOString()
  });
  job.updatedAt = new Date().toISOString();
  return job;
}

export function appendOutbox(message) {
  ensureFile(outboxPath, { messages: [] });
  const current = JSON.parse(readFileSync(outboxPath, "utf8"));
  current.messages.push({
    id: randomUUID(),
    ...message,
    at: new Date().toISOString()
  });
  writeFileSync(outboxPath, JSON.stringify(current, null, 2));
}

export function recordEmailAudit(job, message) {
  if (!job) return null;
  job.emailLog ||= [];
  const templateName = String(message?.templateName || "unknown");
  const recipient = String(message?.to || "");
  const resendCount = job.emailLog.filter((entry) => (
    entry.templateName === templateName && String(entry.to || "") === recipient
  )).length + 1;
  const result = message?.result || {};
  const entry = {
    id: randomUUID(),
    templateName,
    audience: message?.audience || "customer",
    to: recipient,
    subject: message?.subject || "",
    ok: Boolean(result.ok),
    blocked: Boolean(result.blocked),
    relayed: Boolean(result.relayed),
    dryRun: Boolean(result.dryRun),
    skipped: Boolean(result.skipped),
    provider: result.provider || "",
    reason: String(result.reason || ""),
    providerId: result.id || result.providerId || null,
    resendCount,
    at: new Date().toISOString()
  };
  job.emailLog.push(entry);
  job.updatedAt = entry.at;
  return entry;
}

export function storageHealth() {
  return {
    dataDirConfigured: dataDir !== "data",
    dataDir
  };
}
