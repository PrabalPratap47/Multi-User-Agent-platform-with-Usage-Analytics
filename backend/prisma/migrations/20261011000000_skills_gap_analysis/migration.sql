-- CV Skills Extraction & Gap Analysis Agent: saved analyses.
-- Additive only: one new table and its indexes; no existing table is changed.

-- CreateTable
CREATE TABLE "skills_gap_analyses" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "runId" TEXT,
    "userId" INTEGER NOT NULL,
    "agentId" INTEGER NOT NULL,
    "targetRole" TEXT NOT NULL,
    "cvFileName" TEXT,
    "cvCharCount" INTEGER NOT NULL,
    "result" JSONB NOT NULL,
    "rawResponse" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "skills_gap_analyses_runId_fkey" FOREIGN KEY ("runId") REFERENCES "agent_runs" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "skills_gap_analyses_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "skills_gap_analyses_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "skills_gap_analyses_runId_key" ON "skills_gap_analyses"("runId");

-- CreateIndex
CREATE INDEX "skills_gap_analyses_userId_createdAt_idx" ON "skills_gap_analyses"("userId", "createdAt" DESC);
