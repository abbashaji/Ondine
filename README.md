# Ondine

Implementation of the Zero-Cost Enterprise Serverless Stack (v2026.14).

## Architecture note (important)

The MCP server behind Claude's one custom-connector slot is
**`turso-github-mcp`** — a real OAuth 2.1 server (dynamic client
registration, `/authorize` consent screen) with ~35 tools already wired
to Turso/GitHub/Discord/Groq/Gemini/Neo4j/Cloudflare/Upstash/PostHog, all
credentials already configured as Worker secrets.

An earlier pass in this repo built a **second**, separate Worker
(`worker/`, `ondine-gateway`) before that source was available to read.
That was a mistake: since only one custom connector slot exists, a
second Worker is just unreachable dead code. **`worker/` and the original
`GATEWAY_BEARER_TOKEN` references in `gh-workflows-staging/test.yml` are
superseded — ignore or delete them.**

The current, correct approach: extend `turso-github-mcp` itself. See
**`mcp-server-patch/`** for the two new files (`codecells.ts`,
`code_cell_workflow.ts`) and the exact diffs for `index.ts`/`auth.ts`/
`wrangler.toml` to merge in. This adds 3 new MCP tools (`cell_create`,
`cell_resume`, `checkpoint_write`) and a `CodeCellWorkflow` Workflow
class, reusing that server's own existing `groq.ts`/`gemini.ts`/
`github.ts`/`discord.ts`/`turso.ts` helpers — no new Worker, no new
secrets besides three CodeCell-specific ones.

## Build status

- [x] Turso schema — `code_cells`, `checkpoints` (also created inline by `mcp-server-patch/codecells.ts`'s `ensureSchema()`; `db/schema.sql` is the standalone reference copy, includes a `project_state` table not currently used by the workflow)
- [x] CodeCell pipeline source (Sections 4a, 4c, 4f, 5, 5b, 5c) — `mcp-server-patch/` — **written, not yet merged into the real source repo** (I don't know which repo that is — tell me and I'll apply it directly)
- [x] GitHub Actions Heavy Worker source (Section 4, step 6) — `scripts/run_heavy_worker.py` + staged workflow file — **written, not yet activated** (see below)
- [x] Pre-filter tagging via Gemma 4 31B (Section 4c) — real `response_schema`-constrained call in `code_cell_workflow.ts`
- [ ] QStash rate-limit pacing (Section 2, narrowed by 4f) — Fast Worker calls don't route through QStash yet
- [x] Discord alert webhook (Section 4, step 7) — uses the existing bot-token `discordSendMessage`, needs `DISCORD_ALERT_CHANNEL_ID`
- [ ] Neo4j Decision/Error graph + keepalive cron (Section 7, 7f)
- [ ] R2 blob storage wiring (Section 9)
- [ ] PostHog error analytics (Section 10) — deliberately not wired yet; `posthog.ts` proxies PostHog's own MCP tool catalog and needs a confirmed tool name (`posthog_list_tools`) before calling it blind
- [ ] Operator dashboard (Section 12)

Source spec: `Zero-Cost-Stack-v11.md`.

## Merging `mcp-server-patch/` into your real source

1. Copy `mcp-server-patch/codecells.ts` and `mcp-server-patch/code_cell_workflow.ts` into your source root as-is.
2. Follow `mcp-server-patch/README.md` for the exact diffs to `index.ts`, `auth.ts`, `wrangler.toml`.
3. Set three new secrets:
   ```bash
   wrangler secret put HEAVY_WORKER_REPO           # e.g. abbashaji/ondine
   wrangler secret put HEAVY_WORKER_CALLBACK_TOKEN # openssl rand -hex 32
   wrangler secret put DISCORD_ALERT_CHANNEL_ID    # optional
   ```
4. `wrangler deploy`.

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

Keep this repo **public** — Section 2's Heavy Worker row: private repos
are capped at 2,000 Actions minutes/month, public repos are unmetered.
