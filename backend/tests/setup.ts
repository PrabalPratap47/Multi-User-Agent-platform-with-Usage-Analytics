import fs from 'fs';
import { beforeAll, afterAll } from 'vitest';
import prisma from '../src/db/client.js';
import config from '../src/config/env.js';
import { assertDedicatedTestDatabase } from '../src/db/testDatabaseGuard.js';

// Tests delete rows, so refuse anything but backend/data/test.db before any
// test file runs. Output never includes URLs or paths.
const testDatabasePath = assertDedicatedTestDatabase(config.DATABASE_URL, process.env.NODE_ENV);

if (!fs.existsSync(testDatabasePath)) {
  throw new Error('Test database has not been initialized. Run "npm run db:reset:test" (npm test does this automatically).');
}

beforeAll(async () => {
  try {
    await prisma.$connect();
  } catch {
    throw new Error('Test database connection failed.');
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});
