// The only module that knows about HTTP. The app lives in <site>/ and the API in <site>/api
// (site = smti.uk/sf/ or the workers.dev root).
export const SITE_ROOT = location.origin + location.pathname.replace(/[^/]*$/, '');
const BASE = SITE_ROOT.replace(/\/$/, '') + '/api';
const TOKEN_KEY = 'sf.token';

let token = null;
try { token = localStorage.getItem(TOKEN_KEY); } catch { /* storage blocked */ }

const listeners = new Set();
export const onUnauthorized = (fn) => (listeners.add(fn), () => listeners.delete(fn));

export function setToken(t) {
  token = t;
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}
export const hasToken = () => Boolean(token);

export class ApiError extends Error {
  constructor(status, error = {}) {
    super(error.message || 'שגיאה');
    this.status = status;
    this.code = error.code;
    this.fields = error.fields || {};
  }
}

async function request(method, path, body) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, { message: 'אין חיבור לשרת. בדקו את החיבור לאינטרנט' });
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new ApiError(res.status, data.error);
    if (res.status === 401 && !path.startsWith('/auth/') && path !== '/me/password') {
      setToken(null);
      listeners.forEach((fn) => fn(err));
    }
    throw err;
  }
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
  put: (p, b) => request('PUT', p, b),
  patch: (p, b) => request('PATCH', p, b),
  del: (p) => request('DELETE', p),
};
