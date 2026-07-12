import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "arcovia-completion-email-"));
process.env.ARCOVIA_DATA_DIR = dataDir;
process.env.PUBLIC_BASE_URL = "https://sourcingbusiness.example";
process.env.EMAIL_PROVIDER = "none";
process.env.EMAIL_OUTBOX_COUNTS_AS_SENT = "true";
process.env.ADMIN_EMAIL = "owner@example.com";

const { config } = await import("../src/config.js");
const {
  reconcileAllResearchCompletionNotifications,
  reconcileResearchCompletionNotifications
} = await import("../src/completion-notifications.js");
const { getJob, upsertJob } = await import("../src/storage.js");

after(() => rmSync(dataDir, { recursive: true, force: true }));

test("completion sends separate private admin and anonymous customer links even to the same mailbox", async () => {
  upsertJob(completedJob({ id: "same-mailbox", customerEmail: config.adminEmail }));

  const result = await reconcileResearchCompletionNotifications("same-mailbox");
  assert.equal(result.ok, true);

  const saved = getJob("same-mailbox");
  assert.ok(saved.adminReviewSentAt);
  assert.ok(saved.customerOptionsSentAt);
  assert.equal(saved.status, "options_sent");
  assert.equal(saved.emailLog.length, 2);
  assert.deepEqual(saved.emailLog.map((entry) => entry.templateName), ["admin_review_ready", "customer_options_ready"]);

  const messages = readOutbox().filter((message) => message.to === config.adminEmail);
  assert.equal(messages.length, 2);
  const adminMessage = messages.find((message) => message.subject.startsWith("Private Arcovia"));
  const customerMessage = messages.find((message) => message.subject.startsWith("Your Arcovia"));
  assert.match(adminMessage.text, /\/review\/review-same-mailbox/);
  assert.doesNotMatch(adminMessage.text, /\/options\/options-same-mailbox/);
  assert.match(customerMessage.text, /\/options\/options-same-mailbox/);
  assert.doesNotMatch(customerMessage.text, /\/review\//);
  assert.doesNotMatch(customerMessage.text, /supplier\.secret\.example/i);

  await reconcileResearchCompletionNotifications("same-mailbox");
  assert.equal(readOutbox().filter((message) => message.to === config.adminEmail).length, 2);
});

test("admin failure does not block the customer link and can be retried independently", async () => {
  const originalAdminEmail = config.adminEmail;
  config.adminEmail = "";
  upsertJob(completedJob({ id: "independent-retry", customerEmail: "customer@example.com" }));

  const first = await reconcileResearchCompletionNotifications("independent-retry");
  assert.equal(first.ok, false);
  const afterFirst = getJob("independent-retry");
  assert.equal(afterFirst.adminReviewSentAt, undefined);
  assert.ok(afterFirst.completionNotifications.admin.retryAt);
  assert.ok(afterFirst.customerOptionsSentAt);

  config.adminEmail = originalAdminEmail;
  const retry = await reconcileResearchCompletionNotifications("independent-retry", {
    forceAdmin: true,
    customer: false
  });
  assert.equal(retry.admin.ok, true);
  const afterRetry = getJob("independent-retry");
  assert.ok(afterRetry.adminReviewSentAt);
  assert.equal(afterRetry.completionNotifications.admin.retryAt, null);
});

test("saved completed jobs are repaired by reconciliation without rerunning research", async () => {
  upsertJob(completedJob({ id: "saved-job", customerEmail: "saved@example.com" }));

  await reconcileAllResearchCompletionNotifications();

  const saved = getJob("saved-job");
  assert.ok(saved.adminReviewSentAt);
  assert.ok(saved.customerOptionsSentAt);
  assert.equal(saved.researchAttemptCount, 3);
});

function completedJob({ id, customerEmail }) {
  return {
    id,
    orderName: `#${id}`,
    customerName: "Test Customer",
    customerEmail,
    reviewToken: `review-${id}`,
    customerOptionsToken: `options-${id}`,
    status: "human_review",
    researchCompletedAt: "2026-07-11T10:00:00.000Z",
    researchAttemptCount: 3,
    research: {
      suppliers: [{
        name: "Secret Supplier",
        url: "https://supplier.secret.example/product",
        price: "R1,000"
      }],
      candidateSources: [],
      rejectedSources: []
    },
    timeline: []
  };
}

function readOutbox() {
  return JSON.parse(readFileSync(join(dataDir, "outbox.json"), "utf8")).messages;
}
