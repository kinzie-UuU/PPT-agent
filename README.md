# PPT Agent

> 实验性原生可编辑 Provider 的接入边界见 `docs/ppt-master-provider.md`。当前正式产品链路仍为 `codex-ppt` + `image-to-editable-ppt/editppt`；PPT Master 只完成无费用运行时预检，尚未开放自动执行。

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

截至 2026-08-20，单个八页真实任务已经完成图片版、对象级可编辑重建、自动质量检查、人工复核和最终交付门禁；工程闭环成立。工具级结论仍为 `engineering-capability-only`，因为可重复业务能力必须由当前策略 cohort 的真实任务重新验证。

产品级 v1 验收以当前策略 cohort 的可重复业务能力门禁为准，不能再由单个成功任务代替。
单任务仍必须由交付门禁返回 ready，或由验收报告明确记录 `acceptance.ready=true`；该条件只证明单任务交付，不等于工具级业务能力完成。

- 当前策略版本：`repeatable-business-v1`。
- 历史试验任务不会自动冒充当前产品能力，也不会永久污染新版预算覆盖率。
- 当前策略需要至少 20 个非内部真实任务，覆盖至少 4 类材料，完整交付成功率不低于 90%，预算覆盖率为 100%，成功任务平均独立恢复次数不高于 0.5。
- `npm run business:readiness` 会复用未变化任务的缓存结果，并报告 cohort、缓存命中和耗时。
- 服务默认只监听 `127.0.0.1`，拒绝非回环 Host 与跨站浏览器请求；如源码或构建在服务启动后变化，界面会提示重启。

## 重要边界

- `codex-ppt` 负责视觉统一的图片型 PPT。
- `image-to-editable-ppt/editppt` 负责对象级可编辑 PPT 重建。
- `gpt-image-2` 正常不代表对话模型或页面规格模型一定正常。
- OCR 只是文字提示和校对辅助，不是最终重建引擎。
- 外部图片 API 或页面模型调用前必须显式确认外部 API 额度和范围。
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
npm run business:readiness
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

EDITPPT_SKILL_ROOT=C:\Users\Administrator\.agents\skills\image-to-editable-ppt
EDITPPT_PYTHON_PATH=python
EDITPPT_RUN_ROOT=C:\Users\Administrator\AppData\Local\Temp\ppt-tool-editable-runs

PORT=4180
PPT_TOOL_HOST=127.0.0.1
PPT_TOOL_ALLOWED_ORIGINS=
```

前端不能暴露 API Key，只能显示脱敏状态。
`PPT_TOOL_HOST` 只接受 `127.0.0.1`、`localhost` 或 `::1`。当前版本不开放未经认证的局域网监听。

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
POST /api/workflow-cost-preview
GET  /api/business-readiness
GET  /api/workflow-jobs/:id/v1-readiness
GET  /api/workflow-jobs/:id/events
GET  /api/workflow-jobs/:id/logs/download
```
