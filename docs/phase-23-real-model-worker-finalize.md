# Phase 23 - Real Model Worker Finalize

Date: 2026-06-18

## Scope

Validated the real `image-to-editable-ppt` worker path on the first three pages of `个性创意定制案例-1.pptx`:

- external vision model page spec generation
- page-level schema normalization
- page artifact assembly
- `editppt run record`
- `editppt run finalize`

## Job

- Job id: `workflow_20260616-100010Z_9c006d`
- Run dir: `C:\Users\Administrator\AppData\Local\Temp\ppt-tool-editable-runs\workflow_20260616-100010Z_9c006d\run`
- Final PPTX: `E:\PPT工具\workspace\jobs\workflow_20260616-100010Z_9c006d\final\editable-final.pptx`
- Final validation: `E:\PPT工具\workspace\jobs\workflow_20260616-100010Z_9c006d\final\editable-validation.json`

## Results

- `page_001`: recorded with external vision spec, 3 editable text boxes, 40 native shapes, validation passed.
- `page_002`: recorded after normalizing model geometry and Chinese punctuation spacing, 13 editable text boxes, 28 native shapes, validation passed.
- `page_003`: recorded after user-approved page-image asset separation for the complex product scene, 12 editable text boxes, 1 image asset, 1 native shape, validation passed.
- Final deck validation passed:
  - expected pages: 3
  - slides: 3
  - failed page validations: none
  - page contract violations: none
  - missing parts: none

Independent package check:

- `editable-final.pptx` exists.
- size: `992959` bytes.
- slide XML count: `3`.
- media count: `1`.
- slide relationship files: `3`.

## Implementation Notes

Added model-worker hardening:

- `--no-image` fallback mode for text/OCR-only spec generation.
- `--timeout-ms`, `--max-retries`, and `--max-tokens` overrides.
- `--from-response` recovery mode to normalize an already captured model response without another model call.
- Live text probe and real-image vision probe in `model-page-worker-preflight`.
- Shape normalization for common model output variants:
  - nested line endpoints
  - `line_group`
  - `rect_group`
  - `freeform`
  - `polyline`
  - `roundRect.radius_px`
- Windows preview font mapping.
- Chinese punctuation/currency spacing normalization.
- User-approved rasterization provenance normalization for explicitly approved page-image assets.

## Known Risk

`page_003` uses a user-approved raster asset for the complex product scene because the image edit backend repeatedly failed with `IncompleteRead`. This preserves visual fidelity and keeps right-side text editable, but it is not the same as a fully decomposed object-level rebuild of every product/package illustration.
