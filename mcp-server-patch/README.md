# mcp-server-patch — apply to your real `turso-github-mcp` source

This folder consolidates the CodeCell pipeline (Sections 4a/4c/4f/5/5b/5c
of `Zero-Cost-Stack-v11.md`) into your **existing** deployed MCP server —
`turso-github-mcp` — instead of a second Worker. Rationale: your claude.ai
account has exactly one custom-connector slot, already pointed at this
Worker, so a second Worker would just be unreachable dead code. (An
earlier pass in this repo's `worker/` folder made that mistake — ignore
or delete `worker/` and `gh-workflows-staging/test.yml`'s old
`GATEWAY_BEARER_TOKEN` references; superseded by this.)

Two new files, ready to drop in as-is:
- `codecells.ts` → copy to your source root
- `code_cell_workflow.ts` → copy to your source root

Three files need small edits — exact diffs below (old → new).

## index.ts

**1. Imports**, right after the existing `TaskRunner` import:
```diff
 import { TaskRunner, type RunnerTask } from "./runner";
+import { CodeCellWorkflow } from "./code_cell_workflow";
+import { ensureSchema, createCell, resumeCandidate, writeCheckpoint, getCell } from "./codecells";

-export { JobWorkflow, TaskRunner };
+export { JobWorkflow, TaskRunner, CodeCellWorkflow };
```

**2. `Env` interface**, add after `RUNNER: DurableObjectNamespace<TaskRunner>;`:
```diff
+  CODE_CELL_WORKFLOW: Workflow<import("./code_cell_workflow").CodeCellWorkflowParams>;
+  DISCORD_ALERT_CHANNEL_ID?: string;
+  HEAVY_WORKER_REPO?: string; // "owner/name" -- repo containing .github/workflows/test.yml
+  HEAVY_WORKER_CALLBACK_TOKEN?: string; // machine-to-machine secret for /webhook/heavy-worker-result
```

**3. Three new tools** — insert this whole block immediately before the
existing `// ---- runner_* (3 tools) ----` comment:

```ts
  // ---- cell_* (3 tools) -------------------------------------------------
  // Section 4a/4f/5/5b/5c: the CodeCell pipeline. cell_create starts a
  // durable CodeCellWorkflow instance (fast-worker-generate ->
  // heavy-worker-dispatch -> wait for test.yml's callback -> tag -> notify,
  // see code_cell_workflow.ts). cell_resume/checkpoint_write implement the
  // generic cross-session resumability pattern from Section 5b/5c.

  server.registerTool(
    "cell_create",
    {
      description:
        "Insert a new Pending CodeCell (Section 4a) and start its CodeCellWorkflow instance. " +
        "Requires HEAVY_WORKER_REPO to be set (the repo containing .github/workflows/test.yml).",
      inputSchema: {
        spec: z.string().describe("The task/spec text the Fast Worker will generate code from."),
        role: z.string().default("Architect").describe('e.g. "Architect", "Coder", "Reviewer", "Debugger"'),
      },
    },
    async ({ spec, role }) => {
      try {
        await ensureSchema(env);
        const cellId = await createCell(env, spec, role);
        const instance = await env.CODE_CELL_WORKFLOW.create({ params: { cell_id: cellId, spec } });
        return text(`Created CodeCell #${cellId}, started workflow instance ${instance.id}.`);
      } catch (e) {
        return text(`Error creating CodeCell: ${e}`);
      }
    },
  );

  server.registerTool(
    "cell_resume",
    {
      description:
        "Section 5b/5c generic resume query: the highest-priority non-terminal CodeCell to pick up " +
        "next (stale locks -- untouched >10 min -- prioritized over fresh ones). Pass cell_id to look " +
        "up one specific cell instead.",
      inputSchema: { cell_id: z.number().int().optional() },
    },
    async ({ cell_id }) => {
      try {
        const row = cell_id !== undefined ? await getCell(env, cell_id) : await resumeCandidate(env);
        return text(row ? JSON.stringify(row, null, 2) : "No non-terminal CodeCells found.");
      } catch (e) {
        return text(`Error resuming: ${e}`);
      }
    },
  );

  server.registerTool(
    "checkpoint_write",
    {
      description:
        "Write a checkpoint row for a CodeCell (Section 5c). `rationale` is required (min 10 chars) -- " +
        "a checkpoint without a real 'why' looks resumable but tells the next session nothing.",
      inputSchema: {
        cell_id: z.number().int(),
        phase: z.string().describe("mirrors the CodeCell's status at write time"),
        session_id: z.string(),
        artifact: z.string().optional().describe("partial code/notes as they currently stand"),
        next_action: z.string().optional().describe("the exact next concrete step, not a vague summary"),
        rationale: z.string().min(10).describe("the 'why' that isn't recoverable from the artifact alone"),
      },
    },
    async ({ cell_id, phase, session_id, artifact, next_action, rationale }) => {
      try {
        await writeCheckpoint(env, { cellId: cell_id, phase, sessionId: session_id, artifact, nextAction: next_action, rationale });
        return text(`Checkpoint written for CodeCell #${cell_id}.`);
      } catch (e) {
        return text(`Error writing checkpoint: ${e}`);
      }
    },
  );

```

## auth.ts

Insert right after the existing `/`/`/health` block:

```ts
    // Section 4 step 6 callback: test.yml's last step (scripts/run_heavy_worker.py)
    // posts the actual pass/fail + log here once the Ubuntu runner finishes.
    // This resolves CodeCellWorkflow's step.waitForEvent("heavy-worker-result")
    // (code_cell_workflow.ts). Separate machine-to-machine secret rather than
    // MCP_AUTH_TOKEN, which gates the human /authorize consent screen and
    // shouldn't be handed to a CI runner.
    if (url.pathname === "/webhook/heavy-worker-result" && request.method === "POST") {
      if (!env.HEAVY_WORKER_CALLBACK_TOKEN) {
        return new Response("Server misconfigured: HEAVY_WORKER_CALLBACK_TOKEN not set.", { status: 500 });
      }
      const auth = request.headers.get("Authorization") || "";
      if (auth !== `Bearer ${env.HEAVY_WORKER_CALLBACK_TOKEN}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      let body: { workflow_instance_id?: string; passed?: boolean; log?: string };
      try {
        body = await request.json();
      } catch {
        return new Response("Malformed JSON body.", { status: 400 });
      }
      if (!body.workflow_instance_id) {
        return new Response("workflow_instance_id required.", { status: 400 });
      }
      try {
        const instance = await env.CODE_CELL_WORKFLOW.get(body.workflow_instance_id);
        await instance.sendEvent({
          type: "heavy-worker-result",
          payload: { passed: !!body.passed, log: body.log || "" },
        });
        return new Response("ok\n", { status: 200 });
      } catch (e) {
        return new Response(`Error resolving workflow instance: ${e}`, { status: 500 });
      }
    }

```

## wrangler.toml

Add after the existing `[[migrations]]` block:

```toml
# CodeCellWorkflow (code_cell_workflow.ts): Section 4f's durable per-cell
# pipeline (Fast Worker -> Heavy Worker -> tag -> notify). Triggered via
# the cell_create MCP tool; resumed by /webhook/heavy-worker-result
# (auth.ts) via step.waitForEvent.
[[workflows]]
binding = "CODE_CELL_WORKFLOW"
name = "turso-github-mcp-code-cell-workflow"
class_name = "CodeCellWorkflow"
```

Then set three new secrets:
```bash
wrangler secret put HEAVY_WORKER_REPO           # e.g. abbashaji/ondine
wrangler secret put HEAVY_WORKER_CALLBACK_TOKEN # openssl rand -hex 32
wrangler secret put DISCORD_ALERT_CHANNEL_ID    # optional; skips Discord alerts if unset
```

Redeploy: `wrangler deploy`.

## Also update the Heavy Worker's repo secrets (in `abbashaji/ondine`)

`GATEWAY_URL` → this Worker's own URL (`https://turso-github-mcp.<subdomain>.workers.dev`), not the old `ondine-gateway`.
Rename `GATEWAY_BEARER_TOKEN` → `HEAVY_WORKER_CALLBACK_TOKEN`, same value as the Worker secret above.
