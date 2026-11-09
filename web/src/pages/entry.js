// Add / edit an income or expense. Built for the phone: amount first, then tap a category and a payment.
import { useState } from 'preact/hooks';
import { api } from '../api.js';
import { confirmBox, Field, html, Modal, num, Segments, shortDate, toast, toInput, useForm } from '../ui.js';

/** Same rule as the server: a regular card is charged on its billing day of the next month. */
function previewCharge(date, card) {
  if (!date || !card || card.kind !== 'regular' || !card.billing_day) return date;
  let [y, m] = date.split('-').map(Number);
  m += 1; if (m > 12) { m = 1; y += 1; }
  const last = new Date(y, m, 0).getDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(Math.min(card.billing_day, last)).padStart(2, '0')}`;
}

export function EntryForm({ tx, lookups, me, onClose, onSaved }) {
  const editing = Boolean(tx.id);
  const pay0 = tx.card_id ? `c${tx.card_id}` : tx.account_id ? `a${tx.account_id}` : editing ? 'cash' : '';
  const f = useForm({
    kind: tx.kind || 'expense',
    amount: toInput(tx.amount),
    category_id: tx.category_id ?? '',
    pay: pay0,
    date: tx.date || lookups.today,
    owner_id: editing ? tx.owner_id ?? '' : me.id,
    note: tx.note || '',
    charge_date: '',
  });
  const [more, setMore] = useState(false);
  const v = f.values;
  const cards = lookups.cards.filter((c) => c.is_active || `c${c.id}` === pay0);
  const accounts = lookups.accounts.filter((a) => a.is_active || `a${a.id}` === pay0);
  const cats = lookups.categories.filter((c) => c.kind === v.kind && (c.is_active || c.id === tx.category_id));
  const card = v.pay.startsWith('c') ? lookups.cards.find((c) => `c${c.id}` === v.pay) : null;
  const charge = v.charge_date || previewCharge(v.date, card);

  const save = (e) => {
    e?.preventDefault();
    if (!v.pay) return toast('בחרו איך שולם', 'bad');
    const body = {
      kind: v.kind, amount: v.amount, date: v.date, note: v.note,
      category_id: num(v.category_id), owner_id: num(v.owner_id),
      card_id: v.pay.startsWith('c') ? Number(v.pay.slice(1)) : null,
      account_id: v.pay.startsWith('a') ? Number(v.pay.slice(1)) : null,
    };
    if (v.charge_date) body.charge_date = v.charge_date;
    f.submit(() => (editing ? api.patch(`/transactions/${tx.id}`, body) : api.post('/transactions', body))).then((r) => {
      if (!r) return;
      toast(editing ? 'עודכן' : 'נשמר');
      onSaved(r);
    });
  };
  const remove = async () => {
    if (!(await confirmBox('למחוק את התנועה?', { ok: 'מחיקה', danger: true }))) return;
    await api.del(`/transactions/${tx.id}`).then(() => { toast('נמחק'); onSaved(); }, (e) => toast(e.message, 'bad'));
  };

  return html`<${Modal} title=${editing ? 'עריכת תנועה' : 'תנועה חדשה'} onClose=${onClose}>
    <form onSubmit=${save} class="entry">
      <${Segments} value=${v.kind} onChange=${(k) => f.setValues((s) => ({ ...s, kind: k, category_id: '' }))}
        options=${[{ value: 'expense', label: 'הוצאה' }, { value: 'income', label: 'הכנסה' }]} />
      <${Field} error=${f.errors.amount}>
        <div class=${`amount-input ${v.kind}`}><span>₪</span><input inputmode="decimal" placeholder="0" value=${v.amount} onInput=${f.set('amount')} autofocus required /></div>
      <//>

      <div class="label">קטגוריה</div>
      <div class="chips">
        ${cats.map((c) => html`<button type="button" class=${String(v.category_id) === String(c.id) ? 'chip on' : 'chip'} onClick=${() => f.set('category_id')(String(v.category_id) === String(c.id) ? '' : c.id)}>${c.name}</button>`)}
      </div>
      ${f.errors.category_id && html`<div class="err">${f.errors.category_id}</div>`}

      <div class="label">${v.kind === 'expense' ? 'איך שולם' : 'לאן נכנס'}</div>
      <div class="chips">
        ${v.kind === 'expense' && cards.map((c) => html`<button type="button" class=${v.pay === `c${c.id}` ? 'chip on' : 'chip'} onClick=${() => f.set('pay')(`c${c.id}`)}>💳 ${c.name}${c.last4 ? ` ${c.last4}` : ''}<small>${c.kind === 'direct' ? 'דיירקט' : `חיוב ב-${c.billing_day}`}</small></button>`)}
        ${accounts.map((a) => html`<button type="button" class=${v.pay === `a${a.id}` ? 'chip on' : 'chip'} onClick=${() => f.set('pay')(`a${a.id}`)}>🏦 ${a.name}<small>${v.kind === 'expense' ? 'העברה / הוראת קבע' : a.bank}</small></button>`)}
        <button type="button" class=${v.pay === 'cash' ? 'chip on' : 'chip'} onClick=${() => f.set('pay')('cash')}>💵 מזומן</button>
      </div>
      ${!cards.length && !accounts.length && html`<div class="hint">עדיין אין חשבונות וכרטיסים. מוסיפים אותם בהגדרות.</div>`}

      <div class="row2">
        <${Field} label="תאריך" error=${f.errors.date}><input type="date" value=${v.date} onInput=${f.set('date')} required /><//>
        <${Field} label="של מי">
          <select value=${v.owner_id} onChange=${f.set('owner_id')}>
            ${lookups.users.filter((u) => u.is_active || u.id === tx.owner_id).map((u) => html`<option value=${u.id}>${u.name}</option>`)}
            <option value="">משותף</option>
          </select>
        <//>
      </div>
      ${card && card.kind === 'regular' && html`<div class="hint">יחויב בחשבון ב-${shortDate(charge)}</div>`}
      <${Field} label="הערה"><input value=${v.note} onInput=${f.set('note')} placeholder="למשל: רמי לוי" /><//>

      ${more
        ? html`<${Field} label="תאריך חיוב בחשבון (אם שונה)" hint="ריק = לפי הכרטיס" error=${f.errors.charge_date}><input type="date" value=${v.charge_date} onInput=${f.set('charge_date')} /><//>`
        : html`<button type="button" class="link small" onClick=${() => setMore(true)}>תאריך חיוב אחר…</button>`}

      <div class="actions">
        <button class="btn primary" disabled=${f.busy}>${editing ? 'שמירה' : 'הוספה'}</button>
        ${editing && html`<button type="button" class="btn danger" onClick=${remove}>מחיקה</button>`}
      </div>
      ${editing && tx.source !== 'web' && html`<p class="hint">${tx.source === 'phone' ? 'נרשם מהטלפון' : 'נרשם אוטומטית מתנועה קבועה'}${tx.user_name ? ` · ${tx.user_name}` : ''}</p>`}
    </form>
  <//>`;
}
