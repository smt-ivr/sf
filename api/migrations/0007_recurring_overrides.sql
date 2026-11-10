-- A different amount for one occurrence of a recurring item (a credit, a partial month...).
-- Used when the occurrence is recorded and in the forecast; the item's usual amount stays.
CREATE TABLE IF NOT EXISTS sf_recurring_overrides (
  recurring_id INTEGER NOT NULL REFERENCES sf_recurring(id) ON DELETE CASCADE,
  occurrence   TEXT NOT NULL,
  amount       INTEGER NOT NULL CHECK (amount >= 0),
  note         TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (recurring_id, occurrence)
);
