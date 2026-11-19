-- Up Migration
CREATE TABLE playback_coverage (
  sid TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  anilist_id INTEGER NOT NULL,
  ep INTEGER NOT NULL,
  duration DOUBLE PRECISION NOT NULL,
  item_key TEXT,
  watched INTEGER NOT NULL DEFAULT 0,
  intervals TEXT NOT NULL DEFAULT '[]',
  updated_at BIGINT NOT NULL
);
CREATE INDEX playback_coverage_user ON playback_coverage(user_id, anilist_id, ep);

-- Down Migration
DROP TABLE playback_coverage;
