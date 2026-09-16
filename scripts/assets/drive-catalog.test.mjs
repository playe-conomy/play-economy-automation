import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildScenePlan } from "./scene-mapper.mjs";
import { buildCatalog, hydrateDriveCatalog, persistDriveCatalog, validateCatalog } from "./drive-catalog.mjs";

const rootFolderId = "root-id";
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function asset(id, overrides = {}) {
  return {
    id,
    filename: `${id}.jpg`,
    title: id,
    type: "image",
    status: "uploaded",
    upload_status: "uploaded",
    reusable: true,
    asset_role: "cover_art",
    final_entity: "Guitar Hero",
    source: "Openverse",
    source_url: `https://example.test/${id}`,
    checksum: `sha256-${id}`,
    drive_file_id: `drive-${id}`,
    drive_folder_id: "guitar-hero-folder",
    drive_path: "02_Biblioteca Visual/Franquicias/Guitar Hero/",
    mime_type: "image/jpeg",
    semantic_relevance: { score: 60, passed: true },
    total_score: 140,
    license: "CC BY 4.0",
    ...overrides
  };
}

function catalog(assets = [asset("cover")], overrides = {}) {
  return { schema_version: 1, manifest_version: 1, catalog_version: 3, updated_at: "2026-01-01T00:00:00.000Z", assets, ...overrides };
}

function catalogFetch({ files = [], contents = new Map(), bootstrapFiles = new Map(), onRequest = () => {} } = {}) {
  return async (url, options = {}) => {
    const address = String(url);
    onRequest(address, options);
    if (address.includes("/files?") && decodeURIComponent(address).includes(".playeconomy-asset-catalog.json")) return json({ files });
    const matchedFile = [...contents.entries()].find(([id]) => address.includes(`/files/${id}`));
    if (matchedFile && new URL(address).searchParams.get("alt") === "media") return json(matchedFile[1], 200, { etag: `etag-${matchedFile[0]}` });
    const bootstrap = [...bootstrapFiles.entries()].find(([id]) => address.includes(`/files/${id}`));
    if (bootstrap) return json(bootstrap[1]);
    return json({ id: "catalog-file", version: "4" }, 200, { etag: "etag-current" });
  };
}

const empty = await hydrateDriveCatalog({ accessToken: "test-token", rootFolderId, fetchImpl: catalogFetch() });
assert.equal(empty.exists, false, "missing catalog initializes in memory without a Drive write");
assert.equal(empty.manifest.assets.length, 0);
assert.equal(empty.hydration.status, "initialized_empty");

const validCatalog = catalog();
const hydrated = await hydrateDriveCatalog({
  accessToken: "test-token",
  rootFolderId,
  fetchImpl: catalogFetch({ files: [{ id: "catalog-file", version: "3" }], contents: new Map([["catalog-file", validCatalog]]) })
});
assert.equal(hydrated.hydration.status, "hydrated");
assert.deepEqual(hydrated.manifest.assets, [asset("cover")]);
assert.deepEqual(hydrated.manifest, (await hydrateDriveCatalog({ accessToken: "test-token", rootFolderId, fetchImpl: catalogFetch({ files: [{ id: "catalog-file", version: "3" }], contents: new Map([["catalog-file", validCatalog]]) }) })).manifest, "hydration is deterministic");

await assert.rejects(
  hydrateDriveCatalog({ accessToken: "test-token", rootFolderId, fetchImpl: catalogFetch({ files: [{ id: "catalog-file", version: "3" }], contents: new Map([["catalog-file", { not: "a catalog" }]]) }) }),
  { code: "catalog_unsupported_schema_version" },
  "malformed catalog is never replaced with an empty one"
);
assert.throws(() => validateCatalog(catalog([asset("one"), asset("two", { checksum: "sha256-one" })])), { code: "catalog_duplicate_checksum" });
assert.throws(() => validateCatalog(catalog([asset("same"), asset("same", { checksum: "sha256-other" })])), { code: "catalog_duplicate_asset_id" });
assert.throws(() => validateCatalog(catalog([], { schema_version: 2 })), { code: "catalog_unsupported_schema_version" });

const nonBackedManifest = { version: 1, assets: [asset("uploaded"), asset("failed", { status: "downloaded", drive_file_id: null, upload_status: "failed" })] };
assert.deepEqual(buildCatalog(nonBackedManifest, { updatedAt: "2026-01-01T00:00:00.000Z" }).assets.map((entry) => entry.id), ["uploaded"], "only Drive-backed assets are persistent");
assert.equal(buildCatalog({ version: 1, assets: [asset("drive-duplicate", { upload_status: "duplicate", status: "uploaded" })] }).assets.length, 1, "verified Drive duplicates remain persistent");
assert.equal(buildCatalog({ version: 1, assets: [asset("failed-upload", { status: "downloaded", upload_status: "failed", drive_file_id: "drive-failed" })] }).assets.length, 0, "failed uploads cannot be persisted");

const bootstrapDir = await mkdtemp(join(tmpdir(), "playeconomy-bootstrap-"));
try {
  const bootstrapPath = join(bootstrapDir, "manifest.json");
  await writeFile(bootstrapPath, JSON.stringify({ version: 1, assets: [asset("historical")] }));
  const bootstrapSession = await hydrateDriveCatalog({
    accessToken: "test-token",
    rootFolderId,
    bootstrapManifestPath: bootstrapPath,
    fetchImpl: catalogFetch({ bootstrapFiles: new Map([["drive-historical", { id: "drive-historical", appProperties: { playeconomy_sha256: "sha256-historical" } }]]) })
  });
  assert.equal(bootstrapSession.bootstrap.imported, 1);
  assert.equal(bootstrapSession.manifest.assets[0].id, "historical");

  const rejectedBootstrap = await hydrateDriveCatalog({
    accessToken: "test-token",
    rootFolderId,
    bootstrapManifestPath: bootstrapPath,
    fetchImpl: catalogFetch({ bootstrapFiles: new Map([["drive-historical", { id: "drive-historical", appProperties: { playeconomy_sha256: "wrong" } }]]) })
  });
  assert.equal(rejectedBootstrap.bootstrap.imported, 0);
  assert.equal(rejectedBootstrap.bootstrap.skipped, 1, "mismatched historical assets are rejected");
} finally {
  await rm(bootstrapDir, { recursive: true, force: true });
}

let patchAttempted = false;
await assert.rejects(
  persistDriveCatalog({ ...hydrated, catalog: validCatalog }, hydrated.manifest, {
    accessToken: "test-token",
    rootFolderId,
    fetchImpl: catalogFetch({
      onRequest: (_address, options) => { if (options.method === "PATCH") patchAttempted = true; },
      files: [],
      contents: new Map()
    })
  }),
  { code: "catalog_conflict" }
);
assert.equal(patchAttempted, false, "a revision conflict prevents a blind catalog overwrite");

const scenePlan = buildScenePlan({ id: "compatibility", scenes: [{ scene_id: "intro", target_entity: "Guitar Hero", preferred_roles: ["cover_art"] }] }, hydrated.manifest);
assert.equal(scenePlan.scenes[0].selected_assets[0].asset_id, "cover", "hydrated manifests remain mapper-compatible");
assert.equal(buildCatalog({ version: 1, assets: [asset("future-video", { type: "video", mime_type: "video/mp4" })] }).assets[0].type, "video", "future video assets are catalog-compatible");

console.log("drive catalog tests passed");

