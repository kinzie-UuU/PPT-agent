# 第一阶段入口体检记录

## 结论

`E:\PPT工具` 的产品入口应以本仓库为准：

- 后端入口：`server/index.js`
- 本地启动：`npm run local`
- 默认端口：`4180`
- 前端源码入口：`src/main.jsx`
- 生产前端产物：`dist/index.html`

当前 `http://127.0.0.1:4180/` 被另一个目录的服务占用：

```text
E:\大品PPT模板工具\run_ppt_web_stable.py
```

所以浏览器里看到的“可编辑 PPT 重制工具”不是本仓库 `E:\PPT工具` 当前服务出来的 React 工作台。

## 当前仓库入口状态

`package.json` 中的核心脚本：

```text
npm run dev    -> node server/index.js
npm run local  -> scripts/start-local.ps1
npm run build  -> vite build
```

`server/index.js` 的静态前端策略：

```text
如果 dist/index.html 存在：
  serve dist/
否则：
  返回 Frontend build is missing
```

这意味着当前项目不是 Vite dev server 双服务模式，而是 Express 统一服务后端 API 和构建后的前端。

## 已发现的不一致

- `4180` 当前运行态来自 `E:\大品PPT模板工具`，不是 `E:\PPT工具`。
- 旧页面调用的接口包括 `/api/state`、`/api/init`、`/api/files`、`/api/generate-sample-editable` 等。
- 当前仓库 `server/index.js` 的接口是另一套 React 工作台 API，例如 `/api/jobs`、`/api/uploads`、`/api/config`、`/api/jobs/:id/export`。
- `docs/product-goal.md` 和 `data/jobs.json` 中存在历史 mojibake 内容，需要后续单独清理或迁移，不能作为新产品状态源。

## 已完成的第一阶段修正

- `scripts/start-local.ps1` 已改为严格校验 `/api/health`：
  - 必须返回 JSON；
  - 必须包含 `ok` 和 `pid`；
  - 如果返回了 `rootDir`，必须等于当前仓库根目录；
  - 否则视为端口被其他服务占用。
- 新增 `npm run audit:entrypoints`：
  - 输出启动脚本；
  - 输出当前端口占用进程；
  - 输出 `/api/health` 是否属于本仓库；
  - 输出 `server/index.js` 路由；
  - 输出 `src` 与 `dist` 中引用的 API；
  - 标记 `dist` 中没有对应后端路由的 API。

## 后续第一阶段收尾标准

第一阶段完全收尾时，应满足：

- 关闭或换端口运行 `E:\大品PPT模板工具` 的 Python 服务。
- `npm run local` 能启动 `E:\PPT工具` 自己的服务。
- `npm run audit:entrypoints` 显示 `/api/health belongs to this repo: yes`。
- 打开 `http://127.0.0.1:4180/` 时看到的是本仓库 React 工作台。
- 旧工作流页面不再占用本项目默认端口。
