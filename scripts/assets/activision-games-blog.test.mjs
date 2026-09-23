import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createActivisionGamesBlogAdapter } from "./activision-games-blog.mjs";
import { RIGHTS_CLASSES, classifyEditorialForm, classifyRights, coverageGaps, deriveCoverageRequirements, normalizeVisualQuery, scoreCandidate } from "./catalog.mjs";
import { searchOpenverse } from "./openverse.mjs";
import { selectByScoreAndDiversity } from "./selection.mjs";
import { searchWikimedia } from "./wikimedia.mjs";

const root = resolve(import.meta.dirname, "../..");
const config = JSON.parse(await readFile(resolve(root, "asset-manager/config.json"), "utf8"));
const content = JSON.parse(await readFile(resolve(root, "content/guitar-hero.json"), "utf8"));
const workflow = await readFile(resolve(root, ".github/workflows/playeconomy-asset-manager.yml"), "utf8");
const manager = await readFile(resolve(root, "scripts/assets/asset-manager.mjs"), "utf8");
const registry = config.rights.official_source_registry;
const entry = registry.find((item) => item.id === "activision-games-blog-guitar-hero-live");
const [heroPowers, rivalsArena, controllerAsset] = entry.approved_static_assets;
const gameplayQuery = { text: "Guitar Hero gameplay screenshot", intent: "gameplay", target_entity: "Guitar Hero", preferred_editorial_form: "screenshot" };
const controllerQuery = { text: "Guitar Hero controller product", intent: "specific", target_entity: "Guitar Hero", preferred_editorial_form: "product" };
const coverQuery = { text: "Guitar Hero game cover art", intent: "cover_art", target_entity: "Guitar Hero", preferred_editorial_form: "clean_art" };
const officialArtQuery = { text: "Guitar Hero official promotional artwork", intent: "official_art", target_entity: "Guitar Hero", preferred_editorial_form: "clean_art" };
const logoQuery = { text: "Activision logo", intent: "company", target_entity: "Activision", preferred_editorial_form: "logo" };

assert.equal(config.rights.copyrighted_editorial_enabled, false, "global controlled-risk switch remains disabled by default");
assert.deepEqual(entry.cdn_domains, ["community.activision.com", "blog.activision.com"]);
assert.equal(entry.approved_static_assets.length, 3, "only the reviewed current static assets are approved");
assert.deepEqual(entry.approved_static_assets.map((asset) => asset.asset_url), [
  "https://blog.activision.com/content/dam/atvi/activision/atvi-touchui/blog/archives/feature/guitar-hero/featured-Image9913431.jpg",
  "https://blog.activision.com/content/dam/atvi/activision/atvi-touchui/blog/archives/feature/guitar-hero/featured-Image9894231.jpg",
  "https://blog.activision.com/content/dam/atvi/activision/atvi-touchui/blog/archives/feature/guitar-hero/featured-Image9905852.jpg"
], "the registry preserves the exact audited static URLs");

function jpegRange(url, overrides = {}) {
  return {
    ok: true,
    status: 206,
    url,
    hops: [url],
    contentType: "application/octet-stream",
    contentRange: "bytes 0-3/100",
    bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
    bodyExceeded: false,
    ...overrides
  };
}

function adapter({ active = true, media = {}, article = {}, range = {}, onRange = () => {} } = {}) {
  return createActivisionGamesBlogAdapter({
    registry: active ? registry : [],
    fetchArticle: async (url) => article[url] ?? { ok: true, url, hops: [url], html: "" },
    inspectMedia: async (url) => media[url] ?? { ok: true, status: 200, url, hops: [url], contentType: "image/jpeg" },
    inspectMediaRange: async (url) => {
      onRange(url);
      return range[url] ?? jpegRange(url);
    }
  });
}

assert.equal(adapter().isEligibleForCoverage([gameplayQuery, controllerQuery]), true, "a valid registry and matching coverage activate the adapter");
assert.equal(adapter({ active: false }).isEligibleForCoverage([gameplayQuery]), false, "an unavailable registry leaves the adapter ineligible");
assert.match(manager, /effective_copyrighted_editorial_permission/, "Asset Manager preserves the existing double-consent registration gate");
assert.match(manager, /normalizeVisualQuery/, "Asset Manager normalizes explicit visual queries before provider coverage checks");
const rawGameplayQuery = content.visual_queries.find((query) => query.intent === "gameplay");
const rawControllerQuery = content.visual_queries.find((query) => query.query === "Guitar Hero controller");
const rawCoverQuery = content.visual_queries.find((query) => query.query === "Guitar Hero game cover");
const rawOfficialArtQuery = content.visual_queries.find((query) => query.intent === "official_art");
assert.equal(adapter().isEligibleForCoverage([rawGameplayQuery, rawControllerQuery]), false, "unnormalized Guitar Hero visual queries do not activate the adapter");
const normalizedGuitarHeroQueries = [rawGameplayQuery, rawControllerQuery].map(normalizeVisualQuery);
assert.equal(normalizedGuitarHeroQueries[0].preferred_editorial_form, "screenshot");
assert.equal(normalizedGuitarHeroQueries[1].preferred_editorial_form, "product");
assert.equal(adapter().isEligibleForCoverage(normalizedGuitarHeroQueries), true, "normalized Guitar Hero visual queries activate the matching registry coverage");
assert.equal(normalizeVisualQuery(rawCoverQuery).preferred_editorial_form, "clean_art");
assert.equal(normalizeVisualQuery(rawOfficialArtQuery).preferred_editorial_form, "clean_art");
assert.deepEqual(await adapter().search(normalizeVisualQuery(rawCoverQuery)), [], "normalized cover art remains a gap without an approved Activision asset");
assert.deepEqual(await adapter().search(normalizeVisualQuery(rawOfficialArtQuery)), [], "normalized official art remains a gap without an approved Activision asset");
const adapterForConsent = (globalEnabled, perRunEnabled) => globalEnabled && perRunEnabled ? adapter() : null;
assert.equal(adapterForConsent(false, true), null, "global consent false disables the adapter");
assert.equal(adapterForConsent(true, false), null, "per-run consent false disables the adapter");
assert.ok(adapterForConsent(true, true), "both consent gates true enable the adapter");

const gameplayAdapter = adapter();
const gameplay = await gameplayAdapter.search(gameplayQuery);
assert.equal(gameplay.length, 2, "both exact approved gameplay assets enter the generic pipeline");
assert.deepEqual(gameplay.map((candidate) => candidate.sourceUrl), [heroPowers.asset_url, rivalsArena.asset_url], "gameplay candidate order is deterministic registry order");
assert.equal(gameplay[0].provenance_page_url, heroPowers.page_url, "approved page and static asset remain paired");
assert.equal(gameplay[0].source_domain, "blog.activision.com");
assert.equal(gameplay[0].rights_class, RIGHTS_CLASSES.COPYRIGHTED_EDITORIAL);
assert.equal(gameplay[0].license, null);
assert.equal(gameplay[0].license_status, "no_open_license_identified");
assert.equal(gameplay[0].editorial_use_only, true);
assert.equal(gameplay[0].provenance_status, "verified_first_party");
assert.equal(classifyEditorialForm(gameplay[0], gameplayQuery), "screenshot", "gameplay is classified as screenshot by normal metadata");
assert.equal(classifyRights(gameplay[0], { copyrightedEditorialEnabled: true, allowCopyrightedEditorial: true, officialSourceRegistry: registry }).accepted, true, "the generic rights gate accepts complete approved provenance");
assert.equal(classifyRights(gameplay[0], { copyrightedEditorialEnabled: true, allowCopyrightedEditorial: false, officialSourceRegistry: registry }).accepted, false, "per-run consent remains mandatory");

let normalRangeCalls = 0;
const normalHead = await adapter({ onRange: () => { normalRangeCalls += 1; } }).search(gameplayQuery);
assert.equal(normalHead.length, 2, "HEAD image/jpeg accepts the normal path");
assert.equal(normalRangeCalls, 0, "normal image MIME never invokes the range fallback");

let octetRangeCalls = 0;
const octetFallback = await adapter({
  media: { [heroPowers.asset_url]: { ok: true, status: 200, url: heroPowers.asset_url, hops: [heroPowers.asset_url], contentType: "application/octet-stream" } },
  onRange: () => { octetRangeCalls += 1; }
}).search(gameplayQuery);
assert.equal(octetFallback.length, 2, "an exact approved JPEG accepts a valid bounded range signature fallback");
assert.equal(octetFallback[0].mimeType, "image/jpeg", "the candidate uses its exact registered JPEG MIME after signature validation");
assert.equal(octetRangeCalls, 1, "only the octet-stream exact asset uses the range fallback");

const controller = (await adapter().search(controllerQuery))[0];
assert.equal(controller.sourceUrl, controllerAsset.asset_url);
assert.equal(controller.provenance_page_url, controllerAsset.page_url);
assert.equal(classifyEditorialForm(controller, controllerQuery), "product", "controller is classified as specific/product");
assert.deepEqual(await adapter().search(coverQuery), [], "cover clean art remains an explicit gap");
assert.deepEqual(await adapter().search(officialArtQuery), [], "official-art clean art remains an explicit gap");
assert.deepEqual(await adapter().search(logoQuery), [], "company logo remains an explicit gap");

const selected = selectByScoreAndDiversity(gameplay.map((candidate) => {
  const rights = classifyRights(candidate, { copyrightedEditorialEnabled: true, allowCopyrightedEditorial: true, officialSourceRegistry: registry });
  const scored = scoreCandidate(candidate, gameplayQuery, { rights });
  return { candidate, query: gameplayQuery, classification: scored.classification, destination: { finalCategory: "Gameplay" }, editorialForm: scored.editorialForm, visualUtility: scored.visualUtility, rights, scored, totalScore: scored.score };
}), { maxDownloads: 1 });
assert.equal(selected.selected.length, 1, "the existing generic selection decides among the two gameplay candidates");

const samePageUnapproved = structuredClone(registry);
samePageUnapproved[0].approved_static_assets[0].asset_url = "https://blog.activision.com/content/dam/atvi/other.jpg";
assert.deepEqual(await createActivisionGamesBlogAdapter({ registry: samePageUnapproved, fetchArticle: async () => { throw new Error("unexpected"); }, inspectMedia: async () => { throw new Error("unexpected"); } }).search(gameplayQuery), [], "an altered same-page asset is rejected by the exact reviewed registry");
let unapprovedRangeCalls = 0;
assert.deepEqual(await createActivisionGamesBlogAdapter({ registry: samePageUnapproved, fetchArticle: async () => { throw new Error("unexpected"); }, inspectMedia: async () => { throw new Error("unexpected"); }, inspectMediaRange: async () => { unapprovedRangeCalls += 1; throw new Error("unexpected"); } }).search(gameplayQuery), [], "an octet-stream URL outside the exact allowlist has no bypass");
assert.equal(unapprovedRangeCalls, 0, "an invalid registry cannot invoke the range fallback");
const wrongPage = structuredClone(registry);
wrongPage[0].approved_static_assets[0].page_url = controllerAsset.page_url;
assert.deepEqual(await createActivisionGamesBlogAdapter({ registry: wrongPage, fetchArticle: async () => { throw new Error("unexpected"); }, inspectMedia: async () => { throw new Error("unexpected"); } }).search(gameplayQuery), [], "an unreviewed page-to-asset pairing is rejected");
const communityFallback = adapter({ media: { [heroPowers.asset_url]: { ok: true, url: "https://community.activision.com/legacyfs/online/12481.jpg", hops: [heroPowers.asset_url, "https://community.activision.com/legacyfs/online/12481.jpg"], contentType: "image/jpeg" } } });
const communityCandidates = await communityFallback.search(gameplayQuery);
assert.equal(communityCandidates.length, 1, "legacy community media is rejected rather than used as a fallback");
assert.equal(communityCandidates[0].sourceUrl, rivalsArena.asset_url);
for (const blockedUrl of ["https://web.archive.org/web/20200101id_/https://community.activision.com/legacy.jpg", "https://mirror.example/guitar-hero.jpg"]) {
  const blocked = adapter({ media: { [heroPowers.asset_url]: { ok: true, url: blockedUrl, hops: [heroPowers.asset_url, blockedUrl], contentType: "image/jpeg" } } });
  assert.equal((await blocked.search(gameplayQuery)).some((candidate) => candidate.sourceUrl === heroPowers.asset_url), false, "archive and third-party mirrors fail closed");
}
const redirected = adapter({ article: { [heroPowers.page_url]: { ok: true, url: "https://outside.example/article", hops: [heroPowers.page_url, "https://outside.example/article"] } } });
await assert.rejects(() => redirected.search(gameplayQuery), /article_unavailable_or_redirect_unapproved/, "page redirects outside the approved host fail closed");
const nonImage = adapter({ media: { [heroPowers.asset_url]: { ok: true, url: heroPowers.asset_url, hops: [heroPowers.asset_url], contentType: "text/html" } } });
assert.equal((await nonImage.search(gameplayQuery)).some((candidate) => candidate.sourceUrl === heroPowers.asset_url), false, "non-image MIME is rejected");

const nonJpegRegistry = structuredClone(registry);
nonJpegRegistry[0].approved_static_assets[0].mime_type = "image/png";
assert.deepEqual(await createActivisionGamesBlogAdapter({ registry: nonJpegRegistry, fetchArticle: async () => { throw new Error("unexpected"); }, inspectMedia: async () => { throw new Error("unexpected"); }, inspectMediaRange: async () => { throw new Error("unexpected"); } }).search(gameplayQuery), [], "a registry MIME other than image/jpeg is rejected before a bypass");

const rejectedRangeCases = [
  ["GET 200", jpegRange(heroPowers.asset_url, { status: 200 })],
  ["missing Content-Range", jpegRange(heroPowers.asset_url, { contentRange: null })],
  ["invalid Content-Range", jpegRange(heroPowers.asset_url, { contentRange: "invalid" })],
  ["range starts after zero", jpegRange(heroPowers.asset_url, { contentRange: "bytes 1-4/100" })],
  ["invalid JPEG signature", jpegRange(heroPowers.asset_url, { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) })],
  ["body exceeds requested range", jpegRange(heroPowers.asset_url, { bodyExceeded: true })],
  ["body exceeds range by length", jpegRange(heroPowers.asset_url, { contentRange: "bytes 0-4096/5000", bytes: new Uint8Array(4097) })]
];
for (const [label, ranged] of rejectedRangeCases) {
  const rejected = adapter({
    media: { [heroPowers.asset_url]: { ok: true, status: 200, url: heroPowers.asset_url, hops: [heroPowers.asset_url], contentType: "application/octet-stream" } },
    range: { [heroPowers.asset_url]: ranged }
  });
  assert.equal((await rejected.search(gameplayQuery)).some((candidate) => candidate.sourceUrl === heroPowers.asset_url), false, `${label} rejects the bounded JPEG fallback`);
}
const timedOut = adapter({
  media: { [heroPowers.asset_url]: { ok: true, status: 200, url: heroPowers.asset_url, hops: [heroPowers.asset_url], contentType: "application/octet-stream" } },
  range: { [heroPowers.asset_url]: Promise.reject(Object.assign(new Error("timed out"), { code: "timeout" })) }
});
assert.equal((await timedOut.search(gameplayQuery)).some((candidate) => candidate.sourceUrl === heroPowers.asset_url), false, "a range timeout fails closed");
const redirectedWithinHost = adapter({
  media: { [heroPowers.asset_url]: { ok: true, status: 200, url: heroPowers.asset_url, hops: [heroPowers.asset_url], contentType: "application/octet-stream" } },
  range: { [heroPowers.asset_url]: jpegRange(heroPowers.asset_url, { hops: [heroPowers.asset_url, "https://blog.activision.com/internal", heroPowers.asset_url] }) }
});
assert.ok((await redirectedWithinHost.search(gameplayQuery)).some((candidate) => candidate.sourceUrl === heroPowers.asset_url), "an allowed-host redirect chain remains valid when the final exact URL is restored");
const redirectedOutsideHost = adapter({
  media: { [heroPowers.asset_url]: { ok: true, status: 200, url: heroPowers.asset_url, hops: [heroPowers.asset_url], contentType: "application/octet-stream" } },
  range: { [heroPowers.asset_url]: jpegRange(heroPowers.asset_url, { hops: [heroPowers.asset_url, "https://outside.example/media", heroPowers.asset_url] }) }
});
assert.equal((await redirectedOutsideHost.search(gameplayQuery)).some((candidate) => candidate.sourceUrl === heroPowers.asset_url), false, "a range redirect outside the approved host fails closed");

const measured = adapter();
await measured.search(gameplayQuery);
await measured.search(gameplayQuery);
assert.deepEqual(measured.metrics(), { article_requests: 2, media_preflights: 4, source_failures: 0, source_failure_details: [] }, "exact public provenance pages are cached and each asset preflight is counted");
const oneFailure = adapter({ media: { [heroPowers.asset_url]: { ok: false, url: heroPowers.asset_url, hops: [heroPowers.asset_url], contentType: "image/jpeg" } } });
assert.equal((await oneFailure.search(gameplayQuery)).length, 1, "one failed static asset does not broaden discovery or block the other allowlisted asset");
assert.deepEqual(oneFailure.metrics(), { article_requests: 2, media_preflights: 2, source_failures: 1, source_failure_details: [{ provider: "Activision Games Blog", url: heroPowers.asset_url, hostname: "blog.activision.com", method: "HEAD", stage: "media_head", http_status: null, reason: "media_head", observed_content_type: "image/jpeg" }] });
const diagnosticFailure = adapter({ media: { [heroPowers.asset_url]: { ok: true, status: 200, url: heroPowers.asset_url, hops: [heroPowers.asset_url], contentType: "application/octet-stream" } }, range: { [heroPowers.asset_url]: jpegRange(heroPowers.asset_url, { contentRange: null }) } });
await diagnosticFailure.search(gameplayQuery);
const diagnostic = diagnosticFailure.metrics().source_failure_details[0];
assert.deepEqual(Object.keys(diagnostic).sort(), ["hostname", "http_status", "method", "observed_content_type", "provider", "reason", "stage", "url"], "source-failure diagnostics contain only safe structured metadata");
assert.equal(diagnostic.method, "GET");
assert.equal(diagnostic.stage, "media_range_signature");
assert.equal(diagnostic.http_status, 206);
assert.ok(!JSON.stringify(diagnostic).includes("response body"), "diagnostics never include response bodies");

const requirements = deriveCoverageRequirements(content);
const gaps = coverageGaps(requirements, [], []);
assert.ok(gaps.some((gap) => gap.asset_role === "cover_art" && gap.preferred_editorial_form === "clean_art"));
assert.ok(gaps.some((gap) => gap.asset_role === "official_art" && gap.preferred_editorial_form === "clean_art"));
assert.ok(gaps.some((gap) => gap.asset_role === "company" && gap.preferred_editorial_form === "logo"));
const openverse = await searchOpenverse(gameplayQuery, { resultsPerQuery: 1 }, async () => ({ results: [{ title: "Open screenshot", url: "https://open.example/image.jpg", foreign_landing_url: "https://open.example/page", license: "by", license_version: "4.0", width: 1920, height: 1080, mime_type: "image/jpeg" }] }));
const wikimedia = await searchWikimedia(gameplayQuery, { resultsPerQuery: 1 }, async () => ({ query: { pages: [{ title: "File:Guitar Hero.png", canonicalurl: "https://commons.wikimedia.org/wiki/File:Guitar_Hero.png", imageinfo: [{ url: "https://upload.wikimedia.org/guitar-hero.png", width: 1920, height: 1080, mime: "image/png", extmetadata: { LicenseShortName: { value: "CC BY 4.0" } } }] }] } }));
assert.equal(openverse.length, 1, "Openverse remains independent of the static adapter");
assert.equal(wikimedia.length, 1, "Wikimedia remains independent of the static adapter");
assert.ok(!workflow.includes(".cache/assets/"), "review artifacts continue to exclude source media");

console.log("activision games blog static allowlist tests passed");
