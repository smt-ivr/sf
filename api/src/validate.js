import { badRequest, invalid } from './http.js';

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_RE = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

// Invisible characters that sneak in when text is copied from Hebrew apps (WhatsApp, contacts):
// direction marks (RLM/LRM), embeddings/isolates, zero-width spaces, BOM, soft hyphen.
const INVISIBLE = /[\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
/** Removes invisible characters, turns no-break spaces into spaces and trims. */
export const clean = (s) => String(s ?? '').replace(INVISIBLE, '').replace(/[\u00A0\u2007\u202F]/g, ' ').trim();
/** A cleaned, lower-cased e-mail address, or null when it is not one. */
export function normalizeEmail(raw) {
  const s = clean(raw).toLowerCase();
  return EMAIL_RE.test(s) && s.length <= 200 ? s : null;
}

/** Israeli phone to local digits: '+972-58-320-6823' -> '0583206823'. Returns null when not a phone. */
export function normalizePhone(raw) {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.startsWith('972')) d = '0' + d.slice(3);
  return /^0\d{8,9}$/.test(d) ? d : null;
}

/**
 * Declarative body parser. Collects every problem before failing, so the UI can mark all fields at once.
 *   const d = fields(body, { partial }).str('name', { required: true, max: 120 }).int('area_id', { nullable: true }).done();
 * In partial mode (PATCH) missing keys are skipped; present keys are validated the same way.
 */
export function fields(body, { partial = false } = {}) {
  const out = {};
  const errors = {};
  const api = {
    _field(key, opts, check) {
      const has = Object.prototype.hasOwnProperty.call(body, key);
      if (!has) {
        if (opts.required && !partial) errors[key] = 'שדה חובה';
        else if (!partial && 'default' in opts) out[key] = opts.default;
        return api;
      }
      const v = body[key];
      if (v === null || v === '') {
        if (opts.nullable) out[key] = null;
        else if (opts.required) errors[key] = 'שדה חובה';
        else if ('empty' in opts) out[key] = opts.empty;
        else errors[key] = 'ערך חסר';
        return api;
      }
      const res = check(v);
      if (typeof res === 'object' && res && 'error' in res) errors[key] = res.error;
      else out[key] = res;
      return api;
    },
    str(key, opts = {}) {
      return api._field(key, { empty: '', default: '', ...opts }, (v) => {
        if (typeof v !== 'string') return { error: 'חייב להיות טקסט' };
        const s = clean(v);
        if (!s && opts.required) return { error: 'שדה חובה' };
        if (opts.max && s.length > opts.max) return { error: `עד ${opts.max} תווים` };
        if (opts.min && s.length < opts.min) return { error: `לפחות ${opts.min} תווים` };
        return s;
      });
    },
    email(key, opts = {}) {
      return api._field(key, opts, (v) => (typeof v === 'string' && normalizeEmail(v)) || { error: 'כתובת מייל לא תקינה' });
    },
    phone(key, opts = {}) {
      return api._field(key, { nullable: true, ...opts }, (v) => normalizePhone(v) ?? { error: 'מספר טלפון לא תקין' });
    },
    password(key, opts = {}) {
      return api._field(key, opts, (v) =>
        typeof v === 'string' && v.length >= 4 && v.length <= 200 ? v : { error: 'סיסמה של 4 תווים לפחות' }
      );
    },
    int(key, opts = {}) {
      return api._field(key, opts, (v) => {
        const n = typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : v;
        if (!Number.isInteger(n)) return { error: 'חייב להיות מספר שלם' };
        if (opts.min !== undefined && n < opts.min) return { error: `מינימום ${opts.min}` };
        if (opts.max !== undefined && n > opts.max) return { error: `מקסימום ${opts.max}` };
        return n;
      });
    },
    bool(key, opts = {}) {
      return api._field(key, opts, (v) =>
        typeof v === 'boolean' ? v : v === 1 || v === 0 ? v === 1 : { error: 'חייב להיות כן/לא' }
      );
    },
    time(key, opts = {}) {
      return api._field(key, opts, (v) => (typeof v === 'string' && TIME_RE.test(v) ? v : { error: 'שעה בפורמט HH:MM' }));
    },
    /** 'MM-DD' (a yearly date, e.g. the day a season starts). */
    monthDay(key, opts = {}) {
      return api._field(key, opts, (v) => {
        const m = typeof v === 'string' && /^(\d{2})-(\d{2})$/.exec(v);
        return m && +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 31 ? v : { error: 'תאריך לא תקין' };
      });
    },
    /** 'YYYY-MM-DD' */
    date(key, opts = {}) {
      return api._field(key, opts, (v) => (typeof v === 'string' && isDate(v) ? v : { error: 'תאריך לא תקין' }));
    },
    /** Shekels (number or "12.50") -> agorot. */
    money(key, opts = {}) {
      return api._field(key, opts, (v) => {
        const a = toAgorot(v);
        if (a === null) return { error: 'סכום לא תקין' };
        if (a < 0) return { error: 'סכום לא יכול להיות שלילי' };
        if (a > 100_000_000_00) return { error: 'סכום גדול מדי' };
        return a;
      });
    },
    oneOf(key, values, opts = {}) {
      return api._field(key, opts, (v) => (values.includes(v) ? v : { error: 'ערך לא חוקי' }));
    },
    /** Array of allowed strings (no duplicates). */
    subset(key, allowed, opts = {}) {
      return api._field(key, opts, (v) =>
        Array.isArray(v) && v.every((x) => allowed.includes(x)) ? [...new Set(v)] : { error: 'ערכים לא חוקיים' }
      );
    },
    ids(key, opts = {}) {
      return api._field(key, opts, (v) => {
        if (!Array.isArray(v) || v.length > 500 || !v.every((x) => Number.isInteger(x) && x > 0)) {
          return { error: 'רשימת מזהים לא תקינה' };
        }
        return [...new Set(v)];
      });
    },
    done() {
      if (Object.keys(errors).length) throw invalid(errors);
      return out;
    },
  };
  return api;
}

export function id(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || String(n) !== String(value)) throw badRequest('מזהה לא תקין');
  return n;
}

export function queryInt(url, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`פרמטר ${name} לא תקין`);
  return n;
}

/** A real calendar date in 'YYYY-MM-DD'. */
export function isDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/**
 * 12 / "12.5" / "12,50" -> 1250 agorot; anything else -> null. Negative numbers are returned negative.
 * More than 2 decimals ("6.065", from a supplier's mail) is rounded to agorot like the bank: half an
 * agora goes to the even agora (6.065 -> 6.06, 6.075 -> 6.08).
 */
export function toAgorot(v) {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? clean(v).replace(',', '.').replace(/[₪\s]/g, '') : '';
  const m = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) return null;
  const frac = (m[3] || '').padEnd(2, '0');
  let agorot = Number(m[2]) * 100 + Number(frac.slice(0, 2));
  const rest = frac.slice(2); // beyond agorot, compared as text to avoid floating point errors
  if (rest && /[1-9]/.test(rest)) {
    const half = '5'.padEnd(rest.length, '0');
    if (rest > half || (rest === half && agorot % 2 === 1)) agorot += 1;
  }
  return m[1] ? -agorot : agorot;
}
