import assert from "node:assert/strict";
import { allowedLicense, classifyAsset, inspectMetadata, normalizeVisualQuery, qualityTier, scoreCandidate, semanticRelevance } from "./catalog.mjs";
import { resolveAssetDestination } from "./drive.mjs";

const specificQuery = { text: "Guitar Hero controller", intent: "specific", target_entity: "Guitar Hero", target_category: "Franquicias" };
const brollQuery = { text: "electric guitar concert", intent: "contextual_broll", target_entity: null, target_category: "Tecnología" };

for (const [intent, preferredEditorialForm] of Object.entries({
  gameplay: "screenshot",
  controller: "product",
  specific: "product",
  cover_art: "clean_art",
  official_art: "clean_art",
  company: "logo",
  contextual_broll: "contextual"
})) {
  assert.equal(normalizeVisualQuery({ query: "test", intent }).preferred_editorial_form, preferredEditorialForm, `${intent} receives its deterministic editorial form`);
}
assert.equal(normalizeVisualQuery({ query: "test", intent: "gameplay", preferred_editorial_form: "clean_art" }).preferred_editorial_form, "clean_art", "an explicit editorial form is never overwritten");

const controller = {
  title: "Guitar Hero controller", tags: ["Guitar Hero", "controller"], provider: "test",
  sourceUrl: "https://example.test/controller", license: "Public Domain", licenseUrl: "https://creativecommons.org/publicdomain/mark/1.0/",
  width: 2122, height: 1499, mimeType: "image/png"
};

const genericGuitar = {
  title: "Electric guitar at a concert", tags: ["electric guitar", "music"], provider: "test",
  sourceUrl: "https://example.test/guitar", license: "CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
  width: 1111, height: 2982, mimeType: "image/jpeg"
};

assert.equal(classifyAsset(controller, specificQuery).role, "specific");
const hyphenatedControllerRole = classifyAsset({ ...controller, title: "Guitar-hero-controller-horiz.jpg" }, specificQuery);
assert.equal(hyphenatedControllerRole.role, "specific");
assert.deepEqual(resolveAssetDestination(hyphenatedControllerRole.role, { entity: hyphenatedControllerRole.entity }), {
  finalCategory: "Franquicias", finalEntity: "Guitar Hero", drivePath: "02_Biblioteca Visual/Franquicias/Guitar Hero/"
});
assert.equal(scoreCandidate(controller, specificQuery).quality.tier, "high_quality");
assert.equal(classifyAsset(genericGuitar, brollQuery).role, "contextual_broll");
assert.notEqual(classifyAsset(genericGuitar, brollQuery).role, "gameplay");
assert.equal(qualityTier({ width: 215, height: 598 }).tier, "low_resolution");
assert.ok(scoreCandidate({ ...controller, width: 215, height: 598 }, specificQuery).scoreBreakdown.resolution < 0);
assert.equal(allowedLicense({ license: "Unknown", licenseUrl: null }).allowed, false);

const publicDomainWithoutUrl = { ...controller, licenseUrl: null, creator: null, attribution: null };
const publicDomainMetadata = inspectMetadata(publicDomainWithoutUrl);
assert.deepEqual(publicDomainMetadata.missingFields, []);
assert.deepEqual(publicDomainMetadata.warnings, ["creator_missing"]);
assert.equal(allowedLicense(publicDomainWithoutUrl).allowed, true);

const missingLicense = inspectMetadata({ ...controller, license: null });
assert.ok(missingLicense.missingFields.includes("license"));
assert.equal(allowedLicense({ ...controller, license: null }).allowed, false);

const gameplayQuery = { text: "Guitar Hero gameplay", intent: "gameplay", target_entity: "Guitar Hero", target_category: "Gameplay" };
const contextualRole = classifyAsset(genericGuitar, gameplayQuery);
assert.equal(contextualRole.role, "contextual_broll");
assert.deepEqual(resolveAssetDestination(contextualRole.role, { entity: contextualRole.entity }), {
  finalCategory: "Tecnología", finalEntity: null, drivePath: "02_Biblioteca Visual/Tecnología/"
});

const djHero = { ...genericGuitar, title: "DJ Hero PS3 Turntable", tags: ["DJ Hero", "turntable"] };
const djHeroRole = classifyAsset(djHero, gameplayQuery);
assert.equal(djHeroRole.role, "contextual_broll");
assert.equal(resolveAssetDestination(djHeroRole.role, { entity: djHeroRole.entity }).drivePath, "02_Biblioteca Visual/Tecnología/");

const coverQuery = { text: "Guitar Hero game cover", intent: "cover_art", target_entity: "Guitar Hero", target_category: "Franquicias" };
const coverArt = { ...controller, title: "Guitar Hero III game cover artwork", tags: ["Guitar Hero", "cover art", "box art"] };
const coverScore = scoreCandidate(coverArt, coverQuery);
assert.equal(classifyAsset(coverArt, coverQuery).role, "cover_art");
assert.equal(coverScore.semantic.passed, true);
assert.deepEqual(resolveAssetDestination(coverScore.classification.role, { entity: coverScore.classification.entity }), {
  finalCategory: "Franquicias", finalEntity: "Guitar Hero", drivePath: "02_Biblioteca Visual/Franquicias/Guitar Hero/"
});

const officialQuery = { text: "Guitar Hero official promotional artwork", intent: "official_art", target_entity: "Guitar Hero", target_category: "Franquicias" };
const officialArt = { ...controller, title: "Guitar Hero official promotional key art", tags: ["Guitar Hero", "official", "promotional artwork"] };
const officialScore = scoreCandidate(officialArt, officialQuery);
assert.equal(officialScore.classification.role, "official_art");
assert.equal(officialScore.semantic.passed, true);
assert.equal(resolveAssetDestination(officialScore.classification.role, { entity: officialScore.classification.entity }).drivePath, "02_Biblioteca Visual/Franquicias/Guitar Hero/");

const activisionQuery = { text: "Activision logo office", intent: "company", target_entity: "Activision", target_category: "Empresas" };
const officeDirectory = { ...controller, title: "Nangang Station Building A office directories", description: "Office building directory", tags: ["office", "directory"] };
const officeRelevance = semanticRelevance(officeDirectory, activisionQuery);
assert.equal(officeRelevance.passed, false);
assert.ok(officeRelevance.reasons.includes("target_entity_missing"));

assert.equal(scoreCandidate(genericGuitar, brollQuery).semantic.passed, true);
assert.ok(coverScore.score > scoreCandidate(genericGuitar, brollQuery).score);
assert.equal(scoreCandidate(djHero, gameplayQuery).semantic.passed, false);
assert.equal(allowedLicense({ ...coverArt, license: "Unknown", licenseUrl: null }).allowed, false);

const verticalUsable = { ...controller, width: 500, height: 1024 };
const wideHighQuality = { ...controller, width: 2122, height: 1499 };
assert.equal(qualityTier(verticalUsable).tier, "usable");
assert.equal(qualityTier(wideHighQuality).tier, "high_quality");
assert.ok(scoreCandidate(wideHighQuality, specificQuery).score > scoreCandidate(verticalUsable, specificQuery).score);

console.log("catalog tests passed");

const ps1Query = { text: "PS1 console controller hardware accessories", intent: "console", target_entity: "PlayStation/PS1", target_category: "Consolas" };
const wrongPs2 = { ...controller, title: "Sony PlayStation 2 PS2 console", description: "PlayStation 2 hardware" };
const wrongPs2Semantic = semanticRelevance(wrongPs2, ps1Query);
assert.equal(wrongPs2Semantic.passed, false);
assert.ok(wrongPs2Semantic.reasons.includes("conflicting_entity_detected"));

const gameCubeQuery = { text: "GameCube console controller hardware accessories", intent: "console", target_entity: "Nintendo/GameCube", target_category: "Consolas" };
const wrongGameCube = { ...controller, title: "PlayStation 2 console", description: "PS2 gaming hardware GameCube comparison" };
const wrongGameCubeSemantic = semanticRelevance(wrongGameCube, gameCubeQuery);
assert.equal(wrongGameCubeSemantic.passed, false);
assert.ok(wrongGameCubeSemantic.reasons.includes("conflicting_entity_detected"));

const marioCharacterQuery = { text: "Mario character official art", intent: "character", target_entity: "Mario", target_category: "Personajes" };
const unrelatedMarioPerson = { ...controller, title: "Giovanni Mario portrait", description: "Italian photographer portrait" };
const unrelatedMarioSemantic = semanticRelevance(unrelatedMarioPerson, marioCharacterQuery);
assert.equal(unrelatedMarioSemantic.passed, false);

const realMarioCharacter = { ...controller, title: "Super Mario character artwork", description: "Nintendo game character" };
assert.equal(semanticRelevance(realMarioCharacter, marioCharacterQuery).passed, true);

const zeldaMapQuery = { text: "The Legend of Zelda game map", intent: "map", target_entity: "The Legend of Zelda", target_category: "Mapas" };
const zeldaCosplay = { ...controller, title: "The Legend of Zelda cosplay", description: "Link cosplay convention photo" };
const zeldaCosplaySemantic = semanticRelevance(zeldaCosplay, zeldaMapQuery);
assert.equal(zeldaCosplaySemantic.passed, false);
assert.ok(zeldaCosplaySemantic.reasons.includes("intent_evidence_missing"));

const zeldaMap = { ...controller, title: "The Legend of Zelda world map", description: "game overworld map" };
assert.equal(semanticRelevance(zeldaMap, zeldaMapQuery).passed, true);
