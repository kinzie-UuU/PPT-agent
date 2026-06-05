# Editable Layer Model

## Product Rule

Canvas is the workspace, not the editor. The editable object is a layer.

Every editable slide should be represented as a persistent layer document:

- `TextLayer`: native text content and typography.
- `ImageLayer`: source image, fit mode, crop/contain settings, provenance.
- `ShapeLayer`: cards, rules, marks, dividers, badges.
- `GroupLayer`: later grouping for compound objects.

The UI should select and edit layers, not mutate preview pixels.

## TextLayer Contract

Each text object needs:

- `id`, `type: "text"`, `name`
- `x`, `y`, `width`, `height`
- `rotation`, `opacity`, `visible`, `locked`
- `text`
- `style.fontFamily`
- `style.fontSize`
- `style.fontWeight`
- `style.color`
- `style.textAlign`
- `style.lineHeight`
- `style.letterSpacing`
- `zIndex`

In the current app this maps to `canvasEdits` and `SceneGraph.texts`.

## Interaction Contract

- Single click selects a layer and sets `selectedLayerId`.
- Selected layers show a blue selection box.
- Dragging updates layer `x/y`, not DOM-only position.
- Text edits update layer `text`.
- Property controls update layer `style`.
- Save writes layer data back to the slide and regenerates editable PPTX.

## Recommended Rendering

Use hybrid rendering:

- Canvas/background layer for preview backgrounds, images, and shapes.
- DOM TextLayer for native text editing, input method support, cursor, selection, copy/paste.
- Export renderer converts layer data into native PPTX text boxes and shapes.

Avoid pure `ctx.fillText()` for editing. It is acceptable for read-only previews, but not for a production PPT editor.

## QA Gates

- No critical text may be trapped inside a background image.
- TextLayer style changes must survive save and PPTX rebuild.
- ImageLayer must preserve aspect ratio.
- Selection UI must correspond to real layer ids.
- Exported PPTX must contain editable native text boxes.
