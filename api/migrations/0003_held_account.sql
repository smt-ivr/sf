-- Money held for others is kept in a specific account: per account we show how much of it is theirs
-- and how much is missing there (if it was used) until it is returned.
ALTER TABLE sf_held_funds ADD COLUMN account_id INTEGER REFERENCES sf_accounts(id) ON DELETE SET NULL;
