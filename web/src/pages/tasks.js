// Tasks: "is everything under control?" and what to do by when. Automatic tasks come from the data
// (confirm a salary, money needed in an account, money to return, count the cash); the user adds their own.
import { useState } from 'preact/hooks';
import { api } from '../api.js';
import { confirmBox, ErrorBox, Field, html, Loading, Modal, money, shortDate, toast, toInput, useApi, useForm } from '../ui.js';
import { AccountModal, ConfirmModal, HeldModal, ReimburseModal } from './money.js';

const LEVEL = { urgent: 'דחוף', soon: 'בקרוב', info: 'לידיעה' };
const ICON = { confirm: '✍', shortfall: '🏦', depends: '⏳', charge: '📅', owed: '🤝', owed_me: '💸', cash: '💵', expected: '📥', manual: '📝' };
const BUTTON = { confirm: 'לעדכן', shortfall: 'העברתי', depends: 'העברתי', owed: 'העברתי', owed_me: 'קיבלתי', cash: 'לספור', expected: 'נכנס', manual: 'בוצע' };

/** Overdraft outlook for the banks: none / only if income comes in / expected. */
function MinusLine({ minus }) {
  if (!minus) return null;
  if (minus.expected.length) {
    return html`<div class="minus bad">⚠ צפוי מינוס: ${minus.expected.map((m) => `${m.name} ב-${shortDate(m.date)} (${money(m.amount)})`).join(', ')}</div>`;
  }
  if (minus.depends.length) {
    const on = [...new Set(minus.depends.flatMap((m) => m.on))].join(', ');
    return html`<div class="minus warn">לא צפוי מינוס, בתנאי ש${on || 'ההכנסה הצפויה'} ייכנס בזמן. אחרת: ${minus.depends.map((m) => `${m.name} ב-${shortDate(m.date)}`).join(', ')}</div>`;
  }
  return html`<div class="minus good">✓ לא צפוי מינוס באף בנק ב-${minus.days} הימים הקרובים</div>`;
}

/** The status banner: everything fine (no overdraft ahead), or how many things need attention. */
export function StatusBanner({ tasks, compact }) {
  const n = tasks.urgent + tasks.soon;
  if (tasks.status === 'ok') {
    return html`<div class="status ok"><span class="status-icon">✓</span><div><b>הכל בסדר</b><${MinusLine} minus=${tasks.minus} /></div></div>`;
  }
  return html`<div class=${`status ${tasks.status}`}><span class="status-icon">!</span><div>
    <b>${n === 1 ? 'יש דבר אחד לטפל בו' : `יש ${n} דברים לטפל בהם`}</b>
    <${MinusLine} minus=${tasks.minus} />
  </div></div>`;
}

export function TaskItem({ task, onAction }) {
  return html`<div class=${`task ${task.level}`}>
    <span class="task-icon">${ICON[task.kind]}</span>
    <div class="task-body">
      <b>${task.title}</b>
      ${task.detail && html`<div class="small muted">${task.detail}</div>`}
    </div>
    <div class="task-side">
      ${task.due && html`<span class="date-pill">${shortDate(task.due)}</span>`}
      ${BUTTON[task.kind] && html`<button class=${`btn small ${task.level === 'urgent' ? 'primary' : ''}`} onClick=${() => onAction(task)}>${BUTTON[task.kind]}</button>`}
      ${task.kind === 'charge' && task.level !== 'info' && html`<button class="btn small" onClick=${() => onAction(task)}>העברתי</button>`}
      ${task.more && html`<button class="link small" onClick=${() => onAction({ ...task, action: task.more })}>פירוט</button>`}
    </div>
  </div>`;
}

/** Runs a task's action: opens the right window. Returns the modal to render (or null). */
export function useTaskActions(lookups, accounts, done) {
  const [open, setOpen] = useState(null);
  const run = async (task) => {
    const a = task.action;
    if (a.type === 'done') {
      await api.patch(`/tasks/${task.id}`, { done: true }).then(() => (toast('בוצע ✓'), done()), (e) => toast(e.message, 'bad'));
      return;
    }
    setOpen(task);
  };
  const close = () => setOpen(null);
  const finished = () => { setOpen(null); done(); };
  let modal = null;
  if (open) {
    const a = open.action;
    const acc = (id) => accounts.find((x) => x.id === id);
    if (a.type === 'confirm') modal = html`<${ConfirmModal} item=${a.item} lookups=${lookups} onClose=${close} onDone=${finished} />`;
    if (a.type === 'transfer' && acc(a.to)) modal = html`<${AccountModal} account=${acc(a.to)} lookups=${lookups} tab="transfer" transfer=${{ from: a.from, amount: a.amount }} onClose=${close} onDone=${finished} />`;
    if (a.type === 'count' && acc(a.account_id)) modal = html`<${AccountModal} account=${acc(a.account_id)} lookups=${lookups} onClose=${close} onDone=${finished} />`;
    if (a.type === 'reimburse') modal = html`<${ReimburseModal} expense=${a.expense} lookups=${lookups} onClose=${close} onDone=${finished} />`;
    if (a.type === 'held') modal = html`<${HeldModal} lookups=${lookups} onClose=${close} onDone=${done} />`;
  }
  return { run, modal };
}

export function Tasks({ version, lookups, refresh }) {
  const { data, error, reload } = useApi('/tasks', [version]);
  const [adding, setAdding] = useState(false);
  const changed = () => { reload(); refresh(); };
  const { run, modal } = useTaskActions(lookups, data?.accounts || [], changed);
  if (error) return html`<${ErrorBox} error=${error} retry=${reload} />`;
  if (!data) return html`<${Loading} />`;
  const groups = ['urgent', 'soon', 'info'].map((l) => ({ level: l, items: data.tasks.filter((t) => t.level === l) })).filter((g) => g.items.length);

  return html`
    <${StatusBanner} tasks=${data} />
    ${groups.map((g) => html`<section class="card">
      <h3 class=${`level-title ${g.level}`}>${LEVEL[g.level]}</h3>
      ${g.items.map((t) => html`<${TaskItem} task=${t} onAction=${run} />`)}
    </section>`)}
    <button class="btn primary block" onClick=${() => setAdding(true)}>+ משימה שלי</button>
    <p class="muted small">משימות אוטומטיות נוצרות מהנתונים: חיוב שיורד השבוע (לוודא שיש כסף), חשבון שעומד להיכנס למינוס או שיש בו מספיק רק אם משכורת תיכנס, כסף של אחרים שהשתמשת בו, סכום שצריך לאשר כמה נכנס בפועל, ומזומן שלא נספר שבוע. "העברתי" רושם העברה מבנק לבנק. המשימות נעלמות לבד כשמטפלים בהן.</p>
    ${data.done.length > 0 && html`<section class="card">
      <h3>בוצעו</h3>
      ${data.done.map((t) => html`<div class="list-row small done-row">
        <span>✓ ${t.title}</span>
        <span class="end"><button class="link small" onClick=${() => api.patch(`/tasks/${t.id}`, { done: false }).then(changed)}>החזרה</button></span>
      </div>`)}
    </section>`}
    ${adding && html`<${TaskForm} lookups=${lookups} onClose=${() => setAdding(false)} onDone=${() => { setAdding(false); changed(); }} />`}
    ${modal}
  `;
}

function TaskForm({ task = {}, lookups, onClose, onDone }) {
  const f = useForm({ title: task.title || '', due_date: task.due_date || '', amount: toInput(task.amount), note: task.note || '' });
  const save = (e) => {
    e.preventDefault();
    const v = f.values;
    f.submit(() => api.post('/tasks', { title: v.title, due_date: v.due_date || null, amount: v.amount || null, note: v.note })).then((r) => r && (toast('נוספה משימה'), onDone()));
  };
  return html`<${Modal} title="משימה חדשה" onClose=${onClose}><form onSubmit=${save}>
    <${Field} label="מה צריך לעשות" error=${f.errors.title}><input value=${f.values.title} onInput=${f.set('title')} placeholder="למשל: להעביר שכר דירה" required autofocus /><//>
    <div class="row2">
      <${Field} label="עד מתי" error=${f.errors.due_date}><input type="date" value=${f.values.due_date} min=${lookups.today} onInput=${f.set('due_date')} /><//>
      <${Field} label="סכום (לא חובה)" error=${f.errors.amount}><input inputmode="decimal" value=${f.values.amount} onInput=${f.set('amount')} /><//>
    </div>
    <${Field} label="הערה"><input value=${f.values.note} onInput=${f.set('note')} /><//>
    <button class="btn primary" disabled=${f.busy}>הוספה</button>
  </form><//>`;
}
