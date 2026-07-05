# PPT Agent 产品目标

## 产品定位

本工具是围绕两套 Skill 的本地 PPT Agent，不是旧模板库，也不是旧版本地一键生成器。

主流程固定为：

```text
上传 PPT / PDF / 图片 / brief
-> codex-ppt 生成视觉统一的图片型 PPT
-> image-to-editable-ppt / editppt 重建为对象级可编辑 PPT
-> 质量检查、人工视觉复核、失败恢复、交付门禁
-> 下载 editable-final.pptx
```

职责边界：

- `codex-ppt`：负责视觉统一、风格重绘、图片型 PPT 中间产物。
- `image-to-editable-ppt / editppt`：负责把图片型 PPT、PDF 或页面图片重建为对象级可编辑 PPT。
- 旧模板、旧设计方向和旧本地一键生成器不再作为主流程能力，只能作为兼容诊断或历史参考。

## 当前事实

截至 2026-06-30：

- 当前真实 job：`workflow_20260629-021146Z_619d82`
- 源文件：`汇川中秋--20260611.pptx`
- 源页数：20 页
- 当前已完成：20/20 页 `codex-ppt` 图片型页面和图片型 PPT
- 当前已跑通：2/20 页 `image-to-editable-ppt / editppt` 可编辑重建小样本
- 当前最终文件：`workspace/jobs/workflow_20260629-021146Z_619d82/final/editable-final.pptx`
- 当前交付状态：blocked，不是完整产品交付
- 当前待重建页集：`page_001,page_002,page_005-page_020`
- 当前完整页面证据页：`page_003,page_004`
- 注意：当前 2 页 final 是旧小样本结果，不等于当前已记录页面证据页；最终必须重新合成 20/20。
- 图片模型：`gpt-image-2`
- OCR：`paddleocr-local`，`rapidocr-local` fallback
- 对话模型：由外部 OpenAI-compatible provider 配置，前端不暴露 API Key

当前已验证：

- `codex-ppt` 图片型页面真实生成完成，覆盖 20/20 页。
- 图片型 PPT 已覆盖源文件 20 页。
- `image-to-editable-ppt / editppt` 已有 2 页完整页面证据。
- 已支持逐页人工复核标记；最终人工复核门禁尚未完成。
- 当前人工复核标记仍是阶段性记录；20/20 最终文件生成后必须重新做最终人工复核。
- PowerPoint 打开性、对象级可编辑性、整页截图风险仍需在 20/20 最终文件上重新验收。

当前未完成：

- 完整 20/20 页可编辑重建尚未完成。
- 剩余 18 页需要继续跑真实 `image-to-editable-ppt / editppt` 页面 worker。
- `acceptance.ready=true` 只能在完整页数覆盖、交付门禁 ready 后写入。
- 继续剩余页前必须再次显式确认 `gpt-image-2` 图片 API 和页面规格模型调用额度。

## 产品级完成标准

单个真实任务达到产品级交付，需要同时满足：

- 真实 `gpt-image-2` 生成图片型页面，不能用 passthrough 或 dry-run 冒充。
- 真实 `image-to-editable-ppt / editppt` 完成对象级重建。
- 最终 PPT 页数与源文件一致。
- 最终 PPT 可被 PowerPoint 打开。
- 最终 PPT 包含可编辑文字、形状和图片对象。
- 没有整页截图冒充可编辑页面。
- 页面证据和最终证据完整。
- 人工视觉复核已记录。
- 交付门禁返回 ready，或验收报告写入 `acceptance.ready=true`。

工具级完成标准：

- 支持任意 PPT、PDF、图片组和 brief 进入同一主流程。
- 普通用户只看到上传、生成、转可编辑、复核、下载。
- worker、manifest、hash、artifact、provider 等工程细节默认隐藏到高级详情。
- 失败时能解释原因、影响页面和推荐动作。
- 单页重跑不污染已成功页面。
- 外部 API 调用必须显式确认，尤其是 `gpt-image-2` 图片 API 和页面规格模型。
- 旧模板和旧本地生成器不会误导用户进入非 Skill-first 主流程。

## 下一步优先级

1. 让 `/next` 和交付区在 2/20 小样本状态下明确提供两个动作：复核当前样例、继续生成剩余 18 页。
2. 在用户确认额度后，继续跑剩余页面，分批完成 20/20 真实链路。
3. 强化单页失败恢复：失败原因、影响页、重置页、重跑页、重新合成 final。
4. 强化人工复核体验：逐页对比 `codex-ppt` 目标图、可编辑 PPT 预览图、校验结果和资产分离图。
5. 持续清理普通用户前端，把旧模板和旧本地生成器留在高级诊断而不是主流程。
## 2026-06-30 当前产品边界补充

- 当前主验收样本仍是 `汇川中秋--20260611.pptx`，源文件 20 页。
- `codex-ppt` 图片型页面和图片型 PPT 已完成 20/20。
- `image-to-editable-ppt / editppt` 可编辑重建当前仍只有 2/20 小样本，不是完整产品交付。
- `draft-final-pptx` 只开放当前小样本草稿下载，文件名 `editable-sample-2p-draft.pptx`；它不能替代最终产品级 `editable-final.pptx`。
- `final-pptx` 最终产品级下载必须继续受交付门禁控制；当前 blocked 状态下接口应返回 409。
- 剩余页真实执行必须走分批受控启动，默认先跑 2 页；用户明确确认外部 API 额度和模型恢复后，才允许启动真实 `image-to-editable-ppt` 页面 worker。
- 普通用户前端应优先显示五步主流程、当前主任务、小样本/最终文件状态、下一步动作、失败恢复和运行状态；worker、provider、artifact、manifest、hash 等细节默认进入高级/诊断区。
