const environmentsContainer = document.querySelector("#environments");
const scanButton = document.querySelector("#scan-environments");
const onboardingTip = document.querySelector("#onboarding-tip");
const focusSelect = document.querySelector("#pet-focus");
const addSshButton = document.querySelector("#add-ssh");

function addApprovalSettings(main, environment) {
  const approvalLabel = document.createElement("label");
  const approval = document.createElement("input");
  approval.type = "checkbox";
  approval.checked = environment.codexApprovalsEnabled === true;
  approval.addEventListener("change", async () => {
    approval.disabled = true;
    try { await window.vibemate.setCodexApprovals(environment.environmentId, approval.checked); }
    catch (error) { approval.checked = environment.codexApprovalsEnabled === true; window.alert(error.message); }
    finally { approval.disabled = false; }
  });
  approvalLabel.append(approval, " 在 VibeMate 中审批 Codex（默认关闭）");
  const copilotHint = document.createElement("span");
  copilotHint.textContent = "Copilot 仅监控与提醒，权限请在原终端处理。";
  main.append(approvalLabel, copilotHint);

}

function createEnvironmentRow(environment) {
  const row = document.createElement("div");
  row.className = "list-row environment-row";
  const main = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = environment.name;
  const detail = document.createElement("span");
  const kind = { windows: "Windows", wsl: "WSL", ssh: "SSH" }[environment.kind] ?? environment.kind;
  const status = { stopped: "未启动", starting: "启动中", connected: "已连接", disconnected: "已断开", error: "启动失败" }[environment.status] ?? environment.status;
  detail.textContent = `${kind} · ${status}${environment.error ? ` · ${environment.error}` : ""}`;
  main.append(title, detail);
  addApprovalSettings(main, environment);
  const action = document.createElement("button");
  action.type = "button";
  action.className = "compact";
  const active = environment.status === "connected" || environment.status === "starting";
  action.textContent = active ? "停止" : environment.kind === "ssh" ? "开始监控" : "启用";
  action.disabled = environment.status === "starting";
  action.addEventListener("click", async () => {
    action.disabled = true;
    try {
      if (active) await window.vibemate.stopEnvironment(environment.environmentId);
      else if (environment.kind === "windows") await window.vibemate.setEnvironmentEnabled(environment.environmentId, true);
      else await window.vibemate.startEnvironment(environment.environmentId);
    } finally {
      action.disabled = false;
    }
  });
  row.append(main, action);
  return row;
}

function render(snapshot) {
  const sessions = Array.isArray(snapshot?.sessions) ? snapshot.sessions : [];
  const environments = Array.isArray(snapshot?.environments) ? snapshot.environments : [];
  environmentsContainer.replaceChildren(...environments.map(createEnvironmentRow));
  environmentsContainer.classList.toggle("empty", environments.length === 0);
  if (environments.length === 0) environmentsContainer.textContent = "未发现环境";
  onboardingTip.hidden = Boolean(snapshot?.onboardingCompleted);
  const focusOptions = [new Option("全部任务", "all:"),
    ...(snapshot?.devices ?? []).map((item) => new Option(`设备 · ${item.name}`, `device:${item.deviceId}`)),
    ...environments.map((item) => new Option(`环境 · ${item.name}`, `environment:${item.environmentId}`)),
    ...sessions.map((item) => new Option(`会话 · ${item.sessionId}`, `session:${item.environmentId}/${item.agent}/${item.sessionId}`))];
  const selectedFocus = `${snapshot?.preferences?.focus?.kind ?? "all"}:${snapshot?.preferences?.focus?.id ?? ""}`;
  focusSelect.replaceChildren(...focusOptions);
  focusSelect.value = selectedFocus;
}

window.vibemate.onSnapshot(render);
render(await window.vibemate.getSnapshot());
scanButton.addEventListener("click", async () => {
  scanButton.disabled = true;
  scanButton.textContent = "扫描中…";
  try { render(await window.vibemate.scanEnvironments()); }
  finally { scanButton.disabled = false; scanButton.textContent = "扫描本机与 WSL"; }
});
focusSelect.addEventListener("change", async () => {
  const separator = focusSelect.value.indexOf(":");
  const kind = focusSelect.value.slice(0, separator);
  const id = focusSelect.value.slice(separator + 1);
  render(await window.vibemate.setFocus(kind === "all" ? { kind } : { kind, id }));
});
addSshButton.addEventListener("click", async () => {
  const host = window.prompt("请输入 ~/.ssh/config 中的主机别名（例如 pi）");
  if (!host) return;
  render(await window.vibemate.addSshEnvironment(host.trim()));
});
