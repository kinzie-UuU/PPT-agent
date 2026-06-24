# 第三阶段 Provider Adapter 交付记录

## 目标

第三阶段把运行时 AI 能力从业务流程里抽出来，形成统一 Provider 层。

产品运行时不依赖 Codex 内部能力，统一通过外接 Provider：

```text
LLM Provider
Image Provider
OCR Provider
```

## 配置项

兼容旧变量，并新增统一控制项：

```text
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4.1-mini
OPENAI_IMAGE_MODEL=gpt-image-1
PROVIDER_TIMEOUT_MS=120000
PROVIDER_MAX_RETRIES=2
PROVIDER_CONCURRENCY=2
OCR_PROVIDER=rapidocr-local
OCR_PYTHON_PATH=python
```

API Key 只在后端读取，前端只拿到：

```text
hasApiKey
maskedApiKey
```

## 新增模块

```text
server/providers.js
```

能力：

- 统一读取 Provider 配置。
- LLM 连接测试。
- LLM 模型列表检测。
- Image Provider dry-run 测试。
- Image Provider 真实生图探针，默认不启用，避免误花费。
- Image Provider 支持 `b64_json` 和 `url` 两种返回。
- OCR Provider 本地 RapidOCR runtime 检测。
- Provider 请求统一 timeout / retry。

## 新增/扩展 API

```text
GET  /api/providers
POST /api/providers/test
GET  /api/config
POST /api/config
POST /api/config/test
POST /api/config/models
GET  /api/health
```

`/api/providers/test` 示例：

```json
{
  "target": "all"
}
```

单项测试：

```json
{ "target": "llm" }
{ "target": "image" }
{ "target": "ocr" }
```

Image Provider 默认 dry-run，不生成图片：

```json
{
  "target": "image"
}
```

如需真实生成探针图，显式传：

```json
{
  "target": "image",
  "generateProbe": true
}
```

## 已接入旧能力

- `server/cloudImage.js` 已改为调用统一 Image Provider。
- 旧 `/api/config/test` 已改为调用 LLM Provider。
- 旧 `/api/config/models` 已改为调用 LLM Provider 模型列表。
- `/api/health` 增加 Provider 摘要。

## 后续接入点

第四阶段源文件导入与页面导出不需要调用 Provider。

第五阶段视觉统一重绘应调用：

```text
generateImageWithProvider()
```

第六阶段 OCR 应调用：

```text
OCR_PROVIDER=rapidocr-local
OCR_PYTHON_PATH=...
```

并将 OCR 结果写入：

```text
workspace/jobs/{jobId}/ocr/
```
