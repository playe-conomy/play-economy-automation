import { mkdirSync, promises as fs } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { qualityTier } from "./catalog.mjs";

const ASSIGNABLE_STATUSES = new Set(["approved", "downloaded", "uploaded"]);
const ENTITY_COMPATIBLE_ROLES = new Set(["cover_art", "official_art", "specific", "gameplay", "company", "console", "character", "map"]);

function compareAssetIds(left, right) {
  return String(left.id) < String(right.id) ? -1 : String(left.id) > String(right.id) ? 1 : 0;
}

function assetEntity(asset) {
  return asset.final_entity ?? asset.franchise ?? asset.company ?? asset.console ?? null;
}

function mediaType(asset) {
  return asset.type === "video" ? "video" : "image";
}

function sceneNarration(scene) {
  if (scene.narration) return scene.narration;
  if (scene.caption) return scene.caption;
  return [scene.eyebrow, ...(scene.headline ?? []), scene.metric].filter(Boolean).join(" ");
}

export function deriveScenes(content) {
  return (content.scenes ?? []).map((scene, index) => ({
    scene_id: scene.scene_id ?? `${content.id}-scene-${index + 1}`,
    order: index + 1,
    narration: sceneNarration(scene),
    visual_intent: scene.visual_intent ?? "contextual",
    target_entity: scene.target_entity ?? null,
    preferred_roles: scene.preferred_roles ?? ["contextual_broll"],
    allow_contextual_fallback: Boolean(scene.allow_contextual_fallback)
  }));
}

function assignableAssets(manifest) {
  return (manifest.assets ?? [])
    .filter((asset) => ASSIGNABLE_STATUSES.has(asset.status) && ["image", "video"].includes(asset.type ?? "image"))
    .sort(compareAssetIds);
}

function qualityScore(asset) {
  if (asset.quality_tier === "high_quality") return 24;
  if (asset.quality_tier === "usable") return 10;
  return Math.max(0, qualityTier(asset).score);
}

function semanticScore(asset) {
  return Number(asset.semantic_relevance?.score ?? 0);
}

function targetMatches(scene, asset) {
  return Boolean(scene.target_entity) && assetEntity(asset) === scene.target_entity;
}

function assignmentStage(scene, asset, preferredIndex) {
  const exactEntity = targetMatches(scene, asset);
  if (exactEntity && preferredIndex >= 0) return "exact_entity_preferred_role";
  if (exactEntity && ENTITY_COMPATIBLE_ROLES.has(asset.asset_role)) return "exact_entity_compatible_role";
  if (!scene.target_entity && preferredIndex >= 0) return "preferred_role";
  if (scene.allow_contextual_fallback && asset.asset_role === "contextual_broll" && asset.semantic_relevance?.passed !== false) return "contextual_fallback";
  return null;
}

function scoreAssignment(scene, asset, reuseCount) {
  const preferredIndex = scene.preferred_roles.indexOf(asset.asset_role);
  const stage = assignmentStage(scene, asset, preferredIndex);
  if (!stage) return null;
  const stageScore = {
    exact_entity_preferred_role: 160,
    exact_entity_compatible_role: 130,
    preferred_role: 90,
    contextual_fallback: 55
  }[stage];
  const roleScore = preferredIndex >= 0 ? 55 - (preferredIndex * 8) : 0;
  const relevance = Math.min(semanticScore(asset), 60);
  const existingScore = Math.min(Math.max(Number(asset.total_score ?? 0), 0) / 5, 35);
  const reusePenalty = reuseCount * 35;
  const intentRoleBonus = targetMatches(scene, asset) && asset.asset_role === scene.visual_intent && asset.semantic_relevance?.passed !== false ? 12 : 0;
  const score = stageScore + roleScore + relevance + qualityScore(asset) + existingScore + intentRoleBonus - reusePenalty;
  const reasons = [stage];
  if (targetMatches(scene, asset)) reasons.push("target_entity_match");
  if (preferredIndex >= 0) reasons.push(`preferred_role:${preferredIndex + 1}`);
  if (semanticScore(asset)) reasons.push(`semantic_relevance:${semanticScore(asset)}`);
  if (intentRoleBonus) reasons.push(`visual_intent_role_match:${intentRoleBonus}`);
  if (reuseCount) reasons.push(`reuse_penalty:${reusePenalty}`);
  return { score, stage, reasons, reuseCount };
}

function assetReference(asset, assignment) {
  return {
    asset_id: asset.id,
    media_type: mediaType(asset),
    title: asset.title ?? null,
    role: asset.asset_role ?? null,
    target_entity: assetEntity(asset),
    checksum: asset.checksum ?? null,
    source_url: asset.source_url ?? null,
    license: asset.license ?? null,
    license_url: asset.license_url ?? null,
    local_cache_path: asset.local_cache_path ?? null,
    drive_file_id: asset.drive_file_id ?? null,
    drive_path: asset.drive_path ?? null,
    assignment_score: assignment.score,
    assignment_reasons: assignment.reasons,
    reused: assignment.reuseCount > 0,
    reuse_count_before_assignment: assignment.reuseCount
  };
}

export function buildScenePlan(content, manifest) {
  const assets = assignableAssets(manifest);
  const reuseCounts = new Map();
  const scenes = deriveScenes(content).map((scene) => {
    const ranked = assets
      .map((asset) => ({ asset, assignment: scoreAssignment(scene, asset, reuseCounts.get(asset.id) ?? 0) }))
      .filter((candidate) => candidate.assignment && candidate.assignment.score >= 100)
      .sort((left, right) => right.assignment.score - left.assignment.score || compareAssetIds(left.asset, right.asset));
    const chosen = ranked[0] ?? null;
    if (!chosen) return { ...scene, selected_assets: [], fallback_status: "no_asset", fallback_reason: "no_acceptable_asset" };
    reuseCounts.set(chosen.asset.id, (reuseCounts.get(chosen.asset.id) ?? 0) + 1);
    const fallbackUsed = ["exact_entity_compatible_role", "contextual_fallback"].includes(chosen.assignment.stage);
    return {
      ...scene,
      selected_assets: [assetReference(chosen.asset, chosen.assignment)],
      fallback_status: fallbackUsed ? "used" : "not_used",
      fallback_reason: fallbackUsed ? chosen.assignment.stage : null
    };
  });
  return {
    version: "3.5",
    generator: "PlayEconomy Asset-to-Scene Mapper",
    content_id: content.id,
    manifest_version: manifest.version ?? 1,
    scenes
  };
}

const args = Object.fromEntries(process.argv.slice(2).map((arg, index, values) => arg.startsWith("--") ? [arg.slice(2), values[index + 1] ?? true] : null).filter(Boolean));
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const contentPath = resolve(args.content ?? "content/guitar-hero.json");
  const manifestPath = resolve(args.manifest ?? "asset-manager/manifest.json");
  const content = JSON.parse(await fs.readFile(contentPath, "utf8"));
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const outputPath = resolve(args.output ?? `asset-manager/scene-plans/${content.id}.json`);
  const plan = buildScenePlan(content, manifest);
  mkdirSync(resolve(outputPath, ".."), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  console.log(`[Scene Mapper] Content: ${content.id}`);
  console.log(`[Scene Mapper] Scenes: ${plan.scenes.length}; output: ${basename(outputPath)}`);
}
