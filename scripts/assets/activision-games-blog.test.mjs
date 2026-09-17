import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { APPROVED_ARTICLES, createActivisionGamesBlogAdapter, extractApprovedArticleMedia } from "./activision-games-blog.mjs";
import { RIGHTS_CLASSES, classifyEditorialForm, classifyRights, scoreCandidate } from "./catalog.mjs";
import { searchOpenverse } from "./openverse.mjs";
import { selectByScoreAndDiversity } from "./selection.mjs";
import { searchWikimedia } from "./wikimedia.mjs";

const root = resolve(import.meta.dirname, "../..");
const config = JSON.parse(await readFile(resolve(root, "asset-manager/config.json"), "utf8"));
const workflow = await readFile(resolve(root, ".github/workflows/playeconomy-asset-manager.yml"), "utf8");
const manager = await readFile(resolve(root, "scripts/assets/asset-manager.mjs"), "utf8");
const registry = config.rights.official_source_registry;
const articleHtml = `
  <article>
    <a href="https://community.activision.com/legacyfs/online/12481_Guitar%20Hero%20Live_GHTV%20gameplay.jpg"><img src="https://community.activision.com/legacyfs/online/12481_Guitar%20Hero%20Live_GHTV%20gameplay.jpg" width="1920" height="1080"></a>
    <img src="https://community.activision.com/legacyfs/online/12481_Guitar%20Hero%20Live_GHTV%20gameplay.jpg" width="1920" height="1080">
    <img src="https://community.activision.com/legacyfs/online/social-icon.png" width="512" height="512">
    <img src="https://community.activision.com/legacyfs/online/tracking-pixel.png" width="1" height="1">
  </article>`;
const controllerHtml = `<article><img src="https://community.activision.com/legacyfs/online/10739_Guitar-Hero-Live_Guitar-Controller_Gray.jpg" width="1600" height="900"></article>`;
const artworkHtml = `<article><img src="https://community.activision.com/legacyfs/online/featured-Guitar-Hero-Live-Promo.jpg" width="1600" height="900"><img src="https://community.activision.com/legacyfs/online/article-image.jpg" width="1600" height="900"></article>`;
const query = { text: "Guitar Hero gameplay screenshot", intent: "gameplay", target_entity: "Guitar Hero", preferred_editorial_form: "screenshot" };

const media = extractApprovedArticleMedia(articleHtml, APPROVED_ARTICLES.gameplay);
assert.equal(media.length, 1, "duplicate, tracking, icon, and tiny image URLs are excluded");
assert.equal(media[0].width, 1920);
assert.deepEqual(media, extractApprovedArticleMedia(articleHtml, APPROVED_ARTICLES.gameplay), "article media ordering is deterministic");
assert.deepEqual(extractApprovedArticleMedia(articleHtml, "https://blog.activision.com/arbitrary"), [], "arbitrary Activision articles are rejected");
assert.deepEqual(extractApprovedArticleMedia(articleHtml, "https://example.test/guitar-hero"), [], "third-party provenance pages are rejected");
assert.deepEqual(extractApprovedArticleMedia(`<article><img src="https://third-party.test/guitar.jpg" width="1920" height="1080"></article>`, APPROVED_ARTICLES.gameplay), [], "unapproved image hosts are rejected");

function adapter({ globalEnabled = true, perRunEnabled = true, mediaResult = null } = {}) {
  if (!globalEnabled || !perRunEnabled) return null;
  return createActivisionGamesBlogAdapter({
    registry,
    fetchArticle: async (url) => ({ url, hops: [url], html: url === APPROVED_ARTICLES.gameplay ? articleHtml : url === APPROVED_ARTICLES.controller ? controllerHtml : artworkHtml }),
    inspectMedia: async (url) => mediaResult ?? ({ ok: true, url, hops: [url], contentType: "image/jpeg" })
  });
}

assert.equal(config.rights.copyrighted_editorial_enabled, false, "global controlled-risk switch remains disabled by default");
assert.equal(adapter({ globalEnabled: false }), null, "disabled global switch prevents editorial adapter activation");
assert.equal(adapter({ perRunEnabled: false }), null, "disabled per-run switch prevents editorial adapter activation");
assert.deepEqual(await createActivisionGamesBlogAdapter({ registry: [], fetchArticle: async () => { throw new Error("unexpected request"); }, inspectMedia: async () => { throw new Error("unexpected request"); } }).search(query), [], "an unknown registry ID cannot activate the adapter");
assert.match(manager, /effective_copyrighted_editorial_permission/, "Asset Manager only registers the adapter when both switches are true");

const gameplayAdapter = adapter();
const gameplayCandidates = await gameplayAdapter.search(query);
assert.equal(gameplayCandidates.length, 1, "approved CDN image linked by an approved article is accepted");
const gameplay = gameplayCandidates[0];
assert.equal(gameplay.rights_class, RIGHTS_CLASSES.COPYRIGHTED_EDITORIAL);
assert.equal(gameplay.license, null, "official editorial candidates do not claim an open license");
assert.equal(gameplay.provenance_status, "verified_first_party");
assert.equal(gameplay.official_source_registry_id, "activision-games-blog-guitar-hero-live");
assert.equal(gameplay.source_type, "activision_games_blog_article");
assert.equal(gameplay.source_domain, "community.activision.com");
assert.equal(classifyEditorialForm(gameplay, query), "screenshot", "gameplay filename/context is classified as a screenshot");
assert.equal(classifyRights(gameplay, { copyrightedEditorialEnabled: true, allowCopyrightedEditorial: true, officialSourceRegistry: registry }).accepted, true, "complete approved provenance passes the existing V3.7.1 rights gate");
assert.equal(classifyRights(gameplay, { copyrightedEditorialEnabled: true, allowCopyrightedEditorial: false, officialSourceRegistry: registry }).accepted, false, "per-run switch remains a hard gate");
assert.equal(classifyRights({ ...gameplay, official_source_registry_id: "unknown" }, { copyrightedEditorialEnabled: true, allowCopyrightedEditorial: true, officialSourceRegistry: registry }).accepted, false, "unknown registry IDs fail closed");
assert.equal(classifyRights({ ...gameplay, provenance_page_url: null }, { copyrightedEditorialEnabled: true, allowCopyrightedEditorial: true, officialSourceRegistry: registry }).accepted, false, "missing mandatory provenance fails closed");

const controller = (await adapter().search({ text: "Guitar Hero controller product", intent: "specific", target_entity: "Guitar Hero", preferred_editorial_form: "product" }))[0];
assert.equal(classifyEditorialForm(controller, { text: "Guitar Hero controller product", intent: "specific", target_entity: "Guitar Hero", preferred_editorial_form: "product" }), "product", "controller filename/context is classified as a product");
const artwork = (await adapter().search({ text: "Guitar Hero game cover art", intent: "cover_art", target_entity: "Guitar Hero", preferred_editorial_form: "clean_art" }))[0];
assert.equal(classifyEditorialForm(artwork, { text: "Guitar Hero game cover art", intent: "cover_art", target_entity: "Guitar Hero", preferred_editorial_form: "clean_art" }), "clean_art", "reviewed promotional metadata supports clean art");
assert.equal((await adapter().search({ text: "Guitar Hero official promotional artwork", intent: "official_art", target_entity: "Guitar Hero", preferred_editorial_form: "clean_art" })).length, 1, "approved official-art coverage is supported without treating generic article images as clean art");
assert.equal(extractApprovedArticleMedia(artworkHtml, APPROVED_ARTICLES.artwork).some((item) => item.filename === "article image"), true, "generic article media can be parsed but is not selected as promotional art");

assert.deepEqual(await adapter({ mediaResult: { ok: true, url: "https://third-party.test/image.jpg", hops: ["https://community.activision.com/a.jpg", "https://third-party.test/image.jpg"], contentType: "image/jpeg" } }).search(query), [], "redirects to unapproved media hosts fail closed");
assert.deepEqual(await adapter({ mediaResult: { ok: true, url: "https://community.activision.com/a.jpg", hops: ["https://community.activision.com/a.jpg"], contentType: "text/html" } }).search(query), [], "non-image media is rejected");

const scored = scoreCandidate(gameplay, query, { rights: classifyRights(gameplay, { copyrightedEditorialEnabled: true, allowCopyrightedEditorial: true, officialSourceRegistry: registry }) });
assert.equal(scored.classification.role, "gameplay", "adapter hints enter generic classification");
const selected = selectByScoreAndDiversity([{ candidate: gameplay, query, classification: scored.classification, destination: { finalCategory: "Gameplay" }, editorialForm: scored.editorialForm, visualUtility: scored.visualUtility, rights: scored.rights, scored, totalScore: scored.score }], { maxDownloads: 1 });
assert.equal(selected.selected[0].candidate.sourceUrl, gameplay.sourceUrl, "candidate enters generic selection without provider-specific ranking");

const openverse = await searchOpenverse(query, { resultsPerQuery: 1 }, async () => ({ results: [{ title: "Open Guitar Hero screenshot", url: "https://open.example/image.jpg", foreign_landing_url: "https://open.example/page", license: "by", license_version: "4.0", width: 1920, height: 1080, mime_type: "image/jpeg" }] }));
assert.equal(openverse.length, 1, "Openverse behavior remains independent of an official-source failure");
const wikimedia = await searchWikimedia(query, { resultsPerQuery: 1 }, async () => ({ query: { pages: [{ title: "File:Guitar Hero.png", canonicalurl: "https://commons.wikimedia.org/wiki/File:Guitar_Hero.png", imageinfo: [{ url: "https://upload.wikimedia.org/guitar-hero.png", width: 1920, height: 1080, mime: "image/png", extmetadata: { LicenseShortName: { value: "CC BY 4.0" } } }] }] } }));
assert.equal(wikimedia.length, 1, "Wikimedia behavior remains independent of an official-source failure");
assert.ok(!workflow.includes(".cache/assets/"), "review artifacts continue to exclude source media");

console.log("activision games blog adapter tests passed");
