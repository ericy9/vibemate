# 参考项目调研

## Clawd on Desk

### 简化架构

```text
Agent Hook
  → 本机 HTTP POST
  → Electron 主进程状态机
  → Electron IPC
  → Renderer 桌宠
```

普通事件发送到 `/state`，权限请求发送到 `/permission`。它的 Agent 入站不是
SSE；Electron 主进程通过 IPC 更新桌宠窗口。

### 可借鉴

- Hook 安装与增量配置合并
- Agent 事件映射
- 本机 loopback HTTP 接收
- 普通状态与权限请求分流
- 权限超时和原生流程回退
- Codex 官方 Hook 与日志 fallback 的重复抑制

### 不直接采用

- 核心状态、权限和 Electron 展示耦合较深
- 统一状态包含较多动画语义
- 跨机器主要依赖额外隧道能力
- 项目代码为 AGPL-3.0-only
- 美术和主题素材存在独立权利声明

VibeMate 可以参考设计思想，但不应直接复制代码或素材。

## Happy

### 简化架构

```text
编码机器 Happy CLI/Daemon
  → 客户端加密
  → HTTP + Socket.IO
  → Happy Server
  → Socket.IO
  → 手机、Web 或桌面客户端
```

服务器保存并转发密文。持久更新带递增序号，临时在线状态通过 ephemeral
事件传输。权限结果使用按机器或会话定向的 Socket.IO RPC 返回编码端。

### 可借鉴

- 用户、机器、会话三级连接作用域
- HTTP 快照与 WebSocket 实时同步组合
- 持久事件和临时事件分离
- 单调序号、断线补拉和乐观并发
- 按会话命名的定向 RPC
- 客户端加密和设备配对
- 云端与自托管服务模式

### VibeMate 的改进方向

- Happy 是完整远程 Agent 控制平台，VibeMate 第一阶段只需要状态与权限元数据。
- 不同步完整提示词、文件内容、命令输出或未受限工具参数。
- 保持本地优先，远程中继为可选能力。
- Core Service 独立于 Electron 和具体 UI。
- 权限失败统一回退 Agent 原生流程。

Happy 根项目使用 MIT License，但实际复用前仍应检查具体包、依赖和素材许可。
