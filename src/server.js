import http from "node:http";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { reconcileAllResearchCompletionNotifications, reconcileResearchCompletionNotifications } from "./completion-notifications.js";
import { emailDiagnostics, sendCustomerEmail, sendEmail, sendSensitiveAdminEmailForJob } from "./email.js";
import { amountsMatch, buildPayfastCheckoutFields, formatPayfastAmount, parsePayfastBody, payfastConfigured, payfastProcessUrl, verifyPayfastSignature } from "./payfast.js";
import { isResearchRunning, queueDueResearchAttempts, queueResearch, researchPolicySummary } from "./research.js";
import { handleLocalWorkerClaim, handleLocalWorkerHeartbeat, handleLocalWorkerReport, localWorkerHealthFeatures } from "./local-worker.js";
import { FINAL_BALANCE_SKU, extractShopifyFinalPaymentDetails, fetchShopifyOrderDetails, isShopifyFinalBalanceOrder, prepareShopifyFinalCheckout, shopifyAuthenticationMode, shopifyDraftCheckoutConfigured } from "./shopify.js";
import { adminCustomerOptionsCancelled, adminFinalPaymentReceived, adminRefundDue, customerChoiceReceived, customerFinalPaymentReceived, customerNoOnlinePurchaseAvailable, customerOptionSelectedAdmin, customerOptionsCancellationConfirmed, customerOptionsReady, customerOrderStatusUpdate, customerQuoteReady, customerRefundDue, customerSupplierOrderPlaced, depositReceived, stageUpdate } from "./templates.js";
import { addTimeline, getJob, readJobs, recordEmailAudit, storageHealth, upsertJob } from "./storage.js";
import { canCancelCustomerOptions, ensureCustomerOptionsAccess, recordCustomerOptionsDecision } from "./customer-options.js";

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      const researchPolicy = researchPolicySummary();
      const email = emailDiagnostics();
      return json(res, 200, {
        ok: true,
        service: "arcovia-sourcing",
        jobs: readJobs().length,
        features: {
          shopifyOrderEnrichment: true,
          safeOrderResearchRetry: true,
          cappedHostedResearchTokens: true,
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
          multiImageSupplierGalleries: true,
          customerSupplierChoiceCapture: true,
          resendDefaultSenderFallback: false,
          resendStrictVerifiedSender: true,
          emailProvider: email.provider,
          emailReady: email.ready,
          emailActiveProviderPlan: email.activeProviderPlan,
          emailIssues: email.issues,
          emailActiveFromEmail: email.activeFromEmail,
          emailSenderDomain: email.senderDomain,
          emailResendConfigured: email.resendConfigured,
          emailSesApiConfigured: email.sesApiConfigured,
          emailSmtpConfigured: email.smtpConfigured,
          emailSmtpHost: email.smtpHost,
          emailSmtpPort: email.smtpPort,
          emailSmtpSecure: email.smtpSecure,
          emailSmtpFromEmail: email.smtpFromEmail,
          emailAwsSesRegion: email.awsSesRegion,
          emailAwsSesDomain: email.awsSesDomain,
          emailAdminRelayOnFailure: email.adminRelayOnFailure,
          emailOutboxCountsAsSent: email.outboxCountsAsSent,
          completionEmailReconciliation: true,
          independentCompletionEmailRetries: true,
          privateAdminReviewEmail: true,
          resendTestFromEmailEnabled: Boolean(config.resendApiKey && config.resendTestFromEmail),
          resendReplyToAddress: email.replyToConfigured,
          finalPaymentWorkflow: true,
          finalPaymentStorageReady: isFinalPaymentStorageReady(),
          shopifyDraftCheckoutConfigured: shopifyDraftCheckoutConfigured(),
          shopifyAuthenticationMode: shopifyAuthenticationMode(),
          shopifyFinalCheckoutEnabled: config.shopifyFinalCheckoutEnabled,
          payfastConfigured: payfastConfigured(),
          payfastSandbox: config.payfastSandbox,
          payfastProcessUrl: payfastConfigured() ? payfastProcessUrl() : null,
          quotePages: true,
          payfastItnEndpoint: true,
          expandedCategoryIntake: true,
          deliveryAddressCapture: true,
          addressAutocompleteProxy: true,
          missingBriefFixLinks: true,
          refundDueStatus: true,
          adminJobsEndpoint: Boolean(config.adminStatusSecret || config.flowSecret),
          storage: storageHealth()
        }
      });
    }

    if (req.method === "GET" && url.pathname === "/admin/jobs") {
      return handleAdminJobs(req, res, url);
    }

    if (req.method === "POST" && url.pathname === "/admin/email-test") {
      return handleAdminEmailTest(req, res, url);
    }

    if (req.method === "GET" && url.pathname === "/address-search") {
      return handleAddressSearch(res, url);
    }

    if (req.method === "POST" && url.pathname === "/local-worker/claim") {
      return handleLocalWorkerClaim(req, res);
    }

    if (req.method === "POST" && url.pathname === "/local-worker/heartbeat") {
      return handleLocalWorkerHeartbeat(req, res);
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

    if (req.method === "POST" && url.pathname === "/monitor/quote-action") {
      return handleQuoteAction(req, res, "monitor");
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

    if (req.method === "POST" && url.pathname === "/review/quote-action") {
      return handleQuoteAction(req, res, "review");
    }

    if (req.method === "GET" && url.pathname?.startsWith("/quote/")) {
      return handleQuotePage(req, res, decodeURIComponent(url.pathname.split("/").pop() || ""), url);
    }

    if (req.method === "POST" && url.pathname === "/payfast/notify") {
      return handlePayfastNotify(req, res);
    }

    if (req.method === "GET" && url.pathname === "/payfast/return") {
      return handlePayfastReturn(req, res, url);
    }

    if (req.method === "GET" && url.pathname === "/payfast/cancel") {
      return handlePayfastCancel(req, res, url);
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

    if (req.method === "POST" && url.pathname === "/options/cancel") {
      return handleCustomerOptionsCancel(req, res);
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
  console.log(`Arcovia sourcing server listening on http://localhost:${config.port}`);
  reconcileAllResearchCompletionNotifications().catch((error) => console.error("completion email startup reconciliation failed", error));
});

setInterval(() => {
  sendDueUpdates().catch((error) => console.error("update scheduler failed", error));
  if (!config.localCodexWorkerEnabled) queueDueResearchAttempts();
}, 60_000);

async function handleFlowOrderPaid(req, res) {
  if (config.flowSecret || config.finalBalanceFlowSecret) {
    const providedDepositSecret = req.headers["x-arcovia-flow-secret"];
    const providedFinalSecret = req.headers["x-arcovia-final-flow-secret"];
    const authorized = Boolean(
      (config.flowSecret && providedDepositSecret === config.flowSecret)
      || (config.finalBalanceFlowSecret && providedFinalSecret === config.finalBalanceFlowSecret)
    );
    if (!authorized) return json(res, 401, { error: "invalid_flow_secret" });
  }

  const rawBody = await readBody(req);
  const payload = JSON.parse(rawBody || "{}");

  if (req.headers["x-arcovia-dry-run"] === "1") {
    return json(res, 200, {
      ok: true,
      dry_run: true,
      deposit_order: isDepositOrder(payload),
      final_balance_order: isShopifyFinalBalanceOrder(payload),
      product_request_present: Boolean(extractProductRequest(payload)),
      order_name: payload.order_name || payload.name || null
    });
  }

  const result = await processShopifyPaidOrder(payload, "shopify_flow", {
    skipDepositEmail: req.headers["x-arcovia-skip-deposit-email"] === "1",
    forceResearch: req.headers["x-arcovia-force-research"] === "1"
  });
  json(res, 202, result);
}

async function handleAddressSearch(res, url) {
  const query = String(url.searchParams.get("q") || "").trim().slice(0, 180);
  if (query.length < 3) return addressSearchJson(res, 400, { error: "query_too_short", features: [] });

  const target = new URL("https://photon.komoot.io/api/");
  target.searchParams.set("q", query);
  target.searchParams.set("limit", "7");
  target.searchParams.set("lang", "en");

  try {
    const response = await fetch(target, {
      signal: AbortSignal.timeout(7000),
      headers: { "User-Agent": "Arcovia address search/1.0 (https://arcovia.africa)" }
    });
    if (!response.ok) return addressSearchJson(res, 502, { error: "address_provider_unavailable", features: [] });
    const data = await response.json();
    const features = (Array.isArray(data.features) ? data.features : []).slice(0, 7).map((feature) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: Array.isArray(feature?.geometry?.coordinates) ? feature.geometry.coordinates.slice(0, 2) : []
      },
      properties: {
        name: feature?.properties?.name || "",
        housenumber: feature?.properties?.housenumber || "",
        street: feature?.properties?.street || "",
        district: feature?.properties?.district || feature?.properties?.county || "",
        city: feature?.properties?.city || "",
        town: feature?.properties?.town || "",
        village: feature?.properties?.village || "",
        state: feature?.properties?.state || "",
        postcode: feature?.properties?.postcode || "",
        country: feature?.properties?.country || ""
      }
    }));
    return addressSearchJson(res, 200, { features });
  } catch {
    return addressSearchJson(res, 502, { error: "address_provider_unavailable", features: [] });
  }
}

function addressSearchJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=300"
  });
  res.end(JSON.stringify(data));
}

async function handleShopifyWebhook(req, res) {
  const rawBody = await readBody(req);
  if (!verifyShopifyWebhook(rawBody, req.headers["x-shopify-hmac-sha256"])) {
    return json(res, 401, { error: "invalid_shopify_hmac" });
  }

  const payload = JSON.parse(rawBody || "{}");
  const result = await processShopifyPaidOrder(payload, "shopify_webhook");
  json(res, 202, result);
}

async function processShopifyPaidOrder(payload, source, options = {}) {
  const enrichedPayload = await enrichOrderPayload(payload, { forceShopifyLookup: true });
  if (isShopifyFinalBalanceOrder(enrichedPayload)) {
    return handleShopifyFinalBalancePaid(enrichedPayload, source);
  }

  const job = await createJobFromOrderPayload(enrichedPayload, source, options);
  return { ok: true, kind: "sourcing_deposit", job_id: job.id, status: job.status };
}

async function handleShopifyFinalBalancePaid(payload, source) {
  const details = extractShopifyFinalPaymentDetails(payload);
  const job = getJob(details.jobId)
    || readJobs().find((candidate) => candidate.finalQuote?.id === details.quoteId);

  if (!job?.finalQuote) {
    console.error("Unmatched Shopify final-balance payment event", {
      source,
      orderName: details.orderName,
      reason: "job_or_quote_not_found"
    });
    return { ok: false, kind: "final_balance", status: "unverified", reason: "job_or_quote_not_found" };
  }

  const quote = job.finalQuote;
  const reject = (reason, message) => {
    quote.lastPaymentError = message;
    addTimeline(job, `shopify_final_payment_${reason}`, message, {
      orderName: details.orderName || "",
      orderId: details.orderId || ""
    });
    upsertJob(job);
    return { ok: false, kind: "final_balance", job_id: job.id, status: "unverified", reason };
  };

  if (!details.jobId || details.jobId !== job.id || !details.quoteId || details.quoteId !== quote.id) {
    return reject("identifier_mismatch", "Shopify final payment was not accepted because the Arcovia job or quote identifier did not match.");
  }
  if (details.sku !== FINAL_BALANCE_SKU || details.paymentKind !== "final_balance") {
    return reject("marker_mismatch", "Shopify final payment was not accepted because its final-balance SKU or payment marker was missing.");
  }
  if (details.financialStatus !== "PAID") {
    return reject("not_paid", `Shopify final payment is not marked paid (${details.financialStatus || "missing status"}).`);
  }
  if (details.currency !== "ZAR") {
    return reject("currency_mismatch", `Shopify final payment currency mismatch: expected ZAR, received ${details.currency || "missing currency"}.`);
  }
  if (!amountsMatch(quote.finalAmountZar, details.amount)) {
    return reject("amount_mismatch", `Shopify final payment amount mismatch: expected ${displayCurrency(quote.finalAmountZar)}, received ${displayCurrency(details.amount)}.`);
  }

  if (quote.shopifyPaidOrderId) {
    if (quote.shopifyPaidOrderId === details.orderId) {
      return { ok: true, kind: "final_balance", job_id: job.id, status: job.status, duplicate: true };
    }
    return reject("duplicate_order", "A different Shopify order has already confirmed this final quote payment.");
  }

  quote.status = "balance_paid";
  quote.paymentStatus = "COMPLETE";
  quote.paidAt = new Date().toISOString();
  quote.checkoutProvider = "shopify";
  quote.shopifyPaidOrderId = details.orderId;
  quote.shopifyPaidOrderName = details.orderName;
  quote.shopifyFinancialStatus = details.financialStatus;
  quote.lastPaymentError = "";
  job.status = "ready_to_order";
  addTimeline(job, "balance_paid", `Final payment confirmed through Shopify checkout for ${displayCurrency(quote.finalAmountZar)}. Order is ready for Arcovia to place manually.`, {
    paymentProvider: "shopify",
    shopifyOrderId: details.orderId,
    shopifyOrderName: details.orderName
  });
  upsertJob(job);
  await sendCustomerEmailForJob(job, "customer_final_payment_received", customerFinalPaymentReceived(job));
  await sendAdminEmailForJob(job, "admin_final_payment_received", adminFinalPaymentReceived(job), { sensitive: true });
  return { ok: true, kind: "final_balance", job_id: job.id, status: job.status };
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
  const deliveryAddress = extractDeliveryAddress(enrichedPayload);
  if (existing) return updateExistingJobFromOrder(existing, enrichedPayload, productRequest, deliveryAddress, source, options);

  const now = new Date();
  const job = {
    id: randomUUID(),
    publicToken: safeRestoreToken(enrichedPayload.public_token || enrichedPayload.publicToken) || randomUUID(),
    reviewToken: safeRestoreToken(enrichedPayload.review_token || enrichedPayload.reviewToken) || randomUUID(),
    customerOptionsToken: safeRestoreToken(enrichedPayload.customer_options_token || enrichedPayload.customerOptionsToken) || randomUUID(),
    source,
    orderId,
    orderName,
    customerEmail: enrichedPayload.email || enrichedPayload.customer_email || enrichedPayload.customer?.email || "",
    customerName: enrichedPayload.customer_name || enrichedPayload.customer?.displayName || enrichedPayload.customer?.first_name || "",
    deliveryAddress,
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
      addTimeline(job, "local_worker_waiting", "Sourcing worker mode is enabled. Waiting for the always-on PC worker to claim this research job.");
    }
  } else {
    addTimeline(job, "awaiting_brief", "Paid order received, but no product brief was attached to the order.");
  }
  upsertJob(job);

  if (!options.skipDepositEmail) {
    await sendCustomerEmailForJob(job, "deposit_received", depositReceived(job));
  }

  if (productRequest && !config.localCodexWorkerEnabled) queueResearch(job.id);
  return job;
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

async function updateExistingJobFromOrder(existing, payload, productRequest, deliveryAddress, source, options = {}) {
  existing.reviewToken ||= safeRestoreToken(payload.review_token || payload.reviewToken) || randomUUID();
  existing.customerOptionsToken ||= safeRestoreToken(payload.customer_options_token || payload.customerOptionsToken) || randomUUID();
  existing.publicToken ||= safeRestoreToken(payload.public_token || payload.publicToken) || randomUUID();
  existing.rawOrder = {
    ...(existing.rawOrder || {}),
    ...payload
  };
  if (deliveryAddress) existing.deliveryAddress = deliveryAddress;

  if (!existing.productRequest?.trim() && productRequest) {
    existing.productRequest = productRequest;
    addTimeline(existing, "brief_captured", `Product brief captured from ${source}.`);
  }

  if (existing.productRequest?.trim() && ["awaiting_brief", "research_failed"].includes(existing.status)) {
    existing.status = "researching";
    addTimeline(existing, "research_requeued", config.localCodexWorkerEnabled
      ? "Sourcing worker research was queued from the latest paid-order payload."
      : "Supplier research was queued from the latest paid-order payload.");
    upsertJob(existing);
    if (!config.localCodexWorkerEnabled) queueResearch(existing.id);
    return existing;
  }

  if (options.forceResearch && existing.productRequest?.trim()) {
    existing.status = "researching";
    existing.researchAttemptCount = 0;
    existing.researchAttempts = [];
    existing.research = null;
    existing.researchCompletedAt = null;
    existing.researchFirstFoundAt = null;
    existing.researchFirstFoundAttempt = null;
    existing.currentResearchAttempt = null;
    existing.nextResearchAt = null;
    existing.localWorker = null;
    existing.refundStatus = null;
    existing.refundReason = null;
    addTimeline(existing, "research_requeued", config.localCodexWorkerEnabled
      ? "Sourcing worker research was force-queued from the latest paid-order payload with completed-pass progress reset."
      : "Supplier research was force-queued from the latest paid-order payload.");
    upsertJob(existing);
    if (!config.localCodexWorkerEnabled) queueResearch(existing.id);
    return existing;
  }

  upsertJob(existing);
  return existing;
}

function safeRestoreToken(value) {
  const token = String(value || "").trim();
  if (!token) return "";
  return /^[a-z0-9][a-z0-9_-]{7,80}$/i.test(token) ? token : "";
}

async function enrichOrderPayload(payload, { forceShopifyLookup = false } = {}) {
  if (!forceShopifyLookup && extractProductRequest(payload)) return payload;

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
    displayFinancialStatus: payload.displayFinancialStatus || shopifyOrder.displayFinancialStatus,
    financial_status: payload.financial_status || shopifyOrder.financial_status,
    total_price: payload.total_price || shopifyOrder.total_price,
    currency: payload.currency || shopifyOrder.currency,
    totalPriceSet: payload.totalPriceSet || shopifyOrder.totalPriceSet,
    tags: mergeShopifyTags(payload.tags, shopifyOrder.tags),
    customAttributes: [
      ...(payload.customAttributes || []),
      ...(shopifyOrder.customAttributes || [])
    ],
    line_items: mergeLineItems(normalizeLineItems(payload), shopifyOrder.line_items || [])
  };
}

function mergeShopifyTags(...values) {
  return Array.from(new Set(values.flatMap((value) => Array.isArray(value)
    ? value
    : String(value || "").split(","))
    .map((value) => String(value || "").trim())
    .filter(Boolean)));
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
  if (!config.adminStatusSecret && !config.flowSecret) return json(res, 404, { error: "not_found" });
  if (!isAuthorizedAdminRequest(req, url)) {
    return json(res, 401, { error: "invalid_admin_secret" });
  }

  const details = url.searchParams.get("details") === "1";
  const jobs = readJobs().map((job) => serializeJob(job, details));

  json(res, 200, { ok: true, jobs });
}

async function handleAdminEmailTest(req, res, url) {
  if (!config.adminStatusSecret && !config.flowSecret) return json(res, 404, { error: "not_found" });
  if (!isAuthorizedAdminRequest(req, url)) {
    return json(res, 401, { error: "invalid_admin_secret" });
  }

  const diagnostics = emailDiagnostics();
  const result = await sendEmail({
    to: config.adminEmail,
    subject: "Arcovia email test",
    text: `Arcovia email test\n\nThis confirms the backend can send email through the configured production provider.\n\nProvider setting: ${diagnostics.provider}\nActive provider plan: ${diagnostics.activeProviderPlan.join(", ") || "none"}\nSMTP host: ${diagnostics.smtpHost || "not configured"}\nFrom: ${diagnostics.activeFromEmail}\nSent at: ${new Date().toISOString()}\n\nArcovia`
  });

  return json(res, result.ok ? 200 : 502, {
    ok: Boolean(result.ok),
    provider: result.provider || "",
    providerId: result.id || result.providerId || null,
    dryRun: Boolean(result.dryRun),
    reason: result.reason || "",
    diagnostics: {
      provider: diagnostics.provider,
      ready: diagnostics.ready,
      activeProviderPlan: diagnostics.activeProviderPlan,
      smtpConfigured: diagnostics.smtpConfigured,
      smtpHost: diagnostics.smtpHost,
      smtpPort: diagnostics.smtpPort,
      smtpSecure: diagnostics.smtpSecure,
      issues: diagnostics.issues
    }
  });
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
    .source-card { display:grid; grid-template-columns:minmax(96px,168px) minmax(0,1fr); gap:14px; border:1px solid #32101a; background:#0b0407; border-radius:16px; padding:12px; }
    .source-card.rejected { border-color:#4b1724; background:#110609; }
    .source-card.approved { border-color:#245b3b; background:#07170f; }
    .source-card.candidate { border-color:#72551d; background:#151006; }
    .source-gallery { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px; align-content:start; }
    .source-gallery.single { grid-template-columns:1fr; }
    .source-image { width:100%; height:82px; border-radius:14px; border:1px solid #34111a; object-fit:cover; background:#1a0a0f; display:block; }
    .source-gallery.single .source-image { height:120px; }
    .image-fallback { width:100%; min-height:96px; border-radius:14px; border:1px dashed #562033; background:linear-gradient(145deg,#1d0a10,#080406); color:#d8b8c0; display:flex; align-items:center; justify-content:center; text-align:center; font-size:11px; line-height:1.2; padding:8px; }
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
    .quote-admin { border:1px solid #6b1024; background:#10070a; border-radius:18px; padding:14px; margin:14px 0; }
    .quote-admin form { display:grid; gap:10px; margin:12px 0 0; }
    .quote-fields { display:grid; gap:10px; }
    .quote-fields label { display:grid; gap:5px; color:#d8b8c0; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
    .quote-fields input, .quote-fields textarea { width:100%; border-radius:10px; border:1px solid #4b1724; background:#0b0407; color:#fff; padding:10px; font-size:14px; }
    .quote-actions { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
    .email-log { border:1px solid #32101a; background:#0b0407; border-radius:16px; padding:12px; margin:14px 0; }
    .email-log table { width:100%; border-collapse:collapse; font-size:12px; }
    .email-log th, .email-log td { text-align:left; border-bottom:1px solid #32101a; padding:7px; vertical-align:top; }
    .email-ok { color:#6ee7a8; font-weight:800; }
    .email-fail { color:#ff8fa3; font-weight:800; }
    .button.secondary { background:#1b0a10; border-color:#4b1724; }
    .button.warning { background:#6b3d08; border-color:#b47915; }
    .button.success { background:#165c35; border-color:#2f8f58; }
    .empty-section { padding:14px; color:#d8b8c0; }
    .setup-warning { border-color:#b47915; background:#211505; }
    .setup-warning h2, .setup-warning h3 { color:#ffd88a; }
    .setup-warning ol { margin:10px 0 0; padding-left:22px; color:#ead7dc; line-height:1.45; }
    .setup-warning code { background:#0f0609; border:1px solid #4b1724; border-radius:8px; padding:2px 5px; color:#ffd7df; }
    .timeline-wrap { margin-top:16px; }
    @media (min-width: 760px) {
      .source-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
      .source-card.wide { grid-column:1 / -1; }
      .source-metrics { grid-template-columns:repeat(4,minmax(0,1fr)); }
      .quote-fields { grid-template-columns:repeat(2,minmax(0,1fr)); }
      .quote-fields .wide { grid-column:1 / -1; }
    }
    @media (max-width: 560px) {
      .job-head { display:block; }
      .source-card { grid-template-columns:1fr; }
      .source-image, .source-gallery.single .source-image, .image-fallback { width:100%; height:180px; }
      .source-metrics { grid-template-columns:1fr; }
    }
  </style>`;
}

function storageWarningHtml() {
  const storage = storageHealth();
  if (storage.dataDirConfigured) return "";

  return `<div class="card setup-warning">
    <h2>Render storage is not persistent yet</h2>
    <p class="muted">The tracking site is online, but Render is still using temporary file storage at <code>${escapeHtml(storage.dataDir)}</code>. If Render redeploys or restarts, saved sourcing jobs can disappear and this monitor will show no jobs.</p>
    <ol>
      <li>In Render, add a persistent disk to the Arcovia web service.</li>
      <li>Use mount path <code>/var/data</code>.</li>
      <li>Add environment variable <code>ARCOVIA_DATA_DIR=/var/data</code>.</li>
      <li>Redeploy the service, then rerun Shopify Flow for any already-paid order.</li>
    </ol>
  </div>`;
}

function emptyJobsCard() {
  return `<div class="card setup-warning">
    <h2>No sourcing jobs found</h2>
    <p class="muted">The backend currently has 0 stored jobs. If a customer already paid, open that Shopify order and manually run the Arcovia Flow again so Render receives the paid-order payload.</p>
    <ol>
      <li>Shopify Admin → Orders.</li>
      <li>Open the paid sourcing-deposit order.</li>
      <li>More actions → Run Flow automation.</li>
      <li>Select the Arcovia sourcing workflow and run it.</li>
    </ol>
  </div>`;
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
  <title>Arcovia sourcing monitor</title>
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
    .human_review, .supplier_selected, .options_sent, .quote_ready, .balance_paid, .ready_to_order, .order_placed, .in_transit, .delivered { background:#165c35; }
    .refund_due, .research_failed, .payment_failed, .quote_expired, .supplier_unavailable, .no_online_purchase_available, .cancelled_by_customer { background:#7a1028; }
    .quote_verifying, .payment_pending, .customer_selected_option { background:#8a5b00; }
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
    <h1>Arcovia sourcing monitor</h1>
    <div class="muted">Auto-refreshes every 30 seconds. Last loaded: ${escapeHtml(formatEventTime(new Date().toISOString()))}</div>
    <div class="toolbar">
      <a class="button" href="${escapeHtml(refreshUrl)}">Refresh now</a>
    </div>
  </header>
  <main class="monitor-shell">
    ${storageWarningHtml()}
    ${cards || emptyJobsCard()}
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
    .human_review, .supplier_selected, .options_sent, .quote_ready, .balance_paid, .ready_to_order, .order_placed, .in_transit, .delivered { background:#165c35; }
    .refund_due, .research_failed, .payment_failed, .quote_expired, .supplier_unavailable, .no_online_purchase_available, .cancelled_by_customer { background:#7a1028; }
    .quote_verifying, .payment_pending, .customer_selected_option { background:#8a5b00; }
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
    .human_review, .supplier_selected, .options_sent, .quote_ready, .balance_paid, .ready_to_order, .order_placed, .in_transit, .delivered { background:#165c35; }
    .refund_due, .research_failed, .payment_failed, .quote_expired, .supplier_unavailable, .no_online_purchase_available, .cancelled_by_customer { background:#7a1028; }
    .quote_verifying, .payment_pending, .customer_selected_option { background:#8a5b00; }
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
  <main class="monitor-shell">${storageWarningHtml()}${cards || emptyJobsCard()}</main>
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

async function handleQuoteAction(req, res, mode) {
  const body = await readBody(req);
  const form = new URLSearchParams(body);
  const auth = resolveQuoteActionAuth(form, mode);
  if (!auth.ok) {
    return html(res, auth.status || 401, auth.html || "<h1>Not authorized</h1>");
  }

  const job = auth.job;
  const action = String(form.get("action") || "");

  if (action === "resend_options") {
    await reconcileResearchCompletionNotifications(job.id, { admin: false, forceCustomer: true });
    return redirect(res, auth.redirect);
  }

  if (action === "no_online_purchase") {
    job.status = "no_online_purchase_available";
    job.refundStatus = "manual_refund_required";
    job.refundReason = "Arcovia could not confirm a safe online purchase route for the selected option.";
    job.finalQuote ||= {};
    job.finalQuote.status = "no_online_purchase_available";
    job.finalQuote.updatedAt = new Date().toISOString();
    addTimeline(job, "no_online_purchase_available", job.refundReason);
    upsertJob(job);
    await sendAdminEmailForJob(job, "admin_refund_due", adminRefundDue(job));
    await sendCustomerEmailForJob(job, "customer_no_online_purchase_available", customerNoOnlinePurchaseAvailable(job));
    return redirect(res, auth.redirect);
  }

  const quote = ensureFinalQuote(job, selectedQuoteSource(job));
  updateQuoteFromForm(quote, form);

  if (action === "save_quote_draft") {
    quote.status = "verification_pending";
    job.status = "quote_verifying";
    addTimeline(job, "quote_draft_saved", `Final quote draft saved at ${displayCurrency(quote.finalAmountZar)}.`);
    upsertJob(job);
    return redirect(res, auth.redirect);
  }

  if (action === "send_quote" || action === "resend_quote") {
    if (!Number.isFinite(Number(quote.finalAmountZar)) || Number(quote.finalAmountZar) <= 0) {
      addTimeline(job, "quote_send_blocked", "Final quote was not sent because the confirmed amount is missing or invalid.");
      upsertJob(job);
      return redirect(res, auth.redirect);
    }
    if (["COMPLETE", "PAID"].includes(String(quote.paymentStatus || "").toUpperCase())
      || ["balance_paid", "ready_to_order", "order_placed", "in_transit", "delivered"].includes(job.status)) {
      addTimeline(job, "quote_send_blocked", "Final quote was not changed because its payment has already been confirmed.");
      upsertJob(job);
      return redirect(res, auth.redirect);
    }
    if (!isFinalPaymentStorageReady()) {
      quote.status = "payment_setup_blocked";
      job.status = "quote_verifying";
      addTimeline(job, "quote_payment_blocked", finalPaymentBlockedMessage());
      upsertJob(job);
      return redirect(res, auth.redirect);
    }

    const checkout = await prepareFinalQuoteCheckout(job);
    if (!checkout.ok) {
      quote.status = "payment_setup_blocked";
      job.status = "quote_verifying";
      addTimeline(job, "quote_payment_blocked", checkout.message);
      upsertJob(job);
      return redirect(res, auth.redirect);
    }

    quote.status = "quote_ready";
    quote.paymentStatus = "pending";
    quote.expiresAt ||= addHours(new Date(), 24).toISOString();
    job.status = "payment_pending";
    addTimeline(job, "quote_ready", `Final quote ready and payment link prepared for ${displayCurrency(quote.finalAmountZar)}.`, {
      quoteToken: quote.token,
      paymentId: quote.paymentId,
      checkoutProvider: checkout.provider,
      shopifyDraftOrderName: quote.shopifyDraftOrderName || ""
    });
    upsertJob(job);
    const result = await sendCustomerEmailForJob(job, action === "resend_quote" ? "customer_quote_ready_resend" : "customer_quote_ready", customerQuoteReady(job));
    if (result.ok) {
      quote.sentAt = new Date().toISOString();
      quote.lastEmailError = "";
      addTimeline(job, "quote_email_sent", "Final quote payment link sent to customer.");
    } else {
      quote.lastEmailError = result.reason || "unknown email error";
      addTimeline(job, "quote_email_failed", `Final quote email failed: ${quote.lastEmailError}`);
    }
    upsertJob(job);
    return redirect(res, auth.redirect);
  }

  if (action === "mark_order_placed") {
    updateSupplierOrderFromForm(job, form);
    job.status = "order_placed";
    job.supplierOrder.placedAt ||= new Date().toISOString();
    addTimeline(job, "order_placed", "Supplier order marked as placed by Arcovia.", {
      orderReference: job.supplierOrder.orderReference || "",
      trackingNumber: job.supplierOrder.trackingNumber || ""
    });
    upsertJob(job);
    await sendCustomerEmailForJob(job, "customer_order_placed", customerSupplierOrderPlaced(job));
    return redirect(res, auth.redirect);
  }

  if (action === "update_tracking" || action === "mark_in_transit" || action === "mark_delivered") {
    updateSupplierOrderFromForm(job, form);
    job.status = action === "mark_delivered" ? "delivered" : "in_transit";
    addTimeline(job, job.status, `Order status updated to ${statusLabel(job.status)}.`, {
      trackingNumber: job.supplierOrder?.trackingNumber || "",
      eta: job.supplierOrder?.eta || ""
    });
    upsertJob(job);
    await sendCustomerEmailForJob(job, "customer_order_status_update", customerOrderStatusUpdate(job));
    return redirect(res, auth.redirect);
  }

  addTimeline(job, "quote_action_ignored", `Unknown quote action ignored: ${action || "blank"}.`);
  upsertJob(job);
  return redirect(res, auth.redirect);
}

function resolveQuoteActionAuth(form, mode) {
  const jobId = String(form.get("job_id") || "");
  if (mode === "monitor") {
    const key = String(form.get("key") || "");
    if (!isValidMonitorKey(key)) {
      return { ok: false, status: 401, html: monitorLoginHtml() };
    }
    const job = getJob(jobId);
    if (!job) return { ok: false, status: 404, html: "<h1>Job not found</h1>" };
    return { ok: true, job, key, redirect: `/monitor?key=${encodeURIComponent(key)}#${encodeURIComponent(job.id)}` };
  }

  const reviewToken = String(form.get("review_token") || "");
  const job = getJobByReviewToken(reviewToken);
  if (!job || (jobId && job.id !== jobId)) {
    return { ok: false, status: 404, html: "<h1>Review job not found</h1>" };
  }
  return { ok: true, job, reviewToken, redirect: `/review/${encodeURIComponent(reviewToken)}#${encodeURIComponent(job.id)}` };
}

function handleQuotePage(_req, res, token) {
  const job = getJobByQuoteToken(token);
  if (!job) {
    return html(res, 404, quotePageShell("Quote link not found", "<p>This Arcovia quote link is not active.</p>"));
  }

  const quote = job.finalQuote || {};
  if (isQuoteExpired(quote) && !["balance_paid", "ready_to_order", "order_placed", "in_transit", "delivered"].includes(job.status)) {
    quote.status = "quote_expired";
    job.status = "quote_expired";
    addTimeline(job, "quote_expired", "Customer quote link expired before payment was confirmed.");
    upsertJob(job);
  }

  const canPay = canPayQuote(job);
  const shopifyCheckoutUrl = canPay && quote.checkoutProvider === "shopify"
    ? safeShopifyCheckoutUrl(quote.shopifyInvoiceUrl)
    : "";
  const useDirectPayfast = canPay && !shopifyCheckoutUrl && quote.checkoutProvider !== "shopify";
  const paymentFields = useDirectPayfast ? buildPayfastCheckoutFields(job) : null;
  const paymentInputs = paymentFields
    ? Object.entries(paymentFields).map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}" />`).join("")
    : "";
  const paymentBlock = shopifyCheckoutUrl
    ? `<div class="pay-card">
        <a class="button" href="${escapeHtml(shopifyCheckoutUrl)}" rel="noreferrer">Pay now — ${escapeHtml(displayCurrency(quote.finalAmountZar))}</a>
        <p class="muted">This opens Arcovia's secure Shopify checkout. Choose PayFast there to complete payment.</p>
      </div>`
    : paymentFields
      ? `<form class="pay-card" method="POST" action="${escapeHtml(payfastProcessUrl())}">
        ${paymentInputs}
        <button type="submit">Pay ${escapeHtml(displayCurrency(quote.finalAmountZar))} securely with PayFast</button>
        <p class="muted">After payment, Arcovia waits for PayFast confirmation before preparing the order.</p>
      </form>`
      : quote.status === "balance_paid" || job.status === "ready_to_order" || job.status === "order_placed"
        ? `<div class="notice success"><strong>Payment confirmed.</strong><br>Arcovia is preparing or has placed the order.</div>`
        : `<div class="notice"><strong>Payment is not available yet.</strong><br>${escapeHtml(customerPaymentUnavailableMessage(job))}</div>`;

  return html(res, 200, quotePageShell("Arcovia final quote", `
    <div class="badge">${escapeHtml(statusLabel(job.status))}</div>
    <p class="muted">Order ${escapeHtml(job.orderName)} · ${escapeHtml(quote.optionLabel || "Selected option")}</p>
    <section class="quote-grid">
      <div>
        ${customerOptionImageHtml(ensureCustomerOptionsToken(job), Number(quote.optionIndex || 0), job)}
      </div>
      <div class="quote-card">
        <h2>Confirmed total</h2>
        <div class="price">${escapeHtml(displayCurrency(quote.finalAmountZar))}</div>
        <dl>
          <dt>Item / supplier total</dt><dd>${escapeHtml(quote.itemCost || "Included in confirmed total")}</dd>
          <dt>Shipping</dt><dd>${escapeHtml(quote.shippingCost || "Included or not applicable")}</dd>
          <dt>Duties / import handling</dt><dd>${escapeHtml(quote.dutiesCost || "Included if applicable")}</dd>
          <dt>Arcovia handling</dt><dd>${escapeHtml(quote.handlingFee || "Included if applicable")}</dd>
          <dt>Quote expires</dt><dd>${escapeHtml(formatEventTime(quote.expiresAt))}</dd>
        </dl>
        <p class="muted">${escapeHtml(quote.customerNotes || "Final availability and price were reviewed by Arcovia before this quote link was sent.")}</p>
      </div>
    </section>
    ${paymentBlock}
    <section class="notice">
      <strong>Refund and cancellation rule</strong><br>
      If Arcovia cannot place the item order after your final payment, the final payment will be refunded or Arcovia will offer another approved option. After the supplier order is placed, cancellation and refunds depend on the supplier's policy.
    </section>
  `));
}

async function handlePayfastNotify(req, res) {
  const rawBody = await readBody(req);
  const parsed = parsePayfastBody(rawBody);
  const paymentId = String(parsed.fields.m_payment_id || "");
  const job = getJobByPayfastPaymentId(paymentId);
  const verification = verifyPayfastSignature(rawBody);

  if (!job) {
    return json(res, 404, { error: "unknown_payment_id" });
  }

  if (!verification.ok) {
    return json(res, 400, { error: "invalid_signature" });
  }

  if (String(parsed.fields.merchant_id || "") !== String(config.payfastMerchantId || "")) {
    return json(res, 400, { error: "merchant_id_mismatch" });
  }
  if (String(parsed.fields.custom_str1 || "") !== String(job.id || "")
    || String(parsed.fields.custom_str2 || "") !== String(job.finalQuote?.token || "")) {
    return json(res, 400, { error: "quote_identifier_mismatch" });
  }

  const paidAmount = parsed.fields.amount_gross || parsed.fields.amount;
  if (!amountsMatch(job.finalQuote.finalAmountZar, paidAmount)) {
    job.finalQuote.paymentStatus = "amount_mismatch";
    job.finalQuote.lastPaymentError = `Expected ${formatPayfastAmount(job.finalQuote.finalAmountZar)}, received ${paidAmount || "missing"}.`;
    job.status = "payment_failed";
    addTimeline(job, "payfast_amount_mismatch", job.finalQuote.lastPaymentError);
    upsertJob(job);
    return json(res, 400, { error: "amount_mismatch" });
  }

  job.finalQuote ||= {};
  job.finalQuote.payfastNotifications ||= [];
  const duplicateKey = `${paymentId}:${parsed.fields.pf_payment_id || ""}:${parsed.fields.payment_status || ""}:${paidAmount || ""}`;
  if (job.finalQuote.payfastNotifications.some((entry) => entry.duplicateKey === duplicateKey)) {
    return json(res, 200, { ok: true, duplicate: true });
  }

  job.finalQuote.payfastNotifications.push({
    duplicateKey,
    receivedAt: new Date().toISOString(),
    fields: sanitizePayfastFields(parsed.fields)
  });

  const paymentStatus = String(parsed.fields.payment_status || "").toUpperCase();
  if (paymentStatus === "COMPLETE") {
    job.finalQuote.status = "balance_paid";
    job.finalQuote.paymentStatus = "COMPLETE";
    job.finalQuote.paidAt = new Date().toISOString();
    job.finalQuote.payfastPaymentId = parsed.fields.pf_payment_id || "";
    job.status = "ready_to_order";
    addTimeline(job, "balance_paid", `Final payment confirmed by PayFast for ${displayCurrency(job.finalQuote.finalAmountZar)}. Order is ready for Arcovia to place manually.`);
    upsertJob(job);
    await sendCustomerEmailForJob(job, "customer_final_payment_received", customerFinalPaymentReceived(job));
    await sendAdminEmailForJob(job, "admin_final_payment_received", adminFinalPaymentReceived(job), { sensitive: true });
    return json(res, 200, { ok: true });
  }

  job.finalQuote.paymentStatus = paymentStatus || "UNKNOWN";
  job.finalQuote.lastPaymentError = `PayFast status: ${paymentStatus || "UNKNOWN"}`;
  job.status = paymentStatus === "CANCELLED" ? "payment_failed" : "payment_pending";
  addTimeline(job, "payfast_payment_not_complete", job.finalQuote.lastPaymentError);
  upsertJob(job);
  return json(res, 200, { ok: true, status: job.status });
}

function handlePayfastReturn(_req, res, url) {
  const token = String(url.searchParams.get("quote") || "");
  const job = getJobByQuoteToken(token);
  const message = job?.finalQuote?.paymentStatus === "COMPLETE"
    ? `<div class="notice success"><strong>Payment confirmed.</strong><br>Arcovia is preparing the order.</div>`
    : `<div class="notice"><strong>Payment is being confirmed.</strong><br>If you paid successfully, Arcovia will update this page as soon as PayFast sends confirmation.</div>`;
  return html(res, 200, quotePageShell("Payment confirmation", `
    ${message}
    ${job ? `<p><a class="button" href="/quote/${escapeHtml(token)}">Return to quote</a></p>` : ""}
  `));
}

function handlePayfastCancel(_req, res, url) {
  const token = String(url.searchParams.get("quote") || "");
  const job = getJobByQuoteToken(token);
  if (job) {
    job.finalQuote ||= {};
    job.finalQuote.paymentStatus = "cancelled_by_customer";
    addTimeline(job, "payfast_cancel_return", "Customer returned from PayFast without completing payment.");
    upsertJob(job);
  }
  return html(res, 200, quotePageShell("Payment not completed", `
    <div class="notice"><strong>Payment was not completed.</strong><br>You can return to the quote and try again while the quote is still valid.</div>
    ${job ? `<p><a class="button" href="/quote/${escapeHtml(token)}">Return to quote</a></p>` : ""}
  `));
}

function updateQuoteFromForm(quote, form) {
  const amount = Number(String(form.get("final_amount_zar") || "").replace(/,/g, "."));
  if (Number.isFinite(amount) && amount > 0) quote.finalAmountZar = amount;
  quote.itemCost = textFormValue(form, "item_cost") || quote.itemCost || "";
  quote.shippingCost = textFormValue(form, "shipping_cost") || quote.shippingCost || "";
  quote.dutiesCost = textFormValue(form, "duties_cost") || quote.dutiesCost || "";
  quote.handlingFee = textFormValue(form, "handling_fee") || quote.handlingFee || "";
  quote.customerNotes = textFormValue(form, "customer_notes") || quote.customerNotes || "";
  quote.internalNotes = textFormValue(form, "internal_notes") || quote.internalNotes || "";
  const expiryHours = Number(form.get("expiry_hours") || 24);
  if (Number.isFinite(expiryHours) && expiryHours > 0) {
    quote.expiresAt = addHours(new Date(), Math.min(168, expiryHours)).toISOString();
  }
  quote.verifiedAt = new Date().toISOString();
  quote.updatedAt = quote.verifiedAt;
}

function selectedQuoteSource(job) {
  const selected = job.customerSelectedOption || job.selectedSupplier || {};
  return {
    supplier: selected.supplier || {},
    optionIndex: Number(selected.index || 0),
    optionLabel: selected.optionLabel || customerOptionLabel(job, Number(selected.index || 0)),
    sourceGroup: selected.sourceGroup || "suppliers",
    selectedBy: job.customerSelectedOption ? "customer" : "arcovia"
  };
}

function updateSupplierOrderFromForm(job, form) {
  job.supplierOrder ||= {};
  job.supplierOrder.orderReference = textFormValue(form, "supplier_order_reference") || job.supplierOrder.orderReference || "";
  job.supplierOrder.trackingNumber = textFormValue(form, "tracking_number") || job.supplierOrder.trackingNumber || "";
  job.supplierOrder.trackingUrl = textFormValue(form, "tracking_url") || job.supplierOrder.trackingUrl || "";
  job.supplierOrder.eta = textFormValue(form, "eta") || job.supplierOrder.eta || "";
  job.supplierOrder.notes = textFormValue(form, "order_notes") || job.supplierOrder.notes || "";
  job.supplierOrder.updatedAt = new Date().toISOString();
}

async function prepareFinalQuoteCheckout(job) {
  const quote = job.finalQuote || {};
  let shopifyError = "";

  if (shopifyDraftCheckoutConfigured()) {
    try {
      const checkout = await prepareShopifyFinalCheckout(job);
      quote.checkoutProvider = "shopify";
      quote.shopifyDraftOrderId = checkout.draftOrderId;
      quote.shopifyDraftOrderName = checkout.draftOrderName;
      quote.shopifyInvoiceUrl = checkout.invoiceUrl;
      quote.shopifyDraftOrderStatus = checkout.status;
      quote.checkoutAmountZar = checkout.amountZar;
      quote.checkoutCurrency = checkout.currency;
      quote.checkoutPreparedAt = checkout.preparedAt;
      quote.shopifyCheckoutError = "";
      return { ok: true, provider: "shopify" };
    } catch (error) {
      shopifyError = String(error?.message || error || "Shopify checkout preparation failed.").slice(0, 700);
      quote.shopifyCheckoutError = shopifyError;
      quote.shopifyCheckoutErrorAt = new Date().toISOString();

      // Never expose a second payment route while an older Shopify invoice may
      // still be payable at a different amount.
      if (quote.shopifyDraftOrderId || quote.shopifyInvoiceUrl) {
        return {
          ok: false,
          message: `Final payment link blocked because the existing Shopify checkout could not be refreshed: ${shopifyError}`
        };
      }
    }
  }

  if (payfastConfigured()) {
    quote.checkoutProvider = "payfast";
    quote.checkoutAmountZar = Number(quote.finalAmountZar);
    quote.checkoutCurrency = "ZAR";
    quote.checkoutPreparedAt = new Date().toISOString();
    return { ok: true, provider: "payfast", fallbackFromShopify: Boolean(shopifyError) };
  }

  return {
    ok: false,
    message: shopifyError
      ? `Shopify checkout could not be prepared and direct PayFast fallback is not configured: ${shopifyError}`
      : finalPaymentBlockedMessage()
  };
}

function canPayQuote(job) {
  const quote = job.finalQuote || {};
  const providerReady = quote.checkoutProvider === "shopify"
    ? Boolean(safeShopifyCheckoutUrl(quote.shopifyInvoiceUrl))
    : payfastConfigured();
  return isFinalPaymentStorageReady()
    && providerReady
    && !isQuoteExpired(quote)
    && ["quote_ready", "payment_pending"].includes(job.status)
    && ["quote_ready", "payment_pending"].includes(quote.status || "quote_ready")
    && Number(quote.finalAmountZar || 0) > 0
    && quote.paymentStatus !== "COMPLETE";
}

function isQuoteExpired(quote) {
  return Boolean(quote?.expiresAt && new Date(quote.expiresAt) <= new Date() && quote.paymentStatus !== "COMPLETE");
}

function isFinalPaymentOperational() {
  return isFinalPaymentStorageReady() && (shopifyDraftCheckoutConfigured() || payfastConfigured());
}

function isFinalPaymentStorageReady() {
  return storageHealth().dataDirConfigured || config.allowTemporaryPaymentStorage;
}

function finalPaymentBlockedMessage() {
  if (!isFinalPaymentStorageReady()) {
    return "Final payment link blocked: persistent storage is not configured. Add a Render disk and set ARCOVIA_DATA_DIR=/var/data before taking product-balance payments.";
  }
  if (!shopifyDraftCheckoutConfigured() && !payfastConfigured()) {
    return "Final payment link blocked: Shopify draft-order checkout and direct PayFast fallback are not configured.";
  }
  return "Final payment link blocked: payment setup is incomplete.";
}

function customerPaymentUnavailableMessage(job) {
  if (job.status === "quote_expired") return "This quote expired and must be re-confirmed before payment.";
  if (!isFinalPaymentStorageReady()) return "Arcovia is finalizing the payment system before accepting this payment.";
  if (job.finalQuote?.checkoutProvider === "shopify" && !safeShopifyCheckoutUrl(job.finalQuote?.shopifyInvoiceUrl)) {
    return "Arcovia is refreshing the secure Shopify checkout before accepting this payment.";
  }
  if (!isFinalPaymentOperational()) return "Arcovia is finalizing the checkout payment setup before accepting this payment.";
  if (!job.finalQuote?.finalAmountZar) return "Arcovia still needs to confirm the final total.";
  return "Arcovia still needs to confirm this quote before payment.";
}

function safeShopifyCheckoutUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const configuredHost = String(config.shopifyStoreDomain || "")
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .toLowerCase();
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:") return "";
    if (host !== configuredHost && !host.endsWith(".myshopify.com")) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function quotePageShell(title, body) {
  return `<!doctype html>
<html>
<head>
  <title>${escapeHtml(title)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex,nofollow" />
  <style>
    :root { color-scheme: dark; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:Arial, sans-serif; background:#080406; color:#fff; }
    header { padding:24px 16px; background:radial-gradient(circle at top right, rgba(122,16,40,.5), transparent 42%), linear-gradient(135deg,#16080d,#320817); border-bottom:1px solid #6b1024; }
    main { max-width:980px; margin:0 auto; padding:18px; }
    h1 { margin:0 0 8px; font-size:30px; letter-spacing:-.02em; }
    h2 { margin:0 0 10px; }
    p { line-height:1.5; }
    a { color:#ffd7df; }
    .muted { color:#d8b8c0; font-size:14px; }
    .badge { display:inline-block; margin:8px 0 14px; padding:8px 12px; border-radius:999px; background:#7a1028; font-weight:900; text-transform:uppercase; font-size:12px; letter-spacing:.05em; }
    .quote-grid { display:grid; gap:16px; margin:18px 0; }
    .quote-card, .notice, .pay-card { border:1px solid #4b1724; background:#13080c; border-radius:20px; padding:16px; box-shadow:0 12px 30px rgba(0,0,0,.22); }
    .notice.success { border-color:#2f8f58; background:#092014; }
    .price { display:inline-block; margin:4px 0 12px; padding:12px 14px; border-radius:14px; background:#7a1028; border:1px solid #bc3456; font-weight:900; font-size:22px; }
    dl { display:grid; gap:8px; margin:12px 0; }
    dt { color:#d8b8c0; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
    dd { margin:0 0 8px; font-weight:800; }
    button, .button { cursor:pointer; display:inline-block; border:1px solid #bc3456; background:#7a1028; color:#fff; padding:14px 18px; border-radius:999px; font-weight:900; font-size:16px; text-decoration:none; }
    .option-gallery { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; align-content:start; }
    .option-gallery.single { grid-template-columns:1fr; }
    .option-image { width:100%; height:150px; border-radius:16px; border:1px solid #34111a; object-fit:cover; background:#1a0a0f; display:block; }
    .option-gallery.single .option-image { height:260px; }
    .image-fallback { width:100%; min-height:220px; border-radius:16px; border:1px dashed #562033; background:linear-gradient(145deg,#1d0a10,#080406); color:#d8b8c0; display:flex; align-items:center; justify-content:center; text-align:center; font-size:13px; line-height:1.25; padding:10px; }
    @media (min-width:760px) { .quote-grid { grid-template-columns:minmax(260px,380px) minmax(0,1fr); } }
  </style>
</head>
<body>
  <header><main><h1>${escapeHtml(title)}</h1><p class="muted">Secure Arcovia sourcing payment page.</p></main></header>
  <main>${body}</main>
</body>
</html>`;
}

function textFormValue(form, key) {
  return String(form.get(key) || "").trim();
}

function displayCurrency(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return "To be confirmed";
  return `R${amount.toFixed(2)}`;
}

function sanitizePayfastFields(fields) {
  const output = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (/key|passphrase|signature/i.test(key)) continue;
    output[key] = String(value || "").slice(0, 500);
  }
  return output;
}

function handleCustomerOptionsPage(_req, res, token, url) {
  const job = getJobByCustomerOptionsToken(token);
  if (!job) {
    return html(res, 404, `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Options link not found</title></head><body><h1>Options link not found</h1><p>This Arcovia options link is not active.</p></body></html>`);
  }

  const access = ensureCustomerOptionsAccess(job);
  if (access.changed) upsertJob(job);
  if (access.state.expired) {
    return html(res, 410, customerOptionsInactivePage(
      "This private options link has expired",
      `For your security, the decision window for order ${job.orderName} has ended. Reply to the Arcovia email for a new link if the request is still active.`
    ));
  }

  const suppliers = job.research?.suppliers || [];
  const optionsReady = Boolean(job.researchCompletedAt && suppliers.length);
  const selected = job.customerSelectedOption || null;
  const cancelled = access.state.decision === "cancelled" || job.status === "cancelled_by_customer";
  const selectedNotice = cancelled
    ? `<div class="notice cancelled"><strong>This sourcing request was cancelled.</strong><br>No final product payment is due. Because approved options had already been made available, the R250 sourcing deposit is not refundable under the sourcing-deposit policy.</div>`
    : selected
    ? `<div class="notice success"><strong>Your choice was received.</strong><br>You selected ${escapeHtml(selected.optionLabel || customerOptionLabel(job, Number(selected.index || 0)))}. Arcovia will confirm availability and the final quote before the next payment step.</div>`
    : url.searchParams.get("selected") === "1"
      ? `<div class="notice success"><strong>Your choice was received.</strong><br>Arcovia will confirm availability and the final quote before the next payment step.</div>`
      : "";
  const optionCards = optionsReady
    ? suppliers.map((source, index) => customerOptionCard(source, index, token, selected, job)).join("")
    : "";
  const decisionPanel = customerOptionsDecisionPanel(job, token, optionsReady);
  const autoRefresh = customerOptionsShouldRefresh(job, optionsReady)
    ? `<meta http-equiv="refresh" content="30" />`
    : "";

  return html(res, 200, `<!doctype html>
<html>
<head>
  <title>Arcovia sourcing options</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex,nofollow" />
  ${autoRefresh}
  <style>
    :root { color-scheme: dark; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:Arial, sans-serif; background:#080406; color:#fff; }
    header { padding:22px 16px; background:radial-gradient(circle at top right, rgba(122,16,40,.5), transparent 42%), linear-gradient(135deg,#16080d,#320817); border-bottom:1px solid #6b1024; }
    main { max-width:1200px; margin:0 auto; padding:16px; }
    h1 { margin:0 0 8px; font-size:28px; letter-spacing:-.02em; }
    h2 { margin:0 0 8px; font-size:19px; }
    p { line-height:1.5; }
    .muted { color:#d8b8c0; font-size:14px; }
    .badge { display:inline-block; margin-top:8px; padding:7px 10px; border-radius:999px; background:#7a1028; color:#fff; font-weight:900; font-size:12px; text-transform:uppercase; letter-spacing:.05em; }
    .notice { border:1px solid #4b1724; background:#12070b; border-radius:16px; padding:14px; margin:14px 0; line-height:1.45; }
    .notice.success { border-color:#2f8f58; background:#092014; }
    .notice.cancelled { border-color:#bc3456; background:#240910; }
    .options-grid { display:grid; gap:14px; margin-top:16px; }
    .option-card { display:grid; grid-template-columns:minmax(160px,230px) minmax(0,1fr); gap:16px; border:1px solid #4b1724; background:#13080c; border-radius:20px; padding:14px; box-shadow:0 12px 30px rgba(0,0,0,.22); }
    .option-card.chosen { border-color:#2f8f58; background:#07170f; }
    .option-gallery { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; align-content:start; }
    .option-gallery.single { grid-template-columns:1fr; }
    .option-image { width:100%; height:108px; border-radius:16px; border:1px solid #34111a; object-fit:cover; background:#1a0a0f; display:block; }
    .option-gallery.single .option-image { height:190px; }
    .image-fallback { width:100%; min-height:170px; border-radius:16px; border:1px dashed #562033; background:linear-gradient(145deg,#1d0a10,#080406); color:#d8b8c0; display:flex; align-items:center; justify-content:center; text-align:center; font-size:12px; line-height:1.25; padding:10px; }
    .price { display:inline-block; margin:4px 0 10px; padding:10px 12px; border-radius:14px; background:#7a1028; border:1px solid #bc3456; font-weight:900; }
    .details { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; margin:10px 0; }
    .detail { border:1px solid #2d1018; border-radius:12px; padding:9px; background:#0f0609; min-width:0; }
    .detail span { display:block; color:#d8b8c0; font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
    .detail b { display:block; margin-top:3px; color:#fff; overflow-wrap:break-word; }
    button, .pay-now { cursor:pointer; border:1px solid #bc3456; background:#7a1028; color:#fff; padding:12px 16px; border-radius:999px; font-weight:900; font-size:15px; }
    .chosen-label { display:inline-block; border:1px solid #2f8f58; background:#092014; color:#8df0ba; padding:10px 12px; border-radius:999px; font-weight:900; }
    .decision-panel { margin:24px 0 12px; padding:20px; border:1px solid #6b1024; border-radius:22px; background:linear-gradient(145deg,#1b0a10,#0d0508); box-shadow:0 18px 44px rgba(0,0,0,.3); }
    .decision-panel h2 { font-size:23px; }
    .decision-panel .confirmed-total { margin:12px 0; font-size:clamp(30px,8vw,48px); font-weight:950; letter-spacing:-.04em; }
    .pay-now { display:inline-flex; align-items:center; justify-content:center; width:100%; min-height:54px; margin-top:8px; text-decoration:none; background:#fff; border-color:#fff; color:#260812; font-size:17px; }
    .cancel-form { margin-top:18px; padding-top:18px; border-top:1px solid #3a101b; }
    .cancel-form label { display:block; margin-bottom:8px; font-weight:800; }
    .cancel-form textarea { width:100%; min-height:88px; resize:vertical; padding:12px; border:1px solid #4b1724; border-radius:14px; background:#0b0507; color:#fff; font:inherit; }
    .cancel-button { margin-top:10px; background:transparent; border-color:#8b5360; color:#f4cdd6; }
    .privacy-line { margin:12px 0 0; color:#a9838c; font-size:12px; }
    @media (min-width: 1100px) { .options-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
    @media (max-width: 620px) {
      .option-card { grid-template-columns:1fr; }
      .option-image, .option-gallery.single .option-image, .image-fallback { width:100%; height:210px; }
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
      <p class="privacy-line">Private decision link · one selection or cancellation only · do not forward</p>
    </main>
  </header>
  <main>
    ${selectedNotice}
    ${optionsReady
      ? `<div class="notice">These are the approved options from completed research. Prices are estimates until Arcovia confirms live availability, delivery, and the final quote.</div><section class="options-grid">${optionCards}</section>`
      : `<div class="notice"><strong>Your options are not ready yet.</strong><br>Arcovia is still completing the research/review process. You will receive the options link by email when the approved shortlist is ready.</div>`}
    ${decisionPanel}
  </main>
</body>
</html>`);
}

async function handleCustomerOptionSelect(req, res) {
  const body = await readBody(req);
  const form = new URLSearchParams(body);
  const token = String(form.get("token") || "");
  const optionIndexText = String(form.get("option_index") || "");
  const optionIndex = /^\d+$/.test(optionIndexText) ? Number(optionIndexText) : -1;
  const job = getJobByCustomerOptionsToken(token);
  const supplier = job?.research?.suppliers?.[optionIndex] || null;

  if (!job || !supplier) {
    return html(res, 404, "<h1>Option not found</h1><p>Go back to the options page and refresh.</p>");
  }

  if (!job.researchCompletedAt) {
    return html(res, 400, "<h1>Options are not ready yet</h1><p>Arcovia is still completing the research process.</p>");
  }

  const access = ensureCustomerOptionsAccess(job);
  if (access.changed) upsertJob(job);
  if (access.state.expired) {
    return html(res, 410, customerOptionsInactivePage("This private options link has expired", "Contact Arcovia if you still want to continue with this sourcing request."));
  }
  if (access.state.decision === "cancelled") {
    return html(res, 409, customerOptionsInactivePage("This request has already been cancelled", "A cancelled request cannot be changed through this private link."));
  }
  if (access.state.decision === "selected") {
    if (Number(job.customerSelectedOption?.index) === optionIndex) {
      return redirect(res, `/options/${encodeURIComponent(token)}?selected=1`);
    }
    return html(res, 409, customerOptionsInactivePage("Your one-time choice has already been submitted", "For security, this private link allows one supplier choice only. Contact Arcovia if you selected the wrong option."));
  }

  if (!job.customerSelectedOption) {
    const decision = recordCustomerOptionsDecision(job, "selected");
    if (!decision.ok) {
      return html(res, 409, customerOptionsInactivePage("This options link is no longer accepting a choice", "Contact Arcovia if you still need help with this request."));
    }
    const optionLabel = customerOptionLabel(job, optionIndex);
    job.customerSelectedOption = {
      index: optionIndex,
      optionLabel,
      selectedAt: job.customerOptionsDecisionAt,
      supplier
    };
    ensureFinalQuote(job, {
      supplier,
      optionIndex,
      optionLabel,
      sourceGroup: "suppliers",
      selectedBy: "customer"
    });
    job.status = "quote_verifying";
    job.nextUpdateAt = null;
    job.nextResearchAt = null;
    job.currentResearchAttempt = null;
    addTimeline(job, "customer_option_selected", `Customer selected ${optionLabel}. Arcovia must still confirm and approve before purchasing.`, {
      optionIndex,
      optionLabel,
      supplierName: supplier.name || "",
      supplierUrl: supplier.url || ""
    });
    addTimeline(job, "quote_verifying", "Customer choice received. Arcovia must confirm live availability, delivery, and final total before sending a payment link.");
    upsertJob(job);
    await sendAdminEmailForJob(job, "customer_option_selected_admin", customerOptionSelectedAdmin(job), { sensitive: true });
    await sendCustomerEmailForJob(job, "customer_choice_received", customerChoiceReceived(job));
  }

  return redirect(res, `/options/${encodeURIComponent(token)}?selected=1`);
}

async function handleCustomerOptionsCancel(req, res) {
  const body = await readBody(req);
  const form = new URLSearchParams(body);
  const token = String(form.get("token") || "");
  const confirmed = String(form.get("confirm_cancel") || "") === "yes";
  const job = getJobByCustomerOptionsToken(token);

  if (!job) {
    return html(res, 404, customerOptionsInactivePage("Options link not found", "This Arcovia options link is not active."));
  }

  const access = ensureCustomerOptionsAccess(job);
  if (access.changed) upsertJob(job);
  if (access.state.decision === "cancelled" || job.status === "cancelled_by_customer") {
    return redirect(res, `/options/${encodeURIComponent(token)}?cancelled=1`);
  }
  if (!confirmed) {
    return html(res, 400, customerOptionsInactivePage("Cancellation was not confirmed", "Return to the options page and tick the confirmation box before cancelling."));
  }
  if (access.state.expired) {
    return html(res, 410, customerOptionsInactivePage("This private options link has expired", "Contact Arcovia if you still need to cancel or change this request."));
  }
  if (!canCancelCustomerOptions(job)) {
    return html(res, 409, customerOptionsInactivePage(
      "This request cannot be cancelled from the options link",
      job.customerSelectedOption
        ? "A supplier option has already been submitted. Contact Arcovia before making any final payment if you no longer want to continue."
        : "Payment or order processing has already started. Contact Arcovia for help."
    ));
  }

  const decision = recordCustomerOptionsDecision(job, "cancelled");
  if (!decision.ok) {
    return html(res, 409, customerOptionsInactivePage("This options link is no longer accepting a decision", "Contact Arcovia if you need help with this request."));
  }

  const reason = String(form.get("reason") || "").trim().slice(0, 500) || "None of the approved options were suitable.";
  job.status = "cancelled_by_customer";
  job.cancellation = {
    requestedAt: job.customerOptionsDecisionAt,
    requestedBy: "customer",
    reason,
    stage: "approved_options_reviewed",
    finalPaymentDue: false
  };
  job.refundStatus = "deposit_not_refundable_approved_options";
  job.refundReason = "Approved sourcing options were made available before the customer cancelled.";
  job.nextUpdateAt = null;
  job.nextResearchAt = null;
  job.currentResearchAttempt = null;
  if (job.finalQuote && job.finalQuote.paymentStatus !== "COMPLETE") {
    job.finalQuote.status = "cancelled_by_customer";
    job.finalQuote.paymentStatus = "cancelled_by_customer";
    job.finalQuote.updatedAt = job.customerOptionsDecisionAt;
  }
  addTimeline(job, "cancelled_by_customer", "Customer cancelled after reviewing the approved anonymous options. No final product payment is due; the sourcing deposit is non-refundable under the approved-source rule.", {
    reason,
    refundStatus: job.refundStatus
  });
  upsertJob(job);

  await sendCustomerEmailForJob(job, "customer_options_cancellation_confirmed", customerOptionsCancellationConfirmed(job));
  await sendAdminEmailForJob(job, "admin_customer_options_cancelled", adminCustomerOptionsCancelled(job));
  return redirect(res, `/options/${encodeURIComponent(token)}?cancelled=1`);
}

function customerOptionsDecisionPanel(job, token, optionsReady) {
  const decision = String(job.customerOptionsDecision || "").toLowerCase();
  const quote = job.finalQuote || {};
  const amount = Number(quote.finalAmountZar || 0);
  const paidOrOrdered = ["balance_paid", "ready_to_order", "order_placed", "in_transit", "delivered"].includes(job.status)
    || quote.paymentStatus === "COMPLETE";
  const paymentReady = decision === "selected"
    && Number.isFinite(amount)
    && amount > 0
    && Boolean(quote.token)
    && Boolean(quote.verifiedAt)
    && canPayQuote(job);

  if (decision === "cancelled" || job.status === "cancelled_by_customer") {
    return `<section class="decision-panel">
      <h2>Request cancelled</h2>
      <p>No final product payment will be taken. Arcovia has recorded this request as closed.</p>
      <p class="muted">The R250 sourcing deposit is not refundable because approved options had already been found and made available.</p>
    </section>`;
  }

  if (paidOrOrdered) {
    return `<section class="decision-panel">
      <h2>Payment confirmed</h2>
      <p>Your option decision is complete. Arcovia is preparing or tracking the supplier order.</p>
      <p><a class="pay-now" href="${escapeHtml(statusLinkForJob(job))}">View order status</a></p>
    </section>`;
  }

  if (paymentReady) {
    return `<section class="decision-panel" id="payment">
      <h2>Your confirmed total is ready</h2>
      <p class="muted">This is the verified final amount for ${escapeHtml(quote.optionLabel || job.customerSelectedOption?.optionLabel || "your selected option")}. It is not the earlier research estimate.</p>
      <div class="confirmed-total">${escapeHtml(displayCurrency(amount))}</div>
      <a class="pay-now" href="/quote/${encodeURIComponent(quote.token)}">Pay now — ${escapeHtml(displayCurrency(amount))}</a>
      <p class="privacy-line">The next page shows the confirmed cost breakdown and takes you to Arcovia's secure checkout, where you can choose PayFast. Arcovia confirms the paid order before placing the supplier order.</p>
    </section>`;
  }

  if (decision === "selected" || job.customerSelectedOption) {
    const message = job.status === "quote_expired"
      ? "The previous quote expired. Arcovia must re-confirm the live total before a new payment button can appear."
      : "Arcovia is confirming live stock, delivery, duties where relevant, and the complete amount. This page refreshes automatically; the Pay now button will appear only after the total is verified.";
    return `<section class="decision-panel">
      <h2>Final total being confirmed</h2>
      <p>${escapeHtml(message)}</p>
      <p class="muted">No payment is due yet. Do not use an estimated option price as the amount to pay.</p>
    </section>`;
  }

  if (!optionsReady) return "";

  return `<section class="decision-panel" id="next-step">
    <h2>Choose how to continue</h2>
    <p>Select one approved option above. Arcovia will then verify its complete live total before showing any payment button.</p>
    <p class="muted"><strong>None suitable?</strong> You may cancel this sourcing request here. Because approved options have already been found and made available, the R250 sourcing deposit is not refundable. Cancelling stops the final-payment and supplier-order process.</p>
    <form class="cancel-form" method="POST" action="/options/cancel" onsubmit="return confirm('Cancel this sourcing request? This cannot be undone from this private link.');">
      <input type="hidden" name="token" value="${escapeHtml(token)}" />
      <label for="cancel-reason">Why were the options not suitable? <span class="muted">(optional)</span></label>
      <textarea id="cancel-reason" name="reason" maxlength="500" placeholder="For example: prices too high, condition not suitable, or product details do not match."></textarea>
      <label class="muted"><input type="checkbox" name="confirm_cancel" value="yes" required /> I understand that this closes the request and that the R250 deposit is not refundable after approved options were found.</label>
      <button class="cancel-button" type="submit">Cancel this sourcing request</button>
    </form>
  </section>`;
}

function customerOptionsShouldRefresh(job, optionsReady) {
  if (!optionsReady) return true;
  if (job.customerOptionsDecision === "selected" || job.customerSelectedOption) {
    return ["customer_selected_option", "supplier_selected", "quote_verifying", "quote_ready"].includes(job.status)
      && !["quote_ready", "payment_pending"].includes(job.finalQuote?.status || "");
  }
  return false;
}

function customerOptionsInactivePage(title, message) {
  return `<!doctype html>
<html>
<head>
  <title>${escapeHtml(title)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex,nofollow" />
  <style>
    body { margin:0; padding:24px; font-family:Arial,sans-serif; background:#080406; color:#fff; }
    main { max-width:620px; margin:12vh auto 0; padding:24px; border:1px solid #6b1024; border-radius:22px; background:#16080d; box-shadow:0 18px 44px rgba(0,0,0,.3); }
    h1 { margin:0 0 12px; line-height:1.08; }
    p { color:#d8b8c0; line-height:1.6; }
    a { color:#fff; }
  </style>
</head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="${escapeHtml(config.publicBaseUrl.replace(/\/$/, ""))}">Return to Arcovia</a></p></main></body>
</html>`;
}

async function handleCustomerOptionImage(_req, res, pathname) {
  const parts = pathname.split("/").filter(Boolean);
  const token = decodeURIComponent(parts[1] || "");
  const optionIndex = Number(parts[2]);
  const imageIndex = Math.max(0, Number(parts[3] || 0));
  const job = getJobByCustomerOptionsToken(token);
  const source = job?.research?.suppliers?.[optionIndex] || null;
  const imageUrl = customerOptionImageUrls(job, optionIndex)[imageIndex] || "";

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

function ensureFinalQuote(job, { supplier, optionIndex = 0, optionLabel = "", sourceGroup = "suppliers", selectedBy = "arcovia" } = {}) {
  job.finalQuote ||= {};
  job.finalQuote.id ||= randomUUID();
  job.finalQuote.token ||= randomUUID();
  job.finalQuote.paymentId ||= `ARC-${safePaymentId(job.orderName || job.id)}-${String(job.finalQuote.id).slice(0, 8)}`;
  job.finalQuote.status ||= "verification_pending";
  job.finalQuote.optionIndex = optionIndex;
  job.finalQuote.optionLabel = optionLabel || customerOptionLabel(job, optionIndex);
  job.finalQuote.sourceGroup = sourceGroup;
  job.finalQuote.selectedBy = selectedBy;
  job.finalQuote.estimateFromResearch = displayRandTotal(supplier || {});
  job.finalQuote.estimatedAmountZar = parseRandAmount(job.finalQuote.estimateFromResearch);
  job.finalQuote.requiresManualVerification = true;
  job.finalQuote.updatedAt = new Date().toISOString();
  if (!job.finalQuote.createdAt) job.finalQuote.createdAt = job.finalQuote.updatedAt;
  return job.finalQuote;
}

function safePaymentId(value) {
  return String(value || "ORDER")
    .replace(/^#/, "")
    .replace(/[^a-z0-9_-]/gi, "")
    .slice(0, 32) || "ORDER";
}

function parseRandAmount(value) {
  const text = String(value || "").replace(/,/g, "");
  const match = text.match(/(?:R|ZAR)?\s*(\d+(?:\.\d{1,2})?)/i);
  if (!match) return null;
  const amount = Number(match[1]);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
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
  const optionLabel = sourceGroup === "suppliers"
    ? customerOptionLabel(job, supplierIndex)
    : `Internal ${sourceGroupLabel(sourceGroup)} option ${supplierIndex + 1}`;
  job.selectedSupplier = {
    index: supplierIndex,
    sourceGroup,
    selectedAt: new Date().toISOString(),
    supplier
  };
  ensureFinalQuote(job, {
    supplier,
    optionIndex: supplierIndex,
    optionLabel,
    sourceGroup,
    selectedBy: "arcovia"
  });
  job.status = "quote_verifying";
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
  addTimeline(job, "quote_verifying", "Selected source is waiting for live availability, shipping, and final total verification before a payment link is sent.");
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
  <title>Arcovia sourcing lite monitor</title>
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
    .human_review, .supplier_selected, .options_sent, .quote_ready, .balance_paid, .ready_to_order, .order_placed, .in_transit, .delivered { background:#165c35; }
    .refund_due, .research_failed, .payment_failed, .quote_expired, .supplier_unavailable, .no_online_purchase_available, .cancelled_by_customer { background:#7a1028; }
    .quote_verifying, .payment_pending, .customer_selected_option { background:#8a5b00; }
    .awaiting_brief { background:#4b5563; }
    .stats { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; margin:14px 0; }
    .stat { background:#0f0609; border:1px solid #3a101b; border-radius:14px; padding:12px; }
    .stat b { display:block; font-size:22px; }
    .stat span { color:#d8b8c0; font-size:12px; }
    .banner { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; margin-top:12px; }
    .setup-warning { border-color:#b47915; background:#211505; }
    .setup-warning h2, .setup-warning h3 { color:#ffd88a; }
    .setup-warning ol { margin:10px 0 0; padding-left:22px; color:#ead7dc; line-height:1.45; }
    .setup-warning code { background:#0f0609; border:1px solid #4b1724; border-radius:8px; padding:2px 5px; color:#ffd7df; }
    @media (min-width: 760px) { .stats { grid-template-columns:repeat(5,minmax(0,1fr)); } }
  </style>
</head>
<body>
  <header>
    <h1>Arcovia sourcing monitor</h1>
    <div class="muted">Safe phone view. No customer details or supplier links shown. Auto-refreshes every 30 seconds.</div>
    <div class="banner">
      <div class="stat"><b>${escapeHtml(activeCount)}</b><span>sourcing running</span></div>
      <div class="stat"><b>${escapeHtml(reviewCount)}</b><span>needs review</span></div>
      <div class="stat"><b>${escapeHtml(refundCount)}</b><span>refund due</span></div>
    </div>
  </header>
  <main class="grid">
    ${storageWarningHtml()}
    ${cards || emptyJobsCard()}
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
    adminReviewSentAt: job.adminReviewSentAt || null,
    customerOptionsSentAt: job.customerOptionsSentAt || null,
    customerOptionsTokenIssuedAt: job.customerOptionsTokenIssuedAt || null,
    customerOptionsTokenExpiresAt: job.customerOptionsTokenExpiresAt || null,
    customerOptionsDecision: job.customerOptionsDecision || null,
    customerOptionsDecisionAt: job.customerOptionsDecisionAt || null,
    completionNotifications: job.completionNotifications || null,
    completionNotificationRetryAt: job.completionNotificationRetryAt || null,
    briefLink: job.publicToken ? `${config.publicBaseUrl.replace(/\/$/, "")}/brief/${job.publicToken}` : null,
    orderId: job.orderId,
    orderName: job.orderName,
    customerEmail: job.customerEmail,
    customerName: job.customerName || "",
    deliveryAddress: job.deliveryAddress || "",
    status: job.status,
    refundStatus: job.refundStatus || null,
    refundReason: job.refundReason || null,
    selectedSupplier: job.selectedSupplier || null,
    customerSelectedOption: job.customerSelectedOption || null,
    finalQuote: job.finalQuote || null,
    supplierOrder: job.supplierOrder || null,
    emailLog: job.emailLog || [],
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

function isAuthorizedAdminRequest(req, url) {
  const key = url?.searchParams?.get("key") || "";
  const validAdminSecret = config.adminStatusSecret && req.headers["x-arcovia-admin-secret"] === config.adminStatusSecret;
  const validFlowSecret = config.flowSecret && req.headers["x-arcovia-flow-secret"] === config.flowSecret;
  return Boolean(validAdminSecret || validFlowSecret || isValidMonitorKey(key));
}

function getJobByReviewToken(token) {
  if (!token) return null;
  return readJobs().find((job) => job.reviewToken === token);
}

function getJobByCustomerOptionsToken(token) {
  if (!token) return null;
  return readJobs().find((job) => job.customerOptionsToken === token);
}

function getJobByQuoteToken(token) {
  if (!token) return null;
  return readJobs().find((job) => job.finalQuote?.token === token);
}

function getJobByPayfastPaymentId(paymentId) {
  if (!paymentId) return null;
  return readJobs().find((job) => job.finalQuote?.paymentId === paymentId);
}

function ensureCustomerOptionsToken(job) {
  if (!job) return "";
  const access = ensureCustomerOptionsAccess(job);
  if (access.changed) upsertJob(job);
  return job.customerOptionsToken;
}

function monitorLoginHtml() {
  return `<!doctype html>
<html>
<head>
  <title>Arcovia sourcing monitor login</title>
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
    <h1>Arcovia sourcing monitor</h1>
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
  const customerSelectedHtml = job.customerSelectedOption ? customerSelectedOptionBox(job.customerSelectedOption, job) : "";
  const quotePanelHtml = quoteActionPanel(job, auth, formAction, formAuthFields);
  const emailLogHtml = emailLogPanel(job.emailLog || []);
  const missingDetails = (job.missingCustomerDetails || []).slice(0, 5).map((detail) => `<li>${escapeHtml(detail)}</li>`).join("");
  const nextLine = job.nextResearchAt ? `<p class="muted">Next sourcing check: ${escapeHtml(formatEventTime(job.nextResearchAt))}</p>` : "";
  const completedLine = job.researchCompletedAt ? `<p class="muted">Research completed: ${escapeHtml(formatEventTime(job.researchCompletedAt))}</p>` : "";
  const missingBriefLine = !job.productRequestPresent && job.briefLink
    ? `<p><strong>No product details yet.</strong> The sourcing process cannot search this order until the item details are added.</p><p><a class="button" href="${escapeHtml(job.briefLink)}">Add product details</a></p>`
    : "";
  const runningLine = job.researchRunning
    ? `<p><strong>Sourcing research is running right now.</strong> Keep this page open; it refreshes automatically.</p>`
    : `<p class="muted">Sourcing research is not currently running for this order.</p>`;
  const sourceSections = [
    sourceSection({
      title: "Approved suppliers",
      subtitle: "Trusted or usable sources that passed the initial sourcing checks.",
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
      ${quotePanelHtml}
      ${emailLogHtml}
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

function quoteActionPanel(job, auth = {}, _sourceFormAction, _sourceFormAuthFields) {
  const selected = job.customerSelectedOption || job.selectedSupplier;
  const quote = job.finalQuote || null;
  const showPanel = Boolean(selected || quote || ["quote_verifying", "quote_ready", "payment_pending", "ready_to_order", "order_placed", "in_transit", "delivered", "payment_failed", "quote_expired"].includes(job.status));
  if (!showPanel) {
    return `<div class="quote-admin">
      <h3>Customer email actions</h3>
      <p class="muted">Use this if research is complete but the customer options email did not send.</p>
      ${quoteActionForm(job, auth, `<div class="quote-actions"><button name="action" value="resend_options" type="submit">Send / resend customer options</button></div>`)}
    </div>`;
  }

  const quoteToken = quote?.token || "";
  const quoteLink = quoteToken ? `${config.publicBaseUrl.replace(/\/$/, "")}/quote/${quoteToken}` : "";
  const blocked = !isFinalPaymentOperational() ? `<div class="warning-box"><strong>Payment link blocked.</strong><br>${escapeHtml(finalPaymentBlockedMessage())}</div>` : "";
  const amountValue = quote?.finalAmountZar || "";
  const paymentStatus = quote?.paymentStatus || quote?.status || "verification pending";
  const order = job.supplierOrder || {};

  return `<div class="quote-admin">
    <h3>Final quote and payment</h3>
    <p class="muted">Selected option: ${escapeHtml(quote?.optionLabel || selected?.optionLabel || "No option selected")} · Quote status: ${escapeHtml(paymentStatus)}${quoteLink ? ` · <a href="${escapeHtml(quoteLink)}" target="_blank" rel="noreferrer">Open quote page</a>` : ""}</p>
    ${blocked}
    ${quoteActionForm(job, auth, `
      <div class="quote-fields">
        <label>Confirmed final amount in rand
          <input name="final_amount_zar" inputmode="decimal" value="${escapeHtml(amountValue)}" placeholder="Example: 2499.00" />
          <span class="muted">Enter the live all-inclusive total only after availability and delivery are verified. The research estimate is not copied into this field.</span>
        </label>
        <label>Quote expiry hours
          <input name="expiry_hours" inputmode="numeric" value="24" />
        </label>
        <label>Item / supplier total
          <input name="item_cost" value="${escapeHtml(quote?.itemCost || quote?.estimateFromResearch || "")}" placeholder="Example: R1,900 item price" />
        </label>
        <label>Shipping
          <input name="shipping_cost" value="${escapeHtml(quote?.shippingCost || "")}" placeholder="Example: R350 delivery" />
        </label>
        <label>Duties / import handling
          <input name="duties_cost" value="${escapeHtml(quote?.dutiesCost || "")}" placeholder="Example: Included / R250 estimated" />
        </label>
        <label>Arcovia handling
          <input name="handling_fee" value="${escapeHtml(quote?.handlingFee || "")}" placeholder="Example: Included" />
        </label>
        <label class="wide">Customer-safe quote note
          <textarea name="customer_notes" rows="2" placeholder="Short customer-safe note, no supplier names or websites.">${escapeHtml(quote?.customerNotes || "")}</textarea>
        </label>
        <label class="wide">Internal notes
          <textarea name="internal_notes" rows="2" placeholder="Internal verification notes.">${escapeHtml(quote?.internalNotes || "")}</textarea>
        </label>
      </div>
      <div class="quote-actions">
        <button name="action" value="save_quote_draft" type="submit">Save quote draft</button>
        <button class="button success" name="action" value="send_quote" type="submit">Send final quote link</button>
        <button class="button secondary" name="action" value="resend_quote" type="submit">Resend quote link</button>
        <button class="button secondary" name="action" value="resend_options" type="submit">Resend customer options</button>
        <button class="button warning" name="action" value="no_online_purchase" type="submit">No safe online purchase / refund due</button>
      </div>
    `)}
    <h3>Supplier order update</h3>
    <p class="muted">Use this only after customer final payment is confirmed and you have placed the supplier order.</p>
    ${quoteActionForm(job, auth, `
      <div class="quote-fields">
        <label>Supplier order reference
          <input name="supplier_order_reference" value="${escapeHtml(order.orderReference || "")}" />
        </label>
        <label>Tracking number
          <input name="tracking_number" value="${escapeHtml(order.trackingNumber || "")}" />
        </label>
        <label>Tracking URL
          <input name="tracking_url" value="${escapeHtml(order.trackingUrl || "")}" />
        </label>
        <label>ETA
          <input name="eta" value="${escapeHtml(order.eta || "")}" placeholder="Example: 12-18 July" />
        </label>
        <label class="wide">Order notes
          <textarea name="order_notes" rows="2">${escapeHtml(order.notes || "")}</textarea>
        </label>
      </div>
      <div class="quote-actions">
        <button class="button success" name="action" value="mark_order_placed" type="submit">Mark supplier order placed</button>
        <button class="button secondary" name="action" value="mark_in_transit" type="submit">Mark in transit</button>
        <button class="button success" name="action" value="mark_delivered" type="submit">Mark delivered</button>
      </div>
    `)}
  </div>`;
}

function quoteActionForm(job, auth = {}, innerHtml = "") {
  const action = auth.reviewToken ? "/review/quote-action" : "/monitor/quote-action";
  const authFields = auth.reviewToken
    ? `<input type="hidden" name="review_token" value="${escapeHtml(auth.reviewToken)}" />`
    : `<input type="hidden" name="key" value="${escapeHtml(auth.key || "")}" />`;
  return `<form method="POST" action="${escapeHtml(action)}">
    ${authFields}
    <input type="hidden" name="job_id" value="${escapeHtml(job.id)}" />
    ${innerHtml}
  </form>`;
}

function emailLogPanel(emailLog = []) {
  const rows = (emailLog || []).slice(-8).reverse().map((entry) => `<tr>
    <td>${escapeHtml(formatEventTime(entry.at))}</td>
    <td>${escapeHtml(entry.audience || "")}<br><span class="muted">${escapeHtml(entry.to || "")}</span></td>
    <td>${escapeHtml(entry.templateName || "")}<br><span class="muted">${escapeHtml(entry.subject || "")}</span></td>
    <td class="${entry.ok ? "email-ok" : "email-fail"}">${escapeHtml(entry.ok ? "sent" : entry.relayed ? "relayed" : entry.blocked ? "blocked" : entry.skipped ? "skipped" : "failed")}</td>
    <td>${escapeHtml(entry.provider || "")}</td>
    <td>${escapeHtml(entry.reason || "")}</td>
  </tr>`).join("");
  return `<details class="email-log">
    <summary>Email log (${escapeHtml((emailLog || []).length)})</summary>
    ${rows ? `<table><thead><tr><th>Time</th><th>To</th><th>Template</th><th>Status</th><th>Provider</th><th>Reason</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="muted">No email attempts recorded yet.</p>`}
  </details>`;
}

function customerOptionCard(source, index, token, selected, job) {
  const optionLabel = customerOptionLabel(job, index);
  const selectedIndex = Number(selected?.index);
  const isChosen = selected && selectedIndex === index;
  const decision = String(job.customerOptionsDecision || "").toLowerCase();
  const isLocked = Boolean(selected || decision);
  const overBudget = source.over_budget ? "May be above your stated budget" : "Budget fit not confirmed";
  const imageCount = customerOptionImageUrls(job, index).length;
  const imageNote = hasSourceImage(source)
    ? `${imageCount || 1} option image${imageCount === 1 ? "" : "s"}`
    : imageCount
      ? `${imageCount} reference image${imageCount === 1 ? "" : "s"}`
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
        <div class="detail"><span>Images</span><b>${escapeHtml(imageNote)}</b></div>
      </div>
      <p class="muted">Provider/source identity, websites, and sourcing evidence are kept private by Arcovia. Final availability, delivery, and total cost still need confirmation.</p>
      ${isChosen
        ? `<span class="chosen-label">Chosen option</span>`
        : decision === "cancelled"
          ? `<span class="chosen-label">Request cancelled</span>`
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
  const imageUrls = customerOptionImageUrls(job, index);
  if (imageUrls.length) {
    const images = imageUrls.slice(0, 5).map((_imageUrl, imageIndex) => {
      return `<img class="option-image" src="/options-image/${escapeHtml(token)}/${escapeHtml(index)}/${escapeHtml(imageIndex)}" alt="${escapeHtml(`${customerOptionLabel(job, index)} image ${imageIndex + 1}`)}" loading="lazy" />`;
    }).join("");
    return `<div class="option-gallery ${imageUrls.length === 1 ? "single" : ""}">${images}</div>`;
  }
  return `<div class="image-fallback">Product image<br>not available</div>`;
}

function customerOptionLabel(job, index) {
  const categoryText = `${job?.productRequest || ""} ${job?.rawOrder?.note || ""}`.toLowerCase();
  if (categoryText.includes("category: services") || categoryText.includes("services near me")) return `Service provider ${index + 1}`;
  if (categoryText.includes("category: manufacturers") || categoryText.includes("manufacturers & factories")) return `Manufacturer ${index + 1}`;
  if (categoryText.includes("category: fabrics") || categoryText.includes("fabrics & textiles")) return `Fabric supplier ${index + 1}`;
  return `Supplier ${index + 1}`;
}

function customerOptionImageUrl(job, index) {
  return customerOptionImageUrls(job, index)[0] || "";
}

function customerOptionImageUrls(job, index) {
  const source = job?.research?.suppliers?.[index] || null;
  const direct = sourceImageUrls(source);
  if (direct.length) return direct.slice(0, 5);
  return [];
}

function hasSourceImage(source) {
  return sourceImageUrls(source).length > 0;
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
      <span>Shipping agents<span class="section-subtitle">Forwarders and shipping options found for international orders.</span></span>
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

function customerSelectedOptionBox(selectedOption, job = {}) {
  const source = selectedOption?.supplier || {};
  const optionLabel = selectedOption?.optionLabel || customerOptionLabel(job, Number(selectedOption?.index || 0));

  return `<div class="selected-box">
    <h3>Customer preferred option</h3>
    <p><strong>${escapeHtml(optionLabel)}</strong> was chosen by the customer${selectedOption?.selectedAt ? ` on ${escapeHtml(formatEventTime(selectedOption.selectedAt))}` : ""}.</p>
    <p class="muted">Internal mapping: ${escapeHtml(source.name || "Unnamed source")} · ${escapeHtml(displayRandTotal(source))} · Trust ${escapeHtml(displayTrustScore(source))} · Risk ${escapeHtml(source.risk_level || "unknown")}</p>
    ${source.url ? `<a class="button success" href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer">Open customer-chosen source</a>` : ""}
  </div>`;
}

function sourceImageHtml(source) {
  const imageUrls = sourceImageUrls(source);
  if (imageUrls.length) {
    const images = imageUrls.slice(0, 5).map((imageUrl, imageIndex) => {
      return `<img class="source-image" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(source.name || "Product image")} image ${escapeHtml(imageIndex + 1)}" loading="lazy" referrerpolicy="no-referrer" />`;
    }).join("");
    return `<div class="source-gallery ${imageUrls.length === 1 ? "single" : ""}">${images}</div>`;
  }
  return `<div class="image-fallback">No item<br>image yet</div>`;
}

function sourceImageUrl(source) {
  return sourceImageUrls(source)[0] || "";
}

function sourceImageUrls(source) {
  return uniqueImageUrls([
    source?.image_url,
    source?.product_image_url,
    source?.item_image_url,
    source?.image,
    source?.thumbnail_url,
    source?.reference_image_url,
    ...listFieldValues(source?.image_urls),
    ...listFieldValues(source?.product_image_urls),
    ...listFieldValues(source?.reference_image_urls)
  ]);
}

function uniqueImageUrls(values) {
  const seen = new Set();
  const output = [];
  for (const value of values || []) {
    const imageUrl = String(value || "").trim();
    if (!isSafeImageUrl(imageUrl)) continue;
    if (isLikelyNonProductImage(imageUrl) || isProbablyTinyImage(imageUrl)) continue;
    const key = imageUrl.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(imageUrl);
  }
  return output;
}

function isLikelyNonProductImage(value) {
  const text = String(value || "").toLowerCase();
  return /favicon|apple-touch-icon|sprite|icon[-_0-9]|logo(?!.*product)|placeholder|no[-_ ]?image|default[-_ ]?image|loading|spinner|avatar|profile|social|facebook|instagram|x-twitter|twitter|linkedin|youtube|payment|visa|mastercard|paypal|eft|trust[-_ ]?badge|secure[-_ ]?checkout|newsletter|header|footer|banner|hero|background|storefront|map|pin|marker/.test(text);
}

function isProbablyTinyImage(value) {
  const text = String(value || "").toLowerCase();
  const dimensions = [...text.matchAll(/(?:^|[^\d])(\d{1,4})[x_=-](\d{1,4})(?:[^\d]|$)/g)];
  return dimensions.some((match) => Number(match[1]) < 180 || Number(match[2]) < 180);
}

function listFieldValues(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    return value
      .split(/\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
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
  const nextLine = job.nextResearchAt ? `<p class="muted">Next sourcing check: ${escapeHtml(formatEventTime(job.nextResearchAt))}</p>` : "";
  const completedLine = job.researchCompletedAt ? `<p class="muted">Completed: ${escapeHtml(formatEventTime(job.researchCompletedAt))}</p>` : "";
  const reviewButton = job.reviewLink
    ? `<p><a class="button" href="${escapeHtml(job.reviewLink)}">Review suppliers</a></p>`
    : "";
  const missingBriefButton = !job.productRequestPresent && job.briefLink
    ? `<p><strong>No product details yet.</strong></p><p><a class="button" href="${escapeHtml(job.briefLink)}">Add product details</a></p>`
    : "";
  const runningLine = job.researchRunning
    ? `<p><strong>Sourcing research is running right now.</strong></p>`
    : `<p class="muted">Sourcing research is not currently running for this order.</p>`;

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

function extractDeliveryAddress(payload) {
  const addressObjects = [payload.delivery_address, payload.deliveryAddress, payload.shipping_address, payload.shippingAddress];
  for (const address of addressObjects) {
    if (!address) continue;
    if (typeof address === "string" && address.trim()) return address.trim();
    if (typeof address === "object") {
      const formatted = [
        address.address1,
        address.address2,
        address.city,
        address.province || address.province_code,
        address.zip || address.postal_code,
        address.country
      ].map((part) => String(part || "").trim()).filter(Boolean).join(", ");
      if (formatted) return formatted;
    }
  }

  const propertyNames = new Set(["delivery address", "service address", "shipping address"]);
  for (const item of normalizeLineItems(payload)) {
    const properties = [...(item.properties || []), ...(item.customAttributes || [])];
    for (const property of properties) {
      const name = String(property.name || property.key || "").trim().toLowerCase();
      const value = String(property.value || "").trim();
      if (propertyNames.has(name) && value) return value;
    }
  }
  return "";
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
  services: {
    label: "Services near me",
    productLabel: "Service needed",
    productPlaceholder: "Example: photographer, plumber, electrician, makeup artist, mechanic, tutor, cleaner...",
    conditionLabel: "When do you need the service?",
    conditionPlaceholder: "Choose the timing...",
    conditionOptions: ["Emergency / today", "Within 24-48 hours", "This week", "This month", "Flexible timing"],
    preferenceLabel: "Most important requirement",
    preferencePlaceholder: "Choose what matters most...",
    preferenceOptions: ["Best reviewed provider", "Lowest safe price", "Provider near my location", "Available soonest", "Specialist experience required"],
    budgetLabel: "Service budget",
    budgetPlaceholder: "Example: R1,500 total, R500 call-out fee, or quote needed",
    notesLabel: "Problem or service brief",
    notesPlaceholder: "Describe what happened, what you need done, access limits, preferred dates, photos/reference links, and anything the provider must know.",
    detailFields: [
      { name: "service_location", label: "Service location", placeholder: "Example: Sandton, Johannesburg; Cape Town CBD; exact suburb/address if comfortable...", required: true },
      { name: "service_problem", label: "Problem or event details", placeholder: "Example: leaking kitchen pipe, wedding photography for 80 guests, car won't start, wall needs painting...", required: true },
      { name: "service_property_access", label: "Property, access or appointment details", placeholder: "Example: apartment on 3rd floor, gate code needed, parking available, weekend only, business hours only..." },
      { name: "service_provider_requirements", label: "Provider requirements", placeholder: "Example: registered plumber, portfolio needed, own tools, insurance, female provider preferred, invoice needed..." }
    ]
  },
  manufacturers_factories: {
    label: "Manufacturers & factories",
    productLabel: "Product or component to manufacture",
    productPlaceholder: "Example: leather handbags, metal brackets, custom perfume bottles, uniforms, packaging boxes...",
    conditionLabel: "Production stage",
    conditionPlaceholder: "Choose the production stage...",
    conditionOptions: ["Idea / need manufacturer guidance", "Sample or prototype needed", "Small batch production", "Bulk production", "Existing product needs a new factory"],
    preferenceLabel: "Factory priority",
    preferencePlaceholder: "Choose what matters most...",
    preferenceOptions: ["Specialist factory only", "Lowest safe manufacturing cost", "Local South African factory preferred", "International manufacturer acceptable", "Can help with design/prototype"],
    budgetLabel: "Manufacturing budget",
    budgetPlaceholder: "Example: R20,000 first batch, R150 per unit target, quote needed",
    notesLabel: "Manufacturing brief",
    notesPlaceholder: "Explain the product, target quality, quantity, materials, packaging, deadlines, and any reference photos/spec sheets.",
    detailFields: [
      { name: "manufacturer_specialty", label: "Required manufacturing specialty", placeholder: "Example: leather goods, denim, cosmetics, metal fabrication, plastic injection moulding, packaging, furniture...", required: true },
      { name: "manufacturer_materials", label: "Materials and finish", placeholder: "Example: full-grain leather, brass hardware, cotton canvas, stainless steel, matte black powder coating...", required: true },
      { name: "manufacturer_quantity", label: "Quantity, MOQ and scaling plan", placeholder: "Example: 20 samples now, 500 units later; no high MOQ; monthly production needed...", required: true },
      { name: "manufacturer_specs", label: "Technical specs, samples or reference links", placeholder: "Example: dimensions, tech pack, CAD file, photos, competitor product link, packaging requirements..." },
      { name: "manufacturer_compliance", label: "Compliance, branding and confidentiality", placeholder: "Example: food-safe materials, SABS/ISO, private label, NDA needed, branded tags, export paperwork..." }
    ]
  },
  fabrics_textiles: {
    label: "Fabrics & textiles",
    productLabel: "Fabric or textile needed",
    productPlaceholder: "Example: black faux leather, 100% cotton fleece, silk satin, denim, upholstery velvet, Lycra...",
    conditionLabel: "Fabric requirement",
    conditionPlaceholder: "Choose the fabric requirement...",
    conditionOptions: ["Specific fabric only", "Closest alternative acceptable", "Bulk roll needed", "Small sample/metres needed", "Supplier must confirm composition"],
    preferenceLabel: "Sourcing priority",
    preferencePlaceholder: "Choose what matters most...",
    preferenceOptions: ["Exact colour/material match", "Local fabric shop preferred", "Wholesale supplier preferred", "Cheapest acceptable option", "Premium quality only"],
    budgetLabel: "Fabric budget",
    budgetPlaceholder: "Example: R120 per metre, R3,000 total, quote needed",
    notesLabel: "Fabric sourcing brief",
    notesPlaceholder: "Describe the fabric, colour, texture, stretch, weight, use case, quantity, reference photos, and what to avoid.",
    detailFields: [
      { name: "fabric_material_composition", label: "Material composition", placeholder: "Example: 100% cotton, wool blend, PU leather, genuine leather, polyester satin, spandex blend...", required: true },
      { name: "fabric_colour_texture", label: "Colour, texture and finish", placeholder: "Example: matte black, burgundy velvet, ribbed, waterproof, shiny satin, embossed crocodile texture...", required: true },
      { name: "fabric_quantity_width", label: "Quantity, width and weight", placeholder: "Example: 10 metres, 150cm wide, 280gsm, upholstery weight, sample swatches first...", required: true },
      { name: "fabric_use_case", label: "What it will be used for", placeholder: "Example: tracksuits, handbags, couches, curtains, uniforms, swimwear, car seats..." },
      { name: "fabric_location_delivery", label: "Preferred fabric-shop location or delivery area", placeholder: "Example: Johannesburg fabric shops, deliver to Durban, international supplier acceptable..." }
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
        <label id="productLabel" for="product">Item name</label>
        <input id="product" name="product" required disabled placeholder="Brand, model, item type, or exact product name..." value="${escapeHtml(singleLine(job.productRequest || ""))}" />

        <label id="conditionLabel" for="condition">Preferred condition</label>
        <select id="condition" name="condition" required disabled></select>

        <label id="preferenceLabel" for="preference">Preference</label>
        <select id="preference" name="preference" required disabled></select>

        <div id="customFields" class="details-grid"></div>

        <label id="budgetLabel" for="budget">Maximum budget</label>
        <input id="budget" name="budget" disabled placeholder="Example: R2,500 total" />

        <label id="notesLabel" for="notes">Anything else we must know</label>
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
    const productLabel = document.getElementById("productLabel");
    const product = document.getElementById("product");
    const conditionLabel = document.getElementById("conditionLabel");
    const condition = document.getElementById("condition");
    const preferenceLabel = document.getElementById("preferenceLabel");
    const preference = document.getElementById("preference");
    const customFields = document.getElementById("customFields");
    const budgetLabel = document.getElementById("budgetLabel");
    const budget = document.getElementById("budget");
    const notesLabel = document.getElementById("notesLabel");
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
        productLabel.textContent = "Item name";
        conditionLabel.textContent = "Preferred condition";
        preferenceLabel.textContent = "Preference";
        budgetLabel.textContent = "Maximum budget";
        notesLabel.textContent = "Anything else we must know";
        renderDetailFields([]);
        return;
      }

      categoryLabel.value = selected.label;
      categoryHint.textContent = "Good. The questions below now match " + selected.label + ".";
      productLabel.textContent = selected.productLabel || "Item name";
      product.placeholder = selected.productPlaceholder;
      conditionLabel.textContent = selected.conditionLabel || "Preferred condition";
      preferenceLabel.textContent = selected.preferenceLabel || "Preference";
      budgetLabel.textContent = selected.budgetLabel || "Maximum budget";
      notesLabel.textContent = selected.notesLabel || "Anything else we must know";
      budget.placeholder = selected.budgetPlaceholder || "Example: R2,500 total";
      notes.placeholder = selected.notesPlaceholder || "What to avoid, preferred suppliers, delivery area...";
      fillSelect(condition, selected.conditionOptions, selected.conditionPlaceholder || "Choose a matching condition...");
      fillSelect(preference, selected.preferenceOptions, selected.preferencePlaceholder || "Choose the most important preference...");
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
    fieldLine(selectedCategory?.productLabel || "Item name", form.get("product")),
    fieldLine(selectedCategory?.conditionLabel || "Condition", form.get("condition")),
    fieldLine(selectedCategory?.preferenceLabel || "Preference", form.get("preference")),
    ...detailLines,
    fieldLine(selectedCategory?.budgetLabel || "Maximum budget", form.get("budget")),
    fieldLine(selectedCategory?.notesLabel || "Notes", form.get("notes"))
  ].filter(Boolean).join("\n");
  job.status = "researching";
  job.researchAttemptCount = 0;
  job.maxResearchAttempts = researchPolicySummary().maxTotalAttempts;
  job.currentResearchAttempt = null;
  job.nextResearchAt = null;
  addTimeline(job, "brief_received", "Customer submitted product sourcing brief.");
  if (config.localCodexWorkerEnabled) {
    addTimeline(job, "local_worker_waiting", "Sourcing worker mode is enabled. Waiting for the always-on PC worker to claim this research job.");
  }
  upsertJob(job);

  if (!config.localCodexWorkerEnabled) queueResearch(job.id);
  html(res, 200, briefReceivedHtml(job));
}

async function handleStatusPage(_req, res, token) {
  const job = getJob(token);
  if (!job) return html(res, 404, "<h1>Status link not found</h1>");
  const timeline = (job.timeline || []).slice().reverse().map((event) => {
    return `<li><strong>${escapeHtml(formatEventTime(event.at))}</strong><br>${escapeHtml(customerTimelineMessage(event, job))}</li>`;
  }).join("");
  const researchSummary = job.researchCompletedAt
    ? `<section><h2>Research review</h2><p class="muted">Arcovia is reviewing the sourcing results before any final quote or next payment step is confirmed.</p></section>`
    : "";
  const progress = researchProgressHtml(job);
  const workflow = customerWorkflowHtml(job);

  html(res, 200, `<!doctype html>
<html>
<head>
  <title>Arcovia sourcing status</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root { color-scheme: dark; --bg:#070307; --panel:#170911; --panel2:#210d16; --line:#7b1930; --accent:#ffcf5f; --pink:#ffced8; --text:#fff8f0; --muted:#dfbdc5; }
    * { box-sizing:border-box; }
    body { font-family: Inter, Arial, sans-serif; background:radial-gradient(circle at 20% 0%, #5a1020 0, transparent 34%), linear-gradient(135deg, #090306 0%, #13070d 46%, #250b16 100%); color:var(--text); margin:0; padding:24px; }
    main { max-width:980px; margin:0 auto; }
    .shell { background:rgba(23,9,17,.9); border:1px solid rgba(255,255,255,.14); box-shadow:0 24px 80px rgba(0,0,0,.36); padding:clamp(20px,4vw,36px); border-radius:28px; }
    h1 { margin:0; font-size:clamp(32px,7vw,70px); line-height:.92; letter-spacing:-.06em; text-transform:uppercase; }
    h2 { margin:0 0 12px; text-transform:uppercase; letter-spacing:-.03em; }
    .eyebrow { color:var(--accent); font-weight:900; text-transform:uppercase; letter-spacing:.16em; font-size:12px; margin:0 0 12px; }
    .badge { display:inline-flex; margin:18px 0; padding:9px 13px; border-radius:999px; background:#8f1631; border:1px solid rgba(255,255,255,.18); font-weight:900; text-transform:uppercase; letter-spacing:.05em; font-size:12px; }
    .muted { color:var(--muted); line-height:1.6; }
    .meta { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:10px; margin:20px 0; }
    .meta div, section { background:rgba(255,255,255,.055); border:1px solid rgba(255,255,255,.12); border-radius:18px; padding:16px; }
    .workflow { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; margin:18px 0; }
    .step { position:relative; min-height:150px; background:linear-gradient(145deg, rgba(255,255,255,.095), rgba(255,255,255,.035)); border:1px solid rgba(255,255,255,.12); border-radius:22px; padding:18px; overflow:hidden; }
    .step::after { content:""; position:absolute; inset:auto -30px -40px auto; width:110px; height:110px; border-radius:999px; background:rgba(255,207,95,.1); }
    .step b { display:block; color:var(--accent); font-size:12px; text-transform:uppercase; letter-spacing:.14em; margin-bottom:10px; }
    .step h3 { margin:0 0 8px; font-size:18px; text-transform:uppercase; }
    .step.done { border-color:rgba(255,207,95,.42); }
    .step.active { background:linear-gradient(145deg, rgba(143,22,49,.9), rgba(52,13,25,.86)); border-color:var(--accent); box-shadow:0 18px 60px rgba(255,207,95,.08); }
    .step.upcoming { opacity:.72; }
    .policy-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; margin-top:14px; }
    .policy-grid div { background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.1); border-radius:18px; padding:14px; }
    ul { padding-left:22px; }
    li { margin:0 0 14px; line-height:1.5; }
    a { color:var(--pink); font-weight:800; }
  </style>
</head>
<body>
  <main class="shell">
    <p class="eyebrow">Private sourcing tracker</p>
    <h1>Arcovia sourcing status</h1>
    <div class="badge">${escapeHtml(statusLabel(job.status))}</div>
    <div class="meta">
      <div><strong>Order</strong><br><span class="muted">${escapeHtml(job.orderName)}</span></div>
      <div><strong>Created</strong><br><span class="muted">${escapeHtml(formatEventTime(job.createdAt))}</span></div>
      <div><strong>Policy window</strong><br><span class="muted">Up to 14 days to find or complete a valid online source.</span></div>
    </div>
    ${workflow}
    ${progress}
    ${job.status === "awaiting_brief" ? `<p><a href="${escapeHtml(briefLinkForStatus(job))}">Complete your product brief</a> so the sourcing process can start.</p>` : ""}
    ${researchSummary}
    <section>
      <h2>How payment and ordering works</h2>
      <div class="policy-grid">
        <div><strong>Deposit</strong><p class="muted">The R250 deposit starts the sourcing process. It is refundable if Arcovia cannot find or complete a valid online source.</p></div>
        <div><strong>Options</strong><p class="muted">Approved options are shown anonymously. Supplier names, websites, and internal checks stay private.</p></div>
        <div><strong>Final quote</strong><p class="muted">After you choose an option, Arcovia confirms live availability, delivery, and the final rand total before requesting the balance.</p></div>
        <div><strong>Ordering</strong><p class="muted">The supplier order is placed after final payment is confirmed and Arcovia completes the final owner check.</p></div>
      </div>
    </section>
    <h2>Timeline</h2>
    <ul>${timeline || "<li>No timeline entries yet.</li>"}</ul>
  </main>
</body>
</html>`);
}

async function sendDueUpdates() {
  await reconcileAllResearchCompletionNotifications();
  const now = new Date();
  const jobs = readJobs();
  for (const job of jobs) {
    if (!job.nextUpdateAt) continue;
    if (new Date(job.nextUpdateAt) > now) continue;
    if (["options_sent", "supplier_selected", "quote_verifying", "quote_ready", "payment_pending", "balance_paid", "ready_to_order", "order_placed", "in_transit", "delivered", "cancelled", "cancelled_by_customer", "refunded", "refund_due", "no_online_purchase_available"].includes(job.status)) continue;

    const sourcingWindowEndsAt = job.sourcingWindowEndsAt;
    if (sourcingWindowEndsAt && new Date(sourcingWindowEndsAt) <= now && !["human_review", "options_sent", "quote_ready", "payment_pending", "ready_to_order", "order_placed", "in_transit", "delivered"].includes(job.status)) {
      job.status = "refund_due";
      job.refundStatus = "manual_refund_required";
      job.refundReason = "The sourcing window ended without a verified trustworthy match.";
      job.nextUpdateAt = null;
      addTimeline(job, "refund_due", job.refundReason);
      upsertJob(job);
      await sendAdminEmailForJob(job, "admin_refund_due", adminRefundDue(job));
      await sendCustomerEmailForJob(job, "customer_refund_due", customerRefundDue(job));
      continue;
    }

    const updateResult = await sendCustomerEmailForJob(job, "stage_update", stageUpdate(job));
    if (updateResult.ok) {
      job.nextUpdateAt = addHours(now, config.updateIntervalHours).toISOString();
      addTimeline(job, "customer_update_sent", `Customer update sent for status ${job.status}.`);
    } else {
      job.nextUpdateAt = addHours(now, 0.25).toISOString();
      addTimeline(job, "customer_update_email_failed", "Customer update email failed and will retry in 15 minutes.", {
        reason: String(updateResult.reason || "email_send_failed").slice(0, 500)
      });
    }
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

function briefReceivedHtml(job) {
  return `<!doctype html>
<html>
<head>
  <title>Arcovia brief received</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root { color-scheme: dark; --bg:#070307; --panel:#180911; --line:#7b1930; --accent:#ffcf5f; --pink:#ffced8; --muted:#dfbdc5; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; font-family:Inter, Arial, sans-serif; color:#fff8f0; background:radial-gradient(circle at 18% 0%, #6f1428 0, transparent 32%), linear-gradient(135deg, #080306, #170811 52%, #2a0d18); padding:24px; display:grid; place-items:center; }
    main { width:min(960px,100%); background:rgba(24,9,17,.9); border:1px solid rgba(255,255,255,.14); border-radius:30px; padding:clamp(22px,5vw,42px); box-shadow:0 24px 80px rgba(0,0,0,.38); }
    h1 { margin:0; font-size:clamp(34px,8vw,78px); line-height:.9; letter-spacing:-.06em; text-transform:uppercase; }
    h2 { margin:0 0 10px; text-transform:uppercase; }
    p { color:var(--muted); line-height:1.6; }
    .eyebrow { color:var(--accent); font-size:12px; text-transform:uppercase; letter-spacing:.16em; font-weight:900; margin:0 0 12px; }
    .steps { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:12px; margin:22px 0; }
    .step { background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.12); border-radius:20px; padding:16px; min-height:132px; }
    .step b { color:var(--accent); font-size:12px; letter-spacing:.12em; }
    .actions { display:flex; flex-wrap:wrap; gap:12px; margin-top:20px; }
    a { color:#14070d; background:var(--accent); text-decoration:none; border-radius:999px; padding:12px 18px; font-weight:900; text-transform:uppercase; letter-spacing:.04em; }
    a.secondary { color:#fff8f0; background:transparent; border:1px solid rgba(255,255,255,.24); }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">Brief received</p>
    <h1>Your sourcing process has started.</h1>
    <p>Arcovia has received your request details. The sourcing team/system will now check realistic places to get the item, remove unsafe sources, and prepare approved options if valid sources are found.</p>
    <div class="steps">
      <div class="step"><b>01</b><h2>Search</h2><p>Online stores, marketplaces, physical-store leads, suppliers, distributors, and route options are checked.</p></div>
      <div class="step"><b>02</b><h2>Verify</h2><p>Sources are filtered using reviews, complaint signals, website/payment risk, delivery proof, and product-match quality.</p></div>
      <div class="step"><b>03</b><h2>Options</h2><p>If approved sources pass checks, you receive anonymous options with pictures and estimated prices.</p></div>
      <div class="step"><b>04</b><h2>Quote</h2><p>After you choose an option, Arcovia confirms the final amount before the balance payment is requested.</p></div>
    </div>
    <div class="actions">
      <a href="${escapeHtml(statusLinkForJob(job))}">Track status</a>
      <a class="secondary" href="${escapeHtml(config.publicBaseUrl.replace(/\/$/, ""))}">Back to Arcovia</a>
    </div>
  </main>
</body>
</html>`;
}

function statusLinkForJob(job) {
  return `${config.publicBaseUrl.replace(/\/$/, "")}/status/${job.publicToken}`;
}

function customerWorkflowHtml(job) {
  const currentIndex = customerWorkflowIndex(job.status);
  const refundState = ["refund_due", "no_online_purchase_available", "supplier_unavailable", "payment_failed", "quote_expired", "research_failed"].includes(job.status);
  const cancelledState = job.status === "cancelled_by_customer";
  const steps = [
    {
      title: "Request and deposit",
      text: "Customer pays the R250 deposit and completes the category-specific sourcing brief."
    },
    {
      title: "Deep sourcing checks",
      text: "Arcovia checks online stores, physical-store leads, suppliers, manufacturers, service providers, delivery routes, and trust signals."
    },
    {
      title: "Approved options",
      text: "Unsafe or weak sources are removed. Approved options are shown anonymously with images and estimated totals."
    },
    {
      title: "Final quote",
      text: "After the customer chooses an option, Arcovia confirms live availability, delivery, duties where relevant, and the final rand amount."
    },
    {
      title: "Balance payment",
      text: "The customer pays the final confirmed amount through the Arcovia quote link. Payment is confirmed by PayFast notification."
    },
    {
      title: "Order placement",
      text: "Arcovia performs the final owner check, places the supplier order, and records the reference."
    },
    {
      title: "Tracking and delivery",
      text: "Tracking, ETA, transit updates, and delivery confirmation are added to this private status page."
    }
  ];

  const cards = steps.map((step, index) => {
    const state = refundState && index > currentIndex ? "upcoming" : index < currentIndex ? "done" : index === currentIndex ? "active" : "upcoming";
    return `<div class="step ${state}">
      <b>${String(index + 1).padStart(2, "0")}</b>
      <h3>${escapeHtml(step.title)}</h3>
      <p class="muted">${escapeHtml(step.text)}</p>
    </div>`;
  }).join("");

  const refundNotice = refundState
    ? `<p class="muted"><strong>Current exception:</strong> this request needs Arcovia attention. If Arcovia cannot find or complete a valid online source, the R250 deposit is marked for refund processing.</p>`
    : cancelledState
      ? `<p class="muted"><strong>Request closed:</strong> you cancelled after approved options were made available. No final product payment is due; the R250 sourcing deposit is not refundable under the approved-source rule.</p>`
      : "";

  return `<section>
    <h2>Source-to-delivery workflow</h2>
    <p class="muted">This is the operating flow for your request from paid deposit to final delivery.</p>
    ${refundNotice}
    <div class="workflow">${cards}</div>
  </section>`;
}

function customerWorkflowIndex(status) {
  const map = {
    awaiting_brief: 0,
    deposit_paid: 0,
    researching: 1,
    vetting: 1,
    no_match: 1,
    research_failed: 1,
    human_review: 2,
    options_sent: 2,
    cancelled_by_customer: 2,
    customer_selected_option: 3,
    supplier_selected: 3,
    quote_verifying: 3,
    quote_ready: 4,
    payment_pending: 4,
    quote_expired: 4,
    payment_failed: 4,
    balance_paid: 5,
    ready_to_order: 5,
    order_placed: 6,
    in_transit: 6,
    delivered: 6,
    refund_due: 1,
    no_online_purchase_available: 1,
    supplier_unavailable: 3
  };
  return map[status] ?? 1;
}

function customerTimelineMessage(event, job = {}) {
  const maxAttempts = displayMaxResearchAttempts(job);
  const labels = {
    job_created: "Your sourcing request was received.",
    brief_captured: "Your product details were received.",
    brief_received: "Your product details were received.",
    awaiting_brief: "We are waiting for your product details before the sourcing process can start.",
    local_worker_waiting: "Your request is queued for sourcing research.",
    local_worker_claimed: "A sourcing research check started.",
    research_attempt_started: "A sourcing research check started.",
    local_worker_report_received: "A sourcing research check was completed.",
    research_attempt_completed: "A sourcing research check was completed.",
    local_worker_more_scheduled: `Another sourcing research check is scheduled. Arcovia completes ${maxAttempts} deep checks before sending final options or a no-supplier update.`,
    research_more_scheduled: `Another sourcing research check is scheduled. Arcovia completes ${maxAttempts} deep checks before sending final options or a no-supplier update.`,
    local_worker_retry_scheduled: "No trusted supplier has passed checks yet. Another sourcing check is scheduled.",
    research_retry_scheduled: "No trusted supplier has passed checks yet. Another sourcing check is scheduled.",
    research_schedule_shortened: "The next sourcing check was moved forward.",
    research_completed: "The sourcing checks are complete and the options are being reviewed.",
    customer_options_sent: "Your private options link was sent by email.",
    cancelled_by_customer: "You cancelled this sourcing request after reviewing the approved options. No final product payment is due.",
    customer_options_email_failed: "The options email could not be sent automatically. Arcovia is checking it.",
    customer_update_sent: "A sourcing update was sent by email.",
    customer_option_selected: "Your chosen option was received.",
    supplier_selected: "Arcovia selected an option for follow-up.",
    quote_verifying: "Arcovia is confirming availability, delivery, and the final total.",
    quote_draft_saved: "Arcovia saved the final quote draft.",
    quote_ready: "Your final quote is ready.",
    quote_email_sent: "Your final quote link was sent by email.",
    quote_email_failed: "The quote email could not be sent automatically. Arcovia is checking it.",
    quote_payment_blocked: "Arcovia is finalizing the payment setup before sending the payment link.",
    balance_paid: "Your final payment has been confirmed.",
    payfast_payment_not_complete: "Final payment has not been confirmed yet.",
    payfast_cancel_return: "Payment was not completed.",
    order_placed: "Your item order has been placed.",
    in_transit: "Your item order is in transit.",
    delivered: "Your item order has been marked as delivered.",
    no_online_purchase_available: "Arcovia could not confirm a safe online purchase route. Your refundable deposit is marked for refund processing.",
    quote_expired: "The quote expired and must be confirmed again before payment.",
    payment_failed: "The final payment was not confirmed.",
    refund_due: "No trusted supplier was found after the full sourcing checks. Your refundable deposit is marked for refund processing.",
    research_failed: "The sourcing process needs attention. Arcovia is checking it."
  };

  if (labels[event?.type]) return labels[event.type];

  return String(event?.message || "Sourcing update recorded.")
    .replace(/\bAI\b/gi, "sourcing")
    .replace(/Local Codex worker/gi, "Sourcing worker")
    .replace(/Local Codex/gi, "Sourcing worker")
    .replace(/https?:\/\/[^\s)>\]]+/gi, "[private link]");
}

function researchProgressHtml(job) {
  const policy = researchPolicySummary();
  const maxAttempts = Math.min(job.maxResearchAttempts || policy.maxTotalAttempts, policy.maxTotalAttempts);
  const attempt = Math.min(job.researchAttemptCount || 0, maxAttempts);
  const current = job.currentResearchAttempt ? `<br>Current check: ${escapeHtml(job.currentResearchAttempt)} of ${escapeHtml(maxAttempts)}` : "";
  const next = job.nextResearchAt ? `<br>Next deep check: ${escapeHtml(formatEventTime(job.nextResearchAt))}` : "";
  const suppliers = job.research?.suppliers?.length || 0;
  const candidates = job.research?.candidateSources?.length || 0;
  const rejected = job.research?.rejectedSources?.length || 0;

  return `<section>
    <h2>Research progress</h2>
    <p class="muted">Deep checks completed: ${escapeHtml(attempt)} of ${escapeHtml(maxAttempts)}${current}${next}<br>Policy: Arcovia runs exactly ${escapeHtml(policy.maxTotalAttempts)} deep research passes total before sending final customer options or the no-supplier/refund email.<br>Trusted suppliers waiting for review: ${escapeHtml(suppliers)}<br>Candidate sources checked: ${escapeHtml(candidates)}<br>Unsafe or untrusted sources removed: ${escapeHtml(rejected)}</p>
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
    options_sent: "Options sent",
    customer_selected_option: "Customer selected option",
    quote_verifying: "Confirming final quote",
    supplier_selected: "Supplier selected",
    quote_ready: "Quote ready",
    payment_pending: "Payment pending",
    balance_paid: "Final payment received",
    ready_to_order: "Ready to order",
    order_placed: "Order placed",
    in_transit: "In transit",
    delivered: "Delivered",
    no_match: "No match found yet",
    no_online_purchase_available: "No online purchase available",
    supplier_unavailable: "Supplier unavailable",
    quote_expired: "Quote expired",
    payment_failed: "Payment failed",
    refund_due: "Refund due",
    research_failed: "Research needs attention",
    cancelled_by_customer: "Cancelled by customer"
  };
  return labels[status] || String(status || "In progress").replaceAll("_", " ");
}

