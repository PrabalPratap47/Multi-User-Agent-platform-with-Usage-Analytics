-- Records the provider's response id (OpenAI chat completion "id") on each
-- usage log row, so the logging-accuracy audit can match every row to
-- exactly one raw provider response (a run can have several calls).
--
-- Hand-written ADD COLUMN: `prisma migrate diff` would rebuild
-- llm_usage_logs and silently drop the hand-written
-- llm_usage_logs_status_check constraint from the init migration.
ALTER TABLE "llm_usage_logs" ADD COLUMN "providerResponseId" TEXT;

CREATE INDEX "llm_usage_logs_providerResponseId_idx" ON "llm_usage_logs"("providerResponseId");
