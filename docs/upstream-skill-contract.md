# 上游 Skill 核心契约

## 产品基础

PPT Agent 以以下两个官方仓库为核心实现基础，而不是只参考它们的设计：

- `ningzimu/codex-ppt-skill`：负责视觉统一的图片型 PPT。
- `ningzimu/image-to-editable-ppt-skill`：负责对象级可编辑 PPT 重建。

当前固定正式版本：

- `codex-ppt`：`v0.5.5`
- `image-to-editable-ppt`：`v0.3.2`

产品默认从 `C:\Users\Administrator\.agents\skills` 加载两套 Skill。`.codex\skills` 只保留同版本镜像，不能成为不同版本的平行运行源。

## 产品层职责

本地产品层只负责：

- 文件上传和任务管理。
- 官方 Skill 的关卡、调用编排和进度展示。
- 外部 API 授权、额度提示和状态记录。
- 单页失败恢复、人工复核和交付门禁。
- 产物预览、下载和高级诊断。

## 禁止行为

- 不得复制一套本地生成逻辑替代 `codex-ppt`。
- 不得复制一套本地页面重建逻辑替代 `image-to-editable-ppt/editppt`。
- 不得在官方 Skill 输出后自动覆盖 OCR 文字框、原图裁块或其他保真图层。
- 不得使用旧模板、passthrough、dry-run 或整页截图冒充正式结果。
- 不得让 `.agents` 与 `.codex` 的不同版本混合参与同一任务。

## 更新规则

上游正式版本更新时，先备份本地安装，再更新两处镜像和 `editppt` 运行时。产品适配层只能为新契约补充编排与 UI，不得修改官方 Skill 核心规则。`/api/doctor` 必须验证两套 Skill 的规范目录和关键契约；验证失败时阻止产品级任务启动。
