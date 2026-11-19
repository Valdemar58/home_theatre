const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("host", {
  call: (action, data) => ipcRenderer.invoke("host", action, data),
});
