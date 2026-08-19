const stateLabels = {
  idle: "空闲",
  thinking: "思考中",
  working: "工作中",
  waiting_permission: "等待授权",
  completed: "已完成",
  failed: "执行失败",
  ended: "会话结束",
};

const assetPath = (name) => `./assets/pet/${name}.webm`;
const stateLoops = {
  idle: "idle",
  thinking: "thinking",
  working: "working",
  waiting_permission: "waiting-permission",
};
const permissionReminderDelayMs = 30_000;

const pet = document.querySelector("#pet");
const petVideo = document.querySelector("#pet-video");
const stateLabel = document.querySelector("#state-label");
const openPanel = document.querySelector("#open-panel");
const quitApp = document.querySelector("#quit-app");

let requestedState;
let activeState = "idle";
let transitionVersion = 0;
let cancelPlayback;
let permissionReminderTimer;

function cancelCurrentPlayback() {
  cancelPlayback?.();
  cancelPlayback = undefined;
}

function clearPermissionReminder() {
  if (permissionReminderTimer !== undefined) {
    window.clearTimeout(permissionReminderTimer);
    permissionReminderTimer = undefined;
  }
}

function setVideo(asset, loop) {
  cancelCurrentPlayback();
  petVideo.loop = loop;
  const source = assetPath(asset);
  if (!petVideo.src.endsWith(source.replace("./", "/"))) {
    petVideo.src = source;
  }
  petVideo.currentTime = 0;
  void petVideo.play().catch(() => undefined);
}

function playOnce(asset) {
  cancelCurrentPlayback();
  petVideo.loop = false;
  petVideo.src = assetPath(asset);
  petVideo.currentTime = 0;

  return new Promise((resolve) => {
    const finish = (completed) => {
      petVideo.removeEventListener("ended", handleEnded);
      if (cancelPlayback === cancel) {
        cancelPlayback = undefined;
      }
      resolve(completed);
    };
    const handleEnded = () => finish(true);
    const cancel = () => finish(false);

    cancelPlayback = cancel;
    petVideo.addEventListener("ended", handleEnded, { once: true });
    void petVideo.play().catch(() => finish(false));
  });
}

function showLoop(asset) {
  setVideo(asset, true);
}

function schedulePermissionReminder(version) {
  clearPermissionReminder();
  permissionReminderTimer = window.setTimeout(async () => {
    if (
      version !== transitionVersion ||
      requestedState !== "waiting_permission"
    ) {
      return;
    }

    const completed = await playOnce("permission-reminder");
    if (
      completed &&
      version === transitionVersion &&
      requestedState === "waiting_permission"
    ) {
      showLoop("waiting-permission");
      schedulePermissionReminder(version);
    }
  }, permissionReminderDelayMs);
}

async function transitionTo(state) {
  requestedState = state;
  const previousState = activeState;
  const version = ++transitionVersion;
  clearPermissionReminder();
  cancelCurrentPlayback();

  if (previousState === "working" && state !== "working") {
    await playOnce("working-exit");
  } else if (previousState === "ended" && state !== "ended") {
    await playOnce("wake");
  }

  if (version !== transitionVersion) return;
  activeState = state;

  if (state === "working") {
    if (previousState !== "working") {
      await playOnce("working-enter");
      if (version !== transitionVersion) return;
    }
    showLoop("working");
    return;
  }

  if (state === "ended") {
    if (previousState !== "ended") {
      await playOnce("sleep-enter");
      if (version !== transitionVersion) return;
    }
    showLoop("sleep");
    return;
  }

  if (state === "completed") {
    await playOnce("completed");
    if (version === transitionVersion) showLoop("idle");
    return;
  }

  if (state === "failed") {
    await playOnce("failed");
    if (version === transitionVersion) showLoop("idle");
    return;
  }

  const loop = stateLoops[state] ?? stateLoops.idle;
  showLoop(loop);
  if (state === "waiting_permission") {
    schedulePermissionReminder(version);
  }
}

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
  pet.classList.add("has-video");
  pet.setAttribute("aria-label", `桌宠当前状态：${label}`);
  stateLabel.textContent = label;

  if (state !== requestedState) {
    void transitionTo(state);
  }
}

openPanel.addEventListener("click", () => {
  window.vibemate.showControlPanel();
});

quitApp.addEventListener("click", () => {
  window.vibemate.quitApp();
});

window.vibemate.onSnapshot(render);
render(await window.vibemate.getSnapshot());
