-- The CV Classification Agent's required output shape stores rationale as
-- Array<{ category, evidence }> (one evidence citation per category it
-- comments on), not a single prose string. Widening the column to JSONB
-- preserves that structure losslessly instead of flattening it.
--
-- USING to_jsonb("rationale") keeps this safe to run against a database
-- that already has rows from the previous TEXT column (e.g. demo data
-- seeded before this migration) - each existing string is wrapped as a
-- JSON string scalar rather than failing the migration. Re-running
-- `npm run db:seed` afterwards overwrites those rows with the new
-- structured shape regardless.
ALTER TABLE "cv_recommendations"
  ALTER COLUMN "rationale" TYPE JSONB USING to_jsonb("rationale");
