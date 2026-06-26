# PPT Agent

本项目是本地 PPT Agent 工作台，默认运行在：

```text
http://127.0.0.1:4180/
```

当前产品主线是 **Skill-first workflow**：

```text
上传 PPT / PDF / 图片 / brief
-> codex-ppt 生成视觉统一的图片型 PPT
-> image-to-editable-ppt / editppt 重建对象级可编辑 PPT
-> 质量检查、人工复核、失败恢复、交付门禁
-> 下载 editable-final.pptx
```

旧模板、旧本地生成器、passthrough、dry-run、本地纯文本重建都不能作为产品级主流程。

## 当前结论

当前工具方向正确，但产品级 v1 还没有完成。
产品级 v1 验收的最终标准是完整真实链路通过，并在验收报告中写入 `acceptance.ready=true`。

已经完成或验证：

- Skill-first 工作流框架已接入。
- `codex-ppt` 关卡、图片型 PPT、OCR、`image-to-editable-ppt/editppt`、页面 worker、finalize 和交付门禁均已接入。
- 图片模型配置为 `gpt-image-2`，并已真实生成过 `page_001`、`page_002`。
- OCR 使用 `rapidocr-local`。
- 当前真实 job `workflow_20260624-191529Z_b783f0` 已生成 2 页 `editable-final.pptx`。
- 当前 2 页最终 PPT 可被 PowerPoint 打开，并包含可编辑文本、形状和图片对象，没有整页截图冒充。

未完成：

- 当前 2 页 final 仍被交付门禁阻断，因为最终视觉 QA 需要人工复核。
- 当前只完成 2 页测试，不是完整 15 页产品验收。
- `workspace/v1-acceptance/latest-real-ppt-regression.json` 仍应保持 `acceptance.ready=false`，直到真实 15 页验收完成。
- 前端仍需继续降低工程细节暴露，把 worker、manifest、hash、provider、artifact 等默认收进高级详情。

## 重要边界

- `codex-ppt` 负责视觉统一的图片型 PPT。
- `image-to-editable-ppt/editppt` 负责对象级可编辑 PPT 重建。
- `gpt-image-2` 正常不代表页面规格模型或对话模型一定正常。
- OCR 只是文字提示和校对辅助，不是最终重建引擎。
- 外部图片 API 或页面模型调用前必须明确确认额度和范围。
- 交付门禁不能绕过：打不开、证据缺失、整页截图风险、人工复核未记录时不能开放最终交付。

## 快速启动

```powershell
npm install
npm run local
```

也可以双击：

```text
start-ppt-tool.cmd
```

开发模式：

```powershell
npm run dev
```

检查：

```powershell
npm run check
npm run regression:skill-first
npm run build
npm run smoke
```

环境检查：

```powershell
Invoke-RestMethod http://127.0.0.1:4180/api/doctor
Invoke-RestMethod http://127.0.0.1:4180/api/health
```

## 关键配置

配置写入 `.env` 或项目已有配置方式：

```text
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-5.5
OPENAI_IMAGE_MODEL=gpt-image-2
PAGE_SPEC_MODEL=gpt-4o

OCR_PROVIDER=rapidocr-local
OCR_PYTHON_PATH=python

EDITPPT_SKILL_ROOT=C:\Users\Administrator\.codex\skills\image-to-editable-ppt
EDITPPT_PYTHON_PATH=python
EDITPPT_RUN_ROOT=C:\Users\Administrator\AppData\Local\Temp\ppt-tool-editable-runs

PORT=4180
```

前端不能暴露 API Key，只能显示脱敏状态。

## 产品流程

1. 上传 PPT / PDF / 图片，或输入 brief。
2. 创建 Skill-first workflow。
3. 检查本地服务、Provider、OCR、PowerPoint、editppt 和成本预估。
4. 确认 `codex-ppt` 的大纲、风格、后端、样张、全量生成关卡。
5. 生成并人工复核真实视觉样张。
6. 通过外接图片 API 生成图片型 PPT。
7. 准备 `image-to-editable-ppt/editppt` 运行目录。
8. 执行页面级可编辑重建。
9. 对失败页执行单页重试。
10. 合并为 `editable-final.pptx`。
11. 执行 PowerPoint 打开性、可编辑对象、整页截图风险、页面证据、最终视觉 QA。
12. 人工复核通过后开放最终下载。

## 关键 API

Workflow：

```text
GET  /api/workflow-jobs
POST /api/workflow-jobs
GET  /api/workflow-jobs/:id
POST /api/workflow-jobs/:id/next
POST /api/workflow-jobs/:id/next/preflight
POST /api/workflow-jobs/:id/source/render
POST /api/workflow-jobs/:id/visual/sample
POST /api/workflow-jobs/:id/visual/generate
POST /api/workflow-jobs/:id/image-deck/assemble
POST /api/workflow-jobs/:id/editable/prepare
POST /api/workflow-jobs/:id/editable/prompts
POST /api/workflow-jobs/:id/editable/finalize
GET  /api/workflow-jobs/:id/delivery-status
GET  /api/workflow-jobs/:id/cost-estimate
GET  /api/workflow-jobs/:id/v1-readiness
GET  /api/workflow-jobs/:id/events
GET  /api/workflow-jobs/:id/logs/download
```

产品验收：

```text
POST /api/v1-acceptance/product-visual-sample/prompt-preview
POST /api/v1-acceptance/product-visual-full-deck/approval/approve
GET  /api/v1-acceptance/latest
```

## 当前下一步

当前 `2/15` final 状态下，下一步必须明确呈现两个选择：

- 复核当前 2 页样例。
- 继续生成剩余 13 页。

继续剩余页会消耗外部 API 额度，必须显式确认；不能自动静默运行。
