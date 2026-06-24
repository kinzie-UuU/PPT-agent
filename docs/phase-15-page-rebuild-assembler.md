# Phase 15 - Page Rebuild Assembler

## Goal

Add a worker-side bridge from a real page worker's reconstruction decisions to
the deterministic `editppt` page build/validation commands.

The previous phase added `worker:visual-assets` for image edit/import/sheet
processing. This phase adds the next worker-side step:

```text
page-rebuild-spec.json -> manifest.json -> page.pptx + preview.png + validation.json
```

This is still a page worker responsibility. The parent workflow only copies the
command and later calls record after the worker has finished.

## Script

```text
scripts/page-rebuild-assembler.mjs
npm.cmd run worker:assemble-page
```

Usage inside the worker:

```text
npm.cmd run worker:assemble-page -- --page-dir "%PPT_WORKER_PAGE_DIR%" --spec "%PPT_WORKER_PAGE_DIR%\page-rebuild-spec.json"
```

## Spec Contract

The real page worker authors `page-rebuild-spec.json` after inspecting
`source.png`, `page_request.json`, OCR/text hints, and any separated visual
assets.

The spec supplies:

- `text_inventory`
- `visual_inventory`
- `background_strategy`
- `quality_checks`
- `text_boxes`
- `shapes`
- `images`
- `asset_provenance`
- optional `formula_inventory`

The assembler copies `slide`, `content_box`, and source pixel dimensions from
`page_request.json`, so the worker cannot accidentally stretch the source page.

## Guardrails

The assembler rejects:

- using `source.png` directly as an image layer
- missing `box_px` for text, images, and non-line shapes
- missing `points_px` for line shapes
- `roundRect` without `source_corner_radius_px`
- images without matching `asset_provenance`
- invalid `asset_provenance.source_type`
- missing provenance source files
- forbidden fallback wording such as crop, approximation, fallback, emoji, 裁剪, 近似, 降级
- foreground inventory/provenance that names icons/photos/logos/screenshots/badges without stating asset-sheet separation or image edit

If a guardrail fails, the assembler writes `validation.json` with top-level
`passed: false` and exits non-zero, so `editppt run record` will not accept the
page.

## Frontend

The workflow console now shows three worker-side commands for the selected page:

- `Runner 命令`: executes a worker command and records the page after success
- `视觉资产助手`: runs image edit/import/process-sheet from `visual-asset-jobs.json`
- `页面组装器`: builds and validates the page from `page-rebuild-spec.json`

## Verification

Run:

```text
npm.cmd run check
npm.cmd run build
npm.cmd run audit:entrypoints
node scripts/page-rebuild-assembler.mjs --help
```

Smoke test with a temporary page directory that includes `source.png`,
`page_request.json`, and a minimal native-shape/text `page-rebuild-spec.json`.
