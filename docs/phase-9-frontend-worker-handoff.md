# 第九阶段 Frontend Worker Handoff 交付记录

## 目标

把第八阶段的 page worker 编排能力接到 4180 前端，让用户能在产品界面里看到：

```text
worker prompt
-> 复制/交给真实 page worker
-> 登记真实 worker dispatch
-> 记录 worker 结果
-> finalize
```

本阶段只做交接控制面和只读 prompt 展示，不在父流程内伪造页面重建产物。

## 新增后端能力

新增只读 API：

```text
GET /api/workflow-jobs/:id/editable/prompts
```

返回内容：

- `runDir`
- `status`
- `next`
- `prompts[]`
- 每个 prompt 的 `pageId`、`promptFile`、`relativePath`、`content`、`truncated`

该接口只读取已生成的 `worker-prompt.md`，不会写入 `manifest.json`、`page.pptx`、`preview.png`、`validation.json` 等 page worker 产物。

## 新增前端能力

在生成页的“图片到可编辑 PPT 工作流”面板中新增：

- 固定显示 worker 交接台骨架
- `读取 Prompt`
- 页面选择
- `Agent ID` 输入
- “已真实启动该 page worker”确认
- `复制 Prompt`
- `登记真实 Worker`
- `记录页面完成`
- prompt 内容预览

没生成 prompt 时，交接按钮保持禁用，只显示“等待 Prompt”，避免误操作。

## 安全边界

前端登记派发时必须勾选“已真实启动该 page worker”。

后端仍保留第八阶段 guard：

```text
editable/dispatch without spawned=true or confirmSpawned=true -> 400
```

这保证父流程不能把未真实启动的 worker 伪装成已派发。

## 已验证

```text
npm.cmd run build
npm.cmd run check
npm.cmd run audit:entrypoints
```

入口审计结果：

```text
rootDir: E:\PPT工具
server routes: 63
GET /api/workflow-jobs/:id/editable/prompts present
dist looks like Vite React build: yes
```

浏览器验证：

```text
http://localhost:4180/
生成页存在 workflow 面板
存在 worker console
存在 读取 Prompt
存在 登记真实 Worker
存在 记录页面完成
无 prompt 时按钮禁用
```

## 仍未完成

真实 page worker runner 还没有接入。因此完整闭环仍停在：

```text
worker prompt -> 等待真实 worker 重建页面
```

下一阶段应实现或接入真实 runner：

1. 创建真实 page worker。
2. worker 读取 `worker-prompt.md`。
3. worker 按 image-to-editable-ppt skill 写入页面产物。
4. 父流程调用 `editable/record`。
5. 全部页面 recorded 后调用 `editable/finalize`。
6. 前端展示最终 `editable-final.pptx` 下载和验证报告。
