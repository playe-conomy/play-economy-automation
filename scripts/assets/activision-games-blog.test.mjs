import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createActivisionGamesBlogAdapter } from "./activision-games-blog.mjs";
import { RIGHTS_CLASSES, classifyEditorialForm, classifyRights, coverageGaps, deriveCoverageRequirements, scoreCandidate } from "./catalog.mjs";
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

function adapter({ active = true, media = {}, article = {} } = {}) {
  return createActivisionGamesBlogAdapter({
    registry: active ? registry : [],
    fetchArticle: async (url) => article[url] ?? { ok: true, url, hops: [url], html: "" },
    inspectMedia: async (url) => media[url] ?? { ok: true, url, hops: [url], contentType: "image/jpeg" }
  });
}

assert.equal(adapter().isEligibleForCoverage([gameplayQuery, controllerQuery]), true, "a valid registry and matching coverage activate the adapter");
assert.equal(adapter({ active: false }).isEligibleForCoverage([gameplayQuery]), false, "an unavailable registry leaves the adapter ineligible");
assert.match(manager, /effective_copyrighted_editorial_permission/, "Asset Manager preserves the existing double-consent registration gate");
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

const measured = adapter();
await measured.search(gameplayQuery);
await measured.search(gameplayQuery);
assert.deepEqual(measured.metrics(), { article_requests: 2, media_preflights: 4, source_failures: 0 }, "exact public provenance pages are cached and each asset preflight is counted");
const oneFailure = adapter({ media: { [heroPowers.asset_url]: { ok: false, url: heroPowers.asset_url, hops: [heroPowers.asset_url], contentType: "image/jpeg" } } });
assert.equal((await oneFailure.search(gameplayQuery)).length, 1, "one failed static asset does not broaden discovery or block the other allowlisted asset");
assert.deepEqual(oneFailure.metrics(), { article_requests: 2, media_preflights: 2, source_failures: 1 });

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
