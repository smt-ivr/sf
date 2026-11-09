// Login (phone or e-mail + password, or Google) and the one-time setup of the first user.
import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../api.js';
import { Field, html, Loading, toast, useForm } from '../ui.js';

function GoogleButton({ clientId, onDone }) {
  const ref = useRef();
  useEffect(() => {
    const init = () => {
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: (r) => api.post('/auth/google', { credential: r.credential }).then(onDone, (e) => toast(e.message, 'bad')),
      });
      window.google.accounts.id.renderButton(ref.current, { locale: 'he', width: 280, text: 'signin_with' });
    };
    if (window.google?.accounts) return init();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = init;
    document.head.append(s);
  }, [clientId]);
  return html`<div class="google" ref=${ref}></div>`;
}

export function Login({ onDone }) {
  const [opts, setOpts] = useState(null);
  useEffect(() => { api.get('/auth/options').then(setOpts, () => setOpts({ needs_setup: false })); }, []);
  if (!opts) return html`<${Loading} />`;
  return html`<div class="login-page">
    <div class="login card">
      <div class="logo">₪</div>
      <h1>מעקב הכנסות והוצאות</h1>
      ${opts.needs_setup ? html`<${Setup} onDone=${onDone} />` : html`<${LoginForm} onDone=${onDone} />`}
      ${!opts.needs_setup && opts.google_client_id && html`<div class="or">או</div><${GoogleButton} clientId=${opts.google_client_id} onDone=${onDone} />`}
    </div>
  </div>`;
}

function LoginForm({ onDone }) {
  const f = useForm({ login: '', password: '' });
  const go = (e) => { e.preventDefault(); f.submit((v) => api.post('/auth/login', v)).then((s) => s && onDone(s)); };
  return html`<form onSubmit=${go}>
    <${Field} label="טלפון או מייל"><input value=${f.values.login} onInput=${f.set('login')} autocomplete="username" dir="ltr" required /><//>
    <${Field} label="סיסמה"><input type="password" value=${f.values.password} onInput=${f.set('password')} autocomplete="current-password" required /><//>
    <button class="btn primary block" disabled=${f.busy}>כניסה</button>
  </form>`;
}

function Setup({ onDone }) {
  const f = useForm({ name: '', phone: '', email: '', password: '', password2: '' });
  const go = (e) => {
    e.preventDefault();
    if (f.values.password !== f.values.password2) return toast('הסיסמאות לא זהות', 'bad');
    const { password2, ...v } = f.values;
    f.submit(() => api.post('/setup', { ...v, email: v.email || null, phone: v.phone || null })).then((s) => s && onDone(s));
  };
  return html`<form onSubmit=${go}>
    <p class="muted">הגדרה ראשונה: יצירת המשתמש שלך. את המשתמש של בת הזוג מוסיפים אחר כך בהגדרות.</p>
    <${Field} label="שם" error=${f.errors.name}><input value=${f.values.name} onInput=${f.set('name')} required /><//>
    <${Field} label="טלפון" error=${f.errors.phone} hint="לזיהוי בשלוחה בטלפון ולכניסה"><input type="tel" value=${f.values.phone} onInput=${f.set('phone')} dir="ltr" /><//>
    <${Field} label="מייל" error=${f.errors.email} hint="לכניסה עם Google"><input type="email" value=${f.values.email} onInput=${f.set('email')} dir="ltr" /><//>
    <${Field} label="סיסמה" error=${f.errors.password}><input type="password" value=${f.values.password} onInput=${f.set('password')} autocomplete="new-password" required /><//>
    <${Field} label="סיסמה שוב"><input type="password" value=${f.values.password2} onInput=${f.set('password2')} autocomplete="new-password" required /><//>
    <button class="btn primary block" disabled=${f.busy}>יצירה וכניסה</button>
  </form>`;
}
