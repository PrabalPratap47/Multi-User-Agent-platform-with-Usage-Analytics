# Dependency Security Audit (npm audit)

**Date:** 2026-10-07 · **Tool:** `npm audit` (npm workspaces, root lockfile) · **Result:** 22 vulnerabilities (2 critical, 16 high, 4 moderate). **None affects the running application.**

**Re-checked 2026-10-09 and 2026-10-11** with `npm audit` (read-only, no fix applied): unchanged.

- All dependencies: 22 (2 critical, 16 high, 4 moderate).
- `npm audit --omit=dev`: 3 high (the Prisma CLI chain below).
- Dependencies added later add no findings: `playwright-core` (backend dev dependency for the browser checks), `pdfjs-dist` (backend, PDF text extraction) and `recharts` (frontend charts).

No dependency versions were changed for these findings. `npm audit` offers no non-breaking fix for any of them: every fix is a major-version upgrade, or (for Prisma) a downgrade out of the declared range. `npm audit fix --force` was deliberately **not** run.

## Summary

| Group (root cause) | Findings | Used by | Affects the running app? | Fix |
|---|---|---|---|---|
| Vitest 1.6.1 (`tinypool`, `vite-node`) | 2 critical, 1 moderate | backend tests | No (test runner only) | Vitest 5 (major) |
| Vite 5.4.21 / esbuild 0.21.5 | 1 high, 1 moderate | frontend dev server and build; Vitest | No (dev server only; production output is static files) | Vite 6.4.2+ (major; npm suggests 8) |
| Tailwind CSS 3.4.19 (`braces`, `micromatch`, `fast-glob`, `chokidar`, `postcss-selector-parser`, `postcss-nested`) | 5 high, 2 moderate | frontend CSS build | No (build time only) | Tailwind 4 (major) |
| typescript-eslint 6.21.0 (`minimatch`, `globby`) | 7 high | lint (backend + frontend) | No (lint only) | typescript-eslint 8 (major; also needs newer ESLint) |
| Prisma CLI 6.19.3 (`@prisma/config` → `deepmerge-ts` 7.1.5) | 3 high | `prisma generate` / `migrate` | **No** - see below | Prisma ≥ 8.1 (major), or downgrade to 6.12.0 |

### Runtime vs. development

- `npm audit --omit=dev` reports **3** findings, all in the Prisma CLI chain (`prisma`, `@prisma/config`, `deepmerge-ts`). npm counts them as production only because `@prisma/client` declares `prisma` as a peer dependency.
- **Verified not loaded at runtime:** constructing `PrismaClient` loads no `deepmerge-ts` or `@prisma/config` module. The Prisma runtime bundles contain no `deepmerge` code; the only `@prisma/config` mention is the embedded copy of Prisma's own `package.json`. The vulnerable code runs only inside the `prisma` CLI, which this project uses at development time (generate, migrate). That code parses `prisma.config.ts`, which this project doesn't have.
- The other **19** findings are in packages the lockfile marks `"dev": true`. They are never installed on, or executed by, the running backend.

## Findings

| Package | Version | Severity | Advisory | Scope | Runtime? | Safe non-breaking fix? | Fix requires |
|---|---|---|---|---|---|---|---|
| tinypool | 0.8.4 | critical | GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr: prototype-pollution gadget → RCE via worker/run options | dev (vitest) | No | No | vitest 5 (major) |
| vitest | 1.6.1 | critical | GHSA-5xrq-8626-4rwp: arbitrary file read/exec **when the Vitest UI server is listening** | dev | No | No | vitest 5 (major) |
| vite-node | 1.6.1 | moderate | via vite | dev | No | No | vitest 5 (major) |
| vite | 5.4.21 | high | GHSA-4w7w-66w2-5vf9 (path traversal in optimized-deps `.map`), GHSA-v6wh-96g9-6wx3 (launch-editor NTLMv2 hash disclosure via UNC paths, Windows), GHSA-fx2h-pf6j-xcff (`server.fs.deny` bypass on Windows) | dev | No | No | vite ≥ 6.4.2 (major) |
| esbuild | 0.21.5 | moderate | GHSA-67mh-4wv8-2f99: any website can send requests to the dev server and read responses | dev | No | No | via vite major |
| tailwindcss | 3.4.19 | high | via chokidar, fast-glob, micromatch, postcss-* | dev | No | No | tailwindcss 4 (major) |
| braces | 3.0.3 | high | GHSA-vfj7-8cjw-p6xm: stack-exhaustion DoS on deeply nested patterns | dev | No | No | tailwindcss 4 (major) |
| micromatch | 4.0.8 | high | via braces | dev | No | No | tailwindcss 4 (major) |
| fast-glob | 3.3.3 | high | via micromatch | dev | No | No | tailwindcss 4 (major) |
| chokidar | 3.6.0 | high | via braces | dev | No | No | tailwindcss 4 (major) |
| postcss-selector-parser | 6.1.4 | moderate | GHSA-rj75-hqrm-r3gf: quadratic selector parsing (CPU exhaustion) | dev | No | No | tailwindcss 4 (major) |
| postcss-nested | 6.2.0 | moderate | via postcss-selector-parser | dev | No | No | tailwindcss 4 (major) |
| @typescript-eslint/eslint-plugin | 6.21.0 | high | via type-utils, utils | dev | No | No | v8 (major) |
| @typescript-eslint/parser | 6.21.0 | high | via typescript-estree | dev | No | No | v8 (major) |
| @typescript-eslint/type-utils | 6.21.0 | high | via typescript-estree | dev | No | No | v8 (major) |
| @typescript-eslint/typescript-estree | 6.21.0 | high | via globby, minimatch | dev | No | No | v8 (major) |
| @typescript-eslint/utils | 6.21.0 | high | via typescript-estree | dev | No | No | v8 (major) |
| globby | 11.1.0 | high | via fast-glob | dev | No | No | typescript-eslint 8 (major) |
| minimatch | 9.0.3 | high | GHSA-3ppc-4f35-3m26, GHSA-7r86-cg39-jmmj, GHSA-23c5-xmqv-rm74: ReDoS on crafted glob patterns | dev | No | No | typescript-eslint 8 (major) |
| prisma | 6.19.3 | high | via @prisma/config | CLI (npm: prod via peer dep) | No (verified) | No | prisma ≥ 8.1 (major) or 6.12.0 (downgrade) |
| @prisma/config | 6.19.3 | high | via deepmerge-ts | CLI | No (verified) | No | as above |
| deepmerge-ts | 7.1.5 | high | GHSA-ggr8-5vv4-36mx: stack exhaustion merging recursive object graphs | CLI | No (verified) | No | as above |

## Why these are accepted for now

- **No attacker-controlled input reaches any vulnerable code.** Glob patterns, CSS selectors, tinypool options and Prisma config objects all come from this repository's own source and config files, never from HTTP requests.
- **The production surface** is the Express backend (Express, Prisma Client, OpenAI SDK, jsonwebtoken, bcryptjs, zod, winston, cors, dotenv, pdfjs-dist) plus the static frontend build. None of these has an open advisory.
- **The Prisma downgrade to 6.12.0 is not taken.** It would move CLI and client back 7 minor versions purely to silence a CLI-only finding that can't be reached, and would need full re-verification of the SQLite setup.

## Required precautions (until upgraded)

1. Run the Vite dev server (`npm run dev` in `frontend/`) **only on localhost**. Don't add `--host` or `server.host` (affects the Vite/esbuild advisories, including the Windows-specific ones).
2. Avoid browsing untrusted websites while the Vite dev server is running (esbuild GHSA-67mh-4wv8-2f99).
3. Don't run the Vitest UI (`vitest --ui`). The project doesn't install `@vitest/ui`.
4. Never deploy the dev servers. Production is `npm run build` → `node dist/server.js` (backend) plus static `frontend/dist` files.

## Recommended upgrades (planned work, each one tested separately)

| Upgrade | Clears | Notes |
|---|---|---|
| vitest 1 → 5 | 3 (2 critical) | Config and API changes; re-run the whole test suite |
| typescript-eslint 6 → 8 (with ESLint 8 → 9, flat config) | 7 | Requires migrating both `.eslintrc.json` files to `eslint.config.js` |
| vite 5 → 6.4.2+ (and `@vitejs/plugin-react`) | 2 | Frontend dev server and build changes |
| tailwindcss 3 → 4 | 7 | New configuration model; re-check all styling |
| prisma 6 → 8.1+ | 3 | Major: new config file and driver adapters; re-verify the SQLite migration |

Re-run `npm audit` and `npm audit --omit=dev` after any dependency change and update this file.
