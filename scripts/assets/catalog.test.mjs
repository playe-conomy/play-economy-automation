import assert from "node:assert/strict";
import { allowedLicense, classifyAsset, qualityTier, scoreCandidate } from "./catalog.mjs";

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
assert.equal(scoreCandidate(controller, specificQuery).quality.tier, "high_quality");
assert.equal(classifyAsset(genericGuitar, brollQuery).role, "contextual_broll");
assert.notEqual(classifyAsset(genericGuitar, brollQuery).role, "gameplay");
assert.equal(qualityTier({ width: 215, height: 598 }).tier, "low_resolution");
assert.ok(scoreCandidate({ ...controller, width: 215, height: 598 }, specificQuery).scoreBreakdown.resolution < 0);
assert.equal(allowedLicense({ license: "Unknown", licenseUrl: null }).allowed, false);

console.log("catalog tests passed");
