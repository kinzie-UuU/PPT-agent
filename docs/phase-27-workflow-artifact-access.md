# Phase 27: Workflow Artifact Access

## Conclusion

The workflow UI can now link to controlled workflow artifacts instead of showing only local filesystem paths.

## What Changed

- Added `server/workflowArtifacts.js`.
- Added `GET /api/workflow-jobs/:id/artifacts`.
- Added `GET /api/workflow-jobs/:id/artifacts/:artifactKey`.
- Added `GET /api/workflow-jobs/:id/artifacts/:artifactKey/:pageId`.
- Added frontend API method `workflowArtifacts(id)`.
- Added delivery summary links for:
  - final editable PPTX
  - validation JSON
  - source meta JSON
  - image-based PPTX

## Safety

Artifact access is whitelist-based. The API resolves only known workflow artifacts and verifies the resolved file path stays inside the workflow job root before sending a file.

## Runtime Verification

Verified on `http://127.0.0.1:4180` after restart:

- `/api/health` returns rootDir `E:\PPT工具`.
- `/api/workflow-jobs/workflow_20260616-100010Z_9c006d/artifacts` returns 22 controlled links.
- `/api/workflow-jobs/workflow_20260616-100010Z_9c006d/artifacts/validation` returns:
  - `passed: true`
  - `expected_pages: 3`
  - `slides: 3`
- `/api/workflow-jobs/workflow_20260616-100010Z_9c006d/artifacts/final-pptx?download=1` returns:
  - status `200`
  - content type `application/vnd.openxmlformats-officedocument.presentationml.presentation`
  - attachment filename `editable-final.pptx`

## Remaining Work

- Build a real Review/Export view using source page, visual page, validation, and final PPT links.
- Add side-by-side source/rebuilt preview for each page.
- Continue full 15-page workflow completion and validation.
