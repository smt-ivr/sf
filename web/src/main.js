// App shell: login / first-time setup, bottom navigation, hash routes, the "+" entry form.
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { api, hasToken, onUnauthorized, setToken } from './api.js';
import { html, Loading, ErrorBox } from './ui.js';
import { Login } from './pages/login.js';
import { Home } from './pages/home.js';
import { Transactions } from './pages/transactions.js';
import { Forecast } from './pages/forecast.js';
import { Settings } from './pages/settings.js';
import { Recurring } from './pages/recurring.js';
import { EntryForm } from './pages/entry.js';
import { Report } from './pages/report.js';
import { Tasks } from './pages/tasks.js';

const ROUTES = {
  '': { title: 'בית', icon: '⌂', page: Home },
  tx: { title: 'תנועות', icon: '☰', page: Transactions },
  forecast: { title: 'צפי', icon: '📅', page: Forecast },
  report: { title: 'לאן הלך הכסף', icon: '📊', page: Report },
  tasks: { title: 'משימות', icon: '✓', page: Tasks },
  recurring: { title: 'קבועות', icon: '↻', page: Recurring },
  settings: { title: 'הגדרות', icon: '⚙', page: Settings },
};
const route = () => location.hash.replace(/^#\/?/, '').split('?')[0];

function App() {
  const [me, setMe] = useState(null);
  const [state, setState] = useState(hasToken() ? 'loading' : 'login');
  const [lookups, setLookups] = useState(null);
  const [error, setError] = useState(null);
  const [path, setPath] = useState(route());
  const [entry, setEntry] = useState(null); // null | {} (new) | transaction (edit)
  const [version, setVersion] = useState(0); // bumped after any change: pages reload
  const [badge, setBadge] = useState(0);      // tasks that need attention

  const loadLookups = () => api.get('/lookups').then(setLookups, setError);
  const refresh = () => { setVersion((v) => v + 1); loadLookups(); };

  useEffect(() => onUnauthorized(() => { setMe(null); setState('login'); }), []);
  useEffect(() => {
    const on = () => { setPath(route()); window.scrollTo(0, 0); };
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  useEffect(() => {
    if (state !== 'loading') return;
    Promise.all([api.get('/me'), api.get('/lookups')]).then(([m, l]) => { setMe(m); setLookups(l); setState('in'); }, (e) => { if (e.status !== 401) { setError(e); setState('error'); } });
  }, [state]);

  useEffect(() => {
    if (state !== 'in') return;
    api.get('/tasks').then((t) => setBadge(t.urgent + t.soon), () => {});
  }, [state, version]);

  if (state === 'login') return html`<${Login} onDone=${(s) => { setToken(s.token); setState('loading'); }} />`;
  if (state === 'error') return html`<div class="page"><${ErrorBox} error=${error} retry=${() => setState('loading')} /></div>`;
  if (state !== 'in' || !lookups) return html`<${Loading} />`;

  const r = ROUTES[path] || ROUTES[''];
  const Page = r.page;
  const ctx = { me, lookups, version, refresh, openEntry: (t) => setEntry(t || {}), logout: async () => { await api.post('/auth/logout').catch(() => {}); setToken(null); setMe(null); setState('login'); } };

  return html`
    <header class="topbar"><h1>${r.title}</h1>
      <span class="topbar-side"><span class="muted small">${me.name}</span><a class=${`icon-btn ${path === 'settings' || path === 'recurring' ? 'on' : ''}`} href="#/settings" aria-label="הגדרות">⚙</a></span>
    </header>
    <main class="page"><${Page} ...${ctx} /></main>
    <nav class="bottom-nav">
      ${['', 'tx'].map((k) => html`<a href=${`#/${k}`} class=${path === k ? 'on' : ''}><span>${ROUTES[k].icon}</span>${ROUTES[k].title}</a>`)}
      <button class="fab" onClick=${() => setEntry({})} aria-label="הוספה">+</button>
      <a href="#/tasks" class=${path === 'tasks' ? 'on' : ''}><span class="nav-icon">${ROUTES.tasks.icon}${badge > 0 && html`<i class="badge">${badge}</i>`}</span>משימות</a>
      <a href="#/report" class=${path === 'report' ? 'on' : ''}><span>${ROUTES.report.icon}</span>דוח</a>
    </nav>
    ${entry && html`<${EntryForm} tx=${entry} lookups=${lookups} me=${me} onClose=${() => setEntry(null)} onSaved=${() => { setEntry(null); refresh(); }} />`}
  `;
}

render(html`<${App} />`, document.getElementById('app'));

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
