import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SAFE_ZONES, buildVisualLayout, endCardTiming, normalBrandingLayout, resolveVisualFamily, segmentCaption, timedCaptionSegments, visualBeats, visualDebugPlan, wrapCaptionLines } from "./visual-layout.mjs";

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
assert.equal(cover.mediaTreatment, "derived_background_contain", "cover/product assets preserve their full foreground over a derived background");
assert.equal(media.mediaTreatment, "fill_crop", "media assets use controlled fill/crop treatment");
assert.equal(company.companyFallback, true, "a company without an asset receives its generated fallback");
assert.equal(company.title, "Activision", "company fallback uses the target entity");
assert.equal(company.dataEnabled, false, "company fallback does not invent numeric graphics");
assert.equal(buildVisualLayout({ scene: definition.scenes[2], selectedAsset: { asset_id: "company", role: "company" }, order: 2, duration: 27 }).mediaTreatment, "derived_background_contain", "company media preserves the complete source over a derived background");
assert.equal(buildVisualLayout({ scene: { visual_family: "data_economy", data: { value: 1 } }, selectedAsset: { asset_id: "data" }, order: 0, duration: 10 }).mediaTreatment, "fill_crop", "data-economy media retains its existing fill/crop treatment");
assert.equal(buildVisualLayout({ scene: { visual_family: "brand" }, selectedAsset: null, order: 0, duration: 10 }).mediaTreatment, "none", "brand-only scenes retain no-media behavior");
assert.deepEqual(media.motion, buildVisualLayout({ scene: definition.scenes[1], selectedAsset: { role: "specific" }, order: 1, duration: 27 }).motion, "motion is deterministic");
assert.ok(media.motion.zoomEnd >= 1.02 && media.motion.zoomEnd <= 1.06, "media motion remains within the 2-6 percent range");
assert.ok(cover.motion.zoomEnd >= 1.01 && cover.motion.zoomEnd <= 1.03, "cover motion remains within the 1-3 percent range");
assert.deepEqual(endCardTiming(27), { start: 25, end: 27, duration: 2 }, "a 27-second V4.1 video reserves its final two seconds for the end card");
assert.deepEqual(SAFE_ZONES.main, { left: 48, right: 1032, top: 170, bottom: 1470 }, "main safe zone is conservative for mobile UI");
assert.deepEqual(SAFE_ZONES.subtitle, { top: 1420, bottom: 1620 }, "subtitle safe zone avoids the lower platform area");
assert.deepEqual(SAFE_ZONES.mediaForeground, { x: 72, y: 430, width: 936, height: 890 }, "derived foreground stays between headline and subtitle safe zones");
const foregroundFit = (width, height) => {
  const scale = Math.min(SAFE_ZONES.mediaForeground.width / width, SAFE_ZONES.mediaForeground.height / height);
  return { width: width * scale, height: height * scale };
};
for (const [label, width, height] of [
  ["ultrawide", 2400, 1000],
  ["sixteen-nine", 1920, 1080],
  ["four-three", 1600, 1200],
  ["square", 1200, 1200],
  ["portrait", 1200, 1800],
  ["nine-sixteen", 1080, 1920]
]) {
  const fitted = foregroundFit(width, height);
  assert.ok(fitted.width <= SAFE_ZONES.mediaForeground.width && fitted.height <= SAFE_ZONES.mediaForeground.height, `${label} foreground stays within the safe area`);
  assert.ok(Math.abs((fitted.width / fitted.height) - (width / height)) < 0.000001, `${label} foreground preserves its original aspect ratio`);
}
assert.ok(!layoutSource.includes("fetch("), "visual layout has no network operation");
assert.ok(!layoutSource.includes("drive"), "visual layout has no Drive operation");

const captionScene = {
  scene_id: "caption-test",
  start: 0,
  end: 5,
  caption: "Una guitarra de plástico se volvió un negocio millonario."
};
const segments = timedCaptionSegments(captionScene);
assert.deepEqual(segmentCaption(captionScene.caption), segmentCaption(captionScene.caption), "caption segmentation is deterministic");
assert.ok(segments.length > 1, "an ordinary five-second sentence develops through multiple phrase captions");
assert.equal(segments[0].start, captionScene.start, "the first caption phrase starts at scene start");
assert.equal(segments.at(-1).end, captionScene.end, "the final caption phrase ends at scene end");
for (const [index, segment] of segments.entries()) {
  if (index > 0) assert.equal(segments[index - 1].end, segment.start, "caption phrases have no gaps or overlaps");
  assert.ok(wrapCaptionLines(segment.text).split("\n").length <= 2, "caption phrases fit in at most two lines");
}
const weightedSegments = timedCaptionSegments({ scene_id: "weighted", start: 0, end: 5, caption: "Uno dos tres cuatro cinco seis siete ocho nueve diez once." });
assert.ok(weightedSegments[0].word_count > weightedSegments.at(-1).word_count && weightedSegments[0].end - weightedSegments[0].start > weightedSegments.at(-1).end - weightedSegments.at(-1).start, "phrase timing is weighted by word count");
assert.deepEqual(segmentCaption("El éxito parecía no tener techo."), ["El éxito parecía no tener techo."], "short captions are not unnecessarily fragmented");
assert.match(segments.map((segment) => segment.text).join(" "), /plástico.*volvió.*millonario/, "Spanish accents and punctuation are preserved");
assert.deepEqual(normalBrandingLayout({ transparentLogoAvailable: true }), { mode: "transparent_logo", x: 72, y: 112, width: 136 }, "transparent normal branding stays in the upper safe zone");
assert.equal(normalBrandingLayout({ transparentLogoAvailable: false }).mode, "avatar_fallback", "non-transparent logos fall back gracefully to the existing avatar mark");
assert.equal(visualDebugPlan({ scenes: definition.scenes, duration: 27, transparentLogoAvailable: true })[0].captionSegments[0].start, 0, "debug plans expose phrase timing");

const pacedIdentity = buildVisualLayout({ scene: definition.scenes[0], selectedAsset: { asset_id: "identity", role: "cover_art" }, order: 0, duration: 27 });
const identityCaptions = timedCaptionSegments(definition.scenes[0]);
assert.deepEqual(pacedIdentity.captionSegments, identityCaptions, "visual beats do not rewrite caption segments");
assert.deepEqual(
  pacedIdentity.visualBeats.map(({ start, end, presentation, headlineState, asset_id }) => ({ start, end, presentation, headlineState, asset_id })),
  [
    { start: 0, end: identityCaptions[1].start, presentation: "cover_establish", headlineState: "visible", asset_id: "identity" },
    { start: identityCaptions[1].start, end: 5, presentation: "cover_detail", headlineState: "hidden", asset_id: "identity" }
  ],
  "cover/product uses the suitable caption boundary for deterministic two-beat pacing"
);
for (const [index, beat] of pacedIdentity.visualBeats.entries()) {
  assert.ok(beat.start >= definition.scenes[0].start && beat.end <= definition.scenes[0].end, "beats stay inside their scene");
  if (index > 0) assert.equal(pacedIdentity.visualBeats[index - 1].end, beat.start, "beats are continuous without gaps or overlaps");
}
assert.deepEqual(pacedIdentity.visualBeats, buildVisualLayout({ scene: definition.scenes[0], selectedAsset: { asset_id: "identity", role: "cover_art" }, order: 0, duration: 27 }).visualBeats, "visual beats are deterministic");

const pacedGameplay = buildVisualLayout({ scene: definition.scenes[1], selectedAsset: { asset_id: "gameplay", role: "gameplay" }, order: 1, duration: 27 });
assert.deepEqual(pacedGameplay.visualBeats.map((beat) => [beat.start, beat.end]), [[5, 7.5], [7.5, 10]], "one-caption media scene uses its deterministic midpoint");
assert.deepEqual(pacedGameplay.visualBeats.map((beat) => beat.headlineState), ["visible", "hidden"], "media headlines only appear during the establishing beat");

const pacedCompany = buildVisualLayout({ scene: definition.scenes[2], order: 2, duration: 27 });
assert.deepEqual(pacedCompany.visualBeats.map((beat) => [beat.start, beat.end, beat.presentation, beat.headlineState]), [[10, 12.5, "company_establish", "company_name"], [12.5, 15, "company_supporting", "supporting_message"]], "no-asset company fallback receives its two safe typography states");

const pacedRock = buildVisualLayout({ scene: definition.scenes[3], selectedAsset: { asset_id: "rock", role: "contextual_broll" }, order: 3, duration: 27 });
assert.equal(pacedRock.visualBeats[0].end, timedCaptionSegments(definition.scenes[3])[1].start, "rock scene reuses its suitable caption boundary");
assert.deepEqual(pacedRock.visualBeats.map((beat) => beat.headlineState), ["visible", "hidden"], "media reframe hides the headline");

const pacedConclusion = buildVisualLayout({ scene: definition.scenes[4], selectedAsset: { asset_id: "conclusion", role: "official_art" }, order: 4, duration: 27 });
assert.deepEqual(pacedConclusion.visualBeats.map((beat) => [beat.start, beat.end]), [[21, 23], [23, 25]], "conclusion visual beats stop at the generic end-card boundary");
assert.ok(pacedConclusion.visualBeats.every((beat) => beat.end <= pacedConclusion.endCard.start), "no normal conclusion beat overlaps the end card");
assert.ok(pacedConclusion.visualBeats.every((beat) => beat.motion.zoomStart === 1), "every media beat declares motion that starts locally from its own beginning");
const preEndCardScene = { scene_id: "pre-end-card", start: 6, end: 10, caption: "Una sola frase." };
assert.deepEqual(
  visualBeats({ scene: preEndCardScene, family: "media", hasMedia: true, captionSegments: timedCaptionSegments(preEndCardScene), endCard: { start: 8, end: 10 } }).map((beat) => [beat.start, beat.end]),
  [[6, 8]],
  "a short effective pre-end-card interval degrades safely to one beat"
);
const coveredScene = { scene_id: "covered", start: 8, end: 10, caption: "No visible." };
assert.deepEqual(
  visualBeats({ scene: coveredScene, family: "media", hasMedia: true, captionSegments: timedCaptionSegments(coveredScene), endCard: { start: 8, end: 10 } }),
  [],
  "a scene fully covered by the end card creates no zero or negative beat"
);
const clampedBoundaryScene = { scene_id: "clamped-boundary", start: 0, end: 10, caption: "No importa." };
assert.deepEqual(
  visualBeats({ scene: clampedBoundaryScene, family: "media", hasMedia: true, captionSegments: [{ start: 0 }, { start: 4.1 }], endCard: { start: 4, end: 10 } }).map((beat) => [beat.start, beat.end]),
  [[0, 2], [2, 4]],
  "a caption boundary outside the effective visual interval cannot create an invalid beat"
);
assert.deepEqual(pacedGameplay.visualBeats.map((beat) => [beat.start, beat.end]), [[5, 7.5], [7.5, 10]], "a scene outside the end card remains unchanged");
assert.equal(visualBeats({ scene: { start: 0, end: 2, caption: "Corta." }, family: "brand", hasMedia: false, captionSegments: [], endCard: { start: 3, end: 5 } }).length, 1, "short brand-only scenes do not gain unnecessary beats");

console.log("visual layout tests passed");

