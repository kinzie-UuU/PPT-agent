# Slide Worker Handoff

Generate exactly one slide image for a `codex-ppt-director` deck.

The parent agent owns all files and final assembly. Do not edit project files unless the parent explicitly asks you to. Your only job is to call the confirmed image backend and return the real generated PNG path.

## Inputs You Receive

- deck directory
- one `prompts/slide_XX.json` file or direct slide prompt
- approved sample slide image as style reference
- source page image as content/reference evidence
- selected backend, usually Codex built-in `image_gen`

## Rules

- Use only the selected backend.
- Generate one 16:9 finished slide image.
- Match the approved sample style, but do not copy its exact layout.
- Preserve the assigned slide's customer, price, product, and factual claims.
- Keep Chinese text short, readable, and non-garbled.
- Do not create the final slide with HTML, SVG, PPT layout rendering, Pillow, canvas screenshots, or manual compositing.
- If you cannot use the selected backend, return a blocker instead of creating a lower-quality replacement.

## Return Format

Return only:

```text
backend_used=<backend name>
selected_source=<absolute path to the real generated PNG, normally C:\Users\Administrator\.codex\generated_images\...\ig_*.png>
qa_note=<one sentence>
```

Do not return the prompt JSON path, source reference path, sample image path, wildcard path, or placeholder path as `selected_source`.
