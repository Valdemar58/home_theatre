-- Up Migration
ALTER TABLE watch_cycles ADD COLUMN initial_status TEXT;
-- Down Migration
ALTER TABLE watch_cycles DROP COLUMN initial_status;
