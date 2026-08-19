# VibeMate

VibeMate 是一个面向 AI 编码 Agent 的桌面伙伴。它监听 Codex CLI 和
GitHub Copilot CLI 会话，在任务需要用户注意时发出提醒，并允许用户不必逐个寻找
终端窗口，就能处理受支持的权限请求。

项目将从集成层开始构建：先完成 Agent 事件采集和权限路由，再让像素桌宠和桌面
应用消费这套稳定协议。

## 当前状态

目前处于本机 Agent 集成和桌面端骨架阶段。仓库已包含 Protocol v1、会话存储、
权限 Broker、Codex/Copilot 事件映射、loopback HTTP 接收服务、Hook runner、
增量安装器，以及由实时状态驱动的 Electron 控制面板、托盘和七状态悬浮占位桌宠。

## 项目文档

- [产品需求文档](docs/product-requirements.md)
- [当前架构](docs/current-architecture.md)

## 初始范围

- Codex CLI
- GitHub Copilot CLI
- 优先支持本地会话
- 非阻塞的生命周期事件采集
- 支持原生回退的阻塞式 Allow/Deny 权限流程
- 轻量的多会话身份模型

远程 Linux、WSL2、树莓派、桌面宠物、系统通知和个人生活提醒，将在编码端
采集层得到验证后分阶段实现。

## 本地请求 Seedance

使用 OpenLux 的豆包 Volc 接口创建 Seedance 2.0 视频任务：

```bash
export OPENLUX_API_KEY="你的 API Key"
npm run seedance -- create "一只像素风小狗在桌面上摇尾巴" \
  --image assets/raw-videos/geenBGlight.png \
  --duration 5 --ratio 16:9 --resolution 720p \
  --download output.mp4
```

默认模型为 `doubao-seedance-2-0-260128`。仅创建任务、不等待：

```bash
npm run seedance -- create "视频描述"
```

查询或继续等待已有任务：

```bash
npm run seedance -- get cgt-任务ID
npm run seedance -- wait cgt-任务ID --download output.mp4
```

密钥只从 `OPENLUX_API_KEY` 环境变量读取，不要写入仓库。
