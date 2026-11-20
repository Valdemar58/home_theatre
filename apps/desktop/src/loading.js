const $=id=>document.getElementById(id);let state={status:"checking"},acting=false;
const size=bytes=>`${(Math.max(0,bytes||0)/1024**2).toFixed(1)} МБ`;
function render(s){state=s;
  const waiting=["checking","downloading","installing"].includes(s.status),failed=s.status==="error",panel=!!s.panel;
  $("heading").textContent=({checking:s.detail==="downloaded"?"Проверяем последнюю версию":"Проверяем обновления",downloading:"Загружаем обновление",installing:"Устанавливаем обновление",error:"Не удалось обновить приложение"})[s.status]||(panel?"Обновления приложения":s.networkError?"Не удалось открыть сервер":"Открываем ваш сервер");
  $("detail").textContent=s.status==="downloading"?`Версия ${s.version} → ${s.target}`:s.status==="installing"?"Приложение перезапустится. Аккаунты, привязки и медиатека сохранятся.":s.status==="checking"?s.detail==="downloaded"?"Проверяем, не появился ли более свежий выпуск":"Перед подключением к вашему серверу":failed?"Подключение к серверу остановлено до завершения обновления":panel?s.status==="development"?"В режиме разработки автоматическое обновление выключено.":"Версия проверена при запуске. Для новой проверки перезапустите приложение.":s.networkError||"Аккаунт, устройство и медиатека сохранены";
  document.querySelector(".spinner").hidden=!waiting;
  $("download").hidden=s.status!=="downloading";$("progress").value=s.progress||0;$("transfer").textContent=`${Math.floor(s.progress||0)}% · ${size(s.transferred)} из ${size(s.total)}`;
  $("error").hidden=!failed;$("error").textContent=s.error||"";$("version").textContent=s.version?`Версия ${s.version}`:"";
  $("channel").value=s.channel||"stable";$("channel").disabled=waiting||acting;
  $("primary").hidden=!failed&&!(panel&&s.runtimeReady&&s.status!=="development");$("primary").textContent=failed?"Повторить":"Перезапустить и проверить";$("primary").disabled=acting;
  $("releases").hidden=!failed&&!panel;$("exit").hidden=!failed;
  $("navigation").hidden=!s.runtimeReady;$("back").hidden=!panel;$("choose").hidden=panel;$("local").hidden=panel;
}
async function call(action,data){if(acting)return;acting=true;$("action-error").hidden=true;try{await window.host.call(action,data);}catch(e){$("action-error").textContent=e.message.replace(/^Error invoking remote method 'host': Error: /,"");$("action-error").hidden=false;}finally{acting=false;render(state);}}
$("choose").onclick=()=>call("profile-add");$("local").onclick=()=>call("setup-local-library");$("back").onclick=()=>call("setup-update-return");
$("primary").onclick=()=>call(state.runtimeReady?"setup-update-restart":"setup-update-retry");$("releases").onclick=()=>call("setup-open-releases");$("exit").onclick=()=>call("setup-update-exit");
$("channel").onchange=e=>call("setup-update-channel",{channel:e.target.value});
const strip=document.createElement("div");strip.className="native-drag-strip";strip.hidden=true;strip.setAttribute("aria-hidden","true");document.body.append(strip);
window.host.onChromeDrag?.(s=>{strip.style.left=s.left+"px";strip.hidden=!s.visible;});void window.host.call("setup-loading-ready");
window.host.onUpdate?.(render);window.host.call("setup-update-state").then(render).catch(e=>render({status:"error",error:e.message}));
