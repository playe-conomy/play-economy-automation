import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const [mode, definitionPath, outputPath = "output", sceneMediaPath] = process.argv.slice(2);

if (!mode || !definitionPath || !["prepare", "render"].includes(mode)) {
  throw new Error("Usage: node scripts/video/render-v2.mjs <prepare|render> <content.json> [output-dir]");
}

const definition = JSON.parse(readFileSync(definitionPath, "utf8"));
const outputDir = resolve(outputPath);
const duration = definition.durationSeconds;
const font = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const subtitleFont = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
const logoPath = resolve("assets/brand/playeconomy-logo.png");
const avatarPath = resolve("assets/brand/playeconomy-avatar.jpeg");

mkdirSync(outputDir, { recursive: true });

function sceneMediaInputs() {
  if (!sceneMediaPath) return { scenes: new Map(), assets: [] };
  const sceneMedia = JSON.parse(readFileSync(sceneMediaPath, "utf8"));
  const assets = new Map();
  const scenes = new Map();
  for (const [sceneId, entry] of Object.entries(sceneMedia.scenes ?? {})) {
    if (entry?.media_type !== "image") throw new Error(`Unsupported scene media type for ${sceneId}`);
    if (!entry.asset_id || !entry.local_path) throw new Error(`Invalid scene media entry for ${sceneId}`);
    const path = resolve(entry.local_path);
    if (!existsSync(path)) throw new Error(`Scene media file missing for ${sceneId}`);
    const existing = assets.get(entry.asset_id);
    if (existing && existing.path !== path) throw new Error(`Conflicting scene media path for ${entry.asset_id}`);
    assets.set(entry.asset_id, { asset_id: entry.asset_id, path });
    scenes.set(sceneId, entry.asset_id);
  }
  return { scenes, assets: [...assets.values()].sort((left, right) => left.asset_id.localeCompare(right.asset_id)) };
}

function escapeAss(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("{", "\\{").replaceAll("}", "\\}").replaceAll("\n", "\\N");
}

function assTimestamp(seconds) {
  const cs = Math.round(seconds * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

function escapeFilter(value) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll(":", "\\:")
    .replaceAll(",", "\\,");
}

function prepare() {
  const sceneMedia = sceneMediaInputs();
  writeFileSync(resolve(outputDir, "narration.txt"), `${definition.narration}\n`, "utf8");

  const assLines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    "Style: Caption,DejaVu Sans,48,&H00FFFFFF,&H00006BFF,&HDD07121F,&HAA07121F,1,0,0,0,100,100,0,0,1,3,0,2,92,92,220,1",
    "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text"
  ];

  for (const scene of definition.scenes) {
    assLines.push(`Dialogue: 0,${assTimestamp(scene.start + 0.2)},${assTimestamp(scene.end - 0.2)},Caption,,0,0,0,,${escapeAss(scene.caption)}`);
  }
  writeFileSync(resolve(outputDir, "captions.ass"), `${assLines.join("\n")}\n`, "utf8");

  const draw = [
    "drawbox=x=0:y=0:w=1080:h=1920:color=0x07121F:t=fill",
    "drawbox=x=0:y=0:w=1080:h=18:color=0x006BFF:t=fill",
    "drawbox=x=0:y=1870:w=1080:h=50:color=0x06101A:t=fill"
  ];

  for (const [index, scene] of definition.scenes.entries()) {
    const start = scene.start;
    const end = scene.end;
    const accentY = 420 + (index % 2) * 130;
    const barWidth = 180 + index * 115;
    const enabled = `between(t\\,${start}\\,${end})`;
    const textEnabled = `between(t\\,${start + 0.15}\\,${end - 0.15})`;
    draw.push(
      `drawbox=x=72:y=${accentY}:w=${barWidth}:h=16:color=0x006BFF:t=fill:enable='${enabled}'`,
      `drawbox=x=72:y=760:w=936:h=4:color=0x2A4663:t=fill:enable='${enabled}'`,
      `drawbox=x=72:y=760:w=${barWidth + 240}:h=4:color=0xFFFFFF:t=fill:enable='${enabled}'`,
      `drawtext=fontfile=${font}:text='${escapeFilter(scene.eyebrow)}':fontcolor=0x7FA7D7:fontsize=34:x=72:y=300:enable='${textEnabled}'`,
      `drawtext=fontfile=${font}:text='${escapeFilter(scene.headline[0])}':fontcolor=white:fontsize=102:x=72:y=500:enable='${textEnabled}'`,
      `drawtext=fontfile=${font}:text='${escapeFilter(scene.headline[1])}':fontcolor=white:fontsize=102:x=72:y=620:enable='${textEnabled}'`,
      `drawtext=fontfile=${font}:text='${escapeFilter(scene.headline[2])}':fontcolor=0x006BFF:fontsize=102:x=72:y=740:enable='${textEnabled}'`,
      `drawtext=fontfile=${font}:text='${escapeFilter(scene.metric)}':fontcolor=0xD7E7FF:fontsize=30:x=72:y=835:enable='${textEnabled}'`,
      `drawbox=x=72:y=990:w=936:h=${260 - index * 22}:color=0x0D2339:t=fill:enable='${enabled}'`,
      `drawbox=x=72:y=${1210 - index * 22}:w=936:h=10:color=0x006BFF:t=fill:enable='${enabled}'`,
      `drawbox=x=${72 + index * 80}:y=1125:w=90:h=${125 + index * 35}:color=0x006BFF:t=fill:enable='${enabled}'`,
      `drawbox=x=${220 + index * 60}:y=1060:w=90:h=${190 + index * 45}:color=0xFFFFFF:t=fill:enable='${enabled}'`,
      `drawbox=x=${368 + index * 40}:y=1010:w=90:h=${240 - index * 20}:color=0x2A85FF:t=fill:enable='${enabled}'`
    );
  }

  draw.push(
    `drawbox=x=0:y=0:w=1080:h=1920:color=0x000000:t=fill:enable='between(t\\,23\\,${duration})'`,
    `drawtext=fontfile=${font}:text='PLAYECONOMY':fontcolor=white:fontsize=58:x=(w-text_w)/2:y=1420:enable='between(t\\,23.3\\,${duration})'`,
    `drawtext=fontfile=${subtitleFont}:text='${escapeFilter(definition.tagline)}':fontcolor=0xBFD7F5:fontsize=30:x=(w-text_w)/2:y=1500:enable='between(t\\,23.5\\,${duration})'`,
    `subtitles=${resolve(outputDir, "captions.ass").replaceAll("\\", "/")}:fontsdir=/usr/share/fonts/truetype/dejavu`
  );

  const mediaFilters = [];
  const hasSceneMedia = sceneMedia.assets.length > 0;
  let canvasInput = "[0:v]";
  const [baseBackground, ...foregroundDraw] = draw;
  if (hasSceneMedia) {
    // Keep the legacy opaque background behind selected V4 scene media.
    mediaFilters.push(`${canvasInput}${baseBackground}[scene_media_base]`);
    canvasInput = "[scene_media_base]";
  }
  for (const [index, scene] of definition.scenes.entries()) {
    const assetId = sceneMedia.scenes.get(scene.scene_id);
    if (!assetId) continue;
    const inputIndex = 3 + sceneMedia.assets.findIndex((asset) => asset.asset_id === assetId);
    const mediaLabel = `scene_media_${index}`;
    const compositeLabel = `scene_canvas_${index}`;
    mediaFilters.push(
      `[${inputIndex}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[${mediaLabel}]`,
      `${canvasInput}[${mediaLabel}]overlay=0:0:enable='between(t\\,${scene.start}\\,${scene.end})'[${compositeLabel}]`
    );
    canvasInput = `[${compositeLabel}]`;
  }

  const graph = [
    ...mediaFilters,
    `${canvasInput}${(hasSceneMedia ? foregroundDraw : draw).join(",")}[canvas]`,
    "[1:v]scale=92:92,format=rgba[avatar]",
    "[2:v]scale=620:-1,format=rgba[logo]",
    "[canvas][avatar]overlay=72:78:enable='between(t,0,22.9)'[with_avatar]",
    `[with_avatar][logo]overlay=(W-w)/2:760:enable='between(t,23,${duration})'[v]`
  ].join(";\n");
  writeFileSync(resolve(outputDir, "filtergraph.txt"), `${graph}\n`, "utf8");
}

function render() {
  const sceneMedia = sceneMediaInputs();
  const audioPath = resolve(outputDir, "narration.mp3");
  const videoPath = resolve(outputDir, `${definition.id}.mp4`);
  const command = [
    "-y",
    "-f", "lavfi", "-i", `color=c=0x07121F:s=1080x1920:r=30:d=${duration}`,
    "-loop", "1", "-framerate", "30", "-i", avatarPath,
    "-loop", "1", "-framerate", "30", "-i", logoPath,
    ...sceneMedia.assets.flatMap((asset) => ["-loop", "1", "-framerate", "30", "-i", asset.path]),
    "-i", audioPath,
    "-filter_complex_script", resolve(outputDir, "filtergraph.txt"),
    "-map", "[v]", "-map", `${3 + sceneMedia.assets.length}:a`,
    "-t", String(duration),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
    "-c:a", "aac", "-b:a", "128k", "-af", `apad=pad_dur=${duration}`,
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", videoPath
  ];
  const result = spawnSync("ffmpeg", command, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (mode === "prepare") prepare();
if (mode === "render") render();

console.log(`${mode}: ${basename(definitionPath)}`);

