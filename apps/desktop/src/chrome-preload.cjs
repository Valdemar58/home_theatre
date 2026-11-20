// Narrow account bridge; secrets and filesystem access remain in the main process.
const { ipcRenderer, contextBridge } = require("electron");
contextBridge.exposeInMainWorld("homeTheaterDesktop", Object.freeze({
  linkDevice: () => ipcRenderer.invoke("desktop-link-device"),
  unlinkDevice: () => ipcRenderer.invoke("desktop-unlink-device"),
  deviceInfo: () => ipcRenderer.invoke("desktop-device-info"),
  openLocalLibrary: () => ipcRenderer.send("desktop-local-library"),
}));
window.addEventListener("DOMContentLoaded", () => {
  if (window.top !== window) return;
  const playback=()=>ipcRenderer.send("desktop-playback-state",[...document.querySelectorAll("video")].some(v=>!v.paused&&!v.ended));
  for(const event of ["play","pause","ended","emptied"])document.addEventListener(event,playback,true);
  playback();
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
    #menu{min-width:0}#server{overflow:hidden;text-overflow:ellipsis;max-width:55vw}
  </style><nav aria-label="Навигация приложения"><button id="back" aria-label="Назад" title="Назад (Alt+←)" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg></button><button id="menu" aria-label="Выбрать сервер" aria-haspopup="menu"><span id="server">home_theater</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg></button><button id="device-settings" aria-label="Мои устройства" title="Мои устройства"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></svg></button></nav>`;
  root.querySelector("#menu").addEventListener("click",()=>ipcRenderer.send("desktop-menu"));
  ipcRenderer.on("desktop-picker-state",(_event,state)=>{const menu=root.querySelector("#menu");menu.setAttribute("aria-expanded",String(!!state.open));if(state.focus)menu.focus();});
  const back = root.querySelector("#back");
  back.addEventListener("click",()=>ipcRenderer.send("desktop-go-back"));
  root.querySelector("#device-settings").addEventListener("click",()=>ipcRenderer.send("desktop-local-settings"));
  document.addEventListener("pointerdown",event=>{if(!event.composedPath().includes(chrome))ipcRenderer.send("desktop-dismiss-picker");});
  document.addEventListener("keydown",event=>{if(event.key==="Escape")ipcRenderer.send("desktop-dismiss-picker");});
  ipcRenderer.on("desktop-navigation-state",(_event,state)=>{back.disabled=!state?.canGoBack;const label=root.querySelector("#server");label.textContent=state?.server||"home_theater";label.title=label.textContent;});
  const style = document.createElement("style");
  style.textContent = `html{padding-top:40px;scroll-padding-top:120px}body{min-height:calc(100vh - 40px)!important}.app-header{top:40px!important}aside.fixed{top:40px!important;height:calc(100dvh - 40px)!important}html:is(:fullscreen,:has(:fullscreen)){padding-top:0}html:is(:fullscreen,:has(:fullscreen)) #home-theater-chrome{display:none}`;
  document.head.append(style);
  document.body.append(chrome);
  const dragLayout=()=>ipcRenderer.send("desktop-chrome-layout",{left:Math.ceil(root.querySelector('#device-settings').getBoundingClientRect().right)+8,visible:!document.fullscreenElement});
  new ResizeObserver(dragLayout).observe(root.querySelector('#menu'));
  window.addEventListener('resize',dragLayout);
  document.addEventListener('fullscreenchange',dragLayout);
  dragLayout();
  ipcRenderer.send("desktop-navigation-ready");
});
