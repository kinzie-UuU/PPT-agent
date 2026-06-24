# 第二阶段 Job Orchestrator 交付记录

## 目标

第二阶段先建立产品级长流程任务基座，不直接改造旧 `/api/jobs`。

新的工作流任务用于承载后续完整链路：

```text
上传源文件
-> 页面导出
-> 视觉统一重绘
-> 图片型 PPT
-> OCR
-> editppt 可编辑重建
-> validation
-> final export
```

## 任务目录

所有新工作流任务写入：

```text
workspace/jobs/{workflowJobId}/
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

`workflowJobId` 是 ASCII，例如：

```text
workflow_20260616-091234Z_a1b2c3
```

原始中文文件名只保存在 `state.json` 的展示字段里，运行路径保持 ASCII。

## 状态模型

阶段顺序：

```text
created
source_ready
source_rendered
visual_sample_ready
visual_generating
image_deck_ready
ocr_ready
editable_prepared
pages_running
finalizing
complete
```

阶段状态：

```text
pending
running
complete
failed
skipped
```

页面状态：

```text
pending
running
recorded
failed
retrying
```

## 新增 API

```text
GET   /api/workflow-jobs/meta
GET   /api/workflow-jobs
POST  /api/workflow-jobs
GET   /api/workflow-jobs/:id
PATCH /api/workflow-jobs/:id/stage
PATCH /api/workflow-jobs/:id/pages/:pageNumber
POST  /api/workflow-jobs/:id/events
```

创建任务示例：

```json
{
  "sourceUploadId": "file_xxx",
  "mode": "ppt-rebuild",
  "notes": "first product workflow test"
}
```

如果传入 `sourceUploadId`，系统会把上传文件复制到：

```text
workspace/jobs/{workflowJobId}/input/source.{ext}
```

并把 `source_ready` 标记为 `complete`。

## 已完成能力

- 独立于旧 `/api/jobs` 的新工作流任务系统。
- 可恢复：服务重启后从 `workspace/jobs/*/state.json` 扫描恢复。
- 可追踪：每个任务都有 `events`、`errors`、`stages`、`pages`。
- 可落盘：每次状态更新同时写 `state.json` 和 `manifest.json`。
- 可重试基础：页面状态支持 `failed` 和 `retrying`。
- 安全约束：任务记录包含不覆盖原文件、ASCII 运行路径、可恢复状态、页面级重试标记。
- 健康接口增加 `workflowRootDir`。

## 后续接入点

第三阶段 Provider Adapter 应直接读写 workflow job：

- 生图 Provider 写入 `visual-images/`
- OCR Provider 写入 `ocr/`
- 图片型 PPT 组装写入 `image-deck/`
- editppt Runner 写入 `editable-run/`
- 最终结果写入 `final/`
