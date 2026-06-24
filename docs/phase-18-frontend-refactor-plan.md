# Phase 18: Frontend Refactor Plan

## Conclusion

The current `http://127.0.0.1:4180/` frontend is the active tool workbench. It is useful for development and manual orchestration, but it should not be treated as the final product UI.

Frontend refactor should start after the backend workflow contract is stable:

- Provider configuration is external and testable.
- Source render, visual redraw, OCR, editable prepare, worker queue, record, and finalize are all resumable.
- A real deck can pass at least one end-to-end regression run.

## Target Product Shape

Refactor the UI into a task-centered PPT production console:

1. **Import**
   - Upload PPT/PDF/images.
   - Show source pages, page count, extraction confidence, and missing prerequisites.

2. **Visual Redraw**
   - Choose style direction and provider.
   - Generate one sample page first.
   - After approval, run full visual image deck generation.

3. **Editable Rebuild**
   - Show page worker queue with status: ready, running, recorded, failed.
   - Surface prompt, page directory, retry reason, and last validation result.
   - Keep script commands available only in an advanced drawer.

4. **Review**
   - Compare source image, rebuilt preview, validation report, and editable object summary.
   - Highlight pages that need worker retry or human confirmation.

5. **Export**
   - Show final editable PPTX, validation JSON, and run summary.
   - Keep download/export actions disabled until record/finalize gates are satisfied.

## Refactor Principles

- Replace scattered action buttons with a guided pipeline.
- Keep every long-running step visible and resumable.
- Do not expose API keys in frontend state.
- Put provider health, worker runtime health, and editppt doctor results in one diagnostics panel.
- Separate normal user flow from advanced operator controls.
- Do not hide failures: failed pages must show root cause, artifacts, and retry entry.

## Suggested Implementation Order

1. Extract workflow API client and state hooks from `src/main.jsx`.
2. Split the current workflow panel into route-level components:
   - `WorkflowImport`
   - `WorkflowVisualRedraw`
   - `WorkflowEditableQueue`
   - `WorkflowReview`
   - `WorkflowExport`
3. Add a single workflow timeline/store so progress is not duplicated across panels.
4. Add artifact viewers for source image, visual image, editable preview, and validation JSON.
5. Move runner/script command snippets into an advanced operator drawer.
6. Add product copy pass after the flow is stable.

## Incremental Progress

- Added a guided next-action control above the manual workflow buttons. It reads
  the backend Skill-first runbook, runs automatic steps such as source render,
  image deck assembly, editppt prepare/hints/prompts/finalize, and focuses the
  correct approval or worker panel when human action is required.
- Moved the manual workflow action row into an Advanced operator panel. The
  default workflow surface now emphasizes the guided next action, while direct
  step buttons remain available for recovery and testing.
- Added a compact delivery status badge to the guided next-action area. The
  operator can now see both the next required action and the current final
  delivery gate state without scanning the full delivery report first.
- Extracted the guided next-action decision map into
  `src/workflow/guidedAction.js`, so the runbook-to-UI action contract is no
  longer buried inside `src/main.jsx` and can be tested independently as the
  workflow UI is split into route-level components.
- Added guided action contract cases to `regression:skill-first`, covering
  disabled/no-workflow state, approval focus, sample generation, image-deck
  assembly, page-worker handoff, finalize, and manual review routing.
- Corrected final delivery gate semantics so a workflow with no final PPTX is
  `pending-delivery` instead of `not-deliverable.pptx` / blocked. Added delivery
  gate contract cases for pending, ready, draft, and blocked states.
- Updated the guided delivery badge to prefer backend `finalGate` level/title/label
  over locally derived delivery status, so the primary UI reflects the same
  product-ready/draft/blocked/pending contract as the final delivery API.

## Not Yet Product-Complete

The frontend refactor should wait for these backend/product gates:

- Real user PPT regression, not only synthetic smoke.
- Complex visual page worker path with asset separation verified.
- Provider failure and retry behavior validated.
- Final file download/open check on a real deck.
