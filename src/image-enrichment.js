const MAX_IMAGE_FETCHES_PER_REPORT = 30;
const MAX_HTML_CHARS = 700_000;
const FETCH_TIMEOUT_MS = 6_000;
const IMAGE_FETCH_CONCURRENCY = 5;

export async function enrichResearchImages(research) {
  if (!research || typeof research !== "object") return research;

  const fetchBudget = { remaining: MAX_IMAGE_FETCHES_PER_REPORT };
  const groups = ["suppliers", "candidateSources", "rejectedSources"];

  for (const group of groups) {
    research[group] = await enrichSourceListImages(research[group] || [], fetchBudget);
  }

  return research;
}

export function imageEnrichmentHealthFeatures() {
  return {
    supplierImageUrlAutoEnrichment: true,
    supplierImageSources: ["ai_image_url", "og:image", "twitter:image", "json_ld_image", "direct_image_url"],
    supplierImageFetchLimitPerReport: MAX_IMAGE_FETCHES_PER_REPORT
  };
}

async function enrichSourceListImages(items, fetchBudget) {
  const enriched = [];
  const list = items || [];

  for (let index = 0; index < list.length; index += IMAGE_FETCH_CONCURRENCY) {
    const batch = list.slice(index, index + IMAGE_FETCH_CONCURRENCY);
    enriched.push(...await Promise.all(batch.map((item) => enrichSourceImage(item, fetchBudget))));
  }
  return enriched;
}

async function enrichSourceImage(source, fetchBudget) {
  if (!source || typeof source !== "object") return source;
  if (hasImageUrl(source)) return source;
  if (!isSafeHttpUrl(source.url)) return source;
  if (fetchBudget.remaining <= 0) return source;

  fetchBudget.remaining -= 1;
  const discovered = await discoverImageFromPage(source.url);
  if (!discovered) return source;

  return {
    ...source,
    image_url: discovered,
    image_source: "page_metadata"
  };
}

async function discoverImageFromPage(pageUrl) {
  try {
    const response = await fetch(pageUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "user-agent": "ArcoviaImageEnricher/1.0"
      }
    });

    if (!response.ok) return "";
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("html") && !contentType.toLowerCase().includes("text")) return "";

    const html = (await response.text()).slice(0, MAX_HTML_CHARS);
    return bestImageFromHtml(html, response.url || pageUrl);
  } catch {
    return "";
  }
}

function bestImageFromHtml(html, baseUrl) {
  const candidates = [
    ...metaImageCandidates(html),
    ...linkImageCandidates(html),
    ...jsonLdImageCandidates(html),
    ...directImageCandidates(html)
  ]
    .map((value) => absoluteUrl(value, baseUrl))
    .filter(isSafeImageUrl)
    .filter((value) => !isLikelyIcon(value));

  return candidates[0] || "";
}

function metaImageCandidates(html) {
  const candidates = [];
  const metaRegex = /<meta\b[^>]*>/gi;
  for (const match of html.matchAll(metaRegex)) {
    const tag = match[0];
    const property = attrValue(tag, "property").toLowerCase();
    const name = attrValue(tag, "name").toLowerCase();
    if (!["og:image", "og:image:url", "twitter:image", "twitter:image:src"].includes(property) && !["twitter:image", "twitter:image:src"].includes(name)) continue;
    const content = attrValue(tag, "content");
    if (content) candidates.push(content);
  }
  return candidates;
}

function linkImageCandidates(html) {
  const candidates = [];
  const linkRegex = /<link\b[^>]*>/gi;
  for (const match of html.matchAll(linkRegex)) {
    const tag = match[0];
    const rel = attrValue(tag, "rel").toLowerCase();
    if (!rel.includes("image_src") && !rel.includes("preload")) continue;
    const href = attrValue(tag, "href");
    if (href && looksLikeImageUrl(href)) candidates.push(href);
  }
  return candidates;
}

function jsonLdImageCandidates(html) {
  const candidates = [];
  const scriptRegex = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scriptRegex)) {
    const raw = decodeHtmlEntities(match[1] || "").trim();
    if (!raw) continue;
    try {
      collectJsonImages(JSON.parse(raw), candidates);
    } catch {
      // Ignore malformed JSON-LD blocks.
    }
  }
  return candidates;
}

function directImageCandidates(html) {
  const candidates = [];
  const regex = /https?:\\?\/\\?\/[^"'<>\s)]+?\.(?:jpg|jpeg|png|webp)(?:\?[^"'<>\s)]*)?/gi;
  for (const match of html.matchAll(regex)) {
    candidates.push(match[0].replaceAll("\\/", "/"));
  }
  return candidates;
}

function collectJsonImages(value, output) {
  if (!value) return;

  if (Array.isArray(value)) {
    for (const item of value) collectJsonImages(item, output);
    return;
  }

  if (typeof value !== "object") return;

  const image = value.image || value.thumbnailUrl || value.primaryImageOfPage;
  if (typeof image === "string") output.push(image);
  if (Array.isArray(image)) {
    for (const item of image) {
      if (typeof item === "string") output.push(item);
      else if (item?.url) output.push(item.url);
    }
  } else if (image?.url) {
    output.push(image.url);
  }

  for (const key of ["@graph", "offers", "itemListElement", "mainEntity"]) {
    collectJsonImages(value[key], output);
  }
}

function attrValue(tag, name) {
  const regex = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i");
  const match = tag.match(regex);
  return decodeHtmlEntities(match?.[1] || "").trim();
}

function absoluteUrl(value, baseUrl) {
  try {
    return new URL(String(value || "").trim(), baseUrl).toString();
  } catch {
    return "";
  }
}

function hasImageUrl(source) {
  return isSafeImageUrl(source.image_url || source.product_image_url || source.item_image_url || source.image || "");
}

function isSafeHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function isSafeImageUrl(value) {
  if (!isSafeHttpUrl(value)) return false;
  return looksLikeImageUrl(value) || value.includes("image") || value.includes("cdn") || value.includes("media");
}

function looksLikeImageUrl(value) {
  return /\.(jpg|jpeg|png|webp)(\?|#|$)/i.test(String(value || ""));
}

function isLikelyIcon(value) {
  const text = String(value || "").toLowerCase();
  return /favicon|apple-touch-icon|icon-192|icon-512|logo(?!.*product)/.test(text);
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}
