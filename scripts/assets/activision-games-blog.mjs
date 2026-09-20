const REGISTRY_ID = "activision-games-blog-guitar-hero-live";
const ARTICLE_HOST = "blog.activision.com";
const MAX_REDIRECTS = 3;
const RANGE_PREFLIGHT_BYTES = 4096;

const APPROVED_STATIC_ASSETS = Object.freeze([
  Object.freeze({ page_url: "https://blog.activision.com/guitar-hero/archives/guitar-hero-live-introducing-hero-powers", asset_url: "https://blog.activision.com/content/dam/atvi/activision/atvi-touchui/blog/archives/feature/guitar-hero/featured-Image9913431.jpg", role: "gameplay", editorial_form: "screenshot", target_entity: "Guitar Hero", width: 1500, height: 500, mime_type: "image/jpeg" }),
  Object.freeze({ page_url: "https://blog.activision.com/guitar-hero/archives/guitar-hero-live-test-your-skills-in-rivals-arena", asset_url: "https://blog.activision.com/content/dam/atvi/activision/atvi-touchui/blog/archives/feature/guitar-hero/featured-Image9894231.jpg", role: "gameplay", editorial_form: "screenshot", target_entity: "Guitar Hero", width: 1920, height: 762, mime_type: "image/jpeg" }),
  Object.freeze({ page_url: "https://blog.activision.com/es/guitar-hero/archives/the-guitar-hero-live-controller-six-things-you-need-to-know", asset_url: "https://blog.activision.com/content/dam/atvi/activision/atvi-touchui/blog/archives/feature/guitar-hero/featured-Image9905852.jpg", role: "specific", editorial_form: "product", target_entity: "Guitar Hero", width: 1280, height: 508, mime_type: "image/jpeg" })
]);

function normalizedUrl(value) {
  const url = new URL(value);
  url.hash = "";
  return url.toString();
}

function sameUrl(left, right) {
  try {
    return normalizedUrl(left) === normalizedUrl(right);
  } catch {
    return false;
  }
}

function isCurrentStaticAsset(asset) {
  try {
    const page = new URL(asset?.page_url);
    const media = new URL(asset?.asset_url);
    return page.protocol === "https:" && media.protocol === "https:" &&
      page.hostname.toLowerCase() === ARTICLE_HOST && media.hostname.toLowerCase() === ARTICLE_HOST &&
      media.pathname.startsWith("/content/dam/") && asset.target_entity === "Guitar Hero" &&
      ["gameplay", "specific"].includes(asset.role) && ["screenshot", "product"].includes(asset.editorial_form) &&
      Number(asset.width) >= 500 && Number(asset.height) >= 500 && asset.mime_type === "image/jpeg";
  } catch {
    return false;
  }
}

function isExactApprovedStaticAsset(asset, index) {
  const expected = APPROVED_STATIC_ASSETS[index];
  return expected && Object.entries(expected).every(([key, value]) => asset?.[key] === value);
}

function validRegistryEntry(entry) {
  return entry?.approved === true && entry.domains?.includes(ARTICLE_HOST) && entry.cdn_domains?.includes(ARTICLE_HOST) &&
    entry.source_types?.includes("activision_games_blog_article") && Array.isArray(entry.approved_static_assets) &&
    entry.approved_static_assets.length === APPROVED_STATIC_ASSETS.length && entry.approved_static_assets.every((asset, index) =>
      isCurrentStaticAsset(asset) && isExactApprovedStaticAsset(asset, index));
}

function assetsForQuery(entry, query) {
  if (!entry || !Array.isArray(entry.approved_static_assets)) return [];
  if (String(query.target_entity ?? "").toLowerCase() !== "guitar hero") return [];
  if (query.intent === "gameplay" && query.preferred_editorial_form === "screenshot") {
    return entry.approved_static_assets.filter((asset) => asset.role === "gameplay" && asset.editorial_form === "screenshot");
  }
  if (query.intent === "specific" && query.preferred_editorial_form === "product") {
    return entry.approved_static_assets.filter((asset) => asset.role === "specific" && asset.editorial_form === "product");
  }
  return [];
}

function validatedRedirect(result, expectedUrl) {
  const hops = result.hops ?? [result.url];
  return result?.ok === true && sameUrl(result.url, expectedUrl) && hops.length <= MAX_REDIRECTS + 1 &&
    hops.every((hop) => {
      try {
        const url = new URL(hop);
        return url.protocol === "https:" && url.hostname.toLowerCase() === ARTICLE_HOST;
      } catch { return false; }
    });
}

function normalizedContentType(value) {
  return String(value ?? "").split(";", 1)[0].trim().toLowerCase();
}

function isExactApprovedJpeg(entry, asset) {
  const index = entry?.approved_static_assets?.indexOf(asset);
  return Number.isInteger(index) && index >= 0 && asset?.mime_type === "image/jpeg" && isExactApprovedStaticAsset(asset, index);
}

function validContentRange(value, byteLength) {
  const match = /^bytes 0-(\d+)\/(\d+)$/i.exec(String(value ?? "").trim());
  if (!match) return false;
  const end = Number(match[1]);
  const total = Number(match[2]);
  return Number.isSafeInteger(end) && Number.isSafeInteger(total) && end >= 0 && total > end &&
    end + 1 === byteLength && byteLength <= RANGE_PREFLIGHT_BYTES;
}

function hasJpegSignature(bytes) {
  return bytes instanceof Uint8Array && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function safeErrorReason(error, fallback) {
  return error?.code ?? error?.reason ?? error?.name ?? fallback;
}

function candidateMetadata(asset) {
  if (asset.role === "gameplay") {
    return { title: "Guitar Hero Live gameplay screenshot", description: "Current first-party Guitar Hero Live gameplay screenshot with note highway and HUD.", tags: ["Guitar Hero", "gameplay", "screenshot", "note highway"] };
  }
  return { title: "Guitar Hero Live controller product", description: "Current first-party official Guitar Hero Live controller product image.", tags: ["Guitar Hero", "controller", "product"] };
}

export function createActivisionGamesBlogAdapter({ registry, fetchArticle, inspectMedia, inspectMediaRange }) {
  const entry = (registry ?? []).find((item) => item?.id === REGISTRY_ID);
  const articleCache = new Map();
  const metrics = { article_requests: 0, media_preflights: 0, source_failures: 0, source_failure_details: [] };
  const applicable = (query) => assetsForQuery(entry, query).length > 0;
  const recordFailure = ({ url, method, stage, result = null, error = null }) => {
    metrics.source_failures += 1;
    let hostname = null;
    try { hostname = new URL(url).hostname.toLowerCase(); } catch { /* The URL is only diagnostic data. */ }
    metrics.source_failure_details.push({
      provider: "Activision Games Blog",
      url,
      hostname,
      method,
      stage,
      http_status: result?.status ?? error?.status ?? null,
      reason: safeErrorReason(error, result?.reason ?? stage),
      observed_content_type: normalizedContentType(result?.contentType) || null
    });
  };
  return {
    name: "Activision Games Blog",
    isEligibleForCoverage(queries) {
      return validRegistryEntry(entry) && queries.some(applicable);
    },
    metrics() {
      return { ...metrics, source_failure_details: metrics.source_failure_details.map((detail) => ({ ...detail })) };
    },
    async search(query) {
      if (!validRegistryEntry(entry)) return [];
      const assets = assetsForQuery(entry, query);
      if (!assets.length) return [];
      const candidates = [];
      for (const asset of assets) {
        if (!articleCache.has(asset.page_url)) {
          metrics.article_requests += 1;
          articleCache.set(asset.page_url, (async () => {
          try {
            const article = await fetchArticle(asset.page_url);
            if (!validatedRedirect(article, asset.page_url)) {
              throw new Error("activision_games_blog_article_unavailable_or_redirect_unapproved");
            }
            return article;
          } catch (error) {
            recordFailure({ url: asset.page_url, method: "GET", stage: "provenance_page", error });
            throw error;
          }
        })());
        }
        await articleCache.get(asset.page_url);
        metrics.media_preflights += 1;
        let inspected;
        try {
          inspected = await inspectMedia(asset.asset_url);
        } catch (error) {
          recordFailure({ url: asset.asset_url, method: "HEAD", stage: "media_head", error });
          continue;
        }
        if (!validatedRedirect(inspected, asset.asset_url)) {
          recordFailure({ url: asset.asset_url, method: "HEAD", stage: "media_head", result: inspected });
          continue;
        }
        const contentType = normalizedContentType(inspected.contentType);
        let mimeType = contentType;
        if (!contentType.startsWith("image/")) {
          if (contentType !== "application/octet-stream" || !isExactApprovedJpeg(entry, asset) || typeof inspectMediaRange !== "function") {
            recordFailure({ url: asset.asset_url, method: "HEAD", stage: "media_head", result: inspected });
            continue;
          }
          let ranged;
          try {
            ranged = await inspectMediaRange(asset.asset_url);
          } catch (error) {
            recordFailure({ url: asset.asset_url, method: "GET", stage: "media_range_signature", error });
            continue;
          }
          if (!validatedRedirect(ranged, asset.asset_url) || ranged.status !== 206 || ranged.bodyExceeded === true ||
            !validContentRange(ranged.contentRange, ranged.bytes?.length ?? 0) || !hasJpegSignature(ranged.bytes)) {
            recordFailure({ url: asset.asset_url, method: "GET", stage: "media_range_signature", result: ranged });
            continue;
          }
          mimeType = asset.mime_type;
        }
        const metadata = candidateMetadata(asset);
        candidates.push({
          provider: "activision-games-blog",
          type: "image",
          ...metadata,
          sourceUrl: asset.asset_url,
          downloadUrl: asset.asset_url,
          creator: null,
          license: null,
          licenseUrl: null,
          attribution: `Activision Publishing, Inc. — ${new URL(asset.page_url).pathname.split("/").pop()}`,
          width: asset.width,
          height: asset.height,
          mimeType,
          rights_class: "copyrighted_editorial",
          copyright_owner: "Activision Publishing, Inc.",
          source_type: "activision_games_blog_article",
          provenance_page_url: asset.page_url,
          source_domain: new URL(asset.asset_url).hostname.toLowerCase(),
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
