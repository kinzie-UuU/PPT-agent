# 第六阶段 OCR Text Hints 交付记录

## 目标

第六阶段读取 workflow 的视觉图片，生成本地 OCR 文字提示。

输入优先级：

```text
job.artifacts.visualImages
fallback: job.artifacts.renderedPages
```

输出：

```text
workspace/jobs/{jobId}/ocr/
  page_001/ocr.json
  page_002/ocr.json
  text_hints.json
```

## 新增模块

```text
server/workflowOcr.js
```

职责：

- 调用本地 RapidOCR。
- 每页生成 `ocr.json`。
- 汇总生成 `text_hints.json`。
- 标记低置信度文字。
- 写回 workflow job 的 `artifacts`、`pages`、`stages`、`events`。

## 新增 API

```text
POST /api/workflow-jobs/:id/ocr/run
```

请求示例：

```json
{
  "minConfidence": 0.35
}
```

## text_hints.json

核心结构：

```json
{
  "version": 1,
  "jobId": "workflow_xxx",
  "backend": "rapidocr-local",
  "ocrBackend": {
    "name": "rapidocr-onnxruntime",
    "mode": "local-open-source",
    "pythonPath": "..."
  },
  "summary": {
    "pageCount": 1,
    "textCount": 12,
    "lowConfidenceCount": 2,
    "errorCount": 0
  },
  "pages": [
    {
      "pageId": "page_001",
      "requiredText": ["..."],
      "ocrLines": [
        {
          "id": "O001",
          "text": "...",
          "confidence": 0.98,
          "low_confidence": false,
          "box_px": [0, 0, 100, 30],
          "polygon_px": [[0, 0], [100, 0], [100, 30], [0, 30]],
          "font_pt_if_cjk": 17.4
        }
      ]
    }
  ]
}
```

## 状态更新

成功：

```text
currentStage: ocr_ready
stageStatus: complete
artifacts.ocrTextHints
artifacts.ocrPages
```

失败：

```text
currentStage: ocr_ready
stageStatus: failed
errors[]
```

## 后续接入点

第七阶段 image-to-editable-ppt 应读取：

```text
job.artifacts.imageDeck.path
job.artifacts.ocrTextHints.path
```

并把重建运行目录写入：

```text
workspace/jobs/{jobId}/editable-run/
```
