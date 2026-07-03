import { config } from "./config.js";

const ORDER_FIELDS = `
  id
  name
  email
  note
  customAttributes {
    key
    value
  }
  customer {
    displayName
    email
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
  return {
    order_id: order.id,
    order_name: order.name,
    email: order.email || order.customer?.email || "",
    customer_name: order.customer?.displayName || "",
    note: order.note || "",
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
  return (attributes || [])
    .map((attribute) => ({
      key: String(attribute.key || attribute.name || "").trim(),
      value: String(attribute.value || "").trim()
    }))
    .filter((attribute) => attribute.key || attribute.value);
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
    throw new Error(`Shopify Admin API order lookup failed: ${response.status} ${detail}`);
  }

  return body.data;
}

function normalizeShopifyDomain(domain) {
  return String(domain || "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
}
