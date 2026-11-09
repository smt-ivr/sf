// Calendar logic on 'YYYY-MM-DD' strings: today in Israel, month arithmetic, recurring occurrences
// and when a payment actually hits the bank account. Pure functions (tested in api/test).

const pad = (n) => String(n).padStart(2, '0');
const parts = (d) => d.split('-').map(Number);
export const fmt = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

/** Today in the given time zone (default Israel). */
export function today(tz = 'Asia/Jerusalem', now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** The day `day` of month (y, m), clamped to the month's last day (31 -> 30 in April). */
export function dayIn(y, m, day) {
  return fmt(y, m, Math.min(day, daysInMonth(y, m)));
}

/** [year, month] moved by n months. */
export function shiftMonth(y, m, n) {
  const i = y * 12 + (m - 1) + n;
  return [Math.floor(i / 12), (i % 12) + 1];
}

export function addDays(date, n) {
  const [y, m, d] = parts(date);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** First and last day of the month of `date` ('YYYY-MM' also accepted). */
export function monthRange(ym) {
  const [y, m] = parts(ym);
  return { from: fmt(y, m, 1), to: fmt(y, m, daysInMonth(y, m)) };
}

// ------------------------------------------------------------------ Hebrew calendar
const hebFmt = new Intl.DateTimeFormat('en-u-ca-hebrew', { timeZone: 'UTC', day: 'numeric', month: 'numeric', year: 'numeric' });
/** Day of the Hebrew month (1-30) of a 'YYYY-MM-DD' date. */
export function hebrewDay(date) {
  const [y, m, d] = parts(date);
  return Number(hebFmt.formatToParts(new Date(Date.UTC(y, m - 1, d))).find((p) => p.type === 'day').value);
}

/**
 * Dates between from..to that fall on day `day` of the Hebrew month. Day 30 in a 29-day month falls
 * on the 29th (the last day), like the 31st of a short Gregorian month.
 */
export function hebrewOccurrences(day, from, to) {
  const out = [];
  let prev = null;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const hd = prev === null ? hebrewDay(d) : prev;
    const next = hebrewDay(addDays(d, 1));
    if (hd === day || (day === 30 && hd === 29 && next === 1)) out.push(d);
    prev = next;
    if (out.length > 1000) break; // safety
  }
  return out;
}

/**
 * Occurrence dates of a recurring item between from..to (inclusive).
 * r = { day_of_month, interval_months, start_date, end_date, calendar? }
 * Hebrew items are monthly (Hebrew months differ in number from year to year).
 */
export function occurrences(r, from, to) {
  if (r.calendar === 'hebrew') {
    const start = from > r.start_date ? from : r.start_date;
    const end = r.end_date && r.end_date < to ? r.end_date : to;
    return start <= end ? hebrewOccurrences(r.day_of_month, start, end) : [];
  }
  const out = [];
  const [sy, sm] = parts(r.start_date);
  const step = r.interval_months || 1;
  const last = r.end_date && r.end_date < to ? r.end_date : to;
  // jump close to `from` instead of walking from the start date
  const [fy, fm] = parts(from);
  let k = Math.max(0, Math.floor(((fy - sy) * 12 + (fm - sm)) / step) - 1);
  for (;; k++) {
    const [y, m] = shiftMonth(sy, sm, k * step);
    const d = dayIn(y, m, r.day_of_month);
    if (d > last) break;
    if (d >= from && d >= r.start_date) out.push(d);
    if (k > 10_000) break; // safety
  }
  return out;
}

/**
 * When the money leaves (or reaches) the bank account.
 *   card regular: billing_day of the month after the purchase month
 *   card direct / bank account / cash: the same day
 */
export function chargeDate(date, card) {
  if (!card || card.kind !== 'regular' || !card.billing_day) return date;
  const [y, m] = parts(date);
  const [ny, nm] = shiftMonth(y, m, 1);
  return dayIn(ny, nm, card.billing_day);
}
