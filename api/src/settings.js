// Key/value settings (sf_settings).
import { all, run } from './db.js';

export const DEFAULTS = {
  // Same Google client as the other smti.uk projects (the origin smti.uk is already allowed there).
  google_client_id: '89500817024-tbvsuu4dci6bqh173l65ua9lc65pe24p.apps.googleusercontent.com',
  google_login_enabled: '1',
  ivr_key: '',          // the phone line works only when Yemot sends key=<this> (ext.ini: api_add_0=key=<this>)
  ivr_enabled: '1',
};

export async function getSettings(env) {
  const rows = await all(env, `SELECT key, value FROM sf_settings`);
  const out = { ...DEFAULTS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export const setSetting = (env, key, value) =>
  run(env, `INSERT INTO sf_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, String(value));
