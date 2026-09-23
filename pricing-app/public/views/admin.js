// "more" (every role): profile, sync, change password, logout.  "admin" (finance/owner): tiers, tier rules, customers, users, settings, audit.
import { get, post, put, patch } from '../api.js';
import * as store from '../store.js';
import { esc, bi, t, rm, rmBig, num, toast, errMsg, modal, on, dt, debounce } from '../ui.js';
import { parseRoute } from '../app.js';

export async function render(root, ctx) {
  const route = parseRoute();
  if (route.name === 'more' || ctx.user.role === 'salesperson') return renderMore(root, ctx);
  return renderAdmin(root, ctx);
}

async function renderMore(root, { user, logout }) {
  const s = store.state;
  root.innerHTML = `<h1>${bi('nav_more')}</h1>
    <div class="card"><div style="font-size:18px;font-weight:700">${esc(user.display_name)}</div><div class="muted small">${esc(user.username)} · ${t('role_' + user.role)}${user.salesperson_code ? ` · ${esc(user.salesperson_code)}` : ''}</div></div>
    <div class="card" style="margin-top:10px"><div class="row"><div class="grow"><div>${s.online ? bi('online') : bi('offline')}</div><div class="small muted">${t('last_sync')}: ${dt(s.lastSync)} · ${s.pending} ${t('pending')}</div></div><button class="btn" id="sync">${bi('refresh')}</button></div></div>
    <div class="card" style="margin-top:10px"><button class="btn block" id="pw">${bi('change_password')}</button></div>
    <div class="card" style="margin-top:10px"><button class="btn block danger" id="out">${bi('logout')}</button></div>`;
  root.querySelector('#sync').onclick = async () => { await store.syncAll(); toast(store.state.error ? errMsg({ message: store.state.error }) : t('synced'), store.state.error ? 'err' : 'ok'); renderMore(root, { user, logout }); };
  root.querySelector('#out').onclick = () => { if (store.state.pending && !confirm(`${store.state.pending} ${t('pending')}. ${t('confirm')}`)) return; logout(); };
  root.querySelector('#pw').onclick = () => modal(`<h2>${bi('change_password')}</h2><label>${bi('current_password')}</label><input type="password" id="c"><label>${bi('new_password')}</label><input type="password" id="n"><div class="row" style="margin-top:12px"><button class="btn grow" data-close>${bi('cancel')}</button><button class="btn primary grow" id="go">${bi('save')}</button></div>`, {
    onMount: (el, close) => { el.querySelector('#go').onclick = async () => { try { await post('/api/auth/change-password', { current_password: el.querySelector('#c').value, new_password: el.querySelector('#n').value }); toast(t('saved')); close(); } catch (e) { toast(errMsg(e), 'err'); } }; },
  });
}

async function renderAdmin(root, { user }) {
  const isOwner = user.role === 'owner';
  const [tiers, rules, settings] = await Promise.all([get('/api/tiers'), get('/api/tier-rules'), get('/api/settings')]);
  const tierOpts = sel => tiers.map(x => `<option value="${x.code}" ${x.code === sel ? 'selected' : ''}>${esc(x.name_zh)} ${x.code}</option>`).join('');
  root.innerHTML = `<h1>${bi('admin_title')}</h1>
    <h2>${bi('tiers')}</h2><div class="card flat"><table class="tbl" id="tiers"><tr><th>Code</th><th>中文</th><th>English</th><th>Sort</th></tr>${tiers.map(x => `<tr><td><input class="w-sm" data-k="code" value="${esc(x.code)}"></td><td><input data-k="name_zh" value="${esc(x.name_zh)}"></td><td><input data-k="name_en" value="${esc(x.name_en)}"></td><td><input class="w-sm" data-k="sort" value="${x.sort}"></td></tr>`).join('')}<tr><td><input class="w-sm" data-k="code" placeholder="NEW"></td><td><input data-k="name_zh"></td><td><input data-k="name_en"></td><td><input class="w-sm" data-k="sort" value="99"></td></tr></table><button class="btn sm primary" id="save-tiers" style="margin-top:8px">${bi('save')}</button></div>
    <h2>${bi('tier_rules')}</h2><div class="card flat"><p class="small muted">${t('customers_n')} · ${t('fy_value')} · ${t('override')}</p><div class="tblwrap"><table class="tbl" id="rules"><tr><th>${t('customer_type')}</th><th>${t('size')}</th><th class="num">${t('customers_n')}</th><th class="num">${t('fy_value')}</th><th>Now</th><th>${t('price_tier')}</th></tr>
      ${rules.matrix.map(m => { const r = rules.rules.find(x => x.customer_type === m.customer_type && x.size_tier === m.size_tier) || rules.rules.find(x => x.customer_type === m.customer_type && x.size_tier === '*') || rules.rules.find(x => x.customer_type === '*' && x.size_tier === m.size_tier); return `<tr data-type="${esc(m.customer_type)}" data-size="${esc(m.size_tier)}"><td>${esc(m.customer_type || '(none)')}</td><td>${esc(m.size_tier || '(none)')}</td><td class="num">${num(m.customers)}${m.overrides ? ` <span class="badge">${m.overrides} ${t('override')}</span>` : ''}</td><td class="num">${rmBig(m.fy_value_sen)}</td><td class="small">${esc(m.current_tiers || '')}</td><td><select class="w-sm" data-rule><option value="">—</option>${tierOpts(r?.price_tier)}</select></td></tr>`; }).join('')}</table></div>
      <div class="row" style="margin-top:8px"><button class="btn sm primary" id="save-rules">${bi('save')}</button><button class="btn sm" id="apply-rules">${bi('apply_rules')}</button><span class="small muted" id="rules-res"></span></div></div>
    <h2>${bi('customers')}</h2><div class="card flat"><input type="search" id="cq" placeholder="${esc(t('search'))}"><div class="tblwrap"><table class="tbl" id="custs" style="margin-top:8px"></table></div></div>
    ${isOwner ? `<h2>${bi('users')}</h2><div class="card flat"><div class="tblwrap"><table class="tbl" id="users"></table></div><button class="btn sm" id="add-user" style="margin-top:8px">${bi('add_user')}</button></div>
    <h2>${bi('admin_title')}</h2><div class="card flat"><label><input type="checkbox" id="s-cost" ${settings.salesperson_can_see_cost === '1' ? 'checked' : ''}> ${bi('sp_can_see_cost')}</label>
      <label>${bi('default_tier')}</label><select id="s-tier" style="width:auto">${tierOpts(settings.default_price_tier)}</select><label>${bi('fy')}</label><input id="s-fy" style="width:160px" value="${esc(settings.fy_label || '')}"><label>${bi('floor_discount')}</label><input id="s-floor" style="width:120px" value="${esc(settings.default_floor_discount_pct || '')}">
      <button class="btn sm primary" id="save-settings" style="margin-top:8px">${bi('save')}</button></div>
    <h2>${bi('reset_title')}</h2><div class="card flat"><p class="small muted">${bi('reset_help')}</p><button class="btn sm danger" id="reset-db">${bi('reset_title')}</button></div>` : ''}
    <h2>${bi('audit')}</h2><div class="filters"><input type="search" id="aq" placeholder="${esc(t('who'))}"><a class="btn sm" href="/api/export/audit.csv">${bi('export')} CSV</a></div><div class="tblwrap"><table class="tbl" id="audit"></table></div>`;

  root.querySelector('#save-tiers').onclick = async () => {
    const rows = [...root.querySelectorAll('#tiers tr')].slice(1).map(tr => Object.fromEntries([...tr.querySelectorAll('input')].map(i => [i.dataset.k, i.value.trim()]))).filter(r => r.code);
    try { await put('/api/tiers', { tiers: rows }); toast(t('saved')); renderAdmin(root, { user }); } catch (e) { toast(errMsg(e), 'err'); }
  };
  root.querySelector('#save-rules').onclick = async () => {
    const rs = [...root.querySelectorAll('#rules tr[data-type]')].map(tr => ({ customer_type: tr.dataset.type || '', size_tier: tr.dataset.size || '', price_tier: tr.querySelector('[data-rule]').value })).filter(r => r.price_tier);
    try { await put('/api/tier-rules', { rules: rs.map(r => ({ ...r, customer_type: r.customer_type || '*', size_tier: r.size_tier || '*' })) }); toast(t('saved')); } catch (e) { toast(errMsg(e), 'err'); }
  };
  root.querySelector('#apply-rules').onclick = async () => { if (!confirm(t('confirm'))) return; try { const r = await post('/api/tier-rules/apply'); root.querySelector('#rules-res').textContent = `${r.changed} ${t('changed')}`; loadCust(); } catch (e) { toast(errMsg(e), 'err'); } };

  const loadCust = async (q = '') => {
    const rows = await get(`/api/customers?q=${encodeURIComponent(q)}`);
    root.querySelector('#custs').innerHTML = `<tr><th>${t('customer')}</th><th>${t('customer_type')}</th><th>${t('size')}</th><th>${t('nav_lookup')}</th><th class="num">${t('fy_value')}</th><th>${t('price_tier')}</th></tr>` +
      rows.slice(0, 200).map(c => `<tr data-code="${esc(c.customer_code)}"><td><b>${esc(c.customer_name)}</b><div class="small muted">${esc(c.customer_code)}</div></td><td>${esc(c.customer_type || '')}</td><td>${esc(c.size_tier || '')}</td><td>${esc(c.salesperson || '')}</td><td class="num">${rmBig(c.fy_value_sen)}</td><td class="nowrap"><select class="w-sm" data-ctier>${tierOpts(c.price_tier)}</select> ${c.price_tier_override ? `<span class="badge">${t('override')}</span> <button class="btn sm" data-unset>↺</button>` : ''}</td></tr>`).join('');
  };
  await loadCust();
  root.querySelector('#cq').oninput = debounce(e => loadCust(e.target.value), 250);
  on(root.querySelector('#custs'), 'change', '[data-ctier]', async (e, el) => { try { await patch(`/api/customers/${encodeURIComponent(el.closest('tr').dataset.code)}`, { price_tier: el.value }); toast(t('saved')); loadCust(root.querySelector('#cq').value); } catch (ex) { toast(errMsg(ex), 'err'); } });
  on(root.querySelector('#custs'), 'click', '[data-unset]', async (e, el) => { try { await patch(`/api/customers/${encodeURIComponent(el.closest('tr').dataset.code)}`, { price_tier_override: false }); loadCust(root.querySelector('#cq').value); } catch (ex) { toast(errMsg(ex), 'err'); } });

  if (isOwner) {
    const loadUsers = async () => {
      const us = await get('/api/users');
      root.querySelector('#users').innerHTML = `<tr><th>${t('username')}</th><th>${t('display_name')}</th><th>${t('role')}</th><th>${t('salesperson_code')}</th><th>${t('active')}</th><th></th></tr>` +
        us.map(u => `<tr data-id="${u.id}"><td><b>${esc(u.username)}</b>${u.must_change_password ? ` <span class="badge warn">pw</span>` : ''}</td><td><input data-k="display_name" value="${esc(u.display_name)}"></td><td><select data-k="role" class="w-sm">${['salesperson', 'finance', 'owner'].map(r => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${t('role_' + r)}</option>`).join('')}</select></td><td><input class="w-sm" data-k="salesperson_code" value="${esc(u.salesperson_code || '')}"></td><td style="text-align:center"><input type="checkbox" data-k="active" ${u.active ? 'checked' : ''}></td><td class="nowrap"><button class="btn sm primary" data-usave>${bi('save', '')}</button> <button class="btn sm" data-upw>${bi('reset_password', '')}</button></td></tr>`).join('');
    };
    await loadUsers();
    on(root.querySelector('#users'), 'click', '[data-usave]', async (e, el) => {
      const tr = el.closest('tr'); const b = {}; tr.querySelectorAll('[data-k]').forEach(i => { b[i.dataset.k] = i.type === 'checkbox' ? i.checked : i.value; });
      try { await patch(`/api/users/${tr.dataset.id}`, b); toast(t('saved')); loadUsers(); } catch (ex) { toast(errMsg(ex), 'err'); }
    });
    on(root.querySelector('#users'), 'click', '[data-upw]', async (e, el) => { const pw = prompt(t('new_password')); if (!pw) return; try { await patch(`/api/users/${el.closest('tr').dataset.id}`, { password: pw }); toast(t('saved')); loadUsers(); } catch (ex) { toast(errMsg(ex), 'err'); } });
    root.querySelector('#add-user').onclick = () => modal(`<h2>${bi('add_user')}</h2><label>${bi('username')}</label><input id="nu"><label>${bi('display_name')}</label><input id="nd"><label>${bi('role')}</label><select id="nr">${['salesperson', 'finance', 'owner'].map(r => `<option value="${r}">${t('role_' + r)}</option>`).join('')}</select><label>${bi('salesperson_code')}</label><input id="ns"><label>${bi('password')}</label><input id="np" type="password"><div class="row" style="margin-top:12px"><button class="btn grow" data-close>${bi('cancel')}</button><button class="btn primary grow" id="go">${bi('save')}</button></div>`, {
      onMount: (el, close) => { el.querySelector('#go').onclick = async () => { try { await post('/api/users', { username: el.querySelector('#nu').value, display_name: el.querySelector('#nd').value, role: el.querySelector('#nr').value, salesperson_code: el.querySelector('#ns').value, password: el.querySelector('#np').value }); toast(t('saved')); close(); loadUsers(); } catch (ex) { toast(errMsg(ex), 'err'); } }; },
    });
    root.querySelector('#reset-db').onclick = () => modal(`<h2>${bi('reset_title')}</h2><p class="alert warn">${bi('reset_help')}</p><label>${bi('password')}</label><input type="password" id="r-pw"><label>${bi('reset_confirm')}</label><input type="text" id="r-c" autocomplete="off" placeholder="RESET"><label><input type="checkbox" id="r-seed"> ${bi('reset_seed')}</label><div class="row" style="margin-top:12px"><button class="btn grow" data-close>${bi('cancel')}</button><button class="btn danger grow" id="r-go">${bi('reset_title')}</button></div>`, {
      onMount: (el, close) => { el.querySelector('#r-go').onclick = async () => { try { await post('/api/admin/reset', { password: el.querySelector('#r-pw').value, confirm: el.querySelector('#r-c').value.trim(), seed_sample: el.querySelector('#r-seed').checked }); toast(t('saved')); close(); location.hash = '#/uom'; } catch (ex) { toast(errMsg(ex), 'err'); } }; },
    });
    root.querySelector('#save-settings').onclick = async () => {
      try { await put('/api/settings', { salesperson_can_see_cost: root.querySelector('#s-cost').checked ? '1' : '0', default_price_tier: root.querySelector('#s-tier').value, fy_label: root.querySelector('#s-fy').value, default_floor_discount_pct: root.querySelector('#s-floor').value }); toast(t('saved')); }
      catch (ex) { toast(errMsg(ex), 'err'); }
    };
  }
  const loadAudit = async (who = '') => {
    const rows = await get(`/api/audit?who=${encodeURIComponent(who)}&limit=200`);
    root.querySelector('#audit').innerHTML = `<tr><th>${t('when')}</th><th>${t('who')}</th><th>${t('what')}</th><th>${t('id')}</th><th>${t('field')}</th><th>${t('old')}</th><th>${t('new')}</th></tr>` +
      rows.map(a => `<tr><td class="small nowrap">${dt(a.at)}</td><td>${esc(a.who)}</td><td>${esc(a.action)} ${esc(a.entity)}</td><td class="small">${esc(a.entity_id)}</td><td>${esc(a.field || '')}</td><td class="small">${esc((a.old_value ?? '').slice(0, 80))}</td><td class="small">${esc((a.new_value ?? '').slice(0, 80))}</td></tr>`).join('');
  };
  await loadAudit();
  root.querySelector('#aq').oninput = debounce(e => loadAudit(e.target.value), 250);
}
