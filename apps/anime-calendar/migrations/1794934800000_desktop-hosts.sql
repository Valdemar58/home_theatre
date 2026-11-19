-- Up Migration
CREATE TABLE desktop_devices (
 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
 label TEXT NOT NULL, platform TEXT NOT NULL, created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL,
 last_seen BIGINT NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0, inventory TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE desktop_grants (
 device_id TEXT NOT NULL REFERENCES desktop_devices(id) ON DELETE CASCADE,
 list_id BIGINT NOT NULL REFERENCES shared_lists(id) ON DELETE CASCADE,
 anilist_id BIGINT NOT NULL, PRIMARY KEY(device_id,list_id,anilist_id)
);
-- Down Migration
DROP TABLE desktop_grants;
DROP TABLE desktop_devices;
