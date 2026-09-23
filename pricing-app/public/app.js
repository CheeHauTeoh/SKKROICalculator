import * as store from './store.js';
import { get, post, ApiError } from './api.js';
import { esc, t, bi, toast, modal, errMsg, dt } from './ui.js';

const VIEWS = {
  login: () => import('./views/login.js'), lookup: () => import('./views/lookup.js'), visit: () => import('./views/visit.js'), capture: () => import('./views/capture.js'),
  uom: () => import('./views/uom.js'), products: () => import('./views/products.js'), intel: () => import('./views/intel.js'), import: () => import('./views/import.js'), admin: () => import('./views/admin.js'),
  more: () => import('./views/admin.js'),
};
const SALES_TABS = [['lookup', '¥', 'nav_lookup'], ['visit', '👤', 'nav_visit'], ['capture', '✎', 'nav_capture'], ['more', '⋯', 'nav_more']];
const MGMT_NAV = [['uom', 'nav_uom'], ['products', 'nav_products'], ['intel', 'nav_intel'], ['import', 'nav_import'], ['lookup', 'nav_lookup'], ['visit', 'nav_visit'], ['capture', 'nav_capture'], ['admin', 'nav_admin']];
const ROLE_ROUTES = { salesperson: ['lookup', 'visit', 'capture', 'more'], finance: ['uom', 'products', 'intel', 'import', 'lookup', 'visit', 'capture', 'admin', 'more'], owner: ['uom', 'products', 'intel', 'import', 'lookup', 'visit', 'capture', 'admin', 'more'] };

export const app = { user: null, canSeeCost: false, cleanup: null };
const root = document.getElementById('app');

export function navigate(hash) { location.hash = hash; }
export function parseRoute() {
  const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
  const [name, ...rest] = path.split('/');
  return { name: name || '', rest, params: Object.fromEntries(new URLSearchParams(qs || '')) };
}

async function loadUser() {
  try { const me = await get('/api/auth/me'); app.user = me.user; app.canSeeCost = me.pricing_visibility === 'full'; await store.init(); return true; }
  catch (e) {
    if (e instanceof ApiError && e.status === 401) { app.user = null; return false; }
    // offline: fall back to the cached user so the salesperson screens keep working
    await store.init(); app.user = store.state.user; app.canSeeCost = false; return !!app.user;
  }
}

function layout(route) {
  const u = app.user;
  const isMgmt = u.role !== 'salesperson';
  const status = `<span class="status"><span class="dot ${store.state.online ? '' : 'off'}"></span><span id="st-text"></span></span>`;
  const top = `<header class="top"><div class="top-inner"><span class="brand">${esc(t('app_name'))}</span><span class="muted small">${esc(u.display_name)}</span>${status}</div></header>`;
  if (isMgmt) {
    const side = MGMT_NAV.map(([r, k]) => `<a href="#/${r}" class="${route.name === r ? 'active' : ''}">${bi(k)}</a>`).join('') + `<a href="#/more" class="${route.name === 'more' ? 'active' : ''}">${bi('nav_more')}</a>`;
    return `${top}<div class="desk"><nav class="side">${side}</nav><main class="main" id="view"></main></div>${mobileTabs(route, [['uom', '⚖', 'nav_uom'], ['products', '¥', 'nav_products'], ['intel', '◔', 'nav_intel'], ['more', '⋯', 'nav_more']])}`;
  }
  return `${top}<main class="main" id="view"></main>${mobileTabs(route, SALES_TABS)}`;
}
const mobileTabs = (route, tabs) => `<nav class="tabs ${app.user.role !== 'salesperson' ? 'mgmt-tabs' : ''}">${tabs.map(([r, ico, k]) => `<a href="#/${r}" class="${route.name === r ? 'active' : ''}"><span class="ico">${ico}</span>${bi(k, '')}</a>`).join('')}</nav>`;

function renderStatus() {
  const el = document.getElementById('st-text'); const dot = document.querySelector('.top .dot');
  if (!el) return;
  const s = store.state;
  dot?.classList.toggle('off', !s.online);
  el.textContent = `${s.online ? t('online') : t('offline')}${s.syncing ? ' · ' + t('syncing') : ''}${s.pending ? ` · ${s.pending} ${t('pending')}` : ''}`;
}
store.subscribe(renderStatus);

let lastLayoutKey = null;
export async function render() {
  const route = parseRoute();
  if (app.cleanup) { try { app.cleanup(); } catch {} app.cleanup = null; }
  if (!app.user) {
    lastLayoutKey = null;
    const m = await VIEWS.login();
    root.innerHTML = '<main class="main" id="view"></main>';
    app.cleanup = await m.render(document.getElementById('view'), { onLogin: async () => { await loadUser(); store.refreshSnapshot(); navigate(`#/${ROLE_ROUTES[app.user.role][0]}`); render(); } });
    return;
  }
  const allowed = ROLE_ROUTES[app.user.role];
  if (!route.name || !allowed.includes(route.name)) { navigate(`#/${allowed[0]}`); return; }
  const key = `${app.user.username}:${route.name}`;
  if (lastLayoutKey !== key) { root.innerHTML = layout(route); lastLayoutKey = key; renderStatus(); }
  const view = document.getElementById('view');
  view.innerHTML = `<div class="boot">${t('loading')}</div>`;
  try {
    const m = await VIEWS[route.name]();
    app.cleanup = await m.render(view, { user: app.user, canSeeCost: app.canSeeCost, params: route.params, rest: route.rest, navigate, rerender: render, logout });
  } catch (e) { console.error(e); view.innerHTML = `<div class="alert bad">${errMsg(e)}</div>`; }
  if (app.user.must_change_password && route.name !== 'more') forcePasswordChange();
}

async function logout() {
  try { await post('/api/auth/logout'); } catch {}
  await store.clearAll(); app.user = null; lastLayoutKey = null; navigate('#/login'); render();
}

let pwModalOpen = false;
function forcePasswordChange() {
  if (pwModalOpen) return; pwModalOpen = true;
  modal(`<h2>${bi('change_password')}</h2><p class="alert warn">${bi('must_change')}</p>
    <label>${bi('current_password')}</label><input type="password" id="pw-cur" autocomplete="current-password">
    <label>${bi('new_password')}</label><input type="password" id="pw-new" autocomplete="new-password">
    <div class="row" style="margin-top:12px"><button class="btn primary grow" id="pw-save">${bi('save')}</button></div>`, {
    onMount: (el, close) => {
      el.querySelector('#pw-save').onclick = async () => {
        try { await post('/api/auth/change-password', { current_password: el.querySelector('#pw-cur').value, new_password: el.querySelector('#pw-new').value }); app.user.must_change_password = false; toast(t('saved')); pwModalOpen = false; close(); }
        catch (e) { toast(errMsg(e), 'err'); }
      };
    },
  });
}

window.addEventListener('hashchange', render);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
(async () => {
  await loadUser();
  if (app.user) store.refreshSnapshot();
  render();
})();
