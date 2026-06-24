# PPT Design Tool

本项目是一个本地 PPT 重建工作台，目标是把原 PPT / PDF / 图片页转换成可验证、可恢复、可下载的 PPT 交付流程。

当前产品主线是 Skill-first workflow：

```text
source PPT/PDF/image/brief
-> render source pages
-> codex-ppt visual sample and image-based deck
-> OCR / text hints
-> image-to-editable-ppt / editppt editable rebuild
-> validation, review, retry, download
```

Codex 只用于开发和调试。产品运行时的视觉生成必须使用外接 Image API Provider，不依赖 Codex 内部生图能力。

## Quick Start

Windows 本地启动：

```powershell
npm install
npm run local
```

或双击：

```text
start-ppt-tool.cmd
```

默认地址：

```text
http://127.0.0.1:4180/
```

开发模式：

```powershell
npm run dev
```

## Required Runtime

基础依赖：

- Node.js
- PowerPoint for PPTX page rendering on Windows
- Python for OCR and editppt runtime
- image-to-editable-ppt skill / editppt CLI
- External OpenAI-compatible Image API for codex-ppt visual pages

检查运行环境：

```powershell
Invoke-RestMethod http://127.0.0.1:4180/api/doctor
```

前端首页也会显示 Product readiness 和 Doctor checks。

## Configuration

复制或编辑 `.env`：

```text
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4.1-mini
OPENAI_IMAGE_MODEL=gpt-image-2
PROVIDER_TIMEOUT_MS=120000
PROVIDER_MAX_RETRIES=2
PROVIDER_CONCURRENCY=2
OCR_PROVIDER=rapidocr-local
OCR_PYTHON_PATH=python
EDITPPT_SKILL_ROOT=C:\Users\Administrator\.codex\skills\image-to-editable-ppt
EDITPPT_PYTHON_PATH=python
EDITPPT_RUN_ROOT=C:\Users\Administrator\AppData\Local\Temp\ppt-tool-editable-runs
PDFTOPPM_PATH=
PDFTOPPM_ARGS_PREFIX_JSON=
PDF_RENDER_DPI=160
PDF_RENDER_TIMEOUT_MS=180000
PDF_PARSE_RENDER_WIDTH=1600
PORT=4180
```

可选成本估算单价：

```text
COST_IMAGE_USD_PER_GENERATION=
COST_EDITABLE_PAGE_USD=
COST_OCR_PAGE_USD=0
COST_LLM_INPUT_USD_PER_1K=
COST_LLM_OUTPUT_USD_PER_1K=
```

API Key 只保存在后端环境配置里，前端只显示脱敏状态。

## Normal Product Flow

1. 打开 `http://127.0.0.1:4180/`。
2. 上传 PPT/PDF/图片，或直接输入需求 brief。
3. 进入 Generate editable PPT。
4. 创建 Skill-first PPT workflow。
5. 检查 Cost estimate、Provider readiness、Doctor checks。
6. 完成 codex-ppt outline/style/backend 审批。
7. 生成并检查 visual sample。
8. 批准 sample 和 full-deck generation。
9. 同步 codex-ppt slide worker 队列，记录真实生成的页面图片。
10. Assemble image PPT。
11. Prepare editppt / image-to-editable-ppt run。
12. 生成 editable page worker prompts。
13. 通过 worker 执行页面重建并 record 结果。
14. 对失败页执行 retry。
15. Finalize editable PPTX。
16. 检查 final QA、validation、manual review 和 delivery status。
17. 下载 editable PPTX、image deck、validation、log bundle。

## Key API

Workflow:

```text
GET  /api/workflow-jobs
POST /api/workflow-jobs
GET  /api/workflow-jobs/:id
POST /api/workflow-jobs/:id/source/render
POST /api/workflow-jobs/:id/visual/sample
POST /api/workflow-jobs/:id/visual/generate
POST /api/workflow-jobs/:id/image-deck/assemble
POST /api/workflow-jobs/:id/editable/prepare
POST /api/workflow-jobs/:id/editable/hints
POST /api/workflow-jobs/:id/editable/prompts
POST /api/workflow-jobs/:id/editable/finalize
GET  /api/workflow-jobs/:id/compliance
GET  /api/workflow-jobs/:id/delivery-status
GET  /api/workflow-jobs/:id/cost-estimate
GET  /api/workflow-jobs/:id/v1-readiness
GET  /api/workflow-jobs/:id/events
GET  /api/workflow-jobs/:id/logs/download
```

Operations:

```text
GET  /api/doctor
GET  /api/providers
POST /api/providers/test
GET  /api/workflow-jobs/cleanup/preview
POST /api/workflow-jobs/cleanup/archive
POST /api/workflow-jobs/:id/archive
POST /api/workflow-jobs/:id/restore
```

## Artifacts

Workflow artifacts live under:

```text
workspace/jobs/{workflowId}/
```

Important folders:

```text
input/
source/
rendered-pages/
visual-images/
image-deck/
ocr/
editable-run/
final/
logs/
state.json
manifest.json
```

The editable final PPTX is stored in:

```text
workspace/jobs/{workflowId}/final/editable-final.pptx
```

## Worker Commands

Normal UI flow should not require shell commands, but these remain available for diagnosis or controlled worker execution:

```powershell
npm run worker:codex-slide
npm run worker:batch
npm run worker:once
npm run worker:briefs
```

Scripts prefixed with `lab:*` are experimental or diagnostic and are not the product path.

## Validation

Run before delivery:

```powershell
npm run check
npm run build
npm run regression:skill-first
```

Optional:

```powershell
npm run smoke
npm run smoke:workflow-e2e
npm run regression:real-ppt -- --source "C:\path\to\deck.pptx" --max-pages 15
```

`regression:real-ppt` writes the latest real PPT acceptance report to:

```text
workspace/v1-acceptance/latest-real-ppt-regression.json
```

The v1 acceptance panel reads this report through `/api/v1-acceptance/latest`.
The response includes `acceptance.ready`, `acceptance.checks`, and `acceptance.missing` so the UI can show whether v1 is actually proven and which evidence is still missing.
You can also start the same dry-run acceptance from the v1 acceptance panel by entering a local `.pptx` path; the UI calls `/api/v1-acceptance/run` and tracks `workspace/v1-acceptance/latest-run.json`.
When the selected workflow already has a PPTX source, the panel can start acceptance from that workflow source directly, using the job's internal ASCII-safe copy.

## Recovery

- Use Workflow events to inspect recent failures.
- Use Failed page recovery to retry failed codex-ppt or editable page tasks.
- Use log bundle download for debugging.
- Use Archive current to hide finished or unwanted workflows without deleting files.
- Use Workflow cleanup to preview and soft-archive internal regression/probe jobs.
- Use Show archived and Restore workflow to bring archived jobs back.

## Known Limits

- Product v1 is still in progress.
- PDF rendering fallback is not fully productized yet when PowerPoint/renderer dependencies are missing.
- Visual generation quality depends on the configured external Image API.
- Editable reconstruction depends on editppt / image-to-editable-ppt runtime readiness.
- Some older UI strings still need cleanup from previous encoding issues.
