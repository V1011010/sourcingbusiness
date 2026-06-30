# Arcovia AI Sourcing Go-Live Checklist

## What Codex already prepared

The backend is already built in this folder. It can:

- receive the Shopify paid-deposit trigger
- ignore non-deposit orders
- create a sourcing job
- collect missing customer product details
- run AI supplier research
- write/send customer updates
- send Arcovia the internal supplier vetting report

## What you still need to get

You must create these yourself because they involve private accounts, billing, identity, or domain ownership.

### 1. OpenAI API key

Use this for the AI supplier research.

Steps:

1. Go to `https://platform.openai.com/api-keys`.
2. Log in or create an OpenAI Platform account.
3. Add billing/payment method if the platform asks.
4. Create a new API key.
5. Copy it once and store it safely.
6. Put it in `.env` as:

```text
OPENAI_API_KEY=sk-...
```

Do not send this key in normal chat messages. Paste it only into your private `.env` file or hosting provider environment-variable screen.

### 2. Email sending account

The backend is wired for Resend because it is simple and has a direct HTTP API.

Steps:

1. Go to `https://resend.com`.
2. Create an account.
3. Verify a sending domain or subdomain. Recommended: `updates.arcovia.africa`.
4. Add the DNS records Resend gives you at the DNS provider for `arcovia.africa`.
5. Wait until Resend says the domain is verified.
6. Create an API key with sending access.
7. Put it in `.env` as:

```text
RESEND_API_KEY=re_...
FROM_EMAIL=Arcovia <updates@arcovia.africa>
ADMIN_EMAIL=vutlharingobeni5@gmail.com
```

If Resend is not configured, the backend still works in dry-run mode and writes emails to `data/outbox.json`.

### 3. Public hosting URL

Shopify cannot call your laptop directly. The backend needs a public HTTPS URL.

Recommended beginner route: Render.

Steps:

1. Create a GitHub account if you do not have one.
2. Upload this `arcovia-ai-sourcing` folder to a new private GitHub repository.
3. Go to `https://render.com`.
4. Create an account and connect GitHub.
5. Click **New > Web Service**.
6. Select the repository.
7. Use:
   - Build Command: leave blank or use `npm install`
   - Start Command: `node src/server.js`
   - Runtime: Node
8. Add environment variables from `.env.example`.
9. Deploy.
10. Copy the public URL Render gives you, for example:

```text
https://arcovia-ai-sourcing.onrender.com
```

Then set:

```text
PUBLIC_BASE_URL=https://arcovia-ai-sourcing.onrender.com
```

### 4. Shopify Flow workflow

This makes Shopify call the AI backend only after the deposit is paid.

Steps:

1. In Shopify Admin, go to **Apps > Shopify Flow**.
2. Create a new workflow.
3. Trigger: **Order paid**.
4. Add a condition that the order line item SKU equals:

```text
ARC-SOURCE-250
```

5. Add action: **Add order tags**:

```text
arcovia-ai-sourcing, sourcing-started
```

6. Add action: **Send HTTP request**.
7. Method: `POST`.
8. URL:

```text
https://YOUR_PUBLIC_URL/flow/order-paid
```

9. Headers:

```text
Content-Type: application/json
X-Arcovia-Flow-Secret: YOUR_LONG_RANDOM_SECRET
```

10. Body:

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

11. Turn on the workflow.

Use the same secret value in the backend:

```text
ARCOVIA_FLOW_SECRET=YOUR_LONG_RANDOM_SECRET
```

### 5. Product brief fields

Best version: customers enter product details before checkout.

For now, the backend sends a brief form link if Shopify does not pass product details. That is safe and already working.

Later, add fields to the deposit product page for:

- product name
- size/specs
- preferred condition
- budget
- deadline
- links/photos/notes

Those fields should be saved as Shopify line-item properties so Flow can pass them to the backend.

## Exact environment variables

Copy `.env.example` to `.env` and fill:

```text
PORT=8787
PUBLIC_BASE_URL=https://YOUR_PUBLIC_URL
ARCOVIA_FLOW_SECRET=YOUR_LONG_RANDOM_SECRET
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.5
RESEND_API_KEY=re_...
FROM_EMAIL=Arcovia <updates@arcovia.africa>
ADMIN_EMAIL=vutlharingobeni5@gmail.com
UPDATE_INTERVAL_HOURS=6
MAX_SOURCING_DAYS=14
DEPOSIT_SKU=ARC-SOURCE-250
```

## Testing before real customers

After deployment, open:

```text
https://YOUR_PUBLIC_URL/health
```

It should show:

```json
{
  "ok": true
}
```

Then create a test Shopify order for the R250 deposit, pay using your payment test/sandbox method if available, and confirm:

- Shopify Flow ran
- backend job was created
- customer received the first email
- admin received the supplier report

## Manual approval rule

Do not let the AI buy automatically.

The AI should:

1. Research suppliers.
2. Score trust.
3. Send Arcovia the internal report.
4. Wait for human approval.
5. Then Arcovia sends the customer the quote or refund decision.

