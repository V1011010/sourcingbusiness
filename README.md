# Arcovia Sourcing Automation

This service starts a sourcing job when the **R250 Product Sourcing Deposit** order is paid.

It supports two Shopify trigger options:

1. **Recommended:** Shopify Flow → `Order paid` → `Send HTTP request` to `/flow/order-paid`.
2. Native Shopify webhook → `ORDERS_PAID` → `/webhooks/shopify/orders-paid`.

Shopify Flow is the easiest for this store because Arcovia is on Shopify Advanced and Flow supports the `Order paid` trigger plus HTTP requests.

## What the automation does

- Creates a sourcing job immediately after a paid deposit.
- Extracts the product request from order notes, line-item properties, or Flow payload fields.
- If the customer did not provide product details, sends them a unique intake form link.
- Runs deep web research with supplier trust checks.
- Runs 3 deep sourcing searches total for every paid request before final outcome.
- The first pass is the super-deep search; pass 2 and pass 3 use different search angles and expansion/confirmation checks.
- If a trusted source is found early, the worker still completes all 3 passes before sending customer options.
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
- Captures multiple source/product images per option where available. Images are filtered so customer options do not borrow pictures from other suppliers and do not use obvious logos, banners, placeholders, profile pictures, or generic unrelated images.
- Never buys from a supplier automatically.
- Lets the customer choose an anonymized approved option, then moves the job into final-quote verification.
- Creates a private `/quote/...` page for the final confirmed total and PayFast balance payment.
- Confirms final payments only through the PayFast notification endpoint, not just the customer return page.
- Blocks live final-payment links until persistent storage is configured, so quote/payment state is not lost on Render restarts.
- If all 3 deep searches finish with no trusted source, marks the job `refund_due` and emails Arcovia/customer that no trusted supplier/source was found. The actual payment refund is still a manual Shopify/PayFast action until refund automation is separately tested.
- Optional local worker mode lets an always-on Windows PC run supplier research through the signed-in local CLI instead of the hosted research API.
- The local worker runs as a multi-agent sourcing team by default: online retail, local physical/services, manufacturers/wholesale/fabrics, trust/risk, and shipping/total-cost agents.

## Local setup

Copy the environment file:

```powershell
Copy-Item .env.example .env
```

Fill in `.env`:

- `OPENAI_API_KEY`
- `PUBLIC_BASE_URL`
- `ARCOVIA_FLOW_SECRET`
- `RESEND_API_KEY` if you want real emails through Resend
- `EMAIL_PROVIDER=ses` uses Amazon SES through HTTPS, which works on Render Free
- `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are required for a dedicated least-privilege SES API user
- `EMAIL_ADMIN_RELAY_ON_FAILURE=true` copies safe customer emails to admin when Resend blocks customer delivery because the sender domain is not verified
- `ADMIN_EMAIL`
- `DEEP_RESEARCH_MAX_ATTEMPTS` defaults to `3`; the current worker policy is fixed at 3 completed deep research passes total
- `DEEP_RESEARCH_NO_MATCH_RETRIES` defaults to `2`
- `DEEP_RESEARCH_CONFIRMATION_CHECKS_AFTER_FOUND` defaults to `2`; the current worker policy still completes 3 total passes rather than stopping early
- `RESEARCH_RETRY_DELAY_MINUTES` defaults to `5`
- `OPENAI_WEB_SEARCH_CONTEXT_SIZE` defaults to `high` for the super-deep sourcing pass
- `RESEARCH_TECHNICAL_RETRY_DELAY_MINUTES` defaults to `10`; technical API/rate-limit errors retry quickly and do not count as one of the sourcing checks
- `LOCAL_CODEX_WORKER_ENABLED=true` makes the hosted backend wait for the local Codex worker instead of calling OpenAI directly
- `LOCAL_CODEX_MULTI_AGENT_ENABLED=true` makes each local research pass run multiple focused sourcing agents
- `LOCAL_CODEX_AGENT_CONCURRENCY=2` controls how many local Codex agents run at once
- `LOCAL_CODEX_MODEL=gpt-5.5` keeps sourcing on GPT-5.5 by default
- `LOCAL_CODEX_REASONING_EFFORT=xhigh` runs each sourcing-agent pass at extra-high reasoning effort by default
- `ARCOVIA_LOCAL_WORKER_SECRET` can be set separately; if blank, the worker uses `ARCOVIA_FLOW_SECRET`
- `ARCOVIA_DATA_DIR` can point to a persistent storage directory, for example a Render persistent disk mount path
- `PAYFAST_MERCHANT_ID`, `PAYFAST_MERCHANT_KEY`, and `PAYFAST_PASSPHRASE` enable final balance payments
- `PAYFAST_SANDBOX=true` keeps quote payments in sandbox while testing

Start:

```powershell
node src/server.js
```

Health check:

```text
GET http://localhost:8787/health
```

## Free local production runtime

Arcovia can run without paid Render storage when the owner's Windows computer stays online. The local production runtime starts and supervises:

- the Arcovia HTTP server on port `8787`
- the local multi-agent sourcing worker
- a named Cloudflare Tunnel for Shopify callbacks and private customer links
- Gmail SMTP delivery using a revocable Google App Password
- six-hourly local backups of `jobs.json` and `outbox.json`

Local production values:

```env
PUBLIC_BASE_URL=https://sourcing.arcovia.africa
ARCOVIA_DATA_DIR=C:/absolute/path/to/sourcing/data
ARCOVIA_LOCAL_BASE_URL=http://127.0.0.1:8787
LOCAL_CODEX_WORKER_ENABLED=true
EMAIL_PROVIDER=smtp
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=arcovia.africa@gmail.com
SMTP_FROM_EMAIL=Arcovia <arcovia.africa@gmail.com>
REPLY_TO_EMAIL=arcovia.africa@gmail.com
CLOUDFLARE_TUNNEL_NAME=arcovia-sourcing
```

Keep `SMTP_PASSWORD`, Shopify client credentials, Flow secrets, and any Cloudflare tunnel token out of Git. `START_ARCOVIA_LOCAL.cmd` loads those values from the current user's Windows environment and then loads non-secret settings from `.env`.

Start, inspect, or stop the full local runtime with:

```text
START_ARCOVIA_LOCAL.cmd
STATUS_ARCOVIA_LOCAL.cmd
STOP_ARCOVIA_LOCAL.cmd
```

The customer and Shopify URLs only work while the computer, internet connection, and Cloudflare Tunnel are online. Configure the supplied start command to run at Windows logon after the Gmail and Cloudflare account steps are complete.

Dry-run test:

```powershell
node scripts/dry-run-paid-order.js
```

The dry-run test intentionally uses a blank customer email and no product brief, so it verifies job creation and status-page handling without sending real email or starting paid research.

## Local worker mode

Use this when the store owner's computer is always on and the local worker is signed in with subscription access.

Hosted backend:

```env
LOCAL_CODEX_WORKER_ENABLED=true
```

Local PC `.env`:

```env
PUBLIC_BASE_URL=https://sourcingbusiness.onrender.com
ARCOVIA_FLOW_SECRET=the-same-secret-used-in-shopify-flow
```

Then start the worker from the repo folder:

```powershell
node scripts/local-codex-worker.js
```

By default, each claimed research job runs these focused local agents and merges their reports before submitting:

1. Online stores and marketplaces.
2. Local physical stores and service providers.
3. Manufacturers, wholesalers, factories, and fabrics.
4. Trust, reviews, complaint, and scam-risk checks.
5. Shipping, import, duties, and total landed cost.

Control the load on the PC:

```env
LOCAL_CODEX_MULTI_AGENT_ENABLED=true
LOCAL_CODEX_AGENT_CONCURRENCY=2
LOCAL_CODEX_WORKER_LEASE_MINUTES=20
```

To temporarily use the old single-agent worker:

```powershell
node scripts/local-codex-worker.js --single-agent
```

Or double-click:

```text
scripts/start-local-codex-worker.cmd
```

The Windows start script supervises the local worker and restarts it after unexpected exits. To stop it intentionally, run:

```text
scripts/stop-local-codex-worker.cmd
```

To check the live PID, model, effort, and last poll:

```text
scripts/status-local-codex-worker.cmd
```

To test one poll without leaving it running:

```powershell
node scripts/local-codex-worker.js --once
```

How it works:

1. Shopify paid deposit creates a sourcing job on Render.
2. Render does not call the hosted research API when local worker mode is enabled.
3. The local worker claims the next ready job from `/local-worker/claim`.
4. The worker renews a short lease through `/local-worker/heartbeat` while the research agents are active, so a stopped/restarted worker cannot strand an order for hours.
5. The worker runs `codex exec` locally with a structured JSON schema.
6. The worker posts the supplier report back to `/local-worker/report`.
7. Arcovia reviews suppliers in `/review` and manually chooses one.

Keep the PC awake, online, and signed in. If the local session logs out or the PC sleeps, new research jobs wait until the worker is running again.

Customer email delivery is still handled by the backend email system, not by free-form Codex drafting. That is intentional: automatic customer emails must pass the customer-safety guard before sending. Codex/Gmail can be used manually from a Codex session to create or send a reviewed message, but the live automation should use Resend, Gmail SMTP, or another real mail API for automatic delivery.

## Amazon SES email setup

Amazon SES is the recommended production email provider for Arcovia because it is cheap and reliable. On Render Free, use the SES HTTPS API because Render blocks outbound SMTP ports on free web services.

Recommended SES region: `eu-west-1` / Europe Ireland.

Recommended SES region: Europe (Ireland), `eu-west-1`. Use:

```env
EMAIL_PROVIDER=ses
AWS_ACCESS_KEY_ID=your-limited-ses-api-access-key
AWS_SECRET_ACCESS_KEY=your-limited-ses-api-secret
SMTP_HOST=email-smtp.eu-west-1.amazonaws.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_FROM_EMAIL=Arcovia <updates@arcovia.africa>
REPLY_TO_EMAIL=arcovia.africa@gmail.com
AWS_SES_REGION=eu-west-1
AWS_SES_DOMAIN=arcovia.africa
```

The API credentials must belong to a dedicated least-privilege IAM user that can send email through SES. Add them to Render as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`; never commit them.

SMTP remains available for a paid host that allows outbound SMTP. In that case, add the SES SMTP credentials in Render:

```env
SMTP_USER=your-ses-smtp-username
SMTP_PASSWORD=your-ses-smtp-password
```

Do not use normal AWS access keys as the SMTP password. Amazon SES SMTP credentials are separate from normal AWS access keys.

### AWS console steps

1. Open AWS SES in region `Europe (Ireland) eu-west-1`.
2. Go to Configuration → Identities.
3. Create identity → Domain.
4. Enter `arcovia.africa`.
5. Enable Easy DKIM.
6. Copy the DNS records SES gives you.
7. Add those DNS records wherever your domain DNS is hosted. Public DNS currently shows `arcovia.africa` using Google DNS nameservers: `ns-cloud-a1.googledomains.com` through `ns-cloud-a4.googledomains.com`.
8. Wait until SES shows the domain identity as verified.
9. Create a dedicated IAM access key with only SES sending permission for the HTTPS API.
10. Put its access key ID/secret into Render as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.
11. Set `EMAIL_PROVIDER=ses`.
12. Request production access to move SES out of sandbox.

Until production access is approved, SES sandbox can only send to verified recipient addresses. After production access is approved, SES can send to any customer address, but the From domain still must stay verified.

Optional AWS CLI start, once AWS CLI is installed and logged in:

```powershell
aws sesv2 create-email-identity --region eu-west-1 --email-identity arcovia.africa
aws sesv2 get-email-identity --region eu-west-1 --email-identity arcovia.africa
```

The second command returns DKIM tokens/records to add in DNS. For this Render Free deployment, create limited IAM API credentials for sending email and add them to Render; do not use SMTP credentials as AWS API keys.

## Temporary email fallback

Resend's free plan can send production emails, but Resend requires a verified sending domain to send to real customer addresses. The default `onboarding@resend.dev` sender is only for testing and can only send to the Resend account's own email address.

Until the Arcovia domain is verified in Resend, use one of these fallbacks:

### Option A: Gmail SMTP fallback

Set these Render environment variables:

```env
EMAIL_PROVIDER=auto
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=arcovia.africa@gmail.com
SMTP_PASSWORD=your-google-app-password
SMTP_FROM_EMAIL=Arcovia <arcovia.africa@gmail.com>
REPLY_TO_EMAIL=arcovia.africa@gmail.com
```

Use a Google App Password, not the normal Gmail password.

### Option B: Admin relay while Resend is blocked

If Gmail SMTP is not configured yet, keep:

```env
EMAIL_ADMIN_RELAY_ON_FAILURE=true
RESEND_TEST_FROM_EMAIL=Arcovia <onboarding@resend.dev>
EMAIL_OUTBOX_COUNTS_AS_SENT=false
```

When Resend blocks a customer email because the domain is not verified, the backend tries to send a copy to `ADMIN_EMAIL` with the original customer recipient and safe message body. It does not mark the customer email as sent. Use this only as a temporary manual-forwarding fallback.

## Persistent job storage

By default, this app stores jobs in `data/jobs.json`. That is fine locally, but hosted services can lose local files when they redeploy or restart unless persistent storage is attached.

For Render production use:

1. Use the checked-in `render.yaml` Blueprint, which declares a persistent disk named `arcovia-data`.
2. The disk mount path is `/var/data`.
3. `ARCOVIA_DATA_DIR=/var/data` is set in the Blueprint.
4. If Render does not apply the Blueprint disk automatically to the existing service, add the disk manually from the Render service's Disks page with the same mount path.
5. Redeploy.

After that, `/health` will show `features.storage.dataDirConfigured: true`.

Final product-balance payments stay blocked until persistent storage is active, unless `ARCOVIA_ALLOW_TEMP_PAYMENT_STORAGE=true` is set for local sandbox testing. Do not enable that override for real customers.

## Final quote, Shopify checkout, and PayFast balance flow

1. Customer pays the R250 deposit in Shopify.
2. The sourcing worker completes 3 deep checks.
3. The customer receives a private options link showing only anonymous approved options.
4. When the customer chooses an option, the job moves to `quote_verifying`.
5. Arcovia confirms live availability, delivery, duties/import handling, and final price.
6. In the monitor/review page, Arcovia enters the final rand amount and sends the final quote link.
7. The backend creates or refreshes one anonymous Shopify draft order with SKU `ARC-FINAL-BALANCE`. Its single custom line is non-taxable, non-shipping, and exactly equal to the verified all-inclusive ZAR total. Automatic discounts and checkout discount codes are disabled so the amount cannot drift.
8. The customer's `Pay now` button opens Shopify's secure invoice checkout, where the customer chooses the store's configured PayFast payment method.
9. A paid-order Flow request or signed native `ORDERS_PAID` webhook is matched to the Arcovia job and quote IDs. The backend verifies `PAID`, ZAR, and the exact amount before marking the job `ready_to_order`.
10. If Shopify draft checkout is unavailable before any invoice is created, the existing signed direct-PayFast checkout is used as a fallback when its merchant credentials are configured. `/payfast/notify` remains the only confirmation path for that fallback.
11. Arcovia places the supplier order manually and updates the monitor with order reference, tracking number/link, and ETA.

Customer emails are guarded so they only contain Arcovia links and never include supplier names, supplier URLs, raw evidence, rejected-source details, or the word "AI".

## Shopify Flow setup

Create the sourcing-deposit Shopify Flow workflow:

1. Trigger: **Order paid**
2. Condition: order contains the deposit product/SKU `ARC-DEPOSIT-250`
3. Action: **Add order tags**
   - `arcovia-sourcing`
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

Create a second **Order paid** Flow for final balances:

1. Condition: order contains SKU `ARC-FINAL-BALANCE`.
2. Send an HTTP request to the same `/flow/order-paid` URL.
3. Add header `X-Arcovia-Final-Flow-Secret`; its value must match `ARCOVIA_FINAL_FLOW_SECRET` in Render.
4. The body only needs the order ID and name because the backend securely fetches and verifies the final-balance SKU, Arcovia job/quote attributes, paid status, currency, and total from Shopify:

```json
{
  "order_id": "{{order.id}}",
  "order_name": "{{order.name}}"
}
```

Do not point the final-balance Flow back into the deposit-only workflow. The backend also checks `ARC-FINAL-BALANCE` before processing it, so a final payment cannot create a new sourcing job.

### Recommended Shopify Admin fallback

Shopify Flow does not always pass every line-item custom field in the HTTP action payload. To make paid-deposit automation reliable, configure these Render environment variables so the backend can fetch the full paid order from Shopify before deciding whether to start supplier research:

- `SHOPIFY_STORE_DOMAIN` — your `.myshopify.com` domain, for example `kk09qy-xz.myshopify.com`
- `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` — credentials for an installed Dev Dashboard app with `read_orders`, `read_draft_orders`, and `write_draft_orders`; the backend refreshes its 24-hour Admin API token automatically
- `SHOPIFY_ADMIN_ACCESS_TOKEN` — legacy alternative for an older admin-created app with the same scopes
- `SHOPIFY_ADMIN_API_VERSION` — defaults to `2026-04`
- `SHOPIFY_FINAL_CHECKOUT_ENABLED=true` — prefer Shopify draft-order checkout for verified final quotes

After changing custom-app scopes, install/update the app in the store and replace the Render token if Shopify issues a new one. With these settings, the webhook can receive only the order ID/name from Flow, fetch the order safely, distinguish deposits from final balances, and prepare secure final checkout links.

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

- `researchRunning: true` means sourcing research is actively running right now.
- `researchAttemptCount: 1` through `3` shows how many deep checks have completed or started.
- `nextResearchAt` shows when the next automatic check will run.
- `deepResearchSearchContextSize`, `deepResearchReasoningEffort`, and `deepResearchMaxOutputTokens` are exposed on `/health` so you can confirm Render is using the safe OpenAI settings.
- `supplierCount` is the number of trusted sources that survived filtering.
- `candidateSourceCount` is the number of sources found before trust filtering.
- `rejectedSourceCount` is the number removed because they looked unsafe, untrusted, or had poor evidence.
- `refundStatus: manual_refund_required` means the refundable-deposit rule has been triggered and the refund must be processed manually.

## Customer brief capture

The fastest version is to add product-detail fields to the deposit product page later. Until then, this backend sends a secure intake link after payment if the order does not include enough detail.

The intake form asks for customer details first, then asks the customer to choose a product category. After that, it only shows fields that match the category:

- customer name, email, and phone number
- category-specific request description, including products, services, manufacturers/factories, and fabrics/textiles
- category-specific condition choices
- category-specific preference choices
- custom follow-up textboxes for that category, such as clothing size, shoe fit, vehicle model/year, machinery power/certifications, service location/problem details, manufacturing specialty/materials/MOQ, fabric composition/colour/quantity, or device compatibility
- item, service, manufacturing, or fabric budget and notes/links/photos

For example, machinery uses industrial condition and supplier-authenticity options and does not offer replica-style choices.
Services ask for the service type, location, timing, problem/event details, provider requirements, and budget. Manufacturers/factories ask for specialty, materials, quantity/MOQ, specs, compliance, and budget. Fabrics/textiles ask for material composition, colour/texture, width/weight/quantity, use case, delivery area, and budget.

## Safety rules

- The system can shortlist suppliers, but Arcovia must approve the supplier before quoting the customer.
- Do not tell customers a supplier is “safe” unless the report contains clear supporting evidence.
- Do not accuse a supplier of fraud in customer emails. Use internal wording like “red flags found” and cite sources internally.
- Do not auto-purchase from suppliers.
- If no trustworthy supplier is found after all deep checks or within the agreed timeframe, the system marks the job `refund_due`; process the payment refund manually until live refund automation has been separately tested and approved.
