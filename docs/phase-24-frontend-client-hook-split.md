# Phase 24: Frontend Client And Workflow Hook Split

## Conclusion

The first frontend refactor slice is complete.

The current `http://127.0.0.1:4180/` UI is still the active internal workbench, but the workflow code is no longer fully locked inside `src/main.jsx`.

## What Changed

- Extracted all frontend HTTP calls into `src/api/client.js`.
- Kept the existing API method names and request paths unchanged.
- Extracted workflow worker console state into `src/workflow/useWorkflowWorkerConsole.js`.
- Left the existing `WorkflowRebuildPanel` JSX and user flow intact.

## Why This Matters

This is the first productization step from the Phase 18 plan:

1. API behavior now has a single client boundary.
2. Worker prompt/task/brief state now has a dedicated hook.
3. Future component splits can move UI without also untangling request logic.

## Verified

- `npm.cmd run check`
- `npm.cmd run build`

Both passed.

## Remaining Frontend Refactor Work

- Split `WorkflowRebuildPanel` into product-level workflow sections:
  - Import
  - Visual Redraw
  - Editable Queue
  - Review
  - Export
- Move runner commands into an advanced operator drawer.
- Add artifact preview panes for source image, visual image, rebuilt preview, and validation JSON.
- Add a production readiness summary that distinguishes:
  - 3-page verified regression
  - full-deck not yet verified
  - user-approved raster fallback pages
  - provider failures and retries

## Product Caveat

The frontend refactor has started, but the product is not complete yet. Current verified real output covers the 3-page regression job, not the full 15-page source deck.
