-- Up Migration
ALTER TABLE account_tokens ADD COLUMN token_secret TEXT;

-- Down Migration
ALTER TABLE account_tokens DROP COLUMN token_secret;
