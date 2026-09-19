# TASK-405 — the agent bubble renders markdown, and find still tells the truth

## What the card said, and what is actually true

The card says assistant **newlines** are lost because `AgentConversation.tsx:796`
sets `white-space: normal`.

**Both halves of that are wrong, and the predecessor note on the card is right.**

1. There is no `white-space` declaration anywhere in `AgentConversation.tsx` —
   `grep -n 'white-space\|whitespace' ` finds only `whitespace-nowrap` on the find
   bar's counter and `whitespace-pre-line` in `AgentView`. The `white-space: normal`
   the card is thinking of is `index.css:298`, `.msg-body .aui-md { white-space:
   normal; }`, which belongs to **`/chat`**, is deliberate, and is not on this
   surface at all (the workspace view is not inside `.msg-body`).
2. Newlines are not the bug, they are one symptom of it. The assistant bubble
   renders `m.text` as a **raw string** through `FindHighlight`. Nothing parses it.
   So tables, `**bold**`, lists, headings and `![img]()` are all literal too —
   exactly what the TASK-357 re-walk measured. `white-space: normal` is the
   browser default here, not a setting somebody chose.

Scope, therefore: **the assistant bubble does not render markdown.**

## The other surface, and which one is right

`/chat` renders assistant text through `MarkdownText` → `MarkdownTextPrimitive`
(`react-markdown` + `remark-gfm`). The workspace agent view renders a bare string.
`/chat` is right; the agent view is the surviving surface (TASK-359/360 delete
`/chat`), so we converge the agent view **toward** `/chat`'s pipeline.

We cannot literally reuse `MarkdownText`: `MarkdownTextPrimitive` takes its text
from `useMessagePartText()` and drops `children`, so it only works inside a mounted
assistant-ui thread. `components/Markdown.tsx` already exists for exactly this —
"THIS IS NOT A SECOND MARKDOWN PIPELINE… the same `react-markdown` with
`remark-gfm`" — and is already used by the workspace Files tab. That is the
convergence point.

Two deliberate differences from `/chat`, both inherited from `Markdown.tsx` and
both kept:

- **`img` renders as its alt text, not as an image.** Assistant text is model
  output. A remote `<img>` in it is an outbound request the reader's browser makes
  on the model's behalf — a beacon that can carry conversation text in its query
  string. `/chat` allows it; that is `/chat`'s pre-existing hole, filed as a
  follow-up, not widened here (invariant 5).
- **`ax://artifact/` is not widened into a chip.** That widening needs an
  assistant-ui thread in scope to resolve the artifact against; there isn't one
  here, so the URL falls to the safe-protocol filter and blanks.

**Soft breaks stay soft.** A single `\n` inside a paragraph is a CommonMark soft
break and renders as a space, here and in `/chat`. Blank-line paragraphs, lists,
tables and headings are what actually carry "line structure" in model output, and
those now render. Adding `remark-breaks` would diverge from `/chat` on the one axis
we are converging.

## The hard part: find must not start lying

`#601`'s rule — the reported count and the rendered `<mark>` count are two readings
of ONE `findRanges` result — is the thing most easily broken here. `findRanges`
runs over the **markdown source**; the marks now have to land inside **rendered
text nodes**, which are a subset of it (`**` is not rendered; neither are `|`,
fences, or link destinations).

### The invariant we hold instead

> A match is counted **iff** it lies wholly inside one rendered text run.

One function, `markdownFindRanges`, decides that, and both the index and the
renderer call it. Nothing else is allowed to compute ranges for a markdown field.

### Why the two sides provably agree

The index parses to **mdast** and takes every `text` node whose
`source.slice(start, end) === node.value`. The renderer's rehype plugin sees
**hast** and takes every `text` node with the same predicate. Measured (probe over
a document with bold, a GFM table, a list, inline code, a link, an image, a fenced
block, backslash escapes and an entity):

```
mdast-ok: 0-8,10-14,16-22,26-27,30-31,46-47,50-51,57-65,68-76,78-85,96-103,104-108,125-131,159-160
hast-ok : 0-8,10-14,16-22,26-27,30-31,46-47,50-51,57-65,68-76,78-85,96-103,104-108,125-131,159-160
MATCH: true
```

The slice-equality guard is what makes it hold: inline code, fenced code and
anything containing a backslash escape or a character reference have
`value !== slice`, so **both** sides drop them together. They are never counted and
never marked.

### The accepted gap, stated plainly

Text that is rendered but is not an mdast `text` node — an image's alt text, the
inside of a code span or fence, a paragraph containing `\*` or `&amp;` — is
**visible but not findable**. That is an under-count, never an over-count: the bar
can never name a match the reader cannot see. Same class of accepted gap as the
collapsible `steps` panel and a grant's description, and documented in the same
place.

## Tasks

1. **`lib/markdown-find.ts`** (new) — `markdownTextRuns(source)` (memoized parse,
   `unified().use(remarkParse).use(remarkGfm)`), `markdownFindRanges(source,
   query)`, and `markdownHighlight()` — the rehype plugin factory that splits hast
   text nodes into `<mark>`s from the *same* range list. Unit tests.
2. **`components/Markdown.tsx`** — accept an optional `rehypePlugins`. No behaviour
   change for existing callers.
3. **`lib/thread-find.ts`** — `FindField` gains `markdown?: boolean`;
   `buildFindIndex` routes markdown fields through `markdownFindRanges`. `agent`
   and `steps` turns are markdown; `user` and `fold` are not.
4. **`components/workspace/ThreadFind.tsx`** — `FindHighlight` gains `markdown`,
   rendering `<Markdown>` (plugin attached only when this field has matches).
5. **`AgentConversation.tsx`** — the assistant arm passes `markdown`.
6. **Tests** — a failing-first markdown render test, count-vs-marks over markdown
   (including a `**`-only query, which must be 0 and 0), and the `ResizeObserver`
   re-pin path from #592, which no test has ever executed (jsdom's stub is a no-op).

### YAGNI pass

| Task | Load-bearing at MVP? |
|---|---|
| 1 | Yes — it is the whole fix. |
| 2 | Yes — without it the marks cannot reach the renderer. |
| 3 | Yes — otherwise the count out-runs the marks. |
| 4, 5 | Yes — the wiring. |
| 6 | Yes — Bug Fix Policy, and the count/mark claim is worthless unasserted. |

Cut: `remark-breaks`; a `/chat` image policy change; user-bubble newline
preservation. All follow-ups.

## Boundary review

No hook surface changes. No IPC. Client-only rendering. N/A.

## Dependencies

`unified@^11.0.5` and `remark-parse@^11.0.0` become **direct** devDependencies of
`@ax/channel-web`. Both are already in the lockfile at those exact versions as
transitive dependencies of `react-markdown@10.1.0`, which is what resolves them
today; nothing new enters the tree. See the security note in the PR.
