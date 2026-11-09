-- Family income/expense tracker. Lives inside the shared "drive-pro" D1 database:
-- every table starts with sf_ so nothing of the other project is touched.
-- Money is stored in agorot (integer); dates are 'YYYY-MM-DD' (Israel time).

CREATE TABLE IF NOT EXISTS sf_users (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT UNIQUE,                 -- also used for "Sign in with Google"
  password_hash TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_login_at TEXT
);

-- Phones of each user: the phone line recognises the caller by caller ID; they also work as a login name.
CREATE TABLE IF NOT EXISTS sf_user_phones (
  phone   TEXT PRIMARY KEY,                  -- local digits, e.g. 0583206823
  user_id INTEGER NOT NULL REFERENCES sf_users(id) ON DELETE CASCADE,
  label   TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sf_sessions (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES sf_users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  user_agent   TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sf_login_attempts (
  key          TEXT PRIMARY KEY,
  failures     INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  locked_until INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sf_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Bank accounts. owner_id NULL = joint account.
CREATE TABLE IF NOT EXISTS sf_accounts (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  bank            TEXT NOT NULL DEFAULT '',
  branch          TEXT NOT NULL DEFAULT '',
  number          TEXT NOT NULL DEFAULT '',
  owner_id        INTEGER REFERENCES sf_users(id) ON DELETE SET NULL,
  opening_balance INTEGER NOT NULL DEFAULT 0,   -- balance at the start of opening_date
  opening_date    TEXT NOT NULL,
  is_active       INTEGER NOT NULL DEFAULT 1,
  sort            INTEGER NOT NULL DEFAULT 0
);

-- Credit cards. direct = charged from the account on the purchase date (debit);
-- regular = everything bought in a month is charged on billing_day of the next month.
CREATE TABLE IF NOT EXISTS sf_cards (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  last4       TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL CHECK (kind IN ('direct', 'regular')),
  account_id  INTEGER NOT NULL REFERENCES sf_accounts(id),
  billing_day INTEGER CHECK (billing_day BETWEEN 1 AND 31),
  owner_id    INTEGER REFERENCES sf_users(id) ON DELETE SET NULL,
  is_active   INTEGER NOT NULL DEFAULT 1,
  sort        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sf_categories (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('expense', 'income')),
  is_active INTEGER NOT NULL DEFAULT 1,
  sort      INTEGER NOT NULL DEFAULT 0
);

-- Fixed income/expenses: salary, standing orders, subscriptions...
-- Paid from: card_id, else account_id, else cash. auto = recorded by itself on its day;
-- otherwise it waits for a confirmation (with the real amount, e.g. a salary that changes).
CREATE TABLE IF NOT EXISTS sf_recurring (
  id              INTEGER PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('expense', 'income')),
  name            TEXT NOT NULL,
  amount          INTEGER NOT NULL,             -- expected amount (agorot)
  category_id     INTEGER REFERENCES sf_categories(id) ON DELETE SET NULL,
  account_id      INTEGER REFERENCES sf_accounts(id) ON DELETE SET NULL,
  card_id         INTEGER REFERENCES sf_cards(id) ON DELETE SET NULL,
  owner_id        INTEGER REFERENCES sf_users(id) ON DELETE SET NULL,
  day_of_month    INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
  interval_months INTEGER NOT NULL DEFAULT 1 CHECK (interval_months BETWEEN 1 AND 12),
  start_date      TEXT NOT NULL,
  end_date        TEXT,
  auto            INTEGER NOT NULL DEFAULT 1,
  is_active       INTEGER NOT NULL DEFAULT 1,
  note            TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- An occurrence the user chose to skip (did not happen this time).
CREATE TABLE IF NOT EXISTS sf_recurring_skips (
  recurring_id INTEGER NOT NULL REFERENCES sf_recurring(id) ON DELETE CASCADE,
  occurrence   TEXT NOT NULL,
  PRIMARY KEY (recurring_id, occurrence)
);

-- Every income/expense. date = when it happened; charge_date = when it hits the account.
CREATE TABLE IF NOT EXISTS sf_transactions (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('expense', 'income')),
  amount       INTEGER NOT NULL CHECK (amount >= 0),
  date         TEXT NOT NULL,
  charge_date  TEXT NOT NULL,
  category_id  INTEGER REFERENCES sf_categories(id) ON DELETE SET NULL,
  account_id   INTEGER REFERENCES sf_accounts(id) ON DELETE SET NULL,
  card_id      INTEGER REFERENCES sf_cards(id) ON DELETE SET NULL,
  owner_id     INTEGER REFERENCES sf_users(id) ON DELETE SET NULL,   -- whose income/expense (NULL = shared)
  user_id      INTEGER REFERENCES sf_users(id) ON DELETE SET NULL,   -- who entered it
  recurring_id INTEGER REFERENCES sf_recurring(id) ON DELETE SET NULL,
  occurrence   TEXT,
  note         TEXT NOT NULL DEFAULT '',
  source       TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'phone', 'recurring')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at   TEXT,
  UNIQUE (recurring_id, occurrence)
);
CREATE INDEX IF NOT EXISTS sf_transactions_date ON sf_transactions(date);
CREATE INDEX IF NOT EXISTS sf_transactions_charge ON sf_transactions(charge_date);

-- Phone line: how many entries were saved in each call (keeps the read names unique, and a retry from
-- Yemot does not save the same entry twice).
CREATE TABLE IF NOT EXISTS sf_ivr_calls (
  call_id    TEXT PRIMARY KEY,
  saved      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

INSERT INTO sf_categories (name, kind, sort) VALUES
  ('מזון וסופר', 'expense', 1),
  ('דיור ומשכנתא', 'expense', 2),
  ('חשמל מים וגז', 'expense', 3),
  ('תחבורה ודלק', 'expense', 4),
  ('ילדים וחינוך', 'expense', 5),
  ('בריאות', 'expense', 6),
  ('ביגוד', 'expense', 7),
  ('תקשורת', 'expense', 8),
  ('צדקה ומעשרות', 'expense', 9),
  ('שונות', 'expense', 10),
  ('משכורת', 'income', 1),
  ('קצבאות', 'income', 2),
  ('הכנסה אחרת', 'income', 3);
