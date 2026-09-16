import { promises as fs } from "node:fs";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

export function driveConfiguration() {
  return {
    rootFolderId: "1T0c4vqzPIPz4QusCP7Jf60EkoNI7nbwx",
    rootPath: "02_Biblioteca Visual",
    authentication: "Google Cloud Workload Identity Federation with GitHub Actions OIDC",
    configured: Boolean(process.env.GOOGLE_DRIVE_ACCESS_TOKEN)
  };
}

export function driveDestination(candidate) {
  return resolveAssetDestination(candidate.assetRole, candidate).drivePath;
}

export function resolveAssetDestination(assetRole, metadata = {}) {
  const entity = metadata.entity ?? metadata.franchise ?? metadata.company ?? metadata.console ?? null;
  const folders = {
    specific: "Franquicias",
    gameplay: "Gameplay",
    company: "Empresas",
    console: "Consolas",
    character: "Personajes",
    official_art: "Arte Oficial",
    map: "Mapas"
  };
  if (assetRole === "technology" || assetRole === "contextual_broll") {
    return { finalCategory: "Tecnología", finalEntity: null, drivePath: "02_Biblioteca Visual/Tecnología/" };
  }
  if (assetRole === "playeconomy_graphic") {
    return { finalCategory: "Gráficos PLAYECONOMY", finalEntity: null, drivePath: "02_Biblioteca Visual/Gráficos PLAYECONOMY/" };
  }
  const finalCategory = folders[assetRole] ?? "Tecnología";
  const finalEntity = entity || null;
  const suffix = finalEntity ? `${finalEntity}/` : "";
  return { finalCategory, finalEntity, drivePath: `02_Biblioteca Visual/${finalCategory}/${suffix}` };
}

async function driveError(code, response) {
  const error = new Error(code);
  error.code = code;
  error.status = response?.status;
  try {
    const payload = await response?.json();
    const detail = payload?.error;
    error.details = {
      reason: detail?.errors?.[0]?.reason ?? null,
      message: detail?.message ?? null
    };
  } catch {
    error.details = { reason: null, message: null };
  }
  return error;
}

function driveHeaders(accessToken, headers = {}) {
  return { Authorization: `Bearer ${accessToken}`, ...headers };
}

async function driveJson(url, options, { accessToken, fetchImpl = fetch }) {
  const response = await fetchImpl(url, { ...options, headers: driveHeaders(accessToken, options.headers) });
  if (!response.ok) throw await driveError(`drive_http_${response.status}`, response);
  return response.status === 204 ? null : response.json();
}

function escapedQueryValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function listFolders(parentId, name, options) {
  const query = `'${escapedQueryValue(parentId)}' in parents and name = '${escapedQueryValue(name)}' and mimeType = '${FOLDER_MIME_TYPE}' and trashed = false`;
  const url = new URL(`${DRIVE_API}/files`);
  url.searchParams.set("q", query);
  url.searchParams.set("fields", "files(id,name,mimeType)");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  const result = await driveJson(url, { method: "GET" }, options);
  return result.files ?? [];
}

async function createFolder(name, parentId, options) {
  return driveJson(`${DRIVE_API}/files?supportsAllDrives=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME_TYPE, parents: [parentId] })
  }, options);
}

export async function verifyDriveRoot(options = {}) {
  const { rootFolderId = driveConfiguration().rootFolderId } = options;
  const url = new URL(`${DRIVE_API}/files/${encodeURIComponent(rootFolderId)}`);
  url.searchParams.set("fields", "id,name,mimeType");
  url.searchParams.set("supportsAllDrives", "true");
  const root = await driveJson(url, { method: "GET" }, options);
  if (root.name !== "02_Biblioteca Visual" || root.mimeType !== FOLDER_MIME_TYPE) throw await driveError("drive_root_mismatch");
  return root;
}

export async function driveAuthenticatedIdentity(options = {}) {
  const url = new URL(`${DRIVE_API}/about`);
  url.searchParams.set("fields", "user(emailAddress)");
  const result = await driveJson(url, { method: "GET" }, options);
  return result.user?.emailAddress ?? null;
}

export async function resolveDriveFolder(destination, options = {}) {
  const { rootFolderId = driveConfiguration().rootFolderId } = options;
  const categories = await listFolders(rootFolderId, destination.finalCategory, options);
  if (!categories.length) throw await driveError("drive_category_missing");
  const categoryFolder = categories[0];
  if (!destination.finalEntity) return { id: categoryFolder.id, path: `02_Biblioteca Visual/${destination.finalCategory}/` };
  const entities = await listFolders(categoryFolder.id, destination.finalEntity, options);
  const entityFolder = entities[0] ?? await createFolder(destination.finalEntity, categoryFolder.id, options);
  return { id: entityFolder.id, path: `02_Biblioteca Visual/${destination.finalCategory}/${destination.finalEntity}/` };
}

async function findDriveDuplicate(checksum, options) {
  const query = `appProperties has { key='playeconomy_sha256' and value='${escapedQueryValue(checksum)}' } and trashed = false`;
  const url = new URL(`${DRIVE_API}/files`);
  url.searchParams.set("q", query);
  url.searchParams.set("fields", "files(id,name)");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  const result = await driveJson(url, { method: "GET" }, options);
  return result.files?.[0] ?? null;
}

function multipartBody(metadata, bytes) {
  const boundary = "playeconomy-drive-upload";
  const opening = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${metadata.mimeType}\r\n\r\n`);
  const closing = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { boundary, body: Buffer.concat([opening, bytes, closing]) };
}

export async function uploadToDrive(record, destination, options = {}) {
  if (!options.accessToken) throw await driveError("drive_not_configured");
  const duplicate = await findDriveDuplicate(record.checksum, options);
  if (duplicate) return { status: "duplicate", drive_file_id: duplicate.id, drive_folder_id: null, drive_path: null };
  const folder = await resolveDriveFolder(destination, options);
  const bytes = await fs.readFile(record.local_cache_path);
  const metadata = { name: record.filename, mimeType: record.mime_type, parents: [folder.id], appProperties: { playeconomy_sha256: record.checksum } };
  const { boundary, body } = multipartBody(metadata, bytes);
  const url = new URL(DRIVE_UPLOAD_API);
  url.searchParams.set("uploadType", "multipart");
  url.searchParams.set("fields", "id,name,parents,createdTime,appProperties");
  url.searchParams.set("supportsAllDrives", "true");
  const file = await driveJson(url, { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body }, options);
  return { status: "uploaded", drive_file_id: file.id, drive_folder_id: folder.id, drive_path: folder.path };
}
