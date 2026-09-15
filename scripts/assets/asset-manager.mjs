import { mkdirSync, promises as fs } from "node:fs";
import { basename, resolve } from "node:path";
import { assetRecord, findDuplicate, loadManifest, saveManifest, scoreCandidate } from "./catalog.mjs";
import { driveConfiguration, driveDestination } from "./drive.mjs";
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
const report = { manager: "PlayEconomy Asset Manager V3", dry_run: dryRun, topic: content.id, limits, library: { reusable_assets_found: manifest.assets.filter((asset) => asset.reusable && asset.status === "approved").length }, providers: {}, duplicates: 0, proposed_downloads: [], errors: [], fallback: "editorial_v2" };

function queriesFromContent() {
  const supplied = content.visual_queries ?? [];
  const derived = supplied.length ? supplied : (content.asset_requirements ?? []).flatMap((item) => item.queries ?? []);
  return derived.slice(0, limits.maxQueries).map((entry) => typeof entry === "string" ? { text: entry, kind: "contextual", primary: entry } : entry);
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
        candidate.category = query.category ?? "Franquicias";
        candidate.franchise = query.franchise ?? null;
        candidate.company = query.company ?? null;
        const scored = scoreCandidate(candidate, query);
        const duplicate = findDuplicate(manifest, candidate);
        if (duplicate) { report.duplicates += 1; stats.rejected += 1; continue; }
        if (!scored.license.allowed || scored.score < config.scoring.minimumScore) { stats.rejected += 1; continue; }
        if (report.proposed_downloads.length >= limits.maxDownloads) continue;
        const record = assetRecord(candidate, { reusable: false, status: "candidate", drivePath: driveDestination(candidate) });
        report.proposed_downloads.push({ query: query.text, score: scored.score, reasons: scored.reasons, asset: record });
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
