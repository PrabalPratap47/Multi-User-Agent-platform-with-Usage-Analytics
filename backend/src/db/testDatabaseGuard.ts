import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { BACKEND_ROOT, DEV_DATABASE_PATH, TEST_DATABASE_PATH, isSamePath, resolveSqliteFilePath } from './sqlitePath.js';

// Messages are deliberately generic: no URLs, paths or other env values.
function refuse(reason: string): never {
  throw new Error(
    `Refusing to use the test database: ${reason}\n` +
      'backend/.env.test must set DATABASE_URL="file:../data/test.db" (see backend/TESTING.md).'
  );
}

/**
 * Throws unless the given configuration points at the dedicated test
 * database (backend/data/test.db) and nothing points development at it.
 * Returns the resolved absolute test database path.
 */
export function assertDedicatedTestDatabase(databaseUrl: string, nodeEnv: string | undefined): string {
  if (nodeEnv !== 'test') {
    refuse('NODE_ENV is not "test", so the test environment file was not loaded.');
  }

  const testPath = resolveSqliteFilePath(databaseUrl);
  if (!testPath) {
    refuse('DATABASE_URL is not a valid SQLite file URL.');
  }
  if (isSamePath(testPath, DEV_DATABASE_PATH)) {
    refuse('DATABASE_URL points at the development database.');
  }
  if (!isSamePath(testPath, TEST_DATABASE_PATH)) {
    refuse('DATABASE_URL does not point at the dedicated test database.');
  }

  const devEnvFile = path.join(BACKEND_ROOT, '.env.local');
  if (fs.existsSync(devEnvFile)) {
    const devUrl = dotenv.parse(fs.readFileSync(devEnvFile)).DATABASE_URL;
    const devPath = devUrl ? resolveSqliteFilePath(devUrl) : null;
    if (devPath && isSamePath(devPath, testPath)) {
      refuse('backend/.env.local points development at the test database.');
    }
  }

  return testPath;
}
