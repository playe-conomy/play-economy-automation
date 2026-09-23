import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadCandidate, shouldDownload } from "./download.mjs";

const cacheDir = await mkdtemp(join(tmpdir(), "playeconomy-download-test-"));
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
const candidate = { sourceUrl: "https://source.test/one", downloadUrl: "https://cdn.test/one.jpg" };
const response = (body, status = 200, type = "image/jpeg") => new Response(body, { status, headers: { "content-type": type } });
const activisionUrls = [
  "https://blog.activision.com/content/dam/atvi/activision/atvi-touchui/blog/archives/feature/guitar-hero/featured-Image9913431.jpg",
  "https://blog.activision.com/content/dam/atvi/activision/atvi-touchui/blog/archives/feature/guitar-hero/featured-Image9894231.jpg",
  "https://blog.activision.com/content/dam/atvi/activision/atvi-touchui/blog/archives/feature/guitar-hero/featured-Image9905852.jpg"
];
const activisionCandidate = (url, overrides = {}) => ({
  sourceUrl: url,
  downloadUrl: url,
  provider: "activision-games-blog",
  source_type: "activision_games_blog_article",
  mimeType: "image/jpeg",
  ...overrides
});

try {
  assert.equal(shouldDownload(true), false);
  assert.equal(shouldDownload(false), true);
  const downloaded = await downloadCandidate(candidate, { cacheDir, maxFileBytes: 1024, fetchImpl: async () => response(jpeg), maxRetries: 0 });
  assert.equal(downloaded.status, "downloaded");
  assert.equal(downloaded.checksum, createHash("sha256").update(jpeg).digest("hex"));
  assert.ok(downloaded.local_cache_path);

  const duplicate = await downloadCandidate({ ...candidate, sourceUrl: "https://source.test/two", downloadUrl: "https://cdn.test/two.jpg" }, { cacheDir, maxFileBytes: 1024, fetchImpl: async () => response(jpeg), executionChecksums: new Set([downloaded.checksum]), maxRetries: 0 });
  assert.equal(duplicate.status, "duplicate");

  const tooLarge = await downloadCandidate(candidate, { cacheDir, maxFileBytes: 3, fetchImpl: async () => response(jpeg), maxRetries: 0 });
  assert.equal(tooLarge.download_error, "file_too_large");

  const html = await downloadCandidate(candidate, { cacheDir, maxFileBytes: 1024, fetchImpl: async () => response("<html>not an image</html>", 200, "text/html"), maxRetries: 0 });
  assert.equal(html.download_error, "unsupported_content_type");

  for (const url of activisionUrls) {
    const fallback = await downloadCandidate(activisionCandidate(url), { cacheDir, maxFileBytes: 1024, fetchImpl: async () => response(jpeg, 200, "application/octet-stream"), maxRetries: 0 });
    assert.equal(fallback.status, "downloaded", `${url} accepts the exact verified octet-stream JPEG fallback`);
    assert.equal(fallback.mime_type, "image/jpeg");
    assert.ok(fallback.filename.endsWith(".jpg"));
    assert.deepEqual(fallback.download_diagnostics, { observed_content_type: "application/octet-stream", exact_activision_octet_stream_fallback: { evaluated: true, decision: "accepted", reason: "exact_approved_activision_jpeg_signature_valid" } });
  }

  const octetRejected = async (candidateOverride, body = jpeg, label = "rejected octet stream") => {
    const result = await downloadCandidate(candidateOverride, { cacheDir, maxFileBytes: 1024, fetchImpl: async () => response(body, 200, "application/octet-stream"), maxRetries: 0 });
    assert.equal(result.download_error, "unsupported_content_type", label);
    assert.equal(result.download_diagnostics?.exact_activision_octet_stream_fallback?.decision, "rejected");
  };
  await octetRejected(activisionCandidate(`${activisionUrls[0]}?variant=1`), jpeg, "a similar Activision URL is rejected");
  await octetRejected(activisionCandidate("https://example.test/guitar-hero.jpg"), jpeg, "an external URL is rejected");
  await octetRejected(activisionCandidate("https://community.activision.com/legacyfs/online/12481.jpg"), jpeg, "legacy community media is rejected");
  await octetRejected(activisionCandidate(activisionUrls[0], { mimeType: "image/png" }), jpeg, "an exact URL with a different declared MIME is rejected");
  await octetRejected(activisionCandidate(activisionUrls[0], { provider: "other", source_type: "other" }), jpeg, "an exact URL with the wrong provider and source is rejected");
  await octetRejected(candidate, jpeg, "a generic octet-stream JPEG is rejected");

  const invalidFallback = await downloadCandidate(activisionCandidate(activisionUrls[0]), { cacheDir, maxFileBytes: 1024, fetchImpl: async () => response(png, 200, "application/octet-stream"), maxRetries: 0 });
  assert.equal(invalidFallback.download_error, "invalid_image_signature");
  assert.equal(invalidFallback.download_diagnostics?.exact_activision_octet_stream_fallback?.reason, "invalid_jpeg_signature");

  const exactHtml = await downloadCandidate(activisionCandidate(activisionUrls[0]), { cacheDir, maxFileBytes: 1024, fetchImpl: async () => response("<html>not an image</html>", 200, "text/html"), maxRetries: 0 });
  assert.equal(exactHtml.download_error, "unsupported_content_type");
  const exactNoMime = await downloadCandidate(activisionCandidate(activisionUrls[0]), { cacheDir, maxFileBytes: 1024, fetchImpl: async () => new Response(jpeg, { status: 200 }), maxRetries: 0 });
  assert.equal(exactNoMime.download_error, "unsupported_content_type");

  const normalPng = await downloadCandidate({ ...candidate, downloadUrl: "https://cdn.test/one.png" }, { cacheDir, maxFileBytes: 1024, fetchImpl: async () => response(png, 200, "image/png"), maxRetries: 0 });
  assert.equal(normalPng.status, "downloaded");
  const normalWebp = await downloadCandidate({ ...candidate, downloadUrl: "https://cdn.test/one.webp" }, { cacheDir, maxFileBytes: 1024, fetchImpl: async () => response(webp, 200, "image/webp"), maxRetries: 0 });
  assert.equal(normalWebp.status, "downloaded");

  const httpError = await downloadCandidate(candidate, { cacheDir, maxFileBytes: 1024, fetchImpl: async () => response("", 503), maxRetries: 0 });
  assert.equal(httpError.download_error, "http_503");

  const timeout = await downloadCandidate(candidate, { cacheDir, maxFileBytes: 1024, fetchImpl: async () => { const error = new Error("timeout"); error.name = "AbortError"; throw error; }, maxRetries: 0 });
  assert.equal(timeout.download_error, "http_timeout");
  console.log("download tests passed");
} finally {
  await rm(cacheDir, { recursive: true, force: true });
}
