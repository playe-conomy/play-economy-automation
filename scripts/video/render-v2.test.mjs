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

async function prepare(outputPath, sceneMediaPath = null, suffix, definitionPath = contentPath) {
  process.argv = [process.execPath, rendererPath, "prepare", definitionPath, outputPath, ...(sceneMediaPath ? [sceneMediaPath] : [])];
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
  const baselineCaptions = await readFile(join(baselineOutput, "captions.ass"), "utf8");
  assert.match(baselineCaptions, /Style: Caption,DejaVu Sans,48,.*?,92,92,220,1/, "legacy V2 caption style remains unchanged");
  assert.equal((baselineCaptions.match(/^Dialogue:/gm) ?? []).length, 5, "legacy V2 retains one caption event per scene");

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
  const firstMediaInput = mediaGraph.indexOf("[scene_media_0_0]");
  const lastMediaOverlay = mediaGraph.indexOf("[scene_canvas_4_1]");
  assert.ok(mediaGraph.indexOf(baseBackground) < firstMediaInput, "V4 draws its opaque base before selected media");
  assert.ok(
    mediaGraph.indexOf(baseBackground, firstMediaInput) === -1,
    "no opaque full-screen V2 base is drawn after selected media"
  );
  assert.match(mediaGraph, /scale=900:1120:force_original_aspect_ratio=decrease,pad=1080:1920/, "cover/product media fits inside the canvas");
  assert.match(mediaGraph, /scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920/, "media scenes retain controlled fill/crop");
  assert.match(mediaGraph, /zoompan=z='min\(zoom\+0\.000/, "V4.1 media receives deterministic native FFmpeg motion");
  assert.match(mediaGraph, /trim=start=0:end=2\.742857142857143,setpts=PTS-STARTPTS/, "identity Beat A starts its media motion at the local beat origin");
  assert.match(mediaGraph, /trim=start=2\.742857142857143:end=5,setpts=PTS-STARTPTS/, "identity Beat B receives a separate local-time presentation");
  assert.match(mediaGraph, /trim=start=5:end=7\.5,setpts=PTS-STARTPTS/, "gameplay Beat A starts motion locally instead of at global render time");
  assert.match(mediaGraph, /trim=start=7\.5:end=10,setpts=PTS-STARTPTS/, "gameplay Beat B does not inherit advanced zoom from Beat A");
  assert.match(mediaGraph, /setpts=PTS\+5\/TB\[scene_media_1_0\]/, "later media is re-timestamped to its own scene time after local motion");
  assert.match(mediaGraph, /overlay=0:0:enable='between\(t\\,0\\,2\.742857142857143\)'/, "identity establishing media is active for Beat A");
  assert.match(mediaGraph, /overlay=0:0:enable='between\(t\\,2\.742857142857143\\,5\)'/, "identity detail media is active for Beat B");
  assert.match(mediaGraph, /overlay=0:0:enable='between\(t\\,5\\,7\.5\)'/, "gameplay establishing media is active for Beat A");
  assert.match(mediaGraph, /overlay=0:0:enable='between\(t\\,7\.5\\,10\)'/, "gameplay reframed media is active for Beat B");
  assert.ok(!mediaGraph.includes("overlay=0:0:enable='between(t\\,10\\,15)'"), "the no_asset Activision scene receives no media overlay");
  assert.match(mediaGraph, /text='Activision'.*between\(t\\,10\.2\\,12\.4\)/, "the no_asset Activision scene keeps its company-name establishing fallback");
  assert.match(mediaGraph, /text='APROVECHÓ EL MOMENTO'.*between\(t\\,12\.6\\,14\.8\)/, "the no_asset Activision scene switches to its supporting-message state");
  assert.match(mediaGraph, /overlay=0:0:enable='between\(t\\,15\\,18\.314285714285713\)'/, "rock media starts with its establishing beat");
  assert.match(mediaGraph, /overlay=0:0:enable='between\(t\\,18\.314285714285713\\,21\)'/, "rock media receives a deterministic second presentation");
  assert.match(mediaGraph, /overlay=0:0:enable='between\(t\\,21\\,23\)'/, "conclusion establishing media is active from 21 to 23");
  assert.match(mediaGraph, /overlay=0:0:enable='between\(t\\,23\\,25\)'/, "conclusion detail ends when the unchanged end card takes ownership");
  assert.doesNotMatch(mediaGraph, /scene_media_4_\d+\]overlay=0:0:enable='between\(t\\,25\\,27\)'/, "no normal conclusion media branch renders during the end card");
  assert.ok(!mediaGraph.includes("drawbox=x=72:y=990"), "generic central dark boxes are absent in V4.1 media mode");
  assert.ok(!mediaGraph.includes("drawbox=x=72:y=1125:w=90"), "generic decorative charts are absent in V4.1 media mode");
  assert.match(mediaGraph, /\[2:v\]scale=136:-1,format=rgba\[normal_brand\]/, "a transparent official logo is preserved as an RGBA normal-scene overlay");
  assert.match(mediaGraph, /\[canvas\]\[normal_brand\]overlay=72:112/, "normal branding remains inside the upper safe zone");
  assert.ok(!mediaGraph.includes("text='PLAYECONOMY':fontcolor=0xD7E7FF:fontsize=24"), "normal scene branding does not use an opaque text plate");
  assert.match(mediaCaptions, /Style: Caption,DejaVu Sans,54,.*?,72,72,300,1/, "V4.1 captions use the conservative lower safe zone");
  assert.ok((mediaCaptions.match(/^Dialogue:/gm) ?? []).length > 5, "V4.1.1 emits phrase-level caption events instead of one static event per scene");
  assert.ok(!mediaCaptions.includes("{\\c&HFF6B00&}"), "captions do not invent blue semantic emphasis without explicit metadata");
  assert.ok(!mediaGraph.includes("text='CONVERTIDO'"), "normal V4.1 scenes do not repeat the legacy three-line headline stack");
  assert.match(mediaGraph, /text='PLÁSTICO'.*between\(t\\,0\.2\\,2\.642857142857143\)/, "cover headline is visible only during its establishing beat");
  assert.doesNotMatch(mediaGraph, /text='PLÁSTICO'.*between\(t\\,2\.742857142857143\\,5\)/, "cover detail beat does not retain the headline");
  assert.match(mediaGraph, /text='JUEGOS \+'.*between\(t\\,5\.2\\,7\.4\)/, "media headline is visible during its establishing beat only");
  assert.ok(
    mediaGraph.indexOf(blackEndCard) > lastMediaOverlay,
    "the V4.1 end card remains downstream and begins at 25, leaving conclusion media visible from 21 to 25"
  );
  assert.ok(lastMediaOverlay < mediaGraph.indexOf("drawtext="), "existing V2 text overlays remain above selected scene media");
  assert.ok(lastMediaOverlay < mediaGraph.indexOf("subtitles="), "captions remain above selected scene media");
  assert.ok(lastMediaOverlay < mediaGraph.indexOf("[canvas][normal_brand]overlay="), "normal branding remains above selected scene media");
  assert.ok(lastMediaOverlay < mediaGraph.indexOf("[with_brand][logo]overlay="), "end-card logo branding remains above selected scene media");
  assert.match(await readFile(rendererPath, "utf8"), /color=c=0x07121F:s=1080x1920:r=30/, "V2 output canvas remains 1080x1920");
  assert.deepEqual(
    visualLayout.scenes.map((scene) => scene.family),
    ["cover_product", "media", "company_logo", "media", "cover_product"],
    "renderer debug output exposes the required five-scene Guitar Hero family plan"
  );
  assert.equal(visualLayout.scenes[2].companyFallback, true, "debug output documents the Activision no_asset fallback");
  assert.equal(visualLayout.scenes[0].safeZones.subtitle.bottom, 1620, "debug output preserves the conservative subtitle safe zone");
  assert.equal(visualLayout.transparent_logo_available, true, "debug output records transparent official branding availability");
  assert.equal(visualLayout.scenes[0].captionSegments[0].start, 0, "debug output includes phrase-level caption timing");
  assert.equal(visualLayout.scenes.at(-1).captionSegments.at(-1).end, 27, "debug caption timing reaches the final scene end");
  assert.deepEqual(visualLayout.scenes[0].visualBeats.map((beat) => [beat.start, beat.end]), [[0, 2.742857142857143], [2.742857142857143, 5]], "debug output exposes the identity visual beats");
  assert.deepEqual(visualLayout.scenes.at(-1).visualBeats.map((beat) => [beat.start, beat.end]), [[21, 23], [23, 25]], "debug output gives conclusion media clean ownership before the end card");

  const sharedSceneMediaPath = join(testDirectory, "shared-scene-media.json");
  await writeFile(sharedSceneMediaPath, JSON.stringify({
    version: "4",
    scenes: {
      "guitar-hero-identity": { asset_id: "identity", media_type: "image", local_path: imagePaths.identity },
      "guitar-hero-gameplay": { asset_id: "gameplay", media_type: "image", local_path: imagePaths.gameplay },
      "rock-culture": { asset_id: "rock", media_type: "image", local_path: imagePaths.rock },
      "guitar-hero-conclusion": { asset_id: "identity", media_type: "image", local_path: imagePaths.identity }
    }
  }));
  const sharedOutput = join(testDirectory, "shared-media");
  await prepare(sharedOutput, sharedSceneMediaPath, "shared-media");
  const sharedGraph = await readFile(join(sharedOutput, "filtergraph.txt"), "utf8");
  assert.match(sharedGraph, /\[4:v\]split=4\[asset_media_1_0\]\[asset_media_1_1\]\[asset_media_1_2\]\[asset_media_1_3\]/, "one unique local input fans out safely to all four same-asset beat uses across scenes");
  assert.ok(!sharedGraph.includes("[6:v]"), "same-asset scene reuse does not add another renderer media input");

  const emphasizedContent = JSON.parse(await readFile(contentPath, "utf8"));
  emphasizedContent.scenes[0].caption_emphasis = "negocio";
  const emphasizedContentPath = join(testDirectory, "emphasized-content.json");
  await writeFile(emphasizedContentPath, JSON.stringify(emphasizedContent));
  const emphasisOutput = join(testDirectory, "with-emphasis");
  await prepare(emphasisOutput, sceneMediaPath, "with-emphasis", emphasizedContentPath);
  const emphasisCaptions = await readFile(join(emphasisOutput, "captions.ass"), "utf8");
  assert.match(emphasisCaptions, /\{\\c&HFF6B00&\}negocio\{\\c&HFFFFFF&\}/, "explicit caption emphasis remains supported");
} finally {
  process.argv = originalArgv;
  await rm(testDirectory, { recursive: true, force: true });
}

console.log("render V2 V4 compatibility tests passed");


