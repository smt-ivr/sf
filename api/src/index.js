// Entry point. Every API path lives under /api; anything else is the web app (static assets in ./web).
import { authenticate } from './auth.js';
import { HttpError, errorResponse, json } from './http.js';
import { Router } from './router.js';
import { handleIvr } from './ivr.js';
import * as auth from './routes/auth.js';
import * as setup from './routes/setup.js';
import * as tx from './routes/transactions.js';
import * as users from './routes/users.js';

const PUBLIC = { auth: 'none' };

export const router = new Router()
  .get('/health', () => json({ ok: true }), PUBLIC)
  // Yemot HaMashiach phone line (own key check; always answers in Yemot format)
  .get('/ivr', handleIvr, PUBLIC)
  .post('/ivr', handleIvr, PUBLIC)
  // session
  .get('/auth/options', auth.getOptions, PUBLIC)
  .post('/setup', auth.postSetup, PUBLIC)
  .post('/auth/login', auth.postLogin, PUBLIC)
  .post('/auth/google', auth.postGoogle, PUBLIC)
  .post('/auth/logout', auth.postLogout)
  .get('/me', auth.getMe)
  .put('/me/password', auth.putPassword)
  // reports
  .get('/dashboard', tx.dashboard)
  .get('/forecast', tx.getForecast)
  .get('/summary', tx.getSummary)
  .get('/lookups', tx.lookups)
  // entries
  .get('/transactions', tx.list)
  .post('/transactions', tx.create)
  .patch('/transactions/:id', tx.patch)
  .delete('/transactions/:id', tx.remove)
  // recurring income/expenses
  .get('/recurring', setup.listRecurring)
  .post('/recurring', setup.createRecurring)
  .patch('/recurring/:id', setup.patchRecurring)
  .delete('/recurring/:id', setup.deleteRecurring)
  .post('/recurring/:id/confirm', tx.confirm)
  .post('/recurring/:id/skip', tx.skip)
  // settings data
  .get('/accounts', setup.listAccounts)
  .post('/accounts', setup.createAccount)
  .patch('/accounts/:id', setup.patchAccount)
  .delete('/accounts/:id', setup.deleteAccount)
  .get('/cards', setup.listCards)
  .post('/cards', setup.createCard)
  .patch('/cards/:id', setup.patchCard)
  .delete('/cards/:id', setup.deleteCard)
  .get('/categories', setup.listCategories)
  .post('/categories', setup.createCategory)
  .patch('/categories/:id', setup.patchCategory)
  .delete('/categories/:id', setup.deleteCategory)
  .get('/users', users.list)
  .post('/users', users.create)
  .patch('/users/:id', users.patch)
  .delete('/users/:id', users.remove)
  .get('/settings', setup.getAppSettings)
  .patch('/settings', setup.patchAppSettings)
  .post('/settings/ivr-key', setup.rotateIvrKey);

async function handleApi(request, env, path) {
  const url = new URL(request.url);
  const found = router.match(request.method, path);
  if (!found) throw new HttpError(404, 'NOT_FOUND', 'נתיב לא קיים');
  if (found.allowed) throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'שיטה לא נתמכת בנתיב זה');
  const { route, params } = found;
  const ctx = { env, request, url, params, actor: null };
  if (route.options.auth !== 'none') ctx.actor = await authenticate(env, request);
  return route.handler(ctx);
}

/**
 * The app lives under a path prefix (BASE_PATH "/sf" for smti.uk/sf) and at the root (workers.dev)
 * at the same time. Returns the path without the prefix, or a redirect.
 */
function stripBase(env, url) {
  const base = (env.BASE_PATH || '').replace(/\/$/, '');
  if (!base) return { path: url.pathname };
  if (url.pathname === base) return { redirect: `${url.origin}${base}/${url.search}` };
  if (url.pathname.startsWith(base + '/')) return { path: url.pathname.slice(base.length) };
  return { path: url.pathname };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { path, redirect } = stripBase(env, url);
    if (redirect) return Response.redirect(redirect, 301);

    if (!path.startsWith('/api/') && path !== '/api') {
      if (!env.ASSETS) return new Response('Not found', { status: 404 });
      const assetUrl = new URL(url);
      assetUrl.pathname = path;
      return env.ASSETS.fetch(new Request(assetUrl, request));
    }

    let response;
    try {
      response = await handleApi(request, env, path.slice(4) || '/');
    } catch (err) {
      if (err instanceof HttpError) response = errorResponse(err);
      else {
        const ref = crypto.randomUUID().slice(0, 8);
        console.error(`[${ref}] ${request.method} ${url.pathname}`, err?.stack || err);
        response = json({ error: { code: 'INTERNAL', message: `שגיאת שרת (קוד ${ref})` } }, 500);
      }
    }
    const out = new Response(response.body, response);
    if (!out.headers.has('Cache-Control')) out.headers.set('Cache-Control', 'no-store');
    return out;
  },
};
