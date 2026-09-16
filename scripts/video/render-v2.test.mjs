import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const rendererPath = join(repositoryRoot, "scripts", "video", "render-v2.mjs");
const contentPath = join(repositoryRoot, "content", "guitar-hero.json");
const testDirectory = await mkdtemp(join(tmpdir(), "playeconomy-v4-renderer-"));
const originalArgv = process.argv;

async function prepare(outputPath, sceneMediaPath = null, suffix) {
  process.argv = [process.execPath, rendererPath, "prepare", contentPath, outputPath, ...(sceneMediaPath ? [sceneMediaPath] : [])];
  await import(`${pathToFileURL(rendererPath).href}?test=${suffix}`);
}

try {
  const baselineOutput = join(testDirectory, "baseline");
  await prepare(baselineOutput, null, "baseline");
  const baselineGraph = await readFile(join(baselineOutput, "filtergraph.txt"), "utf8");
  assert.ok(!baselineGraph.includes("scene_media_"), "V2 without scene media preserves its generated-only graph");
  assert.ok(baselineGraph.startsWith("[0:v]drawbox="), "V2 backward-compatible graph still starts from the generated canvas");

  const imagePath = join(testDirectory, "identity.jpg");
  const sceneMediaPath = join(testDirectory, "scene-media.json");
  await writeFile(imagePath, "synthetic image fixture");
  await writeFile(sceneMediaPath, JSON.stringify({
    version: "4",
    scenes: {
      "guitar-hero-identity": { asset_id: "identity", media_type: "image", local_path: imagePath }
    }
  }));
  const mediaOutput = join(testDirectory, "with-media");
  await prepare(mediaOutput, sceneMediaPath, "with-media");
  const mediaGraph = await readFile(join(mediaOutput, "filtergraph.txt"), "utf8");
  assert.match(mediaGraph, /scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920/);
  assert.match(mediaGraph, /overlay=0:0:enable='between\(t\\,0\\,5\)'/);
  assert.ok(!mediaGraph.includes("overlay=0:0:enable='between(t\\,10\\,15)'"), "the no_asset Activision scene receives no media overlay");
  assert.ok(mediaGraph.indexOf("[scene_canvas_0]") < mediaGraph.indexOf("drawtext="), "existing V2 text overlays remain above selected scene media");
  assert.match(await readFile(rendererPath, "utf8"), /color=c=0x07121F:s=1080x1920:r=30/, "V2 output canvas remains 1080x1920");
} finally {
  process.argv = originalArgv;
  await rm(testDirectory, { recursive: true, force: true });
}

console.log("render V2 V4 compatibility tests passed");

