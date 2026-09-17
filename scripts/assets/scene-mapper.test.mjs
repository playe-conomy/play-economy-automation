import assert from "node:assert/strict";
import { buildScenePlan } from "./scene-mapper.mjs";

function asset(id, overrides = {}) {
  return {
    id,
    type: "image",
    status: "uploaded",
    reusable: true,
    asset_role: "specific",
    final_entity: "Guitar Hero",
    title: id,
    source_url: `https://example.test/${id}`,
    license: "CC BY 4.0",
    width: 1920,
    height: 1080,
    quality_tier: "high_quality",
    semantic_relevance: { score: 60, passed: true },
    total_score: 150,
    ...overrides
  };
}

function scene(scene_id, target_entity, preferred_roles, visual_intent = scene_id) {
  return { scene_id, caption: scene_id, visual_intent, target_entity, preferred_roles };
}

function plan(scenes, assets) {
  return buildScenePlan({ id: "guitar-hero-v2", scenes }, { version: 1, assets });
}

const cover = asset("cover", { asset_role: "cover_art" });
const gameplay = asset("gameplay", { asset_role: "gameplay" });
const controller = asset("controller", { asset_role: "specific", title: "Guitar Hero controller" });
const concert = asset("concert", { asset_role: "contextual_broll", final_entity: null, title: "Electric guitar concert", total_score: 110 });
const unrelated = asset("unrelated", { asset_role: "cover_art", final_entity: "Burnout", total_score: 900, width: 5000, height: 5000 });

const intro = plan([scene("intro", "Guitar Hero", ["cover_art", "official_art", "specific"])], [concert, cover]);
assert.equal(intro.scenes[0].selected_assets[0].asset_id, "cover");

const play = plan([scene("play", "Guitar Hero", ["gameplay", "specific", "cover_art"])], [cover, gameplay]);
assert.equal(play.scenes[0].selected_assets[0].asset_id, "gameplay");

const mechanic = plan([scene("mechanic", "Guitar Hero", ["specific", "gameplay"])], [gameplay, controller]);
assert.equal(mechanic.scenes[0].selected_assets[0].asset_id, "controller");

const rock = plan([scene("rock", null, ["contextual_broll", "technology"])], [cover, concert]);
assert.equal(rock.scenes[0].selected_assets[0].asset_id, "concert");

const noUnrelated = plan([scene("identity", "Guitar Hero", ["cover_art"])], [unrelated]);
assert.equal(noUnrelated.scenes[0].selected_assets.length, 0);
assert.equal(noUnrelated.scenes[0].fallback_reason, "no_acceptable_asset");

const contextualFallback = plan([{ ...scene("fallback", "Guitar Hero", ["cover_art"]), allow_contextual_fallback: true }], [concert]);
assert.equal(contextualFallback.scenes[0].selected_assets[0].asset_id, "concert");
assert.equal(contextualFallback.scenes[0].fallback_reason, "contextual_fallback");

const similarUnused = asset("similar-unused", { asset_role: "specific", total_score: 145, semantic_relevance: { score: 59, passed: true } });
const reusePreference = plan([
  scene("first", "Guitar Hero", ["specific"]),
  scene("second", "Guitar Hero", ["specific"])
], [controller, similarUnused]);
assert.equal(reusePreference.scenes[0].selected_assets[0].asset_id, "controller");
assert.equal(reusePreference.scenes[1].selected_assets[0].asset_id, "similar-unused");

const substantiallyBetter = asset("substantially-better", { asset_role: "specific", total_score: 300, semantic_relevance: { score: 60, passed: true } });
const weakAlternative = asset("weak-alternative", { asset_role: "specific", total_score: 0, quality_tier: "usable", semantic_relevance: { score: 0, passed: true } });
const reuseAllowed = plan([
  scene("best-first", "Guitar Hero", ["specific"]),
  scene("best-second", "Guitar Hero", ["specific"])
], [substantiallyBetter, weakAlternative]);
assert.equal(reuseAllowed.scenes[1].selected_assets[0].asset_id, "substantially-better");
assert.equal(reuseAllowed.scenes[1].selected_assets[0].reused, true);

const videoCompatible = plan([scene("video-compatible", "Guitar Hero", ["specific"])], [asset("future-video", { type: "video" })]);
assert.equal(videoCompatible.scenes[0].selected_assets[0].media_type, "video");
assert.equal(intro.scenes[0].selected_assets[0].media_type, "image");
assert.deepEqual(plan([scene("deterministic", "Guitar Hero", ["cover_art", "specific"])], [cover, controller]), plan([scene("deterministic", "Guitar Hero", ["cover_art", "specific"])], [cover, controller]));

const gameplayIntent = scene("intent-gameplay", "Guitar Hero", ["gameplay", "specific"], "gameplay");
const intentGameplay = asset("intent-gameplay", { asset_role: "gameplay", quality_tier: "usable", semantic_relevance: { score: 90, passed: true }, total_score: 165 });
const intentSpecific = asset("intent-specific", { asset_role: "specific", quality_tier: "high_quality", semantic_relevance: { score: 91, passed: true }, total_score: 205 });
const intentPlan = plan([gameplayIntent], [intentSpecific, intentGameplay]);
assert.equal(intentPlan.scenes[0].selected_assets[0].asset_id, "intent-gameplay", "a same-entity gameplay asset wins the gameplay intent");
assert.equal(intentPlan.scenes[0].selected_assets[0].assignment_score, 330, "the gameplay intent role receives exactly the approved +12 bonus");
assert.ok(intentPlan.scenes[0].selected_assets[0].assignment_reasons.includes("visual_intent_role_match:12"));

const specificOnlyPlan = plan([gameplayIntent], [intentSpecific]);
assert.equal(specificOnlyPlan.scenes[0].selected_assets[0].assignment_score, 326, "a same-entity specific role receives no gameplay bonus");
assert.ok(!specificOnlyPlan.scenes[0].selected_assets[0].assignment_reasons.some((reason) => reason.startsWith("visual_intent_role_match:")));

const semanticFailedGameplay = asset("semantic-failed", { asset_role: "gameplay", quality_tier: "usable", semantic_relevance: { score: 90, passed: false }, total_score: 165 });
const semanticFailedPlan = plan([gameplayIntent], [semanticFailedGameplay]);
assert.equal(semanticFailedPlan.scenes[0].selected_assets[0].assignment_score, 318, "semantic_relevance.passed=false prevents only the new +12 bonus");
assert.equal(semanticFailedPlan.scenes[0].selected_assets[0].asset_id, "semantic-failed", "semantic_relevance.passed=false is not a new universal exact-entity rejection gate");

const wrongEntityGameplay = asset("wrong-entity-gameplay", { asset_role: "gameplay", final_entity: "Burnout", semantic_relevance: { score: 90, passed: true }, total_score: 900 });
assert.equal(plan([gameplayIntent], [wrongEntityGameplay, intentSpecific]).scenes[0].selected_assets[0].asset_id, "intent-specific", "wrong-entity gameplay cannot receive the exact-entity intent bonus or displace a compatible asset");

const reuseScorePlan = plan([
  scene("reuse-first", "Guitar Hero", ["specific"]),
  scene("reuse-second", "Guitar Hero", ["specific"])
], [substantiallyBetter, weakAlternative]);
assert.equal(reuseScorePlan.scenes[1].selected_assets[0].assignment_score, reuseScorePlan.scenes[0].selected_assets[0].assignment_score - 35, "reuse penalty remains exactly 35 per prior use");

const historicalAssets = [
  asset("asset-adb373ee0b4d9dc2", { asset_role: "cover_art", quality_tier: "usable", semantic_relevance: { score: 121, passed: true }, total_score: 241 }),
  asset("asset-92c21f402c858526", { asset_role: "specific", quality_tier: "high_quality", semantic_relevance: { score: 91, passed: true }, total_score: 205 }),
  asset("asset-c979e3c5960285d6", { asset_role: "specific", quality_tier: "usable", semantic_relevance: { score: 91, passed: true }, total_score: 187 }),
  asset("asset-8dd445f2283e970b", { asset_role: "gameplay", quality_tier: "usable", semantic_relevance: { score: 90, passed: true }, total_score: 165 }),
  asset("asset-0d6f3d429964e4d5", { asset_role: "contextual_broll", final_entity: null, quality_tier: "high_quality", semantic_relevance: { score: 40, passed: true }, total_score: 145 })
];
const historicalPlan = plan([
  scene("guitar-hero-identity", "Guitar Hero", ["cover_art", "official_art", "specific"], "franchise_identity"),
  scene("guitar-hero-gameplay", "Guitar Hero", ["gameplay", "specific", "official_art"], "gameplay"),
  scene("activision-business", "Activision", ["company"], "company_context"),
  scene("rock-culture", null, ["contextual_broll", "technology"], "rock_music_context"),
  scene("guitar-hero-conclusion", "Guitar Hero", ["official_art", "cover_art", "specific"], "franchise_conclusion")
], historicalAssets);
assert.deepEqual(
  historicalPlan.scenes.map((entry) => entry.selected_assets[0]?.asset_id ?? "no_asset"),
  ["asset-adb373ee0b4d9dc2", "asset-8dd445f2283e970b", "no_asset", "asset-0d6f3d429964e4d5", "asset-92c21f402c858526"],
  "the generic intent bonus produces the approved five-scene Guitar Hero mapping"
);
assert.equal(historicalPlan.scenes[1].selected_assets[0].assignment_score, 330, "the real gameplay photo scores 330");
assert.equal(historicalPlan.scenes[4].selected_assets[0].assignment_score, 318, "the controller is available for conclusion at 318");
assert.equal(historicalPlan.scenes[4].selected_assets[0].reuse_count_before_assignment, 0, "the controller was not consumed by gameplay");
console.log("scene mapper tests passed");
