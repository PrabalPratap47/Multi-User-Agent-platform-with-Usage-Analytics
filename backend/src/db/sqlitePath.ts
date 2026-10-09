import path from 'path';
import { fileURLToPath } from 'url';

// src/db (tsx) and dist/db (built) both sit two levels below backend/.
export const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PRISMA_SCHEMA_DIR = path.join(BACKEND_ROOT, 'prisma');

export const DEV_DATABASE_PATH = path.join(BACKEND_ROOT, 'data', 'dev.db');
export const TEST_DATABASE_PATH = path.join(BACKEND_ROOT, 'data', 'test.db');

/**
 * Resolves a SQLite "file:" URL to an absolute path the same way the Prisma
 * CLI does: relative paths are relative to the directory holding
 * schema.prisma. Returns null for anything that is not a file-backed SQLite URL.
 */
export function resolveSqliteFilePath(databaseUrl: string): string | null {
  if (!databaseUrl.startsWith('file:')) {
    return null;
  }
  const filePart = databaseUrl.slice('file:'.length).split('?')[0];
  if (!filePart || filePart === ':memory:') {
    return null;
  }
  return path.resolve(PRISMA_SCHEMA_DIR, filePart);
}

export function isSamePath(a: string, b: string): boolean {
  const normalize = (p: string) => {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(a) === normalize(b);
}

export function toSqliteUrl(absolutePath: string): string {
  return `file:${absolutePath.replace(/\\/g, '/')}`;
}
