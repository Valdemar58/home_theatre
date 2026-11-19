-- Up Migration
CREATE TABLE watch_cycles (
 id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 anilist_id INTEGER NOT NULL, baseline INTEGER NOT NULL DEFAULT 0,
 prior_completed INTEGER NOT NULL DEFAULT 0, started_at BIGINT, last_activity BIGINT NOT NULL,
 ended_at BIGINT, outcome TEXT, idle_since BIGINT, created_at BIGINT NOT NULL
);
CREATE INDEX watch_cycles_user ON watch_cycles(user_id, anilist_id);
CREATE TABLE watch_episode_events (
 id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL REFERENCES watch_cycles(id) ON DELETE CASCADE,
 ep INTEGER NOT NULL, source TEXT NOT NULL, actor_id INTEGER NOT NULL,
 meeting_id INTEGER, created_at BIGINT NOT NULL, revoked_at BIGINT, revoked_by INTEGER,
 UNIQUE(cycle_id,ep,source,id)
);
ALTER TABLE playback_coverage ADD COLUMN cycle_id TEXT REFERENCES watch_cycles(id);
CREATE TABLE meeting_history (
 id TEXT PRIMARY KEY, meeting_id INTEGER NOT NULL REFERENCES group_sessions(id) ON DELETE CASCADE,
 actor_id INTEGER NOT NULL, created_at BIGINT NOT NULL, payload TEXT NOT NULL
);
CREATE INDEX meeting_history_meeting ON meeting_history(meeting_id,created_at);
CREATE TABLE meeting_coverage (
 meeting_id INTEGER NOT NULL REFERENCES group_sessions(id) ON DELETE CASCADE,
 anilist_id INTEGER NOT NULL, ep INTEGER NOT NULL, user_id INTEGER NOT NULL,
 attempt TEXT NOT NULL, duration DOUBLE PRECISION NOT NULL, intervals TEXT NOT NULL DEFAULT '[]',
 seen TEXT NOT NULL DEFAULT '[]', updated_at BIGINT NOT NULL,
 PRIMARY KEY(meeting_id,user_id,attempt)
);
CREATE TABLE watch_preferences (
 user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 inactivity_days INTEGER NOT NULL DEFAULT 60
);
ALTER TABLE group_sessions ADD COLUMN actual_started_at BIGINT;
CREATE TABLE watch_sync_receipts (key TEXT PRIMARY KEY);
-- Down Migration
DROP TABLE watch_sync_receipts;
ALTER TABLE group_sessions DROP COLUMN actual_started_at;
DROP TABLE watch_preferences;
DROP TABLE meeting_coverage;
DROP TABLE meeting_history;
ALTER TABLE playback_coverage DROP COLUMN cycle_id;
DROP TABLE watch_episode_events;
DROP TABLE watch_cycles;
