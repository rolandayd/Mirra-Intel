# Mirra — Market Intelligence for Modern Teams

Mirra analyzes competitor websites, reviews, hiring signals, and news to give founders and growth teams a strategic competitive brief in seconds.

## Structure

```
├── index.html        → landing page / frontend entry
├── server.js         → Node.js + Express API (single file)
├── mirra-mcp/        → MCP server for AI agent integration
└── data/             → auto-created: users.json, analysis-history.json
```

## Running locally

```bash
npm install
cp .env.example .env   # fill in your keys
node server.js
```

Open `http://localhost:3010` in your browser.

## Environment variables

See `.env.example` for all keys:

| Variable | Required | Purpose |
|----------|----------|---------|
| `ANTHROPIC_API_KEY` | ✅ | AI analysis (claude-3-5-haiku) |
| `JWT_SECRET` | ✅ | Signs auth tokens — set a random 32-byte hex string |
| `SCREENSHOT_API_KEY` | Optional | screenshotone.com visual capture |
| `SERPAPI_KEY` | Optional | Traffic/index signals |
| `DEMO_MODE` | Optional | `true` bypasses usage limits |
| `CACHE_TTL_MS` | Optional | Cache TTL in ms (default: 3600000) |
| `ADMIN_SECRET` | Optional | Protects `POST /cache/clear` |

Generate a JWT secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## API

All routes except `/status`, `/auth/signup`, and `/auth/login` require a `Authorization: Bearer <token>` header.

| Method | Route | Auth | Purpose |
|--------|-------|------|---------|
| GET | `/status` | — | Health check |
| POST | `/auth/signup` | — | Create account → returns `token` |
| POST | `/auth/login` | — | Authenticate → returns `token` |
| POST | `/auth/profile` | ✅ | Save company profile |
| GET | `/usage` | ✅ | Monthly usage |
| GET | `/history` | ✅ | Past analyses (newest first) |
| POST | `/analyze` | ✅ | Core competitor analysis |
| POST | `/cmo` | ✅ | AI CMO strategy brief |
| POST | `/agent` | ✅ | Conversational AI advisor |
| POST | `/onchain` | ✅ | On-chain token intelligence (stub) |

## Deploying

**Backend → Railway**
1. Connect this repo to Railway
2. Add env vars in Railway dashboard (especially `ANTHROPIC_API_KEY` and `JWT_SECRET`)
3. Deploy — Railway auto-detects Node via `nixpacks.toml`

**Frontend → Netlify**
1. Drag and drop `index.html` to Netlify
2. Update `MIRRA_BACKEND_URL` in the HTML to your Railway URL

## MCP (AI Agent Integration)

See `mirra-mcp/SKILL.md` for setup instructions to connect Mirra to Kiro, Claude Code, or Codex.
