import { now } from './db.js';

const fmt = v => (v === undefined || v === null ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));

export function audit(db, { who, action, entity, entityId, field = null, oldValue = null, newValue = null }) {
  db.run(`INSERT INTO audit_log(at, who, action, entity, entity_id, field, old_value, new_value)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, now(), who, action, entity, String(entityId), field, fmt(oldValue), fmt(newValue));
}

/** Diff two flat objects over `fields` and write one audit row per changed field. Returns changed field names. */
export function auditDiff(db, { who, entity, entityId, before, after, fields, action = 'update' }) {
  const changed = [];
  for (const f of fields) {
    const a = before?.[f] ?? null, b = after?.[f] ?? null;
    if (fmt(a) !== fmt(b)) { audit(db, { who, action, entity, entityId, field: f, oldValue: a, newValue: b }); changed.push(f); }
  }
  return changed;
}
