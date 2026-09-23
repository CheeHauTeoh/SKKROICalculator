// Minimal RFC4180 CSV parser: quotes, escaped quotes, CR/LF, BOM. Returns { headers, rows }.

export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const records = [];
  let row = [], field = '', inQuotes = false, i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); records.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); records.push(row); }
  const nonEmpty = records.filter(r => r.some(v => v.trim() !== ''));
  if (!nonEmpty.length) return { headers: [], rows: [] };
  const headers = nonEmpty[0].map(h => h.trim());
  const rows = nonEmpty.slice(1).map(r => {
    const o = {};
    headers.forEach((h, idx) => { o[h] = (r[idx] ?? '').trim(); });
    return o;
  });
  return { headers, rows };
}

export function toCsv(rows, columns) {
  const esc = v => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const cols = columns || (rows[0] ? Object.keys(rows[0]) : []);
  const lines = [cols.map(esc).join(',')];
  for (const r of rows) lines.push(cols.map(c => esc(r[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}
