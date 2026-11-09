-- Tasks the user writes for themselves ("pay the plumber by Thursday"). The automatic ones
-- (confirm a salary, money needed in an account, money to return, count the cash) are computed.
CREATE TABLE IF NOT EXISTS sf_tasks (
  id         INTEGER PRIMARY KEY,
  title      TEXT NOT NULL,
  due_date   TEXT,
  amount     INTEGER,
  note       TEXT NOT NULL DEFAULT '',
  done_at    TEXT,
  user_id    INTEGER REFERENCES sf_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
