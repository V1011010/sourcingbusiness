import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

loadDotEnv(resolve(".env"));

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value.replace(/^["']|["']$/g, "");
    }
  }
}

export const config = {
  port: Number(process.env.PORT || 8787),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 8787}`,
  flowSecret: process.env.ARCOVIA_FLOW_SECRET || "",
  shopifyWebhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET || "",
  shopifyStoreDomain: process.env.SHOPIFY_STORE_DOMAIN || "",
  shopifyAdminAccessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "",
  shopifyAdminApiVersion: process.env.SHOPIFY_ADMIN_API_VERSION || "2026-04",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiModel: process.env.OPENAI_MODEL || "gpt-5.5",
  openaiMaxOutputTokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || 1800),
  resendApiKey: process.env.RESEND_API_KEY || "",
  fromEmail: process.env.FROM_EMAIL || "Arcovia <updates@arcovia.africa>",
  adminEmail: process.env.ADMIN_EMAIL || "vutlharingobeni5@gmail.com",
  adminStatusSecret: process.env.ARCOVIA_ADMIN_STATUS_SECRET || "",
  updateIntervalHours: Number(process.env.UPDATE_INTERVAL_HOURS || 6),
  maxSourcingDays: Number(process.env.MAX_SOURCING_DAYS || 14),
  highTrustThreshold: Number(process.env.HIGH_TRUST_THRESHOLD || 75),
  mediumTrustThreshold: Number(process.env.MEDIUM_TRUST_THRESHOLD || 60),
  depositSkus: (process.env.DEPOSIT_SKU || "ARC-DEPOSIT-250,ARC-SOURCE-250")
    .split(",")
    .map((sku) => sku.trim())
    .filter(Boolean)
};
