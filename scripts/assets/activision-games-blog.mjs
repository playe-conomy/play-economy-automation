const REGISTRY_ID = "activision-games-blog-guitar-hero-live";

export const APPROVED_ARTICLES = Object.freeze({
  gameplay: "https://blog.activision.com/guitar-hero/archives/guitar-hero-live-introducing-hero-powers",
  artwork: "https://blog.activision.com/guitar-hero/archives/introducing-guitar-hero-live-coming-this-fall",
  controller: "https://blog.activision.com/guitar-hero/archives/the-guitar-hero-live-controller-six-things-you-need-to-know"
});

const ARTICLE_HOST = "blog.activision.com";
const MEDIA_HOST = "community.activision.com";
const MAX_REDIRECTS = 3;
const NON_CONTENT_MEDIA = /(?:avatar|author|icon|logo|social|facebook|twitter|tracking|pixel|spacer|1x1|favicon|nav|header|footer)/i;

function normalizedUrl(value) {
  const url = new URL(value);
  url.hash = "";
  return url.toString();
}

function sameUrl(left, right) {
  return normalizedUrl(left) === normalizedUrl(right);
}

function isApprovedArticleUrl(value) {
  try {
    return Object.values(APPROVED_ARTICLES).some((article) => sameUrl(value, article));
  } catch {
    return false;
  }
}

function allowedHost(value, allowedHostName) {
  try {
    return new URL(value).hostname.toLowerCase() === allowedHostName;
  } catch {
    return false;
  }
}

function decodeFilename(value) {
  try {
    return decodeURIComponent(new URL(value).pathname.split("/").pop() ?? "").replace(/[-_]+/g, " ").replace(/\.[a-z0-9]+$/i, "").trim();
  } catch {
    return "";
  }
}

function parseAttributes(tag) {
  const attributes = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)) attributes[match[1].toLowerCase()] = match[3];
  return attributes;
}

function articleBody(html) {
  return html.match(/<article\b[^>]*>[\s\S]*?<\/article>/i)?.[0] ?? html.match(/<main\b[^>]*>[\s\S]*?<\/main>/i)?.[0] ?? html;
}

function absoluteUrls(value, pageUrl) {
  return value.split(",").map((part) => part.trim().split(/\s+/)[0]).filter(Boolean).map((part) => new URL(part, pageUrl).toString());
}

export function extractApprovedArticleMedia(html, pageUrl) {
  if (!isApprovedArticleUrl(pageUrl) || !allowedHost(pageUrl, ARTICLE_HOST)) return [];
  const found = new Map();
  for (const tag of articleBody(html).matchAll(/<(?:img|source|a)\b[^>]*>/gi)) {
    const attributes = parseAttributes(tag[0]);
    const values = [attributes.src, attributes.href, attributes.srcset].filter(Boolean);
    for (const value of values) {
      for (const sourceUrl of absoluteUrls(value, pageUrl)) {
        if (!allowedHost(sourceUrl, MEDIA_HOST)) continue;
        const filename = decodeFilename(sourceUrl);
        if (!filename || NON_CONTENT_MEDIA.test(filename)) continue;
        const width = Number(attributes.width ?? 0);
        const height = Number(attributes.height ?? 0);
        if ((width && width < 500) || (height && height < 500)) continue;
        const key = normalizedUrl(sourceUrl);
        const existing = found.get(key);
        if (!existing) found.set(key, { sourceUrl: key, filename, width: width || null, height: height || null });
        else {
          existing.width ??= width || null;
          existing.height ??= height || null;
        }
      }
    }
  }
  return [...found.values()];
}

function articleForQuery(query) {
  if (String(query.target_entity ?? "").toLowerCase() !== "guitar hero") return null;
  if (query.intent === "gameplay") return { pageUrl: APPROVED_ARTICLES.gameplay, kind: "gameplay" };
  if (query.intent === "specific" && query.preferred_editorial_form === "product") return { pageUrl: APPROVED_ARTICLES.controller, kind: "controller" };
  if (["cover_art", "official_art"].includes(query.intent)) return { pageUrl: APPROVED_ARTICLES.artwork, kind: "artwork" };
  return null;
}

function mediaMatchesKind(media, kind) {
  const text = media.filename.toLowerCase();
  if (kind === "gameplay") return /(?:gameplay|ghtv|hero power|note highway)/.test(text);
  if (kind === "controller") return /(?:controller|guitar controller|frets)/.test(text);
  return /(?:featured|promo|promotional|key art|cover|artwork)/.test(text);
}

function candidateMetadata(media, query) {
  const sourceText = media.filename;
  if (query.intent === "gameplay") return { title: sourceText, description: "Guitar Hero gameplay screenshot from an official Activision article.", tags: ["Guitar Hero", "gameplay", "screenshot"] };
  if (query.intent === "specific") return { title: sourceText, description: "Guitar Hero controller product from an official Activision article.", tags: ["Guitar Hero", "controller", "product"] };
  if (query.intent === "cover_art") return { title: sourceText, description: "Guitar Hero official promotional cover art from an official Activision article.", tags: ["Guitar Hero", "official", "promotional", "cover art"] };
  return { title: sourceText, description: "Guitar Hero official promotional artwork from an official Activision article.", tags: ["Guitar Hero", "official", "promotional artwork"] };
}

function validatedRedirect(result, expectedHost) {
  const hops = result.hops ?? [result.url];
  return hops.length <= MAX_REDIRECTS + 1 && hops.every((hop) => allowedHost(hop, expectedHost));
}

function validRegistryEntry(entry) {
  return entry?.approved === true && entry.domains?.includes(ARTICLE_HOST) && entry.cdn_domains?.includes(MEDIA_HOST) && entry.source_types?.includes("activision_games_blog_article");
}

export function createActivisionGamesBlogAdapter({ registry, fetchArticle, inspectMedia }) {
  const entry = (registry ?? []).find((item) => item?.id === REGISTRY_ID);
  const articleCache = new Map();
  const metrics = { article_requests: 0, media_preflights: 0, source_failures: 0 };
  const applicable = (query) => articleForQuery(query) !== null;
  return {
    name: "Activision Games Blog",
    isEligibleForCoverage(queries) {
      return validRegistryEntry(entry) && queries.some(applicable);
    },
    metrics() {
      return { ...metrics };
    },
    async search(query) {
      const plan = articleForQuery(query);
      if (!plan || !validRegistryEntry(entry) || !isApprovedArticleUrl(plan.pageUrl)) return [];
      if (!articleCache.has(plan.pageUrl)) {
        metrics.article_requests += 1;
        articleCache.set(plan.pageUrl, (async () => {
          try {
            const article = await fetchArticle(plan.pageUrl);
            if (!article?.html || !sameUrl(article.url, plan.pageUrl) || !validatedRedirect(article, ARTICLE_HOST)) {
              throw new Error("activision_games_blog_article_unavailable_or_redirect_unapproved");
            }
            return article;
          } catch (error) {
            metrics.source_failures += 1;
            throw error;
          }
        })());
      }
      const article = await articleCache.get(plan.pageUrl);
      const media = extractApprovedArticleMedia(article.html, plan.pageUrl).filter((item) => mediaMatchesKind(item, plan.kind));
      const candidates = [];
      for (const item of media.slice(0, 1)) {
        metrics.media_preflights += 1;
        let inspected;
        try {
          inspected = await inspectMedia(item.sourceUrl);
        } catch {
          metrics.source_failures += 1;
          continue;
        }
        if (!inspected?.ok || !validatedRedirect(inspected, MEDIA_HOST) || !String(inspected.contentType ?? "").startsWith("image/")) {
          metrics.source_failures += 1;
          continue;
        }
        const metadata = candidateMetadata(item, query);
        candidates.push({
          provider: "activision-games-blog",
          type: "image",
          ...metadata,
          sourceUrl: item.sourceUrl,
          downloadUrl: item.sourceUrl,
          creator: null,
          license: null,
          licenseUrl: null,
          attribution: `Activision Publishing, Inc. — ${new URL(plan.pageUrl).pathname.split("/").pop()}`,
          width: item.width ?? inspected.width ?? null,
          height: item.height ?? inspected.height ?? null,
          mimeType: inspected.contentType,
          rights_class: "copyrighted_editorial",
          copyright_owner: "Activision Publishing, Inc.",
          source_type: "activision_games_blog_article",
          provenance_page_url: plan.pageUrl,
          source_domain: new URL(item.sourceUrl).hostname.toLowerCase(),
          retrieved_at: new Date().toISOString(),
          editorial_use_only: true,
          license_status: "no_open_license_identified",
          provenance_status: "verified_first_party",
          official_source_registry_id: entry.id
        });
      }
      return candidates;
    }
  };
}
