import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { inflateSync } from "node:zlib";
import { visualDebugPlan, wrapCaptionLines } from "./visual-layout.mjs";

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

function captionText(value, scene, v41) {
  const caption = v41 ? wrapCaptionLines(value) : value;
  const emphasis = scene.caption_emphasis;
  if (v41 && typeof emphasis === "string" && emphasis && caption.includes(emphasis)) {
    const [before, after] = caption.split(emphasis, 2);
    return `${escapeAss(before)}{\\c&HFF6B00&}${escapeAss(emphasis)}{\\c&HFFFFFF&}${escapeAss(after ?? "")}`;
  }
  return escapeAss(caption);
}

function paeth(left, up, upperLeft) {
  const prediction = left + up - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  return leftDistance <= upDistance && leftDistance <= upperLeftDistance ? left : upDistance <= upperLeftDistance ? up : upperLeft;
}

function hasTransparentPngPixels(path) {
  try {
    const file = readFileSync(path);
    if (file.toString("hex", 0, 8) !== "89504e470d0a1a0a") return false;
    let offset = 8;
    let width;
    let height;
    let bitDepth;
    let colorType;
    let interlace;
    const idat = [];
    while (offset < file.length) {
      const length = file.readUInt32BE(offset);
      const type = file.toString("ascii", offset + 4, offset + 8);
      const data = file.subarray(offset + 8, offset + 8 + length);
      if (type === "IHDR") {
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        bitDepth = data[8];
        colorType = data[9];
        interlace = data[12];
      }
      if (type === "IDAT") idat.push(data);
      offset += length + 12;
    }
    if (bitDepth !== 8 || colorType !== 6 || interlace !== 0 || !width || !height) return false;
    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * 4;
    const previous = Buffer.alloc(stride);
    let cursor = 0;
    for (let y = 0; y < height; y += 1) {
      const filter = raw[cursor++];
      const row = Buffer.alloc(stride);
      for (let x = 0; x < stride; x += 1) {
        const value = raw[cursor++];
        const left = x >= 4 ? row[x - 4] : 0;
        const up = previous[x];
        const upperLeft = x >= 4 ? previous[x - 4] : 0;
        row[x] = filter === 1 ? (value + left) & 255
          : filter === 2 ? (value + up) & 255
            : filter === 3 ? (value + Math.floor((left + up) / 2)) & 255
              : filter === 4 ? (value + paeth(left, up, upperLeft)) & 255
                : value;
      }
      for (let x = 3; x < stride; x += 4) if (row[x] < 255) return true;
      row.copy(previous);
    }
  } catch {
    return false;
  }
  return false;
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
    "drawbox=x=0:y=0:w=1080:h=8:color=0x006BFF:t=fill"
  ];
  for (const [index, scene] of definition.scenes.entries()) {
    const layout = layouts[index];
    const enabled = `between(t\\,${scene.start}\\,${scene.end})`;
    const textEnabled = `between(t\\,${scene.start + 0.2}\\,${scene.end - 0.2})`;
    const headlineBeats = layout.visualBeats.filter((beat) => beat.headlineState === "visible");
    draw.push(
      `drawbox=x=72:y=238:w=96:h=8:color=0x006BFF:t=fill:enable='${enabled}'`,
      `drawtext=fontfile=${font}:text='${escapeFilter(scene.eyebrow)}':fontcolor=0xBFD7F5:fontsize=30:x=72:y=275:enable='${textEnabled}'`
    );
    if (["media", "cover_product"].includes(layout.family) && layout.hasMedia) {
      for (const beat of headlineBeats) {
        const headlineEnd = Math.min(beat.end - 0.1, scene.end - 0.2);
        draw.push(`drawtext=fontfile=${font}:text='${escapeFilter(layout.title)}':fontcolor=white:fontsize=64:x=72:y=330:enable='between(t\\,${beat.start + 0.2}\\,${headlineEnd})'`);
      }
    } else if (layout.companyFallback) {
      const nameBeat = layout.visualBeats.find((beat) => beat.headlineState === "company_name");
      const supportingBeat = layout.visualBeats.find((beat) => beat.headlineState === "supporting_message");
      if (nameBeat) draw.push(`drawtext=fontfile=${font}:text='${escapeFilter(layout.title)}':fontcolor=white:fontsize=92:x=72:y=560:enable='between(t\\,${nameBeat.start + 0.2}\\,${nameBeat.end - 0.1})'`);
      if (supportingBeat) draw.push(`drawtext=fontfile=${subtitleFont}:text='${escapeFilter(scene.headline.slice(1).join(" "))}':fontcolor=0xD7E7FF:fontsize=42:x=72:y=680:enable='between(t\\,${supportingBeat.start + 0.1}\\,${supportingBeat.end - 0.2})'`);
    } else {
      draw.push(`drawtext=fontfile=${font}:text='${escapeFilter(layout.title)}':fontcolor=white:fontsize=${layout.family === "company_logo" ? 92 : 64}:x=72:y=${layout.family === "company_logo" ? 560 : 330}:enable='${textEnabled}'`);
    }
    if (layout.dataEnabled && typeof scene.data?.value === "number") {
      draw.push(`drawtext=fontfile=${font}:text='${escapeFilter(String(scene.data.value))}':fontcolor=0x006BFF:fontsize=96:x=72:y=760:enable='${textEnabled}'`);
    }
  }
  draw.push(`subtitles=${resolve(outputDir, "captions.ass").replaceAll("\\", "/")}:fontsdir=/usr/share/fonts/truetype/dejavu`);
  return draw;
}

function mediaTransform(layout, beat) {
  if (beat.presentation === "cover_detail") {
    return "scale=1020:1320:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0x07121F";
  }
  if (beat.presentation === "media_reframe_x") {
    return "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:(iw-ow)*0.72:(ih-oh)*0.5";
  }
  if (beat.presentation === "media_reframe_y") {
    return "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:(iw-ow)*0.5:(ih-oh)*0.7";
  }
  return "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920";
}

function mediaFilter(inputLabel, label, layout, beat) {
  if (layout.mediaTreatment === "derived_background_contain") {
    return [
      `${inputLabel}trim=start=${beat.start}:end=${beat.end},setpts=PTS-STARTPTS,split=2[${label}_bg_source][${label}_fg_source]`,
      `[${label}_bg_source]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=12:1,eq=brightness=-0.18:saturation=0.70[${label}_background]`,
      `[${label}_fg_source]scale=936:890:force_original_aspect_ratio=decrease[${label}_foreground]`,
      `[${label}_background][${label}_foreground]overlay=(W-w)/2:430+(890-h)/2,setsar=1,setpts=PTS+${beat.start}/TB[${label}]`
    ].join(";");
  }
  const increment = layout.family === "cover_product" ? "0.00015" : "0.00025";
  return `${inputLabel}trim=start=${beat.start}:end=${beat.end},setpts=PTS-STARTPTS,${mediaTransform(layout, beat)},zoompan=z='min(zoom+${increment},${beat.motion.zoomEnd})':d=1:s=1080x1920:fps=30,setsar=1,setpts=PTS+${beat.start}/TB[${label}]`;
}

function prepare() {
  const sceneMedia = sceneMediaInputs();
  const hasSceneMedia = sceneMedia.assets.length > 0;
  const sceneAssets = new Map(definition.scenes.map((scene) => [
    scene.scene_id,
    sceneMedia.scenes.has(scene.scene_id) ? { asset_id: sceneMedia.scenes.get(scene.scene_id) } : null
  ]));
  const transparentLogoAvailable = hasSceneMedia && hasTransparentPngPixels(logoPath);
  const layouts = hasSceneMedia ? visualDebugPlan({ scenes: definition.scenes, sceneAssets, duration, transparentLogoAvailable }) : [];
  writeFileSync(resolve(outputDir, "narration.txt"), `${definition.narration}\n`, "utf8");
  const assLines = captionLines(hasSceneMedia);
  for (const [index, scene] of definition.scenes.entries()) {
    const segments = hasSceneMedia ? layouts[index].captionSegments : [{ text: scene.caption, start: scene.start + 0.2, end: scene.end - 0.2 }];
    for (const segment of segments) {
      assLines.push(`Dialogue: 0,${assTimestamp(segment.start)},${assTimestamp(segment.end)},Caption,,0,0,0,,${captionText(segment.text, scene, hasSceneMedia)}`);
    }
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

  writeFileSync(resolve(outputDir, "visual-layout.json"), `${JSON.stringify({ version: "4.1.1", transparent_logo_available: transparentLogoAvailable, scenes: layouts }, null, 2)}\n`, "utf8");

  const endCard = layouts[0].endCard;
  const normalBranding = layouts[0].normalBranding;
  const mediaFilters = ["[0:v]drawbox=x=0:y=0:w=1080:h=1920:color=0x07121F:t=fill[scene_media_base]"];
  const mediaUses = [];
  for (const [sceneIndex, scene] of definition.scenes.entries()) {
    const assetId = sceneMedia.scenes.get(scene.scene_id);
    if (!assetId) continue;
    for (const [beatIndex, beat] of layouts[sceneIndex].visualBeats.entries()) {
      mediaUses.push({ assetId, sceneIndex, scene, beatIndex, beat, layout: layouts[sceneIndex] });
    }
  }
  const usesByAsset = new Map();
  for (const use of mediaUses) {
    const uses = usesByAsset.get(use.assetId) ?? [];
    uses.push(use);
    usesByAsset.set(use.assetId, uses);
  }
  for (const [assetIndex, asset] of sceneMedia.assets.entries()) {
    const uses = usesByAsset.get(asset.asset_id) ?? [];
    if (uses.length <= 1) {
      if (uses.length === 1) uses[0].inputLabel = `[${3 + assetIndex}:v]`;
      continue;
    }
    const labels = uses.map((_, useIndex) => `[asset_media_${assetIndex}_${useIndex}]`);
    mediaFilters.push(`[${3 + assetIndex}:v]split=${uses.length}${labels.join("")}`);
    uses.forEach((use, useIndex) => {
      use.inputLabel = labels[useIndex];
    });
  }
  let canvasInput = "[scene_media_base]";
  for (const use of mediaUses) {
    const mediaLabel = `scene_media_${use.sceneIndex}_${use.beatIndex}`;
    const compositeLabel = `scene_canvas_${use.sceneIndex}_${use.beatIndex}`;
    mediaFilters.push(
      mediaFilter(use.inputLabel, mediaLabel, use.layout, use.beat),
      `${canvasInput}[${mediaLabel}]overlay=0:0:enable='between(t\\,${use.beat.start}\\,${use.beat.end})'[${compositeLabel}]`
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
    normalBranding.mode === "transparent_logo"
      ? `[2:v]scale=${normalBranding.width}:-1,format=rgba[normal_brand]`
      : `[1:v]scale=${normalBranding.width}:${normalBranding.width},format=rgba[normal_brand]`,
    "[2:v]scale=620:-1,format=rgba[logo]",
    `[canvas][normal_brand]overlay=${normalBranding.x}:${normalBranding.y}:enable='between(t,0,${endCard.start - 0.1})'[with_brand]`,
    `[with_brand][logo]overlay=(W-w)/2:760:enable='between(t,${endCard.start},${duration})'[v]`
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


