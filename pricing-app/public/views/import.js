// Import / update: check (dry run, shows mapping) then commit. Idempotent by file hash + merge-by-key.
import { get, post } from '../api.js';
import { esc, bi, t, rm, num, toast, errMsg, dt } from '../ui.js';

const KINDS = [['auto', 'auto_detect'], ['products', 'seed_products'], ['customers', 'seed_customers'], ['bundles', 'seed_bundles'], ['crosssell', 'seed_crosssell'], ['sales', 'UBS sales (item × customer)'], ['purchases', 'UBS purchases']];
const EXPECTED = 2_752_185_900;

export async function render(root) {
  root.innerHTML = `<h1>${bi('import_title')}</h1><p class="alert info">${bi('import_safe')}</p>
    <div class="card"><div class="row"><div><label>${bi('import_kind')}</label><select id="kind">${KINDS.map(([k, l]) => `<option value="${k}">${k === 'auto' ? t(l) : esc(l)}</option>`).join('')}</select></div>
      <div class="grow"><label>${bi('choose_file')}</label><input type="file" id="file" accept=".csv,text/csv"></div><button class="btn primary" id="check" style="align-self:flex-end">${bi('check')}</button></div>
      <div id="result" style="margin-top:12px"></div></div>
    <h2>${bi('import_history')}</h2><div id="recon" class="card flat"></div><div class="tblwrap"><table class="tbl" id="hist"></table></div>`;
  let file = null, text = null;
  root.querySelector('#file').onchange = e => { file = e.target.files[0]; text = null; };
  const readText = () => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(file); });

  const history = async () => {
    const h = await get('/api/imports');
    const ok = h.reconcile.total_sen === EXPECTED;
    root.querySelector('#recon').innerHTML = `<div class="kpis"><div class="kpi"><div class="v">RM ${rm(h.reconcile.total_sen)}</div><div class="l">${bi('reconcile')} · ${h.reconcile.products} SKU · ${h.reconcile.core} ${t('core')}</div></div><div class="kpi"><div class="v">${ok ? '✔' : '≠'}</div><div class="l">${bi('expected_total')}${ok ? '' : ` · Δ RM ${rm(h.reconcile.total_sen - EXPECTED)}`}</div></div></div>`;
    root.querySelector('#hist').innerHTML = `<tr><th>${t('when')}</th><th>${t('who')}</th><th>${t('import_kind')}</th><th>${t('choose_file')}</th><th class="num">${t('rows')}</th><th>${t('what')}</th></tr>` +
      h.imports.map(i => `<tr><td class="small">${dt(i.imported_at)}</td><td>${esc(i.imported_by)}</td><td>${esc(i.kind)}</td><td class="small">${esc(i.filename || '')}<div class="muted">${esc(i.sha256.slice(0, 12))}</div></td><td class="num">${num(i.row_count)}</td><td class="small">${esc(JSON.stringify(i.summary))}</td></tr>`).join('') || `<tr><td colspan="6" class="muted">${t('none_yet')}</td></tr>`;
  };
  await history();

  root.querySelector('#check').onclick = async () => {
    if (!file) { toast(t('choose_file'), 'err'); return; }
    const res = root.querySelector('#result'); res.innerHTML = t('loading');
    try {
      text = text || await readText();
      const kind = root.querySelector('#kind').value;
      const c = await post('/api/import/check', { kind, filename: file.name, text });
      const totals = Object.entries(c.totals).map(([k, v]) => `<div class="kpi"><div class="v">${k.endsWith('_sen') ? 'RM ' + rm(v) : Array.isArray(v) ? esc(v.join(', ')) : num(v)}</div><div class="l">${esc(k)}</div></div>`).join('');
      res.innerHTML = `<div class="kpis"><div class="kpi"><div class="v">${esc(c.kind)}</div><div class="l">${esc(c.label)}</div></div><div class="kpi"><div class="v">${num(c.row_count)}</div><div class="l">${t('rows')}</div></div>${totals}</div>
        ${c.missing.length ? `<p class="alert bad">${bi('missing')}: ${esc(c.missing.join(', '))}</p>` : ''}
        ${c.already_imported ? `<p class="alert warn">${bi('already_imported')} (${dt(c.already_imported.imported_at)}, ${esc(c.already_imported.imported_by)})</p>` : ''}
        <h3>${bi('mapping')}</h3><div class="tblwrap"><table class="tbl">${Object.entries(c.mapping).map(([k, v]) => `<tr><td><b>${esc(k)}</b></td><td>← ${esc(v)}</td></tr>`).join('')}</table></div>
        ${c.unmapped.length ? `<p class="small muted">${bi('unmapped')}: ${esc(c.unmapped.join(', '))}</p>` : ''}
        ${c.warning_count ? `<details><summary>${t('warnings')} (${c.warning_count})</summary><ul class="small">${c.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></details>` : ''}
        <h3>Preview</h3><div class="tblwrap"><table class="tbl"><tr>${Object.keys(c.preview[0] || {}).map(k => `<th>${esc(k)}</th>`).join('')}</tr>${c.preview.map(r => `<tr>${Object.values(r).map(v => `<td class="small">${esc(v ?? '')}</td>`).join('')}</tr>`).join('')}</table></div>
        <div class="row" style="margin-top:12px"><button class="btn primary" id="commit" ${c.missing.length ? 'disabled' : ''}>${bi('commit')}</button>${c.already_imported ? `<label class="small"><input type="checkbox" id="force"> force</label>` : ''}</div><div id="cres" class="small" style="margin-top:8px"></div>`;
      res.querySelector('#commit').onclick = async () => {
        if (!confirm(t('confirm'))) return;
        res.querySelector('#commit').disabled = true;
        try { const r = await post('/api/import/commit', { kind: c.kind, filename: file.name, text, force: !!res.querySelector('#force')?.checked });
          res.querySelector('#cres').innerHTML = r.skipped ? `<span class="alert warn">${bi('already_imported')}</span>` : `<span class="alert info">${esc(JSON.stringify(r.summary))}</span>`; toast(t('saved')); await history(); }
        catch (ex) { toast(errMsg(ex), 'err'); res.querySelector('#commit').disabled = false; }
      };
    } catch (ex) { res.innerHTML = `<p class="alert bad">${errMsg(ex)}${ex.body?.headers ? `<br>headers: ${esc(ex.body.headers.join(' | '))}` : ''}</p>`; }
  };
}
