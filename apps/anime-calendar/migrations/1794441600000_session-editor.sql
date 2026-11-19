-- Up Migration
ALTER TABLE group_sessions ADD COLUMN plan_json TEXT;
ALTER TABLE group_sessions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;

-- Down Migration
ALTER TABLE group_sessions DROP COLUMN revision;
ALTER TABLE group_sessions DROP COLUMN plan_json;
