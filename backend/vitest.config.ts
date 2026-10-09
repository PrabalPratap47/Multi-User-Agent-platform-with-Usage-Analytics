import { defineConfig, type Plugin } from 'vitest/config';
import path from 'path';
import fs from 'fs';

/**
 * The backend source uses ESM-style ".js" import specifiers that point at
 * ".ts" files - required by "moduleResolution": "bundler" in tsconfig.json
 * to mirror how Node's native ESM loader (and tsx, used for `npm run dev`)
 * resolve them at runtime. Vite's resolver does not perform this ".js" ->
 * ".ts" swap on its own, which would otherwise break resolution for nearly
 * every relative import in the app once it's loaded through Vitest.
 */
function resolveTsFromJsSpecifier(): Plugin {
  return {
    name: 'resolve-ts-from-js-specifier',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.') || !source.endsWith('.js')) {
        return null;
      }
      const candidate = path.resolve(path.dirname(importer), source.slice(0, -3) + '.ts');
      return fs.existsSync(candidate) ? candidate : null;
    },
  };
}

export default defineConfig({
  plugins: [resolveTsFromJsSpecifier()],
  test: {
    environment: 'node',
    globals: false,
    setupFiles: ['./tests/setup.ts'],
    // Auth/RBAC tests share state in one test database and must not run
    // concurrently against it.
    fileParallelism: false,
    // Run after-hooks in reverse registration order, so a test file's own
    // afterAll cleanup finishes before tests/setup.ts disconnects Prisma
    // (Vitest 1 otherwise runs them in parallel).
    sequence: { hooks: 'stack' },
    testTimeout: 15000,
    hookTimeout: 15000,
    // Test-runner only (not .env.test, not production): suites that drive
    // dozens of AI requests for one user in seconds (e.g. security.test.ts)
    // are not about rate limiting, so the default per-user AI budget is
    // raised here. tests/aiRateLimit.test.ts installs its own small limiter
    // with a controllable clock and checks the real defaults separately.
    env: { AI_RATE_LIMIT_MAX_RUNS: '100000' },
  },
});
