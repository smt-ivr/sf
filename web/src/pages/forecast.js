// Cash-flow forecast: what will leave/enter the bank accounts day by day, with the running balance.
import { useState } from 'preact/hooks';
import { ErrorBox, html, Loading, longDate, money, Segments, useApi } from '../ui.js';

const TYPE = { card_bill: '💳', recurring: '↻', pending: '⏳', entry: '•' };

export function Forecast({ version }) {
  const [days, setDays] = useState(30);
  const { data, error, reload } = useApi(`/forecast?days=${days}`, [version]);
  if (error) return html`<${ErrorBox} error=${error} retry=${reload} />`;

  const groups = [];
  for (const e of data?.events || []) {
    if (groups.at(-1)?.date !== e.date) groups.push({ date: e.date, items: [] });
    groups.at(-1).items.push(e);
  }
  return html`
    <${Segments} value=${days} onChange=${setDays} options=${[{ value: 14, label: 'שבועיים' }, { value: 30, label: 'חודש' }, { value: 60, label: 'חודשיים' }, { value: 90, label: '3 חודשים' }]} />
    ${!data && html`<${Loading} />`}
    ${data && html`
      <section class="card kpis">
        <div><span class="muted small">היום</span><b>${money(data.start_balance)}</b></div>
        <div><span class="muted small">בסוף התקופה</span><b class=${data.end_balance < 0 ? 'expense' : ''}>${money(data.end_balance)}</b></div>
        <div><span class="muted small">הכי נמוך</span><b class=${data.lowest.balance < 0 ? 'expense' : ''}>${money(data.lowest.balance)}</b></div>
      </section>
      ${!groups.length && html`<p class="muted center">אין תנועות צפויות בתקופה הזו. מוסיפים הכנסות והוצאות קבועות בהגדרות ← קבועות.</p>`}
      ${groups.map((g) => html`<section class="card day">
        <h4>${longDate(g.date)}</h4>
        ${g.items.map((e) => html`<div class="list-row">
          <span>${TYPE[e.type]} ${e.name}${e.count > 1 ? html` <span class="muted small">(${e.count} רכישות)</span>` : ''}${e.type === 'pending' ? html` <span class="muted small">(טרם אושר)</span>` : ''}</span>
          <span class="end"><b class=${e.amount < 0 ? 'expense' : 'income'}>${money(e.amount)}</b><span class=${`small ${e.balance_after < 0 ? 'expense' : 'muted'}`}>${money(e.balance_after)}</span></span>
        </div>`)}
      </section>`)}
      <p class="muted small">💳 חיוב כרטיס אשראי (רכישות שכבר נעשו) · ↻ תנועה קבועה · ⏳ ממתין לאישור. מזומן לא נכלל ביתרה.</p>
    `}
  `;
}
