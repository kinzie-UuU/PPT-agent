# Phase 13 - Worker Task Retry

## Goal

Make the editable rebuild queue resumable at page level.

Before this phase, a page worker task could become `failed` when `editppt run record`
rejected missing or invalid page artifacts. The frontend could refresh the queue, but
there was no explicit way to put that page back into a clean ready-to-claim state.

## Backend

Added:

```text
POST /api/workflow-jobs/:id/editable/worker-tasks/:pageId/reset
```

The reset action:

- sets the selected page task back to `ready`
- calls `editppt run reset <run> --page <page_id>` when the task was already claimed/running/failed
- clears worker identity and run timestamps
- clears the last error
- keeps the attempt count for audit history
- records an `editable.worker_task_reset` event
- refuses to reset `recorded` tasks unless `forceRecorded` is passed
- removes stale same-page dispatch/record artifacts from workflow state after a successful editppt reset

This keeps the normal retry path safe: failed or stuck pages can be retried, while
completed pages are protected by default.

## Frontend

The workflow worker console now includes:

- a `failed` count in the task summary
- a `Reset Retry` page action for the selected task
- automatic refresh of the local task bundle after reset

## Verification

Run:

```text
npm.cmd run check
npm.cmd run build
npm.cmd run audit:entrypoints
```

Expected route count increases by one because of the reset endpoint.
