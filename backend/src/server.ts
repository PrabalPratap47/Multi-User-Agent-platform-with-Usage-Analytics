import app from './app.js';
import config from './config/env.js';
import logger from './config/logging.js';
import { getModelPricing } from './config/modelPricing.js';
import { recoverInterruptedRuns } from './services/runRecoveryService.js';
import prisma, { DATABASE_FILE_PATH } from './db/client.js';
import { checkMigrations, type MigrationCheckResult } from './db/migrationCheck.js';


const PORT = config.BACKEND_PORT;
// Runs created before this moment belong to a previous backend process.
const processStartedAt = new Date();

async function start() {
  // 1. The database schema must match the checked-in migrations. Read-only:
  // nothing is applied automatically, and anything that cannot be verified
  // fails closed. Runs before recovery, which needs the current schema.
  let schema: MigrationCheckResult;
  try {
    schema = await checkMigrations({
      query: sql => prisma.$queryRawUnsafe(sql),
      databasePath: DATABASE_FILE_PATH,
      nodeEnv: config.NODE_ENV,
    });
  } catch {
    schema = { ok: false, reason: 'UNVERIFIABLE', message: 'The database schema could not be verified.', migrations: [] };
  }
  if (!schema.ok) {
    console.error(`Refusing to start: ${schema.message}`);
    logger.error('Database schema check failed - the server will not start', {
      event: 'DATABASE_SCHEMA_CHECK_FAILED',
      reason: schema.reason,
      migrations: schema.migrations,
    });
    await prisma.$disconnect().catch(() => undefined);
    process.exitCode = 1;
    // Exit once output is flushed; force it if something still holds the event loop.
    setTimeout(() => process.exit(1), 2000).unref();
    return;
  }
  logger.info(`Database schema is up to date (${schema.applied} migrations applied)`);

  // 2. Before accepting requests: runs a previous process left PENDING/RUNNING
  // can never finish, so they are failed with a clear reason instead of
  // showing as queued/processing forever. See services/runRecoveryService.ts.
  try {
    await recoverInterruptedRuns(processStartedAt);
  } catch (error) {
    logger.error('Could not check for agent runs interrupted by a previous backend process - they may still show as queued or processing', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  app.listen(PORT, () => {
    logger.info(`Server running on http://localhost:${PORT}`);
    logger.info(`Environment: ${config.NODE_ENV}`);
    logger.info(`Frontend URL: ${config.FRONTEND_URL}`);
    logger.info(`OpenAI model: ${config.OPENAI_MODEL}`);
    if (!config.OPENAI_API_KEY.trim()) {
      logger.warn('OPENAI_API_KEY is not set in backend/.env.local - agent calls will fail until it is.');
    }
    if (!getModelPricing(config.OPENAI_MODEL)) {
      logger.warn(`No pricing configured for OPENAI_MODEL "${config.OPENAI_MODEL}" - costs will be recorded as unknown.`);
    }
  });
}

void start();
