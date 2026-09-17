import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildVisualLayout, visualDebugPlan } from "./visual-layout.mjs";

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

function wrapCaption(value, maximumLineLength = 38) {
  const words = String(value).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  const lines = [""];
  for (const word of words) {
    const current = lines.at(-1);
    if (current && `${current} ${word}`.length > maximumLineLength && lines.length < 2) lines.push(word);
    else lines[lines.length - 1] = current ? `${current} ${word}` : word;
  }
  return lines.join("\n");
}

function captionText(scene, v41) {
  const caption = v41 ? wrapCaption(scene.caption) : scene.caption;
  const emphasis = scene.caption_emphasis;
  if (v41 && typeof emphasis === "string" && emphasis && caption.includes(emphasis)) {
    const [before, after] = caption.split(emphasis, 2);
    return `${escapeAss(before)}{\\c&HFF6B00&}${escapeAss(emphasis)}{\\c&HFFFFFF&}${escapeAss(after ?? "")}`;
  }
  return escapeAss(caption);
}

function captionLines(v41) {
  const style = v41
    ? "Style: Caption,DejaVu Sans,54,&H00FFFFFF,&H00FF6B00,&HDD07121F,&HAA07121F,1,0,0,0,100,100,0,0,1,3,0,2,72,72,300,1"
    : "Style: Caption,DejaVu Sans,48,&H00FFFFFF,&H00006BFF,&HDD07121F,&HAA07121F,1,0,0,0,100,100,0,0,1,3,0,2,92,92,220,1";
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    style,
    "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text"
  ];
}

function legacyDraw() {
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
  return draw;
}

function v41Foreground(layouts) {
  const draw = [
    "drawbox=x=0:y=0:w=1080:h=8:color=0x006BFF:t=fill",
    "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='PLAYECONOMY':fontcolor=0xD7E7FF:fontsize=24:x=140:y=112"
  ];
  for (const [index, scene] of definition.scenes.entries()) {
    const layout = layouts[index];
    const enabled = `between(t\\,${scene.start}\\,${scene.end})`;
    const textEnabled = `between(t\\,${scene.start + 0.2}\\,${scene.end - 0.2})`;
    draw.push(
      `drawbox=x=72:y=238:w=96:h=8:color=0x006BFF:t=fill:enable='${enabled}'`,
      `drawtext=fontfile=${font}:text='${escapeFilter(scene.eyebrow)}':fontcolor=0xBFD7F5:fontsize=30:x=72:y=275:enable='${textEnabled}'`,
      `drawtext=fontfile=${font}:text='${escapeFilter(layout.title)}':fontcolor=white:fontsize=${layout.family === "company_logo" ? 92 : 64}:x=72:y=${layout.family === "company_logo" ? 560 : 330}:enable='${textEnabled}'`
    );
    if (layout.companyFallback) {
      draw.push(`drawtext=fontfile=${subtitleFont}:text='${escapeFilter(scene.headline.slice(1).join(" "))}':fontcolor=0xD7E7FF:fontsize=42:x=72:y=680:enable='${textEnabled}'`);
    }
    if (layout.dataEnabled && typeof scene.data?.value === "number") {
      draw.push(`drawtext=fontfile=${font}:text='${escapeFilter(String(scene.data.value))}':fontcolor=0x006BFF:fontsize=96:x=72:y=760:enable='${textEnabled}'`);
    }
  }
  draw.push(`subtitles=${resolve(outputDir, "captions.ass").replaceAll("\\", "/")}:fontsdir=/usr/share/fonts/truetype/dejavu`);
  return draw;
}

function mediaFilter(inputIndex, label, layout) {
  const increment = layout.family === "cover_product" ? "0.00015" : "0.00035";
  const transform = layout.mediaTreatment === "contain"
    ? "scale=900:1120:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0x07121F"
    : "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920";
  return `[${inputIndex}:v]${transform},zoompan=z='min(zoom+${increment},${layout.motion.zoomEnd})':d=1:s=1080x1920:fps=30,setsar=1[${label}]`;
}

function prepare() {
  const sceneMedia = sceneMediaInputs();
  const hasSceneMedia = sceneMedia.assets.length > 0;
  writeFileSync(resolve(outputDir, "narration.txt"), `${definition.narration}\n`, "utf8");
  const assLines = captionLines(hasSceneMedia);
  for (const scene of definition.scenes) {
    assLines.push(`Dialogue: 0,${assTimestamp(scene.start + 0.2)},${assTimestamp(scene.end - 0.2)},Caption,,0,0,0,,${captionText(scene, hasSceneMedia)}`);
  }
  writeFileSync(resolve(outputDir, "captions.ass"), `${assLines.join("\n")}\n`, "utf8");
  if (!hasSceneMedia) {
    const draw = legacyDraw();
    const graph = [
      `[0:v]${draw.join(",")}[canvas]`,
      "[1:v]scale=92:92,format=rgba[avatar]",
      "[2:v]scale=620:-1,format=rgba[logo]",
      "[canvas][avatar]overlay=72:78:enable='between(t,0,22.9)'[with_avatar]",
      `[with_avatar][logo]overlay=(W-w)/2:760:enable='between(t,23,${duration})'[v]`
    ].join(";\n");
    writeFileSync(resolve(outputDir, "filtergraph.txt"), `${graph}\n`, "utf8");
    return;
  }

  const sceneAssets = new Map(definition.scenes.map((scene) => [
    scene.scene_id,
    sceneMedia.scenes.has(scene.scene_id) ? { asset_id: sceneMedia.scenes.get(scene.scene_id) } : null
  ]));
  const layouts = visualDebugPlan({ scenes: definition.scenes, sceneAssets, duration });
  writeFileSync(resolve(outputDir, "visual-layout.json"), `${JSON.stringify({ version: "4.1", scenes: layouts }, null, 2)}\n`, "utf8");

  const endCard = layouts[0].endCard;
  const mediaFilters = ["[0:v]drawbox=x=0:y=0:w=1080:h=1920:color=0x07121F:t=fill[scene_media_base]"];
  let canvasInput = "[scene_media_base]";
  for (const [index, scene] of definition.scenes.entries()) {
    const assetId = sceneMedia.scenes.get(scene.scene_id);
    if (!assetId) continue;
    const inputIndex = 3 + sceneMedia.assets.findIndex((asset) => asset.asset_id === assetId);
    const mediaLabel = `scene_media_${index}`;
    const compositeLabel = `scene_canvas_${index}`;
    mediaFilters.push(
      mediaFilter(inputIndex, mediaLabel, layouts[index]),
      `${canvasInput}[${mediaLabel}]overlay=0:0:enable='between(t\\,${scene.start}\\,${scene.end})'[${compositeLabel}]`
    );
    canvasInput = `[${compositeLabel}]`;
  }
  const foreground = v41Foreground(layouts);
  foreground.push(
    `drawbox=x=0:y=0:w=1080:h=1920:color=0x000000:t=fill:enable='between(t\\,${endCard.start}\\,${endCard.end})'`,
    `drawtext=fontfile=${font}:text='PLAYECONOMY':fontcolor=white:fontsize=58:x=(w-text_w)/2:y=1420:enable='between(t\\,${endCard.start + 0.3}\\,${endCard.end})'`,
    `drawtext=fontfile=${subtitleFont}:text='${escapeFilter(definition.tagline)}':fontcolor=0xBFD7F5:fontsize=30:x=(w-text_w)/2:y=1500:enable='between(t\\,${endCard.start + 0.5}\\,${endCard.end})'`
  );
  const graph = [
    ...mediaFilters,
    `${canvasInput}${foreground.join(",")}[canvas]`,
    "[1:v]scale=52:52,format=rgba[avatar]",
    "[2:v]scale=620:-1,format=rgba[logo]",
    `[canvas][avatar]overlay=72:104:enable='between(t,0,${endCard.start - 0.1})'[with_avatar]`,
    `[with_avatar][logo]overlay=(W-w)/2:760:enable='between(t,${endCard.start},${duration})'[v]`
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

