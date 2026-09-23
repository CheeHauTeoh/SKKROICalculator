// Server-side enforcement of the cost-visibility rule. Salespeople must never receive purchase cost,
// implied cost, margin, target margin, UOM factor or purchase quantities. This is applied to every
// API response for a user who cannot see cost, regardless of which route produced it.

import { canSeeCost } from './auth.js';

export const SENSITIVE_KEY = /(cost|margin|purchase|uom_factor|uom_purchase|no_purchase|cost_data_quality)/i;

export function redactDeep(value) {
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(k)) continue;
      out[k] = redactDeep(v);
    }
    return out;
  }
  return value;
}

export function redactFor(db, user, payload) {
  return canSeeCost(db, user) ? payload : redactDeep(payload);
}
