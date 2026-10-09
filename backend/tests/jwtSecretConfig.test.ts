/**
 * F-05: the backend must refuse to start with a missing, blank, too-short or
 * published placeholder JWT_SECRET, and accept a real one.
 *
 * Secrets used here are either the repository's own published placeholders
 * or random values generated per run; none is printed. Startup checks spawn
 * the real entry point in an empty temporary directory with a minimal
 * environment, so no env file and no real secret can leak into the child.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jwtSecretProblem, KNOWN_PLACEHOLDER_JWT_SECRETS, TEST_TEMPLATE_JWT_SECRET } from '../src/config/env.js';

const BACKEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');
const realLooking = () => randomBytes(32).toString('hex');

describe('jwtSecretProblem - rejected values', () => {
  it.each(['development', 'production', 'test'])('rejects missing, blank and short secrets (NODE_ENV=%s)', nodeEnv => {
    for (const value of [undefined, '', '   ', '\t \n', 'x'.repeat(31), ` ${'x'.repeat(31)} `]) {
      expect(jwtSecretProblem(value, nodeEnv), JSON.stringify(value)).not.toBeNull();
    }
  });

  it.each(['development', 'production', 'test'])('rejects every published placeholder (NODE_ENV=%s)', nodeEnv => {
    for (const placeholder of KNOWN_PLACEHOLDER_JWT_SECRETS) {
      expect(jwtSecretProblem(placeholder, nodeEnv)).toMatch(/placeholder/);
      expect(jwtSecretProblem(`  ${placeholder}  `, nodeEnv)).toMatch(/placeholder/); // surrounding whitespace
    }
  });

  it('rejects fill-in-the-blank variants of the template wording', () => {
    for (const value of ['your_jwt_secret_here_minimum_32_chars_CHANGED', 'YOUR_SECRET_GOES_HERE_PLEASE_REPLACE_ME', 'your-own-secret-value-goes-right-here-ok']) {
      expect(jwtSecretProblem(value, 'development')).toMatch(/placeholder/);
    }
  });

  it('rejects the published test-only value outside NODE_ENV=test', () => {
    for (const nodeEnv of ['development', 'production', undefined]) {
      expect(jwtSecretProblem(TEST_TEMPLATE_JWT_SECRET, nodeEnv)).toMatch(/test-only/);
    }
  });

  it('never includes the rejected value in the message', () => {
    for (const value of [...KNOWN_PLACEHOLDER_JWT_SECRETS, TEST_TEMPLATE_JWT_SECRET, 'x'.repeat(31)]) {
      const problem = jwtSecretProblem(value, 'production');
      expect(problem).not.toBeNull();
      expect(problem).not.toContain(value);
    }
  });
});

describe('jwtSecretProblem - accepted values', () => {
  it('accepts a generated secret in every environment', () => {
    for (const nodeEnv of ['development', 'production', 'test']) {
      expect(jwtSecretProblem(realLooking(), nodeEnv)).toBeNull();
      expect(jwtSecretProblem(randomBytes(48).toString('base64'), nodeEnv)).toBeNull();
    }
  });

  it('accepts the published test-only value under NODE_ENV=test (the documented .env.test setup)', () => {
    expect(jwtSecretProblem(TEST_TEMPLATE_JWT_SECRET, 'test')).toBeNull();
  });

  it('accepts exactly 32 non-blank characters', () => {
    expect(jwtSecretProblem(randomBytes(16).toString('hex'), 'production')).toBeNull();
  });
});

describe('backend startup', () => {
  let emptyDir: string;
  beforeAll(() => {
    emptyDir = mkdtempSync(join(tmpdir(), 'jwt-secret-startup-'));
  });
  afterAll(() => {
    rmSync(emptyDir, { recursive: true, force: true });
  });

  /** Runs a backend entry file with ONLY the given variables (plus what Node/Windows needs to run). */
  function run(entry: string, vars: Record<string, string | undefined>): Promise<{ code: number | null; output: string }> {
    const passthrough = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'ComSpec'];
    const env: Record<string, string> = {};
    for (const key of passthrough) if (process.env[key] !== undefined) env[key] = process.env[key]!;
    for (const [key, value] of Object.entries(vars)) if (value !== undefined) env[key] = value;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [TSX_CLI, join(BACKEND_ROOT, entry)], { cwd: emptyDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', d => (output += d));
      child.stderr.on('data', d => (output += d));
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`${entry} did not exit within 30s`));
      }, 30_000);
      child.on('exit', code => {
        clearTimeout(timer);
        resolve({ code, output });
      });
    });
  }

  const base = (nodeEnv: string) => ({ NODE_ENV: nodeEnv, DATABASE_URL: 'file:./never-opened.db', OPENAI_API_KEY: '', LOG_LEVEL: 'error' });

  it('the server refuses to start (exit 1, names JWT_SECRET, never echoes the value)', async () => {
    const cases: Array<[string, string | undefined, string]> = [
      ['missing', undefined, 'development'],
      ['blank', '                                        ', 'development'],
      ['template placeholder', KNOWN_PLACEHOLDER_JWT_SECRETS[0], 'development'],
      ['root template placeholder', KNOWN_PLACEHOLDER_JWT_SECRETS[1], 'production'],
      ['test-only value outside tests', TEST_TEMPLATE_JWT_SECRET, 'development'],
    ];
    const results = await Promise.all(cases.map(([, secret, nodeEnv]) => run('src/server.ts', { ...base(nodeEnv), JWT_SECRET: secret })));
    results.forEach(({ code, output }, i) => {
      const [label, secret] = cases[i];
      expect(code, label).toBe(1);
      expect(output, label).toContain('Invalid environment variables');
      expect(output, label).toMatch(/JWT_SECRET: /);
      expect(output, label).not.toMatch(/Server running/);
      if (secret?.trim()) expect(output.includes(secret.trim()), `${label}: value echoed`).toBe(false);
    });
  }, 60_000);

  it('configuration loads with a generated secret, and with the test-only value under NODE_ENV=test', async () => {
    const secret = realLooking();
    const [dev, test] = await Promise.all([
      run('src/config/env.ts', { ...base('development'), JWT_SECRET: secret }),
      run('src/config/env.ts', { ...base('test'), JWT_SECRET: TEST_TEMPLATE_JWT_SECRET }),
    ]);
    for (const { code, output } of [dev, test]) {
      expect(code).toBe(0);
      expect(output).not.toContain('Invalid environment variables');
    }
    expect(dev.output.includes(secret)).toBe(false);
  }, 60_000);
});
