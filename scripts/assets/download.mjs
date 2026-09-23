import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, extname, join } from "node:path";
import { normalizeSourceUrl } from "./catalog.mjs";
import { isExactApprovedActivisionEditorialJpeg } from "./activision-games-blog.mjs";

const MIME_EXTENSIONS = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp"
};

function checksum(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function assetId(candidate) {
  return `asset-${checksum(Buffer.from(normalizeSourceUrl(candidate.sourceUrl))).slice(0, 16)}`;
}

function structuredError(reason, downloadDiagnostics = null) {
  return { status: "error", download_error: reason, checksum: null, local_cache_path: null, bytes: 0, download_diagnostics: downloadDiagnostics };
}

function hasExpectedSignature(bytes, mimeType) {
  if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return bytes.length >= 12 && bytes.subarray(0, 4).equals(Buffer.from("RIFF")) && bytes.subarray(8, 12).equals(Buffer.from("WEBP"));
}

function octetStreamDiagnostics(observedContentType, evaluated, decision, reason) {
  return {
    observed_content_type: observedContentType || null,
    exact_activision_octet_stream_fallback: { evaluated, decision, reason }
  };
}

export async function downloadCandidate(candidate, options) {
  const { cacheDir, maxFileBytes, fetchImpl = fetch, manifestAssets = [], executionChecksums = new Set(), httpTimeoutMs = 10000, maxRetries = 2, backoffMs = 500 } = options;
  let response;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), httpTimeoutMs);
    try {
      response = await fetchImpl(candidate.downloadUrl, { signal: controller.signal });
      if (response.ok || (response.status !== 429 && response.status < 500) || attempt === maxRetries) break;
    } catch (error) {
      if (attempt === maxRetries) return structuredError(error?.name === "AbortError" ? "http_timeout" : "http_request_failed");
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, backoffMs * (2 ** attempt)));
  }
  if (!response) return structuredError("http_request_failed");
  if (!response.ok) return structuredError(`http_${response.status}`);
  const observedContentType = String(response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  let mimeType = observedContentType;
  let extension = MIME_EXTENSIONS[mimeType];
  let downloadDiagnostics = octetStreamDiagnostics(observedContentType, false, "not_applicable", "content_type_not_octet_stream");
  if (!extension) {
    if (observedContentType !== "application/octet-stream") return structuredError("unsupported_content_type", downloadDiagnostics);
    const exactApprovedJpeg = isExactApprovedActivisionEditorialJpeg(candidate);
    downloadDiagnostics = octetStreamDiagnostics(observedContentType, true, exactApprovedJpeg ? "accepted_pending_signature" : "rejected", exactApprovedJpeg ? "exact_approved_activision_jpeg" : "not_exact_approved_activision_jpeg");
    if (!exactApprovedJpeg) return structuredError("unsupported_content_type", downloadDiagnostics);
    mimeType = "image/jpeg";
    extension = MIME_EXTENSIONS[mimeType];
  }
  const urlExtension = extname(new URL(candidate.downloadUrl).pathname).toLowerCase();
  if (urlExtension && ![extension, ".jpeg"].includes(urlExtension)) return structuredError("extension_content_type_mismatch", downloadDiagnostics);
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > maxFileBytes) return structuredError("file_too_large", downloadDiagnostics);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) return structuredError("empty_file", downloadDiagnostics);
  if (bytes.length > maxFileBytes) return structuredError("file_too_large", downloadDiagnostics);
  if (!hasExpectedSignature(bytes, mimeType)) {
    if (observedContentType === "application/octet-stream") downloadDiagnostics = octetStreamDiagnostics(observedContentType, true, "rejected", "invalid_jpeg_signature");
    return structuredError("invalid_image_signature", downloadDiagnostics);
  }
  const fileChecksum = checksum(bytes);
  if (executionChecksums.has(fileChecksum) || manifestAssets.some((asset) => asset.checksum === fileChecksum)) {
    return { status: "duplicate", download_error: null, checksum: fileChecksum, local_cache_path: null, bytes: bytes.length, download_diagnostics: downloadDiagnostics };
  }
  const id = candidate.id ?? assetId(candidate);
  const filename = `${id}${extension}`;
  const localCachePath = join(cacheDir, filename);
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(localCachePath, bytes);
  executionChecksums.add(fileChecksum);
  if (observedContentType === "application/octet-stream") downloadDiagnostics = octetStreamDiagnostics(observedContentType, true, "accepted", "exact_approved_activision_jpeg_signature_valid");
  return { status: "downloaded", download_error: null, checksum: fileChecksum, local_cache_path: localCachePath.replace(/\\\\/g, "/"), bytes: bytes.length, filename, mime_type: mimeType, download_diagnostics: downloadDiagnostics };
}

export function artifactCachePath() {
  return ".cache/assets";
}

export function shouldDownload(dryRun) {
  return !dryRun;
}

export function cacheFileName(path) {
  return basename(path);
}
