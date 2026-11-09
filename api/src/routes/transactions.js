// Income/expense entries, confirming recurring items, and the dashboard/forecast/summary reports.
import { all, first, nowIso, run, setClause } from '../db.js';
import { badRequest, json, noContent, notFound, readJson } from '../http.js';
import { addDays, chargeDate, monthRange, shiftMonth } from '../dates.js';
import { balances, checkCategory, forecast, insertTransaction, pendingRecurring, resolvePayment, summary, syncRecurring, todayFor } from '../money.js';
import { fields, id, isDate } from '../validate.js';

const txFields = (body, partial) =>
  fields(body, { partial })
    .oneOf('kind', ['expense', 'income'], { required: true })
    .money('amount', { required: true })
    .date('date', { required: true })
    .date('charge_date', { nullable: true })
    .int('category_id', { nullable: true, min: 1 })
    .int('account_id', { nullable: true, min: 1 })
    .int('card_id', { nullable: true, min: 1 })
    .int('owner_id', { nullable: true, min: 1 })
    .str('note', { max: 300 })
    .done();

const SELECT_TX = `SELECT t.*, c.name AS category_name, u.name AS user_name FROM sf_transactions t
  LEFT JOIN sf_categories c ON c.id = t.category_id LEFT JOIN sf_users u ON u.id = t.user_id`;

function monthParam(url, env) {
  const m = url.searchParams.get('month');
  if (m && !/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw badRequest('חודש לא תקין (YYYY-MM)');
  return m || todayFor(env).slice(0, 7);
}

/** GET /transactions?month=YYYY-MM | from&to [&kind&category_id&account_id&card_id&owner_id&q] */
export async function list({ env, url }) {
  await syncRecurring(env);
  const p = url.searchParams;
  let { from, to } = monthRange(monthParam(url, env));
  if (p.get('from') || p.get('to')) {
    if (!isDate(p.get('from')) || !isDate(p.get('to'))) throw badRequest('טווח תאריכים לא תקין');
    ({ from, to } = { from: p.get('from'), to: p.get('to') });
  }
  const where = ['t.date BETWEEN ? AND ?'];
  const args = [from, to];
  if (p.get('kind')) { where.push('t.kind = ?'); args.push(p.get('kind')); }
  for (const k of ['category_id', 'account_id', 'card_id', 'owner_id']) {
    if (p.get(k)) { where.push(`t.${k} = ?`); args.push(id(p.get(k))); }
  }
  if (p.get('q')) { where.push('t.note LIKE ?'); args.push(`%${p.get('q').slice(0, 50)}%`); }
  const rows = await all(env, `${SELECT_TX} WHERE ${where.join(' AND ')} ORDER BY t.date DESC, t.id DESC LIMIT 2000`, ...args);
  return json({ from, to, items: rows });
}

export async function create({ env, request, actor }) {
  const d = txFields(await readJson(request), false);
  const newId = await insertTransaction(env, d, { userId: actor.id, source: 'web' });
  return json(await first(env, `${SELECT_TX} WHERE t.id = ?`, newId), 201);
}

export async function patch({ env, request, params }) {
  const tid = id(params.id);
  const current = await first(env, `SELECT * FROM sf_transactions WHERE id = ?`, tid);
  if (!current) throw notFound('התנועה לא נמצאה');
  const body = await readJson(request);
  const d = txFields(body, true);
  const m = { ...current, ...d };
  // payment changed (or date changed without an explicit charge date): recompute the account and charge date
  if (d.card_id !== undefined || d.account_id !== undefined || d.date !== undefined) {
    const pay = await resolvePayment(env, { card_id: m.card_id, account_id: m.card_id ? null : m.account_id });
    d.card_id = pay.card_id;
    d.account_id = pay.account_id;
    if (d.charge_date === undefined) d.charge_date = chargeDate(m.date, pay.card);
  }
  if (d.charge_date === null) d.charge_date = m.date;
  if (d.category_id !== undefined || d.kind !== undefined) await checkCategory(env, m.category_id, m.kind);
  d.updated_at = nowIso();
  const set = setClause(d, ['kind', 'amount', 'date', 'charge_date', 'category_id', 'account_id', 'card_id', 'owner_id', 'note', 'updated_at']);
  await run(env, `UPDATE sf_transactions SET ${set.sql} WHERE id = ?`, ...set.params, tid);
  return json(await first(env, `${SELECT_TX} WHERE t.id = ?`, tid));
}

export async function remove({ env, params }) {
  const tid = id(params.id);
  const t = await first(env, `SELECT recurring_id, occurrence FROM sf_transactions WHERE id = ?`, tid);
  if (!t) throw notFound('התנועה לא נמצאה');
  const stmts = [env.DB.prepare(`DELETE FROM sf_transactions WHERE id = ?`).bind(tid)];
  // a deleted recurring entry did not happen: remember that, so it is not recorded again
  if (t.recurring_id) {
    stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO sf_recurring_skips (recurring_id, occurrence) VALUES (?, ?)`).bind(t.recurring_id, t.occurrence));
  }
  await env.DB.batch(stmts);
  return noContent();
}

// ------------------------------------------------------------------ recurring confirmations
/** POST /recurring/:id/confirm { occurrence, amount?, date? }: "the salary came in" (with the real amount). */
export async function confirm({ env, request, params, actor }) {
  const rid = id(params.id);
  const r = await first(env, `SELECT * FROM sf_recurring WHERE id = ?`, rid);
  if (!r) throw notFound('לא נמצא');
  const d = fields(await readJson(request)).date('occurrence', { required: true }).money('amount').date('date').str('note', { max: 300 }).done();
  if (await first(env, `SELECT id FROM sf_transactions WHERE recurring_id = ? AND occurrence = ?`, rid, d.occurrence)) {
    throw badRequest('כבר נרשם');
  }
  await run(env, `DELETE FROM sf_recurring_skips WHERE recurring_id = ? AND occurrence = ?`, rid, d.occurrence);
  const newId = await insertTransaction(
    env,
    {
      kind: r.kind, amount: d.amount ?? r.amount, date: d.date || d.occurrence, category_id: r.category_id,
      card_id: r.card_id, account_id: r.account_id, owner_id: r.owner_id, recurring_id: rid, occurrence: d.occurrence,
      note: d.note || r.name,
    },
    { userId: actor.id, source: 'web' }
  );
  return json(await first(env, `${SELECT_TX} WHERE t.id = ?`, newId), 201);
}

/** POST /recurring/:id/skip { occurrence }: this time it did not happen. */
export async function skip({ env, request, params }) {
  const rid = id(params.id);
  const d = fields(await readJson(request)).date('occurrence', { required: true }).done();
  if (!(await first(env, `SELECT id FROM sf_recurring WHERE id = ?`, rid))) throw notFound('לא נמצא');
  await run(env, `INSERT OR IGNORE INTO sf_recurring_skips (recurring_id, occurrence) VALUES (?, ?)`, rid, d.occurrence);
  return noContent();
}

// ------------------------------------------------------------------ reports
/** GET /dashboard: this month in numbers, account balances, what waits for confirmation, the coming two weeks. */
export async function dashboard({ env }) {
  await syncRecurring(env);
  const today = todayFor(env);
  const month = monthRange(today.slice(0, 7));
  const [y, m] = today.split('-').map(Number);
  const [py, pm] = shiftMonth(y, m, -1);
  const prev = monthRange(`${py}-${String(pm).padStart(2, '0')}`);
  const [now, before, accounts, pending, fc, recent] = await Promise.all([
    summary(env, month.from, month.to),
    summary(env, prev.from, prev.to),
    balances(env, today),
    pendingRecurring(env, today),
    forecast(env, addDays(today, 30), today),
    all(env, `${SELECT_TX} ORDER BY t.created_at DESC, t.id DESC LIMIT 8`),
  ]);
  return json({ today, month: now, previous_month: before, accounts, pending, forecast: fc, recent });
}

/** GET /forecast?days=60 (or to=YYYY-MM-DD) */
export async function getForecast({ env, url }) {
  await syncRecurring(env);
  const today = todayFor(env);
  const to = url.searchParams.get('to');
  const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 60, 1), 400);
  if (to && !isDate(to)) throw badRequest('תאריך לא תקין');
  return json({ ...(await forecast(env, to || addDays(today, days), today)), pending: await pendingRecurring(env, today) });
}

/** GET /summary?month=YYYY-MM */
export async function getSummary({ env, url }) {
  await syncRecurring(env);
  const { from, to } = monthRange(monthParam(url, env));
  return json(await summary(env, from, to));
}

/** GET /lookups: everything the forms need in one call. */
export async function lookups({ env }) {
  const [users, accounts, cards, categories] = await Promise.all([
    all(env, `SELECT id, name, is_active FROM sf_users ORDER BY id`),
    all(env, `SELECT * FROM sf_accounts ORDER BY is_active DESC, sort, id`),
    all(env, `SELECT * FROM sf_cards ORDER BY is_active DESC, sort, id`),
    all(env, `SELECT * FROM sf_categories ORDER BY kind, is_active DESC, sort, id`),
  ]);
  return json({ today: todayFor(env), users, accounts, cards, categories });
}
