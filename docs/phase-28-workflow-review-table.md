# Phase 28: Workflow Review Table

## Conclusion

The workflow panel now includes a page-level review table.

## What Changed

- Added `WorkflowArtifactReviewPanel` to the frontend workflow panel.
- The review table is built from the controlled artifact links API.
- Each page row shows:
  - page id
  - source rendered page link
  - visual page link when available
  - whether the page can enter visual/rebuild review or still needs processing

## Runtime Evidence

Verified current real regression job:

- artifact links total: `22`
- rendered source pages: `15`
- visual pages: `3`
- final PPTX links: `1`
- validation links: `1`
- image deck links: `1`
- delivery status: `warning`
- delivery summary: editable PPTX covers `3/15` pages

## Why This Matters

The frontend can now show partial workflow coverage at the page level, not just at the job level. This makes it visible which pages still need visual image generation and editable rebuilding.

## Remaining Work

- Add side-by-side source/visual/preview panes for selected pages.
- Add rebuilt editable preview links for each recorded page.
- Continue full 15-page workflow completion and validation.
