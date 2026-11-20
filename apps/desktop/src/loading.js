document.getElementById('choose').onclick=()=>window.host.call('profile-add');
document.getElementById('local').onclick=()=>window.host.call('setup-local-library');
window.host.call('state').then(state=>{if(state.networkError){document.querySelector('p').textContent='Не удалось открыть сервер';document.querySelector('small').textContent=state.networkError;document.querySelector('.spinner').hidden=true;}});
