-- Rollback for 20261120000000_complexity_profiles.
-- Drops only the profiling table; submissions and every other table are untouched.
DROP TABLE IF EXISTS "public"."complexity_profiles";
