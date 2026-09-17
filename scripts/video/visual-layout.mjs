const VISUAL_FAMILIES = new Set([
  "media",
  "cover_product",
  "company_logo",
  "data_economy",
  "brand"
]);

export const SAFE_ZONES = Object.freeze({
  main: Object.freeze({ left: 48, right: 1032, top: 170, bottom: 1470 }),
  subtitle: Object.freeze({ top: 1420, bottom: 1620 }),
  lowerPlatform: Object.freeze({ top: 1660, bottom: 1920 }),
  branding: Object.freeze({ x: 72, y: 112 })
});

function hasStructuredNumericData(scene) {
  const data = scene?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  if (typeof data.value === "number" && Number.isFinite(data.value)) return true;
  if (Array.isArray(data.values) && data.values.some((value) => typeof value === "number" && Number.isFinite(value))) return true;
  return Array.isArray(data.series) && data.series.some((entry) =>
    entry && typeof entry === "object" && typeof entry.value === "number" && Number.isFinite(entry.value)
  );
}

function hasProductIntent(scene, selectedAsset) {
  const roles = [...(scene.preferred_roles ?? []), selectedAsset?.role]
    .filter(Boolean)
    .map((role) => String(role).toLowerCase());
  return roles.some((role) => ["cover_art", "official_art", "specific", "product"].includes(role));
}

export function resolveVisualFamily(scene, selectedAsset = null) {
  if (VISUAL_FAMILIES.has(scene?.visual_family)) return scene.visual_family;
  if (hasStructuredNumericData(scene)) return "data_economy";

  const intent = String(scene?.visual_intent ?? "").toLowerCase();
  if (intent === "company_context") return "company_logo";
  if (intent === "gameplay") return "media";
  if (["franchise_identity", "franchise_conclusion"].includes(intent) && hasProductIntent(scene, selectedAsset)) {
    return "cover_product";
  }
  if (["rock_music_context", "contextual", "contextual_broll", "technology"].includes(intent)) return "media";
  return "media";
}

function motionFor(family, order = 0) {
  const variation = Math.abs(Number(order) || 0) % 3;
  if (family === "media") {
    return { type: "zoompan", zoomStart: 1, zoomEnd: 1.02 + variation * 0.02, pan: variation === 1 ? "x" : variation === 2 ? "y" : "center" };
  }
  if (family === "cover_product") return { type: "zoompan", zoomStart: 1, zoomEnd: 1.01 + variation * 0.01, pan: "center" };
  if (family === "company_logo") return { type: "zoompan", zoomStart: 1, zoomEnd: 1.01, pan: "center" };
  return { type: "static", zoomStart: 1, zoomEnd: 1, pan: "center" };
}

export function endCardTiming(duration) {
  const numericDuration = Number(duration);
  const endCardDuration = Number.isFinite(numericDuration) && numericDuration > 0 ? Math.min(2, numericDuration) : 0;
  return {
    start: numericDuration - endCardDuration,
    end: numericDuration,
    duration: endCardDuration
  };
}

export function buildVisualLayout({ scene, selectedAsset = null, order = 0, duration }) {
  const family = resolveVisualFamily(scene, selectedAsset);
  const hasMedia = Boolean(selectedAsset);
  const containsMedia = family === "cover_product" || family === "company_logo";
  return {
    family,
    hasMedia,
    mediaTreatment: hasMedia ? (containsMedia ? "contain" : "fill_crop") : "none",
    motion: hasMedia ? motionFor(family, order) : motionFor("brand", order),
    brandingMode: family === "brand" ? "large" : "small",
    subtitleMode: "scene_caption",
    safeZones: SAFE_ZONES,
    endCard: endCardTiming(duration),
    dataEnabled: family === "data_economy" && hasStructuredNumericData(scene),
    companyFallback: family === "company_logo" && !hasMedia,
    title: family === "company_logo" && !hasMedia ? (scene.target_entity ?? scene.headline?.[0] ?? "") : (scene.headline?.[0] ?? "")
  };
}

export function visualDebugPlan({ scenes, sceneAssets = new Map(), duration }) {
  return scenes.map((scene, order) => ({
    scene_id: scene.scene_id,
    ...buildVisualLayout({ scene, selectedAsset: sceneAssets.get(scene.scene_id) ?? null, order, duration })
  }));
}
