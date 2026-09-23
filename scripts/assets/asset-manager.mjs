import { mkdirSync, promises as fs } from "node:fs";
import { basename, resolve } from "node:path";
import { assetRecord, attributionLines, classifyRights, coverageGaps, deriveCoverageRequirements, findDuplicate, inspectMetadata, loadManifest, normalizeVisualQuery, planEditorialQueries, saveManifest, scoreCandidate } from "./catalog.mjs";
import { driveAuthenticatedIdentity, driveConfiguration, resolveAssetDestination, uploadToDrive, verifyDriveRoot } from "./drive.mjs";
import { hydrateDriveCatalog, persistDriveCatalog, persistBootstrapOnly, prepareBootstrapOnly } from "./drive-catalog.mjs";
import { artifactCachePath, downloadCandidate, shouldDownload } from "./download.mjs";
import { createActivisionGamesBlogAdapter } from "./activision-games-blog.mjs";
import { createPlayStationBlogAdapter } from "./playstation-blog.mjs";
import { createSonyDesignAdapter } from "./sony-design.mjs";
import { createOfficialWebAdapter } from "./official-web.mjs";
import { searchOpenverse } from "./openverse.mjs";
import { selectByScoreAndDiversity } from "./selection.mjs";
import { searchWikimedia } from "./wikimedia.mjs";
import { searchFlickrPublic } from "./flickr-public.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((arg, index, values) => arg.startsWith("--") ? [arg.slice(2), values[index + 1] ?? true] : null).filter(Boolean));
const contentPath = resolve(args.content ?? "content/guitar-hero.json");
const configPath = resolve(args.config ?? "asset-manager/config.json");
const manifestPath = resolve(args.manifest ?? "asset-manager/manifest.json");
const reportPath = resolve(args.report ?? "asset-manager/reports/latest.json");
const dryRun = String(args["dry-run"] ?? "true") !== "false";
const bootstrapOnly = String(args["bootstrap-only"] ?? "false") === "true";
const allowCopyrightedEditorial = String(args["allow-copyrighted-editorial"] ?? "false") === "true";
const expectedBootstrapAssets = args["expected-bootstrap-assets"] === undefined || args["expected-bootstrap-assets"] === "" ? null : Number(args["expected-bootstrap-assets"]);
const config = JSON.parse(await fs.readFile(configPath, "utf8"));
const rightsConfig = config.rights ?? { copyrighted_editorial_enabled: false, official_source_registry: [] };
const content = JSON.parse(await fs.readFile(contentPath, "utf8"));
const limits = { ...config.limits, maxDownloads: Math.min(Number(args["max-downloads"] ?? config.limits.maxDownloads), config.limits.maxDownloads), maxQueries: Math.min(Number(args["max-queries"] ?? config.limits.maxQueries), config.limits.maxQueries) };
let manifest = loadManifest(manifestPath);
const startedAt = Date.now();
const drive = driveConfiguration();
const report = { manager: "PlayEconomy Asset Manager V3.7.1", dry_run: dryRun, topic: content.id, limits, rights: { copyrighted_editorial_enabled: rightsConfig.copyrighted_editorial_enabled === true, allow_copyrighted_editorial: allowCopyrightedEditorial, effective_copyrighted_editorial_permission: rightsConfig.copyrighted_editorial_enabled === true && allowCopyrightedEditorial }, editorial_trial: { activision_games_blog_activated: false, activision_games_blog_article_requests: 0, activision_games_blog_media_preflights: 0, activision_games_blog_source_failures: 0, activision_games_blog_source_failure_details: [], catalog_version_before: null, catalog_version_after: null }, coverage: { requirements: [], planned_queries: [], gaps: [] }, library: { reusable_assets_found: 0 }, providers: {}, rejection_summary: {}, rejected_candidates: [], duplicates: 0, proposed_downloads: [], downloads: { attempted: 0, successful: 0, failed: 0, duplicates: 0 }, drive: { ...drive, root_verification: "not_requested", attempted: 0, successful: 0, failed: 0, duplicates_skipped: 0 }, catalog: { hydration_status: "not_requested", drive_file_id: null, schema_version: null, hydrated_assets: 0, bootstrap: { status: "not_requested", imported: 0, skipped: 0 }, update_attempted: false, update_status: "not_requested", conflict_detected: false, media_may_be_uncatalogued: false, final_persistent_asset_count: 0 }, bootstrap: { bootstrap_only: bootstrapOnly, expected_assets: expectedBootstrapAssets, imported: 0, skipped: 0, conflicts: 0, conflict_details: [], catalog_previously_existed: false, catalog_created: false, catalog_drive_file_id: null, readback_validation: "not_requested", persistent_asset_count: 0, discovery_executed: false, downloads_executed: false, uploads_executed: false }, errors: [], fallback: "editorial_v2" };
let driveReady = false;
let catalogSession = null;

async function writeReport() {
  report.finished_at = new Date().toISOString();
  mkdirSync(resolve(reportPath, ".."), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function failCatalog(error) {
  report.catalog.hydration_status = "failed";
  report.catalog.error = error.code ?? error.message;
  report.errors.push(`Drive catalog: ${report.catalog.error}`);
  await writeReport();
  throw error;
}

async function failBootstrap(error) {
  report.catalog.hydration_status = "failed";
  report.bootstrap.error = error.code ?? error.message;
  report.errors.push(`Bootstrap: ${report.bootstrap.error}`);
  await writeReport();
  throw error;
}

if (bootstrapOnly && (dryRun || !args["bootstrap-manifest"] || !Number.isInteger(expectedBootstrapAssets) || expectedBootstrapAssets < 1)) {
  const code = dryRun ? "bootstrap_only_requires_dry_run_false" : !args["bootstrap-manifest"] ? "bootstrap_only_requires_bootstrap_manifest" : "bootstrap_only_requires_expected_assets";
  await failBootstrap(Object.assign(new Error(code), { code }));
}

if (drive.configured) {
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
    await (bootstrapOnly ? failBootstrap(error) : failCatalog(error));
  }
  if (bootstrapOnly) {
    try {
      const prepared = await prepareBootstrapOnly({
        accessToken: process.env.GOOGLE_DRIVE_ACCESS_TOKEN,
        rootFolderId: drive.rootFolderId,
        bootstrapManifestPath: resolve(args["bootstrap-manifest"])
      });
      report.bootstrap.catalog_previously_existed = prepared.catalogPreviouslyExisted;
      report.bootstrap.imported = prepared.bootstrap.imported;
      report.bootstrap.skipped = prepared.bootstrap.skipped;
      report.bootstrap.conflicts = prepared.bootstrap.conflicts.length;
      report.bootstrap.conflict_details = prepared.bootstrap.conflicts;
      report.catalog.hydration_status = prepared.catalogPreviouslyExisted ? "catalog_already_exists" : "bootstrap_prepared";
      report.catalog.drive_file_id = prepared.fileId;
      report.catalog.schema_version = prepared.catalog?.schema_version ?? null;
      if (prepared.catalogPreviouslyExisted) {
        report.bootstrap.persistent_asset_count = prepared.manifest.assets.length;
        report.catalog.final_persistent_asset_count = prepared.manifest.assets.length;
      } else {
        const persisted = await persistBootstrapOnly(prepared, expectedBootstrapAssets, {
          accessToken: process.env.GOOGLE_DRIVE_ACCESS_TOKEN,
          rootFolderId: drive.rootFolderId,
          requireImageMediaType: true
        });
        manifest = { version: persisted.catalog.manifest_version, assets: persisted.catalog.assets };
        report.bootstrap.catalog_created = persisted.created;
        report.bootstrap.catalog_drive_file_id = persisted.fileId;
        report.bootstrap.readback_validation = persisted.readback_validation;
        report.bootstrap.persistent_asset_count = persisted.catalog.assets.length;
        report.catalog.hydration_status = "bootstrap_completed";
        report.catalog.drive_file_id = persisted.fileId;
        report.catalog.schema_version = persisted.catalog.schema_version;
        report.catalog.final_persistent_asset_count = persisted.catalog.assets.length;
        await saveManifest(manifestPath, manifest);
      }
      await writeReport();
    } catch (error) {
      if (error.bootstrap_readback_validation) {
        report.bootstrap.readback_validation = error.bootstrap_readback_validation;
        report.bootstrap.catalog_drive_file_id = error.bootstrap_catalog_file_id ?? null;
        report.bootstrap.catalog_created = Boolean(error.bootstrap_catalog_created);
      }
      await failBootstrap(error);
    }
  } else {
    try {
      catalogSession = await hydrateDriveCatalog({
        accessToken: process.env.GOOGLE_DRIVE_ACCESS_TOKEN,
        rootFolderId: drive.rootFolderId,
        bootstrapManifestPath: args["bootstrap-manifest"] ? resolve(args["bootstrap-manifest"]) : null
      });
      manifest = catalogSession.manifest;
      report.catalog = {
        ...report.catalog,
        hydration_status: catalogSession.hydration.status,
        drive_file_id: catalogSession.fileId,
        schema_version: catalogSession.catalog.schema_version,
        hydrated_assets: catalogSession.hydration.asset_count,
        bootstrap: catalogSession.bootstrap,
        final_persistent_asset_count: manifest.assets.length
      };
      report.editorial_trial.catalog_version_before = catalogSession.exists ? catalogSession.catalog.catalog_version : null;
      if (dryRun) report.editorial_trial.catalog_version_after = report.editorial_trial.catalog_version_before;
    } catch (error) {
      await failCatalog(error);
    }
  }
} else if (!dryRun) {
  report.drive.root_verification = "not_configured";
  report.catalog.hydration_status = "not_configured";
}
if (bootstrapOnly && !drive.configured) {
  await failBootstrap(Object.assign(new Error("bootstrap_only_requires_drive_oauth"), { code: "bootstrap_only_requires_drive_oauth" }));
}
if (!bootstrapOnly) {
report.library.reusable_assets_found = manifest.assets.filter((asset) => asset.reusable && ["approved", "uploaded"].includes(asset.status)).length;

function queriesFromContent() {
  // Library briefs declare their searches explicitly. Preserve those queries instead
  // of converting them through the scene/video coverage planner.
  if (Array.isArray(content.visual_queries) && content.visual_queries.length) {
    const planned = content.visual_queries.slice(0, Math.max(0, limits.maxQueries)).map((entry) => {
      const normalized = normalizeVisualQuery(entry);
      return {
        text: normalized.query,
        primary: normalized.query,
        intent: normalized.intent,
        asset_role: normalized.intent,
        target_entity: normalized.target_entity ?? null,
        target_category: normalized.target_category ?? null,
        preferred_editorial_form: normalized.preferred_editorial_form
      };
    });
    report.coverage.requirements = planned.map((query) => ({
      entity: query.target_entity,
      asset_role: query.asset_role,
      preferred_editorial_form: query.preferred_editorial_form
    }));
    report.coverage.planned_queries = planned.map((query) => ({
      entity: query.target_entity,
      asset_role: query.asset_role,
      preferred_editorial_form: query.preferred_editorial_form,
      target_category: query.target_category,
      query: query.text
    }));
    return planned;
  }
  const planned = planEditorialQueries(content, { maxQueries: limits.maxQueries });
  report.coverage.requirements = deriveCoverageRequirements(content);
  report.coverage.planned_queries = planned.map((query) => ({ entity: query.entity, asset_role: query.asset_role, preferred_editorial_form: query.preferred_editorial_form, query: query.text }));
  return planned.map((entry) => ({ ...entry, primary: entry.text, target_category: entry.target_category ?? "Tecnología" }));
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

async function readBoundedResponse(response, maximumBytes) {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(), bodyExceeded: false };
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) return { bytes: new Uint8Array(), bodyExceeded: true };
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, bodyExceeded: false };
}

async function requestPublic(url, { method, accept, provider, rangeBytes = null }) {
  let current = new URL(url);
  const hops = [current.toString()];
  for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limits.httpTimeoutMs);
    try {
      const headers = { "User-Agent": config.userAgent, Accept: accept };
      if (rangeBytes !== null) headers.Range = `bytes=0-${rangeBytes - 1}`;
      const response = await fetch(current, {
        method,
        redirect: "manual",
        signal: controller.signal,
        headers
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirectCount === 3) throw new Error(`${provider} redirect_invalid`);
        current = new URL(location, current);
        hops.push(current.toString());
        continue;
      }
      if (!response.ok) throw Object.assign(new Error(`${provider} HTTP ${response.status}`), { code: "http_error", status: response.status });
      const bounded = rangeBytes === null ? null : await readBoundedResponse(response, rangeBytes);
      return {
        ok: true,
        status: response.status,
        url: current.toString(),
        hops,
        contentType: response.headers.get("content-type")?.split(";")[0] ?? null,
        contentRange: response.headers.get("content-range"),
        bodyExceeded: bounded?.bodyExceeded ?? false,
        bytes: bounded?.bytes,
        html: method === "GET" && rangeBytes === null ? await response.text() : null
      };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`${provider} redirect_invalid`);
}

const queries = queriesFromContent();
const activisionAdapter = report.rights.effective_copyrighted_editorial_permission ? createActivisionGamesBlogAdapter({
  registry: rightsConfig.official_source_registry,
  fetchArticle: (url) => requestPublic(url, { method: "GET", accept: "text/html", provider: "Activision Games Blog" }),
  inspectMedia: (url) => requestPublic(url, { method: "HEAD", accept: "image/*", provider: "Activision Games Blog" }),
  inspectMediaRange: (url) => requestPublic(url, { method: "GET", accept: "image/*", provider: "Activision Games Blog", rangeBytes: 4096 })
}) : null;
const activisionActivated = activisionAdapter?.isEligibleForCoverage(queries) === true;
report.editorial_trial.activision_games_blog_activated = activisionActivated;

const playstationAdapter = report.rights.effective_copyrighted_editorial_permission ? createPlayStationBlogAdapter({
  registry: rightsConfig.official_source_registry,
  fetchArticle: (url) => requestPublic(url, { method: "GET", accept: "*/*", provider: "PlayStation Blog" }),
  inspectMedia: (url) => requestPublic(url, { method: "HEAD", accept: "image/*", provider: "PlayStation Blog" })
}) : null;
const playstationActivated = playstationAdapter?.isEligibleForCoverage(queries) === true;

const sonyDesignAdapter = report.rights.effective_copyrighted_editorial_permission ? createSonyDesignAdapter({
  fetchPage: (url) => requestPublic(url, { method: "GET", accept: "text/html", provider: "Sony Design" }),
  inspectMedia: (url) => requestPublic(url, { method: "HEAD", accept: "image/*", provider: "Sony Design" })
}) : null;
const sonyDesignActivated = sonyDesignAdapter?.isEligibleForCoverage(queries) === true;

const sonyRegistry = (rightsConfig.official_source_registry || []).find((item) => item?.id === "sony-design-playstation");
const officialSonyAdapter = report.rights.effective_copyrighted_editorial_permission && sonyRegistry ? createOfficialWebAdapter({
  registryEntry: sonyRegistry,
  fetchPage: (url) => requestPublic(url, { method: "GET", accept: "text/html", provider: "Sony Official Web" }),
  inspectMedia: (url) => requestPublic(url, { method: "HEAD", accept: "image/*", provider: "Sony Official Web" }),
  owner: "Sony Group Corporation",
  providerName: "Sony Design"
}) : null;
const officialSonyActivated = officialSonyAdapter?.isEligibleForCoverage(queries) === true;

const providers = [
  { name: "Openverse", search: (query) => searchOpenverse(query, limits, (url, _limits, provider) => request(url, provider)) },
  { name: "Wikimedia", search: (query) => searchWikimedia(query, limits, (url, _limits, provider) => request(url, provider)) },
  ...(config.providers?.flickr_public_enabled === true ? [{ name: "Flickr Public", search: (query) => searchFlickrPublic(query, limits, (url, _limits, provider) => request(url, provider)) }] : []),
  ...(activisionActivated ? [activisionAdapter] : []),
  ...(playstationActivated ? [playstationAdapter] : []),
  ...(sonyDesignActivated ? [sonyDesignAdapter] : []),
  ...(officialSonyActivated ? [officialSonyAdapter] : [])
];

const eligible = [];
for (const query of queries) {
  if (Date.now() - startedAt > limits.globalTimeoutMs) { report.errors.push("Global timeout reached; remaining providers skipped."); break; }
  for (const provider of providers) {
    const stats = report.providers[provider.name] ??= { candidates: 0, accepted: 0, rejected: 0, errors: [] };
    try {
      const candidates = await provider.search(query);
      stats.candidates += candidates.length;
      for (const candidate of candidates) {
        candidate.topic = content.id;
        const rights = classifyRights(candidate, {
          copyrightedEditorialEnabled: rightsConfig.copyrighted_editorial_enabled === true,
          allowCopyrightedEditorial,
          officialSourceRegistry: rightsConfig.official_source_registry ?? [],
          acceptUnknownOrRestrictedLicenses: rightsConfig.accept_unknown_or_restricted_licenses === true
        });
        const scored = scoreCandidate(candidate, query, { rights });
        const metadata = inspectMetadata(candidate, { rights });
        const duplicate = findDuplicate(manifest, candidate);
        const destinationRole = query.intent ?? scored.classification.role;
        const destinationEntity = query.target_entity ?? scored.classification.entity;
        const destination = resolveAssetDestination(destinationRole, { entity: destinationEntity, targetCategory: query.target_category });
        const rejectionReasons = [];
        if (duplicate) rejectionReasons.push("duplicate");
        if (!candidate.sourceUrl || !candidate.downloadUrl) rejectionReasons.push("invalid_url");
        const blockingMetadata = rightsConfig.relaxed_library_mode === true ? metadata.missingFields.filter((field) => !["license", "license_url", "creator", "attribution"].includes(field)) : metadata.missingFields;
        if (blockingMetadata.length) rejectionReasons.push("missing_metadata");
        if (!rights.accepted) rejectionReasons.push(rights.reason);
        if (scored.quality.tier === "low_resolution" || scored.quality.tier === "reject") rejectionReasons.push("insufficient_resolution");
        if (!String(candidate.mimeType ?? "").startsWith("image/")) rejectionReasons.push("unsupported_mime");
        if (!scored.semantic.passed) rejectionReasons.push("low_semantic_relevance");
        if (scored.score < config.scoring.minimumScore) rejectionReasons.push("low_relevance");
        if (rejectionReasons.length) {
          stats.rejected += 1;
          if (duplicate) report.duplicates += 1;
          rejectionReasons.forEach((reason) => report.rejection_summary[reason] = (report.rejection_summary[reason] ?? 0) + 1);
          report.rejected_candidates.push({ provider: provider.name, query: query.text, query_intent: query.intent, role: scored.classification.role, editorial_form: scored.editorialForm, target_entity: query.target_entity ?? null, resolved_destination: destination, rights, semantic_relevance: scored.semantic, rejection_reasons: [...new Set(rejectionReasons)], missing_fields: blockingMetadata, metadata_warnings: metadata.warnings, quality_tier: scored.quality.tier, visual_utility: scored.visualUtility, score_breakdown: scored.scoreBreakdown, total_score: scored.score, asset: { title: candidate.title, source_url: candidate.sourceUrl, license: candidate.license, license_url: candidate.licenseUrl, width: candidate.width, height: candidate.height } });
          continue;
        }
        candidate.assetRole = query.intent ?? scored.classification.role;
        candidate.rights_class = rights.rightsClass;
        candidate.editorial_form = scored.editorialForm;
        candidate.visual_utility = scored.visualUtility.score;
        candidate.category = destination.finalCategory;
        candidate.franchise = ["specific", "cover_art", "gameplay", "character", "official_art", "map"].includes(scored.classification.role) ? destination.finalEntity : null;
        candidate.company = scored.classification.role === "company" ? destination.finalEntity : null;
        candidate.console = scored.classification.role === "console" ? destination.finalEntity : null;
        candidate.finalEntity = destination.finalEntity;
        eligible.push({ provider: provider.name, stats, query, candidate, scored, classification: scored.classification, editorialForm: scored.editorialForm, visualUtility: scored.visualUtility, rights, metadata, destination, totalScore: scored.score });
      }
    } catch (error) { stats.errors.push(error.message); report.errors.push(`${provider.name}: ${error.message}`); }
    if (provider === activisionAdapter) {
      const metrics = activisionAdapter.metrics();
      Object.assign(report.editorial_trial, {
        activision_games_blog_article_requests: metrics.article_requests,
        activision_games_blog_media_preflights: metrics.media_preflights,
        activision_games_blog_source_failures: metrics.source_failures,
        activision_games_blog_source_failure_details: metrics.source_failure_details
      });
    }
  }
}

const selection = selectByScoreAndDiversity(eligible, limits);
report.coverage.gaps = coverageGaps(report.coverage.requirements, selection.selected, eligible);
for (const rejected of selection.rejected) {
  rejected.stats.rejected += 1;
  report.rejection_summary.diversity_limit = (report.rejection_summary.diversity_limit ?? 0) + 1;
  report.rejected_candidates.push({ provider: rejected.provider, query: rejected.query.text, query_intent: rejected.query.intent, role: rejected.classification?.role ?? null, editorial_form: rejected.editorialForm ?? null, target_entity: rejected.query.target_entity ?? null, resolved_destination: rejected.destination ?? null, rights: rejected.rights ?? null, semantic_relevance: rejected.scored?.semantic ?? null, rejection_reasons: ["diversity_limit"], missing_fields: [], metadata_warnings: rejected.metadata.warnings, quality_tier: rejected.scored.quality.tier, visual_utility: rejected.scored.visualUtility ?? null, score_breakdown: rejected.scored.scoreBreakdown, total_score: rejected.totalScore, asset: { title: rejected.candidate.title, source_url: rejected.candidate.sourceUrl, license: rejected.candidate.license } });
}

const executionChecksums = new Set();
for (const selected of selection.selected) {
  const { candidate, destination, scored, metadata, query, stats } = selected;
  const record = assetRecord(candidate, { reusable: false, status: "candidate", drivePath: destination.drivePath, query: query.text, queryIntent: query.intent, semanticRelevance: scored.semantic, qualityTier: scored.quality.tier, totalScore: scored.score, rightsClass: selected.rights.rightsClass, editorialForm: scored.editorialForm, visualUtility: scored.visualUtility.score });
  const proposal = { query: query.text, query_intent: query.intent, asset_role: scored.classification.role, editorial_form: scored.editorialForm, visual_utility: scored.visualUtility, rights: selected.rights, attribution: attributionLines(record), classification_confidence: scored.classification.confidence, target_entity: query.target_entity ?? null, final_category: destination.finalCategory, final_entity: destination.finalEntity, drive_path: destination.drivePath, semantic_relevance: scored.semantic, metadata_warnings: metadata.warnings, quality_tier: scored.quality.tier, score_breakdown: scored.scoreBreakdown, total_score: scored.score, reasons: scored.reasons, download_status: "not_requested", download_error: null, upload_status: "not_requested", upload_error: null, checksum: null, local_cache_path: null, bytes: 0, asset: record };
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
      if (driveReady) {
        report.drive.attempted += 1;
        try {
          const upload = await uploadToDrive(record, destination, { accessToken: process.env.GOOGLE_DRIVE_ACCESS_TOKEN, rootFolderId: drive.rootFolderId });
          const drivePath = upload.drive_path ?? destination.drivePath;
          Object.assign(record, { drive_file_id: upload.drive_file_id, drive_folder_id: upload.drive_folder_id, drive_path: drivePath, upload_status: upload.status, upload_date: new Date().toISOString() });
          Object.assign(proposal, { upload_status: upload.status, drive_file_id: upload.drive_file_id, drive_folder_id: upload.drive_folder_id, drive_path: drivePath });
          if (upload.status === "uploaded") {
            report.drive.successful += 1;
          } else {
            report.drive.duplicates_skipped += 1;
          }
          record.status = "uploaded";
          manifest.assets.push(record);
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
if (!dryRun && catalogSession) {
  report.catalog.update_attempted = true;
  try {
    const persisted = await persistDriveCatalog(catalogSession, manifest, {
      accessToken: process.env.GOOGLE_DRIVE_ACCESS_TOKEN,
      rootFolderId: drive.rootFolderId
    });
    report.catalog.update_status = "successful";
    report.catalog.drive_file_id = persisted.fileId;
    report.catalog.schema_version = persisted.catalog.schema_version;
    report.editorial_trial.catalog_version_after = persisted.catalog.catalog_version;
  } catch (error) {
    report.catalog.update_status = "failed";
    report.catalog.update_error = error.code ?? error.message;
    report.catalog.conflict_detected = report.catalog.update_error === "catalog_conflict";
    report.catalog.media_may_be_uncatalogued = report.drive.successful > 0 || report.drive.duplicates_skipped > 0;
    report.errors.push(`Drive catalog update: ${report.catalog.update_error}`);
  }
}
if (!report.catalog.update_attempted) report.editorial_trial.catalog_version_after = report.editorial_trial.catalog_version_before;
report.catalog.final_persistent_asset_count = manifest.assets.length;
report.finished_at = new Date().toISOString();
mkdirSync(resolve(reportPath, ".."), { recursive: true });
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (!dryRun && catalogSession) await saveManifest(manifestPath, manifest);
console.log(`[Asset Manager] Topic: ${content.id}`);
console.log(`[Asset Manager] Proposed assets: ${report.proposed_downloads.length}; fallback: ${report.fallback}`);
console.log(`[Asset Manager] Report: ${basename(reportPath)}`);
} else {
  console.log(`[Asset Manager] Bootstrap-only report: ${basename(reportPath)}`);
}
