const REGISTRY_ID = "playstation-blog-hardware";

function assetsForQuery(entry, query) {
  if (!entry || !Array.isArray(entry.approved_static_assets)) return [];
  const target = String(query.target_entity || "").toLowerCase();
  return entry.approved_static_assets.filter((asset) =>
    asset.role === "console" && String(asset.target_entity || "").toLowerCase() === target);
}

export function createPlayStationBlogAdapter({ registry, fetchArticle, inspectMedia }) {
  const entry = (registry || []).find((item) => item && item.id === REGISTRY_ID && item.approved === true);
  const cache = new Map();
  return {
    name: "PlayStation Blog",
    isEligibleForCoverage(queries) {
      return Boolean(entry && queries.some((query) => assetsForQuery(entry, query).length));
    },
    async search(query) {
      const output = [];
      for (const asset of assetsForQuery(entry, query)) {
        try {
          if (!cache.has(asset.page_url)) cache.set(asset.page_url, fetchArticle(asset.page_url));
          const page = await cache.get(asset.page_url);
          if (!page || page.ok !== true || new URL(page.url).hostname.toLowerCase() !== "blog.playstation.com") continue;
          const media = await inspectMedia(asset.asset_url);
          if (!media || media.ok !== true || !String(media.contentType || "").toLowerCase().startsWith("image/")) continue;
          output.push({
            provider: "playstation-blog",
            type: "image",
            title: String(asset.target_entity) + " official console hardware",
            description: "Official Sony Interactive Entertainment PlayStation console product image.",
            tags: ["PlayStation", "Sony Interactive Entertainment", String(asset.target_entity), "console", "official"],
            sourceUrl: asset.asset_url,
            downloadUrl: asset.asset_url,
            creator: null,
            license: null,
            licenseUrl: null,
            attribution: "Sony Interactive Entertainment / PlayStation.Blog",
            width: asset.width,
            height: asset.height,
            mimeType: asset.mime_type,
            rights_class: "copyrighted_editorial",
            copyright_owner: "Sony Interactive Entertainment",
            source_type: "playstation_blog_article",
            provenance_page_url: asset.page_url,
            source_domain: "blog.playstation.com",
            retrieved_at: new Date().toISOString(),
            editorial_use_only: true,
            license_status: "no_open_license_identified",
            provenance_status: "verified_first_party",
            official_source_registry_id: REGISTRY_ID
          });
        } catch {}
      }
      return output;
    }
  };
}
