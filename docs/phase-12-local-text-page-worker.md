# 第十二阶段 Local Text Page Worker 交付记录

## 目标

提供一个可被 runner 启动的最小真实 page worker，让系统从“只能交接给外部 worker”推进到“至少可执行文本型页面重建”。

## 新增脚本

```text
scripts/local-page-worker.mjs
```

新增 npm script：

```text
npm.cmd run lab:local-page
```

## 工作方式

该 worker 读取 runner 传入的环境变量：

```text
PPT_WORKER_RUN_DIR
PPT_WORKER_PAGE_DIR
PPT_WORKER_PAGE_ID
```

然后：

1. 读取 `page_request.json`。
2. 读取 `workflow_rapidocr_text_hints.json`。
3. 从 OCR lines 生成 `text_boxes`。
4. 写入 page-local `manifest.json`。
5. 保留或创建 `imagegen-jobs.json`。
6. 调用：

```text
editppt page build {pageDir}
editppt page contact-sheet {pageDir}
editppt page validate {pageDir} --report validation.json
```

7. 写入 `page_result.json`。

## 安全边界

该 worker 是保守的文本型 worker：

- 没有 OCR lines 时失败。
- strict 模式下有低置信度 OCR lines 时失败。
- 不做复杂前景图片分离。
- 不把源图整页塞进 PPT 当背景。
- 不把复杂视觉页伪装成已通过。

因此它适用于：

- 文本为主的页面
- 简单白底或浅色背景页面
- 需要先跑通 runner/record/finalize 链路的产品验证

不适用于：

- 大量图片/Logo/图标/产品图页面
- 需要 image edit asset-sheet 分离的视觉页
- 高保真复杂设计还原

## 前端补充

生成页 Runner 命令现在默认包含：

```text
--command "npm.cmd run lab:local-page"
```

用户复制后可直接运行本地文本型 worker。复杂页面后续仍应接入完整视觉 worker。

## 仍未完成

产品级完整 worker 还需：

1. 图像前景资产分离。
2. clean base / asset sheet 的 `editppt image` 调用。
3. 复杂形状、表格、图标、产品图重建。
4. 多页并发调度。
5. 失败页 reset / retry 策略。

## 验证

已验证失败边界：

```text
无 workflow_rapidocr_text_hints.json
-> worker 退出码 2
-> 写入 validation.json passed=false
-> 写入 page_result.json
```

已验证正向文本页：

```text
临时 source.png + workflow_rapidocr_text_hints.json
-> manifest.json
-> page.pptx
-> preview.png
-> split_assets_contact.png
-> validation.json passed=true
-> page_result.json
```

同时通过：

```text
npm.cmd run check
npm.cmd run build
```
