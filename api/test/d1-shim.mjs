// In-memory D1 stand-in on node:sqlite, so tests run the real migrations and handlers without a network.
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const returnsRows = (sql) => /^\s*(SELECT|WITH|PRAGMA)/i.test(sql) || /\bRETURNING\b/i.test(sql);
// D1 binds booleans/undefined differently than node:sqlite; mirror D1 (true -> 1).
const norm = (v) => (v === true ? 1 : v === false ? 0 : v === undefined ? null : v);

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    return new Statement(this.db, this.sql, params.map(norm));
  }
  _exec() {
    const stmt = this.db.prepare(this.sql);
    if (returnsRows(this.sql)) return { results: stmt.all(...this.params).map((r) => ({ ...r })), success: true, meta: {} };
    const info = stmt.run(...this.params);
    return { results: [], success: true, meta: { last_row_id: Number(info.lastInsertRowid), changes: Number(info.changes) } };
  }
  async first() {
    return this._exec().results[0] ?? null;
  }
  async all() {
    return this._exec();
  }
  async run() {
    return this._exec();
  }
}

export class D1Shim {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec('PRAGMA foreign_keys = ON');
    const dir = new URL('../migrations/', import.meta.url);
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      this.db.exec(readFileSync(new URL(f, dir), 'utf8'));
    }
  }
  prepare(sql) {
    return new Statement(this.db, sql);
  }
  async batch(statements) {
    this.db.exec('BEGIN');
    try {
      const out = statements.map((s) => s._exec());
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}
