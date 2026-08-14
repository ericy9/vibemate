const stateLabels = {
  idle: "空闲",
  thinking: "思考中",
  working: "工作中",
  waiting_permission: "等待授权",
  completed: "已完成",
  failed: "执行失败",
  ended: "会话结束",
};

const pet = document.querySelector("#pet");
const stateLabel = document.querySelector("#state-label");
const openPanel = document.querySelector("#open-panel");

function render(snapshot) {
  const sessions = Array.isArray(snapshot?.sessions) ? snapshot.sessions : [];
  const permissions = Array.isArray(snapshot?.pendingPermissions)
    ? snapshot.pendingPermissions
    : [];
  const state = permissions.length > 0
    ? "waiting_permission"
    : sessions[0]?.state ?? "idle";
  const label = stateLabels[state] ?? stateLabels.idle;

  pet.className = `pet state-${state}`;
  pet.setAttribute("aria-label", `桌宠当前状态：${label}`);
  stateLabel.textContent = label;
}

openPanel.addEventListener("click", () => {
  window.vibemate.showControlPanel();
});

window.vibemate.onSnapshot(render);
render(await window.vibemate.getSnapshot());
