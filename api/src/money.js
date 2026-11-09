// Core of the tracker: saving a transaction, recording recurring items, balances and the forecast.
import { all, first } from './db.js';
import { invalid } from './http.js';
import { addDays, chargeDate, occurrences, today as todayIn } from './dates.js';

export const todayFor = (env) => todayIn(env.TZ || 'Asia/Jerusalem');
const signed = (t) => (t.kind === 'income' ? t.amount : -t.amount);
// Recurring items look back at most this far (a forgotten salary from last year is not "pending" forever).
const LOOKBACK_DAYS = 120;

// ------------------------------------------------------------------ payment method
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
  return { card: null, card_id: null, account_id: null }; // cash
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
    `INSERT INTO sf_transactions (kind, amount, date, charge_date, category_id, account_id, card_id, owner_id, user_id, recurring_id, occurrence, note, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(d.kind, d.amount, d.date, charge, d.category_id ?? null, pay.account_id, pay.card_id, d.owner_id ?? null, userId,
    d.recurring_id ?? null, d.occurrence ?? null, d.note ?? '', source);
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
  return { items, seen, cards };
}

/**
 * Records automatic recurring items whose day has come (no cron: called whenever the app or the
 * phone line reads data). Idempotent: UNIQUE(recurring_id, occurrence) plus INSERT OR IGNORE.
 */
export async function syncRecurring(env, today = todayFor(env)) {
  const from = addDays(today, -LOOKBACK_DAYS);
  const { items, seen, cards } = await recurringState(env, from);
  const stmts = [];
  for (const r of items.filter((r) => r.auto)) {
    for (const occ of occurrences(r, from, today)) {
      if (seen.has(`${r.id}|${occ}`)) continue;
      const card = r.card_id ? cards.get(r.card_id) : null;
      stmts.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO sf_transactions (kind, amount, date, charge_date, category_id, account_id, card_id, owner_id, recurring_id, occurrence, note, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recurring')`
        ).bind(r.kind, r.amount, occ, chargeDate(occ, card), r.category_id, card ? card.account_id : r.account_id, card ? card.id : null,
          r.owner_id, r.id, occ, r.name)
      );
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  return stmts.length;
}

/** Occurrences (recorded or not) of the recurring items between from..to, minus recorded and skipped. */
async function openOccurrences(env, from, to, today) {
  const { items, seen, cards } = await recurringState(env, addDays(today, -LOOKBACK_DAYS));
  const out = [];
  for (const r of items) {
    const card = r.card_id ? cards.get(r.card_id) : null;
    for (const occ of occurrences(r, from, to)) {
      if (seen.has(`${r.id}|${occ}`)) continue;
      out.push({
        recurring_id: r.id, name: r.name, kind: r.kind, amount: r.amount, occurrence: occ,
        charge_date: chargeDate(occ, card), account_id: card ? card.account_id : r.account_id, card_id: card ? card.id : null,
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
export async function balances(env, asOf) {
  return all(
    env,
    `SELECT a.id, a.name, a.bank, a.owner_id, a.is_active,
       a.opening_balance + COALESCE((
         SELECT SUM(CASE WHEN t.kind = 'income' THEN t.amount ELSE -t.amount END) FROM sf_transactions t
         WHERE t.account_id = a.id AND t.charge_date >= a.opening_date AND t.charge_date <= ?1), 0) AS balance
     FROM sf_accounts a ORDER BY a.is_active DESC, a.sort, a.id`,
    asOf
  );
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
      bills.set(key, b);
      continue;
    }
    const overdue = o.occurrence <= today;
    events.push({
      type: overdue ? 'pending' : 'recurring', date: overdue ? addDays(today, 1) : o.charge_date, occurrence: o.occurrence,
      recurring_id: o.recurring_id, account_id: o.account_id, name: o.name, amount: o.kind === 'income' ? o.amount : -o.amount,
    });
  }
  events.push(...bills.values());

  events.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
  let running = start;
  for (const e of events) e.balance_after = running += e.amount;
  const lowest = events.reduce((m, e) => (e.balance_after < m.balance ? { balance: e.balance_after, date: e.date } : m), { balance: start, date: today });
  return { today, to, start_balance: start, end_balance: running, lowest, accounts: accs, events };
}

// ------------------------------------------------------------------ monthly summary
export async function summary(env, from, to) {
  const rows = await all(
    env,
    `SELECT t.kind, t.amount, t.category_id, t.owner_id, t.card_id, t.account_id, c.name AS category_name
     FROM sf_transactions t LEFT JOIN sf_categories c ON c.id = t.category_id WHERE t.date BETWEEN ? AND ?`,
    from, to
  );
  const total = { income: 0, expense: 0 };
  const byCat = new Map();
  const byOwner = new Map();
  for (const r of rows) {
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
  };
}
