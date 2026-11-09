-- A regular card's bill that had already built up before tracking started (purchases we never recorded):
-- the user types it in from the card's app, and it hits the account on the billing day.
-- SQLite cannot change a CHECK constraint, so sf_account_moves is rebuilt with kind 'card_bill' and card_id.
CREATE TABLE sf_account_moves_new (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('adjust', 'transfer', 'held', 'card_bill')),
  account_id  INTEGER REFERENCES sf_accounts(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  held_id     INTEGER REFERENCES sf_held_funds(id) ON DELETE CASCADE,
  held_amount INTEGER NOT NULL DEFAULT 0,
  pair_id     INTEGER,
  card_id     INTEGER REFERENCES sf_cards(id) ON DELETE CASCADE,
  note        TEXT NOT NULL DEFAULT '',
  user_id     INTEGER REFERENCES sf_users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
INSERT INTO sf_account_moves_new (id, kind, account_id, date, amount, held_id, held_amount, pair_id, note, user_id, created_at)
  SELECT id, kind, account_id, date, amount, held_id, held_amount, pair_id, note, user_id, created_at FROM sf_account_moves;
DROP TABLE sf_account_moves;
ALTER TABLE sf_account_moves_new RENAME TO sf_account_moves;
CREATE INDEX IF NOT EXISTS sf_account_moves_account ON sf_account_moves(account_id, date);
CREATE INDEX IF NOT EXISTS sf_account_moves_held ON sf_account_moves(held_id);
CREATE INDEX IF NOT EXISTS sf_account_moves_card ON sf_account_moves(card_id);
