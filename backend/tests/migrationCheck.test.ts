/**
 * F-23: the backend refuses to start when the database schema is behind the
 * checked-in migrations (or its state cannot be verified), never applies or
 * modifies anything itself, and checks before run recovery and before it
 * starts listening.
 *
 * Unit tests use real temporary SQLite files (node:sqlite) and temporary
 * migration folders. Startup tests spawn the real src/server.ts against
 * isolated copies of test.db (VACUUM INTO) or temporary files - never
 * backend/data/dev.db.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import prisma, { DATABASE_FILE_PATH } from '../src/db/client.js';
import { checkMigrations, describeDatabase, listLocalMigrations, MIGRATIONS_DIR, type QueryFn } from '../src/db/migrationCheck.js';
import { toSqliteUrl } from '../src/db/sqlitePath.js';

// Vite's resolver does not know the node:sqlite builtin, so load it through
// require. The installed @types/node predates node:sqlite, hence the local type.
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown };
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => SqliteDb;
};

const NAMES = ['20260101000000_first', '20260102000000_second', '20260103000000_third'];
const HISTORY_TABLE = `CREATE TABLE "_prisma_migrations" (
  "id" TEXT PRIMARY KEY NOT NULL, "checksum" TEXT NOT NULL, "finished_at" DATETIME, "migration_name" TEXT NOT NULL,
  "logs" TEXT, "rolled_back_at" DATETIME, "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
  "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0)`;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'migration-check-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
let seq = 0;

function migrationsDir(names: string[]): string {
  const root = join(dir, `migrations-${++seq}`);
  mkdirSync(root);
  for (const name of names) {
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, 'migration.sql'), `-- ${name}\n`);
  }
  mkdirSync(join(root, '20991231000000_no_sql_file')); // ignored: no migration.sql
  writeFileSync(join(root, 'migration_lock.toml'), 'provider = "sqlite"\n'); // ignored: not a folder
  return root;
}

type Row = { name: string; finished?: boolean; rolledBack?: boolean };
/** A SQLite file with the given history rows, or with no history table when rows is null. */
function database(rows: Row[] | null): string {
  const file = join(dir, `db-${++seq}.db`);
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
  if (rows) {
    db.exec(HISTORY_TABLE);
    const insert = db.prepare('INSERT INTO _prisma_migrations (id, checksum, migration_name, finished_at, rolled_back_at, applied_steps_count) VALUES (?, ?, ?, ?, ?, 1)');
    for (const row of rows) {
      insert.run(randomBytes(8).toString('hex'), 'x', row.name, row.finished === false ? null : '2026-10-09 10:00:00', row.rolledBack ? '2026-10-09 11:00:00' : null);
    }
  }
  db.close();
  return file;
}

/** Read-only query function over a SQLite file, like the app's prisma.$queryRawUnsafe. */
function queryOn(file: string): QueryFn & { calls: number } {
  const fn = (async (sql: string) => {
    fn.calls += 1;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return db.prepare(sql).all();
    } finally {
      db.close();
    }
  }) as QueryFn & { calls: number };
  fn.calls = 0;
  return fn;
}

async function check(rows: Row[] | null, local = NAMES, nodeEnv = 'development') {
  const file = database(rows);
  const before = hash(file);
  const result = await checkMigrations({ query: queryOn(file), databasePath: file, migrationsDir: migrationsDir(local), nodeEnv });
  expect(hash(file), 'the check must not modify the database').toBe(before);
  return result;
}
const all = (extra: Partial<Row> = {}) => NAMES.map(name => ({ name, ...extra }));

describe('checkMigrations', () => {
  it('a current schema passes', async () => {
    expect(await check(all())).toEqual({ ok: true, applied: 3 });
  });

  it('pending migrations block, naming them and the documented command', async () => {
    const result = await check(all().slice(0, 1));
    expect(result).toMatchObject({ ok: false, reason: 'PENDING', migrations: [NAMES[1], NAMES[2]] });
    if (result.ok) return;
    expect(result.message).toContain('2 migration(s) not applied');
    expect(result.message).toContain('cd backend && npm run db:migrate:deploy');
    expect(result.message).toContain('Back up the database file');
    const forTests = await check(all().slice(0, 2), NAMES, 'test');
    expect(!forTests.ok && forTests.message).toContain('npm run db:migrate:test');
  });

  it('a rolled-back migration counts as not applied; one re-applied after a rollback counts as applied', async () => {
    const rolledBack = await check([...all().slice(0, 2), { name: NAMES[2], rolledBack: true }]);
    expect(rolledBack).toMatchObject({ ok: false, reason: 'PENDING', migrations: [NAMES[2]] });
    expect(await check([...all(), { name: NAMES[2], rolledBack: true }])).toEqual({ ok: true, applied: 3 });
  });

  it('a failed or unfinished migration blocks', async () => {
    const result = await check([...all().slice(0, 2), { name: NAMES[2], finished: false }]);
    expect(result).toMatchObject({ ok: false, reason: 'FAILED', migrations: [NAMES[2]] });
    expect(!result.ok && result.message).toContain('migrate resolve');
  });

  it('migrations applied to the database but missing from the code block', async () => {
    const result = await check([...all(), { name: '20270101000000_from_the_future' }]);
    expect(result).toMatchObject({ ok: false, reason: 'UNKNOWN_APPLIED', migrations: ['20270101000000_from_the_future'] });
  });

  it('a database with no migration history is "not set up" and points to db:setup', async () => {
    const result = await check(null);
    expect(result).toMatchObject({ ok: false, reason: 'NOT_INITIALIZED', migrations: NAMES });
    expect(!result.ok && result.message).toContain('cd backend && npm run db:setup');
  });

  it('a missing database file is reported without connecting (so no empty file is created)', async () => {
    const file = join(dir, 'never-created.db');
    const query = queryOn(file);
    const result = await checkMigrations({ query, databasePath: file, migrationsDir: migrationsDir(NAMES) });
    expect(result).toMatchObject({ ok: false, reason: 'NOT_INITIALIZED' });
    expect(query.calls).toBe(0);
    expect(existsSync(file)).toBe(false);
  });

  it('fails closed when the state cannot be read, without echoing the raw error', async () => {
    const file = database(all());
    const throwing: QueryFn = async () => {
      throw Object.assign(new Error('could not open file:C:/private/path.db?password=hunter2'), { code: 'P1003' });
    };
    const result = await checkMigrations({ query: throwing, databasePath: file, migrationsDir: migrationsDir(NAMES) });
    expect(result).toMatchObject({ ok: false, reason: 'UNVERIFIABLE' });
    expect(!result.ok && result.message).toContain('(P1003)');
    expect(!result.ok && result.message).not.toMatch(/hunter2|private|file:/);

    const garbage = join(dir, 'not-a-database.db');
    writeFileSync(garbage, 'this is not a sqlite file '.repeat(40));
    const unreadable = await checkMigrations({ query: queryOn(garbage), databasePath: garbage, migrationsDir: migrationsDir(NAMES) });
    expect(unreadable).toMatchObject({ ok: false, reason: 'UNVERIFIABLE' });
  });

  it('fails closed when the migrations folder is missing or empty', async () => {
    const file = database(all());
    for (const folder of [join(dir, 'no-such-folder'), migrationsDir([])]) {
      expect(await checkMigrations({ query: queryOn(file), databasePath: file, migrationsDir: folder })).toMatchObject({ ok: false, reason: 'UNVERIFIABLE' });
    }
  });

  it('names the database by its path under backend/ or its file name - never a connection string', () => {
    expect(describeDatabase(join(process.cwd(), 'data', 'dev.db'))).toBe('data/dev.db');
    expect(describeDatabase(join(dir, 'x.db'))).toBe('x.db');
  });

  it('wired to the real repository: the checked-in migrations, and test.db is current', async () => {
    const local = listLocalMigrations(MIGRATIONS_DIR);
    expect(local).toEqual(['20261007000000_init_sqlite', '20261008000000_agent_run_cv_document_link', '20261008120000_usage_log_provider_response_id', '20261011000000_skills_gap_analysis', '20261011120000_cv_recommendation_feedback', '20261011180000_user_name_and_deactivation']);
    expect(await checkMigrations({ query: sql => prisma.$queryRawUnsafe(sql), databasePath: DATABASE_FILE_PATH, nodeEnv: 'test' })).toEqual({ ok: true, applied: 6 });
  });
});

// ── Real startup ──────────────────────────────────────────────────────

/** Runs the real server with a minimal environment in an empty folder; stops it if it starts listening. */
function startServer(databaseFile: string): Promise<{ code: number | null; output: string; listened: boolean }> {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'ComSpec']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, {
    NODE_ENV: 'development',
    DATABASE_URL: toSqliteUrl(databaseFile),
    JWT_SECRET: randomBytes(32).toString('hex'),
    OPENAI_API_KEY: '',
    BACKEND_PORT: '0',
    LOG_LEVEL: 'info',
  });
  const cwd = mkdtempSync(join(dir, 'cwd-'));
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', tsx, join(process.cwd(), 'src', 'server.ts')], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let listened = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`server neither exited nor listened:\n${output}`));
    }, 45_000);
    const onData = (d: Buffer) => {
      output += d.toString();
      if (!listened && output.includes('Server running on')) {
        listened = true;
        child.kill();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', code => {
      clearTimeout(timer);
      resolve({ code, output, listened });
    });
  });
}

/** A consistent copy of the fully migrated test database. */
async function migratedCopy(): Promise<string> {
  const file = join(dir, `copy-${++seq}.db`);
  await prisma.$executeRawUnsafe(`VACUUM INTO '${file.replace(/\\/g, '/')}'`);
  return file;
}

describe('backend startup', () => {
  it('a current schema starts: schema check, then run recovery, then listening', async () => {
    const { output, listened } = await startServer(await migratedCopy());
    expect(listened, output).toBe(true);
    const checked = output.indexOf('Database schema is up to date (6 migrations applied)');
    const recovered = output.search(/No agent runs were left unfinished|INTERRUPTED_RUNS_RECOVERED/);
    const listening = output.indexOf('Server running on');
    expect(checked).toBeGreaterThanOrEqual(0);
    expect(recovered).toBeGreaterThan(checked);
    expect(listening).toBeGreaterThan(recovered);
  }, 60_000);

  it('pending migrations: refuses to start, never listens or runs recovery, and leaves the database untouched', async () => {
    const file = await migratedCopy();
    const db = new DatabaseSync(file);
    db.exec("DELETE FROM _prisma_migrations WHERE migration_name = '20261008120000_usage_log_provider_response_id'");
    db.close();
    const before = hash(file);

    const { code, output, listened } = await startServer(file);
    expect(code).toBe(1);
    expect(listened).toBe(false);
    expect(output).not.toContain('Server running on');
    expect(output).not.toMatch(/No agent runs were left unfinished|INTERRUPTED_RUNS_RECOVERED/);
    expect(output).toContain('Refusing to start: The database ');
    expect(output).toContain('20261008120000_usage_log_provider_response_id');
    expect(output).toContain('cd backend && npm run db:migrate:deploy');
    expect(output).toContain('DATABASE_SCHEMA_CHECK_FAILED');
    expect(output).not.toContain(toSqliteUrl(file)); // no connection string
    expect(hash(file)).toBe(before); // nothing applied, nothing written
  }, 60_000);

  it('a missing database refuses to start and is not created', async () => {
    const file = join(dir, 'missing-at-startup.db');
    const { code, output, listened } = await startServer(file);
    expect(code).toBe(1);
    expect(listened).toBe(false);
    expect(output).toContain('does not exist. Create it with: cd backend && npm run db:setup');
    expect(existsSync(file)).toBe(false);
  }, 60_000);

  it('an unreadable database fails closed', async () => {
    const file = join(dir, 'garbage-at-startup.db');
    writeFileSync(file, 'definitely not sqlite '.repeat(64));
    const before = hash(file);
    const { code, output, listened } = await startServer(file);
    expect(code).toBe(1);
    expect(listened).toBe(false);
    expect(output).toContain('Could not read the migration history');
    expect(hash(file)).toBe(before);
  }, 60_000);
});
