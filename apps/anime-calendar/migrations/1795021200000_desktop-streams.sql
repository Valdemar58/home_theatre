-- Up Migration
CREATE TABLE desktop_room_sources (
 room_id TEXT PRIMARY KEY REFERENCES watch_rooms(id) ON DELETE CASCADE,
 device_id TEXT REFERENCES desktop_devices(id) ON DELETE SET NULL
);
-- Down Migration
DROP TABLE desktop_room_sources;
