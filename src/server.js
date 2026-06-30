import http from "node:http";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { parse as parseUrl } from "node:url";
import { config } from "./config.js";
import { sendEmail } from "./email.js";
import { queueResearch } from "./research.js";
import { depositReceived, stageUpdate } from "./templates.js";
import { addTimeline, getJob, readJobs, upsertJob } from "./storage.js";

const server = http.createServer(async (req, res) => {
  try {
    const url = parseUrl(req.url, true);

    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, {
        ok: true,
        service: "arcovia-ai-sourcing",
        jobs: readJobs().length
      });
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
}, 60_000);

async function handleFlowOrderPaid(req, res) {
  if (config.flowSecret) {
    const provided = req.headers["x-arcovia-flow-secret"];
    if (provided !== config.flowSecret) return json(res, 401, { error: "invalid_flow_secret" });
  }

  const rawBody = await readBody(req);
  const payload = JSON.parse(rawBody || "{}");
  const job = await createJobFromOrderPayload(payload, "shopify_flow");
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

async function createJobFromOrderPayload(payload, source) {
  if (!isDepositOrder(payload)) {
    return {
      id: null,
      status: "ignored_non_deposit_order",
      ignored: true
    };
  }

  const orderName = payload.order_name || payload.name || `Order ${payload.order_id || payload.id || "unknown"}`;
  const orderId = String(payload.order_id || payload.id || payload.admin_graphql_api_id || orderName);
  const existing = readJobs().find((job) => job.orderId === orderId);
  if (existing) return existing;

  const productRequest = extractProductRequest(payload);
  const now = new Date();
  const job = {
    id: randomUUID(),
    publicToken: randomUUID(),
    source,
    orderId,
    orderName,
    customerEmail: payload.email || payload.customer_email || payload.customer?.email || "",
    customerName: payload.customer_name || payload.customer?.displayName || payload.customer?.first_name || "",
    productRequest,
    status: productRequest ? "researching" : "awaiting_brief",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    nextUpdateAt: addHours(now, config.updateIntervalHours).toISOString(),
    deadlineAt: addDays(now, config.maxSourcingDays).toISOString(),
    rawOrder: payload,
    timeline: []
  };

  addTimeline(job, "job_created", `Sourcing job created from ${source}.`);
  upsertJob(job);

  await sendEmail({ to: job.customerEmail, ...depositReceived(job) });

  if (productRequest) queueResearch(job.id);
  return job;
}

function isDepositOrder(payload) {
  const lineItems = payload.line_items || payload.lineItems || [];
  if (!Array.isArray(lineItems) || lineItems.length === 0) return true;
  return lineItems.some((item) => String(item.sku || item.SKU || "").trim() === config.depositSku);
}

function extractProductRequest(payload) {
  const candidates = [
    payload.product_request,
    payload.sourcing_brief,
    payload.note,
    payload.customer_note,
    ...(payload.note_attributes || []).map((item) => `${item.name}: ${item.value}`),
    ...(payload.line_items || []).flatMap((item) => [
      item.product_request,
      item.note,
      ...(item.properties || []).map((prop) => `${prop.name}: ${prop.value}`)
    ])
  ];

  return candidates
    .filter(Boolean)
    .map((value) => String(value).trim())
    .filter((value) => value && value.toLowerCase() !== "null" && value.toLowerCase() !== "undefined")
    .join("\n")
    .trim();
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
    input, textarea { width:100%; box-sizing:border-box; border-radius:10px; border:1px solid #6b1024; padding:12px; font-size:16px; }
    textarea { min-height:130px; }
    button { margin-top:20px; background:#7a1028; color:white; border:0; border-radius:999px; padding:14px 22px; font-weight:700; cursor:pointer; }
    .muted { color:#d8b8c0; }
  </style>
</head>
<body>
  <main>
    <h1>Arcovia product sourcing brief</h1>
    <p class="muted">Order ${escapeHtml(job.orderName)}. Give us enough detail to start supplier research.</p>
    <form method="post">
      <label>Exact product you want</label>
      <textarea name="product" required placeholder="Brand, model, item type, reference links, photos links...">${escapeHtml(job.productRequest || "")}</textarea>
      <label>Preferred condition</label>
      <input name="condition" placeholder="New, used, refurbished, any" />
      <label>Size/specifications</label>
      <textarea name="specs" placeholder="Size, colour, storage, material, region, compatibility..."></textarea>
      <label>Maximum budget</label>
      <input name="budget" placeholder="Example: R2,500 total" />
      <label>Deadline</label>
      <input name="deadline" placeholder="Example: before Friday / within 2 weeks" />
      <label>Anything else we must know</label>
      <textarea name="notes" placeholder="What to avoid, preferred suppliers, delivery area..."></textarea>
      <button type="submit">Submit sourcing brief</button>
    </form>
  </main>
</body>
</html>`);
}

async function handleBriefSubmit(req, res, token) {
  const job = getJob(token);
  if (!job) return html(res, 404, "<h1>Brief link not found</h1>");

  const body = await readBody(req);
  const form = new URLSearchParams(body);
  job.productRequest = [
    `Product: ${form.get("product") || ""}`,
    `Condition: ${form.get("condition") || ""}`,
    `Specifications: ${form.get("specs") || ""}`,
    `Budget: ${form.get("budget") || ""}`,
    `Deadline: ${form.get("deadline") || ""}`,
    `Notes: ${form.get("notes") || ""}`
  ].join("\n");
  job.status = "researching";
  addTimeline(job, "brief_received", "Customer submitted product sourcing brief.");
  upsertJob(job);

  queueResearch(job.id);
  html(res, 200, "<h1>Brief received</h1><p>Arcovia has started the supplier search. You will receive updates by email.</p>");
}

async function sendDueUpdates() {
  const now = new Date();
  const jobs = readJobs();
  for (const job of jobs) {
    if (!job.nextUpdateAt) continue;
    if (new Date(job.nextUpdateAt) > now) continue;
    if (["quote_ready", "cancelled", "refunded"].includes(job.status)) continue;

    if (new Date(job.deadlineAt) <= now && !["human_review", "quote_ready"].includes(job.status)) {
      job.status = "no_match";
      addTimeline(job, "deadline_reached", "Sourcing deadline reached without a verified match.");
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

function addHours(date, hours) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
