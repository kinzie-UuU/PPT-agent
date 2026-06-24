# 第七阶段 Editable Runner 交付记录

## 目标

第七阶段把前面生成的视觉统一页面图与 OCR 提示接入 `image-to-editable-ppt` 的 `editppt` 运行面。

当前阶段只做父流程编排：

```text
visualImages
+ ocr/text_hints.json
-> editppt prepare
-> editable_run
-> editppt run next/status
```

页面级重建仍必须由后续 page worker 完成，父流程不手写 `manifest.json`、`page.pptx`、`preview.png`、`validation.json` 或 `page_result.json`。

## 新增模块

```text
server/workflowEditable.js
```

职责：

- 检测 `editppt` runtime。
- 调用 skill-local CLI：`python -m editppt.cli ...`。
- 将 `job.artifacts.visualImages` 准备为 `editppt prepare` 输入。
- 复制第六阶段 `ocr/text_hints.json` 为 run-level `workflow_rapidocr_text_hints.json`。
- 写回 workflow job 的 `artifacts`、`stages`、`events`。

## 新增 API

```text
POST /api/workflow-jobs/:id/editable/doctor
POST /api/workflow-jobs/:id/editable/prepare
GET  /api/workflow-jobs/:id/editable/status
POST /api/workflow-jobs/:id/editable/next
```

prepare 请求示例：

```json
{
  "force": true,
  "maxConcurrentPages": 6
}
```

## Windows 路径策略

`E:\PPT工具` 是非 ASCII 路径。实测 `editppt prepare --job-dir E:\PPT工具\...` 会在 Python/Windows 命令链里出现路径乱码，导致找不到 `deck_manifest.json`。

因此第七阶段采用 ASCII scratch run：

```text
C:\Users\Administrator\AppData\Local\Temp\ppt-tool-editable-runs\{jobId}\run
```

workflow 目录仍保留 pointer：

```text
workspace/jobs/{jobId}/editable-run/editable_run_pointer.json
```

pointer 记录：

- live run path
- copied ASCII input paths
- original visual image paths
- runtime python/skill root
- rapid OCR hints path
- editppt next/status 摘要

## 输出状态

成功：

```text
currentStage: editable_prepared
stageStatus: complete
artifacts.editableRun.path: ASCII scratch run
artifacts.editableRun.workspacePointerPath
artifacts.editableRun.rapidOcrHintsPath
```

`editable/next` 当前期望返回：

```text
stage: dispatch_pages
```

这表示第八阶段应进入 page worker 分发，而不是父进程自行重建页面。

## Runtime 状态

当前本地可通过 OCR venv 启动 skill-local CLI：

```text
outputs/skill-duo-test/ocr-venv/Scripts/python.exe -m editppt.cli ...
```

`editppt doctor` 目前会提示部分可选依赖缺失：

```text
fitz: false
openai: false
requests: false
```

对当前 image prepare smoke 不构成阻塞。PDF/PPTX 直接 prepare、云端 image generate/edit、以及更完整的 page worker 流程需要后续补齐运行环境或改为配置化安装。

## 验证记录

已验证：

```text
npm.cmd run check
```

已验证端到端 smoke：

```text
upload image
-> workflow create
-> source/render
-> visual/generate dryRun
-> image-deck/assemble
-> ocr/run
-> editable/prepare
-> editable/status
-> editable/next
```

结果：

```text
editableStage: editable_prepared
pageCount: 1
nextStage: dispatch_pages
run: C:\Users\Administrator\AppData\Local\Temp\ppt-tool-editable-runs\{jobId}\run
```

## 后续接入点

第八阶段应实现：

```text
editppt run next
-> build page-worker prompt
-> spawn page worker
-> editppt run dispatch
-> editppt run record
-> editppt run finalize
```

必须遵守 `image-to-editable-ppt` skill：

- 父流程只编排，不写页面重建产物。
- 每页必须由独立 page worker 生成 manifest/page.pptx/preview/validation/result。
- `run record` 失败时 reset 后重新分发，不能手改状态文件。
