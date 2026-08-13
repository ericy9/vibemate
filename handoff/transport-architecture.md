# 传输架构

## 总体边界

系统分为三个主要部分：

```text
Agent Adapter → Core Service → UI Client
```

- Agent Adapter 负责读取 Agent Hook 输入并转换为统一协议。
- Core Service 负责校验、状态存储、去重和权限 Broker。
- UI Client 只消费快照、实时事件和权限 API。

## 同机场景

```text
Agent Hook
  → Loopback HTTP POST
  → 本机 Core Service
  → Electron IPC
  → 桌宠或桌面界面
```

传输约定：

- Hook → Core：本机 HTTP，监听 loopback 动态端口。
- 普通状态事件：短连接、非阻塞 POST。
- 权限请求：有明确超时的双向请求。
- Core → Electron Renderer：Electron IPC。
- Web 开发观察器可通过 SSE 或 WebSocket 接收只读实时事件。

IPC 只用于同一 Electron 应用内部，不作为跨机器协议。

## 远程场景

```text
编码机器
  Agent Hook → 本机 Core Agent
                    ↓
              加密 WebSocket
                    ↓
                Relay Server
                    ↓
              加密 WebSocket
                    ↓
桌宠机器
  Core Service → Electron IPC → 桌宠
```

远程传输预计使用：

- WebSocket：实时事件、连接健康和权限响应。
- HTTPS：初始化快照、历史补拉和断线恢复。
- 单调事件序号：排序、去重和遗漏检测。
- 唯一请求 ID：权限结果精准路由。

远程能力是可选扩展。同机场景不能依赖 Relay Server 才能工作。

## 权限安全规则

- 每个请求只能接受一个有效最终决定。
- 必须验证来源、Agent、会话和请求 ID。
- 拒绝迟到、重复、过期或身份不匹配的决定。
- 连接断开、超时、服务关闭或归属不明时返回“无决定”。
- 集成故障不得转换为自动 Allow 或自动 Deny。

## 当前决策状态

整体场景与传输方向已经确定。以下细节仍属于第零阶段工作：

- 协议 Schema 和版本协商
- 认证与设备配对
- 密钥交换和端到端加密
- Relay 的云托管与自托管形式
- 事件保留周期与离线补偿窗口
- WebSocket 实现和具体超时参数
