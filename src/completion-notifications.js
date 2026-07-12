import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { ensureCustomerOptionsAccess } from "./customer-options.js";
import { sendCustomerEmail, sendEmail } from "./email.js";
import { adminReviewReady, customerOptionsReady } from "./templates.js";
import { addTimeline, getJob, readJobs, recordEmailAudit, upsertJob } from "./storage.js";

const activeJobs = new Set();
const BASE_RETRY_MINUTES = 5;
const MAX_RETRY_MINUTES = 6 * 60;

export async function reconcileResearchCompletionNotifications(jobOrId, options = {}) {
  const jobId = typeof jobOrId === "string" ? jobOrId : jobOrId?.id;
  if (!jobId || activeJobs.has(jobId)) return { ok: false, skipped: true, reason: "already_reconciling_or_missing_job" };

  activeJobs.add(jobId);
  try {
    let job = getJob(jobId);
    if (!isCompletedResearchWithApprovedOptions(job)) {
      return { ok: true, skipped: true, reason: "completion_notifications_not_applicable" };
    }

    ensureCompletionNotificationState(job);
    upsertJob(job);

    const result = { ok: true, admin: null, customer: null };
    if (options.admin !== false) {
      result.admin = await reconcileAdminNotification(jobId, options);
      if (result.admin && !result.admin.ok && !result.admin.skipped) result.ok = false;
    }
    if (options.customer !== false) {
      result.customer = await reconcileCustomerNotification(jobId, options);
      if (result.customer && !result.customer.ok && !result.customer.skipped) result.ok = false;
    }
    return result;
  } finally {
    activeJobs.delete(jobId);
  }
}

export async function reconcileAllResearchCompletionNotifications(options = {}) {
  const results = [];
  for (const job of readJobs()) {
    if (!isCompletedResearchWithApprovedOptions(job)) continue;
    results.push(await reconcileResearchCompletionNotifications(job.id, options));
  }
  return results;
}

export function isCompletedResearchWithApprovedOptions(job) {
  if (!job?.id || !job.researchCompletedAt) return false;
  if (!Array.isArray(job.research?.suppliers) || job.research.suppliers.length === 0) return false;
  return !["cancelled", "cancelled_by_customer", "refunded", "refund_due", "no_online_purchase_available"].includes(job.status);
}

async function reconcileAdminNotification(jobId, options) {
  let job = getJob(jobId);
  if (!job) return { ok: false, skipped: true, reason: "job_not_found" };
  const state = ensureCompletionNotificationState(job).admin;
  const force = Boolean(options.forceAdmin);
  if (!force && state.sentAt) return { ok: true, skipped: true, reason: "already_sent", sentAt: state.sentAt };
  if (!force && !retryIsDue(state.retryAt)) return { ok: true, skipped: true, reason: "retry_not_due", retryAt: state.retryAt };

  const template = adminReviewReady(job);
  const attemptedAt = new Date().toISOString();
  const result = await safelySend(() => sendEmail({ to: config.adminEmail, ...template }));

  job = getJob(jobId) || job;
  const currentState = ensureCompletionNotificationState(job).admin;
  currentState.attemptCount = Number(currentState.attemptCount || 0) + 1;
  currentState.lastAttemptAt = attemptedAt;
  recordEmailAudit(job, {
    templateName: "admin_review_ready",
    audience: "admin",
    to: config.adminEmail,
    subject: template.subject,
    result
  });

  if (result.ok) {
    const sentAt = new Date().toISOString();
    currentState.sentAt = sentAt;
    currentState.retryAt = null;
    currentState.lastError = null;
    job.adminReviewSentAt = sentAt;
    addTimeline(job, "admin_review_link_sent", "Private supplier-review link sent to the Arcovia admin mailbox.", {
      templateName: "admin_review_ready",
      provider: result.provider || "unknown"
    });
  } else {
    const retryAt = nextRetryAt(currentState.attemptCount);
    currentState.retryAt = retryAt;
    currentState.lastError = safeFailureReason(result.reason);
    addTimeline(job, "admin_review_link_email_failed", `Private admin review email failed and will retry after ${retryAt}.`, {
      templateName: "admin_review_ready",
      reason: currentState.lastError
    });
  }

  updateAggregateRetryAt(job);
  upsertJob(job);
  return result;
}

async function reconcileCustomerNotification(jobId, options) {
  let job = getJob(jobId);
  if (!job) return { ok: false, skipped: true, reason: "job_not_found" };
  const state = ensureCompletionNotificationState(job).customer;
  const force = Boolean(options.forceCustomer);
  if (!force && state.sentAt) return { ok: true, skipped: true, reason: "already_sent", sentAt: state.sentAt };
  if (!force && customerSelectionAlreadyAdvanced(job)) {
    return { ok: true, skipped: true, reason: "customer_workflow_already_advanced" };
  }
  if (!force && !retryIsDue(state.retryAt)) return { ok: true, skipped: true, reason: "retry_not_due", retryAt: state.retryAt };

  const template = customerOptionsReady(job);
  const attemptedAt = new Date().toISOString();
  const result = job.customerEmail
    ? await safelySend(() => sendCustomerEmail({ to: job.customerEmail, ...template }))
    : { ok: false, dryRun: false, reason: "missing_customer_email" };

  job = getJob(jobId) || job;
  const currentState = ensureCompletionNotificationState(job).customer;
  currentState.attemptCount = Number(currentState.attemptCount || 0) + 1;
  currentState.lastAttemptAt = attemptedAt;
  recordEmailAudit(job, {
    templateName: "customer_options_ready",
    audience: "customer",
    to: job.customerEmail,
    subject: template.subject,
    result
  });

  if (result.ok) {
    const sentAt = new Date().toISOString();
    currentState.sentAt = sentAt;
    currentState.retryAt = null;
    currentState.lastError = null;
    job.customerOptionsSentAt = sentAt;
    if (job.status === "human_review") job.status = "options_sent";
    addTimeline(job, "customer_options_sent", "Anonymized approved-supplier options link sent to the customer after research completion.", {
      templateName: "customer_options_ready",
      provider: result.provider || "unknown"
    });
  } else {
    const retryAt = nextRetryAt(currentState.attemptCount);
    currentState.retryAt = retryAt;
    currentState.lastError = safeFailureReason(result.reason);
    addTimeline(job, "customer_options_email_failed", `Customer options email failed and will retry after ${retryAt}.`, {
      templateName: "customer_options_ready",
      reason: currentState.lastError
    });
  }

  updateAggregateRetryAt(job);
  upsertJob(job);
  return result;
}

function ensureCompletionNotificationState(job) {
  const now = new Date().toISOString();
  job.reviewToken ||= randomUUID();
  job.customerOptionsToken ||= randomUUID();
  job.reviewTokenIssuedAt ||= now;
  job.customerOptionsTokenIssuedAt ||= now;
  ensureCustomerOptionsAccess(job, new Date(now));
  job.completionNotifications ||= {};
  job.completionNotifications.admin ||= {};
  job.completionNotifications.customer ||= {};

  if (job.adminReviewSentAt && !job.completionNotifications.admin.sentAt) {
    job.completionNotifications.admin.sentAt = job.adminReviewSentAt;
  }
  if (job.customerOptionsSentAt && !job.completionNotifications.customer.sentAt) {
    job.completionNotifications.customer.sentAt = job.customerOptionsSentAt;
  }
  return job.completionNotifications;
}

function customerSelectionAlreadyAdvanced(job) {
  if (job.customerSelectedOption || job.finalQuote) return true;
  return [
    "customer_selected_option",
    "quote_verifying",
    "quote_ready",
    "payment_pending",
    "balance_paid",
    "ready_to_order",
    "order_placed",
    "in_transit",
    "delivered"
  ].includes(job.status);
}

function retryIsDue(value) {
  if (!value) return true;
  const retryTime = new Date(value).getTime();
  return !Number.isFinite(retryTime) || retryTime <= Date.now();
}

function nextRetryAt(attemptCount) {
  const exponent = Math.max(0, Math.min(7, Number(attemptCount || 1) - 1));
  const delayMinutes = Math.min(MAX_RETRY_MINUTES, BASE_RETRY_MINUTES * (2 ** exponent));
  return new Date(Date.now() + delayMinutes * 60_000).toISOString();
}

function updateAggregateRetryAt(job) {
  const values = [
    job.completionNotifications?.admin?.sentAt ? null : job.completionNotifications?.admin?.retryAt,
    job.completionNotifications?.customer?.sentAt ? null : job.completionNotifications?.customer?.retryAt
  ]
    .filter(Boolean)
    .map((value) => new Date(value))
    .filter((value) => Number.isFinite(value.getTime()))
    .sort((left, right) => left - right);
  job.completionNotificationRetryAt = values[0]?.toISOString() || null;
}

async function safelySend(send) {
  try {
    return await send();
  } catch (error) {
    return { ok: false, dryRun: false, reason: safeFailureReason(error?.message || error) };
  }
}

function safeFailureReason(value) {
  return String(value || "email_send_failed")
    .replace(/re_[A-Za-z0-9_-]+/g, "[redacted-email-key]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted-api-key]")
    .slice(0, 500);
}
