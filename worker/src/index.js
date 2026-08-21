/**
 * Ondine — Cloudflare Worker Gateway + CodeCellWorkflow
 * Implements Zero-Cost-Stack-v11.md Section 6 (Zero-Trust gateway),
 * Section 6a (collapsed search/execute MCP surface), and
 * Section 4f (durable event loop on Cloudflare Workflows).
 *
 * Deploy: wrangler deploy (after `wrangler secret put` for each secret below)
 * Bindings required (wrangler.toml):
 *   - Workflow binding: CODE_CELL_WORKFLOW -> class CodeCellWorkflow
 *   - Secrets: MCP_BEARER_TOKEN, TURSO_DATABASE_URL, TURSO_AUTH_TOKEN,
 *              GROQ_API_KEY, GEMINI_API_KEY, GITHUB_TOKEN, GITHUB_REPO,
 *              DISCORD_WEBHOOK_URL, POSTHOG_API_KEY (optional)
 */

import { WorkflowEntrypoint } from "cloudflare:workers";

// ---------------------------------------------------------------------------
// Section 6: Zero-Trust hardening — Bearer auth on every inbound request.
// (HMAC verification of the Upstash-Signature header belongs on the
// QStash-facing route specifically; see verifyQStashSignature below.)
// ---------------------------------------------------------------------------
function requireBearer(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const expected = `Bearer ${env.MCP_BEARER_TOKEN}`;
  if (auth !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

async function verifyQStashSignature(request, env) {
  // Placeholder: verify the `Upstash-Signature` header per Section 6.1.
  // Left explicit rather than silently permissive — wire up
  // @upstash/qstash's Receiver.verify() here before relying on this route.
  const sig = request.headers.get("Upstash-Signature");
  if (!sig) return false;
  return true; // TODO: real HMAC check before production use
}

// ---------------------------------------------------------------------------
// Turso HTTP API helpers (libSQL over HTTP) — the shared task table (4f).
// ---------------------------------------------------------------------------
async function tursoExec(env, sql, args = []) {
  const resp = await fetch(`${env.TURSO_DATABASE_URL.replace("libsql://", "https://")}/v2/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.TURSO_AUTH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requests: [
        { type: "execute", stmt: { sql, args: args.map((a) => ({ type: "text", value: String(a) })) } },
        { type: "close" },
      ],
    }),
  });
  if (!resp.ok) throw new Error(`Turso error ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

// ---------------------------------------------------------------------------
// Section 4b: Fast Worker cascade — Groq primary, tiered Gemini/Gemma fallback.
// ---------------------------------------------------------------------------
async function generateCode(env, cell) {
  const tiers = [
    { name: "groq", call: () => callGroq(env, cell) },
    { name: "gemini-3.5-flash-lite", call: () => callGemini(env, cell, "gemini-3.5-flash-lite") },
    { name: "gemini-3.1-flash-lite", call: () => callGemini(env, cell, "gemini-3.1-flash-lite") },
    { name: "gemini-2.5-flash-lite", call: () => callGemini(env, cell, "gemini-2.5-flash-lite") },
    { name: "gemma-4-26b", call: () => callGemini(env, cell, "gemma-4-26b") },
  ];
  let lastErr;
  for (const tier of tiers) {
    try {
      const code = await tier.call();
      return { code, provider: tier.name };
    } catch (e) {
      lastErr = `${tier.name}: ${e.message}`;
    }
  }
  throw new Error(`All Fast Worker tiers exhausted. Last: ${lastErr}`);
}

async function callGroq(env, cell) {
  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: cell.spec }],
    }),
  });
  if (!resp.ok) throw new Error(`Groq ${resp.status}`);
  const data = await resp.json();
  return data.choices[0].message.content;
}

async function callGemini(env, cell, model) {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: cell.spec }] }] }),
    }
  );
  if (!resp.ok) throw new Error(`Gemini(${model}) ${resp.status}`);
  const data = await resp.json();
  return data.candidates[0].content.parts[0].text;
}

// ---------------------------------------------------------------------------
// Section 4, step 6: Heavy Worker handoff to GitHub Actions.
// This only fires the workflow_dispatch. The actual pass/fail result comes
// back asynchronously via POST /webhook/heavy-worker-result (see test.yml's
// last step), which the run() loop below picks up with step.waitForEvent —
// a real durable wait, not a synchronous block inside step.do().
// ---------------------------------------------------------------------------
async function dispatchHeavyWorker(env, cellId, workflowInstanceId, code) {
  await tursoExec(env, "UPDATE code_cells SET code = ?, status = 'Testing', updated_at = datetime('now') WHERE id = ?", [code, cellId]);
  const resp = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/test.yml/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ref: "main",
      inputs: { cell_id: String(cellId), workflow_instance_id: String(workflowInstanceId) },
    }),
  });
  if (!resp.ok && resp.status !== 204) throw new Error(`GitHub dispatch ${resp.status}: ${await resp.text()}`);
  return { dispatched: true };
}

// ---------------------------------------------------------------------------
// Section 4c: Pre-filter tagging — Gemma 4 31B, dedicated quota bucket,
// constrained with response_schema (Section 4e) so the tag is always one
// of a fixed enum rather than free text to parse.
// ---------------------------------------------------------------------------
async function tagWithGemma(env, cellId, result) {
  if (result.passed) {
    await tursoExec(env, "UPDATE code_cells SET status = 'Completed', tag = 'passed', last_error = NULL, updated_at = datetime('now') WHERE id = ?", [cellId]);
    return "passed";
  }

  let tag = "needs_human";
  let reason = "classification unavailable, defaulting to human review";
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemma-4-31b:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `Classify this Heavy Worker test failure log:\n\n${(result.log || "").slice(0, 4000)}` }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                tag: { type: "STRING", enum: ["known_flake_pattern", "needs_human"] },
                reason: { type: "STRING" },
              },
              required: ["tag", "reason"],
            },
          },
        }),
      }
    );
    if (resp.ok) {
      const data = await resp.json();
      const parsed = JSON.parse(data.candidates[0].content.parts[0].text);
      tag = parsed.tag;
      reason = parsed.reason;
    }
  } catch (e) {
    // Non-overlap rule (4c): tagging failure defaults to needs_human, never to
    // silently suppressing an alert — the safe direction to fail in.
  }

  const retryQuery = await tursoExec(env, "SELECT retry_count FROM code_cells WHERE id = ?", [cellId]);
  const currentRetries = Number(retryQuery?.results?.[0]?.response?.result?.rows?.[0]?.[0]?.value ?? 0);
  const nextRetries = currentRetries + 1;
  const status = nextRetries > 3 ? "Dead_Letter" : "Failed";

  await tursoExec(
    env,
    "UPDATE code_cells SET status = ?, tag = ?, last_error = ?, retry_count = ?, updated_at = datetime('now') WHERE id = ?",
    [status, tag, `${reason}\n\n${result.log || ""}`.slice(0, 4000), nextRetries, cellId]
  );
  return status === "Dead_Letter" ? "dead_letter" : tag;
}

// ---------------------------------------------------------------------------
// Section 4, step 7 / Section 8 / Section 10: notify Discord + PostHog.
// "Urgent" routing (4 step 8): needs_human / dead_letter go straight to
// Discord; known_flake_pattern still gets logged to PostHog but is left for
// the batched Reviewer digest (Section 3b) rather than an immediate alert.
// ---------------------------------------------------------------------------
async function notifyDiscordAndPostHog(env, cellId, tag) {
  const urgent = tag === "needs_human" || tag === "dead_letter";
  if (urgent && env.DISCORD_WEBHOOK_URL) {
    await fetch(env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `⚠️ CodeCell #${cellId} — \`${tag}\`, needs a look.` }),
    });
  }
  if (env.POSTHOG_API_KEY) {
    await fetch("https://us.i.posthog.com/capture/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: env.POSTHOG_API_KEY,
        event: "code_cell_tagged",
        properties: { cell_id: cellId, tag, urgent },
        distinct_id: "ondine-pipeline",
      }),
    });
  }
}

// ---------------------------------------------------------------------------
// Section 4f: one Workflow instance per CodeCell.
// ---------------------------------------------------------------------------
export class CodeCellWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { cell_id, spec } = event.payload;
    const cell = { id: cell_id, spec };
    const instanceId = event.instanceId;

    try {
      const draft = await step.do("fast-worker-generate", async () => {
        return await generateCode(this.env, cell);
      });

      await step.do("persist-code-ready", async () => {
        await tursoExec(this.env, "UPDATE code_cells SET code = ?, provider = ?, status = 'Code_Ready', updated_at = datetime('now') WHERE id = ?", [draft.code, draft.provider, cell_id]);
      });

      await step.do("heavy-worker-dispatch", async () => {
        return await dispatchHeavyWorker(this.env, cell_id, instanceId, draft.code);
      });

      // Durable wait for test.yml's callback — survives a Worker restart
      // between dispatch and result, unlike a synchronous poll would.
      const testEvent = await step.waitForEvent("heavy-worker-result", {
        type: "heavy-worker-result",
        timeout: "30 minutes",
      });

      const tag = await step.do("tag-result", async () => {
        return await tagWithGemma(this.env, cell_id, testEvent.payload);
      });

      await step.do("notify", async () => {
        return await notifyDiscordAndPostHog(this.env, cell_id, tag);
      });
    } catch (err) {
      // Terminal failure (retry budget exhausted, or waitForEvent timed out
      // because the Heavy Worker never called back) — Section 4a's Dead_Letter
      // path, expressed as this Workflow's own failure handling (Section 4f).
      await step.do("dead-letter", async () => {
        await tursoExec(
          this.env,
          "UPDATE code_cells SET status = 'Dead_Letter', last_error = ?, updated_at = datetime('now') WHERE id = ?",
          [String(err.message || err).slice(0, 4000), cell_id]
        );
        await notifyDiscordAndPostHog(this.env, cell_id, "dead_letter");
      });
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Section 6a: collapsed search/execute MCP surface (token-budget optimization,
// not a security boundary — Bearer auth above still gates everything).
// ---------------------------------------------------------------------------
const API_SPEC_SUMMARY = [
  { op: "create_cell", desc: "Insert a new Pending CodeCell and start its Workflow instance." },
  { op: "read_state", desc: "Query code_cells / checkpoints for current status." },
  { op: "resume", desc: "Section 5b/5c generic resume query: non-terminal cells, stale-locks first." },
  { op: "checkpoint_write", desc: "Write a checkpoint row; rationale field is required (5c)." },
];

async function handleSearch(body) {
  const q = (body.query || "").toLowerCase();
  const hits = API_SPEC_SUMMARY.filter((o) => o.op.includes(q) || o.desc.toLowerCase().includes(q));
  return Response.json({ results: hits.length ? hits : API_SPEC_SUMMARY });
}

async function handleExecute(request, env, body) {
  switch (body.op) {
    case "create_cell": {
      if (!body.spec) return Response.json({ error: "spec required" }, { status: 400 });
      const res = await tursoExec(env, "INSERT INTO code_cells (spec, role) VALUES (?, ?) RETURNING id", [body.spec, body.role || "Architect"]);
      const cellId = res?.results?.[0]?.response?.result?.rows?.[0]?.[0]?.value;
      const instance = await env.CODE_CELL_WORKFLOW.create({ params: { cell_id: cellId, spec: body.spec } });
      return Response.json({ cell_id: cellId, workflow_instance_id: instance.id });
    }
    case "resume": {
      const res = await tursoExec(
        env,
        `SELECT id, status, locked_by, locked_at FROM code_cells
         WHERE status NOT IN ('Completed','Dead_Letter')
         ORDER BY (locked_by IS NOT NULL AND locked_at < datetime('now','-10 minutes')) DESC, updated_at ASC
         LIMIT 1`
      );
      return Response.json(res);
    }
    case "checkpoint_write": {
      const { cell_id, phase, session_id, artifact, next_action, rationale } = body;
      if (!rationale || rationale.trim().length < 10) {
        return Response.json({ error: "rationale is required (min 10 chars) — Section 5c" }, { status: 400 });
      }
      await tursoExec(
        env,
        "INSERT INTO checkpoints (cell_id, phase, session_id, artifact, next_action, decision_notes, draft_committed) VALUES (?, ?, ?, ?, ?, ?, 1)",
        [cell_id, phase, session_id, artifact || "", next_action || "", rationale]
      );
      return Response.json({ ok: true });
    }
    default:
      return Response.json({ error: `unknown op: ${body.op}` }, { status: 400 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/webhook/qstash") {
      const ok = await verifyQStashSignature(request, env);
      if (!ok) return new Response("bad signature", { status: 401 });
      // route to the relevant provider call; pacing already applied by QStash upstream.
      return new Response("ok");
    }

    const unauthorized = requireBearer(request, env);
    if (unauthorized) return unauthorized;

    // Section 4, step 6 callback: test.yml's last step posts the actual
    // pass/fail + log here once the Ubuntu runner finishes, which is what
    // resolves the CodeCellWorkflow's waitForEvent("heavy-worker-result").
    if (url.pathname === "/webhook/heavy-worker-result" && request.method === "POST") {
      const { workflow_instance_id, passed, log } = await request.json();
      if (!workflow_instance_id) {
        return Response.json({ error: "workflow_instance_id required" }, { status: 400 });
      }
      const instance = await env.CODE_CELL_WORKFLOW.get(workflow_instance_id);
      await instance.sendEvent({ type: "heavy-worker-result", payload: { passed: !!passed, log: log || "" } });
      return Response.json({ ok: true });
    }

    if (url.pathname === "/mcp/search" && request.method === "POST") {
      return handleSearch(await request.json());
    }
    if (url.pathname === "/mcp/execute" && request.method === "POST") {
      return handleExecute(request, env, await request.json());
    }
    return new Response("Ondine gateway: POST /mcp/search or /mcp/execute", { status: 200 });
  },
};
