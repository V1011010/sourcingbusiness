import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

const PAYFAST_FIELD_ORDER = [
  "merchant_id",
  "merchant_key",
  "return_url",
  "cancel_url",
  "notify_url",
  "name_first",
  "name_last",
  "email_address",
  "cell_number",
  "m_payment_id",
  "amount",
  "item_name",
  "item_description",
  "custom_int1",
  "custom_int2",
  "custom_int3",
  "custom_int4",
  "custom_int5",
  "custom_str1",
  "custom_str2",
  "custom_str3",
  "custom_str4",
  "custom_str5",
  "email_confirmation",
  "confirmation_address",
  "payment_method",
  "subscription_type",
  "billing_date",
  "recurring_amount",
  "frequency",
  "cycles"
];

export function payfastConfigured() {
  return Boolean(config.payfastMerchantId && config.payfastMerchantKey);
}

export function payfastProcessUrl() {
  if (config.payfastProcessUrl) return config.payfastProcessUrl;
  return config.payfastSandbox
    ? "https://sandbox.payfast.co.za/eng/process"
    : "https://www.payfast.co.za/eng/process";
}

export function buildPayfastCheckoutFields(job) {
  const quote = job.finalQuote || {};
  const customerName = splitCustomerName(job.customerName || "");
  const amount = formatPayfastAmount(quote.finalAmountZar);
  const publicBase = config.publicBaseUrl.replace(/\/$/, "");
  const token = quote.token || "";
  const fields = {
    merchant_id: config.payfastMerchantId,
    merchant_key: config.payfastMerchantKey,
    return_url: `${publicBase}/payfast/return?quote=${encodeURIComponent(token)}`,
    cancel_url: `${publicBase}/payfast/cancel?quote=${encodeURIComponent(token)}`,
    notify_url: `${publicBase}/payfast/notify`,
    name_first: customerName.first,
    name_last: customerName.last,
    email_address: job.customerEmail || "",
    cell_number: normalizePhone(job.customerPhone || job.rawOrder?.phone || ""),
    m_payment_id: quote.paymentId || "",
    amount,
    item_name: `Arcovia sourced item ${job.orderName || ""}`.trim().slice(0, 100),
    item_description: `Final payment for ${quote.optionLabel || "selected sourcing option"} on ${job.orderName || "Arcovia order"}`.slice(0, 255),
    custom_str1: job.id || "",
    custom_str2: token,
    custom_str3: quote.optionLabel || "",
    email_confirmation: config.payfastEmailConfirmation ? "1" : "",
    confirmation_address: config.payfastConfirmationEmail || ""
  };
  fields.signature = payfastSignature(fields);
  return fields;
}

export function payfastSignature(fields) {
  const source = payfastParamString(fields, config.payfastPassphrase, PAYFAST_FIELD_ORDER);
  return createHash("md5").update(source).digest("hex");
}

export function parsePayfastBody(rawBody) {
  const params = new URLSearchParams(rawBody || "");
  const fields = {};
  const entries = [];
  for (const [key, value] of params.entries()) {
    fields[key] = value;
    entries.push([key, value]);
  }
  return { fields, entries };
}

export function verifyPayfastSignature(rawBody) {
  const { fields, entries } = parsePayfastBody(rawBody);
  const provided = String(fields.signature || "").trim().toLowerCase();
  if (!provided) return { ok: false, fields, reason: "missing_signature" };

  const candidates = new Set([
    signatureFromOrderedFields(fields, PAYFAST_FIELD_ORDER),
    signatureFromEntries(entries),
    signatureFromOrderedFields(fields, Object.keys(fields).sort())
  ]);

  for (const candidate of candidates) {
    if (safeEqual(provided, candidate)) return { ok: true, fields };
  }

  return { ok: false, fields, reason: "invalid_signature" };
}

export function formatPayfastAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return "";
  return amount.toFixed(2);
}

export function amountsMatch(expected, actual) {
  const left = Number(expected);
  const right = Number(actual);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return Math.abs(left - right) < 0.01;
}

function signatureFromOrderedFields(fields, order) {
  const source = payfastParamString(fields, config.payfastPassphrase, order);
  return createHash("md5").update(source).digest("hex");
}

function signatureFromEntries(entries) {
  const filtered = (entries || []).filter(([key, value]) => key !== "signature" && hasValue(value));
  const source = [
    ...filtered.map(([key, value]) => `${key}=${encodePayfastValue(value)}`),
    config.payfastPassphrase ? `passphrase=${encodePayfastValue(config.payfastPassphrase)}` : ""
  ].filter(Boolean).join("&");
  return createHash("md5").update(source).digest("hex");
}

function payfastParamString(fields, passphrase, order) {
  const orderedKeys = uniqueKeys([
    ...(order || []),
    ...Object.keys(fields || {}).sort()
  ]);
  const pairs = [];
  for (const key of orderedKeys) {
    if (key === "signature") continue;
    const value = fields?.[key];
    if (!hasValue(value)) continue;
    pairs.push(`${key}=${encodePayfastValue(value)}`);
  }
  if (passphrase) pairs.push(`passphrase=${encodePayfastValue(passphrase)}`);
  return pairs.join("&");
}

function encodePayfastValue(value) {
  return encodeURIComponent(String(value || "").trim()).replace(/%20/g, "+");
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function splitCustomerName(value) {
  const parts = String(value || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: "Arcovia", last: "Customer" };
  if (parts.length === 1) return { first: parts[0], last: "Customer" };
  return {
    first: parts.slice(0, -1).join(" ").slice(0, 100),
    last: parts.at(-1).slice(0, 100)
  };
}

function normalizePhone(value) {
  return String(value || "").replace(/[^\d+]/g, "").slice(0, 20);
}

function uniqueKeys(values) {
  const seen = new Set();
  const output = [];
  for (const value of values || []) {
    const key = String(value || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(key);
  }
  return output;
}
