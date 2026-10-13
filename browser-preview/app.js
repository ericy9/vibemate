const $ = id => document.getElementById(id);
const fields = ['name', 'host', 'port', 'user', 'auth', 'key'];
const devices = [
  { id: 'windows', kind: 'windows', name: '我的 Windows', installed: false, online: false },
  { id: 'wsl', kind: 'wsl', name: 'WSL · Ubuntu', installed: false, online: false },
  { id: 'lab', kind: 'ssh', name: '实验室服务器', host: '192.168.1.20', port: '22', user: 'ubuntu', auth: 'agent', key: '', installed: false, online: false },
];
let selected = null;
let verified = false;
const current = () => devices.find(d => d.id === selected);
function message(text, error = false) { $('result').textContent = text; $('result').classList.toggle('error', error); }
function reset() {
  verified = false; $('deploy').disabled = true; message('');
  for (const id of ['step1', 'step2', 'step3']) $(id).classList.remove('done');
}
function enableSystemOption() {
  if (!$('auth').querySelector('[value="agent"]')) $('auth').add(new Option('使用电脑已有的登录配置（高级）', 'agent'));
}
function showAuth() {
  for (const type of ['password', 'key', 'agent']) $(type + '-area').hidden = $('auth').value !== type;
  $('key-help').hidden = $('auth').value !== 'key';
}
function renderList() {
  $('devices').replaceChildren();
  for (const d of devices) {
    const row = document.createElement('button'); row.type = 'button'; row.className = 'device' + (d.id === selected ? ' selected' : '');
    row.setAttribute('aria-pressed', String(d.id === selected));
    const icon = document.createElement('span'); icon.className = 'icon'; icon.textContent = d.kind === 'windows' ? '⊞' : '>_';
    const info = document.createElement('span'); const name = document.createElement('strong'); name.textContent = d.name;
    const sub = document.createElement('span'); sub.className = 'muted'; sub.textContent = d.kind === 'ssh' ? `${d.user}@${d.host} · SSH` : d.kind === 'wsl' ? '本机 Linux 环境 · 示例' : '本机环境 · 示例';
    info.append(name, sub); const status = document.createElement('span'); status.className = 'status' + (d.online ? ' online' : '');
    status.textContent = (d.online ? '模拟监控中' : d.installed ? '已停止' : d.kind === 'ssh' ? '待验证登录' : '未启用') + ' ›';
    row.append(icon, info, status); row.onclick = () => openDevice(d.id); $('devices').append(row);
  }
}
function remoteState() {
  const d = current(); $('remove').hidden = !d; $('stop').hidden = !d?.online;
  $('remote-state').textContent = d ? `监控状态：${d.online ? '模拟运行中' : '未运行'} · 端侧服务：${d.installed ? '模拟已安装' : '未安装'}。${d.online ? '暂无示例任务或权限请求。' : '保存配置不会连接设备，请先测试登录再开始监控。'}` : '可先保存设备配置，稍后补充登录信息。保存不会连接或安装。';
  $('deploy').textContent = d?.installed ? '连接并监控（模拟）' : '安装并监控（模拟）';
}
function setMode(imported) {
  $('import-area').hidden = !imported; $('manual').classList.toggle('active', !imported); $('import').classList.toggle('active', imported);
}
function openDevice(id) {
  selected = id; reset(); $('password').value = ''; $('passphrase').value = ''; $('advanced').open = false;
  const d = current(); const local = d && d.kind !== 'ssh';
  $('local-detail').hidden = !local; $('remote-detail').hidden = !!local;
  $('panel-title').textContent = d ? d.name + ' · 设备详情' : '添加远程设备';
  if (local) renderLocal(d);
  else {
    const values = d || { name: '我的 Linux 设备', host: '', port: '22', user: '', auth: 'password', key: '' };
    if (values.auth === 'agent') enableSystemOption();
    else $('auth').querySelector('[value="agent"]')?.remove();
    for (const field of fields) $(field).value = values[field] || '';
    $('codex-approvals').checked = d?.codexApprovalsEnabled === true;
    $('system-result').value = 'missing'; setMode(false); showAuth(); remoteState();
  }
  renderList();
}
function renderLocal(d) {
  const panel = $('local-detail'); panel.replaceChildren();
  const note = document.createElement('p'); note.className = 'notice';
  note.textContent = d.kind === 'wsl' ? '这是本机 WSL，Windows 桌面应用会直接部署并启动端侧服务，不需要填写 SSH 或密码。' : '本机接收服务随 Windows 桌面应用运行，不需要 SSH 登录。'; panel.append(note);
  for (const [label, value] of [
    ['环境状态', d.kind === 'wsl' ? (d.online ? '运行中（模拟）' : '已停止（模拟）') : '本机（示例）'],
    ['Agent 检测', 'Codex 已发现 · Copilot 未发现（示例）'],
    ['Hook 注册', d.installed ? '已安装（模拟）' : '未安装'],
    ['接收服务', d.online ? '运行中（模拟）' : '未运行'],
  ]) { const line = document.createElement('div'); line.className = 'detail-line'; const key = document.createElement('span'); key.textContent = label; const val = document.createElement('span'); val.textContent = value; line.append(key, val); panel.append(line); }
  const actions = document.createElement('div'); actions.className = 'actions';
  const approvals = document.createElement('label');
  const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.style.width = 'auto';
  checkbox.checked = d.codexApprovalsEnabled === true;
  checkbox.onchange = () => { d.codexApprovalsEnabled = checkbox.checked; };
  approvals.append(checkbox, ' 在 VibeMate 中审批 Codex（模拟，默认关闭）'); panel.append(approvals);
  const approvalHint = document.createElement('p'); approvalHint.className = 'hint';
  approvalHint.textContent = 'Copilot 仅监控与权限提示提醒，请在原终端审批；不会覆盖 Allow All。'; panel.append(approvalHint);
  const toggle = document.createElement('button'); toggle.className = 'primary'; toggle.textContent = d.online ? '停止监控（模拟）' : d.kind === 'wsl' ? '启动 WSL 并启用监控（模拟）' : '启用监控（模拟）';
  toggle.onclick = () => { d.online = !d.online; if (d.online) d.installed = true; renderLocal(d); renderList(); }; actions.append(toggle);
  const repair = document.createElement('button'); repair.className = 'secondary'; repair.textContent = '检测与修复（模拟）'; repair.onclick = () => { note.textContent = '模拟检查完成：Agent 配置可读取，运行时可用。' + (d.installed ? 'Hook 正常。' : '尚未安装 Hook，启用监控后将安装。'); }; actions.append(repair); panel.append(actions);
  const tasks = document.createElement('p'); tasks.className = 'notice'; tasks.textContent = d.online ? '任务与权限请求：暂无示例任务。真实连接后将在此显示该环境的会话。' : '启用监控后，可查看该环境的任务和权限请求。'; panel.append(tasks);
}
function importExample() {
  enableSystemOption();
  const pi = $('alias').value === 'pi';
  Object.entries({ name: pi ? '我的树莓派' : '实验室服务器', host: pi ? '192.168.1.50' : '192.168.1.20', port: '22', user: pi ? 'pi' : 'ubuntu', auth: 'agent', key: '' }).forEach(([k, v]) => { $(k).value = v; });
  $('password').value = ''; $('passphrase').value = ''; $('system-result').value = 'missing'; showAuth(); reset();
  message('已导入示例地址和用户名，尚未验证登录。SSH 配置不包含登录密码，请测试连接检查是否需要补充。');
}
function save() {
  if (!$('form').reportValidity()) return null;
  let d = current();
  const values = Object.fromEntries(fields.map(key => [key, $(key).value.trim()]));
  values.codexApprovalsEnabled = $('codex-approvals').checked;
  if (d?.online && ['host', 'port', 'user', 'auth', 'key'].some(key => d[key] !== values[key])) { message('请先停止当前监控，再保存修改后的连接设置。', true); return null; }
  if (!d) { d = { id: crypto.randomUUID ? crypto.randomUUID() : 'remote-' + Date.now(), kind: 'ssh', installed: false, online: false }; devices.push(d); selected = d.id; }
  if (['host', 'port', 'user'].some(key => d[key] !== values[key])) d.installed = false;
  Object.assign(d, values); $('panel-title').textContent = d.name + ' · 设备详情'; renderList(); remoteState(); return d;
}
$('add-device').onclick = () => openDevice(null);
$('manual').onclick = () => { setMode(false); reset(); };
$('import').onclick = () => { setMode(true); importExample(); };
$('alias').onchange = importExample;
$('use-agent').onclick = () => { enableSystemOption(); $('auth').value = 'agent'; showAuth(); reset(); };
$('auth').onchange = () => { $('password').value = ''; $('passphrase').value = ''; showAuth(); };
$('form').addEventListener('input', reset); $('form').addEventListener('change', reset);
$('demo-password').onclick = () => { $('password').value = 'demo'; reset(); };
$('save').onclick = () => { if (save()) message('配置已保存在本页列表，密码和口令不会保存。尚未进行真实连接，刷新后重置。'); };
$('form').onsubmit = e => {
  e.preventDefault(); reset();
  if ($('auth').value === 'agent' && $('system-result').value === 'missing') {
    $('auth').value = 'password'; showAuth();
    message('模拟检测：已有配置中没有可用的登录凭证。已为你切换到密码登录，请补充演示密码；也可以选择 SSH 密钥文件。', true); $('password').focus(); return;
  }
  if ($('auth').value === 'password' && !$('password').value) { message('请补充登录密码。预览可点击“填入演示密码”，不要输入真实密码。', true); $('password').focus(); return; }
  if ($('auth').value === 'key' && !$('key').value.trim()) { message('请填写示例密钥路径，例如 C:\\Users\\demo\\.ssh\\id_ed25519。', true); $('key').focus(); return; }
  if (!confirm(`模拟首次连接：${$('host').value}\n主机指纹：SHA256:DEMO（占位）\n正式连接时应向设备管理者核对真实指纹。继续预览？`)) return;
  verified = true; $('password').value = ''; $('passphrase').value = ''; $('deploy').disabled = false;
  $('step1').classList.add('done'); $('step2').classList.add('done');
  message('模拟认证成功 · Linux x64\n可以继续安装接收服务和 Agent Hook，或连接已经安装的服务。');
};
$('deploy').onclick = () => {
  if (!verified) return; const d = save(); if (!d) return;
  d.installed = true; d.online = true; verified = false; $('deploy').disabled = true; $('step3').classList.add('done');
  renderList(); remoteState(); message('模拟部署完成：运行时已准备 → Hook 已注册 → 接收服务已启动。\n设备已进入监控状态，可随时点击列表修改配置或停止。');
};
$('stop').onclick = () => { const d = current(); if (!d) return; d.online = false; reset(); renderList(); remoteState(); message('模拟监控已停止。端侧安装文件保留，下次可重新测试并连接。'); };
$('remove').onclick = () => { const d = current(); if (!d || !confirm(`从预览列表移除“${d.name}”？此操作只删除本页示例记录，不会清理真实设备。`)) return; devices.splice(devices.indexOf(d), 1); openDevice(null); };
openDevice(null);
