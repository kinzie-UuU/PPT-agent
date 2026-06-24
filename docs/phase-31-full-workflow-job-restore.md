# Phase 31: Full Workflow Job Restore

## Conclusion

Created a full 15-page workflow job and added a frontend restore path for existing workflow jobs.

## What Changed

- Ran the real PPT regression workflow for all 15 pages.
- Added `api.workflowJobs()` to load existing workflow jobs.
- Added frontend workflow job state and restore/select logic.
- Added a workflow selector to the rebuild panel so externally-created or previously-created jobs can be resumed in the UI.
- Updated delivery status next actions for the worker-ready state.

## Runtime Evidence

Full workflow job:

- Job id: `workflow_20260618-042438Z_f49f25`
- Source pages rendered: 15
- Visual pages: 15
- Image deck pages: 15
- OCR pages: 15
- Worker prompts: 15
- Worker tasks: 15 ready, 0 recorded, 0 failed

Verified local service:

- `/api/health` returns online with pid `39432`.
- `/api/workflow-jobs` returns `workflow_20260618-042438Z_f49f25` as the latest job.
- `/api/workflow-jobs/workflow_20260618-042438Z_f49f25/delivery-status` returns `working` and next action `启动 page worker 并分发 15 个待重建页面。`
- `/api/workflow-jobs/workflow_20260618-042438Z_f49f25/editable/worker-tasks` returns `total: 15`, `ready: 15`.

Build checks:

- `node --check shared/workflowDeliveryStatus.js`
- `npm.cmd run check`
- `npm.cmd run build`

All passed.

## Remaining Work

- Run page workers for all 15 ready pages.
- Record page worker outputs and mirror review artifacts.
- Finalize the full 15-page editable PPTX.
- Validate final output against source page count and object-level editability.
