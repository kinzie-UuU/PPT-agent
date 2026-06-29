# PPT Agent

本项目是本地 PPT Agent 工作台，默认运行在：

```text
http://127.0.0.1:4180/
```

## 主流程

当前产品主线是 **Skill-first workflow**：

```text
上传 PPT / PDF / 图片 / brief
-> codex-ppt 生成视觉统一的图片型 PPT
-> image-to-editable-ppt / editppt 重建对象级可编辑 PPT
-> 质量检查、人工复核、失败恢复、交付门禁
-> 下载 editable-final.pptx
```

旧模板、旧本地一键生成器、passthrough、dry-run、本地纯文本重建都不能作为产品级主流程。

## 当前结论

当前工具方向正确，但产品级 v1 还没有完成。产品级 v1 验收的最终标准是完整真实链路通过，并在验收报告中写入 `acceptance.ready=true`，或交付门禁返回 ready。

截至 2026-06-29：

- 当前真实 job：`workflow_20260629-021146Z_619d82`
- 源文件：`汇川中秋--20260611.pptx`
- 源页数：20 页
- 当前已跑通：2/20 页真实小样本闭环
- 当前最终文件：`workspace/jobs/workflow_20260629-021146Z_619d82/final/editable-final.pptx`
- 当前交付状态：draft，可作为 2 页测试范围下载，不是完整产品交付
- 图片模型：`gpt-image-2`
- OCR：`paddleocr-local`，`rapidocr-local` 作为兜底

已经完成或验证：

- Skill-first 工作流框架已接入。
- `codex-ppt` 关卡、图片型 PPT、OCR、`image-to-editable-ppt/editppt`、页面 worker、finalize 和交付门禁均已接入。
- 当前 2 页最终 PPT 可被 PowerPoint 打开，并包含可编辑文本、形状和图片对象，没有整页截图冒充。
- 本地开源 OCR 已可用，当前 2 页 OCR 结果 `mojibakeCount=0`。

未完成：

- 当前只完成 2/20 页，不是完整 20 页产品交付。
- 继续剩余 18 页前必须显式确认外部 API 额度。
- 普通用户前端仍需继续隐藏工程细节，把 worker、manifest、hash、provider、artifact 默认收进高级详情。

## 重要边界

- `codex-ppt` 负责视觉统一的图片型 PPT。
- `image-to-editable-ppt/editppt` 负责对象级可编辑 PPT 重建。
- `gpt-image-2` 正常不代表对话模型或页面规格模型一定正常。
- OCR 只是文字提示和校对辅助，不是最终重建引擎。
- 外部图片 API 或页面模型调用前必须明确确认额度和范围。
- 交付门禁不能绕过：打不开、证据缺失、整页截图风险、人工复核未记录、页数未覆盖时不能开放完整产品交付。

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

OCR_PROVIDER=paddleocr-local
OCR_FALLBACK_PROVIDER=rapidocr-local
OCR_PYTHON_PATH=python

EDITPPT_SKILL_ROOT=C:\Users\Administrator\.codex\skills\image-to-editable-ppt
EDITPPT_PYTHON_PATH=python
EDITPPT_RUN_ROOT=C:\Users\Administrator\AppData\Local\Temp\ppt-tool-editable-runs

PORT=4180
```

前端不能暴露 API Key，只能显示脱敏状态。

## 关键 API

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
