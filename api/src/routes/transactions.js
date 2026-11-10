// Income/expense entries, confirming recurring items, and the dashboard/forecast/summary reports.
import { all, first, nowIso, run, setClause } from '../db.js';
import { badRequest, json, noContent, notFound, readJson } from '../http.js';
import { addDays, chargeDate, monthRange, occurrences, shiftMonth } from '../dates.js';
import { movesBetween } from './moves.js';
import { report, trackingStart } from '../money.js';
import { computeTasks } from '../tasks.js';
import { balances, heldFunds, checkCategory, forecast, insertTransaction, pendingRecurring, resolvePayment, summary, syncRecurring, todayFor } from '../money.js';
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
  // corrections, transfers and held money (not income/expenses), unless the list is filtered
  const filtered = ['kind', 'category_id', 'card_id', 'owner_id', 'q'].some((k) => p.get(k));
  let moves = filtered ? [] : await movesBetween(env, from, to);
  if (p.get('account_id')) moves = moves.filter((m) => m.account_id === Number(p.get('account_id')));
  return json({ from, to, items: rows, moves });
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
  const t = await first(
    env,
    `SELECT t.recurring_id, t.occurrence, r.auto FROM sf_transactions t LEFT JOIN sf_recurring r ON r.id = t.recurring_id WHERE t.id = ?`,
    tid
  );
  if (!t) throw notFound('התנועה לא נמצאה');
  const stmts = [env.DB.prepare(`DELETE FROM sf_transactions WHERE id = ?`).bind(tid)];
  // A deleted automatic entry did not happen: remember that, so it is not recorded again by itself.
  // A confirmed one (e.g. a salary) just goes back to "waiting for confirmation".
  if (t.recurring_id && t.auto) {
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

/**
 * GET /recurring/:id/occurrences: the last and the coming occurrences of a recurring item, each with
 * its amount (usual or changed for that time), and whether it was already recorded or skipped.
 */
export async function occurrencesOf({ env, params }) {
  const rid = id(params.id);
  const r = await first(env, `SELECT * FROM sf_recurring WHERE id = ?`, rid);
  if (!r) throw notFound('לא נמצא');
  const today = todayFor(env);
  const from = addDays(today, -45);
  const dates = occurrences(r, from, addDays(today, 400)).slice(0, 6);
  const tx = await all(env, `SELECT id, occurrence, amount, note FROM sf_transactions WHERE recurring_id = ? AND occurrence >= ?`, rid, from);
  const ov = await all(env, `SELECT occurrence, amount, note FROM sf_recurring_overrides WHERE recurring_id = ? AND occurrence >= ?`, rid, from);
  const sk = await all(env, `SELECT occurrence FROM sf_recurring_skips WHERE recurring_id = ? AND occurrence >= ?`, rid, from);
  return json(dates.map((d) => {
    const t = tx.find((x) => x.occurrence === d);
    const o = ov.find((x) => x.occurrence === d);
    return {
      occurrence: d, past: d <= today, usual_amount: r.amount,
      amount: t ? t.amount : o ? o.amount : r.amount, changed: t ? t.amount !== r.amount : Boolean(o),
      note: t ? t.note : o?.note || '', transaction_id: t?.id ?? null, skipped: sk.some((x) => x.occurrence === d),
    };
  }));
}

/**
 * PUT /recurring/:id/occurrences/:occurrence { amount, note? }: a different amount this time (a credit, a
 * partial month). Already recorded: the entry itself is updated; still coming: it is recorded (and shown
 * in the forecast) with this amount.
 */
export async function setOccurrence({ env, request, params }) {
  const rid = id(params.id);
  if (!isDate(params.occurrence)) throw badRequest('תאריך לא תקין');
  const r = await first(env, `SELECT * FROM sf_recurring WHERE id = ?`, rid);
  if (!r) throw notFound('לא נמצא');
  const d = fields(await readJson(request)).money('amount', { required: true }).str('note', { max: 200 }).done();
  const t = await first(env, `SELECT id FROM sf_transactions WHERE recurring_id = ? AND occurrence = ?`, rid, params.occurrence);
  if (t) {
    await run(env, `UPDATE sf_transactions SET amount = ?, note = CASE WHEN ? != '' THEN ? ELSE note END, updated_at = ? WHERE id = ?`, d.amount, d.note, d.note, nowIso(), t.id);
  } else {
    await run(
      env,
      `INSERT INTO sf_recurring_overrides (recurring_id, occurrence, amount, note) VALUES (?, ?, ?, ?)
       ON CONFLICT(recurring_id, occurrence) DO UPDATE SET amount = excluded.amount, note = excluded.note`,
      rid, params.occurrence, d.amount, d.note
    );
  }
  return json({ recorded: Boolean(t) });
}

/** DELETE /recurring/:id/occurrences/:occurrence: back to the usual amount (only for one still coming). */
export async function resetOccurrence({ env, params }) {
  const rid = id(params.id);
  if (!isDate(params.occurrence)) throw badRequest('תאריך לא תקין');
  await run(env, `DELETE FROM sf_recurring_overrides WHERE recurring_id = ? AND occurrence = ?`, rid, params.occurrence);
  return noContent();
}

/** DELETE /recurring/:id/skip/:occurrence: undo "did not happen this time" (it waits again / is recorded again). */
export async function unskip({ env, params }) {
  const rid = id(params.id);
  if (!isDate(params.occurrence)) throw badRequest('תאריך לא תקין');
  await run(env, `DELETE FROM sf_recurring_skips WHERE recurring_id = ? AND occurrence = ?`, rid, params.occurrence);
  return noContent();
}

/** GET /recurring/skips: occurrences marked "did not happen" in the last months (to undo by mistake). */
export async function listSkips({ env }) {
  return json(await all(
    env,
    `SELECT s.recurring_id, s.occurrence, r.name, r.kind, r.amount FROM sf_recurring_skips s JOIN sf_recurring r ON r.id = s.recurring_id
     WHERE s.occurrence >= ? ORDER BY s.occurrence DESC`,
    addDays(todayFor(env), -120)
  ));
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
  const start = await trackingStart(env);
  const [now, before, accounts, pending, fc, recent, held, since] = await Promise.all([
    summary(env, month.from, month.to),
    summary(env, prev.from, prev.to),
    balances(env, today),
    pendingRecurring(env, today),
    forecast(env, addDays(today, 30), today),
    all(env, `${SELECT_TX} ORDER BY t.created_at DESC, t.id DESC LIMIT 8`),
    heldFunds(env),
    report(env, start, today),
  ]);
  const tasks = await computeTasks(env, { today, fc, held, pending });
  return json({ today, month: now, previous_month: before, accounts, pending, forecast: fc, recent, held, tasks, since: { ...since, tracking_start: start } });
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

/** GET /report?from&to (default: from the day tracking started until today) */
export async function getReport({ env, url }) {
  await syncRecurring(env);
  const start = await trackingStart(env);
  const today = todayFor(env);
  const from = url.searchParams.get('from') || start;
  const to = url.searchParams.get('to') || today;
  if (!isDate(from) || !isDate(to) || from > to) throw badRequest('טווח תאריכים לא תקין');
  return json({ ...(await report(env, from, to)), tracking_start: start, today });
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
