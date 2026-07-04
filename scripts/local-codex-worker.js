import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

loadDotEnv(resolve(".env"));

const args = new Set(process.argv.slice(2));
const once = args.has("--once");
const workerId = process.env.LOCAL_CODEX_WORKER_ID || `arcovia-local-codex-${randomUUID().slice(0, 8)}`;
const baseUrl = (process.env.PUBLIC_BASE_URL || "https://sourcingbusiness.onrender.com").replace(/\/$/, "");
const workerSecret = process.env.ARCOVIA_LOCAL_WORKER_SECRET || process.env.ARCOVIA_FLOW_SECRET || "";
const pollSeconds = Math.max(15, Number(process.env.LOCAL_CODEX_WORKER_POLL_SECONDS || 60));
const codexBin = process.env.CODEX_BIN || findCodexBin();
const schemaPath = resolve("scripts/codex-sourcing-schema.json");
const runtimeDir = resolve("data/local-codex-worker");

if (!workerSecret) {
  console.error("Missing ARCOVIA_LOCAL_WORKER_SECRET or ARCOVIA_FLOW_SECRET in .env.");
  process.exit(1);
}

if (!existsSync(runtimeDir)) mkdirSync(runtimeDir, { recursive: true });

console.log(`[Arcovia local Codex worker] started as ${workerId}`);
console.log(`[Arcovia local Codex worker] backend: ${baseUrl}`);
console.log(`[Arcovia local Codex worker] poll interval: ${pollSeconds}s`);

do {
  try {
    const claimed = await claimJob();
    if (claimed?.job) {
      await processJob(claimed.job);
    } else {
      console.log(`[${timestamp()}] no ready jobs`);
    }
  } catch (error) {
    console.error(`[${timestamp()}] worker loop error: ${error.message}`);
    if (once) process.exitCode = 1;
  }

  if (!once) await sleep(pollSeconds * 1000);
} while (!once);

async function claimJob() {
  const response = await fetch(`${baseUrl}/local-worker/claim`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Arcovia-Worker-Secret": workerSecret
    },
    body: JSON.stringify({ worker_id: workerId })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Claim failed: ${response.status} ${JSON.stringify(data)}`);
  }

  return data.claimed ? data : null;
}

async function processJob(job) {
  const outputPath = resolve(runtimeDir, `${safeFileName(job.order_name || job.id)}-${Date.now()}.json`);
  const promptPath = resolve(runtimeDir, `${safeFileName(job.order_name || job.id)}-${Date.now()}-prompt.txt`);
  const startedAt = new Date().toISOString();

  writeFileSync(promptPath, job.prompt, "utf8");
  console.log(`[${timestamp()}] claimed ${job.order_name} (${job.research_pass_title})`);

  try {
    await runCodex(job.prompt, outputPath);
    const report = JSON.parse(readFileSync(outputPath, "utf8"));
    const result = await submitReport(job, report, startedAt);
    console.log(`[${timestamp()}] submitted ${job.order_name}: status=${result.status}, suppliers=${result.suppliers ?? "n/a"}`);
  } catch (error) {
    console.error(`[${timestamp()}] local Codex research failed for ${job.order_name}: ${error.message}`);
    await submitError(job, error);
  }
}

function runCodex(prompt, outputPath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(codexBin, [
      "exec",
      "-",
      "--sandbox",
      "read-only",
      "--output-schema",
      schemaPath,
      "-o",
      outputPath
    ], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      process.stdout.write(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });

    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code !== 0) {
        rejectPromise(new Error(`codex exec exited with ${code}: ${stderr || stdout}`.slice(0, 2000)));
        return;
      }
      if (!existsSync(outputPath)) {
        rejectPromise(new Error("codex exec completed but did not write the expected JSON output file."));
        return;
      }
      resolvePromise();
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function submitReport(job, report, startedAt) {
  const response = await fetch(`${baseUrl}/local-worker/report`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Arcovia-Worker-Secret": workerSecret
    },
    body: JSON.stringify({
      worker_id: workerId,
      job_id: job.id,
      attempt: job.attempt,
      started_at: startedAt,
      report
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Report submit failed: ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function submitError(job, error) {
  const response = await fetch(`${baseUrl}/local-worker/report`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Arcovia-Worker-Secret": workerSecret
    },
    body: JSON.stringify({
      worker_id: workerId,
      job_id: job.id,
      attempt: job.attempt,
      error: {
        message: String(error?.message || error || "Unknown local Codex worker error")
      }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`[${timestamp()}] failed to submit worker error: ${response.status} ${text}`);
  }
}

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value.replace(/^["']|["']$/g, "");
    }
  }
}

function findCodexBin() {
  const candidates = [
    process.env.USERPROFILE ? resolve(process.env.USERPROFILE, ".codex/.sandbox-bin/codex.exe") : "",
    process.env.USERPROFILE ? resolve(process.env.USERPROFILE, ".codex/plugins/.plugin-appserver/codex.exe") : "",
    "codex"
  ];

  return candidates.find((candidate) => candidate && (candidate === "codex" || existsSync(candidate))) || "codex";
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function safeFileName(value) {
  return String(value || "job").replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "job";
}

function timestamp() {
  return new Date().toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" });
}
