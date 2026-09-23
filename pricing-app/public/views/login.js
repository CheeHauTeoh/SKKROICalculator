import { post } from '../api.js';
import { bi, t, esc, errMsg } from '../ui.js';
export async function render(root, { onLogin }) {
  root.innerHTML = `<div class="login card"><h1>${bi('app_name')}</h1><p class="muted small">SK Keong Trading Sdn. Bhd. · internal</p>
    <form id="f"><label>${bi('username')}</label><input type="text" id="u" autocomplete="username" autocapitalize="none" required>
    <label>${bi('password')}</label><input type="password" id="p" autocomplete="current-password" required>
    <div id="err" class="alert bad" style="display:none;margin-top:10px"></div>
    <button class="btn primary block" style="margin-top:14px" type="submit">${bi('login')}</button></form></div>`;
  root.querySelector('#f').onsubmit = async e => {
    e.preventDefault();
    const err = root.querySelector('#err'); err.style.display = 'none';
    try { await post('/api/auth/login', { username: root.querySelector('#u').value, password: root.querySelector('#p').value }); onLogin(); }
    catch (ex) { err.style.display = 'block'; err.innerHTML = ex.status === 401 ? bi('login_failed') : errMsg(ex); }
  };
  root.querySelector('#u').focus();
}
