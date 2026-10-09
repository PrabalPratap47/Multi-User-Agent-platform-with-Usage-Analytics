-- Links each agent run to the CV it classifies and records a safe failure
-- reason, so batch status can report every file's own state.
--
-- Hand-written: `prisma migrate diff` proposes rebuilding agent_runs
-- (RedefineTables), which would silently drop the hand-written
-- agent_runs_status_check constraint from the init migration. SQLite's
-- ADD COLUMN keeps the existing table (and its CHECK) intact; a REFERENCES
-- clause is allowed here because the new column defaults to NULL.
ALTER TABLE "agent_runs" ADD COLUMN "cvDocumentId" INTEGER REFERENCES "cv_documents" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "agent_runs" ADD COLUMN "errorMessage" TEXT;

CREATE INDEX "agent_runs_cvDocumentId_idx" ON "agent_runs"("cvDocumentId");
