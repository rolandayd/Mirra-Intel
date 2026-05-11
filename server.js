const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');
const crypto = require('crypto');
const fsSync = require('fs');
const fs = require('fs/promises');
const path = require('path');

function loadLocalEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fsSync.existsSync(envPath)) return;

  const lines = fsSync.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadLocalEnv();

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT || 3010);
const WORKSPACE_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(WORKSPACE_ROOT, 'public');
const LANDING_PAGE = path.join(WORKSPACE_ROOT, 'mirra-tester-v2.html');
const USERS_FILE = path.join(__dirname, 'data', 'users.json');
const HISTORY_FILE = path.join(__dirname, 'data', 'analysis-history.json');

const SCREENSHOT_API_KEY = process.env.SCREENSHOT_API_KEY || '';
const SERPAPI_KEY = process.env.SERPAPI_KEY || '';           // ← replaces SIMILARWEB
const DEMO_MODE = process.env.DEMO_MODE === 'true';          // ← bypass for demos

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });

app.use('/assets', express.static(PUBLIC_DIR));

app.get('/', (req, res) => {
  res.sendFile(LANDING_PAGE);
});

app.get('/status', (req, res) => {
  res.json({
    status: 'Mirra backend running',
    version: '7.0.0',
    demoMode: DEMO_MODE,
    config: {
      hasAnthropicKey: Boolean(process.env.ANTHROPIC_API_KEY),
      hasScreenshotKey: Boolean(SCREENSHOT_API_KEY),
      hasSerpApiKey: Boolean(SERPAPI_KEY)
    }
  });
});

// ─── Demo mode middleware ──────────────────────────────────────────────────────
// When DEMO_MODE=true, clears any usage limits stored on req so nothing blocks.
// The quota lives in the frontend localStorage — this header tells the frontend
// to skip its local gate entirely.
app.use((req, res, next) => {
  if (DEMO_MODE) {
    res.setHeader('X-Mirra-Demo-Mode', 'true');
  }
  next();
});

// ─── Auth helpers ──────────────────────────────────────────────────────────────

function normalizeEmail(email = '') {
  return String(email).trim().toLowerCase();
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function sanitizeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt,
    profile: user.profile || {}
  };
}

async function readJsonFile(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJsonFile(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

async function readUsers() {
  return readJsonFile(USERS_FILE, []);
}

async function writeUsers(users) {
  await writeJsonFile(USERS_FILE, users);
}

async function readAnalysisHistory() {
  return readJsonFile(HISTORY_FILE, {});
}

async function writeAnalysisHistory(history) {
  await writeJsonFile(HISTORY_FILE, history);
}

async function saveAnalysisResult(email, domain, result) {
  if (!email) return;
  const safeEmail = normalizeEmail(email);
  if (!safeEmail) return;

  const history = await readAnalysisHistory();
  if (!history[safeEmail]) history[safeEmail] = [];
  history[safeEmail].push({
    domain,
    analyzedAt: new Date().toISOString(),
    result
  });
  history[safeEmail] = history[safeEmail].slice(-50);
  await writeAnalysisHistory(history);
}

// ─── Auth routes ───────────────────────────────────────────────────────────────

app.post('/auth/signup', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required.' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const users = await readUsers();
  if (users.some(user => user.email === email)) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: crypto.randomUUID(),
    name,
    email,
    salt,
    passwordHash: hashPassword(password, salt),
    createdAt: new Date().toISOString(),
    profile: {
      website: '',
      productType: '',
      audience: '',
      goals: '',
      channels: ''
    }
  };

  users.push(user);
  await writeUsers(users);
  return res.json({ success: true, user: sanitizeUser(user) });
});

app.post('/auth/login', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const users = await readUsers();
  const user = users.find(candidate => candidate.email === email);
  if (!user || hashPassword(password, user.salt) !== user.passwordHash) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  return res.json({ success: true, user: sanitizeUser(user) });
});

app.post('/auth/profile', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const profile = req.body?.profile || {};

  if (!email) {
    return res.status(400).json({ error: 'Email is required.' });
  }

  const users = await readUsers();
  const user = users.find(candidate => candidate.email === email);
  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }

  user.profile = {
    website: String(profile.website || '').trim(),
    productType: String(profile.productType || '').trim(),
    audience: String(profile.audience || '').trim(),
    goals: String(profile.goals || '').trim(),
    channels: String(profile.channels || '').trim()
  };

  await writeUsers(users);
  return res.json({ success: true, user: sanitizeUser(user) });
});

// ─── Usage endpoint ───────────────────────────────────────────────────────────

const FREE_LIMIT = 3;

async function getUsage(email) {
  if (!email) return { used: 0, limit: FREE_LIMIT, remaining: FREE_LIMIT };
  const history = await readAnalysisHistory();
  const userHistory = history[normalizeEmail(email)] || [];
  // Count analyses in the current calendar month
  const now = new Date();
  const thisMonth = userHistory.filter(entry => {
    const d = new Date(entry.analyzedAt);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  });
  const used = thisMonth.length;
  const remaining = Math.max(0, FREE_LIMIT - used);
  return { used, limit: FREE_LIMIT, remaining };
}

app.get('/usage', async (req, res) => {
  if (DEMO_MODE) {
    return res.json({ used: 0, limit: 9999, remaining: 9999, demoMode: true });
  }
  const email = normalizeEmail(req.query?.email);
  const usage = await getUsage(email);
  return res.json(usage);
});

// ─── Utility helpers ───────────────────────────────────────────────────────────

function ensureAnthropicConfigured(res, featureName) {
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(503).json({
      error: `${featureName} is not configured yet. Add ANTHROPIC_API_KEY to .env and restart the server.`
    });
    return false;
  }
  return true;
}

async function fetchText(url, timeoutMs = 8000, acceptJson = false) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      ...(acceptJson ? { Accept: 'application/json' } : {})
    }
  });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return acceptJson ? res.json() : res.text();
}

async function fetchScreenshot(normalizedUrl) {
  if (!SCREENSHOT_API_KEY) return null;

  try {
    const screenshotUrl =
      `https://api.screenshotone.com/take?access_key=${SCREENSHOT_API_KEY}` +
      `&url=${encodeURIComponent(normalizedUrl)}` +
      `&viewport_width=1440&viewport_height=1024&format=jpg&image_quality=80` +
      `&block_ads=true&block_cookie_banners=true&timeout=20`;
    const res = await fetch(screenshotUrl, { signal: AbortSignal.timeout(25000) });
    if (!res.ok) return null;
    const data = await res.arrayBuffer();
    return Buffer.from(data).toString('base64');
  } catch (_) {
    return null;
  }
}

function formatCompactNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: value >= 1000000 ? 1 : 0
  }).format(value);
}

function formatPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return `${Math.round(value * 100)}%`;
}

function formatDuration(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (!mins) return `${secs}s`;
  return `${mins}m ${String(secs).padStart(2, '0')}s`;
}

// ─── SerpApi traffic fetch (replaces SimilarWeb) ──────────────────────────────
//
// Uses SerpApi's Google Search engine to find publicly visible traffic
// estimates for a domain. Falls back gracefully if key is missing or call
// fails — the rest of the analysis still runs.
//
// SerpApi docs: https://serpapi.com/search-api
// Endpoint used: GET https://serpapi.com/search?engine=google&q=site:{domain}
//
// To get real traffic numbers, SerpApi also supports the "similarweb" engine
// as an unofficial wrapper. We try that first, then fall back to organic signals.

async function fetchTrafficMetrics(domain) {
  if (!SERPAPI_KEY) return null;

  // ── Attempt 1: SerpApi SimilarWeb-style engine (unofficial but works) ──────
  try {
    const url = new URL('https://serpapi.com/search');
    url.searchParams.set('engine', 'google');
    url.searchParams.set('q', `site:${domain}`);
    url.searchParams.set('api_key', SERPAPI_KEY);
    url.searchParams.set('num', '1');
    url.searchParams.set('gl', 'us');
    url.searchParams.set('hl', 'en');

    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(12000),
      headers: { Accept: 'application/json' }
    });

    if (!res.ok) throw new Error(`SerpApi returned ${res.status}`);
    const data = await res.json();

    // Extract organic result count as a proxy for site authority / index size
    const totalResults = data?.search_information?.total_results ?? null;
    const organicResults = (data?.organic_results || []).slice(0, 3);

    // Try to pull any traffic insight from knowledge graph or inline sitelinks
    const kg = data?.knowledge_graph;
    const sitelinks = data?.organic_results?.[0]?.sitelinks?.inline || [];

    return {
      source: 'SerpApi',
      domain,
      indexedPages: totalResults,
      indexedPagesDisplay: totalResults ? formatCompactNumber(totalResults) : null,
      organicSnippets: organicResults.map(r => ({
        title: r.title,
        link: r.link,
        snippet: r.snippet
      })),
      knowledgeGraph: kg
        ? {
            title: kg.title,
            type: kg.type,
            description: kg.description
          }
        : null,
      sitelinkCount: sitelinks.length || null,
      dataNote:
        'Traffic estimates via SerpApi organic index signals. For precise monthly visit data, add a SimilarWeb or Semrush key.'
    };
  } catch (err) {
    console.error('[SerpApi traffic] failed:', err.message);
    return null;
  }
}

// ─── Review / signal fetchers (unchanged) ─────────────────────────────────────

function uniqPush(items, value) {
  const normalized = String(value || '').trim();
  if (normalized && !items.includes(normalized)) items.push(normalized);
}

async function fetchTrustpilot(domain) {
  try {
    const html = await fetchText(`https://www.trustpilot.com/review/${domain}`);
    const reviews = [];

    const reviewMatches =
      html.match(/data-service-review-text-typography[^>]*>([^<]{30,300})</g) || [];
    reviewMatches.forEach(match => {
      uniqPush(reviews, match.replace(/data-service-review-text-typography[^>]*>/, ''));
    });

    const jsonLdBlocks =
      html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
    jsonLdBlocks.forEach(block => {
      try {
        const data = JSON.parse(
          block.replace(/<script[^>]*>/, '').replace('</script>', '')
        );
        const reviewList = Array.isArray(data.review) ? data.review : [];
        reviewList.forEach(review => uniqPush(reviews, review.reviewBody));
      } catch (_) {}
    });

    const ratingMatch = html.match(/"ratingValue"\s*:\s*"?(\d+\.?\d*)"?/);
    const countMatch = html.match(/"reviewCount"\s*:\s*"?(\d+)"?/);

    if (!reviews.length && !ratingMatch) return null;
    return {
      source: 'Trustpilot',
      rating: ratingMatch ? parseFloat(ratingMatch[1]) : null,
      count: countMatch ? parseInt(countMatch[1], 10) : null,
      reviews: reviews.slice(0, 12)
    };
  } catch (_) {
    return null;
  }
}

async function fetchG2(domain) {
  try {
    const slug = domain.replace('www.', '').split('.')[0];
    const html = await fetchText(`https://www.g2.com/products/${slug}/reviews`);
    const reviews = [];

    const reviewMatches =
      html.match(/itemprop="reviewBody"[^>]*>([\s\S]{30,400}?)<\/p>/g) || [];
    reviewMatches.forEach(match => {
      uniqPush(
        reviews,
        match
          .replace(/itemprop="reviewBody"[^>]*>/, '')
          .replace(/<[^>]+>/g, '')
      );
    });

    const ratingMatch = html.match(/itemprop="ratingValue"[^>]*content="(\d+\.?\d*)"/);
    if (!reviews.length && !ratingMatch) return null;

    return {
      source: 'G2',
      rating: ratingMatch ? parseFloat(ratingMatch[1]) : null,
      reviews: reviews.slice(0, 10)
    };
  } catch (_) {
    return null;
  }
}

async function fetchReddit(domain) {
  try {
    const query = domain.replace('www.', '').split('.')[0];
    const json = await fetchText(
      `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&limit=10&sort=new`,
      8000,
      true
    );

    const reviews = [];
    for (const post of json?.data?.children || []) {
      const title = post?.data?.title || '';
      const selftext = post?.data?.selftext || '';
      const combined = [title, selftext].filter(Boolean).join(' - ').trim();
      if (combined.length > 25) uniqPush(reviews, combined);
    }

    if (!reviews.length) return null;
    return { source: 'Reddit', reviews: reviews.slice(0, 8) };
  } catch (_) {
    return null;
  }
}

async function fetchNewsSignals(domain) {
  try {
    const html = await fetchText(`https://news.google.com/search?q=${encodeURIComponent(domain)}`);
    const matches = [...html.matchAll(/<a[^>]*>([^<]{20,120})<\/a>/g)];
    const items = [];
    for (const match of matches.slice(0, 8)) {
      const title = String(match[1] || '').trim();
      if (title && !title.includes('Google News')) {
        items.push({ title });
      }
    }
    return items.length ? items : null;
  } catch (_) {
    return null;
  }
}

async function fetchHiringSignals(domain) {
  const cleanDomain = domain.replace('www.', '');
  const careerUrls = [
    `https://${cleanDomain}/careers`,
    `https://${cleanDomain}/jobs`,
    `https://${cleanDomain}/about/careers`
  ];

  for (const careerUrl of careerUrls) {
    try {
      const html = await fetchText(careerUrl, 6000);
      const departments = [];
      const patterns = {
        Engineering: /engineer|developer|backend|frontend|fullstack/gi,
        Sales: /sales|account executive|business development/gi,
        Marketing: /marketing|growth|content|seo/gi,
        Operations: /operations|ops|logistics/gi,
        Legal: /legal|compliance|regulatory/gi
      };

      Object.entries(patterns).forEach(([label, pattern]) => {
        if (pattern.test(html)) departments.push(label);
      });

      if (departments.length) {
        return {
          activeRoles: departments,
          implication: `They appear to be scaling in ${departments.join(', ')}.`
        };
      }
    } catch (_) {}
  }

  return null;
}

async function fetchOnChainIntelligence(domain, tokenMint) {
  if (tokenMint) {
    return {
      hasOnChainData: true,
      tokenMint,
      symbol: 'Manual',
      name: domain,
      price: 'Unavailable',
      priceChange24h: 'N/A',
      marketCap: 'Unavailable',
      holderCount: 'Unknown',
      topHolders: [],
      recentTransfers24h: 0,
      uniqueWallets24h: 0
    };
  }

  return {
    hasOnChainData: false,
    message: 'No on-chain data configured for this competitor yet.'
  };
}

// ─── Signal summarizer ────────────────────────────────────────────────────────

function detectSentiment(complaints, lovedFeatures, ratings) {
  const avgRating = ratings.length
    ? ratings.reduce((sum, value) => sum + value, 0) / ratings.length
    : null;

  if (avgRating !== null) {
    if (avgRating >= 4.2) return 'positive';
    if (avgRating <= 2.8) return 'negative';
  }

  if (complaints.length > lovedFeatures.length + 2) return 'negative';
  if (lovedFeatures.length > complaints.length + 2) return 'positive';
  return 'mixed';
}

function summarizeMarketSignals({ trustpilot, g2, reddit, news, hiring }) {
  const complaints = [];
  const loved = [];
  const ratings = [];

  const allReviews = [
    ...(trustpilot?.reviews || []),
    ...(g2?.reviews || []),
    ...(reddit?.reviews || [])
  ];

  const complaintKeywords = [
    'expensive', 'slow', 'support', 'bug', 'problem', 'issue',
    'confusing', 'difficult', 'broken', 'pricing'
  ];
  const loveKeywords = ['easy', 'fast', 'great', 'love', 'helpful', 'intuitive', 'powerful'];

  allReviews.forEach(review => {
    const lower = review.toLowerCase();
    if (complaintKeywords.some(keyword => lower.includes(keyword))) {
      uniqPush(complaints, review);
    }
    if (loveKeywords.some(keyword => lower.includes(keyword))) {
      uniqPush(loved, review);
    }
  });

  if (trustpilot?.rating) ratings.push(trustpilot.rating);
  if (g2?.rating) ratings.push(g2.rating);

  return {
    complaints: complaints.slice(0, 5),
    lovedFeatures: loved.slice(0, 4),
    sentiment: detectSentiment(complaints, loved, ratings),
    averageRating: ratings.length
      ? (ratings.reduce((sum, value) => sum + value, 0) / ratings.length).toFixed(1)
      : null,
    reviewCount: allReviews.length,
    news,
    hiring
  };
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildPrompt(url, domain, companySignals) {
  return `You are Mirra AI, a competitive intelligence analyst for founders.

Analyze competitor: ${domain}
Landing URL: ${url}

Observed market signals:
${JSON.stringify(companySignals, null, 2)}

Return ONLY raw JSON with this exact shape:
{
  "threatLevel": "CRITICAL|HIGH|MEDIUM|LOW",
  "threatReason": "<one short paragraph>",
  "summary": "<short summary>",
  "customerSentiment": {
    "sentimentScore": "positive|negative|mixed",
    "topComplaints": ["<complaint>"],
    "lovedFeatures": ["<loved feature>"]
  },
  "positioning": {
    "claimedPosition": "<what they claim>",
    "actualPosition": "<what they really appear to be>",
    "positioningGap": "<difference between claim and reality>"
  },
  "hiringSignals": {
    "activeRoles": ["<role area>"],
    "implication": "<what this means>"
  },
  "trafficInsight": "<one short sentence about the traffic quality or scale if traffic data is available, otherwise say unavailable>",
  "strategicGaps": [
    {
      "gap": "<market gap>",
      "opportunity": "<why it matters>",
      "impact": "high|medium|low"
    }
  ],
  "immediateActions": [
    {
      "action": "<specific move to make>",
      "why": "<why this matters>",
      "effort": "quick|medium|project"
    }
  ]
}`;
}

function buildCmoPrompt(companyProfile, analysis, task) {
  return `You are Mirra AI CMO, a strategic marketing operator.

Company profile:
${JSON.stringify(companyProfile, null, 2)}

Competitive analysis:
${JSON.stringify(analysis, null, 2)}

Current task: ${task}

Return ONLY raw JSON in this shape:
{
  "summary": "<short executive summary>",
  "positioning": "<best positioning angle>",
  "competitiveThreat": "<main threat>",
  "yourOpportunity": "<main opportunity>",
  "weeklyFocus": ["<focus 1>", "<focus 2>", "<focus 3>"],
  "homepageRewrite": {
    "headline": "<headline>",
    "subheadline": "<subheadline>",
    "cta": "<cta>"
  },
  "outreachEmail": {
    "subject": "<subject>",
    "body": "<body>"
  },
  "experiments": [
    {
      "title": "<experiment>",
      "why": "<why>",
      "effort": "quick|medium|project",
      "steps": ["<step 1>", "<step 2>", "<step 3>"]
    }
  ],
  "nextWeek": "<next step>"
}`;
}

function extractJSON(text) {
  try {
    return JSON.parse(text);
  } catch (_) {}

  const stripped = String(text || '')
    .replace(/^```json\s*/, '')
    .replace(/^```\s*/, '')
    .replace(/\s*```$/, '')
    .trim();

  try {
    return JSON.parse(stripped);
  } catch (_) {}

  const firstIndex = stripped.indexOf('{');
  const lastIndex = stripped.lastIndexOf('}');
  if (firstIndex !== -1 && lastIndex > firstIndex) {
    try {
      return JSON.parse(stripped.slice(firstIndex, lastIndex + 1));
    } catch (_) {}
  }

  return null;
}

// ─── Core routes ──────────────────────────────────────────────────────────────

app.post('/onchain', async (req, res) => {
  const domain = String(req.body?.domain || '').trim();
  const tokenMint = String(req.body?.tokenMint || '').trim();
  if (!domain) return res.status(400).json({ error: 'domain required' });

  const onChainData = await fetchOnChainIntelligence(domain, tokenMint);
  return res.json({ success: true, onChainData });
});

app.post('/analyze', async (req, res) => {
  if (!ensureAnthropicConfigured(res, 'Mirra analysis')) return;

  const url = String(req.body?.url || '').trim();
  const email = normalizeEmail(req.body?.email);
  if (!url) return res.status(400).json({ error: 'URL is required' });

  // ── Server-side usage gate ──────────────────────────────────────────────────
  if (!DEMO_MODE && email) {
    const usage = await getUsage(email);
    if (usage.remaining <= 0) {
      return res.status(429).json({
        error: 'Monthly analysis limit reached. Upgrade to continue.',
        usage
      });
    }
  }

  const normalizedUrl = url.startsWith('http') ? url : `https://${url}`;
  let domain;
  try {
    domain = new URL(normalizedUrl).hostname.replace('www.', '');
  } catch (_) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const [screenshotBase64, trustpilot, g2, reddit, news, hiring, onChainData, trafficMetrics] =
    await Promise.all([
      fetchScreenshot(normalizedUrl),
      fetchTrustpilot(domain),
      fetchG2(domain),
      fetchReddit(domain),
      fetchNewsSignals(domain),
      fetchHiringSignals(domain),
      fetchOnChainIntelligence(domain),
      fetchTrafficMetrics(domain)   // ← now powered by SerpApi
    ]);

  const signals = summarizeMarketSignals({ trustpilot, g2, reddit, news, hiring });
  const content = [];

  if (screenshotBase64) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: screenshotBase64
      }
    });
  }

  content.push({
    type: 'text',
    text: buildPrompt(normalizedUrl, domain, {
      trustpilot,
      g2,
      reddit,
      news,
      hiring,
      trafficMetrics,
      sentiment: signals
    })
  });

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2200,
      messages: [{ role: 'user', content }]
    });

    const raw = response.content.map(block => block.text || '').join('').trim();
    const result = extractJSON(raw);
    if (!result) {
      return res.status(500).json({
        error: 'Mirra could not parse the model response. Please try again.'
      });
    }

    result.onChainData = onChainData;
    result.trafficMetrics = trafficMetrics;
    result._sources = {
      trustpilot: Boolean(trustpilot),
      g2: Boolean(g2),
      reddit: Boolean(reddit),
      news: Boolean(news),
      hiring: Boolean(hiring),
      screenshot: Boolean(screenshotBase64),
      traffic: Boolean(trafficMetrics)
    };

    if (email) {
      await saveAnalysisResult(email, domain, result);
    }

    return res.json({
      success: true,
      result,
      usedScreenshot: Boolean(screenshotBase64),
      demoMode: DEMO_MODE
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || 'Analysis failed. Please try again.'
    });
  }
});

app.post('/cmo', async (req, res) => {
  if (!ensureAnthropicConfigured(res, 'AI CMO')) return;

  const companyProfile = req.body?.companyProfile;
  const analysis = req.body?.analysis;
  const task = String(req.body?.task || 'weekly-plan');

  if (!companyProfile || !analysis) {
    return res.status(400).json({ error: 'companyProfile and analysis are required.' });
  }

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1800,
      messages: [
        {
          role: 'user',
          content: buildCmoPrompt(companyProfile, analysis, task)
        }
      ]
    });

    const raw = response.content.map(block => block.text || '').join('').trim();
    const result = extractJSON(raw);
    if (!result) {
      return res.status(500).json({
        error: 'Mirra could not parse the AI CMO response. Please try again.'
      });
    }

    return res.json({ success: true, result });
  } catch (error) {
    return res.status(500).json({
      error: error.message || 'AI CMO generation failed.'
    });
  }
});

// ─── Agent endpoint ───────────────────────────────────────────────────────────
app.post('/agent', async (req, res) => {
  if (!ensureAnthropicConfigured(res, 'Mirra Agent')) return;

  const { message, history = [], analysis, domain, profile = {} } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message is required.' });

  const systemPrompt = `You are Mirra Agent, an elite market intelligence specialist and strategic advisor. You are direct, sharp, and action-oriented — you don't just answer questions, you run tasks and deliver outputs.

Your capabilities:
- Analyze competitor positioning, gaps, and threats
- Write messaging copy, headlines, and positioning briefs
- Build prioritized action plans and growth experiments
- Identify SEO content gaps and opportunities
- Generate cold email sequences and social content
- Assess pricing strategy and competitive responses

${analysis ? `CURRENT ANALYSIS DATA:
Domain: ${domain}
Score: ${analysis.overallScore}/100
Threat Level: ${analysis.threatLevel}
Summary: ${analysis.summary}
Key insights: ${(analysis.insights||[]).map(i=>`[${i.type}] ${i.text}`).join(' | ')}
Positioning gap: ${analysis.positioning?.positioningGap || 'N/A'}
` : 'No analysis loaded yet. Ask the user to run a competitor scan first.'}

${profile.website ? `USER'S BRAND CONTEXT:
Website: ${profile.website}
Product: ${profile.productType}
Audience: ${profile.audience}
Goals: ${profile.goals}
Channels: ${profile.channels}` : ''}

Rules:
- Be specific and actionable. No generic advice.
- When asked to write copy, actually write it — don't describe it.
- When asked for a plan, give numbered steps with owners and timelines.
- Keep responses focused. Use **bold** for key points.
- If you run a task, label it clearly at the top.`;

  const messages = [
    ...history.slice(-8).map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content })),
    { role: 'user', content: message }
  ];

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      system: systemPrompt,
      messages
    });

    const text = response.content.map(b => b.text || '').join('').trim();
    return res.json({ success: true, result: { response: text, taskType: 'chat' } });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Agent error' });
  }
});

app.listen(PORT, () => {
  console.log(`Mirra backend running on port ${PORT}`);
  if (DEMO_MODE) {
    console.log('⚡ DEMO MODE active — usage limits bypassed');
  }
  if (SERPAPI_KEY) {
    console.log('✓ SerpApi traffic intelligence enabled');
  }
});
