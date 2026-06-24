# Phase 17: Workflow E2E Smoke

## Goal

Add a repeatable end-to-end smoke check for the product workflow:

1. Workflow job exists.
2. A visual page is available.
3. `editppt prepare` creates a resumable run.
4. Worker prompts and queue tasks are created.
5. `page-worker-runner.mjs` claims a real task.
6. An external worker command authors `page-rebuild-spec.json`.
7. `page-worker-pipeline.mjs` creates page artifacts.
8. Runner completion records the page through `editppt run record`.
9. `editppt run finalize` produces the final editable PPTX.
10. Delivery and compliance APIs report complete page/final evidence.
11. If the delivery gate is blocked, the only allowed reason is the missing
    `codex-ppt` half of the full product path.

## Added

- `scripts/smoke-workflow-e2e.mjs`
- `npm.cmd run smoke:workflow-e2e`

The smoke uses a synthetic one-page visual image so it can validate the workflow contract without external model calls. The synthetic worker mode writes only `page-rebuild-spec.json`, then delegates artifact creation to the existing worker pipeline. Page artifacts still come from worker-side commands and are recorded through the normal API. After finalize, the smoke also checks `delivery-status` and `compliance` so page-worker evidence and finalize evidence cannot silently regress. It is allowed to remain blocked on `codex-ppt` evidence because this smoke intentionally covers only the `image-to-editable-ppt` half of the product path.

## Command

```powershell
npm.cmd run smoke:workflow-e2e -- --base-url http://127.0.0.1:4180
```

## Current Evidence

Last successful run:

```json
{
  "jobId": "workflow_20260616-095413Z_0a821c",
  "finalPath": "E:\\PPT工具\\workspace\\jobs\\workflow_20260616-095413Z_0a821c\\final\\editable-final.pptx",
  "editable": true,
  "taskSummary": {
    "total": 1,
    "recorded": 1,
    "failed": 0
  }
}
```

## Limits

This smoke proves the orchestrated product contract, not real-world visual fidelity. A real deck still needs:

- OCR/text hints from source pages.
- Model-backed visual redraw.
- Complex page worker reasoning for charts, icons, photos, screenshots, and dense layouts.
- Human or automated visual QA against the original deck.
