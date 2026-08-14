const statePresentation = {
  idle: ["空闲", "等待 Agent 会话"],
  thinking: ["思考中", "Agent 正在规划下一步"],
  working: ["工作中", "Agent 正在执行任务"],
  waiting_permission: ["等待授权", "需要你确认一项操作"],
  completed: ["已完成", "当前任务已经完成"],
  failed: ["执行失败", "当前任务遇到了问题"],
  ended: ["会话结束", "Agent 会话已经结束"],
};

const pet = document.querySelector("#pet");
const stateLabel = document.querySelector("#state-label");
const stateDescription = document.querySelector("#state-description");
const sessionCount = document.querySelector("#session-count");
const permissionCount = document.querySelector("#permission-count");
const sessionsContainer = document.querySelector("#sessions");
const permissionsContainer = document.querySelector("#permissions");

function setPetState(state) {
  const presentation = statePresentation[state] ?? statePresentation.idle;
  pet.className = `pet state-${state}`;
  pet.setAttribute("aria-label", `桌宠当前状态：${presentation[0]}`);
  stateLabel.textContent = presentation[0];
  stateDescription.textContent = presentation[1];
}

function createSessionRow(session) {
  const row = document.createElement("div");
  row.className = "list-row";

  const main = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = `${session.agent} · ${session.sessionId}`;
  const detail = document.createElement("span");
  detail.textContent = statePresentation[session.state]?.[0] ?? session.state;
  main.append(title, detail);

  const time = document.createElement("time");
  time.dateTime = session.updatedAt;
  time.textContent = new Date(session.updatedAt).toLocaleTimeString();
  row.append(main, time);
  return row;
}

function createPermissionRow(request) {
  const row = document.createElement("div");
  row.className = "permission-row";

  const title = document.createElement("strong");
  title.textContent = request.tool.name;
  const detail = document.createElement("span");
  detail.textContent = `${request.agent} · ${request.sessionId}`;
  const summary = document.createElement("p");
  summary.textContent = request.tool.summary ?? "未提供操作摘要";

  const actions = document.createElement("div");
  actions.className = "actions";
  for (const [decision, label] of [["deny", "Deny"], ["allow", "Allow"]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = decision;
    button.textContent = label;
    button.addEventListener("click", async () => {
      for (const action of actions.querySelectorAll("button")) {
        action.disabled = true;
      }
      try {
        await window.vibemate.submitDecision({
          requestId: request.requestId,
          sourceProfile: request.sourceProfile,
          agent: request.agent,
          sessionId: request.sessionId,
        }, decision);
      } finally {
        for (const action of actions.querySelectorAll("button")) {
          action.disabled = false;
        }
      }
    });
    actions.append(button);
  }

  row.append(title, detail, summary, actions);
  return row;
}

function render(snapshot) {
  const sessions = Array.isArray(snapshot?.sessions) ? snapshot.sessions : [];
  const permissions = Array.isArray(snapshot?.pendingPermissions)
    ? snapshot.pendingPermissions
    : [];

  sessionCount.textContent = String(sessions.length);
  permissionCount.textContent = String(permissions.length);

  sessionsContainer.replaceChildren(...sessions.map(createSessionRow));
  sessionsContainer.classList.toggle("empty", sessions.length === 0);
  if (sessions.length === 0) {
    sessionsContainer.textContent = "暂无会话";
  }

  permissionsContainer.replaceChildren(...permissions.map(createPermissionRow));
  permissionsContainer.classList.toggle("empty", permissions.length === 0);
  if (permissions.length === 0) {
    permissionsContainer.textContent = "暂无待处理请求";
  }

  setPetState(permissions.length > 0
    ? "waiting_permission"
    : sessions[0]?.state ?? "idle");
}

window.vibemate.onSnapshot(render);
render(await window.vibemate.getSnapshot());
