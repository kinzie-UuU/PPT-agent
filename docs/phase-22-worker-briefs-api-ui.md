# Phase 22: Worker Briefs API and UI

## Goal

Expose page worker brief generation through the product backend and 4180 frontend instead of requiring manual CLI-only operation.

This moves the real-page workflow closer to product operation:

1. User reaches `editable/prompts`.
2. Product generates worker briefs from the real job.
3. UI shows brief count and copyable model-worker runner commands.
4. Real worker still owns page artifacts.

## Added

- `server/workflowWorkerBriefs.js`
- `POST /api/workflow-jobs/:id/editable/worker-briefs`
- `GET /api/workflow-jobs/:id/editable/worker-briefs`
- Frontend API helpers:
  - `workflowWorkerBriefs`
  - `buildWorkflowWorkerBriefs`
- Frontend controls in `WorkflowRebuildPanel`:
  - `Build briefs`
  - `Copy briefs cmd`
  - `Copy model runner`
  - `Worker briefs` artifact count

## Verified Real Job

API command:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:4180/api/workflow-jobs/workflow_20260616-100010Z_9c006d/editable/worker-briefs `
  -Method Post `
  -ContentType 'application/json' `
  -Body '{"pages":"page_001,page_002,page_003","agentId":"real-worker-001"}'
```

Result:

```json
{
  "ok": true,
  "jobId": "workflow_20260616-100010Z_9c006d",
  "pageCount": 3
}
```

Generated/registered artifact:

```text
E:\PPT工具\workspace\jobs\workflow_20260616-100010Z_9c006d\worker-briefs
```

The workflow job now has:

```json
{
  "artifacts": {
    "workerBriefs": {
      "pageCount": 3,
      "indexPath": "E:\\PPT工具\\workspace\\jobs\\workflow_20260616-100010Z_9c006d\\worker-briefs\\index.json"
    }
  }
}
```

## Boundary Check

After API generation, the real `editppt` page directories were checked for:

- `manifest.json`
- `page.pptx`
- `preview.png`
- `split_assets_contact.png`
- `page-rebuild-spec.json`

No such page deliverable artifacts were created by the briefs API/UI path.

## Current Limit

The product can now prepare and expose the worker handoff package. The remaining missing proof is still a successful real model-worker execution:

```powershell
npm.cmd run worker:once -- --job-id workflow_20260616-100010Z_9c006d --agent-id real-worker-001 --page page_001 --command "npm.cmd run lab:model-page-pipeline"
```

That requires a working vision-capable external model/API path and must produce a valid `page-rebuild-spec.json`, then pass `worker:page-pipeline`, `record`, and eventually `finalize`.
