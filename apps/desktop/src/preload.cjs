const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("host", {
  call: (action, data) => ipcRenderer.invoke("host", action, data),
  onOAuth: callback => { const listener=(_e,open)=>callback(open===true);ipcRenderer.on("desktop-oauth",listener);return ()=>ipcRenderer.removeListener("desktop-oauth",listener); },
  onChromeDrag: callback => { const listener=(_e,state)=>callback(state);ipcRenderer.on("desktop-chrome-drag",listener);return ()=>ipcRenderer.removeListener("desktop-chrome-drag",listener); },
  onUpdate: callback => { const listener=(_e,state)=>callback(state);ipcRenderer.on("desktop-update-state",listener);return ()=>ipcRenderer.removeListener("desktop-update-state",listener); },
});
