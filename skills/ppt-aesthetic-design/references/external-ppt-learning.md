# External PPT Tooling Lessons

## Directly Useful

### pptx-automizer

Use for template-driven automation ideas: import existing PPTX files, reuse slide layouts, and replace structured objects instead of redrawing everything. Best local lesson: separate `template profile` from `content generation`.

### pptx-from-layouts-skill

Use for Skill behavior: inspect layouts and placeholders first, then choose the best layout for each semantic slide. Best local lesson: placeholder mapping is more reliable than freehand coordinate generation when a source template exists.

### dom-to-pptx

Use for experiments only until fidelity is proven. Best local lesson: React/HTML preview can become an editable PPTX source if the converter preserves text, images, fills, and simple geometry. Do not rely on it for complex CSS until sample decks pass visual QA.

## Reference Only

### Presenton / PPT Master / AiPPT

Use these to study product architecture, outline-first generation, template management, and edit/export flows. Do not import whole systems into the local app unless a specific module is isolated and tested.

### OfficeCLI / powerpoint-skill variants

Use as inspiration for agent tools, CLI operations, visual audit, formulas, diagrams, and academic slide patterns. Keep the local app's main PPTX path editable and deterministic.

## Adoption Order

1. Template profile and placeholder evidence.
2. Template reuse engine or pptx-automizer prototype.
3. DOM-to-PPTX single-slide export experiment.
4. Heavier product-architecture ideas only after the local generation path is stable.
