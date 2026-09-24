# PlayEconomy video system

## Architecture

- `assets/brand/` holds the official, unchanged PlayEconomy logo and avatar.
- `content/` holds one JSON definition per topic: narration, scenes, captions and timing.
- V2 is the reusable generated-visual renderer. `scripts/video/render-v2.mjs` converts a content definition into an ASS subtitle file, an FFmpeg filter graph, and a vertical MP4 without Drive access.
- `.github/workflows/playeconomy-video-v2.yml` installs free dependencies, runs Edge TTS and uploads the generated MP4.
- `output/` is created only in the GitHub Actions runner and is not committed.

## Visual catalog delivery

- V3.5 maps semantically suitable catalog assets to content scenes.
- V3.6 stores the validated catalog and media in Google Drive, then hydrates an ephemeral runner manifest.
- V4 reads that hydrated catalog, fetches only unique scene-selected media, verifies each SHA-256 and image decode, and passes local paths to V2 through `output/scene-media.json`.
- When `scene-media.json` is present, V4.1 uses the pure `scripts/video/visual-layout.mjs` layer to resolve a deterministic visual family per scene: `media`, `cover_product`, `company_logo`, `data_economy`, or `brand`. It does not select assets or access Drive.
- Google Drive is persistent catalog/media storage. The GitHub runner stores only selected ephemeral media. V2 remains Google-Drive-agnostic.
- `.github/workflows/playeconomy-video-v4.yml` uploads the MP4, scene plan, scene-media manifest, validation reports and `ATTRIBUTION.md`; it does not publish downloaded source media.

## Brand assets

- `assets/brand/playeconomy-logo.png` is the supplied main controller and upward-chart logo.
- `assets/brand/playeconomy-avatar.jpeg` is the supplied circular avatar variation.

The renderer uses the avatar as a small in-video mark and shows the main logo in the closing frame. Do not redraw, replace or rescale the original source assets in the repository.

## V4.1 visual layout

- Legacy V2 invocation without `scene-media.json` retains its generated visual graph, including its existing 23–27 second end card.
- V4.1 scene media uses a dark base, selected image treatment, minimal foreground typography, captions, then branding/end card. Media scenes use controlled fill/crop. V4.4 preserves complete product and company assets as a sharp foreground inside `x=72, y=430, w=936, h=890`, composited over a deterministic blurred and darkened background derived from the same local image.
- The V4.1 renderer writes an ephemeral `output/visual-layout.json` debug plan with family, media treatment, motion, safe zones, branding mode, subtitle mode, and end-card timing. It is derived only from content plus local scene-media references.
- Generic decorative bar charts and the large central dark box are not used in normal V4.1 scenes. Data graphics require explicit structured numeric `scene.data`; otherwise the renderer does not invent values.
- V4.1 captions remain scene-timed. They use a conservative lower safe zone, compact wrapping, and optional electric-blue emphasis only when content explicitly provides `caption_emphasis`.
- For V4.1 media mode, the end card is derived from the content duration and occupies at most the final two seconds. For a 27-second video it runs from 25 to 27 seconds.
- V4.1.1 splits captions into deterministic phrase events using existing caption text and scene duration only. Phrase timing is weighted by word count, has no gaps or overlaps, and does not attempt speech or word-level alignment.
- In normal V4.1.1 scenes, the official logo is used as a small RGBA overlay only when it contains real transparent pixels. Otherwise rendering falls back to the existing avatar mark; source brand files are never altered. End-card branding remains unchanged.
- V4.2 adds ephemeral `visualBeats` to the local visual-layout debug plan. Eligible scenes receive at most two continuous presentations, preferring an existing caption boundary 1.8–3.5 seconds into the scene and otherwise using a deterministic midpoint. When a scene overlaps the end card, its normal beats end at the end-card start. Caption segmentation itself is unchanged.
- V4.2 gives selected local media a conservative establishing and detail/reframe presentation every roughly 2–3 seconds. Each beat trims and re-timestamps its FFmpeg branch, so motion begins when that beat is visible rather than at global render time.
- A local image can fan out through FFmpeg `split` for multiple beats or scenes without another Drive read, download, mapper assignment, or persistent catalog change. `visualBeats` and their media references exist only in runner output.
- V4.4 uses an additional local FFmpeg split only for `cover_product` and `company_logo` media: one branch fills, blurs, darkens, and desaturates the full 1080x1920 background; the other keeps the uncropped asset inside the foreground safe area. Gameplay and contextual media retain their existing fill/crop path. No source media or derived image is persisted.

## Add a topic

1. Copy `content/guitar-hero.json` to a new descriptive name.
2. Change the `id`, Spanish `narration`, and five or more `scenes`. Each scene needs start/end seconds, an eyebrow, three headline lines, a metric and a short caption.
3. Run **PlayEconomy video V2** from the Actions tab and provide the new JSON path in `content_file`.
4. Download the artifact produced by that run.

The current visual motor uses local FFmpeg shapes, charts, typography, captions and the official assets. V4 can add verified local scene images above that generated base while retaining its captions, typography, timing and branding. It makes no media search, no AI visual verification, and no calls to Openverse, Wikimedia, Ollama, paid APIs or paid services during rendering.

## Limits

The V2 visual language remains intentionally local and reliable: it does not include automatic fact checking, music, or social publishing. V4 accepts verified images only; selected video media fails closed until explicit renderer support is added.


