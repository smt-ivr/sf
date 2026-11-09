// The household's users (you and your wife). Both are equal: either one can add, edit or block.
import { hashPassword, publicUser, revokeSessions } from '../auth.js';
import { all, first, run, setClause } from '../db.js';
import { badRequest, conflict, invalid, json, noContent, notFound, readJson } from '../http.js';
import { clean, fields, id, normalizePhone } from '../validate.js';

/** Validates a phones array: [{ phone, label }] -> normalized, unique. */
function parsePhones(raw) {
  if (!Array.isArray(raw) || raw.length > 10) throw invalid({ phones: 'רשימת טלפונים לא תקינה' });
  const out = new Map();
  for (const p of raw) {
    const phone = normalizePhone(typeof p === 'string' ? p : p?.phone);
    if (!phone) throw invalid({ phones: `מספר לא תקין: ${typeof p === 'string' ? p : p?.phone ?? ''}` });
    out.set(phone, { phone, label: clean(p?.label ?? '').slice(0, 40) });
  }
  return [...out.values()];
}

async function checkPhones(env, userId, phones) {
  for (const p of phones) {
    const other = await first(env, `SELECT user_id FROM sf_user_phones WHERE phone = ?`, p.phone);
    if (other && other.user_id !== userId) throw conflict(`המספר ${p.phone} כבר שייך למשתמש אחר`);
  }
}

export async function addPhones(env, userId, phones) {
  await checkPhones(env, userId, phones);
  await env.DB.batch(phones.map((p) =>
    env.DB.prepare(`INSERT INTO sf_user_phones (phone, user_id, label) VALUES (?, ?, ?) ON CONFLICT(phone) DO UPDATE SET label = excluded.label`).bind(p.phone, userId, p.label)
  ));
}

async function emailTaken(env, email, exceptId = 0) {
  if (email && (await first(env, `SELECT id FROM sf_users WHERE email = ? AND id != ?`, email, exceptId))) throw conflict('המייל כבר שייך למשתמש אחר');
}

export async function list({ env }) {
  const users = await all(env, `SELECT * FROM sf_users ORDER BY id`);
  return json(await Promise.all(users.map((u) => publicUser(env, u))));
}

/** POST /users { name, email?, password?, phones? } */
export async function create({ env, request }) {
  const body = await readJson(request);
  const d = fields(body).str('name', { required: true, max: 80 }).email('email', { nullable: true }).password('password', { nullable: true }).done();
  const phones = body.phones ? parsePhones(body.phones) : [];
  await emailTaken(env, d.email);
  await checkPhones(env, 0, phones);
  const res = await run(env, `INSERT INTO sf_users (name, email, password_hash) VALUES (?, ?, ?)`, d.name, d.email ?? null, d.password ? await hashPassword(d.password) : null);
  const uid = res.meta.last_row_id;
  if (phones.length) await addPhones(env, uid, phones);
  return json(await publicUser(env, await first(env, `SELECT * FROM sf_users WHERE id = ?`, uid)), 201);
}

/** PATCH /users/:id { name?, email?, password?, is_active?, phones? (replaces the list) } */
export async function patch({ env, request, params, actor }) {
  const uid = id(params.id);
  const user = await first(env, `SELECT * FROM sf_users WHERE id = ?`, uid);
  if (!user) throw notFound('משתמש לא נמצא');
  const body = await readJson(request);
  const d = fields(body, { partial: true }).str('name', { required: true, max: 80 }).email('email', { nullable: true }).password('password').bool('is_active').done();
  if (d.is_active === false && uid === actor.id) throw badRequest('אי אפשר לחסום את עצמך');
  if (d.email !== undefined) await emailTaken(env, d.email, uid);
  const phones = body.phones !== undefined ? parsePhones(body.phones) : null;
  if (phones) await checkPhones(env, uid, phones);
  if (d.password) d.password_hash = await hashPassword(d.password);
  const set = setClause(d, ['name', 'email', 'password_hash', 'is_active']);
  if (set.keys.length) await run(env, `UPDATE sf_users SET ${set.sql} WHERE id = ?`, ...set.params, uid);
  if (phones) {
    await run(env, `DELETE FROM sf_user_phones WHERE user_id = ?`, uid);
    if (phones.length) await addPhones(env, uid, phones);
  }
  if (d.password || d.is_active === false) await revokeSessions(env, uid, uid === actor.id ? actor.session_id : 0);
  return json(await publicUser(env, await first(env, `SELECT * FROM sf_users WHERE id = ?`, uid)));
}

export async function remove({ env, params, actor }) {
  const uid = id(params.id);
  if (uid === actor.id) throw badRequest('אי אפשר למחוק את עצמך');
  const res = await run(env, `DELETE FROM sf_users WHERE id = ?`, uid);
  if (!res.meta.changes) throw notFound('משתמש לא נמצא');
  return noContent();
}
