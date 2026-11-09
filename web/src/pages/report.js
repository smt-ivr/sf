// "Where did the money go": from the day tracking started (or another period), every shekel by
// category, payment method and person, per day, plus money that moved without being recorded.
import { useState } from 'preact/hooks';
import { ErrorBox, hebDate, html, Loading, longDate, money, paymentName, Segments, shiftMonth, shortDate, useApi, userName } from '../ui.js';

function monthBounds(ym) {
  const [y, m] = ym.split('-').map(Number);
  return { from: `${ym}-01`, to: `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}` };
}

export function Report({ version, lookups, openEntry }) {
  const [period, setPeriod] = useState('start');
  const [custom, setCustom] = useState({ from: lookups.today.slice(0, 8) + '01', to: lookups.today });
  const thisMonth = lookups.today.slice(0, 7);
  const range = period === 'month' ? monthBounds(thisMonth)
    : period === 'prev' ? monthBounds(shiftMonth(thisMonth, -1))
    : period === 'custom' ? custom : null;
  const qs = range ? `?from=${range.from}&to=${range.to > lookups.today && period === 'month' ? lookups.today : range.to}` : '';
  const { data, error, reload } = useApi(`/report${qs}`, [version]);
  const [open, setOpen] = useState(null); // expanded category key

  const head = html`
    <${Segments} value=${period} onChange=${(p) => { setPeriod(p); setOpen(null); }} options=${[
      { value: 'start', label: 'מההתחלה' }, { value: 'month', label: 'החודש' }, { value: 'prev', label: 'חודש שעבר' }, { value: 'custom', label: 'תאריכים' },
    ]} />
    ${period === 'custom' && html`<div class="row2">
      <input type="date" value=${custom.from} onChange=${(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
      <input type="date" value=${custom.to} onChange=${(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
    </div>`}`;
  if (error) return html`${head}<${ErrorBox} error=${error} retry=${reload} />`;
  if (!data) return html`${head}<${Loading} />`;

  const exp = data.categories.filter((c) => c.kind === 'expense');
  const inc = data.categories.filter((c) => c.kind === 'income');
  const pays = data.payments.filter((p) => p.kind === 'expense');
  const owners = data.owners.filter((o) => o.kind === 'expense').sort((a, b) => b.amount - a.amount);
  const pct = (a) => (data.expense ? Math.round((a / data.expense) * 100) : 0);

  return html`
    ${head}
    <section class="card">
      <p class="muted small">${period === 'start' ? 'מאז העסקה הראשונה: ' : ''}${shortDate(data.from)} (${hebDate(data.from)}) עד ${shortDate(data.to)} · ${data.days} ימים</p>
      <div class="kpis">
        <div><span class="muted small">נכנס</span><b class="income">${money(data.income)}</b></div>
        <div><span class="muted small">יצא</span><b class="expense">${money(data.expense)}</b></div>
        <div><span class="muted small">${data.net < 0 ? 'חסר' : 'נשאר'}</span><b class=${data.net < 0 ? 'expense' : 'income'}>${money(data.net)}</b></div>
      </div>
      <p class="muted small">בממוצע ${money(data.per_day)} הוצאות ליום · ${data.count} תנועות</p>
    </section>

    ${data.unrecorded !== 0 && html`<section class="card attention">
      <h3>⚠ ${money(Math.abs(data.unrecorded))} ${data.unrecorded < 0 ? 'יצאו בלי רישום' : 'נכנסו בלי רישום'}</h3>
      <p class="small">זה ההפרש שנמצא כשעדכנת יתרה ("כמה יש עכשיו"). ${data.unrecorded < 0 ? 'כלומר הוצאות ששכחת לרשום.' : 'כלומר הכנסות שלא נרשמו.'}</p>
      ${data.adjustments.map((a) => html`<div class="list-row small"><span>${a.account_kind === 'cash' ? '💵' : '🏦'} ${a.account_name}</span><b>${money(a.amount)}</b></div>`)}
    </section>`}

    <section class="card">
      <h3>לאן הלך הכסף</h3>
      ${!exp.length && html`<p class="muted small">עוד לא נרשמו הוצאות בתקופה הזו.</p>`}
      ${exp.map((c) => {
        const key = `e${c.category_id ?? 0}`;
        return html`<button class="bar-row tap" onClick=${() => setOpen(open === key ? null : key)}>
          <span>${c.name}</span><span class="bar"><i style=${`width:${Math.max(2, pct(c.amount))}%`}></i></span><b>${money(c.amount)} <span class="muted small">${pct(c.amount)}%</span></b>
        </button>
        ${open === key && html`<${CategoryItems} range=${{ from: data.from, to: data.to }} category=${c} lookups=${lookups} openEntry=${openEntry} version=${version} />`}`;
      })}
    </section>

    ${inc.length > 0 && html`<section class="card">
      <h3>מאיפה הגיע</h3>
      ${inc.map((c) => html`<div class="list-row"><span>${c.name} <span class="muted small">(${c.count})</span></span><b class="income">${money(c.amount)}</b></div>`)}
    </section>`}

    ${pays.length > 0 && html`<section class="card">
      <h3>איך שולם</h3>
      ${pays.map((p) => html`<div class="list-row"><span>${paymentName(p, lookups)} <span class="muted small">(${p.count})</span></span><b>${money(p.amount)}</b></div>`)}
    </section>`}

    ${owners.length > 1 && html`<section class="card">
      <h3>הוצאות לפי מי</h3>
      ${owners.map((o) => html`<div class="list-row"><span>${userName(o.owner_id, lookups)}</span><b>${money(o.amount)}</b></div>`)}
    </section>`}

    ${data.days.length > 0 && html`<section class="card">
      <h3>יום אחר יום</h3>
      ${[...data.days].reverse().map((d) => html`<div class="list-row small"><span>${longDate(d.date)}</span>
        <span class="end">${d.expense ? html`<b class="expense">−${money(d.expense)}</b>` : ''}${d.income ? html`<b class="income">+${money(d.income)}</b>` : ''}</span></div>`)}
    </section>`}
  `;
}

function CategoryItems({ range, category, lookups, openEntry, version }) {
  const qs = new URLSearchParams({ from: range.from, to: range.to, kind: 'expense' });
  if (category.category_id) qs.set('category_id', category.category_id);
  const { data } = useApi(`/transactions?${qs}`, [version]);
  if (!data) return html`<${Loading} />`;
  const items = category.category_id ? data.items : data.items.filter((t) => !t.category_id);
  return html`<div class="sub-list">
    ${items.map((t) => html`<button class="list-row tx small" onClick=${() => openEntry(t)}>
      <span>${shortDate(t.date)} · ${t.note || 'ללא הערה'} <span class="muted">· ${paymentName(t, lookups)}</span></span><b>${money(t.amount)}</b>
    </button>`)}
  </div>`;
}
