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
import { readFile, writeFile, mkdir } from "node:fs/promises";
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
let remoteDownloads, webWindow, quitting = false;
let downloads;
let storageLocations;
let metadataRequest;
let transport;
const root = dirname(fileURLToPath(import.meta.url));
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
const configPath = () => join(app.getPath("userData"), "host.json");
async function save() {
  await writeFile(
    configPath(),
    JSON.stringify({
      ...config,
      secret:
        token && secretAvailable()
          ? safeStorage.encryptString(token).toString("base64")
          : undefined,
    }),
    { mode: 0o600 },
  );
}
async function request(path, body, auth = true, origin = config.server, signal) {
  const requestToken = token;
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
  if(!webWindow || webWindow.isDestroyed())throw new Error("Откройте приложение и войдите в аккаунт");
  if(bindingBusy)throw new Error("Подключение уже выполняется");
  if(action==="unlink" && (remoteDownloads?.busy || sending))throw new Error("Дождитесь завершения текущего задания и повторите отвязку");
  bindingBusy=true;
  try {
    const dir=!app.isPackaged && process.env.HOME_THEATER_TEST_PROFILE ? app.getPath("userData") : join(app.getPath("appData"),"home_theater-device");
    const key=await installationKey(join(dir,"installation.key"));
    const r=await webWindow.webContents.session.fetch(config.server+"/api/desktop/binding",{method:"POST",headers:{"Content-Type":"application/json",Origin:config.server},body:JSON.stringify({action,key,label:hostname().slice(0,80),platform:process.platform,previousToken:token||undefined}),redirect:"error"});
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
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: join(root,"chrome-preload.cjs") } });
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
    webWindow.webContents.send("desktop-navigation-state", { canGoBack });
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
  ipcMain.removeAllListeners("desktop-go-back");
  ipcMain.on("desktop-go-back", event => { if (fromAppWindow(event)) goBack(); });
  ipcMain.removeAllListeners("desktop-navigation-ready");
  ipcMain.on("desktop-navigation-ready", event => { if (fromAppWindow(event)) navigationState(); });
  ipcMain.removeAllListeners("desktop-menu");
  ipcMain.on("desktop-menu", event => {
    if (webWindow && !webWindow.isDestroyed() && event.sender === webWindow.webContents && event.senderFrame === webWindow.webContents.mainFrame)
      appMenu.items[0].submenu.popup({window:webWindow,x:12,y:40});
  });
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
  if (kind === "streams") return transport?.list() || [];
  if (kind === "stream-read") return transport.read(String(data.lease), data.offset, data.length);
  if (kind === "stream-answer") return transport.answer(String(data.lease), data.answer, data.generation, data.negotiation);
  if (kind === "state") return snapshot();
  if (kind === "connect") {
    const nextServer = serverUrl(data.server, { development: !app.isPackaged });
    if (config.server && nextServer !== config.server && (token || pair)) throw new Error("Сначала отзовите доступ этого устройства на прежнем сервере.");
    if (nextServer !== config.server && webWindow && !webWindow.isDestroyed()) { webWindow.destroy(); webWindow = null; }
    config.server = nextServer;
    await save();
    await openApp();
    return;
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
      try {
        config = JSON.parse(await readFile(configPath(), "utf8"));
        if (config.approved && config.secret && secretAvailable())
          token = safeStorage.decryptString(
            Buffer.from(config.secret, "base64"),
          );
      } catch (e) {
        if (e.code !== "ENOENT")
          networkError =
            "Не удалось восстановить привязку. Подключите аккаунт заново.";
      }
      library = new Library(join(app.getPath("userData"), "library"));
      await library.load();
      downloads = new Downloads(join(app.getPath("userData"), "downloads"), library, async (...args) => { await prepare(...args); await heartbeat(); }, {isInUse:id=>!!id && !!transport?.list().some(s=>s.file===id),validateFolder:(folder,id)=>storageLocations?.validateFolder(folder,id)});
      await downloads.load();
      storageLocations=new StorageLocations(app.getPath("userData"),downloads,{detect:detectVolumes});
      await storageLocations.load(config.downloadFolder || join(app.getPath("videos"),"home_theater"));
      remoteDownloads = new RemoteDownloads(downloads, body => request("/api/desktop/commands", body), join(app.getPath("userData"), "remote-receipts.json"), () => storageLocations.defaultId?storageLocations.root():null,{locations:storageLocations,addLocation:addStorageLocation});
      await remoteDownloads.load();
      transport = new HostTransport(library, () => ({ server: config.server, token: pair ? "" : token }), (url, options) => net.fetch(url, options));
      transport.start();
      protocol.handle("hostapp", (req) => {
        const name = new URL(req.url).pathname.slice(1) || "index.html";
        if (!["index.html", "renderer.js", "style.css", "stream-provider.js"].includes(name))
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
          event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame ||
          event.senderFrame.url !== "hostapp://local/index.html"
        )
          throw new Error("Недоступно");
        return action(kind, data);
      });
      window = new BrowserWindow({
        width: 1140,
        height: 800,
        minWidth: 360,
        minHeight: 500,
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
        } else { await heartbeat(); if (token && !bindingBusy) void remoteDownloads.tick().catch(e => { networkError = e.message; }); }
      }, 5000).unref();
      await heartbeat();
      if (config.server) await openApp();
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
