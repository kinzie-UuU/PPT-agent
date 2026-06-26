# PPT Agent 当前问题与后续计划

更新时间：2026-06-25

## 目标

把本地 `E:\PPT工具` 做成围绕两套 Skill 的 PPT Agent，而不是旧模板生成器：

```text
上传 PPT / PDF / 图片 / brief
-> codex-ppt 生成视觉统一的图片型 PPT
-> image-to-editable-ppt / editppt 重建为对象级可编辑 PPT
-> 页面证据、可编辑性、PowerPoint 打开性、视觉复核、交付门禁
-> 下载 editable-final.pptx
```

## 当前权威状态

- 前端服务：`http://127.0.0.1:4180/`
- 仓库：`E:\PPT工具`
- 当前真实 job：`workflow_20260624-191529Z_b783f0`
- 图片模型：`gpt-image-2`，已配置并真实生成过 `page_001`、`page_002`
- 页面规格模型：`PAGE_SPEC_MODEL=gpt-4o`，当前单页探测与单页重建已通过
- OCR：`rapidocr-local` 可用，15 页 OCR 文本提示已生成
- 当前最终文件：`workspace/jobs/workflow_20260624-191529Z_b783f0/final/editable-final.pptx`
- 当前 final 覆盖范围：`1/15` 页
- 当前交付状态：blocked
- 当前真实阻断：最终视觉 QA 需要人工复核；当前 final 不是完整 15 页交付

## 已完成

1. Skill-first 工作流框架已经接入。
2. `codex-ppt` 侧已有 outline、style、backend、sample、fullDeck 证据和确认链。
3. `gpt-image-2` 真实生成图片型页面的路径可用。
4. `image-to-editable-ppt/editppt` 的 prepare、worker、record、finalize 路径已经接上。
5. `page_001` 单页真实重建已成功：
   - 有 `page-rebuild-spec.json`
   - 有 `manifest.json`
   - 有 `page.pptx`
   - 有 `preview.png`
   - 有 `split_assets_contact.png`
   - 有 `validation.json`
   - PowerPoint 可打开
   - 可编辑对象检查通过
   - 未发现整页截图冒充可编辑页
6. 已修复最终视觉 QA 范围污染：
   - 当前 final 只有 `page_001` 时，不再把历史 `page_002` 混进 QA 范围。

## 当前问题

### P0：还不是完整产品结果

当前 `editable-final.pptx` 只覆盖 `1/15` 页。它证明了单页链路可行，但不能作为完整最终文件。

### P0：还缺 2 页小样本闭环

`page_001` 已成功，`page_002` 还没有完成当前 final 范围内的可编辑重建。下一步应该跑 `page_002`，然后合成 2 页 final。

### P0：最终视觉 QA 需要人工复核

系统已经能检查结构证据，但不能完全自动判断视觉是否足够接近 `codex-ppt` 目标图。需要前端提供清晰复核入口：

- 目标图
- 可编辑预览图
- 资产分离联系表
- 确认复核按钮

### P1：前端仍偏工程控制台

主界面还暴露较多 worker、manifest、hash、provider、artifact 等工程概念。产品形态应改成中文 Agent 工作台：

```text
上传文件 -> 生成视觉统一 PPT -> 转成可编辑 PPT -> 检查 -> 下载
```

工程细节默认折叠进“高级详情”。

### P1：文档和历史状态有乱码/旧描述

README、旧产品目标文档、历史 job 状态里仍有 mojibake 和旧流程描述。它们不一定影响运行，但会误导维护和判断。

### P1：旧模板/旧本地生成器仍需继续隔离

旧模板效果不稳定，也不符合当前双 Skill 主线。旧入口只能保留为高级诊断或 Lab，不能出现在主流程。

## 后续执行计划

### 第一阶段：稳定当前 1 页闭环

目标：让当前单页结果状态准确、可解释。

要做：

- 保持最终 QA 只检查当前 final 页范围。
- 在前端交付区明确显示：当前 final 已生成，但等待人工视觉复核。
- 展示 `page_001` 的目标图、可编辑预览图、联系表。
- 增加或修正人工复核记录入口。

完成标准：

- 交付状态不再误报 `page_002`。
- 页面证据显示 `1/1` 完整。
- 阻断原因只剩人工复核和 `1/15` 覆盖范围提示。

### 第二阶段：跑通 2 页小样本

目标：证明不是只能单页成功。

要做：

- 清理或重置 `page_002` 的失败/旧证据。
- 只跑 `page_002` 的 `image-to-editable-ppt` 重建。
- 生成 `preview.png`、`split_assets_contact.png`、`page.pptx`、`validation.json`。
- 合成 2 页 `editable-final.pptx`。
- 复查 PowerPoint 打开性、可编辑对象、整页截图风险。

完成标准：

- `page_001,page_002` 都有完整页面证据。
- 最终 PPT 是 2 页。
- 交付门禁只剩人工视觉复核，或人工复核后允许作为“小样本结果”下载。

### 第三阶段：前端产品化收口

目标：让非技术用户能直接使用。

要做：

- 首页主流程只保留 Skill-first 路径。
- 去掉或隐藏旧模板、旧本地生成器、旧 OCR 主入口。
- 全部可见文案改为纯中文。
- 主界面展示：
  - 当前阶段
  - 正在做什么
  - 为什么卡住
  - 下一步按钮
  - 最终文件位置
- 高级详情折叠：
  - Provider
  - Worker
  - OCR
  - Artifact
  - Validation
  - Logs

完成标准：

- 打开 `4180` 后，不看日志也能知道当前状态和下一步。
- 用户不需要理解 worker、manifest、hash，也能完成测试流程。

### 第四阶段：质量增强与失败恢复

目标：降低图片型页面和可编辑 PPT 的视觉差距。

要做：

- 强化页面规格模型探测。
- 对空响应、无效 JSON、图片输入不支持、额度不足给清晰错误。
- 强化单页重试：失败页可单独清理、重跑、记录、合并。
- 增强资产分离和前景资产检查。
- 对图表、价格卡、产品图、Logo、地图等高风险元素做专项 QA。

完成标准：

- 单页失败原因可定位。
- 重跑失败页不会污染成功页。
- `preview.png` 与目标图差距逐步收敛。

### 第五阶段：15 页正式验收

目标：用当前 15 页 PPT 做产品级验收。

要做：

- 全量真实运行 `codex-ppt`，不使用 passthrough/dry-run。
- 全量运行 `image-to-editable-ppt`，按页分批重建。
- 失败页单页重试。
- 合成 15 页 `editable-final.pptx`。
- 检查：
  - 页数正确
  - PowerPoint 可打开
  - 有可编辑文本/形状/图片对象
  - 无整页截图冒充
  - 页面证据完整
  - 视觉复核通过
- 写入最新验收报告。

完成标准：

- `workspace/v1-acceptance/latest-real-ppt-regression.json` 中 `acceptance.ready=true`
- 15 页最终 PPT 可打开、可编辑、可交付。

## 当前下一步

优先级最高的是：跑 `page_002` 的真实可编辑重建，把当前单页闭环推进到 2 页小样本闭环。

这一步会调用外部模型/API，执行前需要明确知道本次范围是 `page_002` 单页，避免误跑完整 15 页造成不必要消耗。
