// Modals for money that is not income/expense: correcting a balance ("I have X now"), transfers
// (cash withdrawal), and money held for others.
import { useState } from 'preact/hooks';
import { api } from '../api.js';
import { accIcon, confirmBox, ErrorBox, Field, html, Loading, Modal, money, Segments, shortDate, toast, toInput, useApi, useForm } from '../ui.js';

/** One account: update its real balance, or move money to/from another account. */
export function AccountModal({ account, lookups, onClose, onDone }) {
  const [tab, setTab] = useState('balance');
  const others = lookups.accounts.filter((a) => a.id !== account.id && a.is_active);
  const cash = others.find((a) => a.kind === 'cash');
  const bal = useForm({ balance: toInput(account.balance), date: lookups.today });
  const tr = useForm({ dir: account.kind === 'cash' ? 'in' : 'out', other: (account.kind === 'cash' ? others.find((a) => a.kind === 'bank') : cash)?.id ?? others[0]?.id ?? '', amount: '', date: lookups.today, note: '' });

  const saveBalance = (e) => {
    e.preventDefault();
    bal.submit(() => api.post(`/accounts/${account.id}/balance`, bal.values)).then((r) => {
      if (!r) return;
      toast(r.difference ? `עודכן (${r.difference > 0 ? '+' : ''}${money(r.difference)})` : 'היתרה כבר נכונה');
      onDone();
    });
  };
  const saveTransfer = (e) => {
    e.preventDefault();
    const v = tr.values;
    const body = { amount: v.amount, date: v.date, note: v.note, from_account_id: v.dir === 'out' ? account.id : Number(v.other), to_account_id: v.dir === 'out' ? Number(v.other) : account.id };
    tr.submit(() => api.post('/transfers', body)).then((r) => r && (toast('נשמר'), onDone()));
  };

  return html`<${Modal} title=${`${accIcon(account)} ${account.name}`} onClose=${onClose}>
    <p class="muted">יתרה לפי המערכת: <b>${money(account.balance)}</b></p>
    <${Segments} value=${tab} onChange=${setTab} options=${[{ value: 'balance', label: 'עדכון יתרה' }, { value: 'transfer', label: account.kind === 'cash' ? 'משיכה / הפקדה' : 'העברה' }]} />
    ${tab === 'balance' && html`<form onSubmit=${saveBalance}>
      <p class="hint">${account.kind === 'cash' ? 'ספרו כמה מזומן יש לכם עכשיו.' : 'כמה יש בחשבון לפי הבנק.'} ההפרש נרשם כ"עדכון יתרה" (לא כהכנסה או הוצאה).</p>
      <${Field} label="כמה יש עכשיו (₪)" error=${bal.errors.balance}><input inputmode="decimal" value=${bal.values.balance} onInput=${bal.set('balance')} autofocus /><//>
      <${Field} label="נכון לתאריך" error=${bal.errors.date}><input type="date" value=${bal.values.date} onInput=${bal.set('date')} /><//>
      <button class="btn primary" disabled=${bal.busy}>עדכון</button>
    </form>`}
    ${tab === 'transfer' && html`<form onSubmit=${saveTransfer}>
      ${!others.length ? html`<p class="muted">אין חשבון נוסף להעביר אליו.</p>` : html`
        <${Segments} value=${tr.values.dir} onChange=${tr.set('dir')} options=${[{ value: 'out', label: `מ${account.name} אל…` }, { value: 'in', label: `אל ${account.name} מ…` }]} />
        <div class="row2">
          <${Field} label=${tr.values.dir === 'out' ? 'אל' : 'מ'}><select value=${tr.values.other} onChange=${tr.set('other')}>${others.map((a) => html`<option value=${a.id}>${accIcon(a)} ${a.name}</option>`)}</select><//>
          <${Field} label="סכום (₪)" error=${tr.errors.amount}><input inputmode="decimal" value=${tr.values.amount} onInput=${tr.set('amount')} required /><//>
        </div>
        <div class="row2">
          <${Field} label="תאריך"><input type="date" value=${tr.values.date} onInput=${tr.set('date')} /><//>
          <${Field} label="הערה"><input value=${tr.values.note} onInput=${tr.set('note')} placeholder="משיכת מזומן" /><//>
        </div>
        <button class="btn primary" disabled=${tr.busy}>שמירה</button>`}
    </form>`}
  <//>`;
}

/** Money held for others: who, how much is still held, receiving more / returning. */
export function HeldModal({ lookups, onClose, onDone }) {
  const { data, error, reload } = useApi('/held');
  const [adding, setAdding] = useState(false);
  const [moving, setMoving] = useState(null); // { fund, direction }
  const changed = () => { reload(); onDone(); };
  return html`<${Modal} title="כסף של אחרים" onClose=${onClose}>
    <p class="hint">כסף שנמצא אצלך (בבנק או במזומן) אבל לא שלך, עד שיבקשו אותו. הוא נשאר ביתרה, ומוצג בנפרד כדי שתראה כמה באמת שלך.</p>
    ${error && html`<${ErrorBox} error=${error} retry=${reload} />`}
    ${!data && !error && html`<${Loading} />`}
    ${data && html`
      ${data.funds.filter((f) => f.is_active || f.balance).map((f) => html`<div class="card held">
        <div class="month-head"><b>${f.name}</b><b>${money(f.balance)}</b></div>
        <div class="row2 small">
          <span class="muted">נמצא ב:</span>
          <select value=${f.account_id ?? ''} onChange=${(e) => api.patch(`/held/${f.id}`, { account_id: Number(e.target.value) }).then(changed, (er) => toast(er.message, 'bad'))}>
            ${f.account_id == null && html`<option value="">בחרו חשבון</option>`}${accountOptions(lookups)}
          </select>
        </div>
        ${f.note && html`<div class="muted small">${f.note}</div>`}
        ${f.moves.slice(0, 5).map((m) => html`<div class="list-row small"><span>${shortDate(m.date)} · ${m.note}${m.account_name ? ` · ${m.account_name}` : ''}</span><b class=${m.held_amount < 0 ? 'expense' : 'income'}>${money(m.held_amount)}</b></div>`)}
        <div class="actions">
          <button class="btn small" onClick=${() => setMoving({ fund: f, direction: 'out' })} disabled=${f.balance <= 0}>החזרתי לו</button>
          <button class="btn small" onClick=${() => setMoving({ fund: f, direction: 'in' })}>קיבלתי עוד</button>
          ${f.balance === 0 && html`<button class="btn small danger" onClick=${async () => { if (await confirmBox(`למחוק את ${f.name}?`, { ok: 'מחיקה', danger: true })) api.del(`/held/${f.id}`).then(changed); }}>מחיקה</button>`}
        </div>
      </div>`)}
      ${!data.funds.length && html`<p class="muted">אין כרגע.</p>`}
      <button class="btn primary" onClick=${() => setAdding(true)}>+ כסף של מישהו</button>
    `}
    ${adding && html`<${NewHeld} lookups=${lookups} onClose=${() => setAdding(false)} onDone=${() => { setAdding(false); changed(); }} />`}
    ${moving && html`<${HeldMove} ...${moving} lookups=${lookups} onClose=${() => setMoving(null)} onDone=${() => { setMoving(null); changed(); }} />`}
  <//>`;
}

const accountOptions = (lookups) => lookups.accounts.filter((a) => a.is_active).map((a) => html`<option value=${a.id}>${accIcon(a)} ${a.name}</option>`);
const firstBank = (lookups) => (lookups.accounts.find((a) => a.is_active && a.kind === 'bank') || lookups.accounts[0])?.id ?? '';

function NewHeld({ lookups, onClose, onDone }) {
  const f = useForm({ name: '', amount: '', in_balance: '1', account_id: firstBank(lookups), note: '', date: lookups.today });
  const v = f.values;
  const save = (e) => {
    e.preventDefault();
    f.submit(() => api.post('/held', { name: v.name, amount: v.amount, note: v.note, date: v.date, in_balance: v.in_balance === '1', account_id: Number(v.account_id) })).then((r) => r && (toast('נשמר'), onDone()));
  };
  return html`<${Modal} title="כסף של מישהו אחר" onClose=${onClose}><form onSubmit=${save}>
    <div class="row2">
      <${Field} label="של מי" error=${f.errors.name}><input value=${v.name} onInput=${f.set('name')} required /><//>
      <${Field} label="סכום (₪)" error=${f.errors.amount}><input inputmode="decimal" value=${v.amount} onInput=${f.set('amount')} required /><//>
    </div>
    <${Field} label="באיזה חשבון הכסף נמצא" error=${f.errors.account_id} hint="לשם צריך להחזיר אותו"><select value=${v.account_id} onChange=${f.set('account_id')}>${accountOptions(lookups)}</select><//>
    <div class="row2">
      <${Field} label="הכסף…">
        <select value=${v.in_balance} onChange=${f.set('in_balance')}>
          <option value="1">כבר בחשבון (כלול ביתרה)</option>
          <option value="0">נכנס עכשיו</option>
        </select>
      <//>
      ${v.in_balance === '0' && html`<${Field} label="תאריך"><input type="date" value=${v.date} onInput=${f.set('date')} /><//>`}
    </div>
    <${Field} label="הערה"><input value=${v.note} onInput=${f.set('note')} placeholder="למשל: עד שיבקש" /><//>
    <button class="btn primary" disabled=${f.busy}>שמירה</button>
  </form><//>`;
}

function HeldMove({ fund, direction, lookups, onClose, onDone }) {
  const f = useForm({ amount: direction === 'out' ? toInput(fund.balance) : '', account_id: fund.account_id ?? firstBank(lookups), date: lookups.today, note: '' });
  const save = (e) => {
    e.preventDefault();
    const v = f.values;
    f.submit(() => api.post(`/held/${fund.id}/moves`, { direction, amount: v.amount, account_id: v.account_id ? Number(v.account_id) : null, date: v.date, note: v.note })).then((r) => r && (toast('נשמר'), onDone()));
  };
  return html`<${Modal} title=${direction === 'out' ? `החזרה ל${fund.name}` : `קיבלתי מ${fund.name}`} onClose=${onClose}><form onSubmit=${save}>
    ${direction === 'out' && html`<p class="hint">אצלך כרגע ${money(fund.balance)} שלו.</p>`}
    <div class="row2">
      <${Field} label="סכום (₪)" error=${f.errors.amount}><input inputmode="decimal" value=${f.values.amount} onInput=${f.set('amount')} required autofocus /><//>
      <${Field} label=${direction === 'out' ? 'יצא מ' : 'נכנס ל'}><select value=${f.values.account_id} onChange=${f.set('account_id')}>${accountOptions(lookups)}<option value="">לא דרך חשבון</option></select><//>
    </div>
    <div class="row2">
      <${Field} label="תאריך"><input type="date" value=${f.values.date} onInput=${f.set('date')} /><//>
      <${Field} label="הערה"><input value=${f.values.note} onInput=${f.set('note')} /><//>
    </div>
    <button class="btn primary" disabled=${f.busy}>שמירה</button>
  </form><//>`;
}
