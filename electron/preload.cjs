const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("clearviewDesktop", {
  platform: process.platform,
  telemetry: () => ipcRenderer.invoke("clearview:telemetry"),
  allowScreenCapture: () => ipcRenderer.invoke("clearview:arm-capture"),
  onDisplaysChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("clearview:displays-changed", handler);
    return () =>
      ipcRenderer.removeListener("clearview:displays-changed", handler);
  },
});
