# Phase 19: Real PPT Regression

## Goal

Add and run a repeatable regression command against a real user PPTX, proving the product can move beyond synthetic smoke tests into real-file intake.

## Added

- `scripts/real-ppt-regression.mjs`
- `npm.cmd run regression:real-ppt`

The command creates a workflow job from a local PPTX file, then advances the existing product APIs:

1. `source/render`
2. Verify `visual/generate` is blocked by codex-ppt approval gates
3. Record regression-only codex-ppt approvals
4. `visual/generate` in passthrough mode for selected pages
5. `image-deck/assemble`
6. `ocr/run`
7. `editable/prepare`
8. `editable/prompts`
7. `editable/worker-tasks/sync`

It intentionally stops at page-worker-ready state. It does not finalize a real deck with the simplified local text worker, because that would create a misleading low-fidelity output for complex visual slides.

## Command

```powershell
npm.cmd run regression:real-ppt -- --source "C:\path\to\deck.pptx" --max-pages 3
```

The command no longer keeps a hard-coded default deck path. Use `--source`,
set `PPT_TOOL_REAL_PPT_SOURCE`, or pass `--latest-download-pptx` only when the
newest `.pptx` in Downloads is intentionally the acceptance deck.

## Current Evidence

Last successful run:

```json
{
  "jobId": "workflow_20260616-100010Z_9c006d",
  "sourceRender": {
    "renderedPages": 15
  },
  "visual": {
    "mode": "passthrough",
    "visualImages": 3,
    "imageDeck": "E:\\PPT工具\\workspace\\jobs\\workflow_20260616-100010Z_9c006d\\image-deck\\real-regression-image-deck.pptx"
  },
  "ocr": {
    "pageCount": 3,
    "textCount": 26,
    "lowConfidenceCount": 0
  },
  "editable": {
    "nextStage": "dispatch_pages",
    "tasks": {
      "total": 3,
      "ready": 3,
      "recorded": 0,
      "failed": 0
    }
  }
}
```

Key artifacts:

- `E:\PPT工具\workspace\jobs\workflow_20260616-100010Z_9c006d\state.json`
- `E:\PPT工具\workspace\jobs\workflow_20260616-100010Z_9c006d\source\source_meta.json`
- `E:\PPT工具\workspace\jobs\workflow_20260616-100010Z_9c006d\image-deck\real-regression-image-deck.pptx`
- `E:\PPT工具\workspace\jobs\workflow_20260616-100010Z_9c006d\ocr\text_hints.json`
- `E:\PPT工具\workspace\jobs\workflow_20260616-100010Z_9c006d\editable-run\editable_run_pointer.json`

## Encoding Note

PowerShell may print UTF-8 JSON without BOM as mojibake. The file content itself is valid UTF-8. A Node check confirmed the first OCR text line stores `本来生活` with correct Unicode code points.

## Current Limit

This regression proves:

- Real PPTX can be copied into workflow state.
- PowerPoint COM rendering works for the user deck.
- Selected pages can become image-based intermediate deck pages.
- RapidOCR works on real pages.
- `editppt` prepare, prompt generation, and worker task queue work for real pages.

It does not yet prove final product-quality editable reconstruction for the real deck. The missing piece remains a real complex page worker that reads each page prompt, separates visual assets, writes `page-rebuild-spec.json`, runs the worker pipeline, records pages, and then finalizes.
