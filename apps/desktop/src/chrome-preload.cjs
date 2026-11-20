// Narrow account bridge; secrets and filesystem access remain in the main process.
const { ipcRenderer, contextBridge } = require("electron");
contextBridge.exposeInMainWorld("homeTheaterDesktop", Object.freeze({
  linkDevice: () => ipcRenderer.invoke("desktop-link-device"),
  unlinkDevice: () => ipcRenderer.invoke("desktop-unlink-device"),
  deviceInfo: () => ipcRenderer.invoke("desktop-device-info"),
  addStorage: () => ipcRenderer.invoke("desktop-storage-add"),
}));
window.addEventListener("DOMContentLoaded", () => {
  if (window.top !== window) return;
  const chrome = document.createElement("div");
  chrome.id = "home-theater-chrome";
  const root = chrome.attachShadow({mode:"closed"});
  root.innerHTML = `<style>
    :host{position:fixed;inset:0 0 auto;height:40px;z-index:2147483647;background:#111827;color:#d1d5db;font:12px system-ui;-webkit-app-region:drag;user-select:none}
    nav{height:40px;display:flex;align-items:center;gap:2px;padding:0 150px 0 8px}
    button{height:32px;padding:0 10px;display:flex;align-items:center;gap:10px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;-webkit-app-region:no-drag;cursor:pointer;white-space:nowrap}
    button:hover{background:#1f2937;color:#fff}button:focus-visible{outline:2px solid #b4b8f6;outline-offset:-2px}
    button:disabled{opacity:.35;cursor:default}button:disabled:hover{background:transparent;color:inherit}
    #back{width:36px;padding:0;justify-content:center;flex-shrink:0}
    svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:1.5}
  </style><nav aria-label="Навигация приложения"><button id="back" aria-label="Назад" title="Назад (Alt+←)" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg></button><button id="menu" aria-label="Меню home_theater"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>home_theater</button></nav>`;
  root.querySelector("#menu").addEventListener("click",()=>ipcRenderer.send("desktop-menu"));
  const back = root.querySelector("#back");
  back.addEventListener("click",()=>ipcRenderer.send("desktop-go-back"));
  ipcRenderer.on("desktop-navigation-state",(_event,state)=>{back.disabled=!state?.canGoBack;});
  const style = document.createElement("style");
  style.textContent = `html{padding-top:40px;scroll-padding-top:120px}body{min-height:calc(100vh - 40px)!important}.app-header{top:40px!important}aside.fixed{top:40px!important;height:calc(100dvh - 40px)!important}html:is(:fullscreen,:has(:fullscreen)){padding-top:0}html:is(:fullscreen,:has(:fullscreen)) #home-theater-chrome{display:none}`;
  document.head.append(style);
  document.body.append(chrome);
  ipcRenderer.send("desktop-navigation-ready");
});
