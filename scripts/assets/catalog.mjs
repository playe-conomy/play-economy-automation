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
  if (/cc0|public domain|pdm|cc[- ]by(?:[- ]sa)?/.test(license)) {
    return { allowed: true, reason: "reusable-license" };
  }
  return { allowed: false, reason: "license-not-on-allowlist" };
}

export const CRITICAL_METADATA = ["source", "source_url", "title", "license"];
export const OPTIONAL_METADATA = ["creator", "license_url", "attribution"];

export function inspectMetadata(candidate) {
  const missingFields = [];
  if (!candidate.provider) missingFields.push("source");
  if (!candidate.sourceUrl) missingFields.push("source_url");
  if (!candidate.title) missingFields.push("title");
  if (!candidate.license || /unknown/i.test(candidate.license)) missingFields.push("license");
  const warnings = [];
  if (!candidate.creator) warnings.push("creator_missing");
  if (!candidate.licenseUrl && !/public domain|pdm/i.test(candidate.license ?? "")) warnings.push("license_url_missing");
  if (!candidate.attribution && candidate.creator) warnings.push("attribution_missing");
  return { missingFields, warnings };
}

export function qualityTier(candidate) {
  const width = Number(candidate.width ?? 0);
  const height = Number(candidate.height ?? 0);
  const area = width * height;
  if (!width || !height) return { tier: "reject", score: -25, reason: "missing_dimensions" };
  if (width < 500 || height < 500 || area < 500000) return { tier: "low_resolution", score: -35, reason: "insufficient_resolution" };
  if (area >= 2500000 && (width >= 1200 || height >= 1200)) return { tier: "high_quality", score: 32, reason: "high_quality" };
  return { tier: "usable", score: 8, reason: "usable_resolution" };
}

export function classifyAsset(candidate, query) {
  const text = `${candidate.title ?? ""} ${(candidate.tags ?? []).join(" ")} ${candidate.sourceUrl ?? ""}`.toLowerCase();
  const target = (query.target_entity ?? query.primary ?? "").toLowerCase();
  const related = target && text.includes(target);
  const gameplayEvidence = /gameplay|screenshot|screen shot|in-game|in game/.test(text);
  const companyEvidence = /activision|electronic arts|microsoft|sony|nintendo/.test(text);
  const consoleEvidence = /playstation|xbox|nintendo|console|ps2|ps3|ps4/.test(text);
  const technologyEvidence = /electric guitar|guitar|controller|peripheral|accessor|turntable/.test(text);
  if (query.intent === "gameplay" && related && gameplayEvidence) return { role: "gameplay", category: "Gameplay", entity: query.target_entity, confidence: "high" };
  if (query.intent === "character" && related) return { role: "character", category: "Personajes", entity: query.target_entity, confidence: "high" };
  if (query.intent === "official_art" && related) return { role: "official_art", category: "Arte Oficial", entity: query.target_entity, confidence: "high" };
  if (query.intent === "map" && related) return { role: "map", category: "Mapas", entity: query.target_entity, confidence: "high" };
  if (query.intent === "playeconomy_graphic") return { role: "playeconomy_graphic", category: "Gráficos PLAYECONOMY", entity: null, confidence: "high" };
  if (query.intent === "company" && (related || companyEvidence)) return { role: "company", category: "Empresas", entity: query.target_entity, confidence: "high" };
  if (query.intent === "console" && consoleEvidence) return { role: "console", category: "Consolas", entity: query.target_entity, confidence: "high" };
  if (query.intent === "specific" && related) return { role: "specific", category: "Franquicias", entity: query.target_entity, confidence: "high" };
  if (query.intent === "technology") return { role: "technology", category: "Tecnología", entity: null, confidence: technologyEvidence ? "high" : "medium" };
  if (query.intent === "contextual_broll" || technologyEvidence) return { role: "contextual_broll", category: "Tecnología", entity: null, confidence: technologyEvidence ? "medium" : "low" };
  return { role: "contextual_broll", category: "Tecnología", entity: null, confidence: "low" };
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
  const classification = classifyAsset(candidate, query);
  const quality = qualityTier(candidate);
  const breakdown = { relevance: matches * 10, resolution: quality.score, license: 0, orientation: 0, specificity: 0, mime: 0 };
  const reasons = [`relevance:${matches}/${terms.length}`, quality.reason];
  if (["image/jpeg", "image/png", "image/webp"].includes(candidate.mimeType)) { breakdown.mime = 8; reasons.push("supported-image"); }
  else { breakdown.mime = -20; reasons.push("unsupported_mime"); }
  if (candidate.width && candidate.height) {
    const ratio = candidate.height / candidate.width;
    if (ratio >= 0.85) { breakdown.orientation = 10; reasons.push("vertical-friendly"); }
    else { breakdown.orientation = 4; reasons.push("crop-pan-eligible"); }
  }
  breakdown.license = license.allowed ? 25 : -60;
  if (license.allowed) reasons.push(license.reason); else reasons.push(license.reason === "license-not-reusable" ? "license_unknown" : "license_not_allowed");
  if (query.intent === "specific" && classification.role === "specific") { breakdown.specificity = 15; reasons.push("specific-match"); }
  if (query.intent === "gameplay" && classification.role !== "gameplay") { breakdown.specificity = -18; reasons.push("gameplay_evidence_missing"); }
  return { score: Object.values(breakdown).reduce((total, value) => total + value, 0), scoreBreakdown: breakdown, reasons, license, quality, classification };
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
