-- Paying for someone else: an expense can say whom it was for (for_name), and money they give back is
-- an income linked to it (reimburse_of). Reports count it as less expense, not as income.
ALTER TABLE sf_transactions ADD COLUMN for_name TEXT;
ALTER TABLE sf_transactions ADD COLUMN reimburse_of INTEGER REFERENCES sf_transactions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS sf_transactions_reimburse ON sf_transactions(reimburse_of);
