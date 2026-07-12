import { config } from "./config.js";

export const FINAL_BALANCE_SKU = "ARC-FINAL-BALANCE";

const ORDER_FIELDS = `
  id
  name
  email
  note
  displayFinancialStatus
  tags
  totalPriceSet {
    presentmentMoney {
      amount
      currencyCode
    }
    shopMoney {
      amount
      currencyCode
    }
  }
  customAttributes {
    key
    value
  }
  lineItems(first: 50) {
    nodes {
      title
      sku
      customAttributes {
        key
        value
      }
    }
  }
`;

const DRAFT_ORDER_RESULT_FIELDS = `
  id
  name
  invoiceUrl
  status
  totalPriceSet {
    presentmentMoney {
      amount
      currencyCode
    }
    shopMoney {
      amount
      currencyCode
    }
  }
`;

export function shopifyDraftCheckoutConfigured() {
  return Boolean(
    config.shopifyFinalCheckoutEnabled
    && config.shopifyStoreDomain
    && config.shopifyAdminAccessToken
  );
}

/**
 * Creates or refreshes an anonymous Shopify draft-order checkout for a final,
 * manually verified quote. Research estimates must never be passed here.
 */
export async function prepareShopifyFinalCheckout(job) {
  if (!shopifyDraftCheckoutConfigured()) {
    throw new Error("Shopify draft-order checkout is not configured.");
  }

  const quote = job?.finalQuote || {};
  const amount = normalizePositiveAmount(quote.finalAmountZar);
  if (!amount || !quote.verifiedAt) {
    throw new Error("A verified positive final quote is required before creating a Shopify checkout.");
  }
  if (!job?.id || !quote.id) {
    throw new Error("The Arcovia job and quote IDs are required before creating a Shopify checkout.");
  }

  const input = buildFinalBalanceDraftInput(job, quote, amount);
  let payload;

  if (quote.shopifyDraftOrderId) {
    const data = await shopifyGraphql(
      `mutation ArcoviaFinalBalanceDraftUpdate($id: ID!, $input: DraftOrderInput!) {
        draftOrderUpdate(id: $id, input: $input) {
          draftOrder {
            ${DRAFT_ORDER_RESULT_FIELDS}
          }
          userErrors {
            field
            message
          }
        }
      }`,
      { id: quote.shopifyDraftOrderId, input }
    );
    payload = data?.draftOrderUpdate;
  } else {
    const data = await shopifyGraphql(
      `mutation ArcoviaFinalBalanceDraftCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder {
            ${DRAFT_ORDER_RESULT_FIELDS}
          }
          userErrors {
            field
            message
          }
        }
      }`,
      { input }
    );
    payload = data?.draftOrderCreate;
  }

  assertNoShopifyUserErrors(payload, "Shopify draft-order checkout");
  const draftOrder = payload?.draftOrder;
  if (!draftOrder?.id || !draftOrder?.invoiceUrl) {
    throw new Error("Shopify did not return a secure draft-order checkout URL.");
  }

  const total = selectZarMoney(draftOrder.totalPriceSet);
  if (!total || !amountsMatch(amount, total.amount)) {
    throw new Error(
      `Shopify checkout total mismatch: expected ZAR ${amount.toFixed(2)}, received ${formatMoneyResult(total)}.`
    );
  }

  return {
    provider: "shopify",
    draftOrderId: draftOrder.id,
    draftOrderName: draftOrder.name || "",
    invoiceUrl: String(draftOrder.invoiceUrl),
    status: draftOrder.status || "OPEN",
    amountZar: Number(total.amount),
    currency: total.currencyCode,
    preparedAt: new Date().toISOString()
  };
}

export function buildFinalBalanceDraftInput(job, quote, amountValue = quote?.finalAmountZar) {
  const amount = normalizePositiveAmount(amountValue);
  if (!amount) throw new Error("Final checkout amount must be greater than zero.");

  const optionLabel = customerSafeOptionLabel(quote?.optionLabel);
  const quoteId = String(quote?.id || "").trim();
  const jobId = String(job?.id || "").trim();

  return {
    email: String(job?.customerEmail || "").trim() || undefined,
    presentmentCurrencyCode: "ZAR",
    taxExempt: true,
    acceptAutomaticDiscounts: false,
    allowDiscountCodesInCheckout: false,
    note: `Arcovia verified final balance for ${String(job?.orderName || "sourcing order").slice(0, 80)}`,
    tags: [
      "arcovia-final-balance",
      `arcovia-job-${jobId}`,
      `arcovia-quote-${quoteId}`
    ],
    customAttributes: [
      { key: "arcovia_payment_kind", value: "final_balance" },
      { key: "arcovia_job_id", value: jobId },
      { key: "arcovia_quote_id", value: quoteId }
    ],
    lineItems: [
      {
        title: `Arcovia sourced item — ${optionLabel}`,
        sku: FINAL_BALANCE_SKU,
        quantity: 1,
        originalUnitPriceWithCurrency: {
          amount,
          currencyCode: "ZAR"
        },
        requiresShipping: false,
        taxable: false,
        customAttributes: [
          { key: "arcovia_payment_kind", value: "final_balance" },
          { key: "arcovia_job_id", value: jobId },
          { key: "arcovia_quote_id", value: quoteId }
        ]
      }
    ]
  };
}

export function isShopifyFinalBalanceOrder(payload) {
  return extractShopifyFinalPaymentDetails(payload).recognized;
}

/**
 * Extracts the non-secret linkage needed to reconcile a Shopify ORDERS_PAID
 * event. A recognized event still needs server-side job, quote, amount and
 * currency checks before it can mark a balance as paid.
 */
export function extractShopifyFinalPaymentDetails(payload = {}) {
  const lineItems = normalizeOrderLineItems(payload);
  const finalLine = lineItems.find((item) => String(item?.sku || "").trim() === FINAL_BALANCE_SKU);
  const attributes = [
    ...normalizeAttributes(payload.customAttributes),
    ...normalizeAttributes(payload.note_attributes),
    ...normalizeAttributes(payload.noteAttributes),
    ...lineItems.flatMap((item) => [
      ...normalizeAttributes(item.customAttributes),
      ...normalizeAttributes(item.properties)
    ])
  ];
  const attributeMap = new Map(attributes.map(({ key, value }) => [key.toLowerCase(), value]));
  const paymentKind = String(attributeMap.get("arcovia_payment_kind") || "").toLowerCase();
  const recognized = Boolean(finalLine || paymentKind === "final_balance");
  const money = selectOrderMoney(payload);

  return {
    recognized,
    jobId: attributeMap.get("arcovia_job_id") || "",
    quoteId: attributeMap.get("arcovia_quote_id") || "",
    paymentKind,
    financialStatus: String(
      payload.displayFinancialStatus
      || payload.display_financial_status
      || payload.financial_status
      || ""
    ).trim().toUpperCase(),
    amount: money?.amount === undefined ? null : Number(money.amount),
    currency: String(money?.currencyCode || "").toUpperCase(),
    orderId: String(
      payload.order_id
      || payload.id
      || payload.admin_graphql_api_id
      || payload.order_admin_graphql_id
      || ""
    ),
    orderName: String(payload.order_name || payload.name || ""),
    sku: finalLine ? FINAL_BALANCE_SKU : ""
  };
}

export async function fetchShopifyOrderDetails(payload) {
  if (!config.shopifyStoreDomain || !config.shopifyAdminAccessToken) return null;

  const gid = getOrderGid(payload);
  if (gid) {
    const byId = await shopifyGraphql(
      `query ArcoviaOrderById($id: ID!) {
        order(id: $id) {
          ${ORDER_FIELDS}
        }
      }`,
      { id: gid }
    );
    if (byId?.order) return normalizeShopifyOrder(byId.order);
  }

  const name = payload.order_name || payload.name;
  if (!name) return null;

  const byName = await shopifyGraphql(
    `query ArcoviaOrderByName($query: String!) {
      orders(first: 1, query: $query) {
        nodes {
          ${ORDER_FIELDS}
        }
      }
    }`,
    { query: `name:${String(name).trim()}` }
  );

  const order = byName?.orders?.nodes?.[0];
  return order ? normalizeShopifyOrder(order) : null;
}

export function normalizeShopifyOrder(order) {
  const money = order.totalPriceSet?.presentmentMoney || order.totalPriceSet?.shopMoney || {};
  return {
    order_id: order.id,
    order_name: order.name,
    email: order.email || "",
    customer_name: "",
    note: order.note || "",
    displayFinancialStatus: order.displayFinancialStatus || "",
    financial_status: String(order.displayFinancialStatus || "").toLowerCase(),
    total_price: money.amount || "",
    currency: money.currencyCode || "",
    totalPriceSet: order.totalPriceSet || null,
    tags: Array.isArray(order.tags) ? order.tags : [],
    customAttributes: normalizeAttributes(order.customAttributes),
    line_items: (order.lineItems?.nodes || []).map((item) => ({
      title: item.title,
      sku: item.sku,
      properties: normalizeAttributes(item.customAttributes).map((attribute) => ({
        name: attribute.key,
        value: attribute.value
      })),
      customAttributes: normalizeAttributes(item.customAttributes)
    }))
  };
}

function getOrderGid(payload) {
  const candidates = [
    payload.admin_graphql_api_id,
    payload.order_admin_graphql_id,
    payload.order_graphql_id,
    payload.order_id,
    payload.id
  ];

  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (!value) continue;
    if (value.startsWith("gid://shopify/Order/")) return value;
    if (/^\d+$/.test(value)) return `gid://shopify/Order/${value}`;
  }

  return "";
}

function normalizeAttributes(attributes) {
  if (!Array.isArray(attributes)) return [];
  return attributes
    .map((attribute) => ({
      key: String(attribute?.key || attribute?.name || "").trim(),
      value: String(attribute?.value || "").trim()
    }))
    .filter((attribute) => attribute.key || attribute.value);
}

function normalizeOrderLineItems(payload) {
  const candidates = [payload?.line_items, payload?.lineItems, payload?.order?.line_items, payload?.order?.lineItems];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
    if (Array.isArray(candidate?.nodes)) return candidate.nodes;
    if (Array.isArray(candidate?.edges)) return candidate.edges.map((edge) => edge?.node).filter(Boolean);
  }
  return [];
}

function selectOrderMoney(payload) {
  const priceSets = [
    payload?.currentTotalPriceSet,
    payload?.current_total_price_set,
    payload?.totalPriceSet,
    payload?.total_price_set
  ];
  for (const priceSet of priceSets) {
    const selected = selectZarMoney(priceSet) || selectFirstMoney(priceSet);
    if (selected) return selected;
  }

  const amount = payload?.current_total_price ?? payload?.total_price ?? payload?.totalPrice;
  const currencyCode = payload?.presentment_currency || payload?.currency || payload?.currencyCode;
  if (amount !== undefined && currencyCode) return { amount, currencyCode };
  return null;
}

function selectZarMoney(priceSet) {
  const values = [
    priceSet?.presentmentMoney,
    priceSet?.presentment_money,
    priceSet?.shopMoney,
    priceSet?.shop_money
  ].filter(Boolean);
  return values.find((money) => String(money.currencyCode || money.currency_code || "").toUpperCase() === "ZAR")
    ? normalizeMoney(values.find((money) => String(money.currencyCode || money.currency_code || "").toUpperCase() === "ZAR"))
    : null;
}

function selectFirstMoney(priceSet) {
  const money = priceSet?.presentmentMoney
    || priceSet?.presentment_money
    || priceSet?.shopMoney
    || priceSet?.shop_money;
  return money ? normalizeMoney(money) : null;
}

function normalizeMoney(money) {
  return {
    amount: money?.amount,
    currencyCode: String(money?.currencyCode || money?.currency_code || "").toUpperCase()
  };
}

function normalizePositiveAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Number(amount.toFixed(2));
}

function amountsMatch(left, right) {
  return Math.abs(Number(left) - Number(right)) < 0.01;
}

function customerSafeOptionLabel(value) {
  const match = String(value || "").match(/(?:supplier|option)\s*(\d+)/i);
  return match ? `Supplier ${match[1]}` : "Selected option";
}

function assertNoShopifyUserErrors(payload, context) {
  const errors = Array.isArray(payload?.userErrors) ? payload.userErrors : [];
  if (!errors.length) return;
  const message = errors.map((error) => error?.message).filter(Boolean).join("; ");
  throw new Error(`${context} failed: ${message || "unknown Shopify validation error"}`);
}

function formatMoneyResult(money) {
  if (!money) return "no total";
  return `${money.currencyCode || "unknown currency"} ${money.amount ?? "missing amount"}`;
}

async function shopifyGraphql(query, variables) {
  const domain = normalizeShopifyDomain(config.shopifyStoreDomain);
  const response = await fetch(`https://${domain}/admin/api/${config.shopifyAdminApiVersion}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": config.shopifyAdminAccessToken
    },
    body: JSON.stringify({ query, variables })
  });

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Shopify Admin API returned non-JSON response: ${response.status}`);
  }

  if (!response.ok || body.errors?.length) {
    const detail = body.errors?.map((error) => error.message).join("; ") || text;
    throw new Error(`Shopify Admin API request failed: ${response.status} ${detail}`);
  }

  return body.data;
}

function normalizeShopifyDomain(domain) {
  return String(domain || "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
}
