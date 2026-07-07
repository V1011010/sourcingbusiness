import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { sendCustomerEmail, sendEmail, sendSensitiveAdminEmailForJob } from "./email.js";
import { enrichResearchImages, imageEnrichmentHealthFeatures } from "./image-enrichment.js";
import { adminRefundDue, adminReport, customerOptionsReady, customerRefundDue } from "./templates.js";
import { addTimeline, getJob, readJobs, recordEmailAudit, upsertJob } from "./storage.js";
import { researchPolicySummary } from "./research.js";

export async function handleLocalWorkerClaim(req, res) {
  if (!isAuthorizedLocalWorker(req)) return json(res, 401, { error: "invalid_worker_secret" });

  const body = parseJsonBody(await readBody(req));
  const workerId = textValue(body.worker_id) || `local-codex-${randomUUID()}`;
  const job = findClaimableJob();

  if (!job) {
    return json(res, 200, {
      ok: true,
      claimed: false,
      message: "No sourcing research jobs are ready."
    });
  }

  const attemptNumber = Number(job.researchAttemptCount || 0) + 1;
  const policy = researchPolicySummary();
  if (attemptNumber > policy.maxTotalAttempts || hasCompletedPolicy(job)) {
    settleCompletedPolicyJob(job, policy);
    return json(res, 200, {
      ok: true,
      claimed: false,
      message: "Job already satisfies the Arcovia research policy. No extra local worker check is needed."
    });
  }
  const now = new Date();
  const leaseUntil = addMinutes(now, localWorkerLeaseMinutes()).toISOString();

  job.status = "researching";
  job.maxResearchAttempts = policy.maxTotalAttempts;
  job.currentResearchAttempt = attemptNumber;
  job.nextResearchAt = null;
  job.localWorker = {
    workerId,
    attemptNumber,
    claimedAt: now.toISOString(),
    leaseUntil
  };

  addTimeline(job, "local_worker_claimed", `Sourcing worker started ${researchPassTitle(job, attemptNumber)} ${attemptNumber} of ${policy.maxTotalAttempts}.`, {
    workerId,
    attempt: attemptNumber,
    maxAttempts: policy.maxTotalAttempts,
    researchPassType: researchPassType(job, attemptNumber),
    leaseUntil
  });
  upsertJob(job);

  return json(res, 200, {
    ok: true,
    claimed: true,
    worker_id: workerId,
    lease_until: leaseUntil,
    job: {
      id: job.id,
      order_name: job.orderName,
      customer_name: job.customerName || "",
      product_request: job.productRequest,
      attempt: attemptNumber,
      max_attempts: policy.maxTotalAttempts,
      research_pass_type: researchPassType(job, attemptNumber),
      research_pass_title: researchPassTitle(job, attemptNumber),
      previous_research_summary: summarizePreviousAttempts(job),
      policy,
      prompt: buildLocalCodexPrompt(job, attemptNumber, policy)
    }
  });
}

export async function handleLocalWorkerReport(req, res) {
  if (!isAuthorizedLocalWorker(req)) return json(res, 401, { error: "invalid_worker_secret" });

  const body = parseJsonBody(await readBody(req));
  const skipEmails = req.headers["x-arcovia-skip-emails"] === "1";
  const job = getJob(body.job_id);
  if (!job) return json(res, 404, { error: "job_not_found" });

  const workerId = textValue(body.worker_id);
  const attemptNumber = Number(body.attempt || job.localWorker?.attemptNumber || Number(job.researchAttemptCount || 0) + 1);
  const policy = researchPolicySummary();

  if (attemptNumber > policy.maxTotalAttempts) {
    job.currentResearchAttempt = null;
    job.localWorker = null;
    settleCompletedPolicyJob(job, policy);
    return json(res, 200, {
      ok: true,
      status: job.status,
      ignored: true,
      reason: "attempt_exceeds_research_policy"
    });
  }

  if (body.error) {
    const safeError = safeWorkerError(body.error);
    job.status = "researching";
    job.currentResearchAttempt = null;
    job.nextResearchAt = addMinutes(new Date(), localWorkerFailureRetryMinutes()).toISOString();
    job.localWorker = null;
    addTimeline(job, "local_worker_failed", `Sourcing research failed before completion. Retry scheduled for ${formatJohannesburg(job.nextResearchAt)}.`, {
      workerId,
      attempt: attemptNumber,
      error: safeError
    });
    upsertJob(job);
    return json(res, 200, { ok: true, status: job.status, retry_at: job.nextResearchAt });
  }

  const attemptResearch = await enrichResearchImages(normalizeLocalWorkerReport(body.report, attemptNumber), {
    productRequest: job.productRequest
  });
  const mergedResearch = mergeResearch(job.research, attemptResearch);
  const trustedSupplierCount = mergedResearch.suppliers.length;
  const candidateCount = mergedResearch.candidateSources.length;
  const rejectedCount = mergedResearch.rejectedSources.length;

  job.research = mergedResearch;
  job.researchAttemptCount = Math.max(Number(job.researchAttemptCount || 0), attemptNumber);
  job.maxResearchAttempts = policy.maxTotalAttempts;
  job.currentResearchAttempt = null;
  job.localWorker = null;
  job.nextUpdateAt = addHours(new Date(), config.updateIntervalHours).toISOString();
  job.researchStartedAt ||= new Date().toISOString();
  job.researchAttempts ||= [];
  job.researchAttempts.push({
    attempt: attemptNumber,
    researchPassType: researchPassType(job, attemptNumber),
    startedAt: body.started_at || null,
    completedAt: attemptResearch.completedAt,
    summary: attemptResearch.summary,
    candidateCount: attemptResearch.candidateSources.length,
    trustedSupplierCount: attemptResearch.suppliers.length,
    rejectedSourceCount: attemptResearch.rejectedSources.length,
    shippingAgentCount: attemptResearch.shippingAgents.length,
    sourceCount: attemptResearch.webSources.length,
    engine: "local_sourcing_worker"
  });

  addTimeline(job, "local_worker_report_received", `Sourcing worker finished ${researchPassTitle(job, attemptNumber)} ${attemptNumber}: ${trustedSupplierCount} trusted supplier(s), ${candidateCount} candidate(s), ${rejectedCount} rejected.`, {
    workerId,
    attempt: attemptNumber,
    trustedSupplierCount,
    candidateCount,
    rejectedCount
  });

  if (trustedSupplierCount > 0) {
    job.researchFirstFoundAt ||= new Date().toISOString();
    job.researchFirstFoundAttempt ||= attemptNumber;
  }

  if (shouldRunAnotherLocalResearchPass(attemptNumber, policy)) {
    job.status = "researching";
    job.nextResearchAt = addMinutes(new Date(), researchRetryDelayMinutes()).toISOString();
    addTimeline(job, "local_worker_more_scheduled", `The next deep research pass ${attemptNumber + 1} of ${policy.maxTotalAttempts} is scheduled for ${formatJohannesburg(job.nextResearchAt)}. Arcovia will complete all ${policy.maxTotalAttempts} passes before sending final customer options or the no-supplier email.`, {
      nextResearchAt: job.nextResearchAt,
      nextAttempt: attemptNumber + 1,
      maxAttempts: policy.maxTotalAttempts
    });
    upsertJob(job);

    return json(res, 200, { ok: true, status: job.status, suppliers: trustedSupplierCount, next_research_at: job.nextResearchAt });
  }

  if (trustedSupplierCount > 0) {
    job.status = "human_review";
    job.researchCompletedAt = new Date().toISOString();
    job.nextResearchAt = null;
    job.customerOptionsToken ||= randomUUID();
    addTimeline(job, "research_completed", `All ${policy.maxTotalAttempts} deep sourcing passes are complete. Supplier shortlist is ready for Arcovia review.`, {
      suppliers: trustedSupplierCount,
      attempts: attemptNumber
    });
    upsertJob(job);

    if (!skipEmails) {
      await sendAdminEmailForJob(job, "admin_research_report", adminReport(job), { sensitive: true });
    }
    if (!skipEmails && job.customerEmail && !job.customerOptionsSentAt) {
      const emailResult = await sendCustomerEmailForJob(job, "customer_options_ready", customerOptionsReady(job));
      if (emailResult.ok) {
        job.customerOptionsSentAt = new Date().toISOString();
        job.status = "options_sent";
        addTimeline(job, "customer_options_sent", "Anonymized approved-supplier options link sent to customer after research completion.");
      } else {
        addTimeline(job, "customer_options_email_failed", `Customer options email failed: ${emailResult.reason || "unknown email error"}.`);
      }
      upsertJob(job);
    }

    return json(res, 200, { ok: true, status: job.status, suppliers: trustedSupplierCount });
  }

  if (attemptNumber >= policy.noMatchAttemptLimit) {
    job.status = "refund_due";
    job.refundStatus = "manual_refund_required";
    job.refundReason = `No trusted supplier found after all ${policy.maxTotalAttempts} deep sourcing pass(es).`;
    job.researchCompletedAt = new Date().toISOString();
    job.nextResearchAt = null;
    job.nextUpdateAt = null;
    addTimeline(job, "refund_due", job.refundReason, {
      attempts: attemptNumber,
      candidateCount,
      rejectedCount
    });
    upsertJob(job);

    if (!skipEmails) {
      await sendAdminEmailForJob(job, "admin_refund_due", adminRefundDue(job));
      await sendCustomerEmailForJob(job, "customer_refund_due", customerRefundDue(job));
    }
    return json(res, 200, { ok: true, status: job.status, suppliers: 0 });
  }

  job.status = "researching";
  job.nextResearchAt = addMinutes(new Date(), researchRetryDelayMinutes()).toISOString();
  addTimeline(job, "local_worker_retry_scheduled", `No trusted supplier passed checks yet. Retry ${attemptNumber + 1} is scheduled for ${formatJohannesburg(job.nextResearchAt)}.`, {
    nextResearchAt: job.nextResearchAt,
    nextAttempt: attemptNumber + 1,
    maxAttempts: policy.maxTotalAttempts
  });
  upsertJob(job);

  return json(res, 200, { ok: true, status: job.status, suppliers: 0, next_research_at: job.nextResearchAt });
}

export function localWorkerHealthFeatures() {
  return {
    localSourcingWorkerEnabled: config.localCodexWorkerEnabled,
    localSourcingWorkerEndpoints: true,
    localSourcingWorkerLeaseMinutes: localWorkerLeaseMinutes(),
    localSourcingWorkerTrustScoreNormalization: "accepts_0_to_1_or_0_to_100",
    silentLocalWorkerReportReplay: true,
    localWorkerCompletedJobClaimGuard: true,
    ...imageEnrichmentHealthFeatures()
  };
}

async function sendCustomerEmailForJob(job, templateName, template) {
  const result = await sendCustomerEmail({ to: job.customerEmail, ...template });
  recordEmailAudit(job, {
    templateName,
    audience: "customer",
    to: job.customerEmail,
    subject: template?.subject || "",
    result
  });
  upsertJob(job);
  return result;
}

async function sendAdminEmailForJob(job, templateName, template, { sensitive = false } = {}) {
  const result = sensitive
    ? await sendSensitiveAdminEmailForJob(job, template)
    : await sendEmail({ to: config.adminEmail, ...template });
  recordEmailAudit(job, {
    templateName,
    audience: "admin",
    to: config.adminEmail,
    subject: template?.subject || "",
    result
  });
  upsertJob(job);
  return result;
}

function findClaimableJob() {
  const now = new Date();
  return readJobs()
    .filter((job) => {
      if (!["researching", "human_review", "research_failed"].includes(job.status)) return false;
      if (job.selectedSupplier) return false;
      if (!job.productRequest?.trim()) return false;
      if (hasCompletedPolicy(job)) {
        settleCompletedPolicyJob(job);
        return false;
      }
      if (Number(job.researchAttemptCount || 0) >= researchPolicySummary().maxTotalAttempts) {
        settleCompletedPolicyJob(job);
        return false;
      }
      if (job.localWorker?.leaseUntil && new Date(job.localWorker.leaseUntil) > now) return false;
      if (job.nextResearchAt && new Date(job.nextResearchAt) > now && !isOpenAiQuotaBlocked(job)) return false;
      return true;
    })
    .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0))[0] || null;
}

function normalizeLocalWorkerReport(report, attemptNumber) {
  const sources = normalizeSourceList(report?.sources || report?.suppliers || report?.candidate_sources || []);
  const trustedSources = filterTrustedSources(sources);
  const rejectedSources = normalizeRejectedSources(report?.rejected_sources || report?.unsafe_sources || []);
  const shippingAgents = normalizeShippingAgents(report?.shipping_agents || []);
  const completedAt = new Date().toISOString();
  const rawText = JSON.stringify(report || {}, null, 2);

  return {
    summary: textValue(report?.summary) || "Sourcing worker returned a supplier research report.",
    missingCustomerDetails: listValues(report?.missing_customer_details).map(textValue).filter(Boolean),
    suppliers: sortByMostExpensiveFirst(trustedSources),
    candidateSources: sortByMostExpensiveFirst(sources),
    rejectedSources,
    shippingAgents,
    webSources: extractEvidenceWebSources([...sources, ...rejectedSources, ...shippingAgents]),
    rawText,
    model: textValue(report?.model) || "local-codex",
    attempt: attemptNumber,
    completedAt,
    recommendedNextCustomerMessage: textValue(report?.recommended_next_customer_message)
  };
}

function mergeResearch(previous, current) {
  const previousAttempts = previous?.attempts || [];
  const attempts = [
    ...previousAttempts,
    {
      attempt: current.attempt,
      completedAt: current.completedAt,
      summary: current.summary,
      engine: "local_codex_worker"
    }
  ];

  return {
    summary: current.summary,
    missingCustomerDetails: uniqueStrings([...(previous?.missingCustomerDetails || []), ...current.missingCustomerDetails]),
    suppliers: sortByMostExpensiveFirst(uniqueByIdentity([...(previous?.suppliers || []), ...current.suppliers])),
    candidateSources: sortByMostExpensiveFirst(uniqueByIdentity([...(previous?.candidateSources || []), ...current.candidateSources])).slice(0, finalSourceLimit() * researchPolicySummary().maxTotalAttempts),
    rejectedSources: uniqueByIdentity([...(previous?.rejectedSources || []), ...current.rejectedSources]).slice(0, 50),
    shippingAgents: uniqueByIdentity([...(previous?.shippingAgents || []), ...current.shippingAgents]).slice(0, 20),
    webSources: uniqueByUrl([...(previous?.webSources || []), ...current.webSources]).slice(0, 100),
    rawText: current.rawText,
    model: current.model,
    completedAt: current.completedAt,
    attempts
  };
}

function buildLocalCodexPrompt(job, attemptNumber, policy) {
  return `You are Arcovia's local Codex sourcing worker.

You are running on the store owner's always-on Windows PC. Research the customer's requested product and return ONLY JSON that matches the provided output schema.

Order: ${job.orderName}
Research check: ${attemptNumber} of ${policy.maxTotalAttempts}
Research pass type: ${researchPassType(job, attemptNumber)}

Customer request:
${job.productRequest}

Previous checks:
${summarizePreviousAttempts(job)}

Required behavior:
- Do one super-deep search on the first pass. Find as many real choices as possible in one run.
- This order must receive exactly ${policy.maxTotalAttempts} completed deep sourcing passes before Arcovia sends final customer options or a no-supplier/refund email, unless Arcovia has already manually selected a supplier.
- Adapt to the request category. The customer may need a product, local service provider, manufacturer/factory, fabric/textile supplier, wholesaler, distributor, physical store, or import route.
- If this is a retry, use different wording and search angles from previous attempts.
- If suppliers were already found, search once more for missed alternatives and stronger trust evidence.
- For service requests, search local providers near the requested location, directories, Google/social/web presence, portfolios, reviews, complaint signals, call-out/service-area terms, and quote/budget fit.
- For manufacturer/factory requests, search factories, OEM/ODM producers, specialist workshops, wholesalers, trade directories, local and international options, MOQ, capabilities, sample/prototype support, quality/compliance evidence, and contact legitimacy.
- For fabric/textile requests, search fabric shops, textile wholesalers, mills, leather/fabric specialists, swatch/sample options, material composition, width/weight, colour/texture match, and delivery options.
- Search online stores, physical stores, service providers, factories, boutiques, distributors, wholesalers, importers, marketplaces, resellers, and shipping/parcel-forwarding options as relevant.
- Check trust signals for every candidate: customer reviews, HelloPeter where relevant, social media, public complaints, delivery/payment claims, business identity, contact details, refund policy, portfolios/project proof, and counterfeit/scam red flags.
- Include options above the customer's budget if they are real and relevant.
- For every source, include image_url for the best direct product/provider image and image_urls with up to 5 useful angles/images when the product page, provider page, marketplace result, official brand page, or safe reference result exposes them.
- Only include images that clearly show the requested item, service proof/portfolio, manufacturer capability, or fabric/material match. Do not include random Google images, logos, banners, header images, payment icons, social profile pictures, unrelated stock photos, category thumbnails, or generic brand images.
- If the supplier/source page has no images, use reference_image_urls only for clearly matching reference images from an official product/brand page or a search result whose title/URL matches the requested product. If image relevance is uncertain, leave image_url blank and image_urls/reference_image_urls empty.
- For every source, include estimated_total_zar as the approximate total customer cost in South African Rand, including item price, known or estimated shipping, duties, VAT, and handling where possible. If it cannot be estimated, explain briefly such as "Needs checkout quote in ZAR".
- For rejected_sources, also include image_url and image_urls if real item/source images were visible; otherwise return empty strings/arrays.
- Remove unsafe or untrusted sources from the final sources list and put them under rejected_sources with short factual reasons.
- Do not invent prices, reviews, addresses, ratings, or availability.
- Sort final trusted/needs-more-checks sources from most expensive to cheapest.
- trust_score must be 0 to 100, not 0 to 1.
- recommendation must be one of: approve_for_human_review, needs_more_checks, reject.
- Return at most ${finalSourceLimit()} source/provider candidates, up to 8 shipping agents where shipping/import is relevant, and up to 20 rejected sources.
- Keep text compact. Use real URLs in evidence_urls.
- Do not buy anything. Do not contact suppliers. Do not reveal unreviewed suppliers to the customer.

Return JSON only.`;
}

function hasCompletedPolicy(job) {
  const policy = researchPolicySummary();
  const completedAttempts = Number(job.researchAttemptCount || 0);
  return completedAttempts >= policy.maxTotalAttempts;
}

function settleCompletedPolicyJob(job, policy = researchPolicySummary()) {
  const trustedSupplierCount = Number(job.research?.suppliers?.length || 0);
  const now = new Date().toISOString();

  job.currentResearchAttempt = null;
  job.localWorker = null;
  job.nextResearchAt = null;
  job.maxResearchAttempts = policy.maxTotalAttempts;

  if (trustedSupplierCount > 0) {
    const changed = job.status !== "human_review" || !job.researchCompletedAt;
    job.status = "human_review";
    job.researchCompletedAt ||= now;
    job.customerOptionsToken ||= randomUUID();
    if (changed) {
      addTimeline(job, "research_completed", `Saved job already has ${policy.maxTotalAttempts} completed sourcing research pass(es). No further worker checks are scheduled unless Arcovia requeues it.`, {
        suppliers: trustedSupplierCount,
        attempts: job.researchAttemptCount || 0
      });
    }
    upsertJob(job);
    return;
  }

  const changed = job.status !== "refund_due" || !job.researchCompletedAt;
  job.status = "refund_due";
  job.refundStatus = "manual_refund_required";
  job.refundReason ||= `No trusted supplier found after all ${policy.maxTotalAttempts} deep sourcing pass(es).`;
  job.nextUpdateAt = null;
  job.researchCompletedAt ||= now;
  if (changed) {
    addTimeline(job, "refund_due", job.refundReason, {
      attempts: job.researchAttemptCount || 0
    });
  }
  upsertJob(job);
}

function shouldRunAnotherLocalResearchPass(attemptNumber, policy) {
  return attemptNumber < policy.maxTotalAttempts;
}

function firstTrustedAttempt(job, fallbackAttempt) {
  const explicit = Number(job.researchFirstFoundAttempt || 0);
  if (explicit > 0) return explicit;
  const previousAttempt = (job.researchAttempts || [])
    .filter((attempt) => Number(attempt.trustedSupplierCount || 0) > 0)
    .map((attempt) => Number(attempt.attempt || 0))
    .filter((attempt) => attempt > 0)
    .sort((a, b) => a - b)[0];
  if (previousAttempt) return previousAttempt;
  if (Number(job.research?.suppliers?.length || 0) > 0 && Number(job.researchAttemptCount || 0) > 0) {
    return Number(job.researchAttemptCount || 0);
  }
  return Math.max(1, Number(fallbackAttempt || 1));
}

function researchPassType(job, attemptNumber) {
  if (attemptNumber === 1) return "primary_super_deep_search";
  if (Number(job.research?.suppliers?.length || 0) > 0 || Number(job.researchFirstFoundAttempt || 0) > 0) {
    return "confirmation_expansion_search";
  }
  return "no_match_retry_search";
}

function researchPassTitle(job, attemptNumber) {
  const labels = {
    primary_super_deep_search: "primary super-deep sourcing search",
    confirmation_expansion_search: "supplier expansion/confirmation search",
    no_match_retry_search: "no-match retry sourcing search"
  };
  return labels[researchPassType(job, attemptNumber)] || "deep sourcing check";
}

function summarizePreviousAttempts(job) {
  const attempts = (job.researchAttempts || []).slice(-3);
  if (!attempts.length) return "No previous local sourcing checks for this order.";
  return attempts.map((attempt) => {
    return `Check ${attempt.attempt}: ${attempt.trustedSupplierCount || 0} trusted, ${attempt.candidateCount || 0} candidates, ${attempt.rejectedSourceCount || 0} rejected. ${attempt.summary || ""}`;
  }).join("\n");
}

function isOpenAiQuotaBlocked(job) {
  const latest = (job.timeline || []).at(-1);
  const error = String(latest?.meta?.error || job.lastResearchError || "").toLowerCase();
  return error.includes("insufficient_quota") || error.includes("exceeded your current quota");
}

function isAuthorizedLocalWorker(req) {
  const provided = req.headers["x-arcovia-worker-secret"] || req.headers["x-arcovia-flow-secret"];
  return Boolean(config.localWorkerSecret && provided === config.localWorkerSecret);
}

function normalizeSourceList(sources) {
  return listValues(sources).map((source) => ({
    name: textValue(source.name || source.supplier_name || source.store || source.title),
    source_type: textValue(source.source_type || source.type || "other"),
    url: textValue(source.url || source.product_url || source.website),
    product_match: textValue(source.product_match || source.match),
    image_url: textValue(source.image_url || source.product_image_url || source.item_image_url || source.image || source.thumbnail_url),
    image_urls: sourceImageUrlList(source),
    reference_image_urls: listValues(source.reference_image_urls || source.reference_images).map(textValue).filter(Boolean),
    price: textValue(source.price || source.price_found),
    estimated_total_zar: textValue(source.estimated_total_zar || source.approx_total_zar || source.total_zar || source.rand_total),
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
  })).filter((source) => source.name || source.url);
}

function normalizeRejectedSources(sources) {
  return listValues(sources).map((source) => ({
    name: textValue(source.name || source.supplier_name || source.store || source.title),
    url: textValue(source.url || source.product_url || source.website),
    image_url: textValue(source.image_url || source.product_image_url || source.item_image_url || source.image || source.thumbnail_url),
    image_urls: sourceImageUrlList(source),
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

function extractEvidenceWebSources(items) {
  const sources = [];
  for (const item of items) {
    if (item.url) sources.push({ title: item.name || item.url, url: item.url, source: "local_codex" });
    for (const url of item.evidence_urls || []) {
      sources.push({ title: item.name || url, url, source: "local_codex_evidence" });
    }
  }
  return uniqueByUrl(sources).filter((source) => source.url);
}

function sortByMostExpensiveFirst(items) {
  return [...items].sort((a, b) => priceSortValue(b) - priceSortValue(a));
}

function priceSortValue(item) {
  const value = `${item.estimated_total_zar || ""} ${item.estimated_total_to_customer || ""} ${item.price || ""}`;
  const matches = [...value.matchAll(/(?:R|ZAR|USD|US\$|EUR|GBP|£|\$)?\s*([0-9][0-9\s,.]*)/gi)]
    .map((match) => Number(match[1].replace(/\s/g, "").replace(/,/g, "")))
    .filter((number) => Number.isFinite(number));
  return matches.length ? Math.max(...matches) : -1;
}

function uniqueByIdentity(items) {
  const seen = new Map();
  for (const item of items || []) {
    const key = lower(item.url || item.name || JSON.stringify(item));
    if (!key) continue;
    if (!seen.has(key)) {
      seen.set(key, item);
      continue;
    }
    seen.set(key, mergeDuplicateSource(seen.get(key), item));
  }
  return [...seen.values()];
}

function mergeDuplicateSource(existing, incoming) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming || {})) {
    if (hasUsefulValue(value) && !hasUsefulValue(merged[key])) {
      merged[key] = value;
    }
  }
  for (const key of ["image_url", "estimated_total_zar", "estimated_total_to_customer", "price", "availability"]) {
    if (hasUsefulValue(incoming?.[key])) merged[key] = incoming[key];
  }
  merged.image_urls = uniqueStrings([...(existing?.image_urls || []), ...(incoming?.image_urls || [])]).slice(0, 8);
  merged.reference_image_urls = uniqueStrings([...(existing?.reference_image_urls || []), ...(incoming?.reference_image_urls || [])]).slice(0, 8);
  return merged;
}

function hasUsefulValue(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return String(value).trim() !== "";
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

function sourceImageUrlList(source) {
  return uniqueStrings([
    source?.image_url,
    source?.product_image_url,
    source?.item_image_url,
    source?.image,
    source?.thumbnail_url,
    ...(listValues(source?.image_urls)),
    ...(listValues(source?.product_image_urls)),
    ...(listValues(source?.reference_image_urls))
  ]).slice(0, 8);
}

function finalSourceLimit() {
  return Math.max(25, Math.floor(Number(config.maxResearchCandidates || 25)));
}

function researchRetryDelayMinutes() {
  if (Number(config.researchRetryDelayMinutes) > 0) return Number(config.researchRetryDelayMinutes);
  return 5;
}

function localWorkerFailureRetryMinutes() {
  return Math.max(5, Number(config.researchTechnicalRetryDelayMinutes || 15));
}

function localWorkerLeaseMinutes() {
  return Math.max(5, Number(config.localWorkerLeaseMinutes || 45));
}

function parseJsonBody(rawBody) {
  try {
    return JSON.parse(rawBody || "{}");
  } catch {
    return {};
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data, null, 2));
}

function listValues(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(/\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
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
  const score = number > 0 && number <= 1 ? number * 100 : number;
  return Math.max(0, Math.min(100, score));
}

function safeWorkerError(error) {
  return String(error?.message || error || "Unknown sourcing worker error")
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
