import fs from 'fs';
import path from 'path';
import config from '../config/env.js';
import { assertDedicatedTestDatabase } from './testDatabaseGuard.js';

// Deletes backend/data/test.db (and SQLite side files) so `db:migrate:test`
// rebuilds it from the migrations. Refuses to touch any other file.
const testPath = assertDedicatedTestDatabase(config.DATABASE_URL, process.env.NODE_ENV);

fs.mkdirSync(path.dirname(testPath), { recursive: true });
for (const suffix of ['', '-journal', '-wal', '-shm']) {
  fs.rmSync(testPath + suffix, { force: true });
}
console.log('Test database removed; it will be recreated from migrations.');
