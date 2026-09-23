const API = "https://api.flickr.com/services/feeds/photos_public.gne";

function stripHtml(value = "") {
  return String(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export async function searchFlickrPublic(query, limits, request) {
  const url = new URL(API);
  url.searchParams.set("format", "json");
  url.searchParams.set("nojsoncallback", "1");
  url.searchParams.set("tagmode", "all");
  url.searchParams.set("tags", query.text.split(/\s+/).filter(Boolean).slice(0, 6).join(","));
  const payload = await request(url, limits, "Flickr Public");
  return (payload.items ?? []).slice(0, limits.resultsPerQuery).map((item) => {
    const medium = item.media?.m ?? null;
    const originalish = medium ? medium.replace(/_m(\.[a-z0-9]+)$/i, "_b$1") : null;
    return {
      provider: "flickr_public",
      type: "image",
      title: item.title || "Untitled Flickr asset",
      description: stripHtml(item.description),
      tags: String(item.tags ?? "").split(/\s+/).filter(Boolean),
      sourceUrl: item.link,
      downloadUrl: originalish ?? medium,
      creator: item.author ?? null,
      license: null,
      licenseUrl: null,
      attribution: item.author ? `${item.title || "Untitled"} — ${item.author}` : null,
      width: 1024,
      height: 768,
      mimeType: medium?.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg"
    };
  }).filter((item) => item.sourceUrl && item.downloadUrl);
}
