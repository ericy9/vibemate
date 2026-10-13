export function createSshDeviceDialog(api, onSaved, onFeedback) {
  const $ = id => document.getElementById(id);
  const dialog = $('ssh-device-dialog');
  const form = $('ssh-device-form');
  const result = $('ssh-test-result');
  const fields = ['ssh-name', 'ssh-host', 'ssh-port', 'ssh-username', 'ssh-authentication', 'ssh-private-key', 'ssh-password', 'ssh-passphrase'];
  let environmentId;
  let verificationId;
  let busy = false;
  let version = 0;

  const message = (text, error = false) => { result.textContent = text; result.classList.toggle('error', error); };
  const errorMessage = error => String(error?.message ?? '操作失败，请重试').replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '');
  const profile = () => ({
    name: $('ssh-name').value.trim(), host: $('ssh-host').value.trim(), port: Number($('ssh-port').value),
    username: $('ssh-username').value.trim(), authentication: $('ssh-authentication').value,
    ...($('ssh-authentication').value === 'key' ? { privateKeyPath: $('ssh-private-key').value.trim() } : {}),
  });
  const credentials = () => $('ssh-authentication').value === 'password'
    ? ($('ssh-password').value ? { password: $('ssh-password').value } : {})
    : ($('ssh-passphrase').value ? { passphrase: $('ssh-passphrase').value } : {});
  const clearSecrets = () => { $('ssh-password').value = ''; $('ssh-passphrase').value = ''; };
  function setBusy(next) {
    busy = next;
    for (const id of [...fields, 'ssh-save', 'ssh-test', 'ssh-pick-key', 'ssh-dialog-close']) $(id).disabled = next;
    $('ssh-connect').disabled = next || !verificationId;
    form.setAttribute('aria-busy', String(next));
  }
  function invalidate() { verificationId = undefined; $('ssh-connect').disabled = true; message(''); }
  function showAuthentication() {
    const key = $('ssh-authentication').value === 'key';
    $('ssh-key-fields').hidden = !key; $('ssh-password-fields').hidden = key;
    $('ssh-private-key').required = key;
  }
  function close() {
    if (busy) return;
    version++; clearSecrets(); invalidate(); dialog.close();
  }
  function open(environment) {
    if (busy) return;
    version++; environmentId = environment?.environmentId; invalidate(); clearSecrets();
    const connection = environment?.sshConnection;
    $('ssh-dialog-title').textContent = environment ? '连接设备' : '添加 Linux 设备';
    $('ssh-name').value = environment?.name ?? '我的 Linux 设备';
    $('ssh-host').value = connection?.host ?? '';
    $('ssh-port').value = String(connection?.port ?? 22);
    $('ssh-username').value = connection?.username ?? '';
    $('ssh-authentication').value = connection?.authentication ?? 'password';
    $('ssh-private-key').value = connection?.privateKeyPath ?? '';
    showAuthentication(); setBusy(false); dialog.showModal();
  }
  async function save() {
    const saved = await api.saveSshEnvironment({
      profile: profile(), ...(environmentId ? { environmentId } : {}), ...(verificationId ? { verificationId } : {}),
    });
    environmentId = saved.environmentId; verificationId = undefined;
    onSaved(saved.snapshot);
    return saved.environmentId;
  }

  form.addEventListener('input', invalidate);
  $('ssh-authentication').addEventListener('change', () => { clearSecrets(); invalidate(); showAuthentication(); });
  $('ssh-dialog-close').onclick = close;
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  $('ssh-pick-key').onclick = async () => {
    setBusy(true);
    try { const path = await api.pickPrivateKey(); if (path) { $('ssh-private-key').value = path; invalidate(); } }
    catch (error) { message(errorMessage(error), true); }
    finally { setBusy(false); }
  };
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !form.reportValidity()) return;
    const currentVersion = version;
    setBusy(true); invalidate(); message('正在验证登录并检查设备环境…');
    try {
      const checked = await api.testSshConnection({ profile: profile(), credentials: credentials(), ...(environmentId ? { environmentId } : {}) });
      if (currentVersion !== version) return;
      verificationId = checked.verificationId; clearSecrets();
      const agents = `Codex ${checked.agents.codex ? '已发现' : '未发现'} · Copilot ${checked.agents.copilot ? '已发现' : '未发现'}`;
      message(`连接成功：${checked.hostname} · Linux ${checked.architecture === 'arm64' ? 'ARM64' : 'x64'}\n${agents}${!checked.agents.codex && !checked.agents.copilot ? '\n登录环境未发现 Agent，请确认该用户已安装。' : ''}`);
    } catch (error) { if (currentVersion === version) message(errorMessage(error), true); }
    finally { if (currentVersion === version) setBusy(false); }
  });
  $('ssh-save').onclick = async () => {
    if (busy || !form.reportValidity()) return;
    const tested = Boolean(verificationId); setBusy(true);
    try {
      await save(); setBusy(false); close();
      onFeedback(tested ? '设备配置已保存。点击开始监控即可接入。' : '设备配置已保存，尚未连接。开始监控前请测试连接。');
    } catch (error) { message(errorMessage(error), true); }
    finally { setBusy(false); }
  };
  $('ssh-connect').onclick = async () => {
    if (busy || !verificationId || !form.reportValidity()) return;
    setBusy(true); message('正在部署接收端并注册 Agent Hook，请稍候…');
    try {
      const id = await save(); onSaved(await api.startEnvironment(id));
      setBusy(false); close(); onFeedback('监控已启动，连接状态见环境列表。请重启设备上的 Copilot / Codex 会话，让新 Hook 生效。');
    } catch (error) { message(errorMessage(error), true); }
    finally { setBusy(false); }
  };
  return { open };
}
