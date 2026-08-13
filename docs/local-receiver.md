# 本机接收服务

## 作用

本机接收服务连接原始 Agent Hook 和 VibeMate Core：

```text
Codex/Copilot Hook
  → loopback HTTP
  → Agent Adapter
  → Protocol v1
  → SessionStore / PermissionBroker
```

接收服务只监听 `127.0.0.1`，端口由操作系统动态分配。启动后会将发现信息写入：

```text
~/.vibemate/runtime.json
```

运行时文件权限为 `0600`，包含端口、进程 ID 和随机 capability token。所有 HTTP
请求都必须通过 `X-VibeMate-Token` 请求头提供该 token。进程同时持有运行时锁，
防止两个本机服务覆盖彼此的发现信息。

## 启动

```bash
npm run start:receiver
```

当前命令用于开发验证。服务管理和 Electron 启动监督将在后续阶段实现。

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | 服务与协议版本检查 |
| `GET` | `/v1/snapshot` | 会话和待处理权限只读快照 |
| `POST` | `/v1/hooks/codex` | Codex 原始 Hook 载荷 |
| `POST` | `/v1/hooks/copilot/:event` | Copilot 原始 Hook 载荷 |
| `POST` | `/v1/permissions/:requestId/decision` | 提交完整身份绑定的决定 |

原始 Hook 请求最大为 256 KiB，只在内存中完成字段提取。Adapter 输出仍受
Protocol v1 的 16/32 KiB 限制。完整提示词、命令、diff、文件内容和工具输出不会
进入共享事件或快照。

## 权限返回

- Codex Allow/Deny 使用 `hookSpecificOutput` 官方信封。
- Codex 无决定返回 `{}`。
- Copilot Allow/Deny 返回 `{ "behavior": "allow|deny" }`。
- Copilot 无决定返回 HTTP 204，Hook 必须保持空 stdout。

本服务本身不会修改 Agent 配置。Hook runner 和显式安装流程见
[Agent Hook 集成](hook-integration.md)。
