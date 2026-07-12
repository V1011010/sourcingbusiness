import test from "node:test";
import assert from "node:assert/strict";
import {
  canCancelCustomerOptions,
  customerOptionsAccessState,
  ensureCustomerOptionsAccess,
  recordCustomerOptionsDecision
} from "../src/customer-options.js";

const NOW = new Date("2026-07-11T12:00:00.000Z");

function readyJob(overrides = {}) {
  return {
    customerOptionsToken: "private-options-token",
    customerOptionsTokenIssuedAt: NOW.toISOString(),
    researchCompletedAt: NOW.toISOString(),
    status: "options_sent",
    research: { suppliers: [{ name: "Internal supplier" }] },
    ...overrides
  };
}

test("options access gets a finite 30-day decision window", () => {
  const job = readyJob();
  const result = ensureCustomerOptionsAccess(job, NOW);

  assert.equal(result.changed, true);
  assert.equal(job.customerOptionsTokenExpiresAt, "2026-08-10T12:00:00.000Z");
  assert.equal(result.state.canDecide, true);
});

test("a supplier selection consumes the token for decisions but remains idempotent", () => {
  const job = readyJob();
  ensureCustomerOptionsAccess(job, NOW);

  const first = recordCustomerOptionsDecision(job, "selected", NOW);
  const repeat = recordCustomerOptionsDecision(job, "selected", new Date("2026-07-11T12:01:00.000Z"));
  const cancel = recordCustomerOptionsDecision(job, "cancelled", new Date("2026-07-11T12:02:00.000Z"));

  assert.equal(first.ok, true);
  assert.equal(repeat.idempotent, true);
  assert.equal(cancel.ok, false);
  assert.equal(customerOptionsAccessState(job, NOW).canDecide, false);
});

test("customer can cancel unsuitable approved options before selecting or paying", () => {
  const job = readyJob();
  ensureCustomerOptionsAccess(job, NOW);

  assert.equal(canCancelCustomerOptions(job, NOW), true);
  assert.equal(recordCustomerOptionsDecision(job, "cancelled", NOW).ok, true);
  assert.equal(canCancelCustomerOptions(job, NOW), false);
});

test("expired links and paid orders cannot be cancelled", () => {
  const expired = readyJob({ customerOptionsTokenExpiresAt: "2026-07-10T12:00:00.000Z" });
  const paid = readyJob({ status: "ready_to_order", finalQuote: { paymentStatus: "COMPLETE" } });

  assert.equal(customerOptionsAccessState(expired, NOW).expired, true);
  assert.equal(canCancelCustomerOptions(expired, NOW), false);
  assert.equal(canCancelCustomerOptions(paid, NOW), false);
});

