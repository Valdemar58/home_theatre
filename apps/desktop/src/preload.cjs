const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("host", {
  call: (action, data) => ipcRenderer.invoke("host", action, data),
  onOAuth: callback => { const listener=(_e,open)=>callback(open===true);ipcRenderer.on("desktop-oauth",listener);return ()=>ipcRenderer.removeListener("desktop-oauth",listener); },
});
