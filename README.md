# Ondine

Implementation of the Zero-Cost Enterprise Serverless Stack (v2026.14).

## Architecture

Two repos:

- **`abbashaji/remote_mcp`** — the actual deployed MCP server (`turso-github-mcp`
  on Cloudflare), behind Claude's one custom-connector slot. Full source,
  ready to `wrangler deploy`. This includes the CodeCell pipeline
  (`src/codecells.ts`, `src/code_cell_workflow.ts`) merged directly into
  the server rather than as a second Worker.
- **This repo (`Ondine`)** — the project spec, Turso schema reference, and
  the Heavy Worker (GitHub Actions side of Section 4 step 6). Stays
  **public** so its Actions minutes are unmetered (Section 2).

`mcp-server-patch/` and `worker/` in this repo are now historical —
superseded by `remote_mcp`, kept only so the reasoning trail isn't lost.

## Build status

- [x] Turso schema — `code_cells`, `checkpoints` (created inline by `remote_mcp`'s `ensureSchema()`; `db/schema.sql` here is a standalone reference copy)
- [x] CodeCell pipeline (Sections 4a, 4c, 4f, 5, 5b, 5c) — deployed as part of `remote_mcp`
- [x] GitHub Actions Heavy Worker source (Section 4, step 6) — `scripts/run_heavy_worker.py` + staged workflow file — **written, not yet activated** (see below)
- [x] Pre-filter tagging via Gemma 4 31B (Section 4c) — real `response_schema`-constrained call in `remote_mcp/src/code_cell_workflow.ts`
- [ ] QStash rate-limit pacing (Section 2, narrowed by 4f) — Fast Worker calls don't route through QStash yet
- [x] Discord alert webhook (Section 4, step 7) — bot-token `discordSendMessage`, needs `DISCORD_ALERT_CHANNEL_ID` set on the Worker
- [ ] Neo4j Decision/Error graph + keepalive cron (Section 7, 7f)
- [ ] R2 blob storage wiring (Section 9)
- [ ] PostHog error analytics (Section 10) — deliberately not wired yet; needs a confirmed tool name via `posthog_list_tools` first
- [ ] Operator dashboard (Section 12)

Source spec: `Zero-Cost-Stack-v11.md`.

## Deploying `remote_mcp`

```bash
git clone https://github.com/abbashaji/remote_mcp
cd remote_mcp
npm install
wrangler secret put MCP_AUTH_TOKEN
wrangler secret put GITHUB_TOKEN
wrangler secret put TURSO_DATABASE_URL
wrangler secret put TURSO_AUTH_TOKEN
wrangler secret put DISCORD_BOT_TOKEN
wrangler secret put CLOUDFLARE_API_TOKEN
wrangler secret put NEO4J_URI            # optional
wrangler secret put NEO4J_USERNAME       # optional
wrangler secret put NEO4J_PASSWORD       # optional
wrangler secret put UPSTASH_EMAIL        # optional
wrangler secret put UPSTASH_API_KEY      # optional
wrangler secret put GROQ_API_KEY
wrangler secret put GEMINI_API_KEY
wrangler secret put POSTHOG_API_KEY      # optional
wrangler secret put QSTASH_TOKEN         # optional
# CodeCell-pipeline-specific:
wrangler secret put HEAVY_WORKER_REPO           # e.g. abbashaji/ondine
wrangler secret put HEAVY_WORKER_CALLBACK_TOKEN # openssl rand -hex 32
wrangler secret put DISCORD_ALERT_CHANNEL_ID    # optional
wrangler deploy
```

Then point Claude's custom connector at `https://turso-github-mcp.<subdomain>.workers.dev/mcp`.

## Activating the Heavy Worker (`test.yml`)

Two manual steps:

1. **Move the workflow file.** GitHub blocks pushing into `.github/workflows/`
   from a token without the `workflow` scope. Move
   `gh-workflows-staging/test.yml` → `.github/workflows/test.yml` in one
   commit (GitHub UI is fine) to activate it.
2. **Set repo secrets** (Settings → Secrets and variables → Actions):
   - `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` — same values as the Worker's.
   - `GATEWAY_URL` — `turso-github-mcp`'s base URL (e.g. `https://turso-github-mcp.<subdomain>.workers.dev`).
   - `HEAVY_WORKER_CALLBACK_TOKEN` — must equal the Worker's `HEAVY_WORKER_CALLBACK_TOKEN` secret.

Once both are done, the loop is real end-to-end: `cell_create` starts a
`CodeCellWorkflow` → Fast Worker generates code → dispatches `test.yml`
with `cell_id` + `workflow_instance_id` → the runner pulls that cell's
code from Turso, syntax-checks it (and runs `tests/test_*.py` via pytest
if present) → POSTs pass/fail + log back to
`/webhook/heavy-worker-result` → resolves the waiting `CodeCellWorkflow`
instance's `step.waitForEvent` → tags via Gemma 4 31B → notifies Discord
if urgent.
