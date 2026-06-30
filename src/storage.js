import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const dbPath = resolve("data/jobs.json");
const outboxPath = resolve("data/outbox.json");

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
