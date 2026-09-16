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
- Google Drive is persistent catalog/media storage. The GitHub runner stores only selected ephemeral media. V2 remains Google-Drive-agnostic.
- `.github/workflows/playeconomy-video-v4.yml` uploads the MP4, scene plan, scene-media manifest, validation reports and `ATTRIBUTION.md`; it does not publish downloaded source media.

## Brand assets

- `assets/brand/playeconomy-logo.png` is the supplied main controller and upward-chart logo.
- `assets/brand/playeconomy-avatar.jpeg` is the supplied circular avatar variation.

The renderer uses the avatar as a small in-video mark and shows the main logo in the closing frame. Do not redraw, replace or rescale the original source assets in the repository.

## Add a topic

1. Copy `content/guitar-hero.json` to a new descriptive name.
2. Change the `id`, Spanish `narration`, and five or more `scenes`. Each scene needs start/end seconds, an eyebrow, three headline lines, a metric and a short caption.
3. Run **PlayEconomy video V2** from the Actions tab and provide the new JSON path in `content_file`.
4. Download the artifact produced by that run.

The current visual motor uses local FFmpeg shapes, charts, typography, captions and the official assets. V4 can add verified local scene images above that generated base while retaining its captions, typography, timing and branding. It makes no media search, no AI visual verification, and no calls to Openverse, Wikimedia, Ollama, paid APIs or paid services during rendering.

## Limits

The V2 visual language remains intentionally local and reliable: it does not include automatic fact checking, music, or social publishing. V4 accepts verified images only; selected video media fails closed until explicit renderer support is added.

