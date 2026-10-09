import { PrismaClient } from '@prisma/client';
import config from '../config/env.js';
import { TEST_DATABASE_PATH, isSamePath, resolveSqliteFilePath, toSqliteUrl } from './sqlitePath.js';

const databasePath = resolveSqliteFilePath(config.DATABASE_URL);
if (!databasePath) {
  throw new Error('DATABASE_URL must be a SQLite file URL, e.g. "file:../data/dev.db".');
}
if (config.NODE_ENV !== 'test' && isSamePath(databasePath, TEST_DATABASE_PATH)) {
  throw new Error('Refusing to start: a non-test environment is configured to use the test database.');
}

/** The absolute SQLite file this client opens (for the startup migration check). */
export const DATABASE_FILE_PATH: string = databasePath;

// Passed explicitly (and absolute) so the runtime opens exactly the file the
// Prisma CLI migrates - relative SQLite paths are resolved against
// backend/prisma/, as the CLI does - and never a stray backend/.env.
const prisma = new PrismaClient({ datasourceUrl: toSqliteUrl(databasePath) });

export default prisma;
