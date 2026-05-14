# Comprehensive Comparison of Agent Memory Models & A Unified Proposal

---

## Understanding the Landscape

Before diving into individual models, it's critical to recognize that these eight systems are **not all the same kind of thing**. They fall into distinct categories:

| Category | Models | What they solve |
|---|---|---|
| **Tiered Memory Models** | Letta, Hermes | Defining hot vs. cold memory explicitly |
| **Atomic Memory / Fact Extraction** | MemU, Mastra Observational Memory, Supermemory | Turning interactions into compact retrieval units |
| **Canonical Knowledge-Base Models** | LLM Wiki | Treating memory as editable, interlinked documents |
| **Retrieval Models** | Hybrid RAG | How to search memory accurately |
| **Framework Abstractions** | Project AX Cortex | How memory plugs into an agent runtime |

No single category is sufficient. The ideal system must draw from all five.

---

## Model-by-Model Analysis

### 1. Letta (formerly MemGPT)

**Core Metaphor:** Operating-system virtual memory

Letta treats the LLM context window like RAM and everything else like disk. The agent *itself* manages memory through tool calls.

```
┌─────────────────────────────────┐
│  CONTEXT WINDOW                 │
│  ┌───────────┐ ┌─────────────┐ │
│  │ Core Mem  │ │ System Msg  │ │
│  │ (human)   │ │ (persona)   │ │
│  └───────────┘ └─────────────┘ │
│  ┌───────────────────────────┐  │
│  │ Recent Message Buffer     │  │
│  └───────────────────────────┘  │
├─────────────────────────────────┤
│  TOOLS (LLM-invoked)           │
│  • core_memory_append           │
│  • core_memory_replace          │
│  • archival_memory_insert       │
│  • archival_memory_search       │
│  • conversation_search          │
├─────────────────────────────────┤
│  EXTERNAL STORAGE               │
│  ┌─────────────┐ ┌───────────┐ │
│  │ Recall Mem  │ │ Archival  │ │
│  │ (conv hist) │ │ (long-trm)│ │
│  │ (DB+search) │ │ (vectors) │ │
│  └─────────────┘ └───────────┘ │
└─────────────────────────────────┘
```

**Key Properties:**
- **Write strategy:** Agent decides when/what to save via explicit tool calls
- **Retrieval:** Agent-initiated search (embedding-based for archival, text search for recall)
- **Context management:** Core memory is always in-context (~few KB); everything else is paged in on demand
- **Update model:** Agent overwrites/appends to core memory blocks; archival is append-mostly
- **Scalability:** Archival can be backed by a vector DB and grow large; core memory is fixed-size

**Strengths:** The clearest hot/cold split of any model. Elegant abstraction. Agent has full autonomy over memory management. Handles context overflow gracefully. Mature and well-tested.
**Weaknesses:** Requires the LLM to learn memory management discipline. Extra tool-call latency. Memory quality depends entirely on the model's judgment. Complex to implement correctly. Not inherently markdown-native.

**Best idea to steal:** Explicit hot/core vs. archival memory with always-in-context core memory.

---

### 2. MemU (Memory Units)

**Core Metaphor:** Atomic fact database

MemU decomposes all information into **atomic memory units**—small, self-contained factual statements, each independently embeddable and retrievable.

```
Conversation → Extraction LLM → Atomic Units
                                      │
                                      ▼
                               ┌──────────────┐
                               │  Memory Unit  │
                               │  ─────────    │
                               │  fact: "..."  │
                               │  source: ref  │
                               │  confidence:  │
                               │  timestamp:   │
                               │  embedding:   │
                               │  supersedes:  │
                               └──────────────┘
                                      │
                          ┌───────────┼───────────┐
                          ▼           ▼           ▼
                     Dedup Engine  Conflict    Decay
                                  Resolution  Function
```

**Key Properties:**
- **Write strategy:** Automated extraction after each interaction; LLM parses conversation into atomic facts
- **Retrieval:** Embedding similarity search over units; optionally filtered by metadata
- **Context management:** Only relevant units pulled into context; extremely granular
- **Update model:** New units can supersede old ones; confidence scores decay over time; deduplication merges equivalent facts
- **Scalability:** Scales well—units are small and indexable; dedup keeps volume manageable

**Strengths:** Extremely granular. Easy to update/delete individual facts. Dedup prevents bloat. Good for precise factual recall. Better signal-to-noise ratio than raw conversation retrieval.
**Weaknesses:** Loses narrative context (fragmented). Extraction quality varies. No inherent organizational structure. Relationships between facts are implicit. Not ideal as the sole representation for rich documents.

**Best idea to steal:** Atomic memory units with deduplication and supersession for conflict resolution.

---

### 3. Mastra Observational Memory

**Core Metaphor:** Passive human-like observation

Rather than requiring the agent to explicitly manage memory, Mastra uses a background **memory processor** that watches conversations and automatically extracts observations.

```
Conversation Stream
        │
        ▼ (background process)
┌───────────────────┐
│ Observation Engine │ ← LLM extracts noteworthy facts
└────────┬──────────┘
         │
         ▼
┌─────────────────────────────────────┐
│  Working Memory (ephemeral/session) │
│  • Current session observations     │
│  • Active context entities          │
│  • Rolling summary                  │
├─────────────────────────────────────┤
│  Long-Term Memory (persistent)      │
│  • Observations with embeddings     │
│  • Entity profiles                  │
│  • Consolidated knowledge           │
└─────────────────────────────────────┘
         │
         ▼ (on retrieval)
   Semantic Search → Inject into prompt
```

**Key Properties:**
- **Write strategy:** Automatic/passive—the memory processor runs after interactions without agent involvement
- **Retrieval:** Semantic search over observations; working memory is always available
- **Context management:** Working memory acts as a scratchpad; long-term is search-on-demand
- **Update model:** New observations can update or contradict existing ones; entity profiles evolve

**Strengths:** Zero cognitive load on the agent. Captures things the agent might forget to save. Clean separation of concerns. Very simple, practical, and lightweight. Works particularly well for preferences, decisions, commitments, deadlines.
**Weaknesses:** Background LLM calls add cost. Less agent control over what's stored. Not a full knowledge system for documents. Can create many tiny records unless consolidated.

**Best idea to steal:** Observations are a great default write format—passive extraction removes memory management burden from the agent.

---

### 4. LLM Wiki

**Core Metaphor:** Wikipedia for the agent

Memory is organized as a **wiki**—interconnected pages of structured knowledge that the agent can browse, search, create, and edit.

```
┌─────────────────────────────────────────┐
│              WIKI GRAPH                  │
│                                          │
│   ┌──────────┐    ┌──────────────┐      │
│   │ Project  │───→│ John Doe     │      │
│   │ Alpha    │    │ (person)     │      │
│   │ [page]   │    │ [page]       │      │
│   └────┬─────┘    └──────┬───────┘      │
│        │                 │               │
│        ▼                 ▼               │
│   ┌──────────┐    ┌──────────────┐      │
│   │ Sprint 4 │    │ Frontend     │      │
│   │ [page]   │    │ Team [page]  │      │
│   └──────────┘    └──────────────┘      │
│                                          │
│   Navigation: links, categories, search  │
└─────────────────────────────────────────┘
```

**Key Properties:**
- **Write strategy:** Agent creates/edits pages through tools; optionally auto-generated
- **Retrieval:** By title (exact), by link traversal, by full-text search, by category listing
- **Context management:** Only requested pages loaded into context; table-of-contents serves as a lightweight index
- **Update model:** Pages are edited in-place; revision history optional; cross-references maintain coherence

**Strengths:** Extremely human-readable. Natural organization. Supports both structured and unstructured content. Navigable. Markdown-friendly. Great for knowledge-heavy domains. Scales naturally to thousands of documents. Git-friendly. Fits Obsidian-style workflows. Naturally exploits the LLM's training on web navigation and markdown syntax.
**Weaknesses:** Requires the agent to know what page to look up (or search effectively). Can develop stale/contradictory pages. Cross-references need maintenance. Writes are heavier (full page edits vs. atomic updates). Needs indexing/chunking/summaries to work well at scale.

**Best idea to steal:** Markdown documents should be the canonical long-term memory.

---

### 5. Hermes

**Core Metaphor:** Categorized memory with structured working memory

Hermes structures memory into typed, categorized stores with explicit schemas for different kinds of information. It also relies on a `<scratchpad>` or structured XML space in the hot context for temporary reasoning.

```
┌──────────────────────────────────────┐
│          MEMORY CATEGORIES            │
│                                       │
│  ┌─────────────┐  ┌───────────────┐  │
│  │ Episodic    │  │ Semantic      │  │
│  │ (events/    │  │ (facts/       │  │
│  │  sessions)  │  │  knowledge)   │  │
│  └─────────────┘  └───────────────┘  │
│  ┌─────────────┐  ┌───────────────┐  │
│  │ Procedural  │  │ User Model    │  │
│  │ (how-to/    │  │ (preferences/ │  │
│  │  workflows) │  │  profile)     │  │
│  └─────────────┘  └───────────────┘  │
│                                       │
│  Hierarchical summaries at multiple   │
│  time scales for compression          │
│                                       │
│  <scratchpad> for hot reasoning       │
└──────────────────────────────────────┘
```

**Key Properties:**
- **Write strategy:** Memory is routed to the appropriate category based on content type
- **Retrieval:** Category-specific (recent-first for episodic, relevance-first for semantic); hierarchical summaries allow retrieving the smallest abstraction that answers the question
- **Context management:** Each category contributes a token budget; scratchpad handles temporary reasoning
- **Update model:** Category-specific rules (user model is overwritten; episodic is append-only)

**Strengths:** Clean taxonomy. Different retrieval strategies per type. Mirrors human memory models. Excellent for long-horizon context compression. XML scratchpad is incredibly simple to implement and keeps the agent focused.
**Weaknesses:** Categorization can be ambiguous. Rigid schemas may not fit all data. Summary drift is a real problem. More upfront design needed. Scratchpad alone only handles "hot" memory with no native cold retrieval mechanism.

**Best ideas to steal:** Hierarchical summaries (retrieve the smallest abstraction that answers the question) and a dedicated scratchpad for temporary reasoning in hot memory.

---

### 6. Project AX Cortex

**Core Metaphor:** Pluggable brain cortex

Cortex is AX's modular memory provider—it abstracts memory behind a clean provider interface, allowing different backends and strategies to be swapped.

```
┌─────────────────────────────────┐
│       CORTEX PROVIDER           │
│                                  │
│  ┌────────────────────────┐     │
│  │ Memory Interface       │     │
│  │ • store(key, value)    │     │
│  │ • retrieve(query)      │     │
│  │ • update(key, value)   │     │
│  │ • delete(key)          │     │
│  │ • search(semantic)     │     │
│  └──────────┬─────────────┘     │
│             │                    │
│  ┌──────────▼─────────────┐     │
│  │ Storage Backend        │     │
│  │ (pluggable: vector DB, │     │
│  │  file system, KV store)│     │
│  └────────────────────────┘     │
│                                  │
│  Features:                       │
│  • Embedding generation          │
│  • Chunking strategies           │
│  • Metadata filtering            │
│  • TTL / expiration              │
└─────────────────────────────────┘
```

**Key Properties:**
- **Write strategy:** Explicit store/update via API; handles chunking and embedding internally
- **Retrieval:** Semantic search with metadata filters; key-based lookup
- **Context management:** Returns ranked results; consumer decides how much to include
- **Update model:** Key-value update semantics; supports TTL for auto-expiration

**Strengths:** Clean abstraction. Backend-agnostic. Easy to integrate. Composable with other providers. Modularity makes testing easy. Good developer ergonomics. Lets you swap storage backends freely.
**Weaknesses:** More of an implementation pattern than a full theory. Abstraction may hide important details. Doesn't itself solve consolidation strategy, write/retrieve/promotion rules, or canonical truth definition.

**Best idea to steal:** Separate the memory interface from the memory strategy—clean provider boundaries.

---

### 7. Supermemory

**Core Metaphor:** Personal knowledge vault / "Second brain"

Supermemory is designed as a second brain—focused on ingesting information from many sources and making it retrievable via AI.

```
┌───────────────────────────────────────┐
│            INGESTION                   │
│  ┌─────────┐ ┌──────┐ ┌───────────┐  │
│  │Bookmarks│ │Tweets│ │ Documents │  │
│  └────┬────┘ └──┬───┘ └─────┬─────┘  │
│       └────────┬┼───────────┘         │
│                ▼▼                      │
│       ┌────────────────┐               │
│       │ Processing     │               │
│       │ • Parse        │               │
│       │ • Chunk        │               │
│       │ • Embed        │               │
│       │ • Tag/Classify │               │
│       └───────┬────────┘               │
│               ▼                        │
│  ┌──────────────────────────┐          │
│  │  Vector Store + Metadata │          │
│  │  (Searchable Archive)    │          │
│  └──────────────────────────┘          │
└───────────────────────────────────────┘
```

**Key Properties:**
- **Write strategy:** Multi-source ingestion pipeline; automated parsing/chunking/embedding
- **Retrieval:** Vector search with optional filters (source, date, tags); scoped APIs with rich metadata
- **Context management:** Returns relevant chunks; relies on consumer to manage context window
- **Update model:** Primarily append-only; sources can be re-ingested

**Strengths:** Excellent ingestion pipeline. Handles diverse sources. Designed for scale. Good API ergonomics with scoped retrieval and metadata filters. Practical for shipping products quickly.
**Weaknesses:** Primarily read-oriented (not designed for agent self-editing). No built-in tiering. Lacks memory consolidation. More of a retrieval service than an agent memory system. Canonical truth can become opaque behind the API.

**Best idea to steal:** Clean scoped APIs with metadata filters for memory retrieval; robust ingestion pipeline.

---

### 8. Hybrid RAG

**Core Metaphor:** Multi-strategy search fusion

Not a single system but a pattern: combine **sparse retrieval** (BM25/keyword) with **dense retrieval** (vector embeddings) and optionally **structured retrieval** (knowledge graphs, SQL) for maximum recall and precision.

```
            Query
              │
    ┌─────────┼──────────┐
    ▼         ▼          ▼
┌────────┐ ┌────────┐ ┌──────────┐
│ BM25   │ │ Vector │ │Graph/SQL │
│ Index  │ │ Store  │ │ Store    │
└───┬────┘ └───┬────┘ └────┬─────┘
    │          │           │
    └────────┬─┼───────────┘
             ▼ ▼
      ┌──────────────┐
      │  Fusion /    │
      │  Reranker    │
      │  (RRF, CE)   │
      └──────┬───────┘
             ▼
      Top-K Results → Context
```

**Key Properties:**
- **Write strategy:** Documents indexed in multiple indices simultaneously
- **Retrieval:** Parallel queries across sparse + dense; results fused via Reciprocal Rank Fusion or cross-encoder reranking
- **Context management:** Reranker can be tuned for precision or recall
- **Scalability:** Each index scales independently; vector for millions, BM25 for billions

**Strengths:** Best retrieval accuracy of any pure-search approach. Handles both conceptual and keyword queries. Well-proven in production. Lots of tooling available. Essential for large markdown corpora where exact names, IDs, and acronyms matter as much as semantic meaning.
**Weaknesses:** Not a memory model—it's a retrieval pattern. No notion of tiers, working memory, or self-editing. Must be composed with other systems to form a complete memory. Index synchronization adds complexity.

**Best idea to steal:** Use hybrid retrieval (sparse + dense fusion), not vector-only retrieval.

---

## Comparative Matrix

| Dimension | Letta | MemU | Mastra | LLM Wiki | Hermes | AX Cortex | Supermemory | Hybrid RAG |
|---|---|---|---|---|---|---|---|---|
| **Memory Granularity** | Blocks + docs | Atomic facts | Observations | Pages | Categorized entries | Key-value | Chunks | Chunks |
| **Write Trigger** | Agent-initiated | Auto-extracted | Auto-observed | Agent-initiated | Routed | Explicit API | Ingestion pipeline | Explicit index |
| **Retrieval Method** | Embedding search | Embedding search | Semantic search | Title + search + links | Per-category strategy | Semantic + key lookup | Vector search | Sparse + Dense + Fusion |
| **Context Strategy** | Core always in; rest paged | Top-K units | Working mem + search | Load requested pages | Budget per category + scratchpad | Consumer decides | Consumer decides | Reranked Top-K |
| **Self-Editing** | ✅ Full | ❌ System-managed | ❌ System-managed | ✅ Full | ⚠️ Partial | ⚠️ Via API | ❌ | ❌ |
| **Hot/Cold Tiers** | ✅ Core/Archival | ⚠️ Implicit (recency) | ✅ Working/Long-term | ❌ Flat | ⚠️ Per-category | ⚠️ Via TTL | ❌ | ❌ |
| **Consolidation** | ❌ Manual | ✅ Dedup/merge | ⚠️ Basic | ❌ Manual edits | ❌ | ❌ | ❌ | ❌ |
| **Scale to 1000s docs** | ✅ | ✅ | ⚠️ Needs work | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Human Readability** | ⚠️ Medium | ❌ Low (fragments) | ⚠️ Medium | ✅ Excellent | ⚠️ Medium | ❌ Low | ⚠️ Medium | ❌ Low |
| **Implementation Complexity** | 🔴 High | 🟡 Medium | 🟢 Low-Med | 🟢 Low-Med | 🟡 Medium | 🟢 Low | 🟡 Medium | 🟡 Medium |
| **Narrative Preservation** | ⚠️ Conversations | ❌ Fragmented | ⚠️ Observation lists | ✅ Full pages | ⚠️ Per-category | ❌ | ✅ Chunk-level | ✅ Chunk-level |

### Fit Against Requirements

| Requirement | Letta | MemU | Mastra | LLM Wiki | Hermes | AX Cortex | Supermemory | Hybrid RAG |
|---|---|---|---|---|---|---|---|---|
| Simple to implement | Medium | Medium | Good | Excellent | Medium | Good | Good | Medium |
| Scales to 1000s of .md files | Medium | Fair | Fair | Excellent | Good | Good | Good | Excellent |
| Supports hot + cold memory | Excellent | Good | Good | Fair alone | Excellent | Good | Fair | Fair alone |
| Keeps context small | Good | Excellent | Excellent | Fair alone | Excellent | Good | Good | Good |

**Key takeaway: No single model fulfills all four requirements. The solution must combine ideas.**

---

## Best Part to Steal From Each

| System | Key Insight |
|---|---|
| **Letta** | Three-tier architecture with always-in-context core memory |
| **MemU** | Fact-level deduplication, supersession, and conflict resolution |
| **Mastra** | Passive observation extraction (zero agent overhead) |
| **LLM Wiki** | Markdown pages with cross-references as the storage primitive |
| **Hermes** | Hierarchical summaries + XML scratchpad for temporary reasoning |
| **AX Cortex** | Clean provider abstraction with pluggable backends |
| **Supermemory** | Scoped retrieval APIs with rich metadata filters |
| **Hybrid RAG** | Sparse + dense retrieval fusion for maximum recall |

---

## Prior Art (2026-05-10 update)

The model-by-model analysis above predates a 2025–2026 wave of OSS agent-memory systems. Before committing to build, we surveyed the current landscape and a parallel design proposal (ChatGPT's "MemFS-Lattice", same date). The conclusions shape several implementation choices below.

### What the survey found

Multiple projects independently converged on subsets of Strata's design — strong signal that the core ideas are right. None ship the full combination.

| Project | License / Form | What it gets right | What it lacks vs Strata |
|---|---|---|---|
| **Letta MemFS** (descendant of MemGPT) | Apache-2.0, Python server | Markdown-as-canonical-truth + YAML frontmatter + `system/` always-loaded block + observer (Reflection) + consolidator (Defragmentation) | Server-bound; no documented KV-cache discipline; tool-driven retrieval rather than hybrid BM25+vector |
| **memsearch** (Zilliz) | MIT, Python lib | Markdown source-of-truth + content-hash incremental indexing + dense/BM25/RRF retriever | No tier model, no inbox-to-docs pipeline, no frontmatter schema |
| **basic-memory** | AGPL-3.0, Python+MCP | Markdown + frontmatter + WikiLinks + FastEmbed+FTS hybrid | No autonomous observer; AGPL is awkward for a plugin we ship |
| **ByteRover (Cipher)** | Elastic License 2.0, TS daemon + MCP | Markdown FS + git-style VCS + maturity tiers + reports strong LoCoMo numbers using BM25-only (no vectors) | Source-available license unsuitable for a plugin we ship; daemon-and-MCP architecture is wrong shape; no KV-cache discipline; no inbox-to-docs pipeline |
| **MemFS-Lattice** (ChatGPT 2026-05-10 plan, sibling design — not a project) | N/A | Temporal metadata schema; supersession formalism; explicit eval plan | Larger token budgets that break KV-cache discipline; treats observations as a permanent parallel store; full Observer/Curator/Reviewer pipeline is YAGNI for MVP |

Other projects surveyed — mem0, Zep/Graphiti, Mastra memory, MemU, LangMem, Cognee, Supermemory — use proprietary row formats or knowledge graphs and do not satisfy the markdown-as-truth principle (Design Principle 1). Mastra is the only TypeScript-native option but stores memory as SQL rows tightly coupled to its agent framework.

**KV-cache-aware prompt assembly is essentially absent across the field.** Given Anthropic's 90% cached-token discount, this remains Strata's clearest single differentiator.

### Adjustments to this design

1. **On-disk format aims for Letta MemFS compatibility.** The always-loaded directory is named `system/` (matching MemFS) rather than `hot/`. Frontmatter field names should be validated against MemFS during implementation; where they conflict with no good reason, prefer MemFS. Compatibility gives users an exit door if Strata fails — that's a feature, not a bug.

2. **Indexer layer adopts memsearch's BM25 path only.** Phase 3B's vector-vs-no-vector spike (see §Evaluation Plan) settled this empirically: BM25-only beat BM25 + dense + RRF by 9 points on LongMemEval-S, so only memsearch's BM25 layer survives into the production indexer. The c137-style Retrieval Orchestrator + `system/map.md` (added in Phase 3C; see §"Retrieval Orchestration: One-Hop Default, Drill-Down as Escape Valve") sit above the BM25 layer as the picker. Dense embeddings, RRF fusion, and the multi-signal scoring formula are cut. The implementation either ports memsearch's BM25 path to TS or runs it as a Python sidecar; the choice of port-vs-sidecar is deferred to the Phase 1 handoff brief.

3. **Frontmatter schema borrows MemFS-Lattice's temporal and relational fields.** `valid_from`, `valid_to`, `event_time`, `recorded_at`, `confidence`, `supersedes`, `superseded_by`, and `contradicts` are now part of the canonical Document Format. We declined the parallel 6-state lifecycle FSM — those states reduce cleanly to filesystem location plus the new fields.

4. **Vector retrieval is decided OUT (Phase 3B, 2026-05-13).** ByteRover's strong LoCoMo numbers using BM25-only retrieval prompted a deliberate eval spike (see "Evaluation Plan"). The spike has since been run: BM25-only beat BM25 + dense + RRF by 9 points on LongMemEval-S, well outside the ≥5-point band. The vector path and embedding-model dependency are dropped; embeddings move to Level 7 (conditional) and reopen only on contradicting evidence. The LLM reranker (Level 6) also lost to BM25-only by 2.4 points on the same corpus and stays gated on evidence.

5. **`system/recent.md` adds a small derived view inspired by Mastra OM** — open threads, active projects, recent doc changes. Bounded ~400 tokens, regenerated by the Consolidator. This satisfies Mastra's stable-observation-spine intuition without violating single-source-of-truth (it is a *view*, not a parallel store).

6. **Confidence-threshold + sensitive-content gates** in the Consolidator (distilled from the MemFS-Lattice review pipeline) handle the safety story at much lower architectural cost than a full Observer/Curator/Reviewer split. The full pipeline is documented as a deferred-future option in "Open Considerations."

### What remains uniquely Strata's

- Inbox-to-docs single-source-of-truth pipeline (no parallel observation store)
- Three thermal tiers with explicit token budgets (hot ~3500 default / 5000 cap once `system/map.md` is included; warm ~100-doc LRU)
- KV-cache-stable prompt layering (static persona → slowly-changing system files → recent observations → retrieved snippets → conversation)
- Node-native plugin fitting ax-next's hook bus, no orchestrator framework dependency

These four points are where Strata earns its keep over any direct OSS adoption. Everything else is reuse.

### Prior Art (2026-05-13 update — c137)

[c137 Mapped Memory](https://www.c137.ai/research) (closed-source, solo-dev, surfaced 2026-05-13) is the strongest data point yet on several Strata bets. Headline: **90.4% on LongMemEval-S at ~half the median prompt budget (~15k vs ~30k) of competing systems, using zero embeddings.**

What c137 validates:

- **Vector retrieval is probably not load-bearing.** c137 uses no embeddings — pure structured retrieval against a compact in-context "memory map." Combined with ByteRover's BM25-only LoCoMo numbers, this is now two independent signals favoring Level-2 BM25-only over Level-3 hybrid. The eval spike (below) gets stronger priors.
- **Single-source-of-truth holds up.** c137's "only user messages create persistent facts; AI responses go to ledger entries only" is the same anti-hallucination posture as Strata's Observer + confidence-gate, but more sharply enforced.
- **Bounded prompt scaling is achievable.** c137 holds median Stage-2 input flat at ~15k across 35–62 ingested sessions; embedding-based competitors scale linearly. Strata implies this property but doesn't measure it.

What c137 does differently (worth borrowing — adjustments below):

- **Memory Map as a first-class always-in-context index.** A <5k-token hierarchical listing of every topic/group, read on every retrieval decision. Strata's `_summary.md` per folder is the right primitive but isn't auto-injected. → New `system/map.md`, see File System Layout.
- **One-hop retrieval.** A dedicated cheap LLM stage (c137 uses Grok 4.1 Fast, ~1.6s, XML output) reads the map and emits the entire batch of doc/section/FTS requests in one shot. The main agent gets answer-shaped context, no drill-down orchestration cost. → New "Retrieval Orchestration" subsection in Context Assembly.
- **Dual-sourcing rule.** User-originated atoms are fact candidates; assistant-originated atoms are observations needing user corroboration. → Tightens the existing Observer.
- **Logarithmic conversation compression with preservation guarantees.** Last 10 verbatim → L1 per 10 older → L2 per 100; numbers/names/dates guaranteed to survive. → A small upgrade to `system/session.md`'s compression scheme.
- **Abstention as a headline metric.** c137 reports 86.7–96.7% correct-refusal rates; this is arguably more diagnostic of memory quality than raw accuracy. → Bumped to primary in Evaluation Plan.

What Strata still gets right that c137 misses:

- Markdown-as-truth (c137 is JSON-ish DB-backed; no git history, no Obsidian, no portability)
- KV-cache zone discipline (c137 uses provider prefix caching but has no four-zone segmentation)
- Filesystem-first / plugin-shaped (c137 is closed-source and effectively API-locked)
- Long-running coding-agent workload (c137 is chat-app focused)

The c137 datapoint reshuffles the implementation order more than the architecture: vectors slide down the enhancement ladder, the map becomes load-bearing, and retrieval orchestration gets an explicit story. The principles in "Design Principles" are unchanged.

---

# Proposed Model: **Strata**

*"Layered memory with a markdown soul."*

## The Single Most Important Design Rule

**Do not make raw chat history your primary memory.**

Raw history is too large, too noisy, too expensive, and too hard to retrieve well. Instead:

- **Raw history** → archive (cold storage, rarely accessed)
- **Observations** → compact retrieval units (extracted, then consolidated)
- **Markdown pages** → canonical truth (human-readable, version-controllable)
- **Summaries** → compression layer (embedded in documents and generated per-folder/thread)
- **Hot memory** → tiny prompt budget (always in context)

---

## Design Principles

1. **Markdown is the source of truth** — every memory is a human-readable `.md` file
2. **Filesystem-first** — all indices are derived from and rebuildable from the markdown files; the system is never locked into a specific database
3. **Three thermal tiers** — hot (always in context), warm (fast-access cache), cold (full archive)
4. **Passive extraction, active editing** — observations are auto-extracted; the agent *can* edit but doesn't *have to*
5. **Hybrid retrieval** — every query runs BM25 + vector search with fusion
6. **Summary-first context injection** — retrieve the smallest abstraction that answers the question; drill down only when needed
7. **Clean interface boundaries** — memory strategy is separated from storage backend

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        STRATA MEMORY                            │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  🔴 HOT TIER  (always in context, ~3500 default / 5000 cap) │  │
│  │                                                            │  │
│  │  ┌──────────┐  ┌──────────┐  ┌────────────────────────┐  │  │
│  │  │ agent.md │  │ user.md  │  │ session.md (rolling)   │  │  │
│  │  │ (persona │  │ (profile │  │ (compressed summary    │  │  │
│  │  │  & goals)│  │  & prefs)│  │  of current session)   │  │  │
│  │  └──────────┘  └──────────┘  └────────────────────────┘  │  │
│  │  ┌────────────────────────────────────────────────────┐   │  │
│  │  │ recent.md (derived: open threads, active projects, │   │  │
│  │  │  last N doc changes; regenerated by Consolidator)  │   │  │
│  │  └────────────────────────────────────────────────────┘   │  │
│  │  ┌────────────────────────────────────────────────────┐   │  │
│  │  │ map.md (derived: hierarchical doc index w/         │   │  │
│  │  │  summaries; ~2k tokens; from c137 Memory Map)      │   │  │
│  │  └────────────────────────────────────────────────────┘   │  │
│  │  ┌──────────────────────────────────────────────────────┐ │  │
│  │  │ <scratchpad> (temporary reasoning space, cleared     │ │  │
│  │  │  after each task; inspired by Hermes)                │ │  │
│  │  └──────────────────────────────────────────────────────┘ │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  🟡 WARM TIER  (LRU cache, ~100 docs in memory)           │  │
│  │                                                            │  │
│  │  Recently accessed + frequently accessed + pinned docs     │  │
│  │  Instant retrieval, no embedding search needed             │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  🔵 COLD TIER  (full archive on disk)                      │  │
│  │                                                            │  │
│  │  ┌──────────────────┐  ┌──────────────────────────────┐   │  │
│  │  │  Markdown Files  │  │  Derived Indices             │   │  │
│  │  │  (source of      │──│  • SQLite FTS5 (keyword)     │   │  │
│  │  │   truth)         │  │  • Vector Index (semantic)   │   │  │
│  │  │                  │  │  • Metadata Index (filters)  │   │  │
│  │  └──────────────────┘  └──────────────────────────────┘   │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  ⚙️  BACKGROUND PROCESSES                                   │  │
│  │                                                            │  │
│  │  Observer      Consolidator    Retriever     Promoter      │  │
│  │  (extract)     (merge/dedup)   (hybrid       (tier mgmt)   │  │
│  │                                 search)                    │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Design Decision: Three Tiers (Not Four)

Some approaches suggest four layers—splitting observations and canonical docs into separate tiers along with hot memory and summaries. Strata deliberately uses **three thermal tiers** (hot, warm, cold) with observations handled as a **transient inbox** that gets consolidated into canonical documents. Here's why:

- Observations as a permanent parallel retrieval layer creates dual-source-of-truth ambiguity.
- An inbox-to-document pipeline (inspired by GTD workflows) ensures every observation either graduates to a canonical page or is discarded. This prevents unbounded growth of a separate observation store.
- Summaries are embedded as frontmatter within documents and generated per-folder, not stored as a separate layer—keeping the system simpler while still enabling hierarchical summary retrieval.

---

## File System Layout

```
memory/
├── system/                   # Always-loaded hot tier (matches Letta MemFS convention)
│   ├── agent.md              # Persona, capabilities, goals (fixed-cost)
│   ├── user.md               # Active user profile
│   ├── session.md            # Rolling summary of current session (multi-resolution; see below)
│   ├── recent.md             # Derived: open threads + active projects + recent doc changes (~400 tokens)
│   └── map.md                # Derived: hierarchical index of every doc with frontmatter summary (~2k token cap)
│
├── docs/                     # All long-term memory documents (canonical truth)
│   ├── entities/
│   │   ├── people/
│   │   │   ├── john-doe.md
│   │   │   ├── jane-smith.md
│   │   │   └── _summary.md   # Folder-level summary
│   │   ├── projects/
│   │   │   ├── project-alpha.md
│   │   │   └── _summary.md
│   │   └── orgs/
│   │       └── acme-corp.md
│   ├── knowledge/
│   │   ├── technical/
│   │   │   └── react-patterns.md
│   │   └── domain/
│   │       └── quarterly-okrs.md
│   ├── episodes/
│   │   ├── 2024-01-15-planning-call.md
│   │   └── 2024-01-16-debugging-session.md
│   └── procedures/
│       ├── deployment-checklist.md
│       └── code-review-process.md
│
├── inbox/                    # Raw observations awaiting consolidation (GTD-style)
│   ├── 2024-01-16T14-30-00.md
│   └── 2024-01-16T15-45-00.md
│
└── .strata/                  # Derived indices (rebuildable from docs/)
    ├── vectors.db            # SQLite + vector extension (or HNSW file)
    ├── search.db             # SQLite FTS5 full-text index
    └── meta.db               # Metadata, access counts, link graph
```

The `.strata/` index directory is **entirely derived** from the markdown files. If it is deleted, it can be rebuilt from scratch by re-indexing. This ensures the system is never locked into a specific database and files can live in git, Dropbox, or any filesystem.

`system/recent.md` is also derived — the Consolidator regenerates it from the current state of `inbox/` plus the most-recently-updated documents. Deleting it loses no information; the next consolidation pass reproduces it. It is *not* a parallel observation store. Three sections, each one-liners:

```markdown
# Recent

## Open Threads
- Migrating Project Alpha to React 19 (in progress, blocked on API team)
- Choosing Postgres vs SQLite for billing service

## Active Projects
- project-alpha — frontend lead: john-doe
- billing-service — owner: self

## Recent Changes
- 2024-01-16 — added Stripe integration notes to api-endpoints.md
- 2024-01-15 — recorded John's React 19 preference in john-doe.md
```

The 400-token cap is enforced; when content overflows, the consolidator drops oldest "Recent Changes" entries first, then deranks "Open Threads" by `last_accessed`.

### `system/map.md` — the always-injected index

Borrowed from c137 (see Prior Art 2026-05-13). The map is a compact hierarchical listing of every document in `docs/` with its frontmatter `summary` — auto-regenerated by the Consolidator whenever a doc is added, removed, or has its summary changed. Sits in Zone 2 of the prompt (session-stable, cached). Soft cap **2k tokens**; hard cap **3k**.

```markdown
# Memory Map

## entities/people
- [[john-doe]] — Frontend engineer at Acme Corp on Project Alpha. Prefers React. Seattle.
- [[jane-smith]] — John's tech lead. Decision-maker on stack choices.

## entities/projects
- [[project-alpha]] — Q3 dashboard rewrite. React 19 migration in progress.

## knowledge/technical
- [[react-patterns]] — Component patterns we've standardized on.

## episodes (last 30d, summarized older)
- [[2024-01-16-debugging-session]] — Hydration bug; resolved via SSR config fix.

## procedures
- [[deployment-checklist]] — Production deploy steps.

## (cold) — older episodes collapsed to folder summary
- entities/orgs (3 docs) — see [[entities/orgs/_summary]]
```

Key properties:

- **One-line-per-doc.** Just the frontmatter summary, no body. Keeps the map dense.
- **Tiered collapse.** When the token cap is hit, the oldest folders collapse to their `_summary.md` line and a doc count. Drill-down through `memory_list(category=...)` recovers the per-doc list.
- **Wiki-link format.** `[[doc-id]]` matches the canonical cross-reference syntax so the retrieval-stage LLM can name doc IDs directly in its load list.
- **Regenerated on doc change, not per turn.** The map is content-hashed; if unchanged between turns, it stays cache-valid in Zone 2.
- **Deletable.** Like `recent.md`, the map is derived; deleting it loses no information.

When `system/map.md` is small enough to fit alongside `agent.md` + `user.md` + `recent.md` + `session.md` inside the hot-tier budget, it's the single biggest unlock for one-hop retrieval (see "Retrieval Orchestration" below): the retrieval-stage LLM sees everything that exists without having to search.

---

## Document Format

Every document follows a simple convention: YAML frontmatter + markdown body. Frontmatter includes a **summary** field that serves as the primary retrieval unit, avoiding the need to load full page content.

```markdown
---
# Identity
id: john-doe
type: entity/person
tags: [engineering, frontend, seattle]
links: [project-alpha, jane-smith]
summary: >
  John Doe is a frontend engineer at Acme Corp working on
  Project Alpha. Prefers React. Based in Seattle.

# Lifecycle timestamps
created: 2024-01-15T10:30:00Z
updated: 2024-01-16T14:22:00Z
last_accessed: 2024-01-16T14:22:00Z
access_count: 12

# Truth interval (temporal reasoning)
valid_from: 2024-01-15
valid_to:                       # null = currently true
event_time: 2024-01-15T10:30:00Z   # when the underlying event happened
recorded_at: 2024-01-15T10:32:00Z  # when we captured it

# Trust signals
confidence: 0.92                # 0.0–1.0; below ~0.7 stays in inbox
importance: 0.65                # 0.0–1.0; influences retrieval ranking
pinned: false

# Relations (supersession is preferred to overwriting)
supersedes: []                  # ids this fact replaces
superseded_by:                  # null until something newer replaces this
contradicts: []                 # ids that conflict; resolution stays explicit
---

# John Doe

## Facts
- Frontend engineer at Acme Corp
- Working on Project Alpha since Q3 2024
- Prefers React over Vue, has used both for 5+ years
- Based in Seattle, works Pacific time

## Working Style
- Tends to be optimistic about deadlines
- Prefers async communication (Slack > meetings)
- Very detail-oriented in code reviews

## Interaction History
- **2024-01-15**: Discussed Project Alpha timeline; he estimated 3 weeks
  for the dashboard feature
- **2024-01-16**: Helped me debug a React hydration issue; mentioned
  he's blocked on the API team

## See Also
- [[project-alpha]] — the project he's leading frontend for
- [[jane-smith]] — his tech lead
```

### Frontmatter Field Semantics

The temporal, trust, and relations groups are load-bearing:

- **`valid_from` / `valid_to`** define the interval during which the fact is true. Current queries prefer facts where `valid_to` is null or in the future. Historical queries (`as of <date>`) walk these intervals. Without `valid_to`, the fact is treated as currently true.
- **`event_time` vs `recorded_at`** distinguishes when something happened from when we captured it. Matters for late-arriving facts ("yesterday I decided X" recorded today) and for replay/audit.
- **`confidence`** is the consolidator's gate. Observations land in `inbox/` with whatever confidence the Observer assigned; only facts ≥ the consolidation threshold (default 0.7) graduate to `docs/`. See "Consolidator" below.
- **`importance`** is a retrieval signal, not a gate. High-importance facts get a ranking boost.
- **`supersedes` / `superseded_by`** form a chain. A new fact replacing an old one writes a `supersedes: [<old_id>]` link and the old fact gets `superseded_by: <new_id>` set. Old facts are *not deleted* — they remain queryable for historical questions, just deranked for current ones.
- **`contradicts`** is for unresolved conflicts (rare). When two facts disagree and neither supersedes the other, both reference each other in `contradicts:` and retrieval surfaces both with a contradiction marker rather than silently picking one.

**Tombstoning is `git rm`.** Strata does not maintain a separate "tombstoned" lifecycle state — when a fact must go (privacy delete, irrecoverably wrong), it's deleted from the working tree and the git history is the audit trail. For redaction beyond git (compliance), the deletion includes a rewrite of git history per the Forgetting Policy in "Open Considerations."

### Indexing Strategy: Metadata and Headers, Not Full Text

To keep indices lightweight and retrieval fast at scale, the system indexes:
- **Frontmatter fields** (title, type, tags, summary, links)
- **Section headers** (extracted from `#`, `##`, `###` structure)
- **Summary text** (the frontmatter summary field)

Full body text is indexed in FTS5 for keyword search. Full section text is loaded on-demand only when the agent explicitly requests it via `memory_read_section` (or when the Retrieval Orchestrator emits a `<load>` op against a specific section). Embedding-based indexing was deferred to Level 7 (conditional) after the Phase 3B spike — see §Evaluation Plan.

---

## The Four Background Processes

### 1. Observer (from Mastra + MemU)

Runs **automatically after each conversation turn** (or batched every N turns). Extracts observations without the agent doing anything.

```python
class Observer:
    """
    Extracts observations from conversation turns and routes
    them to existing documents or the inbox.
    """

    def observe(self, messages: list[Message]) -> list[Observation]:
        prompt = f"""
        Extract noteworthy facts from this conversation.
        Return as a list of observations, each with:
        - fact: the atomic fact (one sentence)
        - subject: the entity this is about (or "general")
        - type: entity/knowledge/episode/procedure
        - confidence: high/medium/low

        Conversation:
        {format_messages(messages)}
        """
        observations = llm.extract(prompt)

        for obs in observations:
            existing_doc = self.find_matching_doc(obs.subject)
            if existing_doc:
                self.append_to_doc(existing_doc, obs)
            else:
                self.write_to_inbox(obs)   # Staged in inbox/

        return observations

    def update_session_summary(self, messages, current_summary):
        """Compress the rolling session summary (hot tier)."""
        prompt = f"""
        Update this session summary with new messages.
        Keep it under 500 tokens. Preserve key decisions,
        questions, and context. Drop small talk.

        Current summary: {current_summary}
        New messages: {format_messages(messages[-5:])}
        """
        return llm.compress(prompt)
```

#### Dual-Sourcing Rule (anti-hallucination, from c137)

The Observer treats user-originated and assistant-originated content asymmetrically:

| Source | Default landing | Promotion path |
|---|---|---|
| **User message** | Inbox at observed confidence | Standard confidence-gate (≥0.7) |
| **Assistant message** | Inbox at confidence × 0.5 | Requires user corroboration (the user later affirms / acts on / restates the fact) before clearing the 0.7 threshold |
| **Tool result** | Inbox at observed confidence; tagged with tool source | Standard gate; tool-source provenance retained in frontmatter |

**Why.** c137's rule is the strongest known defense against the agent's own confabulations being re-ingested as truth. If the agent says "your meeting is at 3pm" and the user neither confirms nor acts on it, that should not become a persistent fact about the user. Strata's existing confidence-gate handles the threshold mechanic; the dual-sourcing rule adds the *source-discount* that makes assistant-originated observations need corroboration.

**Implementation.** The Observer prompt is split into two extraction passes (or one pass with source-tagged output), and the candidate observation carries an `origin: user|assistant|tool` field through the inbox. The Consolidator's promotion check reads `origin` and applies the corresponding multiplier.

**Provenance is preserved** all the way to the document: graduating facts retain an `origin` annotation in the document frontmatter or fact-level metadata, so retrieval can surface "the agent inferred this; not confirmed by the user."

### 2. Retriever (BM25 from memsearch + map/orchestrator from c137)

**Implementation note (2026-05-14, supersedes 2026-05-10).** The original design adopted memsearch wholesale for hybrid retrieval (BM25 + dense + RRF + multi-signal scoring + rerank). The Phase 3B/3C spike against LongMemEval-S settled this empirically (see §Evaluation Plan, "vector-vs-no-vector spike"):

- **BM25-only beat BM25 + dense + RRF by 9 points** — the dense path didn't earn its dependency cost. Vectors are OUT; embeddings sit at Level 7 (conditional) and reopen only on contradicting evidence.
- **The LLM reranker (zerank-2) also lost to BM25-only** by 2.4 points on the same corpus. Reranker stays at Level 6, also gated on evidence.
- **Orchestrator + LLM-rewritten map (c137-style) beat BM25-only by 7.6pp accuracy / 14.2pp recall@5** at n=500 — the structured-retrieval stage runs *above* the indexer and does the picking, so the indexer no longer needs hybrid scoring to fuse signals.

The resulting indexer is **BM25-only**, taken from memsearch's BM25 path: SQLite FTS5 + content-hash incremental indexing + markdown source-of-truth + frontmatter-scoped indexing. Dense embeddings, RRF, and the multi-signal scoring formula (`0.35 × lexical + 0.35 × dense + ...`) are cut. What Strata adds on top of memsearch's BM25 layer: tier-aware result routing (system → warm-cache → cold-search) and summary-first / header-mode shaping.

**Composition.** The retrieval flow is no longer monolithic. It's a two-layer stack:

1. **Retrieval Orchestrator** (c137-style; see §"Retrieval Orchestration: One-Hop Default" for the full spec) — a cheap LLM call reads `system/map.md` + the user query and emits XML ops (`<load>`, `<fts>`, `<followup needed="true"/>`).
2. **runOps** dispatches each op:
   - `<load doc="..."/>` → direct read from the memory tree (no indexer involved).
   - `<fts query="..."/>` → memsearch BM25 search over FTS5 (the escape valve below).
   - `<followup needed="true"/>` → fall through to agent-driven drill-down via the existing `memory_search` / `memory_read_section` tools.

The Retriever class below covers only step 2's `<fts>` path plus the drill-down tools. The picker layer is the orchestrator, not the indexer.

```python
class Retriever:
    """
    BM25-only retrieval over the markdown corpus. Invoked by the
    Retrieval Orchestrator's <fts> ops and by agent-driven drill-down
    via memory_search / memory_read_section. Dense embeddings, RRF
    fusion, and the multi-signal scoring formula were cut after the
    Phase 3B spike (see §Evaluation Plan).
    """

    def search(self, query: str, filters: dict = None,
               top_k: int = 5, mode: str = "summary") -> list[Result]:
        # BM25 over SQLite FTS5. The FTS5 index covers titles, headers,
        # summaries, and full body text. No vector_index, no embed().
        results = self.fts_index.search(query, limit=top_k, filters=filters)

        # Update access metadata for the Promoter.
        for doc in results:
            self.meta_db.increment_access(doc.id)

        if mode == "summary":
            # Frontmatter summaries (~50 tokens each)
            return [Result(d.id, d.title, d.summary) for d in results]
        if mode == "headers":
            # Document header tree for drill-down
            return [Result(d.id, d.title, d.headers) for d in results]
        return results
```

**Why no fusion layer.** The pre-spike design used RRF + multi-signal scoring to fuse weak signals into a single ranking. In the post-spike architecture, the orchestrator emits at most 5 explicit ops per query against the always-injected map; the BM25 index serves a much smaller surface area (the FTS escape valve, not the primary path), so there's nothing for RRF to fuse against. Recency / importance / scope filtering, if needed, become `filters` passed to the FTS5 query, not score weights — much simpler and more debuggable.

### 3. Consolidator (from MemU + LLM Wiki)

Runs **periodically** (end of session, daily cron, or when inbox exceeds N items). This is where the inbox/GTD pattern shines: raw observations are staged, then consolidated into canonical documents.

```python
class Consolidator:
    """
    Merges inbox observations into existing documents.
    Deduplicates facts. Creates new documents for new topics.
    Updates summaries and cross-references.
    """

    def consolidate(self):
        inbox_items = self.load_inbox()

        # 1. Cluster observations by subject
        clusters = self.cluster_by_subject(inbox_items)

        for subject, observations in clusters.items():
            # Apply promotion criteria before creating new pages
            if not self.find_existing_doc(subject):
                if not self.meets_promotion_criteria(observations):
                    continue  # Leave in inbox for now

            doc = self.find_or_create_doc(subject)

            # 2. Deduplicate against existing facts (MemU-style)
            new_facts = self.deduplicate(observations, doc.facts)

            # 3. Check for contradictions
            contradictions = self.find_contradictions(new_facts, doc.facts)
            for old, new in contradictions:
                doc.replace_fact(old, new)   # Newer wins, with note

            # 4. Append genuinely new facts
            doc.append_facts(new_facts)

            # 5. Update frontmatter summary
            doc.summary = self.regenerate_summary(doc)

            # 6. Update cross-references ([[wiki-links]])
            doc.links = self.extract_links(doc.body)

            # 7. Save and re-index
            doc.save()
            self.reindex(doc)

        # 8. Clear processed inbox items
        self.clear_inbox(inbox_items)

    def meets_promotion_criteria(self, observations: list) -> bool:
        """
        Promote observations to a new wiki page only if:
        - The observation appears multiple times (repeated signal)
        - It is user-confirmed
        - It represents a decision, preference, or stable fact
        - It matters beyond one session
        """
        if len(observations) >= 3:
            return True
        if any(o.confidence == "high" and o.type in ["decision", "preference"]
               for o in observations):
            return True
        return False

    def compress_old_episodes(self, older_than_days=30):
        """Compress old episode documents into summaries."""
        old_episodes = self.find_episodes(older_than=older_than_days)
        for episode in old_episodes:
            summary = self.summarize(episode)
            episode.body = summary
            episode.frontmatter['compressed'] = True
            episode.save()

    def update_folder_summaries(self):
        """Generate/update _summary.md for each folder (Hermes-style hierarchy)."""
        for folder in self.get_doc_folders():
            docs = self.list_docs(folder)
            summaries = [d.frontmatter['summary'] for d in docs]
            folder_summary = self.llm_summarize_collection(summaries)
            self.write_file(f"{folder}/_summary.md", folder_summary)
```

#### Confidence Threshold (the auto-merge gate)

The Consolidator does not promote everything from `inbox/` into `docs/`. Each observation carries a `confidence` score from the Observer; only facts at or above the consolidation threshold (default **0.7**) are eligible to graduate. Observations below the threshold remain in the inbox and follow one of three exits:

1. **Corroboration:** the same fact is observed N more times (default N=2). Each repeat boosts confidence; once it crosses 0.7, the fact graduates.
2. **Decay / expiry:** observations stale longer than K days (default K=14) without corroboration are dropped from the inbox.
3. **Manual promotion:** the agent (or a user via tooling) can force-promote an inbox item.

The threshold is configurable per agent — high-stakes contexts (compliance, finance) raise it; exploratory contexts lower it.

#### Sensitive-Content Gate

Before any fact moves from `inbox/` to `docs/`, the Consolidator runs the candidate through a sensitive-content classifier hook. The default classifier rejects:

- credentials (API keys, tokens, passwords matching common patterns)
- PII (emails, phone numbers, SSNs, payment-card numbers — beyond what the user has explicitly chosen to record about themselves in `system/user.md`)
- prompt-injection markers (instructions that look like attempts to overwrite `system/agent.md`)

The hook is plugin-replaceable. When `@ax/scanner-canary` ships, this gate composes with it directly — the same classifier that vetoes secrets crossing into the workspace also vetoes them crossing into memory. Rejected facts are removed from the inbox (`git rm`) with a small marker entry recording the rejection reason. Silent drops are forbidden.

#### `system/recent.md` Regeneration

At the end of every consolidation pass, the Consolidator regenerates `system/recent.md` from current state:

- **Open Threads:** non-graduated inbox items that look like in-progress work (heuristic: `type: episode` or `type: decision` with `valid_to: null`)
- **Active Projects:** distinct project entities referenced in the last 7 days of doc updates
- **Recent Changes:** the 5 most-recent doc updates (oldest entries dropped first when the 400-token cap is hit)

`recent.md` is rebuildable; it is *not* a parallel observation store. Treating it as a dashboard view rather than canonical content is what keeps single-source-of-truth intact.

### 4. Promoter (Tier Management, from Letta)

Manages which documents live in which tier based on access patterns.

```python
class Promoter:
    """
    Manages document promotion/demotion between tiers.

    HOT:  Always in context. Only core files + scratchpad.
    WARM: LRU cache of ~100 docs. In-memory for instant access.
    COLD: Everything else. Searched on demand via hybrid retrieval.
    """

    def __init__(self, warm_capacity=100):
        self.warm_cache = LRUCache(warm_capacity)

    def promote_to_warm(self, doc_id: str):
        """Called on every retrieval hit."""
        doc = self.load_doc(doc_id)
        self.warm_cache.put(doc_id, doc)

    def auto_pin(self):
        """Auto-pin frequently accessed docs to warm tier."""
        hot_docs = self.meta_db.get_top_by_access(limit=20)
        for doc in hot_docs:
            doc.frontmatter['pinned'] = True
            self.promote_to_warm(doc.id)
```

---

## Context Assembly: How Strata Keeps Context Small

This is the critical mechanism. Context is assembled in a **progressive drill-down** pattern rather than by dumping retrieved chunks:

### Design Decision: Hybrid Injection Strategy

The question of whether to auto-inject retrieved content or force the agent to request everything via tools is a key architectural choice. Strata takes a **hybrid position**: auto-inject summaries (very cheap, ~50 tokens each) while requiring the agent to actively drill down for full sections. This provides the best of both worlds—the agent always has enough context to know *what's available* without wasting tokens on content it may not need.

```
┌──────────────────────────────────────────┐
│ SYSTEM PROMPT                            │
│ (~300 tokens)                            │
│                                          │
│ You are ... [from system/agent.md]       │
│                                          │
│ <scratchpad>                             │
│ Currently investigating billing API.     │
│ Need to check: Stripe integration docs.  │
│ </scratchpad>                            │
├──────────────────────────────────────────┤
│ MEMORY BLOCK (auto-injected)             │
│ (~500-800 tokens, dynamically built)     │
│                                          │
│ ## User Profile [from system/user.md]    │
│ - Name: John, prefers concise answers    │
│                                          │
│ ## Session Context [from system/session.md] │
│ - Discussing Project Alpha migration     │
│ - Decided on React 19, still choosing DB │
│                                          │
│ ## Recent [from system/recent.md]        │
│ - Open: React 19 migration (blocked)     │
│ - Last change: api-endpoints.md (today)  │
│                                          │
│ ## Relevant Documents Found:             │
│ [auto-injected summaries from search]    │
│ - doc:api-endpoints (High): "API setup   │
│   guide for Stripe and PayPal..."        │
│ - doc:billing-policies (Med): "Billing   │
│   rules and refund procedures..."        │
│                                          │
├──────────────────────────────────────────┤
│ CONVERSATION (last N messages)            │
│ (~remaining budget)                      │
│                                          │
│ [only recent messages; old ones are      │
│  compressed into session.md]             │
├──────────────────────────────────────────┤
│ TOOLS                                    │
│ memory_search, memory_read_section,      │
│ memory_note, memory_edit, memory_list    │
└──────────────────────────────────────────┘

Total: ~3500-5000 tokens base (incl. ~2k map.md), even with
       thousands of documents in cold storage.
       Agent drills down only when needed.
```

### The Retrieval Flow in Practice

1. **User asks a question:** "How do I configure the billing API?"
2. **Auto-search fires:** Hybrid retrieval runs, returns top 3-5 document *summaries* (~150 tokens total). These are injected into the Memory Block.
3. **Agent decides:** Based on summaries, the agent uses `memory_read_section(doc_id="api-endpoints", header="## Stripe Integration")` to load only the ~200 tokens it needs.
4. **Agent answers:** Using the scratchpad for reasoning and the loaded section for facts.
5. **Context flushed:** After responding, the loaded section can be dropped. The scratchpad is updated or cleared.

This means **at any given time**, the context contains only: hot memory (~3500 tokens incl. map.md) + auto-injected summaries (~200 tokens) + one actively loaded section (~200 tokens) + conversation + tools ≈ **well under 6K tokens**, regardless of archive size.

### Retrieval Orchestration: One-Hop Default, Drill-Down as Escape Valve

Borrowed from c137 (see Prior Art 2026-05-13). The naive flow above ("auto-search → inject summaries → agent drills down via tool calls") works but spends 2–4 main-agent turns orchestrating retrieval. c137 collapses that into a single cheap LLM call before the main agent runs.

**The orchestration:**

1. **Retrieval Stage (cheap, fast).** A small/fast model (Haiku-class, or local) receives:
   - `system/agent.md` + `system/user.md` + `system/recent.md` + `system/map.md`
   - The user's query
   - A short instruction: "Output the exact set of memory operations to perform, in XML."

   It emits something like:

   ```xml
   <retrieve>
     <load doc="api-endpoints" section="## Stripe Integration"/>
     <load doc="billing-policies" mode="summary"/>
     <fts query="refund window"/>
   </retrieve>
   ```

2. **Execute the batch.** The runtime resolves the XML against the existing tools (`memory_read_section`, `memory_search`, `memory_list`) and assembles the result block.

3. **Main agent runs.** Gets answer-shaped context in Zone 4 (volatile) and answers in one turn.

**Why XML, not tool calls.** c137 reports XML output is more reliable and faster to parse with smaller models than formal tool-calling schemas. Strata uses XML *for the orchestration stage only* — the agent-facing tool surface (`memory_search` etc.) is unchanged and remains a proper tool interface for drill-down.

**Drill-down stays available.** If the main agent realizes mid-response that the orchestrator missed something, it can still call `memory_search` / `memory_read_section` directly. One-hop is the default cheap path; multi-hop is the escape valve.

**When one-hop fails.** Cross-document aggregation queries ("sum all the costs across projects") and overwritten-state queries ("what was the deadline before we changed it") are c137's documented failure modes for one-hop. Strata's response: detect these (the orchestration LLM emits `<followup needed="true">` when it isn't confident) and fall through to agent-driven drill-down.

**Cost model.** Orchestration stage is ~1 cheap call per turn (~$0.002 on Haiku). Saves 2–4 expensive main-agent turns. Net: cheaper, lower latency, more deterministic context.

```python
class RetrievalOrchestrator:
    """
    One-hop retrieval planner (c137-style). Reads the always-injected
    hot tier + user query, emits XML naming exactly which memory ops
    to run. Falls back to agent-driven drill-down when uncertain.
    """

    def plan(self, query: str, hot_tier: HotTier) -> list[MemoryOp]:
        prompt = f"""You select memory to load for a downstream agent.

        Available docs (map): {hot_tier.map}
        Current context: {hot_tier.recent}
        User profile: {hot_tier.user}

        Query: {query}

        Output XML with <load>, <fts>, or <list> ops. If unsure
        whether one-hop is sufficient, add <followup needed="true"/>.
        """
        xml = self.fast_llm.complete(prompt)
        return self.parse_xml(xml)
```

This is the single biggest *behavioral* change c137 motivates. It does not alter the storage layout or the document format — only how retrieval is invoked.

---

## Agent Tool Interface

The agent gets **optional** memory tools. Because the Observer handles the common case passively, the agent doesn't *have to* use these—but it *can* for explicit memory management:

```python
AGENT_TOOLS = {
    "memory_search": {
        "description": "Search long-term memory. Returns document summaries.",
        "params": {"query": "str", "type_filter": "optional str"},
        "handler": retriever.search  # Returns summaries by default
    },
    "memory_read_section": {
        "description": "Read a specific section from a memory document",
        "params": {"doc_id": "str", "header": "optional str"},
        "handler": lambda doc_id, header: read_markdown_section(doc_id, header)
    },
    "memory_note": {
        "description": "Save an important note to memory",
        "params": {"subject": "str", "content": "str", "type": "str"},
        "handler": observer.manual_note  # Goes through same pipeline
    },
    "memory_edit": {
        "description": "Edit an existing memory document section",
        "params": {"doc_id": "str", "section": "str", "new_content": "str"},
        "handler": wiki_editor.edit_section
    },
    "memory_list": {
        "description": "List known topics in a category",
        "params": {"category": "str"},
        "handler": lambda cat: list_docs(f"docs/{cat}/")
    },
    "update_core_memory": {
        "description": "Update a hot memory file (agent.md, user.md)",
        "params": {"file": "str", "key": "str", "value": "str"},
        "handler": hot_memory.update
    }
}
```

---

## How Each Requirement Is Met

### ✅ Simple to Implement

| Component | Implementation |
|---|---|
| Storage | Flat `.md` files on disk. No special database to start. |
| Hot tier | 3-4 files read on every turn + a scratchpad string—trivial |
| Warm tier | Python `lru_cache` or in-memory dict (~50 lines) |
| Cold tier | SQLite FTS5 for keyword search (stdlib). Indexed via memsearch's BM25 path. Vector index deferred to Level 7 (conditional, see §Evaluation Plan) |
| Observer | One LLM call per turn with a structured extraction prompt |
| Consolidator | A script that runs on session end; cluster + deduplicate + write |
| Retriever | BM25 over FTS5 (~30 lines); c137-style Retrieval Orchestrator sits above it as the picker |

**Minimum viable implementation: ~500 lines of Python, zero infrastructure beyond the filesystem and SQLite.**

### ✅ Scales to Thousands of Markdown Documents

- **Filesystem**: Handles millions of files trivially with folder hierarchy
- **SQLite FTS5**: Handles millions of documents; BM25 search in milliseconds
- **Vector index**: `sqlite-vec` or `hnswlib` handles 100K+ vectors on a single machine
- **Lightweight indexing**: Indexing summaries/headers instead of full text keeps the vector index small
- **Folder categories**: `entities/`, `knowledge/`, `episodes/`, `procedures/` prevent flat-namespace chaos
- **Folder summaries** (`_summary.md`): Hierarchical summaries at the folder level enable navigation without loading individual docs
- **Consolidator**: Prevents unbounded growth through dedup, compression of old episodes, and merging of related observations

### ✅ Hot and Cold Memory Retrieval

| Tier | Contents | Access Pattern | Latency |
|---|---|---|---|
| 🔴 Hot | `agent.md`, `user.md`, `session.md`, `recent.md`, `<scratchpad>` | Every turn, always in context | 0ms (pre-loaded) |
| 🟡 Warm | Recently/frequently accessed docs, pinned docs | LRU cache hit before cold search | <1ms (memory) |
| 🔵 Cold | Full archive of all markdown docs + inbox | Hybrid search on demand | ~50-200ms (index query) |

**Promotion path:** Cold → Warm (on access) → stays warm (via LRU/pin). Hot tier is updated per-turn (`session.md`), per-consolidation (`recent.md` regenerated), or on profile changes (`user.md`).

### ✅ Keeps Context Size Small

Five mechanisms work together:

1. **Hot tier budget**: Default ~3500 tokens, hard cap 5000 tokens (`agent.md` + `user.md` + `session.md` + `recent.md` + `map.md` + scratchpad combined). `session.md` is a compressed rolling summary, not full history. `map.md` is a derived index (see File System Layout). Scratchpad is cleared between tasks. When the cap is exceeded, the Consolidator compresses in priority order: `map.md` folder collapse → oldest paragraphs of `session.md` → low-importance items in `user.md` → low-`access_count` entries in `recent.md`. `agent.md` is never compressed (persona is fixed-cost).
2. **Summary-first injection**: Auto-injected search results use the `summary` frontmatter field (~50 tokens each), not full document content.
3. **Header-based drill-down**: The agent reads a file's section headers first, then requests only a specific `##` section—naturally exploiting markdown's hierarchical structure.
4. **Conversation windowing**: Only the last N messages are in context. Older messages are compressed into `session.md` by the Observer.
5. **Consolidator compression**: Old episodes are summarized. Redundant facts are merged. The archive stays dense with information, not bloated with repetition.

---

## Evaluation Plan

Strata's design makes several claims that need empirical backing — most importantly, the bet that BM25 + summary-first retrieval + KV-cache-stable layering wins on cost-adjusted accuracy. The eval harness is part of the plugin, not an afterthought.

### Benchmarks

- **Primary: LongMemEval-S** — long-context memory across multi-session agent tasks. The most directly relevant public benchmark.
- **Secondary: LoCoMo** — conversational memory at length; widely cited so we can compare to ByteRover, Letta MemFS, mem0, and others.
- **Tertiary: internal project-memory tasks** — synthetic queries against an ax-next development corpus. Catches regressions that public benchmarks miss because they don't model our actual workload (long-running coding agents).

Treat all three as directional. Single benchmark wins are noise; consistent direction across all three is signal.

### Metrics (four axes)

**Abstention (primary, from c137)**
- Correct-refusal rate: agent says "I don't know" rather than confabulating, on questions whose answer is not in memory
- Hallucination rate: incorrect-confident-answer rate on the same question set
- c137 reports 86.7–96.7% correct-refusal on LongMemEval-S; this is arguably the most diagnostic memory-quality signal, because retrieval failures dominate over reasoning failures in long-horizon agents. Strata targets parity or better.

**Accuracy**
- Overall QA accuracy
- Multi-session accuracy (information from session A retrieved in session B)
- Temporal-reasoning accuracy ("what did I prefer last quarter?")
- Contradiction-handling accuracy (correct supersession applied)

**Retrieval**
- recall@k, precision@k against gold-labeled relevant docs
- Evidence coverage (% of cited docs that actually contain the answer)
- Citation correctness (agent's claimed source matches the source)
- **One-hop coverage rate** — % of queries the Retrieval Orchestrator answers without falling through to agent drill-down

**Context efficiency**
- Average injected memory tokens per turn
- p95 injected tokens per turn
- **Bounded-prompt-scaling test** (from c137): median injected tokens at session counts of 1, 10, 30, 60. The curve should stay flat. Embedding-based approaches scale linearly here; Strata's structured-retrieval bet predicts a horizontal line.
- Prompt-cache hit rate (Anthropic-reported)
- Latency p50 / p95
- **Tokens per correct answer** — the cost-adjusted metric that ties accuracy to efficiency

### The vector-vs-no-vector spike

Two independent prior data points now favor no-vectors:

- **ByteRover** reports strong LoCoMo results with BM25 + LLM rerank only.
- **c137** hits 90.4% on LongMemEval-S (top-3) with *zero* embeddings — pure structured retrieval against an in-context memory map.

Before committing Strata to dense embeddings (an embedding-model dependency, an extra index, write-time embedding latency, and re-embed cost on schema changes), run a head-to-head:

| Configuration | Indexer cost | Setup |
|---|---|---|
| **A: BM25 only** | smallest | memsearch's BM25 path + summary-first |
| **B: BM25 + LLM rerank** | small + per-query LLM call | A + reranker on top-N |
| **C: BM25 + dense + RRF** | embedding model + vector index | full memsearch hybrid |
| **D: Structured / map-only** (c137-style) | none — map.md is the index | Retrieval Orchestrator over `system/map.md` + FTS escape valve |

**Acceptance criterion (tightened by c137 prior).** Default to the cheapest configuration that wins. C must beat the next-cheapest by **≥5 points** on LongMemEval-S *and* by a meaningful margin on bounded-prompt-scaling to justify the embedding dependency. Previous threshold was "within ~3 points"; the c137 result raises the bar — if structured retrieval is hitting 90% without vectors, vectors need to clearly earn their keep, not just tie.

If D outperforms A/B/C on either metric, the design moves further toward c137: vectors get cut entirely and the implementation collapses around `system/map.md` + the Retrieval Orchestrator. This decision is gated behind eval data, not opinion.

**Phase 3B partial result (2026-05-13).** A/B/C were exercised on 100-Q LongMemEval-S; **D was not yet built and remains the next spike.** Numbers: A (BM25-only) = 22.0%, B (BM25 + zerank-2) = 19.6%, C (BM25 + zembed-1 + RRF) = 13.0%. **C loses to A by 9 points** — comfortably outside the ≥5-point band, so the vector option is OUT. B also underperforms A by 2.4 points; the reranker doesn't earn its cost on this corpus either. Config D (Retrieval Orchestrator + `system/map.md`), the c137-style config, is the open question — a follow-up spike implements the map generator and the cheap-LLM orchestration stage, then re-runs against the same sample. Full report: `docs/plans/2026-05-13-memory-strata-vector-spike-report.md`.

**Phase 3C result (2026-05-13 initial round; 2026-05-14 follow-up).** The initial n=100 round with a Haiku-class orchestrator suggested D loses to A by 4 points; that conclusion did not survive scrutiny. Two follow-on experiments — (a) swapping the orchestrator model to **Grok 4.1 Fast** (c137's actual choice) and (b) running at **n=500 with an LLM-rewritten map** — flipped the binding. n=500 numbers:

- A (BM25-only): 20.6% accuracy, 41.8% recall@5, 70.0% correct-refusal.
- D (Grok orchestrator, original `firstSentence` map): 22.0% accuracy, 39.7% recall@5, 80.0% correct-refusal.
- E (D + BM25 fallback, original map): 24.0% accuracy, 47.6% recall@5, 76.7% correct-refusal.
- **E (D + BM25 fallback, Grok-rewritten map)**: **28.2% accuracy, 56.0% recall@5, 81.5% correct-refusal.**

**E with the LLM-rewritten map beats A by 7.6 points on accuracy and 14.2 points on recall@5 — clears the ≥5-point bar on both axes.** The c137-style retrieval orchestrator architecture *works*; the original n=100 binding was misled by Haiku-as-orchestrator and `firstSentence`-quality map summaries (both of which c137 specifically calls out as load-bearing). Map summary quality is now empirically confirmed as a primary lever, exactly as c137's premise predicted.

**Latency follow-up (2026-05-14).** A small `bench:latency` probe found the n=500 runs' ~7-8s p50 was an OpenRouter routing artifact, not Grok's actual latency. Direct xAI API access for the same model lands at p50 404ms / p95 646ms — ~27× faster than OpenRouter and faster than Haiku-via-Anthropic. The real orchestrator-vs-BM25 latency gap is **~5×, not 90×** (404ms vs 89ms). **The orchestrator architecture is viable as a default retrieval path**, provided production uses direct xAI access (or another low-latency provider) rather than OpenRouter's default routing. BM25-only remains a valid lower-latency fallback for surfaces where 300ms additional p50 latency is unacceptable. Full report: `docs/plans/2026-05-13-memory-strata-phase-3c-config-d-report.md`.

### Harness location

The eval harness lives in `packages/memory-strata/test/bench/` once the plugin exists. It runs on demand (during phase transitions, vendor-version changes, or before publishing benchmark numbers), **not on every CI build** — running LongMemEval-S in CI would burn LLM cost on every commit.

---

## Progressive Enhancement Path

The filesystem-first design allows incremental adoption:

```
LEVEL 0: Just hot tier files + conversation
         (Works with zero infrastructure—just read 4 .md files)
              │
              ▼
LEVEL 1: Add system/map.md + Observer for auto-extraction
         (One small LLM call per turn; c137-style index)
              │
              ▼
LEVEL 2: Add SQLite FTS5 index for keyword search
         (One pip install, zero config)
              │
              ▼
LEVEL 3: Add Retrieval Orchestrator (one-hop XML planner)
         (Cheap-model LLM call before main agent; c137-style)
         Phase 3C spike (2026-05-13 → 2026-05-14): E with Grok 4.1 Fast
         + LLM-rewritten map beat A by 7.6pp accuracy and 14.2pp
         recall@5 at n=500 — clears the ≥5-point bar on both axes.
         Architecture validated. Latency probe revealed OpenRouter's
         default routing was pathological (~11s p50); direct xAI runs
         the same model at ~404ms p50, a 5x gap vs BM25 (not 90x as
         the n=500 numbers suggested). Decision: orchestrator + LLM-
         rewritten map is a viable default retrieval path with direct
         xAI access; BM25-only remains a valid lower-latency fallback.
         See docs/plans/2026-05-13-memory-strata-phase-3c-config-d-report.md.
              │
              ▼
LEVEL 4: Add Consolidator for periodic maintenance
         (A cron job or session-end hook)
              │
              ▼
LEVEL 5: Add warm tier LRU cache + Promoter for access-pattern
         optimization (in-memory optimization)
              │
              ▼
LEVEL 6: Add LLM reranker for precision on top candidates
         (One more LLM call per retrieval)
              │
              ▼
LEVEL 7 (conditional, decided OUT 2026-05-13): vector embeddings + RRF.
         Phase 3B spike showed BM25-only beats BM25+dense+RRF by 9 points
         on LongMemEval-S — outside the ≥5-point band by 4 points. Two
         prior data points (c137, ByteRover) already suggested this; the
         spike confirmed. Strata production indexers stay vector-free.
         Don't reopen without a re-spike that contradicts these numbers.
         See `docs/plans/2026-05-13-memory-strata-vector-spike-report.md`.
```

You can stop at any level and have a functional system. Each level adds measurable improvement. Level 0–3 can be built in a few days and matches c137's architecture (map + one-hop retrieval + FTS escape valve, no embeddings). Level 4–5 is a solid production system. Level 6–7 is optimization, and Level 7 is conditional on evidence.

**The reordering vs the original (pre-c137) plan.** Previously, vector embeddings sat at Level 3 — early, before the Consolidator. After c137, vectors move to Level 7 and become conditional. The Retrieval Orchestrator (which the original plan didn't include) takes the old Level-3 slot. This reflects an honest reading of the data: structured retrieval against a good map outperforms hybrid retrieval against an unstructured corpus.

---

## Cold-Start: Bootstrapping with an Existing Corpus

If you already have thousands of markdown documents:

1. **Drop them into `docs/`** in the appropriate category folders.
2. **Run a bootstrap script** that:
   - Parses frontmatter (or generates it if missing, using an LLM to extract title/type/tags/summary)
   - Extracts section headers
   - Builds the FTS5 index over titles + body text
   - Generates embeddings for summaries + headers
   - Creates `_summary.md` for each folder
3. **The system is immediately usable.** No manual curation required.

For documents without frontmatter, the bootstrap can auto-generate it:

```python
def bootstrap_document(filepath):
    content = read_file(filepath)
    if not has_frontmatter(content):
        metadata = llm.extract(f"""
        Generate YAML frontmatter for this document:
        - id (slug from filename)
        - type (entity/knowledge/episode/procedure)
        - tags (3-5 relevant tags)
        - summary (1-2 sentence summary)
        - links (referenced entities/pages)

        Document: {content[:2000]}
        """)
        write_file(filepath, metadata + "\n---\n" + content)
    index_document(filepath)
```

---

## Open Considerations and Known Limitations

The following are real-world concerns that any production deployment should address:

### Measuring Memory Quality
There is no established standard for evaluating agent memory systems. Consider implementing:
- **Retrieval accuracy tests**: Known-answer queries against your corpus to track precision/recall over time
- **Observation quality audits**: Periodic human review of extracted observations vs. source conversations
- **Context utilization tracking**: Measure how often the agent uses injected memory vs. ignoring it

### Cost of Background LLM Calls
The Observer, Consolidator, and summary-generation processes all require LLM calls. At scale:
- **Observer**: ~1 call per turn (can be batched every N turns to reduce cost)
- **Consolidator**: Runs periodically, not per-turn; cost is amortized
- **Summary generation**: One-time per document change, not per query
- Use a smaller, cheaper model (e.g., a local model or a fast API tier) for extraction and summarization tasks

### Error Propagation from Incorrect Observations
If the Observer extracts an incorrect fact, the Consolidator may merge it into a canonical page. Mitigations:
- **Confidence scoring**: Low-confidence observations stay in the inbox longer before promotion
- **Provenance tracking**: Every fact in a document links back to its source conversation/message
- **Contradiction detection**: The Consolidator flags contradictions for review rather than silently overwriting
- **Human review surface**: Because everything is in readable markdown, errors can be caught by human inspection

### Versioning and Rollback
Because the canonical store is plain markdown files:
- **Git** provides full version history, diff, and rollback for free
- Frontmatter `updated` timestamps provide a lightweight audit trail
- The Consolidator can be configured to write changes as separate commits

### Multi-User and Multi-Tenant Isolation
Strata as described is single-user. For multi-tenant systems:
- Scope the entire `memory/` directory per user/tenant
- Add a `scope` field to frontmatter for shared vs. private documents
- Use metadata filters in retrieval to enforce access boundaries

### Embedding Model Selection
The choice of embedding model significantly impacts retrieval quality:
- For markdown-heavy corpora, models trained on diverse text (not just web prose) perform better
- Test with your actual documents; heading-heavy markdown may behave differently than prose
- Consider using different models for summaries vs. full-text if your corpus is heterogeneous

### Adversarial and Contradictory Inputs
The simple "newer wins" heuristic for contradictions is insufficient for adversarial scenarios. Consider:
- Requiring higher confidence thresholds for facts that contradict existing high-confidence entries
- Flagging frequent contradictions on the same topic for human review
- Maintaining a brief contradiction log in the document's frontmatter

### Latency Budgets
Approximate latencies for a well-implemented system:
- Hot memory read: <1ms
- Warm cache lookup: <1ms
- FTS5 keyword search: 5-50ms (10K docs)
- Vector search: 10-100ms (10K docs)
- RRF fusion + scoring: <5ms
- LLM reranker (optional): 200-500ms
- Observer extraction: 500-2000ms (async, not blocking response)
- Total retrieval latency (without reranker): **50-150ms**

### Future: Curator-as-Patch Pipeline

ChatGPT's MemFS-Lattice proposal (2026-05-10) splits the Consolidator into Observer → Curator → Reviewer, where the Curator emits a git diff that the Reviewer (auto-rules, human, or another LLM) approves before durable merge. Strata declines this for the MVP — the threats it addresses (hallucinated facts, prompt injection, sensitive data) are largely covered by the confidence threshold and the sensitive-content gate at much lower architectural cost (one pipeline vs three; one LLM call per consolidation vs two-to-three).

We will reopen the question when any of these lands:

- **User-facing memory governance:** admins or end-users explicitly want to review-before-commit, e.g. "show me what the agent is about to remember about me."
- **Evidence of bad observations causing real problems** in deployed agents — incident-driven, not speculative.
- **Multi-agent memory sharing:** when one agent's memory can affect another agent's decisions, the safety bar rises and a review gate becomes load-bearing rather than precautionary.

The pipeline shape is documented here so that, when those triggers arrive, we don't relitigate from scratch.

### Forgetting Policy

Most "forgetting" in Strata is implicit: facts get superseded (link forward), demoted (`importance` drops, retrieval ranks them down), or aged out of `inbox/` if never corroborated. None of these delete content — git history retains everything.

Hard deletion (privacy / compliance) is the explicit exception:

1. `git rm` the file from the working tree (Consolidator handles this when the agent calls `memory_forget(doc_id)`).
2. Remove derived index entries (`.strata/`).
3. For redaction beyond git, rewrite history (`git filter-repo` or equivalent) — only when compliance requires it; this rewrites the audit trail and breaks any downstream clones.
4. Leave a non-sensitive deletion marker in `tombstones/` if the agent or user benefits from knowing *that* something was forgotten without knowing what.

---

## Summary: What Strata Borrows From Each System

| System | Contribution to Strata |
|---|---|
| **Letta** | Three-tier hot/warm/cold architecture; always-in-context core memory; agent-controlled paging |
| **MemU** | Atomic fact deduplication, supersession, and conflict resolution in the Consolidator |
| **Mastra** | Passive observation extraction via the Observer—zero agent cognitive overhead |
| **LLM Wiki** | Markdown pages with frontmatter, cross-references (`[[links]]`), and folder hierarchy as the canonical store |
| **Hermes** | Category-specific organization; hierarchical folder summaries; `<scratchpad>` for temporary reasoning in hot memory |
| **AX Cortex** | Clean separation of memory interface from storage backend; pluggable provider pattern |
| **Supermemory** | Scoped retrieval APIs with rich metadata filters; robust ingestion pipeline pattern |
| **Hybrid RAG** | BM25 + vector + RRF fusion retrieval; multi-signal scoring (lexical, dense, recency, importance, scope) |

### In One Sentence

**Use markdown files as the source of truth, passive observation extraction feeding an inbox-to-document consolidation pipeline, a tiny always-in-context hot tier with a scratchpad, hybrid retrieval that injects summaries first and drills down on demand, and let the agent optionally edit its own memory—all backed by nothing more than a filesystem and SQLite.**




# KV Cache Optimization for Strata

## How LLM KV Caching Works (Quick Primer)

During inference, the LLM computes **key** and **value** attention tensors for every input token. These are expensive to compute but can be **reused** if the same token prefix appears again. The critical rule:

> **The KV cache is valid only for an exact prefix match.** If any token changes at position $n$, every cached entry from position $n$ onward is invalidated.

This means **prompt ordering is the single most important optimization lever**. Stable content must come first; volatile content must come last.

Providers handle this differently:

| Provider | Mechanism | Savings |
|---|---|---|
| Anthropic | Explicit cache breakpoints (`cache_control`) | 90% off cached input tokens |
| OpenAI | Automatic prefix matching | 50% off cached input tokens |
| Google (Gemini) | Context caching API | Reduced per-token cost for cached prefix |
| Self-hosted (vLLM, SGLang) | Automatic prefix/radix caching | Zero recomputation for matched prefix |

---

## The Problem: Strata's Current Prompt Layout Wastes Cache

The original Strata prompt assembly looks like this:

```
┌─────────────────────────────────┐
│ System prompt (from agent.md)   │  ← Stable across sessions
│ <scratchpad>...</scratchpad>    │  ← Changes EVERY turn ← 💥 CACHE BREAK
├─────────────────────────────────┤
│ User profile (from user.md)     │  ← Recomputed despite being stable
│ Session summary (session.md)    │  ← Recomputed despite slow change
│ Retrieved memory summaries      │  ← Recomputed (expected)
├─────────────────────────────────┤
│ Conversation (last N messages)  │  ← Grows each turn
│ Tools                           │  ← Recomputed despite being static
└─────────────────────────────────┘
```

The scratchpad sits inside the system prompt and changes every turn. This **invalidates the cache for everything after it**—including the user profile, session context, and tool definitions, all of which are stable. Every turn reprocesses thousands of tokens that haven't changed.

---

## The Fix: Cache-Aware Prompt Segmentation

Restructure the prompt into **stability zones**, ordered from most stable to least stable:

```
┌─────────────────────────────────────────────────────────┐
│  ZONE 1: STATIC PREFIX                                   │
│  Changes: never (or on deployment)                       │
│  ┌────────────────────────────────────────────────────┐  │
│  │ System prompt (persona from agent.md)              │  │
│  │ Tool definitions                                   │  │
│  │ Memory system instructions                         │  │
│  └────────────────────────────────────────────────────┘  │
│  ◆ CACHE BREAKPOINT 1                                    │
├──────────────────────────────────────────────────────────┤
│  ZONE 2: SESSION-STABLE PREFIX                           │
│  Changes: rarely (when user profile updates)             │
│  ┌────────────────────────────────────────────────────┐  │
│  │ User profile (from user.md)                        │  │
│  │ Pinned context documents (if any)                  │  │
│  └────────────────────────────────────────────────────┘  │
│  ◆ CACHE BREAKPOINT 2                                    │
├──────────────────────────────────────────────────────────┤
│  ZONE 3: SLOW-CHANGING                                   │
│  Changes: every 5-10 turns                               │
│  ┌────────────────────────────────────────────────────┐  │
│  │ Session summary (from session.md)                  │  │
│  └────────────────────────────────────────────────────┘  │
│  ◆ CACHE BREAKPOINT 3                                    │
├──────────────────────────────────────────────────────────┤
│  ZONE 4: PER-TURN VOLATILE                               │
│  Changes: every turn (never cached)                      │
│  ┌────────────────────────────────────────────────────┐  │
│  │ Retrieved memory summaries (from hybrid search)    │  │
│  │ <scratchpad>...</scratchpad>                        │  │
│  │ Conversation messages (growing window)             │  │
│  └────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### What Changed

| Element | Before | After | Why |
|---|---|---|---|
| **Tool definitions** | End of prompt | Zone 1 (top) | Completely static—cache once, reuse forever |
| **`<scratchpad>`** | Inside system prompt (Zone 1) | Zone 4 (bottom) | Changes every turn; was breaking the entire cache |
| **User profile** | After scratchpad | Zone 2 | Rarely changes; now benefits from Zone 1 cache |
| **Session summary** | Mixed with volatile content | Zone 3 (own breakpoint) | Only changes every 5-10 turns; gets its own cache segment |
| **Retrieved memories** | Middle of memory block | Zone 4 | Truly per-turn; correctly placed in the volatile zone |

---

## Token Cost Analysis

Consider a typical Strata prompt over a 20-turn conversation:

| Zone | Tokens | Stability | Turns cached | Recomputed turns |
|---|---|---|---|---|
| Zone 1: Static prefix | ~800 | Permanent | 20/20 | 0 |
| Zone 2: User profile + `map.md` | ~2300 | Session-stable; map invalidates on doc add/remove (~5% of turns) | ~19/20 | 1 (first turn) + occasional |
| Zone 3: Session summary | ~400 | Every ~5 turns | ~16/20 | ~4 |
| Zone 4: Volatile | ~1000 | Every turn | 0/20 | 20 |
| **Total per turn** | **~4500** | | | |

### Without KV Cache (Baseline)

$$\text{Total input tokens} = 4500 \times 20 = 90{,}000 \text{ tokens}$$

### With Cache-Aware Layout (Anthropic Pricing: 90% discount on cached)

For each turn, the effective cost in "full-price token equivalents":

$$\text{Turn cost} = \underbrace{800 \times 0.1}_{\text{Zone 1 cached}} + \underbrace{2300 \times p_2}_{\text{Zone 2}} + \underbrace{400 \times p_3}_{\text{Zone 3}} + \underbrace{1000 \times 1.0}_{\text{Zone 4 full}}$$

Where $p_2 \approx 0.1$ for 95% of turns (cached; map.md is content-hashed and only invalidates on doc add/remove), and $p_3 \approx 0.1$ for 80% of turns. Map invalidations cost the full Zone 2 + Zone 3 prefix re-encoding.

**Average turn:** $80 + 240 + 40 + 1000 = 1{,}360$ effective tokens
**Over 20 turns:** $\approx 27{,}200$ effective tokens

$$\boxed{\text{Savings} \approx 70\%}$$

The map.md addition increases the cached prefix and *improves* the cache ratio. It also costs a Zone 2 invalidation when docs are added/removed — keeping consolidation passes batched (not per-turn) keeps that rare.

And this is just the main agent loop—the same principle applies to Observer and Consolidator calls.

---

## Detailed Implementation

### Cache-Aware Prompt Builder

```python
class CacheAwarePromptBuilder:
    """
    Assembles the Strata prompt in cache-optimal order.
    Each zone is a separate message block with cache control.
    """

    def __init__(self, strata: StrataMemory):
        self.strata = strata
        self._zone1_hash = None  # Track changes for cache invalidation
        self._zone2_hash = None
        self._zone3_hash = None
        self._zone3_update_counter = 0

    def build_messages(self, query: str, conversation: list[Message]) -> list[dict]:
        messages = []

        # ── ZONE 1: Static prefix (cached across all sessions) ──
        zone1_content = self._build_zone1()
        messages.append({
            "role": "system",
            "content": zone1_content,
            "cache_control": {"type": "ephemeral"}  # Anthropic-style breakpoint
        })

        # ── ZONE 2: Session-stable (cached within session) ──
        zone2_content = self._build_zone2()
        messages.append({
            "role": "system",
            "content": zone2_content,
            "cache_control": {"type": "ephemeral"}
        })

        # ── ZONE 3: Slow-changing session summary ──
        zone3_content = self._build_zone3()
        messages.append({
            "role": "system",
            "content": zone3_content,
            "cache_control": {"type": "ephemeral"}
        })

        # ── ZONE 4: Per-turn volatile (never cached) ──
        zone4_content = self._build_zone4(query)
        messages.append({
            "role": "system",
            "content": zone4_content
            # No cache_control — this changes every turn
        })

        # ── Conversation messages ──
        # Previous turns benefit from KV cache automatically
        # (each turn extends the prefix by 2 messages)
        messages.extend(self._format_conversation(conversation))

        return messages

    def _build_zone1(self) -> str:
        """Static: persona + tools + memory instructions. Changes on deployment only."""
        return f"""{self.strata.read('system/agent.md')}

## Memory System
You have access to a large markdown knowledge base. Memory tools:
{self._format_tool_descriptions()}

## Instructions
- Relevant document summaries are provided below. Use memory_read_section
  to drill into specific sections when summaries aren't enough.
- Use the <scratchpad> to track your reasoning. It resets each task.
- Save important new information with memory_note."""

    def _build_zone2(self) -> str:
        """Session-stable: user profile + pinned docs."""
        parts = [f"## User Profile\n{self.strata.read('system/user.md')}"]

        pinned = self.strata.promoter.get_pinned_docs()
        if pinned:
            parts.append("## Pinned Context")
            for doc in pinned[:3]:  # Limit pinned docs
                parts.append(f"### {doc.title}\n{doc.summary}")

        return "\n\n".join(parts)

    def _build_zone3(self) -> str:
        """Slow-changing: session summary. Updated every N turns, not every turn."""
        return f"## Session Context\n{self.strata.read('system/session.md')}"

    def _build_zone4(self, query: str) -> str:
        """Per-turn volatile: retrieved memories + scratchpad."""
        # Hybrid search for relevant documents
        results = self.strata.retriever.search(query, top_k=5, mode="summary")

        parts = []
        if results:
            parts.append("## Relevant Documents")
            for r in results:
                parts.append(f"- **{r.title}** ({r.type}): {r.summary}")

        parts.append(f"\n<scratchpad>\n{self.strata.scratchpad}\n</scratchpad>")

        return "\n".join(parts)
```

### Deferred Session Summary Updates

A key optimization: **don't update `session.md` every turn**. Each update shifts Zone 3 content and invalidates its cache. Instead, buffer updates:

```python
class DeferredSessionUpdater:
    """
    Buffers conversation turns and only updates session.md
    every N turns, to preserve Zone 3 cache validity.
    """

    def __init__(self, observer: Observer, flush_interval: int = 5):
        self.observer = observer
        self.flush_interval = flush_interval
        self.buffer: list[Message] = []
        self.turn_count = 0

    def on_turn(self, user_msg: Message, assistant_msg: Message):
        self.buffer.append(user_msg)
        self.buffer.append(assistant_msg)
        self.turn_count += 1

        if self.turn_count % self.flush_interval == 0:
            self.flush()

    def flush(self):
        """Compress buffered turns into session.md."""
        if not self.buffer:
            return

        current_summary = self.observer.strata.read("system/session.md")
        new_summary = self.observer.update_session_summary(
            self.buffer, current_summary
        )
        self.observer.strata.write("system/session.md", new_summary)
        self.buffer.clear()
        # Zone 3 cache will be invalidated on next prompt build —
        # but this only happens every N turns, not every turn

    def on_session_end(self):
        """Always flush remaining buffer at session end."""
        self.flush()
```

The conversation messages themselves still grow each turn (in Zone 4), so the LLM always sees recent messages. The session summary is just the *compressed* history of older turns—it doesn't need to be real-time.

---

## Multi-Turn Conversation Cache Stacking

Beyond the zone-level optimization, there's a second layer of savings from **conversation prefix caching**. Each turn, the conversation grows by two messages (user + assistant). The KV cache from turn $N$ naturally extends to turn $N+1$:

```
Turn 1:  [Zone1 | Zone2 | Zone3 | Zone4 | User₁]
Turn 2:  [Zone1 | Zone2 | Zone3 | Zone4'| User₁ | Asst₁ | User₂]
                                    ↑
                          Zone 4 changed (new retrieval results),
                          but Zones 1-3 are still cached.

Turn 3:  [Zone1 | Zone2 | Zone3 | Zone4'| User₁ | Asst₁ | User₂ | Asst₂ | User₃]
                                    ↑
                          If Zone 4 happens to be identical
                          (same retrieval results), the entire
                          prefix including conversation is cached.
```

When Zone 4 changes (which it usually does—different retrieval results each turn), conversation history from prior turns must be reprocessed. But Zones 1–3 remain cached regardless. The worst case is reprocessing Zone 4 + conversation each turn, which is exactly the volatile portion we've already budgeted for.

**However**, there's an optimization opportunity: if you can make Zone 4 *more stable*, the conversation history itself gets cached too.

### Stabilizing Zone 4 With Lazy Retrieval

Instead of auto-injecting search results every turn, inject a **stable placeholder** and let the agent call `memory_search` only when it needs to:

```python
def _build_zone4_lazy(self) -> str:
    """Minimal volatile zone — no auto-retrieval."""
    return f"""<scratchpad>
{self.strata.scratchpad}
</scratchpad>

Use memory_search if you need information not already in context."""
```

**Trade-off:**

| Strategy | Zone 4 stability | Cache benefit | Retrieval quality |
|---|---|---|---|
| **Auto-inject summaries** | Low (changes every turn) | Zones 1-3 cached | Better—agent always sees relevant context |
| **Lazy retrieval** | High (only scratchpad changes) | Zones 1-3 + conversation cached | Depends on agent proactively searching |
| **Hybrid: inject only if high-confidence** | Medium | Moderate | Good balance |

The hybrid approach is often best:

```python
def _build_zone4_hybrid(self, query: str) -> str:
    """Only inject results if retrieval confidence is high."""
    results = self.strata.retriever.search(query, top_k=3, mode="summary")

    # Only inject if top result is clearly relevant
    high_conf = [r for r in results if r.score > 0.75]

    parts = [f"<scratchpad>\n{self.strata.scratchpad}\n</scratchpad>"]

    if high_conf:
        parts.append("## Relevant Documents")
        for r in high_conf:
            parts.append(f"- **{r.title}**: {r.summary}")
    else:
        parts.append("No documents auto-retrieved. Use memory_search if needed.")

    return "\n".join(parts)
```

---

## Caching the Background Processes

The main agent loop isn't the only place to save tokens. The Observer, Consolidator, and optional reranker all make LLM calls with highly repetitive prefixes.

### Observer Prompt Caching

The Observer's extraction prompt has a stable instruction prefix:

```python
class CacheAwareObserver(Observer):
    """
    The extraction system prompt is identical every call.
    Only the conversation content changes.
    """

    def _build_extraction_messages(self, messages: list[Message]) -> list[dict]:
        return [
            {
                # ── STABLE PREFIX (cached across all Observer calls) ──
                "role": "system",
                "content": """You are a memory extraction system. Extract
noteworthy facts from conversations.

Return JSON array of observations:
- fact: one atomic sentence
- subject: entity name or "general"
- type: entity | knowledge | episode | procedure
- confidence: high | medium | low

Rules:
- Only extract durable, non-obvious facts
- Prefer specific over vague
- One fact per observation
- Skip greetings and filler""",
                "cache_control": {"type": "ephemeral"}
            },
            {
                # ── VOLATILE: the actual conversation ──
                "role": "user",
                "content": f"Extract observations:\n\n{format_messages(messages)}"
            }
        ]
```

The system prompt (~150 tokens) is cached across every Observer invocation. Over 20 turns, that's $150 \times 19 = 2{,}850$ tokens saved at 90% discount.

### Consolidator Prompt Caching

Same principle—the consolidation instructions are stable:

```python
class CacheAwareConsolidator(Consolidator):

    SYSTEM_PROMPT = """You are a memory consolidation system.

Given a set of new observations and an existing document, you must:
1. Identify duplicate facts (same meaning, different wording)
2. Identify contradictions (newer fact supersedes older)
3. Merge new unique facts into the appropriate section
4. Regenerate the frontmatter summary
5. Update [[wiki-links]] if new entities are mentioned

Output the updated document in full."""  # ~100 tokens, cached

    def consolidate_document(self, doc: Document, new_observations: list) -> str:
        return llm.call([
            {
                "role": "system",
                "content": self.SYSTEM_PROMPT,
                "cache_control": {"type": "ephemeral"}
            },
            {
                "role": "user",
                "content": f"## Existing Document\n{doc.full_text}\n\n"
                           f"## New Observations\n{format_observations(new_observations)}"
            }
        ])
```

---

## KV Cache Warming for the Warm Tier

Here's a more advanced optimization that ties the Strata warm tier directly to the KV cache. The idea: **pre-compute KV cache entries for documents most likely to be needed next**.

### Predictive Cache Warming

```python
class PredictiveCacheWarmer:
    """
    After each turn, predict which documents are likely needed next
    and pre-warm them in the KV cache by making a dummy prefill call.

    Works best with self-hosted inference (vLLM/SGLang) where you
    control the KV cache directly.
    """

    def __init__(self, strata: StrataMemory, inference_client):
        self.strata = strata
        self.client = inference_client

    def warm_after_turn(self, current_context: list[dict]):
        """
        Pre-compute KV cache for anticipated next-turn prompts.
        """
        # Predict likely next retrievals based on:
        # 1. Documents linked from currently-retrieved docs
        # 2. Documents in the same folder
        # 3. Access pattern predictions

        candidates = self.predict_next_docs(current_context)

        for doc in candidates[:2]:  # Warm top 2 predictions
            # Build the hypothetical prompt prefix that would include
            # this document's summary in Zone 4
            hypothetical_zone4 = self._build_zone4_with_doc(doc)

            # Make a prefill-only call (no generation) to populate KV cache
            # This is provider-specific
            self.client.prefill(
                messages=current_context[:3] + [  # Zones 1-3 (already cached)
                    {"role": "system", "content": hypothetical_zone4}
                ]
            )

    def predict_next_docs(self, context) -> list[Document]:
        """Simple heuristic: follow wiki-links from retrieved docs."""
        retrieved_ids = self.extract_retrieved_doc_ids(context)
        linked_ids = set()
        for doc_id in retrieved_ids:
            doc = self.strata.load_doc(doc_id)
            linked_ids.update(doc.frontmatter.get('links', []))

        return [self.strata.load_doc(lid) for lid in linked_ids
                if lid not in retrieved_ids]
```

This is speculative and wastes compute if the prediction is wrong, so it's only worthwhile for self-hosted setups where unused KV cache entries are cheap. With API providers, you'd pay for the prefill tokens.

---

## Provider-Specific Implementation Notes

<details>
<summary><strong>Anthropic (Claude) — Explicit cache breakpoints</strong></summary>

Anthropic gives you the most control. You explicitly mark cache breakpoints with `cache_control`:

```python
def build_anthropic_messages(self, query, conversation):
    return {
        "system": [
            {   # Zone 1
                "type": "text",
                "text": self._build_zone1(),
                "cache_control": {"type": "ephemeral"}
            },
            {   # Zone 2
                "type": "text",
                "text": self._build_zone2(),
                "cache_control": {"type": "ephemeral"}
            },
            {   # Zone 3
                "type": "text",
                "text": self._build_zone3(),
                "cache_control": {"type": "ephemeral"}
            },
            {   # Zone 4 (no cache control)
                "type": "text",
                "text": self._build_zone4(query)
            }
        ],
        "messages": self._format_conversation(conversation)
    }
```

- Cached tokens: **90% discount** on input pricing
- Cache lifetime: ~5 minutes (refreshed on each hit)
- Maximum 4 breakpoints per request

</details>

<details>
<summary><strong>OpenAI — Automatic prefix caching</strong></summary>

OpenAI automatically caches any prefix ≥1024 tokens that repeats across requests. You don't mark breakpoints—you just ensure prefix stability:

```python
def build_openai_messages(self, query, conversation):
    # Key: keep the first 1024+ tokens identical across turns
    # Zone 1 + Zone 2 + Zone 3 should exceed 1024 tokens
    messages = [
        {"role": "system", "content": self._build_zone1()},  # ~800 tok
        {"role": "system", "content": self._build_zone2()},  # ~300 tok
        # ↑ These 1100 tokens are automatically cached
        {"role": "system", "content": self._build_zone3()},
        {"role": "system", "content": self._build_zone4(query)},
    ]
    messages.extend(self._format_conversation(conversation))
    return messages
```

- Cached tokens: **50% discount** on input pricing
- Prefix must be ≥1024 tokens and match exactly
- Caching is automatic and invisible

</details>

<details>
<summary><strong>Self-hosted (vLLM / SGLang) — Radix attention / prefix caching</strong></summary>

Self-hosted gives the deepest control. vLLM's automatic prefix caching and SGLang's RadixAttention both cache KV states for shared prefixes:

```python
# SGLang example: explicit prefix sharing
import sglang as sgl

@sgl.function
def strata_agent(s, zone1, zone2, zone3, zone4, conversation):
    # fork() creates a shared prefix that's computed once
    s += sgl.system(zone1)       # Shared across ALL requests
    s += sgl.system(zone2)       # Shared within session
    s += sgl.system(zone3)       # Shared within summary window
    s += sgl.system(zone4)       # Per-turn
    for msg in conversation:
        s += sgl.user(msg.user) if msg.role == "user" else sgl.assistant(msg.text)
    s += sgl.assistant(sgl.gen("response"))
```

- Cached tokens: **zero recomputation cost** (already in GPU memory)
- Cache eviction: LRU-based; larger GPU memory = more cache
- You can explicitly pre-warm entries with prefill-only calls

</details>

---

## Full Cost Model

Here's the complete picture for a 20-turn conversation, comparing no caching vs. the cache-aware layout, using Anthropic pricing as the example:

### Main Agent Loop

| Component | Tokens/turn | Turns recomputed | Effective tokens (cached) | Effective tokens (no cache) |
|---|---|---|---|---|
| Zone 1 (static) | 800 | 1 of 20 | $800 + 19 \times 80 = 2{,}320$ | $16{,}000$ |
| Zone 2 (session-stable) | 300 | 1 of 20 | $300 + 19 \times 30 = 870$ | $6{,}000$ |
| Zone 3 (summary, every 5) | 400 | 4 of 20 | $4 \times 400 + 16 \times 40 = 2{,}240$ | $8{,}000$ |
| Zone 4 (volatile) | 600 | 20 of 20 | $12{,}000$ | $12{,}000$ |
| Conversation (avg) | 400 | 20 of 20 | $8{,}000$ | $8{,}000$ |
| **Total** | | | **$25{,}430$** | **$50{,}000$** |

### Background Processes (Observer)

| Component | Tokens/call | Calls | Cached prefix | Savings |
|---|---|---|---|---|
| Observer system prompt | 150 | 20 | 19 calls cached | $150 + 19 \times 15 = 435$ vs. $3{,}000$ |
| Observer conversation payload | ~300 | 20 | Never cached | $6{,}000$ (same) |

### Combined

$$\text{Total without cache} \approx 53{,}000 \text{ effective tokens}$$

$$\text{Total with cache-aware layout} \approx 31{,}865 \text{ effective tokens}$$

$$\boxed{\text{Overall savings} \approx 40\%}$$

And this is the *conservative* estimate. In longer sessions (50+ turns), Zone 1 and Zone 2 amortize further, pushing savings toward 50–60%.

---

## Summary: Changes to Strata for KV Cache Optimization

| Change | Effort | Impact |
|---|---|---|
| **Reorder prompt: stable prefix first, volatile last** | Trivial (rearrange strings) | Highest — enables all other caching |
| **Move scratchpad from system prompt to Zone 4** | Trivial | High — unblocks Zone 1-2 caching |
| **Move tool definitions into Zone 1** | Trivial | Medium — tools are ~200 tokens, fully cacheable |
| **Defer session.md updates to every 5 turns** | Easy (buffer + counter) | Medium — preserves Zone 3 cache 80% of turns |
| **Add `cache_control` breakpoints (Anthropic)** | Easy (add field to messages) | High — activates 90% discount |
| **Cache Observer/Consolidator system prompts** | Easy (same pattern) | Low-Medium — saves ~15% on background calls |
| **Hybrid auto-injection (confidence threshold)** | Medium (scoring logic) | Medium — stabilizes Zone 4 for better conversation caching |
| **Predictive cache warming** | Hard (self-hosted only) | Low-Medium — speculative, hard to measure |

The first four changes are almost free to implement and deliver the vast majority of the savings. Start there.
