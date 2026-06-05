---
name: ppt-aesthetic-design
description: Use when building, optimizing, reviewing, or debugging the local PPT Design OS aesthetic system, including old PPT redesign, from-zero deck generation, style reference libraries, intelligent routing, style proof confirmation, editable slide objects, image placement, no-distortion PPTX export, and multi-agent quality gates.
---

# PPT Aesthetic Design

Treat each PPT page as a poster-like editable composition: background or hero visual, real PowerPoint text objects, structured layout, small marks/icons, and a deliberate reading path.

## Core Workflow

1. Intake material: user prompt, source PPT/PDF/images, extracted text, products, prices, audience, target page count, and selected style reference group.
2. Understand and preserve facts before redesign: names, dates, prices, quantities, customer labels, risks, source images, and original intent.
3. Route locally before writing copy: choose deck type, page count, section rhythm, layout sequence, image strategy, and risk strategy.
4. Match style: use the selected style reference group as tone/palette/composition guidance, not literal content to copy.
5. Produce style proofs first for old PPT redesign or custom style usage; run automatic QA before asking for human style confirmation.
6. Generate the full deck only after proof confirmation; then run automatic QA again before export handoff.
7. Keep output editable: real PPT text boxes, image slots, speaker notes, structured `canvasEdits`, and downloadable PPTX matter more than static screenshots.

## Non-Negotiables

- Never stretch images. Preserve aspect ratio with contain, cover/crop, or full-bleed background treatment.
- If an image is a scene/product composition and is close to slide ratio, consider it as a background/hero visual with a text safe area.
- Do not crop out the product center, brand mark, packaging, or critical source text.
- One slide should carry one main message. Split dense pages instead of shrinking text into a document page.
- Use real text objects for user-editable content; preview PNGs are evidence, not the editable source.
- AI may propose structure, diagnosis, and copy; code owns coordinates, fonts, colors, image fit, and PPTX export.
- Run checks before claiming completion: `npm.cmd run check`, `npm.cmd run build`, and visual/preview inspection when layout or rendering changes.

## Built-In Knowledge

Load references only when needed:

- `references/workflow.md`: end-to-end PPT agent pipeline and handoff gates.
- `references/routing-and-layouts.md`: deterministic deck routing and layout rhythm rules.
- `references/old-ppt-redesign.md`: SlideIR, diagnosis, page classification, and redesign strategy.
- `references/image-composition.md`: no-distortion image handling, screenshot framing, hero/background decisions.
- `references/style-systems.md`: absorbed style knowledge from Guizang, frontend slides, and beautiful HTML templates.
- `references/template-layouts.md`: template profiling, placeholder mapping, and reusable layout gates learned from PPT tooling projects.
- `references/orchestration.md`: command layer rules for combining uploaded material preprocessing, PPT templates, style libraries, local tools, cloud review, and human confirmation.
- `references/external-ppt-learning.md`: practical lessons from GitHub PPT tools and skills, including what to adopt vs. only reference.
- `references/quality-gates.md`: content, visual, image, route, and export QA checklist.

## Local Integration Points

- Route/design data: `design-system/layouts.json`, `design-system/themes.json`, `design-system/skill-rules.json`.
- Generation and fallback: `server/ai.js`, `server/deckRouter.js`, `server/validateDeck.js`.
- Old PPT, templates, and aesthetics: `server/pptAesthetic.js`, `server/templateProfile.js`, `server/materialBrief.js`, `server/styleFingerprint.js`, `server/visualReview.js`, `server/imageQa.js`.
- Rendering/export: `server/ppt.js`.
- Frontend workflow: `src/main.jsx`, especially preview editing, style references, proof confirmation, and status panels.
