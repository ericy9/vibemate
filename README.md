# VibeMate

VibeMate 是一个面向 AI 编码 Agent 的桌面伙伴。它监听 Codex CLI 和
GitHub Copilot CLI 会话，在任务需要用户注意时发出提醒，并允许用户不必逐个寻找
终端窗口，就能处理受支持的权限请求。

项目将从集成层开始构建：先完成 Agent 事件采集和权限路由，再让像素桌宠和桌面
应用消费这套稳定协议。

## 当前状态

目前处于需求规划和协议调研阶段，尚未开始运行时代码实现。

## 项目文档

- [产品需求文档](docs/product-requirements.md)
- [实施计划](docs/implementation-plan.md)

## 初始范围

- Codex CLI
- GitHub Copilot CLI
- 优先支持本地会话
- 非阻塞的生命周期事件采集
- 支持原生回退的阻塞式 Allow/Deny 权限流程
- 轻量的多会话身份模型

远程 Linux、WSL2、树莓派、桌面宠物、系统通知和个人生活提醒，将在编码端
采集层得到验证后分阶段实现。

