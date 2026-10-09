-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'USER');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCESS', 'ERROR');

-- CreateEnum
CREATE TYPE "LogStatus" AS ENUM ('SUCCESS', 'ERROR');

-- CreateEnum
CREATE TYPE "DecisionType" AS ENUM ('ACCEPT', 'MODIFY', 'REJECT');

-- CreateEnum
CREATE TYPE "Sentiment" AS ENUM ('POSITIVE', 'NEUTRAL', 'NEGATIVE');

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" SERIAL NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agents" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "version" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "agentId" INTEGER NOT NULL,
    "agentName" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_usage_logs" (
    "id" SERIAL NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "runId" TEXT,
    "userId" INTEGER NOT NULL,
    "agentId" INTEGER NOT NULL,
    "agentName" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "status" "LogStatus" NOT NULL,
    "estimatedCost" DOUBLE PRECISION,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "isSeedData" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_usage_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cv_documents" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "batchId" TEXT,
    "fileName" TEXT,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cv_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cv_recommendations" (
    "id" SERIAL NOT NULL,
    "cvDocumentId" INTEGER NOT NULL,
    "runId" TEXT,
    "userId" INTEGER NOT NULL,
    "agentId" INTEGER NOT NULL,
    "primaryCategory" TEXT NOT NULL,
    "secondaryCategories" TEXT[],
    "confidenceScore" DOUBLE PRECISION NOT NULL,
    "confidenceScores" JSONB NOT NULL,
    "rationale" TEXT NOT NULL,
    "rawResponse" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cv_recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendation_decisions" (
    "id" SERIAL NOT NULL,
    "recommendationId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "decisionType" "DecisionType" NOT NULL,
    "finalCategories" TEXT[],
    "reason" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recommendation_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sentiment_results" (
    "id" SERIAL NOT NULL,
    "runId" TEXT,
    "userId" INTEGER NOT NULL,
    "agentId" INTEGER NOT NULL,
    "inputText" TEXT NOT NULL,
    "sentiment" "Sentiment" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "reasoning" TEXT,
    "rawResponse" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sentiment_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_agent_logs" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "sourceAgentName" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "logData" JSONB NOT NULL,
    "recordCount" INTEGER,
    "importTimestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,

    CONSTRAINT "external_agent_logs_pkey" PRIMARY KEY ("id")
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
CREATE INDEX "recommendation_decisions_userId_timestamp_idx" ON "recommendation_decisions"("userId", "timestamp" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "sentiment_results_runId_key" ON "sentiment_results"("runId");

-- CreateIndex
CREATE INDEX "sentiment_results_userId_createdAt_idx" ON "sentiment_results"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "external_agent_logs_userId_importTimestamp_idx" ON "external_agent_logs"("userId", "importTimestamp" DESC);

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "llm_usage_logs" ADD CONSTRAINT "llm_usage_logs_runId_fkey" FOREIGN KEY ("runId") REFERENCES "agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "llm_usage_logs" ADD CONSTRAINT "llm_usage_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "llm_usage_logs" ADD CONSTRAINT "llm_usage_logs_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cv_documents" ADD CONSTRAINT "cv_documents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cv_recommendations" ADD CONSTRAINT "cv_recommendations_cvDocumentId_fkey" FOREIGN KEY ("cvDocumentId") REFERENCES "cv_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cv_recommendations" ADD CONSTRAINT "cv_recommendations_runId_fkey" FOREIGN KEY ("runId") REFERENCES "agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cv_recommendations" ADD CONSTRAINT "cv_recommendations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cv_recommendations" ADD CONSTRAINT "cv_recommendations_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_decisions" ADD CONSTRAINT "recommendation_decisions_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "cv_recommendations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_decisions" ADD CONSTRAINT "recommendation_decisions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sentiment_results" ADD CONSTRAINT "sentiment_results_runId_fkey" FOREIGN KEY ("runId") REFERENCES "agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sentiment_results" ADD CONSTRAINT "sentiment_results_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sentiment_results" ADD CONSTRAINT "sentiment_results_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_agent_logs" ADD CONSTRAINT "external_agent_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Business rule (cannot be expressed declaratively in schema.prisma):
-- a decision's reason is mandatory unless it's a plain ACCEPT.
-- Enforced here as a DB-level safety net in addition to Zod validation
-- in src/utils/validators.ts.
ALTER TABLE "recommendation_decisions" ADD CONSTRAINT "recommendation_decisions_reason_required_check" CHECK (
    "decisionType" = 'ACCEPT' OR ("reason" IS NOT NULL AND length(btrim("reason")) > 0)
);
