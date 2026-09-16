import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDriveFolder, uploadToDrive, verifyDriveRoot } from "./drive.mjs";

const rootId = "root-id";
const folderMimeType = "application/vnd.google-apps.folder";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const requests = [];
const fetchExistingCategory = async (url, options = {}) => {
  const address = String(url);
  requests.push({ address, options });
  if (address.includes(`/files/${rootId}`)) return json({ id: rootId, name: "02_Biblioteca Visual", mimeType: folderMimeType });
  if (address.includes("q=") && decodeURIComponent(address).includes("Tecnología")) return json({ files: [{ id: "technology-id", name: "Tecnología", mimeType: folderMimeType }] });
  if (options.method === "POST") return json({ id: "entity-id", name: "Guitar Hero", mimeType: folderMimeType });
  return json({ files: [] });
};

await verifyDriveRoot({ accessToken: "test-token", rootFolderId: rootId, fetchImpl: fetchExistingCategory });
const folder = await resolveDriveFolder({ finalCategory: "Tecnología", finalEntity: "Guitar Hero" }, { accessToken: "test-token", rootFolderId: rootId, fetchImpl: fetchExistingCategory });
assert.deepEqual(folder, { id: "entity-id", path: "02_Biblioteca Visual/Tecnología/Guitar Hero/" });
const createRequest = requests.find((request) => request.options.method === "POST");
assert.ok(createRequest, "creates a missing entity folder");
assert.deepEqual(JSON.parse(createRequest.options.body).parents, ["technology-id"]);

let writesAfterBadRoot = 0;
await assert.rejects(
  verifyDriveRoot({
    accessToken: "test-token",
    rootFolderId: rootId,
    fetchImpl: async (_url, options = {}) => {
      if (options.method === "POST") writesAfterBadRoot += 1;
      return json({ id: rootId, name: "Play Economy", mimeType: folderMimeType });
    }
  }),
  { code: "drive_root_mismatch" }
);
assert.equal(writesAfterBadRoot, 0, "a root mismatch cannot create folders");

await assert.rejects(
  verifyDriveRoot({
    accessToken: "test-token",
    rootFolderId: rootId,
    fetchImpl: async () => json({ error: { message: "File not found", errors: [{ reason: "notFound" }] } }, 404)
  }),
  (error) => error.code === "drive_http_404" && error.details.reason === "notFound" && error.details.message === "File not found"
);

await assert.rejects(
  resolveDriveFolder({ finalCategory: "Unknown", finalEntity: null }, {
    accessToken: "test-token",
    rootFolderId: rootId,
    fetchImpl: async (_url, options = {}) => {
      assert.notEqual(options.method, "POST", "missing categories must not be created");
      return json({ files: [] });
    }
  }),
  { code: "drive_category_missing" }
);

const cacheDir = await mkdtemp(join(tmpdir(), "playeconomy-drive-test-"));
try {
  const cachePath = join(cacheDir, "asset.jpg");
  await writeFile(cachePath, Buffer.from([0xff, 0xd8, 0xff, 0xdb]));
  const uploadRequests = [];
  const upload = await uploadToDrive({ filename: "asset.jpg", mime_type: "image/jpeg", checksum: "sha256-test", local_cache_path: cachePath }, { finalCategory: "Tecnología", finalEntity: null }, {
    accessToken: "test-token",
    rootFolderId: rootId,
    fetchImpl: async (url, options = {}) => {
      const address = String(url);
      uploadRequests.push({ address, options });
      if (address.includes("upload/drive")) return json({ id: "file-id" });
      if (decodeURIComponent(address).includes("playeconomy_sha256")) return json({ files: [] });
      if (decodeURIComponent(address).includes("Tecnología")) return json({ files: [{ id: "technology-id", name: "Tecnología", mimeType: folderMimeType }] });
      return json({ files: [] });
    }
  });
  assert.equal(upload.status, "uploaded");
  assert.equal(upload.drive_file_id, "file-id");
  const checksumLookup = uploadRequests.find((request) => decodeURIComponent(request.address).includes("playeconomy_sha256"));
  assert.doesNotMatch(decodeURIComponent(checksumLookup.address), /in parents/);
  const uploadRequest = uploadRequests.find((request) => request.address.includes("upload/drive"));
  assert.match(String(uploadRequest.options.body), /playeconomy_sha256/);
  assert.match(String(uploadRequest.options.body), /technology-id/);
} finally {
  await rm(cacheDir, { recursive: true, force: true });
}

console.log("drive tests passed");
