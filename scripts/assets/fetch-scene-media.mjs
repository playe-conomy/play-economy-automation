import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdirSync, promises as fs } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadManifest, saveManifest } from "./catalog.mjs";
import { driveAuthenticatedIdentity, driveConfiguration, driveError, driveHeaders, verifyDriveRoot } from "./drive.mjs";
import { hydrateDriveCatalog } from "./drive-catalog.mjs";

const IMAGE_EXTENSIONS = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"]
]);

function sceneMediaError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function argsFromCommandLine() {
  return Object.fromEntries(process.argv.slice(2).map((arg, index, values) => arg.startsWith("--") ? [arg.slice(2), values[index + 1] ?? true] : null).filter(Boolean));
}

function selectedAsset(scene) {
  if (scene.fallback_status === "no_asset" || !Array.isArray(scene.selected_assets) || scene.selected_assets.length === 0) return null;
  if (scene.selected_assets.length !== 1) throw sceneMediaError("scene_multiple_selected_assets", { scene_id: scene.scene_id });
  return scene.selected_assets[0];
}

function requiredSelectedAsset(asset, sceneId) {
  for (const field of ["asset_id", "media_type", "drive_file_id", "checksum"]) {
    if (typeof asset?.[field] !== "string" || !asset[field]) throw sceneMediaError("scene_selected_asset_missing_field", { scene_id: sceneId, field });
  }
  if (asset.media_type !== "image") throw sceneMediaError("unsupported_media_type", { scene_id: sceneId, asset_id: asset.asset_id, media_type: asset.media_type });
}

export function collectSelectedAssets(scenePlan, catalogManifest) {
  if (!Array.isArray(scenePlan?.scenes)) throw sceneMediaError("scene_plan_invalid");
  const catalogById = new Map((catalogManifest?.assets ?? []).map((asset) => [asset.id, asset]));
  const assets = new Map();
  const scenes = new Map();

  for (const scene of scenePlan.scenes) {
    const selected = selectedAsset(scene);
    if (!selected) continue;
    requiredSelectedAsset(selected, scene.scene_id);
    const catalogAsset = catalogById.get(selected.asset_id);
    if (!catalogAsset) throw sceneMediaError("selected_asset_missing_from_catalog", { scene_id: scene.scene_id, asset_id: selected.asset_id });
    if (catalogAsset.type !== selected.media_type || catalogAsset.drive_file_id !== selected.drive_file_id || catalogAsset.checksum !== selected.checksum) {
      throw sceneMediaError("selected_asset_catalog_mismatch", { scene_id: scene.scene_id, asset_id: selected.asset_id });
    }
    const existing = assets.get(selected.asset_id);
    if (existing && (existing.checksum !== selected.checksum || existing.drive_file_id !== selected.drive_file_id || existing.media_type !== selected.media_type)) {
      throw sceneMediaError("selected_asset_conflicting_reference", { asset_id: selected.asset_id });
    }
    assets.set(selected.asset_id, { ...catalogAsset, ...selected, scene_ids: [...(existing?.scene_ids ?? []), scene.scene_id] });
    scenes.set(scene.scene_id, selected.asset_id);
  }
  return { assets: [...assets.values()].sort((left, right) => left.asset_id.localeCompare(right.asset_id)), scenes };
}

function extensionFor(asset) {
  const fromMime = IMAGE_EXTENSIONS.get(asset.mime_type ?? "");
  if (fromMime) return fromMime;
  const fromFilename = extname(asset.filename ?? "").toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".webp"].includes(fromFilename)) return fromFilename === ".jpeg" ? ".jpg" : fromFilename;
  throw sceneMediaError("unsupported_image_extension", { asset_id: asset.asset_id, mime_type: asset.mime_type ?? null });
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function downloadDriveFile(asset, { accessToken, fetchImpl = fetch }) {
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(asset.drive_file_id)}`);
  url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");
  const response = await fetchImpl(url, { method: "GET", headers: driveHeaders(accessToken) });
  if (!response.ok) {
    const error = await driveError(`drive_http_${response.status}`, response);
    error.operation = "scene_media_download";
    error.asset_id = asset.asset_id;
    throw error;
  }
  return Buffer.from(await response.arrayBuffer());
}

export function validateImageFile(path, { ffprobe = "ffprobe" } = {}) {
  const result = spawnSync(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_type,width,height", "-of", "json", path], { encoding: "utf8" });
  if (result.error || result.status !== 0) throw sceneMediaError("image_not_decodable", { local_path: path });
  try {
    const stream = JSON.parse(result.stdout).streams?.[0];
    if (stream?.codec_type !== "video" || !Number(stream.width) || !Number(stream.height)) throw new Error("invalid image stream");
  } catch {
    throw sceneMediaError("image_not_decodable", { local_path: path });
  }
}

function sceneMediaManifest(scenePlan, fetched, sceneAssignments) {
  return {
    version: "4",
    content_id: scenePlan.content_id,
    assets: fetched.map((asset) => ({
      asset_id: asset.asset_id,
      media_type: asset.media_type,
      local_path: asset.local_path,
      checksum: asset.checksum,
      drive_file_id: asset.drive_file_id,
      title: asset.title ?? null,
      creator: asset.creator ?? null,
      source_url: asset.source_url ?? null,
      license: asset.license ?? null,
      license_url: asset.license_url ?? null
    })),
    scenes: Object.fromEntries([...sceneAssignments.entries()].map(([sceneId, assetId]) => {
      const asset = fetched.find((entry) => entry.asset_id === assetId);
      return [sceneId, { asset_id: asset.asset_id, media_type: asset.media_type, local_path: asset.local_path }];
    }))
  };
}

export function attributionMarkdown(fetched) {
  const lines = ["# PlayEconomy V4 Asset Attribution", ""];
  for (const asset of fetched) {
    lines.push(`## ${asset.asset_id}`, "");
    if (asset.title) lines.push(`- Title: ${asset.title}`);
    if (asset.creator) lines.push(`- Creator: ${asset.creator}`);
    if (asset.source_url) lines.push(`- Source: ${asset.source_url}`);
    if (asset.license) lines.push(`- License: ${asset.license}`);
    if (asset.license_url) lines.push(`- License URL: ${asset.license_url}`);
    lines.push(`- Scenes: ${asset.scene_ids.join(", ")}`, "");
  }
  return `${lines.join("\n")}\n`;
}

export async function fetchSceneMedia(scenePlan, catalogManifest, options) {
  const { outputDir, accessToken, fetchImpl = fetch, validateImage = validateImageFile } = options;
  if (!accessToken) throw sceneMediaError("drive_not_configured");
  const selected = collectSelectedAssets(scenePlan, catalogManifest);
  const mediaDirectory = resolve(outputDir, "scene-media");
  await fs.mkdir(mediaDirectory, { recursive: true });
  const fetched = [];
  let driveReads = 0;

  for (const asset of selected.assets) {
    const extension = extensionFor(asset);
    const absolutePath = resolve(mediaDirectory, `${asset.asset_id}${extension}`);
    const localPath = resolve(outputDir) === resolve("output") ? `output/scene-media/${asset.asset_id}${extension}` : absolutePath;
    const temporaryPath = `${absolutePath}.partial`;
    try {
      const bytes = await downloadDriveFile(asset, { accessToken, fetchImpl });
      driveReads += 1;
      if (digest(bytes) !== asset.checksum) throw sceneMediaError("scene_media_sha256_mismatch", { asset_id: asset.asset_id });
      await fs.writeFile(temporaryPath, bytes);
      await validateImage(temporaryPath);
      await fs.rename(temporaryPath, absolutePath);
      fetched.push({ ...asset, local_path: localPath });
    } catch (error) {
      await fs.rm(temporaryPath, { force: true });
      await fs.rm(absolutePath, { force: true });
      throw error;
    }
  }

  const manifest = sceneMediaManifest(scenePlan, fetched, selected.scenes);
  return { manifest, attribution: attributionMarkdown(fetched), report: { selected_assets: selected.assets.length, downloaded_assets: fetched.length, drive_reads: driveReads, drive_writes: 0 } };
}

export async function hydrateCanonicalCatalog({ manifestPath, reportPath, accessToken, rootFolderId, fetchImpl = fetch }) {
  if (!accessToken) throw sceneMediaError("drive_not_configured");
  const session = await hydrateDriveCatalog({ accessToken, rootFolderId, fetchImpl });
  if (!session.exists) throw sceneMediaError("catalog_not_found");
  await saveManifest(manifestPath, session.manifest);
  const report = { catalog_file_id: session.fileId, schema_version: session.catalog.schema_version, catalog_assets: session.catalog.assets.length, hydrated_assets: session.manifest.assets.length, drive_writes: 0 };
  if (reportPath) {
    await fs.mkdir(dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  return { session, report };
}

async function run() {
  const args = argsFromCommandLine();
  const mode = args.mode;
  if (!mode || !["hydrate", "fetch"].includes(mode)) throw new Error("Usage: node scripts/assets/fetch-scene-media.mjs --mode <hydrate|fetch> ...");
  const drive = driveConfiguration();
  const accessToken = process.env.GOOGLE_DRIVE_ACCESS_TOKEN;
  if (!drive.configured || !accessToken) throw sceneMediaError("drive_not_configured");
  await driveAuthenticatedIdentity({ accessToken });
  await verifyDriveRoot({ accessToken, rootFolderId: drive.rootFolderId });
  if (mode === "hydrate") {
    await hydrateCanonicalCatalog({ manifestPath: resolve(args.manifest ?? "asset-manager/manifest.json"), reportPath: args.report ? resolve(args.report) : null, accessToken, rootFolderId: drive.rootFolderId });
    return;
  }
  const outputDir = resolve(args["output-dir"] ?? "output");
  const scenePlan = JSON.parse(await fs.readFile(resolve(args["scene-plan"]), "utf8"));
  const manifest = loadManifest(resolve(args.manifest ?? "asset-manager/manifest.json"));
  try {
    const result = await fetchSceneMedia(scenePlan, manifest, { outputDir, accessToken });
    await fs.writeFile(resolve(outputDir, "scene-media.json"), `${JSON.stringify(result.manifest, null, 2)}\n`, "utf8");
    await fs.writeFile(resolve(outputDir, "ATTRIBUTION.md"), result.attribution, "utf8");
    if (args.report) await fs.writeFile(resolve(args.report), `${JSON.stringify(result.report, null, 2)}\n`, "utf8");
  } catch (error) {
    if (args.report) await fs.writeFile(resolve(args.report), `${JSON.stringify({ error: error.code ?? error.message, drive_writes: 0 }, null, 2)}\n`, "utf8");
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await run();
  console.log(`scene media: ${basename(process.argv[1])}`);
}

