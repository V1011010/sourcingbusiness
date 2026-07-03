# Arcovia AI Sourcing Automation

This service starts a sourcing job when the **R250 Product Sourcing Deposit** order is paid.

It supports two Shopify trigger options:

1. **Recommended:** Shopify Flow → `Order paid` → `Send HTTP request` to `/flow/order-paid`.
2. Native Shopify webhook → `ORDERS_PAID` → `/webhooks/shopify/orders-paid`.

Shopify Flow is the easiest for this store because Arcovia is on Shopify Advanced and Flow supports the `Order paid` trigger plus HTTP requests.

## What the automation does

- Creates a sourcing job immediately after a paid deposit.
- Extracts the product request from order notes, line-item properties, or Flow payload fields.
- If the customer did not provide product details, sends them a unique intake form link.
- Runs AI deep web research with supplier trust checks.
- Repeats sourcing checks up to 10 times if no trusted source passes review.
- Checks for review, complaint, and trust signals such as:
  - supplier website and product match
  - online stores, physical stores, marketplaces, distributors, importers, and wholesalers
  - customer reviews
  - HelloPeter mentions
  - social media presence
  - shipping agents or freight-forwarding options for international sources
  - marketplace reputation
  - payment and delivery risk signals
  - obvious scam/red-flag language
- Removes unsafe/untrusted sources from the supplier shortlist and keeps the rejected-source reasons internally.
- Keeps safe candidates above the customer's budget in the internal report in case there is no cheaper trustworthy option.
- Sends regular customer updates while the search is in progress.
- Sends the internal supplier report to Arcovia for human approval.
- Never buys from a supplier automatically.
- If all 10 checks finish with no trusted source, marks the job `refund_due` and emails Arcovia/customer. The actual payment refund is still a manual Shopify/PayFast action until refund automation is separately tested.

## Local setup

Copy the environment file:

```powershell
Copy-Item .env.example .env
```

Fill in `.env`:

- `OPENAI_API_KEY`
- `PUBLIC_BASE_URL`
- `ARCOVIA_FLOW_SECRET`
- `RESEND_API_KEY` if you want real emails
- `ADMIN_EMAIL`
- `DEEP_RESEARCH_MAX_ATTEMPTS` defaults to `10`
- `RESEARCH_RETRY_DELAY_MINUTES` defaults to `0`, which spreads retries across `MAX_SOURCING_DAYS`

Start:

```powershell
node src/server.js
```

Health check:

```text
GET http://localhost:8787/health
```

Dry-run test:

```powershell
node scripts/dry-run-paid-order.js
```

The dry-run test intentionally uses a blank customer email and no product brief, so it verifies job creation and status-page handling without sending real email or starting paid AI research.

## Shopify Flow setup

Create a Shopify Flow workflow:

1. Trigger: **Order paid**
2. Condition: order contains the deposit product/SKU `ARC-DEPOSIT-250`
3. Action: **Add order tags**
   - `arcovia-ai-sourcing`
   - `sourcing-started`
4. Action: **Send HTTP request**
   - Method: `POST`
   - URL: `https://sourcingbusiness.onrender.com/flow/order-paid`
   - Headers:
     - `Content-Type: application/json`
     - `X-Arcovia-Flow-Secret: YOUR_ARCOVIA_FLOW_SECRET`
   - Body:

```json
{
  "order_id": "{{order.id}}",
  "order_name": "{{order.name}}",
  "email": "{{order.email}}",
  "customer_name": "{{order.customer.displayName}}",
  "note": "{{order.note}}",
  "product_request": "{{order.note}}",
  "line_items": [
    {% for lineItem in order.lineItems %}
    {
      "title": "{{lineItem.title}}",
      "sku": "{{lineItem.sku}}"
    }{% unless forloop.last %},{% endunless %}
    {% endfor %}
  ]
}
```

If the Flow body Liquid fields need adjustment in the Shopify editor, keep the same JSON shape and use the fields Flow exposes for your order.

### Recommended Shopify Admin fallback

Shopify Flow does not always pass every line-item custom field in the HTTP action payload. To make paid-deposit automation reliable, configure these Render environment variables so the backend can fetch the full paid order from Shopify before deciding whether to start AI research:

- `SHOPIFY_STORE_DOMAIN` — your `.myshopify.com` domain, for example `kk09qy-xz.myshopify.com`
- `SHOPIFY_ADMIN_ACCESS_TOKEN` — a custom app Admin API token with `read_orders`
- `SHOPIFY_ADMIN_API_VERSION` — defaults to `2026-04`

With these set, the webhook can receive only the order ID/name from Flow, fetch the order's line-item custom attributes, extract the product brief, and queue AI supplier research immediately.

Optional diagnostics:

- Set `ARCOVIA_ADMIN_STATUS_SECRET`.
- Then call `GET /admin/jobs` with header `X-Arcovia-Admin-Secret: <secret>` to see job status, timeline, whether research is running, attempt count, next research time, supplier count, rejected-source count, and whether the product request was captured.
- For the full internal detail, call `GET /admin/jobs?details=1` with the same header. That includes supplier candidates, rejected sources, shipping agents, web sources, and a raw research preview.

Example PowerShell status check:

```powershell
$secret = "YOUR_ARCOVIA_ADMIN_STATUS_SECRET"
Invoke-RestMethod `
  -Uri "https://sourcingbusiness.onrender.com/admin/jobs?details=1" `
  -Headers @{ "X-Arcovia-Admin-Secret" = $secret }
```

Important status fields:

- `researchRunning: true` means the AI is actively doing a sourcing check right now.
- `researchAttemptCount: 1` through `10` shows how many deep checks have completed or started.
- `nextResearchAt` shows when the next automatic check will run.
- `supplierCount` is the number of trusted sources that survived filtering.
- `candidateSourceCount` is the number of sources the AI found before trust filtering.
- `rejectedSourceCount` is the number removed because they looked unsafe, untrusted, or had poor evidence.
- `refundStatus: manual_refund_required` means the refundable-deposit rule has been triggered and the refund must be processed manually.

## Customer brief capture

The fastest version is to add product-detail fields to the deposit product page later. Until then, this backend sends a secure intake link after payment if the order does not include enough detail.

The intake form asks for customer details first, then asks the customer to choose a product category. After that, it only shows fields that match the category:

- customer name, email, and phone number
- category-specific product description
- category-specific condition choices
- category-specific preference choices
- custom follow-up textboxes for that category, such as clothing size, shoe fit, vehicle model/year, machinery power/certifications, or device compatibility
- item budget and notes/links/photos

For example, machinery uses industrial condition and supplier-authenticity options and does not offer replica-style choices.

## Safety rules

- The AI can shortlist suppliers, but Arcovia must approve the supplier before quoting the customer.
- Do not tell customers a supplier is “safe” unless the report contains clear supporting evidence.
- Do not accuse a supplier of fraud in customer emails. Use internal wording like “red flags found” and cite sources internally.
- Do not auto-purchase from suppliers.
- If no trustworthy supplier is found after all deep checks or within the agreed timeframe, the system marks the job `refund_due`; process the payment refund manually until live refund automation has been separately tested and approved.
