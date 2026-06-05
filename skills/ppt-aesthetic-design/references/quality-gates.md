# Quality Gates

## Content QA

- The cover clearly states the offer, project, or purpose.
- Every slide has one reason to exist.
- Source prices, product names, specs, dates, client names, and risk notes are preserved.
- Missing facts are marked as risks instead of invented.
- Speaker notes help the presenter say the page out loud.

## Route QA

- Actual layout sequence follows `routePlan`.
- Required layouts appear: `pricing` for price material, `visual` for image material, `product-detail` for product material.
- 5+ slides use at least 3 layout types.
- 8+ slides use at least 5 layout types.
- No 3 consecutive body pages use the same layout.

## Visual QA

- Text fits and stays readable.
- Title hierarchy is consistent.
- Similar objects share size, spacing, and alignment.
- Palette stays coherent with the selected style group.
- Visual pages have enough style signal; the main image is not tiny.

## Image QA

- No image appears stretched, squashed, or unnaturally cropped.
- Product/packaging images keep brand marks and important labels visible.
- Screenshots and dense reference images remain readable.
- Background/hero images have a deliberate text safe area.

## Proof Gate

- Generate 3-4 proof pages for old PPT redesign or custom style use.
- Select proof pages from cover, dense page, pricing/product page, visual page, or low-score diagnosis page.
- Run automatic QA before asking the human to confirm style.
- If proof QA blocks, regenerate proof before full deck.

## Export QA

- PPTX downloads and opens.
- Preview images or fallback preview exist.
- Editable text boxes exist for user-facing slide text.
- Task logs explain warnings.
- Final QA runs after full PPTX generation, not only after proof.
