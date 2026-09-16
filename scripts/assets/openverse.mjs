const API = "https://api.openverse.org/v1/images/";

function normalizeLicense(code) {
  const labels = {
    by: "CC BY",
    "by-sa": "CC BY-SA",
    cc0: "CC0",
    pdm: "Public Domain"
  };
  return labels[String(code ?? "").toLowerCase()] ?? code ?? null;
}

export async function searchOpenverse(query, limits, request) {
  const url = new URL(API);
  url.searchParams.set("q", query.text);
  url.searchParams.set("page_size", String(limits.resultsPerQuery));
  url.searchParams.set("license_type", "commercial");
  const payload = await request(url, limits, "Openverse");
  return (payload.results ?? []).map((item) => ({
    provider: "openverse",
    type: "image",
    title: item.title ?? "Untitled Openverse asset",
    description: item.description ?? null,
    tags: item.tags?.map((tag) => tag.name ?? tag) ?? [],
    sourceUrl: item.foreign_landing_url ?? item.url,
    downloadUrl: item.url,
    creator: item.creator ?? null,
    license: [normalizeLicense(item.license), item.license_version].filter(Boolean).join(" "),
    licenseUrl: item.license_url ?? null,
    attribution: item.creator ? `${item.title ?? "Untitled"} by ${item.creator}` : null,
    width: item.width ?? null,
    height: item.height ?? null,
    mimeType: item.mime_type ?? "image/jpeg"
  }));
}
