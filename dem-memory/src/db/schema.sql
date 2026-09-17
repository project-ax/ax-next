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
    confidence REAL DEFAULT 1.0 CHECK(confidence >= 0.0 AND confidence <= 1.0),
    valid_start TEXT NOT NULL,                         -- ISO-8601 UTC timestamp
    valid_end TEXT DEFAULT '9999-12-31T23:59:59.999Z',  -- ISO-8601 UTC timestamp
    transaction_time TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Fast indices for temporal validity checking and entity lookups
CREATE INDEX IF NOT EXISTS idx_memories_lookup ON memories(bank_id, network, valid_end);
CREATE INDEX IF NOT EXISTS idx_memories_temporal ON memories(valid_start, valid_end);
CREATE INDEX IF NOT EXISTS idx_memories_entity ON memories(bank_id, subject, predicate);

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
