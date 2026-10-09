-- The external-agent-log feature is restructured from "one JSON blob per
-- import" into individual, validated records (ExternalAgentLogRecord),
-- so the dashboard can compute real aggregates (tokens, cost, error
-- rate, per-agent breakdown) instead of just storing an opaque blob.
--
-- There is no lossless migration path from the old blob shape to the
-- new structured one, so any existing rows (dev/demo data only, from
-- the earlier minimal version of this feature) are cleared rather than
-- guessed at.
DELETE FROM "external_agent_logs";

ALTER TABLE "external_agent_logs" DROP COLUMN "logData";
ALTER TABLE "external_agent_logs" DROP COLUMN "recordCount";
ALTER TABLE "external_agent_logs" ADD COLUMN "fileFormat" TEXT NOT NULL;
ALTER TABLE "external_agent_logs" ADD COLUMN "totalRecords" INTEGER NOT NULL;
ALTER TABLE "external_agent_logs" ADD COLUMN "validRecords" INTEGER NOT NULL;
ALTER TABLE "external_agent_logs" ADD COLUMN "invalidRecords" INTEGER NOT NULL;
ALTER TABLE "external_agent_logs" ADD COLUMN "parseErrors" JSONB NOT NULL;

-- CreateTable
CREATE TABLE "external_agent_log_records" (
    "id" SERIAL NOT NULL,
    "importId" INTEGER NOT NULL,
    "rawRecord" JSONB NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "externalUserId" TEXT,
    "agentName" TEXT NOT NULL,
    "model" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "latencyMs" INTEGER,
    "rawStatus" TEXT,
    "isError" BOOLEAN NOT NULL,
    "estimatedCost" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_agent_log_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "external_agent_log_records_importId_idx" ON "external_agent_log_records"("importId");

-- CreateIndex
CREATE INDEX "external_agent_log_records_agentName_idx" ON "external_agent_log_records"("agentName");

-- CreateIndex
CREATE INDEX "external_agent_log_records_timestamp_idx" ON "external_agent_log_records"("timestamp" DESC);

-- AddForeignKey
ALTER TABLE "external_agent_log_records" ADD CONSTRAINT "external_agent_log_records_importId_fkey" FOREIGN KEY ("importId") REFERENCES "external_agent_logs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
