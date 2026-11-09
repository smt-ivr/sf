// Yemot HaMashiach phone line (type=api). The caller is recognised by caller ID (sf_user_phones).
//
// Stateless: Yemot sends back every value collected in the call. Each "round" (one entry, or one report)
// uses its own value names (m3, a3, c3, ...), where the round number is kept in sf_ivr_calls. Finishing a
// round bumps the number, so the next round asks fresh questions, and a retried request cannot save twice.
//
// Round: m = menu (1 expense, 2 income, 3 month status, 0 end) -> a = amount in shekels -> c = category
//        -> p = payment (card / account / cash) -> k = confirm (1 save, 2 cancel)
import { all, first, nowSec, run } from './db.js';
import { insertTransaction, summary, balances, syncRecurring, todayFor, forecast, heldFunds } from './money.js';
import { addDays, monthRange } from './dates.js';
import { getSettings } from './settings.js';
import { normalizePhone } from './validate.js';

// ------------------------------------------------------------------ Yemot protocol
const RESERVED = /[.\-"'&|=׳״,]/g; // characters Yemot treats as syntax inside messages
export const t = (s) => `t-${String(s).replace(RESERVED, ' ').replace(/\s+/g, ' ').trim()}`;
const join = (parts) => parts.flat().filter(Boolean).join('.');
const message = (parts) => `id_list_message=${join(parts)}`;
/** Keypad read. Options: val_name, re_enter_if_exists, max, min, sec_wait, playback, block *, block 0, replace, allowed, attempts, allow_empty, empty_val, block_change_keyboard */
const read = (parts, name, { max = 1, min = 1, wait = 10 } = {}) =>
  `read=${join(parts)}=${[name, 'no', max, min, wait, 'No', 'yes', 'no', '', '', 2, 'Ok', 'None', ''].join(',')}`;
const respond = (...cmds) => new Response(cmds.filter(Boolean).join('&'), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const goodbye = (parts) => respond(message(parts), '');

/** 1234.5 shekels -> words Yemot reads well ("1234 שקלים ו 50 אגורות"). */
export function speakMoney(agorot) {
  const neg = agorot < 0;
  const a = Math.abs(agorot);
  const s = Math.floor(a / 100);
  const ag = a % 100;
  return `${neg ? 'מינוס ' : ''}${s} ${s === 1 ? 'שקל' : 'שקלים'}${ag ? ` ו ${ag} אגורות` : ''}`;
}

async function readParams(request, url) {
  const merged = new URLSearchParams(url.search);
  if (request.method === 'POST') {
    const type = request.headers.get('Content-Type') || '';
    const body = type.includes('json') ? new URLSearchParams(Object.entries(await request.json().catch(() => ({})))) : new URLSearchParams(await request.text());
    for (const [k, v] of body) merged.append(k, v);
  }
  return Object.fromEntries(merged); // Yemot may repeat a key; the last one wins
}

// ------------------------------------------------------------------ entry point
export async function handleIvr({ env, request, url }) {
  try {
    return await handle(env, await readParams(request, url));
  } catch (err) {
    console.error('[ivr]', err?.stack || err);
    return goodbye([t('אירעה תקלה, נסו שוב מאוחר יותר')]);
  }
}

async function handle(env, p) {
  if (p.hangup === 'yes') return respond('');
  const s = await getSettings(env);
  if (!s.ivr_key || p.key !== s.ivr_key) return goodbye([t('הגישה לשלוחה זו חסומה')]);
  if (s.ivr_enabled !== '1') return goodbye([t('השלוחה סגורה כרגע')]);

  const phone = normalizePhone(p.ApiPhone);
  const user = phone
    ? await first(env, `SELECT u.* FROM sf_users u JOIN sf_user_phones ph ON ph.user_id = u.id WHERE ph.phone = ? AND u.is_active = 1`, phone)
    : null;
  if (!user) return goodbye([t('מספר הטלפון שממנו התקשרתם אינו מחובר למערכת')]);

  const callId = String(p.ApiCallId || `phone-${phone}`).slice(0, 100);
  await run(env, `INSERT OR IGNORE INTO sf_ivr_calls (call_id, saved, created_at) VALUES (?, 0, ?)`, callId, nowSec());
  const n = (await first(env, `SELECT saved FROM sf_ivr_calls WHERE call_id = ?`, callId)).saved;
  if (n === 0) await syncRecurring(env);
  return round(env, { p, n, user, callId });
}

/** Ends the current round (only once, even if Yemot repeats the request) and shows the menu again. */
async function nextRound(env, c, say) {
  const res = await run(env, `UPDATE sf_ivr_calls SET saved = saved + 1 WHERE call_id = ? AND saved = ?`, c.callId, c.n);
  return { advanced: res.meta.changes === 1, response: menu(c.n + 1, say) };
}

const menu = (n, say = []) =>
  respond(read([...say, t('להוספת הוצאה הקישו 1, להוספת הכנסה 2, לשמיעת מצב החודש 3, לסיום 0')], `m${n}`));

async function round(env, c) {
  const { p, n } = c;
  const v = (k) => p[`${k}${n}`];
  const m = v('m');
  if (m === undefined) return menu(n, n === 0 ? [t(`שלום ${c.user.name}`)] : []);
  if (m === '0') return goodbye([t('להתראות')]);
  if (m === '3') return (await nextRound(env, c, await status(env))).response;
  if (m !== '1' && m !== '2') return (await nextRound(env, c, [t('בחירה לא קיימת')])).response;
  const kind = m === '1' ? 'expense' : 'income';

  // amount
  const a = v('a');
  if (a === undefined) return respond(read([t('הקישו את הסכום בשקלים ובסיום סולמית')], `a${n}`, { max: 7 }));
  const amount = Number(a) * 100;
  if (!Number.isInteger(amount) || amount <= 0) return (await nextRound(env, c, [t('הסכום לא תקין')])).response;

  // category
  const cats = await all(env, `SELECT id, name FROM sf_categories WHERE kind = ? AND is_active = 1 ORDER BY sort, id LIMIT 99`, kind);
  const cv = v('c');
  if (cv === undefined) {
    const parts = cats.map((x, i) => t(`ל${x.name} הקישו ${i + 1}`));
    return respond(read([t('בחירת קטגוריה'), ...parts, t('ללא קטגוריה הקישו 0')], `c${n}`, { max: cats.length > 9 ? 2 : 1 }));
  }
  const cat = Number(cv) === 0 ? null : cats[Number(cv) - 1];
  if (cat === undefined) return (await nextRound(env, c, [t('קטגוריה לא קיימת')])).response;

  // payment: cards (expenses only), then bank accounts, 0 = cash
  const methods = [
    ...(kind === 'expense' ? (await all(env, `SELECT id, name, kind FROM sf_cards WHERE is_active = 1 ORDER BY sort, id`)).map((x) => ({ card_id: x.id, name: `כרטיס ${x.name}` })) : []),
    ...(await all(env, `SELECT id, name FROM sf_accounts WHERE is_active = 1 AND kind = 'bank' ORDER BY sort, id`)).map((x) => ({ account_id: x.id, name: `חשבון ${x.name}` })),
  ].slice(0, 99);
  const pv = v('p');
  if (pv === undefined) {
    const parts = methods.map((x, i) => t(`${x.name} הקישו ${i + 1}`));
    return respond(read([t(kind === 'expense' ? 'איך שולם' : 'לאן נכנס הכסף'), ...parts, t('מזומן הקישו 0')], `p${n}`, { max: methods.length > 9 ? 2 : 1 }));
  }
  const method = Number(pv) === 0 ? { name: 'מזומן' } : methods[Number(pv) - 1];
  if (!method) return (await nextRound(env, c, [t('אמצעי תשלום לא קיים')])).response;

  // confirm
  const k = v('k');
  const what = `${kind === 'expense' ? 'הוצאה' : 'הכנסה'} של ${speakMoney(amount)}${cat ? `, ${cat.name}` : ''}, ${method.name}`;
  if (k === undefined) return respond(read([t(what), t('לאישור הקישו 1, לביטול 2')], `k${n}`));
  if (k !== '1') return (await nextRound(env, c, [t('בוטל')])).response;

  const { advanced, response } = await nextRound(env, c, [t('נשמר')]);
  if (advanced) {
    await insertTransaction(
      env,
      { kind, amount, date: todayFor(env), category_id: cat?.id ?? null, card_id: method.card_id ?? null, account_id: method.account_id ?? null, owner_id: c.user.id, note: '' },
      { userId: c.user.id, source: 'phone' }
    );
  }
  return response;
}

/** "Month status": this month's income and expenses, money in the accounts, and what is expected this week. */
async function status(env) {
  const today = todayFor(env);
  const { from, to } = monthRange(today.slice(0, 7));
  const [sum, accs, fc, held] = await Promise.all([summary(env, from, to), balances(env, today), forecast(env, addDays(today, 7), today), heldFunds(env)]);
  const active = accs.filter((a) => a.is_active);
  const bank = active.filter((a) => a.kind === 'bank').reduce((s, a) => s + a.balance, 0);
  const cash = active.filter((a) => a.kind === 'cash').reduce((s, a) => s + a.balance, 0);
  const out = [
    t(`החודש נכנסו ${speakMoney(sum.income)}`),
    t(`ויצאו ${speakMoney(sum.expense)}`),
    t(`יתרה בבנק ${speakMoney(bank)}`),
  ];
  if (cash) out.push(t(`במזומן ${speakMoney(cash)}`));
  if (held.total) out.push(t(`מתוך זה ${speakMoney(held.total)} של אחרים, ושלך ${speakMoney(bank + cash - held.total)}`));
  const week = fc.events.reduce((s, e) => s + e.amount, 0);
  if (fc.events.length) out.push(t(`בשבוע הקרוב צפויים ${speakMoney(Math.abs(week))} ${week < 0 ? 'לצאת' : 'להיכנס'}`));
  return out;
}
