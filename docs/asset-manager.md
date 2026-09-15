# PlayEconomy Asset Manager V3

## Purpose and boundaries

V3 is a library-building layer, not a dependency of the V2 renderer. It receives a content definition, finds licensed candidates, records a report and leaves V2 free to render its local editorial fallback whenever external media is absent or unavailable.

The persistent master library stays in the existing Google Drive structure. V3 targets `02_Biblioteca Visual` and its existing categories: `Empresas`, `Franquicias`, `Consolas`, `Gameplay`, `Personajes`, `Mapas`, `Arte Oficial`, `Concept Art`, `Tecnología`, and `Gráficos PLAYECONOMY`. It never reorganizes Drive.

## Modules

- `scripts/assets/asset-manager.mjs`: bounded orchestration, query extraction, reporting and fallback.
- `scripts/assets/openverse.mjs`: Openverse API adapter. It requests commercial-use search results and preserves returned attribution and license metadata.
- `scripts/assets/wikimedia.mjs`: Wikimedia Commons MediaWiki API adapter. It uses the documented API, not HTML scraping, and captures `extmetadata` license, artist and credit fields.
- `scripts/assets/catalog.mjs`: manifest records, normalized source URLs, exact checksum hooks, license allowlist and deterministic scoring.
- `scripts/assets/drive.mjs`: fixed Drive destination mapping and an intentionally disabled upload boundary.
- `asset-manager/manifest.json`: the central catalog. `manifest.schema.json` documents each record.

## Licenses, score and duplicates

Candidates require source, author/attribution data and an allowlisted reusable license before they can be proposed. The initial allowlist accepts CC0, public-domain/PDM, CC-BY and CC-BY-SA material. Unknown, NC, ND and all-rights-reserved metadata are rejected instead of being approved by assumption.

The score combines query-term relevance, supported image type, resolution, portrait friendliness or crop/pan eligibility, and license quality. The default minimum is 38. URL dedupe removes trackers/fragments before comparing a candidate against `normalized_source_url`; a SHA-256 checksum field is reserved for actual downloaded files. A future perceptual-hash stage can be added without changing the manifest.

## V3.1 selection audit

Every searched candidate is retained in `rejected_candidates` or `proposed_downloads` in `asset-manager/reports/latest.json`. Rejections include structured reasons such as `license_unknown`, `license_not_allowed`, `insufficient_resolution`, `unsupported_mime`, `missing_metadata`, `invalid_url`, `duplicate`, and `diversity_limit`, while `rejection_summary` exposes provider totals.

Openverse license short codes are normalized before filtering: `by` becomes `CC BY`, `by-sa` becomes `CC BY-SA`, `cc0` stays `CC0`, and `pdm` becomes `Public Domain`. The allowlist remains conservative and still rejects unknown, NC and ND licenses.

Queries carry `query`, `intent`, `target_category` and `target_entity`. Classification is determined from candidate metadata: gameplay needs both franchise relevance and gameplay evidence, so a generic electric guitar remains `contextual_broll` instead of becoming `gameplay`. Candidate records expose `asset_role`, confidence, quality tier, a relevance/resolution/license/orientation/specificity score breakdown, total score and reasons. Quality tiers are `high_quality`, `usable`, `low_resolution` and `reject`; dimensions under 500px or 500,000 pixels receive a strong penalty.

The dry run limits each query/role/category combination to two proposed assets, preserving lightweight visual diversity without relaxing licensing or relevance filters. `scripts/assets/catalog.test.mjs` covers franchise-specific classification, generic contextual guitar classification, low-resolution penalties and unknown-license rejection.

## V3.1.1 destination and metadata audit

`resolveAssetDestination` is the single destination mapping. It resolves an asset role after classification, not the query intent: franchise-specific assets go to their franchise category, while contextual b-roll such as generic guitars or DJ Hero turntables goes to `Tecnología/` without inheriting the Guitar Hero topic folder.

Critical metadata is `source`, `source_url`, `title`, and `license`. Missing critical fields reject a candidate with `missing_fields`. `creator`, `license_url`, and attribution are optional and appear as `metadata_warnings` where appropriate. Verifiable Public Domain material may therefore retain `license_url: null` and `creator: null` without an automatic `missing_metadata` rejection.

High-quality images receive a larger resolution advantage than usable images so portrait orientation cannot offset a materially lower resolution. The existing low-resolution and reject thresholds remain unchanged.

## Limits and failures

`asset-manager/config.json` caps queries (8), results per query (4), downloads (5), retries (2), per-request timeout (10 seconds), global work (4 minutes), and file size (15 MB). 429 and 5xx replies receive at most two exponential-backoff retries. Any provider error is logged and the other provider continues. There are no unbounded loops.

The workflow first runs with `dry_run=true`. It may perform small metadata searches, but it downloads no assets, writes no Drive files and does not alter the manifest. When no acceptable candidate exists, its report declares `fallback: editorial_v2`.

## Google Drive authentication

The recommended $0 production design is Google Cloud Workload Identity Federation for GitHub Actions OIDC. It avoids a long-lived JSON key in the repository. Configure a restricted Google service account with access only to the existing Drive library, then create GitHub configuration for the workload identity provider and service-account email. Do not store their values in Git.

If keyless federation is not yet available, the fallback is a service-account JSON stored only as the GitHub Actions secret `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON`. This is less preferable because it is a long-lived credential. The current V3 workflow deliberately does not request either value and `drive.mjs` refuses uploads until a later, explicit integration step.

## Run a dry run

From **Actions**, choose **PlayEconomy Asset Manager**, keep `content/guitar-hero.json`, leave `dry_run` enabled, and run it. Download `playeconomy-asset-manager-dry-run-report` to inspect `asset-manager/reports/latest.json`. The report lists provider candidates, accepted/rejected counts, duplicates, proposed Drive paths, errors and the fallback state.

## Later real downloads and renderer V3

Before enabling real downloads, implement a reviewed download-and-checksum stage, configure Drive OIDC, grant the narrow Drive folder permission, and add an explicit upload flag separate from the video renderer. Renderer V3 can then select only `approved` reusable manifest records. Until then, V2 remains unchanged and fully functional.
