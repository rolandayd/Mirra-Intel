# Mirra — Competitive Intelligence Skill

Use this skill to run competitor analysis, generate CMO strategy briefs, and get market intelligence directly inside your agent session.

Mirra scrapes public signals (reviews, hiring, news, traffic) and uses Claude to return structured strategic briefs in seconds.

---

## When to use this skill

- User asks about a competitor, rival product, or market position
- User wants to understand how their product stacks up against another
- User asks for positioning advice, homepage copy, or outreach emails based on competitive data
- User wants to know what gaps exist in a competitor's offering
- User mentions a domain or company and wants intel on it
- User is working on Docketdive and wants to understand how competitors are positioned

---

## Setup

### Option A — MCP (recommended for Kiro, Claude Code, Codex)

1. Install the MCP server:
   ```bash
   cd ~/mirra/mirra-mcp && npm install
   ```

2. Add to your agent's MCP config:

   **Kiro** (`~/.kiro/settings/mcp.json`):
   ```json
   {
     "mcpServers": {
       "mirra": {
         "command": "node",
         "args": ["PATH_TO/mirra/mirra-mcp/server.js"],
         "env": {
           "MIRRA_BACKEND_URL": "https://your-mirra-backend.railway.app",
           "MIRRA_EMAIL": "your@email.com"
         }
       }
     }
   }
   ```

   **Codex** (`~/.codex/config.json`):
   ```json
   {
     "mcpServers": {
       "mirra": {
         "command": "node",
         "args": ["PATH_TO/mirra/mirra-mcp/server.js"],
         "env": {
           "MIRRA_BACKEND_URL": "https://your-mirra-backend.railway.app",
           "MIRRA_EMAIL": "your@email.com"
         }
       }
     }
   }
   ```

### Option B — Direct HTTP (no MCP needed)

Set `MIRRA_BACKEND_URL` in your environment and call the API directly.

---

## Available MCP Tools

| Tool | What it does |
|------|-------------|
| `mirra_analyze` | Full competitor analysis — threat level, sentiment, positioning gaps, hiring signals, strategic gaps, immediate actions |
| `mirra_cmo` | CMO strategy brief — weekly focus, homepage rewrite, outreach email, growth experiments |
| `mirra_agent` | Conversational advisor — write copy, build plans, find SEO gaps, assess pricing |
| `mirra_usage` | Check monthly usage remaining |
| `mirra_status` | Verify backend is running and keys are configured |

---

## Workflow

### Standard competitive analysis

```
1. mirra_status          — confirm backend is live
2. mirra_analyze(url)    — get the full competitor brief
3. mirra_cmo(analysis, companyProfile)  — turn findings into a strategy
4. mirra_agent(message, analysis)       — drill into specific questions
```

### Quick intel

```
mirra_analyze("https://competitor.com")
→ read threat level + strategic gaps
→ ask mirra_agent to write a positioning response
```

---

## Example prompts that trigger this skill

- "Analyze notion.so as a competitor to Docketdive"
- "What are the gaps in Linear's offering?"
- "Run Mirra on clickup.com and tell me how we should position against them"
- "Use Mirra to write a homepage headline that beats Clio"
- "What's the threat level from Harvey AI?"
- "Check my Mirra usage"

---

## Output format

`mirra_analyze` returns:
- **THREAT LEVEL**: CRITICAL / HIGH / MEDIUM / LOW
- **Customer sentiment**: complaints, loved features
- **Positioning gap**: what they claim vs what users actually experience
- **Hiring signals**: what departments they're scaling
- **Strategic gaps**: ranked by impact (high/medium/low)
- **Immediate actions**: ranked by effort (quick/medium/project)

`mirra_cmo` returns:
- Weekly focus (3 priorities)
- Homepage headline + subheadline + CTA rewrite
- Cold outreach email
- Growth experiments with steps

---

## Notes

- Analysis takes 15–30 seconds (parallel scraping + Claude)
- Free tier: 3 analyses/month per email. Set `DEMO_MODE=true` on the backend to bypass for internal use.
- If `mirra_status` shows missing Anthropic key, the backend needs `ANTHROPIC_API_KEY` set.
- The `mirra_agent` tool maintains conversation context via the `history` parameter — pass prior turns for follow-up questions.
