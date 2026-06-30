import { appendOutbox } from "./storage.js";
import { config } from "./config.js";

export async function sendEmail({ to, subject, text }) {
  if (!to) {
    appendOutbox({ to: "missing-recipient", subject, text, skipped: true });
    return { ok: false, dryRun: true, reason: "missing recipient" };
  }

  if (!config.resendApiKey) {
    appendOutbox({ to, from: config.fromEmail, subject, text, dryRun: true });
    return { ok: true, dryRun: true };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: config.fromEmail,
      to: [to],
      subject,
      text
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    appendOutbox({ to, from: config.fromEmail, subject, text, failed: true, detail });
    return { ok: false, dryRun: false, reason: detail };
  }

  return { ok: true, dryRun: false };
}
