// Money movements that are not income/expense: "I have X now" corrections, transfers between accounts
// (e.g. a cash withdrawal into the wallet), and money held for others.
import { all, first, run } from '../db.js';
import { badRequest, invalid, json, noContent, notFound, readJson } from '../http.js';
import { balances, heldFunds, todayFor } from '../money.js';
import { fields, id, toAgorot } from '../validate.js';

const insertMove = (env, m) =>
  env.DB.prepare(
    `INSERT INTO sf_account_moves (kind, account_id, date, amount, held_id, held_amount, pair_id, note, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(m.kind, m.account_id ?? null, m.date, m.amount, m.held_id ?? null, m.held_amount ?? 0, m.pair_id ?? null, m.note ?? '', m.user_id ?? null);

async function requireAccount(env, accountId, field = 'account_id') {
  const a = await first(env, `SELECT * FROM sf_accounts WHERE id = ?`, accountId);
  if (!a) throw invalid({ [field]: 'חשבון לא קיים' });
  return a;
}

/** Signed shekels ("-1200.50" allowed: an overdraft) -> agorot. */
function signedMoney(body, key) {
  const a = toAgorot(body[key]);
  if (a === null || Math.abs(a) > 100_000_000_00) throw invalid({ [key]: 'סכום לא תקין' });
  return a;
}

/**
 * POST /accounts/:id/balance { balance, date? }: "this is how much there is now". Records the difference
 * from the computed balance as a correction, so the balance shown matches the real one from that day on.
 */
export async function setBalance({ env, request, params, actor }) {
  const aid = id(params.id);
  const acc = await requireAccount(env, aid);
  const body = await readJson(request);
  const d = fields(body).date('date').str('note', { max: 200 }).done();
  const target = signedMoney(body, 'balance');
  const date = d.date || todayFor(env);
  if (date < acc.opening_date) throw invalid({ date: 'לפני תאריך פתיחת החשבון' });
  const current = (await balances(env, date)).find((a) => a.id === aid).balance;
  const diff = target - current;
  if (diff !== 0) {
    await insertMove(env, { kind: 'adjust', account_id: aid, date, amount: diff, note: d.note || 'עדכון יתרה', user_id: actor.id }).run();
  }
  return json({ account_id: aid, previous: current, balance: target, difference: diff });
}

/** POST /transfers { from_account_id, to_account_id, amount, date?, note? } (e.g. cash withdrawal) */
export async function transfer({ env, request, actor }) {
  const d = fields(await readJson(request))
    .int('from_account_id', { required: true, min: 1 })
    .int('to_account_id', { required: true, min: 1 })
    .money('amount', { required: true })
    .date('date')
    .str('note', { max: 200 })
    .done();
  if (d.from_account_id === d.to_account_id) throw invalid({ to_account_id: 'אותו חשבון' });
  if (!d.amount) throw invalid({ amount: 'סכום חסר' });
  const from = await requireAccount(env, d.from_account_id, 'from_account_id');
  const to = await requireAccount(env, d.to_account_id, 'to_account_id');
  const date = d.date || todayFor(env);
  const note = d.note || (to.kind === 'cash' ? 'משיכת מזומן' : from.kind === 'cash' ? 'הפקדת מזומן' : `העברה מ${from.name} ל${to.name}`);
  const a = await insertMove(env, { kind: 'transfer', account_id: from.id, date, amount: -d.amount, note, user_id: actor.id }).run();
  const outId = a.meta.last_row_id;
  const b = await insertMove(env, { kind: 'transfer', account_id: to.id, date, amount: d.amount, pair_id: outId, note, user_id: actor.id }).run();
  await run(env, `UPDATE sf_account_moves SET pair_id = ? WHERE id = ?`, b.meta.last_row_id, outId);
  return json({ ok: true }, 201);
}

/** DELETE /moves/:id (a transfer goes with its other half) */
export async function removeMove({ env, params }) {
  const mid = id(params.id);
  const m = await first(env, `SELECT * FROM sf_account_moves WHERE id = ?`, mid);
  if (!m) throw notFound();
  await run(env, `DELETE FROM sf_account_moves WHERE id = ? OR (pair_id IS NOT NULL AND id = ?)`, mid, m.pair_id ?? 0);
  return noContent();
}

/** Moves between from..to (shown in the month list next to the income/expenses). */
export const movesBetween = (env, from, to) =>
  all(
    env,
    `SELECT m.*, a.name AS account_name, f.name AS held_name FROM sf_account_moves m
     LEFT JOIN sf_accounts a ON a.id = m.account_id LEFT JOIN sf_held_funds f ON f.id = m.held_id
     WHERE m.date BETWEEN ? AND ? ORDER BY m.date DESC, m.id DESC`,
    from, to
  );

// ------------------------------------------------------------------ money held for others
export async function listHeld({ env }) {
  const { funds, total } = await heldFunds(env);
  const moves = await all(
    env,
    `SELECT m.*, a.name AS account_name FROM sf_account_moves m LEFT JOIN sf_accounts a ON a.id = m.account_id
     WHERE m.held_id IS NOT NULL ORDER BY m.date DESC, m.id DESC`
  );
  for (const f of funds) f.moves = moves.filter((m) => m.held_id === f.id);
  return json({ funds, total });
}

/**
 * POST /held { name, note?, amount, account_id?, in_balance, date? }
 * in_balance = the money is already part of the balance I entered (nothing changes in the account);
 * otherwise it comes in now, into account_id.
 */
export async function createHeld({ env, request, actor }) {
  const body = await readJson(request);
  const d = fields(body)
    .str('name', { required: true, max: 80 })
    .str('note', { max: 300 })
    .money('amount', { required: true })
    .int('account_id', { nullable: true, min: 1 })
    .bool('in_balance', { default: true })
    .date('date')
    .done();
  if (!d.in_balance && !d.account_id) throw invalid({ account_id: 'לאיזה חשבון נכנס הכסף?' });
  if (d.account_id) await requireAccount(env, d.account_id);
  const res = await run(env, `INSERT INTO sf_held_funds (name, note) VALUES (?, ?)`, d.name, d.note);
  const fid = res.meta.last_row_id;
  if (d.amount) {
    await insertMove(env, {
      kind: 'held', account_id: d.in_balance ? null : d.account_id, date: d.date || todayFor(env), amount: d.in_balance ? 0 : d.amount,
      held_id: fid, held_amount: d.amount, note: d.in_balance ? `יתרת פתיחה: כסף של ${d.name}` : `התקבל מ${d.name}`, user_id: actor.id,
    }).run();
  }
  return json({ id: fid }, 201);
}

export async function patchHeld({ env, request, params }) {
  const fid = id(params.id);
  const d = fields(await readJson(request), { partial: true }).str('name', { required: true, max: 80 }).str('note', { max: 300 }).bool('is_active').done();
  const sets = Object.keys(d);
  if (sets.length) {
    await run(env, `UPDATE sf_held_funds SET ${sets.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...sets.map((k) => (typeof d[k] === 'boolean' ? (d[k] ? 1 : 0) : d[k])), fid);
  }
  const row = await first(env, `SELECT * FROM sf_held_funds WHERE id = ?`, fid);
  if (!row) throw notFound();
  return json(row);
}

export async function deleteHeld({ env, params }) {
  const res = await run(env, `DELETE FROM sf_held_funds WHERE id = ?`, id(params.id)); // its moves go too (cascade)
  if (!res.meta.changes) throw notFound();
  return noContent();
}

/**
 * POST /held/:id/moves { direction: 'in' | 'out', amount, account_id?, date?, note? }
 * in = more money of theirs came in; out = returned to them. account_id: where it came in / went out
 * (empty = no account changes, e.g. it was handed over in another way).
 */
export async function addHeldMove({ env, request, params, actor }) {
  const fid = id(params.id);
  const fund = await first(env, `SELECT * FROM sf_held_funds WHERE id = ?`, fid);
  if (!fund) throw notFound();
  const d = fields(await readJson(request))
    .oneOf('direction', ['in', 'out'], { required: true })
    .money('amount', { required: true })
    .int('account_id', { nullable: true, min: 1 })
    .date('date')
    .str('note', { max: 200 })
    .done();
  if (!d.amount) throw invalid({ amount: 'סכום חסר' });
  if (d.account_id) await requireAccount(env, d.account_id);
  const sign = d.direction === 'in' ? 1 : -1;
  if (d.direction === 'out') {
    const { funds } = await heldFunds(env);
    const held = funds.find((f) => f.id === fid).balance;
    if (d.amount > held) throw badRequest(`אצלך רק ${held / 100} ש"ח של ${fund.name}`);
  }
  await insertMove(env, {
    kind: 'held', account_id: d.account_id ?? null, date: d.date || todayFor(env), amount: d.account_id ? sign * d.amount : 0,
    held_id: fid, held_amount: sign * d.amount, note: d.note || (d.direction === 'in' ? `התקבל מ${fund.name}` : `הוחזר ל${fund.name}`), user_id: actor.id,
  }).run();
  return json({ ok: true }, 201);
}
