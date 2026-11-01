-- Up Migration
CREATE TABLE calendar_data_imports (
  source_sha256 TEXT PRIMARY KEY,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  report JSONB NOT NULL
);

-- Down Migration
DROP TABLE calendar_data_imports;
