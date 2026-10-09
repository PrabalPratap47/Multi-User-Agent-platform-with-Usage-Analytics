# Quick Start Guide

## 🚀 Get Running in 5 Minutes

### Prerequisites Installed?
```bash
node --version    # Should be v18.18+
npm --version     # Should be v9+
```

No database server is needed - the backend uses SQLite files in `backend/data/`.

### 1️⃣ Install (One Time, from the repository root)

```bash
npm install       # both workspaces + Prisma Client
```

### 2️⃣ Configure Backend

```bash
cd backend
cp .env.example .env.local
cp .env.test.example .env.test

# Edit .env.local:
# - Add your OPENAI_API_KEY
# - Generate JWT_SECRET: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# - Leave DATABASE_URL="file:../data/dev.db" as is
```

### 3️⃣ Create the Database

```bash
cd backend
npm run db:setup  # creates backend/data/dev.db, applies migrations, adds demo users
```

### 4️⃣ Configure Frontend

```bash
cd frontend
cp .env.example .env.local
```

### 5️⃣ Start Servers

**Terminal 1:**
```bash
cd backend && npm run dev
# Should see: Server running on http://localhost:3001
```

**Terminal 2:**
```bash
cd frontend && npm run dev
# Should see: Local: http://localhost:5173
```

In Windows PowerShell 5.1, `&&` is not supported. Type `cd backend` and
`npm run dev` as two commands, or use `cd backend; npm run dev`.

### 6️⃣ Login

Browser opens to http://localhost:5173

Use any seeded demo account (local development only, created by `npm run db:seed`):
- `admin@example.com` / `password123` (ADMIN)
- `user1@example.com` / `password123`
- `user2@example.com` / `password123`
- `user3@example.com` / `password123`

---

## ✅ Verify Everything Works

### Backend Health Check
```bash
curl http://localhost:3001/health
# Should respond: {"status":"ok","message":"Server is healthy"}
```

### Try Login
```bash
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"password123"}'

# Should return {"success":true,"data":{"accessToken":...,"refreshToken":...,"user":{...}}}
```

**Windows PowerShell 5.1:** `curl` is an alias of `Invoke-WebRequest`, so the
login example above fails ("Cannot bind parameter 'Headers'"). Use either of
these instead:
```powershell
curl.exe -s -X POST http://localhost:3001/api/auth/login -H "Content-Type: application/json" -d '{\"email\":\"admin@example.com\",\"password\":\"password123\"}'
Invoke-RestMethod -Method Post -Uri http://localhost:3001/api/auth/login -ContentType 'application/json' -Body '{"email":"admin@example.com","password":"password123"}'
```

### Check Database
```bash
cd backend
npm run db:studio
# Opens http://localhost:5555
# Shows all tables and data
```

---

## 📋 Directory Overview

```
multi-user-agent/
├── backend/           ← Express API, agents, analytics, tests
├── frontend/          ← React dashboard
├── docs/              ← Topic documentation (analytics, security, database, ...)
├── evaluation/        ← Evaluation dataset and generated reports
├── README.md          ← Main documentation (start here)
├── SETUP.md           ← Detailed setup guide
└── ARCHITECTURE.md    ← Original design proposal
```

---

## 🐛 Troubleshooting

| Error | Solution |
|-------|----------|
| `The table ... does not exist` | Run `npm run db:setup` in backend/ |
| `npm: command not found` | Install Node.js from nodejs.org |
| Agent calls fail with `OPENAI_API_KEY_MISSING` (HTTP 502) or a 401 | Set `OPENAI_API_KEY` in backend/.env.local, make sure no other `OPENAI_API_KEY` is set in your environment (it would override the file), restart the backend |
| `Port 3001 already in use` | Change BACKEND_PORT in .env.local |
| CORS errors | Verify FRONTEND_URL in backend .env.local matches your frontend URL |

---

## 📚 Next Steps

1. ✅ **Backend is running** → `/health` responds
2. ✅ **Frontend is running** → Login works
3. **Try the features** → CV PROCESSING, SENTIMENT and EXTERNAL LOGS tabs (CV and sentiment need `OPENAI_API_KEY`)
4. **Run the tests** → `cd backend && npm test` (no API key needed)

See README.md for features, analytics definitions and all verification commands.

---

## 🚨 Important Notes

- **Never commit .env.local** - It contains secrets
- **Demo credentials** work only locally with seeded data
- **JWT expires** every 15 minutes (set in .env.local); the frontend refreshes it automatically
- **Tokens** (access and refresh) are kept in the browser's `localStorage` - not in a cookie - so an XSS bug would expose them (a known residual risk, see docs/SECURITY_AUDIT.md)
- **User isolation** enforced server-side: users can only see their own data; admins see all

---

## 📞 Support

- Check backend logs: `npm run dev` output
- Check frontend console: Browser DevTools (F12)
- View database: `npm run db:studio`
- Review ARCHITECTURE.md for design details
