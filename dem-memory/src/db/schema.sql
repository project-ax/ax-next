-- Core relational storage preserving epistemic typing and bi-temporal bounds
CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    bank_id TEXT NOT NULL,
    network TEXT NOT NULL CHECK(network IN ('world', 'experience', 'observation', 'opinion')),
    subject TEXT NOT NULL,
    predicate TEXT NOT NULL,
    object TEXT NOT NULL,
    -- Verbatim slice of the dialogue this fact was extracted from. Extraction is lossy and
    -- terminal; this is the only way a detail the extractor compressed away can still reach
    -- the answerer. NULL when no turn matched well enough to claim provenance.
    source_chunk TEXT,
    valid_start TEXT NOT NULL,                         -- ISO-8601 UTC timestamp
    valid_end TEXT DEFAULT '9999-12-31T23:59:59.999Z',  -- ISO-8601 UTC timestamp
    transaction_time TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- DERIVED from `predicate` by the slot normalizer (src/slots.ts), and the key supersession
    -- matches on. NULL means "no slot", which means this row never closes anything and is
    -- never closed by a slot rule -- the safe default, and the state most rows are in.
    -- Stored rather than computed at read time so the closure can be a single indexed UPDATE;
    -- it is derived, so changing the normalizer means recomputing the column, not a migration.
    slot TEXT,
    -- Who asserted this. Ordered `human > agent > extracted`: a row is only ever closed by a
    -- row of equal-or-higher provenance, so a person's correction survives the next time the
    -- extractor sees the old value in a transcript.
    provenance TEXT NOT NULL DEFAULT 'extracted'
        CHECK(provenance IN ('extracted', 'agent', 'human')),
    -- The row that closed this one, for audit and for reversal. NULL on an active row, and
    -- also NULL for an explicit delete, which is how "superseded" is told from "forgotten".
    closed_by TEXT
);

-- Fast indices for temporal validity checking and entity lookups
CREATE INDEX IF NOT EXISTS idx_memories_lookup ON memories(bank_id, network, valid_end);
CREATE INDEX IF NOT EXISTS idx_memories_temporal ON memories(valid_start, valid_end);
CREATE INDEX IF NOT EXISTS idx_memories_entity ON memories(bank_id, subject, predicate);
-- The slot closure's only lookup: the active rows of one (bank, subject, slot).
CREATE INDEX IF NOT EXISTS idx_memories_slot ON memories(bank_id, subject, slot, valid_end);

-- Full-Text Search index for BM25 keyword matching
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    id UNINDEXED,
    subject,
    predicate,
    object,
    tokenize = 'porter unicode61'
);

-- sqlite-vec virtual table for cosine vector search (384 dimensions for bge-small)
CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
    id TEXT PRIMARY KEY,
    embedding float[384]
);
