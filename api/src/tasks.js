// "What do I need to do, and by when?" Automatic tasks computed from the data, plus the user's own.
// Each task: { key, kind, level: 'urgent' | 'soon' | 'info', title, detail, due, amount, action }
import { all } from './db.js';
import { addDays } from './dates.js';
import { forecast, heldFunds, pendingRecurring, todayFor } from './money.js';

const CASH_STALE_DAYS = 7;
const days = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
const nis = (agorot) => `${(agorot / 100).toLocaleString('he-IL', { maximumFractionDigits: 2 })} ₪`;
const dm = (d) => `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}`;

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
    // where could it come from: another account that stays positive (without others' money) all month
    const source = banks
      .filter((b) => b.account_id !== a.account_id && Math.min(b.lowest.balance, b.end_balance) - b.others >= a.need)
      .sort((x, y) => y.lowest.balance - x.lowest.balance)[0];
    tasks.push({
      key: `short:${a.account_id}`, kind: 'shortfall', level: left <= 7 ? 'urgent' : 'soon',
      title: `להכניס ${nis(a.need)} ל${a.name} עד ${dm(by.date)}`,
      detail: `${a.short_by ? `ב-${dm(by.date)} יוצא ${by.name} ואין מספיק` : by.name}${source ? ` · אפשר להעביר מ${source.name}` : ''}`,
      due: by.date, amount: a.need, action: { type: 'transfer', to: a.account_id, from: source?.account_id ?? null, amount: a.need },
    });
  }

  // 3. others' money that was used: what must go back into which account
  for (const a of fc.per_account) {
    if (!a.others || a.mine >= 0) continue;
    const names = held.funds.filter((f) => f.is_active && f.account_id === a.account_id && f.balance > 0).map((f) => f.name).join(', ');
    const covered = a.end_balance - a.others >= 0; // expected income covers it within the month
    tasks.push({
      key: `owed:${a.account_id}`, kind: 'owed', level: covered ? 'info' : 'soon',
      title: `להשלים ${nis(-a.mine)} ב${a.name}`,
      detail: `השתמשת בכסף של ${names || 'אחרים'}${covered ? ` · לפי הצפי יחזור עד ${dm(fc.to)}` : ' · לפי הצפי זה לא יחזור החודש'}`,
      due: null, amount: -a.mine, action: { type: 'held' },
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
  return { status: urgent ? 'urgent' : soon ? 'attention' : 'ok', urgent, soon, tasks, accounts: fc.accounts };
}
