-- Up Migration
ALTER TABLE shared_lists ADD COLUMN permissions TEXT;
ALTER TABLE shared_list_items ADD COLUMN planning_state TEXT NOT NULL DEFAULT 'accepted'
  CHECK (planning_state IN ('proposed', 'accepted'));

-- Down Migration
ALTER TABLE shared_list_items DROP COLUMN planning_state;
ALTER TABLE shared_lists DROP COLUMN permissions;
