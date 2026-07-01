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
- Runs AI web research with supplier trust checks.
- Checks for review, complaint, and trust signals such as:
  - supplier website and product match
  - customer reviews
  - HelloPeter mentions
  - social media presence
  - marketplace reputation
  - payment and delivery risk signals
  - obvious scam/red-flag language
- Sends regular customer updates while the search is in progress.
- Sends the internal supplier report to Arcovia for human approval.
- Never buys from a supplier automatically.

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

## Shopify Flow setup

Create a Shopify Flow workflow:

1. Trigger: **Order paid**
2. Condition: order contains the deposit product/SKU `ARC-SOURCE-250`
3. Action: **Add order tags**
   - `arcovia-ai-sourcing`
   - `sourcing-started`
4. Action: **Send HTTP request**
   - Method: `POST`
   - URL: `https://YOUR_PUBLIC_URL/flow/order-paid`
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

## Customer brief capture

The fastest version is to add product-detail fields to the deposit product page later. Until then, this backend sends a secure intake link after payment if the order does not include enough detail.

The intake form asks the customer to choose a product category first. After that, it only shows fields that match the category:

- category-specific product description
- category-specific condition choices
- category-specific preference choices
- size only where size or fit matters, such as clothing, shoes, jewellery, and sport fit items
- item specifications, budget, deadline, and notes/links/photos

For example, machinery uses industrial condition and supplier-authenticity options and does not offer replica-style choices.

## Safety rules

- The AI can shortlist suppliers, but Arcovia must approve the supplier before quoting the customer.
- Do not tell customers a supplier is “safe” unless the report contains clear supporting evidence.
- Do not accuse a supplier of fraud in customer emails. Use internal wording like “red flags found” and cite sources internally.
- Do not auto-purchase from suppliers.
- If no trustworthy supplier is found within the agreed timeframe, process the refundable deposit rule.
