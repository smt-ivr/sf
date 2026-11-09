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
  assert.equal((await app.call('GET', '/settings')).data.ivr_link.startsWith('https://smti.uk/sf/api/ivr?key='), true);
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
  const key = new URL((await app.call('GET', '/settings')).data.ivr_link).searchParams.get('key');

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
  const confirm = await ivr(app, { ...base, m0: '1', a0: '75', c0: ci, p0: '1' });
  assert.match(confirm, /75 שקלים/);
  const done = { ...base, m0: '1', a0: '75', c0: ci, p0: '1', k0: '1' };
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
  await app.call('POST', `/accounts/${acc.id}/balance`, { balance: 351 }); // 1000 + 500 - 999 = 501 computed (card not charged yet) -> 150 unrecorded
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

test('an expense dated before the balance was entered, but recorded after it, lowers the balance', async () => {
  const { app, acc, direct } = await ready();
  const today = todayFor(app.env);
  await app.call('PATCH', `/accounts/${acc.id}`, { opening_date: today, opening_balance: 3892.38 });
  await app.call('POST', '/transactions', { kind: 'expense', amount: 400, date: '2020-01-06', card_id: direct.id });
  const a = (await app.call('GET', '/dashboard')).data.accounts.find((x) => x.id === acc.id);
  assert.equal(a.balance, 349238);
  // someone's money that came in last month is already inside the balance entered
  await app.call('POST', '/held', { name: 'נחמן', amount: 4000, in_balance: false, account_id: acc.id, date: '2020-01-04' });
  const d = (await app.call('GET', '/dashboard')).data;
  assert.equal(d.accounts.find((x) => x.id === acc.id).balance, 349238);
  assert.equal(d.forecast.per_account.find((x) => x.account_id === acc.id).mine, 349238 - 400000);
  // and it is part of "since we started recording"
  assert.equal((await app.call('GET', '/report')).data.expense >= 40000, true);
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
