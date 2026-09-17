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

export function wrapCaptionLines(value, maximumLineLength = 38) {
  const words = String(value).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  const lines = [""];
  for (const word of words) {
    const current = lines.at(-1);
    if (current && `${current} ${word}`.length > maximumLineLength && lines.length < 2) lines.push(word);
    else lines[lines.length - 1] = current ? `${current} ${word}` : word;
  }
  return lines.join("\n");
}

function wordsIn(value) {
  return String(value).trim().split(/\s+/).filter(Boolean);
}

export function segmentCaption(value) {
  const words = wordsIn(value);
  if (words.length <= 6) return words.length ? [words.join(" ")] : [];

  const chunks = [];
  let cursor = 0;
  const desiredChunks = Math.ceil(words.length / 4);
  while (cursor < words.length) {
    const remainingWords = words.length - cursor;
    const remainingChunks = desiredChunks - chunks.length;
    if (remainingChunks <= 1) {
      chunks.push(words.slice(cursor).join(" "));
      break;
    }
    const balancedSize = Math.round(remainingWords / remainingChunks);
    const minimumRemaining = (remainingChunks - 1) * 2;
    const upperBound = Math.min(cursor + balancedSize + 2, words.length - minimumRemaining);
    const lowerBound = Math.max(cursor + 2, cursor + balancedSize - 2);
    let boundary = Math.min(cursor + balancedSize, upperBound);
    for (let index = upperBound; index >= lowerBound; index -= 1) {
      if (/[,;:.!?]$/.test(words[index - 1])) {
        boundary = index;
        break;
      }
    }
    chunks.push(words.slice(cursor, boundary).join(" "));
    cursor = boundary;
  }
  return chunks;
}

export function timedCaptionSegments(scene) {
  const chunks = segmentCaption(scene.caption);
  if (!chunks.length) return [];
  const totalWords = chunks.reduce((total, chunk) => total + wordsIn(chunk).length, 0);
  const duration = Number(scene.end) - Number(scene.start);
  const minimum = chunks.length > 1 ? Math.min(0.8, duration / chunks.length) : duration;
  const distributable = Math.max(0, duration - minimum * chunks.length);
  let cursor = Number(scene.start);
  return chunks.map((text, index) => {
    const wordCount = wordsIn(text).length;
    const segmentDuration = index === chunks.length - 1
      ? Number(scene.end) - cursor
      : minimum + distributable * (wordCount / totalWords);
    const segment = {
      text,
      display_text: wrapCaptionLines(text),
      start: cursor,
      end: cursor + segmentDuration,
      word_count: wordCount
    };
    cursor = segment.end;
    return segment;
  });
}

export function normalBrandingLayout({ transparentLogoAvailable }) {
  return {
    mode: transparentLogoAvailable ? "transparent_logo" : "avatar_fallback",
    x: SAFE_ZONES.branding.x,
    y: SAFE_ZONES.branding.y,
    width: transparentLogoAvailable ? 136 : 52
  };
}

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
    return { type: "zoompan", zoomStart: 1, zoomEnd: 1.02 + variation * 0.02 };
  }
  if (family === "cover_product") return { type: "zoompan", zoomStart: 1, zoomEnd: 1.01 + variation * 0.01 };
  if (family === "company_logo") return { type: "zoompan", zoomStart: 1, zoomEnd: 1.01 };
  return { type: "static", zoomStart: 1, zoomEnd: 1 };
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

function beatBoundary(scene, captionSegments, effectiveEnd) {
  const start = Number(scene.start);
  const candidates = captionSegments
    .map((segment) => Number(segment.start))
    .filter((boundary) => boundary > start && boundary < effectiveEnd && boundary - start >= 1.8 && boundary - start <= 3.5);
  return candidates[0] ?? start + (effectiveEnd - start) / 2;
}

function presentationFor(family, beatIndex, hasMedia, order) {
  if (family === "media") {
    if (beatIndex === 0) return "media_establish";
    return Math.abs(Number(order) || 0) % 2 ? "media_reframe_x" : "media_reframe_y";
  }
  if (family === "cover_product") return beatIndex === 0 ? "cover_establish" : "cover_detail";
  if (family === "company_logo") {
    if (!hasMedia) return beatIndex === 0 ? "company_establish" : "company_supporting";
    return beatIndex === 0 ? "company_establish" : "company_detail";
  }
  if (family === "data_economy") return beatIndex === 0 ? "data_primary" : "data_explanation";
  return "brand_static";
}

function headlineStateFor(family, beatIndex, hasMedia) {
  if (["media", "cover_product"].includes(family) && hasMedia) return beatIndex === 0 ? "visible" : "hidden";
  if (family === "company_logo" && !hasMedia) return beatIndex === 0 ? "company_name" : "supporting_message";
  if (family === "data_economy") return beatIndex === 0 ? "data_primary" : "data_explanation";
  return family === "brand" ? "hidden" : "visible";
}

function beatMotion(family, presentation, order) {
  if (family === "media") return { type: "zoompan", zoomStart: 1, zoomEnd: presentation === "media_establish" ? 1.018 : 1.022 + (Math.abs(Number(order) || 0) % 2) * 0.006 };
  if (family === "cover_product") return { type: "zoompan", zoomStart: 1, zoomEnd: presentation === "cover_establish" ? 1.01 : 1.022 };
  return { type: "static", zoomStart: 1, zoomEnd: 1 };
}

export function visualBeats({ scene, family, hasMedia, captionSegments, selectedAsset = null, order = 0, endCard }) {
  const start = Number(scene.start);
  const end = Number(scene.end);
  const assetId = selectedAsset?.asset_id ?? null;
  const endCardStart = Number(endCard?.start);
  const effectiveEnd = Number.isFinite(endCardStart) && endCardStart < end ? endCardStart : end;
  if (!Number.isFinite(start) || !Number.isFinite(effectiveEnd) || effectiveEnd <= start) return [];
  const eligibleForTwoBeats = effectiveEnd - start >= 4 && family !== "brand";
  const boundaries = eligibleForTwoBeats ? [start, beatBoundary(scene, captionSegments, effectiveEnd), effectiveEnd] : [start, effectiveEnd];
  return boundaries.slice(0, -1).map((beatStart, index) => {
    const presentation = presentationFor(family, index, hasMedia, order);
    return {
      start: beatStart,
      end: boundaries[index + 1],
      presentation,
      headlineState: headlineStateFor(family, index, hasMedia),
      asset_id: assetId,
      motion: beatMotion(family, presentation, order)
    };
  });
}

export function buildVisualLayout({ scene, selectedAsset = null, order = 0, duration }) {
  const family = resolveVisualFamily(scene, selectedAsset);
  const hasMedia = Boolean(selectedAsset);
  const containsMedia = family === "cover_product" || family === "company_logo";
  const captionSegments = timedCaptionSegments(scene);
  const endCard = endCardTiming(duration);
  return {
    family,
    hasMedia,
    mediaTreatment: hasMedia ? (containsMedia ? "contain" : "fill_crop") : "none",
    motion: hasMedia ? motionFor(family, order) : motionFor("brand", order),
    brandingMode: family === "brand" ? "large" : "small",
    subtitleMode: "scene_caption",
    captionSegments,
    visualBeats: visualBeats({ scene, family, hasMedia, captionSegments, selectedAsset, order, endCard }),
    safeZones: SAFE_ZONES,
    endCard,
    dataEnabled: family === "data_economy" && hasStructuredNumericData(scene),
    companyFallback: family === "company_logo" && !hasMedia,
    title: family === "company_logo" && !hasMedia ? (scene.target_entity ?? scene.headline?.[0] ?? "") : (scene.headline?.[0] ?? "")
  };
}

export function visualDebugPlan({ scenes, sceneAssets = new Map(), duration, transparentLogoAvailable = false }) {
  return scenes.map((scene, order) => ({
    scene_id: scene.scene_id,
    ...buildVisualLayout({ scene, selectedAsset: sceneAssets.get(scene.scene_id) ?? null, order, duration }),
    normalBranding: normalBrandingLayout({ transparentLogoAvailable })
  }));
}

