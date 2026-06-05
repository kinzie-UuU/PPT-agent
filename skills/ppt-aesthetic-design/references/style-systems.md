# Style Systems Absorbed From Old Skill Packs

## Guizang-Derived Knowledge

Useful principles:

- Magazine style: restrained decoration, serif/display headline contrast, strong editorial hierarchy, image as a first-class citizen.
- Swiss style: single accent color, sans-serif system, 12-column grid, hairline rules, large type contrast, rectangular geometry.
- Do not mix two full style systems in one deck; choose one base system and keep it coherent.
- Read the actual template/classes before using a layout; missing class definitions cause visual collapse.
- For Swiss-like pages, avoid gradients, shadows, rounded corners, and multi-accent color clutter.
- Larger type should be lighter; small type should be heavier enough to read.
- Use icons from a known icon library, not improvised decorative SVGs, unless the system already defines them.

Not absorbed:

- The old standalone HTML horizontal-swipe runtime is not the main product path.
- Guizang's exact two-style limitation is not adopted; this project uses its own style reference groups.
- External absolute paths and old project-specific examples are not retained.

## Frontend Slides Knowledge

Useful principles:

- Build decks as viewport-stable compositions.
- Use consistent slide dimensions and safe areas.
- Keep typography responsive by layout rules, not arbitrary viewport scaling.
- Motion is optional; content and readability come first.

## Beautiful HTML Templates Knowledge

Useful principles:

- Template selection should use mood, occasion, density, scheme, formality, and best/avoid fit.
- A style reference library should store more than images: it should capture palette, density, typography, whitespace, geometry, and tone.
- Template screenshots are best used as style fingerprints, not as content to copy.

## Current Project Style Groups

The local product may expose five or more style groups. Treat custom groups as first-class:

- Each group should have a name, description, representative images, extracted fingerprint, and intended scenarios.
- A user-added style that does not fit a preset should become a custom style group, not be forced into the closest preset.
- Generation should reference the selected group during route, proof, and full-deck rendering.
