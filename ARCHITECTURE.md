# Mirra-Intel — Architecture

## What Mirra Is

Mirra is a competitive intelligence tool for founders and growth teams. You paste a competitor's URL, and Mirra scrapes public signals (reviews, hiring pages, news, traffic, on-chain data), feeds them to Claude, and returns a structured strategic brief in seconds.

---

## System Overview

```
Browser (Frontend)
      │
      │  HTTP (REST)
      ▼
Express API (server.js)
      │
      ├── Signal Fetchers (parallel)
      │     ├── Trustpilot scraper
      │     ├── G2 scraper
      │     ├── Reddit search
      │     ├── Google News scraper
      │     ├── Hiring page scraper
      │     ├── SerpApi (traffic signals)
      │     ├── ScreenshotOne API (visual)
      │     └── On-chain stub (token data)
      │
      ├── Signal Summarizer
      │     └── Sentiment + complaint/love extraction
      │
      └── Anthropic Claude (claude-haiku-4-5)
            ├── /analyze  → competitive brief (JSON)
            ├── /cmo      → CMO strategy brief (JSON)
            └── /agent    → conversational advisor (text)
```

---

## Directory Structure

```
Mirra-Intel/
├── server.js              # All backend logic (single file)
├── package.json
├── .env.example
├── netlify.toml           # Frontend deploy config
├── nixpacks.toml          # Railway deploy config
├── index.html             # Redirect / static entry
├── mirra logo.jpg
└── data/                  # Auto-created at runtime
      ├── users.json       # User accounts (hashed passwords)
      └── analysis-history.json  # Per-user analysis log
```

> The frontend (`mirra-tester-v2.html`) is a single-file app served either from the backend root or deployed separately to Netlify.

---

## API Endpoints

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/status` | Health check + config flags |
| GET | `/usage?email=` | Monthly usage for a user |
| POST | `/auth/signup` | Create account |
| POST | `/auth/login` | Authenticate |
| POST | `/auth/profile` | Save company profile |
| POST | `/analyze` | Core competitor analysis |
| POST | `/cmo` | AI CMO strategy brief |
| POST | `/agent` | Conversational AI advisor |
| POST | `/onchain` | On-chain token intelligence |

---

## Data Flow — `/analyze`

1. Client sends `{ url, email }`
2. Server normalizes URL → extracts domain
3. **8 fetchers run in parallel** via `Promise.all`:
   - Screenshot (ScreenshotOne API)
   - Trustpilot reviews (HTML scrape)
   - G2 reviews (HTML scrape)
   - Reddit posts (Reddit JSON API)
   - Google News headlines (HTML scrape)
   - Hiring signals (career page scrape)
   - On-chain data (stub / token mint)
   - Traffic metrics (SerpApi)
4. `summarizeMarketSignals()` extracts complaints, loved features, sentiment
5. Prompt is built with all signals → sent to Claude with optional screenshot image
6. Claude returns structured JSON → parsed → enriched with raw signal data
7. Result saved to `analysis-history.json` (if email provided)
8. Usage gate checked (3 analyses/month free; bypassed in DEMO_MODE)

---

## Auth Model

- Passwords hashed with `crypto.scryptSync` (salt + 64-byte hash)
- No JWT — client stores user object in localStorage, sends email on requests
- Usage tracked server-side by email + calendar month
- `DEMO_MODE=true` bypasses all limits

---

## AI Layer

All three AI endpoints use **claude-haiku-4-5-20251001**:

| Endpoint | Max Tokens | Output |
|----------|-----------|--------|
| `/analyze` | 2200 | Structured JSON brief |
| `/cmo` | 1800 | Structured JSON strategy |
| `/agent` | 1200 | Markdown prose |

Prompts are hardcoded in `buildPrompt()` and `buildCmoPrompt()`. The agent uses a system prompt with injected analysis context and user brand profile.

---

## External Dependencies

| Service | Required | Purpose |
|---------|----------|---------|
| Anthropic API | ✅ Yes | All AI analysis |
| ScreenshotOne | Optional | Visual competitor screenshot |
| SerpApi | Optional | Traffic/index signals |
| Trustpilot | Free (scrape) | Customer reviews |
| G2 | Free (scrape) | B2B reviews |
| Reddit | Free (JSON API) | Community sentiment |
| Google News | Free (scrape) | News signals |

---

## Deployment

| Layer | Platform | Config |
|-------|----------|--------|
| Backend | Railway | `nixpacks.toml`, env vars in dashboard |
| Frontend | Netlify | `netlify.toml`, update `MIRRA_BACKEND_URL` in HTML |

---

## Known Limitations & Debt

- `server.js` is a single ~600-line file — needs splitting into modules
- Auth has no session tokens; email passed in plaintext on every request
- `data/` folder is ephemeral on Railway (no persistent disk by default)
- Scraping Trustpilot/G2 is fragile — HTML structure changes break it
- No rate limiting on API endpoints (DDoS / abuse risk)
- `puppeteer` is in `package.json` but not used in server.js (dead dependency)
- On-chain intelligence is a stub — not yet connected to real chain data
