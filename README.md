# Ondine

Implementation of the Zero-Cost Enterprise Serverless Stack (v2026.14).

## Build status

- [x] Turso schema — `code_cells`, `checkpoints`, `project_state` (`db/schema.sql`)
- [ ] Cloudflare Worker gateway (Section 6) — remote MCP endpoint, Bearer/Access auth
- [ ] Cloudflare Workflows — Fast→Heavy→tag→notify chain (Section 4f)
- [ ] GitHub Actions Heavy Worker (Section 4, step 6)
- [ ] Pre-filter tagging via Gemma 4 31B (Section 4c)
- [ ] QStash rate-limit pacing (Section 2, narrowed by 4f)
- [ ] Discord alert webhook (Section 4, step 7)
- [ ] Neo4j Decision/Error graph + keepalive cron (Section 7, 7f)
- [ ] R2 blob storage wiring (Section 9)
- [ ] PostHog error analytics (Section 10)
- [ ] Operator dashboard (Section 12)

Source spec: `Zero-Cost-Stack-v11.md`.
