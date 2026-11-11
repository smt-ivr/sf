// "What do I need to do, and by when?" Automatic tasks computed from the data, plus the user's own.
// Each task: { key, kind, level: 'urgent' | 'soon' | 'info', title, detail, due, amount, action }
import { all } from './db.js';
import { addDays } from './dates.js';
import { forecast, heldFunds, owedToMe, pendingRecurring, todayFor } from './money.js';

const CASH_STALE_DAYS = 7;
const CHARGE_WEEK = 7;          // charges coming this week get a "make sure there is money" task
const CHARGE_MIN = 100_00;      // ... when at least this much (agorot)
const days = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
const nis = (agorot) => `${(agorot / 100).toLocaleString('he-IL', { maximumFractionDigits: 2 })} ₪`;
const dm = (d) => `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}`;

/** Another bank that can give `amount` and still never go below zero (nor touch others' money) this month. */
function sourceFor(banks, target, amount) {
  return banks
    .filter((b) => b.account_id !== target.account_id && Math.min(b.lowest.balance, b.balance) - Math.max(b.others, 0) - (b.need_sure ? b.need_sure : 0) >= amount)
    .sort((x, y) => y.lowest.balance - x.lowest.balance)[0] || null;
}

export async function computeTasks(env, { today = todayFor(env), fc = null, held = null, pending = null } = {}) {
  fc ??= await forecast(env, addDays(today, 30), today);
  held ??= await heldFunds(env);
  pending ??= await pendingRecurring(env, today);
  const tasks = [];

  // 1. recurring items whose day passed: how much really came in / went out?
  for (const p of pending) {
    const late = days(p.occurrence, today);
    tasks.push({
      key: `confirm:${p.recurring_id}:${p.occurrence}`, kind: 'confirm', level: late > 2 ? 'urgent' : 'soon',
      title: p.kind === 'income' ? `לעדכן כמה נכנס: ${p.name}` : `לעדכן כמה יצא: ${p.name}`,
      detail: `היה צפוי ב-${dm(p.occurrence)}, ${nis(p.amount)}${late > 0 ? ` · לפני ${late} ימים` : ''}`,
      due: p.occurrence, amount: p.amount, action: { type: 'confirm', item: p },
    });
  }

  // 2. accounts that would go below zero: move money there in time
  const banks = fc.per_account.filter((a) => a.kind === 'bank');
  for (const a of fc.per_account) {
    if (!a.need) continue;
    const by = a.short_by || { date: today, name: 'היתרה כבר במינוס' }; // already below zero today
    const left = days(today, by.date);
    const source = sourceFor(banks, a, a.need);
    tasks.push({
      key: `short:${a.account_id}`, kind: 'shortfall', level: left <= 7 ? 'urgent' : 'soon',
      title: `להכניס ${nis(a.need)} ל${a.name} עד ${dm(by.date)}`,
      detail: `${a.short_by ? `ב-${dm(by.date)} יוצא ${by.name} ואין מספיק` : by.name}${source ? ` · אפשר להעביר מ${source.name}` : ''}`,
      due: by.date, amount: a.need, action: { type: 'transfer', to: a.account_id, from: source?.account_id ?? null, amount: a.need },
    });
  }

  // 2b. no overdraft only if a salary that is still expected comes in on time
  for (const a of banks) {
    if (a.need || !a.need_sure) continue;
    const by = a.short_by_sure;
    const waiting = a.waiting_for.filter((w) => w.date <= by.date).map((w) => `${w.name} (${dm(w.date)})`).join(', ');
    const outs = a.events.filter((e) => e.amount < 0 && days(today, e.date) <= 30).slice(0, 4).map((e) => `${dm(e.date)} ${e.name} ${nis(-e.amount)}`).join(' · ');
    tasks.push({
      key: `depends:${a.account_id}`, kind: 'depends', level: days(today, by.date) <= 7 ? 'soon' : 'info',
      title: `${a.name}: ב-${dm(by.date)} יוצא ${by.name}`,
      detail: `יש מספיק רק אם ${waiting || 'ההכנסה הצפויה'} ייכנס בזמן. אחרת חסרים ${nis(a.need_sure)}${outs ? ` · יוצא: ${outs}` : ''}`,
      due: by.date, amount: a.need_sure,
      action: { type: 'transfer', to: a.account_id, from: sourceFor(banks, a, a.need_sure)?.account_id ?? null, amount: a.need_sure },
    });
  }

  // 2c. charges coming this week: make sure the money is there
  const charges = new Map();
  for (const e of fc.events) {
    if (e.amount >= 0 || !e.account_id || days(today, e.date) > CHARGE_WEEK) continue;
    const a = banks.find((b) => b.account_id === e.account_id);
    if (!a || a.need || a.need_sure) continue; // a shortfall / "only if the salary comes in" task covers this account
    const k = `${e.account_id}|${e.date}`;
    const c = charges.get(k) || { a, date: e.date, amount: 0, names: [], after: null };
    c.amount -= e.amount;
    c.names.push(e.name);
    c.after = e.account_balance_after;
    charges.set(k, c);
  }
  for (const c of charges.values()) {
    if (c.amount < CHARGE_MIN) continue;
    const depends = c.a.need_sure > 0 && c.a.short_by_sure && c.date >= c.a.short_by_sure.date;
    tasks.push({
      key: `charge:${c.a.account_id}:${c.date}`, kind: 'charge', level: depends ? 'soon' : 'info',
      title: `לוודא שיש ${nis(c.amount)} ב${c.a.name} עד ${dm(c.date)}`,
      detail: `${c.names.join(', ')} · ${depends ? 'תלוי בהכנסה שעוד לא נכנסה' : `אחרי החיוב יישאר ${nis(c.after)} ✓`}`,
      due: c.date, amount: c.amount,
      action: { type: 'transfer', to: c.a.account_id, from: sourceFor(banks, c.a, c.amount)?.account_id ?? null, amount: c.amount },
    });
  }

  // 3. others' money that was used: put it back (a transfer from another bank, or wait for income)
  for (const a of fc.per_account) {
    if (!a.others || a.mine >= 0) continue;
    const names = held.funds.filter((f) => f.is_active && f.account_id === a.account_id && f.balance > 0).map((f) => f.name).join(', ');
    const covered = a.end_balance - a.others >= 0; // expected income covers it within the month
    const source = sourceFor(banks, a, -a.mine);
    tasks.push({
      key: `owed:${a.account_id}`, kind: 'owed', level: covered ? 'info' : 'soon',
      title: `להחזיר ${nis(-a.mine)} ל${a.name} (הכסף של ${names || 'אחרים'})`,
      detail: `השתמשת בכסף שלו${source ? ` · אפשר להעביר מ${source.name}` : ''}${covered ? ` · לפי הצפי יחזור עד ${dm(fc.to)}` : ' · לפי הצפי זה לא יחזור החודש'}`,
      due: null, amount: -a.mine,
      action: { type: 'transfer', to: a.account_id, from: source?.account_id ?? null, amount: -a.mine }, more: { type: 'held' },
    });
  }

  // 4. cash not counted for a while
  const cash = fc.accounts.filter((a) => a.is_active && a.kind === 'cash');
  if (cash.length) {
    const last = await all(
      env,
      `SELECT a.id, a.name, a.opening_date, (SELECT MAX(m.date) FROM sf_account_moves m WHERE m.account_id = a.id AND m.kind = 'adjust') AS counted
       FROM sf_accounts a WHERE a.kind = 'cash' AND a.is_active = 1`
    );
    for (const c of last) {
      const since = c.counted || c.opening_date;
      if (days(since, today) < CASH_STALE_DAYS) continue;
      tasks.push({
        key: `cash:${c.id}`, kind: 'cash', level: 'info', title: `לספור כמה מזומן יש ב${c.name}`,
        detail: c.counted ? `נספר לאחרונה ב-${dm(c.counted)}` : 'עוד לא נספר', due: null, amount: null, action: { type: 'count', account_id: c.id },
      });
    }
  }

  // 5. income expected in the coming week (confirm it when it arrives, even early)
  for (const e of fc.events.filter((e) => e.type === 'recurring' && e.amount > 0 && days(today, e.date) <= 7)) {
    tasks.push({
      key: `expect:${e.recurring_id}:${e.occurrence}`, kind: 'expected', level: 'info',
      title: `צפוי להיכנס: ${e.name}`, detail: `ב-${dm(e.date)}, ${nis(e.amount)} · כשנכנס, לעדכן כמה בפועל`,
      due: e.date, amount: e.amount, action: { type: 'confirm', item: { recurring_id: e.recurring_id, occurrence: e.occurrence, name: e.name, amount: e.amount, kind: 'income' } },
    });
  }

  // 5b. people who owe you for something you paid for them
  for (const o of await owedToMe(env)) {
    const left = o.amount - o.repaid;
    tasks.push({
      key: `owedme:${o.id}`, kind: 'owed_me', level: 'info', title: `${o.for_name} חייב לך ${nis(left)}`,
      detail: `${o.note || o.category_name || 'הוצאה'} מ-${dm(o.date)}${o.repaid ? ` · החזיר כבר ${nis(o.repaid)}` : ''}`,
      due: null, amount: left, action: { type: 'reimburse', expense: o },
    });
  }

  // 6. the user's own tasks
  for (const t of await all(env, `SELECT * FROM sf_tasks WHERE done_at IS NULL ORDER BY due_date IS NULL, due_date, id`)) {
    const left = t.due_date ? days(today, t.due_date) : null;
    tasks.push({
      key: `task:${t.id}`, kind: 'manual', id: t.id, level: left === null ? 'info' : left <= 1 ? 'urgent' : left <= 7 ? 'soon' : 'info',
      title: t.title, detail: [t.note, left !== null && (left < 0 ? `באיחור של ${-left} ימים` : left === 0 ? 'היום' : `עוד ${left} ימים`)].filter(Boolean).join(' · '),
      due: t.due_date, amount: t.amount, action: { type: 'done' },
    });
  }

  const order = { urgent: 0, soon: 1, info: 2 };
  tasks.sort((a, b) => order[a.level] - order[b.level] || (a.due || '9999').localeCompare(b.due || '9999'));
  const urgent = tasks.filter((t) => t.level === 'urgent').length;
  const soon = tasks.filter((t) => t.level === 'soon').length;
  // overdraft outlook for the banks (30 days): expected / only if income arrives / none
  const minus = {
    days: days(today, fc.to),
    expected: banks.filter((a) => a.need).map((a) => ({ name: a.name, date: (a.short_by || { date: today }).date, amount: a.need })),
    depends: banks.filter((a) => !a.need && a.need_sure).map((a) => ({
      name: a.name, date: a.short_by_sure.date, amount: a.need_sure,
      on: a.waiting_for.filter((w) => w.date <= a.short_by_sure.date).map((w) => w.name),
    })),
  };
  return { status: urgent ? 'urgent' : soon ? 'attention' : 'ok', urgent, soon, tasks, minus, accounts: fc.accounts };
}
