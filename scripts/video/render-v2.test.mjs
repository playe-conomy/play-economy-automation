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

  const baseBackground = "drawbox=x=0:y=0:w=1080:h=1920:color=0x07121F:t=fill";
  const blackEndCard = "drawbox=x=0:y=0:w=1080:h=1920:color=0x000000:t=fill:enable='between(t\\,23\\,27)'";
  const firstMediaInput = mediaGraph.indexOf("[3:v]scale=1080:1920");
  const lastMediaOverlay = mediaGraph.indexOf("[scene_canvas_4]");
  assert.ok(mediaGraph.indexOf(baseBackground) < firstMediaInput, "V4 draws its opaque base before selected media");
  assert.ok(
    mediaGraph.indexOf(baseBackground, firstMediaInput) === -1,
    "no opaque full-screen V2 base is drawn after selected media"
  );
  assert.match(mediaGraph, /scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920/);
  assert.match(mediaGraph, /overlay=0:0:enable='between\(t\\,0\\,5\)'/, "identity media is active from 0 to 5");
  assert.match(mediaGraph, /overlay=0:0:enable='between\(t\\,5\\,10\)'/, "gameplay media is active from 5 to 10");
  assert.ok(!mediaGraph.includes("overlay=0:0:enable='between(t\\,10\\,15)'"), "the no_asset Activision scene receives no media overlay");
  assert.match(mediaGraph, /drawbox=x=72:y=420:w=410:h=16:color=0x006BFF:t=fill:enable='between\(t\\,10\\,15\)'/, "the no_asset Activision scene keeps the generated fallback");
  assert.match(mediaGraph, /overlay=0:0:enable='between\(t\\,15\\,21\)'/, "rock media is active from 15 to 21");
  assert.match(mediaGraph, /overlay=0:0:enable='between\(t\\,21\\,27\)'/, "conclusion media is active from 21 to 27 before foreground layers");
  assert.ok(
    mediaGraph.indexOf(blackEndCard) > lastMediaOverlay,
    "the deliberate legacy end card remains downstream and begins at 23, covering conclusion media only from 23 to 27"
  );
  assert.ok(lastMediaOverlay < mediaGraph.indexOf("drawtext="), "existing V2 text overlays remain above selected scene media");
  assert.ok(lastMediaOverlay < mediaGraph.indexOf("subtitles="), "captions remain above selected scene media");
  assert.ok(lastMediaOverlay < mediaGraph.indexOf("[canvas][avatar]overlay="), "avatar branding remains above selected scene media");
  assert.ok(lastMediaOverlay < mediaGraph.indexOf("[with_avatar][logo]overlay="), "logo branding remains above selected scene media");
  assert.match(await readFile(rendererPath, "utf8"), /color=c=0x07121F:s=1080x1920:r=30/, "V2 output canvas remains 1080x1920");
} finally {
  process.argv = originalArgv;
  await rm(testDirectory, { recursive: true, force: true });
}

console.log("render V2 V4 compatibility tests passed");

