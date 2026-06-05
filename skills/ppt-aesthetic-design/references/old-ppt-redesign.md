# Old PPT Redesign

## SlideIR / SlideJSON

Extract or preserve:

- Page size and source slide index.
- Text blocks, raw text, font size, font family, color, bold/weight if available.
- Images with dimensions, coordinates, aspect ratio, and source path.
- Shapes, fills, strokes, approximate coordinates, and element counts.
- Derived metrics: character count, image count, color count, occupancy, density.

## Page Classification

Use these source slide types when possible:

- `cover`
- `agenda`
- `company_case`
- `product_cost`
- `project_review`
- `light_custom`
- `creative_custom`
- `category_matrix`
- `thanks`
- `unknown`

Map to local layouts:

- Case pages -> `cards`, `kpi`, `section`.
- Quotation/cost pages -> `pricing`, `bundle`.
- Review/risk pages -> `risk-checklist`, `compare`.
- Category matrix pages -> `cards`, `compare`, or `category-matrix` strategy.
- Dense narrative pages -> split into `section` plus `cards` or `visual`.

## Aesthetic Diagnosis

Score each page on:

- Information density.
- Element count.
- Color count.
- Font hierarchy.
- Alignment.
- White space.
- Consistency with deck system.
- Image ratio or cropping risk.

Prioritize proof samples from low-score pages, high-density pages, pricing pages, risk pages, and cover pages.

## Preservation Rules

- Preserve source facts before beautifying.
- Do not invent prices, names, dates, product specs, or risk notes.
- Preserve original images when they carry evidence or product identity.
- If image extraction fails, keep text reconstruction and mark image risk.
- If AI JSON fails, fall back to local rule-based plan.
