// Shared UI pieces: formatting, form fields, modal, toasts, data loading hook.
import { h, render } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import htm from 'htm';
import { api } from './api.js';

export const html = htm.bind(h);

// ------------------------------------------------------------------ formatting
const ils0 = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });
const ils2 = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** agorot -> "₪1,234" or "₪1,234.50" */
export const money = (agorot) => ((agorot || 0) % 100 ? ils2 : ils0).format((agorot || 0) / 100);
/** agorot -> "1234.50" for an input */
export const toInput = (agorot) => (agorot == null ? '' : String(agorot / 100));

const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const parse = (d) => { const [y, m, day] = d.split('-').map(Number); return new Date(y, m - 1, day); };
/** '2026-11-09' -> "9.11" */
export const shortDate = (d) => (d ? `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}` : '');
/** 1..30 -> "א׳" ... "ל׳" (15 = ט״ו, 16 = ט״ז) */
export function gematria(n) {
  const ones = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'];
  const tens = ['', 'י', 'כ', 'ל'];
  let s = n === 15 ? 'טו' : n === 16 ? 'טז' : tens[Math.floor(n / 10)] + ones[n % 10];
  return s.length === 1 ? `${s}׳` : `${s.slice(0, -1)}״${s.slice(-1)}`;
}
const hebFmt = new Intl.DateTimeFormat('he-u-ca-hebrew', { timeZone: 'UTC', day: 'numeric', month: 'long' });
/** '2026-11-10' -> "ל׳ חשוון" */
export function hebDate(d) {
  const parts = hebFmt.formatToParts(new Date(`${d}T00:00:00Z`));
  const day = Number(parts.find((p) => p.type === 'day').value);
  const month = parts.find((p) => p.type === 'month').value.replace(/^ב/, '');
  return `${gematria(day)} ${month}`;
}
/** '2026-11-09' -> "יום שני, 9 בנובמבר · כ״ט חשוון" */
export const longDate = (d) => { const t = parse(d); return `יום ${DAYS[t.getDay()]}, ${t.getDate()} ב${MONTHS[t.getMonth()]} · ${hebDate(d)}`; };
/** '2026-11' -> "נובמבר 2026" */
export const monthName = (ym) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
export function shiftMonth(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const i = y * 12 + m - 1 + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ data loading
/** const { data, error, loading, reload } = useApi('/dashboard') */
export function useApi(path, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const load = useCallback(() => {
    if (!path) return;
    setState((s) => ({ ...s, loading: true }));
    api.get(path).then((data) => setState({ data, error: null, loading: false }), (error) => setState({ data: null, error, loading: false }));
  }, [path, ...deps]);
  useEffect(load, [load]);
  return { ...state, reload: load };
}

export const Loading = () => html`<div class="center muted"><span class="spinner"></span></div>`;
export const ErrorBox = ({ error, retry }) => html`<div class="card error-box">${error?.message || 'שגיאה'} ${retry && html`<button class="link" onClick=${retry}>נסו שוב</button>`}</div>`;

// ------------------------------------------------------------------ toasts
let toastRoot;
export function toast(text, kind = 'ok') {
  if (!toastRoot) { toastRoot = document.createElement('div'); toastRoot.className = 'toasts'; document.body.append(toastRoot); }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  toastRoot.append(el);
  while (toastRoot.children.length > 2) toastRoot.firstChild.remove();
  setTimeout(() => el.classList.add('hide'), 2600);
  setTimeout(() => el.remove(), 3000);
}

// ------------------------------------------------------------------ modal
export function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.classList.add('modal-open');
    return () => { document.removeEventListener('keydown', onKey); document.body.classList.remove('modal-open'); };
  }, []);
  return html`<div class="modal-back" onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <div class=${`modal ${wide ? 'wide' : ''}`} role="dialog" aria-label=${title}>
      <header><h2>${title}</h2><button class="icon-btn" onClick=${onClose} aria-label="סגירה">✕</button></header>
      <div class="modal-body">${children}</div>
    </div>
  </div>`;
}

/** Imperative confirm in our own style. Resolves true/false. */
export function confirmBox(text, { ok = 'אישור', danger = false } = {}) {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.append(host);
    const close = (v) => { render(null, host); host.remove(); resolve(v); };
    render(html`<${Modal} title="אישור" onClose=${() => close(false)}>
      <p>${text}</p>
      <div class="actions"><button class=${danger ? 'btn danger' : 'btn primary'} onClick=${() => close(true)}>${ok}</button><button class="btn" onClick=${() => close(false)}>ביטול</button></div>
    <//>`, host);
  });
}

// ------------------------------------------------------------------ forms
/** Form state with server-side validation errors. */
export function useForm(initial) {
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => {
    const v = e && e.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e;
    setValues((s) => ({ ...s, [k]: v }));
    setErrors((s) => ({ ...s, [k]: undefined }));
  };
  async function submit(fn) {
    setBusy(true);
    try {
      return await fn(values);
    } catch (err) {
      setErrors(err.fields || {});
      toast(err.message, 'bad');
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { values, setValues, set, errors, busy, submit };
}

export const Field = ({ label, error, hint, children }) => html`<label class=${`field ${error ? 'has-error' : ''}`}>
  <span class="label">${label}</span>${children}${error ? html`<span class="err">${error}</span>` : hint ? html`<span class="hint">${hint}</span>` : null}
</label>`;

export const Select = ({ value, onChange, options, empty }) => html`<select value=${value ?? ''} onChange=${onChange}>
  ${empty !== undefined && html`<option value="">${empty}</option>`}
  ${options.map((o) => html`<option value=${o.value}>${o.label}</option>`)}
</select>`;

/** Segmented buttons: [{value,label}] */
export const Segments = ({ value, onChange, options }) => html`<div class="segments">
  ${options.map((o) => html`<button type="button" class=${String(value) === String(o.value) ? 'on' : ''} onClick=${() => onChange(o.value)}>${o.label}</button>`)}
</div>`;

export const num = (v) => (v === '' || v == null ? null : Number(v));

/** Display name of where money came from/went to. */
export function paymentName(t, lk) {
  if (t.card_id) { const c = lk.cards.find((x) => x.id === t.card_id); return c ? `${c.name}${c.last4 ? ` ${c.last4}` : ''}` : 'כרטיס'; }
  if (t.account_id) { const a = lk.accounts.find((x) => x.id === t.account_id); return a ? (a.kind === 'cash' ? `💵 ${a.name}` : a.name) : 'חשבון'; }
  return 'מזומן';
}
export const accIcon = (a) => (a.kind === 'cash' ? '💵' : '🏦');
export const userName = (id, lk) => (id ? lk.users.find((u) => u.id === id)?.name ?? '' : 'משותף');
