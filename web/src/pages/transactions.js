// Entries of a month, grouped by day, with filters. Tap an entry to edit it.
import { useState } from 'preact/hooks';
import { ErrorBox, html, Loading, longDate, money, monthName, paymentName, shiftMonth, useApi, userName } from '../ui.js';

export function Transactions({ version, lookups, openEntry }) {
  const [month, setMonth] = useState(lookups.today.slice(0, 7));
  const [kind, setKind] = useState('');
  const [pay, setPay] = useState('');
  const [owner, setOwner] = useState('');
  const [cat, setCat] = useState('');
  const [q, setQ] = useState('');
  const qs = new URLSearchParams({ month });
  if (kind) qs.set('kind', kind);
  if (pay) qs.set(pay.startsWith('c') ? 'card_id' : 'account_id', pay.slice(1));
  if (owner) qs.set('owner_id', owner);
  if (cat) qs.set('category_id', cat);
  const { data, error, reload } = useApi(`/transactions?${qs}`, [version]);
  const catName = (id) => lookups.categories.find((c) => c.id === id)?.name;

  let items = data?.items || [];
  if (q) items = items.filter((t) => `${t.note} ${catName(t.category_id) || ''}`.includes(q));
  const groups = [];
  for (const t of items) {
    if (groups.at(-1)?.date !== t.date) groups.push({ date: t.date, items: [] });
    groups.at(-1).items.push(t);
  }
  const inc = items.filter((t) => t.kind === 'income').reduce((s, t) => s + t.amount, 0);
  const exp = items.filter((t) => t.kind === 'expense').reduce((s, t) => s + t.amount, 0);

  return html`
    <div class="month-nav">
      <button class="icon-btn" onClick=${() => setMonth(shiftMonth(month, -1))} aria-label="חודש קודם">›</button>
      <b>${monthName(month)}</b>
      <button class="icon-btn" onClick=${() => setMonth(shiftMonth(month, 1))} aria-label="חודש הבא">‹</button>
    </div>
    <div class="filters">
      <select value=${kind} onChange=${(e) => { setKind(e.target.value); setCat(''); }}><option value="">הכל</option><option value="expense">הוצאות</option><option value="income">הכנסות</option></select>
      <select value=${cat} onChange=${(e) => setCat(e.target.value)}><option value="">כל הקטגוריות</option>${lookups.categories.filter((c) => !kind || c.kind === kind).map((c) => html`<option value=${c.id}>${c.name}</option>`)}</select>
      <select value=${pay} onChange=${(e) => setPay(e.target.value)}><option value="">כל אמצעי התשלום</option>
        ${lookups.cards.map((c) => html`<option value=${`c${c.id}`}>💳 ${c.name}</option>`)}${lookups.accounts.map((a) => html`<option value=${`a${a.id}`}>🏦 ${a.name}</option>`)}</select>
      <select value=${owner} onChange=${(e) => setOwner(e.target.value)}><option value="">כולם</option>${lookups.users.map((u) => html`<option value=${u.id}>${u.name}</option>`)}</select>
      <input type="search" placeholder="חיפוש" value=${q} onInput=${(e) => setQ(e.target.value)} />
    </div>
    ${error && html`<${ErrorBox} error=${error} retry=${reload} />`}
    ${!data && !error && html`<${Loading} />`}
    ${data && html`<div class="totals small"><span>הכנסות <b class="income">${money(inc)}</b></span><span>הוצאות <b class="expense">${money(exp)}</b></span><span>${items.length} תנועות</span></div>`}
    ${data && !items.length && html`<p class="muted center">אין תנועות</p>`}
    ${groups.map((g) => html`<section class="card day">
      <h4>${longDate(g.date)}</h4>
      ${g.items.map((t) => html`<button class="list-row tx" onClick=${() => openEntry(t)}>
        <span><b>${t.note || catName(t.category_id) || (t.kind === 'income' ? 'הכנסה' : 'הוצאה')}</b>
          <span class="muted small">${[t.note && catName(t.category_id), paymentName(t, lookups), userName(t.owner_id, lookups), t.charge_date !== t.date && `חיוב ${t.charge_date.slice(8)}/${t.charge_date.slice(5, 7)}`, t.source === 'phone' && '☎', t.source === 'recurring' && '↻'].filter(Boolean).join(' · ')}</span></span>
        <b class=${t.kind}>${t.kind === 'expense' ? '−' : '+'}${money(t.amount)}</b>
      </button>`)}
    </section>`)}
  `;
}
