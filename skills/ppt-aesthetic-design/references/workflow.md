# PPT Agent Workflow

## Two Product Modes

- Existing PPT redesign: parse source, diagnose, classify pages, preserve facts and images, create proof samples, then rebuild the full deck.
- From-zero generation: start from one sentence, one image, or mixed material; infer deck type, route, style, and missing facts.

## Required Pipeline

1. Input material.
2. Understand content and extract facts.
3. Build local route plan.
4. Match style reference group.
5. Generate style proof pages.
6. Run automatic QA on proof pages.
7. Ask human to confirm style.
8. Generate full PPT.
9. Run automatic QA again.
10. Support continuing edits and export.

## Agent Roles

- Brain/router: deck type, page count, layout sequence, section rhythm, risk strategy.
- Content agent: titles, subtitles, bullets, data points, speaker notes.
- Style agent: palette, whitespace, image role, typography density, composition rhythm.
- Layout agent: coordinates, fit mode, object hierarchy, editable text placement.
- QA agents: content preservation, image ratio, route adherence, style proof, export readiness.

## Handoff Rules

- Style proof is mandatory for old PPT redesign and custom style library usage.
- Proof QA must run before human style confirmation.
- Full-deck QA must run before saying the PPT is done.
- Task logs should record route, proof, QA, export, and warnings.
