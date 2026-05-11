# Mirra — Market Intelligence for Modern Teams

Mirra analyzes competitor websites, reviews, hiring signals, and news to give founders and growth teams a strategic competitive brief in seconds.

## Structure

```
├── frontend/   → mirra-tester-v2.html (single-file app)
├── backend/    → Node.js + Express API server
└── public/     → static assets
```

## Running locally

**Backend**
```bash
cd backend
npm install
# copy .env.example to .env and add your keys
node server.js
```

**Frontend**

Open `frontend/mirra-tester-v2.html` directly in a browser, or serve it via the backend (it's served at `/` by default).

## Environment variables

See `backend/.env.example` for required keys:
- `ANTHROPIC_API_KEY` — required for analysis
- `SCREENSHOT_API_KEY` — optional (screenshotone.com)
- `SERPAPI_KEY` — optional (traffic signals)
- `DEMO_MODE` — set to `true` to bypass usage limits

## Deploying

**Backend → Railway**
1. Connect this repo to Railway
2. Set root directory to `backend/`
3. Add env vars in Railway dashboard
4. Deploy

**Frontend → Netlify**
1. Drag and drop `frontend/mirra-tester-v2.html` to Netlify
2. Update `MIRRA_BACKEND_URL` in the HTML to your Railway URL
