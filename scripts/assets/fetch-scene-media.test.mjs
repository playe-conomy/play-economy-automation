import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSelectedAssets, fetchSceneMedia } from "./fetch-scene-media.mjs";

const bytesFor = (id) => Buffer.from(`synthetic-image-${id}`);
const checksumFor = (bytes) => createHash("sha256").update(bytes).digest("hex");

function catalogAsset(id, overrides = {}) {
  const bytes = bytesFor(id);
  return {
    id,
    type: "image",
    status: "uploaded",
    upload_status: "uploaded",
    filename: `${id}.jpg`,
    mime_type: "image/jpeg",
    title: `Title ${id}`,
    creator: `Creator ${id}`,
    source: "Openverse",
    source_url: `https://example.test/${id}`,
    license: "CC BY 4.0",
    license_url: "https://creativecommons.org/licenses/by/4.0/",
    asset_role: "cover_art",
    checksum: checksumFor(bytes),
    drive_file_id: `drive-${id}`,
    ...overrides
  };
}

function selected(asset) {
  return { asset_id: asset.id, media_type: asset.type, drive_file_id: asset.drive_file_id, checksum: asset.checksum, title: asset.title, source_url: asset.source_url, license: asset.license, license_url: asset.license_url };
}

function plan(assets) {
  return {
    version: "3.5",
    content_id: "guitar-hero-v2",
    scenes: [
      { scene_id: "guitar-hero-identity", selected_assets: [selected(assets[0])], fallback_status: "not_used" },
      { scene_id: "guitar-hero-gameplay", selected_assets: [selected(assets[1])], fallback_status: "not_used" },
      { scene_id: "activision-business", selected_assets: [], fallback_status: "no_asset", fallback_reason: "no_acceptable_asset" },
      { scene_id: "rock-culture", selected_assets: [selected(assets[2])], fallback_status: "not_used" },
      { scene_id: "guitar-hero-conclusion", selected_assets: [selected(assets[3])], fallback_status: "not_used" }
    ]
  };
}

function driveFetch(assets, calls, { missingId = null, wrongBytesId = null } = {}) {
  return async (url, options = {}) => {
    assert.equal(options.method, "GET", "V4 only performs Drive reads");
    const id = assets.find((asset) => String(url).includes(asset.drive_file_id))?.id;
    calls.push(id ?? "unknown");
    if (!id || id === missingId) return new Response(JSON.stringify({ error: { message: "missing" } }), { status: 404, headers: { "content-type": "application/json" } });
    return new Response(wrongBytesId === id ? bytesFor("wrong") : bytesFor(id), { status: 200 });
  };
}

const assets = [
  "asset-adb373ee0b4d9dc2",
  "asset-92c21f402c858526",
  "asset-0d6f3d429964e4d5",
  "asset-c979e3c5960285d6",
  "asset-8dd445f2283e970b"
].map(catalogAsset);
const manifest = { version: 1, assets };
const validationDirectory = await mkdtemp(join(tmpdir(), "playeconomy-v4-fetch-"));
try {
  const calls = [];
  const result = await fetchSceneMedia(plan(assets), manifest, {
    outputDir: join(validationDirectory, "success"),
    accessToken: "test-token",
    fetchImpl: driveFetch(assets, calls),
    validateImage: async () => {}
  });
  assert.equal(calls.length, 4, "four selected unique assets result in four Drive reads");
  assert.deepEqual(calls.sort(), assets.slice(0, 4).map((asset) => asset.id).sort(), "the current Guitar Hero fixture fetches exactly its four selected assets");
  assert.ok(!calls.includes(assets[4].id), "the fifth catalog asset is never downloaded");
  assert.equal(result.manifest.assets.length, 4);
  assert.equal(result.manifest.scenes["activision-business"], undefined, "no_asset scenes do not receive media assignments");
  assert.equal(result.report.drive_writes, 0);
  assert.equal(result.report.downloaded_assets, 4);
  assert.ok(!JSON.stringify(result.manifest).match(/token|secret|credential/i), "scene-media output contains no credentials");
  assert.equal((result.attribution.match(/^## /gm) ?? []).length, 4, "attribution includes only used unique assets");
  assert.equal((await readFile(join(validationDirectory, "success", "scene-media", `${assets[0].id}.jpg`))).equals(bytesFor(assets[0].id)), true);

  const duplicatePlan = plan(assets);
  duplicatePlan.scenes[4].selected_assets = [selected(assets[0])];
  const duplicateCalls = [];
  const duplicateResult = await fetchSceneMedia(duplicatePlan, manifest, { outputDir: join(validationDirectory, "duplicate"), accessToken: "test-token", fetchImpl: driveFetch(assets, duplicateCalls), validateImage: async () => {} });
  assert.equal(duplicateCalls.length, 3, "an asset reused by two scenes downloads once");
  assert.equal(duplicateResult.manifest.scenes["guitar-hero-identity"].local_path, duplicateResult.manifest.scenes["guitar-hero-conclusion"].local_path);

  const noAssetCalls = [];
  const noAssetPlan = { content_id: "none", scenes: [{ scene_id: "empty", selected_assets: [], fallback_status: "no_asset" }] };
  const noAssetResult = await fetchSceneMedia(noAssetPlan, manifest, { outputDir: join(validationDirectory, "no-asset"), accessToken: "test-token", fetchImpl: driveFetch(assets, noAssetCalls), validateImage: async () => {} });
  assert.equal(noAssetCalls.length, 0, "no_asset scenes cause no Drive fetches");
  assert.equal(noAssetResult.manifest.assets.length, 0);

  await assert.rejects(
    fetchSceneMedia(plan(assets), manifest, { outputDir: join(validationDirectory, "mismatch"), accessToken: "test-token", fetchImpl: driveFetch(assets, [], { wrongBytesId: assets[0].id }), validateImage: async () => {} }),
    { code: "scene_media_sha256_mismatch" },
    "SHA mismatches fail closed"
  );
  assert.equal(await readFile(join(validationDirectory, "mismatch", "scene-media", `${assets[0].id}.jpg`)).catch(() => null), null, "invalid media is removed");

  await assert.rejects(
    fetchSceneMedia(plan(assets), manifest, { outputDir: join(validationDirectory, "missing"), accessToken: "test-token", fetchImpl: driveFetch(assets, [], { missingId: assets[0].id }), validateImage: async () => {} }),
    { code: "drive_http_404" },
    "missing Drive files fail closed"
  );

  const videoAsset = catalogAsset("video", { type: "video", mime_type: "video/mp4" });
  assert.throws(() => collectSelectedAssets({ scenes: [{ scene_id: "video", selected_assets: [selected(videoAsset)] }] }, { version: 1, assets: [videoAsset] }), { code: "unsupported_media_type" }, "selected video fails explicitly until renderer support exists");

  await assert.rejects(
    fetchSceneMedia(plan(assets), manifest, { outputDir: join(validationDirectory, "corrupt"), accessToken: "test-token", fetchImpl: driveFetch(assets, []), validateImage: async () => { const error = new Error("image_not_decodable"); error.code = "image_not_decodable"; throw error; } }),
    { code: "image_not_decodable" },
    "corrupt images fail closed"
  );
} finally {
  await rm(validationDirectory, { recursive: true, force: true });
}

console.log("fetch scene media tests passed");

