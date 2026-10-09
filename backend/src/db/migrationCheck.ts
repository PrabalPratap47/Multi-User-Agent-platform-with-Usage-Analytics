import fs from 'node:fs';
import path from 'node:path';
import { BACKEND_ROOT } from './sqlitePath.js';

/**
 * Startup check: is the database schema at the version of the checked-in
 * migrations (backend/prisma/migrations)?
 *
 * Read-only. It compares the migration folders with Prisma's own history
 * table (`_prisma_migrations`), the same comparison `prisma migrate status`
 * makes. It never applies migrations, and it does not need the Prisma CLI,
 * which is a dev dependency and so absent from a production install.
 *
 * A migration counts as applied when a history row has `finished_at` set and
 * `rolled_back_at` empty. A row with neither is a failed or unfinished
 * migration, which `prisma migrate deploy` itself refuses to continue past.
 * Anything that prevents reading this state fails closed.
 */

export const MIGRATIONS_DIR = path.join(BACKEND_ROOT, 'prisma', 'migrations');

export type MigrationCheckResult =
  | { ok: true; applied: number }
  | {
      ok: false;
      reason: 'PENDING' | 'NOT_INITIALIZED' | 'FAILED' | 'UNKNOWN_APPLIED' | 'UNVERIFIABLE';
      /** Operator-facing explanation with the command to run; never contains a connection string. */
      message: string;
      migrations: string[];
    };

/** Runs one read-only SQL query against the database (the app passes prisma.$queryRawUnsafe). */
export type QueryFn = (sql: string) => Promise<unknown[]>;

interface HistoryRow {
  migration_name: string;
  finished_at: unknown;
  rolled_back_at: unknown;
}

const isSet = (value: unknown) => value !== null && value !== undefined;

/** Checked-in migrations: every folder that contains a migration.sql, in name (= timestamp) order. */
export function listLocalMigrations(migrationsDir: string): string[] {
  return fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(migrationsDir, entry.name, 'migration.sql')))
    .map(entry => entry.name)
    .sort();
}

/** "data/dev.db" for a file under backend/, otherwise just the file name - never the full URL. */
export function describeDatabase(databasePath: string): string {
  const relative = path.relative(BACKEND_ROOT, databasePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative.split(path.sep).join('/')
    : path.basename(databasePath);
}

function commands(nodeEnv: string | undefined) {
  return nodeEnv === 'test'
    ? { migrate: 'cd backend && npm run db:migrate:test', setup: 'cd backend && npm run db:reset:test' }
    : { migrate: 'cd backend && npm run db:migrate:deploy', setup: 'cd backend && npm run db:setup' };
}

export async function checkMigrations(options: {
  query: QueryFn;
  databasePath: string;
  migrationsDir?: string;
  nodeEnv?: string;
}): Promise<MigrationCheckResult> {
  const { query, databasePath, migrationsDir = MIGRATIONS_DIR, nodeEnv } = options;
  const db = describeDatabase(databasePath);
  const cmd = commands(nodeEnv);
  const fail = (reason: Exclude<MigrationCheckResult, { ok: true }>['reason'], message: string, migrations: string[] = []) =>
    ({ ok: false, reason, message, migrations }) as const;

  let local: string[];
  try {
    local = listLocalMigrations(migrationsDir);
  } catch {
    return fail('UNVERIFIABLE', `Could not read the migrations folder (${path.basename(migrationsDir)}), so the database schema of ${db} cannot be verified.`);
  }
  if (local.length === 0) {
    return fail('UNVERIFIABLE', `No migrations were found in the migrations folder, so the database schema of ${db} cannot be verified.`);
  }

  // Checked before connecting: opening a missing SQLite file would create an empty one.
  if (!fs.existsSync(databasePath)) {
    return fail('NOT_INITIALIZED', `The database ${db} does not exist. Create it with: ${cmd.setup}`, local);
  }

  let rows: HistoryRow[];
  try {
    const tables = (await query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_prisma_migrations'")) as Array<{ name: string }>;
    if (tables.length === 0) {
      return fail('NOT_INITIALIZED', `The database ${db} has no migration history (it has not been set up). Create it with: ${cmd.setup}`, local);
    }
    rows = (await query('SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations')) as HistoryRow[];
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return fail('UNVERIFIABLE', `Could not read the migration history of ${db}${typeof code === 'string' ? ` (${code})` : ''}. Check that the file is a readable SQLite database.`);
  }

  const failed = [...new Set(rows.filter(r => !isSet(r.finished_at) && !isSet(r.rolled_back_at)).map(r => r.migration_name))];
  if (failed.length > 0) {
    return fail(
      'FAILED',
      `The database ${db} records a failed or unfinished migration: ${failed.join(', ')}. Fix it before starting (see Prisma's "migrate resolve"); applying further migrations is blocked until then.`,
      failed
    );
  }

  const applied = new Set(rows.filter(r => isSet(r.finished_at) && !isSet(r.rolled_back_at)).map(r => r.migration_name));
  const unknown = [...applied].filter(name => !local.includes(name)).sort();
  if (unknown.length > 0) {
    return fail(
      'UNKNOWN_APPLIED',
      `The database ${db} has migrations that this code does not have: ${unknown.join(', ')}. It was migrated by a newer version of the project; use matching code and database.`,
      unknown
    );
  }

  const pending = local.filter(name => !applied.has(name));
  if (pending.length > 0) {
    return fail(
      'PENDING',
      `The database ${db} is behind the code: ${pending.length} migration(s) not applied (${pending.join(', ')}). ` +
        `Back up the database file if its data matters, then apply them with: ${cmd.migrate}`,
      pending
    );
  }
  return { ok: true, applied: local.length };
}
