# Ondine

Implementation of the Zero-Cost Enterprise Serverless Stack (v2026.14).

## Build status

- [x] Turso schema — `code_cells`, `checkpoints`, `project_state` (`db/schema.sql`)
- [x] Cloudflare Worker gateway source (Sections 6, 6a, 4f) — `worker/` — **written, not yet deployed** (see below)
- [x] GitHub Actions Heavy Worker source (Section 4, step 6) — `scripts/run_heavy_worker.py` + staged workflow file — **written, not yet activated** (see below)
- [x] Pre-filter tagging via Gemma 4 31B (Section 4c) — real `response_schema`-constrained call in `worker/src/index.js`
- [ ] QStash rate-limit pacing (Section 2, narrowed by 4f) — Fast Worker calls in the gateway don't route through QStash yet
- [x] Discord alert webhook (Section 4, step 7) — wired, needs a real webhook URL in `DISCORD_WEBHOOK_URL`
- [ ] Neo4j Decision/Error graph + keepalive cron (Section 7, 7f)
- [ ] R2 blob storage wiring (Section 9)
- [x] PostHog error analytics (Section 10) — capture call wired, needs `POSTHOG_API_KEY`
- [ ] Operator dashboard (Section 12)

Source spec: `Zero-Cost-Stack-v11.md`.

## Deploying `worker/`

Built and committed as source but **not deployed**, on purpose: the agent
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

## Activating the Heavy Worker (`test.yml`)

Two manual steps, both blocked on things this build session doesn't have:

1. **Move the workflow file.** GitHub blocks pushing into `.github/workflows/`
   from any token without the `workflow` scope — this build's GitHub token
   doesn't have it. The file is staged at `gh-workflows-staging/test.yml`;
   move/rename it to `.github/workflows/test.yml` in one commit (via the
   GitHub UI or your own git client) to activate it.
2. **Set repo secrets** (Settings → Secrets and variables → Actions):
   - `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` — same values as the Worker's.
   - `GATEWAY_URL` — the deployed `ondine-gateway` Worker's base URL.
   - `GATEWAY_BEARER_TOKEN` — must equal the Worker's `MCP_BEARER_TOKEN`.

Once both are done, the loop is real end-to-end: gateway dispatches
`test.yml` with `cell_id` + `workflow_instance_id` → the runner pulls that
cell's code from Turso, syntax-checks it (and runs `tests/test_*.py` via
pytest if present) → POSTs pass/fail + log back to
`/webhook/heavy-worker-result` → that resolves the waiting
`CodeCellWorkflow` instance's `step.waitForEvent`, which then tags via
Gemma 4 31B and notifies.

Also keep this repo **public** — Section 2's Heavy Worker row: private
repos are capped at 2,000 Actions minutes/month, public repos are unmetered.
