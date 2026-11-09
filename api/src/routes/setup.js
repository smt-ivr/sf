// Settings data: bank accounts, credit cards, categories, recurring income/expenses, and app settings.
import { randomToken } from '../auth.js';
import { all, first, run, setClause } from '../db.js';
import { badRequest, conflict, invalid, json, noContent, notFound, readJson } from '../http.js';
import { checkCategory, resolvePayment, todayFor } from '../money.js';
import { getSettings, setSetting } from '../settings.js';
import { fields, id } from '../validate.js';

async function checkOwner(env, owner_id) {
  if (owner_id && !(await first(env, `SELECT id FROM sf_users WHERE id = ?`, owner_id))) throw invalid({ owner_id: 'משתמש לא קיים' });
}

/** Deletes a row, or (when it is referenced) refuses and suggests hiding it instead. */
async function removeOrRefuse(env, table, rowId, refs) {
  for (const [sql, what] of refs) {
    if (await first(env, sql, rowId)) throw conflict(`אי אפשר למחוק: יש ${what} שמשתמשים בזה. אפשר להסתיר במקום (לא פעיל)`, 'IN_USE');
  }
  const res = await run(env, `DELETE FROM ${table} WHERE id = ?`, rowId);
  if (!res.meta.changes) throw notFound();
  return noContent();
}

// ------------------------------------------------------------------ accounts
const accountFields = (body, partial) =>
  fields(body, { partial })
    .str('name', { required: true, max: 80 })
    .str('bank', { max: 60 })
    .str('branch', { max: 20 })
    .str('number', { max: 30 })
    .int('owner_id', { nullable: true, min: 1 })
    .date('opening_date')
    .bool('is_active')
    .int('sort', { min: 0, max: 9999 })
    .done();

// opening balance may be negative (overdraft): accept a signed value
function openingBalance(body) {
  const v = body.opening_balance;
  if (v === undefined) return undefined;
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || Math.abs(n) > 1e9) throw invalid({ opening_balance: 'סכום לא תקין' });
  return Math.round(n * 100);
}

export async function listAccounts({ env }) {
  return json(await all(env, `SELECT * FROM sf_accounts ORDER BY is_active DESC, sort, id`));
}

export async function createAccount({ env, request }) {
  const body = await readJson(request);
  const d = accountFields(body, false);
  await checkOwner(env, d.owner_id);
  const res = await run(
    env,
    `INSERT INTO sf_accounts (name, bank, branch, number, owner_id, opening_balance, opening_date, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    d.name, d.bank, d.branch, d.number, d.owner_id ?? null, openingBalance(body) ?? 0, d.opening_date || todayFor(env), d.sort ?? 0
  );
  return json(await first(env, `SELECT * FROM sf_accounts WHERE id = ?`, res.meta.last_row_id), 201);
}

export async function patchAccount({ env, request, params }) {
  const aid = id(params.id);
  const body = await readJson(request);
  const d = accountFields(body, true);
  await checkOwner(env, d.owner_id);
  d.opening_balance = openingBalance(body);
  const set = setClause(d, ['name', 'bank', 'branch', 'number', 'owner_id', 'opening_balance', 'opening_date', 'is_active', 'sort']);
  if (set.keys.length) await run(env, `UPDATE sf_accounts SET ${set.sql} WHERE id = ?`, ...set.params, aid);
  const row = await first(env, `SELECT * FROM sf_accounts WHERE id = ?`, aid);
  if (!row) throw notFound('חשבון לא נמצא');
  return json(row);
}

export const deleteAccount = ({ env, params }) =>
  removeOrRefuse(env, 'sf_accounts', id(params.id), [
    [`SELECT 1 FROM sf_cards WHERE account_id = ?`, 'כרטיסים'],
    [`SELECT 1 FROM sf_transactions WHERE account_id = ?`, 'תנועות'],
  ]);

// ------------------------------------------------------------------ cards
const cardFields = (body, partial) =>
  fields(body, { partial })
    .str('name', { required: true, max: 80 })
    .str('last4', { max: 4 })
    .oneOf('kind', ['direct', 'regular'], { required: true })
    .int('account_id', { required: true, min: 1 })
    .int('billing_day', { nullable: true, min: 1, max: 31 })
    .int('owner_id', { nullable: true, min: 1 })
    .bool('is_active')
    .int('sort', { min: 0, max: 9999 })
    .done();

async function checkCard(env, d, current = {}) {
  const merged = { ...current, ...d };
  if (d.account_id && !(await first(env, `SELECT id FROM sf_accounts WHERE id = ?`, d.account_id))) throw invalid({ account_id: 'חשבון לא קיים' });
  if (merged.kind === 'regular' && !merged.billing_day) throw invalid({ billing_day: 'בכרטיס רגיל צריך יום חיוב' });
  if (d.last4 && !/^\d{4}$/.test(d.last4)) throw invalid({ last4: '4 ספרות' });
  await checkOwner(env, d.owner_id);
}

export async function listCards({ env }) {
  return json(await all(env, `SELECT * FROM sf_cards ORDER BY is_active DESC, sort, id`));
}

export async function createCard({ env, request }) {
  const d = cardFields(await readJson(request), false);
  await checkCard(env, d);
  const res = await run(
    env,
    `INSERT INTO sf_cards (name, last4, kind, account_id, billing_day, owner_id, sort) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    d.name, d.last4, d.kind, d.account_id, d.kind === 'regular' ? d.billing_day : null, d.owner_id ?? null, d.sort ?? 0
  );
  return json(await first(env, `SELECT * FROM sf_cards WHERE id = ?`, res.meta.last_row_id), 201);
}

export async function patchCard({ env, request, params }) {
  const cid = id(params.id);
  const current = await first(env, `SELECT * FROM sf_cards WHERE id = ?`, cid);
  if (!current) throw notFound('כרטיס לא נמצא');
  const d = cardFields(await readJson(request), true);
  await checkCard(env, d, current);
  if ((d.kind ?? current.kind) === 'direct') d.billing_day = null;
  const set = setClause(d, ['name', 'last4', 'kind', 'account_id', 'billing_day', 'owner_id', 'is_active', 'sort']);
  if (set.keys.length) await run(env, `UPDATE sf_cards SET ${set.sql} WHERE id = ?`, ...set.params, cid);
  return json(await first(env, `SELECT * FROM sf_cards WHERE id = ?`, cid));
}

export const deleteCard = ({ env, params }) =>
  removeOrRefuse(env, 'sf_cards', id(params.id), [
    [`SELECT 1 FROM sf_transactions WHERE card_id = ?`, 'תנועות'],
    [`SELECT 1 FROM sf_recurring WHERE card_id = ?`, 'תנועות קבועות'],
  ]);

// ------------------------------------------------------------------ categories
const categoryFields = (body, partial) =>
  fields(body, { partial })
    .str('name', { required: true, max: 60 })
    .oneOf('kind', ['expense', 'income'], { required: true })
    .bool('is_active')
    .int('sort', { min: 0, max: 9999 })
    .done();

export async function listCategories({ env }) {
  return json(await all(env, `SELECT * FROM sf_categories ORDER BY kind, is_active DESC, sort, id`));
}

export async function createCategory({ env, request }) {
  const d = categoryFields(await readJson(request), false);
  const sort = d.sort ?? ((await first(env, `SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM sf_categories WHERE kind = ?`, d.kind)).n);
  const res = await run(env, `INSERT INTO sf_categories (name, kind, sort) VALUES (?, ?, ?)`, d.name, d.kind, sort);
  return json(await first(env, `SELECT * FROM sf_categories WHERE id = ?`, res.meta.last_row_id), 201);
}

export async function patchCategory({ env, request, params }) {
  const cid = id(params.id);
  const d = categoryFields(await readJson(request), true);
  if (d.kind && (await first(env, `SELECT 1 FROM sf_transactions WHERE category_id = ? AND kind != ?`, cid, d.kind))) {
    throw badRequest('יש תנועות בקטגוריה הזו, אי אפשר להפוך אותה מהוצאה להכנסה (או להפך)');
  }
  const set = setClause(d, ['name', 'kind', 'is_active', 'sort']);
  if (set.keys.length) await run(env, `UPDATE sf_categories SET ${set.sql} WHERE id = ?`, ...set.params, cid);
  const row = await first(env, `SELECT * FROM sf_categories WHERE id = ?`, cid);
  if (!row) throw notFound('קטגוריה לא נמצאה');
  return json(row);
}

export const deleteCategory = ({ env, params }) =>
  removeOrRefuse(env, 'sf_categories', id(params.id), [
    [`SELECT 1 FROM sf_transactions WHERE category_id = ?`, 'תנועות'],
    [`SELECT 1 FROM sf_recurring WHERE category_id = ?`, 'תנועות קבועות'],
  ]);

// ------------------------------------------------------------------ recurring
const recurringFields = (body, partial) =>
  fields(body, { partial })
    .oneOf('kind', ['expense', 'income'], { required: true })
    .str('name', { required: true, max: 80 })
    .money('amount', { required: true })
    .int('category_id', { nullable: true, min: 1 })
    .int('account_id', { nullable: true, min: 1 })
    .int('card_id', { nullable: true, min: 1 })
    .int('owner_id', { nullable: true, min: 1 })
    .int('day_of_month', { required: true, min: 1, max: 31 })
    .int('interval_months', { min: 1, max: 12 })
    .date('start_date')
    .date('end_date', { nullable: true })
    .bool('auto')
    .bool('is_active')
    .str('note', { max: 300 })
    .done();

const RECURRING_COLUMNS = ['kind', 'name', 'amount', 'category_id', 'account_id', 'card_id', 'owner_id', 'day_of_month', 'interval_months', 'start_date', 'end_date', 'auto', 'is_active', 'note'];

async function checkRecurring(env, d, current = {}) {
  const m = { ...current, ...d };
  if (m.end_date && m.start_date && m.end_date < m.start_date) throw invalid({ end_date: 'תאריך הסיום לפני ההתחלה' });
  if (d.card_id !== undefined || d.account_id !== undefined) await resolvePayment(env, m);
  await checkCategory(env, m.category_id, m.kind);
  await checkOwner(env, d.owner_id);
}

export async function listRecurring({ env }) {
  return json(await all(env, `SELECT * FROM sf_recurring ORDER BY is_active DESC, kind DESC, day_of_month, id`));
}

export async function createRecurring({ env, request }) {
  const d = recurringFields(await readJson(request), false);
  d.start_date ||= todayFor(env);
  d.interval_months ??= 1;
  d.auto ??= true;
  if (d.card_id) d.account_id = null;
  await checkRecurring(env, d);
  const cols = RECURRING_COLUMNS.filter((c) => c !== 'is_active');
  const res = await run(
    env,
    `INSERT INTO sf_recurring (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    ...cols.map((c) => (typeof d[c] === 'boolean' ? (d[c] ? 1 : 0) : d[c] ?? (c === 'note' ? '' : null)))
  );
  return json(await first(env, `SELECT * FROM sf_recurring WHERE id = ?`, res.meta.last_row_id), 201);
}

export async function patchRecurring({ env, request, params }) {
  const rid = id(params.id);
  const current = await first(env, `SELECT * FROM sf_recurring WHERE id = ?`, rid);
  if (!current) throw notFound('לא נמצא');
  const d = recurringFields(await readJson(request), true);
  if (d.card_id) d.account_id = null;
  await checkRecurring(env, d, current);
  const set = setClause(d, RECURRING_COLUMNS);
  if (set.keys.length) await run(env, `UPDATE sf_recurring SET ${set.sql} WHERE id = ?`, ...set.params, rid);
  return json(await first(env, `SELECT * FROM sf_recurring WHERE id = ?`, rid));
}

export async function deleteRecurring({ env, params }) {
  const rid = id(params.id);
  // recorded entries stay (they really happened); they just lose the link
  await run(env, `UPDATE sf_transactions SET recurring_id = NULL WHERE recurring_id = ?`, rid);
  const res = await run(env, `DELETE FROM sf_recurring WHERE id = ?`, rid);
  if (!res.meta.changes) throw notFound();
  return noContent();
}

// ------------------------------------------------------------------ app settings
export async function getAppSettings({ env, url }) {
  const s = await getSettings(env);
  const base = (env.BASE_PATH || '').replace(/\/$/, '');
  return json({
    google_client_id: s.google_client_id,
    google_login_enabled: s.google_login_enabled === '1',
    ivr_enabled: s.ivr_enabled === '1',
    ivr_link: s.ivr_key ? `${url.origin}${base}/api/ivr?key=${s.ivr_key}` : null,
  });
}

export async function patchAppSettings(ctx) {
  const d = fields(await readJson(ctx.request), { partial: true })
    .str('google_client_id', { max: 200 })
    .bool('google_login_enabled')
    .bool('ivr_enabled')
    .done();
  for (const [k, v] of Object.entries(d)) await setSetting(ctx.env, k, typeof v === 'boolean' ? (v ? '1' : '0') : v);
  return getAppSettings(ctx);
}

export async function rotateIvrKey(ctx) {
  await setSetting(ctx.env, 'ivr_key', randomToken(18));
  return getAppSettings(ctx);
}
