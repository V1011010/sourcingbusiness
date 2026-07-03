import http from "node:http";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { sendEmail } from "./email.js";
import { isResearchRunning, queueDueResearchAttempts, queueResearch } from "./research.js";
import { fetchShopifyOrderDetails } from "./shopify.js";
import { adminRefundDue, customerRefundDue, depositReceived, stageUpdate } from "./templates.js";
import { addTimeline, getJob, readJobs, upsertJob } from "./storage.js";

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, {
        ok: true,
        service: "arcovia-ai-sourcing",
        jobs: readJobs().length,
        features: {
          shopifyOrderEnrichment: true,
          safeOrderResearchRetry: true,
          cappedOpenAIResearchTokens: true,
          deepResearchLoop: true,
          deepResearchMaxAttempts: config.deepResearchMaxAttempts,
          deepResearchSearchContextSize: config.openaiWebSearchContextSize,
          deepResearchReasoningEffort: config.openaiReasoningEffort,
          deepResearchMaxOutputTokens: config.openaiMaxOutputTokens,
          refundDueStatus: true,
          adminJobsEndpoint: Boolean(config.adminStatusSecret || config.flowSecret)
        }
      });
    }

    if (req.method === "GET" && url.pathname === "/admin/jobs") {
      return handleAdminJobs(req, res, url);
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
  queueDueResearchAttempts();
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
    source,
    orderId,
    orderName,
    customerEmail: enrichedPayload.email || enrichedPayload.customer_email || enrichedPayload.customer?.email || "",
    customerName: enrichedPayload.customer_name || enrichedPayload.customer?.displayName || enrichedPayload.customer?.first_name || "",
    productRequest,
    status: productRequest ? "researching" : "awaiting_brief",
    researchAttemptCount: 0,
    maxResearchAttempts: config.deepResearchMaxAttempts,
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
  } else {
    addTimeline(job, "awaiting_brief", "Paid order received, but no product brief was attached to the order.");
  }
  upsertJob(job);

  if (!options.skipDepositEmail) {
    await sendEmail({ to: job.customerEmail, ...depositReceived(job) });
  }

  if (productRequest) queueResearch(job.id);
  return job;
}

async function updateExistingJobFromOrder(existing, payload, productRequest, source, options = {}) {
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
    addTimeline(existing, "research_requeued", "AI supplier research was queued from the latest paid-order payload.");
    upsertJob(existing);
    queueResearch(existing.id);
    return existing;
  }

  if (options.forceResearch && existing.productRequest?.trim()) {
    existing.status = "researching";
    existing.currentResearchAttempt = null;
    existing.nextResearchAt = null;
    addTimeline(existing, "research_requeued", "AI supplier research was force-queued from the latest paid-order payload.");
    upsertJob(existing);
    queueResearch(existing.id);
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
  const jobs = readJobs().map((job) => {
    const base = {
      id: job.id,
      orderId: job.orderId,
      orderName: job.orderName,
      customerEmail: job.customerEmail,
      status: job.status,
      refundStatus: job.refundStatus || null,
      refundReason: job.refundReason || null,
      productRequestPresent: Boolean(job.productRequest?.trim()),
      supplierCount: job.research?.suppliers?.length || 0,
      candidateSourceCount: job.research?.candidateSources?.length || 0,
      rejectedSourceCount: job.research?.rejectedSources?.length || 0,
      shippingAgentCount: job.research?.shippingAgents?.length || 0,
      researchAttemptCount: job.researchAttemptCount || 0,
      maxResearchAttempts: job.maxResearchAttempts || config.deepResearchMaxAttempts,
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
      suppliers: job.research?.suppliers || [],
      candidateSources: job.research?.candidateSources || [],
      rejectedSources: job.research?.rejectedSources || [],
      shippingAgents: job.research?.shippingAgents || [],
      webSources: job.research?.webSources || [],
      rawResearchPreview: String(job.research?.rawText || "").slice(0, 4000)
    };
  });

  json(res, 200, { ok: true, jobs });
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
  job.maxResearchAttempts = config.deepResearchMaxAttempts;
  job.currentResearchAttempt = null;
  job.nextResearchAt = null;
  addTimeline(job, "brief_received", "Customer submitted product sourcing brief.");
  upsertJob(job);

  queueResearch(job.id);
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
    if (["quote_ready", "cancelled", "refunded", "refund_due"].includes(job.status)) continue;

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
  const maxAttempts = job.maxResearchAttempts || config.deepResearchMaxAttempts;
  const current = job.currentResearchAttempt ? `<br>Current check: ${escapeHtml(job.currentResearchAttempt)} of ${escapeHtml(maxAttempts)}` : "";
  const next = job.nextResearchAt ? `<br>Next deep check: ${escapeHtml(formatEventTime(job.nextResearchAt))}` : "";
  const suppliers = job.research?.suppliers?.length || 0;
  const candidates = job.research?.candidateSources?.length || 0;
  const rejected = job.research?.rejectedSources?.length || 0;

  return `<section>
    <h2>Research progress</h2>
    <p class="muted">Deep checks completed: ${escapeHtml(attempt)} of ${escapeHtml(maxAttempts)}${current}${next}<br>Trusted suppliers waiting for review: ${escapeHtml(suppliers)}<br>Candidate sources checked: ${escapeHtml(candidates)}<br>Unsafe or untrusted sources removed: ${escapeHtml(rejected)}</p>
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
    human_review: "Supplier research under review",
    quote_ready: "Quote ready",
    no_match: "No match found yet",
    refund_due: "Refund due",
    research_failed: "Research needs attention"
  };
  return labels[status] || String(status || "In progress").replaceAll("_", " ");
}
