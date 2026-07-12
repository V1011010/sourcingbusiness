import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

test("private options page supports a one-time cancellation and verified-total payment handoff", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "arcovia-options-http-"));
  const port = 21000 + Math.floor(Math.random() * 10000);
  const baseUrl = `http://127.0.0.1:${port}`;
  writeFileSync(join(dataDir, "jobs.json"), JSON.stringify({ jobs: [cancellableJob(), payableJob()] }, null, 2));

  const server = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      PUBLIC_BASE_URL: baseUrl,
      ARCOVIA_DATA_DIR: dataDir,
      EMAIL_PROVIDER: "none",
      EMAIL_OUTBOX_COUNTS_AS_SENT: "true",
      LOCAL_CODEX_WORKER_ENABLED: "false",
      PAYFAST_MERCHANT_ID: "test-merchant",
      PAYFAST_MERCHANT_KEY: "test-key",
      ADMIN_EMAIL: "owner@example.com"
    },
    stdio: "ignore"
  });

  t.after(() => {
    server.kill();
    rmSync(dataDir, { recursive: true, force: true });
  });
  await waitForServer(`${baseUrl}/health`);

  const initialPage = await fetch(`${baseUrl}/options/cancel-token`).then((response) => response.text());
  assert.match(initialPage, /Choose how to continue/);
  assert.match(initialPage, /Cancel this sourcing request/);
  assert.doesNotMatch(initialPage, /Pay now —/);
  assert.doesNotMatch(initialPage, /supplier\.example|Hidden supplier/);

  const cancelResponse = await fetch(`${baseUrl}/options/cancel`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token: "cancel-token",
      confirm_cancel: "yes",
      reason: "None of the approved options match the required condition."
    })
  });
  assert.equal(cancelResponse.status, 303);

  const cancelled = readJob(dataDir, "cancel-job");
  assert.equal(cancelled.status, "cancelled_by_customer");
  assert.equal(cancelled.customerOptionsDecision, "cancelled");
  assert.equal(cancelled.refundStatus, "deposit_not_refundable_approved_options");
  assert.equal(cancelled.finalQuote, undefined);

  const firstEmailCount = cancelled.emailLog.length;
  const repeatCancel = await fetch(`${baseUrl}/options/cancel`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: "cancel-token", confirm_cancel: "yes" })
  });
  assert.equal(repeatCancel.status, 303);
  assert.equal(readJob(dataDir, "cancel-job").emailLog.length, firstEmailCount);

  const cancelledPage = await fetch(`${baseUrl}/options/cancel-token`).then((response) => response.text());
  assert.match(cancelledPage, /Request cancelled/);
  assert.doesNotMatch(cancelledPage, /Pay now —/);

  const payablePage = await fetch(`${baseUrl}/options/pay-token`).then((response) => response.text());
  assert.match(payablePage, /Your confirmed total is ready/);
  assert.match(payablePage, /Pay now — R1899\.50/);
  assert.match(payablePage, /href="\/quote\/quote-token"/);
  assert.doesNotMatch(payablePage, /Pay now — R1,200/);
  assert.doesNotMatch(payablePage, /supplier\.example|Hidden supplier/);
});

function cancellableJob() {
  return baseJob({
    id: "cancel-job",
    orderName: "#CANCEL",
    customerOptionsToken: "cancel-token"
  });
}

function payableJob() {
  return {
    ...baseJob({
      id: "pay-job",
      orderName: "#PAY",
      customerOptionsToken: "pay-token"
    }),
    status: "payment_pending",
    customerOptionsDecision: "selected",
    customerOptionsDecisionAt: "2026-07-12T08:05:00.000Z",
    customerOptionsConsumedAt: "2026-07-12T08:05:00.000Z",
    customerSelectedOption: {
      index: 0,
      optionLabel: "Supplier 1",
      selectedAt: "2026-07-12T08:05:00.000Z",
      supplier: { name: "Hidden supplier", price: "R1,200" }
    },
    finalQuote: {
      token: "quote-token",
      optionIndex: 0,
      optionLabel: "Supplier 1",
      finalAmountZar: 1899.5,
      status: "quote_ready",
      paymentStatus: "pending",
      checkoutProvider: "payfast",
      verifiedAt: "2026-07-12T08:10:00.000Z",
      expiresAt: "2099-08-10T08:00:00.000Z"
    }
  };
}

function baseJob({ id, orderName, customerOptionsToken }) {
  const sentAt = "2026-07-12T08:00:00.000Z";
  return {
    id,
    orderId: id,
    orderName,
    customerName: "Test Customer",
    customerEmail: "customer@example.com",
    publicToken: `status-${id}`,
    reviewToken: `review-${id}`,
    customerOptionsToken,
    customerOptionsTokenIssuedAt: sentAt,
    customerOptionsTokenExpiresAt: "2099-08-10T08:00:00.000Z",
    customerOptionsSentAt: sentAt,
    adminReviewSentAt: sentAt,
    completionNotifications: {
      admin: { sentAt },
      customer: { sentAt }
    },
    status: "options_sent",
    researchCompletedAt: sentAt,
    researchAttemptCount: 3,
    research: {
      suppliers: [{
        name: "Hidden supplier",
        url: "https://supplier.example/private-product",
        price: "R1,200",
        estimated_total_to_customer: "R1,200",
        availability: "In stock"
      }]
    },
    timeline: []
  };
}

function readJob(dataDir, id) {
  const jobs = JSON.parse(readFileSync(join(dataDir, "jobs.json"), "utf8")).jobs;
  return jobs.find((job) => job.id === id);
}

async function waitForServer(url) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError || new Error("server did not become ready");
}
