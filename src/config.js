import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

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
  finalBalanceFlowSecret: process.env.ARCOVIA_FINAL_FLOW_SECRET || "",
  shopifyWebhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_CLIENT_SECRET || "",
  shopifyStoreDomain: process.env.SHOPIFY_STORE_DOMAIN || "",
  shopifyAdminAccessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "",
  shopifyClientId: process.env.SHOPIFY_CLIENT_ID || "",
  shopifyClientSecret: process.env.SHOPIFY_CLIENT_SECRET || "",
  shopifyAdminApiVersion: process.env.SHOPIFY_ADMIN_API_VERSION || "2026-04",
  shopifyFinalCheckoutEnabled: process.env.SHOPIFY_FINAL_CHECKOUT_ENABLED === undefined
    ? true
    : ["1", "true", "yes", "on"].includes(String(process.env.SHOPIFY_FINAL_CHECKOUT_ENABLED || "").toLowerCase()),
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiModel: process.env.OPENAI_MODEL || "gpt-5.5",
  openaiMaxOutputTokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || 12000),
  openaiReasoningEffort: process.env.OPENAI_REASONING_EFFORT || "low",
  openaiWebSearchContextSize: process.env.OPENAI_WEB_SEARCH_CONTEXT_SIZE || "high",
  resendApiKey: process.env.RESEND_API_KEY || "",
  emailProvider: (process.env.EMAIL_PROVIDER || "auto").toLowerCase(),
  fromEmail: process.env.FROM_EMAIL || "Arcovia <updates@arcovia.africa>",
  resendTestFromEmail: process.env.RESEND_TEST_FROM_EMAIL || "Arcovia <onboarding@resend.dev>",
  replyToEmail: process.env.REPLY_TO_EMAIL || process.env.REPLY_TO || "arcovia.africa@gmail.com",
  adminEmail: process.env.ADMIN_EMAIL || "vutlharingobeni5@gmail.com",
  emailAdminRelayOnFailure: process.env.EMAIL_ADMIN_RELAY_ON_FAILURE === undefined
    ? true
    : ["1", "true", "yes", "on"].includes(String(process.env.EMAIL_ADMIN_RELAY_ON_FAILURE || "").toLowerCase()),
  emailOutboxCountsAsSent: ["1", "true", "yes", "on"].includes(String(process.env.EMAIL_OUTBOX_COUNTS_AS_SENT || "").toLowerCase()),
  smtpHost: process.env.SMTP_HOST || "email-smtp.eu-west-1.amazonaws.com",
  smtpPort: Number(process.env.SMTP_PORT || 465),
  smtpSecure: process.env.SMTP_SECURE === undefined
    ? true
    : ["1", "true", "yes", "on"].includes(String(process.env.SMTP_SECURE || "").toLowerCase()),
  smtpUser: process.env.SMTP_USER || process.env.GMAIL_USER || "",
  smtpPassword: process.env.SMTP_PASSWORD || process.env.GMAIL_APP_PASSWORD || "",
  smtpFromEmail: process.env.SMTP_FROM_EMAIL || process.env.GMAIL_FROM_EMAIL || process.env.FROM_EMAIL || "Arcovia <updates@arcovia.africa>",
  googleOAuthClientPath: process.env.GOOGLE_OAUTH_CLIENT_PATH || resolve(homedir(), ".arcovia", "google-oauth-client.json"),
  googleOAuthTokenPath: process.env.GOOGLE_OAUTH_TOKEN_PATH || resolve(homedir(), ".arcovia", "google-oauth-token.json"),
  gmailUser: process.env.GMAIL_USER || "arcovia.africa@gmail.com",
  gmailFromEmail: process.env.GMAIL_FROM_EMAIL || "Arcovia <arcovia.africa@gmail.com>",
  awsSesRegion: process.env.AWS_SES_REGION || "eu-west-1",
  awsSesDomain: process.env.AWS_SES_DOMAIN || "arcovia.africa",
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  awsSessionToken: process.env.AWS_SESSION_TOKEN || "",
  adminStatusSecret: process.env.ARCOVIA_ADMIN_STATUS_SECRET || "",
  dataDir: process.env.ARCOVIA_DATA_DIR || process.env.DATA_DIR || "data",
  allowTemporaryPaymentStorage: ["1", "true", "yes", "on"].includes(String(process.env.ARCOVIA_ALLOW_TEMP_PAYMENT_STORAGE || "").toLowerCase()),
  payfastMerchantId: process.env.PAYFAST_MERCHANT_ID || "",
  payfastMerchantKey: process.env.PAYFAST_MERCHANT_KEY || "",
  payfastPassphrase: process.env.PAYFAST_PASSPHRASE || "",
  payfastSandbox: process.env.PAYFAST_SANDBOX === undefined
    ? true
    : ["1", "true", "yes", "on"].includes(String(process.env.PAYFAST_SANDBOX || "").toLowerCase()),
  payfastProcessUrl: process.env.PAYFAST_PROCESS_URL || "",
  payfastEmailConfirmation: ["1", "true", "yes", "on"].includes(String(process.env.PAYFAST_EMAIL_CONFIRMATION || "").toLowerCase()),
  payfastConfirmationEmail: process.env.PAYFAST_CONFIRMATION_EMAIL || process.env.ADMIN_EMAIL || "vutlharingobeni5@gmail.com",
  updateIntervalHours: Number(process.env.UPDATE_INTERVAL_HOURS || 6),
  maxSourcingDays: Number(process.env.MAX_SOURCING_DAYS || 14),
  deepResearchMaxAttempts: Number(process.env.DEEP_RESEARCH_MAX_ATTEMPTS || 3),
  deepResearchNoMatchRetries: Number(process.env.DEEP_RESEARCH_NO_MATCH_RETRIES || 2),
  deepResearchConfirmationChecksAfterFound: Number(process.env.DEEP_RESEARCH_CONFIRMATION_CHECKS_AFTER_FOUND || 2),
  researchRetryDelayMinutes: Number(process.env.RESEARCH_RETRY_DELAY_MINUTES || 5),
  researchTechnicalRetryDelayMinutes: Number(process.env.RESEARCH_TECHNICAL_RETRY_DELAY_MINUTES || 10),
  maxResearchCandidates: Number(process.env.DEEP_RESEARCH_MAX_CANDIDATES || 25),
  highTrustThreshold: Number(process.env.HIGH_TRUST_THRESHOLD || 75),
  mediumTrustThreshold: Number(process.env.MEDIUM_TRUST_THRESHOLD || 60),
  localCodexWorkerEnabled: process.env.LOCAL_CODEX_WORKER_ENABLED === undefined
    ? true
    : ["1", "true", "yes", "on"].includes(String(process.env.LOCAL_CODEX_WORKER_ENABLED || "").toLowerCase()),
  localCodexMultiAgentEnabled: process.env.LOCAL_CODEX_MULTI_AGENT_ENABLED === undefined
    ? true
    : ["1", "true", "yes", "on"].includes(String(process.env.LOCAL_CODEX_MULTI_AGENT_ENABLED || "").toLowerCase()),
  localCodexAgentConcurrency: Math.max(1, Math.min(5, Number(process.env.LOCAL_CODEX_AGENT_CONCURRENCY || 2))),
  localWorkerSecret: process.env.ARCOVIA_LOCAL_WORKER_SECRET || process.env.ARCOVIA_FLOW_SECRET || "",
  localWorkerLeaseMinutes: Number(process.env.LOCAL_CODEX_WORKER_LEASE_MINUTES || 20),
  depositSkus: (process.env.DEPOSIT_SKU || "ARC-DEPOSIT-250,ARC-SOURCE-250")
    .split(",")
    .map((sku) => sku.trim())
    .filter(Boolean)
};
