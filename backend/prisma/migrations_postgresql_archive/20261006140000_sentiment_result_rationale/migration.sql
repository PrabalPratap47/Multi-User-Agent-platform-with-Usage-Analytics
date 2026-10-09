-- The Sentiment Agent's required output contract always includes a
-- rationale (see agents/sentiment/schema.ts), so the column is renamed
-- from the earlier scaffold-era "reasoning" to "rationale" (matching the
-- CV agent's naming) and made non-nullable.
--
-- Fill any existing NULLs first so SET NOT NULL cannot fail against a
-- database that already has rows from the previous optional column.
UPDATE "sentiment_results" SET "reasoning" = 'No rationale provided' WHERE "reasoning" IS NULL;

ALTER TABLE "sentiment_results" RENAME COLUMN "reasoning" TO "rationale";
ALTER TABLE "sentiment_results" ALTER COLUMN "rationale" SET NOT NULL;
