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
  assert.ok(
    baselineGraph.startsWith("[0:v]drawbox=x=0:y=0:w=1080:h=1920:color=0x07121F:t=fill"),
    "V2 backward-compatible graph still starts with its opaque generated background"
  );
  assert.match(
    baselineGraph,
    /drawbox=x=0:y=0:w=1080:h=1920:color=0x000000:t=fill:enable='between\(t\\,23\\,27\)'/,
    "legacy V2 retains its 23-27 end card"
  );

  const imagePaths = {
    identity: join(testDirectory, "identity.jpg"),
    gameplay: join(testDirectory, "gameplay.jpg"),
    rock: join(testDirectory, "rock.jpg"),
    conclusion: join(testDirectory, "conclusion.jpg")
  };
  const sceneMediaPath = join(testDirectory, "scene-media.json");
  await Promise.all(Object.values(imagePaths).map((imagePath) => writeFile(imagePath, "synthetic image fixture")));
  await writeFile(sceneMediaPath, JSON.stringify({
    version: "4",
    scenes: {
      "guitar-hero-identity": { asset_id: "identity", media_type: "image", local_path: imagePaths.identity },
      "guitar-hero-gameplay": { asset_id: "gameplay", media_type: "image", local_path: imagePaths.gameplay },
      "rock-culture": { asset_id: "rock", media_type: "image", local_path: imagePaths.rock },
      "guitar-hero-conclusion": { asset_id: "conclusion", media_type: "image", local_path: imagePaths.conclusion }
    }
  }));
  const mediaOutput = join(testDirectory, "with-media");
  await prepare(mediaOutput, sceneMediaPath, "with-media");
  const mediaGraph = await readFile(join(mediaOutput, "filtergraph.txt"), "utf8");
  const mediaCaptions = await readFile(join(mediaOutput, "captions.ass"), "utf8");
  const visualLayout = JSON.parse(await readFile(join(mediaOutput, "visual-layout.json"), "utf8"));

  const baseBackground = "drawbox=x=0:y=0:w=1080:h=1920:color=0x07121F:t=fill";
  const blackEndCard = "drawbox=x=0:y=0:w=1080:h=1920:color=0x000000:t=fill:enable='between(t\\,25\\,27)'";
  const firstMediaInput = mediaGraph.indexOf("[scene_media_0]");
  const lastMediaOverlay = mediaGraph.indexOf("[scene_canvas_4]");
  assert.ok(mediaGraph.indexOf(baseBackground) < firstMediaInput, "V4 draws its opaque base before selected media");
  assert.ok(
    mediaGraph.indexOf(baseBackground, firstMediaInput) === -1,
    "no opaque full-screen V2 base is drawn after selected media"
  );
  assert.match(mediaGraph, /scale=900:1120:force_original_aspect_ratio=decrease,pad=1080:1920/, "cover/product media fits inside the canvas");
  assert.match(mediaGraph, /scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920/, "media scenes retain controlled fill/crop");
  assert.match(mediaGraph, /zoompan=z='min\(zoom\+0\.000/, "V4.1 media receives deterministic native FFmpeg motion");
  assert.match(mediaGraph, /overlay=0:0:enable='between\(t\\,0\\,5\)'/, "identity media is active from 0 to 5");
  assert.match(mediaGraph, /overlay=0:0:enable='between\(t\\,5\\,10\)'/, "gameplay media is active from 5 to 10");
  assert.ok(!mediaGraph.includes("overlay=0:0:enable='between(t\\,10\\,15)'"), "the no_asset Activision scene receives no media overlay");
  assert.match(mediaGraph, /text='Activision'.*between\(t\\,10\.2\\,14\.8\)/, "the no_asset Activision scene receives a company-specific generated fallback");
  assert.match(mediaGraph, /overlay=0:0:enable='between\(t\\,15\\,21\)'/, "rock media is active from 15 to 21");
  assert.match(mediaGraph, /overlay=0:0:enable='between\(t\\,21\\,27\)'/, "conclusion media is active from 21 to 27 before foreground layers");
  assert.ok(!mediaGraph.includes("drawbox=x=72:y=990"), "generic central dark boxes are absent in V4.1 media mode");
  assert.ok(!mediaGraph.includes("drawbox=x=72:y=1125:w=90"), "generic decorative charts are absent in V4.1 media mode");
  assert.match(mediaGraph, /drawtext=.*text='PLAYECONOMY'.*fontsize=24/, "normal scenes use a small persistent PlayEconomy identifier");
  assert.match(mediaCaptions, /Style: Caption,DejaVu Sans,54,.*?,72,72,300,1/, "V4.1 captions use the conservative lower safe zone");
  assert.ok(!mediaGraph.includes("text='CONVERTIDO'"), "normal V4.1 scenes do not repeat the legacy three-line headline stack");
  assert.ok(
    mediaGraph.indexOf(blackEndCard) > lastMediaOverlay,
    "the V4.1 end card remains downstream and begins at 25, leaving conclusion media visible from 21 to 25"
  );
  assert.ok(lastMediaOverlay < mediaGraph.indexOf("drawtext="), "existing V2 text overlays remain above selected scene media");
  assert.ok(lastMediaOverlay < mediaGraph.indexOf("subtitles="), "captions remain above selected scene media");
  assert.ok(lastMediaOverlay < mediaGraph.indexOf("[canvas][avatar]overlay="), "avatar branding remains above selected scene media");
  assert.ok(lastMediaOverlay < mediaGraph.indexOf("[with_avatar][logo]overlay="), "logo branding remains above selected scene media");
  assert.match(await readFile(rendererPath, "utf8"), /color=c=0x07121F:s=1080x1920:r=30/, "V2 output canvas remains 1080x1920");
  assert.deepEqual(
    visualLayout.scenes.map((scene) => scene.family),
    ["cover_product", "media", "company_logo", "media", "cover_product"],
    "renderer debug output exposes the required five-scene Guitar Hero family plan"
  );
  assert.equal(visualLayout.scenes[2].companyFallback, true, "debug output documents the Activision no_asset fallback");
  assert.equal(visualLayout.scenes[0].safeZones.subtitle.bottom, 1620, "debug output preserves the conservative subtitle safe zone");
} finally {
  process.argv = originalArgv;
  await rm(testDirectory, { recursive: true, force: true });
}

console.log("render V2 V4 compatibility tests passed");

