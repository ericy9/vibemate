const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vibemate", {
  getSnapshot: () => ipcRenderer.invoke("vibemate:get-snapshot"),
  submitDecision: (identity, decision) => (
    ipcRenderer.invoke("vibemate:submit-decision", identity, decision)
  ),
  showControlPanel: () => ipcRenderer.send("vibemate:show-control"),
  quitApp: () => ipcRenderer.send("vibemate:quit"),
  onSnapshot: (listener) => {
    const handler = (_event, snapshot) => listener(snapshot);
    ipcRenderer.on("vibemate:snapshot", handler);
    return () => ipcRenderer.removeListener("vibemate:snapshot", handler);
  },
});
