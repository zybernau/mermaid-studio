# Mermaid Design — Extend Plan Progress

Working notes for `extend-plan.md` (two-way editing). Source of truth is the
text; visual edits are targeted character-range splices.

## Testing

```
npm install            # normal npm install
./scripts/install-browsers.sh  # Chromium into .playwright-browsers (sandbox-writable)
npm test               # vitest, unit + fixture tests
npm run test:e2e       # playwright, needs a running dev server (auto-started)
```

Playwright's default `~/Library/Caches/ms-playwright` is not writable in this
sandbox, so browsers live in `.playwright-browsers/` via `PLAYWRIGHT_BROWSERS_PATH`.
That directory is gitignored.

## Fixtures

`fixtures/*.mmd` — 15 files: simple, chains, groups, inline-labels, subgraphs,
comments, odd-spacing, styled, shapes, directions, cycle, long-labels,
empty, big (60 nodes), invalid.

## Progress

- [x] Step 0: Vitest + happy-dom + Playwright + fixtures, `npm test` green.
- [x] Step 1: parser with ranges.
- [x] Step 2: SVG -> model id map.
- [x] Step 3: bidirectional selection.
- [x] Step 4: patch engine (fuzzed against real `mermaid.parse`).
- [ ] Step 5: double-click inline rename + auto-quoting.
- [ ] Steps 6-9: usability polish, <300 ms re-render.

## Risk notes

- Mermaid pinned to 11.17.2; a test hard-fails if SVG id patterns change.
  Verified against the real bundle:
  - node   `flowchart-A-0`
  - edge   `L_A_B_0` — **underscores**, not the `L-A-B-0` dashes the plan assumed.
  - cluster `-<id>`
- `mermaid.parse` needs a DOM -> unit tests use happy-dom; real render
  assertions go in Playwright.
- PNG export is browser-only (`new Image()` + canvas) and stays out of Node tests.

## Label escaping — verified against the real renderer

Mermaid's lexer rejects many characters that look like plain text, so
`src/lib/flowchart/quote.ts` entity-escapes them. The rules are not guessable;
each was pinned by rendering in a browser (`tests/e2e/entities.spec.ts`).

**Use named entities, never numeric.** Mermaid 11.17.2 parses numeric entities
fine but renders them wrong: the `;` is dropped and the `&` survives, so
`&#40;` comes out as a bare `&`. `A -->|paren &#40;ok&#41;| B` therefore
displays `paren &(ok&)`. Named `&lpar;` renders a real `(`.

What must be escaped, and where:

| Context | Rejected literally | Escaped to |
| --- | --- | --- |
| Edge label `\|…\|` | `( ) { } [ ] \| @` | `&lpar; &rpar; &lbrace; &rbrace; &lsqb; &rsqb; &vert; &commat;` |
| Edge label / node label | `"` (see below) | `&quot;` |
| Either | a stray `&` | `&amp;` |

Two lexer traps worth remembering:

- `\"` is only legal as the *closing* quote, so `A["He said \"hi\""]` parses
  but `A["a \"b\" c"]` errors with `got 'STR'`. There is no backslash escape
  for a mid-label quote — `&quot;` is the only form Mermaid renders everywhere.
- An edge label must sit **immediately** after its arrow. `A --> |x|   B` is a
  parse error; `A -->|x| B` is fine.

Both escaping helpers are idempotent, so re-labelling an already-escaped edge
never accumulates `&amp;quot;`. The fuzzer (`tests/fuzz-mermaid.test.ts`)
re-parses every patch's output with real `mermaid.parse`, which is what caught
these — our own parser is deliberately more permissive than Mermaid and would
pass all of them.

The fuzzer's label pool includes `a[b]` and `a{b}`, which exercises every
bracket entity end-to-end; the explicit render checks in `entities.spec.ts`
cover `&quot;`, `&amp;`, `&lpar;`, `&rpar;`, `&vert;`, `&commat;` and the
numeric-entity regression.
