import { createSshDeviceDialog } from './ssh-device-dialog.js';

const environmentsContainer = document.querySelector("#environments");
const scanButton = document.querySelector("#scan-environments");
const onboardingTip = document.querySelector("#onboarding-tip");
const focusSelect = document.querySelector("#pet-focus");
const petSection = document.querySelector("#pet-section");
const systemNotifications = document.querySelector("#system-notifications");
const addSshButton = document.querySelector("#add-ssh");
const feedback = document.querySelector("#settings-feedback");
const sshDialog = createSshDeviceDialog(window.vibemate, render, message => { feedback.textContent = message; });

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
      else if (environment.sshConnection) { sshDialog.open(environment); }
      else await window.vibemate.startEnvironment(environment.environmentId);
    } catch (error) {
      feedback.textContent = error.message;
    } finally {
      action.disabled = false;
    }
  });
  const actions = document.createElement("div");
  actions.className = "environment-actions";
  if (environment.sshConnection) {
    const edit = document.createElement("button"); edit.type = "button"; edit.className = "compact secondary";
    edit.textContent = "连接设置"; edit.disabled = active;
    edit.onclick = () => sshDialog.open(environment); actions.append(edit);
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "compact secondary";
    remove.textContent = "移除配置"; remove.disabled = active;
    remove.onclick = async () => {
      remove.disabled = true;
      try { render(await window.vibemate.removeSshEnvironment(environment.environmentId)); }
      catch (error) { feedback.textContent = error.message; }
      finally { remove.disabled = false; }
    };
    actions.append(remove);
    const address = document.createElement("span");
    address.textContent = `${environment.sshConnection.username}@${environment.sshConnection.host}:${environment.sshConnection.port}`;
    main.append(address);
  }
  actions.append(action); row.append(main, actions);
  return row;
}

function render(snapshot) {
  const sessions = Array.isArray(snapshot?.sessions) ? snapshot.sessions : [];
  const environments = Array.isArray(snapshot?.environments) ? snapshot.environments : [];
  environmentsContainer.replaceChildren(...environments.map(createEnvironmentRow));
  environmentsContainer.classList.toggle("empty", environments.length === 0);
  if (environments.length === 0) environmentsContainer.textContent = "未发现环境";
  onboardingTip.hidden = Boolean(snapshot?.onboardingCompleted);
  petSection.hidden = snapshot?.preferences?.petEnabled !== true;
  systemNotifications.checked = snapshot?.preferences?.systemNotifications !== false;
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
addSshButton.addEventListener("click", () => sshDialog.open());

systemNotifications.addEventListener("change", async () => {
  systemNotifications.disabled = true;
  try { render(await window.vibemate.setSystemNotifications(systemNotifications.checked)); }
  catch (error) { feedback.textContent = error.message; }
  finally { systemNotifications.disabled = false; }
});

// Easter egg: click the title five times in quick succession to wake the pet.
let titleClicks = [];
document.querySelector("#settings-title").addEventListener("click", async () => {
  const now = Date.now();
  titleClicks = [...titleClicks.filter((time) => now - time < 2_000), now];
  if (titleClicks.length < 5) return;
  titleClicks = [];
  render(await window.vibemate.setPetEnabled(true));
});
document.querySelector("#pet-disable").addEventListener("click", async () => {
  render(await window.vibemate.setPetEnabled(false));
});
