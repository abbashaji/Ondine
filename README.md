# Ondine

Implementation of the Zero-Cost Enterprise Serverless Stack (v2026.14).

## Build status

- [x] Turso schema — `code_cells`, `checkpoints`, `project_state` (`db/schema.sql`)
- [x] Cloudflare Worker gateway source (Sections 6, 6a, 4f) — `worker/` — **written, not yet deployed** (see below)
- [ ] GitHub Actions Heavy Worker (Section 4, step 6) — `test.yml` referenced by the gateway doesn't exist yet
- [ ] Pre-filter tagging via Gemma 4 31B (Section 4c) — stubbed in the gateway, needs real prompt/schema
- [ ] QStash rate-limit pacing (Section 2, narrowed by 4f)
- [ ] Discord alert webhook (Section 4, step 7) — wired in code, needs a real webhook URL
- [ ] Neo4j Decision/Error graph + keepalive cron (Section 7, 7f)
- [ ] R2 blob storage wiring (Section 9)
- [ ] PostHog error analytics (Section 10)
- [ ] Operator dashboard (Section 12)

Source spec: `Zero-Cost-Stack-v11.md`.

## Deploying `worker/`

This was built and committed as source but **not deployed**, on purpose: the agent
building this only has proxied tool access to Turso/GitHub/Discord/Groq/Gemini
(via an existing MCP connector), not the raw credential values, so it cannot run
`wrangler secret put` itself. To deploy:

```bash
cd worker
wrangler secret put MCP_BEARER_TOKEN
wrangler secret put TURSO_DATABASE_URL
wrangler secret put TURSO_AUTH_TOKEN
wrangler secret put GROQ_API_KEY
wrangler secret put GEMINI_API_KEY
wrangler secret put GITHUB_TOKEN
wrangler secret put GITHUB_REPO      # e.g. abbashaji/ondine
wrangler secret put DISCORD_WEBHOOK_URL
wrangler deploy
```

Then point claude.ai's one free custom remote-MCP connector slot (Section 5c) at
`https://ondine-gateway.<your-subdomain>.workers.dev/mcp/execute` with the Bearer
token you set above.

Note: there's already a separate, live Worker on this Cloudflare account
(`turso-github-mcp`) — the one this build session's own tool access runs through.
`ondine-gateway` is deliberately a new, independent Worker rather than a rewrite
of that one, to avoid touching infrastructure this session depends on mid-build.
Decide whether to keep both or consolidate once `ondine-gateway` is verified working.
