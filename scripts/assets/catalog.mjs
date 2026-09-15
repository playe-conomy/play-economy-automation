import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";

export function normalizeSourceUrl(value = "") {
  try {
    const url = new URL(value);
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ref"].forEach((key) => url.searchParams.delete(key));
    url.hash = "";
    return url.toString();
  } catch {
    return value.trim();
  }
}

export function loadManifest(path) {
  if (!existsSync(path)) return { version: 1, assets: [] };
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  return { version: manifest.version ?? 1, assets: manifest.assets ?? [] };
}

export async function saveManifest(path, manifest) {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function allowedLicense(candidate) {
  const license = `${candidate.license ?? ""} ${candidate.licenseUrl ?? ""}`.toLowerCase();
  if (!license || /unknown|all rights reserved|noncommercial|\bnc\b|no derivatives|\bnd\b/.test(license)) {
    return { allowed: false, reason: "license-not-reusable" };
  }
  if (/cc0|public domain|pdm|cc-by|cc by/.test(license)) {
    return { allowed: true, reason: "reusable-license" };
  }
  return { allowed: false, reason: "license-not-on-allowlist" };
}

export function findDuplicate(manifest, candidate, checksum) {
  const normalizedUrl = normalizeSourceUrl(candidate.sourceUrl);
  return manifest.assets.find((asset) =>
    (normalizedUrl && asset.normalized_source_url === normalizedUrl) ||
    (checksum && asset.checksum === checksum)
  );
}

export function scoreCandidate(candidate, query) {
  const text = `${candidate.title ?? ""} ${(candidate.tags ?? []).join(" ")}`.toLowerCase();
  const terms = query.text.toLowerCase().split(/\s+/).filter((term) => term.length > 2);
  const matches = terms.filter((term) => text.includes(term)).length;
  const license = allowedLicense(candidate);
  let score = matches * 12;
  const reasons = [`relevance:${matches}/${terms.length}`];
  if (candidate.width >= 1600 || candidate.height >= 1600) { score += 22; reasons.push("large-enough"); }
  else if (candidate.width >= 1000 || candidate.height >= 1000) { score += 12; reasons.push("usable-resolution"); }
  else { score -= 10; reasons.push("small-resolution"); }
  if (["image/jpeg", "image/png", "image/webp"].includes(candidate.mimeType)) { score += 8; reasons.push("supported-image"); }
  else { score -= 20; reasons.push("unsupported-type"); }
  if (candidate.width && candidate.height) {
    const ratio = candidate.height / candidate.width;
    if (ratio >= 0.85) { score += 8; reasons.push("vertical-friendly"); }
    else { score += 3; reasons.push("crop-pan-eligible"); }
  }
  if (license.allowed) { score += 30; reasons.push(license.reason); }
  else { score -= 60; reasons.push(license.reason); }
  if (query.kind === "specific" && text.includes(query.primary.toLowerCase())) { score += 15; reasons.push("specific-match"); }
  return { score, reasons, license };
}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function assetRecord(candidate, overrides = {}) {
  return {
    id: overrides.id ?? `asset-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    filename: overrides.filename ?? null,
    type: candidate.type ?? "image",
    category: candidate.category ?? null,
    franchise: candidate.franchise ?? null,
    company: candidate.company ?? null,
    console: candidate.console ?? null,
    topic: candidate.topic ?? null,
    tags: candidate.tags ?? [],
    source: candidate.provider,
    source_url: candidate.sourceUrl,
    normalized_source_url: normalizeSourceUrl(candidate.sourceUrl),
    creator: candidate.creator ?? null,
    license: candidate.license ?? null,
    license_url: candidate.licenseUrl ?? null,
    attribution: candidate.attribution ?? null,
    download_date: overrides.downloadDate ?? null,
    width: candidate.width ?? null,
    height: candidate.height ?? null,
    duration: candidate.duration ?? null,
    orientation: candidate.width && candidate.height ? (candidate.height > candidate.width ? "portrait" : candidate.height < candidate.width ? "landscape" : "square") : null,
    mime_type: candidate.mimeType ?? null,
    checksum: overrides.checksum ?? null,
    drive_path: overrides.drivePath ?? null,
    drive_file_id: overrides.driveFileId ?? null,
    local_cache_path: overrides.localCachePath ?? null,
    reusable: overrides.reusable ?? false,
    status: overrides.status ?? "candidate"
  };
}
