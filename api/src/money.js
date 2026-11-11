// Core of the tracker: saving a transaction, recording recurring items, balances and the forecast.
import { all, first } from './db.js';
import { invalid } from './http.js';
import { addDays, chargeDate, occurrences, today as todayIn } from './dates.js';

export const todayFor = (env) => todayIn(env.TZ || 'Asia/Jerusalem');
const signed = (t) => (t.kind === 'income' ? t.amount : -t.amount);
// Recurring items look back at most this far (a forgotten salary from last year is not "pending" forever).
const LOOKBACK_DAYS = 120;

// ------------------------------------------------------------------ payment method
/** The cash wallet (an account of kind 'cash'); "cash" payments go there. null when there is none. */
export async function cashAccountId(env) {
  const row = await first(env, `SELECT id FROM sf_accounts WHERE kind = 'cash' ORDER BY is_active DESC, sort, id LIMIT 1`);
  return row?.id ?? null;
}

/**
 * Resolves where money comes from / goes to: a card (then its bank account), a bank account, or cash.
 * Returns { card, account_id, card_id }. Throws 422 on unknown ids.
 */
export async function resolvePayment(env, { card_id, account_id }) {
  if (card_id) {
    const card = await first(env, `SELECT * FROM sf_cards WHERE id = ?`, card_id);
    if (!card) throw invalid({ card_id: 'כרטיס לא קיים' });
    return { card, card_id: card.id, account_id: card.account_id };
  }
  if (account_id) {
    const acc = await first(env, `SELECT id FROM sf_accounts WHERE id = ?`, account_id);
    if (!acc) throw invalid({ account_id: 'חשבון לא קיים' });
    return { card: null, card_id: null, account_id };
  }
  return { card: null, card_id: null, account_id: await cashAccountId(env) }; // cash: into the wallet
}

export async function checkCategory(env, category_id, kind) {
  if (!category_id) return;
  const c = await first(env, `SELECT kind FROM sf_categories WHERE id = ?`, category_id);
  if (!c) throw invalid({ category_id: 'קטגוריה לא קיימת' });
  if (kind && c.kind !== kind) throw invalid({ category_id: kind === 'income' ? 'זו קטגוריה של הוצאות' : 'זו קטגוריה של הכנסות' });
}

/** Builds the INSERT for a transaction (charge date computed from the card unless given). */
export async function prepareTransaction(env, d, { userId = null, source = 'web' } = {}) {
  const pay = await resolvePayment(env, d);
  await checkCategory(env, d.category_id, d.kind);
  const charge = d.charge_date || chargeDate(d.date, pay.card);
  return env.DB.prepare(
    `INSERT INTO sf_transactions (kind, amount, date, charge_date, category_id, account_id, card_id, owner_id, user_id, recurring_id, occurrence, note, source, for_name, reimburse_of)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(d.kind, d.amount, d.date, charge, d.category_id ?? null, pay.account_id, pay.card_id, d.owner_id ?? null, userId,
    d.recurring_id ?? null, d.occurrence ?? null, d.note ?? '', source, d.kind === 'expense' ? d.for_name || null : null, d.reimburse_of ?? null);
}

export async function insertTransaction(env, d, opts) {
  const res = await (await prepareTransaction(env, d, opts)).run();
  return res.meta.last_row_id;
}

// ------------------------------------------------------------------ recurring
async function recurringState(env, from) {
  const items = await all(env, `SELECT * FROM sf_recurring WHERE is_active = 1`);
  const done = await all(
    env,
    `SELECT recurring_id, occurrence FROM sf_transactions WHERE recurring_id IS NOT NULL AND occurrence >= ?1
     UNION ALL SELECT recurring_id, occurrence FROM sf_recurring_skips WHERE occurrence >= ?1`,
    from
  );
  const seen = new Set(done.map((r) => `${r.recurring_id}|${r.occurrence}`));
  const cards = new Map((await all(env, `SELECT * FROM sf_cards`)).map((c) => [c.id, c]));
  const ov = await all(env, `SELECT * FROM sf_recurring_overrides WHERE occurrence >= ?`, from);
  const overrides = new Map(ov.map((o) => [`${o.recurring_id}|${o.occurrence}`, o]));
  return { items, seen, cards, overrides, cashId: await cashAccountId(env) };
}

/** The amount of one occurrence: its override (a credit, a partial month) or the usual amount. */
const amountOf = (r, occ, overrides) => overrides.get(`${r.id}|${occ}`)?.amount ?? r.amount;
const noteOf = (r, occ, overrides) => overrides.get(`${r.id}|${occ}`)?.note || r.name;

/**
 * Records automatic recurring items whose day has come (no cron: called whenever the app or the
 * phone line reads data). Idempotent: UNIQUE(recurring_id, occurrence) plus INSERT OR IGNORE.
 */
export async function syncRecurring(env, today = todayFor(env)) {
  const from = addDays(today, -LOOKBACK_DAYS);
  const { items, seen, cards, overrides, cashId } = await recurringState(env, from);
  const stmts = [];
  for (const r of items.filter((r) => r.auto)) {
    for (const occ of occurrences(r, from, today)) {
      if (seen.has(`${r.id}|${occ}`)) continue;
      const card = r.card_id ? cards.get(r.card_id) : null;
      stmts.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO sf_transactions (kind, amount, date, charge_date, category_id, account_id, card_id, owner_id, recurring_id, occurrence, note, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recurring')`
        ).bind(r.kind, amountOf(r, occ, overrides), occ, chargeDate(occ, card), r.category_id, card ? card.account_id : r.account_id ?? cashId, card ? card.id : null,
          r.owner_id, r.id, occ, noteOf(r, occ, overrides))
      );
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  return stmts.length;
}

/** Occurrences (recorded or not) of the recurring items between from..to, minus recorded and skipped. */
async function openOccurrences(env, from, to, today) {
  const { items, seen, cards, overrides, cashId } = await recurringState(env, addDays(today, -LOOKBACK_DAYS));
  const out = [];
  for (const r of items) {
    const card = r.card_id ? cards.get(r.card_id) : null;
    for (const occ of occurrences(r, from, to)) {
      if (seen.has(`${r.id}|${occ}`)) continue;
      out.push({
        recurring_id: r.id, name: r.name, kind: r.kind, amount: amountOf(r, occ, overrides), usual_amount: r.amount,
        changed: overrides.has(`${r.id}|${occ}`), occurrence: occ,
        charge_date: chargeDate(occ, card), account_id: card ? card.account_id : r.account_id ?? cashId, card_id: card ? card.id : null,
        category_id: r.category_id, owner_id: r.owner_id, auto: r.auto === 1,
      });
    }
  }
  return out;
}

/** Non-automatic items whose day has passed and wait for a confirmation (e.g. "did the salary come in?"). */
export async function pendingRecurring(env, today = todayFor(env)) {
  const list = await openOccurrences(env, addDays(today, -LOOKBACK_DAYS), today, today);
  return list.filter((o) => !o.auto).sort((a, b) => a.occurrence.localeCompare(b.occurrence));
}

// ------------------------------------------------------------------ balances
/**
 * Balance of every account on `asOf`: the balance in the bank on the opening date (before that day's
 * charges) + every income/expense/transfer that hits the account from that date until `asOf`.
 * Anything dated earlier is already inside the opening balance. A transfer dated tomorrow (when it will
 * show in the bank) counts from tomorrow; until then it is in the forecast. "I have X now" corrections
 * fix any difference from the bank.
 */
export async function balances(env, asOf) {
  return all(
    env,
    `SELECT a.id, a.name, a.bank, a.kind, a.owner_id, a.is_active, a.opening_balance, a.opening_date,
       a.opening_balance
       + COALESCE((SELECT SUM(CASE WHEN t.kind = 'income' THEN t.amount ELSE -t.amount END) FROM sf_transactions t
           WHERE t.account_id = a.id AND t.charge_date >= a.opening_date AND t.charge_date <= ?1), 0)
       + COALESCE((SELECT SUM(m.amount) FROM sf_account_moves m
           WHERE m.account_id = a.id AND m.date >= a.opening_date AND m.date <= ?1), 0) AS balance
     FROM sf_accounts a ORDER BY a.is_active DESC, a.kind, a.sort, a.id`,
    asOf
  );
}

/** Money held for others: each fund with what is still held (and the total). */
export async function heldFunds(env) {
  const funds = await all(
    env,
    `SELECT f.*, a.name AS account_name, COALESCE((SELECT SUM(m.held_amount) FROM sf_account_moves m WHERE m.held_id = f.id), 0) AS balance
     FROM sf_held_funds f LEFT JOIN sf_accounts a ON a.id = f.account_id ORDER BY f.is_active DESC, f.id`
  );
  const active = funds.filter((f) => f.is_active);
  // per account: how much of its balance belongs to others
  const byAccount = {};
  for (const f of active) byAccount[f.account_id ?? 0] = (byAccount[f.account_id ?? 0] || 0) + f.balance;
  return { funds, total: active.reduce((s, f) => s + f.balance, 0), by_account: byAccount };
}

// ------------------------------------------------------------------ forecast
/**
 * What is expected to hit the bank accounts from tomorrow to `to`: card bills (purchases already made),
 * recurring items, and future-dated entries. Each event carries the running total of all accounts.
 */
export async function forecast(env, to, today = todayFor(env)) {
  const accs = await balances(env, today);
  const start = accs.filter((a) => a.is_active).reduce((s, a) => s + a.balance, 0);
  const cards = new Map((await all(env, `SELECT * FROM sf_cards`)).map((c) => [c.id, c]));
  const events = [];

  // future-dated money movements already recorded (mostly purchases on regular cards), card bills grouped
  const future = await all(
    env,
    `SELECT t.*, c.name AS category_name FROM sf_transactions t LEFT JOIN sf_categories c ON c.id = t.category_id
     WHERE t.account_id IS NOT NULL AND t.charge_date > ? AND t.charge_date <= ? ORDER BY t.charge_date, t.id`,
    today, to
  );
  const bills = new Map();
  for (const t of future) {
    const card = t.card_id ? cards.get(t.card_id) : null;
    if (card && card.kind === 'regular') {
      const key = `${card.id}|${t.charge_date}`;
      const b = bills.get(key) || { type: 'card_bill', date: t.charge_date, card_id: card.id, account_id: t.account_id, name: `חיוב ${card.name}`, amount: 0, count: 0 };
      b.amount += signed(t);
      b.count++;
      (b.items ||= []).push(t.note || t.category_name || 'רכישה');
      bills.set(key, b);
    } else {
      events.push({ type: 'entry', id: t.id, date: t.charge_date, account_id: t.account_id, name: t.note || t.category_name || (t.kind === 'income' ? 'הכנסה' : 'הוצאה'), amount: signed(t) });
    }
  }

  // recurring items not yet recorded: upcoming ones, and overdue ones still waiting for confirmation
  for (const o of await openOccurrences(env, addDays(today, -LOOKBACK_DAYS), to, today)) {
    if (!o.account_id) continue; // cash: does not touch an account
    if (o.occurrence <= today && o.auto) continue; // recorded by syncRecurring
    const card = o.card_id ? cards.get(o.card_id) : null;
    if (card && card.kind === 'regular') {
      const key = `${card.id}|${o.charge_date}`;
      if (o.charge_date <= today || o.charge_date > to) continue;
      const b = bills.get(key) || { type: 'card_bill', date: o.charge_date, card_id: card.id, account_id: o.account_id, name: `חיוב ${card.name}`, amount: 0, count: 0 };
      b.amount += o.kind === 'income' ? o.amount : -o.amount;
      b.count++;
      (b.items ||= []).push(o.name);
      bills.set(key, b);
      continue;
    }
    const overdue = o.occurrence <= today;
    events.push({
      type: overdue ? 'pending' : 'recurring', date: overdue ? addDays(today, 1) : o.charge_date, occurrence: o.occurrence,
      recurring_id: o.recurring_id, account_id: o.account_id, name: o.name, amount: o.kind === 'income' ? o.amount : -o.amount,
      changed: o.changed, usual_amount: o.usual_amount,
    });
  }
  for (const b of bills.values()) if (b.items?.length) b.name = `${b.name}: ${b.items.slice(0, 3).join(', ')}${b.items.length > 3 ? '…' : ''}`;
  events.push(...bills.values());

  // future-dated transfers / corrections / held money
  for (const m of await all(env, `SELECT * FROM sf_account_moves WHERE account_id IS NOT NULL AND date > ? AND date <= ?`, today, to)) {
    events.push({ type: 'move', id: m.id, date: m.date, account_id: m.account_id, name: m.note || 'העברה', amount: m.amount });
  }

  events.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
  let running = start;
  for (const e of events) e.balance_after = running += e.amount;
  const lowest = events.reduce((m, e) => (e.balance_after < m.balance ? { balance: e.balance_after, date: e.date } : m), { balance: start, date: today });

  // per account: what goes out / comes in, the lowest point, and how much must be added there by when
  const held = await heldFunds(env);
  const perAccount = accs.filter((a) => a.is_active).map((a) => {
    const evs = events.filter((e) => e.account_id === a.id);
    let bal = a.balance;
    let low = { balance: bal, date: today };
    let shortBy = bal < 0 ? { date: today, name: 'היתרה כבר במינוס' } : null; // first moment the account is below zero
    for (const e of evs) {
      bal += e.amount;
      e.account_balance_after = bal;
      if (bal < low.balance) low = { balance: bal, date: e.date };
      if (bal < 0 && !shortBy) shortBy = { date: e.date, name: e.name };
    }
    // the same, if income that was not confirmed yet (a salary still expected) does not come in
    const unsure = (e) => e.amount > 0 && (e.type === 'recurring' || e.type === 'pending');
    let sbal = a.balance;
    let slow = { balance: sbal, date: today };
    let sshort = null;
    const waitingFor = [];
    for (const e of evs) {
      if (unsure(e)) { waitingFor.push({ name: e.name, date: e.date, amount: e.amount, recurring_id: e.recurring_id, occurrence: e.occurrence }); continue; }
      sbal += e.amount;
      if (sbal < slow.balance) slow = { balance: sbal, date: e.date };
      if (sbal < 0 && !sshort) sshort = { date: e.date, name: e.name };
    }
    const others = held.by_account[a.id] || 0;
    return {
      account_id: a.id, name: a.name, kind: a.kind, balance: a.balance, others, mine: a.balance - others,
      out: evs.filter((e) => e.amount < 0).reduce((s, e) => s - e.amount, 0),
      in: evs.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0),
      end_balance: bal, lowest: low,
      need: low.balance < 0 ? -low.balance : 0, // must be added before shortBy.date
      short_by: shortBy, events: evs,
      // without income that is still only expected
      need_sure: slow.balance < 0 ? -slow.balance : 0, short_by_sure: sshort, waiting_for: waitingFor,
    };
  });
  return { today, to, start_balance: start, end_balance: running, lowest, accounts: accs, events, per_account: perAccount };
}

// ------------------------------------------------------------------ monthly summary
/** Income/expenses dated from..to (by the date of each entry). */
export async function summary(env, from, to) {
  // money given back for an expense paid for someone is not income: it lowers that expense
  // (same category, owner and payment method as the expense)
  const rows = await all(
    env,
    `SELECT CASE WHEN o.id IS NOT NULL THEN 'expense' ELSE t.kind END AS kind,
            CASE WHEN o.id IS NOT NULL THEN -t.amount ELSE t.amount END AS amount,
            t.date, COALESCE(o.category_id, t.category_id) AS category_id, COALESCE(o.owner_id, t.owner_id) AS owner_id,
            CASE WHEN o.id IS NOT NULL THEN o.card_id ELSE t.card_id END AS card_id,
            CASE WHEN o.id IS NOT NULL THEN o.account_id ELSE t.account_id END AS account_id, c.name AS category_name
     FROM sf_transactions t LEFT JOIN sf_transactions o ON o.id = t.reimburse_of AND o.kind = 'expense'
     LEFT JOIN sf_categories c ON c.id = COALESCE(o.category_id, t.category_id) WHERE t.date BETWEEN ? AND ?`,
    from, to
  );
  const total = { income: 0, expense: 0 };
  const byCat = new Map();
  const byOwner = new Map();
  const byPay = new Map();
  const byDay = new Map();
  for (const r of rows) {
    const pk = `${r.kind}|${r.card_id ? `c${r.card_id}` : `a${r.account_id ?? 0}`}`;
    const pay = byPay.get(pk) || { kind: r.kind, card_id: r.card_id, account_id: r.card_id ? null : r.account_id, amount: 0, count: 0 };
    pay.amount += r.amount;
    pay.count++;
    byPay.set(pk, pay);
    const day = byDay.get(r.date) || { date: r.date, income: 0, expense: 0 };
    day[r.kind] += r.amount;
    byDay.set(r.date, day);
    total[r.kind] += r.amount;
    const ck = `${r.kind}|${r.category_id ?? 0}`;
    const c = byCat.get(ck) || { kind: r.kind, category_id: r.category_id, name: r.category_name || 'ללא קטגוריה', amount: 0, count: 0 };
    c.amount += r.amount;
    c.count++;
    byCat.set(ck, c);
    const ok = `${r.kind}|${r.owner_id ?? 0}`;
    const o = byOwner.get(ok) || { kind: r.kind, owner_id: r.owner_id, amount: 0 };
    o.amount += r.amount;
    byOwner.set(ok, o);
  }
  return {
    from, to, income: total.income, expense: total.expense, net: total.income - total.expense, count: rows.length,
    categories: [...byCat.values()].sort((a, b) => b.amount - a.amount),
    owners: [...byOwner.values()],
    payments: [...byPay.values()].sort((a, b) => b.amount - a.amount),
    days: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/** The count starts at the first entry: the date of the earliest income/expense. */
export async function trackingStart(env) {
  const r = await first(env, `SELECT MIN(date) AS d FROM sf_transactions`);
  return r?.d || todayFor(env);
}

/**
 * Where the money went between from..to: income/expenses by category, payment and person, per day,
 * plus balance corrections ("I have X now") = money that moved without being recorded.
 */
export async function report(env, from, to) {
  const sum = await summary(env, from, to);
  const adjust = await all(
    env,
    `SELECT m.account_id, a.name AS account_name, a.kind AS account_kind, SUM(m.amount) AS amount, COUNT(*) AS count
     FROM sf_account_moves m JOIN sf_accounts a ON a.id = m.account_id
     WHERE m.kind = 'adjust' AND m.date BETWEEN ? AND ? GROUP BY m.account_id ORDER BY a.sort, a.id`,
    from, to
  );
  const unrecorded = adjust.reduce((s, a) => s + a.amount, 0);
  const days = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1);
  return { ...sum, unrecorded, adjustments: adjust, days, per_day: Math.round(sum.expense / days) };
}

