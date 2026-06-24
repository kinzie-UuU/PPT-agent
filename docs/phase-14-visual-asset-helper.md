# Phase 14 - Visual Asset Helper

## Goal

Move complex visual pages closer to the real `image-to-editable-ppt` contract.

The previous local worker is intentionally conservative and text-oriented. It
does not separate foreground photos, icons, screenshots, badges, hand-drawn
marks, or complex background clean bases. This phase adds a worker-side helper
for that missing middle step:

```text
visual-asset-jobs.json -> editppt image batch -> image import -> process-sheet
```

The helper does not mark a page complete. A real page worker still owns
`manifest.json`, `page.pptx`, `preview.png`, `split_assets_contact.png`,
`validation.json`, and `page_result.json`.

## Script

```text
scripts/visual-asset-helper.mjs
npm.cmd run worker:visual-assets
```

Default worker-side usage:

```text
npm.cmd run worker:visual-assets -- --page-dir "%PPT_WORKER_PAGE_DIR%" --spec "%PPT_WORKER_PAGE_DIR%\visual-asset-jobs.json"
```

Dry-run validation:

```text
npm.cmd run worker:visual-assets -- --page-dir "<page_dir>" --spec "<page_dir>\visual-asset-jobs.json" --dry-run
```

## Spec Shape

The page worker writes `visual-asset-jobs.json` inside its page directory:

```json
{
  "concurrency": 2,
  "jobs": [
    {
      "id": "icon_sheet",
      "type": "edit",
      "image": "source.png",
      "role": "asset_sheet",
      "prompt": "Extract every foreground icon from the source into a magenta chroma-key sheet. Preserve source colors, strokes, proportions, and shadows. No readable text.",
      "out": "icon_sheet.png",
      "dest": "assets/icon_sheet.png",
      "processSheet": {
        "assetsDir": "assets/icons",
        "assetNames": ["icon_1", "icon_2"],
        "splitManifest": "assets/icons/split_manifest.json"
      }
    }
  ]
}
```

Supported job behaviors:

- no `image` or `images`: call image generation
- `image` or `images`: call image edit
- `dest`: import selected output into the page directory
- `processSheet`: run deterministic chroma-key/split processing

## Frontend

The workflow worker console now shows a separate `视觉资产助手` command for the
selected page. It is deliberately separate from `Runner 命令` because this helper
is only one step inside a real page worker; it does not produce final page
artifacts and must not trigger `record` by itself.

## Verification

Run:

```text
npm.cmd run check
npm.cmd run build
npm.cmd run audit:entrypoints
node scripts/visual-asset-helper.mjs --help
```

Use `--dry-run` with a temporary page dir to validate spec generation without
calling the image backend.
