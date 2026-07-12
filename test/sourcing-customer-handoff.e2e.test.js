import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("completed research sends private links, accepts one choice, exposes only a verified total, and supports cancellation", { timeout: 20_000 }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "arcovia-customer-handoff-"));
  const port = await findAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const jobs = [selectableJob(), cancellableJob()];
  writeFileSync(join(dataDir, "jobs.json"), JSON.stringify({ jobs }, null, 2));

  let stdout = "";
  let stderr = "";
  const child = spawn(process.execPath, [join(projectDir, "src", "server.js")], {
    cwd: projectDir,
    env: {
      ...process.env,
      PORT: String(port),
      PUBLIC_BASE_URL: baseUrl,
      ARCOVIA_DATA_DIR: dataDir,
      ARCOVIA_ALLOW_TEMP_PAYMENT_STORAGE: "true",
      ARCOVIA_ADMIN_STATUS_SECRET: "test-admin-secret",
      ARCOVIA_FLOW_SECRET: "test-flow-secret",
      EMAIL_PROVIDER: "none",
      EMAIL_OUTBOX_COUNTS_AS_SENT: "true",
      EMAIL_ADMIN_RELAY_ON_FAILURE: "false",
      ADMIN_EMAIL: "owner@arcovia.test",
      LOCAL_CODEX_WORKER_ENABLED: "false",
      SHOPIFY_FINAL_CHECKOUT_ENABLED: "false",
      PAYFAST_MERCHANT_ID: "test-merchant-id",
      PAYFAST_MERCHANT_KEY: "test-merchant-key",
      PAYFAST_PASSPHRASE: "test-passphrase",
      PAYFAST_SANDBOX: "true",
      PAYFAST_PROCESS_URL: "https://sandbox.payfast.co.za/eng/process"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000))
      ]);
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, child, () => stderr);
  await waitFor(() => {
    const messages = readOutbox(dataDir);
    return messages.some((message) => message.subject?.includes("Private Arcovia supplier review ready: #SELECT"))
      && messages.some((message) => message.subject?.includes("Your Arcovia sourcing options are ready: #SELECT"));
  }, () => `Completion emails were not written to the outbox.\nstdout:\n${stdout}\nstderr:\n${stderr}`);

  const completionMessages = readOutbox(dataDir);
  const ownerReviewEmail = findMessage(completionMessages, "owner@arcovia.test", "Private Arcovia supplier review ready: #SELECT");
  const customerOptionsEmail = findMessage(completionMessages, "buyer@example.com", "Your Arcovia sourcing options are ready: #SELECT");
  assert.match(ownerReviewEmail.text, new RegExp(`${escapeRegExp(baseUrl)}/review/review-select`));
  assert.match(customerOptionsEmail.text, new RegExp(`${escapeRegExp(baseUrl)}/options/options-select`));
  assert.doesNotMatch(customerOptionsEmail.text, /\/review\//);
  assertCustomerSafe(customerOptionsEmail.text);

  const optionsResponse = await fetch(`${baseUrl}/options/options-select`);
  const optionsHtml = await optionsResponse.text();
  assert.equal(optionsResponse.status, 200);
  assert.match(optionsHtml, /Supplier 1/);
  assert.match(optionsHtml, /Supplier 2/);
  assert.match(optionsHtml, /Cancel this sourcing request/);
  assert.match(optionsHtml, /one selection or cancellation only/);
  assert.doesNotMatch(optionsHtml, /Nightfall Wholesale|Hidden Bazaar/);
  assert.doesNotMatch(optionsHtml, /nightfall\.example|hidden-bazaar\.example/);

  const reviewResponse = await fetch(`${baseUrl}/review/review-select`);
  const reviewHtml = await reviewResponse.text();
  assert.equal(reviewResponse.status, 200);
  assert.match(reviewHtml, /Nightfall Wholesale/);
  assert.match(reviewHtml, /nightfall\.example/);

  const firstChoice = await postForm(`${baseUrl}/options/select`, {
    token: "options-select",
    option_index: "0"
  });
  assert.equal(firstChoice.status, 303);
  assert.equal(firstChoice.headers.get("location"), "/options/options-select?selected=1");

  let selectedJob = readJob(dataDir, "job-select");
  assert.equal(selectedJob.status, "quote_verifying");
  assert.equal(selectedJob.customerOptionsDecision, "selected");
  assert.equal(selectedJob.customerSelectedOption.optionLabel, "Supplier 1");
  assert.equal(selectedJob.finalQuote.status, "verification_pending");
  assert.equal(selectedJob.finalQuote.requiresManualVerification, true);

  const secondChoice = await postForm(`${baseUrl}/options/select`, {
    token: "options-select",
    option_index: "1"
  });
  assert.equal(secondChoice.status, 409);
  assert.match(await secondChoice.text(), /one-time choice has already been submitted/i);
  selectedJob = readJob(dataDir, "job-select");
  assert.equal(selectedJob.customerSelectedOption.index, 0);

  const quoteAction = await postForm(`${baseUrl}/review/quote-action`, {
    review_token: "review-select",
    job_id: "job-select",
    action: "send_quote",
    final_amount_zar: "2345.67",
    expiry_hours: "24",
    item_cost: "R1,900.00",
    shipping_cost: "R300.00",
    duties_cost: "R95.67",
    handling_fee: "R50.00",
    customer_notes: "Live stock and delivery were confirmed for this option.",
    internal_notes: "Private supplier verification complete."
  });
  assert.equal(quoteAction.status, 303);

  selectedJob = readJob(dataDir, "job-select");
  assert.equal(selectedJob.status, "payment_pending");
  assert.equal(selectedJob.finalQuote.status, "quote_ready");
  assert.equal(selectedJob.finalQuote.paymentStatus, "pending");
  assert.equal(selectedJob.finalQuote.finalAmountZar, 2345.67);
  assert.equal(selectedJob.finalQuote.checkoutProvider, "payfast");

  const payableOptionsResponse = await fetch(`${baseUrl}/options/options-select`);
  const payableOptionsHtml = await payableOptionsResponse.text();
  assert.equal(payableOptionsResponse.status, 200);
  assert.match(payableOptionsHtml, /Your confirmed total is ready/);
  assert.match(payableOptionsHtml, /Pay now — R2345\.67/);
  assert.match(payableOptionsHtml, new RegExp(`href="/quote/${escapeRegExp(selectedJob.finalQuote.token)}"`));
  assert.doesNotMatch(payableOptionsHtml, /Nightfall Wholesale|nightfall\.example/);

  const quoteResponse = await fetch(`${baseUrl}/quote/${encodeURIComponent(selectedJob.finalQuote.token)}`);
  const quoteHtml = await quoteResponse.text();
  assert.equal(quoteResponse.status, 200);
  assert.match(quoteHtml, /Confirmed total/);
  assert.match(quoteHtml, /Pay R2345\.67 securely with PayFast/);
  assert.match(quoteHtml, /action="https:\/\/sandbox\.payfast\.co\.za\/eng\/process"/);
  assert.doesNotMatch(quoteHtml, /Nightfall Wholesale|nightfall\.example/);

  const cancelPageResponse = await fetch(`${baseUrl}/options/options-cancel`);
  const cancelPageHtml = await cancelPageResponse.text();
  assert.equal(cancelPageResponse.status, 200);
  assert.match(cancelPageHtml, /Cancel this sourcing request/);
  assert.doesNotMatch(cancelPageHtml, /Pay now —/);

  const cancellation = await postForm(`${baseUrl}/options/cancel`, {
    token: "options-cancel",
    confirm_cancel: "yes",
    reason: "None of the approved options match the required condition."
  });
  assert.equal(cancellation.status, 303);
  assert.equal(cancellation.headers.get("location"), "/options/options-cancel?cancelled=1");

  const cancelledJob = readJob(dataDir, "job-cancel");
  assert.equal(cancelledJob.status, "cancelled_by_customer");
  assert.equal(cancelledJob.customerOptionsDecision, "cancelled");
  assert.equal(cancelledJob.refundStatus, "deposit_not_refundable_approved_options");
  assert.equal(cancelledJob.cancellation.finalPaymentDue, false);

  const choiceAfterCancellation = await postForm(`${baseUrl}/options/select`, {
    token: "options-cancel",
    option_index: "0"
  });
  assert.equal(choiceAfterCancellation.status, 409);
  assert.match(await choiceAfterCancellation.text(), /already been cancelled/i);

  const cancelledOptionsResponse = await fetch(`${baseUrl}/options/options-cancel`);
  const cancelledOptionsHtml = await cancelledOptionsResponse.text();
  assert.equal(cancelledOptionsResponse.status, 200);
  assert.match(cancelledOptionsHtml, /Request cancelled/);
  assert.doesNotMatch(cancelledOptionsHtml, /Pay now —/);

  const finalOutbox = readOutbox(dataDir);
  const quoteEmail = findMessage(finalOutbox, "buyer@example.com", "Your Arcovia final quote is ready: #SELECT");
  assert.match(quoteEmail.text, new RegExp(`${escapeRegExp(baseUrl)}/quote/${escapeRegExp(selectedJob.finalQuote.token)}`));
  const cancellationEmail = findMessage(finalOutbox, "cancel@example.com", "Arcovia sourcing request cancelled: #CANCEL");
  assert.match(cancellationEmail.text, /no final product payment will be requested/i);

  for (const message of finalOutbox.filter((entry) => ["buyer@example.com", "cancel@example.com"].includes(entry.to))) {
    assertCustomerSafe(`${message.subject || ""}\n${message.text || ""}`);
  }
});

function selectableJob() {
  return completedJob({
    id: "job-select",
    orderName: "#SELECT",
    customerEmail: "buyer@example.com",
    reviewToken: "review-select",
    customerOptionsToken: "options-select",
    suppliers: [
      {
        name: "Nightfall Wholesale",
        url: "https://nightfall.example/private/item-884",
        price: "R1,750.00",
        estimated_total_zar: "R2,050.00",
        availability: "In stock",
        trust_score: 89,
        risk_level: "low"
      },
      {
        name: "Hidden Bazaar",
        url: "https://hidden-bazaar.example/catalog/item-201",
        price: "R1,980.00",
        estimated_total_zar: "R2,280.00",
        availability: "Limited stock",
        trust_score: 82,
        risk_level: "low"
      }
    ]
  });
}

function cancellableJob() {
  return completedJob({
    id: "job-cancel",
    orderName: "#CANCEL",
    customerEmail: "cancel@example.com",
    reviewToken: "review-cancel",
    customerOptionsToken: "options-cancel",
    suppliers: [{
      name: "Cancel Route Supplier",
      url: "https://cancel-route.example/secret-product",
      price: "R900.00",
      estimated_total_zar: "R1,150.00",
      availability: "In stock",
      trust_score: 80,
      risk_level: "low"
    }]
  });
}

function completedJob({ id, orderName, customerEmail, reviewToken, customerOptionsToken, suppliers }) {
  const completedAt = new Date(Date.now() - 60_000).toISOString();
  return {
    id,
    orderId: `order-${id}`,
    orderName,
    customerName: "Test Customer",
    customerEmail,
    publicToken: `status-${id}`,
    reviewToken,
    customerOptionsToken,
    source: "test_seed",
    productRequest: "Category: Electronics\nItem name: privacy workflow test item\nBudget: R3,000",
    status: "human_review",
    researchAttemptCount: 3,
    maxResearchAttempts: 3,
    createdAt: completedAt,
    updatedAt: completedAt,
    researchCompletedAt: completedAt,
    research: {
      summary: "Test research completed with approved options.",
      suppliers,
      candidateSources: [],
      rejectedSources: []
    },
    timeline: []
  };
}

function readJob(dataDir, id) {
  const jobs = JSON.parse(readFileSync(join(dataDir, "jobs.json"), "utf8")).jobs;
  return jobs.find((job) => job.id === id);
}

function readOutbox(dataDir) {
  try {
    return JSON.parse(readFileSync(join(dataDir, "outbox.json"), "utf8")).messages || [];
  } catch {
    return [];
  }
}

function findMessage(messages, recipient, subject) {
  const message = messages.find((entry) => entry.to === recipient && entry.subject === subject);
  assert.ok(message, `Expected outbox message to ${recipient} with subject "${subject}".`);
  return message;
}

function assertCustomerSafe(text) {
  assert.doesNotMatch(text, /Nightfall Wholesale|Hidden Bazaar|Cancel Route Supplier/);
  assert.doesNotMatch(text, /nightfall\.example|hidden-bazaar\.example|cancel-route\.example/);
  assert.doesNotMatch(text, /\/review\//);
  assert.doesNotMatch(text, /\bAI\b/i);
}

async function postForm(url, fields) {
  return fetch(url, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields)
  });
}

async function waitForHealth(baseUrl, child, stderr) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited before health check.\n${stderr()}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The child process may still be binding the port.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Server did not become healthy.\n${stderr()}`);
}

async function waitFor(predicate, failureMessage) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(failureMessage());
}

async function findAvailablePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  probe.close();
  await once(probe, "close");
  return port;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
