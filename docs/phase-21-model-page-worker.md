# Phase 21: Model Page Worker

## Goal

Add a worker-side command that can use an external OpenAI-compatible vision model to author `page-rebuild-spec.json` from a real page source image and worker brief.

This is the first product bridge from "page worker handoff package exists" to "a worker process can author the page rebuild spec."

## Added

- `scripts/model-page-spec-worker.mjs`
- `scripts/model-page-worker-pipeline.mjs`
- `npm.cmd run lab:model-page-spec`
- `npm.cmd run lab:model-page-pipeline`

## Intended Runner Command

```powershell
npm.cmd run worker:once -- --job-id <workflow_id> --agent-id <worker_id> --page page_001 --command "npm.cmd run lab:model-page-pipeline"
```

The runner still owns claim/heartbeat/complete/record. The model worker runs as the external worker command.

## Worker Boundary

The model worker is worker-side, not parent-side:

- It reads `source.png`, `page_request.json`, and optional `worker-brief.json`.
- It writes `model-page-spec-prompt.json` for audit.
- It writes `page-rebuild-spec.json` only after a model returns valid JSON.
- It does not write `manifest.json`, `page.pptx`, `preview.png`, `split_assets_contact.png`, or a passing `validation.json`.
- `lab:model-page-pipeline` delegates artifact creation to the existing `worker:page-pipeline`.

On failure, it writes:

- `validation.json` with top-level `passed: false`
- `page_result.json` pointing at the failure report

It does not fabricate successful artifacts.

## Dry-Run Evidence

Command:

```powershell
npm.cmd run lab:model-page-spec -- --page-dir "C:\Users\Administrator\AppData\Local\Temp\ppt-tool-editable-runs\workflow_20260616-100010Z_9c006d\run\pages\page_001" --job-id workflow_20260616-100010Z_9c006d --page page_001 --workflow-root "E:\PPT工具\workspace\jobs" --dry-run
```

Result:

- wrote `model-page-spec-prompt.json`
- did not call the network
- did not create `page-rebuild-spec.json`
- did not create page deliverable artifacts

## Failure Boundary Evidence

A copied temp page was used:

```text
E:\PPT工具\workspace\tmp-model-worker-no-api-page
```

With unavailable API/network, the worker exited non-zero and wrote:

```json
{
  "passed": false,
  "status": "failed",
  "reason": "fetch failed"
}
```

It did not create:

- `manifest.json`
- `page.pptx`
- `preview.png`
- `split_assets_contact.png`
- `page-rebuild-spec.json`

## Current Limit

The command path is implemented and validated offline, but a real successful model call has not been proven in this environment. Completion still requires:

1. Configure a vision-capable external model.
2. Run `lab:model-page-pipeline` through `worker:once` on a real page.
3. Confirm it writes a valid `page-rebuild-spec.json`.
4. Confirm `worker:page-pipeline` builds and validates page artifacts.
5. Confirm runner records the page.
6. Repeat for all pages and finalize the real deck.
