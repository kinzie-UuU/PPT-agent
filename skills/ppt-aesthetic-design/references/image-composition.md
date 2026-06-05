# Image Composition

## Fit Modes

- `contain`: show the whole image, best for product packs, screenshots, dense reference images.
- `cover`: fill a frame while cropping safely, best for atmospheric or non-critical backgrounds.
- `background`: full-bleed or large-area hero image with text safe area.
- `crop`: allowed only when the important subject remains intact.

## No-Distortion Rules

- Never force an image into mismatched width/height.
- Circles must remain circles; products must not look thin, fat, or compressed.
- Record image slot ratio and actual image ratio; warn when fit would distort.
- Use crop/contain decisions rather than raw stretching.

## Hero / Background Decision

Use an image as a background or hero when:

- It is a scene or product composition.
- It already has usable empty space or can support a text panel.
- It establishes the style better than a small framed image.
- It is close enough to slide ratio for safe cover cropping.

Use contain or framed placement when:

- The image has packaging, product labels, UI text, or dense evidence.
- Cropping would remove important content.
- The original image ratio is far from slide ratio.

## Screenshot Framing

- Screenshots need readable text first, aesthetics second.
- Use consistent frame ratios for screenshot groups.
- If screenshots are too long/narrow, split or summarize instead of squeezing.
- For generated replacement visuals, match final slot ratio before generation.

## Text Safe Areas

- Put text on a clean empty zone, solid paper panel, translucent panel, or deliberately darkened overlay.
- Do not place text directly on busy product/image details.
- Keep brand marks and product centers outside text panels.
