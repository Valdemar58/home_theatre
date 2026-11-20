import {serverPicker,escapeHtml as esc,icon} from './server-picker.js';
const root=document.getElementById('r5-desktop'),$=s=>root.querySelector(s),call=(action,data)=>window.host.call(action,data);
const steps=['Знакомство','Режим','Сервер','Аккаунт','Доступ','Подключения','Синхронизация'];
const order=['welcome','mode','server','auth','access','links','sync'];
const tweaks={motion:360},reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');let windowVisible=true;
let state={step:'welcome',motionPaused:false,profiles:[],error:'',custom:false,address:'',name:'',register:false,busy:false,pickerOpen:false,probe:null,linked:false,me:null,syncRows:[],syncDone:false};
let lastStep=null,attempt=0,polling=false,pending=null,pendingMeta=null;
const pickerMode=new URLSearchParams(location.search).has('picker');
function button(text,action,kind='primary',attrs=''){return `<button type="button" class="r5-${kind}" data-action="${action}" ${attrs}>${text}</button>`;}
const error=()=>`<div class="r5-error" role="alert">${state.error?icon('circle-alert')+`<span>${esc(state.error)}</span>`:''}</div>`;
const intro=(title,copy,content='',narrow=false)=>`<section class="r5-page${narrow?' narrow':''}"><h1>${title}</h1><p class="r5-intro">${copy}</p>${content}</section>`;
const choices=()=>state.profiles.some(p=>p.origin===state.product.server.origin)?state.profiles:[{...state.product.server,id:'suggested'},...state.profiles];
function mountPicker(container,context){
 container.replaceChildren(serverPicker({profiles:context==='header'?state.profiles:choices(),active:state.selected?.id||state.active,onSelect:async p=>{
  if(context==='header'){await run(()=>switchProfile(p));return;}
  attempt++;void call('setup-cancel-probe');state.selected=p;state.custom=false;state.address=p.origin;state.probe=null;state.pickerOpen=false;render();$('[data-action=connect]')?.focus();
 },onDisconnect:context==='header'?async()=>{await call('setup-dialog-size');pendingMeta={title:'Отключить сервер?',text:'Вход на этом устройстве будет завершён. Аккаунт, списки и история на сервере, локальные файлы и привязка сохранятся. Загрузки приостановятся. Затем можно пройти настройку заново.',confirm:'Отключить и настроить заново'};pending=()=>call('profile-disconnect',{confirm:true});renderDialog();}:undefined,onAdd:async()=>{if(context==='header'){await run(()=>call('profile-add'));return;}attempt++;void call('setup-cancel-probe');state.custom=true;state.address='';state.name='';state.probe=null;state.pickerOpen=false;render();$('#address')?.focus();}}));
}
function welcome(){return `<section class="r5-page welcome"><div class="r5-welcome-mark">${icon('clapperboard')}</div><h1>Ваши истории.<br>Ваш следующий вечер.</h1><p class="r5-intro">Аниме, манга и ранобэ — в одном месте. Планируйте просмотр, сохраняйте прогресс и собирайте друзей. Серии загружаются на ваш компьютер.</p><div class="r5-welcome-points"><span>${icon('calendar-days')}Планировать</span><span>${icon('play')}Смотреть</span><span>${icon('users')}Вместе</span></div>${button('Начать '+icon('arrow-right'),'next')}</section>`;}
function modes(){return intro('Как вы хотите<br>пользоваться приложением?','Выберите, где будут храниться аккаунт, списки и статус просмотра.',`<div class="r5-modes"><button class="r5-mode" type="button" aria-pressed="true">${icon('server')}<div><strong>Сервер управления</strong><p>Подбор аниме, аккаунт и списки — на сервере. Скачивание и подготовка — на этом устройстве.</p></div></button><button class="r5-mode" type="button" disabled>${icon('monitor')}<div><strong>Автономное управление</strong><p>Все данные запрашиваются и хранятся на этом устройстве.</p><span class="r5-unavailable">${icon('lock')}После 1.0</span></div></button></div><div class="r5-actions end">${button('Далее '+icon('arrow-right'),'next')}</div>`);}
function server(){const selected=state.selected||state.product.server,p=state.probe;return intro(state.adding?'Подключить сервер':'Где будем смотреть?','Здесь будут храниться ваш аккаунт, списки и прогресс.',`<div class="r5-server-field r5-picker"><span class="r5-label">Сервер управления</span><button type="button" class="r5-picker-trigger" data-action="picker" aria-haspopup="menu" aria-expanded="${state.pickerOpen}">${icon(state.custom?'globe':'server')}<span class="r5-server-copy"><strong>${state.custom?'Свой сервер':esc(selected.name)}</strong><small>${state.custom?'Укажите адрес ниже':esc(new URL(selected.origin).host)}</small></span>${icon('chevron-down')}</button>${state.pickerOpen?'<div id="wizard-options"></div>':''}</div>${state.custom?`<div class="r5-custom-server"><label><span class="r5-label">Адрес сервера</span><input id="address" autocomplete="off" inputmode="url" value="${esc(state.address)}" placeholder="cinema.example.org"></label><label><span class="r5-label">Название (необязательно)</span><input id="server-label" maxlength="80" value="${esc(state.name)}" placeholder="Мой кинозал"></label></div>`:''}<div class="r5-probe" role="status" aria-live="polite" data-result="${p?.status||'idle'}" ${p?.status==='checking'?'aria-busy="true"':''}>${p?.status==='checking'?'<span class="r5-spinner" aria-hidden="true"></span>':icon(p?.status==='verified'?'circle-check':p?.status==='error'?'circle-alert':'server')}<div><strong>${esc(p?.title||'Проверим перед входом')}</strong><p>${esc(p?.detail||'Соединение, тип сервера и совместимость приложения.')}</p></div></div>${error()}<div class="r5-actions end">${button(state.busy?'Проверяем…':p?.status==='verified'?'Продолжить':p?.status==='error'?'Повторить проверку':'Связать','connect','primary',state.busy?'disabled':'')}</div>`,true);}
function auth(){return intro(state.register?'Создать аккаунт':'Добро пожаловать',state.register?'Создайте аккаунт на выбранном сервере.':'Войдите в аккаунт этого сервера.',`${icon('server')}<span class="r5-muted"> ${esc(new URL(state.server).host)}</span><form id="auth-form" class="r5-form"><label><span class="r5-label">Логин</span><input name="login" autocomplete="username" required maxlength="64" value="${esc(state.login||'')}"></label><label><span class="r5-label">Пароль</span><input name="password" type="password" autocomplete="${state.register?'new-password':'current-password'}" required minlength="${state.register?8:1}"></label>${state.register?'<label><span class="r5-label">Повторите пароль</span><input name="confirm" type="password" autocomplete="new-password" required></label>':''}${error()}<button class="r5-primary r5-full" ${state.busy?'disabled':''}>${state.busy?'Подключаем…':state.register?'Зарегистрироваться':'Войти'}</button></form><p class="r5-form-toggle">${state.register?'Уже есть аккаунт?':'Пока нет аккаунта?'}<button class="r5-link" data-action="toggle-auth">${state.register?'Войти':'Зарегистрироваться'}</button></p><p class="r5-small r5-muted r5-connections">Сессия и привязка устройства сохраняются отдельно для каждого сервера.</p>`,true);}
function access(){const blocked=state.access==='blocked';return intro(blocked?'Доступ отозван':'Осталось получить доступ',blocked?'Аккаунт сохранён. Обратитесь к администратору или выберите другой сервер.':'Аккаунт создан. Можно дождаться одобрения или воспользоваться приглашением.',`${blocked?'':`<div class="r5-connections"><span class="r5-spinner" aria-hidden="true"></span><p class="r5-intro">Ожидаем одобрения администратора</p></div><form id="invite-form" class="r5-form"><label><span class="r5-label">Ссылка или код приглашения</span><input name="invite" autocomplete="off" required placeholder="Вставьте приглашение"></label><button class="r5-secondary" ${state.busy?'disabled':''}>Применить приглашение</button></form>`}${error()}<div class="r5-actions">${button('Выбрать другой сервер','other-server','quiet')}${button('Проверить доступ','access-check','secondary',state.busy?'disabled':'')}</div>`,true);}
function links(){const shiki=state.me?.shikimori;return intro('Добавим то, что уже ваше','Необязательно. Всё это можно настроить позже.',`<div class="r5-connections"><div class="r5-connection">${icon('monitor')}<div><h3>Этот компьютер</h3><p>Загрузка серий из веба и доступ для комнат.</p></div>${state.linked?`<span class="r5-status">${icon('check')}Привязан</span>`:button('Привязать','bind','secondary',state.busy?'disabled':'')}</div><div class="r5-connection">${icon('book-open')}<div><h3>Shikimori</h3><p>${!shiki?.configured?'Не настроен на этом сервере.':shiki?.linked?'Подключён. Статусы можно синхронизировать.':'Перенести ваши списки и статусы просмотра.'}</p></div>${shiki?.linked?`<span class="r5-status">${icon('check')}Подключён</span>`:button('Подключить','shikimori','secondary',state.busy||!shiki?.configured?'disabled':'')}</div></div>${!state.secureStorage?'<p class="r5-intro">Системное хранилище ключей недоступно. Для сохранения привязки настройте хранилище секретов операционной системы.</p>':''}${error()}<div class="r5-actions end">${button(state.linked||shiki?.linked?'Далее':'Пропустить','sync','primary',state.busy?'disabled':'')}</div>`);}
function sync(){return intro(state.syncDone?'Можно начинать':'Собираем всё на месте',state.syncDone?'Аккаунт и выбранные подключения сохранены. При следующем запуске откроется этот сервер.':'Синхронизируем данные с выбранным сервером.',`<div class="r5-sync-list">${state.syncRows.map(r=>`<div class="r5-sync-row" data-failed="${!!r.failed}"><span>${r.done?icon('check'):r.failed?icon('circle-alert'):'<span class="r5-spinner" aria-hidden="true"></span>'}${esc(r.name)}</span><small data-failed="${!!r.failed}">${r.done?'Готово':r.failed?'Требуется внимание':'Синхронизация…'}</small></div>`).join('')}</div>${error()}<div class="r5-actions end">${state.syncDone?button('Открыть приложение '+icon('arrow-right'),'finish'):!state.busy?button('Повторить','sync')+(state.optionalFailure?button('Продолжить без импорта','skip-import','secondary'):''):''}</div>`,true);}
function render(){if(pickerMode){$('#r5-stage').replaceChildren();mountPicker($('#r5-stage'),'header');$('#r5-stage button')?.focus();return;}
 const focused=document.activeElement,focusKey=root.contains(focused)?(focused.id?'#'+CSS.escape(focused.id):focused.dataset.action?'[data-action="'+CSS.escape(focused.dataset.action)+'"]':focused.name?'[name="'+CSS.escape(focused.name)+'"]':null):null;
 $('#r5-stage').innerHTML=({welcome,mode:modes,server,auth,access,links,sync}[state.step]||welcome)();
 if(lastStep!==state.step){$('.r5-page').classList.add('r5-panel-enter');lastStep=state.step;$('#r5-announcer').textContent=$('h1')?.textContent||'';}
 if($('#wizard-options'))mountPicker($('#wizard-options'),'wizard');
 $('#r5-server-name').textContent=state.server?new URL(state.server).host:state.product?.name||'home_theater';
 updateFooter();updateAurora();renderDialog();if(focusKey&&!pending){const next=$(focusKey);if(next&&!next.disabled)next.focus({preventScroll:true});}
}
async function go(step){attempt++;void call('setup-cancel-probe');state.busy=false;state.error='';state.pickerOpen=false;root.style.setProperty('--r5-slide-from',order.indexOf(step)<order.indexOf(state.step)?'-14px':'14px');state.step=step;if(step==='server')state.probe=null;await call('setup-step',{step});render();requestAnimationFrame(()=>$('.r5-page input,.r5-page button')?.focus({preventScroll:true}));if(step==='links')await loadLinks();}
async function run(fn){try{state.error='';await fn();}catch(e){state.busy=false;state.error=e.message.replace(/^Error invoking remote method 'host': Error: /,'');if(pickerMode){const p=document.createElement('p');p.className='r5-picker-error';p.setAttribute('role','alert');p.textContent=state.error;$('#r5-stage').append(p);}else render();}}
async function loadLinks(){await run(async()=>{state.me=await call('setup-me');const d=await call('setup-binding');state.linked=d.active;render();});}
async function probe(){
 if(state.busy)return;
 if(state.probe?.status==='verified'&&Date.now()-(state.probe.at||Date.now())<300000)return connect();
 const own=++attempt;state.busy=true;state.probe={status:'checking',title:'Устанавливаем соединение',detail:'Проверяем адрес и совместимость API'};render();
 const progress=setTimeout(()=>{if(own===attempt){state.probe.title='Проверяем сервер';render();}},500);
 try{const p=await call('setup-probe',{address:state.address||state.selected?.origin||state.product.server.origin});if(own!==attempt)return;state.address=p.origin;state.probe={...p,status:'verified',title:'Сервер подтверждён',detail:'API совместим. Можно перейти к входу в аккаунт.'};}
 catch(e){if(own!==attempt)return;state.probe={status:'error',title:'Не удалось подключиться',detail:e.message.replace(/^Error invoking remote method 'host': Error: /,'')};}
 finally{clearTimeout(progress);if(own===attempt){state.busy=false;render();}}
}
function renderDialog(){const overlay=$('#r5-overlay');overlay.hidden=!pending;if(!pending){pendingMeta=null;return;}overlay.innerHTML=`<section class="r5-dialog" role="dialog" aria-modal="true" aria-labelledby="pause-heading"><h2 id="pause-heading">${esc(pendingMeta?.title||"Приостановить загрузку?")}</h2><p>${esc(pendingMeta?.text||"Файлы и задания останутся у прежнего сервера. После возвращения загрузку можно продолжить.")}</p><div class="r5-actions end">${button('Остаться','stay','quiet')}${button(esc(pendingMeta?.confirm||'Приостановить и перейти'),'confirm')}</div></section>`;overlay.querySelector('button')?.focus();}
async function connect(confirm=false){state.busy=true;render();const result=await call('setup-connect',{address:state.address,name:state.name,confirm});if(result.needsPause){state.busy=false;pending=()=>connect(true);renderDialog();return;}state.server=state.address;state.profiles=(await call('setup-state')).profiles;await go(result.step);}
async function switchProfile(p,confirm=false){const result=await call('profile-select',{id:p.id,confirm});if(result?.needsPause){pending=()=>switchProfile(p,true);renderDialog();}}
async function checkAccess(){if(polling||state.step!=='access')return;polling=true;try{const user=await call('setup-status');if(!user)await go('auth');else if(user.access==='approved')await go('links');else{const changed=state.access!==user.access;state.access=user.access;if(changed)render();}}finally{polling=false;}}
async function synchronize(skipImport=false){await go('sync');state.busy=true;state.syncRows=[];state.syncDone=false;state.optionalFailure=false;render();
 const operations=[['Аккаунт','setup-me'],['Списки и прогресс просмотра','setup-lists'],...(state.linked?[['Устройство','setup-binding']]:[]),...(!skipImport&&state.me?.shikimori?.linked?[['Импорт Shikimori','setup-import']]:[])];
 for(const[name,action]of operations){const row={name};state.syncRows.push(row);render();try{const result=await call(action);row.done=true;if(action==='setup-me')state.me=result;}catch(e){row.failed=true;state.error=e.message.replace(/^Error invoking remote method 'host': Error: /,'');state.optionalFailure=action==='setup-import';state.busy=false;render();return;}}
 state.busy=false;state.syncDone=true;render();
}
root.addEventListener('click',e=>{const b=e.target.closest('[data-action]');if(!b||b.disabled)return;void run(async()=>{switch(b.dataset.action){
 case 'return':return call('setup-return');
 case 'next':return go(state.step==='welcome'?'mode':'server');
 case 'back':return go(({mode:'welcome',server:'mode',auth:'server',access:'auth',links:'auth'})[state.step]||'welcome');
 case 'picker':state.pickerOpen=!state.pickerOpen;render();if(state.pickerOpen)$('#wizard-options button')?.focus();return;
 case 'connect':return probe();case 'toggle-auth':state.register=!state.register;render();$('[name=login]')?.focus();return;
 case 'access-check':return checkAccess();case 'other-server':return go('server');
 case 'bind':state.busy=true;render();try{const r=await call('setup-binding',{link:true});state.linked=r.active;}finally{state.busy=false;render();}return;
 case 'shikimori':state.busy=true;render();try{state.me=await call('setup-shikimori');}finally{state.busy=false;render();}return;
 case 'sync':return synchronize();case 'skip-import':return synchronize(true);case 'finish':return call('setup-finish');
 case 'stay':pending=null;renderDialog();if(pickerMode)await call('setup-dialog-size',{compact:true});return;case 'confirm':{const fn=pending;pending=null;renderDialog();return fn?.();}
 }});});
root.addEventListener('input',e=>{if(e.target.id==='address'){state.address=e.target.value;state.probe=null;state.busy=false;attempt++;void call('setup-cancel-probe');const status=$('.r5-probe');status.dataset.result='idle';status.removeAttribute('aria-busy');status.innerHTML=`${icon('server')}<div><strong>Проверим перед входом</strong><p>Соединение, тип сервера и совместимость приложения.</p></div>`;const b=$('[data-action=connect]');b.disabled=false;b.textContent='Связать';}if(e.target.id==='server-label')state.name=e.target.value;if(e.target.name==='login')state.login=e.target.value;});
root.addEventListener('submit',e=>{e.preventDefault();const form=e.target;if(state.busy||!form.reportValidity())return;void run(async()=>{state.busy=true;const data=new FormData(form);render();if(form.id==='auth-form'){
 if(state.register&&data.get('password')!==data.get('confirm'))throw Error('Пароли не совпадают');
 const user=await call('setup-auth',{login:data.get('login'),password:data.get('password'),register:state.register});state.access=user.access;await go(user.access==='approved'?'links':'access');
 }else if(form.id==='invite-form'){await call('setup-invite',{token:data.get('invite')});await checkAccess();}state.busy=false;render();});});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(pickerMode){e.preventDefault();void call('setup-close-picker').catch(()=>{});return;}const headerOpen=!$('#r5-server-popover').hidden,wizardOpen=state.pickerOpen,dialogOpen=!!pending;if(headerOpen||wizardOpen||dialogOpen){e.preventDefault();pending=null;state.pickerOpen=false;$('#r5-server-popover').hidden=true;$('#r5-server-menu').setAttribute('aria-expanded','false');if(headerOpen&&!wizardOpen&&!dialogOpen){$('#r5-server-menu').focus();return;}render();(headerOpen?$('#r5-server-menu'):dialogOpen?$('[data-action=connect]'):$('[data-action=picker]'))?.focus();}}if(e.key==='Tab'&&pending){const buttons=[...$('#r5-overlay').querySelectorAll('button')];if(e.shiftKey&&document.activeElement===buttons[0]){e.preventDefault();buttons.at(-1).focus();}else if(!e.shiftKey&&document.activeElement===buttons.at(-1)){e.preventDefault();buttons[0].focus();}}});
root.addEventListener('click',e=>{const pop=$('#r5-server-popover');if(!pop.hidden&&!e.target.closest('#r5-server-popover,#r5-server-menu')){pop.hidden=true;$('#r5-server-menu').setAttribute('aria-expanded','false');}if(state.pickerOpen&&!e.target.closest('.r5-picker')){state.pickerOpen=false;render();}});
$('#r5-server-menu').onclick=()=>{if(state.profiles.length){const pop=$('#r5-server-popover');pop.hidden=!pop.hidden;$('#r5-server-menu').setAttribute('aria-expanded',String(!pop.hidden));if(!pop.hidden){mountPicker(pop,'header');pop.querySelector('button')?.focus();}}};
setInterval(()=>{if(state.step==='access')void run(checkAccess);},10000);
const auroraPositions={welcome:[-2,0],mode:[3,-4],server:[-5,2],auth:[4,5],access:[-3,-5],links:[6,0],sync:[0,4]};
function updateAurora(){const paused=state.motionPaused||reducedMotion.matches||document.hidden||!windowVisible,plane=$('.r5-aurora-plane'),was=$('.r5-window').classList.contains('r5-motion-paused');if(paused&&!was){plane.style.transform=getComputedStyle(plane).transform;plane.style.transition='none';}if(!paused&&was){plane.style.transition='';plane.style.transform='';}$('.r5-window').classList.toggle('r5-motion-paused',paused);const[x,y]=auroraPositions[state.step]||[0,0];root.style.setProperty('--r5-pan-x',x+'%');root.style.setProperty('--r5-pan-y',y+'%');const b=$('#r5-motion-toggle');b.innerHTML=icon(paused?'play':'pause');b.disabled=reducedMotion.matches;b.setAttribute('aria-pressed',String(paused));b.setAttribute('aria-label',paused?'Возобновить движение фона':'Остановить движение фона');}
$('#r5-motion-toggle').onclick=()=>{state.motionPaused=!state.motionPaused;updateAurora();};
document.addEventListener('visibilitychange',()=>{updateAurora();if(document.hidden)settleDrops();});reducedMotion.addEventListener('change',()=>{updateAurora();if(reducedMotion.matches)settleDrops();});
new IntersectionObserver(entries=>{windowVisible=entries[0].isIntersecting;updateAurora();}).observe(root);
// Approved pagination geometry and liquid transition are defined below.
function footer(){if(state.step==='home')return '';const index=Math.min(6,['welcome','mode','server','auth','access','links','sync'].indexOf(state.step));return `<button class="r5-quiet r5-step-back" data-action="back" ${index===0||state.step==='sync'?'disabled':''}>${icon('arrow-left')}Назад</button><div class="r5-dots" role="img" aria-label="Настройка: ${steps[index]}, шаг ${index+1} из 7">${steps.map((name,i)=>`<span class="r5-dot${i===index?' current':i<index?' done':''}" title="${name}"></span>`).join('')}</div><span class="r5-step-caption">${index+1} из 7</span>`;}
let dotFrame=0,dotIndex=null,dotGeometry=null;
function dotLayout(index){let x=8;return steps.map((_,i)=>{const width=i===index?22:7,mark={x,width};x+=width+8;return mark;});}
function setDropRect(el,x,width,height=8){el.setAttribute('x',x);el.setAttribute('y',14-height/2);el.setAttribute('width',Math.max(0,width));el.setAttribute('height',height);el.setAttribute('rx',height/2);}
function paintDrops(geometry,from,to,t=1){
 const marks=[...root.querySelectorAll('.r5-step-marks rect')];if(!marks.length)return;
 geometry.forEach((g,i)=>setDropRect(marks[i],g.x,g.width,7));dotGeometry=geometry;
 const group=$('.r5-step-liquid'),moving=$('.r5-drop-moving'),receiving=$('.r5-drop-receiving'),bridge=$('.r5-drop-bridge');
 if(t===1){group.removeAttribute('filter');setDropRect(moving,geometry[to].x,22);moving.style.opacity=1;setDropRect(receiving,0,0);setDropRect(bridge,0,0);return;}
 group.setAttribute('filter','url(#r5-drop-join)');
 const a=geometry[from],b=geometry[to],p=t*t*(3-2*t);
 setDropRect(moving,a.x,a.width);moving.style.opacity=1-p;
 setDropRect(receiving,b.x,b.width);
 const center=(a.x+a.width/2)*(1-p)+(b.x+b.width/2)*p;
 setDropRect(bridge,center-3.5,7,7);bridge.style.opacity=Math.sin(Math.PI*t);
}
function settleDrops(){cancelAnimationFrame(dotFrame);dotFrame=0;if(dotIndex!==null)paintDrops(dotLayout(dotIndex),dotIndex,dotIndex);$('.r5-dots')?.removeAttribute('data-merging');}
function updateFooter(){
 const bar=$('#r5-footer');if(state.adding){bar.hidden=false;bar.innerHTML=button('Отменить подключение','return','quiet',state.busy?'disabled':'')+'<span class="r5-small r5-muted">Подключение сервера</span>';return;}bar.hidden=state.step==='home';
 if(bar.hidden){settleDrops();bar.replaceChildren();dotIndex=null;return;}
 const index=['welcome','mode','server','auth','access','links','sync'].indexOf(state.step);
 if(!bar.querySelector('.r5-liquid-steps')){
  bar.innerHTML=footer();
  bar.querySelector('.r5-dots').innerHTML=`<svg class="r5-liquid-steps" viewBox="0 0 128 28" aria-hidden="true"><defs><filter id="r5-drop-join" x="-15%" y="-70%" width="130%" height="240%" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceGraphic" stdDeviation="1.3"/><feColorMatrix type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -8"/></filter></defs><g class="r5-step-marks">${steps.map(name=>`<rect><title>${name}</title></rect>`).join('')}</g><g class="r5-step-liquid"><rect class="r5-drop-moving"/><rect class="r5-drop-receiving"/><rect class="r5-drop-bridge"/></g></svg>`;
 }
 bar.querySelector('[data-action=back]').disabled=index===0||state.step==='sync';
 const dots=bar.querySelector('.r5-dots');dots.setAttribute('aria-label',`Настройка: ${steps[index]}, шаг ${index+1} из 7`);
 bar.querySelector('.r5-step-caption').textContent=`${index+1} из 7`;
 bar.querySelectorAll('.r5-step-marks rect').forEach((mark,i)=>mark.classList.toggle('done',i<index));
 if(index===dotIndex)return;
 const initial=dotIndex===null,previous=dotIndex??index,from=dotGeometry||dotLayout(index),to=dotLayout(index);dotIndex=index;
 cancelAnimationFrame(dotFrame);
 if(initial||reducedMotion.matches||document.hidden||!windowVisible){settleDrops();return;}
 dots.dataset.merging='true';
 const started=performance.now(),duration=Math.max(300,Math.min(560,tweaks.motion*1.3));
 const tick=now=>{
  const t=Math.min(1,(now-started)/duration),p=t*t*(3-2*t);
  const geometry=from.map((g,i)=>({x:g.x+(to[i].x-g.x)*p,width:g.width+(to[i].width-g.width)*p}));
  paintDrops(geometry,previous,index,t);
  if(t<1)dotFrame=requestAnimationFrame(tick);else settleDrops();
 };
 dotFrame=requestAnimationFrame(tick);
}

root.style.setProperty('--r5-motion','360ms');
try{
 const saved=await call('setup-state');state={...state,...saved};
 state.step=order.includes(saved.step)?saved.step:'server';
 state.selected=state.profiles.find(p=>p.id===state.active)||state.product.server;
 state.address=saved.adding?'':(saved.server||state.product.server.origin);state.custom=!!saved.adding;
 if(pickerMode)document.body.classList.add('picker');
 render();
 if(!pickerMode&&state.server&&['auth','access','links','sync'].includes(state.step)){
  try{const user=await call('setup-status');if(!user)state.step='auth';else if(user.access!=='approved'){state.step='access';state.access=user.access;}else if(['auth','access'].includes(state.step))state.step='links';}catch(e){state.error=e.message;}
  render();
 }
 if(!pickerMode&&state.step==='links')await loadLinks();
 if(!pickerMode&&state.step==='sync')await run(()=>synchronize());
}catch(e){$('#r5-stage').textContent='Не удалось открыть настройки: '+e.message;}

window.host.onOAuth?.(open=>{let b=document.getElementById('r5-oauth-close');if(!b){b=document.createElement('button');b.id='r5-oauth-close';b.className='r5-quiet';b.textContent='Отменить подключение Shikimori';b.onclick=()=>call('setup-close-oauth');document.querySelector('.r5-chrome').append(b);}b.hidden=!open;});
