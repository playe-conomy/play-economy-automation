import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  RIGHTS_CLASSES, attributionLines, classifyEditorialForm, classifyRights, coverageGaps,
  deriveCoverageRequirements, planEditorialQueries, scoreCandidate, visualUtility
} from "./catalog.mjs";
import { selectByScoreAndDiversity } from "./selection.mjs";
import { validateCatalog } from "./drive-catalog.mjs";

const root = resolve(import.meta.dirname, "../..");
const config = JSON.parse(await readFile(resolve(root, "asset-manager/config.json"), "utf8"));
const content = JSON.parse(await readFile(resolve(root, "content/guitar-hero.json"), "utf8"));
const workflow = await readFile(resolve(root, ".github/workflows/playeconomy-asset-manager.yml"), "utf8");
const v4Workflow = await readFile(resolve(root, ".github/workflows/playeconomy-video-v4.yml"), "utf8");

const query = { text: "Guitar Hero gameplay screenshot", intent: "gameplay", target_entity: "Guitar Hero", preferred_editorial_form: "screenshot" };
const openScreenshot = {
  provider: "test", title: "Guitar Hero gameplay screenshot", description: "In game note highway screenshot", tags: ["Guitar Hero", "gameplay"],
  sourceUrl: "https://open.example.test/screenshot", downloadUrl: "https://open.example.test/screenshot.jpg", license: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/", width: 1920, height: 1080, mimeType: "image/jpeg"
};
const lifestyle = { ...openScreenshot, title: "People playing Guitar Hero gameplay", description: "Players at an event", sourceUrl: "https://open.example.test/lifestyle" };
const cleanCover = { ...openScreenshot, title: "Guitar Hero game cover art", description: "Clean cover artwork", sourceUrl: "https://open.example.test/cover" };
const cases = { ...openScreenshot, title: "Collection of Guitar Hero game cases", description: "Game cases on a shelf", sourceUrl: "https://open.example.test/cases" };
const controller = { ...openScreenshot, title: "Guitar Hero controller product", description: "Official hardware", sourceUrl: "https://open.example.test/controller" };
const logo = { ...openScreenshot, title: "Activision logo", description: "Company logo", sourceUrl: "https://open.example.test/logo" };
const concert = { ...openScreenshot, title: "Electric guitar concert", description: "Music stage performance", sourceUrl: "https://open.example.test/concert" };

assert.equal(config.rights.copyrighted_editorial_enabled, false, "global controlled-risk switch defaults to false");
assert.equal(config.rights.official_source_registry[0]?.id, "activision-games-blog-guitar-hero-live", "the reviewed V3.7.2 registry source is configured while the global switch remains disabled");
assert.equal(classifyRights(openScreenshot).rightsClass, RIGHTS_CLASSES.OPEN_LICENSE);
assert.equal(classifyRights({ ...openScreenshot, license: "Unknown" }).rightsClass, RIGHTS_CLASSES.REJECTED_OR_UNKNOWN);

const registry = [{ id: "publisher-test", approved: true, domains: ["publisher.test"], cdn_domains: ["media.publisher.test"], source_types: ["publisher_game_page"] }];
const editorial = {
  provider: "official", title: "Guitar Hero official gameplay screenshot", description: "Official screenshot", tags: ["Guitar Hero", "gameplay"],
  sourceUrl: "https://media.publisher.test/guitar-hero.jpg", downloadUrl: "https://media.publisher.test/guitar-hero.jpg", width: 1920, height: 1080, mimeType: "image/jpeg",
  rights_class: "copyrighted_editorial", copyright_owner: "Publisher Test", source_type: "publisher_game_page", provenance_page_url: "https://publisher.test/guitar-hero", source_domain: "media.publisher.test", retrieved_at: "2026-09-17T00:00:00.000Z", editorial_use_only: true, license: null, license_status: "no_open_license_identified", attribution: "Publisher Test", provenance_status: "verified_first_party", official_source_registry_id: "publisher-test"
};
assert.equal(classifyRights(editorial, { copyrightedEditorialEnabled: false, allowCopyrightedEditorial: true, officialSourceRegistry: registry }).accepted, false);
assert.equal(classifyRights(editorial, { copyrightedEditorialEnabled: true, allowCopyrightedEditorial: false, officialSourceRegistry: registry }).accepted, false);
const enabledEditorial = classifyRights(editorial, { copyrightedEditorialEnabled: true, allowCopyrightedEditorial: true, officialSourceRegistry: registry });
assert.equal(enabledEditorial.accepted, true);
assert.equal(enabledEditorial.rightsClass, RIGHTS_CLASSES.COPYRIGHTED_EDITORIAL);
assert.equal(classifyRights({ ...editorial, attribution: null }, { copyrightedEditorialEnabled: true, allowCopyrightedEditorial: true, officialSourceRegistry: registry }).accepted, false, "missing provenance fails closed");
assert.equal(classifyRights({ ...editorial, official_source_registry_id: "unknown" }, { copyrightedEditorialEnabled: true, allowCopyrightedEditorial: true, officialSourceRegistry: registry }).accepted, false, "unknown registry ID fails closed");
assert.equal(editorial.license, null, "copyrighted editorial records cannot claim a CC/PD license");

assert.equal(classifyEditorialForm(openScreenshot, query), "screenshot");
assert.equal(classifyEditorialForm(lifestyle, query), "lifestyle", "lifestyle takes precedence over gameplay wording");
assert.equal(classifyEditorialForm(cleanCover, { ...query, intent: "cover_art" }), "clean_art");
assert.equal(classifyEditorialForm(cases, { ...query, intent: "cover_art" }), "physical_case");
assert.equal(classifyEditorialForm(controller, { ...query, intent: "specific" }), "product");
assert.equal(classifyEditorialForm(logo, { text: "Activision logo", intent: "company", target_entity: "Activision" }), "logo");
assert.equal(classifyEditorialForm(concert, { text: "electric guitar concert", intent: "contextual_broll" }), "contextual");

const screenshotUtility = visualUtility(openScreenshot, query);
const lifestyleUtility = visualUtility(lifestyle, query);
assert.ok(screenshotUtility.score > lifestyleUtility.score, "screenshot materially outranks lifestyle for screenshot coverage");
const cleanUtility = visualUtility(cleanCover, { ...query, intent: "cover_art", preferred_editorial_form: "clean_art" });
const caseUtility = visualUtility(cases, { ...query, intent: "cover_art", preferred_editorial_form: "clean_art" });
assert.ok(cleanUtility.score > caseUtility.score, "clean art materially outranks physical cases");
assert.equal(scoreCandidate({ ...openScreenshot, license: "Unknown" }, query).rights.accepted, false, "rights rejection remains a hard gate regardless of utility");
assert.equal(scoreCandidate({ ...openScreenshot, title: "Unrelated screenshot", description: "gameplay screenshot", tags: [] }, query).semantic.passed, false, "semantic rejection remains a hard gate regardless of utility");

const selected = selectByScoreAndDiversity([
  { query, classification: { role: "gameplay", entity: "Guitar Hero" }, destination: { finalCategory: "Gameplay" }, candidate: { title: "lifestyle" }, editorialForm: "lifestyle", visualUtility: lifestyleUtility, rights: { rightsClass: "open_license", provenanceConfidence: 80 }, scored: { semantic: { score: 100 } }, totalScore: 250 },
  { query, classification: { role: "gameplay", entity: "Guitar Hero" }, destination: { finalCategory: "Gameplay" }, candidate: { title: "official screenshot" }, editorialForm: "screenshot", visualUtility: screenshotUtility, rights: enabledEditorial, scored: { semantic: { score: 100 } }, totalScore: 180 }
], { maxDownloads: 1 });
assert.equal(selected.selected[0].candidate.title, "official screenshot", "verified screenshot can outrank a weaker open-license lifestyle image");

const requirements = deriveCoverageRequirements(content);
assert.ok(requirements.some((item) => item.asset_role === "gameplay" && item.preferred_editorial_form === "screenshot"));
assert.ok(requirements.some((item) => item.asset_role === "company" && item.preferred_editorial_form === "logo"));
const planned = planEditorialQueries(content, { maxQueries: 8 });
assert.ok(planned.length <= 8);
assert.deepEqual(planned, planEditorialQueries(content, { maxQueries: 8 }), "query plan is deterministic");
assert.ok(planned.some((item) => item.text.includes("gameplay screenshot")));
const gaps = coverageGaps(requirements, [], []);
assert.equal(gaps.length, requirements.length);
assert.ok(gaps.every((gap) => gap.reason === "no_accepted_candidate"));

const legacyCatalog = validateCatalog({ schema_version: 1, manifest_version: 1, catalog_version: 1, assets: [{ id: "legacy", type: "image", source: "openverse", source_url: "https://example.test/legacy", asset_role: "specific", checksum: "a".repeat(64), drive_file_id: "drive-file", status: "uploaded", license: "CC BY 4.0" }] });
assert.equal(legacyCatalog.assets.length, 1, "old catalog asset without new fields remains valid");
assert.equal(classifyRights({ license: legacyCatalog.assets[0].license }).rightsClass, RIGHTS_CLASSES.OPEN_LICENSE, "legacy allowed license derives open rights transiently");

const editorialAttribution = attributionLines(editorial).join("\n");
assert.match(editorialAttribution, /Copyrighted editorial/);
assert.match(editorialAttribution, /No open license identified/);
assert.match(editorialAttribution, /does not itself grant reuse permission/);
assert.match(attributionLines(openScreenshot).join("\n"), /Rights class: Open license/);
assert.ok(!workflow.includes("            .cache/assets/"), "Asset Manager artifact excludes source-media cache");
assert.match(workflow, /allow_copyrighted_editorial/);
assert.ok(!v4Workflow.includes("output/scene-media/"), "V4 artifact behavior remains source-media free and unchanged");

console.log("editorial tests passed");
