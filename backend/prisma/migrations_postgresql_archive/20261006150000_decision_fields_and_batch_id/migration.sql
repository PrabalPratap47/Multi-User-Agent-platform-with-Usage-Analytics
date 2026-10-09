-- Batch CV processing: groups runs created by one batch upload (see
-- CvDocument.batchId, stamped with the same value). Nullable - most runs
-- are not part of a batch.
ALTER TABLE "agent_runs" ADD COLUMN "batchId" TEXT;
CREATE INDEX "agent_runs_batchId_idx" ON "agent_runs"("batchId");

-- Decision workflow: a decision record must be a self-contained audit
-- row (CV ID, agent run ID directly queryable, not only reachable via a
-- join through the recommendation), and "final category" must be able to
-- represent "none" for REJECT - a single combined array can't express
-- that distinction cleanly, hence splitting into primary + secondary.
ALTER TABLE "recommendation_decisions" ADD COLUMN "cvDocumentId" INTEGER;
ALTER TABLE "recommendation_decisions" ADD COLUMN "agentRunId" TEXT;
ALTER TABLE "recommendation_decisions" ADD COLUMN "finalPrimaryCategory" TEXT;
ALTER TABLE "recommendation_decisions" ADD COLUMN "finalSecondaryCategories" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Backfill from the referenced recommendation for any existing rows
-- (demo/seed data only in practice) - running `npm run db:seed`
-- afterwards regenerates it with the new shape regardless.
UPDATE "recommendation_decisions" rd
SET "cvDocumentId" = cr."cvDocumentId",
    "agentRunId" = cr."runId",
    "finalPrimaryCategory" = rd."finalCategories"[1]
FROM "cv_recommendations" cr
WHERE cr."id" = rd."recommendationId";

ALTER TABLE "recommendation_decisions" ALTER COLUMN "cvDocumentId" SET NOT NULL;
ALTER TABLE "recommendation_decisions" DROP COLUMN "finalCategories";

ALTER TABLE "recommendation_decisions" ADD CONSTRAINT "recommendation_decisions_cvDocumentId_fkey" FOREIGN KEY ("cvDocumentId") REFERENCES "cv_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recommendation_decisions" ADD CONSTRAINT "recommendation_decisions_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "recommendation_decisions_cvDocumentId_idx" ON "recommendation_decisions"("cvDocumentId");
CREATE INDEX "recommendation_decisions_agentRunId_idx" ON "recommendation_decisions"("agentRunId");

-- Business rule: REJECT must have no final category; ACCEPT/MODIFY must
-- have one. Enforced here as a DB-level safety net in addition to Zod
-- validation in validators.ts (same pattern as the reason-required check
-- in the initial migration).
ALTER TABLE "recommendation_decisions" ADD CONSTRAINT "recommendation_decisions_final_category_presence_check" CHECK (
  ("decisionType" = 'REJECT' AND "finalPrimaryCategory" IS NULL) OR
  ("decisionType" != 'REJECT' AND "finalPrimaryCategory" IS NOT NULL)
);
