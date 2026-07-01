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

const CATEGORY_CONFIG = {
  clothing: {
    label: "Clothing & fashion",
    productPlaceholder: "Example: Nike tech fleece, black hoodie, women's blazer, winter jacket...",
    conditionOptions: ["New with tags", "New without tags", "Pre-owned excellent condition", "Any condition if clean and wearable"],
    preferenceOptions: ["Authentic branded only", "Unbranded alternative is fine", "Inspired/non-branded look is fine", "Local South African supplier preferred"],
    size: {
      label: "Clothing size",
      placeholder: "Example: M, UK 10, EU 38, waist 32, chest 102cm, relaxed/oversized fit..."
    },
    specsPlaceholder: "Colour, fabric, fit, gender, exact style, reference links, photos..."
  },
  shoes: {
    label: "Shoes & sneakers",
    productPlaceholder: "Example: Air Jordan 4 Bred Reimagined, Adidas Samba, formal leather shoes...",
    conditionOptions: ["Brand new", "New/open box", "Pre-owned excellent condition", "Any condition if authentic and wearable"],
    preferenceOptions: ["Authentic branded only", "Original box preferred", "Used authentic pair acceptable", "Inspired/non-branded style is fine"],
    size: {
      label: "Shoe size",
      placeholder: "Example: UK 8, US 9, EU 42, men's/women's/kids, wide fit if needed..."
    },
    specsPlaceholder: "Colourway, release year, gender sizing, box requirement, reference links..."
  },
  bags_accessories: {
    label: "Bags & accessories",
    productPlaceholder: "Example: laptop backpack, handbag, belt, sunglasses, wallet...",
    conditionOptions: ["Brand new", "New/open box", "Pre-owned excellent condition", "Any clean usable condition"],
    preferenceOptions: ["Authentic branded only", "Unbranded alternative is fine", "Inspired/non-branded look is fine", "Leather/material quality matters most"],
    specsPlaceholder: "Material, colour, dimensions, compartments, logo/no logo preference, reference links..."
  },
  watches_jewelry: {
    label: "Watches & jewellery",
    productPlaceholder: "Example: Casio watch, silver chain, engagement ring style, bracelet...",
    conditionOptions: ["Brand new", "Certified pre-owned", "Pre-owned excellent condition", "Any condition with proof of authenticity"],
    preferenceOptions: ["Authentic branded only", "Certificate/proof required", "Style match more important than brand", "Hypoallergenic/material-safe only"],
    size: {
      label: "Ring/watch/chain size",
      placeholder: "Example: ring size N, 18cm wrist, 20mm strap, 55cm chain..."
    },
    specsPlaceholder: "Metal, stone, strap size, water resistance, warranty/certificate requirement..."
  },
  phones_computers: {
    label: "Phones, computers & tablets",
    productPlaceholder: "Example: iPhone 14 Pro 256GB, gaming laptop, iPad, MacBook charger...",
    conditionOptions: ["New sealed", "New/open box", "Certified refurbished", "Used excellent condition", "Used acceptable if fully tested"],
    preferenceOptions: ["Original/genuine only", "Warranty required", "Unlocked/network-free required", "Charger/accessories included preferred"],
    specsPlaceholder: "Storage, RAM, processor, colour, network lock, battery health, warranty, region model..."
  },
  electronics: {
    label: "Electronics & gadgets",
    productPlaceholder: "Example: headphones, camera, drone, console, smart watch, speaker...",
    conditionOptions: ["New sealed", "New/open box", "Refurbished with warranty", "Used fully tested", "Any working condition"],
    preferenceOptions: ["Original brand only", "Warranty required", "Compatible replacement acceptable", "Best value over brand"],
    specsPlaceholder: "Model number, voltage, plug type, compatibility, accessories, warranty need..."
  },
  appliances: {
    label: "Home appliances",
    productPlaceholder: "Example: fridge, air fryer, washing machine, microwave, vacuum cleaner...",
    conditionOptions: ["Brand new", "Open box/display unit", "Refurbished with warranty", "Used fully working", "Any condition if repairable"],
    preferenceOptions: ["Warranty required", "Energy-efficient preferred", "Delivery/installation preferred", "Brand not important if reliable"],
    specsPlaceholder: "Capacity, dimensions, power rating, colour, delivery area, installation needs..."
  },
  furniture: {
    label: "Furniture & decor",
    productPlaceholder: "Example: office chair, couch, dining table, bed frame, wall art...",
    conditionOptions: ["Brand new", "Display unit", "Pre-owned excellent condition", "Any condition if structurally sound"],
    preferenceOptions: ["Exact style match", "Custom-made acceptable", "Local pickup acceptable", "Delivery required"],
    specsPlaceholder: "Dimensions, material, colour, room type, assembly/delivery needs, reference photos..."
  },
  vehicle_parts: {
    label: "Vehicle parts & accessories",
    productPlaceholder: "Example: Toyota Hilux headlight, BMW bumper, tyres, car radio...",
    conditionOptions: ["Brand new", "OEM used", "Aftermarket new", "Reconditioned", "Used tested"],
    preferenceOptions: ["OEM/genuine only", "Aftermarket compatible acceptable", "VIN/part-number match required", "Fitment proof required"],
    specsPlaceholder: "Vehicle make/model/year, VIN if safe to share, part number, side/position, engine variant..."
  },
  machinery: {
    label: "Machinery & industrial equipment",
    productPlaceholder: "Example: CNC machine, compressor, generator, packaging machine, pump...",
    conditionOptions: ["Brand new", "Certified used", "Refurbished with service records", "Used working condition", "For parts/repair only"],
    preferenceOptions: ["OEM/authorised supplier only", "Service records required", "Warranty or return policy required", "Aftermarket compatible parts acceptable", "No replica/counterfeit equipment"],
    specsPlaceholder: "Model, capacity, voltage/phase, certifications, manuals, spares, service history, delivery/rigging needs..."
  },
  tools: {
    label: "Tools & workshop equipment",
    productPlaceholder: "Example: Makita drill, welding machine, toolbox, compressor, torque wrench...",
    conditionOptions: ["Brand new", "Open box", "Refurbished", "Used tested", "Any working condition"],
    preferenceOptions: ["Original brand only", "Aftermarket compatible acceptable", "Warranty preferred", "Heavy-duty/professional grade only"],
    specsPlaceholder: "Voltage, battery platform, power rating, attachments, use case, safety requirements..."
  },
  beauty: {
    label: "Beauty, health & cosmetics",
    productPlaceholder: "Example: skincare product, hair tool, perfume, supplements...",
    conditionOptions: ["New sealed only", "New with intact packaging", "Unused open box if safe", "Not applicable"],
    preferenceOptions: ["Authorised retailer only", "Expiry date required", "Batch/serial proof preferred", "Cruelty-free/vegan preferred"],
    specsPlaceholder: "Shade, scent, formula, expiry requirement, allergies, skin/hair type, certification needs..."
  },
  sports_outdoor: {
    label: "Sports, gym & outdoor",
    productPlaceholder: "Example: treadmill, dumbbells, bicycle, tent, fishing gear...",
    conditionOptions: ["Brand new", "Open box", "Used excellent condition", "Used working condition", "Any safe usable condition"],
    preferenceOptions: ["Warranty preferred", "Commercial-grade preferred", "Local pickup acceptable", "Safety certification required"],
    size: {
      label: "Size/fit if relevant",
      placeholder: "Example: bicycle frame 54cm, helmet L, gloves M, tent 4-person..."
    },
    specsPlaceholder: "Weight limit, dimensions, sport type, safety rating, accessories, delivery needs..."
  },
  collectibles: {
    label: "Collectibles, art & rare items",
    productPlaceholder: "Example: limited figure, trading card, signed item, vintage decor...",
    conditionOptions: ["Mint/sealed", "Excellent condition", "Good condition", "Any condition if rare", "Graded/certified only"],
    preferenceOptions: ["Authenticity proof required", "Certificate of authenticity required", "Original packaging preferred", "Local seller preferred"],
    specsPlaceholder: "Edition, year, grading, serial number, packaging, proof, provenance, reference links..."
  },
  books_media: {
    label: "Books, media & documents",
    productPlaceholder: "Example: textbook, rare book, vinyl record, game disc, manual...",
    conditionOptions: ["New", "Like new", "Used good condition", "Any readable/working condition", "Digital copy acceptable"],
    preferenceOptions: ["Original physical copy", "Specific edition required", "ISBN/catalogue number required", "Local seller preferred"],
    specsPlaceholder: "ISBN, edition, author/artist, language, format, region compatibility, publication year..."
  },
  other: {
    label: "Other / not sure",
    productPlaceholder: "Describe the item as clearly as possible...",
    conditionOptions: ["Brand new", "Used excellent condition", "Refurbished", "Any working/usable condition", "Not sure"],
    preferenceOptions: ["Authentic/original only", "Best value option", "Local supplier preferred", "Fastest available option", "Need help deciding"],
    specsPlaceholder: "Important measurements, compatibility, colour, model, reference links, what to avoid..."
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
    .muted { color:#d8b8c0; }
    .panel { margin-top:18px; padding:16px; border:1px solid #6b1024; border-radius:14px; background:#220c13; }
    .hint { color:#d8b8c0; margin:8px 0 0; font-size:14px; line-height:1.4; }
    .hidden { display:none; }
  </style>
</head>
<body>
  <main>
    <h1>Arcovia product sourcing brief</h1>
    <p class="muted">Order ${escapeHtml(job.orderName)}. Select a category first so we only ask questions that match the item.</p>
    <form method="post">
      <label for="category">Product category</label>
      <select id="category" name="category" required>
        <option value="">Choose the closest category...</option>
        ${categoryOptionsHtml()}
      </select>
      <input type="hidden" id="category_label" name="category_label" />
      <p id="categoryHint" class="hint">After you choose a category, the condition, preference, size, and specification fields will update.</p>

      <section id="categoryFields" class="panel hidden" aria-live="polite">
        <label for="product">Exact product you want</label>
        <textarea id="product" name="product" required disabled placeholder="Brand, model, item type, reference links, photo links...">${escapeHtml(job.productRequest || "")}</textarea>

        <label for="condition">Preferred condition</label>
        <select id="condition" name="condition" required disabled></select>

        <label for="preference">Preference</label>
        <select id="preference" name="preference" required disabled></select>

        <div id="sizeWrap" class="hidden">
          <label id="sizeLabel" for="size">Size</label>
          <input id="size" name="size" disabled />
        </div>

        <label for="specs">Important specifications</label>
        <textarea id="specs" name="specs" disabled placeholder="Model, colour, compatibility, material, dimensions, region..."></textarea>

        <label for="budget">Maximum budget</label>
        <input id="budget" name="budget" disabled placeholder="Example: R2,500 total" />

        <label for="deadline">Deadline</label>
        <input id="deadline" name="deadline" disabled placeholder="Example: before Friday / within 2 weeks" />

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
    const sizeWrap = document.getElementById("sizeWrap");
    const sizeLabel = document.getElementById("sizeLabel");
    const size = document.getElementById("size");
    const specs = document.getElementById("specs");
    const budget = document.getElementById("budget");
    const deadline = document.getElementById("deadline");
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

    function setCategoryFields() {
      const selected = categories[category.value];
      const enabled = Boolean(selected);
      categoryFields.classList.toggle("hidden", !enabled);
      product.disabled = !enabled;
      condition.disabled = !enabled;
      preference.disabled = !enabled;
      specs.disabled = !enabled;
      budget.disabled = !enabled;
      deadline.disabled = !enabled;
      notes.disabled = !enabled;
      submitButton.disabled = !enabled;

      if (!enabled) {
        categoryLabel.value = "";
        categoryHint.textContent = "After you choose a category, the condition, preference, size, and specification fields will update.";
        sizeWrap.classList.add("hidden");
        size.disabled = true;
        size.required = false;
        return;
      }

      categoryLabel.value = selected.label;
      categoryHint.textContent = "Good. The questions below now match " + selected.label + ".";
      product.placeholder = selected.productPlaceholder;
      specs.placeholder = selected.specsPlaceholder;
      fillSelect(condition, selected.conditionOptions, "Choose a matching condition...");
      fillSelect(preference, selected.preferenceOptions, "Choose the most important preference...");

      if (selected.size) {
        sizeWrap.classList.remove("hidden");
        size.disabled = false;
        size.required = true;
        sizeLabel.textContent = selected.size.label;
        size.placeholder = selected.size.placeholder;
      } else {
        sizeWrap.classList.add("hidden");
        size.disabled = true;
        size.required = false;
        size.value = "";
      }
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
  job.productRequest = [
    `Category: ${form.get("category_label") || form.get("category") || ""}`,
    `Product: ${form.get("product") || ""}`,
    `Condition: ${form.get("condition") || ""}`,
    `Preference: ${form.get("preference") || ""}`,
    `Size: ${form.get("size") || ""}`,
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

function scriptJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}
