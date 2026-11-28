-- prisma/sql/least_privilege_runtime_role.sql
--
-- Least-privilege runtime role for the Calibr8 API (SECURITY_AUDIT.md SA-M5).
--
-- The API currently connects as the database owner, which can DROP, TRUNCATE
-- and ALTER every table. The API needs data access only: it never changes the
-- schema at runtime (schema changes are applied by an operator with the owner
-- role, see AGENTS.md section 4).
--
-- NOT applied by any code path. Owner action:
--   1. Run on a Neon branch first, as the owner role:
--        psql "$OWNER_DATABASE_URL" -v app_password="$(openssl rand -hex 24)" \
--             -f prisma/sql/least_privilege_runtime_role.sql
--      (or create the role in the Neon console and run only the GRANT part).
--   2. Point the API's DATABASE_URL at calibr8_app on that branch and run
--      the test suite against it.
--   3. Then repeat on production, update DATABASE_URL in the hosting
--      platform, deploy, and keep the owner URL out of the API's environment.
-- Rollback: point DATABASE_URL back at the owner role (the role can stay).
--
-- Verified 2026-11-27 on PostgreSQL 16 (local test database): the API test
-- suites pass as calibr8_app, and CREATE/DROP/ALTER/TRUNCATE are refused.

\set ON_ERROR_STOP on

BEGIN;

CREATE ROLE calibr8_app LOGIN PASSWORD :'app_password' NOINHERIT;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO calibr8_app', current_database());
END $$;

GRANT USAGE ON SCHEMA public TO calibr8_app;
-- Data access only: no TRUNCATE, REFERENCES, TRIGGER, and no CREATE on the schema.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO calibr8_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO calibr8_app;
-- Tables and sequences the owner creates later get the same grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO calibr8_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO calibr8_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Bounded work per statement / transaction (server-side, so they also apply
-- through the Neon connection pooler).
ALTER ROLE calibr8_app SET statement_timeout = '30s';
ALTER ROLE calibr8_app SET lock_timeout = '10s';
ALTER ROLE calibr8_app SET idle_in_transaction_session_timeout = '60s';

COMMIT;
