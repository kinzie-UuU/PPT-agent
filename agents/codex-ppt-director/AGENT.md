# Codex PPT Director Agent

## Purpose

This agent wraps `skills/codex-ppt` into a repeatable director workflow for creating or redesigning image-based PowerPoint decks.

Use it when the user wants:

- one-prompt PPT generation from notes, articles, reports, PDFs, or PPT/PPTX files;
- redesign of an existing deck with stronger visual consistency;
- a visually polished PPTX where each slide is a full-slide image;
- parallel slide generation after a style sample is approved.

Do not use it when the user requires fully editable text boxes, editable charts, or native PowerPoint shapes as the final output. In that case, use the local editable PPT pipeline or an image-to-editable reconstruction workflow.

## Core Contract

The director owns decisions, evidence, state, QA, and assembly. Slide workers only generate one slide image each.

The final output is a `.pptx` assembled from `origin_image/slide_XX.png`. Each slide is image-based and visually unified. Speaker notes should be written to `speech.md` and included in the PPTX when assembly supports notes.

## Required Skill

Read and follow:

- `skills/codex-ppt/SKILL.md`
- `skills/codex-ppt/docs/workflow-gates-and-progress.md`
- phase-specific docs from the skill before that phase

If the skill conflicts with this agent file, prefer the skill for generation policy and this file for local wrapper conventions.

## Workflow

1. Source intake
   - Copy user source files into the project directory when path encoding or permissions may be fragile.
   - Extract slide/page text and embedded images when possible.
   - Render PPT/PPTX/PDF pages to real preview images before deriving style.
   - Produce a source contact sheet when the source has multiple pages.

2. Outline confirmation
   - Draft `outline.md` with slide number, title, key points, layout role, visual idea, and required source images.
   - Ask for approval before style selection unless the user explicitly asked to skip gates.

3. Visual style confirmation
   - Offer 2-3 concrete style options if no style was specified.
   - If a style reference was supplied, inspect rendered images first and summarize the style rules.

4. Backend confirmation
   - Prefer Codex built-in `image_gen` when available.
   - Use `scripts/image_gen.py` only when the built-in backend is unavailable or the user explicitly chooses CLI/API fallback.
   - Explain the selected backend and wait for confirmation.

5. Sample slide
   - Generate exactly one representative slide image.
   - Save it as the final filename, such as `origin_image/slide_08.png`.
   - Show it to the user and wait for approval.

6. Full-deck generation
   - Create `deck_spec.json`, `prompts/slide_XX.json`, `slide_jobs.json`, and `slide_run_state.json`.
   - Use one subagent per remaining slide whenever available and authorized.
   - If subagents are not available, ask whether sequential generation is acceptable.

7. Result recording
   - The parent must copy each selected generated PNG into `origin_image/slide_XX.png`.
   - Do not trust worker-reported paths blindly. If a worker returns a placeholder, job file, or source reference path, inspect that worker's generated image directory and recover the real PNG.
   - Keep provenance in `slide_jobs.json` and `slide_run_state.json`.

8. QA and repair
   - Build a contact sheet from `origin_image`.
   - Check slide count, obvious text corruption, missing products, broken layout, duplicate pages, and blank slides.
   - Regenerate only problematic slides.

9. Assembly
   - Prefer `skills/codex-ppt/scripts/assemble_ppt.py` when a working Python runtime exists.
   - If Python is unavailable, use `scripts/assemble-image-deck.mjs`.
   - Verify the final PPTX by checking the internal slide count and, when PowerPoint is available, exporting a preview.

## Local Directory Convention

Use:

```text
outputs/codex-ppt-agent/{deck_name}/
  source/
  source_refs/
  assets/
  prompts/
  origin_image/
  outline.md
  deck_spec.json
  slide_jobs.json
  slide_run_state.json
  speech.md
  {deck_name}.pptx
  *_contact_sheet.png
```

For ad hoc redesigns, a simpler directory under `outputs/{deck_name}` is acceptable if the user has already chosen it.

## Standard User Prompt

```text
使用 codex-ppt-director 智能体，把这个文件重新设计成 15 页现代提案风 PPT。
要求：保留事实和报价；先出样张；样张通过后并行生成；最后输出 PPTX。
```

## Failure Policy

- Missing source file: stop and ask for a valid path.
- Source rendering unavailable: extract Open XML text/images and clearly mark reduced confidence.
- Built-in image backend unavailable: ask whether to use CLI/API fallback.
- Python unavailable: use Node assembly fallback and report this deviation.
- Worker path is wrong: recover from the worker generated-images directory before declaring blocked.
- Severe text corruption: regenerate the slide with shorter text and larger type.
