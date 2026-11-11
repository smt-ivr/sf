// End-to-end tests over the real Worker and migrations (in-memory SQLite instead of D1).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/index.js';
import { addDays, chargeDate, occurrences } from '../src/dates.js';
import { todayFor } from '../src/money.js';
import { D1Shim } from './d1-shim.mjs';

function makeApp() {
  const env = { DB: new D1Shim(), TZ: 'Asia/Jerusalem', BASE_PATH: '/sf' };
  let token = null;
  const call = async (method, path, body, headers = {}) => {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await worker.fetch(new Request(`https://smti.uk/sf/api${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data };
  };
  return { env, call, setToken: (t) => (token = t) };
}

const ivr = (app, params) =>
  worker.fetch(new Request(`https://smti.uk/sf/api/ivr?${new URLSearchParams(params)}`), app.env).then((r) => r.text());

test('dates: regular card is charged on its next billing day (same day counts); clamps to month end', () => {
  assert.equal(chargeDate('2026-01-20', { kind: 'regular', billing_day: 10 }), '2026-02-10');
  assert.equal(chargeDate('2026-11-15', { kind: 'regular', billing_day: 15 }), '2026-11-15'); // insurance on the 15th
  assert.equal(chargeDate('2026-11-09', { kind: 'regular', billing_day: 15 }), '2026-11-15');
  assert.equal(chargeDate('2026-02-05', { kind: 'regular', billing_day: 31 }), '2026-02-28');
  assert.equal(chargeDate('2026-12-31', { kind: 'regular', billing_day: 2 }), '2027-01-02');
  assert.equal(chargeDate('2026-01-20', { kind: 'direct' }), '2026-01-20');
  assert.equal(chargeDate('2026-01-20', null), '2026-01-20');
});

test('dates: recurring occurrences', () => {
  const r = { day_of_month: 31, interval_months: 1, start_date: '2026-01-15', end_date: null };
  assert.deepEqual(occurrences(r, '2026-01-01', '2026-04-30'), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  const bi = { day_of_month: 1, interval_months: 2, start_date: '2026-01-01', end_date: '2026-06-30' };
  assert.deepEqual(occurrences(bi, '2026-02-01', '2026-12-31'), ['2026-03-01', '2026-05-01']);
});

test('setup once, login by phone and e-mail, second user', async () => {
  const app = makeApp();
  assert.equal((await app.call('GET', '/auth/options')).data.needs_setup, true);
  const s = await app.call('POST', '/setup', { name: 'שמואל', email: 'A@Example.com', phone: '058-320-6823', password: '1234' });
  assert.equal(s.status, 201);
  assert.equal(s.data.user.email, 'a@example.com');
  assert.equal((await app.call('POST', '/setup', { name: 'x', password: '1234' })).status, 409);
  assert.equal((await app.call('GET', '/auth/options')).data.needs_setup, false);

  assert.equal((await app.call('POST', '/auth/login', { login: '0583206823', password: 'bad' })).status, 401);
  const l = await app.call('POST', '/auth/login', { login: '+972583206823', password: '1234' });
  assert.equal(l.status, 200);
  app.setToken(l.data.token);

  const w = await app.call('POST', '/users', { name: 'רחל', email: 'r@example.com', password: '5678', phones: ['0521111111', { phone: '0522222222', label: 'עבודה' }] });
  assert.equal(w.status, 201);
  assert.equal(w.data.phones.length, 2);
  assert.equal((await app.call('POST', '/users', { name: 'x', phones: ['0521111111'] })).status, 409);
  assert.equal((await app.call('GET', '/users')).data.length, 2);
  assert.ok((await app.call('GET', '/settings')).data.ivr_key);
});

async function ready() {
  const app = makeApp();
  const s = await app.call('POST', '/setup', { name: 'שמואל', phone: '0583206823', password: '1234' });
  app.setToken(s.data.token);
  const acc = (await app.call('POST', '/accounts', { name: 'עו"ש', bank: 'פועלים', opening_balance: 1000, opening_date: '2020-01-01' })).data;
  const regular = (await app.call('POST', '/cards', { name: 'ויזה', kind: 'regular', account_id: acc.id, billing_day: 10, last4: '1234' })).data;
  const direct = (await app.call('POST', '/cards', { name: 'דיירקט', kind: 'direct', account_id: acc.id })).data;
  const cats = (await app.call('GET', '/categories')).data;
  return { app, acc, regular, direct, food: cats.find((c) => c.name === 'מזון וסופר'), salary: cats.find((c) => c.name === 'משכורת') };
}

test('cards: regular needs a billing day; entries get the right charge date and balance', async () => {
  const { app, acc, regular, direct, food } = await ready();
  assert.equal((await app.call('POST', '/cards', { name: 'x', kind: 'regular', account_id: acc.id })).status, 422);

  const a = await app.call('POST', '/transactions', { kind: 'expense', amount: '120.50', date: '2026-01-20', card_id: regular.id, category_id: food.id });
  assert.equal(a.status, 201);
  assert.equal(a.data.amount, 12050);
  assert.equal(a.data.charge_date, '2026-02-10');
  assert.equal(a.data.account_id, acc.id);

  const b = await app.call('POST', '/transactions', { kind: 'expense', amount: 30, date: '2026-01-21', card_id: direct.id });
  assert.equal(b.data.charge_date, '2026-01-21');
  // wrong category kind
  assert.equal((await app.call('POST', '/transactions', { kind: 'income', amount: 1, date: '2026-01-21', category_id: food.id })).status, 422);

  const list = await app.call('GET', '/transactions?month=2026-01');
  assert.equal(list.data.items.length, 2);
  const sum = await app.call('GET', '/summary?month=2026-01');
  assert.equal(sum.data.expense, 15050);

  // moving the purchase to the direct card recomputes the charge date
  const p = await app.call('PATCH', `/transactions/${a.data.id}`, { card_id: direct.id });
  assert.equal(p.data.charge_date, '2026-01-20');

  const dash = await app.call('GET', '/dashboard');
  assert.equal(dash.status, 200);
  assert.equal(dash.data.accounts[0].balance, 100000 - 15050);

  // an account that is in use cannot be deleted
  assert.equal((await app.call('DELETE', `/accounts/${acc.id}`)).status, 409);
});

test('recurring: automatic items are recorded once; manual ones wait for confirmation', async () => {
  const { app, acc, salary } = await ready();
  const today = todayFor(app.env);
  const day = Number(today.slice(8, 10));
  const start = `${today.slice(0, 7)}-01`;
  const rent = await app.call('POST', '/recurring', { kind: 'expense', name: 'שכירות', amount: 4000, account_id: acc.id, day_of_month: 1, start_date: start });
  assert.equal(rent.status, 201);
  const pay = await app.call('POST', '/recurring', { kind: 'income', name: 'משכורת', amount: 9000, account_id: acc.id, category_id: salary.id, day_of_month: day, start_date: start, auto: false });
  assert.equal(pay.status, 201);

  await app.call('GET', '/dashboard');
  await app.call('GET', '/dashboard');
  const items = (await app.call('GET', `/transactions?month=${today.slice(0, 7)}`)).data.items;
  assert.equal(items.filter((t) => t.recurring_id === rent.data.id).length, 1);
  assert.equal(items.filter((t) => t.recurring_id === pay.data.id).length, 0);

  const dash = (await app.call('GET', '/dashboard')).data;
  const pending = dash.pending.find((x) => x.recurring_id === pay.data.id);
  assert.ok(pending);
  const c = await app.call('POST', `/recurring/${pay.data.id}/confirm`, { occurrence: pending.occurrence, amount: 9100 });
  assert.equal(c.status, 201);
  assert.equal(c.data.amount, 910000);
  assert.equal((await app.call('GET', '/dashboard')).data.pending.length, 0);

  // deleting an automatic entry means "did not happen": it is not recorded again
  const rentTx = items.find((t) => t.recurring_id === rent.data.id);
  assert.equal((await app.call('DELETE', `/transactions/${rentTx.id}`)).status, 204);
  await app.call('GET', '/dashboard');
  const again = (await app.call('GET', `/transactions?month=${today.slice(0, 7)}`)).data.items;
  assert.equal(again.filter((t) => t.recurring_id === rent.data.id).length, 0);

  const fc = await app.call('GET', '/forecast?days=70');
  assert.ok(fc.data.events.some((e) => e.recurring_id === rent.data.id));
});

test('phone line: key, caller ID, an expense on a card, and no double save on retry', async () => {
  const { app, regular, food } = await ready();
  const st = (await app.call('GET', '/settings')).data;
  assert.equal(st.ivr_link, 'https://smti.uk/sf/api/ivr'); // no query string: Yemot adds key via api_add_0
  const key = st.ivr_key;

  assert.match(await ivr(app, { key: 'bad', ApiPhone: '0583206823', ApiCallId: 'c1' }), /חסומה/);
  assert.match(await ivr(app, { key, ApiPhone: '0500000000', ApiCallId: 'c1' }), /אינו מחובר/);

  const base = { key, ApiPhone: '0583206823', ApiCallId: 'c1' };
  assert.match(await ivr(app, base), /read=.*=m0,/);
  assert.match(await ivr(app, { ...base, m0: '1' }), /=a0,/);
  assert.match(await ivr(app, { ...base, m0: '1', a0: '75' }), /=c0,/);
  const cats = (await app.call('GET', '/categories')).data.filter((c) => c.kind === 'expense' && c.is_active).sort((a, b) => a.sort - b.sort || a.id - b.id);
  const ci = String(cats.findIndex((c) => c.id === food.id) + 1);
  const payMenu = await ivr(app, { ...base, m0: '1', a0: '75', c0: ci });
  assert.match(payMenu, /ויזה הקישו 1/);
  const noteMenu = await ivr(app, { ...base, m0: '1', a0: '75', c0: ci, p0: '1' });
  assert.match(noteMenu, /=n0,/);
  const confirm = await ivr(app, { ...base, m0: '1', a0: '75', c0: ci, p0: '1', n0: '0' });
  assert.match(confirm, /75 שקלים/);
  const done = { ...base, m0: '1', a0: '75', c0: ci, p0: '1', n0: '0', k0: '1' };
  assert.match(await ivr(app, done), /נשמר.*=m1,/);
  assert.match(await ivr(app, done), /=m1,/); // Yemot retried the same request

  const items = (await app.call('GET', `/transactions?month=${todayFor(app.env).slice(0, 7)}`)).data.items.filter((t) => t.source === 'phone');
  assert.equal(items.length, 1);
  assert.equal(items[0].amount, 7500);
  assert.equal(items[0].card_id, regular.id);
  assert.equal(items[0].category_id, food.id);

  assert.match(await ivr(app, { ...done, m1: '3' }), /יתרה בבנק.*=m2,/);
  assert.match(await ivr(app, { ...done, m1: '3', m2: '0' }), /להתראות/);
});

test('dates: Hebrew-calendar recurring item (Rosh Chodesh)', () => {
  const r = { calendar: 'hebrew', day_of_month: 1, interval_months: 1, start_date: '2026-11-01', end_date: null };
  // 1 Kislev, 1 Tevet, 1 Shevat 5787
  assert.deepEqual(occurrences(r, '2026-11-01', '2027-01-31'), ['2026-11-11', '2026-12-11', '2027-01-09']);
  // day 30 in a 29-day month falls on the 29th
  assert.equal(occurrences({ ...r, day_of_month: 30 }, '2026-12-12', '2027-01-09').length, 1);
});

test('cash wallet, balance correction, transfer, and money held for others', async () => {
  const { app, acc } = await ready();
  const lk = (await app.call('GET', '/lookups')).data;
  const wallet = lk.accounts.find((a) => a.kind === 'cash');
  assert.ok(wallet, 'a cash wallet exists');

  // a cash expense goes into the wallet
  const today = todayFor(app.env);
  const tx = await app.call('POST', '/transactions', { kind: 'expense', amount: 50, date: today });
  assert.equal(tx.data.account_id, wallet.id);

  // "I have 300 in cash now"
  const sb = await app.call('POST', `/accounts/${wallet.id}/balance`, { balance: 300 });
  assert.equal(sb.status, 200);
  assert.equal(sb.data.difference, 35000);
  // withdraw 200 from the bank into the wallet
  assert.equal((await app.call('POST', '/transfers', { from_account_id: acc.id, to_account_id: wallet.id, amount: 200 })).status, 201);
  let bal = (await app.call('GET', '/dashboard')).data.accounts;
  assert.equal(bal.find((a) => a.id === wallet.id).balance, 50000);
  assert.equal(bal.find((a) => a.id === acc.id).balance, 80000);
  // the month list shows the moves, not as income/expense
  const list = (await app.call('GET', `/transactions?month=${today.slice(0, 7)}`)).data;
  assert.equal(list.moves.length, 3);
  assert.equal((await app.call('GET', `/summary?month=${today.slice(0, 7)}`)).data.income, 0);
  // deleting one half of a transfer removes both
  const half = list.moves.find((m) => m.kind === 'transfer');
  await app.call('DELETE', `/moves/${half.id}`);
  bal = (await app.call('GET', '/dashboard')).data.accounts;
  assert.equal(bal.find((a) => a.id === acc.id).balance, 100000);

  // 600 of Reuven's money is already inside the bank balance
  const h = await app.call('POST', '/held', { name: 'ראובן', amount: 600, in_balance: true, account_id: acc.id });
  assert.equal(h.status, 201);
  let dash = (await app.call('GET', '/dashboard')).data;
  assert.equal(dash.held.total, 60000);
  assert.equal(dash.accounts.find((a) => a.id === acc.id).balance, 100000); // unchanged
  // returning 250 to him from the bank
  assert.equal((await app.call('POST', `/held/${h.data.id}/moves`, { direction: 'out', amount: 250, account_id: acc.id })).status, 201);
  assert.equal((await app.call('POST', `/held/${h.data.id}/moves`, { direction: 'out', amount: 9999, account_id: acc.id })).status, 400);
  dash = (await app.call('GET', '/dashboard')).data;
  assert.equal(dash.held.total, 35000);
  assert.equal(dash.accounts.find((a) => a.id === acc.id).balance, 75000);
  assert.equal((await app.call('GET', '/held')).data.funds[0].moves.length, 2);
});

test('recurring by the Hebrew calendar is validated', async () => {
  const { app, acc } = await ready();
  const bad = await app.call('POST', '/recurring', { kind: 'income', name: 'כולל', amount: 3000, account_id: acc.id, day_of_month: 1, calendar: 'hebrew', interval_months: 2 });
  assert.equal(bad.status, 422);
  const ok = await app.call('POST', '/recurring', { kind: 'income', name: 'כולל', amount: 3000, account_id: acc.id, day_of_month: 1, calendar: 'hebrew', auto: false });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.calendar, 'hebrew');
  const fc = (await app.call('GET', '/forecast?days=60')).data;
  assert.ok(fc.events.some((e) => e.recurring_id === ok.data.id));
});

test('report: from the first entry, by category and payment, with unrecorded differences', async () => {
  const { app, acc, regular, food } = await ready();
  const today = todayFor(app.env);
  await app.call('PATCH', `/accounts/${acc.id}`, { opening_date: today, opening_balance: 1000 });
  await app.call('POST', '/transactions', { kind: 'expense', amount: 100, date: today, card_id: regular.id, category_id: food.id });
  await app.call('POST', '/transactions', { kind: 'income', amount: 500, date: today, account_id: acc.id });
  await app.call('POST', '/transactions', { kind: 'expense', amount: 999, date: '2020-01-05', account_id: acc.id }); // recorded now, dated long ago
  // the wallet's opening date is today too, so tracking starts today
  // whatever the computed balance is today (the card purchase may already be charged), there is 150 less in the bank
  const computed = (await app.call('GET', '/dashboard')).data.accounts.find((x) => x.id === acc.id).balance;
  await app.call('POST', `/accounts/${acc.id}/balance`, { balance: (computed - 15000) / 100 });
  const r = (await app.call('GET', '/report')).data;
  assert.equal(r.tracking_start, '2020-01-05'); // the earliest entry
  assert.equal(r.from, '2020-01-05');
  assert.equal(r.income, 50000);
  assert.equal(r.expense, 109900);
  assert.equal((await app.call('GET', `/report?from=${today}&to=${today}`)).data.expense, 10000); // a date range: by date only
  assert.equal(r.categories.find((c) => c.category_id === food.id).amount, 10000);
  assert.equal(r.payments.find((p) => p.card_id === regular.id).amount, 10000);
  assert.equal(r.unrecorded, -15000);
});

test('the opening balance is the bank balance on its date: earlier entries are inside it, later ones count', async () => {
  const { app, acc, direct } = await ready();
  const today = todayFor(app.env);
  const d5 = addDays(today, -5);
  // Discount had 4047.38 on the 5th, 4000 of it Nachman's
  await app.call('PATCH', `/accounts/${acc.id}`, { opening_date: d5, opening_balance: 4047.38 });
  await app.call('POST', '/held', { name: 'נחמן', amount: 4000, in_balance: false, account_id: acc.id, date: addDays(today, -30) });
  await app.call('POST', '/transactions', { kind: 'expense', amount: 999, date: addDays(today, -6), card_id: direct.id }); // before: already inside
  await app.call('POST', '/transactions', { kind: 'expense', amount: 400, date: addDays(today, -4), card_id: direct.id });
  await app.call('POST', '/transactions', { kind: 'expense', amount: 116, date: addDays(today, -2), card_id: direct.id });
  const d = (await app.call('GET', '/dashboard')).data;
  const pa = d.forecast.per_account.find((x) => x.account_id === acc.id);
  assert.equal(pa.balance, 404738 - 40000 - 11600);
  assert.equal(pa.mine, 404738 - 40000 - 11600 - 400000);
});

test('a transfer dated tomorrow (when the bank shows it) counts from tomorrow; until then it is in the forecast', async () => {
  const { app, acc } = await ready();
  const today = todayFor(app.env);
  const other = (await app.call('POST', '/accounts', { name: 'פועלים', opening_balance: 500, opening_date: today })).data;
  await app.call('PATCH', `/accounts/${acc.id}`, { opening_date: today, opening_balance: 100 });
  const tomorrow = addDays(today, 1);
  assert.equal((await app.call('POST', '/transfers', { from_account_id: other.id, to_account_id: acc.id, amount: 300, date: tomorrow })).status, 201);
  const d = (await app.call('GET', '/dashboard')).data;
  assert.equal(d.accounts.find((x) => x.id === acc.id).balance, 10000);
  assert.equal(d.accounts.find((x) => x.id === other.id).balance, 50000);
  const ev = d.forecast.events.filter((e) => e.type === 'move' && e.date === tomorrow);
  assert.equal(ev.length, 2);
  assert.equal(d.forecast.per_account.find((x) => x.account_id === acc.id).end_balance >= 40000, true);
});

test('per account forecast: what goes out and how much must be added by when', async () => {
  const { app, acc } = await ready();
  const today = todayFor(app.env);
  await app.call('PATCH', `/accounts/${acc.id}`, { opening_date: today, opening_balance: 100 });
  const d = addDays(today, 3);
  await app.call('POST', '/recurring', { kind: 'expense', name: 'הלוואה', amount: 1500, account_id: acc.id, day_of_month: Number(d.slice(8, 10)), start_date: d });
  const pa = (await app.call('GET', '/forecast?days=10')).data.per_account.find((x) => x.account_id === acc.id);
  assert.equal(pa.balance, 10000);
  assert.equal(pa.out, 150000);
  assert.equal(pa.need, 140000);
  assert.equal(pa.short_by.date, d);
});

test('money held for others belongs to an account: what is missing there', async () => {
  const { app, acc } = await ready();
  assert.equal((await app.call('POST', '/held', { name: 'שמעון', amount: 1500, in_balance: true })).status, 422);
  const h = await app.call('POST', '/held', { name: 'שמעון', amount: 1500, in_balance: true, account_id: acc.id });
  assert.equal(h.status, 201);
  const held = (await app.call('GET', '/dashboard')).data.held;
  assert.equal(held.by_account[acc.id], 150000);
  assert.equal(held.funds[0].account_name, 'עו"ש');
  // the account has 1000: 500 of his money was used
  const bal = (await app.call('GET', '/dashboard')).data.accounts.find((a) => a.id === acc.id).balance;
  assert.equal(bal - held.by_account[acc.id], -50000);
});

test('tasks: confirm a salary, money needed in an account, money to return, own tasks; "under control"', async () => {
  const { app, acc } = await ready();
  const today = todayFor(app.env);
  await app.call('PATCH', `/accounts/${acc.id}`, { opening_date: today, opening_balance: 100 });
  let t = (await app.call('GET', '/tasks')).data;
  assert.equal(t.status, 'ok');

  const soon = addDays(today, 3);
  await app.call('POST', '/recurring', { kind: 'expense', name: 'הלוואה', amount: 500, account_id: acc.id, day_of_month: Number(soon.slice(8, 10)), start_date: soon });
  const past = addDays(today, -1);
  await app.call('POST', '/recurring', { kind: 'income', name: 'משכורת', amount: 3000, account_id: acc.id, day_of_month: Number(past.slice(8, 10)), start_date: past, auto: false });
  await app.call('POST', '/held', { name: 'נחמן', amount: 300, in_balance: true, account_id: acc.id });
  t = (await app.call('GET', '/tasks')).data;
  const kinds = t.tasks.map((x) => x.kind);
  assert.ok(kinds.includes('confirm'), 'confirm the salary');
  assert.ok(kinds.includes('owed'), 'others money used');
  // the overdue salary counts in the forecast (tomorrow), so the loan is covered: no shortfall
  assert.ok(!kinds.includes('shortfall'));
  const conf = t.tasks.find((x) => x.kind === 'confirm');
  await app.call('POST', `/recurring/${conf.action.item.recurring_id}/skip`, { occurrence: conf.action.item.occurrence });
  t = (await app.call('GET', '/tasks')).data;
  const short = t.tasks.find((x) => x.kind === 'shortfall');
  assert.ok(short, 'without the salary the loan is not covered');
  assert.equal(short.amount, 40000);
  assert.equal(short.level, 'urgent');
  assert.equal(t.status, 'urgent');

  const mine = await app.call('POST', '/tasks', { title: 'לשלם לאינסטלטור', due_date: addDays(today, 10) });
  assert.equal(mine.status, 201);
  assert.ok((await app.call('GET', '/tasks')).data.tasks.some((x) => x.kind === 'manual'));
  await app.call('PATCH', `/tasks/${mine.data.id}`, { done: true });
  const after = (await app.call('GET', '/tasks')).data;
  assert.ok(!after.tasks.some((x) => x.kind === 'manual'));
  assert.equal(after.done.length, 1);
  assert.ok((await app.call('GET', '/dashboard')).data.tasks.tasks.length > 0);
});

test('tasks: charges this week, "no overdraft only if the salary comes in", returning others\' money by transfer', async () => {
  const { app, acc } = await ready();
  const today = todayFor(app.env);
  await app.call('PATCH', `/accounts/${acc.id}`, { opening_date: today, opening_balance: 100 });
  const other = (await app.call('POST', '/accounts', { name: 'פועלים', opening_balance: 5000, opening_date: today })).data;
  const in1 = addDays(today, 1);
  const in3 = addDays(today, 3);
  await app.call('POST', '/recurring', { kind: 'income', name: 'משכורת', amount: 3000, account_id: acc.id, day_of_month: Number(in1.slice(8, 10)), start_date: in1, auto: false });
  await app.call('POST', '/recurring', { kind: 'expense', name: 'הלוואה', amount: 1500, account_id: acc.id, day_of_month: Number(in3.slice(8, 10)), start_date: in3 });
  await app.call('POST', '/recurring', { kind: 'expense', name: 'ועד בית', amount: 400, account_id: other.id, day_of_month: Number(in3.slice(8, 10)), start_date: in3 });
  let t = (await app.call('GET', '/tasks')).data;
  const dep = t.tasks.find((x) => x.kind === 'depends');
  assert.ok(dep, 'enough only if the salary comes in');
  assert.equal(dep.amount, 140000);
  assert.equal(dep.action.type, 'transfer');
  assert.equal(dep.action.from, other.id); // פועלים can give it
  assert.equal(t.minus.expected.length, 0);
  assert.equal(t.minus.depends[0].name, 'עו"ש');
  assert.deepEqual(t.minus.depends[0].on, ['משכורת']);
  assert.ok(!t.tasks.some((x) => x.kind === 'charge' && x.action.to === acc.id), 'one task per account');
  const charge = t.tasks.find((x) => x.kind === 'charge' && x.action.to === other.id);
  assert.ok(charge, 'make sure 400 is in פועלים');
  assert.equal(charge.level, 'info');
  assert.match(charge.detail, /יישאר/);

  // others' money used in פועלים: the task is a transfer back into it
  await app.call('POST', '/held', { name: 'נחמן', amount: 6000, in_balance: true, account_id: other.id });
  t = (await app.call('GET', '/tasks')).data;
  const owed = t.tasks.find((x) => x.kind === 'owed');
  assert.equal(owed.action.type, 'transfer');
  assert.equal(owed.action.to, other.id);
  assert.equal(owed.amount, 100000);
});

test('deleting a confirmed salary sends it back to "waiting"; "did not happen" can be undone', async () => {
  const { app, acc } = await ready();
  const today = todayFor(app.env);
  const r = (await app.call('POST', '/recurring', { kind: 'income', name: 'משכורת', amount: 6000, account_id: acc.id, day_of_month: Number(today.slice(8, 10)), start_date: today, auto: false })).data;
  const c = await app.call('POST', `/recurring/${r.id}/confirm`, { occurrence: today, amount: 5800 });
  assert.equal((await app.call('DELETE', `/transactions/${c.data.id}`)).status, 204);
  assert.ok((await app.call('GET', '/dashboard')).data.pending.some((p) => p.recurring_id === r.id), 'waiting again');
  await app.call('POST', `/recurring/${r.id}/skip`, { occurrence: today });
  assert.ok(!(await app.call('GET', '/dashboard')).data.pending.some((p) => p.recurring_id === r.id));
  assert.equal((await app.call('GET', '/recurring/skips')).data[0].name, 'משכורת');
  await app.call('DELETE', `/recurring/${r.id}/skip/${today}`);
  assert.ok((await app.call('GET', '/dashboard')).data.pending.some((p) => p.recurring_id === r.id), 'waiting after undo');
});


test('phone line: shekels*agorot, a spoken or typed note, or none', async () => {
  const { parseIvrAmount } = await import('../src/ivr.js');
  assert.equal(parseIvrAmount('12'), 1200);
  assert.equal(parseIvrAmount('12*50'), 1250);
  assert.equal(parseIvrAmount('12*5'), 1205);
  assert.equal(parseIvrAmount('0*90'), 90);
  assert.equal(parseIvrAmount('12*'), null);
  assert.equal(parseIvrAmount('0'), null);
  assert.equal(parseIvrAmount('1*2*3'), null);

  const { app } = await ready();
  const key = (await app.call('GET', '/settings')).data.ivr_key;
  const base = { key, ApiPhone: '0583206823', ApiCallId: 'n1', m0: '1', a0: '23*40', c0: '0', p0: '0' };
  assert.match(await ivr(app, { ...base, n0: '1' }), /=t0,no,voice,he-IL,/); // speech to text
  assert.match(await ivr(app, { ...base, n0: '2' }), /=t0,no,60,1,10,HebrewKeyboard,/); // typing letters
  const confirm = await ivr(app, { ...base, n0: '1', t0: 'קניות בשוק' });
  assert.match(confirm, /23 שקלים ו 40 אגורות/);
  assert.match(confirm, /הערה: קניות בשוק/);
  assert.match(await ivr(app, { ...base, n0: '1', t0: 'קניות בשוק', k0: '1' }), /נשמר/);
  const tx = (await app.call('GET', `/transactions?month=${todayFor(app.env).slice(0, 7)}`)).data.items.find((x) => x.source === 'phone');
  assert.equal(tx.amount, 2340);
  assert.equal(tx.note, 'קניות בשוק');
  // nothing said: saved without a note
  const b2 = { ...base, ApiCallId: 'n2', n0: '1', t0: 'None' };
  const c2 = await ivr(app, b2);
  assert.match(c2, /=k0,/);
  assert.doesNotMatch(c2, /הערה:/);
});

test('a different amount this time for an automatic monthly expense (credit / partial month)', async () => {
  const { app, acc } = await ready();
  const today = todayFor(app.env);
  await app.call('PATCH', `/accounts/${acc.id}`, { opening_date: today, opening_balance: 1000 });
  const soon = addDays(today, 5);
  const r = (await app.call('POST', '/recurring', { kind: 'expense', name: 'חשמל', amount: 300, account_id: acc.id, day_of_month: Number(soon.slice(8, 10)), start_date: today })).data;
  const occ = (await app.call('GET', `/recurring/${r.id}/occurrences`)).data;
  const next = occ.find((o) => !o.past);
  assert.equal(next.amount, 30000);
  // this month: 120 after a credit
  assert.equal((await app.call('PUT', `/recurring/${r.id}/occurrences/${next.occurrence}`, { amount: 120, note: 'חשמל (זיכוי)' })).data.recorded, false);
  let fc = (await app.call('GET', '/forecast?days=10')).data;
  const ev = fc.events.find((e) => e.recurring_id === r.id && e.occurrence === next.occurrence);
  assert.equal(ev.amount, -12000);
  assert.equal(ev.changed, true);
  // the month after keeps the usual amount
  const after = (await app.call('GET', `/recurring/${r.id}/occurrences`)).data.filter((o) => !o.past)[1];
  assert.equal(after.amount, 30000);
  // back to the usual amount
  await app.call('DELETE', `/recurring/${r.id}/occurrences/${next.occurrence}`);
  fc = (await app.call('GET', '/forecast?days=10')).data;
  assert.equal(fc.events.find((e) => e.recurring_id === r.id).amount, -30000);
});

test('a different amount for an occurrence that was already recorded updates that entry', async () => {
  const { app, acc } = await ready();
  const today = todayFor(app.env);
  const r = (await app.call('POST', '/recurring', { kind: 'expense', name: 'ארנונה', amount: 500, account_id: acc.id, day_of_month: Number(today.slice(8, 10)), start_date: today })).data;
  await app.call('GET', '/dashboard'); // records today's
  const auto = (await app.call('GET', '/dashboard')).data.auto_recent.find((t) => t.recurring_id === r.id);
  assert.equal(auto.usual_amount, 50000);
  assert.equal((await app.call('PUT', `/recurring/${r.id}/occurrences/${today}`, { amount: 350 })).data.recorded, true);
  const tx = (await app.call('GET', `/transactions?month=${today.slice(0, 7)}`)).data.items.find((t) => t.recurring_id === r.id);
  assert.equal(tx.amount, 35000);
});

test('amounts with more than 2 decimals are rounded to agorot like the bank (6.065 -> 6.06)', async () => {
  const { toAgorot } = await import('../src/validate.js');
  assert.equal(toAgorot('6.065'), 606);
  assert.equal(toAgorot('6.075'), 608);
  assert.equal(toAgorot('6.0651'), 607);
  assert.equal(toAgorot('1.999'), 200);
  assert.equal(toAgorot('12,5'), 1250);
  const { app, acc } = await ready();
  const r = await app.call('POST', '/transactions', { kind: 'expense', amount: '6.065', date: todayFor(app.env), account_id: acc.id });
  assert.equal(r.status, 201);
  assert.equal(r.data.amount, 606);
});

test('paying for a friend: partial cash repayments, "they owe you", reports count it as less expense', async () => {
  const { app, acc, direct, food } = await ready();
  const today = todayFor(app.env);
  await app.call('PATCH', `/accounts/${acc.id}`, { opening_date: today, opening_balance: 1000 });
  const wallet = (await app.call('GET', '/lookups')).data.accounts.find((a) => a.kind === 'cash');
  const e = (await app.call('POST', '/transactions', { kind: 'expense', amount: 200, date: today, card_id: direct.id, category_id: food.id, note: 'מסעדה', for_name: 'יוסי' })).data;
  assert.equal(e.for_name, 'יוסי');
  let d = (await app.call('GET', '/dashboard')).data;
  assert.equal(d.owed.length, 1);
  assert.ok(d.tasks.tasks.some((t) => t.kind === 'owed_me' && t.amount === 20000));

  // he gives back 120 in cash
  const r1 = await app.call('POST', `/transactions/${e.id}/reimbursements`, { amount: 120 });
  assert.equal(r1.status, 201);
  assert.equal(r1.data.account_id, wallet.id);
  assert.equal(r1.data.reimburse_of, e.id);
  assert.equal((await app.call('POST', `/transactions/${e.id}/reimbursements`, { amount: 100 })).status, 400); // only 80 left
  d = (await app.call('GET', '/dashboard')).data;
  assert.equal(d.owed[0].repaid, 12000);
  assert.equal(d.accounts.find((a) => a.id === wallet.id).balance, 12000);
  assert.equal(d.accounts.find((a) => a.id === acc.id).balance, 80000);
  // reports: 200 - 120 = 80 expense on food, no income
  const s = (await app.call('GET', `/summary?month=${today.slice(0, 7)}`)).data;
  assert.equal(s.income, 0);
  assert.equal(s.expense, 8000);
  assert.equal(s.categories.find((c) => c.category_id === food.id).amount, 8000);

  // the rest, then nothing is owed
  await app.call('POST', `/transactions/${e.id}/reimbursements`, { amount: 80, account_id: acc.id });
  d = (await app.call('GET', '/dashboard')).data;
  assert.equal(d.owed.length, 0);
  assert.equal((await app.call('GET', `/transactions/${e.id}/reimbursements`)).data.length, 2);
  // any expense can get a repayment, even without a name
  const e2 = (await app.call('POST', '/transactions', { kind: 'expense', amount: 50, date: today, account_id: acc.id })).data;
  assert.equal((await app.call('POST', `/transactions/${e2.id}/reimbursements`, { amount: 20 })).status, 201);
});
