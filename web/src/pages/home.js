// Home: how much money is really yours (without others' money, unless you ask), banks and cash apart,
// whether everything is under control, each account's outlook, what comes next, this month.
import { useState } from 'preact/hooks';
import { accIcon, ErrorBox, hebDate, html, Loading, money, monthName, paymentName, shortDate, useApi } from '../ui.js';
import { AccountModal, ConfirmModal, HeldModal, OccurrenceModal } from './money.js';
import { StatusBanner, TaskItem, useTaskActions } from './tasks.js';

const KEY = 'sf.withOthers';
const readPref = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };

export function Home({ version, lookups, openEntry, refresh }) {
  const { data, error, reload } = useApi('/dashboard', [version]);
  const [withOthers, setWithOthers] = useState(readPref);
  const [account, setAccount] = useState(null);
  const [held, setHeld] = useState(false);
  const [confirming, setConfirming] = useState(null);
  const [changing, setChanging] = useState(null);
  const { run, modal } = useTaskActions(lookups, data?.accounts || [], refresh);
  const toggle = () => { const v = !withOthers; setWithOthers(v); try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* ignore */ } };

  if (error) return html`<${ErrorBox} error=${error} retry=${reload} />`;
  if (!data) return html`<${Loading} />`;
  if (!lookups.accounts.some((a) => a.kind === 'bank')) {
    return html`<div class="card welcome">
      <h2>ברוכים הבאים 👋</h2>
      <p>כדי להתחיל, מגדירים את חשבונות הבנק ואת כרטיסי האשראי, ואחר כך את ההכנסות וההוצאות הקבועות (משכורות, הוראות קבע).</p>
      <a class="btn primary" href="#/settings">להגדרות</a>
    </div>`;
  }

  const { month, forecast: fc, recent, held: heldData, tasks, since } = data;
  const per = fc.per_account;
  const show = (pa) => (withOthers ? pa.balance : pa.mine);
  const banks = per.filter((p) => p.kind === 'bank');
  const cash = per.filter((p) => p.kind === 'cash');
  const sum = (list) => list.reduce((s, p) => s + show(p), 0);
  const bankSum = sum(banks);
  const cashSum = sum(cash);
  const used = per.reduce((s, p) => s + (p.others && p.mine < 0 ? -p.mine : 0), 0); // others' money already spent
  const heldNames = heldData.funds.filter((f) => f.is_active && f.balance > 0).map((f) => f.name).join(', ');
  const catName = (id) => lookups.categories.find((c) => c.id === id)?.name;
  const upcoming = fc.events.slice(0, 7);

  const accRow = (pa) => html`<button class=${`acc-row ${pa.need ? 'short' : ''}`} onClick=${() => setAccount({ ...data.accounts.find((x) => x.id === pa.account_id), forecast: pa })}>
    <div class="acc-top"><span class="acc-name">${accIcon(pa)} ${pa.name}</span><b class=${show(pa) < 0 ? 'expense' : ''}>${money(show(pa))}</b></div>
    ${pa.others !== 0 && html`<div class="small muted">${withOthers ? `כולל ${money(pa.others)} של אחרים · שלך ${money(pa.mine)}` : `בבנק ${money(pa.balance)}, מתוכם ${money(pa.others)} של אחרים`}</div>`}
    ${pa.mine < 0 && pa.others !== 0 && html`<div class="small expense">חסר ${money(-pa.mine)} להחזיר לכאן</div>`}
    ${(pa.out || pa.in) ? html`<div class="small muted">30 יום: ${pa.out ? `יוצא ${money(pa.out)}` : ''}${pa.out && pa.in ? ' · ' : ''}${pa.in ? `נכנס ${money(pa.in)}` : ''}</div>` : ''}
    ${pa.events.filter((e) => e.type === 'move').map((e) => html`<div class="small pending-move">⏳ ${e.amount > 0 ? 'ייכנס' : 'ייצא'} ${money(Math.abs(e.amount))} ב-${shortDate(e.date)} · ${e.name}</div>`)}
    ${pa.need > 0 && html`<div class="small expense"><b>⚠ להכניס ${money(pa.need)} עד ${shortDate(pa.short_by.date)}</b> · ${pa.short_by.name}</div>`}
  </button>`;

  return html`
    <section class="hero">
      <div class="hero-head">
        <span>${withOthers ? 'כל הכסף שיש (כולל של אחרים)' : 'הכסף שלך'}</span>
        <button class=${`chip-toggle ${withOthers ? 'on' : ''}`} onClick=${toggle} aria-pressed=${withOthers}>${withOthers ? '✓ ' : ''}כולל כסף של אחרים</button>
      </div>
      <div class="hero-tiles">
        <div class="tile"><span>🏦 בבנקים</span><b class=${bankSum < 0 ? 'neg' : ''}>${money(bankSum)}</b></div>
        <div class="tile"><span>💵 במזומן</span><b class=${cashSum < 0 ? 'neg' : ''}>${money(cashSum)}</b></div>
      </div>
      ${heldData.total > 0
        ? html`<button class="hero-note" onClick=${() => setHeld(true)}>
            ${withOthers ? `כולל ${money(heldData.total)} של ${heldNames}` : `לא כולל ${money(heldData.total)} של ${heldNames}`}${used > 0 ? ` · השתמשת ב-${money(used)} מהם` : ''} ›
          </button>`
        : html`<button class="hero-note" onClick=${() => setHeld(true)}>🤝 כסף של אחרים ›</button>`}
    </section>

    <section class="card">
      <${StatusBanner} tasks=${tasks} compact />
      ${tasks.tasks.slice(0, 3).map((t) => html`<${TaskItem} task=${t} onAction=${run} />`)}
      ${tasks.tasks.length > 0 && html`<a class="link small" href="#/tasks">${tasks.tasks.length > 3 ? `לכל ${tasks.tasks.length} המשימות ›` : 'למשימות ›'}</a>`}
    </section>

    <section class="card">
      <div class="month-head"><h3>חשבונות בנק</h3><b class=${bankSum < 0 ? 'expense' : ''}>${money(bankSum)}</b></div>
      ${banks.map(accRow)}
    </section>

    ${cash.length > 0 && html`<section class="card">
      <div class="month-head"><h3>מזומן</h3><b class=${cashSum < 0 ? 'expense' : ''}>${money(cashSum)}</b></div>
      ${cash.map(accRow)}
      <p class="muted small">לוחצים על ארנק כדי לעדכן כמה מזומן יש בפועל.</p>
    </section>`}

    ${upcoming.length > 0 && html`<section class="card">
      <div class="month-head"><h3>מה הלאה</h3><a class="link small" href="#/forecast">לצפי המלא ›</a></div>
      ${upcoming.map((e) => html`<div class="list-row">
        <span><span><span class="date-pill">${shortDate(e.date)}</span> ${e.name}</span>
          <span class="muted small">${per.find((p) => p.account_id === e.account_id)?.name || ''}${e.type === 'pending' ? ' · ממתין לאישור' : ''}</span></span>
        <span class="end">
          <b class=${e.amount < 0 ? 'expense' : 'income'}>${money(e.amount)}</b>
          ${(e.type === 'recurring' || e.type === 'pending') && e.amount > 0 && html`<button class="link small" onClick=${() => setConfirming({ recurring_id: e.recurring_id, occurrence: e.occurrence, name: e.name, amount: e.amount, kind: 'income' })}>נכנס?</button>`}
          ${e.type === 'recurring' && e.amount < 0 && html`<button class="link small" onClick=${() => setChanging({ recurring_id: e.recurring_id, occurrence: e.occurrence, name: e.name, amount: -e.amount, usual_amount: e.usual_amount, changed: e.changed, kind: 'expense' })}>${e.changed ? 'סכום שונה ✎' : 'סכום אחר?'}</button>`}
        </span>
      </div>`)}
    </section>`}

    <section class="card">
      <div class="month-head"><h3>${monthName(data.today.slice(0, 7))} <span class="muted small">${hebDate(data.today)}</span></h3><a class="link small" href="#/report">לאן הלך הכסף ›</a></div>
      <div class="kpis">
        <div><span class="muted small">נכנס</span><b class="income">${money(month.income)}</b></div>
        <div><span class="muted small">יצא</span><b class="expense">${money(month.expense)}</b></div>
        <div><span class="muted small">${month.net < 0 ? 'חסר' : 'נשאר'}</span><b class=${month.net < 0 ? 'expense' : 'income'}>${money(month.net)}</b></div>
      </div>
      ${month.categories.filter((c) => c.kind === 'expense').slice(0, 4).map((c) => html`<div class="bar-row">
        <span>${c.name}</span><span class="bar"><i style=${`width:${Math.max(3, (c.amount / Math.max(month.expense, 1)) * 100)}%`}></i></span><b>${money(c.amount)}</b>
      </div>`)}
      <p class="muted small">מאז העסקה הראשונה (${shortDate(since.tracking_start)}): נכנס ${money(since.income)}, יצא ${money(since.expense)}${since.unrecorded < 0 ? html` · <span class="expense">${money(-since.unrecorded)} יצאו בלי רישום</span>` : ''}</p>
    </section>

    ${data.auto_recent.length > 0 && html`<section class="card">
      <h3>יצא ונכנס אוטומטית לאחרונה</h3>
      <p class="muted small">יצא סכום אחר ממה שרשום (זיכוי, חיוב יחסי)? לוחצים "סכום אחר?" ומתקנים. היתרה מתעדכנת.</p>
      ${data.auto_recent.map((t) => html`<div class="list-row">
        <button class="plain" onClick=${() => openEntry(t)}><b>${t.recurring_name}</b>
          <span class="muted small">${shortDate(t.date)} · ${paymentName(t, lookups)}${t.amount !== t.usual_amount ? ` · רגיל ${money(t.usual_amount)}` : ''}</span></button>
        <span class="end">
          <b class=${t.kind}>${t.kind === 'expense' ? '−' : '+'}${money(t.amount)}${t.amount !== t.usual_amount ? ' ✎' : ''}</b>
          <button class="link small" onClick=${() => setChanging({ recurring_id: t.recurring_id, occurrence: t.occurrence, name: t.recurring_name, amount: t.amount, usual_amount: t.usual_amount, changed: t.amount !== t.usual_amount, transaction_id: t.id, note: t.note !== t.recurring_name ? t.note : '', kind: t.kind })}>סכום אחר?</button>
        </span>
      </div>`)}
    </section>`}

    <section class="card">
      <h3>נרשמו לאחרונה</h3>
      ${recent.length === 0 && html`<p class="muted">עוד לא נרשמו תנועות. לוחצים על + למטה.</p>`}
      ${recent.map((t) => html`<button class="list-row tx" onClick=${() => openEntry(t)}>
        <span><b>${t.note || catName(t.category_id) || (t.kind === 'income' ? 'הכנסה' : 'הוצאה')}</b>
          <span class="muted small">${shortDate(t.date)} · ${paymentName(t, lookups)}${t.source === 'phone' ? ' · ☎' : ''}${t.source === 'recurring' ? ' · ↻' : ''}</span></span>
        <b class=${t.kind}>${t.kind === 'expense' ? '−' : '+'}${money(t.amount)}</b>
      </button>`)}
    </section>

    ${account && html`<${AccountModal} account=${account} lookups=${lookups} onClose=${() => setAccount(null)} onDone=${() => { setAccount(null); refresh(); }} />`}
    ${held && html`<${HeldModal} lookups=${lookups} onClose=${() => setHeld(false)} onDone=${refresh} />`}
    ${changing && html`<${OccurrenceModal} item=${changing} onClose=${() => setChanging(null)} onDone=${() => { setChanging(null); refresh(); }} />`}
    ${confirming && html`<${ConfirmModal} item=${confirming} lookups=${lookups} onClose=${() => setConfirming(null)} onDone=${() => { setConfirming(null); refresh(); }} />`}
    ${modal}
  `;
}
