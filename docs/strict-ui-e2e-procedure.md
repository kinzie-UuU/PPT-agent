# 严格 UI E2E 复跑说明

## 前置条件

1. 在项目根目录运行 `npm.cmd run build`。
2. 使用最新源码启动 `http://127.0.0.1:4180/`。
3. 确认阻断态验收任务 `workflow_20260804-094558Z_162643` 仍保留 20 页图片和 1 页可编辑结果。
4. 最新性能证据必须为 `pass`，且其构建指纹与最终构建一致。

## 执行

```powershell
npm.cmd run evidence:strict-ui
```

该命令使用 `@playwright/cli` 启动独立 Chromium，会真实执行以下操作：

- 搜索并选择验收任务。
- 打开新建任务面板，再点击已有任务返回。
- 拦截本地大纲请求，检查请求期间上传和需求输入被锁定、任务侧栏仍可切换、响应后仍留在 V2 工作台并显示紧凑大纲。
- 切换图片版和可编辑版。
- 打开整套图片复核并检查 20 页、60 张图片及门禁按钮。
- 打开可编辑复核并检查 20 个页面通过按钮均受质量证据约束。
- 检查 blocked 任务不暴露最终可编辑 PPT 下载。
- 创建一个不调用外部模型的 1 页 synthetic ready 控制面夹具，从任务列表点击进入，检查最终下载入口并真实点击下载。
- 检查 1200、1181 和 390px 视口无横向裁切。
- 截取阻断态桌面、整套图片复核、390×844 手机视图和 synthetic ready 交付态。
- 保存 Playwright trace、浏览器版本、运行日志、控制台和失败请求。
- 对比浏览器实际加载的 JS/CSS 与 `dist/index.html` 当前引用。
- 验证截图和 trace 的修改时间晚于最终构建。

## 证据

- `workspace/delivery-evidence/strict-ui-e2e/latest.json`
- `workspace/delivery-evidence/strict-ui-e2e/latest.md`
- `workspace/delivery-evidence/strict-ui-e2e/capture.json`
- `workspace/delivery-evidence/strict-ui-e2e/trace-latest.zip`
- `workspace/delivery-evidence/strict-ui-e2e/playwright-run.log`
- `workspace/delivery-evidence/strict-ui-e2e/workspace-desktop-latest.png`
- `workspace/delivery-evidence/strict-ui-e2e/image-review-latest.png`
- `workspace/delivery-evidence/strict-ui-e2e/workspace-mobile-latest.png`
- `workspace/delivery-evidence/strict-ui-e2e/workspace-ready-latest.png`

正确自动结果是 `dual-state-pass`：历史任务仍然 blocked，synthetic ready 夹具证明控制面、交付门禁和下载闭环可用。synthetic 夹具不代表外部生图质量，不能冒充真实产品 PPT 已 ready；运行后会自动归档。
