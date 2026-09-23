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
export const RIGHTS_CLASSES = Object.freeze({
  OPEN_LICENSE: "open_license",
  COPYRIGHTED_EDITORIAL: "copyrighted_editorial",
  REJECTED_OR_UNKNOWN: "rejected_or_unknown"
});
export const EDITORIAL_FORMS = Object.freeze(["screenshot", "lifestyle", "clean_art", "physical_case", "product", "logo", "contextual"]);

const COPYRIGHTED_EDITORIAL_FIELDS = [
  "copyright_owner", "source_type", "source_url", "provenance_page_url", "source_domain",
  "retrieved_at", "attribution", "provenance_status", "official_source_registry_id"
];

export function inspectMetadata(candidate, { rights = null } = {}) {
  const missingFields = [];
  if (!candidate.provider) missingFields.push("source");
  if (!candidate.sourceUrl) missingFields.push("source_url");
  if (!candidate.title) missingFields.push("title");
  if (rights?.rightsClass === RIGHTS_CLASSES.COPYRIGHTED_EDITORIAL) {
    for (const field of COPYRIGHTED_EDITORIAL_FIELDS) {
      const key = field.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
      if (!candidate[field] && !candidate[key]) missingFields.push(field);
    }
  } else if (!candidate.license || /unknown/i.test(candidate.license)) missingFields.push("license");
  const warnings = [];
  if (!candidate.creator) warnings.push("creator_missing");
  if (!candidate.licenseUrl && !/public domain|pdm/i.test(candidate.license ?? "")) warnings.push("license_url_missing");
  if (!candidate.attribution && candidate.creator) warnings.push("attribution_missing");
  return { missingFields, warnings };
}

function configuredRegistryEntry(candidate, registry = []) {
  const id = candidate.official_source_registry_id ?? candidate.officialSourceRegistryId;
  const entry = (registry ?? []).find((item) => item?.id === id && item.approved === true);
  if (!entry) return null;
  const provenanceUrl = candidate.provenance_page_url ?? candidate.provenancePageUrl;
  const sourceUrl = candidate.sourceUrl ?? candidate.source_url;
  let provenanceDomain;
  let sourceDomain;
  try {
    provenanceDomain = new URL(provenanceUrl).hostname.toLowerCase();
    sourceDomain = new URL(sourceUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  const allowedPages = entry.domains ?? [];
  const allowedAssets = [...allowedPages, ...(entry.cdn_domains ?? [])];
  const sourceType = candidate.source_type ?? candidate.sourceType;
  if (!allowedPages.includes(provenanceDomain) || !allowedAssets.includes(sourceDomain) || !(entry.source_types ?? []).includes(sourceType)) return null;
  return entry;
}

export function classifyRights(candidate, { copyrightedEditorialEnabled = false, allowCopyrightedEditorial = false, officialSourceRegistry = [], acceptUnknownOrRestrictedLicenses = false } = {}) {
  const requested = candidate.rights_class ?? candidate.rightsClass ?? null;
  if (requested === RIGHTS_CLASSES.COPYRIGHTED_EDITORIAL) {
    const provenancePageUrl = candidate.provenance_page_url ?? candidate.provenancePageUrl;
    const sourceDomain = candidate.source_domain ?? candidate.sourceDomain;
    const metadataComplete = COPYRIGHTED_EDITORIAL_FIELDS.every((field) => {
      const key = field.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
      return Boolean(candidate[field] ?? candidate[key]);
    });
    const registryEntry = configuredRegistryEntry(candidate, officialSourceRegistry);
    const sourceHostMatches = (() => {
      try { return new URL(candidate.sourceUrl ?? candidate.source_url).hostname.toLowerCase() === String(sourceDomain ?? "").toLowerCase(); } catch { return false; }
    })();
    const validEditorial = metadataComplete && candidate.editorial_use_only === true && candidate.license == null &&
      candidate.license_status === "no_open_license_identified" && candidate.provenance_status === "verified_first_party" &&
      Boolean(provenancePageUrl) && sourceHostMatches && Boolean(registryEntry);
    if (!validEditorial) return { accepted: false, rightsClass: RIGHTS_CLASSES.REJECTED_OR_UNKNOWN, reason: "copyrighted_editorial_provenance_invalid", provenanceConfidence: 0 };
    if (!copyrightedEditorialEnabled || !allowCopyrightedEditorial) return { accepted: false, rightsClass: RIGHTS_CLASSES.COPYRIGHTED_EDITORIAL, reason: "copyrighted_editorial_disabled", provenanceConfidence: 100 };
    return { accepted: true, rightsClass: RIGHTS_CLASSES.COPYRIGHTED_EDITORIAL, reason: "verified_first_party_editorial", provenanceConfidence: 100, registryId: registryEntry.id };
  }
  const license = allowedLicense(candidate);
  if (requested === RIGHTS_CLASSES.OPEN_LICENSE || !requested) {
    if (license.allowed) return { accepted: true, rightsClass: RIGHTS_CLASSES.OPEN_LICENSE, reason: "reusable_license", provenanceConfidence: 80 };
    if (acceptUnknownOrRestrictedLicenses) return { accepted: true, rightsClass: RIGHTS_CLASSES.REJECTED_OR_UNKNOWN, reason: "accepted_in_relaxed_library_mode", provenanceConfidence: 20 };
    return { accepted: false, rightsClass: RIGHTS_CLASSES.REJECTED_OR_UNKNOWN, reason: license.reason, provenanceConfidence: 0 };
  }
  if (acceptUnknownOrRestrictedLicenses) return { accepted: true, rightsClass: RIGHTS_CLASSES.REJECTED_OR_UNKNOWN, reason: "accepted_in_relaxed_library_mode", provenanceConfidence: 20 };
  return { accepted: false, rightsClass: RIGHTS_CLASSES.REJECTED_OR_UNKNOWN, reason: "rights_class_rejected_or_unknown", provenanceConfidence: 0 };
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

function normalizeText(value = "") {
  return String(value).toLowerCase().replace(/[-_]+/g, " ").replace(/[^a-z0-9áéíóúüñ]+/gi, " ").replace(/\s+/g, " ").trim();
}

function candidateText(candidate) {
  return {
    title: normalizeText(candidate.title),
    metadata: normalizeText(`${candidate.description ?? ""} ${(candidate.tags ?? []).join(" ")}`)
  };
}

function meaningfulTerms(value) {
  const ignored = new Set(["and", "art", "for", "from", "game", "hero", "logo", "music", "office", "official", "the", "video", "with"]);
  return [...new Set(normalizeText(value).split(" ").filter((term) => term.length > 2 && !ignored.has(term)))];
}

function includesPhrase(text, phrase) {
  return Boolean(phrase) && (` ${text} `).includes(` ${phrase} `);
}

function entityAliases(value = "") {
  const normalized = normalizeText(value);
  const aliases = {
    "playstation ps1": ["playstation", "ps1", "playstation 1", "playstation one"],
    "playstation ps2": ["playstation 2", "ps2", "playstation2"],
    "playstation ps3": ["playstation 3", "ps3", "playstation3"],
    "playstation ps4": ["playstation 4", "ps4", "playstation4"],
    "playstation ps5": ["playstation 5", "ps5", "playstation5"],
    "playstation ps5 pro": ["playstation 5 pro", "ps5 pro", "playstation5 pro"],
    "sony": ["sony", "sony interactive entertainment", "sie"],
    "mario": ["super mario", "mario bros", "mario nintendo", "mario character"],
    "link": ["link zelda", "link character", "legend of zelda link"],
    "master chief": ["master chief", "halo master chief"],
    "leon s kennedy": ["leon s kennedy", "leon kennedy", "resident evil leon"],
    "cj": ["carl johnson", "gta san andreas cj", "grand theft auto cj"],
    "niko bellic": ["niko bellic", "gta iv niko", "grand theft auto niko"]
  };
  const direct = aliases[normalized] ?? [];
  const tail = normalized.includes("/") ? normalizeText(normalized.split("/").pop()) : "";
  const ambiguousCharacter = ["mario", "link", "cj"].includes(normalized);
  return [...new Set([...(ambiguousCharacter ? [] : [normalized]), tail, ...direct].filter(Boolean))];
}

function matchesEntity(text, value) {
  return entityAliases(value).some((alias) => includesPhrase(text, alias));
}

function entityConflict(text, value = "") {
  const target = normalizeText(value);
  const rules = [
    { target: /playstation ps1$/, conflicts: /\b(?:ps2|playstation 2|ps3|playstation 3|ps4|playstation 4|ps5|playstation 5)\b/ },
    { target: /playstation ps2$/, conflicts: /\b(?:ps1|playstation 1|ps3|playstation 3|ps4|playstation 4|ps5|playstation 5)\b/ },
    { target: /playstation ps3$/, conflicts: /\b(?:ps1|playstation 1|ps2|playstation 2|ps4|playstation 4|ps5|playstation 5)\b/ },
    { target: /playstation ps4$/, conflicts: /\b(?:ps1|playstation 1|ps2|playstation 2|ps3|playstation 3|ps5|playstation 5)\b/ },
    { target: /playstation ps5 pro$/, conflicts: /\b(?:ps1|ps2|ps3|ps4|playstation [1-4])\b/ },
    { target: /playstation ps5$/, conflicts: /\b(?:ps1|ps2|ps3|ps4|playstation [1-4])\b/ },
    { target: /gamecube$/, conflicts: /\b(?:playstation|ps[1-5]|xbox|wii|switch|nintendo 64|n64)\b/ },
    { target: /nintendo 64$/, conflicts: /\b(?:playstation|ps[1-5]|xbox|gamecube|wii|switch)\b/ },
    { target: /wii u$/, conflicts: /\b(?:playstation|ps[1-5]|xbox|gamecube|switch|nintendo 64|n64)\b/ },
    { target: /nintendo switch 2$/, conflicts: /\b(?:playstation|ps[1-5]|xbox|gamecube|wii|nintendo 64|n64)\b/ }
  ];
  return rules.some((rule) => rule.target.test(target) && rule.conflicts.test(text));
}

function intentEvidence(text, intent) {
  if (intent === "map") return /\b(?:map|world map|game map|overworld|atlas|region map|level map)\b/.test(text);
  if (intent === "character") return /\b(?:character|render|artwork|official art|game|gaming|nintendo|playstation|xbox|halo|zelda|resident evil|grand theft auto|gta|super mario|mario bros)\b/.test(text);
  return true;
}

function visualEvidence(text) {
  return {
    cover: /\b(?:cover(?: art| artwork)?|box art|game box|key art|sleeve)\b/.test(text),
    official: /\b(?:official|promotional|promotion|promo|press kit|key art)\b/.test(text),
    gameplay: /\b(?:gameplay|screenshot|screen shot|in game|in game)\b/.test(text)
  };
}

export function classifyEditorialForm(candidate, query, classification = classifyAsset(candidate, query)) {
  const { title, metadata } = candidateText(candidate);
  const text = `${title} ${metadata}`.trim();
  const physicalCase = /\b(?:collection|cases?|game cases?|boxed|shelf|shelves|multiple boxes?)\b/.test(text);
  const lifestyle = /\b(?:people|person|players?|playing|hands? on|event|audience|crowd)\b/.test(text);
  if (physicalCase) return "physical_case";
  if (lifestyle) return "lifestyle";
  if (/\blogo(?:type|mark)?\b/.test(text)) return "logo";
  if (/\b(?:controller|peripheral|accessor(?:y|ies)|guitar controller|hardware)\b/.test(text)) return "product";
  if (classification.role === "cover_art" || /\b(?:cover art|box art|key art|game cover|sleeve)\b/.test(text)) return "clean_art";
  if (classification.role === "gameplay" && /\b(?:gameplay|screenshot|screen shot|in game)\b/.test(text)) return "screenshot";
  if (classification.role === "contextual_broll" || /\b(?:concert|music|stage|electric guitar)\b/.test(text)) return "contextual";
  return null;
}

function preferredForm(query) {
  return query.preferred_editorial_form ?? query.preferredEditorialForm ?? null;
}

export function visualUtility(candidate, query, { classification = classifyAsset(candidate, query), editorialForm = classifyEditorialForm(candidate, query, classification), quality = qualityTier(candidate) } = {}) {
  const preferred = preferredForm(query);
  const reasons = [];
  let score = 0;
  if (preferred && editorialForm === preferred) { score += 60; reasons.push("preferred_editorial_form"); }
  else if (preferred && editorialForm) { score -= 35; reasons.push("editorial_form_mismatch"); }
  else if (editorialForm) { score += 12; reasons.push("identified_editorial_form"); }
  if (quality.tier === "high_quality") { score += 12; reasons.push("high_quality"); }
  else if (quality.tier === "usable") { score += 4; reasons.push("usable_quality"); }
  const ratio = Number(candidate.width ?? 0) / Number(candidate.height ?? 1);
  if (editorialForm === "screenshot" && ratio >= 1.2) { score += 8; reasons.push("screenshot_landscape"); }
  if (["clean_art", "product", "logo"].includes(editorialForm) && ratio >= 0.75 && ratio <= 1.5) { score += 8; reasons.push("contain_friendly_ratio"); }
  if (editorialForm === "lifestyle" && preferred === "screenshot") { score -= 20; reasons.push("lifestyle_not_screenshot"); }
  if (editorialForm === "physical_case" && preferred === "clean_art") { score -= 20; reasons.push("physical_case_not_clean_art"); }
  return { score, editorial_form: editorialForm, preferred_editorial_form: preferred, reasons };
}

function requirementKey(requirement) {
  return [requirement.entity ?? "", requirement.asset_role, requirement.preferred_editorial_form].join("|");
}

function sceneRequirement(scene) {
  const entity = scene.target_entity ?? null;
  if (scene.visual_intent === "gameplay") return { entity, asset_role: "gameplay", preferred_editorial_form: "screenshot" };
  if (scene.visual_intent === "company_context") return { entity, asset_role: "company", preferred_editorial_form: "logo" };
  if (scene.visual_intent === "rock_music_context") return { entity: null, asset_role: "contextual_broll", preferred_editorial_form: "contextual" };
  if (["franchise_identity", "franchise_conclusion"].includes(scene.visual_intent)) return { entity, asset_role: "cover_art", preferred_editorial_form: "clean_art" };
  return null;
}

function queryRequirement(entry) {
  const text = entry.query ?? entry.text ?? "";
  const intent = entry.intent ?? entry.kind ?? "contextual_broll";
  const entity = entry.target_entity ?? entry.franchise ?? entry.company ?? null;
  if (intent === "gameplay") return { entity, asset_role: "gameplay", preferred_editorial_form: "screenshot" };
  if (intent === "cover_art") return { entity, asset_role: "cover_art", preferred_editorial_form: "clean_art" };
  if (intent === "official_art") return { entity, asset_role: "official_art", preferred_editorial_form: "clean_art" };
  if (intent === "company") return { entity, asset_role: "company", preferred_editorial_form: "logo" };
  if (intent === "specific" && /\b(?:controller|peripheral|accessor)/i.test(text)) return { entity, asset_role: "specific", preferred_editorial_form: "product" };
  if (intent === "contextual_broll") return { entity: null, asset_role: "contextual_broll", preferred_editorial_form: "contextual" };
  return null;
}

export function deriveCoverageRequirements(content) {
  const requirements = [];
  for (const scene of content.scenes ?? []) {
    const requirement = sceneRequirement(scene);
    if (requirement) requirements.push({ ...requirement, scene_id: scene.scene_id });
  }
  for (const query of content.visual_queries ?? []) {
    const requirement = queryRequirement(typeof query === "string" ? { query } : query);
    if (requirement) requirements.push(requirement);
  }
  const seen = new Set();
  return requirements.filter((requirement) => {
    const key = requirementKey(requirement);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function queryTextForRequirement(requirement) {
  const entity = requirement.entity ? `${requirement.entity} ` : "";
  const form = requirement.preferred_editorial_form;
  if (requirement.asset_role === "gameplay") return `${entity}gameplay screenshot`;
  if (requirement.asset_role === "cover_art") return `${entity}game cover art`;
  if (requirement.asset_role === "official_art") return `${entity}official promotional artwork`;
  if (requirement.asset_role === "company") return `${entity}logo`;
  if (requirement.asset_role === "specific" && form === "product") return `${entity}controller product`;
  if (requirement.asset_role === "contextual_broll") return "electric guitar concert";
  return `${entity}${requirement.asset_role}`.trim();
}

export function planEditorialQueries(content, { maxQueries = 8 } = {}) {
  const requirements = deriveCoverageRequirements(content);
  const planned = requirements.map((requirement) => ({
    text: queryTextForRequirement(requirement),
    intent: requirement.asset_role,
    target_entity: requirement.entity,
    target_category: null,
    ...requirement
  }));
  const seen = new Set();
  return planned.filter((query) => {
    const key = `${query.text.toLowerCase()}|${query.asset_role}|${query.preferred_editorial_form}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, Math.max(0, maxQueries));
}

export function coverageGaps(requirements, selected, eligible) {
  return requirements.flatMap((requirement) => {
    const matches = (item) => item.classification?.role === requirement.asset_role && item.editorialForm === requirement.preferred_editorial_form &&
      (requirement.entity == null || item.classification?.entity === requirement.entity);
    if (selected.some(matches)) return [];
    const candidateExists = eligible.some(matches);
    return [{
      entity: requirement.entity,
      asset_role: requirement.asset_role,
      preferred_editorial_form: requirement.preferred_editorial_form,
      attempted_queries: requirements.filter((item) => requirementKey(item) === requirementKey(requirement)).map(() => queryTextForRequirement(requirement)),
      reason: candidateExists ? "max_downloads_limit_or_selection" : "no_accepted_candidate"
    }];
  });
}

export function attributionLines(asset) {
  if (asset.rights_class === RIGHTS_CLASSES.COPYRIGHTED_EDITORIAL) {
    return [
      "Rights class: Copyrighted editorial",
      `Copyright owner: ${asset.copyright_owner}`,
      `Official source: ${asset.provenance_page_url}`,
      "License: No open license identified",
      "Use classification: Editorial supporting visual only",
      "Attribution/provenance documentation does not itself grant reuse permission."
    ];
  }
  return [
    "Rights class: Open license",
    `License: ${asset.license ?? "Unknown"}`,
    ...(asset.license_url ? [`License URL: ${asset.license_url}`] : [])
  ];
}

export function classifyAsset(candidate, query) {
  const { title, metadata } = candidateText(candidate);
  const text = `${title} ${metadata}`.trim();
  const target = normalizeText(query.target_entity ?? query.primary ?? "");
  const related = matchesEntity(title, target) || matchesEntity(metadata, target);
  const evidence = visualEvidence(text);
  const gameplayEvidence = evidence.gameplay;
  const companyEvidence = /activision|electronic arts|microsoft|sony|nintendo/.test(text);
  const consoleEvidence = /playstation|xbox|nintendo|console|ps1|ps2|ps3|ps4|ps5/.test(text);
  const technologyEvidence = /electric guitar|guitar|controller|peripheral|accessor|turntable/.test(text);
  if (query.intent === "gameplay" && related && gameplayEvidence) return { role: "gameplay", category: "Gameplay", entity: query.target_entity, confidence: "high" };
  if (query.intent === "character" && related) return { role: "character", category: "Personajes", entity: query.target_entity, confidence: "high" };
  if (query.intent === "official_art" && related && evidence.official) return { role: "official_art", category: "Franquicias", entity: query.target_entity, confidence: "high" };
  if ((query.intent === "cover_art" || evidence.cover) && related && evidence.cover) return { role: "cover_art", category: "Franquicias", entity: query.target_entity, confidence: "high" };
  if (evidence.official && related) return { role: "official_art", category: "Franquicias", entity: query.target_entity, confidence: "high" };
  if (query.intent === "map" && related) return { role: "map", category: "Mapas", entity: query.target_entity, confidence: "high" };
  if (query.intent === "playeconomy_graphic") return { role: "playeconomy_graphic", category: "Gráficos PLAYECONOMY", entity: null, confidence: "high" };
  if (query.intent === "company" && (related || companyEvidence)) return { role: "company", category: "Empresas", entity: query.target_entity, confidence: "high" };
  if (query.intent === "console" && related && consoleEvidence) return { role: "console", category: "Consolas", entity: query.target_entity, confidence: "high" };
  if (query.intent === "specific" && related) return { role: "specific", category: "Franquicias", entity: query.target_entity, confidence: "high" };
  if (query.intent === "technology") return { role: "technology", category: "Tecnología", entity: null, confidence: technologyEvidence ? "high" : "medium" };
  if (query.intent === "contextual_broll" || technologyEvidence) return { role: "contextual_broll", category: "Tecnología", entity: null, confidence: technologyEvidence ? "medium" : "low" };
  return { role: "contextual_broll", category: "Tecnología", entity: null, confidence: "low" };
}

export function semanticRelevance(candidate, query, classification = classifyAsset(candidate, query)) {
  const { title, metadata } = candidateText(candidate);
  const combined = `${title} ${metadata}`.trim();
  const target = normalizeText(query.target_entity ?? query.primary ?? "");
  const titleTargetMatch = matchesEntity(title, target);
  const metadataTargetMatch = matchesEntity(metadata, target);
  const targetMatched = titleTargetMatch || metadataTargetMatch;
  const conflict = entityConflict(combined, target);
  const typeEvidence = intentEvidence(combined, query.intent);
  const evidence = visualEvidence(combined);
  const queryTerms = meaningfulTerms(query.text);
  const matchedTerms = queryTerms.filter((term) => title.includes(term) || metadata.includes(term));
  const contextualPhraseMatch = ["electric guitar", "video game", "game accessories", "gaming accessories"].some((phrase) => includesPhrase(combined, phrase));
  const reasons = [];
  let score = 0;

  if (titleTargetMatch) {
    score += 75;
    reasons.push("target_entity_in_title");
  } else if (metadataTargetMatch) {
    score += 60;
    reasons.push("target_entity_in_metadata");
  }
  if (matchedTerms.length) {
    score += Math.min(matchedTerms.length, 3) * 8;
    reasons.push(`query_terms:${matchedTerms.length}/${queryTerms.length}`);
  }
  if (evidence.cover) {
    score += 30;
    reasons.push("cover_art_evidence");
  }
  if (evidence.official) {
    score += 22;
    reasons.push("official_art_evidence");
  }
  if (evidence.gameplay) {
    score += 14;
    reasons.push("gameplay_evidence");
  }
  if (!target && contextualPhraseMatch) {
    score += 16;
    reasons.push("contextual_phrase_match");
  }

  const requiresTarget = Boolean(target) && ["specific", "gameplay", "character", "cover_art", "official_art", "company", "console", "map"].includes(query.intent);
  const requiresVisualEvidence = ["cover_art", "official_art", "gameplay"].includes(query.intent);
  const contextualEnough = matchedTerms.length >= 2 || contextualPhraseMatch;
  const targetEnough = targetMatched && !conflict && typeEvidence && (!requiresVisualEvidence || evidence.cover || evidence.official || evidence.gameplay);
  const passed = requiresTarget ? targetEnough : contextualEnough;
  if (conflict) reasons.push("conflicting_entity_detected");
  if (!typeEvidence) reasons.push("intent_evidence_missing");
  if (!passed && !conflict && typeEvidence) reasons.push(requiresTarget && !targetMatched ? "target_entity_missing" : "insufficient_concept_match");
  return {
    score,
    passed,
    reasons,
    target_entity: query.target_entity ?? null,
    matched_terms: matchedTerms,
    classification_role: classification.role
  };
}

export function findDuplicate(manifest, candidate, checksum) {
  const normalizedUrl = normalizeSourceUrl(candidate.sourceUrl);
  return manifest.assets.find((asset) =>
    (normalizedUrl && asset.normalized_source_url === normalizedUrl) ||
    (checksum && asset.checksum === checksum)
  );
}

export function scoreCandidate(candidate, query, { rights = null } = {}) {
  const text = `${candidate.title ?? ""} ${candidate.description ?? ""} ${(candidate.tags ?? []).join(" ")}`.toLowerCase();
  const terms = query.text.toLowerCase().split(/\s+/).filter((term) => term.length > 2);
  const matches = terms.filter((term) => text.includes(term)).length;
  const license = allowedLicense(candidate);
  const classification = classifyAsset(candidate, query);
  const semantic = semanticRelevance(candidate, query, classification);
  const quality = qualityTier(candidate);
  const editorialForm = classifyEditorialForm(candidate, query, classification);
  const utility = visualUtility(candidate, query, { classification, editorialForm, quality });
  const resolvedRights = rights ?? classifyRights(candidate);
  const breakdown = { relevance: matches * 10, semantic_relevance: semantic.score, visual_utility: utility.score, resolution: quality.score, license: 0, orientation: 0, specificity: 0, mime: 0 };
  const reasons = [`relevance:${matches}/${terms.length}`, quality.reason];
  if (["image/jpeg", "image/png", "image/webp"].includes(candidate.mimeType)) { breakdown.mime = 8; reasons.push("supported-image"); }
  else { breakdown.mime = -20; reasons.push("unsupported_mime"); }
  if (candidate.width && candidate.height) {
    const ratio = candidate.height / candidate.width;
    if (ratio >= 0.85) { breakdown.orientation = 10; reasons.push("vertical-friendly"); }
    else { breakdown.orientation = 4; reasons.push("crop-pan-eligible"); }
  }
  breakdown.license = resolvedRights.rightsClass === RIGHTS_CLASSES.OPEN_LICENSE ? 10 : resolvedRights.accepted ? 0 : -60;
  reasons.push(resolvedRights.reason);
  if (classification.role === "cover_art") { breakdown.specificity = 35; reasons.push("cover-art-match"); }
  else if (classification.role === "official_art") { breakdown.specificity = 30; reasons.push("official-art-match"); }
  else if (query.intent === "specific" && classification.role === "specific") { breakdown.specificity = 15; reasons.push("specific-match"); }
  if (query.intent === "gameplay" && classification.role !== "gameplay") { breakdown.specificity = -18; reasons.push("gameplay_evidence_missing"); }
  reasons.push(...semantic.reasons);
  return { score: Object.values(breakdown).reduce((total, value) => total + value, 0), scoreBreakdown: breakdown, reasons, license, rights: resolvedRights, quality, classification, editorialForm, visualUtility: utility, semantic };
}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function assetRecord(candidate, overrides = {}) {
  return {
    id: overrides.id ?? `asset-${createHash("sha256").update(normalizeSourceUrl(candidate.sourceUrl ?? candidate.title ?? "asset")).digest("hex").slice(0, 16)}`,
    filename: overrides.filename ?? null,
    title: candidate.title ?? null,
    type: candidate.type ?? "image",
    category: candidate.category ?? null,
    asset_role: candidate.assetRole ?? null,
    query: overrides.query ?? null,
    query_intent: overrides.queryIntent ?? null,
    semantic_relevance: overrides.semanticRelevance ?? null,
    quality_tier: overrides.qualityTier ?? null,
    total_score: overrides.totalScore ?? null,
    final_category: candidate.category ?? null,
    final_entity: candidate.finalEntity ?? null,
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
    rights_class: overrides.rightsClass ?? candidate.rights_class ?? null,
    copyright_owner: candidate.copyright_owner ?? null,
    source_type: candidate.source_type ?? null,
    provenance_page_url: candidate.provenance_page_url ?? null,
    source_domain: candidate.source_domain ?? null,
    retrieved_at: candidate.retrieved_at ?? null,
    editorial_use_only: candidate.editorial_use_only ?? false,
    license_status: candidate.license_status ?? null,
    provenance_status: candidate.provenance_status ?? null,
    official_source_registry_id: candidate.official_source_registry_id ?? null,
    editorial_form: overrides.editorialForm ?? candidate.editorial_form ?? null,
    visual_utility: overrides.visualUtility ?? candidate.visual_utility ?? null,
    download_date: overrides.downloadDate ?? null,
    width: candidate.width ?? null,
    height: candidate.height ?? null,
    duration: candidate.duration ?? null,
    orientation: candidate.width && candidate.height ? (candidate.height > candidate.width ? "portrait" : candidate.height < candidate.width ? "landscape" : "square") : null,
    mime_type: candidate.mimeType ?? null,
    checksum: overrides.checksum ?? null,
    drive_path: overrides.drivePath ?? null,
    drive_file_id: overrides.driveFileId ?? null,
    drive_folder_id: overrides.driveFolderId ?? null,
    upload_status: overrides.uploadStatus ?? null,
    upload_date: overrides.uploadDate ?? null,
    upload_error: overrides.uploadError ?? null,
    local_cache_path: overrides.localCachePath ?? null,
    reusable: overrides.reusable ?? false,
    status: overrides.status ?? "candidate"
  };
}
