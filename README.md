# VibeMate

VibeMate 是一个面向 AI 编码 Agent 的桌面伙伴。它监听 Codex CLI 和
GitHub Copilot CLI 会话，在任务需要用户注意时发出提醒，并允许用户不必逐个寻找
终端窗口，就能处理受支持的权限请求。

项目将从集成层开始构建：先完成 Agent 事件采集和权限路由，再让像素桌宠和桌面
应用消费这套稳定协议。

## 当前状态

仓库已包含 Protocol v1、会话存储、权限 Broker、Codex/Copilot 事件映射、
loopback HTTP 接收服务、Hook runner、增量安装器，以及由实时状态驱动的
Electron 设置页、托盘、胶囊式悬浮监控窗和七状态悬浮桌宠。桌面端可以同时管理
Windows 本机、多个 WSL 发行版，以及通过系统 SSH 接入的 Linux/树莓派环境。

默认仅监控，沿用 Agent 原生授权设置。每个环境可单独开启“在 VibeMate 中审批
Codex”；关闭或客户端离线会回退原生审批。Copilot 仅采集任务状态及实际
`permission_prompt` 提醒，不接管审批，不干扰其 Allow All／会话授权规则。
重新启用环境时安装器会移除 VibeMate 旧的 Copilot 权限 Hook 并注册通知 Hook，
保留其他工具的配置。已运行的 Agent 可能需要重启会话才能加载新的 Hook 配置。

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

系统通知、自动更新、完整卸载清理和个人生活提醒仍属于后续工作。

## 开发与打包

```bash
npm test
npm run start:desktop
npm run dist:windows
```

正式用户路径不需要终端：启动后扫描 Windows/WSL，确认要启用的环境即可。独立
Linux 主机从面板选择已有 SSH 别名或填写主机/IP，再手动点击“开始监控”。

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
