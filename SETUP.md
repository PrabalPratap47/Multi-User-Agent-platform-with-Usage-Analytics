# Development Setup Guide

This guide walks you through setting up the Multi-User Agent Platform for local development.
No database server is needed: the backend uses SQLite files under `backend/data/`.

## Prerequisites

- **Node.js**: v18.18 or higher ([Download](https://nodejs.org/)) - required by Prisma 6
- **npm**: Comes with Node.js
- **OpenAI API Key**: Get one from [OpenAI Platform](https://platform.openai.com/api-keys) (only needed to call the real agents; not needed for the test suite)

## Quick Setup (fresh clone)

```bash
# 1. Install everything (both workspaces) and generate the Prisma Client
npm install

# 2. Create the backend environment files from the templates
cd backend
cp .env.example .env.local        # development -> backend/data/dev.db
cp .env.test.example .env.test    # testing     -> backend/data/test.db
#    Edit .env.local: set JWT_SECRET to your own random 32+ character secret
#    (node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
#    - the backend refuses to start with the template placeholder - and
#    OPENAI_API_KEY to your key. Leave DATABASE_URL as it is.

# 3. Create the development database and load the demo users
npm run db:setup

# 4. (optional) run the test suite - it creates its own test database
npm test

# 5. (optional) Frontend environment - only needed if the backend is not on http://localhost:3001
cd ../frontend
cp .env.example .env.local
```

Then start the servers (Step 5 below).

**Windows PowerShell 5.1:** `cp` works (it is an alias of `Copy-Item`). Command lines joined with `&&` fail with "The token '&&' is not a valid statement separator in this version": run the parts separately, join them with `;`, or use PowerShell 7+.

## Step 1: Clone / Extract Repository

```bash
cd multi-user-agent
```

## Step 2: Install Dependencies

The repository is an npm workspace (`backend` + `frontend`). Install once,
from the repository root:

```bash
npm install
```

This installs both workspaces into the root `node_modules/` and runs the
backend's `postinstall` (`prisma generate`), so the Prisma Client is ready
afterwards. To regenerate it manually: `npm run db:generate` in `backend/`.

## Step 3: Setup Database

### Databases

| Environment | File | Configured in |
|---|---|---|
| Development | `backend/data/dev.db` | `backend/.env.local` -> `DATABASE_URL="file:../data/dev.db"` |
| Testing | `backend/data/test.db` | `backend/.env.test` -> `DATABASE_URL="file:../data/test.db"` |

SQLite `file:` paths are resolved relative to `backend/prisma/` (where
`schema.prisma` lives), which is why the URLs start with `../data/`. The
`.db` files are git-ignored and created by the commands below. There are no
database credentials. See [docs/DATABASE.md](docs/DATABASE.md) for the
schema, the SQLite-specific details, and the migration history.

### Create Environment File

```bash
cd backend
cp .env.example .env.local
```

### Edit `.env.local`

```env
BACKEND_PORT=3001
NODE_ENV=development
FRONTEND_URL=http://localhost:5173

# SQLite development database (backend/data/dev.db) - no credentials
DATABASE_URL="file:../data/dev.db"

# Authentication (all expiries are in SECONDS)
# Example placeholder only - the backend rejects it. Use your own random secret.
JWT_SECRET=your_super_secret_key_minimum_32_characters_long
JWT_EXPIRY_SECONDS=900
REFRESH_TOKEN_EXPIRY_SECONDS=604800
BCRYPT_SALT_ROUNDS=12

# OpenAI API (backend only - never in a frontend env file)
# Empty is allowed: the server starts, and agent calls fail with
# OPENAI_API_KEY_MISSING until a key is set. Restart the backend after editing.
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o

# Optional per-user AI rate limit (defaults shown; see README "Security")
# AI_RATE_LIMIT_MAX_RUNS=60
# AI_RATE_LIMIT_WINDOW_SECONDS=600

# Logging
LOG_LEVEL=debug
```

### How Environment Files Are Selected

There is no `backend/.env`. Each command reads exactly one file:

| Command (run in `backend/`) | Env file | Database |
|---|---|---|
| `npm run dev`, `npm start` | `.env.local` | `data/dev.db` |
| `npm run db:setup`, `db:migrate`, `db:migrate:deploy`, `db:push`, `db:studio` | `.env.local` | `data/dev.db` |
| `npm run db:seed` | `.env.local` | `data/dev.db` |
| `npm run eval:cv-classification` | `.env.local` | `data/dev.db` |
| `npm test` (Vitest sets `NODE_ENV=test`) | `.env.test` | `data/test.db` |
| `npm run db:reset:test`, `db:migrate:test` | `.env.test` | `data/test.db` |

- The app, seed script and tests load configuration through
  `src/config/env.ts`, which reads `.env.test` when `NODE_ENV=test` and
  `.env.local` otherwise. `src/db/client.ts` resolves that `DATABASE_URL`
  exactly as the Prisma CLI does and passes it to Prisma explicitly, so the
  runtime opens the same file the CLI migrated.
- The Prisma CLI only auto-loads `.env`, so its scripts are wrapped with
  `dotenv-cli` (`dotenv -e .env.local -- prisma ...`) to read the intended
  file instead.
- Both env files are git-ignored. `.env.local` holds your `JWT_SECRET` and
  `OPENAI_API_KEY`; `.env.test` holds only test values.
- Variables that are already set in the process environment **win over the
  file** (dotenv never overrides them). An `OPENAI_API_KEY` set in your shell
  or Windows user environment silently replaces the one in `.env.local`. The
  same mechanism lets you point a command at another database for one run,
  e.g. `DATABASE_URL="file:../data/cv-eval.db"` (see README, "Tests and
  verification").
- Replace the `JWT_SECRET` placeholder with your own random secret. The
  backend refuses to start (`Invalid environment variables ... JWT_SECRET`)
  while the value is missing, blank, under 32 characters (ignoring
  surrounding whitespace), or a placeholder from the templates or these docs.
  The `.env.test.example` value is public and is accepted only with
  `NODE_ENV=test`, for the throwaway test database.
- Cross-environment safety: the tests refuse to run unless they point at
  `backend/data/test.db`, and the app refuses to start in development if it
  is configured to use `test.db`. See `backend/TESTING.md`.

> Do not create a `backend/.env`. The app ignores it, and a stale one could
> confuse ad-hoc `npx prisma ...` commands run without the npm scripts.

### Create the Development Database & Seed

```bash
npm run db:setup
# = npm run db:migrate:deploy   (creates data/dev.db and applies prisma/migrations/)
#   npm run db:seed             (demo users + agents + clearly-marked demo records)
```

> **After pulling new migrations**, the backend refuses to start until they are applied. It prints `Refusing to start: The database data/dev.db is behind the code: …` with the migration names and the command (`npm run db:migrate:deploy`). Back up `data/dev.db` first if its data matters. The startup check only reads the database; see docs/DATABASE.md, "Startup migration check".
>
> `db:migrate:deploy` applies existing migrations as-is. If you change
> `schema.prisma` yourself, use `npm run db:migrate` (`prisma migrate dev`),
> which generates a new migration file. Read the SQLite notes in
> docs/DATABASE.md first: hand-written CHECK constraints must be re-added if
> Prisma rebuilds a table.

You should see:
```
✅ Database seeded successfully!

Demo Users (LOCAL DEV ONLY - see backend/.env.example):
  Admin:  admin@example.com / password123
  User 1: user1@example.com / password123
  User 2: user2@example.com / password123
  User 3: user3@example.com / password123
```

> These are local-development-only credentials, intentionally simple, and
> only ever seeded into your local dev database. The seed also creates a few
> demo CV/sentiment records and usage logs, all flagged `isSeedData = true`
> and excluded from every analytics metric. Never commit `.env.local`.

### Run the Test Suite (optional but recommended)

```bash
cd backend
cp .env.test.example .env.test   # one-time; no edits needed
npm test
```

`npm test` first runs `db:reset:test` (deletes `data/test.db` and re-applies
the migrations), then Vitest. Your development database is never touched.
See `backend/TESTING.md` for details.

## Step 4: Frontend Configuration

```bash
cd frontend
cp .env.example .env.local
```

`.env.local` should contain:
```
VITE_API_URL=http://localhost:3001
```

This step is optional: `src/services/api.ts` defaults to `http://localhost:3001`
when `VITE_API_URL` is not set. The frontend only ever knows the backend URL.
Never put `OPENAI_API_KEY` (or any secret) in a frontend env file, because every
`VITE_*` value is compiled into the JavaScript sent to the browser.

## Step 5: Start Development Servers

### Terminal 1: Backend

```bash
cd backend
npm run dev
```

Expected log lines (with timestamps):
```
Server running on http://localhost:3001
Environment: development
Frontend URL: http://localhost:5173
OpenAI model: gpt-4o
```
With an empty `OPENAI_API_KEY` you also see the warning
`OPENAI_API_KEY is not set in backend/.env.local - agent calls will fail until it is.`

### Terminal 2: Frontend

```bash
cd frontend
npm run dev
```

Expected output:
```
  VITE v... ready in ... ms

  ➜  Local:   http://localhost:5173/
  ➜  press h to show help
```

## Step 6: Access Application

1. Open browser to http://localhost:5173
2. Login with a seeded demo account (local development only; created by
   `npm run db:seed` from `backend/src/db/seed.ts`):
   - **Admin**: admin@example.com / password123
   - **User 1**: user1@example.com / password123
   - **User 2**: user2@example.com / password123
   - **User 3**: user3@example.com / password123

   The login page lists these only when served by the Vite dev server; a
   production build does not contain them. Never seed a shared or production
   database.

## Troubleshooting

### Tables missing / "The table `main.users` does not exist"
The development database has not been created yet: run `npm run db:setup` in `backend/`.

### "DATABASE_URL must be a SQLite file URL"
`DATABASE_URL` in `backend/.env.local` must be `"file:../data/dev.db"`.

### "Refusing to use the test database: ..."
The tests only run against `backend/data/test.db`. Re-copy `backend/.env.test.example` to `backend/.env.test`.

### "Test database has not been initialized"
Run `npm run db:reset:test` (or just `npm test`, which does it first).

### Port Already in Use
- Backend default: 3001
- Frontend default: 5173
- Change in `.env.local` or `vite.config.ts` if needed

### API Not Found / "Could not reach the server"
- Ensure backend is running on port 3001
- Check CORS configuration: `FRONTEND_URL` in `backend/.env.local` must be the
  origin the app is served from - `http://localhost:5173` for `npm run dev`,
  `http://localhost:4173` for `npm run preview` - then restart the backend
- `VITE_API_URL` is baked into a production build: set it before `npm run build`

### "install scripts ... blocked" during `npm install`
npm 11+ can block the install scripts of `@prisma/client`, `@prisma/engines`,
`prisma` and `esbuild`. In the Step 20 fresh-copy test (npm 12) this was
harmless: the backend workspace's own `postinstall` still ran `prisma generate`,
and `db:setup` and all tests passed. If the Prisma Client is missing
("@prisma/client did not initialize yet"), run `npm run db:generate` in `backend/`.

### "The token '&&' is not a valid statement separator in this version"
Windows PowerShell 5.1 does not support `&&`. Run the commands one at a time
(or join them with `;`), or use PowerShell 7+.

### Module Not Found
```
npm ERR! code ERESOLVE
```
Try: `npm install --legacy-peer-deps`

## Development Commands

### Backend

```bash
cd backend

# Development server with hot-reload
npm run dev

# Type checking / linting / production build
npm run typecheck
npm run lint
npm run build

# Prisma Client
npm run db:generate

# Development database (data/dev.db)
npm run db:setup            # create + migrate + seed
npm run db:migrate:deploy   # apply migrations only
npm run db:seed             # re-seed (deletes and recreates all rows)
npm run db:migrate          # after editing schema.prisma: create a new migration
npm run db:studio           # browse data in Prisma Studio

# Test database (data/test.db) and tests
npm run db:reset:test       # delete + re-migrate test.db
npm test                    # runs db:reset:test, then all tests
```

### Frontend

```bash
cd frontend

# Development server
npm run dev

# Type checking
npm run typecheck

# Linting
npm run lint

# Build for production
npm run build

# Preview production build locally
npm run preview
```

## Database Management

### View Schema
```bash
cd backend
npm run db:studio
```
Opens Prisma Studio at http://localhost:5555 for visual database management.

### Reset the Development Database
Stop the backend, delete `backend/data/dev.db`, then:
```bash
cd backend
npm run db:setup
```

## Debugging

### Enable Debug Logging
Edit `backend/.env.local`:
```
LOG_LEVEL=debug
```

### Browser DevTools
- Open DevTools: F12
- Network tab to see API calls
- Application tab to view localStorage (auth tokens)

### Prisma Debug
```bash
cd backend
DEBUG=prisma:* npm run dev
```

## Common Workflows

### Add a Demo User

```bash
# Edit backend/src/db/seed.ts, add new user, then:
npm run db:seed
```

### Clear All Data
```bash
npm run db:seed   # the seed deletes all rows before inserting the demo data
```

### Check Token Validity
In browser console:
```javascript
JSON.parse(localStorage.getItem('auth'))
```

## Next Steps After Setup

1. **Run the application** (follow steps above)
2. **Login and explore** the dashboard
3. **Check backend logs** to see API calls
4. **Run the checks**: see README.md, "Tests and verification", and
   `backend/TESTING.md` (the browser checks need Google Chrome; the real-OpenAI
   scripts need an API key and cost money)

See README.md for features and analytics definitions, docs/DATABASE.md for the
data model, and ARCHITECTURE.md for the original design (read its
implementation notes first).
