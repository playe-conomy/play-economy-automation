import { promises as fs } from "node:fs";
import { DRIVE_API, DRIVE_UPLOAD_API, driveJsonResponse } from "./drive.mjs";

export const CATALOG_SCHEMA_VERSION = 1;
export const CATALOG_FILE_NAME = ".playeconomy-asset-catalog.json";
const CATALOG_PROPERTY = "playeconomy_asset_catalog";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const DRIVE_BACKED_STATUSES = new Set(["uploaded", "approved"]);

function catalogError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function escapedQueryValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalAsset(asset) {
  const result = clone(asset);
  delete result.local_cache_path;
  delete result.download_error;
  delete result.upload_error;
  delete result.upload_diagnostic;
  return result;
}

function validateAsset(asset, index) {
  if (!asset || typeof asset !== "object" || Array.isArray(asset)) throw catalogError("catalog_asset_invalid", { asset_index: index });
  const requiredStrings = ["id", "type", "source", "source_url", "asset_role", "checksum", "drive_file_id"];
  for (const field of requiredStrings) {
    if (typeof asset[field] !== "string" || !asset[field]) throw catalogError("catalog_asset_missing_required_field", { asset_index: index, field });
  }
  if (!["image", "video"].includes(asset.type)) throw catalogError("catalog_asset_unsupported_media_type", { asset_index: index, media_type: asset.type });
  if (!DRIVE_BACKED_STATUSES.has(asset.status)) throw catalogError("catalog_asset_not_drive_backed", { asset_index: index, status: asset.status ?? null });
  if (asset.local_cache_path != null) throw catalogError("catalog_asset_contains_local_cache_path", { asset_index: index });
}

function validateAssetSet(assets) {
  if (!Array.isArray(assets)) throw catalogError("catalog_assets_invalid");
  const ids = new Set();
  const checksums = new Set();
  assets.forEach((asset, index) => {
    validateAsset(asset, index);
    if (ids.has(asset.id)) throw catalogError("catalog_duplicate_asset_id", { asset_id: asset.id });
    if (checksums.has(asset.checksum)) throw catalogError("catalog_duplicate_checksum", { checksum: asset.checksum });
    ids.add(asset.id);
    checksums.add(asset.checksum);
  });
}

function orderedAssets(assets) {
  return [...assets].sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

export function validateCatalog(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw catalogError("catalog_invalid");
  if (input.schema_version !== CATALOG_SCHEMA_VERSION) {
    throw catalogError("catalog_unsupported_schema_version", { schema_version: input.schema_version ?? null });
  }
  if (!Number.isInteger(input.manifest_version) || input.manifest_version < 1) {
    throw catalogError("catalog_invalid_manifest_version", { manifest_version: input.manifest_version ?? null });
  }
  if (!Number.isInteger(input.catalog_version) || input.catalog_version < 1) {
    throw catalogError("catalog_invalid_catalog_version", { catalog_version: input.catalog_version ?? null });
  }
  validateAssetSet(input.assets);
  return {
    schema_version: input.schema_version,
    manifest_version: input.manifest_version,
    catalog_version: input.catalog_version,
    updated_at: typeof input.updated_at === "string" ? input.updated_at : null,
    assets: orderedAssets(input.assets.map(canonicalAsset))
  };
}

export function isDriveBackedAsset(asset) {
  return Boolean(asset?.drive_file_id) && DRIVE_BACKED_STATUSES.has(asset?.status) && asset?.upload_status !== "failed";
}

export function persistentAssets(manifest) {
  const assets = (manifest?.assets ?? [])
    .filter(isDriveBackedAsset)
    .map(canonicalAsset);
  validateAssetSet(assets);
  return orderedAssets(assets);
}

export function buildCatalog(manifest, { catalogVersion = 1, updatedAt = new Date().toISOString() } = {}) {
  const catalog = {
    schema_version: CATALOG_SCHEMA_VERSION,
    manifest_version: Number(manifest?.version ?? 1),
    catalog_version: catalogVersion,
    updated_at: updatedAt,
    assets: persistentAssets(manifest)
  };
  return validateCatalog(catalog);
}

export function manifestFromCatalog(catalog) {
  const valid = validateCatalog(catalog);
  return { version: valid.manifest_version, assets: valid.assets.map(clone) };
}

function catalogLookupUrl(rootFolderId) {
  const query = `'${escapedQueryValue(rootFolderId)}' in parents and name = '${CATALOG_FILE_NAME}' and mimeType = 'application/json' and trashed = false`;
  const url = new URL(`${DRIVE_API}/files`);
  url.searchParams.set("q", query);
  url.searchParams.set("fields", "files(id,name,mimeType,version,modifiedTime,appProperties)");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  return url;
}

async function locateCatalog(options) {
  const result = await driveJsonResponse(catalogLookupUrl(options.rootFolderId), { method: "GET" }, {
    ...options,
    operation: "catalog_lookup",
    targetFolderId: options.rootFolderId,
    targetPath: "02_Biblioteca Visual/"
  });
  const files = result.data.files ?? [];
  if (files.length > 1) throw catalogError("catalog_multiple_files", { catalog_file_ids: files.map((file) => file.id) });
  return files[0] ? { ...files[0], etag: result.etag } : null;
}

async function readCatalogFile(fileId, options) {
  const url = new URL(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");
  return driveJsonResponse(url, { method: "GET" }, {
    ...options,
    operation: "catalog_download",
    targetFolderId: options.rootFolderId,
    targetPath: `02_Biblioteca Visual/${CATALOG_FILE_NAME}`
  });
}

async function bootstrapManifest(path) {
  let input;
  try {
    input = JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    throw catalogError("bootstrap_manifest_invalid");
  }
  const assets = (input.assets ?? []).map(canonicalAsset);
  validateAssetSet(assets);
  return { version: Number(input.manifest_version ?? input.version ?? 1), assets: orderedAssets(assets) };
}

async function verifyBootstrapAsset(asset, options) {
  const url = new URL(`${DRIVE_API}/files/${encodeURIComponent(asset.drive_file_id)}`);
  url.searchParams.set("fields", "id,name,mimeType,appProperties");
  url.searchParams.set("supportsAllDrives", "true");
  try {
    const response = await driveJsonResponse(url, { method: "GET" }, {
      ...options,
      operation: "bootstrap_asset_verify",
      targetFolderId: options.rootFolderId,
      targetPath: asset.drive_path ?? "02_Biblioteca Visual/"
    });
    const file = response.data;
    return file.id === asset.drive_file_id && file.appProperties?.playeconomy_sha256 === asset.checksum;
  } catch {
    return false;
  }
}

async function verifiedBootstrap(path, options) {
  if (!path) return { status: "not_requested", imported: 0, skipped: 0, assets: [] };
  const manifest = await bootstrapManifest(path);
  const verified = [];
  let skipped = 0;
  for (const asset of manifest.assets) {
    if (await verifyBootstrapAsset(asset, options)) verified.push(asset);
    else skipped += 1;
  }
  return { status: skipped ? "completed_with_skips" : "completed", imported: verified.length, skipped, assets: verified, manifestVersion: manifest.version };
}

export async function hydrateDriveCatalog(options) {
  const file = await locateCatalog(options);
  if (file) {
    const response = await readCatalogFile(file.id, options);
    const catalog = validateCatalog(response.data);
    return {
      exists: true,
      fileId: file.id,
      driveVersion: String(file.version ?? ""),
      etag: response.etag ?? file.etag ?? null,
      catalog,
      manifest: manifestFromCatalog(catalog),
      hydration: { status: "hydrated", asset_count: catalog.assets.length },
      bootstrap: { status: "not_needed", imported: 0, skipped: 0 }
    };
  }
  const bootstrap = await verifiedBootstrap(options.bootstrapManifestPath, options);
  const manifest = { version: bootstrap.manifestVersion ?? 1, assets: bootstrap.assets };
  const catalog = buildCatalog(manifest, { catalogVersion: 1 });
  return {
    exists: false,
    fileId: null,
    driveVersion: null,
    etag: null,
    catalog,
    manifest,
    hydration: { status: "initialized_empty", asset_count: catalog.assets.length },
    bootstrap: { status: bootstrap.status, imported: bootstrap.imported, skipped: bootstrap.skipped }
  };
}

function multipartCatalogBody(catalog, rootFolderId) {
  const boundary = "playeconomy-catalog-upload";
  const metadata = {
    name: CATALOG_FILE_NAME,
    mimeType: "application/json",
    parents: [rootFolderId],
    appProperties: { [CATALOG_PROPERTY]: String(CATALOG_SCHEMA_VERSION) }
  };
  const serialized = JSON.stringify(catalog, null, 2);
  const body = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${serialized}\r\n--${boundary}--\r\n`);
  return { boundary, body };
}

async function currentCatalogRevision(fileId, options) {
  const url = new URL(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("fields", "id,version,modifiedTime");
  url.searchParams.set("supportsAllDrives", "true");
  return driveJsonResponse(url, { method: "GET" }, {
    ...options,
    operation: "catalog_revision_check",
    targetFolderId: options.rootFolderId,
    targetPath: `02_Biblioteca Visual/${CATALOG_FILE_NAME}`
  });
}

export async function persistDriveCatalog(session, manifest, options) {
  const catalog = buildCatalog(manifest, {
    catalogVersion: (session.catalog?.catalog_version ?? 0) + 1
  });
  if (!session.exists) {
    const { boundary, body } = multipartCatalogBody(catalog, options.rootFolderId);
    const url = new URL(DRIVE_UPLOAD_API);
    url.searchParams.set("uploadType", "multipart");
    url.searchParams.set("fields", "id,version,modifiedTime");
    url.searchParams.set("supportsAllDrives", "true");
    const response = await driveJsonResponse(url, { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body }, {
      ...options,
      operation: "catalog_create",
      targetFolderId: options.rootFolderId,
      targetPath: `02_Biblioteca Visual/${CATALOG_FILE_NAME}`
    });
    return { fileId: response.data.id, catalog, created: true };
  }

  const current = await currentCatalogRevision(session.fileId, options);
  if (String(current.data.version ?? "") !== String(session.driveVersion ?? "") || (session.etag && current.etag && session.etag !== current.etag)) {
    throw catalogError("catalog_conflict", { file_id: session.fileId });
  }
  const url = new URL(`${DRIVE_UPLOAD_API}/${encodeURIComponent(session.fileId)}`);
  url.searchParams.set("uploadType", "media");
  url.searchParams.set("fields", "id,version,modifiedTime");
  url.searchParams.set("supportsAllDrives", "true");
  const headers = { "Content-Type": "application/json" };
  if (session.etag) headers["If-Match"] = session.etag;
  const response = await driveJsonResponse(url, { method: "PATCH", headers, body: JSON.stringify(catalog) }, {
    ...options,
    operation: "catalog_update",
    targetFolderId: options.rootFolderId,
    targetPath: `02_Biblioteca Visual/${CATALOG_FILE_NAME}`
  });
  return { fileId: response.data.id, catalog, created: false };
}

