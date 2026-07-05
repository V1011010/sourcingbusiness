import { config } from "./config.js";

export function briefLink(job) {
  return `${config.publicBaseUrl.replace(/\/$/, "")}/brief/${job.publicToken}`;
}

export function statusLink(job) {
  return `${config.publicBaseUrl.replace(/\/$/, "")}/status/${job.publicToken}`;
}

export function customerOptionsLink(job) {
  return `${config.publicBaseUrl.replace(/\/$/, "")}/options/${job.customerOptionsToken}`;
}

export function depositReceived(job) {
  if (job.productRequest?.trim()) {
    return {
      subject: `Arcovia sourcing started for ${job.orderName}`,
      text: `Hi ${job.customerName || "there"},

We received your R250 sourcing deposit and the AI sourcing process has started.

Current stage: searching for possible suppliers and product matches.

We will update you regularly as we search, review suppliers, and check trust signals.

Track the status here:
${statusLink(job)}

Order: ${job.orderName}

Arcovia`
    };
  }

  return {
    subject: `Arcovia received your sourcing deposit`,
    text: `Hi ${job.customerName || "there"},

We received your R250 sourcing deposit for ${job.orderName}.

Before the AI can start the supplier search, please send the product details here:
${briefLink(job)}

You can track the status here:
${statusLink(job)}

Please include your contact details, item category, exact item name, condition, budget, and any category-specific details, reference links, or photos.

Arcovia`
  };
}

export function customerOptionsReady(job) {
  const suppliers = job.research?.suppliers || [];

  return {
    subject: `Your Arcovia sourcing options are ready: ${job.orderName}`,
    text: `Hi ${job.customerName || "there"},

Arcovia has completed the supplier research for your request.

We found ${suppliers.length} approved option${suppliers.length === 1 ? "" : "s"} that passed our initial sourcing checks. For safety and to protect Arcovia's sourcing process, the options are shown anonymously as Supplier 1, Supplier 2, and so on.

You can view the approved options, prices, and product pictures here:
${customerOptionsLink(job)}

Choose the option you prefer. Arcovia will still confirm final availability, delivery, and the final quote before any purchase is made.

Order: ${job.orderName}

Arcovia`
  };
}

export function stageUpdate(job) {
  const status = job.status || "researching";
  const stageMessages = {
    awaiting_brief: "We are waiting for your product brief so we can begin the supplier search.",
    researching: "We are still searching across online stores, physical stores, marketplaces, suppliers, distributors, reviews, complaint sites, social signals, and shipping options.",
    vetting: "We have found possible suppliers and are checking authenticity, reviews, complaint history, and social presence.",
    human_review: "Supplier options are under Arcovia review. When the approved shortlist is complete, you will receive a private options link to choose from.",
    supplier_selected: "Arcovia has selected a supplier/source for internal follow-up. We will confirm the final quote and next steps before any purchase is made.",
    quote_ready: "Your sourcing result is ready. Arcovia will contact you with the quote and next steps.",
    no_match: "We have not found a trustworthy match yet. If we cannot find one within the sourcing window, the refundable-deposit rule applies.",
    refund_due: "We completed all 3 deep research checks and could not find a trusted supplier/source we are comfortable recommending. Your refundable deposit is now marked for refund processing."
  };
  const progressLine = researchProgressLine(job);

  return {
    subject: `Arcovia sourcing update for ${job.orderName}`,
    text: `Hi ${job.customerName || "there"},

Update on your product search:

${stageMessages[status] || stageMessages.researching}
${progressLine ? `\n${progressLine}` : ""}

We check supplier trust before recommending anything, including customer reviews, complaint signals, social presence, website/payment risk, and consistency of product claims.

Track the status here:
${statusLink(job)}

Order: ${job.orderName}

Arcovia`
  };
}

export function customerOptionSelectedAdmin(job) {
  const selected = job.customerSelectedOption || {};
  const supplier = selected.supplier || {};
  const optionLabel = selected.optionLabel || `Supplier ${Number(selected.index || 0) + 1}`;

  return {
    subject: `Customer selected ${optionLabel}: ${job.orderName}`,
    text: `Arcovia customer option selected

Order: ${job.orderName}
Customer: ${job.customerName || "n/a"} <${job.customerEmail || "n/a"}>
Customer choice shown as: ${optionLabel}
Selected at: ${selected.selectedAt || "n/a"}

Internal supplier details:
Supplier/source: ${supplier.name || supplier.supplier_name || "Unnamed supplier"}
URL: ${supplier.url || "Not provided"}
Price: ${supplier.price || "n/a"}
Estimated total in rand: ${displayRandTotal(supplier)}
Availability: ${supplier.availability || "n/a"}
Trust score: ${supplier.trust_score ?? "n/a"}
Risk: ${supplier.risk_level || "n/a"}

Next step:
Review the selected supplier internally, confirm availability and delivery, then contact the customer with the final quote/payment instructions. Do not order automatically.`
  };
}

export function adminReport(job) {
  const suppliers = job.research?.suppliers || [];
  const candidates = job.research?.candidateSources || [];
  const rejected = job.research?.rejectedSources || [];
  const shippingAgents = job.research?.shippingAgents || [];
  const supplierText = suppliers.length
    ? suppliers.map((supplier, index) => {
        return `${index + 1}. ${supplier.name || supplier.supplier_name || "Unnamed supplier"}
Type: ${supplier.source_type || "n/a"}
URL: ${supplier.url || "Not provided"}
Price: ${supplier.price || "n/a"}
Estimated total: ${supplier.estimated_total_to_customer || "n/a"}
Availability: ${supplier.availability || "n/a"}
Location: ${supplier.location || "n/a"}
Delivery / pickup: ${supplier.delivery_or_pickup || "n/a"}
Trust score: ${supplier.trust_score ?? "n/a"}
Risk: ${supplier.risk_level || "n/a"}
Recommendation: ${supplier.recommendation || "n/a"}
Red flags: ${Array.isArray(supplier.red_flags) ? supplier.red_flags.join("; ") : supplier.red_flags || "None listed"}
Evidence: ${Array.isArray(supplier.evidence_urls) ? supplier.evidence_urls.join(", ") : supplier.evidence_urls || "None listed"}`;
      }).join("\n\n")
    : "No structured supplier list returned. Check raw report.";
  const shippingText = shippingAgents.length
    ? shippingAgents.map((agent, index) => `${index + 1}. ${agent.name || "Unnamed shipping agent"}
URL: ${agent.url || "n/a"}
Route/countries: ${agent.countries_supported || "n/a"}
Estimated cost: ${agent.estimated_cost || "n/a"}
Trust score: ${agent.trust_score ?? "n/a"}
Risk: ${agent.risk_level || "n/a"}
Evidence: ${Array.isArray(agent.evidence_urls) ? agent.evidence_urls.join(", ") : agent.evidence_urls || "None listed"}
Notes: ${agent.notes || "n/a"}`).join("\n\n")
    : "No shipping-agent shortlist returned.";
  const rejectedText = rejected.length
    ? rejected.slice(0, 20).map((source, index) => `${index + 1}. ${source.name || "Unnamed source"}
URL: ${source.url || "n/a"}
Reason removed: ${source.reason || "n/a"}
Evidence: ${Array.isArray(source.evidence_urls) ? source.evidence_urls.join(", ") : source.evidence_urls || "None listed"}`).join("\n\n")
    : "No rejected sources listed.";

  return {
    subject: `Supplier research report ready: ${job.orderName}`,
    text: `Arcovia supplier research report

Order: ${job.orderName}
Customer: ${job.customerName || "n/a"} <${job.customerEmail || "n/a"}>
Phone number: ${job.customerPhone || "n/a"}
Research attempts: ${job.researchAttemptCount || 0}/${displayMaxAttempts(job)}
Trusted suppliers: ${suppliers.length}
Candidate sources checked: ${candidates.length}
Rejected unsafe/untrusted sources: ${rejected.length}
Request:
${job.productRequest || "No request captured"}

Summary:
${job.research?.summary || "No summary provided"}

Supplier shortlist:
${supplierText}

Shipping agents / import support:
${shippingText}

Rejected sources:
${rejectedText}

Raw report:
${job.research?.rawText || ""}

Important: review manually before quoting or asking the customer to pay the balance.`
  };
}

export function adminRefundDue(job) {
  return {
    subject: `Refund due: no trusted source found for ${job.orderName}`,
    text: `Arcovia refund due notice

Order: ${job.orderName}
Customer: ${job.customerName || "n/a"} <${job.customerEmail || "n/a"}>
Status: ${job.status}
Research attempts: ${job.researchAttemptCount || 0}/${displayMaxAttempts(job)}
Reason: ${job.refundReason || "No trusted source found."}

Candidate sources checked: ${job.research?.candidateSources?.length || 0}
Rejected unsafe/untrusted sources: ${job.research?.rejectedSources?.length || 0}

Request:
${job.productRequest || "No request captured"}

Action needed:
Process the customer's refundable R250 deposit manually in Shopify/PayFast, then update the order/admin records.`
  };
}

export function customerRefundDue(job) {
  return {
    subject: `No trusted supplier found for ${job.orderName}`,
    text: `Hi ${job.customerName || "there"},

We completed all 3 deep sourcing checks for your request, but we could not find a trusted supplier/source that we are comfortable recommending.

Your R250 sourcing deposit is therefore marked for refund processing under the refundable-deposit rule.

Track the status here:
${statusLink(job)}

Order: ${job.orderName}

Arcovia`
  };
}

export function researchFailure(job, errorMessage) {
  return {
    subject: `Arcovia AI research failed: ${job.orderName}`,
    text: `Arcovia AI supplier research failed.

Order: ${job.orderName}
Customer: ${job.customerName || "n/a"} <${job.customerEmail || "n/a"}>
Status: ${job.status}

Request:
${job.productRequest || "No request captured"}

Failure:
${errorMessage}

Fix the API/config issue, then retry the paid-order webhook or ask Codex to reprocess the order.`
  };
}

function researchProgressLine(job) {
  const maxAttempts = displayMaxAttempts(job);
  const attempt = Math.min(job.researchAttemptCount || 0, maxAttempts);
  const nextResearchAt = job.nextResearchAt
    ? new Date(job.nextResearchAt).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" })
    : "";
  const base = attempt ? `Research checks completed: ${attempt}/${maxAttempts}. Policy: Arcovia runs 3 deep research passes total before sending final customer options or the no-supplier/refund email.` : "";
  return [base, nextResearchAt ? `Next check: ${nextResearchAt}.` : ""].filter(Boolean).join(" ");
}

function displayMaxAttempts(job) {
  return Math.min(3, Math.max(1, Number(job.maxResearchAttempts || config.deepResearchMaxAttempts || 3)));
}

function displayRandTotal(source) {
  const direct = source.estimated_total_zar || source.approx_total_zar || source.total_zar || "";
  if (direct) return direct;
  const total = source.estimated_total_to_customer || "";
  if (/\bZAR\b|(^|\s)R\s?\d/i.test(total)) return total;
  const price = source.price || "";
  if (/\bZAR\b|(^|\s)R\s?\d/i.test(price)) return price;
  return total || price || "Needs ZAR estimate";
}
