# Mirra-Intel — Implementation Plan

## Phase 0 — Agent Integration (MCP + Skill) ✅ DONE
**Goal:** Make Mirra callable by any AI agent — Codex, Kiro, Claude Code, OpenClaw.

### What was built
- `mirra-mcp/server.js` — MCP server exposing 5 tools over stdio transport
- `mirra-mcp/package.json` — ESM, pinned deps (`@modelcontextprotocol/sdk`, `zod`)
- `mirra-mcp/SKILL.md` — install + usage guide for Kiro and Codex

### MCP Tools
| Tool | Wraps |
|------|-------|
| `mirra_analyze` | `POST /analyze` |
| `mirra_cmo` | `POST /cmo` |
| `mirra_agent` | `POST /agent` |
| `mirra_usage` | `GET /usage` |
| `mirra_status` | `GET /status` |

### To activate in Kiro
Add to `~/.kiro/settings/mcp.json`:
```json
{
  "mcpServers": {
    "mirra": {
      "command": "node",
      "args": ["C:/Users/PC/mirra/mirra-mcp/server.js"],
      "env": {
        "MIRRA_BACKEND_URL": "https://your-mirra-backend.railway.app",
        "MIRRA_EMAIL": "your@email.com"
      }
    }
  }
}
```

### To activate in Codex
Add to `~/.codex/config.json` under `"mcpServers"` — same shape as above.

---

## Current State (v7.0.0)

Working: auth, /analyze, /cmo, /agent, /onchain, usage limits, demo mode, Railway + Netlify deploy.
Gaps: fragile scrapers, no persistent storage, no rate limiting, monolithic server.js, stub on-chain data.

---

## Phase 1 — Stability & Production Hardening
**Goal:** Make what exists reliable enough for real users. No new features.

### 1.1 Fix Persistent Storage
**Problem:** `data/users.json` and `data/analysis-history.json` are wiped on every Railway redeploy.
**Fix:** Add Railway Volume mount OR migrate to a free Postgres instance (Railway provides one).
- [ ] Add `pg` dependency
- [ ] Create `users` and `analysis_history` tables
- [ ] Replace `readUsers/writeUsers` and `readAnalysisHistory/writeAnalysisHistory` with DB queries
- [ ] Keep JSON file fallback for local dev

### 1.2 Rate Limiting
**Problem:** `/analyze` and `/agent` have no rate limiting — one user can spam Claude calls.
**Fix:** Add `express-rate-limit` middleware.
- [ ] 10 req/min per IP on `/analyze`
- [ ] 30 req/min per IP on `/agent`
- [ ] 5 req/min per IP on auth routes

### 1.3 Scraper Resilience
**Problem:** Trustpilot and G2 scrapers break when HTML structure changes.
**Fix:** Add fallback selectors + structured error logging.
- [ ] Log scraper failures with domain + error to a `scraper-errors.log`
- [ ] Add a second CSS selector pattern for Trustpilot rating extraction
- [ ] Add retry (1x) with 2s delay on network timeout

### 1.4 Remove Dead Dependency
- [ ] Remove `puppeteer` from `package.json` (unused, adds ~300MB to Railway build)
- [ ] Remove `axios` (unused — all fetches use native `fetch`)

### 1.5 Input Sanitization
- [ ] Validate URL format before processing in `/analyze` (reject non-HTTP/HTTPS)
- [ ] Cap `message` length in `/agent` at 2000 chars
- [ ] Sanitize `companyProfile` fields in `/cmo` (trim, max length per field)

---

## Phase 2 — Auth Upgrade
**Goal:** Replace the email-as-identity pattern with proper session tokens.

### 2.1 JWT Auth
- [ ] Add `jsonwebtoken` dependency
- [ ] Issue a signed JWT on `/auth/login` and `/auth/signup`
- [ ] Add `authenticateToken` middleware for protected routes
- [ ] Update `/analyze`, `/cmo`, `/agent`, `/usage` to require valid token
- [ ] Update frontend to store token in localStorage and send as `Authorization: Bearer` header
- [ ] Add `/auth/refresh` endpoint (7-day refresh token)

### 2.2 Password Reset
- [ ] Add `/auth/forgot-password` → generates a time-limited reset token (stored in DB)
- [ ] Add `/auth/reset-password` → validates token, updates hash
- [ ] Send reset email via Resend or Postmark (add API key to .env)

---

## Phase 3 — Scraper Upgrades
**Goal:** More reliable, richer signal data.

### 3.1 Replace Google News Scraper
**Problem:** Google News HTML scraping is unreliable and may violate ToS.
**Fix:** Use NewsAPI.org (free tier: 100 req/day).
- [ ] Add `NEWS_API_KEY` to .env.example
- [ ] Replace `fetchNewsSignals()` with NewsAPI call
- [ ] Fall back to current scraper if key is missing

### 3.2 Real Traffic Data
**Problem:** SerpApi organic index count is a weak proxy for traffic.
**Fix:** Add SimilarWeb API or Semrush API as optional upgrade.
- [ ] Add `SIMILARWEB_API_KEY` to .env.example (was there before, got removed)
- [ ] Add `fetchSimilarWebMetrics()` that returns monthly visits, bounce rate, top channels
- [ ] Use SerpApi as fallback when SimilarWeb key is absent

### 3.3 LinkedIn Hiring Signals
**Problem:** Career page scraper only checks 3 hardcoded URLs.
**Fix:** Add LinkedIn Jobs search via SerpApi `engine=google_jobs`.
- [ ] Query `site:linkedin.com/jobs {domain}` via SerpApi
- [ ] Extract job titles and departments
- [ ] Merge with career page results

---

## Phase 4 — On-Chain Intelligence (Real)
**Goal:** Replace the stub with actual blockchain data.

- [ ] Integrate Helius API (Solana) for token holder count, recent transfers
- [ ] Add `HELIUS_API_KEY` to .env.example
- [ ] `fetchOnChainIntelligence()` queries Helius when `tokenMint` is provided
- [ ] Add DexScreener API for price + market cap (no key required)
- [ ] Update `/onchain` response shape to match new data

---

## Phase 5 — Monetization
**Goal:** Convert free users to paid.

### 5.1 Stripe Integration
- [ ] Add `stripe` dependency
- [ ] Add `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` to .env.example
- [ ] Create `/billing/checkout` → Stripe Checkout session (Pro plan: $29/mo)
- [ ] Create `/billing/webhook` → handle `checkout.session.completed`, update user tier in DB
- [ ] Add `tier` field to users table (`free` | `pro`)
- [ ] Update `getUsage()`: free = 3/month, pro = unlimited

### 5.2 Usage UI
- [ ] Show usage bar in frontend (X of 3 used)
- [ ] Show upgrade CTA when limit is reached
- [ ] Show "Pro" badge in nav when user is on paid plan

---

## Phase 6 — Code Quality
**Goal:** Make server.js maintainable as the codebase grows.

### 6.1 Module Split
Split `server.js` into:
```
src/
  routes/
    auth.js       # /auth/*
    analyze.js    # /analyze
    cmo.js        # /cmo
    agent.js      # /agent
    onchain.js    # /onchain
    usage.js      # /usage
  scrapers/
    trustpilot.js
    g2.js
    reddit.js
    news.js
    hiring.js
    traffic.js
    screenshot.js
  ai/
    prompts.js    # buildPrompt, buildCmoPrompt
    client.js     # Anthropic client singleton
  db/
    users.js
    history.js
  middleware/
    auth.js       # JWT middleware
    rateLimit.js
  utils/
    format.js     # formatCompactNumber, etc.
    json.js       # extractJSON
server.js         # App setup + route mounting only
```

### 6.2 Tests
- [ ] Add `jest` + `supertest`
- [ ] Unit tests for `extractJSON`, `summarizeMarketSignals`, `hashPassword`
- [ ] Integration tests for `/auth/signup`, `/auth/login`, `/analyze` (mock Claude)

---

## Milestone Summary

| Phase | Focus | Effort | Priority |
|-------|-------|--------|----------|
| 1 | Stability | 1–2 days | 🔴 Now |
| 2 | Auth upgrade | 2–3 days | 🟠 Soon |
| 3 | Better scrapers | 2–3 days | 🟠 Soon |
| 4 | Real on-chain | 1–2 days | 🟡 When needed |
| 5 | Monetization | 3–4 days | 🟡 When users exist |
| 6 | Code quality | 3–5 days | 🟢 Ongoing |
