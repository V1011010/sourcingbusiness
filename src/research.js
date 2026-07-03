import { config } from "./config.js";
import { sendEmail } from "./email.js";
import { adminReport, researchFailure, stageUpdate } from "./templates.js";
import { addTimeline, getJob, upsertJob } from "./storage.js";

const runningJobs = new Set();

export function queueResearch(jobId) {
  if (runningJobs.has(jobId)) return;
  runningJobs.add(jobId);
  setTimeout(async () => {
    try {
      await runResearch(jobId);
    } catch (error) {
      const job = getJob(jobId);
      if (job) {
        job.status = "research_failed";
        addTimeline(job, "research_failed", error.message);
        upsertJob(job);
        await sendEmail({ to: config.adminEmail, ...researchFailure(job, error.message) });
      }
    } finally {
      runningJobs.delete(jobId);
    }
  }, 100);
}

export async function runResearch(jobId) {
  const job = getJob(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  if (!job.productRequest?.trim()) return;

  job.status = "researching";
  job.researchStartedAt ||= new Date().toISOString();
  job.nextUpdateAt = addHours(new Date(), config.updateIntervalHours).toISOString();
  addTimeline(job, "research_started", "AI supplier research started.");
  upsertJob(job);

  const customerUpdate = stageUpdate(job);
  await sendEmail({ to: job.customerEmail, ...customerUpdate });

  const research = await performSupplierResearch(job);

  job.status = "human_review";
  job.research = research;
  job.researchCompletedAt = new Date().toISOString();
  job.nextUpdateAt = addHours(new Date(), config.updateIntervalHours).toISOString();
  addTimeline(job, "research_completed", "Supplier research completed and sent to Arcovia for review.", {
    suppliers: research.suppliers?.length || 0
  });
  upsertJob(job);

  await sendEmail({ to: config.adminEmail, ...adminReport(job) });
  await sendEmail({ to: job.customerEmail, ...stageUpdate(job) });
}

async function performSupplierResearch(job) {
  if (!config.openaiApiKey) {
    return dryRunResearch(job);
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.openaiModel,
      tools: [{ type: "web_search" }],
      tool_choice: "required",
      include: ["web_search_call.action.sources"],
      input: buildResearchPrompt(job)
    })
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI research failed: ${response.status} ${body}`);
  }

  const data = JSON.parse(body);
  const text = data.output_text || extractOutputText(data) || "";
  const parsed = parseJsonReport(text);

  return {
    summary: parsed?.summary || "Supplier research completed. Review raw report.",
    suppliers: normalizeSuppliers(parsed?.suppliers || []),
    rawText: text,
    model: config.openaiModel,
    completedAt: new Date().toISOString()
  };
}

function buildResearchPrompt(job) {
  return `You are Arcovia's supplier-sourcing analyst.

Customer request:
${job.productRequest}

Order: ${job.orderName}
Customer budget and sourcing preferences may be inside the request. If important details are missing, say what is missing.

Task:
Find trustworthy suppliers for this product. Do deep public-source research before recommending any supplier.

Research requirements:
- Search broad web results and supplier/product pages.
- Check customer reviews and complaints.
- Check HelloPeter mentions where relevant, especially for South African suppliers.
- Check social media presence or absence where relevant.
- Check marketplace/review signals, payment safety, delivery claims, contact details, and consistency.
- Look for scam, fake-store, no-delivery, refund, and counterfeit red flags.
- Prefer official retailers, established marketplaces, and suppliers with verifiable history.

Decision rules:
- Do not mark a supplier trustworthy without evidence URLs.
- Do not recommend buying from a supplier with serious unresolved delivery/payment complaints.
- Do not invent reviews, ratings, addresses, social accounts, prices, or availability.
- If evidence is weak, classify as "needs_more_checks".
- This report is internal. Do not make defamatory claims; describe "red flags" and cite sources.

Return only valid JSON in this shape:
{
  "summary": "short internal summary",
  "missing_customer_details": ["..."],
  "suppliers": [
    {
      "name": "supplier name",
      "url": "supplier/product URL",
      "product_match": "how closely it matches",
      "price": "price if found",
      "availability": "availability if found",
      "location": "country/city if found",
      "trust_score": 0,
      "risk_level": "low | medium | high | unknown",
      "trust_checks": {
        "customer_reviews": "what was found",
        "hellopeter": "what was found or not found",
        "social_media": "what was found or not found",
        "website_payment_delivery": "what was found",
        "business_identity": "what was found"
      },
      "red_flags": ["..."],
      "evidence_urls": ["https://..."],
      "recommendation": "approve_for_human_review | reject | needs_more_checks"
    }
  ],
  "recommended_next_customer_message": "safe short status message, no unverified supplier details"
}`;
}

function dryRunResearch(job) {
  return {
    summary: "Dry run: OpenAI API key not configured. The job was created, customer/admin emails were written to the local outbox, and live supplier research is waiting for OPENAI_API_KEY.",
    suppliers: [],
    rawText: `No live research performed for request: ${job.productRequest}`,
    model: "dry-run",
    completedAt: new Date().toISOString()
  };
}

function extractOutputText(data) {
  const parts = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.text) parts.push(content.text);
    }
  }
  return parts.join("\n");
}

function parseJsonReport(text) {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function normalizeSuppliers(suppliers) {
  return suppliers.map((supplier) => ({
    ...supplier,
    trust_score: Number(supplier.trust_score || 0),
    recommendation: supplier.recommendation || "needs_more_checks"
  }));
}

function addHours(date, hours) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}
