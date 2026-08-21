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
// ---------------------------------------------------------------------------
async function runHeadlessTests(env, cellId, code) {
  await tursoExec(env, "UPDATE code_cells SET code = ?, status = 'Testing', updated_at = datetime('now') WHERE id = ?", [code, cellId]);
  const resp = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/test.yml/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: "main", inputs: { cell_id: String(cellId) } }),
  });
  if (!resp.ok && resp.status !== 204) throw new Error(`GitHub dispatch ${resp.status}`);
  // Actual pass/fail lands back via the Heavy Worker's own callback to /webhook/heavy-worker-result;
  // Workflows' step.do() here represents the dispatch itself, not a synchronous wait.
  return { dispatched: true };
}

// ---------------------------------------------------------------------------
// Section 4c: Pre-filter tagging — Gemma 4 31B, dedicated quota bucket.
// ---------------------------------------------------------------------------
async function tagWithGemma(env, cellId, testResult) {
  const tag = testResult.dispatched ? "pending_result" : "needs_human"; // refined once the real result lands
  await tursoExec(env, "UPDATE code_cells SET tag = ?, updated_at = datetime('now') WHERE id = ?", [tag, cellId]);
  return tag;
}

// ---------------------------------------------------------------------------
// Section 4, step 7 / Section 10: notify Discord + PostHog.
// ---------------------------------------------------------------------------
async function notifyDiscordAndPostHog(env, cellId, tag) {
  if (env.DISCORD_WEBHOOK_URL) {
    await fetch(env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `CodeCell #${cellId} tagged \`${tag}\`` }),
    });
  }
  if (env.POSTHOG_API_KEY) {
    await fetch("https://us.i.posthog.com/capture/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: env.POSTHOG_API_KEY,
        event: "code_cell_tagged",
        properties: { cell_id: cellId, tag },
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

    const draft = await step.do("fast-worker-generate", async () => {
      return await generateCode(this.env, cell);
    });

    await step.do("persist-code-ready", async () => {
      await tursoExec(this.env, "UPDATE code_cells SET code = ?, provider = ?, status = 'Code_Ready', updated_at = datetime('now') WHERE id = ?", [draft.code, draft.provider, cell_id]);
    });

    const testResult = await step.do("heavy-worker-test", async () => {
      return await runHeadlessTests(this.env, cell_id, draft.code);
    });

    const tag = await step.do("tag-result", async () => {
      return await tagWithGemma(this.env, cell_id, testResult);
    });

    await step.do("notify", async () => {
      return await notifyDiscordAndPostHog(this.env, cell_id, tag);
    });
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

    if (url.pathname === "/mcp/search" && request.method === "POST") {
      return handleSearch(await request.json());
    }
    if (url.pathname === "/mcp/execute" && request.method === "POST") {
      return handleExecute(request, env, await request.json());
    }
    return new Response("Ondine gateway: POST /mcp/search or /mcp/execute", { status: 200 });
  },
};
