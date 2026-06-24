# 第八阶段 Page Worker Orchestration 交付记录

## 目标

第八阶段把 `editppt` 的页面级状态机接入产品后端：

```text
editppt run next
-> build worker prompt
-> dispatch real page worker
-> record worker result
-> finalize final editable PPTX
```

本阶段重点是父流程编排，不在父进程内重建页面。

## 新增后端能力

扩展模块：

```text
server/workflowEditable.js
```

新增 API：

```text
POST /api/workflow-jobs/:id/editable/prompts
POST /api/workflow-jobs/:id/editable/dispatch
POST /api/workflow-jobs/:id/editable/record
POST /api/workflow-jobs/:id/editable/finalize
```

已存在并继续使用：

```text
POST /api/workflow-jobs/:id/editable/prepare
GET  /api/workflow-jobs/:id/editable/status
POST /api/workflow-jobs/:id/editable/next
```

## Prompt 生成

`editable/prompts` 会读取 `editppt run next --json`。

只有当 next stage 是：

```text
dispatch_pages
```

才会调用 skill-local 脚本：

```text
scripts/build-page-worker-prompt.py
```

产物：

```text
{ascii-run}/pages/page_001/worker-prompt.md
```

workflow artifact：

```text
artifacts.editableWorkerPrompts[]
```

## Dispatch 边界

`editable/dispatch` 只记录真实 worker 分发。

请求必须包含：

```json
{
  "pageId": "page_001",
  "agentId": "real-worker-id",
  "promptFile": ".../worker-prompt.md",
  "spawned": true
}
```

如果没有 `spawned: true` 或 `confirmSpawned: true`，后端会拒绝：

```text
Refusing to dispatch without spawned=true.
```

这是为了符合 `image-to-editable-ppt` skill：`editppt run dispatch` 不能被用来伪造 worker 状态。

## Record

`editable/record` 调用：

```text
editppt run record {run} --page page_001 --agent-id {agentId}
```

它依赖真实 page worker 已经写入：

```text
manifest.json
imagegen-jobs.json
page.pptx
preview.png
split_assets_contact.png
validation.json
page_result.json
```

`record` 会验证：

- `validation.json` 顶层 `passed: true`
- `page.pptx` 与 `manifest.json` 坐标/对象合同一致
- 必要产物存在并可被记录

失败时不允许父流程手改页面产物，应 reset 后重新分发 worker。

## Finalize

`editable/finalize` 调用：

```text
editppt run finalize {run}
```

仅当所有页面已 `recorded` 才会成功。

成功后会把 ASCII scratch run 中的最终文件复制到 workflow 交付目录：

```text
workspace/jobs/{jobId}/final/editable-final.pptx
workspace/jobs/{jobId}/final/editable-validation.json
```

并写入：

```text
artifacts.editableFinal
```

同时会用本项目的 OpenXML 检查器生成 `pptxEditability` 摘要。

## 已验证

已验证语法与项目检查：

```text
npm.cmd run check
```

已验证 API smoke：

```text
upload image
-> workflow create
-> source/render
-> visual/generate dryRun
-> image-deck/assemble
-> ocr/run
-> editable/prepare
-> editable/prompts
```

结果：

```text
promptCount: 1
prompt: C:\Users\Administrator\AppData\Local\Temp\ppt-tool-editable-runs\{jobId}\run\pages\page_001\worker-prompt.md
```

已验证 guard：

```text
editable/dispatch without spawned=true -> 400
```

## 当前未完成

还没有真正 spawn page worker，因此没有执行：

```text
dispatch -> worker rebuild -> record -> finalize
```

这是预期状态，不是后端 API 缺口。下一步需要用户明确允许使用 sub-agent/page worker，或实现产品自己的 worker runner。

## 下一步

第九阶段建议：

1. 接入真实 page worker 调度。
2. worker 读取 `worker-prompt.md` 并按 skill 写页面产物。
3. 父流程调用 `editable/dispatch`。
4. worker 完成后父流程调用 `editable/record`。
5. 所有页面 recorded 后调用 `editable/finalize`。
6. 前端显示每页 worker 状态、失败原因、重试入口和最终 PPTX 下载。
