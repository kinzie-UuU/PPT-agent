# Phase 16 - Page Worker Pipeline

## Goal

Provide one strict worker-side command that can be used as the external command
for `page-worker-runner.mjs`.

Before this phase, the worker path had separate commands:

```text
worker:visual-assets
worker:assemble-page
```

This phase adds:

```text
worker:page-pipeline
```

It runs the page worker implementation steps in order after a real page worker
has authored the required specs.

## Command

```text
npm.cmd run worker:page-pipeline
```

With explicit page dir:

```text
npm.cmd run worker:page-pipeline -- --page-dir "%PPT_WORKER_PAGE_DIR%"
```

As the runner external command:

```text
npm.cmd run worker:once -- --job-id <workflow_id> --agent-id <worker_id> --page page_001 --command "npm.cmd run worker:page-pipeline"
```

## Behavior

The pipeline:

1. Uses `PPT_WORKER_PAGE_DIR` or `--page-dir`.
2. Runs `worker:visual-assets` when `visual-asset-jobs.json` exists.
3. Requires `page-rebuild-spec.json`.
4. Runs `worker:assemble-page`.
5. Verifies all required page artifacts exist:
   - `manifest.json`
   - `imagegen-jobs.json`
   - `page.pptx`
   - `preview.png`
   - `split_assets_contact.png`
   - `validation.json`
   - `page_result.json`

If any step fails, the pipeline exits non-zero. `page-worker-runner.mjs` then
does not call complete/record, so failed pages are not accepted.

## Boundary

The pipeline does not author `visual-asset-jobs.json` or `page-rebuild-spec.json`.
Those are still the responsibility of the real page worker that read the prompt,
source image, OCR/text hints, and visual assets.

This keeps the parent workflow from faking page reconstruction while still
making the worker execution path repeatable.

## Frontend

The workflow console now exposes:

- `文本 Runner 命令`: conservative local OCR text worker
- `完整链路 Runner`: strict pipeline for complex pages after specs are authored
- `视觉资产助手`: direct worker-side asset step
- `页面组装器`: direct worker-side assembly step

## Verification

Run:

```text
npm.cmd run check
npm.cmd run build
npm.cmd run audit:entrypoints
node scripts/page-worker-pipeline.mjs --help
```

Smoke tests:

- positive: temporary page dir with `page_request.json`, `source.png`, and
  `page-rebuild-spec.json` should produce all page artifacts.
- negative: temporary page dir without `page-rebuild-spec.json` should exit
  non-zero and must not produce accepted page artifacts.
