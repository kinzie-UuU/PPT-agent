# Phase 20: Page Worker Briefs

## Goal

Turn real PPT worker-ready pages into explicit handoff packages for real page workers.

The previous real regression proved that the user PPT can reach:

- rendered source pages
- visual intermediate pages
- OCR text hints
- `editppt` prepared run
- page worker prompts
- ready worker tasks

This phase adds a product-level bridge from "task is ready" to "a real worker has enough context to rebuild the page."

## Added

- `scripts/build-worker-briefs.mjs`
- `npm.cmd run worker:briefs`

The command writes worker handoff files under:

```text
workspace/jobs/<workflow_id>/worker-briefs/
```

It does not write page artifacts in the `editppt` page directory.

## Command

```powershell
npm.cmd run worker:briefs -- --job-id workflow_20260616-100010Z_9c006d --pages 1-3 --agent-id real-worker-001 --workflow-root "E:\PPT工具\workspace\jobs" --out "E:\PPT工具\workspace\jobs\workflow_20260616-100010Z_9c006d\worker-briefs"
```

## Current Evidence

Generated briefs:

- `E:\PPT工具\workspace\jobs\workflow_20260616-100010Z_9c006d\worker-briefs\README.md`
- `E:\PPT工具\workspace\jobs\workflow_20260616-100010Z_9c006d\worker-briefs\index.json`
- `E:\PPT工具\workspace\jobs\workflow_20260616-100010Z_9c006d\worker-briefs\page_001\worker-brief.md`
- `E:\PPT工具\workspace\jobs\workflow_20260616-100010Z_9c006d\worker-briefs\page_001\worker-brief.json`
- `E:\PPT工具\workspace\jobs\workflow_20260616-100010Z_9c006d\worker-briefs\page_002\worker-brief.md`
- `E:\PPT工具\workspace\jobs\workflow_20260616-100010Z_9c006d\worker-briefs\page_002\worker-brief.json`
- `E:\PPT工具\workspace\jobs\workflow_20260616-100010Z_9c006d\worker-briefs\page_003\worker-brief.md`
- `E:\PPT工具\workspace\jobs\workflow_20260616-100010Z_9c006d\worker-briefs\page_003\worker-brief.json`

Brief index summary:

```json
{
  "pageCount": 3,
  "briefs": [
    { "pageId": "page_001", "ocrLineCount": 3, "taskStatus": "ready" },
    { "pageId": "page_002", "ocrLineCount": 11, "taskStatus": "ready" },
    { "pageId": "page_003", "ocrLineCount": 12, "taskStatus": "ready" }
  ]
}
```

The generated briefs include:

- source image path
- page directory
- worker prompt path
- OCR lines and text boxes
- page ownership boundary
- forbidden parent-authored artifacts
- helper commands
- spec skeleton outside the page directory

## Boundary Check

After generating briefs, the real `editppt` page directories were checked for forbidden deliverable artifacts:

- `manifest.json`
- `page.pptx`
- `preview.png`
- `split_assets_contact.png`
- `validation.json`
- `page_result.json`

No such artifacts were created by this command.

## Current Limit

This phase prepares real page workers but does not replace them. The remaining product gap is still:

1. Spawn or run a real page worker per page.
2. Let that worker inspect source images and write `page-rebuild-spec.json`.
3. Run `worker:page-pipeline`.
4. Record each page.
5. Finalize the real deck.
