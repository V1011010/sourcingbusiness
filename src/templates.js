import { config } from "./config.js";

export function briefLink(job) {
  return `${config.publicBaseUrl.replace(/\/$/, "")}/brief/${job.publicToken}`;
}

export function statusLink(job) {
  return `${config.publicBaseUrl.replace(/\/$/, "")}/status/${job.publicToken}`;
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

export function stageUpdate(job) {
  const status = job.status || "researching";
  const stageMessages = {
    awaiting_brief: "We are waiting for your product brief so we can begin the supplier search.",
    researching: "We are still searching across online stores, physical stores, marketplaces, suppliers, distributors, reviews, complaint sites, social signals, and shipping options.",
    vetting: "We have found possible suppliers and are checking authenticity, reviews, complaint history, and social presence.",
    human_review: "A supplier shortlist is under internal review before we send you a quote or recommendation.",
    supplier_selected: "Arcovia has selected a supplier/source for internal follow-up. We will confirm the final quote and next steps before any purchase is made.",
    quote_ready: "Your sourcing result is ready. Arcovia will contact you with the quote and next steps.",
    no_match: "We have not found a trustworthy match yet. If we cannot find one within the sourcing window, the refundable-deposit rule applies.",
    refund_due: "We could not verify a trustworthy source after the agreed sourcing checks. Your refundable deposit is now marked for refund processing."
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
Research attempts: ${job.researchAttemptCount || 0}/${job.maxResearchAttempts || config.deepResearchMaxAttempts}
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
Research attempts: ${job.researchAttemptCount || 0}/${job.maxResearchAttempts || config.deepResearchMaxAttempts}
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
    subject: `Arcovia sourcing refund update for ${job.orderName}`,
    text: `Hi ${job.customerName || "there"},

We completed the sourcing checks for your request, but we could not verify a trustworthy source that we are comfortable recommending.

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
  const attempt = job.researchAttemptCount || 0;
  const maxAttempts = job.maxResearchAttempts || config.deepResearchMaxAttempts;
  const nextResearchAt = job.nextResearchAt
    ? new Date(job.nextResearchAt).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" })
    : "";
  const base = attempt ? `Research checks completed: ${attempt}/${maxAttempts}.` : "";
  return [base, nextResearchAt ? `Next check: ${nextResearchAt}.` : ""].filter(Boolean).join(" ");
}
