import { mkdirSync, promises as fs } from "node:fs";
import { basename, resolve } from "node:path";
import { assetRecord, findDuplicate, inspectMetadata, loadManifest, saveManifest, scoreCandidate } from "./catalog.mjs";
import { driveAuthenticatedIdentity, driveConfiguration, resolveAssetDestination, uploadToDrive, verifyDriveRoot } from "./drive.mjs";
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
const drive = driveConfiguration();
const report = { manager: "PlayEconomy Asset Manager V3.4", dry_run: dryRun, topic: content.id, limits, library: { reusable_assets_found: manifest.assets.filter((asset) => asset.reusable && asset.status === "approved").length }, providers: {}, rejection_summary: {}, rejected_candidates: [], duplicates: 0, proposed_downloads: [], downloads: { attempted: 0, successful: 0, failed: 0, duplicates: 0 }, drive: { ...drive, root_verification: dryRun ? "not_requested" : "pending", attempted: 0, successful: 0, failed: 0, duplicates_skipped: 0 }, errors: [], fallback: "editorial_v2" };

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
        const destination = resolveAssetDestination(scored.classification.role, { entity: scored.classification.entity });
        const rejectionReasons = [];
        if (duplicate) rejectionReasons.push("duplicate");
        if (!candidate.sourceUrl || !candidate.downloadUrl) rejectionReasons.push("invalid_url");
        if (metadata.missingFields.length) rejectionReasons.push("missing_metadata");
        if (!scored.license.allowed) rejectionReasons.push(scored.license.reason === "license-not-reusable" ? "license_unknown" : "license_not_allowed");
        if (scored.quality.tier === "low_resolution" || scored.quality.tier === "reject") rejectionReasons.push("insufficient_resolution");
        if (!String(candidate.mimeType ?? "").startsWith("image/")) rejectionReasons.push("unsupported_mime");
        if (!scored.semantic.passed) rejectionReasons.push("low_semantic_relevance");
        if (scored.score < config.scoring.minimumScore) rejectionReasons.push("low_relevance");
        if (rejectionReasons.length) {
          stats.rejected += 1;
          if (duplicate) report.duplicates += 1;
          rejectionReasons.forEach((reason) => report.rejection_summary[reason] = (report.rejection_summary[reason] ?? 0) + 1);
          report.rejected_candidates.push({ provider: provider.name, query: query.text, query_intent: query.intent, role: scored.classification.role, target_entity: query.target_entity ?? null, resolved_destination: destination, semantic_relevance: scored.semantic, rejection_reasons: [...new Set(rejectionReasons)], missing_fields: metadata.missingFields, metadata_warnings: metadata.warnings, quality_tier: scored.quality.tier, score_breakdown: scored.scoreBreakdown, total_score: scored.score, asset: { title: candidate.title, source_url: candidate.sourceUrl, license: candidate.license, license_url: candidate.licenseUrl, width: candidate.width, height: candidate.height } });
          continue;
        }
        candidate.assetRole = scored.classification.role;
        candidate.category = destination.finalCategory;
        candidate.franchise = ["specific", "cover_art", "gameplay", "character", "official_art", "map"].includes(scored.classification.role) ? destination.finalEntity : null;
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
  report.rejected_candidates.push({ provider: rejected.provider, query: rejected.query.text, query_intent: rejected.query.intent, role: rejected.classification?.role ?? null, target_entity: rejected.query.target_entity ?? null, resolved_destination: rejected.destination ?? null, semantic_relevance: rejected.scored?.semantic ?? null, rejection_reasons: ["diversity_limit"], missing_fields: [], metadata_warnings: rejected.metadata.warnings, quality_tier: rejected.scored.quality.tier, score_breakdown: rejected.scored.scoreBreakdown, total_score: rejected.totalScore, asset: { title: rejected.candidate.title, source_url: rejected.candidate.sourceUrl, license: rejected.candidate.license } });
}

let driveReady = false;
if (!dryRun && drive.configured) {
  try {
    report.drive.authenticated_identity = await driveAuthenticatedIdentity({ accessToken: process.env.GOOGLE_DRIVE_ACCESS_TOKEN });
    report.drive.identity_check = "verified";
  } catch (error) {
    report.drive.identity_check = "failed";
    report.drive.identity_error = error.code ?? error.message;
  }
  try {
    await verifyDriveRoot({ accessToken: process.env.GOOGLE_DRIVE_ACCESS_TOKEN, rootFolderId: drive.rootFolderId });
    report.drive.root_verification = "verified";
    driveReady = true;
  } catch (error) {
    report.drive.root_verification = "failed";
    report.drive.root_verification_error = error.code ?? error.message;
    report.drive.root_verification_reason = error.details?.reason ?? null;
    report.drive.root_verification_message = error.details?.message ?? null;
    report.errors.push(`Drive root verification: ${report.drive.root_verification_error}${report.drive.root_verification_reason ? ` (${report.drive.root_verification_reason})` : ""}`);
  }
} else if (!dryRun) {
  report.drive.root_verification = "not_configured";
}

const executionChecksums = new Set();
for (const selected of selection.selected) {
  const { candidate, destination, scored, metadata, query, stats } = selected;
  const record = assetRecord(candidate, { reusable: false, status: "candidate", drivePath: destination.drivePath, query: query.text, queryIntent: query.intent, semanticRelevance: scored.semantic, qualityTier: scored.quality.tier, totalScore: scored.score });
  const proposal = { query: query.text, query_intent: query.intent, asset_role: scored.classification.role, classification_confidence: scored.classification.confidence, target_entity: query.target_entity ?? null, final_category: destination.finalCategory, final_entity: destination.finalEntity, drive_path: destination.drivePath, semantic_relevance: scored.semantic, metadata_warnings: metadata.warnings, quality_tier: scored.quality.tier, score_breakdown: scored.scoreBreakdown, total_score: scored.score, reasons: scored.reasons, download_status: "not_requested", download_error: null, upload_status: "not_requested", upload_error: null, checksum: null, local_cache_path: null, bytes: 0, asset: record };
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
      if (driveReady) {
        report.drive.attempted += 1;
        try {
          const upload = await uploadToDrive(record, destination, { accessToken: process.env.GOOGLE_DRIVE_ACCESS_TOKEN, rootFolderId: drive.rootFolderId });
          Object.assign(record, { drive_file_id: upload.drive_file_id, drive_folder_id: upload.drive_folder_id, drive_path: upload.drive_path, upload_status: upload.status, upload_date: new Date().toISOString() });
          Object.assign(proposal, { upload_status: upload.status, drive_file_id: upload.drive_file_id, drive_folder_id: upload.drive_folder_id, drive_path: upload.drive_path });
          if (upload.status === "uploaded") {
            record.status = "uploaded";
            report.drive.successful += 1;
          } else {
            report.drive.duplicates_skipped += 1;
          }
        } catch (error) {
          const uploadDiagnostic = {
            http_status: error.status ?? null,
            reason: error.details?.reason ?? null,
            message: error.details?.message ?? null,
            stage: error.operation ?? "unknown",
            target_folder_id: error.target_folder_id ?? null,
            target_path: error.target_path ?? null
          };
          record.upload_status = "failed";
          record.upload_error = error.code ?? error.message;
          record.upload_diagnostic = uploadDiagnostic;
          proposal.upload_status = "failed";
          proposal.upload_error = record.upload_error;
          proposal.upload_diagnostic = uploadDiagnostic;
          report.drive.failed += 1;
          report.errors.push(`Drive upload ${record.id}: ${record.upload_error} at ${uploadDiagnostic.stage}`);
        }
      } else if (!dryRun) {
        const reason = report.drive.root_verification === "not_configured" ? "drive_not_configured" : "drive_root_not_verified";
        Object.assign(record, { upload_status: "not_attempted", upload_error: reason });
        Object.assign(proposal, { upload_status: "not_attempted", upload_error: reason });
      }
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
report.finished_at = new Date().toISOString();
mkdirSync(resolve(reportPath, ".."), { recursive: true });
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (!dryRun) await saveManifest(manifestPath, manifest);
console.log(`[Asset Manager] Topic: ${content.id}`);
console.log(`[Asset Manager] Proposed assets: ${report.proposed_downloads.length}; fallback: ${report.fallback}`);
console.log(`[Asset Manager] Report: ${basename(reportPath)}`);
