const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vibemate", {
  getSnapshot: () => ipcRenderer.invoke("vibemate:get-snapshot"),
  hidePreview: () => ipcRenderer.send("vibemate:hide-preview"),
  reportPreviewState: (state) => ipcRenderer.send("vibemate:preview-state", state),
  dragPreview: (phase, dx, dy) => ipcRenderer.send("vibemate:preview-drag", phase, dx, dy),
  setCodexApprovals: (environmentId, enabled) => ipcRenderer.invoke("vibemate:set-codex-approvals", environmentId, enabled),
  submitDecision: (identity, decision) => (
    ipcRenderer.invoke("vibemate:submit-decision", identity, decision)
  ),
  scanEnvironments: () => ipcRenderer.invoke("vibemate:scan-environments"),
  setEnvironmentEnabled: (environmentId, enabled) => (
    ipcRenderer.invoke("vibemate:set-environment-enabled", environmentId, enabled)
  ),
  startEnvironment: (environmentId) => ipcRenderer.invoke("vibemate:start-environment", environmentId),
  stopEnvironment: (environmentId) => ipcRenderer.invoke("vibemate:stop-environment", environmentId),
  setFocus: (focus) => ipcRenderer.invoke("vibemate:set-focus", focus),
  addSshEnvironment: (host) => ipcRenderer.invoke("vibemate:add-ssh-environment", host),
  pickPrivateKey: () => ipcRenderer.invoke("vibemate:pick-private-key"),
  testSshConnection: (input) => ipcRenderer.invoke("vibemate:test-ssh-connection", input),
  saveSshEnvironment: (input) => ipcRenderer.invoke("vibemate:save-ssh-environment", input),
  removeSshEnvironment: (environmentId) => ipcRenderer.invoke("vibemate:remove-ssh-environment", environmentId),
  showControlPanel: () => ipcRenderer.send("vibemate:show-control"),
  quitApp: () => ipcRenderer.send("vibemate:quit"),
  onSnapshot: (listener) => {
    const handler = (_event, snapshot) => listener(snapshot);
    ipcRenderer.on("vibemate:snapshot", handler);
    return () => ipcRenderer.removeListener("vibemate:snapshot", handler);
  },
});
