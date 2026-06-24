# 第五阶段 Visual Redraw 与图片型 PPT 交付记录

## 目标

第五阶段基于 workflow job 的 `rendered-pages` 生成视觉统一的图片型中间稿，并组装为 image-based PPTX。

链路：

```text
rendered-pages
-> visual_prompts.json
-> visual-images/page_001...
-> image-deck/image-based-deck.pptx
```

## 新增模块

```text
server/workflowVisuals.js
```

职责：

- 为每页生成统一风格 prompt。
- 生成单页样张。
- 批量生成 visual images。
- 组装 image-based PPTX。
- 更新 workflow job 状态、pages、artifacts、events。

## 新增 API

```text
POST /api/workflow-jobs/:id/visual/sample
POST /api/workflow-jobs/:id/visual/generate
POST /api/workflow-jobs/:id/image-deck/assemble
```

### 生成样张

```json
{
  "pageNumber": 1,
  "styleBrief": "现代专业中文商业演示风格"
}
```

### 批量生成

```json
{
  "pages": "1-5",
  "styleBrief": "现代专业中文商业演示风格"
}
```

不传 `pages` 时默认全部页面。

### 安全 dry-run

为避免测试时误产生生图费用，支持：

```json
{
  "dryRun": true
}
```

dry-run 会把 source rendered page passthrough 到 visual image 位置，并标记：

```text
provider: passthrough
dryRun: true
```

## 输出目录

```text
workspace/jobs/{jobId}/visual-images/
  visual_prompts.json
  sample_page_001.png
  page_001.png
  page_002.png

workspace/jobs/{jobId}/image-deck/
  image-based-deck.pptx
```

## 状态更新

样张成功：

```text
currentStage: visual_sample_ready
stageStatus: complete
artifacts.visualSample
artifacts.visualPrompts
```

整套图成功：

```text
currentStage: image_deck_ready
stageStatus: complete 或 running
artifacts.visualImages
```

组装 PPT 成功：

```text
currentStage: image_deck_ready
stageStatus: complete
artifacts.imageDeck
```

## 后续接入点

第六阶段 OCR 应读取：

```text
job.artifacts.visualImages
```

并写入：

```text
workspace/jobs/{jobId}/ocr/
```

第七阶段 image-to-editable-ppt 应优先使用：

```text
job.artifacts.imageDeck.path
```
