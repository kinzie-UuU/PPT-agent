# 第四阶段 Source Rendering 交付记录

## 目标

第四阶段把 workflow job 的源文件标准化为逐页页面图片。

输出目录：

```text
workspace/jobs/{jobId}/rendered-pages/
workspace/jobs/{jobId}/source/source_meta.json
```

## 新增模块

```text
server/sourceRenderer.js
```

职责：

- 读取 workflow job 的 `artifacts.source`。
- 根据源文件类型执行页面渲染。
- 写入 `rendered-pages/page_001...`。
- 写入 `source/source_meta.json`。
- 更新 workflow job：
  - `artifacts.sourceMeta`
  - `artifacts.renderedPages`
  - `pages`
  - `stages.source_rendered`

## 新增 API

```text
POST /api/workflow-jobs/:id/source/render
```

成功后，job 进入：

```text
status: source_rendered
currentStage: source_rendered
stageStatus: complete
```

## 当前支持范围

已支持：

- `.pptx`
  - 使用 PowerPoint COM 导出 PNG。
  - 输出 `page_001.png`、`page_002.png` 等。
- `.ppt`
  - 按 PowerPoint COM 路径尝试。
- 图片输入：
  - `.png`
  - `.jpg`
  - `.jpeg`
  - `.webp`
  - `.svg`
  - 当前为 passthrough，不强行转 PNG。

暂未支持：

- `.pdf`
  - 当前环境没有 `pdftoppm`、ImageMagick、Ghostscript 或 LibreOffice。
  - PDF 会明确写入 failed 状态和 `pdf-renderer-not-configured` warning。
  - 后续可接 Poppler 或 LibreOffice 后启用。

## source_meta.json

示例结构：

```json
{
  "version": 1,
  "ok": true,
  "jobId": "workflow_xxx",
  "renderer": "powerpoint-com",
  "source": {
    "originalName": "source.pptx",
    "path": "...",
    "size": 123,
    "sha256": "..."
  },
  "pageCount": 15,
  "pages": [
    {
      "pageId": "page_001",
      "pageNumber": 1,
      "path": ".../rendered-pages/page_001.png",
      "width": 1920,
      "height": 1080
    }
  ],
  "warnings": []
}
```

## 后续接入点

第五阶段视觉统一重绘应读取：

```text
job.artifacts.renderedPages
```

并把生成图写入：

```text
workspace/jobs/{jobId}/visual-images/
```
