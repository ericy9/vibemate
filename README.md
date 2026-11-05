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
Linux / 树莓派设备可在客户端点击“添加设备”，填写名称、地址、SSH 端口和用户名，
选择密码或 SSH 私钥文件登录。已有系统 SSH 别名仍可通过扫描发现并使用。

## 添加 Linux / 树莓派设备

1. 在 Windows 客户端设置页点击“添加设备”，填写设备地址和运行 Agent 的用户名。
2. 选择密码登录，或选择私钥文件并按需输入密钥口令。
3. 点击“测试连接”，首次连接核对并确认真实主机指纹。测试只检查登录、Linux 架构、
   `tar` 和 Agent 可见性，不部署文件或修改 Agent 配置。
4. 测试成功后点击“安装并开始监控”，客户端部署自带运行时、Receiver 和 Agent Hook。
5. 重启该设备上的 Copilot / Codex 会话，让新 Hook 生效。

也可以先“保存配置”，稍后从环境列表的“连接设置”或“开始监控”补充登录信息。
地址、端口、用户名、私钥路径和已确认的设备指纹会保存；密码、密钥口令只在本次
应用运行期间留在主进程内存中，不写入设置文件，私钥内容也不复制到设置中。
重启客户端后，密码登录和加密密钥需要重新提供凭证。身份改变的设备会被拒绝连接。
停止监控后可“移除配置”，清除客户端的设备记录和本次凭证；此操作不卸载远端文件或 Hook。
通过界面添加的设备使用内置 SSH 客户端，不需要事先在 PowerShell 配置免密登录。
远端仍需已安装并登录 Codex / Copilot；默认只监控，Copilot 权限仍在原终端处理。

源码模式接入 WSL/远端设备前，先执行 `npm run build:linux-payload` 生成 Linux 运行时。
