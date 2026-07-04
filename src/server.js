import http from "node:http";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { sendEmail } from "./email.js";
import { isResearchRunning, queueDueResearchAttempts, queueResearch, researchPolicySummary } from "./research.js";
import { handleLocalWorkerClaim, handleLocalWorkerReport, localWorkerHealthFeatures } from "./local-worker.js";
import { fetchShopifyOrderDetails } from "./shopify.js";
import { adminRefundDue, customerOptionSelectedAdmin, customerRefundDue, depositReceived, stageUpdate } from "./templates.js";
import { addTimeline, getJob, readJobs, upsertJob } from "./storage.js";

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      const researchPolicy = researchPolicySummary();
      return json(res, 200, {
        ok: true,
        service: "arcovia-ai-sourcing",
        jobs: readJobs().length,
        features: {
          shopifyOrderEnrichment: true,
          safeOrderResearchRetry: true,
          cappedOpenAIResearchTokens: true,
          deepResearchLoop: true,
          deepResearchPolicy: researchPolicy,
          deepResearchMaxAttempts: researchPolicy.maxTotalAttempts,
          deepResearchSearchContextSize: "high",
          deepResearchReasoningEffort: config.openaiReasoningEffort,
          deepResearchMaxOutputTokens: Math.max(config.openaiMaxOutputTokens, 12000),
          continuousResearchUntilMaxAttempts: false,
          superDeepFirstSearch: true,
          retryOnlyIfNoMatch: true,
          extraConfirmationSearchAfterMatch: true,
          technicalRetryDelayRespected: true,
          researchSchedulerPolicyVersion: "super_deep_conditional_v2",
          ...localWorkerHealthFeatures(),
          activeResearchRetryMinutes: config.researchRetryDelayMinutes || 5,
          allOrdersSupplierReview: true,
          anonymizedCustomerOptionsPage: true,
          anonymizedCustomerImageProxy: true,
          customerSupplierChoiceCapture: true,
          resendDefaultSenderFallback: true,
          resendReplyToAddress: Boolean(config.replyToEmail),
          missingBriefFixLinks: true,
          refundDueStatus: true,
          adminJobsEndpoint: Boolean(config.adminStatusSecret || config.flowSecret)
        }
      });
    }

    if (req.method === "GET" && url.pathname === "/admin/jobs") {
      return handleAdminJobs(req, res, url);
    }

    if (req.method === "POST" && url.pathname === "/local-worker/claim") {
      return handleLocalWorkerClaim(req, res);
    }

    if (req.method === "POST" && url.pathname === "/local-worker/report") {
      return handleLocalWorkerReport(req, res);
    }

    if (req.method === "GET" && url.pathname === "/monitor-lite") {
      return handleMonitorLitePage(req, res);
    }

    if (req.method === "GET" && url.pathname === "/monitor") {
      return handleMonitorPage(req, res, url);
    }

    if (req.method === "POST" && url.pathname === "/monitor/select-supplier") {
      return handleSelectSupplier(req, res);
    }

    if (req.method === "GET" && url.pathname === "/review") {
      return handleReviewAllPage(req, res);
    }

    if (req.method === "GET" && url.pathname?.startsWith("/review/")) {
      return handleReviewPage(req, res, url.pathname.split("/").pop());
    }

    if (req.method === "POST" && url.pathname === "/review/select-supplier") {
      return handleReviewSelectSupplier(req, res);
    }

    if (req.method === "GET" && url.pathname?.startsWith("/options-image/")) {
      return handleCustomerOptionImage(req, res, url.pathname);
    }

    if (req.method === "GET" && url.pathname?.startsWith("/options/")) {
      return handleCustomerOptionsPage(req, res, decodeURIComponent(url.pathname.split("/").pop() || ""), url);
    }

    if (req.method === "POST" && url.pathname === "/options/select") {
      return handleCustomerOptionSelect(req, res);
    }

    if (req.method === "POST" && url.pathname === "/flow/order-paid") {
      return handleFlowOrderPaid(req, res);
    }

    if (req.method === "POST" && url.pathname === "/webhooks/shopify/orders-paid") {
      return handleShopifyWebhook(req, res);
    }

    if (req.method === "GET" && url.pathname?.startsWith("/brief/")) {
      return handleBriefForm(req, res, url.pathname.split("/").pop());
    }

    if (req.method === "POST" && url.pathname?.startsWith("/brief/")) {
      return handleBriefSubmit(req, res, url.pathname.split("/").pop());
    }

    if (req.method === "GET" && url.pathname?.startsWith("/status/")) {
      return handleStatusPage(req, res, url.pathname.split("/").pop());
    }

    json(res, 404, { error: "not_found" });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
});

server.listen(config.port, () => {
  console.log(`Arcovia AI sourcing server listening on http://localhost:${config.port}`);
});

setInterval(() => {
  sendDueUpdates().catch((error) => console.error("update scheduler failed", error));
  if (!config.localCodexWorkerEnabled) queueDueResearchAttempts();
}, 60_000);

async function handleFlowOrderPaid(req, res) {
  if (config.flowSecret) {
    const provided = req.headers["x-arcovia-flow-secret"];
    if (provided !== config.flowSecret) return json(res, 401, { error: "invalid_flow_secret" });
  }

  const rawBody = await readBody(req);
  const payload = JSON.parse(rawBody || "{}");

  if (req.headers["x-arcovia-dry-run"] === "1") {
    return json(res, 200, {
      ok: true,
      dry_run: true,
      deposit_order: isDepositOrder(payload),
      product_request_present: Boolean(extractProductRequest(payload)),
      order_name: payload.order_name || payload.name || null
    });
  }

  const job = await createJobFromOrderPayload(payload, "shopify_flow", {
    skipDepositEmail: req.headers["x-arcovia-skip-deposit-email"] === "1",
    forceResearch: req.headers["x-arcovia-force-research"] === "1"
  });
  json(res, 202, { ok: true, job_id: job.id, status: job.status });
}

async function handleShopifyWebhook(req, res) {
  const rawBody = await readBody(req);
  if (!verifyShopifyWebhook(rawBody, req.headers["x-shopify-hmac-sha256"])) {
    return json(res, 401, { error: "invalid_shopify_hmac" });
  }

  const payload = JSON.parse(rawBody || "{}");
  const job = await createJobFromOrderPayload(payload, "shopify_webhook");
  json(res, 202, { ok: true, job_id: job.id, status: job.status });
}

async function createJobFromOrderPayload(payload, source, options = {}) {
  if (!isDepositOrder(payload)) {
    return {
      id: null,
      status: "ignored_non_deposit_order",
      ignored: true
    };
  }

  const orderName = payload.order_name || payload.name || `Order ${payload.order_id || payload.id || "unknown"}`;
  const orderId = String(payload.order_id || payload.id || payload.admin_graphql_api_id || orderName);
  const existing = readJobs().find((job) => job.orderId === orderId || job.orderName === orderName);
  const enrichedPayload = await enrichOrderPayload(payload);
  const productRequest = extractProductRequest(enrichedPayload);
  if (existing) return updateExistingJobFromOrder(existing, enrichedPayload, productRequest, source, options);

  const now = new Date();
  const job = {
    id: randomUUID(),
    publicToken: randomUUID(),
    reviewToken: randomUUID(),
    customerOptionsToken: randomUUID(),
    source,
    orderId,
    orderName,
    customerEmail: enrichedPayload.email || enrichedPayload.customer_email || enrichedPayload.customer?.email || "",
    customerName: enrichedPayload.customer_name || enrichedPayload.customer?.displayName || enrichedPayload.customer?.first_name || "",
    productRequest,
    status: productRequest ? "researching" : "awaiting_brief",
    researchAttemptCount: 0,
    maxResearchAttempts: researchPolicySummary().maxTotalAttempts,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    nextUpdateAt: addHours(now, config.updateIntervalHours).toISOString(),
    sourcingWindowEndsAt: addDays(now, config.maxSourcingDays).toISOString(),
    rawOrder: enrichedPayload,
    timeline: []
  };

  addTimeline(job, "job_created", `Sourcing job created from ${source}.`);
  if (productRequest) {
    addTimeline(job, "brief_captured", "Product brief captured from the paid Shopify order.");
    if (config.localCodexWorkerEnabled) {
      addTimeline(job, "local_worker_waiting", "Local Codex worker mode is enabled. Waiting for the always-on PC worker to claim this research job.");
    }
  } else {
    addTimeline(job, "awaiting_brief", "Paid order received, but no product brief was attached to the order.");
  }
  upsertJob(job);

  if (!options.skipDepositEmail) {
    await sendEmail({ to: job.customerEmail, ...depositReceived(job) });
  }

  if (productRequest && !config.localCodexWorkerEnabled) queueResearch(job.id);
  return job;
}

async function updateExistingJobFromOrder(existing, payload, productRequest, source, options = {}) {
  existing.reviewToken ||= randomUUID();
  existing.customerOptionsToken ||= randomUUID();
  existing.rawOrder = {
    ...(existing.rawOrder || {}),
    ...payload
  };

  if (!existing.productRequest?.trim() && productRequest) {
    existing.productRequest = productRequest;
    addTimeline(existing, "brief_captured", `Product brief captured from ${source}.`);
  }

  if (existing.productRequest?.trim() && ["awaiting_brief", "research_failed"].includes(existing.status)) {
    existing.status = "researching";
    addTimeline(existing, "research_requeued", config.localCodexWorkerEnabled
      ? "Local Codex worker research was queued from the latest paid-order payload."
      : "AI supplier research was queued from the latest paid-order payload.");
    upsertJob(existing);
    if (!config.localCodexWorkerEnabled) queueResearch(existing.id);
    return existing;
  }

  if (options.forceResearch && existing.productRequest?.trim()) {
    existing.status = "researching";
    existing.currentResearchAttempt = null;
    existing.nextResearchAt = null;
    addTimeline(existing, "research_requeued", config.localCodexWorkerEnabled
      ? "Local Codex worker research was force-queued from the latest paid-order payload."
      : "AI supplier research was force-queued from the latest paid-order payload.");
    upsertJob(existing);
    if (!config.localCodexWorkerEnabled) queueResearch(existing.id);
    return existing;
  }

  upsertJob(existing);
  return existing;
}

async function enrichOrderPayload(payload) {
  if (extractProductRequest(payload)) return payload;

  try {
    const shopifyOrder = await fetchShopifyOrderDetails(payload);
    if (!shopifyOrder) return payload;
    return mergeOrderPayload(payload, shopifyOrder);
  } catch (error) {
    console.error("Shopify order enrichment failed", error);
    return payload;
  }
}

function mergeOrderPayload(payload, shopifyOrder) {
  return {
    ...payload,
    order_id: payload.order_id || shopifyOrder.order_id,
    order_name: payload.order_name || shopifyOrder.order_name,
    email: payload.email || shopifyOrder.email,
    customer_name: payload.customer_name || shopifyOrder.customer_name,
    note: payload.note || shopifyOrder.note,
    customAttributes: [
      ...(payload.customAttributes || []),
      ...(shopifyOrder.customAttributes || [])
    ],
    line_items: mergeLineItems(normalizeLineItems(payload), shopifyOrder.line_items || [])
  };
}

function mergeLineItems(payloadItems, shopifyItems) {
  if (!payloadItems.length) return shopifyItems;

  return payloadItems.map((item, index) => ({
    ...(shopifyItems[index] || {}),
    ...item,
    properties: [
      ...((item.properties || []).map((prop) => ({ ...prop }))),
      ...((shopifyItems[index]?.properties || []).map((prop) => ({ ...prop })))
    ],
    customAttributes: [
      ...((item.customAttributes || []).map((prop) => ({ ...prop }))),
      ...((shopifyItems[index]?.customAttributes || []).map((prop) => ({ ...prop })))
    ]
  }));
}

function handleAdminJobs(req, res, url) {
  const validAdminSecret = config.adminStatusSecret && req.headers["x-arcovia-admin-secret"] === config.adminStatusSecret;
  const validFlowSecret = config.flowSecret && req.headers["x-arcovia-flow-secret"] === config.flowSecret;

  if (!config.adminStatusSecret && !config.flowSecret) return json(res, 404, { error: "not_found" });
  if (!validAdminSecret && !validFlowSecret) {
    return json(res, 401, { error: "invalid_admin_secret" });
  }

  const details = url.searchParams.get("details") === "1";
  const jobs = readJobs().map((job) => serializeJob(job, details));

  json(res, 200, { ok: true, jobs });
}

function monitorPageStyles() {
  return `<style>
    .monitor-shell { max-width:1180px; }
    .card.pro-card { overflow:hidden; padding:0; }
    .job-head { display:flex; justify-content:space-between; gap:14px; align-items:flex-start; padding:18px; border-bottom:1px solid #3a101b; background:radial-gradient(circle at top right, rgba(122,16,40,.42), transparent 38%), #16080d; }
    .job-title { margin:0; display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
    .job-meta { margin-top:8px; color:#d8b8c0; font-size:13px; line-height:1.45; }
    .job-body { padding:18px; }
    .summary-box, .selected-box, .warning-box { border:1px solid #4b1724; background:#0f0609; border-radius:16px; padding:14px; margin:14px 0; }
    .selected-box { border-color:#2f8f58; background:#092014; }
    .warning-box { border-color:#9b6a16; background:#211505; }
    .quick-links { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
    .pill { display:inline-flex; align-items:center; gap:6px; border:1px solid #4b1724; background:#10070a; color:#ffd7df; border-radius:999px; padding:7px 10px; font-size:12px; text-decoration:none; }
    .section-stack { display:grid; gap:12px; margin-top:16px; }
    details.source-section { border:1px solid #3a101b; border-radius:16px; background:#10070a; overflow:hidden; }
    details.source-section[open] { border-color:#7a1028; box-shadow:0 12px 26px rgba(0,0,0,.22); }
    details.source-section > summary { cursor:pointer; list-style:none; display:flex; justify-content:space-between; align-items:center; gap:12px; padding:14px 16px; font-weight:900; color:#fff; background:#16080d; }
    details.source-section > summary::-webkit-details-marker { display:none; }
    .section-subtitle { color:#d8b8c0; display:block; font-size:12px; font-weight:500; margin-top:3px; }
    .count-badge { min-width:34px; text-align:center; border-radius:999px; padding:6px 9px; background:#7a1028; color:#fff; font-weight:900; }
    .source-grid { display:grid; gap:12px; padding:14px; }
    .source-card { display:grid; grid-template-columns:88px minmax(0,1fr); gap:14px; border:1px solid #32101a; background:#0b0407; border-radius:16px; padding:12px; }
    .source-card.rejected { border-color:#4b1724; background:#110609; }
    .source-card.approved { border-color:#245b3b; background:#07170f; }
    .source-card.candidate { border-color:#72551d; background:#151006; }
    .source-image { width:88px; height:88px; border-radius:14px; border:1px solid #34111a; object-fit:cover; background:#1a0a0f; display:block; }
    .image-fallback { width:88px; height:88px; border-radius:14px; border:1px dashed #562033; background:linear-gradient(145deg,#1d0a10,#080406); color:#d8b8c0; display:flex; align-items:center; justify-content:center; text-align:center; font-size:11px; line-height:1.2; padding:8px; }
    .source-title { margin:0; font-size:16px; font-weight:900; color:#fff; line-height:1.25; }
    .source-type { color:#d8b8c0; font-size:12px; margin-top:3px; }
    .source-metrics { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; margin:10px 0; }
    .metric { border:1px solid #2d1018; border-radius:12px; padding:9px; background:#13080c; min-width:0; }
    .metric span { display:block; color:#d8b8c0; font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
    .metric b { display:block; margin-top:3px; color:#fff; font-size:13px; overflow-wrap:anywhere; }
    .risk-low { color:#6ee7a8; }
    .risk-medium, .risk-unknown { color:#f3c56b; }
    .risk-high, .risk-unsafe { color:#ff8fa3; }
    .source-note { margin:8px 0 0; color:#ead7dc; font-size:13px; line-height:1.45; }
    .mini-list { margin:8px 0 0; padding-left:18px; color:#d8b8c0; font-size:12px; line-height:1.45; }
    .source-actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; align-items:center; }
    .source-actions form { margin:0; }
    .source-actions button { cursor:pointer; width:auto; }
    .button.secondary { background:#1b0a10; border-color:#4b1724; }
    .button.warning { background:#6b3d08; border-color:#b47915; }
    .button.success { background:#165c35; border-color:#2f8f58; }
    .empty-section { padding:14px; color:#d8b8c0; }
    .timeline-wrap { margin-top:16px; }
    @media (min-width: 760px) {
      .source-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
      .source-card.wide { grid-column:1 / -1; }
      .source-metrics { grid-template-columns:repeat(4,minmax(0,1fr)); }
    }
    @media (max-width: 560px) {
      .job-head { display:block; }
      .source-card { grid-template-columns:1fr; }
      .source-image, .image-fallback { width:100%; height:180px; }
      .source-metrics { grid-template-columns:1fr; }
    }
  </style>`;
}

function handleMonitorPage(_req, res, url) {
  const key = url.searchParams.get("key") || "";
  if (!isValidMonitorKey(key)) {
    return redirect(res, "/monitor-lite");
  }

  const jobs = readJobs()
    .map((job) => serializeJob(job, true))
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  const cards = jobs.map((job) => monitorJobCard(job, { key })).join("");
  const refreshUrl = `/monitor?key=${encodeURIComponent(key)}`;

  return html(res, 200, `<!doctype html>
<html>
<head>
  <title>Arcovia AI monitor</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="30" />
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: Arial, sans-serif; background:#080406; color:#fff; }
    header { position:sticky; top:0; z-index:2; padding:18px 16px; background:linear-gradient(135deg,#16080d,#320817); border-bottom:1px solid #6b1024; }
    main { padding:16px; max-width:980px; margin:0 auto; }
    h1 { margin:0 0 6px; font-size:24px; }
    h2 { margin:0 0 8px; font-size:20px; }
    h3 { margin:18px 0 8px; font-size:16px; color:#ffd7df; }
    p { line-height:1.45; }
    a { color:#ffd7df; }
    .muted { color:#d8b8c0; font-size:14px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-top:12px; }
    .button { display:inline-block; text-decoration:none; font-weight:700; color:#fff; background:#7a1028; border:1px solid #bc3456; padding:10px 12px; border-radius:999px; }
    .grid { display:grid; gap:14px; }
    .card { border:1px solid #6b1024; background:#16080d; border-radius:18px; padding:16px; box-shadow:0 12px 30px rgba(0,0,0,.25); }
    .status { display:inline-block; padding:7px 10px; border-radius:999px; font-weight:800; letter-spacing:.03em; text-transform:uppercase; font-size:12px; }
    .researching { background:#8a5b00; }
    .human_review, .supplier_selected { background:#165c35; }
    .refund_due, .research_failed { background:#7a1028; }
    .awaiting_brief { background:#4b5563; }
    .stats { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; margin:14px 0; }
    .stat { background:#0f0609; border:1px solid #3a101b; border-radius:14px; padding:12px; }
    .stat b { display:block; font-size:22px; }
    .stat span { color:#d8b8c0; font-size:12px; }
    .timeline { margin:8px 0 0; padding-left:20px; }
    .timeline li { margin:0 0 10px; color:#ead7dc; }
    .supplier { border-top:1px solid #3a101b; padding-top:10px; margin-top:10px; }
    .supplier-title { font-weight:800; }
    @media (min-width: 760px) { .stats { grid-template-columns:repeat(5,minmax(0,1fr)); } }
  </style>
  ${monitorPageStyles()}
</head>
<body>
  <header>
    <h1>Arcovia AI monitor</h1>
    <div class="muted">Auto-refreshes every 30 seconds. Last loaded: ${escapeHtml(formatEventTime(new Date().toISOString()))}</div>
    <div class="toolbar">
      <a class="button" href="${escapeHtml(refreshUrl)}">Refresh now</a>
    </div>
  </header>
  <main class="monitor-shell">
    ${cards || `<div class="card"><h2>No sourcing jobs yet</h2><p class="muted">When a paid Shopify deposit triggers the AI, it will appear here.</p></div>`}
  </main>
</body>
</html>`);
}

function handleReviewPage(_req, res, token) {
  const job = getJobByReviewToken(token);
  if (!job) {
    return html(res, 404, `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Review link not found</title></head><body><h1>Review link not found</h1><p>This supplier review link is not active. Ask Arcovia to generate a fresh link.</p></body></html>`);
  }

  const serializedJob = serializeJob(job, true);
  const card = monitorJobCard(serializedJob, { reviewToken: token, hideCustomer: true });

  return html(res, 200, `<!doctype html>
<html>
<head>
  <title>Arcovia supplier review</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="30" />
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: Arial, sans-serif; background:#080406; color:#fff; }
    header { position:sticky; top:0; z-index:2; padding:18px 16px; background:linear-gradient(135deg,#16080d,#320817); border-bottom:1px solid #6b1024; }
    main { padding:16px; max-width:980px; margin:0 auto; }
    h1 { margin:0 0 6px; font-size:24px; }
    h2 { margin:0 0 8px; font-size:20px; }
    h3 { margin:18px 0 8px; font-size:16px; color:#ffd7df; }
    p { line-height:1.45; }
    a { color:#ffd7df; }
    button { cursor:pointer; }
    .muted { color:#d8b8c0; font-size:14px; }
    .button { display:inline-block; text-decoration:none; font-weight:700; color:#fff; background:#7a1028; border:1px solid #bc3456; padding:10px 12px; border-radius:999px; }
    .card { border:1px solid #6b1024; background:#16080d; border-radius:18px; padding:16px; box-shadow:0 12px 30px rgba(0,0,0,.25); }
    .status { display:inline-block; padding:7px 10px; border-radius:999px; font-weight:800; letter-spacing:.03em; text-transform:uppercase; font-size:12px; }
    .researching { background:#8a5b00; }
    .human_review, .supplier_selected { background:#165c35; }
    .refund_due, .research_failed { background:#7a1028; }
    .awaiting_brief { background:#4b5563; }
    .stats { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; margin:14px 0; }
    .stat { background:#0f0609; border:1px solid #3a101b; border-radius:14px; padding:12px; }
    .stat b { display:block; font-size:22px; }
    .stat span { color:#d8b8c0; font-size:12px; }
    .timeline { margin:8px 0 0; padding-left:20px; }
    .timeline li { margin:0 0 10px; color:#ead7dc; }
    .supplier { border-top:1px solid #3a101b; padding-top:10px; margin-top:10px; }
    .supplier-title { font-weight:800; }
    @media (min-width: 760px) { .stats { grid-template-columns:repeat(5,minmax(0,1fr)); } }
  </style>
  ${monitorPageStyles()}
</head>
<body>
  <header>
    <h1>Supplier review</h1>
    <div class="muted">No password needed. Do not share this link outside Arcovia.</div>
  </header>
  <main class="monitor-shell">${card}</main>
</body>
</html>`);
}

function handleReviewAllPage(_req, res) {
  const jobs = readJobs()
    .map((job) => {
      job.reviewToken ||= randomUUID();
      upsertJob(job);
      return serializeJob(job, true);
    })
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  const cards = jobs.map((job) => monitorJobCard(job, { reviewToken: job.reviewToken, hideCustomer: true })).join("");

  return html(res, 200, `<!doctype html>
<html>
<head>
  <title>Arcovia supplier review</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="30" />
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: Arial, sans-serif; background:#080406; color:#fff; }
    header { position:sticky; top:0; z-index:2; padding:18px 16px; background:linear-gradient(135deg,#16080d,#320817); border-bottom:1px solid #6b1024; }
    main { display:grid; gap:16px; padding:16px; max-width:980px; margin:0 auto; }
    h1 { margin:0 0 6px; font-size:24px; }
    h2 { margin:0 0 8px; font-size:20px; }
    h3 { margin:18px 0 8px; font-size:16px; color:#ffd7df; }
    p { line-height:1.45; }
    a { color:#ffd7df; }
    button { cursor:pointer; }
    .muted { color:#d8b8c0; font-size:14px; }
    .button { display:inline-block; text-decoration:none; font-weight:700; color:#fff; background:#7a1028; border:1px solid #bc3456; padding:10px 12px; border-radius:999px; }
    .card { border:1px solid #6b1024; background:#16080d; border-radius:18px; padding:16px; box-shadow:0 12px 30px rgba(0,0,0,.25); }
    .status { display:inline-block; padding:7px 10px; border-radius:999px; font-weight:800; letter-spacing:.03em; text-transform:uppercase; font-size:12px; }
    .researching { background:#8a5b00; }
    .human_review, .supplier_selected { background:#165c35; }
    .refund_due, .research_failed { background:#7a1028; }
    .awaiting_brief { background:#4b5563; }
    .stats { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; margin:14px 0; }
    .stat { background:#0f0609; border:1px solid #3a101b; border-radius:14px; padding:12px; }
    .stat b { display:block; font-size:22px; }
    .stat span { color:#d8b8c0; font-size:12px; }
    .timeline { margin:8px 0 0; padding-left:20px; }
    .timeline li { margin:0 0 10px; color:#ead7dc; }
    .supplier { border-top:1px solid #3a101b; padding-top:10px; margin-top:10px; }
    .supplier-title { font-weight:800; }
    @media (min-width: 760px) { .stats { grid-template-columns:repeat(5,minmax(0,1fr)); } }
  </style>
  ${monitorPageStyles()}
</head>
<body>
  <header>
    <h1>Supplier review</h1>
    <div class="muted">No password. New orders appear here automatically. Do not share this internal page outside Arcovia.</div>
  </header>
  <main class="monitor-shell">${cards || `<div class="card"><h2>No sourcing jobs yet</h2><p class="muted">When new paid deposit orders reach the AI, they will appear here.</p></div>`}</main>
</body>
</html>`);
}

async function handleSelectSupplier(req, res) {
  const body = await readBody(req);
  const form = new URLSearchParams(body);
  const key = String(form.get("key") || "");
  if (!isValidMonitorKey(key)) {
    return html(res, 401, monitorLoginHtml());
  }

  const jobId = String(form.get("job_id") || "");
  const sourceGroup = String(form.get("source_group") || "suppliers");
  const supplierIndex = Number(form.get("supplier_index"));
  const job = getJob(jobId);
  const supplier = getSelectableSource(job, sourceGroup, supplierIndex);
  if (!job || !supplier) {
    return html(res, 404, "<h1>Supplier not found</h1><p>Go back to the monitor and refresh.</p>");
  }

  markSupplierSelected(job, supplier, supplierIndex, sourceGroup);

  return redirect(res, `/monitor?key=${encodeURIComponent(key)}#${encodeURIComponent(job.id)}`);
}

async function handleReviewSelectSupplier(req, res) {
  const body = await readBody(req);
  const form = new URLSearchParams(body);
  const reviewToken = String(form.get("review_token") || "");
  const sourceGroup = String(form.get("source_group") || "suppliers");
  const supplierIndex = Number(form.get("supplier_index"));
  const job = getJobByReviewToken(reviewToken);
  const supplier = getSelectableSource(job, sourceGroup, supplierIndex);
  if (!job || !supplier) {
    return html(res, 404, "<h1>Supplier not found</h1><p>Go back to the review link and refresh.</p>");
  }

  markSupplierSelected(job, supplier, supplierIndex, sourceGroup);
  return redirect(res, `/review/${encodeURIComponent(reviewToken)}`);
}

function handleCustomerOptionsPage(_req, res, token, url) {
  const job = getJobByCustomerOptionsToken(token);
  if (!job) {
    return html(res, 404, `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Options link not found</title></head><body><h1>Options link not found</h1><p>This Arcovia options link is not active.</p></body></html>`);
  }

  const suppliers = job.research?.suppliers || [];
  const optionsReady = Boolean(job.researchCompletedAt && suppliers.length);
  const selected = job.customerSelectedOption || null;
  const selectedNotice = selected
    ? `<div class="notice success"><strong>Your choice was received.</strong><br>You selected ${escapeHtml(selected.optionLabel || `Supplier ${Number(selected.index || 0) + 1}`)}. Arcovia will confirm availability and the final quote before the next payment step.</div>`
    : url.searchParams.get("selected") === "1"
      ? `<div class="notice success"><strong>Your choice was received.</strong><br>Arcovia will confirm availability and the final quote before the next payment step.</div>`
      : "";
  const optionCards = optionsReady
    ? suppliers.map((source, index) => customerOptionCard(source, index, token, selected, job)).join("")
    : "";

  return html(res, 200, `<!doctype html>
<html>
<head>
  <title>Arcovia sourcing options</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex,nofollow" />
  <style>
    :root { color-scheme: dark; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:Arial, sans-serif; background:#080406; color:#fff; }
    header { padding:22px 16px; background:radial-gradient(circle at top right, rgba(122,16,40,.5), transparent 42%), linear-gradient(135deg,#16080d,#320817); border-bottom:1px solid #6b1024; }
    main { max-width:980px; margin:0 auto; padding:16px; }
    h1 { margin:0 0 8px; font-size:28px; letter-spacing:-.02em; }
    h2 { margin:0 0 8px; font-size:19px; }
    p { line-height:1.5; }
    .muted { color:#d8b8c0; font-size:14px; }
    .badge { display:inline-block; margin-top:8px; padding:7px 10px; border-radius:999px; background:#7a1028; color:#fff; font-weight:900; font-size:12px; text-transform:uppercase; letter-spacing:.05em; }
    .notice { border:1px solid #4b1724; background:#12070b; border-radius:16px; padding:14px; margin:14px 0; line-height:1.45; }
    .notice.success { border-color:#2f8f58; background:#092014; }
    .options-grid { display:grid; gap:14px; margin-top:16px; }
    .option-card { display:grid; grid-template-columns:140px minmax(0,1fr); gap:16px; border:1px solid #4b1724; background:#13080c; border-radius:20px; padding:14px; box-shadow:0 12px 30px rgba(0,0,0,.22); }
    .option-card.chosen { border-color:#2f8f58; background:#07170f; }
    .option-image { width:140px; height:140px; border-radius:16px; border:1px solid #34111a; object-fit:cover; background:#1a0a0f; display:block; }
    .image-fallback { width:140px; height:140px; border-radius:16px; border:1px dashed #562033; background:linear-gradient(145deg,#1d0a10,#080406); color:#d8b8c0; display:flex; align-items:center; justify-content:center; text-align:center; font-size:12px; line-height:1.25; padding:10px; }
    .price { display:inline-block; margin:4px 0 10px; padding:10px 12px; border-radius:14px; background:#7a1028; border:1px solid #bc3456; font-weight:900; }
    .details { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; margin:10px 0; }
    .detail { border:1px solid #2d1018; border-radius:12px; padding:9px; background:#0f0609; min-width:0; }
    .detail span { display:block; color:#d8b8c0; font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
    .detail b { display:block; margin-top:3px; color:#fff; overflow-wrap:anywhere; }
    button { cursor:pointer; border:1px solid #bc3456; background:#7a1028; color:#fff; padding:12px 16px; border-radius:999px; font-weight:900; font-size:15px; }
    .chosen-label { display:inline-block; border:1px solid #2f8f58; background:#092014; color:#8df0ba; padding:10px 12px; border-radius:999px; font-weight:900; }
    @media (min-width: 760px) { .options-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
    @media (max-width: 620px) {
      .option-card { grid-template-columns:1fr; }
      .option-image, .image-fallback { width:100%; height:210px; }
      .details { grid-template-columns:1fr; }
    }
  </style>
</head>
<body>
  <header>
    <main>
      <h1>Your Arcovia sourcing options</h1>
      <p class="muted">Order ${escapeHtml(job.orderName)}. Supplier details are kept private by Arcovia. Choose by option number, price, and product image.</p>
      <span class="badge">${escapeHtml(optionsReady ? `${suppliers.length} approved option${suppliers.length === 1 ? "" : "s"}` : "Research not ready yet")}</span>
    </main>
  </header>
  <main>
    ${selectedNotice}
    ${optionsReady
      ? `<div class="notice">These are the approved options from completed research. Prices are estimates until Arcovia confirms live availability, delivery, and the final quote.</div><section class="options-grid">${optionCards}</section>`
      : `<div class="notice"><strong>Your options are not ready yet.</strong><br>Arcovia is still completing the research/review process. You will receive the options link by email when the approved shortlist is ready.</div>`}
  </main>
</body>
</html>`);
}

async function handleCustomerOptionSelect(req, res) {
  const body = await readBody(req);
  const form = new URLSearchParams(body);
  const token = String(form.get("token") || "");
  const optionIndex = Number(form.get("option_index"));
  const job = getJobByCustomerOptionsToken(token);
  const supplier = job?.research?.suppliers?.[optionIndex] || null;

  if (!job || !supplier) {
    return html(res, 404, "<h1>Option not found</h1><p>Go back to the options page and refresh.</p>");
  }

  if (!job.researchCompletedAt) {
    return html(res, 400, "<h1>Options are not ready yet</h1><p>Arcovia is still completing the research process.</p>");
  }

  if (!job.customerSelectedOption) {
    const optionLabel = `Supplier ${optionIndex + 1}`;
    job.customerSelectedOption = {
      index: optionIndex,
      optionLabel,
      selectedAt: new Date().toISOString(),
      supplier
    };
    addTimeline(job, "customer_option_selected", `Customer selected ${optionLabel}. Arcovia must still confirm and approve before purchasing.`, {
      optionIndex,
      optionLabel,
      supplierName: supplier.name || "",
      supplierUrl: supplier.url || ""
    });
    upsertJob(job);
    await sendEmail({ to: config.adminEmail, ...customerOptionSelectedAdmin(job) });
  }

  return redirect(res, `/options/${encodeURIComponent(token)}?selected=1`);
}

async function handleCustomerOptionImage(_req, res, pathname) {
  const parts = pathname.split("/").filter(Boolean);
  const token = decodeURIComponent(parts[1] || "");
  const optionIndex = Number(parts[2]);
  const job = getJobByCustomerOptionsToken(token);
  const source = job?.research?.suppliers?.[optionIndex] || null;
  const imageUrl = customerOptionImageUrl(job, optionIndex);

  if (!job || !source || !isSafeImageUrl(imageUrl)) {
    return customerImagePlaceholder(res);
  }

  try {
    const response = await fetch(imageUrl, {
      redirect: "follow",
      headers: {
        "user-agent": "ArcoviaImageProxy/1.0"
      }
    });
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok || !contentType.toLowerCase().startsWith("image/")) {
      return customerImagePlaceholder(res);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 5 * 1024 * 1024) return customerImagePlaceholder(res);

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=3600",
      "X-Robots-Tag": "noindex"
    });
    res.end(buffer);
  } catch {
    customerImagePlaceholder(res);
  }
}

function getSelectableSource(job, sourceGroup, sourceIndex) {
  const groups = {
    suppliers: job?.research?.suppliers || [],
    candidateSources: job?.research?.candidateSources || [],
    rejectedSources: job?.research?.rejectedSources || []
  };
  return groups[sourceGroup]?.[sourceIndex] || null;
}

function markSupplierSelected(job, supplier, supplierIndex, sourceGroup = "suppliers") {
  job.selectedSupplier = {
    index: supplierIndex,
    sourceGroup,
    selectedAt: new Date().toISOString(),
    supplier
  };
  job.status = "supplier_selected";
  job.nextUpdateAt = null;
  job.nextResearchAt = null;
  job.currentResearchAttempt = null;
  job.researchCompletedAt ||= new Date().toISOString();
  addTimeline(job, "supplier_selected", `Arcovia selected supplier/source: ${supplier.name || "Unnamed source"}.`, {
    supplierIndex,
    sourceGroup,
    supplierName: supplier.name || "",
    supplierUrl: supplier.url || ""
  });
  upsertJob(job);
}

function handleMonitorLitePage(_req, res) {
  const jobs = readJobs()
    .map((job) => serializeJob(job, false))
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  const activeCount = jobs.filter((job) => job.researchRunning).length;
  const reviewCount = jobs.filter((job) => job.status === "human_review").length;
  const refundCount = jobs.filter((job) => job.status === "refund_due").length;
  const cards = jobs.map((job) => monitorLiteJobCard(job)).join("");

  return html(res, 200, `<!doctype html>
<html>
<head>
  <title>Arcovia AI lite monitor</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="30" />
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: Arial, sans-serif; background:#080406; color:#fff; }
    header { position:sticky; top:0; z-index:2; padding:18px 16px; background:linear-gradient(135deg,#16080d,#320817); border-bottom:1px solid #6b1024; }
    main { padding:16px; max-width:860px; margin:0 auto; }
    h1 { margin:0 0 6px; font-size:24px; }
    h2 { margin:0 0 8px; font-size:20px; }
    a { color:#ffd7df; }
    .muted { color:#d8b8c0; font-size:14px; line-height:1.45; }
    .button { display:inline-block; text-decoration:none; font-weight:700; color:#fff; background:#7a1028; border:1px solid #bc3456; padding:10px 12px; border-radius:999px; }
    .grid { display:grid; gap:14px; }
    .card { border:1px solid #6b1024; background:#16080d; border-radius:18px; padding:16px; box-shadow:0 12px 30px rgba(0,0,0,.25); }
    .status { display:inline-block; padding:7px 10px; border-radius:999px; font-weight:800; letter-spacing:.03em; text-transform:uppercase; font-size:12px; }
    .researching { background:#8a5b00; }
    .human_review, .supplier_selected { background:#165c35; }
    .refund_due, .research_failed { background:#7a1028; }
    .awaiting_brief { background:#4b5563; }
    .stats { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; margin:14px 0; }
    .stat { background:#0f0609; border:1px solid #3a101b; border-radius:14px; padding:12px; }
    .stat b { display:block; font-size:22px; }
    .stat span { color:#d8b8c0; font-size:12px; }
    .banner { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; margin-top:12px; }
    @media (min-width: 760px) { .stats { grid-template-columns:repeat(5,minmax(0,1fr)); } }
  </style>
</head>
<body>
  <header>
    <h1>Arcovia AI monitor</h1>
    <div class="muted">Safe phone view. No customer details or supplier links shown. Auto-refreshes every 30 seconds.</div>
    <div class="banner">
      <div class="stat"><b>${escapeHtml(activeCount)}</b><span>AI running</span></div>
      <div class="stat"><b>${escapeHtml(reviewCount)}</b><span>needs review</span></div>
      <div class="stat"><b>${escapeHtml(refundCount)}</b><span>refund due</span></div>
    </div>
  </header>
  <main class="grid">
    ${cards || `<div class="card"><h2>No sourcing jobs yet</h2><p class="muted">When a paid Shopify deposit triggers the AI, it will appear here.</p></div>`}
  </main>
</body>
</html>`);
}

function serializeJob(job, details = false) {
  const customerOptionsToken = ensureCustomerOptionsToken(job);
  const base = {
    id: job.id,
    reviewToken: job.reviewToken || null,
    reviewLink: job.reviewToken ? `${config.publicBaseUrl.replace(/\/$/, "")}/review/${job.reviewToken}` : null,
    customerOptionsToken,
    customerOptionsLink: customerOptionsToken ? `${config.publicBaseUrl.replace(/\/$/, "")}/options/${customerOptionsToken}` : null,
    customerOptionsSentAt: job.customerOptionsSentAt || null,
    briefLink: job.publicToken ? `${config.publicBaseUrl.replace(/\/$/, "")}/brief/${job.publicToken}` : null,
    orderId: job.orderId,
    orderName: job.orderName,
    customerEmail: job.customerEmail,
    customerName: job.customerName || "",
    status: job.status,
    refundStatus: job.refundStatus || null,
    refundReason: job.refundReason || null,
    selectedSupplier: job.selectedSupplier || null,
    customerSelectedOption: job.customerSelectedOption || null,
    productRequestPresent: Boolean(job.productRequest?.trim()),
    supplierCount: job.research?.suppliers?.length || 0,
    candidateSourceCount: job.research?.candidateSources?.length || 0,
    rejectedSourceCount: job.research?.rejectedSources?.length || 0,
    shippingAgentCount: job.research?.shippingAgents?.length || 0,
    researchAttemptCount: job.researchAttemptCount || 0,
    maxResearchAttempts: Math.min(job.maxResearchAttempts || researchPolicySummary().maxTotalAttempts, researchPolicySummary().maxTotalAttempts),
    currentResearchAttempt: job.currentResearchAttempt || null,
    researchRunning: Boolean(job.id && isResearchRunning(job.id)),
    nextResearchAt: job.nextResearchAt || null,
    nextUpdateAt: job.nextUpdateAt || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    researchStartedAt: job.researchStartedAt || null,
    researchCompletedAt: job.researchCompletedAt || null,
    latestAttempt: (job.researchAttempts || []).at(-1) || null,
    researchSummary: job.research?.summary || null,
    timeline: (job.timeline || []).map((event) => ({
      type: event.type,
      message: event.message,
      at: event.at,
      meta: event.meta || {}
    }))
  };

  if (!details) return base;

  return {
    ...base,
    productRequest: job.productRequest || "",
    missingCustomerDetails: job.research?.missingCustomerDetails || [],
    suppliers: job.research?.suppliers || [],
    candidateSources: job.research?.candidateSources || [],
    rejectedSources: job.research?.rejectedSources || [],
    shippingAgents: job.research?.shippingAgents || [],
    webSources: job.research?.webSources || [],
    rawResearchPreview: String(job.research?.rawText || "").slice(0, 4000)
  };
}

function isValidMonitorKey(key) {
  if (!key) return false;
  return Boolean(
    (config.adminStatusSecret && key === config.adminStatusSecret)
    || (config.flowSecret && key === config.flowSecret)
  );
}

function getJobByReviewToken(token) {
  if (!token) return null;
  return readJobs().find((job) => job.reviewToken === token);
}

function getJobByCustomerOptionsToken(token) {
  if (!token) return null;
  return readJobs().find((job) => job.customerOptionsToken === token);
}

function ensureCustomerOptionsToken(job) {
  if (!job) return "";
  if (job.customerOptionsToken) return job.customerOptionsToken;
  job.customerOptionsToken = randomUUID();
  upsertJob(job);
  return job.customerOptionsToken;
}

function monitorLoginHtml() {
  return `<!doctype html>
<html>
<head>
  <title>Arcovia AI monitor login</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: Arial, sans-serif; background:#080406; color:#fff; margin:0; padding:22px; }
    main { max-width:520px; margin:0 auto; background:#16080d; border:1px solid #6b1024; padding:22px; border-radius:18px; }
    input, button { width:100%; padding:14px; border-radius:12px; border:1px solid #6b1024; margin:8px 0; font-size:16px; }
    input { background:#0f0609; color:#fff; }
    button { background:#7a1028; color:#fff; font-weight:800; }
    .muted { color:#d8b8c0; line-height:1.5; }
  </style>
</head>
<body>
  <main>
    <h1>Arcovia AI monitor</h1>
    <p class="muted">Enter the private monitor key, or use the saved phone link.</p>
    <form method="GET" action="/monitor">
      <input name="key" placeholder="Private monitor key" autocomplete="off" />
      <button type="submit">Open monitor</button>
    </form>
  </main>
</body>
</html>`;
}

function monitorJobCard(job, auth = {}) {
  const maxAttempts = displayMaxResearchAttempts(job);
  const timeline = (job.timeline || []).slice(-6).reverse().map((event) => {
    return `<li><strong>${escapeHtml(formatEventTime(event.at))}</strong><br>${escapeHtml(event.message)}</li>`;
  }).join("");
  const formAction = auth.reviewToken ? "/review/select-supplier" : "/monitor/select-supplier";
  const formAuthFields = auth.reviewToken
    ? `<input type="hidden" name="review_token" value="${escapeHtml(auth.reviewToken)}" />`
    : `<input type="hidden" name="key" value="${escapeHtml(auth.key || "")}" />`;
  const customerLine = auth.hideCustomer
    ? ""
    : `<p class="muted">${escapeHtml(job.customerName || "Customer")} ${job.customerEmail ? `· ${escapeHtml(job.customerEmail)}` : ""}</p>`;
  const selected = job.selectedSupplier?.supplier;
  const selectedHtml = selected ? selectedSourceBox(selected, job.selectedSupplier) : "";
  const customerSelectedHtml = job.customerSelectedOption ? customerSelectedOptionBox(job.customerSelectedOption) : "";
  const missingDetails = (job.missingCustomerDetails || []).slice(0, 5).map((detail) => `<li>${escapeHtml(detail)}</li>`).join("");
  const nextLine = job.nextResearchAt ? `<p class="muted">Next AI check: ${escapeHtml(formatEventTime(job.nextResearchAt))}</p>` : "";
  const completedLine = job.researchCompletedAt ? `<p class="muted">Research completed: ${escapeHtml(formatEventTime(job.researchCompletedAt))}</p>` : "";
  const missingBriefLine = !job.productRequestPresent && job.briefLink
    ? `<p><strong>No product details yet.</strong> The AI cannot search this order until the item details are added.</p><p><a class="button" href="${escapeHtml(job.briefLink)}">Add product details</a></p>`
    : "";
  const runningLine = job.researchRunning
    ? `<p><strong>AI is working right now.</strong> Keep this page open; it refreshes automatically.</p>`
    : `<p class="muted">AI is not currently running for this order.</p>`;
  const sourceSections = [
    sourceSection({
      title: "Approved suppliers",
      subtitle: "Trusted or usable sources that passed the AI's initial checks.",
      items: job.suppliers || [],
      group: "suppliers",
      cardType: "approved",
      formAction,
      formAuthFields,
      job,
      open: Boolean((job.suppliers || []).length)
    }),
    sourceSection({
      title: "Candidate sources",
      subtitle: "Possible leads that need human confirmation before quoting the customer.",
      items: job.candidateSources || [],
      group: "candidateSources",
      cardType: "candidate",
      formAction,
      formAuthFields,
      job,
      open: !Boolean((job.suppliers || []).length) && Boolean((job.candidateSources || []).length)
    }),
    sourceSection({
      title: "Rejected suppliers",
      subtitle: "Sources removed because of stock, match, safety, trust, or availability issues. You can still override one manually.",
      items: job.rejectedSources || [],
      group: "rejectedSources",
      cardType: "rejected",
      formAction,
      formAuthFields,
      job,
      open: false
    }),
    shippingAgentSection(job.shippingAgents || [])
  ].join("");
  const quickLinks = [
    job.reviewLink ? `<a class="pill" href="${escapeHtml(job.reviewLink)}">Review link</a>` : "",
    job.customerOptionsLink ? `<a class="pill" href="${escapeHtml(job.customerOptionsLink)}">Customer options link</a>` : "",
    job.briefLink ? `<a class="pill" href="${escapeHtml(job.briefLink)}">Brief link</a>` : "",
    selected?.url ? `<a class="pill" href="${escapeHtml(selected.url)}" target="_blank" rel="noreferrer">Open selected source</a>` : ""
  ].filter(Boolean).join("");

  return `<section class="card pro-card" id="${escapeHtml(job.id)}">
    <div class="job-head">
      <div>
        <h2 class="job-title">${escapeHtml(job.orderName || "Unknown order")} <span class="status ${escapeHtml(statusClass(job.status))}">${escapeHtml(statusLabel(job.status))}</span></h2>
        ${customerLine}
        <div class="job-meta">
          Created ${escapeHtml(formatEventTime(job.createdAt))}${job.updatedAt ? ` · Updated ${escapeHtml(formatEventTime(job.updatedAt))}` : ""}
          ${job.currentResearchAttempt ? ` · Current check ${escapeHtml(job.currentResearchAttempt)} of ${escapeHtml(maxAttempts)}` : ""}
        </div>
        ${quickLinks ? `<div class="quick-links">${quickLinks}</div>` : ""}
      </div>
    </div>
    <div class="job-body">
      ${missingBriefLine}
      ${runningLine}
      <div class="stats">
        <div class="stat"><b>${escapeHtml(`${job.researchAttemptCount}/${maxAttempts}`)}</b><span>checks</span></div>
        <div class="stat"><b>${escapeHtml(job.supplierCount)}</b><span>approved</span></div>
        <div class="stat"><b>${escapeHtml(job.candidateSourceCount)}</b><span>candidates</span></div>
        <div class="stat"><b>${escapeHtml(job.rejectedSourceCount)}</b><span>rejected</span></div>
        <div class="stat"><b>${escapeHtml(job.shippingAgentCount)}</b><span>shipping agents</span></div>
      </div>
      ${nextLine}
      ${completedLine}
      ${job.researchSummary ? `<div class="summary-box"><h3>Research summary</h3><p class="muted">${escapeHtml(job.researchSummary)}</p></div>` : ""}
      ${missingDetails ? `<div class="warning-box"><h3>Missing details / questions</h3><ul class="mini-list">${missingDetails}</ul></div>` : ""}
      ${customerSelectedHtml}
      ${selectedHtml}
      <div class="section-stack">${sourceSections}</div>
      <div class="timeline-wrap">
        <h3>Latest activity</h3>
        <ul class="timeline">${timeline || "<li>No activity yet.</li>"}</ul>
      </div>
    </div>
  </section>`;
}

function sourceSection({ title, subtitle, items, group, cardType, formAction, formAuthFields, job, open }) {
  const cards = (items || []).map((source, index) => sourceCard(source, index, {
    group,
    cardType,
    formAction,
    formAuthFields,
    job
  })).join("");
  return `<details class="source-section" ${open ? "open" : ""}>
    <summary>
      <span>${escapeHtml(title)}<span class="section-subtitle">${escapeHtml(subtitle)}</span></span>
      <span class="count-badge">${escapeHtml((items || []).length)}</span>
    </summary>
    ${cards ? `<div class="source-grid">${cards}</div>` : `<div class="empty-section">No ${escapeHtml(title.toLowerCase())} captured yet.</div>`}
  </details>`;
}

function customerOptionCard(source, index, token, selected, job) {
  const optionLabel = `Supplier ${index + 1}`;
  const selectedIndex = Number(selected?.index);
  const isChosen = selected && selectedIndex === index;
  const isLocked = Boolean(selected);
  const overBudget = source.over_budget ? "May be above your stated budget" : "Budget fit not confirmed";
  const imageNote = hasSourceImage(source)
    ? "Option image"
    : customerOptionImageUrl(job, index)
      ? "Reference item image"
      : "Image pending";

  return `<article class="option-card ${isChosen ? "chosen" : ""}">
    ${customerOptionImageHtml(token, index, job)}
    <div>
      <h2>${escapeHtml(optionLabel)}</h2>
      <div class="price">Approx total: ${escapeHtml(displayRandTotal(source))}</div>
      <div class="details">
        <div class="detail"><span>Listed price</span><b>${escapeHtml(source.price || "Not captured")}</b></div>
        <div class="detail"><span>Availability</span><b>${escapeHtml(source.availability || "To be confirmed")}</b></div>
        <div class="detail"><span>Budget note</span><b>${escapeHtml(overBudget)}</b></div>
        <div class="detail"><span>Image</span><b>${escapeHtml(imageNote)}</b></div>
      </div>
      <p class="muted">Supplier identity, websites, and sourcing evidence are kept private by Arcovia. Final availability, delivery, and total cost still need confirmation.</p>
      ${isChosen
        ? `<span class="chosen-label">Chosen option</span>`
        : isLocked
          ? `<span class="chosen-label">Another option already chosen</span>`
          : `<form method="POST" action="/options/select">
              <input type="hidden" name="token" value="${escapeHtml(token)}" />
              <input type="hidden" name="option_index" value="${escapeHtml(index)}" />
              <button type="submit">Choose ${escapeHtml(optionLabel)}</button>
            </form>`}
    </div>
  </article>`;
}

function customerOptionImageHtml(token, index, job) {
  const imageUrl = customerOptionImageUrl(job, index);
  if (isSafeImageUrl(imageUrl)) {
    return `<img class="option-image" src="/options-image/${escapeHtml(token)}/${escapeHtml(index)}" alt="${escapeHtml(`Supplier ${index + 1} product image`)}" loading="lazy" />`;
  }
  return `<div class="image-fallback">Product image<br>not available</div>`;
}

function customerOptionImageUrl(job, index) {
  const source = job?.research?.suppliers?.[index] || null;
  const direct = sourceImageUrl(source);
  if (isSafeImageUrl(direct)) return direct;

  const fallbackImages = [
    ...(job?.research?.suppliers || []),
    ...(job?.research?.candidateSources || [])
  ]
    .map(sourceImageUrl)
    .filter(isSafeImageUrl);

  if (!fallbackImages.length) return "";
  return fallbackImages[index % fallbackImages.length];
}

function hasSourceImage(source) {
  return isSafeImageUrl(sourceImageUrl(source));
}

function sourceCard(source, index, { group, cardType, formAction, formAuthFields, job }) {
  const alreadySelected = job.selectedSupplier?.sourceGroup === group && Number(job.selectedSupplier?.index) === index;
  const actionLabel = alreadySelected
    ? "Selected"
    : group === "rejectedSources"
      ? "Override and choose"
      : group === "candidateSources"
        ? "Choose candidate"
        : "Choose supplier";
  const actionClass = group === "rejectedSources" ? "button warning" : group === "candidateSources" ? "button secondary" : "button success";
  const reason = source.reason || source.product_match || "";
  const redFlags = (source.red_flags || []).slice(0, 3).map((flag) => `<li>${escapeHtml(flag)}</li>`).join("");
  const evidence = (source.evidence_urls || []).slice(0, 3).map((url, urlIndex) => `<a class="pill" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Evidence ${escapeHtml(urlIndex + 1)}</a>`).join("");

  return `<article class="source-card ${escapeHtml(cardType)}">
    ${sourceImageHtml(source)}
    <div>
      <h4 class="source-title">${escapeHtml(index + 1)}. ${escapeHtml(source.name || "Unnamed source")}</h4>
      <div class="source-type">${escapeHtml(source.source_type || source.location || "source type not captured")}</div>
      <div class="source-metrics">
        <div class="metric"><span>Approx total in rand</span><b>${escapeHtml(displayRandTotal(source))}</b></div>
        <div class="metric"><span>Listed price</span><b>${escapeHtml(source.price || "Not captured")}</b></div>
        <div class="metric"><span>Trust score</span><b>${escapeHtml(displayTrustScore(source))}</b></div>
        <div class="metric"><span>Risk</span><b class="${escapeHtml(riskClass(source.risk_level))}">${escapeHtml(source.risk_level || "unknown")}</b></div>
      </div>
      ${source.availability ? `<p class="source-note"><strong>Availability:</strong> ${escapeHtml(source.availability)}</p>` : ""}
      ${source.delivery_or_pickup ? `<p class="source-note"><strong>Delivery/pickup:</strong> ${escapeHtml(source.delivery_or_pickup)}</p>` : ""}
      ${reason ? `<p class="source-note">${escapeHtml(reason)}</p>` : ""}
      ${redFlags ? `<ul class="mini-list">${redFlags}</ul>` : ""}
      <div class="source-actions">
        ${source.url ? `<a class="button secondary" href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer">Open source</a>` : ""}
        ${evidence}
        <form method="POST" action="${escapeHtml(formAction)}">
          ${formAuthFields}
          <input type="hidden" name="job_id" value="${escapeHtml(job.id)}" />
          <input type="hidden" name="source_group" value="${escapeHtml(group)}" />
          <input type="hidden" name="supplier_index" value="${escapeHtml(index)}" />
          <button class="${escapeHtml(actionClass)}" type="submit">${escapeHtml(actionLabel)}</button>
        </form>
      </div>
    </div>
  </article>`;
}

function shippingAgentSection(agents) {
  const cards = (agents || []).map((agent, index) => `<article class="source-card wide">
    <div class="image-fallback">Shipping<br>agent</div>
    <div>
      <h4 class="source-title">${escapeHtml(index + 1)}. ${escapeHtml(agent.name || "Unnamed shipping agent")}</h4>
      <div class="source-metrics">
        <div class="metric"><span>Estimated cost</span><b>${escapeHtml(agent.estimated_cost || "Quote needed")}</b></div>
        <div class="metric"><span>Routes</span><b>${escapeHtml(agent.countries_supported || "Not captured")}</b></div>
        <div class="metric"><span>Trust score</span><b>${escapeHtml(displayTrustScore(agent))}</b></div>
        <div class="metric"><span>Risk</span><b class="${escapeHtml(riskClass(agent.risk_level))}">${escapeHtml(agent.risk_level || "unknown")}</b></div>
      </div>
      ${agent.notes ? `<p class="source-note">${escapeHtml(agent.notes)}</p>` : ""}
      <div class="source-actions">
        ${agent.url ? `<a class="button secondary" href="${escapeHtml(agent.url)}" target="_blank" rel="noreferrer">Open shipping agent</a>` : ""}
        ${(agent.evidence_urls || []).slice(0, 3).map((url, urlIndex) => `<a class="pill" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Evidence ${escapeHtml(urlIndex + 1)}</a>`).join("")}
      </div>
    </div>
  </article>`).join("");
  return `<details class="source-section">
    <summary>
      <span>Shipping agents<span class="section-subtitle">Forwarders and shipping options the AI found for international orders.</span></span>
      <span class="count-badge">${escapeHtml((agents || []).length)}</span>
    </summary>
    ${cards ? `<div class="source-grid">${cards}</div>` : `<div class="empty-section">No shipping agents captured yet.</div>`}
  </details>`;
}

function selectedSourceBox(source, selectedSupplier) {
  return `<div class="selected-box">
    <h3>Selected source</h3>
    <p><strong>${escapeHtml(source.name || "Unnamed source")}</strong></p>
    <p class="muted">Chosen from ${escapeHtml(sourceGroupLabel(selectedSupplier?.sourceGroup))} · ${escapeHtml(displayRandTotal(source))} · Trust ${escapeHtml(displayTrustScore(source))} · Risk ${escapeHtml(source.risk_level || "unknown")}</p>
    ${source.url ? `<a class="button success" href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer">Open selected source</a>` : ""}
  </div>`;
}

function customerSelectedOptionBox(selectedOption) {
  const source = selectedOption?.supplier || {};
  const optionLabel = selectedOption?.optionLabel || `Supplier ${Number(selectedOption?.index || 0) + 1}`;

  return `<div class="selected-box">
    <h3>Customer preferred option</h3>
    <p><strong>${escapeHtml(optionLabel)}</strong> was chosen by the customer${selectedOption?.selectedAt ? ` on ${escapeHtml(formatEventTime(selectedOption.selectedAt))}` : ""}.</p>
    <p class="muted">Internal mapping: ${escapeHtml(source.name || "Unnamed source")} · ${escapeHtml(displayRandTotal(source))} · Trust ${escapeHtml(displayTrustScore(source))} · Risk ${escapeHtml(source.risk_level || "unknown")}</p>
    ${source.url ? `<a class="button success" href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer">Open customer-chosen source</a>` : ""}
  </div>`;
}

function sourceImageHtml(source) {
  const imageUrl = sourceImageUrl(source);
  if (isSafeImageUrl(imageUrl)) {
    return `<img class="source-image" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(source.name || "Product image")}" loading="lazy" referrerpolicy="no-referrer" />`;
  }
  return `<div class="image-fallback">No item<br>image yet</div>`;
}

function sourceImageUrl(source) {
  return source?.image_url || source?.product_image_url || source?.item_image_url || source?.image || "";
}

function customerImagePlaceholder(res) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">
  <rect width="600" height="600" fill="#16080d"/>
  <rect x="36" y="36" width="528" height="528" rx="44" fill="#0f0609" stroke="#6b1024" stroke-width="6"/>
  <text x="300" y="286" text-anchor="middle" fill="#d8b8c0" font-family="Arial, sans-serif" font-size="34" font-weight="700">Arcovia</text>
  <text x="300" y="336" text-anchor="middle" fill="#d8b8c0" font-family="Arial, sans-serif" font-size="22">Product image pending</text>
</svg>`;
  res.writeHead(200, {
    "Content-Type": "image/svg+xml; charset=utf-8",
    "Cache-Control": "public, max-age=3600",
    "X-Robots-Tag": "noindex"
  });
  res.end(svg);
}

function displayRandTotal(source) {
  const direct = source.estimated_total_zar || source.approx_total_zar || source.total_zar || "";
  if (direct) return direct;
  const total = source.estimated_total_to_customer || "";
  if (/\bZAR\b|(^|\s)R\s?\d/i.test(total)) return total;
  const price = source.price || "";
  if (/\bZAR\b|(^|\s)R\s?\d/i.test(price)) return price;
  return "Needs ZAR estimate";
}

function displayTrustScore(source) {
  if (source.trust_score === 0) return "0/100";
  return source.trust_score ? `${source.trust_score}/100` : "n/a";
}

function riskClass(riskLevel) {
  const risk = String(riskLevel || "unknown").toLowerCase();
  if (risk.includes("low")) return "risk-low";
  if (risk.includes("high") || risk.includes("unsafe")) return "risk-high";
  if (risk.includes("medium")) return "risk-medium";
  return "risk-unknown";
}

function sourceGroupLabel(group) {
  const labels = {
    suppliers: "approved suppliers",
    candidateSources: "candidate sources",
    rejectedSources: "rejected suppliers"
  };
  return labels[group] || "sources";
}

function isSafeImageUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function monitorLiteJobCard(job) {
  const maxAttempts = displayMaxResearchAttempts(job);
  const nextLine = job.nextResearchAt ? `<p class="muted">Next AI check: ${escapeHtml(formatEventTime(job.nextResearchAt))}</p>` : "";
  const completedLine = job.researchCompletedAt ? `<p class="muted">Completed: ${escapeHtml(formatEventTime(job.researchCompletedAt))}</p>` : "";
  const reviewButton = job.reviewLink
    ? `<p><a class="button" href="${escapeHtml(job.reviewLink)}">Review suppliers</a></p>`
    : "";
  const missingBriefButton = !job.productRequestPresent && job.briefLink
    ? `<p><strong>No product details yet.</strong></p><p><a class="button" href="${escapeHtml(job.briefLink)}">Add product details</a></p>`
    : "";
  const runningLine = job.researchRunning
    ? `<p><strong>AI is working right now.</strong></p>`
    : `<p class="muted">AI is not currently running for this order.</p>`;

  return `<section class="card">
    <h2>${escapeHtml(job.orderName || "Latest order")}</h2>
    <span class="status ${escapeHtml(statusClass(job.status))}">${escapeHtml(statusLabel(job.status))}</span>
    ${missingBriefButton}
    ${runningLine}
    <div class="stats">
      <div class="stat"><b>${escapeHtml(`${job.researchAttemptCount}/${maxAttempts}`)}</b><span>checks</span></div>
      <div class="stat"><b>${escapeHtml(job.supplierCount)}</b><span>trusted suppliers</span></div>
      <div class="stat"><b>${escapeHtml(job.candidateSourceCount)}</b><span>candidates</span></div>
      <div class="stat"><b>${escapeHtml(job.rejectedSourceCount)}</b><span>rejected</span></div>
      <div class="stat"><b>${escapeHtml(job.shippingAgentCount)}</b><span>shipping agents</span></div>
    </div>
    ${reviewButton}
    ${nextLine}
    ${completedLine}
  </section>`;
}

function statusClass(status) {
  return String(status || "unknown").replace(/[^a-z0-9_-]/gi, "_");
}

function displayMaxResearchAttempts(job) {
  const policy = researchPolicySummary();
  return Math.min(job.maxResearchAttempts || policy.maxTotalAttempts, policy.maxTotalAttempts);
}

function isDepositOrder(payload) {
  const lineItems = normalizeLineItems(payload);
  if (!Array.isArray(lineItems) || lineItems.length === 0) return true;
  return lineItems.some((item) => {
    const sku = String(item.sku || item.SKU || "").trim();
    const title = String(item.title || item.name || "").toLowerCase();
    const handle = String(item.product?.handle || item.product_handle || item.productHandle || "").toLowerCase();
    return config.depositSkus.includes(sku)
      || handle === "arcovia-sourcing-deposit"
      || handle === "product-sourcing-deposit"
      || (title.includes("sourcing") && title.includes("deposit"));
  });
}

function extractProductRequest(payload) {
  const lineItems = normalizeLineItems(payload);
  const candidates = [
    payload.product_request,
    payload.sourcing_brief,
    payload.note,
    payload.customer_note,
    payload.customerNote,
    ...(payload.note_attributes || []).map((item) => `${item.name}: ${item.value}`),
    ...(payload.customAttributes || []).map((item) => `${item.key || item.name}: ${item.value}`),
    ...lineItems.flatMap((item) => [
      item.product_request,
      item.productRequest,
      item.note,
      ...(item.properties || []).map((prop) => `${prop.name || prop.key}: ${prop.value}`),
      ...(item.customAttributes || []).map((prop) => `${prop.key || prop.name}: ${prop.value}`)
    ])
  ];

  return candidates
    .filter(Boolean)
    .map((value) => String(value).trim())
    .filter((value) => value && value.toLowerCase() !== "null" && value.toLowerCase() !== "undefined")
    .join("\n")
    .trim();
}

function normalizeLineItems(payload) {
  if (Array.isArray(payload.line_items)) return payload.line_items;
  if (Array.isArray(payload.lineItems)) return payload.lineItems;
  if (Array.isArray(payload.line_items?.nodes)) return payload.line_items.nodes;
  if (Array.isArray(payload.lineItems?.nodes)) return payload.lineItems.nodes;
  if (payload.line_items?.edges) return payload.line_items.edges.map((edge) => edge.node).filter(Boolean);
  if (payload.lineItems?.edges) return payload.lineItems.edges.map((edge) => edge.node).filter(Boolean);
  return [];
}

const CATEGORY_CONFIG = {
  clothing: {
    label: "Clothing & fashion",
    productPlaceholder: "Example: Nike Tech Fleece hoodie, women's blazer, winter jacket...",
    conditionOptions: ["New with tags", "New without tags", "Pre-owned excellent condition", "Any condition if clean and wearable"],
    preferenceOptions: ["Authentic branded only", "Unbranded alternative is fine", "Inspired/non-branded look is fine", "Local South African supplier preferred"],
    detailFields: [
      { name: "clothing_size_fit", label: "Clothing size and fit", placeholder: "Example: M, UK 10, EU 38, waist 32, oversized fit, men's/women's/kids...", required: true },
      { name: "clothing_colour_material", label: "Colour, fabric and style", placeholder: "Example: black cotton fleece, slim fit, zip-up, no logo, winter weight..." },
      { name: "clothing_reference", label: "Reference link or photo description", placeholder: "Paste a reference link, or describe what the item should look like." }
    ]
  },
  shoes: {
    label: "Shoes & sneakers",
    productPlaceholder: "Example: Air Jordan 4 Bred Reimagined, Adidas Samba, formal leather shoes...",
    conditionOptions: ["Brand new", "New/open box", "Pre-owned excellent condition", "Any condition if authentic and wearable"],
    preferenceOptions: ["Authentic branded only", "Original box preferred", "Used authentic pair acceptable", "Inspired/non-branded style is fine"],
    detailFields: [
      { name: "shoe_size_fit", label: "Shoe size and fit", placeholder: "Example: UK 8, US 9, EU 42, men's/women's/kids, wide fit if needed...", required: true },
      { name: "shoe_colourway", label: "Colourway or exact style", placeholder: "Example: black/red Bred, white/green Samba, patent leather, low-top/high-top..." },
      { name: "shoe_box_auth", label: "Box and authenticity requirements", placeholder: "Example: original box required, proof of purchase preferred, used authentic pair acceptable..." }
    ]
  },
  bags_accessories: {
    label: "Bags & accessories",
    productPlaceholder: "Example: laptop backpack, handbag, belt, sunglasses, wallet...",
    conditionOptions: ["Brand new", "New/open box", "Pre-owned excellent condition", "Any clean usable condition"],
    preferenceOptions: ["Authentic branded only", "Unbranded alternative is fine", "Inspired/non-branded look is fine", "Leather/material quality matters most"],
    detailFields: [
      { name: "bag_material_dimensions", label: "Material, colour and dimensions", placeholder: "Example: black leather, 15-inch laptop compartment, medium handbag, exact strap length..." },
      { name: "bag_brand_logo", label: "Brand or logo preference", placeholder: "Example: authentic branded only, no visible logo, inspired style is fine..." },
      { name: "bag_usage", label: "How it will be used", placeholder: "Example: daily work bag, travel, school, formal event, must fit laptop..." }
    ]
  },
  watches_jewelry: {
    label: "Watches & jewellery",
    productPlaceholder: "Example: Casio watch, silver chain, engagement ring style, bracelet...",
    conditionOptions: ["Brand new", "Certified pre-owned", "Pre-owned excellent condition", "Any condition with proof of authenticity"],
    preferenceOptions: ["Authentic branded only", "Certificate/proof required", "Style match more important than brand", "Hypoallergenic/material-safe only"],
    detailFields: [
      { name: "jewelry_measurements", label: "Ring, wrist, strap or chain size", placeholder: "Example: ring size N, 18cm wrist, 20mm strap, 55cm chain...", required: true },
      { name: "jewelry_material", label: "Material and design", placeholder: "Example: sterling silver, gold-plated, stainless steel, black strap, diamond-style stone..." },
      { name: "jewelry_certificate", label: "Proof, certificate or warranty needs", placeholder: "Example: certificate required, serial number, water resistance, warranty..." }
    ]
  },
  phones_computers: {
    label: "Phones, computers & tablets",
    productPlaceholder: "Example: iPhone 14 Pro 256GB, gaming laptop, iPad, MacBook charger...",
    conditionOptions: ["New sealed", "New/open box", "Certified refurbished", "Used excellent condition", "Used acceptable if fully tested"],
    preferenceOptions: ["Original/genuine only", "Warranty required", "Unlocked/network-free required", "Charger/accessories included preferred"],
    detailFields: [
      { name: "device_model_specs", label: "Exact model and main specs", placeholder: "Example: iPhone 14 Pro 256GB, 16GB RAM laptop, M2 MacBook Air, iPad 10th gen...", required: true },
      { name: "device_compatibility", label: "Compatibility requirements", placeholder: "Example: unlocked, Vodacom/MTN compatible, Windows 11, USB-C, local plug, region model..." },
      { name: "device_battery_warranty", label: "Battery, accessories and warranty", placeholder: "Example: battery health above 85%, charger included, warranty required, no cracked screen..." }
    ]
  },
  electronics: {
    label: "Electronics & gadgets",
    productPlaceholder: "Example: headphones, camera, drone, console, smart watch, speaker...",
    conditionOptions: ["New sealed", "New/open box", "Refurbished with warranty", "Used fully tested", "Any working condition"],
    preferenceOptions: ["Original brand only", "Warranty required", "Compatible replacement acceptable", "Best value over brand"],
    detailFields: [
      { name: "electronics_model", label: "Model number and exact version", placeholder: "Example: Sony WH-1000XM5, DJI Mini 4 Pro, PS5 disc edition, GoPro Hero 12...", required: true },
      { name: "electronics_compatibility", label: "Compatibility, voltage or plug needs", placeholder: "Example: South African plug, 220V, works with iPhone, compatible replacement acceptable..." },
      { name: "electronics_accessories", label: "Accessories and warranty", placeholder: "Example: charger, case, memory card, controller, warranty, original packaging..." }
    ]
  },
  appliances: {
    label: "Home appliances",
    productPlaceholder: "Example: fridge, air fryer, washing machine, microwave, vacuum cleaner...",
    conditionOptions: ["Brand new", "Open box/display unit", "Refurbished with warranty", "Used fully working", "Any condition if repairable"],
    preferenceOptions: ["Warranty required", "Energy-efficient preferred", "Delivery/installation preferred", "Brand not important if reliable"],
    detailFields: [
      { name: "appliance_capacity_size", label: "Capacity and physical size", placeholder: "Example: 300L fridge, 8kg washing machine, must fit 60cm space, countertop size...", required: true },
      { name: "appliance_power_install", label: "Power, installation and delivery needs", placeholder: "Example: 220V, installation needed, delivery to Johannesburg, upstairs delivery..." },
      { name: "appliance_brand_warranty", label: "Brand, energy rating and warranty", placeholder: "Example: Samsung/LG preferred, energy efficient, minimum 12-month warranty..." }
    ]
  },
  furniture: {
    label: "Furniture & decor",
    productPlaceholder: "Example: office chair, couch, dining table, bed frame, wall art...",
    conditionOptions: ["Brand new", "Display unit", "Pre-owned excellent condition", "Any condition if structurally sound"],
    preferenceOptions: ["Exact style match", "Custom-made acceptable", "Local pickup acceptable", "Delivery required"],
    detailFields: [
      { name: "furniture_dimensions", label: "Dimensions and room fit", placeholder: "Example: 2.2m couch, queen bed frame, desk must fit 120cm wall, small apartment...", required: true },
      { name: "furniture_material_style", label: "Material, colour and style", placeholder: "Example: black leather, oak wood, modern, velvet, industrial, matching reference photo..." },
      { name: "furniture_delivery", label: "Delivery and assembly needs", placeholder: "Example: delivery required, flat-pack okay, assembly needed, local pickup acceptable..." }
    ]
  },
  vehicle_parts: {
    label: "Vehicle parts & accessories",
    productPlaceholder: "Example: Toyota Hilux headlight, BMW bumper, tyres, car radio...",
    conditionOptions: ["Brand new", "OEM used", "Aftermarket new", "Reconditioned", "Used tested"],
    preferenceOptions: ["OEM/genuine only", "Aftermarket compatible acceptable", "VIN/part-number match required", "Fitment proof required"],
    detailFields: [
      { name: "vehicle_details", label: "Vehicle make, model and year", placeholder: "Example: 2018 Toyota Hilux 2.8 GD-6, BMW F30 320i, VW Polo Vivo 2016...", required: true },
      { name: "vehicle_part_number", label: "Part number, VIN or fitment details", placeholder: "Share part number or VIN only if you are comfortable. Include engine variant if relevant." },
      { name: "vehicle_position", label: "Side, position and fitment proof", placeholder: "Example: front-left headlight, rear bumper, 16-inch tyres, must include fitment confirmation..." }
    ]
  },
  machinery: {
    label: "Machinery & industrial equipment",
    productPlaceholder: "Example: CNC machine, compressor, generator, packaging machine, pump...",
    conditionOptions: ["Brand new", "Certified used", "Refurbished with service records", "Used working condition", "For parts/repair only"],
    preferenceOptions: ["OEM/authorised supplier only", "Service records required", "Warranty or return policy required", "Aftermarket compatible parts acceptable", "No replica/counterfeit equipment"],
    detailFields: [
      { name: "machine_specs", label: "Machine type and technical specifications", placeholder: "Example: 5kVA generator, 100L compressor, CNC bed size, pump flow rate, packaging speed...", required: true },
      { name: "machine_power_capacity", label: "Power, capacity and certification needs", placeholder: "Example: 220V single phase, 380V three phase, SABS/CE, duty cycle, load capacity..." },
      { name: "machine_service_warranty", label: "Service history, manuals and warranty", placeholder: "Example: service records required, manual required, spare parts available, warranty/return policy..." },
      { name: "machine_delivery_install", label: "Delivery, rigging or installation", placeholder: "Example: forklift needed, installation required, delivery province, training required..." }
    ]
  },
  tools: {
    label: "Tools & workshop equipment",
    productPlaceholder: "Example: Makita drill, welding machine, toolbox, compressor, torque wrench...",
    conditionOptions: ["Brand new", "Open box", "Refurbished", "Used tested", "Any working condition"],
    preferenceOptions: ["Original brand only", "Aftermarket compatible acceptable", "Warranty preferred", "Heavy-duty/professional grade only"],
    detailFields: [
      { name: "tool_specs", label: "Tool specs and power rating", placeholder: "Example: 18V drill, 200A welder, 50L compressor, 1/2 inch torque wrench...", required: true },
      { name: "tool_platform_accessories", label: "Battery platform and accessories", placeholder: "Example: Makita LXT battery, charger included, drill bits, case, gas/no gas welding..." },
      { name: "tool_use_case", label: "Use case and duty level", placeholder: "Example: home DIY, professional workshop, heavy-duty daily use, safety requirements..." }
    ]
  },
  beauty: {
    label: "Beauty, health & cosmetics",
    productPlaceholder: "Example: skincare product, hair tool, perfume, supplements...",
    conditionOptions: ["New sealed only", "New with intact packaging", "Unused open box if safe", "Not applicable"],
    preferenceOptions: ["Authorised retailer only", "Expiry date required", "Batch/serial proof preferred", "Cruelty-free/vegan preferred"],
    detailFields: [
      { name: "beauty_variant", label: "Shade, scent, formula or variant", placeholder: "Example: shade 330, eau de parfum 100ml, retinol serum, keratin hair tool...", required: true },
      { name: "beauty_safety", label: "Expiry, batch and safety needs", placeholder: "Example: sealed only, expiry date required, batch number preferred, authorised retailer only..." },
      { name: "beauty_allergies", label: "Allergies, skin or hair type", placeholder: "Example: sensitive skin, oily skin, sulphate-free, fragrance-free, cruelty-free..." }
    ]
  },
  sports_outdoor: {
    label: "Sports, gym & outdoor",
    productPlaceholder: "Example: treadmill, dumbbells, bicycle, tent, fishing gear...",
    conditionOptions: ["Brand new", "Open box", "Used excellent condition", "Used working condition", "Any safe usable condition"],
    preferenceOptions: ["Warranty preferred", "Commercial-grade preferred", "Local pickup acceptable", "Safety certification required"],
    detailFields: [
      { name: "sports_activity", label: "Sport/activity and usage", placeholder: "Example: home gym, commercial gym, mountain biking, camping, fishing, beginner/pro use...", required: true },
      { name: "sports_measurements", label: "Sport-specific measurements", placeholder: "Example: bicycle frame 54cm, helmet L, treadmill weight limit, tent 4-person..." },
      { name: "sports_safety_delivery", label: "Safety, accessories and delivery", placeholder: "Example: safety certification, included weights, delivery needed, assembly required..." }
    ]
  },
  collectibles: {
    label: "Collectibles, art & rare items",
    productPlaceholder: "Example: limited figure, trading card, signed item, vintage decor...",
    conditionOptions: ["Mint/sealed", "Excellent condition", "Good condition", "Any condition if rare", "Graded/certified only"],
    preferenceOptions: ["Authenticity proof required", "Certificate of authenticity required", "Original packaging preferred", "Local seller preferred"],
    detailFields: [
      { name: "collectible_identity", label: "Edition, year, serial or grading", placeholder: "Example: 1999 card, PSA 9, limited edition number, signed item, original artwork...", required: true },
      { name: "collectible_auth", label: "Authenticity proof needed", placeholder: "Example: certificate of authenticity, grading certificate, provenance, seller proof..." },
      { name: "collectible_packaging", label: "Packaging and condition expectations", placeholder: "Example: sealed box, mint card, frame included, minor wear acceptable..." }
    ]
  },
  books_media: {
    label: "Books, media & documents",
    productPlaceholder: "Example: textbook, rare book, vinyl record, game disc, manual...",
    conditionOptions: ["New", "Like new", "Used good condition", "Any readable/working condition", "Digital copy acceptable"],
    preferenceOptions: ["Original physical copy", "Specific edition required", "ISBN/catalogue number required", "Local seller preferred"],
    detailFields: [
      { name: "media_identity", label: "ISBN, edition, author or catalogue number", placeholder: "Example: ISBN, 4th edition, author, vinyl catalogue number, game title...", required: true },
      { name: "media_format_language", label: "Format, language and region", placeholder: "Example: hardcover, paperback, English, PAL region, PS5 disc, vinyl LP..." },
      { name: "media_condition", label: "Acceptable condition", placeholder: "Example: no missing pages, readable used copy okay, disc must be working, cover condition..." }
    ]
  },
  other: {
    label: "Other / not sure",
    productPlaceholder: "Describe the item as clearly as possible...",
    conditionOptions: ["Brand new", "Used excellent condition", "Refurbished", "Any working/usable condition", "Not sure"],
    preferenceOptions: ["Authentic/original only", "Best value option", "Local supplier preferred", "Fastest available option", "Need help deciding"],
    detailFields: [
      { name: "other_details", label: "Important details", placeholder: "Describe the item, model, material, colour, use case, or exact match needed.", required: true },
      { name: "other_compatibility", label: "Compatibility or measurements", placeholder: "If it must fit or work with something, explain that here." },
      { name: "other_avoid", label: "What to avoid", placeholder: "Example: avoid replicas, avoid used, avoid overseas suppliers, avoid a certain colour..." }
    ]
  }
};

function categoryOptionsHtml() {
  return Object.entries(CATEGORY_CONFIG)
    .map(([value, category]) => `<option value="${escapeHtml(value)}">${escapeHtml(category.label)}</option>`)
    .join("");
}

async function handleBriefForm(_req, res, token) {
  const job = getJob(token);
  if (!job) return html(res, 404, "<h1>Brief link not found</h1>");

  html(res, 200, `<!doctype html>
<html>
<head>
  <title>Arcovia sourcing brief</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: Arial, sans-serif; background:#080406; color:#fff; margin:0; padding:24px; }
    main { max-width:720px; margin:0 auto; background:#16080d; border:1px solid #6b1024; padding:24px; border-radius:16px; }
    label { display:block; margin:16px 0 6px; font-weight:700; }
    input, textarea, select { width:100%; box-sizing:border-box; border-radius:10px; border:1px solid #6b1024; padding:12px; font-size:16px; background:#fff; color:#16080d; }
    textarea { min-height:130px; }
    button { margin-top:20px; background:#7a1028; color:white; border:0; border-radius:999px; padding:14px 22px; font-weight:700; cursor:pointer; }
    button:disabled { opacity:.45; cursor:not-allowed; }
    h2 { font-size:20px; margin:0 0 10px; }
    .muted { color:#d8b8c0; }
    .panel { margin-top:18px; padding:16px; border:1px solid #6b1024; border-radius:14px; background:#220c13; }
    .details-grid { display:grid; gap:14px; margin-top:14px; }
    .details-grid label { margin-top:0; }
    .details-grid textarea { min-height:95px; }
    .hint { color:#d8b8c0; margin:8px 0 0; font-size:14px; line-height:1.4; }
    .hidden { display:none; }
  </style>
</head>
<body>
  <main>
    <h1>Arcovia product sourcing brief</h1>
    <p class="muted">Order ${escapeHtml(job.orderName)}. Select a category first so we only ask questions that match the item.</p>
    <form method="post">
      <section class="panel">
        <h2>Your details</h2>
        <label for="customer_name">Full name</label>
        <input id="customer_name" name="customer_name" required value="${escapeHtml(job.customerName || "")}" placeholder="Your full name" />

        <label for="customer_email">Email address</label>
        <input id="customer_email" name="customer_email" type="email" value="${escapeHtml(job.customerEmail || "")}" placeholder="you@example.com" />

        <label for="customer_phone">Phone number</label>
        <input id="customer_phone" name="customer_phone" value="${escapeHtml(job.customerPhone || "")}" placeholder="Example: 071 234 5678" />
        <p class="hint">Use the best contact details for updates about this sourcing request.</p>
      </section>

      <label for="category">Product category</label>
      <select id="category" name="category" required>
        <option value="">Choose the closest category...</option>
        ${categoryOptionsHtml()}
      </select>
      <input type="hidden" id="category_label" name="category_label" />
      <p id="categoryHint" class="hint">After you choose a category, the item name and the right follow-up questions will appear.</p>

      <section id="categoryFields" class="panel hidden" aria-live="polite">
        <label for="product">Item name</label>
        <input id="product" name="product" required disabled placeholder="Brand, model, item type, or exact product name..." value="${escapeHtml(singleLine(job.productRequest || ""))}" />

        <label for="condition">Preferred condition</label>
        <select id="condition" name="condition" required disabled></select>

        <label for="preference">Preference</label>
        <select id="preference" name="preference" required disabled></select>

        <div id="customFields" class="details-grid"></div>

        <label for="budget">Maximum budget</label>
        <input id="budget" name="budget" disabled placeholder="Example: R2,500 total" />

        <label for="notes">Anything else we must know</label>
        <textarea id="notes" name="notes" disabled placeholder="What to avoid, preferred suppliers, delivery area..."></textarea>

        <button id="submitButton" type="submit" disabled>Submit sourcing brief</button>
      </section>
    </form>
  </main>
  <script>
    const categories = ${scriptJson(CATEGORY_CONFIG)};
    const category = document.getElementById("category");
    const categoryLabel = document.getElementById("category_label");
    const categoryFields = document.getElementById("categoryFields");
    const categoryHint = document.getElementById("categoryHint");
    const product = document.getElementById("product");
    const condition = document.getElementById("condition");
    const preference = document.getElementById("preference");
    const customFields = document.getElementById("customFields");
    const budget = document.getElementById("budget");
    const notes = document.getElementById("notes");
    const submitButton = document.getElementById("submitButton");

    function fillSelect(select, options, placeholder) {
      select.innerHTML = "";
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = placeholder;
      select.appendChild(empty);
      for (const optionText of options) {
        const option = document.createElement("option");
        option.value = optionText;
        option.textContent = optionText;
        select.appendChild(option);
      }
    }

    function renderDetailFields(fields) {
      customFields.innerHTML = "";
      for (const field of fields || []) {
        const wrapper = document.createElement("div");
        const label = document.createElement("label");
        const id = "detail__" + field.name;
        label.htmlFor = id;
        label.textContent = field.label;

        const control = document.createElement("textarea");
        control.id = id;
        control.name = id;
        control.placeholder = field.placeholder || "";
        control.required = Boolean(field.required);

        wrapper.appendChild(label);
        wrapper.appendChild(control);
        customFields.appendChild(wrapper);
      }
    }

    function setCategoryFields() {
      const selected = categories[category.value];
      const enabled = Boolean(selected);
      categoryFields.classList.toggle("hidden", !enabled);
      product.disabled = !enabled;
      condition.disabled = !enabled;
      preference.disabled = !enabled;
      budget.disabled = !enabled;
      notes.disabled = !enabled;
      submitButton.disabled = !enabled;

      if (!enabled) {
        categoryLabel.value = "";
        categoryHint.textContent = "After you choose a category, the item name and the right follow-up questions will appear.";
        renderDetailFields([]);
        return;
      }

      categoryLabel.value = selected.label;
      categoryHint.textContent = "Good. The questions below now match " + selected.label + ".";
      product.placeholder = selected.productPlaceholder;
      fillSelect(condition, selected.conditionOptions, "Choose a matching condition...");
      fillSelect(preference, selected.preferenceOptions, "Choose the most important preference...");
      renderDetailFields(selected.detailFields);
    }

    category.addEventListener("change", setCategoryFields);
    setCategoryFields();
  </script>
</body>
</html>`);
}

async function handleBriefSubmit(req, res, token) {
  const job = getJob(token);
  if (!job) return html(res, 404, "<h1>Brief link not found</h1>");

  const body = await readBody(req);
  const form = new URLSearchParams(body);
  const submittedName = String(form.get("customer_name") || "").trim();
  const submittedEmail = String(form.get("customer_email") || "").trim();
  const submittedPhone = String(form.get("customer_phone") || "").trim();
  const categoryKey = String(form.get("category") || "").trim();
  const selectedCategory = CATEGORY_CONFIG[categoryKey];
  const detailLines = (selectedCategory?.detailFields || [])
    .map((field) => fieldLine(field.label, form.get(`detail__${field.name}`)))
    .filter(Boolean);

  if (submittedName) job.customerName = submittedName;
  if (submittedEmail) job.customerEmail = submittedEmail;
  if (submittedPhone) job.customerPhone = submittedPhone;

  job.productRequest = [
    fieldLine("Customer name", job.customerName),
    fieldLine("Customer email", job.customerEmail),
    fieldLine("Customer phone number", job.customerPhone),
    fieldLine("Category", form.get("category_label") || selectedCategory?.label || categoryKey),
    fieldLine("Item name", form.get("product")),
    fieldLine("Condition", form.get("condition")),
    fieldLine("Preference", form.get("preference")),
    ...detailLines,
    fieldLine("Maximum budget", form.get("budget")),
    fieldLine("Notes", form.get("notes"))
  ].filter(Boolean).join("\n");
  job.status = "researching";
  job.researchAttemptCount = 0;
  job.maxResearchAttempts = researchPolicySummary().maxTotalAttempts;
  job.currentResearchAttempt = null;
  job.nextResearchAt = null;
  addTimeline(job, "brief_received", "Customer submitted product sourcing brief.");
  if (config.localCodexWorkerEnabled) {
    addTimeline(job, "local_worker_waiting", "Local Codex worker mode is enabled. Waiting for the always-on PC worker to claim this research job.");
  }
  upsertJob(job);

  if (!config.localCodexWorkerEnabled) queueResearch(job.id);
  html(res, 200, "<h1>Brief received</h1><p>Arcovia has started the supplier search. You will receive updates by email.</p>");
}

async function handleStatusPage(_req, res, token) {
  const job = getJob(token);
  if (!job) return html(res, 404, "<h1>Status link not found</h1>");
  const timeline = (job.timeline || []).slice().reverse().map((event) => {
    return `<li><strong>${escapeHtml(formatEventTime(event.at))}</strong><br>${escapeHtml(event.message)}</li>`;
  }).join("");
  const researchSummary = job.research?.summary
    ? `<section><h2>Internal research summary</h2><p>${escapeHtml(job.research.summary)}</p><p class="muted">Arcovia reviews supplier evidence before any supplier details or quote is sent to you.</p></section>`
    : "";
  const progress = researchProgressHtml(job);

  html(res, 200, `<!doctype html>
<html>
<head>
  <title>Arcovia sourcing status</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: Arial, sans-serif; background:#080406; color:#fff; margin:0; padding:24px; }
    main { max-width:760px; margin:0 auto; background:#16080d; border:1px solid #6b1024; padding:24px; border-radius:16px; }
    h1 { margin-top:0; }
    .badge { display:inline-block; margin:8px 0 18px; padding:8px 12px; border-radius:999px; background:#7a1028; font-weight:700; text-transform:uppercase; letter-spacing:.04em; }
    .muted { color:#d8b8c0; line-height:1.5; }
    ul { padding-left:22px; }
    li { margin:0 0 16px; line-height:1.45; }
    a { color:#ffc4d0; }
  </style>
</head>
<body>
  <main>
    <h1>Arcovia sourcing status</h1>
    <div class="badge">${escapeHtml(statusLabel(job.status))}</div>
    <p class="muted">Order: ${escapeHtml(job.orderName)}<br>Created: ${escapeHtml(formatEventTime(job.createdAt))}<br>Sourcing window ends: ${escapeHtml(formatEventTime(job.sourcingWindowEndsAt))}</p>
    ${progress}
    ${job.status === "awaiting_brief" ? `<p><a href="${escapeHtml(briefLinkForStatus(job))}">Complete your product brief</a> so the AI can start searching.</p>` : ""}
    ${researchSummary}
    <h2>Timeline</h2>
    <ul>${timeline || "<li>No timeline entries yet.</li>"}</ul>
  </main>
</body>
</html>`);
}

async function sendDueUpdates() {
  const now = new Date();
  const jobs = readJobs();
  for (const job of jobs) {
    if (!job.nextUpdateAt) continue;
    if (new Date(job.nextUpdateAt) > now) continue;
    if (["supplier_selected", "quote_ready", "cancelled", "refunded", "refund_due"].includes(job.status)) continue;

    const sourcingWindowEndsAt = job.sourcingWindowEndsAt;
    if (sourcingWindowEndsAt && new Date(sourcingWindowEndsAt) <= now && !["human_review", "quote_ready"].includes(job.status)) {
      job.status = "refund_due";
      job.refundStatus = "manual_refund_required";
      job.refundReason = "The sourcing window ended without a verified trustworthy match.";
      job.nextUpdateAt = null;
      addTimeline(job, "refund_due", job.refundReason);
      upsertJob(job);
      await sendEmail({ to: config.adminEmail, ...adminRefundDue(job) });
      await sendEmail({ to: job.customerEmail, ...customerRefundDue(job) });
      continue;
    }

    await sendEmail({ to: job.customerEmail, ...stageUpdate(job) });
    job.nextUpdateAt = addHours(now, config.updateIntervalHours).toISOString();
    addTimeline(job, "customer_update_sent", `Customer update sent for status ${job.status}.`);
    upsertJob(job);
  }
}

function verifyShopifyWebhook(rawBody, hmacHeader) {
  if (!config.shopifyWebhookSecret) return false;
  if (!hmacHeader) return false;
  const digest = createHmac("sha256", config.shopifyWebhookSecret).update(rawBody, "utf8").digest("base64");
  const received = Buffer.from(String(hmacHeader), "utf8");
  const expected = Buffer.from(digest, "utf8");
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
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

function html(res, status, content) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(content);
}

function redirect(res, location) {
  res.writeHead(303, { Location: location });
  res.end();
}

function addHours(date, hours) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function singleLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function fieldLine(label, value) {
  const text = String(value || "").trim();
  return text ? `${label}: ${text}` : "";
}

function scriptJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function briefLinkForStatus(job) {
  return `${config.publicBaseUrl.replace(/\/$/, "")}/brief/${job.publicToken}`;
}

function researchProgressHtml(job) {
  const attempt = job.researchAttemptCount || 0;
  const policy = researchPolicySummary();
  const maxAttempts = Math.min(job.maxResearchAttempts || policy.maxTotalAttempts, policy.maxTotalAttempts);
  const current = job.currentResearchAttempt ? `<br>Current check: ${escapeHtml(job.currentResearchAttempt)} of ${escapeHtml(maxAttempts)}` : "";
  const next = job.nextResearchAt ? `<br>Next deep check: ${escapeHtml(formatEventTime(job.nextResearchAt))}` : "";
  const suppliers = job.research?.suppliers?.length || 0;
  const candidates = job.research?.candidateSources?.length || 0;
  const rejected = job.research?.rejectedSources?.length || 0;

  return `<section>
    <h2>Research progress</h2>
    <p class="muted">Deep checks completed: ${escapeHtml(attempt)} of ${escapeHtml(maxAttempts)}${current}${next}<br>Policy: one super-deep search first, up to ${escapeHtml(policy.noMatchRetries)} retry search(es) only if no trusted source is found, and ${escapeHtml(policy.confirmationChecksAfterFound)} extra expansion check after the first trusted match.<br>Trusted suppliers waiting for review: ${escapeHtml(suppliers)}<br>Candidate sources checked: ${escapeHtml(candidates)}<br>Unsafe or untrusted sources removed: ${escapeHtml(rejected)}</p>
  </section>`;
}

function formatEventTime(value) {
  if (!value) return "n/a";
  return new Date(value).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" });
}

function statusLabel(status) {
  const labels = {
    awaiting_brief: "Waiting for product details",
    researching: "Searching for product",
    vetting: "Checking suppliers",
    human_review: "Supplier options ready",
    supplier_selected: "Supplier selected",
    quote_ready: "Quote ready",
    no_match: "No match found yet",
    refund_due: "Refund due",
    research_failed: "Research needs attention"
  };
  return labels[status] || String(status || "In progress").replaceAll("_", " ");
}
