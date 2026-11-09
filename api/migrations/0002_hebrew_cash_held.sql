-- 1. Recurring items by the Hebrew calendar (e.g. a kollel salary on Rosh Chodesh = day 1 of the Hebrew month).
ALTER TABLE sf_recurring ADD COLUMN calendar TEXT NOT NULL DEFAULT 'gregorian' CHECK (calendar IN ('gregorian', 'hebrew'));

-- 2. Accounts are a bank account or a cash wallet.
ALTER TABLE sf_accounts ADD COLUMN kind TEXT NOT NULL DEFAULT 'bank' CHECK (kind IN ('bank', 'cash'));
INSERT INTO sf_accounts (name, kind, opening_balance, opening_date, sort)
SELECT 'מזומן', 'cash', 0, date('now'), 999 WHERE NOT EXISTS (SELECT 1 FROM sf_accounts WHERE kind = 'cash');

-- 3. Money held for others (it sits in my account but is not mine, until they ask for it).
CREATE TABLE IF NOT EXISTS sf_held_funds (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,                  -- whose money
  note       TEXT NOT NULL DEFAULT '',
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- 4. Money movements that are not income/expense: a balance correction ("I have X now"), a transfer
--    between accounts (cash withdrawal), and receiving / returning money held for others.
--    amount is signed: its effect on account_id (NULL = touches no account, e.g. held money that was
--    already included in the balance when it was entered).
--    For held money the fund's balance is the sum of its moves' amounts (in = +, returned = -).
CREATE TABLE IF NOT EXISTS sf_account_moves (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('adjust', 'transfer', 'held')),
  account_id  INTEGER REFERENCES sf_accounts(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  held_id     INTEGER REFERENCES sf_held_funds(id) ON DELETE CASCADE,
  held_amount INTEGER NOT NULL DEFAULT 0,    -- change of the held fund (+ received, - returned)
  pair_id     INTEGER,                        -- the other half of a transfer
  note        TEXT NOT NULL DEFAULT '',
  user_id     INTEGER REFERENCES sf_users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS sf_account_moves_account ON sf_account_moves(account_id, date);
CREATE INDEX IF NOT EXISTS sf_account_moves_held ON sf_account_moves(held_id);
