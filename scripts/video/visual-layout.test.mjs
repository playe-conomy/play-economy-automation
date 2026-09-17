import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SAFE_ZONES, buildVisualLayout, endCardTiming, resolveVisualFamily } from "./visual-layout.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const definition = JSON.parse(await readFile(resolve(repositoryRoot, "content/guitar-hero.json"), "utf8"));
const layoutSource = await readFile(resolve(repositoryRoot, "scripts/video/visual-layout.mjs"), "utf8");
const expectedFamilies = ["cover_product", "media", "company_logo", "media", "cover_product"];

for (const [index, scene] of definition.scenes.entries()) {
  assert.equal(resolveVisualFamily(scene), expectedFamilies[index], `${scene.scene_id} resolves to its required V4.1 family`);
}

assert.equal(
  resolveVisualFamily({ visual_intent: "gameplay", preferred_roles: ["specific"] }, { role: "specific" }),
  "media",
  "gameplay remains media even when its selected role is specific"
);
assert.equal(resolveVisualFamily({ visual_intent: "company_context" }), "company_logo", "company context selects the company family without an asset");
assert.equal(resolveVisualFamily({ visual_family: "brand", visual_intent: "gameplay" }), "brand", "a valid explicit family wins");
assert.equal(resolveVisualFamily({ data: { value: 241 } }), "data_economy", "structured numeric data enables the data family");
assert.equal(resolveVisualFamily({ data: { label: "not numeric" } }), "media", "non-numeric metadata cannot enable data graphics");

const cover = buildVisualLayout({ scene: definition.scenes[0], selectedAsset: { role: "cover_art" }, order: 0, duration: 27 });
const media = buildVisualLayout({ scene: definition.scenes[1], selectedAsset: { role: "specific" }, order: 1, duration: 27 });
const company = buildVisualLayout({ scene: definition.scenes[2], order: 2, duration: 27 });
assert.equal(cover.mediaTreatment, "contain", "cover/product assets use fit/contain treatment");
assert.equal(media.mediaTreatment, "fill_crop", "media assets use controlled fill/crop treatment");
assert.equal(company.companyFallback, true, "a company without an asset receives its generated fallback");
assert.equal(company.title, "Activision", "company fallback uses the target entity");
assert.equal(company.dataEnabled, false, "company fallback does not invent numeric graphics");
assert.deepEqual(media.motion, buildVisualLayout({ scene: definition.scenes[1], selectedAsset: { role: "specific" }, order: 1, duration: 27 }).motion, "motion is deterministic");
assert.ok(media.motion.zoomEnd >= 1.02 && media.motion.zoomEnd <= 1.06, "media motion remains within the 2-6 percent range");
assert.ok(cover.motion.zoomEnd >= 1.01 && cover.motion.zoomEnd <= 1.03, "cover motion remains within the 1-3 percent range");
assert.deepEqual(endCardTiming(27), { start: 25, end: 27, duration: 2 }, "a 27-second V4.1 video reserves its final two seconds for the end card");
assert.deepEqual(SAFE_ZONES.main, { left: 48, right: 1032, top: 170, bottom: 1470 }, "main safe zone is conservative for mobile UI");
assert.deepEqual(SAFE_ZONES.subtitle, { top: 1420, bottom: 1620 }, "subtitle safe zone avoids the lower platform area");
assert.ok(!layoutSource.includes("fetch("), "visual layout has no network operation");
assert.ok(!layoutSource.includes("drive"), "visual layout has no Drive operation");

console.log("visual layout tests passed");
