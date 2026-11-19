-- Up Migration
CREATE TABLE desktop_commands (
 id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES desktop_devices(id) ON DELETE CASCADE,
 kind TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
 result TEXT NOT NULL DEFAULT '{}', created_at BIGINT NOT NULL
);
CREATE INDEX desktop_commands_device ON desktop_commands(device_id,created_at);
CREATE TABLE desktop_download_state (
 device_id TEXT PRIMARY KEY REFERENCES desktop_devices(id) ON DELETE CASCADE,
 snapshot TEXT NOT NULL DEFAULT '[]', updated_at BIGINT NOT NULL
);
-- Down Migration
DROP TABLE desktop_download_state;
DROP TABLE desktop_commands;
