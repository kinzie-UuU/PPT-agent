# 第十阶段 Worker Runner Queue 交付记录

## 目标

把 page worker 从“人工复制 prompt”推进到“可被真实 runner 领取的任务队列”。

本阶段仍不在父流程中重建页面，只提供产品级 runner 协议：

```text
prompt -> sync task -> worker claim -> heartbeat -> worker writes page artifacts -> complete(record)
```

## 新增后端模块

```text
server/workflowWorkerQueue.js
```

职责：

- 从 `editableWorkerPrompts` 同步 `editableWorkerTasks`
- 维护 page worker 任务状态
- 让真实 worker claim 任务
- 让真实 worker heartbeat
- worker 完成后调用 `editppt run record`
- record 失败时标记任务 failed，但不伪造页面产物

## 新增 API

```text
GET  /api/workflow-jobs/:id/editable/worker-tasks
POST /api/workflow-jobs/:id/editable/worker-tasks/sync
POST /api/workflow-jobs/:id/editable/worker-tasks/:pageId/claim
POST /api/workflow-jobs/:id/editable/worker-tasks/:pageId/heartbeat
POST /api/workflow-jobs/:id/editable/worker-tasks/:pageId/complete
```

### Claim

`claim` 代表真实 worker 已经启动并领取任务，因此后端会调用：

```text
editppt run dispatch
```

请求示例：

```json
{
  "agentId": "real-page-worker-001",
  "workerName": "runner-a"
}
```

### Complete

`complete` 代表 worker 已经把页面产物写入 page 目录，因此后端会调用：

```text
editppt run record
```

如果缺少 `manifest.json`、`page.pptx`、`preview.png`、`validation.json` 等真实 worker 产物，record 会失败，任务状态会变为 `failed`。

## 前端新增能力

在生成页 worker console 中新增：

- `同步任务队列`
- `刷新队列`
- `领取并登记`
- 任务摘要：总数、待领取、运行中、已记录
- 每页任务状态列表

无 prompt 时按钮禁用，显示：

```text
等待同步 worker task。
```

## 验证

```text
npm.cmd run check
npm.cmd run build
npm.cmd run audit:entrypoints
```

审计结果：

```text
server routes: 68
worker-tasks routes present
rootDir: E:\PPT工具
```

浏览器验证：

```text
生成页存在 worker console
存在 同步任务队列
存在 刷新队列
存在 领取并登记
存在 任务摘要
存在 任务列表
无 prompt 时按钮禁用
```

## 仍未完成

还没有真正的 worker 执行器进程。

下一阶段需要实现 runner：

1. runner 读取 `/worker-tasks`。
2. runner claim 某一页。
3. runner 使用 `worker-prompt.md` 和 image-to-editable-ppt skill 重建页面。
4. runner 写入 page 目录真实产物。
5. runner 调用 complete。
6. 父流程在全部 recorded 后 finalize。
