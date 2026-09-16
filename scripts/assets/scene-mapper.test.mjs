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

function scene(scene_id, target_entity, preferred_roles) {
  return { scene_id, caption: scene_id, visual_intent: scene_id, target_entity, preferred_roles };
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
console.log("scene mapper tests passed");
