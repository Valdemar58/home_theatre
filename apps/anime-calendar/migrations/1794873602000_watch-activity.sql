-- Up Migration
ALTER TABLE watch_log ADD COLUMN cycle_id TEXT;
ALTER TABLE watch_log ADD COLUMN ep INTEGER;
CREATE UNIQUE INDEX watch_log_cycle_episode ON watch_log(cycle_id,ep) WHERE cycle_id IS NOT NULL;
-- Down Migration
DROP INDEX watch_log_cycle_episode;
ALTER TABLE watch_log DROP COLUMN ep;
ALTER TABLE watch_log DROP COLUMN cycle_id;
