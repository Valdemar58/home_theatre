-- Up Migration
CREATE TABLE desktop_installations (
 key_hash TEXT PRIMARY KEY,
 device_id TEXT NOT NULL UNIQUE REFERENCES desktop_devices(id) ON DELETE CASCADE
);
-- Down Migration
DROP TABLE desktop_installations;
