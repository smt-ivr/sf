// First-time setup, login (password / Google), and the signed-in user's own profile.
import { checkLock, createSession, hashPassword, LIMITS, login, logout, publicUser, randomToken, recordFailure, revokeSessions, userCount, verifyPassword } from '../auth.js';
import { first, run } from '../db.js';
import { conflict, forbidden, json, noContent, readJson, unauthorized } from '../http.js';
import { getSettings, setSetting } from '../settings.js';
import { fields, normalizeEmail } from '../validate.js';
import { addPhones } from './users.js';

/** GET /auth/options: what the login screen should show. */
export async function getOptions({ env }) {
  const s = await getSettings(env);
  return json({
    needs_setup: (await userCount(env)) === 0,
    google_client_id: s.google_login_enabled === '1' && s.google_client_id ? s.google_client_id : null,
  });
}

/**
 * POST /setup { name, email?, phone?, password }: creates the first user. Works only while there are no
 * users at all, so it is open exactly once (right after the first deploy).
 */
export async function postSetup({ env, request }) {
  const d = fields(await readJson(request))
    .str('name', { required: true, max: 80 })
    .email('email', { nullable: true })
    .phone('phone')
    .password('password', { required: true })
    .done();
  if ((await userCount(env)) > 0) throw conflict('המערכת כבר הוגדרה. התחברו עם המשתמש הקיים', 'ALREADY_SET_UP');
  const res = await run(env, `INSERT INTO sf_users (name, email, password_hash) VALUES (?, ?, ?)`, d.name, d.email ?? null, await hashPassword(d.password));
  const id = res.meta.last_row_id;
  if (d.phone) await addPhones(env, id, [{ phone: d.phone, label: '' }]);
  await setSetting(env, 'ivr_key', randomToken(18));
  return json(await createSession(env, request, await first(env, `SELECT * FROM sf_users WHERE id = ?`, id)), 201);
}

export async function postLogin({ env, request }) {
  const d = fields(await readJson(request)).str('login', { required: true, max: 200 }).str('password', { required: true, max: 200 }).done();
  return json(await login(env, request, d.login, d.password));
}

/** POST /auth/google { credential }: Google's ID token, matched to a user by e-mail. */
export async function postGoogle({ env, request }) {
  const s = await getSettings(env);
  if (s.google_login_enabled !== '1' || !s.google_client_id) throw forbidden('הכניסה עם Google סגורה');
  const d = fields(await readJson(request)).str('credential', { required: true, max: 5000 }).done();
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  await checkLock(env, `ip:${ip}`);
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(d.credential)}`);
  const g = res.ok ? await res.json() : null;
  if (!g?.email || g.aud !== s.google_client_id || String(g.email_verified) !== 'true' || Number(g.exp) * 1000 < Date.now()) {
    await recordFailure(env, `ip:${ip}`, LIMITS.ip);
    throw unauthorized('האימות מול Google נכשל. נסו שוב');
  }
  const user = await first(env, `SELECT * FROM sf_users WHERE email = ? AND is_active = 1`, normalizeEmail(g.email) ?? '');
  if (!user) throw unauthorized(`החשבון ${g.email} לא מחובר לאף משתמש. הוסיפו את המייל בהגדרות המשתמש`);
  return json(await createSession(env, request, user));
}

export async function postLogout({ env, actor }) {
  await logout(env, actor);
  return noContent();
}

export async function getMe({ env, actor }) {
  return json(await publicUser(env, await first(env, `SELECT * FROM sf_users WHERE id = ?`, actor.id)));
}

/** PUT /me/password { current_password?, new_password } (current required when one is set). */
export async function putPassword({ env, request, actor }) {
  const d = fields(await readJson(request)).str('current_password', { max: 200 }).password('new_password', { required: true }).done();
  const user = await first(env, `SELECT * FROM sf_users WHERE id = ?`, actor.id);
  if (user.password_hash && !(await verifyPassword(d.current_password || '', user.password_hash))) {
    throw unauthorized('הסיסמה הנוכחית שגויה');
  }
  await run(env, `UPDATE sf_users SET password_hash = ? WHERE id = ?`, await hashPassword(d.new_password), actor.id);
  await revokeSessions(env, actor.id, actor.session_id);
  return noContent();
}
