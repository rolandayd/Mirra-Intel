// Mirra Backend v9
// Improvements over v8:
//   1. JWT auth — signed tokens replace email-as-identity
//   2. Input sanitization — URL validation, message cap, profile field limits
//   3. Scraper resilience — retry + second selector for Trustpilot
//   4. /history endpoint — retrieve past analyses per user
//   5. Upgraded model to claude-3-5-haiku-20241022
//   6. express upgraded to 4.22.2 (0 audit vulnerabilities)

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const crypto = require('crypto');
const fsSync = require('fs');
const fs = require('fs/promises');
const path = require('path');

// ── Env loader ────────────────────────────────────────────────────────────────
function loadLocalEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fsSync.existsSync(envPath)) return;
  for (const line of fsSync.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadLocalEnv();

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT || 3010);
const SCREENSHOT_API_KEY = process.env.SCREENSHOT_API_KEY || '';
const SERPAPI_KEY = process.env.SERPAPI_KEY || '';
const DEMO_MODE = process.env.DEMO_MODE === 'true';
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 60 * 60 * 1000);
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const JWT_EXPIRES_IN = '7d';
const MODEL = 'claude-3-5-haiku-20241022';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });

const USERS_FILE = path.join(__dirname, 'data', 'users.json');
const HISTORY_FILE = path.join(__dirname, 'data', 'analysis-history.json');
const FREE_LIMIT = 3;

// ── In-memory result cache ────────────────────────────────────────────────────
// Key: domain string. Value: { result, cachedAt }
// Avoids re-scraping + re-calling Claude for the same domain within TTL.
const analysisCache = new Map();

function getCached(domain) {
  const entry = analysisCache.get(domain);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    analysisCache.delete(domain);
    return null;
  }
  return entry.result;
}

function setCache(domain, result) {
  analysisCache.set(domain, { result, cachedAt: Date.now() });
  // Evict oldest entries if cache grows large
  if (analysisCache.size > 200) {
    const oldest = [...analysisCache.entries()].sort((a, b) => a[1].cachedAt - b[1].cachedAt)[0];
    analysisCache.delete(oldest[0]);
  }
}

// ── Simple in-memory rate limiter ─────────────────────────────────────────────
const rateLimitMap = new Map(); // ip → { count, windowStart }

function rateLimit(maxPerMin) {
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = rateLimitMap.get(ip) || { count: 0, windowStart: now };
    if (now - entry.windowStart > 60000) {
      entry.count = 0;
      entry.windowStart = now;
    }
    entry.count++;
    rateLimitMap.set(ip, entry);
    if (entry.count > maxPerMin) {
      return res.status(429).json({ error: 'Too many requests. Slow down.' });
    }
    next();
  };
}

// ── JWT helpers ───────────────────────────────────────────────────────────────
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function authenticateToken(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

// ── Input sanitization ────────────────────────────────────────────────────────
const PROFILE_MAX = { website: 200, productType: 200, audience: 300, goals: 500, channels: 300 };

function validateUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return { error: 'URL required.' };
  const withScheme = s.startsWith('http') ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    if (!['http:', 'https:'].includes(u.protocol)) return { error: 'URL must use http or https.' };
    return { url: withScheme, domain: u.hostname.replace('www.', '') };
  } catch {
    return { error: 'Invalid URL.' };
  }
}

function sanitizeProfile(raw = {}) {
  const out = {};
  for (const [k, max] of Object.entries(PROFILE_MAX)) {
    out[k] = String(raw[k] || '').trim().slice(0, max);
  }
  return out;
}

// ── File helpers ──────────────────────────────────────────────────────────────
async function readJsonFile(filePath, fallback) {
  try { return JSON.parse(await fs.readFile(filePath, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
async function writeJsonFile(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}
const readUsers = () => readJsonFile(USERS_FILE, []);
const writeUsers = (u) => writeJsonFile(USERS_FILE, u);
const readHistory = () => readJsonFile(HISTORY_FILE, {});
const writeHistory = (h) => writeJsonFile(HISTORY_FILE, h);

async function saveAnalysis(email, domain, result) {
  if (!email) return;
  const safe = String(email).trim().toLowerCase();
  const h = await readHistory();
  if (!h[safe]) h[safe] = [];
  h[safe].push({ domain, analyzedAt: new Date().toISOString(), result });
  h[safe] = h[safe].slice(-50);
  await writeHistory(h);
}

// ── Auth helpers ──────────────────────────────────────────────────────────────
const normalizeEmail = (e = '') => String(e).trim().toLowerCase();
const hashPassword = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const sanitizeUser = (u) => ({ id: u.id, name: u.name, email: u.email, createdAt: u.createdAt, profile: u.profile || {} });

// ── Usage ─────────────────────────────────────────────────────────────────────
async function getUsage(email) {
  if (!email) return { used: 0, limit: FREE_LIMIT, remaining: FREE_LIMIT };
  const h = await readHistory();
  const now = new Date();
  const thisMonth = (h[normalizeEmail(email)] || []).filter(e => {
    const d = new Date(e.analyzedAt);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  });
  const used = thisMonth.length;
  return { used, limit: FREE_LIMIT, remaining: Math.max(0, FREE_LIMIT - used) };
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────
// Timeout cut to 4s — scrapers that are slow aren't worth waiting for
async function fetchText(url, timeoutMs = 4000, asJson = false) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      ...(asJson ? { Accept: 'application/json' } : {}),
    },
  });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return asJson ? res.json() : res.text();
}

// Screenshot runs in background — doesn't block the analysis pipeline
async function fetchScreenshot(url) {
  if (!SCREENSHOT_API_KEY) return null;
  try {
    const screenshotUrl = `https://api.screenshotone.com/take?access_key=${SCREENSHOT_API_KEY}`
      + `&url=${encodeURIComponent(url)}&viewport_width=1440&viewport_height=900`
      + `&format=jpg&image_quality=70&block_ads=true&block_cookie_banners=true&timeout=15`;
    const res = await fetch(screenshotUrl, { signal: AbortSignal.timeout(18000) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer()).toString('base64');
  } catch { return null; }
}

// ── Scrapers ──────────────────────────────────────────────────────────────────
function uniqPush(arr, val) {
  const v = String(val || '').trim();
  if (v && !arr.includes(v)) arr.push(v);
}

async function fetchTrustpilot(domain) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (attempt > 0) await new Promise(r => setTimeout(r, 2000));
      const html = await fetchText(`https://www.trustpilot.com/review/${domain}`);
      const reviews = [];
      const blocks = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
      for (const b of blocks) {
        try {
          const data = JSON.parse(b.replace(/<script[^>]*>/, '').replace('</script>', ''));
          (Array.isArray(data.review) ? data.review : []).forEach(r => uniqPush(reviews, r.reviewBody));
        } catch {}
      }
      // Primary selector
      let rating = html.match(/"ratingValue"\s*:\s*"?(\d+\.?\d*)"?/)?.[1];
      let count = html.match(/"reviewCount"\s*:\s*"?(\d+)"?/)?.[1];
      // Fallback selector (Trustpilot sometimes uses data-rating-typography)
      if (!rating) rating = html.match(/data-rating-typography[^>]*>(\d+\.?\d*)</)?.[1];
      if (!rating) rating = html.match(/class="[^"]*typography_heading[^"]*"[^>]*>(\d+\.?\d*)</)?.[1];
      if (!reviews.length && !rating) return null;
      return { source: 'Trustpilot', rating: rating ? parseFloat(rating) : null, count: count ? parseInt(count) : null, reviews: reviews.slice(0, 10) };
    } catch (err) {
      if (attempt === 1) return null; // both attempts failed
    }
  }
  return null;
}

async function fetchG2(domain) {
  try {
    const slug = domain.replace('www.', '').split('.')[0];
    const html = await fetchText(`https://www.g2.com/products/${slug}/reviews`);
    const reviews = [];
    (html.match(/itemprop="reviewBody"[^>]*>([\s\S]{30,400}?)<\/p>/g) || [])
      .forEach(m => uniqPush(reviews, m.replace(/itemprop="reviewBody"[^>]*>/, '').replace(/<[^>]+>/g, '')));
    const rating = html.match(/itemprop="ratingValue"[^>]*content="(\d+\.?\d*)"/)?.[1];
    if (!reviews.length && !rating) return null;
    return { source: 'G2', rating: rating ? parseFloat(rating) : null, reviews: reviews.slice(0, 8) };
  } catch { return null; }
}

async function fetchReddit(domain) {
  try {
    const q = domain.replace('www.', '').split('.')[0];
    const json = await fetchText(`https://www.reddit.com/search.json?q=${encodeURIComponent(q)}&limit=8&sort=new`, 4000, true);
    const reviews = [];
    for (const p of json?.data?.children || []) {
      const combined = [p.data?.title, p.data?.selftext].filter(Boolean).join(' - ').trim();
      if (combined.length > 25) uniqPush(reviews, combined);
    }
    return reviews.length ? { source: 'Reddit', reviews: reviews.slice(0, 6) } : null;
  } catch { return null; }
}

async function fetchNewsSignals(domain) {
  try {
    const html = await fetchText(`https://news.google.com/search?q=${encodeURIComponent(domain)}`);
    const items = [...html.matchAll(/<a[^>]*>([^<]{20,120})<\/a>/g)]
      .slice(0, 6)
      .map(m => ({ title: m[1].trim() }))
      .filter(i => !i.title.includes('Google News'));
    return items.length ? items : null;
  } catch { return null; }
}

async function fetchHiringSignals(domain) {
  const clean = domain.replace('www.', '');
  for (const path of ['/careers', '/jobs', '/about/careers']) {
    try {
      const html = await fetchText(`https://${clean}${path}`, 4000);
      const depts = [];
      const patterns = {
        Engineering: /engineer|developer|backend|frontend/gi,
        Sales: /sales|account executive|business development/gi,
        Marketing: /marketing|growth|content|seo/gi,
        Operations: /operations|ops|logistics/gi,
      };
      Object.entries(patterns).forEach(([label, re]) => { if (re.test(html)) depts.push(label); });
      if (depts.length) return { activeRoles: depts, implication: `Scaling in ${depts.join(', ')}.` };
    } catch {}
  }
  return null;
}

async function fetchTrafficMetrics(domain) {
  if (!SERPAPI_KEY) return null;
  try {
    const url = new URL('https://serpapi.com/search');
    url.searchParams.set('engine', 'google');
    url.searchParams.set('q', `site:${domain}`);
    url.searchParams.set('api_key', SERPAPI_KEY);
    url.searchParams.set('num', '1');
    url.searchParams.set('gl', 'us');
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      source: 'SerpApi',
      domain,
      indexedPages: data?.search_information?.total_results ?? null,
      organicSnippets: (data?.organic_results || []).slice(0, 2).map(r => ({ title: r.title, snippet: r.snippet })),
    };
  } catch { return null; }
}

// ── Signal summarizer ─────────────────────────────────────────────────────────
function summarizeSignals({ trustpilot, g2, reddit, news, hiring }) {
  const complaints = [], loved = [], ratings = [];
  const allReviews = [...(trustpilot?.reviews || []), ...(g2?.reviews || []), ...(reddit?.reviews || [])];
  const complaintKw = ['expensive', 'slow', 'support', 'bug', 'issue', 'confusing', 'broken', 'pricing'];
  const loveKw = ['easy', 'fast', 'great', 'love', 'helpful', 'intuitive', 'powerful'];
  allReviews.forEach(r => {
    const l = r.toLowerCase();
    if (complaintKw.some(k => l.includes(k))) uniqPush(complaints, r);
    if (loveKw.some(k => l.includes(k))) uniqPush(loved, r);
  });
  if (trustpilot?.rating) ratings.push(trustpilot.rating);
  if (g2?.rating) ratings.push(g2.rating);
  const avg = ratings.length ? ratings.reduce((s, v) => s + v, 0) / ratings.length : null;
  const sentiment = avg !== null ? (avg >= 4.2 ? 'positive' : avg <= 2.8 ? 'negative' : 'mixed')
    : complaints.length > loved.length + 2 ? 'negative' : loved.length > complaints.length + 2 ? 'positive' : 'mixed';
  return { complaints: complaints.slice(0, 5), lovedFeatures: loved.slice(0, 4), sentiment, averageRating: avg ? avg.toFixed(1) : null, news, hiring };
}




// ── Prompts ───────────────────────────────────────────────────────────────────
// Tighter schema = fewer tokens = faster response + lower cost
function buildAnalyzePrompt(url, domain, signals) {
  return `You are Mirra, an elite competitive intelligence analyst. Be sharp, specific, and ruthless.

Competitor: ${domain} (${url})
Signals: ${JSON.stringify(signals)}

Return ONLY valid JSON — no markdown, no explanation:
{"threatLevel":"CRITICAL|HIGH|MEDIUM|LOW","threatReason":"1 sentence","summary":"2-3 sentences max","customerSentiment":{"sentimentScore":"positive|negative|mixed","topComplaints":["max 3"],"lovedFeatures":["max 3"]},"positioning":{"claimedPosition":"","actualPosition":"","positioningGap":""},"hiringSignals":{"activeRoles":[],"implication":""},"trafficInsight":"","strategicGaps":[{"gap":"","opportunity":"","impact":"high|medium|low"}],"immediateActions":[{"action":"","why":"","effort":"quick|medium|project"}]}`;
}

function buildCmoPrompt(profile, analysis, task) {
  return `You are Mirra CMO. Be direct and tactical.

Company: ${JSON.stringify(profile)}
Analysis: ${JSON.stringify(analysis)}
Task: ${task}

Return ONLY valid JSON:
{"summary":"","positioning":"","competitiveThreat":"","yourOpportunity":"","weeklyFocus":["","",""],"homepageRewrite":{"headline":"","subheadline":"","cta":""},"outreachEmail":{"subject":"","body":""},"experiments":[{"title":"","why":"","effort":"quick|medium|project","steps":[]}],"nextWeek":""}`;
}

function buildAgentSystem(analysis, domain, profile) {
  return `You are Mirra Agent — elite market intelligence specialist. Direct, sharp, action-oriented.

Capabilities: competitor positioning, messaging copy, action plans, SEO gaps, cold emails, pricing strategy.
${analysis ? `\nCURRENT ANALYSIS — ${domain}:\nThreat: ${analysis.threatLevel}\n${analysis.summary}\nPositioning gap: ${analysis.positioning?.positioningGap || 'N/A'}` : 'No analysis loaded. Ask user to run a scan first.'}
${profile?.website ? `\nUSER BRAND: ${profile.website} | ${profile.productType} | Audience: ${profile.audience}` : ''}

Rules: Be specific. When asked to write copy, write it. When asked for a plan, give numbered steps. Use **bold** for key points.`;
}

function extractJSON(text) {
  try { return JSON.parse(text); } catch {}
  const s = String(text || '').replace(/^```json\s*/, '').replace(/^```\s*/, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(s); } catch {}
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i !== -1 && j > i) { try { return JSON.parse(s.slice(i, j + 1)); } catch {} }
  return null;
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use('/assets', express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  const landing = path.join(__dirname, 'mirra-tester-v2.html');
  if (fsSync.existsSync(landing)) return res.sendFile(landing);
  res.json({ status: 'Mirra backend running', version: '8.0.0' });
});

app.get('/status', (req, res) => res.json({
  status: 'Mirra backend running', version: '8.0.0', demoMode: DEMO_MODE,
  cacheSize: analysisCache.size,
  config: {
    hasAnthropicKey: Boolean(process.env.ANTHROPIC_API_KEY),
    hasScreenshotKey: Boolean(SCREENSHOT_API_KEY),
    hasSerpApiKey: Boolean(SERPAPI_KEY),
  },
}));

app.use((req, res, next) => {
  if (DEMO_MODE) res.setHeader('X-Mirra-Demo-Mode', 'true');
  next();
});

// ── Auth routes ───────────────────────────────────────────────────────────────
app.post('/auth/signup', async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 100);
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password required.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be 8+ characters.' });
  const users = await readUsers();
  if (users.some(u => u.email === email)) return res.status(409).json({ error: 'Email already registered.' });
  const salt = crypto.randomBytes(16).toString('hex');
  const user = { id: crypto.randomUUID(), name, email, salt, passwordHash: hashPassword(password, salt), createdAt: new Date().toISOString(), profile: {} };
  users.push(user);
  await writeUsers(users);
  const token = signToken({ id: user.id, email: user.email });
  res.json({ success: true, token, user: sanitizeUser(user) });
});

app.post('/auth/login', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
  const users = await readUsers();
  const user = users.find(u => u.email === email);
  if (!user || hashPassword(password, user.salt) !== user.passwordHash)
    return res.status(401).json({ error: 'Invalid email or password.' });
  const token = signToken({ id: user.id, email: user.email });
  res.json({ success: true, token, user: sanitizeUser(user) });
});

app.post('/auth/profile', authenticateToken, async (req, res) => {
  const email = req.user.email;
  const profile = sanitizeProfile(req.body?.profile);
  const users = await readUsers();
  const user = users.find(u => u.email === email);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  user.profile = profile;
  await writeUsers(users);
  res.json({ success: true, user: sanitizeUser(user) });
});

app.get('/usage', authenticateToken, async (req, res) => {
  if (DEMO_MODE) return res.json({ used: 0, limit: 9999, remaining: 9999, demoMode: true });
  const usage = await getUsage(req.user.email);
  res.json(usage);
});

// ── /analyze — streaming + cache ──────────────────────────────────────────────
app.post('/analyze', authenticateToken, rateLimit(10), async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY)
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured.' });

  const parsed = validateUrl(req.body?.url);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { url: normalizedUrl, domain } = parsed;

  const email = req.user.email;
  const stream = req.body?.stream === true;

  if (!DEMO_MODE) {
    const usage = await getUsage(email);
    if (usage.remaining <= 0)
      return res.status(429).json({ error: 'Monthly limit reached. Upgrade to continue.', usage });
  }

  // Cache hit — return instantly
  const cached = getCached(domain);
  if (cached) {
    return res.json({ success: true, result: cached, fromCache: true, demoMode: DEMO_MODE });
  }

  // Run all scrapers in parallel — screenshot is fire-and-forget (non-blocking)
  const screenshotPromise = fetchScreenshot(normalizedUrl); // starts but we don't await it yet
  const [trustpilot, g2, reddit, news, hiring, trafficMetrics] = await Promise.all([
    fetchTrustpilot(domain),
    fetchG2(domain),
    fetchReddit(domain),
    fetchNewsSignals(domain),
    fetchHiringSignals(domain),
    fetchTrafficMetrics(domain),
  ]);

  const signals = summarizeSignals({ trustpilot, g2, reddit, news, hiring });
  const screenshotBase64 = await screenshotPromise; // now collect screenshot result

  const content = [];
  if (screenshotBase64) {
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: screenshotBase64 } });
  }
  content.push({ type: 'text', text: buildAnalyzePrompt(normalizedUrl, domain, { trustpilot, g2, reddit, news, hiring, trafficMetrics, sentiment: signals }) });

  try {
    if (stream) {
      // Streaming mode — send tokens as they arrive
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no');

      let fullText = '';
      const stream = await client.messages.stream({
        model: MODEL,
        max_tokens: 1800,
        messages: [{ role: 'user', content }],
      });

      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
          fullText += chunk.delta.text;
          res.write(`data: ${JSON.stringify({ token: chunk.delta.text })}\n\n`);
        }
      }

      const result = extractJSON(fullText);
      if (!result) {
        res.write(`data: ${JSON.stringify({ error: 'Parse failed. Try again.' })}\n\n`);
        return res.end();
      }

      result.trafficMetrics = trafficMetrics;
      result._sources = { trustpilot: Boolean(trustpilot), g2: Boolean(g2), reddit: Boolean(reddit), news: Boolean(news), hiring: Boolean(hiring), screenshot: Boolean(screenshotBase64), traffic: Boolean(trafficMetrics) };
      setCache(domain, result);
      if (email) await saveAnalysis(email, domain, result);

      res.write(`data: ${JSON.stringify({ done: true, result })}\n\n`);
      res.end();
    } else {
      // Standard JSON mode
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 1800,
        messages: [{ role: 'user', content }],
      });

      const raw = response.content.map(b => b.text || '').join('').trim();
      const result = extractJSON(raw);
      if (!result) return res.status(500).json({ error: 'Could not parse model response. Try again.' });

      result.trafficMetrics = trafficMetrics;
      result._sources = { trustpilot: Boolean(trustpilot), g2: Boolean(g2), reddit: Boolean(reddit), news: Boolean(news), hiring: Boolean(hiring), screenshot: Boolean(screenshotBase64), traffic: Boolean(trafficMetrics) };
      setCache(domain, result);
      if (email) await saveAnalysis(email, domain, result);

      res.json({ success: true, result, fromCache: false, demoMode: DEMO_MODE });
    }
  } catch (err) {
    res.status(500).json({ error: err.message || 'Analysis failed.' });
  }
});

// ── /cmo ──────────────────────────────────────────────────────────────────────
app.post('/cmo', authenticateToken, rateLimit(20), async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY)
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured.' });
  const { analysis, task = 'weekly-plan' } = req.body || {};
  const companyProfile = sanitizeProfile(req.body?.companyProfile);
  if (!companyProfile.website || !analysis) return res.status(400).json({ error: 'companyProfile and analysis required.' });
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1600,
      messages: [{ role: 'user', content: buildCmoPrompt(companyProfile, analysis, task) }],
    });
    const result = extractJSON(response.content.map(b => b.text || '').join('').trim());
    if (!result) return res.status(500).json({ error: 'Could not parse CMO response.' });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message || 'CMO generation failed.' });
  }
});

// ── /agent — streaming ────────────────────────────────────────────────────────
app.post('/agent', authenticateToken, rateLimit(30), async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY)
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured.' });

  const { message, history = [], analysis, domain, profile = {}, stream: doStream } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required.' });
  if (String(message).length > 2000) return res.status(400).json({ error: 'Message too long (max 2000 chars).' });

  const messages = [
    ...history.slice(-8).map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content })),
    { role: 'user', content: message },
  ];

  try {
    if (doStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no');

      const stream = await client.messages.stream({
        model: MODEL,
        max_tokens: 1000,
        system: buildAgentSystem(analysis, domain, profile),
        messages,
      });

      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
          res.write(`data: ${JSON.stringify({ token: chunk.delta.text })}\n\n`);
        }
      }
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } else {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 1000,
        system: buildAgentSystem(analysis, domain, profile),
        messages,
      });
      res.json({ success: true, result: { response: response.content.map(b => b.text || '').join('').trim(), taskType: 'chat' } });
    }
  } catch (err) {
    res.status(500).json({ error: err.message || 'Agent error.' });
  }
});

// ── /history ──────────────────────────────────────────────────────────────────
app.get('/history', authenticateToken, async (req, res) => {
  const h = await readHistory();
  const entries = (h[req.user.email] || []).slice().reverse(); // newest first
  res.json({ success: true, history: entries });
});

// ── /onchain ──────────────────────────────────────────────────────────────────
app.post('/onchain', authenticateToken, async (req, res) => {
  const domain = String(req.body?.domain || '').trim();
  if (!domain) return res.status(400).json({ error: 'domain required.' });
  // Stub — Phase 4 will wire Helius + DexScreener
  res.json({ success: true, onChainData: { hasOnChainData: false, message: 'On-chain data coming in Phase 4.' } });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Debug — tells you if ADMIN_SECRET is set without revealing it
app.get('/admin/ping', (req, res) => {
  res.json({ adminSecretSet: Boolean(process.env.ADMIN_SECRET) });
});

// ── Admin middleware ──────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const secret = req.headers['x-admin-secret'] || req.query.secret;
  if (!process.env.ADMIN_SECRET) return res.status(503).json({ error: 'ADMIN_SECRET not set.' });
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden.' });
  next();
}

// ── GET /admin/dashboard ──────────────────────────────────────────────────────
app.get('/admin/dashboard', adminAuth, async (req, res) => {
  const [users, history] = await Promise.all([readUsers(), readHistory()]);
  const now = new Date();

  const userStats = users.map(u => {
    const entries = history[u.email] || [];
    const thisMonth = entries.filter(e => {
      const d = new Date(e.analyzedAt);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    });
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      createdAt: u.createdAt,
      totalAnalyses: entries.length,
      thisMonth: thisMonth.length,
      lastActive: entries.length ? entries[entries.length - 1].analyzedAt : null,
      recentDomains: entries.slice(-5).reverse().map(e => e.domain),
    };
  });

  // Global stats
  const allEntries = Object.values(history).flat();
  const thisMonthAll = allEntries.filter(e => {
    const d = new Date(e.analyzedAt);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  });
  const domainCounts = allEntries.reduce((acc, e) => {
    acc[e.domain] = (acc[e.domain] || 0) + 1; return acc;
  }, {});
  const topDomains = Object.entries(domainCounts)
    .sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([domain, count]) => ({ domain, count }));

  res.json({
    overview: {
      totalUsers: users.length,
      totalAnalyses: allEntries.length,
      analysesThisMonth: thisMonthAll.length,
      activeUsersThisMonth: userStats.filter(u => u.thisMonth > 0).length,
      cacheSize: analysisCache.size,
    },
    topDomains,
    users: userStats.sort((a, b) => (b.lastActive || '').localeCompare(a.lastActive || '')),
  });
});

// ── GET /admin/activity ───────────────────────────────────────────────────────
app.get('/admin/activity', adminAuth, async (req, res) => {
  const history = await readHistory();
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const all = Object.entries(history).flatMap(([email, entries]) =>
    entries.map(e => ({ email, domain: e.domain, analyzedAt: e.analyzedAt }))
  );
  all.sort((a, b) => b.analyzedAt.localeCompare(a.analyzedAt));
  res.json({ activity: all.slice(0, limit) });
});

// ── /cache/clear — admin utility ──────────────────────────────────────────────
app.post('/cache/clear', adminAuth, (req, res) => {
  analysisCache.clear();
  res.json({ success: true, message: 'Cache cleared.' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Mirra v9 running on port ${PORT}`);
  if (DEMO_MODE) console.log('⚡ DEMO MODE — limits bypassed');
  if (SERPAPI_KEY) console.log('✓ SerpApi traffic enabled');
  if (SCREENSHOT_API_KEY) console.log('✓ Screenshot API enabled');
  console.log(`✓ Result cache TTL: ${CACHE_TTL_MS / 1000 / 60}min`);
});
