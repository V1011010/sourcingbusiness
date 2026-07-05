const MAX_IMAGE_FETCHES_PER_REPORT = 30;
const MAX_HTML_CHARS = 700_000;
const FETCH_TIMEOUT_MS = 6_000;
const IMAGE_FETCH_CONCURRENCY = 5;
const MAX_IMAGES_PER_SOURCE = 5;

export async function enrichResearchImages(research, context = {}) {
  if (!research || typeof research !== "object") return research;

  const fetchBudget = { remaining: MAX_IMAGE_FETCHES_PER_REPORT };
  const groups = ["suppliers", "candidateSources", "rejectedSources"];

  for (const group of groups) {
    research[group] = await enrichSourceListImages(research[group] || [], fetchBudget, context);
  }

  return research;
}

export function imageEnrichmentHealthFeatures() {
  return {
    supplierImageUrlAutoEnrichment: true,
    supplierImageGalleryAutoEnrichment: true,
    supplierImageSources: ["ai_image_url", "ai_image_urls", "og:image", "twitter:image", "json_ld_image", "direct_image_url", "html_img_src"],
    supplierImageProductRelevanceFilter: true,
    supplierImageFetchLimitPerReport: MAX_IMAGE_FETCHES_PER_REPORT,
    supplierImageGalleryLimitPerSource: MAX_IMAGES_PER_SOURCE
  };
}

async function enrichSourceListImages(items, fetchBudget, context) {
  const enriched = [];
  const list = items || [];

  for (let index = 0; index < list.length; index += IMAGE_FETCH_CONCURRENCY) {
    const batch = list.slice(index, index + IMAGE_FETCH_CONCURRENCY);
    enriched.push(...await Promise.all(batch.map((item) => enrichSourceImage(item, fetchBudget, context))));
  }
  return enriched;
}

async function enrichSourceImage(source, fetchBudget, context) {
  if (!source || typeof source !== "object") return source;
  const existingImages = sourceDirectImageUrls(source, context);
  const existingReferenceImages = sourceReferenceImageUrls(source, context);
  if (existingImages.length + existingReferenceImages.length >= MAX_IMAGES_PER_SOURCE) {
    return normalizeSourceImages(source, existingImages, source.image_source || "provided", existingReferenceImages);
  }
  if (!isSafeHttpUrl(source.url) || fetchBudget.remaining <= 0) {
    return normalizeSourceImages(source, existingImages, source.image_source || "provided", existingReferenceImages);
  }

  fetchBudget.remaining -= 1;
  const discovered = filterRelevantImageUrls(source, await discoverImagesFromPage(source.url), context, {
    fromSourcePage: true
  });
  const images = uniqueImageUrls([...existingImages, ...discovered]).slice(0, MAX_IMAGES_PER_SOURCE);

  return normalizeSourceImages(source, images, discovered.length ? "page_metadata" : source.image_source || "provided", existingReferenceImages);
}

function normalizeSourceImages(source, images, imageSource, referenceImages = []) {
  const safeImages = uniqueImageUrls(images).slice(0, MAX_IMAGES_PER_SOURCE);
  const safeReferenceImages = uniqueImageUrls(referenceImages).slice(0, MAX_IMAGES_PER_SOURCE);
  const hasAnySafeImage = safeImages.length || safeReferenceImages.length;

  return {
    ...source,
    image_url: safeImages[0] || safeReferenceImages[0] || "",
    image_urls: safeImages,
    reference_image_urls: safeReferenceImages,
    image_source: hasAnySafeImage ? imageSource : "none_confident"
  };
}

async function discoverImagesFromPage(pageUrl) {
  try {
    const response = await fetch(pageUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "user-agent": "ArcoviaImageEnricher/1.0"
      }
    });

    if (!response.ok) return [];
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("html") && !contentType.toLowerCase().includes("text")) return [];

    const html = (await response.text()).slice(0, MAX_HTML_CHARS);
    return bestImagesFromHtml(html, response.url || pageUrl);
  } catch {
    return [];
  }
}

function bestImagesFromHtml(html, baseUrl) {
  return uniqueImageUrls([
    ...metaImageCandidates(html),
    ...linkImageCandidates(html),
    ...jsonLdImageCandidates(html),
    ...htmlImageCandidates(html),
    ...directImageCandidates(html)
  ]
    .map((value) => absoluteUrl(value, baseUrl))
    .filter(isSafeImageUrl)
    .filter((value) => !isLikelyIcon(value)))
    .slice(0, MAX_IMAGES_PER_SOURCE);
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

function htmlImageCandidates(html) {
  const candidates = [];
  const imgRegex = /<img\b[^>]*>/gi;
  for (const match of html.matchAll(imgRegex)) {
    const tag = match[0];
    for (const attr of ["src", "data-src", "data-original", "data-image", "data-zoom-image"]) {
      const value = attrValue(tag, attr);
      if (value && looksLikeUsefulImageCandidate(value)) candidates.push(value);
    }
    candidates.push(...srcsetCandidates(attrValue(tag, "srcset")));
    candidates.push(...srcsetCandidates(attrValue(tag, "data-srcset")));
  }
  return candidates;
}

function srcsetCandidates(value) {
  return String(value || "")
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(looksLikeUsefulImageCandidate);
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

function sourceDirectImageUrls(source, context) {
  const values = [
    source?.image_url,
    source?.product_image_url,
    source?.item_image_url,
    source?.image,
    source?.thumbnail_url,
    ...listValues(source?.image_urls),
    ...listValues(source?.product_image_urls)
  ];
  return filterRelevantImageUrls(source, values, context);
}

function sourceReferenceImageUrls(source, context) {
  return filterRelevantImageUrls(source, [
    source?.reference_image_url,
    ...listValues(source?.reference_image_urls),
    ...listValues(source?.reference_images)
  ], context, { requireKeyword: true });
}

function filterRelevantImageUrls(source, values, context = {}, options = {}) {
  const keywords = relevanceKeywords(source, context);
  const sourceHost = hostName(source?.url);

  return uniqueImageUrls(values).filter((imageUrl) => {
    const imageText = safeDecodeURIComponent(imageUrl).toLowerCase();
    if (isLikelyNonProductImage(imageText) || isProbablyTinyImage(imageText)) return false;

    const keywordHits = keywords.filter((keyword) => imageTextIncludesKeyword(imageText, keyword)).length;
    if (keywordHits > 0) return true;
    if (options.requireKeyword) return false;
    if (options.fromSourcePage) return true;

    const imageHost = hostName(imageUrl);
    if (sharesSiteRoot(sourceHost, imageHost)) return true;
    return keywords.length === 0;
  });
}

function relevanceKeywords(source, context = {}) {
  const text = [
    context.productRequest,
    source?.name,
    source?.product_match,
    source?.source_type,
    source?.url
  ].join(" ").toLowerCase();

  const stopWords = new Set([
    "https", "http", "www", "com", "co", "za", "the", "and", "for", "with", "from", "that", "this", "near", "item", "product",
    "supplier", "source", "store", "shop", "online", "physical", "service", "provider", "budget", "price", "delivery", "shipping",
    "category", "condition", "preference", "maximum", "extra", "notes", "links", "photo", "description", "south", "africa", "african"
  ]);

  const tokens = text
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && token.length <= 32 && !stopWords.has(token));

  return [...new Set(tokens)].slice(0, 40);
}

function imageTextIncludesKeyword(imageText, keyword) {
  if (!keyword) return false;
  if (keyword.length <= 3) {
    return new RegExp(`(^|[^a-z0-9])${escapeRegex(keyword)}([^a-z0-9]|$)`, "i").test(imageText);
  }
  return imageText.includes(keyword);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueImageUrls(values) {
  const seen = new Set();
  const output = [];
  for (const value of values || []) {
    const imageUrl = String(value || "").trim();
    if (!isSafeImageUrl(imageUrl)) continue;
    const key = imageUrl.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(imageUrl);
  }
  return output;
}

function listValues(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    return value
      .split(/\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
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

function looksLikeUsefulImageCandidate(value) {
  const text = String(value || "");
  return looksLikeImageUrl(text) || text.includes("cdn") || text.includes("media") || text.includes("image");
}

function isLikelyIcon(value) {
  const text = String(value || "").toLowerCase();
  return /favicon|apple-touch-icon|icon-192|icon-512|logo(?!.*product)/.test(text);
}

function isLikelyNonProductImage(value) {
  const text = String(value || "").toLowerCase();
  return /favicon|apple-touch-icon|sprite|icon[-_0-9]|logo(?!.*product)|placeholder|no[-_ ]?image|default[-_ ]?image|loading|spinner|avatar|profile|social|facebook|instagram|x-twitter|twitter|linkedin|youtube|payment|visa|mastercard|paypal|eft|trust[-_ ]?badge|secure[-_ ]?checkout|newsletter|header|footer|banner|hero|background|storefront|map|pin|marker/.test(text);
}

function isProbablyTinyImage(value) {
  const text = String(value || "").toLowerCase();
  const dimensions = [...text.matchAll(/(?:^|[^\d])(\d{1,4})[x_=-](\d{1,4})(?:[^\d]|$)/g)];
  return dimensions.some((match) => Number(match[1]) < 180 || Number(match[2]) < 180);
}

function hostName(value) {
  try {
    return new URL(String(value || "")).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function sharesSiteRoot(leftHost, rightHost) {
  if (!leftHost || !rightHost) return false;
  if (leftHost === rightHost) return true;
  const leftRoot = siteRoot(leftHost);
  const rightRoot = siteRoot(rightHost);
  return Boolean(leftRoot && rightRoot && leftRoot === rightRoot);
}

function siteRoot(host) {
  const parts = String(host || "").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const last = parts.at(-1);
  const secondLast = parts.at(-2);
  if (last?.length === 2 && ["co", "com", "net", "org"].includes(secondLast)) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}
