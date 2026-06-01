---
name: ppt-aesthetic-design
description: Use when building or modifying the PPT Design OS aesthetic system, especially slide image placement, style references, routing, style proofing, and old-deck redesign workflows. Enforces no-distortion image handling and poster-like PPT composition.
---

# PPT Aesthetic Design

This tool treats a PPT page like a poster system: background/hero image, editable text layout, small icons or marks, and clear content hierarchy.

## Non-Negotiables

- Never stretch an image by forcing it into a mismatched `w/h` box.
- Always preserve image aspect ratio. Use contain, cover/crop, or full-bleed background; never use raw `x,y,w,h` when it changes proportions.
- If an image is a scene/product composition and its ratio is close to the slide ratio, use it as a full-bleed or large-area background/hero visual.
- Put text in a deliberate safe area: translucent panel, solid paper panel, or clean empty area in the image.
- If the image contains important products/text, crop conservatively. Do not crop out the product center, brand mark, or key packaging.
- Source PPT optimization must preserve original images and original meaning before applying style.

## Decision Rules

- Landscape scene image: prefer full-slide background with right/left text panel.
- Portrait product cutout: use large hero frame with contain; do not crop unless composition remains clear.
- Dense screenshot or text-heavy image: keep as reference/appendix or place in a readable contain box.
- Style reference image: extract palette, whitespace, contrast, texture, typography density, and composition rhythm; do not copy content literally.

## Old PPT Redesign Workflow

- Parse the source PPTX into SlideIR before redesign: page size, text, images, shapes, coordinates, font sizes, colors, raw text, element counts.
- Classify each source slide before routing: cover, agenda, company_case, product_cost, project_review, light_custom, creative_custom, category_matrix, thanks, or unknown.
- Score each page for information density, element count, color count, hierarchy, occupancy/white space, and image ratio risk.
- Preserve source facts first: names, dates, prices, quantities, customer labels, risk notes, delivery assumptions, and original image intent.
- AI can propose diagnosis and redesign structure; code owns coordinates, fonts, colors, editable text boxes, image placement, and PPTX export.
- Low-score, high-density, pricing, risk, and cover pages should be prioritized for style proof samples before full-deck generation.

## QA Checklist

- Image looks natural: circles remain circles, products are not thin/fat, packaging is not squashed.
- Main visual is large enough to establish style in the first viewport/cover.
- Text does not sit directly on busy image areas unless a panel or overlay guarantees readability.
- The deck has an explicit style proof before full generation when the user is optimizing an existing PPT or using a custom style library.
- Run local preview export and inspect PNGs before saying the visual issue is fixed.
- Run automatic QA both after style proof and after full PPTX generation.
