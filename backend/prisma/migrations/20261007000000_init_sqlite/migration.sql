-- SQLite baseline. Generated with
--   prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
-- then extended by hand with CHECK constraints (marked "-- hand-written").
-- Replaces the PostgreSQL history archived in prisma/migrations_postgresql_archive/
-- (see docs/DATABASE.md). SQLite only accepts CHECK constraints inside
-- CREATE TABLE, so they are inlined here rather than added with ALTER TABLE.

-- CreateTable
CREATE TABLE "users" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    -- hand-written: enum Role
    CONSTRAINT "users_role_check" CHECK ("role" IN ('ADMIN', 'USER'))
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tokenHash" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "agents" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "version" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" INTEGER NOT NULL,
    "agentId" INTEGER NOT NULL,
    "agentName" TEXT NOT NULL,
    "batchId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_runs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "agent_runs_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    -- hand-written: enum RunStatus
    CONSTRAINT "agent_runs_status_check" CHECK ("status" IN ('PENDING', 'RUNNING', 'SUCCESS', 'ERROR'))
);

-- CreateTable
CREATE TABLE "llm_usage_logs" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "timestamp" DATETIME NOT NULL,
    "runId" TEXT,
    "userId" INTEGER NOT NULL,
    "agentId" INTEGER NOT NULL,
    "agentName" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "estimatedCost" REAL,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "isSeedData" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "llm_usage_logs_runId_fkey" FOREIGN KEY ("runId") REFERENCES "agent_runs" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "llm_usage_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "llm_usage_logs_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    -- hand-written: enum LogStatus
    CONSTRAINT "llm_usage_logs_status_check" CHECK ("status" IN ('SUCCESS', 'ERROR'))
);

-- CreateTable
CREATE TABLE "cv_documents" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "batchId" TEXT,
    "fileName" TEXT,
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cv_documents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "cv_recommendations" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "cvDocumentId" INTEGER NOT NULL,
    "runId" TEXT,
    "userId" INTEGER NOT NULL,
    "agentId" INTEGER NOT NULL,
    "primaryCategory" TEXT NOT NULL,
    "secondaryCategories" JSONB NOT NULL,
    "confidenceScore" REAL NOT NULL,
    "confidenceScores" JSONB NOT NULL,
    "rationale" JSONB NOT NULL,
    "rawResponse" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cv_recommendations_cvDocumentId_fkey" FOREIGN KEY ("cvDocumentId") REFERENCES "cv_documents" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "cv_recommendations_runId_fkey" FOREIGN KEY ("runId") REFERENCES "agent_runs" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "cv_recommendations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "cv_recommendations_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "recommendation_decisions" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "recommendationId" INTEGER NOT NULL,
    "cvDocumentId" INTEGER NOT NULL,
    "agentRunId" TEXT,
    "userId" INTEGER NOT NULL,
    "decisionType" TEXT NOT NULL,
    "finalPrimaryCategory" TEXT,
    "finalSecondaryCategories" JSONB NOT NULL,
    "reason" TEXT,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "recommendation_decisions_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "cv_recommendations" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "recommendation_decisions_cvDocumentId_fkey" FOREIGN KEY ("cvDocumentId") REFERENCES "cv_documents" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "recommendation_decisions_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "agent_runs" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "recommendation_decisions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    -- hand-written: enum DecisionType
    CONSTRAINT "recommendation_decisions_decisionType_check" CHECK ("decisionType" IN ('ACCEPT', 'MODIFY', 'REJECT')),
    -- hand-written business rule: reason is mandatory unless the decision is ACCEPT
    -- (also enforced by Zod in src/utils/validators.ts)
    CONSTRAINT "recommendation_decisions_reason_required_check" CHECK (
        "decisionType" = 'ACCEPT' OR ("reason" IS NOT NULL AND length(trim("reason")) > 0)
    ),
    -- hand-written business rule: REJECT has no final category; ACCEPT/MODIFY must have one
    CONSTRAINT "recommendation_decisions_final_category_presence_check" CHECK (
        ("decisionType" = 'REJECT' AND "finalPrimaryCategory" IS NULL) OR
        ("decisionType" != 'REJECT' AND "finalPrimaryCategory" IS NOT NULL)
    )
);

-- CreateTable
CREATE TABLE "sentiment_results" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "runId" TEXT,
    "userId" INTEGER NOT NULL,
    "agentId" INTEGER NOT NULL,
    "inputText" TEXT NOT NULL,
    "sentiment" TEXT NOT NULL,
    "confidence" REAL NOT NULL,
    "rationale" TEXT NOT NULL,
    "rawResponse" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sentiment_results_runId_fkey" FOREIGN KEY ("runId") REFERENCES "agent_runs" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "sentiment_results_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "sentiment_results_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    -- hand-written: enum Sentiment
    CONSTRAINT "sentiment_results_sentiment_check" CHECK ("sentiment" IN ('POSITIVE', 'NEUTRAL', 'NEGATIVE'))
);

-- CreateTable
CREATE TABLE "external_agent_logs" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "sourceAgentName" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileFormat" TEXT NOT NULL,
    "totalRecords" INTEGER NOT NULL,
    "validRecords" INTEGER NOT NULL,
    "invalidRecords" INTEGER NOT NULL,
    "parseErrors" JSONB NOT NULL,
    "importTimestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    CONSTRAINT "external_agent_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "external_agent_log_records" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "importId" INTEGER NOT NULL,
    "rawRecord" JSONB NOT NULL,
    "timestamp" DATETIME NOT NULL,
    "externalUserId" TEXT,
    "agentName" TEXT NOT NULL,
    "model" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "latencyMs" INTEGER,
    "rawStatus" TEXT,
    "isError" BOOLEAN NOT NULL,
    "estimatedCost" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "external_agent_log_records_importId_fkey" FOREIGN KEY ("importId") REFERENCES "external_agent_logs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_idx" ON "refresh_tokens"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "agents_name_key" ON "agents"("name");

-- CreateIndex
CREATE INDEX "agent_runs_userId_createdAt_idx" ON "agent_runs"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "agent_runs_agentId_createdAt_idx" ON "agent_runs"("agentId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "agent_runs_status_idx" ON "agent_runs"("status");

-- CreateIndex
CREATE INDEX "agent_runs_batchId_idx" ON "agent_runs"("batchId");

-- CreateIndex
CREATE INDEX "llm_usage_logs_userId_createdAt_idx" ON "llm_usage_logs"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "llm_usage_logs_agentId_createdAt_idx" ON "llm_usage_logs"("agentId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "llm_usage_logs_createdAt_idx" ON "llm_usage_logs"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "llm_usage_logs_runId_idx" ON "llm_usage_logs"("runId");

-- CreateIndex
CREATE INDEX "llm_usage_logs_status_idx" ON "llm_usage_logs"("status");

-- CreateIndex
CREATE INDEX "llm_usage_logs_isSeedData_idx" ON "llm_usage_logs"("isSeedData");

-- CreateIndex
CREATE INDEX "cv_documents_userId_batchId_idx" ON "cv_documents"("userId", "batchId");

-- CreateIndex
CREATE INDEX "cv_documents_userId_createdAt_idx" ON "cv_documents"("userId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "cv_recommendations_runId_key" ON "cv_recommendations"("runId");

-- CreateIndex
CREATE INDEX "cv_recommendations_userId_createdAt_idx" ON "cv_recommendations"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "cv_recommendations_primaryCategory_idx" ON "cv_recommendations"("primaryCategory");

-- CreateIndex
CREATE INDEX "cv_recommendations_cvDocumentId_idx" ON "cv_recommendations"("cvDocumentId");

-- CreateIndex
CREATE INDEX "recommendation_decisions_recommendationId_idx" ON "recommendation_decisions"("recommendationId");

-- CreateIndex
CREATE INDEX "recommendation_decisions_cvDocumentId_idx" ON "recommendation_decisions"("cvDocumentId");

-- CreateIndex
CREATE INDEX "recommendation_decisions_agentRunId_idx" ON "recommendation_decisions"("agentRunId");

-- CreateIndex
CREATE INDEX "recommendation_decisions_userId_timestamp_idx" ON "recommendation_decisions"("userId", "timestamp" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "sentiment_results_runId_key" ON "sentiment_results"("runId");

-- CreateIndex
CREATE INDEX "sentiment_results_userId_createdAt_idx" ON "sentiment_results"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "external_agent_logs_userId_importTimestamp_idx" ON "external_agent_logs"("userId", "importTimestamp" DESC);

-- CreateIndex
CREATE INDEX "external_agent_log_records_importId_idx" ON "external_agent_log_records"("importId");

-- CreateIndex
CREATE INDEX "external_agent_log_records_agentName_idx" ON "external_agent_log_records"("agentName");

-- CreateIndex
CREATE INDEX "external_agent_log_records_timestamp_idx" ON "external_agent_log_records"("timestamp" DESC);

