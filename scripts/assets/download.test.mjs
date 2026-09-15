import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadCandidate, shouldDownload } from "./download.mjs";

const cacheDir = await mkdtemp(join(tmpdir(), "playeconomy-download-test-"));
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]);
const candidate = { sourceUrl: "https://source.test/one", downloadUrl: "https://cdn.test/one.jpg" };
const response = (body, status = 200, type = "image/jpeg") => new Response(body, { status, headers: { "content-type": type } });

try {
  assert.equal(shouldDownload(true), false);
  assert.equal(shouldDownload(false), true);
  const downloaded = await downloadCandidate(candidate, { cacheDir, maxFileBytes: 1024, fetchImpl: async () => response(jpeg), maxRetries: 0 });
  assert.equal(downloaded.status, "downloaded");
  assert.ok(downloaded.checksum);
  assert.ok(downloaded.local_cache_path);

  const duplicate = await downloadCandidate({ ...candidate, sourceUrl: "https://source.test/two", downloadUrl: "https://cdn.test/two.jpg" }, { cacheDir, maxFileBytes: 1024, fetchImpl: async () => response(jpeg), executionChecksums: new Set([downloaded.checksum]), maxRetries: 0 });
  assert.equal(duplicate.status, "duplicate");

  const tooLarge = await downloadCandidate(candidate, { cacheDir, maxFileBytes: 3, fetchImpl: async () => response(jpeg), maxRetries: 0 });
  assert.equal(tooLarge.download_error, "file_too_large");

  const html = await downloadCandidate(candidate, { cacheDir, maxFileBytes: 1024, fetchImpl: async () => response("<html>not an image</html>", 200, "text/html"), maxRetries: 0 });
  assert.equal(html.download_error, "unsupported_content_type");

  const httpError = await downloadCandidate(candidate, { cacheDir, maxFileBytes: 1024, fetchImpl: async () => response("", 503), maxRetries: 0 });
  assert.equal(httpError.download_error, "http_503");

  const timeout = await downloadCandidate(candidate, { cacheDir, maxFileBytes: 1024, fetchImpl: async () => { const error = new Error("timeout"); error.name = "AbortError"; throw error; }, maxRetries: 0 });
  assert.equal(timeout.download_error, "http_timeout");
  console.log("download tests passed");
} finally {
  await rm(cacheDir, { recursive: true, force: true });
}
