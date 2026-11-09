-- When the opening balance was entered. Every entry recorded after that moment counts in the balance,
-- whatever its date (e.g. an expense from three days ago, recorded after the balance was set).
-- Entries recorded before it count only if they hit the account after the opening date.
ALTER TABLE sf_accounts ADD COLUMN opening_at TEXT;
UPDATE sf_accounts SET opening_at = opening_date || 'T00:00:00Z' WHERE opening_at IS NULL;
-- "Tracking start" is no longer a setting: it is the day of the first balance entered.
DELETE FROM sf_settings WHERE key = 'tracking_start';
