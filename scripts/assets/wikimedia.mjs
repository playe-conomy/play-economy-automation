const API = "https://commons.wikimedia.org/w/api.php";

function metadata(item, key) {
  return item?.extmetadata?.[key]?.value?.replace(/<[^>]+>/g, "").trim() ?? null;
}

export async function searchWikimedia(query, limits, request) {
  const url = new URL(API);
  Object.entries({ action: "query", generator: "search", gsrsearch: query.text, gsrlimit: limits.resultsPerQuery, gsrnamespace: "6", prop: "imageinfo|info", iiprop: "url|size|mime|extmetadata", format: "json", formatversion: "2", origin: "*" }).forEach(([key, value]) => url.searchParams.set(key, value));
  const payload = await request(url, limits, "Wikimedia");
  return (payload.query?.pages ?? []).map((page) => {
    const image = page.imageinfo?.[0] ?? {};
    const license = metadata(image, "LicenseShortName");
    return {
      provider: "wikimedia",
      type: "image",
      title: page.title?.replace(/^File:/, "") ?? "Untitled Wikimedia asset",
      description: metadata(image, "ImageDescription") ?? metadata(image, "ObjectName"),
      tags: [],
      sourceUrl: image.descriptionurl ?? page.canonicalurl,
      downloadUrl: image.url,
      creator: metadata(image, "Artist"),
      license,
      licenseUrl: metadata(image, "LicenseUrl"),
      attribution: metadata(image, "Credit") ?? metadata(image, "Artist"),
      width: image.width ?? null,
      height: image.height ?? null,
      mimeType: image.mime ?? null
    };
  });
}
