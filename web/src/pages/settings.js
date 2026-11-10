// Settings: bank accounts, credit cards, categories, users (phones, e-mail), the phone line, password.
import { useState } from 'preact/hooks';
import { api } from '../api.js';
import { confirmBox, ErrorBox, Field, html, Loading, Modal, money, num, Segments, toast, toInput, useApi, useForm, userName } from '../ui.js';

export function Settings(props) {
  const { lookups, refresh, logout, me } = props;
  const [open, setOpen] = useState(null); // {type, item}
  const done = () => { setOpen(null); refresh(); };
  const close = () => setOpen(null);
  const accName = (id) => lookups.accounts.find((a) => a.id === id)?.name || '';

  return html`
    <a class="card nav-card" href="#/recurring"><span>↻ הכנסות והוצאות קבועות</span><span class="muted small">משכורות, הוראות קבע, מנויים ›</span></a>

    <section class="card">
      <div class="month-head"><h3>חשבונות ומזומן</h3><button class="btn small" onClick=${() => setOpen({ type: 'account', item: {} })}>+ חשבון</button></div>
      ${!lookups.accounts.length && html`<p class="muted small">מתחילים כאן: הוסיפו את חשבונות הבנק שלכם.</p>`}
      ${lookups.accounts.map((a) => html`<button class=${`list-row tx ${a.is_active ? '' : 'inactive'}`} onClick=${() => setOpen({ type: 'account', item: a })}>
        <span><b>${a.kind === 'cash' ? '💵' : '🏦'} ${a.name}</b><span class="muted small">${[a.bank, a.branch && `סניף ${a.branch}`, a.number, userName(a.owner_id, lookups), !a.is_active && 'לא פעיל'].filter(Boolean).join(' · ')}</span></span><span class="muted">›</span>
      </button>`)}
    </section>

    <section class="card">
      <div class="month-head"><h3>כרטיסי אשראי</h3><button class="btn small" disabled=${!lookups.accounts.length} onClick=${() => setOpen({ type: 'card', item: {} })}>+ כרטיס</button></div>
      ${lookups.cards.map((c) => html`<button class=${`list-row tx ${c.is_active ? '' : 'inactive'}`} onClick=${() => setOpen({ type: 'card', item: c })}>
        <span><b>💳 ${c.name}${c.last4 ? ` · ${c.last4}` : ''}</b><span class="muted small">${[c.kind === 'direct' ? 'דיירקט (יורד מיד)' : `רגיל · חיוב ב-${c.billing_day} לחודש`, `מחשבון ${accName(c.account_id)}`, userName(c.owner_id, lookups), !c.is_active && 'לא פעיל'].filter(Boolean).join(' · ')}</span></span><span class="muted">›</span>
      </button>`)}
    </section>

    <section class="card">
      <div class="month-head"><h3>קטגוריות</h3><button class="btn small" onClick=${() => setOpen({ type: 'category', item: {} })}>+ קטגוריה</button></div>
      ${['expense', 'income'].map((k) => html`<div class="label">${k === 'expense' ? 'הוצאות' : 'הכנסות'}</div><div class="chips">
        ${lookups.categories.filter((c) => c.kind === k).map((c) => html`<button class=${`chip ${c.is_active ? '' : 'inactive'}`} onClick=${() => setOpen({ type: 'category', item: c })}>${c.name}</button>`)}
      </div>`)}
    </section>

    <${Users} me=${me} onChange=${refresh} />
    <${PhoneLine} />
    <${MyPassword} />
    <button class="btn block" onClick=${logout}>יציאה</button>

    ${open?.type === 'account' && html`<${AccountForm} item=${open.item} lookups=${lookups} onClose=${close} onSaved=${done} />`}
    ${open?.type === 'card' && html`<${CardForm} item=${open.item} lookups=${lookups} onClose=${close} onSaved=${done} />`}
    ${open?.type === 'category' && html`<${CategoryForm} item=${open.item} onClose=${close} onSaved=${done} />`}
  `;
}

/** Shared save/delete for the small forms. */
function crud(path, item, onSaved) {
  return {
    save: (f, body) => f.submit(() => (item.id ? api.patch(`${path}/${item.id}`, body) : api.post(path, body))).then((r) => r && (toast('נשמר'), onSaved())),
    remove: async () => {
      if (!(await confirmBox('למחוק?', { ok: 'מחיקה', danger: true }))) return;
      api.del(`${path}/${item.id}`).then(() => (toast('נמחק'), onSaved()), (e) => toast(e.message, 'bad'));
    },
  };
}

const OwnerSelect = ({ value, onChange, lookups }) => html`<select value=${value ?? ''} onChange=${onChange}><option value="">משותף</option>${lookups.users.map((u) => html`<option value=${u.id}>${u.name}</option>`)}</select>`;
const ActiveSelect = ({ value, onChange }) => html`<select value=${value} onChange=${onChange}><option value="1">פעיל</option><option value="0">לא פעיל (מוסתר)</option></select>`;
const Buttons = ({ f, item, remove }) => html`<div class="actions"><button class="btn primary" disabled=${f.busy}>שמירה</button>${item.id && html`<button type="button" class="btn danger" onClick=${remove}>מחיקה</button>`}</div>`;

function AccountForm({ item, lookups, onClose, onSaved }) {
  const f = useForm({ kind: item.kind || 'bank', name: item.name || '', bank: item.bank || '', branch: item.branch || '', number: item.number || '', owner_id: item.owner_id ?? '', opening_balance: toInput(item.opening_balance ?? 0), opening_date: item.opening_date || lookups.today, is_active: item.is_active ?? 1 });
  const { save, remove } = crud('/accounts', item, onSaved);
  const v = f.values;
  const submit = (e) => { e.preventDefault(); save(f, { ...v, owner_id: num(v.owner_id), is_active: Boolean(Number(v.is_active)) }); };
  return html`<${Modal} title=${item.id ? v.name || 'חשבון' : 'חשבון חדש'} onClose=${onClose}><form onSubmit=${submit}>
    <${Segments} value=${v.kind} onChange=${f.set('kind')} options=${[{ value: 'bank', label: '🏦 חשבון בנק' }, { value: 'cash', label: '💵 מזומן (ארנק)' }]} />
    <${Field} label="שם" error=${f.errors.name}><input value=${v.name} onInput=${f.set('name')} placeholder=${v.kind === 'cash' ? 'מזומן' : 'עו״ש משותף'} required /><//>
    ${v.kind === 'bank' && html`<div class="row2">
      <${Field} label="בנק"><input value=${v.bank} onInput=${f.set('bank')} list="banks" /><//>
      <${Field} label="סניף"><input value=${v.branch} onInput=${f.set('branch')} inputmode="numeric" /><//>
    </div>`}
    <datalist id="banks">${['הפועלים', 'לאומי', 'דיסקונט', 'מזרחי טפחות', 'הבינלאומי', 'מרכנתיל', 'ירושלים', 'יהב', 'מסד', 'אוצר החייל', 'וואן זירו', 'הדואר'].map((b) => html`<option value=${b} />`)}</datalist>
    <div class="row2">
      ${v.kind === 'bank' && html`<${Field} label="מספר חשבון"><input value=${v.number} onInput=${f.set('number')} inputmode="numeric" dir="ltr" /><//>`}
      <${Field} label="של מי"><${OwnerSelect} value=${v.owner_id} onChange=${f.set('owner_id')} lookups=${lookups} /><//>
    </div>
    <div class="row2">
      <${Field} label="היתרה בבנק (₪)" error=${f.errors.opening_balance} hint="כמה היה בחשבון בתאריך שמשמאל. מינוס = חובה"><input inputmode="decimal" value=${v.opening_balance} onInput=${f.set('opening_balance')} /><//>
      <${Field} label="נכון לתאריך" hint="לפני החיובים של אותו יום. כל חיוב מהתאריך הזה והלאה יורד מהיתרה" error=${f.errors.opening_date}><input type="date" value=${v.opening_date} onInput=${f.set('opening_date')} /><//>
    </div>
    ${item.id && html`<${Field} label="מצב"><${ActiveSelect} value=${v.is_active} onChange=${f.set('is_active')} /><//>`}
    <${Buttons} f=${f} item=${item} remove=${remove} />
  </form><//>`;
}

function CardForm({ item, lookups, onClose, onSaved }) {
  const f = useForm({ name: item.name || '', last4: item.last4 || '', kind: item.kind || 'regular', account_id: item.account_id ?? lookups.accounts.find((a) => a.is_active)?.id ?? '', billing_day: item.billing_day ?? 10, owner_id: item.owner_id ?? '', is_active: item.is_active ?? 1 });
  const { save, remove } = crud('/cards', item, onSaved);
  const v = f.values;
  const submit = (e) => { e.preventDefault(); save(f, { ...v, account_id: num(v.account_id), billing_day: v.kind === 'regular' ? num(v.billing_day) : null, owner_id: num(v.owner_id), is_active: Boolean(Number(v.is_active)) }); };
  return html`<${Modal} title=${item.id ? 'כרטיס אשראי' : 'כרטיס אשראי חדש'} onClose=${onClose}><form onSubmit=${submit}>
    <${Segments} value=${v.kind} onChange=${f.set('kind')} options=${[{ value: 'regular', label: 'רגיל' }, { value: 'direct', label: 'דיירקט' }]} />
    <p class="hint">${v.kind === 'regular' ? 'כל חיוב בכרטיס יורד מהחשבון ביום החיוב הקרוב. למשל: יום חיוב 15, ביטוח שיורד מהכרטיס ב-15 יורד מהחשבון באותו יום, וקנייה ב-20 יורדת ב-15 בחודש הבא.' : 'כל רכישה יורדת מהחשבון מיד (כרטיס חיוב מיידי).'}</p>
    <div class="row2">
      <${Field} label="שם" error=${f.errors.name}><input value=${v.name} onInput=${f.set('name')} placeholder="ויזה כאל" required /><//>
      <${Field} label="4 ספרות אחרונות" error=${f.errors.last4}><input value=${v.last4} onInput=${f.set('last4')} inputmode="numeric" maxlength="4" dir="ltr" /><//>
    </div>
    <div class="row2">
      <${Field} label="יורד מחשבון" error=${f.errors.account_id}><select value=${v.account_id} onChange=${f.set('account_id')}>${lookups.accounts.map((a) => html`<option value=${a.id}>${a.name}</option>`)}</select><//>
      ${v.kind === 'regular' && html`<${Field} label="יום חיוב" error=${f.errors.billing_day}><select value=${v.billing_day} onChange=${f.set('billing_day')}>${[2, 10, 15].concat(Array.from({ length: 31 }, (_, i) => i + 1).filter((d) => ![2, 10, 15].includes(d))).map((d) => html`<option value=${d}>${d}</option>`)}</select><//>`}
    </div>
    <${Field} label="של מי"><${OwnerSelect} value=${v.owner_id} onChange=${f.set('owner_id')} lookups=${lookups} /><//>
    ${item.id && html`<${Field} label="מצב"><${ActiveSelect} value=${v.is_active} onChange=${f.set('is_active')} /><//>`}
    <${Buttons} f=${f} item=${item} remove=${remove} />
  </form><//>`;
}

function CategoryForm({ item, onClose, onSaved }) {
  const f = useForm({ name: item.name || '', kind: item.kind || 'expense', is_active: item.is_active ?? 1, sort: item.sort ?? '' });
  const { save, remove } = crud('/categories', item, onSaved);
  const v = f.values;
  const submit = (e) => { e.preventDefault(); save(f, { name: v.name, kind: v.kind, is_active: Boolean(Number(v.is_active)), ...(v.sort !== '' ? { sort: Number(v.sort) } : {}) }); };
  return html`<${Modal} title="קטגוריה" onClose=${onClose}><form onSubmit=${submit}>
    <${Segments} value=${v.kind} onChange=${f.set('kind')} options=${[{ value: 'expense', label: 'הוצאה' }, { value: 'income', label: 'הכנסה' }]} />
    <${Field} label="שם" error=${f.errors.name}><input value=${v.name} onInput=${f.set('name')} required /><//>
    <div class="row2">
      <${Field} label="סדר" hint="גם הסדר בתפריט הטלפון"><input type="number" min="0" value=${v.sort} onInput=${f.set('sort')} /><//>
      ${item.id && html`<${Field} label="מצב"><${ActiveSelect} value=${v.is_active} onChange=${f.set('is_active')} /><//>`}
    </div>
    <${Buttons} f=${f} item=${item} remove=${remove} />
  </form><//>`;
}

// ------------------------------------------------------------------ users
function Users({ me, onChange }) {
  const { data, error, reload } = useApi('/users');
  const [edit, setEdit] = useState(null);
  return html`<section class="card">
    <div class="month-head"><h3>משתמשים</h3><button class="btn small" onClick=${() => setEdit({})}>+ משתמש</button></div>
    ${error && html`<${ErrorBox} error=${error} retry=${reload} />`}
    ${!data && !error && html`<${Loading} />`}
    ${data?.map((u) => html`<button class=${`list-row tx ${u.is_active ? '' : 'inactive'}`} onClick=${() => setEdit(u)}>
      <span><b>${u.name}${u.id === me.id ? ' (אני)' : ''}</b><span class="muted small">${[u.email, ...u.phones.map((p) => p.phone), !u.is_active && 'חסום'].filter(Boolean).join(' · ') || 'אין טלפון ומייל'}</span></span><span class="muted">›</span>
    </button>`)}
    ${edit && html`<${UserForm} user=${edit} me=${me} onClose=${() => setEdit(null)} onSaved=${() => { setEdit(null); reload(); onChange(); }} />`}
  </section>`;
}

function UserForm({ user, me, onClose, onSaved }) {
  const f = useForm({ name: user.name || '', email: user.email || '', password: '', is_active: user.is_active === false ? 0 : 1 });
  const [phones, setPhones] = useState(user.phones?.length ? user.phones : [{ phone: '', label: '' }]);
  const setPhone = (i, k) => (e) => setPhones((ps) => ps.map((p, j) => (j === i ? { ...p, [k]: e.target.value } : p)));
  const { remove } = crud('/users', user, onSaved);
  const submit = (e) => {
    e.preventDefault();
    const v = f.values;
    const body = { name: v.name, email: v.email || null, phones: phones.filter((p) => p.phone.trim()) };
    if (v.password) body.password = v.password;
    if (user.id && user.id !== me.id) body.is_active = Boolean(Number(v.is_active));
    f.submit(() => (user.id ? api.patch(`/users/${user.id}`, body) : api.post('/users', body))).then((r) => r && (toast('נשמר'), onSaved()));
  };
  return html`<${Modal} title=${user.id ? user.name : 'משתמש חדש'} onClose=${onClose}><form onSubmit=${submit}>
    <${Field} label="שם" error=${f.errors.name}><input value=${f.values.name} onInput=${f.set('name')} required /><//>
    <${Field} label="מייל" error=${f.errors.email} hint="כניסה עם Google לפי המייל הזה"><input type="email" value=${f.values.email} onInput=${f.set('email')} dir="ltr" /><//>
    <div class="label">טלפונים</div>
    <p class="hint">שיחה מאחד המספרים לשלוחה בימות המשיח מזוהה כמשתמש הזה. אפשר גם להיכנס לאתר עם המספר.</p>
    ${phones.map((p, i) => html`<div class="row2 phone-row">
      <input type="tel" value=${p.phone} onInput=${setPhone(i, 'phone')} placeholder="05X-XXXXXXX" dir="ltr" />
      <input value=${p.label} onInput=${setPhone(i, 'label')} placeholder="תיאור (נייד / בית)" />
      <button type="button" class="icon-btn" onClick=${() => setPhones((ps) => ps.filter((_, j) => j !== i))} aria-label="הסרה">✕</button>
    </div>`)}
    ${f.errors.phones && html`<div class="err">${f.errors.phones}</div>`}
    <button type="button" class="link small" onClick=${() => setPhones((ps) => [...ps, { phone: '', label: '' }])}>+ עוד טלפון</button>
    <${Field} label=${user.id ? 'סיסמה חדשה' : 'סיסמה'} error=${f.errors.password} hint=${user.id ? 'ריק = בלי שינוי' : 'אפשר גם בלי, ולהיכנס רק עם Google'}><input type="password" value=${f.values.password} onInput=${f.set('password')} autocomplete="new-password" /><//>
    ${user.id && user.id !== me.id && html`<${Field} label="מצב"><select value=${f.values.is_active} onChange=${f.set('is_active')}><option value="1">פעיל</option><option value="0">חסום</option></select><//>`}
    <div class="actions"><button class="btn primary" disabled=${f.busy}>שמירה</button>${user.id && user.id !== me.id && html`<button type="button" class="btn danger" onClick=${remove}>מחיקה</button>`}</div>
  </form><//>`;
}

// ------------------------------------------------------------------ phone line & login settings
function PhoneLine() {
  const { data, error, reload } = useApi('/settings');
  const [showGoogle, setShowGoogle] = useState(false);
  if (error) return html`<${ErrorBox} error=${error} retry=${reload} />`;
  if (!data) return null;
  const patch = (body) => api.patch('/settings', body).then(() => (toast('נשמר'), reload()), (e) => toast(e.message, 'bad'));
  const rotate = async () => {
    if (!(await confirmBox('ליצור קישור חדש? הקישור הישן יפסיק לעבוד, וצריך לעדכן אותו בימות המשיח.', { ok: 'יצירה' }))) return;
    api.post('/settings/ivr-key').then(() => (toast('נוצר קישור חדש'), reload()));
  };
  const ext = `type=api\napi_link=${data.ivr_link}\napi_hangup_send=yes`;
  return html`<section class="card">
    <div class="month-head"><h3>☎ שלוחה בימות המשיח</h3>
      <label class="switch"><input type="checkbox" checked=${data.ivr_enabled} onChange=${(e) => patch({ ivr_enabled: e.target.checked })} /> פעילה</label></div>
    <p class="hint">מגדירים שלוחה מסוג API ומדביקים בקובץ ext.ini שלה:</p>
    <pre class="code" dir="ltr">${ext}</pre>
    <div class="actions">
      <button class="btn small" onClick=${() => navigator.clipboard.writeText(ext).then(() => toast('הועתק'))}>העתקה</button>
      <button class="btn small" onClick=${rotate}>קישור חדש</button>
    </div>
    <p class="hint">בשיחה: 1 הוצאה, 2 הכנסה (סכום ← קטגוריה ← אמצעי תשלום ← אישור), 3 מצב החודש. המתקשר מזוהה לפי הטלפונים של המשתמשים.</p>
    <div class="month-head"><span>כניסה עם Google</span><label class="switch"><input type="checkbox" checked=${data.google_login_enabled} onChange=${(e) => patch({ google_login_enabled: e.target.checked })} /> פעילה</label></div>
    ${showGoogle
      ? html`<${Field} label="Google Client ID"><input dir="ltr" value=${data.google_client_id} onChange=${(e) => patch({ google_client_id: e.target.value })} /><//>`
      : html`<button class="link small" onClick=${() => setShowGoogle(true)}>מתקדם…</button>`}
  </section>`;
}

function MyPassword() {
  const [open, setOpen] = useState(false);
  const f = useForm({ current_password: '', new_password: '' });
  const submit = (e) => { e.preventDefault(); f.submit(() => api.put('/me/password', f.values)).then((r) => r !== undefined && (toast('הסיסמה עודכנה'), setOpen(false))); };
  return html`<section class="card">
    <button class="list-row tx" onClick=${() => setOpen(!open)}><b>🔑 שינוי הסיסמה שלי</b><span class="muted">${open ? '˄' : '˅'}</span></button>
    ${open && html`<form onSubmit=${submit}>
      <${Field} label="סיסמה נוכחית" error=${f.errors.current_password}><input type="password" value=${f.values.current_password} onInput=${f.set('current_password')} autocomplete="current-password" /><//>
      <${Field} label="סיסמה חדשה" error=${f.errors.new_password}><input type="password" value=${f.values.new_password} onInput=${f.set('new_password')} autocomplete="new-password" required /><//>
      <button class="btn primary" disabled=${f.busy}>עדכון</button>
    </form>`}
  </section>`;
}
