// Fixed income/expenses: salaries, standing orders, subscriptions, loans.
import { useState } from 'preact/hooks';
import { OccurrenceModal } from './money.js';
import { api } from '../api.js';
import { confirmBox, ErrorBox, Field, gematria, html, Loading, Modal, money, num, Segments, toast, toInput, useApi, useForm, paymentName, userName, shortDate } from '../ui.js';

const when = (r) => (r.calendar === 'hebrew'
  ? `ב-${gematria(r.day_of_month)} לחודש העברי${r.day_of_month === 1 ? ' (ראש חודש)' : ''}`
  : `ב-${r.day_of_month} ${r.interval_months === 1 ? 'לכל חודש' : `כל ${r.interval_months} חודשים`}`);

export function Recurring({ version, lookups, refresh }) {
  const { data, error, reload } = useApi('/recurring', [version]);
  const skips = useApi('/recurring/skips', [version]);
  const [edit, setEdit] = useState(null);
  const unskip = (s) => api.del(`/recurring/${s.recurring_id}/skip/${s.occurrence}`).then(() => { toast('הוחזר'); skips.reload(); refresh(); }, (e) => toast(e.message, 'bad'));
  if (error) return html`<${ErrorBox} error=${error} retry=${reload} />`;
  if (!data) return html`<${Loading} />`;
  const section = (kind, title) => {
    const items = data.filter((r) => r.kind === kind);
    const monthly = items.filter((r) => r.is_active).reduce((s, r) => s + r.amount / r.interval_months, 0);
    return html`<section class="card">
      <div class="month-head"><h3>${title}</h3><span class="muted small">בחודש: ${money(monthly)}</span></div>
      ${!items.length && html`<p class="muted small">אין עדיין</p>`}
      ${items.map((r) => html`<button class=${`list-row tx ${r.is_active ? '' : 'inactive'}`} onClick=${() => setEdit(r)}>
        <span><b>${r.name}</b><span class="muted small">${[when(r), paymentName(r, lookups), userName(r.owner_id, lookups), r.auto ? 'נרשם אוטומטית' : 'דורש אישור', !r.is_active && 'מושבת'].filter(Boolean).join(' · ')}</span></span>
        <b class=${kind}>${money(r.amount)}</b>
      </button>`)}
      <button class="btn small" onClick=${() => setEdit({ kind })}>+ ${kind === 'income' ? 'הכנסה קבועה' : 'הוצאה קבועה'}</button>
    </section>`;
  };
  return html`
    <a class="link small" href="#/settings">← להגדרות</a>
    ${skips.data?.length > 0 && html`<section class="card">
      <h3>סומנו "לא היה הפעם"</h3>
      <p class="muted small">אם סימנת בטעות (או מחקת תנועה אוטומטית), לוחצים "החזרה" והיא תחזור לחכות לאישור או תירשם שוב.</p>
      ${skips.data.map((s) => html`<div class="list-row">
        <span><b>${s.name}</b><span class="muted small">${shortDate(s.occurrence)} · ${money(s.amount)}</span></span>
        <button class="btn small" onClick=${() => unskip(s)}>החזרה</button>
      </div>`)}
    </section>`}
    ${section('income', 'הכנסות קבועות')}
    ${section('expense', 'הוצאות קבועות')}
    <p class="muted small">"נרשם אוטומטית": ביום שלו התנועה נרשמת לבד (מתאים להוראות קבע בסכום קבוע). "דורש אישור": מופיע בדף הבית ב"ממתין לאישור", ושם מאשרים עם הסכום בפועל (מתאים למשכורת שמשתנה).</p>
    ${edit && html`<${RecurringForm} item=${edit} lookups=${lookups} onClose=${() => setEdit(null)} onSaved=${() => { setEdit(null); reload(); refresh(); }} />`}
  `;
}

function RecurringForm({ item, lookups, onClose, onSaved }) {
  const editing = Boolean(item.id);
  const f = useForm({
    kind: item.kind || 'expense', name: item.name || '', amount: toInput(item.amount), category_id: item.category_id ?? '',
    pay: item.card_id ? `c${item.card_id}` : item.account_id ? `a${item.account_id}` : editing ? 'cash' : '',
    owner_id: item.owner_id ?? '', day_of_month: item.day_of_month ?? 1, calendar: item.calendar || 'gregorian', interval_months: item.interval_months ?? 1,
    start_date: item.start_date || lookups.today, end_date: item.end_date || '', auto: item.auto ?? (item.kind !== 'income' ? 1 : 0),
    is_active: item.is_active ?? 1, note: item.note || '',
  });
  const v = f.values;
  const save = (e) => {
    e.preventDefault();
    const body = {
      kind: v.kind, name: v.name, amount: v.amount, category_id: num(v.category_id), owner_id: num(v.owner_id),
      card_id: v.pay.startsWith('c') ? Number(v.pay.slice(1)) : null, account_id: v.pay.startsWith('a') ? Number(v.pay.slice(1)) : null,
      day_of_month: Number(v.day_of_month), calendar: v.calendar, interval_months: v.calendar === 'hebrew' ? 1 : Number(v.interval_months), start_date: v.start_date, end_date: v.end_date || null,
      auto: Boolean(Number(v.auto)), is_active: Boolean(Number(v.is_active)), note: v.note,
    };
    f.submit(() => (editing ? api.patch(`/recurring/${item.id}`, body) : api.post('/recurring', body))).then((r) => r && (toast('נשמר'), onSaved()));
  };
  const remove = async () => {
    if (!(await confirmBox('למחוק? תנועות שכבר נרשמו יישארו.', { ok: 'מחיקה', danger: true }))) return;
    api.del(`/recurring/${item.id}`).then(() => (toast('נמחק'), onSaved()), (e) => toast(e.message, 'bad'));
  };
  return html`<${Modal} title=${editing ? 'עריכת תנועה קבועה' : 'תנועה קבועה חדשה'} onClose=${onClose}>
    <form onSubmit=${save}>
      <${Segments} value=${v.kind} onChange=${(k) => f.setValues((s) => ({ ...s, kind: k, category_id: '' }))} options=${[{ value: 'expense', label: 'הוצאה' }, { value: 'income', label: 'הכנסה' }]} />
      <${Field} label="שם" error=${f.errors.name}><input value=${v.name} onInput=${f.set('name')} placeholder=${v.kind === 'income' ? 'משכורת' : 'שכירות / ועד בית / חשמל'} required /><//>
      <div class="label">לפי לוח</div>
      <${Segments} value=${v.calendar} onChange=${(c) => f.setValues((s) => ({ ...s, calendar: c, day_of_month: Math.min(Number(s.day_of_month) || 1, c === 'hebrew' ? 30 : 31) }))}
        options=${[{ value: 'gregorian', label: 'תאריך לועזי' }, { value: 'hebrew', label: 'תאריך עברי' }]} />
      <div class="row2">
        <${Field} label="סכום (₪)" error=${f.errors.amount} hint="אם משתנה: סכום משוער"><input inputmode="decimal" value=${v.amount} onInput=${f.set('amount')} required /><//>
        ${v.calendar === 'hebrew'
          ? html`<${Field} label="יום בחודש העברי" error=${f.errors.day_of_month}><select value=${v.day_of_month} onChange=${f.set('day_of_month')}>${Array.from({ length: 30 }, (_, i) => i + 1).map((d) => html`<option value=${d}>${gematria(d)}${d === 1 ? ' (ראש חודש)' : ''}</option>`)}</select><//>`
          : html`<${Field} label="יום בחודש" error=${f.errors.day_of_month}><input type="number" min="1" max="31" value=${v.day_of_month} onInput=${f.set('day_of_month')} required /><//>`}
      </div>
      <div class="row2">
        ${v.calendar === 'hebrew'
          ? html`<${Field} label="כל כמה חודשים"><select disabled><option>כל חודש עברי</option></select><//>`
          : html`<${Field} label="כל כמה חודשים"><select value=${v.interval_months} onChange=${f.set('interval_months')}>${[1, 2, 3, 6, 12].map((n) => html`<option value=${n}>${n === 1 ? 'כל חודש' : n === 12 ? 'פעם בשנה' : `כל ${n} חודשים`}</option>`)}</select><//>`}
        <${Field} label="קטגוריה" error=${f.errors.category_id}><select value=${v.category_id} onChange=${f.set('category_id')}><option value="">ללא</option>${lookups.categories.filter((c) => c.kind === v.kind && c.is_active).map((c) => html`<option value=${c.id}>${c.name}</option>`)}</select><//>
      </div>
      <${Field} label=${v.kind === 'income' ? 'נכנס לחשבון' : 'משולם דרך'} error=${f.errors.card_id || f.errors.account_id}>
        <select value=${v.pay} onChange=${f.set('pay')}>
          <option value="" disabled>בחרו</option>
          ${v.kind === 'expense' && lookups.cards.filter((c) => c.is_active).map((c) => html`<option value=${`c${c.id}`}>💳 ${c.name}</option>`)}
          ${lookups.accounts.filter((a) => a.is_active).map((a) => html`<option value=${`a${a.id}`}>${a.kind === 'cash' ? '💵' : '🏦'} ${a.name}</option>`)}
          ${!lookups.accounts.some((a) => a.kind === 'cash') && html`<option value="cash">💵 מזומן</option>`}
        </select>
      <//>
      <div class="row2">
        <${Field} label="של מי"><select value=${v.owner_id} onChange=${f.set('owner_id')}><option value="">משותף</option>${lookups.users.map((u) => html`<option value=${u.id}>${u.name}</option>`)}</select><//>
        <${Field} label="רישום"><select value=${v.auto} onChange=${f.set('auto')}><option value="1">אוטומטי</option><option value="0">דורש אישור</option></select><//>
      </div>
      <div class="row2">
        <${Field} label="מתאריך" error=${f.errors.start_date}><input type="date" value=${v.start_date} onInput=${f.set('start_date')} /><//>
        <${Field} label="עד תאריך" error=${f.errors.end_date} hint="ריק = ללא סוף"><input type="date" value=${v.end_date} onInput=${f.set('end_date')} /><//>
      </div>
      ${editing && html`<${Field} label="מצב"><select value=${v.is_active} onChange=${f.set('is_active')}><option value="1">פעיל</option><option value="0">מושבת</option></select><//>`}
      <div class="actions">
        <button class="btn primary" disabled=${f.busy || !v.pay}>שמירה</button>
        ${editing && html`<button type="button" class="btn danger" onClick=${remove}>מחיקה</button>`}
      </div>
    </form>
    ${editing && html`<${Occurrences} item=${item} />`}
  <//>`;
}

/** The last and coming times of a recurring item, each with its amount; tap to change it for that time. */
function Occurrences({ item }) {
  const { data, reload } = useApi(`/recurring/${item.id}/occurrences`);
  const [open, setOpen] = useState(null);
  if (!data) return null;
  return html`<div class="card held">
    <b class="small">סכום לפי חודש</b>
    <p class="hint">יצא סכום אחר באחד החודשים (זיכוי, חיוב יחסי)? לוחצים עליו ומשנים רק אותו.</p>
    ${data.map((o) => html`<button type="button" class="list-row tx small" onClick=${() => !o.skipped && setOpen(o)}>
      <span>${shortDate(o.occurrence)} ${o.skipped ? '· לא היה' : o.transaction_id ? '· נרשם' : o.past ? '· ממתין' : ''}${o.note && o.changed ? ` · ${o.note}` : ''}</span>
      <b class=${o.changed ? 'expense' : ''}>${money(o.amount)}${o.changed ? ' ✎' : ''}</b>
    </button>`)}
    ${open && html`<${OccurrenceModal} item=${{ ...open, recurring_id: item.id, name: item.name, kind: item.kind }} onClose=${() => setOpen(null)} onDone=${() => { setOpen(null); reload(); }} />`}
  </div>`;
}
