import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import {
  FINAL_BALANCE_SKU,
  buildFinalBalanceDraftInput,
  extractShopifyFinalPaymentDetails,
  prepareShopifyFinalCheckout
} from "../src/shopify.js";

const baseJob = {
  id: "job-123",
  orderName: "#1012",
  customerEmail: "buyer@example.com",
  customerSelectedOption: {
    supplier: {
      name: "Secret Supplier Name",
      url: "https://secret-supplier.example/item"
    }
  },
  finalQuote: {
    id: "quote-456",
    optionLabel: "Supplier 2",
    finalAmountZar: 1234.56,
    verifiedAt: "2026-07-12T08:00:00.000Z"
  }
};

test("buildFinalBalanceDraftInput creates one exact anonymous all-inclusive item", () => {
  const input = buildFinalBalanceDraftInput(baseJob, baseJob.finalQuote);

  assert.equal(input.presentmentCurrencyCode, "ZAR");
  assert.equal(input.taxExempt, true);
  assert.equal(input.acceptAutomaticDiscounts, false);
  assert.equal(input.allowDiscountCodesInCheckout, false);
  assert.equal(input.lineItems.length, 1);
  assert.deepEqual(input.lineItems[0], {
    title: "Arcovia sourced item — Supplier 2",
    sku: FINAL_BALANCE_SKU,
    quantity: 1,
    originalUnitPriceWithCurrency: {
      amount: 1234.56,
      currencyCode: "ZAR"
    },
    requiresShipping: false,
    taxable: false,
    customAttributes: [
      { key: "arcovia_payment_kind", value: "final_balance" },
      { key: "arcovia_job_id", value: "job-123" },
      { key: "arcovia_quote_id", value: "quote-456" }
    ]
  });

  const serialized = JSON.stringify(input);
  assert.doesNotMatch(serialized, /Secret Supplier Name/i);
  assert.doesNotMatch(serialized, /secret-supplier\.example/i);
});

test("extractShopifyFinalPaymentDetails recognizes and links a paid balance order", () => {
  const details = extractShopifyFinalPaymentDetails({
    id: 998877,
    name: "#2020",
    financial_status: "paid",
    total_price: "1234.56",
    currency: "ZAR",
    note_attributes: [
      { name: "arcovia_payment_kind", value: "final_balance" },
      { name: "arcovia_job_id", value: "job-123" },
      { name: "arcovia_quote_id", value: "quote-456" }
    ],
    line_items: [{ sku: FINAL_BALANCE_SKU, title: "Arcovia sourced item — Supplier 2" }]
  });

  assert.deepEqual(details, {
    recognized: true,
    jobId: "job-123",
    quoteId: "quote-456",
    paymentKind: "final_balance",
    financialStatus: "PAID",
    amount: 1234.56,
    currency: "ZAR",
    orderId: "998877",
    orderName: "#2020",
    sku: FINAL_BALANCE_SKU
  });
});

test("prepareShopifyFinalCheckout creates a ZAR draft and returns its invoice URL", { concurrency: false }, async () => {
  const restore = installShopifyConfig();
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), body: JSON.parse(options.body) };
    return jsonResponse({
      data: {
        draftOrderCreate: {
          draftOrder: {
            id: "gid://shopify/DraftOrder/10",
            name: "#D10",
            invoiceUrl: "https://unit-test-store.myshopify.com/123456/invoices/abc",
            status: "OPEN",
            totalPriceSet: {
              presentmentMoney: { amount: "1234.56", currencyCode: "ZAR" },
              shopMoney: { amount: "1234.56", currencyCode: "ZAR" }
            }
          },
          userErrors: []
        }
      }
    });
  };

  try {
    const result = await prepareShopifyFinalCheckout(structuredClone(baseJob));
    assert.equal(result.provider, "shopify");
    assert.equal(result.draftOrderId, "gid://shopify/DraftOrder/10");
    assert.equal(result.amountZar, 1234.56);
    assert.equal(result.currency, "ZAR");
    assert.match(request.url, /\/admin\/api\/2026-04\/graphql\.json$/);
    assert.match(request.body.query, /draftOrderCreate/);
    assert.deepEqual(request.body.variables.input.lineItems[0].originalUnitPriceWithCurrency, {
      amount: 1234.56,
      currencyCode: "ZAR"
    });
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("prepareShopifyFinalCheckout updates the existing draft instead of opening another", { concurrency: false }, async () => {
  const restore = installShopifyConfig();
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return jsonResponse({
      data: {
        draftOrderUpdate: {
          draftOrder: {
            id: "gid://shopify/DraftOrder/10",
            name: "#D10",
            invoiceUrl: "https://unit-test-store.myshopify.com/123456/invoices/abc",
            status: "OPEN",
            totalPriceSet: {
              presentmentMoney: { amount: "1234.56", currencyCode: "ZAR" },
              shopMoney: { amount: "1234.56", currencyCode: "ZAR" }
            }
          },
          userErrors: []
        }
      }
    });
  };

  try {
    const job = structuredClone(baseJob);
    job.finalQuote.shopifyDraftOrderId = "gid://shopify/DraftOrder/10";
    await prepareShopifyFinalCheckout(job);
    assert.match(request.query, /draftOrderUpdate/);
    assert.equal(request.variables.id, "gid://shopify/DraftOrder/10");
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("prepareShopifyFinalCheckout rejects a checkout whose total changed", { concurrency: false }, async () => {
  const restore = installShopifyConfig();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({
    data: {
      draftOrderCreate: {
        draftOrder: {
          id: "gid://shopify/DraftOrder/11",
          name: "#D11",
          invoiceUrl: "https://unit-test-store.myshopify.com/123456/invoices/mismatch",
          status: "OPEN",
          totalPriceSet: {
            presentmentMoney: { amount: "1200.00", currencyCode: "ZAR" },
            shopMoney: { amount: "1200.00", currencyCode: "ZAR" }
          }
        },
        userErrors: []
      }
    }
  });

  try {
    await assert.rejects(
      prepareShopifyFinalCheckout(structuredClone(baseJob)),
      /checkout total mismatch/i
    );
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("prepareShopifyFinalCheckout refuses an unverified research estimate", async () => {
  const restore = installShopifyConfig();
  try {
    const job = structuredClone(baseJob);
    delete job.finalQuote.finalAmountZar;
    job.finalQuote.estimatedAmountZar = 999;
    await assert.rejects(prepareShopifyFinalCheckout(job), /verified positive final quote/i);
  } finally {
    restore();
  }
});

function installShopifyConfig() {
  const previous = {
    shopifyFinalCheckoutEnabled: config.shopifyFinalCheckoutEnabled,
    shopifyStoreDomain: config.shopifyStoreDomain,
    shopifyAdminAccessToken: config.shopifyAdminAccessToken,
    shopifyAdminApiVersion: config.shopifyAdminApiVersion
  };
  config.shopifyFinalCheckoutEnabled = true;
  config.shopifyStoreDomain = "unit-test-store.myshopify.com";
  config.shopifyAdminAccessToken = "test-token";
  config.shopifyAdminApiVersion = "2026-04";
  return () => Object.assign(config, previous);
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  };
}
