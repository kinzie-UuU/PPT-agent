# PPT Master Provider（实验性）

## 定位

`PPT Master` 是可选的原生可编辑 PPT Provider，不替换当前正式链路：

```text
codex-ppt -> 图片版 PPT -> image-to-editable-ppt/editppt -> 交付门禁
```

当前固定检查版本为 `hugohe3/ppt-master v4.7.0`。本地检出默认位于：

```text
external/ppt-master
```

`external/` 不进入 Git 仓库，因此业务代码不会复制或修改第三方实现。

## 当前能力边界

已经接入：

- 官方仓库与版本识别。
- 必需 Skill、工作流和脚本检查。
- Python 可用性检查。
- `attribution_guard.py` 完整性检查。
- `/api/providers/ppt-master` 无费用预检接口。
- `/api/doctor` 可选运行时状态。
- Workflow `input.generationRoute` 字段，旧任务默认归一为 `image-fidelity`。
- 前端生成引擎状态展示。

尚未接入：

- 自动调用 Agent 执行 PPT Master 的 Default/Quick 工作流。
- PPT Master SVG/PPTX 产物导入当前 job artifact manifest。
- 原生页逐页证据、人工复核和最终交付门禁映射。

因此前端的 `ppt-master-native` 选项保持不可用。仅检测到 Skill 不等于真实产品执行已经完成。

## 配置

```text
PPT_MASTER_ROOT=
PPT_MASTER_SKILL_ROOT=
PPT_MASTER_PYTHON_PATH=python
PPT_MASTER_RUNNER_COMMAND=
```

如果不设置路径，服务会依次检查：

1. `external/ppt-master/skills/ppt-master`
2. `~/.agents/skills/ppt-master`
3. `~/.codex/skills/ppt-master`

`PPT_MASTER_RUNNER_COMMAND` 目前只作为未来 Runner 的显式配置边界；服务不会执行它。

## 验证

```powershell
Invoke-RestMethod http://127.0.0.1:4180/api/providers/ppt-master
Invoke-RestMethod http://127.0.0.1:4180/api/doctor
npm.cmd run regression:skill-first
```
