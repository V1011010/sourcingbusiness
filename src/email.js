import { appendOutbox } from "./storage.js";
import { config } from "./config.js";

export async function sendEmail({ to, subject, text }) {
  if (!to) {
    appendOutbox({ to: "missing-recipient", subject, text, skipped: true });
    return { ok: false, dryRun: true, reason: "missing recipient" };
  }

  if (!config.resendApiKey) {
    appendOutbox({ to, from: config.fromEmail, replyTo: config.replyToEmail, subject, text, dryRun: true });
    return { ok: true, dryRun: true };
  }

  const response = await sendResendEmail({
    from: config.fromEmail,
    to,
    subject,
    text
  });

  if (!response.ok) {
    const detail = await response.text();
    if (shouldRetryWithResendDefaultSender(detail)) {
      const fallbackFrom = "Arcovia <onboarding@resend.dev>";
      const fallbackResponse = await sendResendEmail({
        from: fallbackFrom,
        to,
        subject,
        text
      });

      if (fallbackResponse.ok) {
        appendOutbox({
          to,
          from: fallbackFrom,
          originalFrom: config.fromEmail,
          replyTo: config.replyToEmail,
          subject,
          fallback: true,
          reason: "original_from_domain_not_verified"
        });
        return { ok: true, dryRun: false, fallback: true };
      }

      const fallbackDetail = await fallbackResponse.text();
      appendOutbox({ to, from: fallbackFrom, replyTo: config.replyToEmail, subject, text, failed: true, detail: fallbackDetail, fallback: true });
      return { ok: false, dryRun: false, reason: fallbackDetail };
    }

    appendOutbox({ to, from: config.fromEmail, replyTo: config.replyToEmail, subject, text, failed: true, detail });
    return { ok: false, dryRun: false, reason: detail };
  }

  return { ok: true, dryRun: false };
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

function shouldRetryWithResendDefaultSender(detail) {
  const message = String(detail || "").toLowerCase();
  return message.includes("domain is not verified") || message.includes("verify your domain");
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
    `${allowedBase}/options/`
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
