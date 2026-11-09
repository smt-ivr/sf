// Thin helpers over D1. Every query is parameterized; table/column names never come from input.

export const q = (env, sql, ...params) => env.DB.prepare(sql).bind(...params);
export const first = (env, sql, ...params) => q(env, sql, ...params).first();
export const run = (env, sql, ...params) => q(env, sql, ...params).run();
export const all = async (env, sql, ...params) => (await q(env, sql, ...params).all()).results;

export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
export const nowSec = () => Math.floor(Date.now() / 1000);

/** Builds "SET a = ?, b = ?" from a whitelist of columns present in `data`. */
export function setClause(data, columns) {
  const keys = columns.filter((c) => data[c] !== undefined);
  return {
    keys,
    sql: keys.map((k) => `${k} = ?`).join(', '),
    params: keys.map((k) => (typeof data[k] === 'boolean' ? (data[k] ? 1 : 0) : data[k])),
  };
}
