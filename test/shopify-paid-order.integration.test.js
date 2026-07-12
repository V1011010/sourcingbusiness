import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("a paid Shopify final-balance order confirms its quote and never creates a sourcing job", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "arcovia-shopify-paid-"));
  const port = 43000 + Math.floor(Math.random() * 1500);
  const job = {
    id: "job-paid-test",
    orderId: "deposit-order-1",
    orderName: "#1012",
    customerName: "Test Buyer",
    customerEmail: "buyer@example.com",
    status: "payment_pending",
    publicToken: "public-paid-test",
    timeline: [],
    finalQuote: {
      id: "quote-paid-test",
      token: "quote-token-paid-test",
      paymentId: "ARC-1012-TEST",
      finalAmountZar: 1234.56,
      status: "quote_ready",
      paymentStatus: "pending",
      checkoutProvider: "shopify"
    }
  };
  writeFileSync(join(dataDir, "jobs.json"), JSON.stringify({ jobs: [job] }, null, 2));

  const child = spawn(process.execPath, [join(projectDir, "src", "server.js")], {
    cwd: dataDir,
    env: {
      ...process.env,
      PORT: String(port),
      PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      ARCOVIA_DATA_DIR: dataDir,
      ARCOVIA_FLOW_SECRET: "flow-test-secret",
      ARCOVIA_ADMIN_STATUS_SECRET: "admin-test-secret",
      EMAIL_PROVIDER: "none",
      EMAIL_OUTBOX_COUNTS_AS_SENT: "true",
      ADMIN_EMAIL: "owner@example.com",
      LOCAL_CODEX_WORKER_ENABLED: "false",
      SHOPIFY_STORE_DOMAIN: "",
      SHOPIFY_ADMIN_ACCESS_TOKEN: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([
        once(child, "exit"),
        new Promise((resolveDelay) => setTimeout(resolveDelay, 2000))
      ]);
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  await waitForHealth(port, child);
  const response = await fetch(`http://127.0.0.1:${port}/flow/order-paid`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Arcovia-Flow-Secret": "flow-test-secret"
    },
    body: JSON.stringify({
      id: 555999,
      name: "#2020",
      financial_status: "paid",
      total_price: "1234.56",
      currency: "ZAR",
      note_attributes: [
        { name: "arcovia_payment_kind", value: "final_balance" },
        { name: "arcovia_job_id", value: "job-paid-test" },
        { name: "arcovia_quote_id", value: "quote-paid-test" }
      ],
      line_items: [{ sku: "ARC-FINAL-BALANCE", title: "Arcovia sourced item — Supplier 1" }]
    })
  });

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    ok: true,
    kind: "final_balance",
    job_id: "job-paid-test",
    status: "ready_to_order"
  });

  const savedJobs = JSON.parse(readFileSync(join(dataDir, "jobs.json"), "utf8")).jobs;
  assert.equal(savedJobs.length, 1);
  assert.equal(savedJobs[0].id, "job-paid-test");
  assert.equal(savedJobs[0].status, "ready_to_order");
  assert.equal(savedJobs[0].finalQuote.paymentStatus, "COMPLETE");
  assert.equal(savedJobs[0].finalQuote.shopifyPaidOrderId, "555999");
  assert.ok(savedJobs[0].timeline.some((entry) => entry.type === "balance_paid"));
});

async function waitForHealth(port, child) {
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited before health check: ${stderr}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // Startup race; retry briefly.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Server did not become healthy: ${stderr}`);
}
