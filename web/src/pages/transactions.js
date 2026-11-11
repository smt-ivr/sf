// Entries of a month, grouped by day, with filters. Tap an entry to edit it.
import { useState } from 'preact/hooks';
import { api } from '../api.js';
import { confirmBox, ErrorBox, html, Loading, longDate, money, monthName, paymentName, shiftMonth, toast, useApi, userName } from '../ui.js';

const MOVE_ICON = { adjust: '⚖', transfer: '⇄', held: '🤝' };

export function Transactions({ version, lookups, openEntry, refresh }) {
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
  const moves = q ? [] : (data?.moves || []).filter((m) => m.account_id); // held money already inside the balance moves nothing
  const byDate = new Map();
  for (const t of items) (byDate.get(t.date) || byDate.set(t.date, { date: t.date, items: [], moves: [] }).get(t.date)).items.push(t);
  for (const m of moves) (byDate.get(m.date) || byDate.set(m.date, { date: m.date, items: [], moves: [] }).get(m.date)).moves.push(m);
  const groups = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
  const removeMove = async (m) => {
    if (!(await confirmBox(m.kind === 'transfer' ? 'למחוק את ההעברה (משני הצדדים)?' : 'למחוק את הרישום?', { ok: 'מחיקה', danger: true }))) return;
    api.del(`/moves/${m.id}`).then(() => { toast('נמחק'); refresh(); }, (e) => toast(e.message, 'bad'));
  };
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
    ${data && !groups.length && html`<p class="muted center">אין תנועות</p>`}
    ${groups.map((g) => html`<section class="card day">
      <h4>${longDate(g.date)}</h4>
      ${g.items.map((t) => html`<button class="list-row tx" onClick=${() => openEntry(t)}>
        <span><b>${t.note || catName(t.category_id) || (t.kind === 'income' ? 'הכנסה' : 'הוצאה')}</b>
          <span class="muted small">${[t.note && catName(t.category_id), paymentName(t, lookups), userName(t.owner_id, lookups), t.charge_date !== t.date && `חיוב ${t.charge_date.slice(8)}/${t.charge_date.slice(5, 7)}`, t.source === 'phone' && '☎', t.source === 'recurring' && '↻', t.for_name && `בשביל ${t.for_name}${t.repaid ? ` (הוחזר ${money(t.repaid)})` : ''}`, t.reimburse_of && '↩ החזר, לא הכנסה'].filter(Boolean).join(' · ')}</span></span>
        <b class=${t.kind}>${t.kind === 'expense' ? '−' : '+'}${money(t.amount)}</b>
      </button>`)}
      ${g.moves.map((m) => html`<button class="list-row tx move" onClick=${() => removeMove(m)} title="לחיצה למחיקה">
        <span><b>${MOVE_ICON[m.kind]} ${m.note || 'העברה'}</b><span class="muted small">${m.account_name}${m.held_name ? ` · ${m.held_name}` : ''} · לא נספר כהכנסה/הוצאה</span></span>
        <b class="muted">${m.amount > 0 ? '+' : '−'}${money(Math.abs(m.amount))}</b>
      </button>`)}
    </section>`)}
  `;
}
