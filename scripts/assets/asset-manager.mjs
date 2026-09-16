import { mkdirSync, promises as fs } from "node:fs";
import { basename, resolve } from "node:path";
import { assetRecord, findDuplicate, inspectMetadata, loadManifest, saveManifest, scoreCandidate } from "./catalog.mjs";
import { driveConfiguration, resolveAssetDestination } from "./drive.mjs";
import { artifactCachePath, downloadCandidate, shouldDownload } from "./download.mjs";
import { searchOpenverse } from "./openverse.mjs";
import { selectByScoreAndDiversity } from "./selection.mjs";
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
const report = { manager: "PlayEconomy Asset Manager V3.2", dry_run: dryRun, topic: content.id, limits, library: { reusable_assets_found: manifest.assets.filter((asset) => asset.reusable && asset.status === "approved").length }, providers: {}, rejection_summary: {}, rejected_candidates: [], duplicates: 0, proposed_downloads: [], downloads: { attempted: 0, successful: 0, failed: 0, duplicates: 0 }, errors: [], fallback: "editorial_v2" };

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

const eligible = [];
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
        const destination = resolveAssetDestination(scored.classification.role, { entity: scored.classification.entity });
        candidate.assetRole = scored.classification.role;
        candidate.category = destination.finalCategory;
        candidate.franchise = ["specific", "gameplay", "character", "official_art", "map"].includes(scored.classification.role) ? destination.finalEntity : null;
        candidate.company = scored.classification.role === "company" ? destination.finalEntity : null;
        candidate.console = scored.classification.role === "console" ? destination.finalEntity : null;
        candidate.finalEntity = destination.finalEntity;
        eligible.push({ provider: provider.name, stats, query, candidate, scored, classification: scored.classification, metadata, destination, totalScore: scored.score });
      }
    } catch (error) { stats.errors.push(error.message); report.errors.push(`${provider.name}: ${error.message}`); }
  }
}

const selection = selectByScoreAndDiversity(eligible, limits);
for (const rejected of selection.rejected) {
  rejected.stats.rejected += 1;
  report.rejection_summary.diversity_limit = (report.rejection_summary.diversity_limit ?? 0) + 1;
  report.rejected_candidates.push({ provider: rejected.provider, query: rejected.query.text, query_intent: rejected.query.intent, rejection_reasons: ["diversity_limit"], missing_fields: [], metadata_warnings: rejected.metadata.warnings, quality_tier: rejected.scored.quality.tier, score_breakdown: rejected.scored.scoreBreakdown, total_score: rejected.totalScore, asset: { title: rejected.candidate.title, source_url: rejected.candidate.sourceUrl, license: rejected.candidate.license } });
}

const executionChecksums = new Set();
for (const selected of selection.selected) {
  const { candidate, destination, scored, metadata, query, stats } = selected;
  const record = assetRecord(candidate, { reusable: false, status: "candidate", drivePath: destination.drivePath });
  const proposal = { query: query.text, query_intent: query.intent, asset_role: scored.classification.role, classification_confidence: scored.classification.confidence, final_category: destination.finalCategory, final_entity: destination.finalEntity, drive_path: destination.drivePath, metadata_warnings: metadata.warnings, quality_tier: scored.quality.tier, score_breakdown: scored.scoreBreakdown, total_score: scored.score, reasons: scored.reasons, download_status: "not_requested", download_error: null, checksum: null, local_cache_path: null, bytes: 0, asset: record };
  if (shouldDownload(dryRun) && Date.now() - startedAt > limits.globalTimeoutMs) {
    proposal.download_status = "error";
    proposal.download_error = "global_timeout";
    report.downloads.failed += 1;
    record.status = "error";
  } else if (shouldDownload(dryRun)) {
    report.downloads.attempted += 1;
    const outcome = await downloadCandidate({ ...candidate, id: record.id }, { cacheDir: resolve(artifactCachePath()), maxFileBytes: limits.maxFileBytes, httpTimeoutMs: limits.httpTimeoutMs, maxRetries: limits.maxRetries, backoffMs: limits.backoffMs, manifestAssets: manifest.assets, executionChecksums });
    Object.assign(proposal, { download_status: outcome.status, download_error: outcome.download_error, checksum: outcome.checksum, local_cache_path: outcome.local_cache_path, bytes: outcome.bytes });
    if (outcome.status === "downloaded") {
      report.downloads.successful += 1;
      Object.assign(record, { filename: outcome.filename, mime_type: outcome.mime_type, checksum: outcome.checksum, local_cache_path: outcome.local_cache_path, download_date: new Date().toISOString(), reusable: true, status: "downloaded" });
      manifest.assets.push(record);
    } else if (outcome.status === "duplicate") {
      report.downloads.duplicates += 1;
      record.status = "duplicate";
    } else {
      report.downloads.failed += 1;
      record.status = "error";
    }
  }
  report.proposed_downloads.push(proposal);
  stats.accepted += 1;
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
