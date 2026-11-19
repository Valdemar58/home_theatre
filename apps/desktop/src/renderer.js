const $ = (id) => document.getElementById(id);
let displayedNetworkError = "";
let current = null,
  busy = false,
  lastFiles = "";
const size = (b) =>
  b < 1024 ** 2
    ? `${(b / 1024).toFixed(1)} КБ`
    : b < 1024 ** 3
      ? `${(b / 1024 ** 2).toFixed(1)} МБ`
      : `${(b / 1024 ** 3).toFixed(2)} ГБ`;
function element(tag, text, cls) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}
async function call(action, data) {
  try {
    $("error").hidden = true;
    const value = await window.host.call(action, data);
    await refresh();
    return value;
  } catch (e) {
    $("error").textContent = e.message.replace(
      /^Error invoking remote method 'host': Error: /,
      "",
    );
    $("error").hidden = false;
  }
}
function button(text, fn) {
  const e = element("button", text, "quiet");
  e.type = "button";
  e.onclick = fn;
  return e;
}
function renderFiles(s) {
  const signature = JSON.stringify([s.files, s.rooms, s.grants, s.linked]);
  if (signature === lastFiles) return;
  lastFiles = signature;
  const root = $("library");
  root.replaceChildren();
  $("count").textContent = `Серий: ${s.files.length}`;
  if (!s.files.length) {
    root.append(
      element(
        "p",
        "Подключите серию, чтобы подготовить её и разрешить доступ комнате.",
      ),
    );
    return;
  }
  for (const f of s.files) {
    const row = element("article", undefined, "file");
    row.append(
      element("h3", `${f.titleName || `Тайтл ${f.title}`} · Серия ${f.ep}`),
      element("p", `${f.name} · ${size(f.bytes)}`, "name"),
    );
    const state = {
      imported: "Файл подключён",
      preparing: "Подготовка",
      ready: "Подготовлено локально",
      error: "Требуется внимание",
    }[f.state];
    row.append(element("p", f.error || state));
    if (f.state === "preparing") {
      const p = element("progress");
      p.max = 1;
      p.value = f.progress;
      p.setAttribute("aria-label", `Подготовка серии ${f.ep}`);
      row.append(p);
    }
    const actions = element("div", undefined, "actions");
    const prep = button(
      f.state === "ready" ? "Подготовить заново" : "Подготовить",
      () => call("prepare", { id: f.id }),
    );
    prep.disabled = s.files.some((x) => x.state === "preparing");
    actions.append(prep);
    const remove = button("Убрать из библиотеки", () =>
      call("remove", { id: f.id }),
    );
    remove.disabled = f.state === "preparing";
    actions.append(remove);
    row.append(actions);
    if (s.linked) {
      const share = element("div", undefined, "share");
      share.append(element("span", "Доступ комнатам:"));
      for (const room of s.rooms) {
        const enabled = s.grants.some(
          (g) => g.list_id === room.id && g.anilist_id === f.title,
        );
        const b = button(
          `${enabled ? "Отозвать" : "Разрешить"} · ${room.name}`,
          () =>
            call("grant", { room: room.id, title: f.title, enabled: !enabled }),
        );
        share.append(b);
        if (enabled) share.append(button(`Открыть · ${room.name}`, () => call("web", { room: room.id })));
      }
      if (!s.rooms.length)
        share.append(element("span", "Нет комнат с правом хостинга"));
      row.append(share);
    }
    root.append(row);
  }
}
async function refresh() {
  if (busy) return;
  busy = true;
  try {
    const s = await window.host.call("state");
    current = s;
    document.querySelector("#search-form button").disabled = !s.linked;
    if (document.activeElement !== $("server") && !$("server").value)
      $("server").value = s.server;
    $("account").textContent = s.linked
      ? "Устройство подключено к аккаунту"
      : s.pair
        ? "Подтвердите устройство в окне приложения"
        : "Устройство не подключено. Вход в приложение доступен без привязки.";
    $("pair-code").textContent = s.pair ? `Код устройства: ${s.pair.id}` : "";
    $("storage-warning").textContent = s.persistent
      ? ""
      : "Системное хранилище ключей недоступно: после закрытия потребуется повторная привязка.";
    $("import-status").textContent =
      s.importProgress === null
        ? ""
        : `Проверка файла · ${Math.round(s.importProgress * 100)}%`;
    $("web").disabled = !s.server;
    $("link-device").disabled = !s.server;
    if (s.networkError) {
      $("error").textContent = s.networkError;
      $("error").hidden = false;
      displayedNetworkError = s.networkError;
    } else if (displayedNetworkError && $("error").textContent === displayedNetworkError) {
      $("error").hidden = true;
      $("error").textContent = "";
      displayedNetworkError = "";
    }
    renderFiles(s);
    renderDownloads(s);
    $("find-releases").disabled = !s.linked || !$("title").value || releaseBusy;
    $("download-folder-path").textContent = s.downloadFolder;
  } finally {
    busy = false;
  }
}
$("pair-form").onsubmit = async (e) => {
  e.preventDefault();
  await call("connect", { server: $("server").value });
};
$("link-device").onclick = () => call("pair", { server: current.server });
$("import-form").onsubmit = async (e) => {
  e.preventDefault();
  await call("import", {
    title: Number($("title").value),
    ep: Number($("episode").value),
    titleName: $("results").value === $("title").value
      ? $("results").selectedOptions[0]?.textContent : "",
  });
};
$("web").onclick = () => call("web");
setInterval(() => refresh().catch(() => {}), 1000);
refresh();

$("search-form").onsubmit = async (e) => {
  e.preventDefault();
  const r = await call("search", { query: $("search").value });
  if (!r) return;
  $("results").replaceChildren();
  for (const m of r.media) {
    const o = element(
      "option",
      m.title.ru || m.title.romaji || m.title.english || String(m.id),
    );
    o.value = m.id;
    $("results").append(o);
  }
  if (!r.media.length) {
    const o = element("option", "Ничего не найдено");
    o.value = "";
    $("results").append(o);
  }
  $("title").value = $("results").value;
  selectTitle();
};
$("results").onchange = () => {
  $("title").value = $("results").value;
  selectTitle();
};

let releaseBusy = false, releaseEpoch = 0, selection = null;
function selectTitle() {
  releaseEpoch++;
  $("release-query").value = $("results").selectedOptions[0]?.textContent || "";
  $("release-results").replaceChildren();
  $("release-status").textContent = "Найдите раздачу. Проверьте сезон и состав файлов перед скачиванием.";
}
$("download-folder").onclick = () => call("download-folder");
$("release-form").onsubmit = async e => {
  e.preventDefault();
  if (releaseBusy) return;
    const epoch = ++releaseEpoch, title = Number($("title").value), titleName = $("results").value === String(title)
      ? $("results").selectedOptions[0]?.textContent : `Тайтл ${title}`;
  releaseBusy = true; $("find-releases").disabled = true;
  $("release-status").textContent = "Ищем в подключённых индексаторах. Это может занять пару минут…";
  const r = await call("releases", { query: $("release-query").value });
  releaseBusy = false; await refresh();
  if (epoch !== releaseEpoch) return;
  $("release-results").replaceChildren();
  $("release-status").textContent = r ? (r.warning || (r.releases.length ? `Раздач: ${r.releases.length}. Выберите подходящий сезон и озвучку.` : "Ничего не найдено. Попробуйте другое название.")) : "Поиск не завершён. Повторите попытку.";
  for (const release of r?.releases || []) {
    const row = element("article", undefined, "release-row"), content = element("div");
    content.append(element("h3", release.title), element("p", `${release.indexer} · ${size(release.size)} · Сиды: ${release.seeders}`));
    const status = element("p"); status.setAttribute("role", "status");
    const cancel = button("Отменить", () => call("download-metadata-cancel")); cancel.hidden = true;
    const choose = button("Выбрать серии", async () => {
      choose.disabled = true; choose.textContent = "Получаем список…"; cancel.hidden = false;
      status.textContent = "Для magnet ждём список файлов от пиров — до 90 секунд. Серии ещё не скачиваются.";
      const job = await call("download-inspect", { id: release.id, title, titleName });
      choose.disabled = false; choose.textContent = "Выбрать серии"; cancel.hidden = true;
      status.textContent = job ? "" : $("error").textContent;
      if (job) showSelection(job);
    });
    content.append(status); const actions = element("div", undefined, "actions"); actions.append(choose, cancel);
    row.append(content, actions); $("release-results").append(row);
  }
};
function showSelection(job) {
  selection = job;
  const root = $("download-selection"); root.hidden = false; root.replaceChildren();
  root.append(element("h3", `${job.titleName} · выбор серий`), element("p", job.releaseName, "name"), element("p", "Номера определены по именам файлов. Проверьте их: для неоднозначных файлов укажите номер вручную."));
  const controls = element("div", undefined, "actions"), grid = element("div", undefined, "episode-files"), total = element("p");
  const rows = [];
  const update = () => { const chosen = rows.filter(r => r.check.checked); total.textContent = `Серий: ${chosen.length} · ${size(chosen.reduce((n, r) => n + r.file.bytes, 0))}`; };
  controls.append(button("Отметить все", () => { rows.forEach(r => r.check.checked = true); update(); }), button("Сбросить", () => { rows.forEach(r => r.check.checked = false); update(); }));
  for (const file of job.files.filter(f => f.video)) {
    const row = element("div", undefined, "episode-file"), label = element("label"), check = element("input"); check.type = "checkbox"; check.checked = true;
    label.append(check, element("span", file.path));
    const numberLabel = element("label", "Серия"), number = element("input"); number.type = "number"; number.min = 1; number.max = 10000; number.value = file.episode || ""; number.required = true; number.setAttribute("aria-label", `Номер серии: ${file.name}`);
    numberLabel.append(number); row.append(label, element("span", size(file.bytes), "file-size"), numberLabel); grid.append(row);
    rows.push({ file, check, number }); check.onchange = update;
  }
  const auto = element("label", undefined, "inline-check"), checkbox = element("input"); checkbox.type = "checkbox"; checkbox.checked = true; auto.append(checkbox, element("span", "Подготовить выбранные серии автоматически"));
  const failure = element("p", "", "download-error"); failure.setAttribute("role", "alert"); failure.hidden = true;
  const start = button("Скачать на устройство", async () => {
    const chosen = rows.filter(r => r.check.checked);
    failure.hidden = true;
    if (!chosen.length) { failure.textContent = "Выберите хотя бы одну серию."; failure.hidden = false; return; }
    if (chosen.some(r => !r.number.reportValidity())) return;
    start.disabled = true;
    await call("download-start", { id: job.id, selections: chosen.map(r => ({ index: r.file.index, episode: Number(r.number.value) })), autoPrepare: checkbox.checked });
    start.disabled = false;
    if (!$("error").hidden) { failure.textContent = $("error").textContent; failure.hidden = false; return; }
    if (current?.downloads.find(j => j.id === job.id)?.state !== "selecting") { root.hidden = true; selection = null; }
  }); start.className = "";
  root.append(controls, grid, total, auto, element("p", "Папка назначения указана в загрузках ниже. Для подготовки понадобится дополнительное место."), start, failure);
  update(); root.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
}
let lastDownloads = "";
function renderDownloads(s) {
  const signature = JSON.stringify(s.downloads);
  if (signature === lastDownloads || $("downloads").contains(document.activeElement)) return;
  lastDownloads = signature; const root = $("downloads"); root.replaceChildren();
  if (!s.downloads.length) { root.append(element("p", "Загрузок пока нет. Найдите раздачу выше или подключите готовый файл.")); return; }
  const labels = { selecting: "Выберите серии", verifying: "Проверяем полученные части", downloading: "Загрузка", paused: "На паузе", downloaded: "Скачано", preparing: "Подготовка", ready: "Готово к просмотру", error: "Требуется внимание", cancelled: "Остановлено · файлы сохранены" };
  for (const j of s.downloads) {
    const row = element("article", undefined, "file"), heading = element("div", undefined, "section-heading");
    heading.append(element("h3", j.titleName), element("span", labels[j.state])); row.append(heading, element("p", j.releaseName, "name"));
    if (j.error) row.append(element("p", j.error, "download-error"));
    if (j.state === "downloading") row.append(element("p", j.peers ? `${size(j.speed)}/с · Пиры: ${j.peers}` : "Ищем участников раздачи. Если ожидание затянулось, выберите другую раздачу."));
    const strip = element("div", undefined, "download-episodes");
    for (const f of j.files.filter(f => f.selected)) {
      const item = element("div", undefined, "download-episode");
      item.append(element("span", `Серия ${f.episode}`), element("small", `${size(f.downloaded)} / ${size(f.bytes)}`));
      const p = element("progress"); p.max = 1; p.value = 0.8 * Math.min(1, f.downloaded / (f.bytes || 1)) + 0.2 * (f.prepareState === "ready" ? 1 : f.prepareProgress); p.setAttribute("aria-label", `Серия ${f.episode}: загрузка ${Math.round(100 * f.downloaded / (f.bytes || 1))}%, подготовка ${Math.round(100 * (f.prepareState === "ready" ? 1 : f.prepareProgress))}%`); item.append(p); strip.append(item);
    }
    row.append(strip);
    const actions = element("div", undefined, "actions");
    if (j.state === "selecting") actions.append(button("Выбрать серии", () => showSelection(j)));
    if (["paused", "error"].includes(j.state) && j.folder) actions.append(button("Продолжить загрузку", () => call("download-resume", { id: j.id })));
    if (["downloading", "verifying"].includes(j.state)) actions.append(button("Пауза", () => call("download-pause", { id: j.id })));
    if (!["ready", "downloaded", "cancelled", "preparing"].includes(j.state)) actions.append(button("Остановить, сохранив файлы", () => call("download-cancel", { id: j.id })));
    if (["ready", "downloaded", "cancelled"].includes(j.state)) actions.append(button("Убрать запись", () => call("download-forget", { id: j.id })));
    row.append(actions); root.append(row);
  }
}
