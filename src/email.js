import net from "node:net";
import tls from "node:tls";
import { appendOutbox } from "./storage.js";
import { config } from "./config.js";

export function emailDiagnostics() {
  const providerPlan = emailProviderPlan();
  const activeFrom = activeFromEmail();
  const senderAddress = emailAddressOnly(activeFrom);
  const senderDomain = senderAddress.includes("@") ? senderAddress.split("@").pop().toLowerCase() : "";
  return {
    provider: config.emailProvider || "auto",
    ready: providerPlan.length > 0,
    activeProviderPlan: providerPlan,
    activeFromEmail: activeFrom,
    senderDomain,
    replyToConfigured: Boolean(config.replyToEmail),
    adminEmailConfigured: Boolean(config.adminEmail),
    resendConfigured: Boolean(config.resendApiKey),
    smtpConfigured: smtpConfigured(),
    smtpHost: config.smtpHost || null,
    smtpPort: config.smtpPort || null,
    smtpSecure: config.smtpSecure,
    smtpFromEmail: config.smtpFromEmail || null,
    awsSesRegion: config.awsSesRegion,
    awsSesDomain: config.awsSesDomain,
    adminRelayOnFailure: config.emailAdminRelayOnFailure,
    outboxCountsAsSent: config.emailOutboxCountsAsSent,
    issues: emailConfigurationIssues({ providerPlan, senderDomain })
  };
}

export async function sendEmail({ to, subject, text }) {
  if (!to) {
    appendOutbox({ to: "missing-recipient", subject, text, skipped: true });
    return { ok: false, dryRun: true, provider: "none", reason: "missing recipient" };
  }

  const providers = emailProviderPlan();
  if (!providers.length) {
    appendOutbox({ to, from: activeFromEmail(), replyTo: config.replyToEmail, subject, text, dryRun: true, failed: true, detail: "no_email_provider_configured" });
    return {
      ok: config.emailOutboxCountsAsSent,
      dryRun: true,
      provider: "outbox",
      reason: config.emailOutboxCountsAsSent ? "" : "no_email_provider_configured"
    };
  }

  const failures = [];
  for (const provider of providers) {
    const result = await sendWithProvider(provider, { to, subject, text });
    if (result.ok) return result;
    failures.push(result);
  }

  const relayResult = await maybeRelayToAdmin({ to, subject, text, failures });
  if (relayResult) return relayResult;

  const reason = failures.map((failure) => failure.reason).filter(Boolean).join(" | ") || "email_send_failed";
  appendOutbox({ to, from: activeFromEmail(), replyTo: config.replyToEmail, subject, text, failed: true, detail: reason });
  return { ok: false, dryRun: false, reason };
}

async function sendWithProvider(provider, message) {
  if (provider === "smtp") return sendViaSmtp(message);
  if (provider === "resend") return sendViaResend({ ...message, from: config.fromEmail, provider: "resend" });
  return { ok: false, reason: `unknown_email_provider:${provider}` };
}

async function sendViaResend({ from, to, subject, text, provider = "resend" }) {
  const response = await sendResendEmail({
    from,
    to,
    subject,
    text
  });

  if (!response.ok) {
    const detail = await response.text();
    return { ok: false, dryRun: false, provider, reason: detail, domainRestricted: isResendDomainRestriction(detail) };
  }

  const detail = await response.text();
  const parsed = parseJson(detail);
  return { ok: true, dryRun: false, provider, id: parsed?.id || null };
}

export async function sendCustomerEmail({ to, subject, text }) {
  const unsafeReason = getUnsafeCustomerEmailReason({ subject, text });
  if (unsafeReason) {
    appendOutbox({
      to,
      from: config.fromEmail,
      replyTo: config.replyToEmail,
      subject,
      blocked: true,
      reason: unsafeReason
    });
    return { ok: false, dryRun: false, blocked: true, reason: unsafeReason };
  }

  return sendEmail({ to, subject, text });
}

export async function sendSensitiveAdminEmailForJob(job, template) {
  if (sameEmail(config.adminEmail, job?.customerEmail)) {
    appendOutbox({
      to: config.adminEmail,
      from: config.fromEmail,
      replyTo: config.replyToEmail,
      subject: template?.subject || "Arcovia internal supplier report",
      skipped: true,
      reason: "admin_email_matches_customer_email_sensitive_report"
    });
    return { ok: true, skipped: true, reason: "admin_email_matches_customer_email_sensitive_report" };
  }

  return sendEmail({ to: config.adminEmail, ...template });
}

function sendResendEmail({ from, to, subject, text }) {
  return fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      text,
      ...(config.replyToEmail ? { reply_to: config.replyToEmail } : {})
    })
  });
}

function emailProviderPlan() {
  const provider = config.emailProvider || "auto";
  if (provider === "outbox" || provider === "none") return [];
  if (provider === "smtp") return smtpConfigured() ? ["smtp"] : [];
  if (provider === "resend") return config.resendApiKey ? ["resend"] : [];

  const providers = [];
  if (smtpConfigured()) providers.push("smtp");
  if (config.resendApiKey) providers.push("resend");
  return providers;
}

function smtpConfigured() {
  return Boolean(config.smtpHost && config.smtpUser && config.smtpPassword);
}

function emailConfigurationIssues({ providerPlan, senderDomain }) {
  const issues = [];
  const provider = config.emailProvider || "auto";
  if (!providerPlan.length) {
    issues.push("no_active_email_provider");
  }
  if (provider === "smtp" || provider === "auto") {
    if (!config.smtpHost) issues.push("missing_smtp_host");
    if (!config.smtpUser) issues.push("missing_smtp_user");
    if (!config.smtpPassword) issues.push("missing_smtp_password");
    if (!config.smtpFromEmail) issues.push("missing_smtp_from_email");
  }
  if ((provider === "resend" || provider === "auto") && !config.resendApiKey && provider === "resend") {
    issues.push("missing_resend_api_key");
  }
  if (provider === "smtp" && config.awsSesDomain && senderDomain && senderDomain !== config.awsSesDomain.toLowerCase()) {
    issues.push(`smtp_from_domain_not_ses_verified_domain:${senderDomain}`);
  }
  if (config.emailOutboxCountsAsSent) {
    issues.push("email_outbox_counts_as_sent_enabled");
  }
  return issues;
}

function activeFromEmail() {
  return smtpConfigured() && (config.emailProvider === "smtp" || config.emailProvider === "auto")
    ? config.smtpFromEmail
    : config.fromEmail;
}

async function maybeRelayToAdmin({ to, subject, text, failures }) {
  if (!config.emailAdminRelayOnFailure) return null;
  if (!config.adminEmail || sameEmail(config.adminEmail, to)) return null;

  const restrictedFailure = failures.find((failure) => failure.domainRestricted || isResendDomainRestriction(failure.reason));
  if (!restrictedFailure && failures.length) return null;

  const relaySubject = `[Arcovia customer email not sent] ${subject || "Customer update"}`.slice(0, 180);
  const relayText = `This customer email was NOT sent automatically.

Reason:
${failures.map((failure) => failure.reason || "unknown").join("\n")}

Original recipient:
${to}

Copy the safe message below and send it manually, or configure Gmail SMTP / verify the Resend domain.

--- CUSTOMER MESSAGE START ---
${text || ""}
--- CUSTOMER MESSAGE END ---`;

  const relayProviders = [];
  if (smtpConfigured()) relayProviders.push("smtp");
  if (config.resendApiKey) relayProviders.push("resend_test");

  for (const provider of relayProviders) {
    const result = provider === "smtp"
      ? await sendViaSmtp({ to: config.adminEmail, subject: relaySubject, text: relayText })
      : await sendViaResend({ from: config.resendTestFromEmail, to: config.adminEmail, subject: relaySubject, text: relayText, provider: "resend_test_admin_relay" });
    if (result.ok) {
      appendOutbox({
        to,
        relayedTo: config.adminEmail,
        from: provider === "smtp" ? config.smtpFromEmail : config.resendTestFromEmail,
        replyTo: config.replyToEmail,
        subject,
        text,
        relayed: true,
        failed: true,
        detail: failures.map((failure) => failure.reason || "unknown").join(" | ")
      });
      return {
        ok: false,
        dryRun: false,
        relayed: true,
        provider: result.provider,
        providerId: result.id,
        reason: `customer_email_not_sent_relayed_to_admin:${failures.map((failure) => safeReason(failure.reason)).filter(Boolean).join("|")}`
      };
    }
  }

  return null;
}

async function sendViaSmtp({ to, subject, text }) {
  try {
    const result = await sendSmtpEmail({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      username: config.smtpUser,
      password: config.smtpPassword,
      from: config.smtpFromEmail,
      replyTo: config.replyToEmail,
      to,
      subject,
      text
    });
    return { ok: true, dryRun: false, provider: "smtp", id: result.messageId };
  } catch (error) {
    return { ok: false, dryRun: false, provider: "smtp", reason: safeReason(error?.message || error) };
  }
}

function sendSmtpEmail({ host, port, secure, username, password, from, replyTo, to, subject, text }) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });
    let buffer = "";
    const pending = [];
    const messageId = `<arcovia-${Date.now()}-${Math.random().toString(16).slice(2)}@arcovia.africa>`;

    socket.setTimeout(30_000, () => {
      socket.destroy(new Error("smtp_timeout"));
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      drainResponses();
    });
    socket.on("error", reject);

    function drainResponses() {
      while (true) {
        const lines = buffer.split(/\r?\n/);
        const completeIndex = lines.findIndex((line) => /^\d{3} /.test(line));
        if (completeIndex === -1) return;
        const responseLines = lines.slice(0, completeIndex + 1).filter(Boolean);
        buffer = lines.slice(completeIndex + 1).join("\r\n");
        const waiter = pending.shift();
        if (waiter) waiter(responseLines.join("\n"));
      }
    }

    function readResponse() {
      return new Promise((resolveResponse) => {
        pending.push(resolveResponse);
        drainResponses();
      });
    }

    async function expect(codes, command) {
      if (command) socket.write(`${command}\r\n`);
      const response = await readResponse();
      const code = Number(response.slice(0, 3));
      const allowed = Array.isArray(codes) ? codes : [codes];
      if (!allowed.includes(code)) {
        throw new Error(`smtp_unexpected_response:${code}:${response.slice(0, 500)}`);
      }
      return response;
    }

    async function run() {
      await expect(220);
      await expect(250, `EHLO ${smtpClientName()}`);
      if (!secure) {
        await expect(220, "STARTTLS");
        throw new Error("smtp_starttls_not_supported_use_smtp_secure_true");
      }
      await expect(334, "AUTH LOGIN");
      await expect(334, Buffer.from(username).toString("base64"));
      await expect(235, Buffer.from(password).toString("base64"));
      await expect(250, `MAIL FROM:<${emailAddressOnly(from)}>`);
      await expect([250, 251], `RCPT TO:<${emailAddressOnly(to)}>`);
      await expect(354, "DATA");
      socket.write(`${buildPlainTextMime({ from, replyTo, to, subject, text, messageId })}\r\n.\r\n`);
      await expect(250);
      socket.write("QUIT\r\n");
      socket.end();
      resolve({ messageId });
    }

    run().catch((error) => {
      socket.destroy();
      reject(error);
    });
  });
}

function buildPlainTextMime({ from, replyTo, to, subject, text, messageId }) {
  const headers = [
    `From: ${sanitizeHeader(from)}`,
    `To: ${sanitizeHeader(to)}`,
    replyTo ? `Reply-To: ${sanitizeHeader(replyTo)}` : "",
    `Subject: ${encodeHeader(subject || "")}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit"
  ].filter(Boolean);
  return `${headers.join("\r\n")}\r\n\r\n${escapeSmtpBody(text || "")}`;
}

function escapeSmtpBody(value) {
  return String(value || "")
    .replace(/\r?\n/g, "\r\n")
    .replace(/^\./gm, "..");
}

function sanitizeHeader(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

function encodeHeader(value) {
  const header = sanitizeHeader(value);
  return /^[\x00-\x7F]*$/.test(header)
    ? header
    : `=?UTF-8?B?${Buffer.from(header, "utf8").toString("base64")}?=`;
}

function emailAddressOnly(value) {
  const raw = String(value || "").trim();
  const bracketMatch = raw.match(/<([^>]+)>/);
  return (bracketMatch ? bracketMatch[1] : raw).trim();
}

function smtpClientName() {
  try {
    return new URL(config.publicBaseUrl).hostname || "arcovia.africa";
  } catch {
    return "arcovia.africa";
  }
}

function isResendDomainRestriction(detail) {
  const text = String(detail || "").toLowerCase();
  return text.includes("verify a domain")
    || text.includes("domain is not verified")
    || text.includes("only send testing emails")
    || text.includes("resend.dev")
    || text.includes("403");
}

function safeReason(value) {
  return String(value || "")
    .replace(/re_[A-Za-z0-9_-]+/g, "[redacted-resend-key]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted-api-key]")
    .slice(0, 500);
}

function getUnsafeCustomerEmailReason({ subject, text }) {
  const combined = `${subject || ""}\n${text || ""}`;
  const sensitivePatterns = [
    { pattern: /\bAI\b/i, reason: "customer_email_mentions_ai" },
    { pattern: /internal supplier details/i, reason: "customer_email_contains_internal_supplier_details" },
    { pattern: /supplier\/source:/i, reason: "customer_email_contains_supplier_source_mapping" },
    { pattern: /\bURL:/i, reason: "customer_email_contains_raw_url_field" },
    { pattern: /\bEvidence:/i, reason: "customer_email_contains_evidence_field" },
    { pattern: /\bRaw report:/i, reason: "customer_email_contains_raw_report" },
    { pattern: /\bRed flags:/i, reason: "customer_email_contains_red_flags" }
  ];

  for (const { pattern, reason } of sensitivePatterns) {
    if (pattern.test(combined)) return reason;
  }

  const allowedBase = config.publicBaseUrl.replace(/\/$/, "");
  const urls = combined.match(/https?:\/\/[^\s)>\]]+/gi) || [];
  const blockedUrl = urls.find((url) => !isAllowedCustomerUrl(url, allowedBase));
  if (blockedUrl) return "customer_email_contains_unapproved_external_link";

  return "";
}

function isAllowedCustomerUrl(url, allowedBase) {
  return [
    `${allowedBase}/brief/`,
    `${allowedBase}/status/`,
    `${allowedBase}/options/`,
    `${allowedBase}/quote/`
  ].some((prefix) => String(url || "").startsWith(prefix));
}

function sameEmail(left, right) {
  return normalizeEmail(left) && normalizeEmail(left) === normalizeEmail(right);
}

function normalizeEmail(value) {
  const raw = String(value || "").trim().toLowerCase();
  const bracketMatch = raw.match(/<([^>]+)>/);
  return (bracketMatch ? bracketMatch[1] : raw).trim();
}

function parseJson(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return null;
  }
}
