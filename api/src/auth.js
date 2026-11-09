// Passwords, sessions and login throttling. Two equal users (husband and wife); no roles.
import { all, first, nowIso, nowSec, run } from './db.js';
import { tooMany, unauthorized } from './http.js';
import { clean, normalizeEmail, normalizePhone } from './validate.js';

const enc = new TextEncoder();

export const SESSION_TTL = 90 * 24 * 3600;      // 90 days: it is your own phone
const SEEN_REFRESH = 10 * 60;
const MAX_SESSIONS = 10;                         // per user; oldest are dropped
const PBKDF2_ITERATIONS = 100_000;               // Workers' maximum

// ------------------------------------------------------------------ passwords
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(await pbkdf2(password, salt, PBKDF2_ITERATIONS))}`;
}

export async function verifyPassword(password, stored) {
  const [kind, iter, salt, hash] = String(stored).split('$');
  if (kind !== 'pbkdf2' || !salt || !hash) return false;
  const actual = await pbkdf2(password, unb64(salt), Number(iter));
  const expected = unb64(hash);
  let diff = actual.length ^ expected.length;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ (expected[i] ?? 0);
  return diff === 0;
}

// Used when the user does not exist, so both paths cost the same time.
const DUMMY_HASH = 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const randomToken = (bytes = 32) =>
  b64(crypto.getRandomValues(new Uint8Array(bytes))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]);

// ------------------------------------------------------------------ login throttling
export const LIMITS = {
  login: { max: 5, window: 15 * 60, lock: 15 * 60 },
  ip: { max: 30, window: 15 * 60, lock: 15 * 60 },
};

export async function checkLock(env, key) {
  const row = await first(env, `SELECT locked_until FROM sf_login_attempts WHERE key = ?`, key);
  const wait = row ? row.locked_until - nowSec() : 0;
  if (wait > 0) throw tooMany(`יותר מדי ניסיונות. נסו שוב בעוד ${Math.ceil(wait / 60)} דקות`, wait);
}

export async function recordFailure(env, key, { max, window, lock }) {
  const now = nowSec();
  await run(
    env,
    `INSERT INTO sf_login_attempts (key, failures, window_start, locked_until) VALUES (?1, 1, ?2, 0)
     ON CONFLICT(key) DO UPDATE SET
       failures     = CASE WHEN window_start < ?2 - ?3 THEN 1 ELSE failures + 1 END,
       window_start = CASE WHEN window_start < ?2 - ?3 THEN ?2 ELSE window_start END,
       locked_until = CASE WHEN window_start >= ?2 - ?3 AND failures + 1 >= ?4 THEN ?2 + ?5 ELSE locked_until END`,
    key, now, window, max, lock
  );
}

// ------------------------------------------------------------------ users
/** An active user by e-mail or by one of their phones. */
export async function findUser(env, identifier) {
  const phone = normalizePhone(identifier);
  if (phone) {
    return first(env, `SELECT u.* FROM sf_users u JOIN sf_user_phones p ON p.user_id = u.id WHERE p.phone = ? AND u.is_active = 1`, phone);
  }
  const email = normalizeEmail(identifier);
  return email ? first(env, `SELECT * FROM sf_users WHERE email = ? AND is_active = 1`, email) : null;
}

export const userCount = async (env) => (await first(env, `SELECT COUNT(*) AS n FROM sf_users`)).n;

export async function publicUser(env, u) {
  const phones = await all(env, `SELECT phone, label FROM sf_user_phones WHERE user_id = ? ORDER BY phone`, u.id);
  return {
    id: u.id,
    name: u.name,
    email: u.email ?? null,
    phones,
    has_password: Boolean(u.password_hash),
    is_active: u.is_active === 1,
    created_at: u.created_at,
    last_login_at: u.last_login_at ?? null,
  };
}

// ------------------------------------------------------------------ sessions
export async function login(env, request, identifier, password) {
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const id = normalizePhone(identifier) || normalizeEmail(identifier) || clean(identifier).toLowerCase();
  const keys = { login: `login:${id}`, ip: `ip:${ip}` };
  await checkLock(env, keys.ip);
  await checkLock(env, keys.login);

  const user = await findUser(env, identifier);
  const ok = await verifyPassword(password, user?.password_hash || DUMMY_HASH);
  if (!user || !user.password_hash || !ok) {
    await recordFailure(env, keys.login, LIMITS.login);
    await recordFailure(env, keys.ip, LIMITS.ip);
    throw unauthorized('שם משתמש או סיסמה שגויים');
  }
  await run(env, `DELETE FROM sf_login_attempts WHERE key = ?`, keys.login);
  return createSession(env, request, user);
}

export async function createSession(env, request, user) {
  await cleanup(env); // housekeeping piggybacks on logins (no cron on the free plan)
  const token = 'sf_' + randomToken();
  const now = nowSec();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO sf_sessions (user_id, token_hash, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(user.id, await sha256(token), now, now + SESSION_TTL, now, (request.headers.get('User-Agent') || '').slice(0, 200)),
    env.DB.prepare(
      `DELETE FROM sf_sessions WHERE user_id = ?1 AND id NOT IN (SELECT id FROM sf_sessions WHERE user_id = ?1 ORDER BY id DESC LIMIT ?2)`
    ).bind(user.id, MAX_SESSIONS),
    env.DB.prepare(`UPDATE sf_users SET last_login_at = ? WHERE id = ?`).bind(nowIso(), user.id),
  ]);
  return { token, expires_at: new Date((now + SESSION_TTL) * 1000).toISOString(), user: await publicUser(env, user) };
}

/** Resolves the bearer token to the acting user, or throws 401. */
export async function authenticate(env, request) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw unauthorized();
  const row = await first(
    env,
    `SELECT s.id AS session_id, s.expires_at, s.last_seen_at, u.*
     FROM sf_sessions s JOIN sf_users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    await sha256(token)
  );
  const now = nowSec();
  if (!row || row.expires_at <= now || !row.is_active) throw unauthorized('ההתחברות פגה, יש להתחבר מחדש');
  if (now - row.last_seen_at > SEEN_REFRESH) await run(env, `UPDATE sf_sessions SET last_seen_at = ? WHERE id = ?`, now, row.session_id);
  return { id: row.id, name: row.name, email: row.email, session_id: row.session_id };
}

export const logout = (env, actor) => run(env, `DELETE FROM sf_sessions WHERE id = ?`, actor.session_id);

export const revokeSessions = (env, userId, keepSessionId = 0) =>
  run(env, `DELETE FROM sf_sessions WHERE user_id = ? AND id != ?`, userId, keepSessionId);

export const cleanup = (env) =>
  env.DB.batch([
    env.DB.prepare(`DELETE FROM sf_sessions WHERE expires_at <= ?`).bind(nowSec()),
    env.DB.prepare(`DELETE FROM sf_login_attempts WHERE locked_until < ?1 AND window_start < ?1 - 86400`).bind(nowSec()),
    env.DB.prepare(`DELETE FROM sf_ivr_calls WHERE created_at < ?`).bind(nowSec() - 2 * 86400),
  ]);
