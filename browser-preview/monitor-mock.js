(() => {
  const listeners = new Set();
  let snapshot;
  const verifications = new Map();
  const clone = () => structuredClone(snapshot);
  const feedback = text => { document.querySelector('#demo-feedback').textContent = text; };
  function emit(text) { for (const listener of listeners) listener(clone()); if (text) feedback(text); return clone(); }
  function environment(id) { return snapshot.environments.find(item => item.environmentId === id); }
  function release(id) {
    snapshot.pendingPermissions = snapshot.pendingPermissions.filter(item => item.environmentId !== id);
    for (const session of snapshot.sessions) {
      if (session.environmentId === id && session.agent === 'codex' && session.state === 'waiting_permission') session.state = 'idle';
    }
  }
  window.monitorDemo = (mode = 'mixed') => {
    const mixed = mode === 'mixed';
    snapshot = {
      devices: [{ deviceId: 'pc', name: '我的 Windows', kind: 'local' }, { deviceId: 'lab', name: '实验室 Linux', kind: 'remote' }],
      environments: [
        { environmentId: 'windows', deviceId: 'pc', name: 'Windows 本机', kind: 'windows', status: 'connected', enabled: true, codexApprovalsEnabled: false },
        { environmentId: 'ubuntu', deviceId: 'pc', name: 'WSL · Ubuntu', kind: 'wsl', distribution: 'Ubuntu', status: 'connected', enabled: true, codexApprovalsEnabled: mixed },
        { environmentId: 'linux', deviceId: 'lab', name: '实验室 Linux', kind: 'ssh', sshHost: 'lab', status: 'connected', enabled: true, codexApprovalsEnabled: false },
      ],
      preferences: { showPet: true, showPreview: true, focus: { kind: 'all' } },
      onboardingCompleted: true,
      sessions: [], pendingPermissions: [],
    };
    for (const [index, [id, agent, title, state]] of [
      ['windows', 'codex', '前端页面调整', 'working'],
      ['ubuntu', 'codex', '运行项目测试', 'waiting_permission'],
      ['linux', 'copilot', '更新服务配置', 'waiting_permission'],
      ['ubuntu', 'copilot', '整理接口文档', 'completed'],
    ].entries()) {
      const env = environment(id);
      snapshot.sessions.push({ environmentId: id, deviceId: env.deviceId, environmentName: env.name, sourceProfile: id,
        agent, sessionId: title, state: mixed ? state : mode, updatedAt: new Date(Date.now() - index * 30_000).toISOString() });
    }
    if (mixed) snapshot.pendingPermissions.push({ environmentId: 'ubuntu', deviceId: 'pc', environmentName: 'WSL · Ubuntu',
      requestId: 'demo-permission', sourceProfile: 'ubuntu', agent: 'codex', sessionId: '运行项目测试',
      tool: { name: 'Bash · 运行项目测试', summary: '示例请求：npm test\n工作目录：/home/demo/project\n此按钮仅演示审批，不执行命令。' } });
    emit(mixed ? '示例：WSL 的 Codex 已主动开启桌面审批；Linux 的 Copilot 等待原生终端审批。' : '已切换模拟场景，未操作真实 Agent。');
  };
  window.vibemate = {
    getSnapshot: async () => clone(),
    onSnapshot: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    async setCodexApprovals(id, enabled) {
      environment(id).codexApprovalsEnabled = enabled;
      if (!enabled) release(id);
      return emit(enabled ? '模拟已开启此环境的 Codex 桌面审批。Copilot 仍沿用原生审批。' : '模拟已关闭桌面审批，等待中的请求交回原终端。');
    },
    async submitDecision(identity, decision) {
      const request = snapshot.pendingPermissions.find(item => item.requestId === identity.requestId && item.environmentId === identity.environmentId);
      if (!request) return 'not_found';
      snapshot.pendingPermissions = snapshot.pendingPermissions.filter(item => item !== request);
      const session = snapshot.sessions.find(item => item.agent === request.agent && item.sessionId === request.sessionId && item.environmentId === request.environmentId);
      session.state = decision === 'allow' ? 'working' : 'idle'; session.updatedAt = new Date().toISOString();
      emit(decision === 'allow' ? '模拟已允许，任务继续工作。未执行真实命令。' : '模拟已拒绝本次操作；未操作真实 Agent。'); return 'accepted';
    },
    async stopEnvironment(id) {
      environment(id).status = 'stopped'; environment(id).enabled = false; release(id);
      snapshot.sessions = snapshot.sessions.filter(item => item.environmentId !== id);
      return emit('模拟已停止此环境监控，其他环境不受影响。');
    },
    async startEnvironment(id) { environment(id).status = 'connected'; environment(id).enabled = true; return emit('模拟已连接，等待新的会话上报。'); },
    async setEnvironmentEnabled(id, enabled) { return enabled ? this.startEnvironment(id) : this.stopEnvironment(id); },
    async setFocus(focus) { snapshot.preferences.focus = focus; return emit('已保存示例关注范围；独立悬浮桌宠不包含在此主面板预览中。'); },
    async scanEnvironments() { return emit('模拟扫描完成：此页面使用固定示例环境，没有读取你的 Windows。'); },
    async pickPrivateKey() { return '/demo/id_ed25519'; },
    async testSshConnection({ profile }) {
      const verificationId = crypto.randomUUID();
      verifications.set(verificationId, JSON.stringify(profile));
      return { verificationId, hostname: profile.name, architecture: 'arm64', agents: { codex: true, copilot: true } };
    },
    async saveSshEnvironment({ profile, environmentId, verificationId }) {
      if (verificationId && verifications.get(verificationId) !== JSON.stringify(profile)) throw new Error('连接检查已失效，请重新测试');
      verifications.delete(verificationId);
      let env = environmentId ? environment(environmentId) : undefined;
      if (!env) {
        const id = `demo-${crypto.randomUUID()}`;
        snapshot.devices.push({ deviceId: id, name: profile.name, kind: 'remote' });
        env = { environmentId: id, deviceId: id, kind: 'ssh', status: 'stopped', enabled: false, codexApprovalsEnabled: false };
        snapshot.environments.push(env);
      }
      const { name, ...connection } = profile;
      Object.assign(env, { name, sshHost: profile.host, sshConnection: connection });
      return { snapshot: emit('已保存模拟设备配置，没有连接真实设备。'), environmentId: env.environmentId };
    },
    async removeSshEnvironment(id) {
      release(id);
      snapshot.environments = snapshot.environments.filter(item => item.environmentId !== id);
      snapshot.devices = snapshot.devices.filter(item => snapshot.environments.some(env => env.deviceId === item.deviceId));
      return emit('已移除模拟设备配置，未操作真实设备。');
    },
    async addSshEnvironment(host) {
      if (!snapshot.environments.some(item => item.sshHost === host)) {
        const id = `demo-${Date.now()}`;
        snapshot.devices.push({ deviceId: id, name: host, kind: 'remote' });
        snapshot.environments.push({ environmentId: id, deviceId: id, name: host, kind: 'ssh', sshHost: host, status: 'stopped', enabled: false, codexApprovalsEnabled: false });
      }
      return emit('已加入示例环境列表，没有执行 SSH 连接。');
    },
  };
  window.monitorDemo();
})();
