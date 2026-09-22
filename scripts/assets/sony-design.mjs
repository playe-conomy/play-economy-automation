const SONY_HOST = "www.sony.com";

function targetPage(target) {
  const value = String(target || "").toLowerCase();
  if (value.includes("ps2")) return "https://www.sony.com/en/SonyInfo/design/gallery/PlayStation2/";
  if (value.includes("ps4")) return "https://www.sony.com/en/SonyInfo/design/gallery/PlayStation4/";
  if (value.includes("ps5 pro")) return "https://www.sony.com/en/SonyInfo/design/news/awards/if_design_2025.html";
  if (value.includes("ps5")) return "https://www.sony.com/en/SonyInfo/design/gallery/PS5/";
  return null;
}

function absolute(base, src) {
  try { return new URL(src, base).toString(); } catch { return null; }
}

function extractImages(html, pageUrl) {
  const out = [];
  const re = /<img\b[^>]*>/gi;
  for (const tag of String(html || "").match(re) || []) {
    const src = /\bsrc=["']([^"']+)["']/i.exec(tag)?.[1] || /\bdata-src=["']([^"']+)["']/i.exec(tag)?.[1];
    if (!src) continue;
    const url = absolute(pageUrl, src);
    if (!url) continue;
    let host;
    try { host = new URL(url).hostname.toLowerCase(); } catch { continue; }
    if (host !== SONY_HOST) continue;
    const alt = /\balt=["']([^"']*)["']/i.exec(tag)?.[1] || "";
    out.push({ url, alt });
  }
  return [...new Map(out.map((x) => [x.url, x])).values()];
}

export function createSonyDesignAdapter({ fetchPage, inspectMedia }) {
  return {
    name: "Sony Design",
    isEligibleForCoverage(queries) { return queries.some((q) => Boolean(targetPage(q.target_entity))); },
    async search(query) {
      const pageUrl = targetPage(query.target_entity);
      if (!pageUrl || query.intent !== "console") return [];
      try {
        const page = await fetchPage(pageUrl);
        if (!page?.ok || new URL(page.url).hostname.toLowerCase() !== SONY_HOST) return [];
        const images = extractImages(page.text || page.bodyText || page.body || "", pageUrl);
        const out = [];
        for (const image of images) {
          const hay = (image.alt + " " + image.url).toLowerCase();
          if (!/(playstation|ps2|ps4|ps5|scph|cuh)/i.test(hay)) continue;
          const media = await inspectMedia(image.url);
          const type = String(media?.contentType || "").split(";",1)[0].toLowerCase();
          if (!media?.ok || !type.startsWith("image/")) continue;
          out.push({
            provider:"sony-design", type:"image",
            title:String(query.target_entity) + " Sony Design official hardware",
            description:"Official Sony Design gallery image for PlayStation hardware.",
            tags:["Sony","PlayStation",String(query.target_entity),"console","official"],
            sourceUrl:image.url, downloadUrl:image.url, creator:null, license:null, licenseUrl:null,
            attribution:"Sony Group Corporation / Sony Design", width:null, height:null, mimeType:type,
            rights_class:"copyrighted_editorial", copyright_owner:"Sony Group Corporation",
            source_type:"sony_design_gallery", provenance_page_url:pageUrl,
            source_domain:SONY_HOST, retrieved_at:new Date().toISOString(), editorial_use_only:true,
            license_status:"no_open_license_identified", provenance_status:"verified_first_party",
            official_source_registry_id:"sony-design-playstation"
          });
        }
        return out.slice(0, 6);
      } catch { return []; }
    }
  };
}
