# PlayEconomy video system V2

## Architecture

- `assets/brand/` holds the official, unchanged PlayEconomy logo and avatar.
- `content/` holds one JSON definition per topic: narration, scenes, captions and timing.
- `scripts/video/render-v2.mjs` is the reusable local renderer. It converts a content definition into an ASS subtitle file, an FFmpeg filter graph, and a vertical MP4.
- `.github/workflows/playeconomy-video-v2.yml` installs free dependencies, runs Edge TTS and uploads the generated MP4.
- `output/` is created only in the GitHub Actions runner and is not committed.

## Brand assets

- `assets/brand/playeconomy-logo.png` is the supplied main controller and upward-chart logo.
- `assets/brand/playeconomy-avatar.jpeg` is the supplied circular avatar variation.

The renderer uses the avatar as a small in-video mark and shows the main logo in the closing frame. Do not redraw, replace or rescale the original source assets in the repository.

## Add a topic

1. Copy `content/guitar-hero.json` to a new descriptive name.
2. Change the `id`, Spanish `narration`, and five or more `scenes`. Each scene needs start/end seconds, an eyebrow, three headline lines, a metric and a short caption.
3. Run **PlayEconomy video V2** from the Actions tab and provide the new JSON path in `content_file`.
4. Download the artifact produced by that run.

The current visual motor uses local FFmpeg shapes, charts, typography, captions and the official assets. It makes no media search, no AI visual verification, and no calls to Openverse, Wikimedia, Ollama, paid APIs or paid services.

## Limits

The V2 visual language is intentionally local and reliable: it does not include licensed gameplay footage, automatic fact checking, music, or social publishing. Future V3 work can add an approved local media library and richer transition templates while keeping the content schema and the zero-cost rendering path.
