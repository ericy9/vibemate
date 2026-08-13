# 当前需求上下文

## 产品目标

VibeMate 是一个用于观察和管理多个 AI 编码会话的桌面伙伴。第一阶段支持：

- Codex CLI
- GitHub Copilot CLI

当前优先级是先完成可靠的 Agent 集成核心，再实现桌宠展示层。

## 第一阶段核心能力

- 采集并校验 Agent 生命周期事件。
- 将不同 Agent 事件映射为统一状态。
- 按来源、Agent 和会话隔离状态。
- 观察多个并发终端会话，避免覆盖和串线。
- 对受支持的权限请求完成 Allow/Deny 闭环。
- 在服务不可用、超时或身份不明确时返回“无决定”，回退 Agent 原生审批。
- 只保存经过清理、长度受限的必要元数据。
- 提供开发观察器验证事件、权限、去重和回退行为。

## 当前实现状态

- 已建立 Node.js 22 + TypeScript + npm workspaces 工具链。
- `@vibemate/protocol` 已实现 Protocol v1 Schema、载荷限制、清理和会话键。
- `@vibemate/core` 已实现有界会话存储、乱序处理、完成去重和权限 Broker。
- 已实现 Codex/Copilot 原始 Hook 映射和带 capability token 的 loopback HTTP
  接收服务。
- 已实现零依赖 Hook runner 和增量配置安装器；安装器尚未对真实用户配置执行。
- 尚未实现开发观察器。
- 当前真实 CLI 验证基线为 Codex 0.147.0、Copilot 1.0.79。

## 统一状态

- `idle`
- `thinking`
- `working`
- `waiting_permission`
- `completed`
- `failed`
- `ended`

动画名称不属于核心协议。桌宠可以把统一状态映射为自己的动画状态。

## 会话身份

核心会话键应包含：

```text
<source-profile>|<agent>|<session-id>
```

权限请求还必须拥有唯一的 `requestId`，并绑定到准确的来源、Agent 和会话。

## 当前不做

- 自动批准权限策略
- 云端同步作为第一阶段前置条件
- 手机客户端
- 公共插件市场
- Claude Code 和其他 Agent
- 个人提醒功能与 Agent 核心混合
