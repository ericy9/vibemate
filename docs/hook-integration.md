# Agent Hook 集成

## 组件

VibeMate 的 Agent 接入分成两个独立组件：

```text
Agent → hook-runner → loopback Receiver → Adapter → Core
```

- `hook-runner` 是每次 Hook 触发时启动的零依赖短进程。它只读取 stdin 和
  `~/.vibemate/runtime.json`，然后把原始 JSON 发送到本机 Receiver。
- `hook-installer` 只在用户明确执行安装命令时修改 Agent 配置；Receiver 启动不会
  自动安装或覆盖 Hook。

## 原生回退

runner 对 Agent stdout 使用 fail-open 语义：

| Agent | 无决定或故障时 stdout |
| --- | --- |
| Codex | `{}` |
| Copilot | 空输出 |

服务未启动、运行时文件失效、认证失败、超时、输入过大或响应格式异常时，runner
都会以退出码 0 返回上述结果，让 Agent 使用原生审批界面。设置
`VIBEMATE_HOOK_DEBUG=1` 后，runner 才会把限长错误摘要写入 stderr。

生命周期事件使用 1 秒本机投递超时。权限事件最多等待 9 分钟，始终早于安装配置
中的 10 分钟 Agent Hook 超时。

runner 不直接信任 Receiver 的权限响应。只有符合当前 Codex/Copilot 官方
Allow/Deny 结构的限长 JSON 才会写入 stdout；其他响应均回退原生流程。

## 安装

完成构建后，可显式安装两个 Agent 的 Hook：

```bash
npm run hooks:install
```

也可以只安装一个 Agent：

```bash
npm run hooks:install -- codex
npm run hooks:install -- copilot
```

卸载时只移除 VibeMate 自己的条目：

```bash
npm run hooks:uninstall
npm run hooks:uninstall -- codex
```

安装器具有以下约束：

- Codex：增量合并到 `$CODEX_HOME/hooks.json` 或 `~/.codex/hooks.json`。
- Copilot：写入独立的
  `$COPILOT_HOME/hooks/vibemate.json` 或
  `~/.copilot/hooks/vibemate.json`。
- 只更新带 `vibemate-hook-runner` 标记的 VibeMate 条目。
- 保留用户已有字段和 Hook，重复执行不会重复添加。
- 修改已有文件前创建 `.vibemate-*.bak` 备份，并使用同目录原子替换。
- 已有配置不是有效 JSON 时立即报错，不覆盖原文件。

Copilot 会合并多个 Hook 文件，而多个 `permissionRequest` 输出可能相互覆盖。
因此，只要 `hooks/` 中其他 JSON 或 `settings.json` 已声明该事件，安装器就只安装
生命周期 Hook，并明确警告权限接管未安装。仓库级 `.github/hooks/*.json` 会随
工作目录变化，安装器无法全局枚举；在这类仓库中应继续使用原生审批，直到实现
可验证的 Hook 组合策略。

当前开发阶段不会自动执行上述安装命令。
