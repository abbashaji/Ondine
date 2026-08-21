-- Ondine: Zero-Cost Enterprise Serverless Stack
-- Turso schema — see Sections 4a, 4c, 5, 5b of Zero-Cost-Stack-v11.md

CREATE TABLE code_cells (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'Pending'
    CHECK (status IN (
      'Pending','Processing_Planned','Processing_Drafting','Processing_SelfTested',
      'Code_Ready','Testing','Failed','Completed','Dead_Letter'
    )),
  role TEXT NOT NULL DEFAULT 'Architect',
  spec TEXT NOT NULL,
  code TEXT,
  provider TEXT,        -- e.g. groq, gemini-3.5-flash-lite, gemma-4-26b (Section 4b)
  provider_tier TEXT,   -- primary/secondary/tertiary/quaternary/floor
  tag TEXT,             -- pre-filter tag from Gemma 4 31B (Section 4c)
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  retry_after TEXT,
  locked_by TEXT,        -- session/context identifier (Section 5)
  locked_at TEXT,         -- for stale-lock recovery, >10min silence (Section 5b)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_cells_status ON code_cells(status);

-- Section 5b: checkpoint-based resumability, two-phase commit pattern.
-- A resuming context reads the last row with draft_committed = 1 for a given cell_id.
CREATE TABLE checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cell_id INTEGER NOT NULL REFERENCES code_cells(id),
  phase TEXT NOT NULL,             -- mirrors code_cells.status at write time
  session_id TEXT NOT NULL,
  artifact TEXT,                   -- partial code/notes as they currently stand
  next_action TEXT,                -- the exact next concrete step, not a vague summary
  decision_notes TEXT,             -- the "why" that isn't recoverable from the artifact alone
  draft_committed INTEGER NOT NULL DEFAULT 0,
  checkpoint_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_checkpoints_cell ON checkpoints(cell_id, created_at);

-- Section 5: supplementary free-text project note, not the primary resumability mechanism.
CREATE TABLE project_state (
  key TEXT PRIMARY KEY,
  note TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
