import { randomUUID } from "node:crypto";

const OPTIONS_LINK_LIFETIME_DAYS = 30;
const FINAL_PAYMENT_OR_ORDER_STATES = new Set([
  "balance_paid",
  "ready_to_order",
  "order_placed",
  "in_transit",
  "delivered"
]);

export function ensureCustomerOptionsAccess(job, now = new Date()) {
  if (!job) return { changed: false, state: customerOptionsAccessState(job, now) };

  let changed = false;
  if (!job.customerOptionsToken) {
    job.customerOptionsToken = randomUUID();
    changed = true;
  }

  const readyToIssue = Boolean(
    job.customerOptionsSentAt
    || job.researchCompletedAt
    || job.customerSelectedOption
    || job.status === "cancelled_by_customer"
  );
  if (!job.customerOptionsTokenIssuedAt && readyToIssue) {
    const issuedAt = firstValidDate(job.customerOptionsSentAt, job.researchCompletedAt, now.toISOString());
    job.customerOptionsTokenIssuedAt = issuedAt.toISOString();
    changed = true;
  }

  if (!job.customerOptionsTokenExpiresAt && job.customerOptionsTokenIssuedAt) {
    const expiresAt = new Date(job.customerOptionsTokenIssuedAt);
    expiresAt.setUTCDate(expiresAt.getUTCDate() + OPTIONS_LINK_LIFETIME_DAYS);
    job.customerOptionsTokenExpiresAt = expiresAt.toISOString();
    changed = true;
  }

  if (!job.customerOptionsDecision && job.customerSelectedOption) {
    job.customerOptionsDecision = "selected";
    job.customerOptionsDecisionAt = job.customerSelectedOption.selectedAt || now.toISOString();
    job.customerOptionsConsumedAt = job.customerOptionsDecisionAt;
    changed = true;
  } else if (!job.customerOptionsDecision && job.status === "cancelled_by_customer") {
    job.customerOptionsDecision = "cancelled";
    job.customerOptionsDecisionAt = job.cancellation?.requestedAt || now.toISOString();
    job.customerOptionsConsumedAt = job.customerOptionsDecisionAt;
    changed = true;
  }

  return { changed, state: customerOptionsAccessState(job, now) };
}

export function customerOptionsAccessState(job, now = new Date()) {
  const decision = String(job?.customerOptionsDecision || "").toLowerCase();
  const expiresAt = validDate(job?.customerOptionsTokenExpiresAt || job?.customerOptionsExpiresAt);
  const expired = Boolean(!decision && expiresAt && expiresAt <= now);

  return {
    decision: decision || null,
    decided: Boolean(decision),
    expired,
    canDecide: Boolean(job?.customerOptionsToken && job?.customerOptionsTokenIssuedAt && !decision && !expired),
    expiresAt: expiresAt?.toISOString() || null
  };
}

export function recordCustomerOptionsDecision(job, decision, now = new Date()) {
  const normalizedDecision = decision === "cancelled" ? "cancelled" : "selected";
  const existing = String(job?.customerOptionsDecision || "").toLowerCase();
  if (existing) {
    return { ok: existing === normalizedDecision, idempotent: existing === normalizedDecision, decision: existing };
  }

  const access = customerOptionsAccessState(job, now);
  if (!access.canDecide) {
    return { ok: false, idempotent: false, decision: existing || null, reason: access.expired ? "expired" : "inactive" };
  }

  const decidedAt = now.toISOString();
  job.customerOptionsDecision = normalizedDecision;
  job.customerOptionsDecisionAt = decidedAt;
  job.customerOptionsConsumedAt = decidedAt;
  return { ok: true, idempotent: false, decision: normalizedDecision };
}

export function canCancelCustomerOptions(job, now = new Date()) {
  const access = customerOptionsAccessState(job, now);
  if (!access.canDecide) return false;
  if (!job?.researchCompletedAt || !(job.research?.suppliers || []).length) return false;
  if (job.customerSelectedOption) return false;
  if (FINAL_PAYMENT_OR_ORDER_STATES.has(job.status)) return false;
  if (job.finalQuote?.paymentStatus === "COMPLETE") return false;
  return true;
}

function firstValidDate(...values) {
  for (const value of values) {
    const parsed = validDate(value);
    if (parsed) return parsed;
  }
  return new Date();
}

function validDate(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
