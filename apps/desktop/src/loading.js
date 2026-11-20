document.getElementById('choose').onclick=()=>window.host.call('profile-add');
document.getElementById('local').onclick=()=>window.host.call('setup-local-library');
// A draggable region in the owner window must never cover child-view controls.
const strip=document.createElement('div');strip.className='native-drag-strip';strip.hidden=true;strip.setAttribute('aria-hidden','true');document.body.append(strip);
window.host.onChromeDrag?.(state=>{strip.style.left=state.left+'px';strip.hidden=!state.visible;});
void window.host.call('setup-loading-ready');
window.host.call('state').then(state=>{if(state.networkError){document.querySelector('p').textContent='Не удалось открыть сервер';document.querySelector('small').textContent=state.networkError;document.querySelector('.spinner').hidden=true;}});
