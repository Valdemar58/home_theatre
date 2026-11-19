# Calendar database

PostgreSQL is the default calendar database. Other services retain their own databases. The default deployment uses a private `calendar-db` container (`postgres:17-alpine`) and the named volume `calendar-db`; no database port is published. Authentik's separate PostgreSQL database is unchanged.

The private local database uses `CALENDAR_DB_SSLMODE=disable`; configure `require` or certificate verification for an external server that supports TLS.

## Start / upgrade

```powershell
python scripts/init.py
docker compose up -d --build anime-calendar
```

`init.py` generates `CALENDAR_DB_PASSWORD` without replacing existing credentials. The calendar waits for PostgreSQL readiness. Before HTTP or background jobs start, `node-pg-migrate` applies pending SQL migrations in one transaction under an advisory lock.

On the first upgrade, an existing `/data/anime-calendar.db` is imported automatically into an empty PostgreSQL database. Import:

- creates a consistent, timestamped SQLite backup next to the source;
- refuses to overwrite nonempty application tables;
- transfers all tables in one transaction with deferred foreign keys;
- verifies row counts and a content checksum for every table, including binary embeddings;
- advances generated identity sequences and validates foreign keys before commit;
- records a completion marker so future starts do not repeat the import.

The original SQLite file and snapshot remain on disk. Do not run another SQLite-writing calendar during the cutover. For a manual transfer, stop the old calendar and run:

```powershell
docker compose run --rm --no-deps anime-calendar node database/migrate.mjs up
docker compose run --rm --no-deps anime-calendar node database/import-sqlite.mjs /data/anime-calendar.db
docker compose up -d anime-calendar
```

For a deliberately empty installation, set `DATABASE_IMPORT_SQLITE=off`. When an operator runs migrations separately, set `DATABASE_MIGRATE=false`. The database health endpoint is `/api/health/database`; it does not expose connection credentials.

## External PostgreSQL

Set either `DATABASE_URL` (a standard PostgreSQL connection URL, including TLS options) or `CALENDAR_DB_HOST`, `CALENDAR_DB_PORT`, `CALENDAR_DB_NAME`, `CALENDAR_DB_USER`, `CALENDAR_DB_PASSWORD`, and `CALENDAR_DB_SSLMODE` in the root `.env`. Add `compose.external-db.yml` to `COMPOSE_FILE` so the local database is not started or required. For example:

```dotenv
COMPOSE_FILE=docker-compose.yml:compose.nvidia.yml:compose.external-db.yml
CALENDAR_DB_HOST=postgres.internal
CALENDAR_DB_PORT=5432
CALENDAR_DB_NAME=calendar
CALENDAR_DB_USER=calendar
CALENDAR_DB_SSLMODE=require
```

Supply the password privately in `.env`. The database must exist and the account must be allowed to create tables, indexes, sequences, and the migration history. Use a separate migration account and `DATABASE_MIGRATE=false` if the runtime account has restricted DDL permissions. For an external database the host and certificates must be accessible from the calendar container.

When running the app directly, set `DATABASE_URL` or standard `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, and `PGSSLMODE`; then `npm run dev`. The app does not read the repository root `.env` automatically outside Compose. `DATABASE_STATEMENT_TIMEOUT_MS` defaults to 30000.

Use a Node.js build with `node:sqlite` support and Node 22.16 or newer for the legacy import/snapshot tools. The Docker image supplies the supported runtime.

## Schema changes

SQL migrations live in `apps/anime-calendar/migrations`. Never edit an applied migration; add a new one:

```powershell
cd apps/anime-calendar
npm run db:create-migration -- describe-change
npm run db:migrate
```

Migration history is in `calendar_migrations`. Migrations use `-- Up Migration` / `-- Down Migration` sections. `npm run db:rollback` reverts one migration when its down section supports it; destructive baseline rollback is deliberately disabled. Back up before destructive changes. SQLite's old inline migrations are retained only for explicit legacy fixtures/rollback, not for PostgreSQL schema management.

The business code retains its synchronous statement API. Network I/O runs in a Synckit worker using `pg`, with a dedicated connection per Node process, so transaction boundaries remain on the same connection. This is a compatibility boundary, not a concurrent query pool: slow remote database calls still block the caller. Parameter compilation understands quoted strings, comments and repeated numbered parameters; SQL upserts and aggregates use PostgreSQL syntax. Connection loss does not replay writes or resume an interrupted transaction on another connection.

Production builds use Next.js's Webpack path because Turbopack currently attempts to execute Synckit's `.d.cts` declarations during external dependency tracing. The runtime image explicitly includes the worker, migrations, and production dependencies.

## Backup and restore

`python scripts/backup.py` now writes a consistent PostgreSQL custom-format dump to `config/anime-calendar/postgres.dump` before archiving the configuration. This dump contains schema, data, identities, and migration history. A database dump failure fails the backup instead of silently producing an archive without the calendar database.

The restored archive's dump is restored by `scripts/restore.py` before the app is started. Restore requires an empty target database and runs as a single transaction. An existing database is never cleaned or overwritten automatically.

Manual commands (the source dump is inside the calendar's `/data` mount):

```powershell
docker compose exec -T anime-calendar node database/backup.mjs
docker compose run --rm --no-deps anime-calendar node database/restore.mjs /data/postgres.dump
```

`DATABASE_DRIVER=sqlite` is an explicit fallback for the retained old SQLite database, with `compose.external-db.yml` to remove the local PostgreSQL dependency if needed. It is not a reverse migration: PostgreSQL writes made after cutover are not copied back to SQLite. A rollback after users have written to PostgreSQL must restore a suitable PostgreSQL backup or deliberately reconcile those writes.

## Verification

```powershell
docker compose -f docker-compose.yml -f compose.test.yml run --build --rm calendar-test
```

Tests run on an isolated internal network against a disposable PostgreSQL database with tmpfs storage. They apply migrations twice, ask PostgreSQL to parse all static application queries, test SQLite transfer/content validation/refusal to overwrite/rollback/identity advancement, and run the application regression suite. They never connect to the live calendar database. Stop the test database with `docker compose -f docker-compose.yml -f compose.test.yml stop calendar-test-db` after testing.
