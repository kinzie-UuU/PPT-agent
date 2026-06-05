# Template Layout Profiling

## Source Ideas

- `pptx-from-layouts-skill`: prefer real PowerPoint slide layouts and placeholders over freehand coordinate guessing.
- `pptx-automizer`: treat existing decks as reusable template parts, not only as text/image sources.
- `dom-to-pptx`: keep HTML previews useful, but only accept export paths that preserve editable text and shapes.

## Local Rule

When a PPTX is uploaded, read three layers before redesign:

1. Slide content: text, images, density, and facts.
2. Layout profile: slide layout links, layout names, placeholder types, placeholder bounds, and use counts.
3. Aesthetic diagnosis: hierarchy, density, color noise, image balance, and redesign strategy.

Use the layout profile as evidence. A layout that is used repeatedly and has title/body/picture placeholders is a candidate for template reuse. A layout with no placeholders is a visual reference only unless code can rebuild editable objects safely.

## Placeholder Mapping

- `title` / `ctrTitle`: map to slide title or action headline.
- `subTitle`: map to subtitle, audience, date, or one-line value proposition.
- `body` / `obj`: map to bullets, cards, tables, or structured content blocks.
- `pic` / `media`: map to source images or confirmed generated images.
- `sldNum`, `dt`, `ftr`, `hdr`: preserve only as template furniture; do not fill with story content.

## Generation Gate

Before full generation from an old PPT or custom template:

- Prefer a reusable source layout if it has matching placeholders for the planned slide role.
- If no suitable placeholder exists, generate editable objects with project layout code and record why the source layout was not reused.
- Never flatten a slide to a screenshot just because the original layout is complex.
- If a template has many unused or duplicate layouts, choose from layouts used by real source slides first.

## QA Signals

Warn when:

- A source PPTX has slides but no layout links.
- A used layout has zero placeholders.
- More than 20 layouts exist; the template probably contains noise or historical variants.
- A generated slide claims template reuse but has no mapped placeholder evidence.
