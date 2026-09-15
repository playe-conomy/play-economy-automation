import { mkdirSync, promises as fs } from "node:fs";
import { basename, resolve } from "node:path";
import { assetRecord, findDuplicate, inspectMetadata, loadManifest, saveManifest, scoreCandidate } from "./catalog.mjs";
import { driveConfiguration, resolveAssetDestination } from "./drive.mjs";
import { searchOpenverse } from "./openverse.mjs";
import { searchWikimedia } from "./wikimedia.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((arg, index, values) => arg.startsWith("--") ? [arg.slice(2), values[index + 1] ?? true] : null).filter(Boolean));
const contentPath = resolve(args.content ?? "content/guitar-hero.json");
const configPath = resolve(args.config ?? "asset-manager/config.json");
const manifestPath = resolve(args.manifest ?? "asset-manager/manifest.json");
const reportPath = resolve(args.report ?? "asset-manager/reports/latest.json");
const dryRun = String(args["dry-run"] ?? "true") !== "false";
const config = JSON.parse(await fs.readFile(configPath, "utf8"));
const content = JSON.parse(await fs.readFile(contentPath, "utf8"));
const limits = { ...config.limits, maxDownloads: Math.min(Number(args["max-downloads"] ?? config.limits.maxDownloads), config.limits.maxDownloads), maxQueries: Math.min(Number(args["max-queries"] ?? config.limits.maxQueries), config.limits.maxQueries) };
const manifest = loadManifest(manifestPath);
const startedAt = Date.now();
const report = { manager: "PlayEconomy Asset Manager V3.1.1", dry_run: dryRun, topic: content.id, limits, library: { reusable_assets_found: manifest.assets.filter((asset) => asset.reusable && asset.status === "approved").length }, providers: {}, rejection_summary: {}, rejected_candidates: [], duplicates: 0, proposed_downloads: [], errors: [], fallback: "editorial_v2" };

function queriesFromContent() {
  const supplied = content.visual_queries ?? [];
  const derived = supplied.length ? supplied : (content.asset_requirements ?? []).flatMap((item) => item.queries ?? []);
  return derived.slice(0, limits.maxQueries).map((entry) => typeof entry === "string" ? { text: entry, intent: "contextual_broll", target_category: "Tecnología", primary: entry } : { ...entry, text: entry.query ?? entry.text, intent: entry.intent ?? entry.kind ?? "contextual_broll", target_entity: entry.target_entity ?? entry.franchise ?? entry.company ?? null, target_category: entry.target_category ?? entry.category ?? "Tecnología" });
}

async function request(url, provider) {
  let lastError;
  for (let attempt = 0; attempt <= limits.maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limits.httpTimeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { "User-Agent": config.userAgent, Accept: "application/json" } });
      if (response.ok) return response.json();
      const retryable = response.status === 429 || response.status >= 500;
      lastError = new Error(`${provider} HTTP ${response.status}`);
      if (!retryable || attempt === limits.maxRetries) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, limits.backoffMs * (2 ** attempt)));
    } catch (error) {
      lastError = error;
      if (attempt === limits.maxRetries) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, limits.backoffMs * (2 ** attempt)));
    } finally { clearTimeout(timer); }
  }
  throw lastError;
}

const providers = [
  { name: "Openverse", search: (query) => searchOpenverse(query, limits, (url, _limits, provider) => request(url, provider)) },
  { name: "Wikimedia", search: (query) => searchWikimedia(query, limits, (url, _limits, provider) => request(url, provider)) }
];

for (const query of queriesFromContent()) {
  if (Date.now() - startedAt > limits.globalTimeoutMs) { report.errors.push("Global timeout reached; remaining providers skipped."); break; }
  for (const provider of providers) {
    const stats = report.providers[provider.name] ??= { candidates: 0, accepted: 0, rejected: 0, errors: [] };
    try {
      const candidates = await provider.search(query);
      stats.candidates += candidates.length;
      for (const candidate of candidates) {
        candidate.topic = content.id;
        const scored = scoreCandidate(candidate, query);
        const metadata = inspectMetadata(candidate);
        const duplicate = findDuplicate(manifest, candidate);
        const rejectionReasons = [];
        if (duplicate) rejectionReasons.push("duplicate");
        if (!candidate.sourceUrl || !candidate.downloadUrl) rejectionReasons.push("invalid_url");
        if (metadata.missingFields.length) rejectionReasons.push("missing_metadata");
        if (!scored.license.allowed) rejectionReasons.push(scored.license.reason === "license-not-reusable" ? "license_unknown" : "license_not_allowed");
        if (scored.quality.tier === "low_resolution" || scored.quality.tier === "reject") rejectionReasons.push("insufficient_resolution");
        if (!String(candidate.mimeType ?? "").startsWith("image/")) rejectionReasons.push("unsupported_mime");
        if (scored.score < config.scoring.minimumScore) rejectionReasons.push("low_relevance");
        if (rejectionReasons.length) {
          stats.rejected += 1;
          if (duplicate) report.duplicates += 1;
          rejectionReasons.forEach((reason) => report.rejection_summary[reason] = (report.rejection_summary[reason] ?? 0) + 1);
          report.rejected_candidates.push({ provider: provider.name, query: query.text, query_intent: query.intent, rejection_reasons: [...new Set(rejectionReasons)], missing_fields: metadata.missingFields, metadata_warnings: metadata.warnings, quality_tier: scored.quality.tier, score_breakdown: scored.scoreBreakdown, total_score: scored.score, asset: { title: candidate.title, source_url: candidate.sourceUrl, license: candidate.license, license_url: candidate.licenseUrl, width: candidate.width, height: candidate.height } });
          continue;
        }
        if (report.proposed_downloads.length >= limits.maxDownloads) continue;
        const destination = resolveAssetDestination(scored.classification.role, { entity: scored.classification.entity });
        candidate.assetRole = scored.classification.role;
        candidate.category = destination.finalCategory;
        candidate.franchise = ["specific", "gameplay", "character", "official_art", "map"].includes(scored.classification.role) ? destination.finalEntity : null;
        candidate.company = scored.classification.role === "company" ? destination.finalEntity : null;
        candidate.console = scored.classification.role === "console" ? destination.finalEntity : null;
        const similar = report.proposed_downloads.filter((item) => item.asset_role === scored.classification.role && item.asset.category === candidate.category && item.query === query.text);
        if (similar.length >= 2) { report.rejection_summary.diversity_limit = (report.rejection_summary.diversity_limit ?? 0) + 1; stats.rejected += 1; report.rejected_candidates.push({ provider: provider.name, query: query.text, query_intent: query.intent, rejection_reasons: ["diversity_limit"], missing_fields: [], metadata_warnings: metadata.warnings, quality_tier: scored.quality.tier, score_breakdown: scored.scoreBreakdown, total_score: scored.score, asset: { title: candidate.title, source_url: candidate.sourceUrl, license: candidate.license } }); continue; }
        const record = assetRecord(candidate, { reusable: false, status: "candidate", drivePath: destination.drivePath });
        report.proposed_downloads.push({ query: query.text, query_intent: query.intent, asset_role: scored.classification.role, classification_confidence: scored.classification.confidence, final_category: destination.finalCategory, final_entity: destination.finalEntity, drive_path: destination.drivePath, metadata_warnings: metadata.warnings, quality_tier: scored.quality.tier, score_breakdown: scored.scoreBreakdown, total_score: scored.score, reasons: scored.reasons, asset: record });
        stats.accepted += 1;
      }
    } catch (error) { stats.errors.push(error.message); report.errors.push(`${provider.name}: ${error.message}`); }
  }
}

report.fallback = report.proposed_downloads.length ? "not-required-after-approval" : "editorial_v2";
report.drive = driveConfiguration();
report.finished_at = new Date().toISOString();
mkdirSync(resolve(reportPath, ".."), { recursive: true });
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (!dryRun) await saveManifest(manifestPath, manifest);
console.log(`[Asset Manager] Topic: ${content.id}`);
console.log(`[Asset Manager] Proposed assets: ${report.proposed_downloads.length}; fallback: ${report.fallback}`);
console.log(`[Asset Manager] Report: ${basename(reportPath)}`);
