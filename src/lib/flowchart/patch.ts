/**
 * The patch engine: pure functions turning a visual action into new Mermaid
 * source by splicing *only* the affected character ranges.
 *
 * Invariants every operation must uphold (asserted in tests/patch.test.ts):
 *  - the result parses and yields the intended model change
 *  - comments, blank lines and unrelated statements are byte-identical
 *  - applying an operation and then undoing it restores the original text
 *
 * Nothing here mutates its arguments; each function returns a new string.
 */

import {
  type ClassAssignStmt,
  type EdgeStmt,
  type FlowchartModel,
  type LinkStyleStmt,
  type NodeShape,
  type Position,
  parseFlowchart,
  nodeList,
} from './parser';
import { delimsForShape, edgeLabelText, quoteLabel } from './quote';

/** A replacement of `[start, end)` with `text`. */
interface Splice {
  start: number;
  end: number;
  text: string;
}

/**
 * Apply splices to `src`. Later splices are not offset-adjusted, so callers
 * must supply absolute offsets and non-overlapping ranges.
 */
export function applySplices(src: string, splices: Splice[]): string {
  if (splices.length === 0) return src;
  const sorted = [...splices].sort((a, b) => b.start - a.start);
  let out = src;
  let lastStart = src.length + 1;
  for (const s of sorted) {
    // Guard against overlapping ranges; earlier edits win.
    if (s.end > lastStart) continue;
    out = out.slice(0, s.start) + s.text + out.slice(s.end);
    lastStart = s.start;
  }
  return out;
}

function indentOf(src: string, at: number): string {
  let start = at;
  while (start > 0 && src[start - 1] !== '\n') start--;
  const m = /^[ \t]*/.exec(src.slice(start, at));
  return m ? m[0] : '';
}

function lineEndOf(src: string, at: number): number {
  const nl = src.indexOf('\n', at);
  return nl === -1 ? src.length : nl;
}

/**
 * Where a new statement should be inserted: at the very end of the source,
 * after any trailing newline. Using the end of the document avoids landing in
 * the middle of the last line.
 */
function appendPoint(model: FlowchartModel, src: string): number {
  void model;
  return src.length;
}

// ---------------------------------------------------------------------------
// renameNode
// ---------------------------------------------------------------------------

/**
 * Set a node's visible label, rewriting every inline definition of that id.
 *
 * A node may be defined several times (`A` bare on one line, `A[Label]` on
 * another). We rewrite only definitions that actually carry a label; a bare
 * reference gets its label attached at its *first* bare occurrence so the
 * diagram gains a label without disturbing other lines.
 */
export function renameNode(
  src: string,
  model: FlowchartModel,
  id: string,
  label: string,
): string {
  const defs = nodeList(model).filter((n) => n.id === id);
  if (defs.length === 0) return src;

  // `A[]` is not valid mermaid, so a blank label falls back to the node id.
  const safeLabel = label === '' ? id : label;

  const withLabel = defs.filter((n) => src.slice(n.range.start, n.range.end).includes('[') ||
    src.slice(n.range.start, n.range.end).includes('(') ||
    src.slice(n.range.start, n.range.end).includes('{'));

  if (withLabel.length > 0) {
    const splices: Splice[] = withLabel.map((n) => {
      const text = src.slice(n.range.start, n.range.end);
      const shape = shapeOfText(text);
      const [open, close] = delimsForShape(shape);
      return { start: n.range.start, end: n.range.end, text: `${id}${open}${quoteLabel(safeLabel)}${close}` };
    });
    return applySplices(src, splices);
  }

  // Only bare references: label the first one.
  const first = defs[0];
  return applySplices(src, [
    { start: first.range.start, end: first.range.end, text: `${id}[${quoteLabel(safeLabel)}]` },
  ]);
}

/**
 * Recover the shape name from already-parsed definition text by matching the
 * opener that appears immediately after the node id.
 */
function shapeOfText(text: string): NodeShape {
  const i = text.search(/[[({>]/);
  if (i === -1) return 'rect';
  const rest = text.slice(i);
  if (rest.startsWith('[[')) return 'subroutine';
  if (rest.startsWith('[(')) return 'cylinder';
  if (rest.startsWith('([')) return 'stadium';
  if (rest.startsWith('((')) return 'circle';
  if (rest.startsWith('{{')) return 'hexagon';
  if (rest.startsWith('{')) return 'diamond';
  if (rest.startsWith('(')) return 'round';
  if (rest.startsWith('>')) return 'asym';
  return 'rect';
}

// ---------------------------------------------------------------------------
// changeShape
// ---------------------------------------------------------------------------

/** Change a node's shape while preserving its label text. */
export function changeShape(
  src: string,
  model: FlowchartModel,
  id: string,
  shape: NodeShape,
): string {
  const defs = nodeList(model).filter((n) => n.id === id);
  const [open, close] = delimsForShape(shape);
  const splices: Splice[] = [];
  for (const n of defs) {
    const text = src.slice(n.range.start, n.range.end);
    const raw = labelOfText(text);
    if (raw === null) continue; // bare ref, nothing to reshape
    // `labelOfText` returns the label exactly as written. Strip any quotes
    // before re-quoting, otherwise a label that was already quoted would grow
    // a second layer of escapes on every shape change.
    const unquoted = stripWrappingQuotes(raw);
    splices.push({
      start: n.range.start,
      end: n.range.end,
      text: `${id}${open}${quoteLabel(unquoted)}${close}`,
    });
  }
  return splices.length ? applySplices(src, splices) : src;
}

/** Remove a single matching pair of surrounding quotes. */
function stripWrappingQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1).replace(/\\(["'\\])/g, '$1');
    }
  }
  return s;
}

/**
 * Extract the raw label text from `A[Label]` (or any shape), preserving it
 * exactly as written. Returns null for a bare reference like `A`.
 */
function labelOfText(text: string): string | null {
  const i = text.search(/[[({>]/);
  if (i === -1) return null;
  // Use the opener *sequence* at i: `A((x))` opens with `((`, not `(`.
  const rest = text.slice(i);
  const open = rest.startsWith('[[') || rest.startsWith('[(') || rest.startsWith('([')
    ? rest.slice(0, 2)
    : rest.startsWith('((') || rest.startsWith('{{')
      ? rest.slice(0, 2)
      : rest[0];
  const inner = text.slice(i + open.length);
  // Choose the closer that mirrors the *opener kind*, longest first. Keying on
  // `open[0]` (not `open`) matters: a circle opens with `((` but still closes
  // with `))`, and must not fall through to the default `]` candidate.
  const kind = open[0];
  const candidates: string[] =
    kind === '['
      ? [']]', ')]', '])', ']']
      : kind === '('
        ? ['))', ')]', '])', ')']
        : kind === '{'
          ? ['}}', '}']
          : [']'];
  for (const close of candidates) {
    if (!inner.endsWith(close)) continue;
    return inner.slice(0, inner.length - close.length);
  }
  return inner.length > 0 ? inner : null;
}

// ---------------------------------------------------------------------------
// deleteNode
// ---------------------------------------------------------------------------

/**
 * Remove a node and every statement that mentions it.
 *
 * Everything is done by statement *role* rather than by raw ranges: edges are
 * removed one at a time (re-parsing between steps so indices stay valid), then
 * any surviving definition of the node is dropped. Lines that become empty are
 * removed whole so no blank residue accumulates.
 */
/**
 * Remove style/class references that would dangle after an edit.
 *
 * `A:::big` and `linkStyle 3` address a node by name or an edge by index, so a
 * plain text splice leaves them pointing at nothing. Mermaid then dies with
 * "Cannot set properties of undefined (setting 'style')" instead of reporting a
 * syntax error, which is the worst failure mode: the whole diagram disappears
 * rather than highlighting one bad line.
 *
 * Returns the possibly-shortened source.
 */
function pruneDanglingStyles(src: string, nodeId?: string): string {
  let out = src;
  for (let guard = 0; guard < 100; guard++) {
    const model = parseFlowchart(out).model;
    if (!model) break;

    if (nodeId !== undefined) {
      // `A:::class` is inline, so it only goes when nothing else is on its line.
      const assign = model.styles.find(
        (s): s is ClassAssignStmt => s.kind === 'class' && s.target === nodeId,
      );
      if (assign) {
        const ls = startOfLine(out, assign.range.start);
        const le = lineEndOf(out, assign.range.end);
        const rest =
          out.slice(ls, assign.range.start) + out.slice(assign.range.end, le);
        if (rest.trim() === '') {
          out = out.slice(0, ls) + out.slice(consumeNewline(out, le));
          continue;
        }
      }
    }

    // `linkStyle N` refers to an edge index; drop indices past the last edge.
    const edgeCount = model.edges.length;
    const ls2 = model.styles.find(
      (s): s is LinkStyleStmt =>
        s.kind === 'linkStyle' && s.indices.some((n) => n >= edgeCount),
    );
    if (!ls2) break;

    const kept = ls2.indices.filter((n) => n < edgeCount);
    const ls = startOfLine(out, ls2.range.start);
    const le = lineEndOf(out, ls2.range.end);
    if (kept.length === 0) {
      out = out.slice(0, ls) + out.slice(consumeNewline(out, le));
    } else {
      const decl = out.slice(ls2.range.start, ls2.range.end);
      const pruned = decl.replace(
        /^linkStyle\s+[0-9,\s]+?\s*/,
        `linkStyle ${kept.join(',')} `,
      );
      out = out.slice(0, ls2.range.start) + pruned + out.slice(ls2.range.end);
    }
  }
  return out;
}

export function deleteNode(src: string, model: FlowchartModel, id: string): string {
  let out = src;

  // 1. Style / class lines that target this node are always standalone lines.
  for (const st of model.styles) {
    if ((st.kind === 'style' || st.kind === 'class') && st.target !== id) continue;
    if (st.kind !== 'style' && st.kind !== 'class') continue;
    const ls = startOfLine(out, st.range.start);
    const le = lineEndOf(out, st.range.end);
    const before = out.slice(ls, st.range.start);
    if (before.trim() !== '') continue;
    out = out.slice(0, ls) + out.slice(consumeNewline(out, le));
  }

  // 2. Remove every edge touching the node. Re-parse each round because the
  //    previous deletion shifts all subsequent offsets.
  //
  //    Each round must reduce the edge count or shrink the text. A patch that
  //    fails to do so would loop, and each loop doubles the text, so the next
  //    parse alone would take exponential time. Both conditions are checked so
  //    a bad edit degrades into "stop early" instead of a hang.
  for (let guard = 0; guard < 1000; guard++) {
    const current = parseFlowchart(out).model!;
    const idx = current.edges.findIndex((e) => e.from === id || e.to === id);
    if (idx === -1) break;
    const edgesBefore = current.edges.length;
    const lenBefore = out.length;
    // An edge's range swallows its source node's definition, so removing the
    // edge naively would also delete that node. When the line holds a
    // definition of some *other* node, restore it after the edge goes.
    const edge = current.edges[idx];
    const lineStart = startOfLine(out, edge.range.start);
    const siblings = current.edges.filter(
      (e) => startOfLine(out, e.range.start) === lineStart,
    );
    if (siblings.length === 1) {
      const others = nodeList(current).filter(
        (n) => n.id !== id && n.range.start >= lineStart && startOfLine(out, n.range.start) === lineStart,
      );
      const keepFirst = others[0];
      const next = deleteEdge(out, current, idx);
      if (keepFirst && !parseFlowchart(next).model!.nodesById.has(keepFirst.id)) {
        // Re-emit the sibling definition on its own line so the node (and its
        // label) survive the edge deletion.
        const insertAt = lineStart <= next.length ? lineStart : next.length;
        const indent = /^[ \t]*/.exec(out.slice(lineStart, edge.range.start))![0];
        const decl = out.slice(keepFirst.range.start, keepFirst.range.end);
        const head = next.slice(0, insertAt);
        const tail = next.slice(insertAt);
        out = `${head}${indent}${decl}\n${tail}`;
      } else {
        out = next;
      }
    } else {
      out = deleteEdge(out, current, idx);
    }
    // Convergence check: bail out rather than let the text grow without bound.
    const after = parseFlowchart(out).model;
    if (!after || out.length > lenBefore * 2 + 200) break;
    if (after.edges.length >= edgesBefore) break;
  }

  // 3. Remove references that would dangle once the node is gone.
  //
  //     `A:::big` and `linkStyle 3` address the node/edge by name or index, so
  //     a plain text splice leaves them pointing at nothing. Mermaid then dies
  //     with "Cannot set properties of undefined (setting 'style')" rather than
  //     reporting a syntax error, which is the worst failure mode: the whole
  //     diagram disappears.
  out = pruneDanglingStyles(out, id);

  // 4. Drop the node's own definition, but only when its whole line goes with
  //    it. A definition sharing a line with a surviving statement stays put, so
  //    `A[Start] --> B[Process]` keeps `A[Start]` after `B` is removed.
  for (let guard = 0; guard < 100; guard++) {
    const current = parseFlowchart(out).model!;
    const def = nodeList(current).find((n) => n.id === id);
    if (!def) break;
    const ls = startOfLine(out, def.range.start);
    const le = lineEndOf(out, def.range.end);
    const rest = out.slice(ls, def.range.start) + out.slice(def.range.end, le);
    if (rest.trim() === '') {
      out = out.slice(0, ls) + out.slice(consumeNewline(out, le));
      continue;
    }
    // The node is still referenced on this line, so keep its definition.
    const stillUsed = current.edges.some((e) => e.from === id || e.to === id);
    if (stillUsed) break;
    // Only the deleted node's own definition remains here; remove it, and if
    // the line then holds nothing but leftovers, drop the line too.
    out = out.slice(0, def.range.start) + out.slice(def.range.end);
    const afterCut = out.slice(ls, lineEndOf(out, ls));
    if (afterCut.trim() === '' || /^[\s]*[-=.<~>]+[\s]*$/.test(afterCut)) {
      out = out.slice(0, ls) + out.slice(consumeNewline(out, lineEndOf(out, ls)));
    }
  }

  return out;
}

function startOfLine(src: string, at: number): number {
  let s = at;
  while (s > 0 && src[s - 1] !== '\n') s--;
  return s;
}

function consumeNewline(src: string, at: number): number {
  return src[at] === '\n' ? at + 1 : at;
}

// ---------------------------------------------------------------------------
// moveNodeIntoSubgraph (Step 9a)
// ---------------------------------------------------------------------------

/**
 * Move `id` into subgraph `subgraphId` by re-parenting it in the source.
 *
 * This is "move" for v1, and it is deliberately *not* a free-canvas drag.
 * Mermaid owns the layout: translating a rendered node with a CSS transform
 * leaves Mermaid's edge paths where they were, so the node detaches from its
 * own arrows. Re-parenting changes the graph instead of the pixels, and
 * Mermaid re-layouts with every edge still attached.
 *
 * A move differs from a delete in one crucial way: **edges survive**. Deleting
 * strips every edge that touches the node, which is what you want when the node
 * is going away and wrong when it is coming back, so this does its own work:
 *
 *   1. note the edges that touch the node
 *   2. delete the node (which drops those edges along with it)
 *   3. re-emit the declaration, and one line per edge, inside the subgraph
 *
 * Returns `src` unchanged when either endpoint is unknown, or when the node
 * already lives in that subgraph.
 */
export function moveNodeIntoSubgraph(
  src: string,
  model: FlowchartModel,
  nodeId: string,
  subgraphId: string,
): string {
  const sg = model.subgraphs.find((s) => s.id === subgraphId);
  const def = nodeList(model).find((n) => n.id === nodeId);
  if (!sg || !def) return src;

  // Already there? Compare by containment, not by adjacency.
  if (def.range.start >= sg.range.start && def.range.end <= sg.range.end) return src;

  // 1. Capture the declaration text and the touching edges while the original
  //    offsets are still valid.
  const decl = src.slice(def.range.start, def.range.end);
  const indent = /^[ \t]*/.exec(src.slice(startOfLine(src, def.range.start), def.range.start))![0];
  const touching = model.edges
    .filter((e) => e.from === nodeId || e.to === nodeId)
    .map((e) => ({ from: e.from, to: e.to, token: tokenFor(e), label: e.label }));

  // 2. Strip the node out of the source. deleteNode removes each touching edge
  //    and re-emits any sibling definition it shared a line with, which is
  //    exactly the cleanup a move needs; we only differ in that the moved
  //    node's declaration was captured above for step 3.
  const stripped = deleteNode(src, model, nodeId);

  // 3. Re-parse: the removal shifted every offset after it, and `sg` may have
  //    moved if the node sat above the subgraph.
  const fresh = parseFlowchart(stripped).model;
  if (!fresh) return stripped;
  const sg2 = fresh.subgraphs.find((s) => s.id === subgraphId);
  if (!sg2) return stripped;

  // 4. Emit the declaration and one line per edge just before the subgraph's
  //    `end`. Mermaid's cluster membership follows text nesting, so this is
  //    what actually re-parents the node.
  const endLine = endKeywordOffset(stripped, sg2.range.start, sg2.range.end);
  const head = stripped.slice(0, endLine);
  const tail = stripped.slice(endLine);
  const inner = `${indentOf(stripped, sg2.openRange.start)}    `;

  const lines = [`${inner}${decl}`];
  for (const e of touching) {
    // A label must sit after the arrow: `A -->|go| B`. Before it, Mermaid
    // reports a parse error.
    const lbl = e.label ? `|${edgeLabelText(e.label)}|` : '';
    lines.push(`${inner}${e.from} ${e.token}${lbl} ${e.to}`);
  }

  const needsNlBefore = head.length > 0 && !head.endsWith('\n');
  return `${head}${needsNlBefore ? '\n' : ''}${lines.join('\n')}\n${indent}${tail}`;
}

/**
 * Offset of the `end` keyword closing a subgraph.
 *
 * Mermaid's `end` may not be indented, and a subgraph can nest, so we scan for
 * a line whose trimmed text is exactly `end` at or after `from`.
 */
function endKeywordOffset(src: string, from: number, to: number): number {
  let i = from;
  while (i < to) {
    const lineEnd = lineEndOf(src, i);
    if (src.slice(i, lineEnd).trim() === 'end') {
      // Keep the end line's own indentation.
      return i + (src.slice(i, lineEnd).length - src.slice(i, lineEnd).trimStart().length);
    }
    i = consumeNewline(src, lineEnd);
  }
  return to;
}

// ---------------------------------------------------------------------------
// addNode
// ---------------------------------------------------------------------------

/** Generate an id not already present in the model. */
export function uniqueNodeId(model: FlowchartModel, base = 'n'): string {
  const taken = new Set(model.nodesById.keys());
  if (!taken.has(base)) return base;
  for (let i = 1; ; i++) {
    const candidate = `${base}${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Append a new node statement.
 *
 * The id defaults to the label when the label is a legal mermaid identifier,
 * which keeps the generated script readable (`Add node` -> `Fresh[Fresh]`).
 * Otherwise a unique `n`, `n1`, `n2`… is used.
 */
export function addNode(
  src: string,
  model: FlowchartModel,
  label: string,
  shape: NodeShape = 'rect',
  id?: string,
): string {
  const taken = new Set(model.nodesById.keys());
  const base = id ?? (isIdentifier(label) ? label : 'n');
  const nodeId = taken.has(base) ? uniqueNodeId(model, base) : base;
  const [open, close] = delimsForShape(shape);
  // `A[]` is not valid Mermaid, so a blank label falls back to the node id.
  const safeLabel = label === '' ? nodeId : label;
  const line = `${indentOf(src, appendPoint(model, src))}${nodeId}${open}${quoteLabel(safeLabel)}${close}`;
  const at = appendPoint(model, src);
  const needsNlBefore = at > 0 && src[at - 1] !== '\n';
  const insert = `${needsNlBefore ? '\n' : ''}${line}\n`;
  return src.slice(0, at) + insert + src.slice(at);
}

/** True when `s` can be used verbatim as a mermaid node id. */
function isIdentifier(s: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
}

// ---------------------------------------------------------------------------
// addEdge
// ---------------------------------------------------------------------------

/** Append `from --> to` as a new statement. */
export function addEdge(
  src: string,
  model: FlowchartModel,
  from: string,
  to: string,
  token = '-->',
  label = '',
): string {
  const at = appendPoint(model, src);
  // Mermaid places the label after the arrow: `A -->|label| B`. Before the
  // arrow (`A |label| --> B`) is a parse error.
  const linkText = label ? `|${edgeLabelText(label)}|` : '';
  const line = `${indentOf(src, at)}${from} ${token}${linkText} ${to}`;
  const needsNlBefore = at > 0 && src[at - 1] !== '\n';
  const insert = `${needsNlBefore ? '\n' : ''}${line}\n`;
  return src.slice(0, at) + insert + src.slice(at);
}

/**
 * Delete a specific edge. Edges are addressed by model index so duplicates
 * (`A --> B` twice) can be removed one at a time.
 */
export function deleteEdge(src: string, model: FlowchartModel, index: number): string {
  const edge = model.edges[index];
  if (!edge) return src;
  // A chain `A --> B --> C` puts several edges on one line, so we treat "other
  // edges starting on the same line" as siblings. Comparing ranges directly
  // does not work: chain edges intentionally overlap.
  const lineStart = startOfLine(src, edge.range.start);
  const siblings = model.edges.filter(
    (e) => startOfLine(src, e.range.start) === lineStart,
  );
  if (siblings.length > 1) return pruneDanglingStyles(deleteEdgeFromChain(src, model, edge));
  return pruneDanglingStyles(deleteWholeLine(src, edge.range, model));
}

/**
 * Remove a statement's range, dropping the whole line when nothing else on
 * that line would survive.
 *
 * An edge's range begins at its *source node* (`A[Start] --> B[Process]`), so
 * the range also swallows that node's definition. We deliberately do NOT try
 * to salvage it: emitting a lone `A[Start]` would silently re-link it to the
 * next statement (`B --> C[End]` becomes `A[Start] --> C[End]`). Callers that
 * want the node kept (`deleteNode`) handle its definition separately.
 */
function deleteWholeLine(src: string, r: Position, model?: FlowchartModel): string {
  void model;
  const ls = startOfLine(src, r.start);
  const lineLe = lineEndOf(src, r.start);
  const end = Math.min(r.end, lineLe);
  const before = src.slice(ls, r.start);
  const after = src.slice(end, lineLe);

  if (before.trim() === '' && after.trim() === '') {
    return src.slice(0, ls) + src.slice(consumeNewline(src, lineLe));
  }
  // The statement is removed but the line survives. Keep the surrounding text
  // as it was written, including whatever whitespace separated them, or two
  // statements end up fused into one unparseable token.
  const kept = before + after;
  return src.slice(0, ls) + kept + src.slice(lineLe);
}

/**
 * Remove one edge from a chained line (`A --> B --> C`), keeping the rest.
 *
 * Rebuilding from the model rather than trimming characters is deliberate: the
 * surviving links may each carry a different token or label, and splicing text
 * would corrupt the chain's shape.
 */
function deleteEdgeFromChain(
  src: string,
  model: FlowchartModel,
  drop: EdgeStmt,
): string {
  const lineStart = startOfLine(src, drop.range.start);
  const lineEnd = lineEndOf(src, drop.range.end);
  const siblings = model.edges.filter((e) => startOfLine(src, e.range.start) === lineStart);
  const dropKey = `${drop.from}|${drop.to}|${drop.range.start}`;
  const keep = siblings.filter((e) => `${e.from}|${e.to}|${e.range.start}` !== dropKey);
  if (keep.length === 0) return deleteWholeLine(src, drop.range);

  // Preserve any inline node definitions that lived on this line.
  const defs = nodeList(model).filter((n) => n.range.start >= lineStart && n.range.end <= lineEnd);
  const indent = indentOf(src, lineStart);

  // Rebuild the line as one or more chains.
  //
  // Group the surviving edges by their source: each group is one chain head
  // (`D & E & F --> G` is three edges sharing the head `D & E & F`). Emitting a
  // flat list of nodes and arrows instead fuses them into nonsense such as
  // `D ; --> ; G ; F ; --> ; G`.
  //
  // Each node is emitted at most once, and always with its declaration text
  // when it had one: joining per-edge segments would repeat the shared node as
  // `X[A] X[A] --> Z`, which mermaid rejects.
  const heads: string[] = [];
  const chains = new Map<string, EdgeStmt[]>();
  for (const e of keep) {
    if (!chains.has(e.from)) {
      chains.set(e.from, []);
      heads.push(e.from);
    }
    chains.get(e.from)!.push(e);
  }

  const emitted = new Set<string>();
  const textFor = (id: string): string => {
    if (emitted.has(id)) return id;
    emitted.add(id);
    const def = defs.find((d) => d.id === id);
    return def ? src.slice(def.range.start, def.range.end) : id;
  };

  const statements = heads.map((head) => {
    const links = chains.get(head)!;
    const parts: string[] = [links.map((e) => textFor(e.from)).join(' & ')];
    for (const e of links) {
      // The label goes after the arrow: mermaid writes `A -->|lbl| B` and
      // rejects the pipes on the arrow's left.
      const lbl = e.label ? `|${edgeLabelText(e.label)}|` : '';
      parts.push(`${tokenFor(e)}${lbl}`);
      parts.push(textFor(e.to));
    }
    return parts.join(' ');
  });

  // `&` groups mean several statements can share a line. Join those with `;` —
  // a separator mermaid accepts — rather than a bare space, which fuses them
  // into one unparseable statement.
  const sep = statements.length > 1 ? ' ; ' : ' ';
  const rebuilt = `${indent}${statements.join(sep)}`;
  return src.slice(0, lineStart) + rebuilt + src.slice(lineEnd);
}

/** The source token for an edge's type — the inverse of the tokenizer. */
export function tokenFor(e: { type: string; arrow: string }): string {
  switch (e.type) {
    case 'arrow':
      return '-->';
    case 'open':
      return '---';
    case 'thick':
      return '==>';
    case 'dotted':
      return '-.->';
    case 'thickOpen':
      return '===';
    case 'dottedOpen':
      return '-..-';
    case 'invisible':
      return '~~~';
    default:
      return '-->';
  }
}

// ---------------------------------------------------------------------------
// changeEdgeLabel / changeEdgeToken
// ---------------------------------------------------------------------------

/**
 * Locate the arrow token of an edge inside its range.
 *
 * A naive `/[-=.<~]{2,}/` is wrong because it also matches inside a `|label|`
 * and inside a negative-looking label. We therefore skip any `|...|` segment
 * and any node label, and take the first genuine arrow token after the source
 * node.
 */
/**
 * Arrow tokens Mermaid accepts, ordered longest first so a shorter token can
 * never shadow a longer one (`-.->` before `-.-` before `-->`).
 *
 * The set is verified against `mermaid.parse` rather than guessed from the
 * grammar: note the asymmetries. `--` and `==` are not links (only `---` and
 * `===` are), and a reversed link needs the arrowhead (`<-->`, not `<--`).
 */
export const ARROW_TOKENS = [
  '<-.->',
  '<-->',
  '<-.-',
  '<===',
  '<==>',
  '-.->',
  '-.-',
  '-->',
  '===',
  '---',
  '==>',
  '~~~',
];

function findArrowToken(src: string, start: number, end: number): { start: number; end: number } | null {
  // 1. Step over the source node: its id plus an optional inline shape/label.
  let i = start;
  while (i < end && (src[i] === ' ' || src[i] === '\t')) i++;
  const ident = /^[A-Za-z0-9_]+/.exec(src.slice(i, end));
  if (!ident) return null;
  i += ident[0].length;
  while (i < end && (src[i] === ' ' || src[i] === '\t')) i++;
  const shape = /^(\[\[|\[\(|\(\(|\(\[|\{\{|\[|\(|\{|>)/.exec(src.slice(i, end));
  if (shape) {
    const openers: Record<string, string> = {
      '[[': ']]',
      '[(': ')]',
      '((': '))',
      '([': '])',
      '{{': '}}',
      '[': ']',
      '(': ')',
      '{': '}',
      '>': ']',
    };
    const close = openers[shape[1]];
    const at = src.indexOf(close, i + shape[1].length);
    if (at === -1 || at >= end) return null;
    i = at + close.length;
  }

  // 2. Skip whitespace and an optional |label| that precedes the arrow.
  while (i < end && (src[i] === ' ' || src[i] === '\t')) i++;
  if (i < end && src[i] === '|') {
    const close = src.indexOf('|', i + 1);
    if (close === -1 || close >= end) return null;
    i = close + 1;
  }

  // 3. The arrow token. Matched against a verified token list, longest first,
  //    so `-.->` is never read as `-.-` plus a stray `>`.
  const rest = src.slice(i, end);
  for (const token of ARROW_TOKENS) {
    if (rest.startsWith(token)) return { start: i, end: i + token.length };
  }
  return null;
}

/** Set an edge's label text, rewriting its `|...|` segment. */
export function changeEdgeLabel(
  src: string,
  model: FlowchartModel,
  index: number,
  label: string,
): string {
  const edge = model.edges[index];
  if (!edge) return src;
  // A blank label means "clear it"; a whitespace-only one would emit
  // `A -->|   | B`, which parses but looks like a bug to the reader.
  const text = label.trim() === '' ? '' : label;
  const r = edge.range;
  // An existing label may sit on the arrow's left (`A |lbl| --> B`), which our
  // parser tolerates but mermaid rejects outright. Rewrite it in the canonical
  // position rather than preserving text that can never render.
  if (edge.labelRange) {
    const lr = edge.labelRange;
    const labelIsBeforeArrow = lr.end <= edge.range.start + edge.arrow.length;
    if (labelIsBeforeArrow) {
      // Strip the misplaced pipes, then re-insert after the arrow.
      const stripped = src.slice(0, lr.start - 1) + src.slice(lr.end + 1);
      const reparsed = parseFlowchart(stripped).model;
      const arrow = reparsed ? findArrowToken(stripped, edge.range.start, edge.range.end) : null;
      if (!arrow) return stripped;
      const inserted = stripped.slice(0, arrow.end) + `|${edgeLabelText(text)}|` + stripped.slice(arrow.end);
      return changeEdgeLabel(inserted, parseFlowchart(inserted).model!, index, text);
    }
    if (!text) {
      // Clearing a label must remove the pipes too: `A -->|| B` is a lex error.
      return src.slice(0, lr.start - 1) + src.slice(lr.end + 1);
    }
    return src.slice(0, lr.start) + edgeLabelText(text) + src.slice(lr.end);
  }
  // No label yet: insert `|label|` after the arrow, since mermaid writes
  // `A -->|label| B` and rejects the pipes on the arrow's left.
  //
  // The insertion must swallow any whitespace that already follows the arrow.
  // Mermaid's lexer only tolerates whitespace *before* `|label|`, never after
  // it: `A --> |x|   B` is a parse error while `A -->   |x|B` is fine. Leaving
  // the original spacing in place would therefore break the line.
  const arrow = findArrowToken(src, r.start, r.end);
  if (!arrow || !text) return src;
  const after = /^(\s*)/.exec(src.slice(arrow.end))![1];
  return (
    src.slice(0, arrow.end) +
    `|${edgeLabelText(text)}|` +
    src.slice(arrow.end + after.length)
  );
}

/** Replace the arrow token of an edge, preserving endpoints and label. */
export function changeEdgeToken(
  src: string,
  model: FlowchartModel,
  index: number,
  token: string,
): string {
  const edge = model.edges[index];
  if (!edge) return src;
  const arrow = findArrowToken(src, edge.range.start, edge.range.end);
  if (!arrow) return src;
  return src.slice(0, arrow.start) + token + src.slice(arrow.end);
}

// ---------------------------------------------------------------------------
// setDirection
// ---------------------------------------------------------------------------

/** Change the flowchart direction in the header line. */
export function setDirection(
  src: string,
  model: FlowchartModel,
  direction: 'TD' | 'LR' | 'BT' | 'RL',
): string {
  const r = model.directionRange;
  if (!r) return src;
  const line = src.slice(r.start, r.end);
  const m = /^(.*?)\b(TD|TB|BT|RL|LR)\b(.*)$/i.exec(line);
  if (!m) return src;
  const rebuilt = `${m[1]}${direction}${m[3]}`;
  return src.slice(0, r.start) + rebuilt + src.slice(r.end);
}

// ---------------------------------------------------------------------------
// setNodeStyle
// ---------------------------------------------------------------------------

/**
 * Write `style <id> fill:..,stroke:..` for a node, replacing any existing style
 * line for that id so repeated edits never accumulate duplicates.
 */
export function setNodeStyle(
  src: string,
  model: FlowchartModel,
  id: string,
  props: Record<string, string>,
): string {
  const decl = Object.entries(props)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}:${v}`)
    .join(',');
  const line = `style ${id} ${decl}`;

  const existing = model.styles.find((s) => s.kind === 'style' && s.target === id);
  if (existing) {
    const ls = startOfLine(src, existing.range.start);
    const le = lineEndOf(src, existing.range.end);
    const indent = indentOf(src, existing.range.start);
    return src.slice(0, ls) + indent + line + src.slice(le);
  }
  const at = appendPoint(model, src);
  const indent = indentOf(src, at);
  const needsNlBefore = at > 0 && src[at - 1] !== '\n';
  return src.slice(0, at) + `${needsNlBefore ? '\n' : ''}${indent}${line}\n` + src.slice(at);
}