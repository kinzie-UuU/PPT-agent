# 第十一阶段 Page Worker Runner CLI 交付记录

## 目标

在第十阶段 worker task API 之上，提供一个最小独立 runner CLI，让真实 worker 可以被产品流程启动和追踪。

runner 只做编排：

```text
sync task -> select prompt -> start external worker command -> claim(dispatch) -> heartbeat -> complete(record)
```

runner 不生成页面产物，不写入 `manifest.json`、`page.pptx`、`preview.png`、`validation.json` 或 `page_result.json`。

## 新增脚本

```text
scripts/page-worker-runner.mjs
```

新增 npm script：

```text
npm.cmd run worker:once
```

## 配置

`.env.example` 新增：

```text
PPT_TOOL_BASE_URL=http://127.0.0.1:4180
PPT_PAGE_WORKER_COMMAND=
```

`PPT_PAGE_WORKER_COMMAND` 是真实 page worker 命令。runner 会通过环境变量把当前任务传给它：

```text
PPT_WORKFLOW_JOB_ID
PPT_WORKER_AGENT_ID
PPT_WORKER_PAGE_ID
PPT_WORKER_PROMPT_FILE
PPT_WORKER_PAGE_DIR
PPT_WORKER_RUN_DIR
PPT_WORKER_PROMPT_RELATIVE_PATH
```

## 用法

使用 `.env` 中的 `PPT_PAGE_WORKER_COMMAND`：

```powershell
npm.cmd run worker:once -- --job-id workflow_xxx --agent-id worker-001 --page page_001
```

临时传入外部 worker 命令：

```powershell
npm.cmd run worker:once -- --job-id workflow_xxx --agent-id worker-001 --page page_001 --command "your-real-worker-command"
```

只打印 prompt，不 dispatch：

```powershell
node scripts/page-worker-runner.mjs once --job-id workflow_xxx --agent-id worker-001 --page page_001 --print-prompt
```

只登记已真实启动的 worker：

```powershell
node scripts/page-worker-runner.mjs once --job-id workflow_xxx --agent-id worker-001 --page page_001 --claim-only
```

`claim-only` 只能在真实 worker 已经启动后使用。

## 前端补充

生成页 worker console 新增：

- `复制 Runner 命令`
- Runner 命令预览

命令默认形态：

```text
npm.cmd run worker:once -- --job-id {workflowId} --agent-id {agentId} --page {pageId}
```

## 安全边界

runner 在外部 worker 进程 `spawn` 成功后才调用 task claim。claim 会调用后端 `editppt run dispatch`。

外部 worker 命令退出码为 0 后，runner 调用 task complete。complete 会调用后端 `editppt run record`，由 `editppt` 验证页面产物。

如果外部 worker 没有写入真实产物，record 会失败，任务不会被标记为 recorded。

## 仍未完成

还缺真实 worker 命令本身，也就是实际执行 `worker-prompt.md`、重建页面对象、写入页面产物的执行器。

下一阶段可选方向：

1. 接入 Codex/多 Agent worker。
2. 接入外部 LLM worker 服务。
3. 接入本地 worker CLI，按 prompt 调用模型和 editppt image 工具完成页面重建。
