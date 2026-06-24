# Phase 26: Workflow Delivery Status API

## Conclusion

Delivery readiness is now available through a backend API instead of being only a frontend inference.

## What Changed

- Added `shared/workflowDeliveryStatus.js` for reusable delivery status derivation.
- Updated `src/workflow/deliveryStatus.js` to re-export the shared evaluator.
- Added `server/workflowDelivery.js`.
- Added `GET /api/workflow-jobs/:id/delivery-status`.
- Added `api.workflowDeliveryStatus(id)` in the frontend client.
- Updated `WorkflowRebuildPanel` to prefer backend delivery status while keeping local fallback.
- Displayed parsed validation fields in the frontend when available:
  - `passed`
  - `expected_pages`
  - `slides`
  - `missing_parts`

## Why This Matters

The frontend can now show delivery readiness from actual workflow files:

- `source/source_meta.json`
- `final/editable-validation.json`
- `artifacts.editableFinal.pptxEditability`
- worker task retry/fallback records

This reduces the risk of the UI claiming a deck is complete based only on artifact presence.

## Real Job Result

The current real regression job is correctly classified as:

- level: `warning`
- title: `部分可交付`
- summary: generated editable PPTX covers `3/15` pages

## Runtime Verification

- Restarted the local server on `http://127.0.0.1:4180`.
- Verified `/api/health` after restart.
- Verified `/api/workflow-jobs/workflow_20260616-100010Z_9c006d/delivery-status` returns:
  - level: `warning`
  - sourcePages: `15`
  - finalPages: `3`
  - validationPassed: `true`

## Remaining Work

- Add a Review page that renders this API response with source/preview/validation viewers.
- Continue full 15-page workflow execution and validation.
