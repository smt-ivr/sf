// Tasks: GET returns the automatic ones and the user's own; the user's own can be added, edited, done.
import { all, first, nowIso, run } from '../db.js';
import { json, noContent, notFound, readJson } from '../http.js';
import { computeTasks } from '../tasks.js';
import { syncRecurring } from '../money.js';
import { fields, id } from '../validate.js';

export async function list({ env }) {
  await syncRecurring(env);
  const done = await all(env, `SELECT * FROM sf_tasks WHERE done_at IS NOT NULL ORDER BY done_at DESC LIMIT 20`);
  return json({ ...(await computeTasks(env)), done });
}

const taskFields = (body, partial) =>
  fields(body, { partial }).str('title', { required: true, max: 200 }).date('due_date', { nullable: true }).money('amount', { nullable: true }).str('note', { max: 500 }).bool('done').done();

export async function create({ env, request, actor }) {
  const d = taskFields(await readJson(request), false);
  const res = await run(env, `INSERT INTO sf_tasks (title, due_date, amount, note, user_id) VALUES (?, ?, ?, ?, ?)`, d.title, d.due_date ?? null, d.amount ?? null, d.note, actor.id);
  return json(await first(env, `SELECT * FROM sf_tasks WHERE id = ?`, res.meta.last_row_id), 201);
}

export async function patch({ env, request, params }) {
  const tid = id(params.id);
  const d = taskFields(await readJson(request), true);
  const sets = [];
  const args = [];
  for (const k of ['title', 'due_date', 'amount', 'note']) if (d[k] !== undefined) { sets.push(`${k} = ?`); args.push(d[k]); }
  if (d.done !== undefined) { sets.push('done_at = ?'); args.push(d.done ? nowIso() : null); }
  if (sets.length) await run(env, `UPDATE sf_tasks SET ${sets.join(', ')} WHERE id = ?`, ...args, tid);
  const row = await first(env, `SELECT * FROM sf_tasks WHERE id = ?`, tid);
  if (!row) throw notFound('משימה לא נמצאה');
  return json(row);
}

export async function remove({ env, params }) {
  const res = await run(env, `DELETE FROM sf_tasks WHERE id = ?`, id(params.id));
  if (!res.meta.changes) throw notFound('משימה לא נמצאה');
  return noContent();
}
