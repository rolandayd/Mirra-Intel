#!/usr/bin/env node
/**
 * Mirra MCP Server
 * Exposes Mirra's competitive intelligence API as MCP tools so any
 * AI agent (Codex, Kiro, Claude Code, etc.) can call Mirra directly.
 *
 * Usage:
 *   node server.js
 *
 * Env vars:
 *   MIRRA_BACKEND_URL  — your deployed Mirra backend (default: http://localhost:3010)
 *   MIRRA_EMAIL        — optional user email for usage tracking
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const MIRRA_URL = (process.env.MIRRA_BACKEND_URL || 'http://localhost:3010').replace(/\/$/, '');
const MIRRA_EMAIL = process.env.MIRRA_EMAIL || '';

async function mirraPost(path, body) {
  const res = await fetch(`${MIRRA_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `Mirra returned ${res.status}`);
  return json;
}

async function mirraGet(path) {
  const res = await fetch(`${MIRRA_URL}${path}`, { signal: AbortSignal.timeout(10000) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `Mirra returned ${res.status}`);
  return json;
}

const server = new McpServer({
  name: 'mirra',
  version: '1.0.0',
});

// ── Tool: analyze ────────────────────────────────────────────────────────────
server.tool(
  'mirra_analyze',
  'Analyze a competitor URL. Returns threat level, customer sentiment, positioning gaps, hiring signals, traffic insight, strategic gaps, and immediate actions.',
  { url: z.string().describe('Competitor URL to analyze, e.g. https://notion.so') },
  async ({ url }) => {
    const data = await mirraPost('/analyze', { url, email: MIRRA_EMAIL });
    const r = data.result;
    const text = [
      `THREAT LEVEL: ${r.threatLevel}`,
      `REASON: ${r.threatReason}`,
      ``,
      `SUMMARY: ${r.summary}`,
      ``,
      `CUSTOMER SENTIMENT: ${r.customerSentiment?.sentimentScore}`,
      r.customerSentiment?.topComplaints?.length
        ? `Top complaints:\n${r.customerSentiment.topComplaints.map(c => `  - ${c}`).join('\n')}`
        : '',
      r.customerSentiment?.lovedFeatures?.length
        ? `Loved features:\n${r.customerSentiment.lovedFeatures.map(f => `  - ${f}`).join('\n')}`
        : '',
      ``,
      `POSITIONING`,
      `  Claimed: ${r.positioning?.claimedPosition}`,
      `  Actual:  ${r.positioning?.actualPosition}`,
      `  Gap:     ${r.positioning?.positioningGap}`,
      ``,
      r.hiringSignals?.activeRoles?.length
        ? `HIRING SIGNALS: ${r.hiringSignals.activeRoles.join(', ')}\n  → ${r.hiringSignals.implication}`
        : 'HIRING SIGNALS: none detected',
      ``,
      r.trafficInsight ? `TRAFFIC: ${r.trafficInsight}` : '',
      ``,
      `STRATEGIC GAPS`,
      ...(r.strategicGaps || []).map(g => `  [${g.impact.toUpperCase()}] ${g.gap}\n    Opportunity: ${g.opportunity}`),
      ``,
      `IMMEDIATE ACTIONS`,
      ...(r.immediateActions || []).map((a, i) => `  ${i + 1}. [${a.effort}] ${a.action}\n     Why: ${a.why}`),
    ].filter(l => l !== undefined).join('\n');

    return { content: [{ type: 'text', text }] };
  }
);

// ── Tool: cmo ────────────────────────────────────────────────────────────────
server.tool(
  'mirra_cmo',
  'Generate an AI CMO strategy brief based on a competitor analysis and your company profile. Returns positioning, weekly focus, homepage rewrite, outreach email, and growth experiments.',
  {
    analysis: z.record(z.unknown()).describe('The result object from mirra_analyze'),
    companyProfile: z.object({
      website: z.string().describe('Your product URL'),
      productType: z.string().describe('What your product does'),
      audience: z.string().describe('Who your target customer is'),
      goals: z.string().describe('Current growth goals'),
      channels: z.string().describe('Marketing channels you use'),
    }),
    task: z.enum(['weekly-plan', 'positioning', 'messaging', 'experiments']).default('weekly-plan'),
  },
  async ({ analysis, companyProfile, task }) => {
    const data = await mirraPost('/cmo', { analysis, companyProfile, task });
    const r = data.result;
    const text = [
      `CMO BRIEF — ${task.toUpperCase()}`,
      ``,
      r.summary,
      ``,
      `POSITIONING: ${r.positioning}`,
      `COMPETITIVE THREAT: ${r.competitiveThreat}`,
      `YOUR OPPORTUNITY: ${r.yourOpportunity}`,
      ``,
      `WEEKLY FOCUS`,
      ...(r.weeklyFocus || []).map((f, i) => `  ${i + 1}. ${f}`),
      ``,
      r.homepageRewrite ? [
        `HOMEPAGE REWRITE`,
        `  Headline:    ${r.homepageRewrite.headline}`,
        `  Subheadline: ${r.homepageRewrite.subheadline}`,
        `  CTA:         ${r.homepageRewrite.cta}`,
      ].join('\n') : '',
      ``,
      r.outreachEmail ? [
        `OUTREACH EMAIL`,
        `  Subject: ${r.outreachEmail.subject}`,
        `  Body:\n${r.outreachEmail.body}`,
      ].join('\n') : '',
      ``,
      `EXPERIMENTS`,
      ...(r.experiments || []).map(e => [
        `  [${e.effort}] ${e.title}`,
        `  Why: ${e.why}`,
        `  Steps: ${e.steps?.join(' → ')}`,
      ].join('\n')),
      ``,
      r.nextWeek ? `NEXT WEEK: ${r.nextWeek}` : '',
    ].filter(Boolean).join('\n');

    return { content: [{ type: 'text', text }] };
  }
);

// ── Tool: agent ──────────────────────────────────────────────────────────────
server.tool(
  'mirra_agent',
  'Chat with Mirra Agent — an elite market intelligence advisor. Ask it to write copy, build action plans, find SEO gaps, generate cold emails, or assess pricing strategy. Optionally pass analysis context.',
  {
    message: z.string().describe('Your question or task for Mirra Agent'),
    analysis: z.record(z.unknown()).optional().describe('Analysis result from mirra_analyze to give the agent context'),
    domain: z.string().optional().describe('Competitor domain the analysis is about'),
    history: z.array(z.object({ role: z.string(), content: z.string() })).optional().describe('Prior conversation turns'),
  },
  async ({ message, analysis, domain, history }) => {
    const data = await mirraPost('/agent', {
      message,
      analysis,
      domain,
      history: history || [],
      profile: {},
    });
    return { content: [{ type: 'text', text: data.result.response }] };
  }
);

// ── Tool: usage ──────────────────────────────────────────────────────────────
server.tool(
  'mirra_usage',
  'Check how many Mirra analyses have been used this month.',
  {},
  async () => {
    const emailParam = MIRRA_EMAIL ? `?email=${encodeURIComponent(MIRRA_EMAIL)}` : '';
    const data = await mirraGet(`/usage${emailParam}`);
    const text = data.demoMode
      ? 'Demo mode active — unlimited analyses.'
      : `Used: ${data.used} / ${data.limit} this month. Remaining: ${data.remaining}`;
    return { content: [{ type: 'text', text }] };
  }
);

// ── Tool: status ─────────────────────────────────────────────────────────────
server.tool(
  'mirra_status',
  'Check if the Mirra backend is running and which integrations are configured.',
  {},
  async () => {
    const data = await mirraGet('/status');
    const lines = [
      `Mirra backend: ${data.status}`,
      `Version: ${data.version}`,
      `Demo mode: ${data.demoMode}`,
      `Anthropic key: ${data.config.hasAnthropicKey ? '✓' : '✗ MISSING'}`,
      `Screenshot key: ${data.config.hasScreenshotKey ? '✓' : '— not set'}`,
      `SerpApi key: ${data.config.hasSerpApiKey ? '✓' : '— not set'}`,
    ];
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

// ── Start ────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
