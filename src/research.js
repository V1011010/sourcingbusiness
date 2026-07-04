import { config } from "./config.js";
import { sendEmail } from "./email.js";
import {
  adminRefundDue,
  adminReport,
  customerRefundDue,
  researchFailure,
  stageUpdate
} from "./templates.js";
import { addTimeline, getJob, readJobs, upsertJob } from "./storage.js";

const runningJobs = new Set();

export function queueResearch(jobId) {
  if (runningJobs.has(jobId)) return;
  runningJobs.add(jobId);
  setTimeout(async () => {
    try {
      await runResearch(jobId);
    } catch (error) {
      await handleResearchError(jobId, error);
    } finally {
      runningJobs.delete(jobId);
    }
  }, 100);
}

export function queueDueResearchAttempts() {
  const now = new Date();
  for (const job of readJobs()) {
    if (!["researching", "human_review"].includes(job.status)) continue;
    if (job.selectedSupplier) continue;
    if (!job.productRequest?.trim()) continue;
    if (Number(job.researchAttemptCount || 0) >= Number(job.maxResearchAttempts || maxResearchAttempts())) continue;
    if (runningJobs.has(job.id)) continue;
    if (job.nextResearchAt && new Date(job.nextResearchAt) > now) continue;
    queueResearch(job.id);
  }
}

export function isResearchRunning(jobId) {
  return runningJobs.has(jobId);
}

export async function runResearch(jobId) {
  const job = getJob(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  if (!job.productRequest?.trim()) return;
  if (job.selectedSupplier || job.status === "supplier_selected") return;

  const maxAttempts = maxResearchAttempts();
  const attemptNumber = Number(job.researchAttemptCount || 0) + 1;
  if (attemptNumber > maxAttempts) return;
  const now = new Date();
  const hadTrustedBefore = Boolean(job.research?.suppliers?.length);

  job.status = "researching";
  job.researchStartedAt ||= now.toISOString();
  job.researchAttemptCount = attemptNumber;
  job.maxResearchAttempts = maxAttempts;
  job.currentResearchAttempt = attemptNumber;
  job.nextResearchAt = null;
  job.nextUpdateAt = addHours(now, config.updateIntervalHours).toISOString();
  job.researchAttempts ||= [];

  addTimeline(job, "research_attempt_started", `Deep sourcing check ${attemptNumber} of ${maxAttempts} started.`, {
    attempt: attemptNumber,
    maxAttempts
  });
  upsertJob(job);

  if (attemptNumber === 1) {
    await sendEmail({ to: job.customerEmail, ...stageUpdate(job) });
  }

  const attemptResearch = await performSupplierResearch(job, attemptNumber, maxAttempts);
  const mergedResearch = mergeResearch(job.research, attemptResearch);
  const trustedSupplierCount = mergedResearch.suppliers.length;
  const candidateCount = mergedResearch.candidateSources.length;
  const rejectedCount = mergedResearch.rejectedSources.length;

  job.research = mergedResearch;
  job.researchAttempts.push({
    attempt: attemptNumber,
    startedAt: now.toISOString(),
    completedAt: attemptResearch.completedAt,
    summary: attemptResearch.summary,
    candidateCount: attemptResearch.candidateSources.length,
    trustedSupplierCount: attemptResearch.suppliers.length,
    rejectedSourceCount: attemptResearch.rejectedSources.length,
    shippingAgentCount: attemptResearch.shippingAgents.length,
    sourceCount: attemptResearch.webSources.length
  });

  addTimeline(
    job,
    "research_attempt_completed",
    `Deep sourcing check ${attemptNumber} finished: ${trustedSupplierCount} trusted supplier(s), ${candidateCount} total candidate(s), ${rejectedCount} rejected source(s).`,
    {
      attempt: attemptNumber,
      trustedSupplierCount,
      candidateCount,
      rejectedCount
    }
  );

  if (trustedSupplierCount > 0 && attemptNumber < maxAttempts) {
    const nextResearchAt = addMinutes(new Date(), researchRetryDelayMinutes()).toISOString();
    job.status = "human_review";
    job.researchFirstFoundAt ||= new Date().toISOString();
    job.currentResearchAttempt = null;
    job.nextResearchAt = nextResearchAt;
    job.nextUpdateAt = addHours(new Date(), config.updateIntervalHours).toISOString();
    addTimeline(job, "research_more_scheduled", `Supplier options are ready, but AI will keep researching. Next deep sourcing check ${attemptNumber + 1} of ${maxAttempts} is scheduled for ${formatJohannesburg(nextResearchAt)}.`, {
      suppliers: trustedSupplierCount,
      nextResearchAt,
      nextAttempt: attemptNumber + 1,
      maxAttempts
    });
    upsertJob(job);

    if (!hadTrustedBefore) {
      await sendEmail({ to: config.adminEmail, ...adminReport(job) });
      await sendEmail({ to: job.customerEmail, ...stageUpdate(job) });
    }
    return;
  }

  if (trustedSupplierCount > 0) {
    job.status = "human_review";
    job.researchFirstFoundAt ||= new Date().toISOString();
    job.researchCompletedAt = new Date().toISOString();
    job.currentResearchAttempt = null;
    job.nextResearchAt = null;
    job.nextUpdateAt = addHours(new Date(), config.updateIntervalHours).toISOString();
    addTimeline(job, "research_completed", `All ${maxAttempts} deep sourcing checks are complete. Supplier shortlist is ready for Arcovia human review.`, {
      suppliers: trustedSupplierCount,
      attempts: attemptNumber
    });
    upsertJob(job);

    await sendEmail({ to: config.adminEmail, ...adminReport(job) });
    if (!hadTrustedBefore) {
      await sendEmail({ to: job.customerEmail, ...stageUpdate(job) });
    }
    return;
  }

  if (attemptNumber >= maxAttempts) {
    job.status = "refund_due";
    job.refundStatus = "manual_refund_required";
    job.refundReason = `No trusted source found after ${maxAttempts} deep sourcing checks.`;
    job.researchCompletedAt = new Date().toISOString();
    job.currentResearchAttempt = null;
    job.nextResearchAt = null;
    job.nextUpdateAt = null;
    addTimeline(job, "refund_due", job.refundReason, {
      attempts: attemptNumber,
      candidateCount,
      rejectedCount
    });
    upsertJob(job);

    await sendEmail({ to: config.adminEmail, ...adminRefundDue(job) });
    await sendEmail({ to: job.customerEmail, ...customerRefundDue(job) });
    return;
  }

  const nextResearchAt = addMinutes(new Date(), researchRetryDelayMinutes()).toISOString();
  job.status = "researching";
  job.currentResearchAttempt = null;
  job.nextResearchAt = nextResearchAt;
  job.nextUpdateAt = addHours(new Date(), config.updateIntervalHours).toISOString();
  addTimeline(job, "research_retry_scheduled", `No trusted supplier passed checks yet. Next deep sourcing check is scheduled for ${formatJohannesburg(nextResearchAt)}.`, {
    nextResearchAt,
    nextAttempt: attemptNumber + 1,
    maxAttempts
  });
  upsertJob(job);
}

async function handleResearchError(jobId, error) {
  const job = getJob(jobId);
  if (!job) return;

  const originalAttempts = Number(job.researchAttemptCount || 0);
  const maxAttempts = maxResearchAttempts();
  const safeMessage = safeErrorMessage(error);
  const technicalError = isTechnicalResearchError(safeMessage);

  if (technicalError && originalAttempts > 0) {
    job.researchAttemptCount = Math.max(0, originalAttempts - 1);
  }

  const recordedAttempts = Number(job.researchAttemptCount || 0);

  if (recordedAttempts < maxAttempts) {
    const delayMinutes = technicalError ? technicalRetryDelayMinutes() : researchRetryDelayMinutes();
    const nextResearchAt = addMinutes(new Date(), delayMinutes).toISOString();
    const nextAttempt = recordedAttempts + 1;
    job.status = "researching";
    job.currentResearchAttempt = null;
    job.lastResearchError = safeMessage;
    job.nextResearchAt = nextResearchAt;
    addTimeline(job, "research_retry_scheduled", `${technicalError ? "AI research hit a technical/API limit before the check completed" : `AI research hit an error on check ${originalAttempts}`}. A retry is scheduled for ${formatJohannesburg(nextResearchAt)}.`, {
      error: safeMessage,
      technicalError,
      nextResearchAt,
      nextAttempt,
      maxAttempts
    });
    upsertJob(job);
    await sendEmail({ to: config.adminEmail, ...researchFailure(job, `${safeMessage}\n\nRetry scheduled for ${formatJohannesburg(nextResearchAt)}.`) });
    return;
  }

  job.status = "research_failed";
  job.currentResearchAttempt = null;
  job.lastResearchError = safeMessage;
  addTimeline(job, "research_failed", safeMessage, { attempts: originalAttempts, maxAttempts });
  upsertJob(job);
  await sendEmail({ to: config.adminEmail, ...researchFailure(job, safeMessage) });
}

async function performSupplierResearch(job, attemptNumber, maxAttempts) {
  if (!config.openaiApiKey) {
    return dryRunResearch(job, attemptNumber);
  }

  const requestBody = {
    model: config.openaiModel,
    max_output_tokens: config.openaiMaxOutputTokens,
    tools: [{
      type: "web_search",
      external_web_access: true,
      search_context_size: config.openaiWebSearchContextSize,
      return_token_budget: "default"
    }],
    tool_choice: "required",
    include: ["web_search_call.action.sources"],
    input: buildResearchPrompt(job, attemptNumber, maxAttempts)
  };

  if (config.openaiReasoningEffort) {
    requestBody.reasoning = { effort: config.openaiReasoningEffort };
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(requestBody)
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI research failed: ${response.status} ${body}`);
  }

  const data = JSON.parse(body);
  const text = data.output_text || extractOutputText(data) || "";
  const parsed = parseJsonReport(text) || parsePartialJsonReport(text);
  const allSources = normalizeSourceList(parsed?.sources || parsed?.suppliers || parsed?.candidate_sources || []);
  const trustedSources = filterTrustedSources(allSources);
  const rejectedSources = normalizeRejectedSources(parsed?.rejected_sources || parsed?.unsafe_sources || []);
  const shippingAgents = normalizeShippingAgents(parsed?.shipping_agents || []);

  return {
    summary: parsed?.summary || summarizeUnstructuredResult(text),
    missingCustomerDetails: listValues(parsed?.missing_customer_details),
    suppliers: sortByMostExpensiveFirst(trustedSources),
    candidateSources: sortByMostExpensiveFirst(allSources),
    rejectedSources,
    shippingAgents,
    webSources: extractWebSources(data),
    rawText: text,
    model: config.openaiModel,
    attempt: attemptNumber,
    completedAt: new Date().toISOString(),
    recommendedNextCustomerMessage: parsed?.recommended_next_customer_message || ""
  };
}

function buildResearchPrompt(job, attemptNumber, maxAttempts) {
  const previousSummary = summarizePreviousAttempts(job);

  return `You are Arcovia's deep supplier-sourcing analyst.

Order: ${job.orderName}
Deep sourcing check: ${attemptNumber} of ${maxAttempts}

Customer request:
${job.productRequest}

Previous checks:
${previousSummary}

Objective:
Find every realistic way Arcovia can source this requested product. Do not stop at normal Google-style surface results.

Search lanes to cover:
1. Online stores and product pages, including local South African stores and international stores.
2. Physical stores, boutiques, authorized dealers, distributors, wholesalers, importers, and supplier directories.
3. Marketplaces and reseller platforms only when buyer protection, seller history, and delivery proof are clear.
4. Cross-border options where the product can be shipped to South Africa.
5. Shipping agents, freight forwarders, or parcel-forwarding services that can help import from other countries.
6. Trust/background checks for each candidate: customer reviews, HelloPeter where relevant, social media, public complaints, delivery/payment claims, business identity, contact details, domain/website consistency, refund policy, and counterfeit/scam red flags.

Rules:
- Include candidates above the customer's budget too, because they may be the only available options.
- Remove unsafe/untrusted candidates from the final "sources" list. Put them in "rejected_sources" with short internal reasons.
- Reject sources with repeated unresolved no-delivery, refund, counterfeit, fake-store, or payment complaints.
- Do not invent availability, prices, reviews, addresses, social pages, or ratings.
- If a price is visible, include currency and total estimate. If shipping/import fees are separate, note that.
- Sort final trusted sources from most expensive to cheapest.
- Return at most ${config.maxResearchCandidates} final trusted/needs-more-checks sources, up to 6 shipping agents, and up to 12 rejected sources.
- Keep each evidence summary under 220 characters so the JSON finishes within the token budget.
- Prefer official retailers, established marketplaces, verified physical shops, authorized distributors, and suppliers with clear delivery proof.
- Keep wording factual. Do not make defamatory claims; describe evidence and red flags internally.
- Return compact valid JSON only. Put URLs inside evidence_urls. Do not use Markdown.

Return this JSON shape:
{
  "summary": "short internal summary of what was checked and what passed or failed",
  "missing_customer_details": ["only details that block better sourcing"],
  "sources": [
    {
      "name": "store, supplier, marketplace seller, distributor, or physical shop",
      "source_type": "online_store | physical_store | supplier | distributor | marketplace | reseller | other",
      "url": "product or supplier URL",
      "product_match": "how closely it matches the requested product",
      "price": "price including currency, and whether shipping/import is included",
      "estimated_total_to_customer": "best estimate including delivery/import if available",
      "over_budget": true,
      "availability": "in stock, preorder, used available, contact required, unknown",
      "location": "country/city if found",
      "delivery_or_pickup": "delivery, pickup, international shipping, shipping agent needed, unknown",
      "trust_score": 0,
      "risk_level": "low | medium | high | unknown",
      "trust_checks": {
        "customer_reviews": "review/complaint evidence",
        "hellopeter": "HelloPeter evidence or not found",
        "social_media": "social evidence or not found",
        "website_payment_delivery": "payment, delivery, refund, buyer protection evidence",
        "business_identity": "registration/contact/address/history evidence"
      },
      "red_flags": ["specific red flags"],
      "evidence_urls": ["https://..."],
      "recommendation": "approve_for_human_review | needs_more_checks"
    }
  ],
  "shipping_agents": [
    {
      "name": "shipping agent or freight forwarder",
      "url": "URL",
      "countries_supported": "route/countries",
      "estimated_cost": "price if found",
      "trust_score": 0,
      "risk_level": "low | medium | high | unknown",
      "evidence_urls": ["https://..."],
      "notes": "why this agent might help"
    }
  ],
  "rejected_sources": [
    {
      "name": "rejected source",
      "url": "URL if found",
      "reason": "short factual reason it was removed",
      "evidence_urls": ["https://..."]
    }
  ],
  "recommended_next_customer_message": "short safe customer-facing progress update without unapproved supplier details"
}`;
}

function dryRunResearch(job, attemptNumber) {
  const completedAt = new Date().toISOString();
  return {
    summary: "Dry run: OpenAI API key not configured. The job was created and the repeated deep-research loop is ready, but live supplier research is waiting for OPENAI_API_KEY.",
    missingCustomerDetails: [],
    suppliers: [],
    candidateSources: [],
    rejectedSources: [],
    shippingAgents: [],
    webSources: [],
    rawText: `No live research performed for request: ${job.productRequest}`,
    model: "dry-run",
    attempt: attemptNumber,
    completedAt,
    recommendedNextCustomerMessage: ""
  };
}

function mergeResearch(previous, current) {
  const previousAttempts = previous?.attempts || [];
  const attempts = [
    ...previousAttempts,
    {
      attempt: current.attempt,
      completedAt: current.completedAt,
      summary: current.summary
    }
  ];

  return {
    summary: current.summary,
    missingCustomerDetails: uniqueStrings([...(previous?.missingCustomerDetails || []), ...current.missingCustomerDetails]),
    suppliers: sortByMostExpensiveFirst(uniqueByIdentity([...(previous?.suppliers || []), ...current.suppliers])),
    candidateSources: sortByMostExpensiveFirst(uniqueByIdentity([...(previous?.candidateSources || []), ...current.candidateSources])).slice(0, config.maxResearchCandidates * maxResearchAttempts()),
    rejectedSources: uniqueByIdentity([...(previous?.rejectedSources || []), ...current.rejectedSources]).slice(0, 50),
    shippingAgents: uniqueByIdentity([...(previous?.shippingAgents || []), ...current.shippingAgents]).slice(0, 20),
    webSources: uniqueByUrl([...(previous?.webSources || []), ...current.webSources]).slice(0, 100),
    rawText: current.rawText,
    model: current.model,
    completedAt: current.completedAt,
    attempts
  };
}

function filterTrustedSources(sources) {
  return sources.filter((source) => {
    const recommendation = lower(source.recommendation);
    const risk = lower(source.risk_level);
    const trustScore = Number(source.trust_score || 0);
    const redFlagText = [
      ...(Array.isArray(source.red_flags) ? source.red_flags : []),
      JSON.stringify(source.trust_checks || {})
    ].join(" ").toLowerCase();

    if (!source.url && !source.name) return false;
    if (recommendation.includes("reject")) return false;
    if (risk === "high" || risk === "unsafe") return false;
    if (hasSevereBadReviewSignal(redFlagText) && trustScore < config.highTrustThreshold) return false;
    if (recommendation.includes("approve")) return true;
    return trustScore >= config.mediumTrustThreshold && !hasSevereBadReviewSignal(redFlagText);
  });
}

function hasSevereBadReviewSignal(text) {
  return /scam|fake store|fake-store|fraud|counterfeit|no delivery|non[- ]delivery|never delivered|unresolved complaint|chargeback|stolen|too many bad|many bad reviews/.test(text);
}

function normalizeSourceList(sources) {
  return listValues(sources).map((source) => ({
    name: textValue(source.name || source.supplier_name || source.store || source.title),
    source_type: textValue(source.source_type || source.type || "other"),
    url: textValue(source.url || source.product_url || source.website),
    product_match: textValue(source.product_match || source.match),
    price: textValue(source.price || source.price_found),
    estimated_total_to_customer: textValue(source.estimated_total_to_customer || source.estimated_total || source.total_cost),
    over_budget: Boolean(source.over_budget),
    availability: textValue(source.availability),
    location: textValue(source.location),
    delivery_or_pickup: textValue(source.delivery_or_pickup || source.delivery),
    trust_score: clampScore(source.trust_score),
    risk_level: textValue(source.risk_level || "unknown"),
    trust_checks: source.trust_checks && typeof source.trust_checks === "object" ? source.trust_checks : {},
    red_flags: listValues(source.red_flags).map(textValue).filter(Boolean),
    evidence_urls: listValues(source.evidence_urls || source.evidence || source.sources).map(textValue).filter(Boolean),
    recommendation: textValue(source.recommendation || "needs_more_checks")
  }));
}

function normalizeRejectedSources(sources) {
  return listValues(sources).map((source) => ({
    name: textValue(source.name || source.supplier_name || source.store || source.title),
    url: textValue(source.url || source.product_url || source.website),
    reason: textValue(source.reason || source.red_flag || source.summary),
    evidence_urls: listValues(source.evidence_urls || source.evidence || source.sources).map(textValue).filter(Boolean)
  })).filter((source) => source.name || source.url || source.reason);
}

function normalizeShippingAgents(agents) {
  return listValues(agents).map((agent) => ({
    name: textValue(agent.name),
    url: textValue(agent.url || agent.website),
    countries_supported: textValue(agent.countries_supported || agent.route || agent.countries),
    estimated_cost: textValue(agent.estimated_cost || agent.price),
    trust_score: clampScore(agent.trust_score),
    risk_level: textValue(agent.risk_level || "unknown"),
    evidence_urls: listValues(agent.evidence_urls || agent.evidence || agent.sources).map(textValue).filter(Boolean),
    notes: textValue(agent.notes || agent.summary)
  })).filter((agent) => agent.name || agent.url);
}

function extractWebSources(data) {
  const sources = [];

  for (const item of data.output || []) {
    if (item.type === "web_search_call") {
      for (const source of item.action?.sources || []) {
        sources.push({
          title: textValue(source.title),
          url: textValue(source.url),
          source: "web_search"
        });
      }
    }

    for (const content of item.content || []) {
      for (const annotation of content.annotations || []) {
        if (annotation.type === "url_citation" || annotation.url) {
          sources.push({
            title: textValue(annotation.title),
            url: textValue(annotation.url),
            source: "citation"
          });
        }
      }
    }
  }

  return uniqueByUrl(sources).filter((source) => source.url);
}

function extractOutputText(data) {
  const parts = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.text) parts.push(content.text);
    }
  }
  return parts.join("\n");
}

function parseJsonReport(text) {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function parsePartialJsonReport(text) {
  if (!text?.includes('"sources"')) return null;

  const sources = extractJsonObjectsFromArray(text, "sources");
  const shippingAgents = extractJsonObjectsFromArray(text, "shipping_agents");
  const rejectedSources = extractJsonObjectsFromArray(text, "rejected_sources");
  if (!sources.length && !shippingAgents.length && !rejectedSources.length) return null;

  return {
    summary: extractJsonStringField(text, "summary") || "AI research returned partial structured JSON. Review raw report for any truncated fields.",
    missing_customer_details: extractJsonStringArray(text, "missing_customer_details"),
    sources,
    shipping_agents: shippingAgents,
    rejected_sources: rejectedSources,
    recommended_next_customer_message: extractJsonStringField(text, "recommended_next_customer_message")
  };
}

function extractJsonObjectsFromArray(text, key) {
  const keyIndex = text.indexOf(`"${key}"`);
  if (keyIndex === -1) return [];
  const arrayStart = text.indexOf("[", keyIndex);
  if (arrayStart === -1) return [];

  const objects = [];
  let depth = 0;
  let objectStart = -1;
  let inString = false;
  let escaped = false;

  for (let index = arrayStart + 1; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) objectStart = index;
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0 && objectStart !== -1) {
        const objectText = text.slice(objectStart, index + 1);
        try {
          objects.push(JSON.parse(objectText));
        } catch {
          // Ignore malformed partial objects and keep any complete objects already recovered.
        }
        objectStart = -1;
      }
      continue;
    }

    if (char === "]" && depth === 0) break;
  }

  return objects;
}

function extractJsonStringField(text, key) {
  const match = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "s"));
  if (!match) return "";
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1];
  }
}

function extractJsonStringArray(text, key) {
  const keyIndex = text.indexOf(`"${key}"`);
  if (keyIndex === -1) return [];
  const arrayStart = text.indexOf("[", keyIndex);
  const arrayEnd = text.indexOf("]", arrayStart);
  if (arrayStart === -1 || arrayEnd === -1) return [];
  const arrayText = text.slice(arrayStart, arrayEnd + 1);
  try {
    const parsed = JSON.parse(arrayText);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function summarizePreviousAttempts(job) {
  const attempts = (job.researchAttempts || []).slice(-3);
  if (!attempts.length) return "No previous deep sourcing checks for this order.";
  return attempts.map((attempt) => {
    return `Check ${attempt.attempt}: ${attempt.trustedSupplierCount || 0} trusted, ${attempt.candidateCount || 0} candidates, ${attempt.rejectedSourceCount || 0} rejected. ${attempt.summary || ""}`;
  }).join("\n");
}

function summarizeUnstructuredResult(text) {
  if (!text?.trim()) return "AI research returned no structured report.";
  return `AI research returned an unstructured report. Review raw text.`;
}

function maxResearchAttempts() {
  return Math.max(1, Math.floor(Number(config.deepResearchMaxAttempts || 10)));
}

function researchRetryDelayMinutes() {
  if (Number(config.researchRetryDelayMinutes) > 0) return Number(config.researchRetryDelayMinutes);
  const spreadAcrossWindow = Math.floor((Number(config.maxSourcingDays || 14) * 24 * 60) / maxResearchAttempts());
  return Math.max(60, spreadAcrossWindow);
}

function technicalRetryDelayMinutes() {
  return Math.max(1, Number(config.researchTechnicalRetryDelayMinutes || 15));
}

function isTechnicalResearchError(message) {
  return /429|rate limit|rate_limit|tokens per min|TPM|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|5\d\d/.test(message);
}

function sortByMostExpensiveFirst(items) {
  return [...items].sort((a, b) => priceSortValue(b) - priceSortValue(a));
}

function priceSortValue(item) {
  const value = `${item.estimated_total_to_customer || ""} ${item.price || ""}`;
  const matches = [...value.matchAll(/(?:R|ZAR|USD|US\$|EUR|GBP|£|\$)?\s*([0-9][0-9\s,.]*)/gi)]
    .map((match) => Number(match[1].replace(/\s/g, "").replace(/,/g, "")))
    .filter((number) => Number.isFinite(number));
  return matches.length ? Math.max(...matches) : -1;
}

function uniqueByIdentity(items) {
  const seen = new Set();
  const unique = [];
  for (const item of items || []) {
    const key = lower(item.url || item.name || JSON.stringify(item));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function uniqueByUrl(items) {
  const seen = new Set();
  const unique = [];
  for (const item of items || []) {
    const key = lower(item.url || item.title || JSON.stringify(item));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function uniqueStrings(values) {
  return [...new Set(listValues(values).map(textValue).filter(Boolean))];
}

function listValues(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function textValue(value) {
  return String(value || "").trim();
}

function lower(value) {
  return textValue(value).toLowerCase();
}

function clampScore(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, number));
}

function safeErrorMessage(error) {
  return String(error?.message || error || "Unknown research error")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted-api-key]")
    .slice(0, 2000);
}

function addHours(date, hours) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function formatJohannesburg(value) {
  return new Date(value).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" });
}
