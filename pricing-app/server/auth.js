import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { now } from './db.js';

export const ROLES = ['salesperson', 'finance', 'owner'];
const SESSION_DAYS = 30;
export const COOKIE = 'skk_sid';

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
export function verifyPassword(password, stored) {
  const [algo, salt, hash] = String(stored || '').split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const test = scryptSync(String(password), salt, 64);
  const ref = Buffer.from(hash, 'hex');
  return test.length === ref.length && timingSafeEqual(test, ref);
}

const failures = new Map(); // username -> { count, until }
function locked(username) {
  const f = failures.get(username);
  return f && f.until > Date.now();
}
function noteFailure(username) {
  const f = failures.get(username) || { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= 5) { f.until = Date.now() + 60_000; f.count = 0; }
  failures.set(username, f);
}

export function login(db, username, password) {
  const u = String(username || '').trim().toLowerCase();
  if (!u || locked(u)) return null;
  const user = db.get('SELECT * FROM users WHERE username = ? AND active = 1', u);
  if (!user || !verifyPassword(password, user.password_hash)) { noteFailure(u); return null; }
  failures.delete(u);
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  db.run('INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', token, user.id, now(), expires);
  return { token, user: publicUser(user) };
}

export function logout(db, token) {
  if (token) db.run('DELETE FROM sessions WHERE token = ?', token);
}

export function userFromToken(db, token) {
  if (!token) return null;
  const row = db.get(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                      WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`, token, now());
  return row ? publicUser(row) : null;
}

export function publicUser(u) {
  return {
    id: u.id, username: u.username, display_name: u.display_name, role: u.role,
    salesperson_code: u.salesperson_code, must_change_password: !!u.must_change_password, active: !!u.active,
  };
}

export function changePassword(db, userId, newPassword) {
  if (String(newPassword || '').length < 6) throw Object.assign(new Error('password_too_short'), { status: 400 });
  db.run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', hashPassword(newPassword), userId);
}

/** Create the first owner account if the users table is empty. Returns the bootstrap password or null. */
export function bootstrap(db, { adminPassword } = {}) {
  const count = db.get('SELECT COUNT(*) c FROM users').c;
  if (count > 0) return null;
  const pw = adminPassword || 'changeme';
  db.run(`INSERT INTO users(username, display_name, role, password_hash, must_change_password, active, created_at)
          VALUES ('owner', 'Owner', 'owner', ?, 1, 1, ?)`, hashPassword(pw), now());
  db.setSetting('bootstrap_password_source', adminPassword ? 'env' : 'default');
  return pw;
}

/**
 * Recovery: set the owner's password from a deployment secret. Applied once per distinct value
 * (a hash of the value is remembered), so redeploys do not keep resetting it after the owner
 * changed it. Returns true when a reset was applied.
 */
export function applyOwnerPasswordReset(db, value) {
  if (!value || String(value).length < 6) return false;
  const marker = createHash('sha256').update(String(value)).digest('hex');
  if (db.setting('owner_password_reset_marker') === marker) return false;
  const owner = db.get(`SELECT id FROM users WHERE role = 'owner' ORDER BY id LIMIT 1`);
  if (!owner) return false;
  db.run('UPDATE users SET password_hash = ?, must_change_password = 1, active = 1 WHERE id = ?', hashPassword(value), owner.id);
  db.run('DELETE FROM sessions WHERE user_id = ?', owner.id);
  db.setSetting('owner_password_reset_marker', marker);
  db.setSetting('owner_password_reset_at', now());
  return true;
}

/** Ensure a salesperson login exists for a salesperson code seen in customer data. */
export function ensureSalespersonUser(db, code, { defaultPassword = 'sk1234' } = {}) {
  const c = String(code || '').trim();
  if (!c) return false;
  const username = c.toLowerCase().replace(/[^a-z0-9_.-]+/g, '_');
  const exists = db.get('SELECT id FROM users WHERE username = ? OR salesperson_code = ?', username, c);
  if (exists) return false;
  db.run(`INSERT INTO users(username, display_name, role, salesperson_code, password_hash, must_change_password, active, created_at)
          VALUES (?, ?, 'salesperson', ?, ?, 1, 1, ?)`, username, c, c, hashPassword(defaultPassword), now());
  return true;
}

/** Cost visibility rule. Owner and finance always; salesperson only if the owner flips the setting. */
export function canSeeCost(db, user) {
  if (!user) return false;
  if (user.role === 'owner' || user.role === 'finance') return true;
  return db.setting('salesperson_can_see_cost', '0') === '1';
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
