import {
  app,
  BrowserWindow,
  dialog,
  session,
  ipcMain,
  protocol,
  net,
  shell,
  safeStorage,
  Menu,
} from "electron";
import { mkdir } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostname } from "node:os";
import { installationKey } from "./device-identity.mjs";
import { serverUrl } from "./server-url.mjs";
import { allowAppFullscreen } from "./desktop-permissions.mjs";
import { Library } from "./library.mjs";
import { prepare, stopPreparation } from "./prepare.mjs";
import { HostTransport } from "./transport.mjs";
import { Downloads } from "./downloads.mjs";
import { RemoteDownloads } from "./remote-downloads.mjs";
import { StorageLocations } from "./storage-locations.mjs";
import { detectVolumes } from "./volumes.mjs";
import { Profiles, normalizeServerAddress } from "./profiles.mjs";
import { product } from "./product.mjs";
let profiles, pickerWindow, rtcWindow, switching=false, probeGeneration=0;
let playbackActive=false;
const profileSession = () => profiles?.partition() ? session.fromPartition(profiles.partition()) : session.defaultSession;
let remoteDownloads, webWindow, quitting = false;
let downloads;
let storageLocations;
let metadataRequest;
let transport;
const root = dirname(fileURLToPath(import.meta.url));
const defaultMedia = () => config.downloadFolder || (!app.isPackaged&&process.env.HOME_THEATER_TEST_PROFILE?join(app.getPath("userData"),"media"):join(app.getPath("videos"),"home_theater"));
// Isolated developer fixtures must not overwrite a user's real account/library.
if (!app.isPackaged && process.env.HOME_THEATER_TEST_PROFILE) app.setPath("userData", process.env.HOME_THEATER_TEST_PROFILE);
protocol.registerSchemesAsPrivileged([
  {
    scheme: "hostapp",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
app.enableSandbox();
let window,
  library,
  config = {},
  token = "",
  pair = null,
  rooms = [],
  grants = [],
  networkError = "",
  importProgress = null,
  importing = false,
  sending = false;
const secretAvailable = () =>
  safeStorage.isEncryptionAvailable() &&
  (process.platform !== "linux" ||
    safeStorage.getSelectedStorageBackend() !== "basic_text");
async function save() {
  if (!profiles?.active) return;
  profiles.active.settings={
      ...config,
      secret:
        token && secretAvailable()
          ? safeStorage.encryptString(token).toString("base64")
          : config.approved ? config.secret : undefined,
    };
  await profiles.save();
}
async function request(path, body, auth = true, origin = config.server, signal) {
  const requestToken = token;
  const requestProfile = profiles?.active?.id;
  // Use the same system proxy/PAC handling as the application window.
  const response = await net.fetch(origin + path, {
    credentials: "omit",
    method: body ? "POST" : "GET",
    headers: {
      "X-Desktop-Protocol": "2",
      ...(auth ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.any([AbortSignal.timeout(path === "/api/desktop/releases" ? 180000 : 15000), ...(signal ? [signal] : [])]),
    redirect: "error",
  });
  const result = await response.json().catch(() => ({}));
  if(requestProfile!==profiles?.active?.id)throw Error("Профиль сервера изменился");
  if (!response.ok) {
    if (response.status === 401 && auth && token === requestToken) {
      networkError = "Устройство отключено. Привяжите аккаунт заново.";
      token = "";
      pair = null;
      rooms = [];
      grants = [];
      config.approved = false;
      await save();
    }
    throw new Error(result.error || `Ошибка сервера ${response.status}`);
  }
  return result;
}
let bindingBusy=false;
async function accountBinding(action="status") {
  if(bindingBusy)throw new Error("Подключение уже выполняется");
  if(action==="unlink" && (remoteDownloads?.busy || sending))throw new Error("Дождитесь завершения текущего задания и повторите отвязку");
  bindingBusy=true;
  try {
    const dir=!app.isPackaged && process.env.HOME_THEATER_TEST_PROFILE ? app.getPath("userData") : join(app.getPath("appData"),"home_theater-device");
    const key=await installationKey(join(dir,"installation.key"));
    const r=await profileSession().fetch(config.server+"/api/desktop/binding",{method:"POST",headers:{"Content-Type":"application/json",Origin:config.server},body:JSON.stringify({action,key,label:hostname().slice(0,80),platform:process.platform,previousToken:token||undefined}),redirect:"error"});
    const result=await r.json();
    if(!r.ok)throw new Error(result.error||"Не удалось подключить устройство");
    if(action==="unlink") {
      // Stop the former account's host and pending local work before another account takes over.
      stopPreparation();
      if(transport){transport.streams=[];transport.seen=0;}
      for(const j of downloads.jobs??[])if(["downloading","verifying"].includes(j.state))await downloads.pause(j.id);
      token="";pair=null;grants=[];rooms=[];config.approved=false;await save();
    }
    if(action==="link") {
      if(result.token)token=result.token;
      pair=null;config.deviceId=result.id;config.approved=true;await save();await heartbeat();
    }
    return {id:result.id,status:result.status,active:result.status==="linked" && !!token && !!config.approved,alreadyLinked:!!result.alreadyLinked};
  } finally {bindingBusy=false;}
}
async function heartbeat() {
  if (!token || pair || sending) return;
  sending = true;
  const expectedToken = token;
  try {
    await library.refresh();
    const r = await request("/api/desktop/host", {
      action: "heartbeat",
      files: library.publicFiles(),
    });
    if (token !== expectedToken) return;
    if (r.deviceId && config.deviceId !== r.deviceId) { config.deviceId = r.deviceId; await save(); }
    rooms = r.rooms;
    grants = r.grants;
    networkError = "";
  } catch (e) {
    networkError = e.message;
  } finally {
    sending = false;
  }
}
async function openApp(room, destination) {
  if (!config.server) throw new Error("Сначала укажите сервер");
  if (webWindow && !webWindow.isDestroyed()) { webWindow.show(); webWindow.focus(); if (destination || room) await webWindow.loadURL(config.server + (destination || `/groups/${room}`)); window.hide(); return; }
  webWindow = new BrowserWindow({ width: 1280, height: 860, minWidth: 360, minHeight: 500,
    backgroundColor: "#111827", titleBarStyle: "hidden", titleBarOverlay: { color: "#111827", symbolColor: "#d1d5db", height: 40 },
    autoHideMenuBar: true,
    webPreferences: { session:profileSession(), sandbox: true, contextIsolation: true, nodeIntegration: false, preload: join(root,"chrome-preload.cjs") } });
  webWindow.webContents.setWindowOpenHandler(({url}) => { if (new URL(url).protocol === "https:") void shell.openExternal(url); return { action: "deny" }; });
  const guard = (event, url) => { try { const u = new URL(url); if (u.protocol !== "https:" && u.origin !== config.server) event.preventDefault(); } catch { event.preventDefault(); } };
  webWindow.webContents.on("will-navigate", guard);
  webWindow.webContents.on("will-redirect", guard);
  const goBack = () => {
    if (webWindow && !webWindow.isDestroyed() && webWindow.webContents.navigationHistory.canGoBack())
      webWindow.webContents.navigationHistory.goBack();
  };
  const appMenu = Menu.buildFromTemplate([{ label: "home_theater", submenu: [
    { id: "desktop-back", label: "Назад", accelerator: "Alt+Left", enabled: false, click: goBack },
    { label: "Локальные файлы и устройство", click: () => { window.show(); window.focus(); } },
    { label: "Перезагрузить", role: "reload" }, { type: "separator" }, { label: "Завершить", click: () => window.close() },
  ] }]);
  webWindow.setMenu(appMenu);
  webWindow.setMenuBarVisibility(false);
  const navigationState = () => {
    if (!webWindow || webWindow.isDestroyed()) return;
    const canGoBack = webWindow.webContents.navigationHistory.canGoBack();
    appMenu.getMenuItemById("desktop-back").enabled = canGoBack;
    webWindow.webContents.send("desktop-navigation-state", { canGoBack, server:new URL(config.server).host });
  };
  for (const event of ["did-navigate", "did-navigate-in-page", "did-finish-load"])
    webWindow.webContents.on(event, navigationState);
  webWindow.on("app-command", (_event, command) => { if (command === "browser-backward") goBack(); });
  webWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "ArrowLeft" && input.alt && !input.control && !input.meta && !input.shift) {
      event.preventDefault();
      goBack();
    }
  });
  const fromAppWindow = event => webWindow && !webWindow.isDestroyed() &&
    event.sender === webWindow.webContents && event.senderFrame === webWindow.webContents.mainFrame;
  ipcMain.removeAllListeners("desktop-playback-state");
  ipcMain.on("desktop-playback-state",(event,active)=>{if(fromAppWindow(event))playbackActive=active===true;});
  webWindow.webContents.on("did-navigate",()=>{playbackActive=false;});
  ipcMain.removeAllListeners("desktop-go-back");
  ipcMain.on("desktop-go-back", event => { if (fromAppWindow(event)) goBack(); });
  ipcMain.removeAllListeners("desktop-navigation-ready");
  ipcMain.on("desktop-navigation-ready", event => { if (fromAppWindow(event)) navigationState(); });
  ipcMain.removeAllListeners("desktop-menu");
  ipcMain.on("desktop-menu", event => {
    if (webWindow && !webWindow.isDestroyed() && event.sender === webWindow.webContents && event.senderFrame === webWindow.webContents.mainFrame)
      void showPicker().catch(e=>{networkError=e.message;});
  });
  ipcMain.removeAllListeners("desktop-local-settings");
  ipcMain.on("desktop-local-settings",event=>{if(fromAppWindow(event))void setupAction("setup-device-settings",{});});
  for(const s of [profileSession()]){
    const allowed=(contents,permission,url,details)=>allowAppFullscreen({permission,ownWindow:contents===webWindow?.webContents,isMainFrame:details.isMainFrame,requestingUrl:url,server:config.server});
    s.setPermissionRequestHandler((contents,permission,callback,details)=>callback(allowed(contents,permission,details.requestingUrl,details)));
    s.setPermissionCheckHandler((contents,permission,origin,details)=>allowed(contents,permission,details.requestingUrl||origin,details));
  }
  ipcMain.removeHandler("desktop-link-device");
  ipcMain.removeHandler("desktop-device-info");
  ipcMain.removeHandler("desktop-unlink-device");
  const isAppFrame = event => webWindow && event.sender === webWindow.webContents && event.senderFrame === webWindow.webContents.mainFrame && new URL(event.senderFrame.url).origin === config.server;
  ipcMain.handle("desktop-device-info", async event => {
    if(!isAppFrame(event))throw new Error("Недоступно");
    return accountBinding("status");
  });
  ipcMain.handle("desktop-link-device", async event => {
    if(!isAppFrame(event))throw new Error("Недоступно");
    return accountBinding("link");
  });
  ipcMain.handle("desktop-unlink-device", async event => {
    if(!isAppFrame(event))throw new Error("Недоступно");
    return accountBinding("unlink");
  });
  webWindow.on("close", event => { if (!quitting) { event.preventDefault(); window.close(); } });
  try {
    await webWindow.loadURL(config.server + (destination || (room ? `/groups/${room}` : "/") + (config.deviceId ? `?desktopDevice=${encodeURIComponent(config.deviceId)}` : "")));
    window.hide();
  } catch {
    webWindow.destroy(); webWindow = null;
    networkError = "Сервер недоступен. Локальная библиотека сохранена. Повторите открытие home_theater после восстановления связи.";
    window.show();
  }
}
function snapshot() {
  return {
    server: config.server || "",
    linked: !!token && !pair,
    pair,
    rooms,
    grants,
    networkError: networkError || (token ? transport?.error : "") || "",
    importProgress,
    persistent: secretAvailable(),
    files: library.files.map(({ path, output, ...f }) => ({
      ...f,
      name: basename(path),
    })),
    downloads: downloads?.snapshot() || [],
    downloadFolder: storageLocations?.defaultId ? storageLocations.root() : config.downloadFolder || join(app.getPath("videos"), "home_theater"),
  };
}
async function addStorageLocation(volume) {
  const disk=(await storageLocations.scan(true)).find(v=>v.id===volume&&v.online);
  if(!disk)throw new Error("Выберите доступный диск в разделе Загрузки");
  const registered=storageLocations.locations.find(l=>l.volumeId===disk.id);
  if(registered)return {id:registered.id,alreadyConnected:true};
  const parent=webWindow&&!webWindow.isDestroyed()?webWindow:window;
  parent?.show();
  const result=await dialog.showOpenDialog(parent,{title:`Папка медиатеки на ${disk.label}`,defaultPath:disk.root,properties:["openDirectory","createDirectory"]});
  if(result.canceled)return {cancelled:true};
  const location=await storageLocations.add(result.filePaths[0],disk.id);
  if(remoteDownloads)remoteDownloads.storageAt=0;
  return {id:location.id,label:location.label};
}
async function action(kind, data = {}) {
  if(kind==="streams")return switching?[]:transport?.list()||[];
  if (kind.startsWith("setup-") || kind.startsWith("profile-")) return setupAction(kind,data);
  if(switching && kind!=="state")throw Error("Переключаем сервер. Повторите действие после подключения.");
  if (kind === "stream-read") return transport.read(String(data.lease), data.offset, data.length);
  if (kind === "stream-answer") return transport.answer(String(data.lease), data.answer, data.generation, data.negotiation);
  if (kind === "state") return snapshot();
  if (kind === "connect") {
    const origin=normalizeServerAddress(data.server,{development:!app.isPackaged});
    if(origin===config.server)return openApp();
    await showSetup(true);return;
  }
  if (["releases", "download-inspect"].includes(kind) && (!token || pair)) throw new Error("Сначала привяжите аккаунт");
  if (kind === "releases") return request("/api/desktop/releases", { query: String(data.query) });
  if (kind === "download-inspect") {
    if (metadataRequest) throw new Error("Уже получаем список файлов. Дождитесь результата или отмените запрос.");
    const controller = new AbortController(); metadataRequest = controller;
    try {
      const r = await request("/api/desktop/releases", { action: "torrent", id: String(data.id) }, true, config.server, controller.signal);
      if (controller.signal.aborted) throw new Error("Получение списка файлов отменено");
      return await (r.magnet
        ? downloads.inspectMagnet(r.magnet, Number(data.title), data.titleName, r.title)
        : downloads.inspect(r.torrent, Number(data.title), data.titleName, r.title));
    } catch (e) { if (controller.signal.aborted) throw new Error("Получение списка файлов отменено"); throw e; }
    finally { metadataRequest = null; }
  }
  if (kind === "download-metadata-cancel") { metadataRequest?.abort(); return downloads.cancelMetadata(); }
  if (kind === "download-folder") {
    await openApp(undefined,"/downloads");
    return;
  }
  if (kind === "download-start") {downloads.get(String(data.id)).storageId=data.target||storageLocations.defaultId;return downloads.start(String(data.id),data.selections,await storageLocations.checkedRoot(data.target||undefined),data.autoPrepare);}
  if (kind === "download-pause") return downloads.pause(String(data.id));
  if (kind === "download-resume") return downloads.resume(String(data.id));
  if (kind === "download-cancel") return downloads.cancel(String(data.id));
  if (kind === "download-forget") return downloads.forget(String(data.id));
  if (kind === "pair") {
    await openApp(undefined,"/devices");
    return snapshot();
  }

  if (kind === "web") {
    const requestedRoom = Number(data.room);
    await openApp(Number.isSafeInteger(requestedRoom) && rooms.some(r => r.id === requestedRoom) ? requestedRoom : undefined);
    return;
  }
  if (["search", "grant"].includes(kind) && (!token || pair))
    throw new Error("Сначала привяжите аккаунт");
  if (kind === "search")
    return request("/api/desktop/host", {
      action: "search",
      query: String(data.query),
    });
  if (kind === "import") {
    if (importing) throw new Error("Уже подключается файл");
    const title = Number(data.title),
      ep = Number(data.ep);
    if (
      !Number.isSafeInteger(title) ||
      title <= 0 ||
      !Number.isSafeInteger(ep) ||
      ep <= 0
    )
      throw new Error("Укажите ID тайтла и номер серии");
    const result = await dialog.showOpenDialog(window, {
      properties: ["openFile"],
      filters: [
        {
          name: "Видео",
          extensions: ["mkv", "mp4", "webm", "avi", "m4v", "mov"],
        },
      ],
    });
    if (result.canceled) return;
    importing = true;
    try {
      const file = await library.add(result.filePaths[0], title, ep, (p) => {
        importProgress = p;
      });
      file.titleName = String(data.titleName || title).slice(0, 250);
      await library.save();
      await heartbeat();
    } finally {
      importing = false;
      importProgress = null;
    }
    return;
  }
  if (kind === "prepare") {
    prepare(library, String(data.id))
      .then(heartbeat)
      .catch((e) => {
        networkError = e.message;
      });
    return;
  }
  if (kind === "remove") {
    await library.remove(String(data.id));
    await heartbeat();
    return;
  }
  if (kind === "grant") {
    if (typeof data.enabled !== "boolean")
      throw new Error("Некорректное разрешение");
    await heartbeat();
    const r = await request("/api/desktop/host", {
      action: "grant",
      title: Number(data.title),
      room: Number(data.room),
      enabled: data.enabled,
    });
    rooms = r.rooms;
    grants = r.grants;
    return;
  }
  throw new Error("Неизвестное действие");
}
async function loadLocalServices(){
  const id=profiles.active?.id, directory=profiles.directoryFor();
  library=new Library(join(directory,"library"));await library.load();
  downloads=new Downloads(join(directory,"downloads"),library,async(...args)=>{await prepare(...args);await heartbeat();},{isInUse:file=>!!file&&!!transport?.list().some(s=>s.file===file),validateFolder:(folder,storage)=>storageLocations?.validateFolder(folder,storage)});
  await downloads.load();
  storageLocations=new StorageLocations(app.getPath("userData"),downloads,{detect:detectVolumes});
  await storageLocations.load(defaultMedia());
  remoteDownloads=new RemoteDownloads(downloads,body=>{
    if(switching||profiles.active?.id!==id)throw Error("Профиль сервера не активен");
    return request("/api/desktop/commands",body);
  },join(directory,"remote-receipts.json"),()=>storageLocations.defaultId?storageLocations.root():null,{locations:storageLocations,addLocation:addStorageLocation});
  await remoteDownloads.load();
  transport=new HostTransport(library,()=>!switching&&profiles.active?.id===id?{server:config.server,token:pair?"":token}:{server:"",token:""},(url,options)=>net.fetch(url,options));transport.start();
}
async function changeProfile(profile,confirm=false){

  if(switching)throw Error("Сервер уже переключается");
  if(profile.id===profiles.active?.id)return {ok:true};
  if(transport?.list().length)throw Error("Этот компьютер предоставляет видео комнате. Сначала завершите просмотр.");
  if(playbackActive)throw Error("Сначала приостановите просмотр, чтобы сменить сервер.");
  if(importing||metadataRequest||downloads?.preparing||library.files.some(f=>f.state==="preparing")||storageLocations?.progress||storageLocations?.recoveryError)throw Error("Дождитесь завершения подготовки, переноса или текущего задания");
  if(switching)throw Error("Сервер уже переключается");
  switching=true;let altered=false;const previous={id:profiles.data.activeId,config,token,hadWindow:!!webWindow&&!webWindow.isDestroyed()};
  try{
    const deadline=Date.now()+15000;
    while(bindingBusy||sending||remoteDownloads?.busy||downloads?.busy){if(Date.now()>deadline)throw Error("Текущее задание ещё выполняется. Дождитесь его окончания и повторите переключение.");await new Promise(resolve=>setTimeout(resolve,50));}
    if(downloads.preparing||library.files.some(f=>f.state==="preparing")||storageLocations.progress)throw Error("Дождитесь завершения подготовки или переноса");
    if(downloads.active.size&&!confirm)return {needsPause:true};
    altered=true;

    for(const j of [...downloads.active.keys()])await downloads.pause(j);
    await save();await profileSession().cookies.flushStore();transport.stop();await downloads.close();await library.writes;

    if(webWindow&&!webWindow.isDestroyed()){webWindow.destroy();webWindow=null;}
    profiles.data.activeId=profile.id;config={...profile.settings,server:profile.origin};

    token="";pair=null;rooms=[];grants=[];networkError="";
    if(config.approved&&config.secret&&secretAvailable()){try{token=safeStorage.decryptString(Buffer.from(config.secret,"base64"));}catch{networkError="Не удалось прочитать ключ устройства. Вход и файлы сохранены; подключите устройство в настройках.";}}
    await profiles.save();await loadLocalServices();if(rtcWindow&&!rtcWindow.isDestroyed())await rtcWindow.loadURL("hostapp://local/rtc.html");return {ok:true};
  }catch(error){
    if(!altered)throw error;
    transport?.stop();await downloads?.close().catch(()=>{});
    profiles.data.activeId=previous.id;config=previous.config;token=previous.token;await profiles.save();await loadLocalServices();
    if(previous.hadWindow)await openApp();throw error;
  }finally{switching=false;}
}
async function accountRequest(path,body){
  if(!config.server)throw Error("Сначала выберите сервер");
  const origin=config.server,id=profiles.active.id;
  const r=await profileSession().fetch(origin+path,{method:body?"POST":"GET",credentials:"include",headers:{Origin:origin,...(body?{"Content-Type":"application/json"}:{})},body:body?JSON.stringify(body):undefined,redirect:"error",signal:AbortSignal.timeout(path==="/api/shikimori/sync"?180000:20000)});
  const result=await r.json().catch(()=>null);
  if(id!==profiles.active.id)throw Error("Профиль изменился");
  if(!r.ok)throw Error(result?.error||`Сервер вернул ошибку ${r.status}`);
  return result;
}
async function showSetup(add=false){
  pickerWindow?.close();
  if(add){profiles.data.draft={step:"server",adding:true};await profiles.save();}
  await window.loadURL("hostapp://local/onboarding.html");window.show();window.focus();
}
function chromeState(state){
  // A child picker may close while its parent WebContents is already being destroyed.
  try{if(webWindow&&!webWindow.isDestroyed()){const contents=webWindow.webContents;if(!contents.isDestroyed())contents.send("desktop-picker-state",state);}}catch{/* The parent has finished closing; there is no UI to update. */}
}
async function showPicker(){
  if(pickerWindow&&!pickerWindow.isDestroyed()){const previous=pickerWindow;pickerWindow=null;previous.close();return;}
  const bounds=webWindow.getBounds();
  pickerWindow=new BrowserWindow({show:false,width:355,height:300,x:bounds.x+10,y:bounds.y+40,frame:false,resizable:false,skipTaskbar:true,parent:webWindow,backgroundColor:"#111827",webPreferences:{preload:join(root,"preload.cjs"),sandbox:true,contextIsolation:true,nodeIntegration:false}});
  pickerWindow.removeMenu();pickerWindow.webContents.setWindowOpenHandler(()=>({action:"deny"}));pickerWindow.webContents.on("will-navigate",e=>e.preventDefault());
  const own=pickerWindow;let ready=false;
  own.on("blur",()=>{if(ready)setTimeout(()=>{if(!own.isDestroyed()&&!own.isFocused())own.close();},100);});
  own.on("closed",()=>{if(pickerWindow===own)pickerWindow=null;if(!pickerWindow)chromeState({open:false});});
  await pickerWindow.loadURL("hostapp://local/onboarding.html?picker=1");
  if(own.isDestroyed()||pickerWindow!==own)return;
  ready=true;own.show();own.focus();
  chromeState({open:true});
}
let checkedServer=null;
async function setupAction(kind,data){
  if(kind==="setup-close-picker"){const previous=pickerWindow;pickerWindow=null;previous?.close();if(webWindow&&!webWindow.isDestroyed())webWindow.focus();chromeState({open:false,focus:true});return;}
  if(kind==="setup-state")return {product,profiles:profiles.list(),active:profiles.active?.id,step:profiles.data.draft?.adding?"server":profiles.active?.wizard?.step||profiles.data.draft?.step||"welcome",adding:!!profiles.data.draft?.adding,linked:!!token,server:config.server,secureStorage:secretAvailable()};
  if(kind==="setup-step"){
    if(!["welcome","mode","server","auth","access","links","sync"].includes(data.step))throw Error("Неизвестный шаг");
    const target=profiles.data.draft?.adding?profiles.data.draft:profiles.active?(profiles.active.wizard??={}):profiles.data.draft;
    target.step=data.step;await profiles.save();return;
  }
  if(kind==="setup-probe"){
    const own=++probeGeneration,origin=normalizeServerAddress(data.address,{development:!app.isPackaged});checkedServer=null;
    let r;try{r=await net.fetch(origin+"/api/desktop/info",{credentials:"omit",redirect:"error",signal:AbortSignal.timeout(15000)});}catch{throw Error("Не удалось безопасно подключиться к серверу. Проверьте адрес, сертификат и соединение.");}
    const info=await r.json().catch(()=>null);
    if(own!==probeGeneration)throw Error("Адрес изменён; повторите проверку");
    if(r.status>=500)throw Error(info?.maintenance?info.error:"Сервер временно недоступен. Повторите проверку позже.");
    if(!r.ok||info?.service!=="home_theater")throw Error("Это другой сервис или сервер ещё не поддерживает подключение desktop");
    if(info.desktopProtocol!==product.protocol)throw Error("Версия сервера не поддерживается. Требуется обновление сервера или приложения.");
    checkedServer={origin,at:Date.now(),name:String(info.name||new URL(origin).host).slice(0,80)};return checkedServer;
  }
  if(kind==="setup-cancel-probe"){probeGeneration++;checkedServer=null;return;}
  if(kind==="setup-connect"){
    const origin=normalizeServerAddress(data.address,{development:!app.isPackaged});
    if(!checkedServer||checkedServer.origin!==origin||Date.now()-checkedServer.at>300000)throw Error("Сначала проверьте этот сервер");
    const p=profiles.ensure(origin,String(data.name||checkedServer.name));const changed=await changeProfile(p,!!data.confirm);if(changed.needsPause)return changed;
    profiles.data.draft={step:"welcome"};await profiles.save();
    const user=await accountRequest("/api/auth/status");return {step:user?(user.access==="approved"?"links":"access"):"auth"};
  }
  if(kind==="profile-add"){await showSetup(true);return;}
  if(kind==="profile-select"){

    const p=profiles.data.profiles.find(p=>p.id===data.id);if(!p)throw Error("Сервер не найден");
    const previousId=profiles.active?.id;
    const result=await changeProfile(p,!!data.confirm);if(result.needsPause){pickerWindow?.setSize(Math.max(320,Math.min(420,webWindow.getContentBounds().width-20)),420);return result;}
    pickerWindow?.close();if(p.wizard?.step==="done"){if(previousId!==p.id)await window.loadURL("hostapp://local/index.html");await openApp();}else await showSetup();return result;
  }
  if(kind==="setup-auth"){
    await accountRequest(data.register?"/api/auth/register":"/api/auth/login",{login:data.login,name:data.login,password:data.password,...(data.invite?{token:invitationCode(data.invite)}:{})});
    await profileSession().cookies.flushStore();
    return accountRequest("/api/auth/status");
  }
  if(kind==="setup-status")return accountRequest("/api/auth/status");
  if(kind==="setup-invite")return accountRequest("/api/auth/invitation",{token:invitationCode(data.token)});
  if(kind==="setup-binding")return accountBinding(data.link?"link":"status");
  if(kind==="setup-me")return accountRequest("/api/me");
  if(kind==="setup-lists")return accountRequest("/api/lists");
  if(kind==="setup-import")return accountRequest("/api/shikimori/sync",{});
  if(kind==="setup-shikimori")return linkShikimori();
  if(kind==="setup-finish"){
    const user=await accountRequest("/api/auth/status");if(user?.access!=="approved")throw Error("Доступ ещё не подтверждён");
    profiles.active.wizard={step:"done"};await profiles.save();await window.loadURL("hostapp://local/index.html");await openApp();return;
  }
  if(kind==="setup-device-settings"){pickerWindow?.close();await window.loadURL("hostapp://local/index.html");window.show();window.focus();return;}
  throw Error("Неизвестное действие настройки");
}
function invitationCode(value){try{const u=new URL(value);return new URLSearchParams(u.hash.slice(1)).get("token")||u.searchParams.get("token")||value;}catch{return String(value).trim();}}
async function linkShikimori(){
  const result=await accountRequest("/api/shikimori/authorize");
  if(result.oob)throw Error("Этот сервер использует ручное подключение Shikimori. Подключите его в настройках приложения.");
  const url=new URL(result.url);if(url.protocol!=="https:")throw Error("Небезопасный адрес авторизации");
  const popup=new BrowserWindow({parent:window,width:820,height:780,modal:true,autoHideMenuBar:true,webPreferences:{session:profileSession(),sandbox:true,contextIsolation:true,nodeIntegration:false}});
  popup.webContents.setWindowOpenHandler(()=>({action:"deny"}));
  popup.webContents.on("did-navigate",(_e,address)=>{if(new URL(address).origin===config.server&&!new URL(address).pathname.startsWith("/api/shikimori/"))popup.close();});
  const closed=new Promise(resolve=>popup.once("closed",resolve));
  try{await popup.loadURL(url.toString());await closed;return await accountRequest("/api/me");}finally{if(!popup.isDestroyed())popup.close();}
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    const visible = webWindow && !webWindow.isDestroyed() ? webWindow : window;
    visible?.restore(); visible?.show(); visible?.focus();
  });
  app
    .whenReady()
    .then(async () => {
      await mkdir(app.getPath("userData"), { recursive: true });
      profiles=new Profiles(app.getPath("userData"));await profiles.load();
      try {
        config={...(profiles.active?.settings||profiles.data.legacySettings||{})};
        if (config.approved && config.secret && secretAvailable())
          token = safeStorage.decryptString(
            Buffer.from(config.secret, "base64"),
          );
      } catch (e) {
        if (e.code !== "ENOENT")
          networkError =
            "Не удалось восстановить привязку. Подключите аккаунт заново.";
      }
      await loadLocalServices();
      protocol.handle("hostapp", (req) => {
        const name = new URL(req.url).pathname.slice(1) || "index.html";
        if (!["index.html", "renderer.js", "style.css", "stream-provider.js", "rtc.html", "onboarding.html", "onboarding.css", "onboarding.js", "server-picker.js", "product.mjs", "icon.png"].includes(name))
          return new Response("Not found", { status: 404 });
        return net.fetch(pathToFileURL(join(root, name)).toString());
      });
      const fullscreenAllowed = (contents, permission, url, details) => allowAppFullscreen({
        permission,
        ownWindow: !!webWindow && !webWindow.isDestroyed() && contents === webWindow.webContents,
        isMainFrame: details.isMainFrame,
        requestingUrl: url,
        server: config.server,
      });
      session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) =>
        callback(fullscreenAllowed(contents, permission, details.requestingUrl, details)));
      session.defaultSession.setPermissionCheckHandler((contents, permission, origin, details) =>
        fullscreenAllowed(contents, permission, details.requestingUrl || origin, details));
      ipcMain.handle("host", async (event, kind, data) => {
        if (
          ![window?.webContents,pickerWindow?.webContents,rtcWindow?.webContents].includes(event.sender) ||
          event.senderFrame !== event.sender.mainFrame ||
          !["hostapp://local/index.html","hostapp://local/onboarding.html","hostapp://local/rtc.html"].includes(event.senderFrame.url.split("?")[0]) ||
          (event.sender===pickerWindow?.webContents&&!kind.startsWith("setup-")&&!kind.startsWith("profile-")) ||
          (event.sender===rtcWindow?.webContents&&!["streams","stream-read","stream-answer"].includes(kind))
        )
          throw new Error("Недоступно");
        return action(kind, data);
      });
      window = new BrowserWindow({
        width: 1140,
        height: 800,
        minWidth: 360,
        minHeight: 500,
        backgroundColor:"#111827",titleBarStyle:"hidden",titleBarOverlay:{color:"#111827",symbolColor:"#d1d5db",height:40},
        webPreferences: {
          preload: join(root, "preload.cjs"),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      window.on("closed", () => app.quit());
      window.removeMenu();
      await window.loadURL("hostapp://local/index.html");
      rtcWindow=new BrowserWindow({show:false,webPreferences:{preload:join(root,"preload.cjs"),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
      rtcWindow.webContents.setWindowOpenHandler(()=>({action:"deny"}));rtcWindow.webContents.on("will-navigate",event=>event.preventDefault());
      await rtcWindow.loadURL("hostapp://local/rtc.html");
      window.on("close", (event) => {
        if (importing || downloads.active.size || library.files.some((f) => f.state === "preparing")) {
          const answer = dialog.showMessageBoxSync(webWindow && !webWindow.isDestroyed() ? webWindow : window, {
            type: "question",
            buttons: ["Остаться", "Завершить приложение"],
            defaultId: 0,
            cancelId: 0,
            message: "Загрузка или подготовка ещё идёт. Завершить приложение?",
            detail:
              "Загрузку можно будет продолжить, подготовку — начать заново. Полученные файлы сохранятся.",
          });
          if (answer === 0) event.preventDefault();
        }
      });
      setInterval(async () => {
        if (pair) {
          const expectedPair = pair;
          try {
            const p = await request("/api/desktop/pair");
            if (p.approved && pair === expectedPair) {
              config.approved = true;
              pair = null;
              await save();
              await heartbeat();
              await openApp(undefined, `/?desktopDevice=${encodeURIComponent(config.deviceId || "")}`);
            }
          } catch (e) {
            networkError = e.message;
          }
        } else if(!switching) { await heartbeat(); if (token && !bindingBusy) void remoteDownloads.tick().catch(e => { networkError = e.message; }); }
      }, 5000).unref();
      await heartbeat();
      if (config.server && profiles.active?.wizard?.step==="done") await openApp();
      else await showSetup();
    })
    .catch((e) => {
      dialog.showErrorBox("Не удалось запустить приложение", e.message);
      app.quit();
    });
  let closing = false;
  app.on("before-quit", (event) => {
    quitting = true;
    if (closing || !downloads) return;
    closing = true; event.preventDefault(); metadataRequest?.abort(); transport?.stop(); stopPreparation();
    void downloads?.close().finally(() => app.quit());
  });
  app.on("window-all-closed", () => app.quit());
}
