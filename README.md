# PPT Agent

这是本地 PPT Agent 工作台，运行在：

```text
http://127.0.0.1:4180/
```

当前产品主线是 **Skill-first workflow**，围绕两套 Skill：

```text
原始 PPT / PDF / 图片 / brief
-> codex-ppt 生成视觉统一的图片型 PPT
-> image-to-editable-ppt / editppt 重建对象级可编辑 PPT
-> 质量检查、人工复核、失败恢复、交付门禁
-> 下载最终 editable-final.pptx
```

旧模板、旧本地生成器、passthrough、dry-run、本地纯文本重建都不能作为产品级主流程。

## 当前结论

当前工程方向是对的，但产品级 v1 还没有完成。

已完成或已验证：

- Skill-first 工作流框架已接入。
- `codex-ppt` 关卡、图片型 PPT、OCR、`image-to-editable-ppt/editppt`、页面 worker、finalize、交付门禁均已接入。
- 图片模型配置为 `gpt-image-2`，并已真实生成过 `page_001`、`page_002`。
- OCR 使用 `rapidocr-local`，15 页文本提示已生成，低置信度为 0。
- 当前真实 job `workflow_20260624-191529Z_b783f0` 已生成 2 页 `editable-final.pptx`。
- 当前 2 页最终 PPT 可被 PowerPoint 打开，并包含可编辑文本、形状和图片对象，没有整页截图冒充。

未完成：

- 当前 2 页 final 仍被交付门禁阻断，因为最终视觉 QA 需要人工复核。
- 当前只完成 2 页测试，不是完整 15 页产品验收。
- `workspace/v1-acceptance/latest-real-ppt-regression.json` 仍为 `acceptance.ready=false`。
- 前端仍偏工程控制台，后续要继续改成纯中文、低理解成本的 Agent 工作台。
- 仓库里仍有历史兼容/诊断代码，主流程不应再依赖旧模板。

## 重要边界

- `codex-ppt` 负责视觉统一的图片型 PPT。
- `image-to-editable-ppt/editppt` 负责对象级可编辑 PPT 重建。
- 图片模型和对话模型必须分开判断：`gpt-image-2` 正常不代表页面重建模型一定正常。
- OCR 只是辅助，不是最终重建引擎。
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

默认访问：

```text
http://127.0.0.1:4180/
```

开发模式：

```powershell
npm run dev
```

## 运行依赖

- Node.js
- Windows PowerPoint：用于源 PPT 渲染、PPTX 打开性检查和预览
- Python：用于 OCR 和 editppt 运行时
- `codex-ppt` Skill
- `image-to-editable-ppt` Skill / editppt CLI
- OpenAI-compatible LLM / Image API

环境检查：

```powershell
Invoke-RestMethod http://127.0.0.1:4180/api/doctor
Invoke-RestMethod http://127.0.0.1:4180/api/health
```

## 配置

在 `.env` 或项目已有配置中维护：

```text
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-5.5
OPENAI_IMAGE_MODEL=gpt-image-2
PAGE_SPEC_MODEL=gpt-4o
PROVIDER_TIMEOUT_MS=120000
PROVIDER_MAX_RETRIES=2
PROVIDER_CONCURRENCY=2

OCR_PROVIDER=rapidocr-local
OCR_PYTHON_PATH=python

EDITPPT_SKILL_ROOT=C:\Users\Administrator\.codex\skills\image-to-editable-ppt
EDITPPT_PYTHON_PATH=python
EDITPPT_RUN_ROOT=C:\Users\Administrator\AppData\Local\Temp\ppt-tool-editable-runs

PORT=4180
```

API Key 只能保存在后端环境配置中，前端只显示脱敏状态。

## 产品流程

正常产品流应尽量从前端完成，不要求用户理解 worker、manifest、hash 或 gate：

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
POST /api/workflow-jobs/:id/source/render
POST /api/workflow-jobs/:id/visual/sample
POST /api/workflow-jobs/:id/visual/generate
POST /api/workflow-jobs/:id/image-deck/assemble
POST /api/workflow-jobs/:id/editable/prepare
POST /api/workflow-jobs/:id/editable/prompts
POST /api/workflow-jobs/:id/editable/dispatch
POST /api/workflow-jobs/:id/editable/record
POST /api/workflow-jobs/:id/editable/finalize
GET  /api/workflow-jobs/:id/delivery-status
GET  /api/workflow-jobs/:id/cost-estimate
GET  /api/workflow-jobs/:id/v1-readiness
GET  /api/workflow-jobs/:id/events
GET  /api/workflow-jobs/:id/logs/download
```

Provider / 诊断：

```text
GET  /api/doctor
GET  /api/providers
POST /api/providers/test
```

v1 验收：

```text
GET  /api/v1-acceptance/latest
POST /api/v1-acceptance/run
POST /api/v1-acceptance/product-visual-readiness
POST /api/v1-acceptance/product-visual-sample/preflight
POST /api/v1-acceptance/product-visual-sample/prompt-preview
POST /api/v1-acceptance/product-visual-sample/run
POST /api/v1-acceptance/product-visual-sample/approval/preflight
POST /api/v1-acceptance/product-visual-sample/approval/approve
POST /api/v1-acceptance/product-visual-full-deck/approval/preflight
POST /api/v1-acceptance/product-visual-full-deck/approval/approve
POST /api/v1-acceptance/product-visual-full-deck/preflight
POST /api/v1-acceptance/product-visual-full-deck/run
```

## 产物目录

工作流产物位于：

```text
workspace/jobs/{workflowId}/
```

关键目录：

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

最终可编辑 PPTX：

```text
workspace/jobs/{workflowId}/final/editable-final.pptx
```

当前 2 页测试 final：

```text
workspace/jobs/workflow_20260624-191529Z_b783f0/final/editable-final.pptx
```

## 验证

每轮代码修改后至少执行：

```powershell
npm run check
npm run build
npm run regression:skill-first
```

涉及服务、路由、前端或交付门禁时再执行：

```powershell
Invoke-WebRequest http://127.0.0.1:4180/ -UseBasicParsing
Invoke-WebRequest http://127.0.0.1:4180/api/health -UseBasicParsing
```

真实 15 页验收：

```powershell
npm run regression:real-ppt -- --source "C:\path\to\deck.pptx" --max-pages 15
```

报告位置：

```text
workspace/v1-acceptance/latest-real-ppt-regression.json
```

只有报告中的 `acceptance.ready=true`，才能声明产品级 v1 验收通过。

## 当前下一步

优先级从高到低：

1. 把前端交付区改成清楚的“最终 PPT 已生成，等待人工视觉复核”。
2. 在复核区展示目标图、可编辑预览、联系表，并提供确认复核入口。
3. 完成当前 2 页小样本复核，让交付门禁刷新。
4. 继续隐藏或移除旧模板和旧本地生成器入口。
5. 将首页改成纯中文 Agent 工作台。
6. 完成真实 15 页产品验收。

更多细节见：

```text
docs/product-goal.md
```
