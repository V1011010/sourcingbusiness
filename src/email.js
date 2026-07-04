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
