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
    researching: "We are still searching across supplier sites, marketplaces, reviews, and public sources.",
    vetting: "We have found possible suppliers and are checking authenticity, reviews, complaint history, and social presence.",
    human_review: "A supplier shortlist is under internal review before we send you a quote or recommendation.",
    quote_ready: "Your sourcing result is ready. Arcovia will contact you with the quote and next steps.",
    no_match: "We have not found a trustworthy match yet. If we cannot find one within the sourcing window, the refundable-deposit rule applies."
  };

  return {
    subject: `Arcovia sourcing update for ${job.orderName}`,
    text: `Hi ${job.customerName || "there"},

Update on your product search:

${stageMessages[status] || stageMessages.researching}

We check supplier trust before recommending anything, including customer reviews, complaint signals, social presence, website/payment risk, and consistency of product claims.

Track the status here:
${statusLink(job)}

Order: ${job.orderName}

Arcovia`
  };
}

export function adminReport(job) {
  const suppliers = job.research?.suppliers || [];
  const supplierText = suppliers.length
    ? suppliers.map((supplier, index) => {
        return `${index + 1}. ${supplier.name || supplier.supplier_name || "Unnamed supplier"}
URL: ${supplier.url || "Not provided"}
Trust score: ${supplier.trust_score ?? "n/a"}
Risk: ${supplier.risk_level || "n/a"}
Recommendation: ${supplier.recommendation || "n/a"}
Red flags: ${Array.isArray(supplier.red_flags) ? supplier.red_flags.join("; ") : supplier.red_flags || "None listed"}
Evidence: ${Array.isArray(supplier.evidence_urls) ? supplier.evidence_urls.join(", ") : supplier.evidence_urls || "None listed"}`;
      }).join("\n\n")
    : "No structured supplier list returned. Check raw report.";

  return {
    subject: `Supplier research report ready: ${job.orderName}`,
    text: `Arcovia supplier research report

Order: ${job.orderName}
Customer: ${job.customerName || "n/a"} <${job.customerEmail || "n/a"}>
Phone / WhatsApp: ${job.customerPhone || "n/a"}
Request:
${job.productRequest || "No request captured"}

Summary:
${job.research?.summary || "No summary provided"}

Supplier shortlist:
${supplierText}

Raw report:
${job.research?.rawText || ""}

Important: review manually before quoting or asking the customer to pay the balance.`
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
