import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

loadDotEnv(resolve(".env"));

const args = new Set(process.argv.slice(2));
const once = args.has("--once");
const singleAgent = args.has("--single-agent");
const workerId = process.env.LOCAL_CODEX_WORKER_ID || `arcovia-local-codex-${randomUUID().slice(0, 8)}`;
const baseUrl = (process.env.PUBLIC_BASE_URL || "https://sourcingbusiness.onrender.com").replace(/\/$/, "");
const workerSecret = process.env.ARCOVIA_LOCAL_WORKER_SECRET || process.env.ARCOVIA_FLOW_SECRET || "";
const pollSeconds = Math.max(15, Number(process.env.LOCAL_CODEX_WORKER_POLL_SECONDS || 60));
const codexBin = process.env.CODEX_BIN || findCodexBin();
const codexModel = process.env.LOCAL_CODEX_MODEL || "gpt-5.6-luna";
const codexReasoningEffort = process.env.LOCAL_CODEX_REASONING_EFFORT || "low";
const workerEnv = buildWorkerEnv();
const schemaPath = resolve("scripts/codex-sourcing-schema.json");
const runtimeDir = resolve("data/local-codex-worker");
const multiAgentEnabled = !singleAgent && envFlag("LOCAL_CODEX_MULTI_AGENT_ENABLED", true);
const agentConcurrency = Math.max(1, Math.min(5, Number(process.env.LOCAL_CODEX_AGENT_CONCURRENCY || 2)));
const agentProfiles = [
  {
    id: "online_retail",
    label: "Online stores and marketplaces agent",
    focus: [
      "Find direct online purchase routes, official stores, boutiques, marketplaces, resale listings, distributors, and specialist ecommerce stores.",
      "Prioritize exact product match, stock/size/condition, live price, checkout availability, customer location delivery, and clear product images.",
      "Reject counterfeit, replica, private-seller, no-checkout, suspiciously cheap, or sold-out sources unless they are useful reference/rejected evidence."
    ]
  },
  {
    id: "local_physical_services",
    label: "Local physical stores and services agent",
    focus: [
      "Find local physical stores, pickup routes, service providers, nearby professionals, directories, portfolios, Google/social presence, and phone/contact evidence.",
      "For services, prioritize location/service area, portfolio proof, reviews, complaint signals, budget fit, response channels, and whether the provider can realistically perform the requested work.",
      "For products, include in-store leads only when the store looks legitimate and the lead is useful for Arcovia human follow-up."
    ]
  },
  {
    id: "manufacturers_wholesale_fabrics",
    label: "Manufacturers, wholesalers, and fabrics agent",
    focus: [
      "Find factories, manufacturers, workshops, fabric/textile shops, mills, wholesalers, OEM/ODM suppliers, trade directories, leather/material specialists, and sample/swatch options.",
      "Prioritize capabilities, MOQ, lead time, material/spec match, sample/prototype support, export ability, business identity, and verified contact details.",
      "Reject vague directories, unverifiable suppliers, mismatched materials, and sources without enough business proof."
    ]
  },
  {
    id: "trust_risk",
    label: "Trust, reviews, and risk agent",
    focus: [
      "Deep-check the best candidates from broad search angles for scam signals, bad reviews, HelloPeter where relevant, social media legitimacy, business registration clues, refund/returns policy, payment risk, and delivery complaints.",
      "Move unsafe options to rejected_sources with factual reasons and evidence URLs.",
      "Do not approve a candidate unless there is enough evidence that Arcovia can safely recommend it for human review."
    ]
  },
  {
    id: "shipping_total_cost",
    label: "Shipping, import, and total cost agent",
    focus: [
      "Estimate the full customer cost in South African Rand, including item/service price, delivery, international shipping, VAT/duties/import handling, courier/forwarder fees, and Arcovia handling assumptions where relevant.",
      "Find shipping agents or parcel forwarders only when useful and check their route, costs, risk, and evidence.",
      "Include over-budget options if they are real and explain why final checkout verification is still needed."
    ]
  }
];

if (!workerSecret) {
  console.error("Missing ARCOVIA_LOCAL_WORKER_SECRET or ARCOVIA_FLOW_SECRET in .env.");
  process.exit(1);
}

if (!existsSync(runtimeDir)) mkdirSync(runtimeDir, { recursive: true });

console.log(`[Arcovia local Codex worker] started as ${workerId}`);
console.log(`[Arcovia local Codex worker] backend: ${baseUrl}`);
console.log(`[Arcovia local Codex worker] poll interval: ${pollSeconds}s`);
console.log(`[Arcovia local Codex worker] mode: ${multiAgentEnabled ? `multi-agent (${agentProfiles.length} agents, concurrency ${agentConcurrency})` : "single-agent"}`);

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
  const runId = `${safeFileName(job.order_name || job.id)}-${Date.now()}`;
  const outputPath = resolve(runtimeDir, `${runId}.json`);
  const promptPath = resolve(runtimeDir, `${runId}-prompt.txt`);
  const startedAt = new Date().toISOString();

  writeFileSync(promptPath, job.prompt, "utf8");
  console.log(`[${timestamp()}] claimed ${job.order_name} (${job.research_pass_title})`);

  try {
    const report = multiAgentEnabled
      ? await runCodexAgentTeam(job, runId)
      : await runSingleCodexAgent(job.prompt, outputPath);
    writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf8");
    const result = await submitReport(job, report, startedAt);
    console.log(`[${timestamp()}] submitted ${job.order_name}: status=${result.status}, suppliers=${result.suppliers ?? "n/a"}`);
  } catch (error) {
    console.error(`[${timestamp()}] local Codex research failed for ${job.order_name}: ${error.message}`);
    await submitError(job, error);
  }
}

async function runSingleCodexAgent(prompt, outputPath) {
  await runCodex(prompt, outputPath);
  return JSON.parse(readFileSync(outputPath, "utf8"));
}

async function runCodexAgentTeam(job, runId) {
  const agentDir = resolve(runtimeDir, `${runId}-agents`);
  mkdirSync(agentDir, { recursive: true });

  const tasks = agentProfiles.map((profile, index) => async () => {
    const agentPrompt = buildAgentPrompt(job, profile);
    const promptPath = resolve(agentDir, `${String(index + 1).padStart(2, "0")}-${profile.id}-prompt.txt`);
    const outputPath = resolve(agentDir, `${String(index + 1).padStart(2, "0")}-${profile.id}.json`);
    writeFileSync(promptPath, agentPrompt, "utf8");
    console.log(`[${timestamp()}] ${job.order_name}: ${profile.label} started`);
    await runCodex(agentPrompt, outputPath);
    const report = JSON.parse(readFileSync(outputPath, "utf8"));
    console.log(`[${timestamp()}] ${job.order_name}: ${profile.label} finished (${listLength(report.sources)} sources, ${listLength(report.rejected_sources)} rejected)`);
    return { profile, report };
  });

  const settled = await runWithConcurrency(tasks, agentConcurrency);
  const successes = settled.filter((result) => result.ok).map((result) => result.value);
  const failures = settled.filter((result) => !result.ok);
  const incomplete = successes.filter((result) => reportIndicatesIncomplete(result.report));

  if (!successes.length) {
    throw new Error(`All Codex sourcing agents failed: ${failures.map((failure) => failure.error?.message || failure.error).join("; ")}`.slice(0, 2000));
  }

  if (failures.some((failure) => isRetryableAgentFailure(failure.error)) || incomplete.length) {
    const reasons = [
      ...failures.map((failure) => failure.error?.message || failure.error),
      ...incomplete.map((result) => `${result.profile.label} returned an incomplete report`)
    ];
    throw new Error(`Sourcing pass blocked before completion; retry without counting this pass: ${reasons.join("; ")}`.slice(0, 2000));
  }

  if (failures.length) {
    console.error(`[${timestamp()}] ${job.order_name}: ${failures.length} sourcing agent(s) failed but ${successes.length} succeeded`);
  }

  return mergeAgentReports(successes, failures, job);
}

function buildAgentPrompt(job, profile) {
  return `${job.prompt}

Additional multi-agent role:
You are the ${profile.label}.

Focus only on your part of the sourcing job:
${profile.focus.map((line) => `- ${line}`).join("\n")}

Coordination rules:
- Return the same JSON schema as the main sourcing worker.
- It is acceptable if your sources list is smaller than the full report; quality and evidence matter more than volume.
- Do not duplicate low-quality broad search results.
- Do not include supplier/source details intended for customers; this is an internal Arcovia research report only.
- Return JSON only.`;
}

async function runWithConcurrency(tasks, concurrency) {
  const results = new Array(tasks.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const current = nextIndex;
      nextIndex += 1;
      try {
        results[current] = { ok: true, value: await tasks[current]() };
      } catch (error) {
        results[current] = { ok: false, error };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return results;
}

function mergeAgentReports(successes, failures, job) {
  const reports = successes.map((success) => success.report || {});
  const summaryLines = successes.map((success) => {
    const sourceCount = listLength(success.report?.sources);
    const rejectedCount = listLength(success.report?.rejected_sources);
    return `${success.profile.label}: ${textValue(success.report?.summary) || "completed"} (${sourceCount} source(s), ${rejectedCount} rejected).`;
  });
  const failureLines = failures.map((failure) => `Agent failed: ${String(failure.error?.message || failure.error || "unknown error").slice(0, 240)}`);

  return {
    summary: [
      `Multi-agent sourcing completed for ${job.order_name || "this order"}.`,
      ...summaryLines,
      ...failureLines
    ].join("\n").slice(0, 8000),
    missing_customer_details: uniqueStrings(flatMap(reports, "missing_customer_details")).slice(0, 20),
    sources: sortByMostExpensiveFirst(uniqueSources(flatMap(reports, "sources")).map(shapeSource)).slice(0, 40),
    shipping_agents: uniqueSources(flatMap(reports, "shipping_agents")).map(shapeShippingAgent).slice(0, 12),
    rejected_sources: uniqueSources(flatMap(reports, "rejected_sources")).map(shapeRejectedSource).slice(0, 40),
    recommended_next_customer_message: compactText([
      ...reports.map((report) => report?.recommended_next_customer_message),
      failures.length ? `${failures.length} research agent(s) failed; review the successful findings before customer communication.` : ""
    ].filter(Boolean).join("\n"))
  };
}

function runCodex(prompt, outputPath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(codexBin, [
      "exec",
      "-",
      "--model",
      codexModel,
      "--config",
      `model_reasoning_effort=${JSON.stringify(codexReasoningEffort)}`,
      "--ignore-user-config",
      "--enable",
      "standalone_web_search",
      "--disable",
      "shell_tool",
      "--sandbox",
      "read-only",
      "--ephemeral",
      "--output-schema",
      schemaPath,
      "-o",
      outputPath
    ], {
      cwd: process.cwd(),
      env: workerEnv,
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

function shapeSource(source) {
  return {
    name: textValue(source?.name),
    source_type: textValue(source?.source_type),
    url: textValue(source?.url),
    product_match: textValue(source?.product_match),
    image_url: textValue(source?.image_url),
    image_urls: uniqueStrings(source?.image_urls).slice(0, 8),
    reference_image_urls: uniqueStrings(source?.reference_image_urls).slice(0, 8),
    price: textValue(source?.price),
    estimated_total_zar: textValue(source?.estimated_total_zar),
    estimated_total_to_customer: textValue(source?.estimated_total_to_customer),
    over_budget: Boolean(source?.over_budget),
    availability: textValue(source?.availability),
    location: textValue(source?.location),
    delivery_or_pickup: textValue(source?.delivery_or_pickup),
    trust_score: Number.isFinite(Number(source?.trust_score)) ? Number(source.trust_score) : 0,
    risk_level: textValue(source?.risk_level),
    trust_checks: normalizeTrustChecks(source?.trust_checks),
    red_flags: uniqueStrings(source?.red_flags).slice(0, 10),
    evidence_urls: uniqueStrings(source?.evidence_urls).slice(0, 10),
    recommendation: textValue(source?.recommendation)
  };
}

function normalizeTrustChecks(value) {
  const checks = value && typeof value === "object" ? value : {};
  return {
    customer_reviews: textValue(checks.customer_reviews),
    hellopeter: textValue(checks.hellopeter),
    social_media: textValue(checks.social_media),
    website_payment_delivery: textValue(checks.website_payment_delivery),
    business_identity: textValue(checks.business_identity)
  };
}

function shapeShippingAgent(agent) {
  return {
    name: textValue(agent?.name),
    url: textValue(agent?.url),
    countries_supported: textValue(agent?.countries_supported),
    estimated_cost: textValue(agent?.estimated_cost),
    trust_score: Number.isFinite(Number(agent?.trust_score)) ? Number(agent.trust_score) : 0,
    risk_level: textValue(agent?.risk_level),
    evidence_urls: uniqueStrings(agent?.evidence_urls).slice(0, 10),
    notes: textValue(agent?.notes)
  };
}

function shapeRejectedSource(source) {
  return {
    name: textValue(source?.name),
    url: textValue(source?.url),
    image_url: textValue(source?.image_url),
    image_urls: uniqueStrings(source?.image_urls).slice(0, 8),
    reason: textValue(source?.reason),
    evidence_urls: uniqueStrings(source?.evidence_urls).slice(0, 10)
  };
}

function flatMap(reports, key) {
  return reports.flatMap((report) => Array.isArray(report?.[key]) ? report[key] : []);
}

function uniqueSources(items) {
  const seen = new Map();
  for (const item of items || []) {
    const key = normalizeIdentityKey(item);
    if (!key) continue;
    if (!seen.has(key)) {
      seen.set(key, item);
      continue;
    }
    seen.set(key, mergeSource(seen.get(key), item));
  }
  return [...seen.values()];
}

function mergeSource(existing, incoming) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming || {})) {
    if (hasValue(value) && !hasValue(merged[key])) merged[key] = value;
  }
  for (const key of ["image_url", "price", "estimated_total_zar", "estimated_total_to_customer", "availability", "trust_score", "risk_level", "recommendation"]) {
    if (hasValue(incoming?.[key])) merged[key] = incoming[key];
  }
  merged.image_urls = uniqueStrings([...(asArray(existing?.image_urls)), ...(asArray(incoming?.image_urls))]).slice(0, 8);
  merged.reference_image_urls = uniqueStrings([...(asArray(existing?.reference_image_urls)), ...(asArray(incoming?.reference_image_urls))]).slice(0, 8);
  merged.evidence_urls = uniqueStrings([...(asArray(existing?.evidence_urls)), ...(asArray(incoming?.evidence_urls))]).slice(0, 10);
  merged.red_flags = uniqueStrings([...(asArray(existing?.red_flags)), ...(asArray(incoming?.red_flags))]).slice(0, 10);
  return merged;
}

function normalizeIdentityKey(item) {
  return textValue(item?.url || item?.name || item?.source || item?.title).toLowerCase();
}

function sortByMostExpensiveFirst(items) {
  return [...(items || [])].sort((a, b) => priceSortValue(b) - priceSortValue(a));
}

function priceSortValue(item) {
  const value = `${item?.estimated_total_zar || ""} ${item?.estimated_total_to_customer || ""} ${item?.price || ""}`;
  const matches = [...value.matchAll(/(?:R|ZAR|USD|US\$|EUR|GBP|£|\$)?\s*([0-9][0-9\s,.]*)/gi)]
    .map((match) => Number(match[1].replace(/\s/g, "").replace(/,/g, "")))
    .filter((number) => Number.isFinite(number));
  return matches.length ? Math.max(...matches) : -1;
}

function uniqueStrings(values) {
  return [...new Set(asArray(values).map(textValue).filter(Boolean))];
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== undefined && item !== null);
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return textValue(value) !== "";
}

function listLength(value) {
  return Array.isArray(value) ? value.length : 0;
}

function compactText(value) {
  return textValue(value).replace(/\s+\n/g, "\n").slice(0, 4000);
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
  const pluginRuntime = process.env.USERPROFILE
    ? resolve(process.env.USERPROFILE, ".codex/plugins/.plugin-appserver")
    : "";
  const candidates = [
    pluginRuntime && existsSync(resolve(pluginRuntime, "codex-code-mode-host.exe"))
      ? resolve(pluginRuntime, "codex.exe")
      : "",
    process.env.USERPROFILE ? resolve(process.env.USERPROFILE, ".codex/.sandbox-bin/codex.exe") : "",
    "codex"
  ];

  return candidates.find((candidate) => candidate && (candidate === "codex" || existsSync(candidate))) || "codex";
}

function reportIndicatesIncomplete(report) {
  const summary = textValue(report?.summary).toLowerCase();
  const hasEvidence = [
    report?.sources,
    report?.shipping_agents,
    report?.rejected_sources
  ].some((items) => Array.isArray(items) && items.length > 0);

  if (/do not count|could not be completed|unable to complete|failed before execution|tool (host|call|route).*?(missing|failed)|no (live )?(web|browser|shell) (access|tooling)|access is denied|could not start (powershell|the shell)|mcp startup failed/i.test(summary)) {
    return true;
  }

  return !hasEvidence && /blocked|capacity|quota|rate limit|token limit|no jobs available|missing executable/i.test(summary);
}

function isRetryableAgentFailure(error) {
  return /capacity|quota|rate.?limit|token|no jobs available|tool host|code-mode-host|missing.*executable|os error 2|access is denied|createprocessasuserw|mcp startup failed|temporar|timed? out|service unavailable|429|502|503|504/i.test(
    String(error?.message || error || "")
  );
}

function buildWorkerEnv() {
  const env = { ...process.env };
  const gitDir = findGitDir();
  if (gitDir) {
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
    const currentPath = env[pathKey] || "";
    const parts = currentPath.split(";").filter(Boolean);
    if (!parts.some((part) => part.toLowerCase() === gitDir.toLowerCase())) {
      env[pathKey] = [gitDir, currentPath].filter(Boolean).join(";");
    }
  }
  return env;
}

function findGitDir() {
  const candidates = [
    "C:\\Program Files\\Git\\cmd",
    "C:\\Program Files\\Git\\bin",
    process.env.LOCALAPPDATA ? resolve(process.env.LOCALAPPDATA, "GitHubDesktop/app-3.6.1/resources/app/git/cmd") : "",
    process.env.LOCALAPPDATA ? resolve(process.env.LOCALAPPDATA, "GitHubDesktop/app-3.6.1/resources/app/git/bin") : ""
  ];

  return candidates.find((candidate) => candidate && existsSync(resolve(candidate, "git.exe"))) || "";
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function envFlag(name, fallback) {
  if (process.env[name] === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(String(process.env[name] || "").toLowerCase());
}

function safeFileName(value) {
  return String(value || "job").replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "job";
}

function textValue(value) {
  return String(value || "").trim();
}

function timestamp() {
  return new Date().toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" });
}
