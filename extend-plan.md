## Goal
Make the preview **two-way**: edit the diagram visually (move, rename, add, delete, reconnect, restyle) and the Mermaid script updates automatically, while typing in the script still updates the diagram.

## The key design decision
Mermaid renders SVG but gives you no editable model. So you need your own layer:

```
 .mmd text  ⇄  Parser  ⇄  Diagram model (JSON)  →  Mermaid render → SVG
                                 ↑
                      visual actions (click, drag, menu)
```

- **Source of truth = the text.** Visual edits are applied as *targeted text patches* (not full regeneration), so comments, spacing, and unsupported syntax survive.
- **Scope v1 to flowcharts only** (`flowchart`/`graph`). Add sequence, ER, etc. later. Trying to cover all diagram types at once is the main way this project fails.

---

## The mode model — exactly ONE edit mode

Most of the failure modes in this phase come from inventing modes. The rule for
this project:

> **There is one `editMode` flag. Everything visual is gated on it. No other
> mode may exist.**

`editMode: boolean` is the *only* state that decides whether the diagram is
editable. It is **not** a per-tool mode. There is deliberately no
`tool: 'select' | 'connect' | 'delete' | 'style'` state — that is the trap.
Which operation a click performs is derived from **what is selected** and
**what is hovered**, never from a mode variable.

### Toggling
- Toolbar toggle labelled **Edit diagram**, plus the `E` key.
- Leaving edit mode clears selection and any in-progress drag.

### What each state does

| | `editMode = false` (view) | `editMode = true` |
| --- | --- | --- |
| Wheel / drag empty canvas | zoom + pan (unchanged) | zoom + pan |
| Double-click | **zoom in** (current behaviour preserved) | **rename the node** under the cursor |
| Hover node | nothing | highlight + connector handles |
| Click node / edge | nothing | select → property panel + editor range highlight |
| Drag node | nothing | move / reconnect (see Steps 8-9) |
| Toolbar | export, theme, view | + Add node, Delete, Undo/Redo |

### Audit of existing view state — all orthogonal, keep as-is
- `view: 'split' | 'editor-max' | 'preview-max'` — **layout**, not editing.
- `mobileTab: 'code' | 'preview'` — layout.
- `openMenu: null | 'templates' | 'theme' | 'export'` — transient UI.

None of these may imply editability. A user in `preview-max` is not suddenly
able to edit; only `editMode` decides that.

### Known conflict this resolves
`src/App.tsx` currently sets `doubleClick={{ mode: 'zoomIn' }}` on
`TransformWrapper`, which would swallow the double-click that Step 6 needs for
rename. The table above resolves it: bind
`doubleClick={{ disabled: editMode }}`, so view mode keeps zoom and edit mode
lets the event reach the node. **Do this first** — it is a one-line change that
otherwise silently breaks rename.

---

## How every visual action is validated

A visual edit can "pass" while the diagram is actually broken, because the app
**keeps showing the last good diagram when the text fails to parse**. That is
the single most dangerous trap in this phase: a test can assert against a
stale SVG while the real text is invalid.

So **every** visual action gets three assertions, never fewer:

1. **Text** — the source now contains the expected statement.
2. **Model** — re-parsing the new source yields the expected model change and
   *nothing else* changed.
3. **Visual** — the rendered SVG reflects it, **and the error banner is
   absent** (proving the SVG is live, not stale).

### e2e helpers to add (`tests/e2e/helpers.ts`)
```
expectNoErrorBanner(page)          // .preview-error absent → SVG is live
expectNodeLabel(page, id, label)   // g.node[id$="-flowchart-{id}-"] .nodeLabel
expectEdgeExists(page, from, to)   // path[id$="L_{from}_{to}_"]
expectEdgeCount(page, n)
expectSelected(page, key)          // .selected on the SVG element
expectEditorHighlights(page, range)// editor selection == model range
readModel(page)                    // parse readEditorText() in the browser
```
`readModel` is the key one: it parses the *editor's* text in-page, so step 2
is asserted against what the user would actually see, not a copied string.

---

## Status: done

| Step | State |
| --- | --- |
| 0 Test harness | done — vitest + happy-dom + playwright |
| 1 Parser with ranges | done — `src/lib/flowchart/parser.ts` |
| 2 SVG → model map | done — `src/lib/flowchart/svg-map.ts` |
| 4 Patch engine | done — `src/lib/flowchart/patch.ts`, fuzz-verified |

### Blockers found in the current code (fix before Step 5)
1. **Selection is not wired.** `buildSvgIndex` / `bindingFromEvent` exist but
   `App.tsx` never imports them; the preview has no `onClick`. Step 3 is
   library-only.
2. **`window.__cmView` is not exposed.** `tests/e2e/helpers.ts` already calls
   it in `setEditorText`, so that helper currently cannot drive the editor.
   Expose it via `@uiw/react-codemirror`'s `onCreateEditor`.
3. **`doubleClick={{ mode: 'zoomIn' }}`** conflicts with rename (see mode table).

---

## Step-by-step plan

Each step has **Actions**, **Done when**, and **Visual validation**.

### Step 5: Edit mode shell + two-way selection
The foundation every later step hangs off.

**Actions**
1. Add `editMode` state; toolbar toggle + `E` key.
2. Bind `doubleClick={{ disabled: editMode }}` on `TransformWrapper`.
3. Expose `window.__cmView` via `onCreateEditor`.
4. After each render, call `buildSvgIndex(svgEl, model)` and store it in a ref.
5. `onClick` on `.preview-card`: `bindingFromEvent` → set `selectedKey`.
6. Selecting a node/edge scrolls the editor to, and selects, that element's
   `range`. Moving the editor cursor selects the matching SVG element.

**Done when:** clicking a node highlights it *and* its text; clicking in the
editor highlights the shape. Nothing is editable yet.

**Visual validation**
- Click node `B`: `expectSelected(page,'node:B')`, editor selection equals
  `B`'s range, `expectNoErrorBanner`.
- Place cursor on an edge line: that `path` gets `.selected`.
- With `editMode=false`: clicking does nothing, double-click zooms.

### Step 6: Rename a node (double-click, inline)
**Actions**
1. Double-click node → render an `<input>` overlaid on the node's bbox, pre-filled
   with the decoded label.
2. `Enter` commits → `renameNode(src, model, id, value)` → set code.
3. `Esc` cancels → restore, no text change.
4. Blur commits (so the edit is never silently lost).
5. Quoting is automatic via `quoteLabel` — never hand-build `["..."]`.

**Done when:** rename updates the script, the diagram re-renders, and the
edited node is still selected.

**Visual validation**
- Double-click `A`, type `Hello (world) "x"`:
  - text contains `A["Hello (world) &quot;x&quot;"]` (named entity, not `\"`)
  - `expectNodeLabel(page,'A','Hello (world) "x"')`
  - `expectNoErrorBanner` — the entity renders, it does not break the parse
- Empty label → node keeps a usable label (falls back to the id).
- 200-char label → still renders, no overflow crash.

### Step 7: Add and delete node
**Actions**
1. **Add:** toolbar *Add node*, or double-click empty canvas in edit mode.
   Compute `uniqueNodeId(model, base)`, then `addNode`. Select the new node
   and immediately enter rename so the user can label it.
2. **Delete:** `Delete`/`Backspace` with a node selected → `deleteNode`, which
   also removes its edges and prunes dangling `linkStyle`/`class`.
3. Confirm when the node has > 3 connected edges.

**Done when:** IDs never collide; deleting a hub leaves no dangling edges or
dangling style lines in the script.

**Visual validation**
- Add 50 nodes in a loop → 50 distinct ids, `expectEdgeCount` unchanged.
- Delete a 3-way hub → `expectEdgeCount(page, n-3)`, node gone,
  `expectNoErrorBanner`, and the script has no `linkStyle` pointing past the
  new edge count.

### Step 8: Reconnect arrows (drag an endpoint)
**Actions**
1. Hover a node → show connector handles (one per incident edge + one for
   "new edge").
2. Drag an existing edge's endpoint handle onto another node.
3. On drop: preserve the edge's **token and label**, swap only the endpoint.
   Implement as `deleteEdge(i)` + `addEdge(from, newTo, token, label)` so the
   label and arrow style survive.
4. Drop on empty canvas or on the same node → cancel, no text change.
5. Drag from the "new edge" handle → `addEdge` (with an edge-type chooser:
   `-->`, `---`, `-.->`, `==>`).
6. Click an edge → edit its label inline, or change its type from the panel.

**Done when:** a dragged endpoint rewrites exactly that one edge, keeping its
label and arrow style.

**Visual validation**
- `B -->|go| C`, drag `C`-endpoint onto `D` → text is `B -->|go| D`,
  `expectEdgeExists('B','D')`, `expectEdgeCount` unchanged, label still `go`.
- Drag onto empty canvas → text byte-identical to before.
- Drag onto the same node → no change, no self-loop created.

### Step 9: Move a node — decide first, then build
**This is the step most likely to be built wrong.** Mermaid owns the layout, so
free-dragging a node and leaving Mermaid's edge paths where they were produces a
**severed diagram** — the node moves, the arrows do not.

Two genuinely different features; pick deliberately.

**9a — Move into a group (recommended for v1, works today)**
Interpret a drag as *"re-parent this node"*, then let Mermaid re-layout:
1. Drag node `X` and drop on subgraph `S`.
2. Patch the source so `X`'s statement moves inside `subgraph S … end`,
   preserving its label and shape.
3. Mermaid re-layouts; every edge stays attached because the graph changed,
   not the pixels.
- **Done when:** `X` renders inside `S`'s cluster and all its edges are intact.
- **Visual validation:** `expectClusterContains(page,'S','X')`,
  `expectEdgeCount` unchanged, `expectNoErrorBanner`.

**9b — Free canvas positioning (separate project, do not start casually)**
Storing `%% positions: {X: {x,y}}` and applying `transform` to `g.node[id]`
after render **is not enough** — the edge paths are computed by Mermaid from
its own coordinates and will not follow. Making them follow means owning
layout *and* edge geometry: adopt ELK/dagre, draw your own nodes and paths,
and keep Mermaid only as a syntax reference. Budget it as a rewrite of the
renderer, not a feature.

**Do not ship a half-version of 9b** (node moves, arrows stay) — it is worse
than not having the feature.

### Step 10: Property panel (shape, colour, direction)
**Actions**
1. When something is selected, show a side panel: shape dropdown, fill /
   stroke / text colour, direction toggle (TD/LR).
2. Each control writes via its patch op (`changeShape`, `setNodeStyle`,
   `setDirection`), replacing an existing `style A …` line rather than
   appending duplicates.
3. Edits are debounced so a colour slider does not produce 60 history entries.

**Done when:** every change appears in both the script and the diagram, with no
duplicate style lines.

**Visual validation**
- Change fill twice → exactly one `style A` line in the script;
  `expectNodeFill(page,'A','#f9f')`.
- Change shape rect → circle → label is preserved and still renders.
- Toggle TD → LR → header reads `flowchart LR`, diagram re-layouts,
  `expectNoErrorBanner`.

### Step 11: Undo/redo + invalid-text guard
**Actions**
1. One history stack of **text snapshots**, shared by typed and visual edits;
   group rapid edits (a colour drag) into a single entry.
2. `Ctrl+Z` / `Ctrl+Y` (and `Ctrl+Shift+Z`) work across both input modes.
3. If the text becomes invalid mid-typing: keep the last good diagram, show the
   banner, and **disable edit mode** with "Fix syntax to edit visually".

**Done when:** 10 mixed edits undo to the original text and redo to the final.

**Visual validation**
- 5 typed + 5 visual edits, undo ×10 → text equals the original byte-for-byte.
- Redo ×10 → text equals the final.
- Break the syntax by hand → `editMode` is off, banner shown, last good SVG
  still visible (assert it is the *last good* one, not cleared).

---

## Verification checklist (release gate)
- All fixtures round-trip with **no text change** when no edit is made.
- Every visual action has a unit test **and** an e2e test with all three
  assertions (text / model / live-SVG).
- Fuzz (1,000 random op sequences) produces zero invalid Mermaid.
- Typing and visual edits interleave with no desync.
- Large diagram (200 nodes) re-renders under ~300 ms.
- **Edit mode is the only mode** — grep the source for a second tool-mode
  variable and fail the build if one appears.

## Biggest risks
- **Mermaid's SVG ids change between versions.** Pinned to 11.17.2; verified
  ids are `flowchart-A-0` (node), `L_A_B_0` (**underscores**), `-<id>`
  (cluster). A test hard-fails if these change.
- **Stale-diagram false positives.** The last-good-diagram-on-error behaviour
  means a visual test can pass against a dead SVG. Always assert
  `expectNoErrorBanner` alongside a visual claim.
- **Label quoting bugs** are the most common source of invalid output. Named
  HTML entities only — Mermaid 11.17.2 parses numeric entities (`&#40;`) but
  renders them as a bare `&`. Covered by the fuzz + `tests/e2e/entities.spec.ts`.
- **Flowchart syntax is loose** (chains `A --> B --> C`, `&` groups, inline
  definitions). Handled explicitly in the parser; keep it that way.

## Suggested order of delivery
Steps 5-6 give the first real two-way edit and are demo-able. Steps 7-8 make it
genuinely usable. Step 9a before 9b, always. Steps 10-11 are polish.
