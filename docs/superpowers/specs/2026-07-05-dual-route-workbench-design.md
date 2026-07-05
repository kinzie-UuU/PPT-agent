# Dual Route Workbench Design

## Goal

Simplify the PPT Agent frontend by showing two explicit routes in the same job:

- Route A: image-based PPT delivery through `codex-ppt`
- Route B: optional editable PPT delivery through `image-to-editable-ppt` / `editppt`

## Boundaries

- Do not change backend workflow logic, API shapes, worker contracts, delivery gates, authorization gates, or artifact paths.
- Do not bypass external spend confirmation or manual review requirements.
- Frontend changes are limited to presentation, labels, grouping, and reuse of existing callbacks.

## UI Shape

The main generation screen starts with a dual-route summary:

- Route A shows source upload, visual pages, image PPT assembly, and image PPT download.
- Route B shows image PPT selection, OCR/page understanding, editable rebuild, manual review, and editable PPT download.
- Route B is visually optional until Route A has produced an image deck.
- The next-action panel tells the user whether to complete image PPT first or continue into editable reconstruction.
- Advanced worker/provider/artifact detail remains available in the existing advanced sections.

## Success Criteria

- Ordinary users can understand that image PPT and editable PPT are separate stages.
- Existing workflow controls continue to call the same functions.
- The UI clearly reports partial state such as `20/20` image pages and `2/20` editable sample pages.
- `npm run check` and `npm run build` pass after the frontend change.
