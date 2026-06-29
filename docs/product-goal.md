# PPT Agent 产品目标

## 产品定位

本工具是围绕两套 Skill 的本地 PPT Agent，不是传统模板库，也不是旧版一键生成器。

主流程固定为：

```text
上传源文件或 brief
-> codex-ppt 生成视觉统一的图片型 PPT
-> image-to-editable-ppt / editppt 重建对象级可编辑 PPT
-> 质量检查和人工视觉复核
-> 交付 editable-final.pptx
```

两套 Skill 的职责边界：

- `codex-ppt`：负责视觉统一、风格重绘和图片型 PPT 中间产物。
- `image-to-editable-ppt`：负责把图片型 PPT、PDF 或页面图片重建为对象级可编辑 PPT。

旧模板、旧设计方向和旧本地一键生成器不再作为主流程能力，只能作为兼容诊断或历史参考。

## 当前事实

截至 2026-06-29：

- 当前真实 job：`workflow_20260624-191529Z_b783f0`
- 源 PPT：15 页
- 当前已跑通：15/15 页真实样例闭环
- 当前最终文件：`workspace/jobs/workflow_20260624-191529Z_b783f0/final/editable-final.pptx`
- 图片模型：`gpt-image-2`
- OCR：`rapidocr-local`
- 对话模型：由外部 OpenAI-compatible provider 配置，前端不暴露 API Key
- 当前交付状态：ready，可以交付

当前 15 页样例已验证：

- `codex-ppt` 图片型页面真实生成完成。
- `image-to-editable-ppt / editppt` 可编辑重建完成。
- 最终 PPT 页数等于源文件页数：15/15。
- PowerPoint 可打开。
- 对象级可编辑性检查通过，包含可编辑文字、形状和图片对象。
- 未发现整页截图冒充可编辑页面。
- 页面证据和最终证据完整。
- 人工视觉复核已记录。
- 交付门禁返回 `productReady=true`、`downloadable=true`。

## 产品级完成标准

当前样例达到产品级交付门禁，但工具级完成标准还需要覆盖更多输入类型。

### 单个真实任务完成标准

- 真实 `gpt-image-2` 生成图片型页面，不能用 passthrough 或 dry-run 冒充。
- 真实 `image-to-editable-ppt / editppt` 完成对象级重建。
- 最终 PPT 页数与源文件一致。
- 最终 PPT 可被 PowerPoint 打开。
- 最终 PPT 包含可编辑文字、形状和图片对象。
- 没有整页截图冒充可编辑页面。
- 页面证据和最终证据完整。
- 人工视觉复核已记录。
- 验收报告中 `acceptance.ready=true`，或交付门禁等价返回 ready。

### 工具级完成标准

- 支持任意 PPT、PDF、图片组和 brief 进入同一主流程。
- 普通用户只看到上传、生成、转可编辑、复核、下载。
- worker、manifest、hash、artifact、provider 等工程细节默认隐藏到高级详情。
- 失败时能解释原因、影响页面和推荐动作。
- 单页重跑不会污染已成功页面。
- 外部 API 调用必须显式确认，尤其是 `gpt-image-2` 图片 API 和页面规格模型。
- 旧模板和旧本地生成器不会误导用户进入非 Skill-first 主流程。

## 核心限制

- 外部 API 调用必须显式确认，不能静默消耗额度。
- `gpt-image-2` 正常不代表对话模型或页面规格模型正常。
- OCR 只作为文字提示和校对辅助，不替代视觉理解和对象重建。
- 图片型 PPT 是中间产物，不是最终交付物。
- 交付门禁不能绕过。
- 旧模板、旧设计方向和旧本地生成器不能回到主流程。

## 下一步优先级

1. 用新的 PPT/PDF 再跑一轮非样例任务，验证工具不是只适配当前 15 页样例。
2. 继续简化前端普通用户视图，把旧工程细节全部折叠到高级详情。
3. 强化单页失败恢复体验：失败原因、影响页面、推荐动作、重置页面、重跑页面、重新合成 final。
4. 强化复核体验：逐页对比 `codex-ppt` 目标图、可编辑 PPT 预览图、校验结果和资产分离图。
5. 更新 README 和运行手册，明确当前已完成 15 页样例，后续重点是泛化测试和产品体验收口。
