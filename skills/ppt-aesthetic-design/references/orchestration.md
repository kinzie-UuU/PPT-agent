# PPT Aesthetic Orchestration

## Mental Model

The system has three different inputs that must not be mixed:

- Source material: facts, text, uploaded images, old PPT slides, product photos, prices, and customer context.
- PPT template: layout skeleton, placeholder structure, page rhythm, reusable master/layout evidence, typography scale, and editable object patterns.
- Style library: reference images for color, texture, mood, density, whitespace, image treatment, and brand atmosphere.

The "brain" chooses and coordinates. It does not draw every page freehand. It routes the deck, selects template layouts, chooses which source images become background/hero/foreground/decor, asks local or cloud tools only when needed, and gates full generation behind proof QA and human confirmation.

## Required Pipeline

1. Intake and preprocess uploads.
   - Hash every uploaded file and reuse duplicates by `sha256`.
   - For images, record size/aspect ratio and classify role: `background`, `foreground`, `decor`, `style-reference`, or `material`.
   - Old PPT images extracted from slides keep their source slide number; loose uploads are a shared asset pool.

2. Understand facts.
   - Extract and preserve names, dates, prices, specs, customer labels, source slide intent, and risk notes.
   - Missing facts are called out as confirmation needs, not invented.

3. Route locally.
   - Decide deck type, target pages, section rhythm, layout sequence, image strategy, risk strategy, template pack, and style reference group.
   - The route must state why a PPT template is being used and why a style group is being referenced.

4. Match template and style separately.
   - Template selection answers: where do title, body, image slots, data cards, section pages, and closing pages go?
   - Style library selection answers: what should the palette, material, visual density, cropping, whitespace, and tone feel like?
   - Never treat a style reference photo as content unless the user uploaded it as source material.

5. Generate style proofs.
   - Produce 3-4 representative slides, preferably cover, dense content, image-led, pricing/data, and risk/closing if present.
   - Run automatic QA before asking the user to confirm style.

6. Full generation.
   - Generate the complete editable PPT only after style confirmation.
   - Run automatic QA again: content preservation, image ratio, editable text, route adherence, template adherence, style adherence, and export validity.

7. Continue editing and export.
   - Online edits update structured slide data first, then regenerate PPTX and previews.
   - Exported PPTX must remain editable; full-slide screenshots are only previews or fallback evidence.

## Image Role Rules

- `background`: scene/poster/hero images. Use full-bleed or large-cover placement with a text-safe area. Never squeeze.
- `foreground`: product/package/person/object images. Preserve aspect ratio, optionally run cutout/matting, and place in image slots.
- `decor`: icons, logos, marks, small texture pieces. Do not enlarge into hero images.
- `style-reference`: mood and visual guidance only. Use for palette/composition/fingerprint, not as slide content.
- `material`: unknown image material. Prefer contain/crop with QA instead of stretch.

## Tool Routing

- Local deterministic code handles routing, template layout, coordinates, image fit, file hashing, dedupe, and PPTX generation.
- Local ComfyUI/Z-Image handles background generation, foreground cutout, and element decomposition when available.
- Cloud model handles semantic diagnosis, copy, route critique, and visual QA when configured.
- Human confirmation happens after proof QA, before full-deck generation.
