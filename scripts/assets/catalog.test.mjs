import assert from "node:assert/strict";
import { allowedLicense, classifyAsset, inspectMetadata, qualityTier, scoreCandidate } from "./catalog.mjs";
import { resolveAssetDestination } from "./drive.mjs";

const specificQuery = { text: "Guitar Hero controller", intent: "specific", target_entity: "Guitar Hero", target_category: "Franquicias" };
const brollQuery = { text: "electric guitar concert", intent: "contextual_broll", target_entity: null, target_category: "Tecnología" };

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

const verticalUsable = { ...controller, width: 500, height: 1024 };
const wideHighQuality = { ...controller, width: 2122, height: 1499 };
assert.equal(qualityTier(verticalUsable).tier, "usable");
assert.equal(qualityTier(wideHighQuality).tier, "high_quality");
assert.ok(scoreCandidate(wideHighQuality, specificQuery).score > scoreCandidate(verticalUsable, specificQuery).score);

console.log("catalog tests passed");
