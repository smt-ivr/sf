// Home: this month at a glance, balances, items waiting for confirmation, the next 30 days.
import { useState } from 'preact/hooks';
import { api } from '../api.js';
import { ErrorBox, Field, html, Loading, Modal, money, monthName, shortDate, toast, toInput, useApi, useForm, paymentName } from '../ui.js';

export function Home({ version, lookups, openEntry, refresh }) {
  const { data, error, loading, reload } = useApi('/dashboard', [version]);
  const [confirming, setConfirming] = useState(null);
  if (error) return html`<${ErrorBox} error=${error} retry=${reload} />`;
  if (!data) return html`<${Loading} />`;
  const { month, previous_month: prev, accounts, pending, forecast: fc, recent } = data;
  const active = accounts.filter((a) => a.is_active);
  const total = active.reduce((s, a) => s + a.balance, 0);
  const catName = (id) => lookups.categories.find((c) => c.id === id)?.name;

  if (!lookups.accounts.length) {
    return html`<div class="card welcome">
      <h2>ברוכים הבאים 👋</h2>
      <p>כדי להתחיל, מגדירים את חשבונות הבנק ואת כרטיסי האשראי, ואחר כך את ההכנסות וההוצאות הקבועות (משכורות, הוראות קבע).</p>
      <a class="btn primary" href="#/settings">להגדרות</a>
    </div>`;
  }

  return html`
    <section class="card month">
      <div class="month-head"><h2>${monthName(data.today.slice(0, 7))}</h2><a class="link small" href="#/tx">לכל התנועות</a></div>
      <div class="kpis">
        <div><span class="muted small">הכנסות</span><b class="income">${money(month.income)}</b></div>
        <div><span class="muted small">הוצאות</span><b class="expense">${money(month.expense)}</b></div>
        <div><span class="muted small">נשאר</span><b class=${month.net < 0 ? 'expense' : ''}>${money(month.net)}</b></div>
      </div>
      ${prev.expense > 0 && html`<p class="muted small">בחודש שעבר: הוצאות ${money(prev.expense)}, הכנסות ${money(prev.income)}</p>`}
      ${month.categories.filter((c) => c.kind === 'expense').slice(0, 5).map((c) => html`<div class="bar-row">
        <span>${c.name}</span><span class="bar"><i style=${`width:${Math.max(3, (c.amount / Math.max(month.expense, 1)) * 100)}%`}></i></span><b>${money(c.amount)}</b>
      </div>`)}
    </section>

    ${pending.length > 0 && html`<section class="card attention">
      <h3>ממתין לאישור</h3>
      ${pending.map((p) => html`<div class="list-row">
        <div><b>${p.name}</b><div class="muted small">${shortDate(p.occurrence)} · צפוי ${money(p.amount)}</div></div>
        <button class="btn small primary" onClick=${() => setConfirming(p)}>${p.kind === 'income' ? 'נכנס' : 'יצא'}</button>
      </div>`)}
    </section>`}

    <section class="card">
      <div class="month-head"><h3>יתרות</h3><b class=${total < 0 ? 'expense' : ''}>${money(total)}</b></div>
      ${active.map((a) => html`<div class="list-row"><span>🏦 ${a.name} <span class="muted small">${a.bank}</span></span><b class=${a.balance < 0 ? 'expense' : ''}>${money(a.balance)}</b></div>`)}
      ${fc.events.length > 0 && html`<p class=${`small ${fc.lowest.balance < 0 ? 'expense' : 'muted'}`}>
        צפי בעוד 30 יום: ${money(fc.end_balance)}${fc.lowest.balance < total ? ` · הנקודה הנמוכה: ${money(fc.lowest.balance)} ב-${shortDate(fc.lowest.date)}` : ''}
      </p>`}
    </section>

    ${fc.events.length > 0 && html`<section class="card">
      <div class="month-head"><h3>בקרוב</h3><a class="link small" href="#/forecast">לצפי המלא</a></div>
      ${fc.events.slice(0, 6).map((e) => html`<div class="list-row">
        <span><span class="date-pill">${shortDate(e.date)}</span> ${e.name}${e.count > 1 ? html` <span class="muted small">(${e.count})</span>` : ''}</span>
        <b class=${e.amount < 0 ? 'expense' : 'income'}>${money(e.amount)}</b>
      </div>`)}
    </section>`}

    <section class="card">
      <h3>נרשמו לאחרונה</h3>
      ${recent.length === 0 && html`<p class="muted">עוד לא נרשמו תנועות. לוחצים על + למטה.</p>`}
      ${recent.map((t) => html`<button class="list-row tx" onClick=${() => openEntry(t)}>
        <span><b>${t.note || catName(t.category_id) || (t.kind === 'income' ? 'הכנסה' : 'הוצאה')}</b>
          <span class="muted small">${shortDate(t.date)} · ${paymentName(t, lookups)}${t.source === 'phone' ? ' · ☎' : ''}</span></span>
        <b class=${t.kind}>${t.kind === 'expense' ? '−' : '+'}${money(t.amount)}</b>
      </button>`)}
    </section>

    ${confirming && html`<${ConfirmRecurring} item=${confirming} onClose=${() => setConfirming(null)} onDone=${() => { setConfirming(null); refresh(); }} />`}
  `;
}

function ConfirmRecurring({ item, onClose, onDone }) {
  const f = useForm({ amount: toInput(item.amount), date: item.occurrence });
  const ok = (e) => {
    e.preventDefault();
    f.submit(() => api.post(`/recurring/${item.recurring_id}/confirm`, { occurrence: item.occurrence, amount: f.values.amount, date: f.values.date })).then((r) => r && (toast('נרשם'), onDone()));
  };
  const skip = () => api.post(`/recurring/${item.recurring_id}/skip`, { occurrence: item.occurrence }).then(() => (toast('דולג'), onDone()), (e) => toast(e.message, 'bad'));
  return html`<${Modal} title=${item.name} onClose=${onClose}>
    <form onSubmit=${ok}>
      <${Field} label="הסכום בפועל" error=${f.errors.amount}><input inputmode="decimal" value=${f.values.amount} onInput=${f.set('amount')} autofocus /><//>
      <${Field} label="תאריך" error=${f.errors.date}><input type="date" value=${f.values.date} onInput=${f.set('date')} /><//>
      <div class="actions"><button class="btn primary" disabled=${f.busy}>אישור</button><button type="button" class="btn" onClick=${skip}>לא היה הפעם</button></div>
    </form>
  <//>`;
}
