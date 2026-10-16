/**
 * Flowchart parser producing a model with absolute character ranges.
 *
 * Design rules:
 *  - Text is the source of truth. We never rewrite the whole document.
 *  - Every node/edge/subgraph/style statement keeps the exact `[start, end)`
 *    range in the original source, so patches can splice only what changed.
 *  - Anything we do not understand is left in the text verbatim (`unknown`),
 *    so a later patch never destroys unsupported syntax.
 *
 * Supported syntax (v1):
 *      flowchart TD / graph LR      direction header
 *      A[Label], A(Label), A((x)), A([x]), A[[x]], A[(x)], A{x}, A{{x}}, A>x]
 *      A --> B, A --- B, A -.-> B, A ==> B, A -- text --> B
 *      A & B --> C, A --> B & C    (& groups on either side)
 *      A --> B --> C                (chained edges)
 *      subgraph name [Title] ... end
 *      classDef / class / style / linkStyle / A:::class
 */

export type NodeShape =
  | 'rect'
  | 'round'
  | 'stadium'
  | 'subroutine'
  | 'cylinder'
  | 'circle'
  | 'asym'
  | 'diamond'
  | 'hexagon'
  | 'bang';

export type EdgeType =
  | 'arrow' // -->
  | 'open' // ---
  | 'thick' // ==>
  | 'dotted' // -.-> / -.->
  | 'thickOpen' // ===
  | 'dottedOpen' // -..-
  | 'invisible'; // ~~~

export interface Position {
  /** 0-based absolute offset into the source. */
  start: number;
  /** Exclusive end offset. */
  end: number;
}

export interface NodeStmt {
  kind: 'node';
  id: string;
  label: string;
  shape: NodeShape;
  /** Range of the whole `id[Label]` (or bare `id`) occurrence. */
  range: Position;
}

export interface EdgeStmt {
  kind: 'edge';
  from: string;
  to: string;
  label: string;
  type: EdgeType;
  /** Absolute range of the link text `|...|` (exclusive), when present. */
  labelRange?: Position;
  arrow: 'arrow' | 'none';
  /** Absolute range spanning from the `from` node through the `to` node. */
  range: Position;
}

export interface SubgraphStmt {
  kind: 'subgraph';
  id: string;
  label: string;
  /** Range from `subgraph` keyword to the matching `end` (inclusive of end). */
  range: Position;
  /** Offset of the `subgraph` line only (for insertion). */
  openRange: Position;
}

export interface StyleStmt {
  kind: 'style';
  target: string;
  range: Position;
}

export interface ClassDefStmt {
  kind: 'classDef';
  name: string;
  range: Position;
}

export interface ClassAssignStmt {
  kind: 'class';
  target: string;
  className: string;
  range: Position;
}

export interface LinkStyleStmt {
  kind: 'linkStyle';
  index: number;
  /** Every index on the line: `linkStyle 0,3 stroke:#f00` styles two edges. */
  indices: number[];
  range: Position;
}

export interface DirectionStmt {
  kind: 'direction';
  value: string;
  range: Position;
}

export interface CommentStmt {
  kind: 'comment';
  range: Position;
}

export type Statement =
  | NodeStmt
  | EdgeStmt
  | SubgraphStmt
  | StyleStmt
  | ClassDefStmt
  | ClassAssignStmt
  | LinkStyleStmt
  | DirectionStmt
  | CommentStmt;

export interface FlowchartModel {
  direction: 'TD' | 'TB' | 'BT' | 'RL' | 'LR';
  /** Range covering the whole header line (keyword + direction). */
  directionRange: Position | null;
  statements: Statement[];
  nodesById: Map<string, NodeStmt[]>;
  edges: EdgeStmt[];
  subgraphs: SubgraphStmt[];
  styles: (StyleStmt | ClassDefStmt | ClassAssignStmt | LinkStyleStmt)[];
  /** Lines/statements we intentionally do not model. */
  unknown: { text: string; range: Position }[];
  /** Absolute offset just after the header line's newline. */
  bodyStart: number;
  /** Absolute offset of the last non-space char + 1. */
  bodyEnd: number;
}

export interface ParseResult {
  ok: boolean;
  model: FlowchartModel | null;
  errorOffset?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

const SHAPE_OPENERS: Array<{ open: string; close: string; shape: NodeShape }> = [
  { open: '[[', close: ']]', shape: 'subroutine' },
  { open: '[(', close: ')]', shape: 'cylinder' },
  { open: '([', close: '])', shape: 'stadium' },
  { open: '((', close: '))', shape: 'circle' },
  { open: '{{', close: '}}', shape: 'hexagon' },
  { open: ')(', close: ')(', shape: 'bang' },
  { open: '{', close: '}', shape: 'diamond' },
  { open: '[', close: ']', shape: 'rect' },
  { open: '(', close: ')', shape: 'round' },
  { open: '>', close: ']', shape: 'asym' },
];

// Longest-first so `-.->` wins over `-->` and `<-->` over `-->`. Note the
// two-headed `<...>` forms come first, then normal arrows, then open links.
const EDGE_TOKENS: Array<{ token: string; type: EdgeType; arrow: boolean }> = [
  { token: '<-->', type: 'arrow', arrow: true },
  { token: '<--->', type: 'arrow', arrow: true },
  { token: '<-.->', type: 'dotted', arrow: true },
  { token: '<==> ', type: 'thick', arrow: true },
  { token: '<==>', type: 'thick', arrow: true },
  { token: '<->', type: 'arrow', arrow: true },
  { token: '==>', type: 'thick', arrow: true },
  { token: '-->', type: 'arrow', arrow: true },
  { token: '---', type: 'open', arrow: false },
  { token: '-.-', type: 'dotted', arrow: true },
  { token: '-..->', type: 'dotted', arrow: true },
  { token: '-..-', type: 'dottedOpen', arrow: false },
  { token: '===', type: 'thickOpen', arrow: false },
  { token: '~~~', type: 'invisible', arrow: false },
  { token: '--', type: 'open', arrow: false },
];

function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_\u00C0-\u024F\u4E00-\u9FFF]/.test(ch);
}

/** Reads a bare identifier starting at `i`. Does not include `.` or `-`. */
function readIdent(src: string, i: number): string {
  let j = i;
  while (j < src.length && isIdentChar(src[j])) j++;
  return src.slice(i, j);
}

function skipInlineSpace(src: string, i: number): number {
  while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++;
  return i;
}

/**
 * Parses a bracketed label starting at `start` (pointing at the opening shape
 * char). Handles nested brackets and quoted strings. Returns the inner value
 * and the number of characters consumed (including brackets), or null when the
 * label is unterminated on this line.
 *
 * Note: only the `close` sequence terminates the label. Other bracket chars
 * (`[`, `(`, `{`) are ordinary label content, so `A[(a [b])]` still parses and
 * `A[Spaced  ]` keeps its exact width.
 */
function parseLabelInside(
  src: string,
  start: number,
  open: string,
  close: string,
): { value: string; consumed: number } | null {
  let i = start + open.length;
  const inner: string[] = [];
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\' && i + 1 < src.length) {
      inner.push(src[i], src[i + 1]);
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      const buf: string[] = [];
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < src.length) {
          buf.push(src[i], src[i + 1]);
          i += 2;
          continue;
        }
        buf.push(src[i]);
        i++;
      }
      if (i >= src.length) return null;
      i++;
      inner.push(buf.join(''));
      continue;
    }
    if (src.startsWith(close, i)) {
      return { value: inner.join(''), consumed: i + close.length - start };
    }
    if (ch === '\n') return null;
    inner.push(ch);
    i++;
  }
  return null;
}

function unescapeLabel(value: string): string {
  return value.replace(/\\(["'\\])/g, '$1');
}

/** Offset of the next newline at or after `i`, or end of source. */
function lineEndOf(src: string, i: number): number {
  const nl = src.indexOf('\n', i);
  return nl === -1 ? src.length : nl;
}

/**
 * Parse a shape, choosing between candidate closing sequences.
 *
 * `H(((Circle)))` is a circle node whose label is `Circle`, but a naive scan
 * for `((` … `))` would stop at the first `))` and leave a stray `)` behind,
 * which would then fail the "every character is explained" invariant. So we
 * collect every candidate close and prefer the longest one whose remaining
 * characters are only closing brackets.
 */
function parseShape(
  src: string,
  start: number,
  open: string,
  close: string,
  lineEnd: number,
): { value: string; consumed: number } | null {
  const first = parseLabelInside(src, start, open, close);
  if (!first) return null;
  // Walk past extra identical closer chars, as mermaid does for `(((x)))`.
  let end = start + first.consumed;
  while (end < lineEnd && src[end] === close[close.length - 1]) end++;
  if (end === start + first.consumed) return first;
  // Everything we swallowed must be closing chars only — otherwise a real
  // label such as `A[x)]` would be mis-read.
  const between = src.slice(start + first.consumed, end);
  if (!/^[)\]}]+$/.test(between)) return first;
  return { value: first.value, consumed: end - start };
}

/**
 * Attempt to read `id` + optional shape/label at `i`. Returns the id, optional
 * parsed label/shape, and the total character length consumed (id + bracket).
 */
function readNodeRef(
  src: string,
  i: number,
): { id: string; label?: string; shape?: NodeShape; len: number } | null {
  const id = readIdent(src, i);
  if (!id) return null;
  const afterId = i + id.length;
  const a = skipInlineSpace(src, afterId);
  for (const { open, close, shape } of SHAPE_OPENERS) {
    if (!src.startsWith(open, a)) continue;
    const parsed = parseShape(src, a, open, close, lineEndOf(src, a));
    if (parsed) {
      return {
        id,
        label: unescapeLabel(parsed.value),
        shape,
        // id + inner spacing + bracketed label
        len: id.length + (a - afterId) + parsed.consumed,
      };
    }
  }
  return { id, len: id.length };
}

// ---------------------------------------------------------------------------
// Line tokenizer: split a flowchart line into node refs, edge tokens, &, |labels|
// ---------------------------------------------------------------------------

interface Seg {
  kind: 'node' | 'amp' | 'edge' | 'label' | 'classref';
  start: number; // absolute offset into source
  end: number;
  id?: string;
  label?: string;
  shape?: NodeShape;
  edgeType?: EdgeType;
  arrow?: boolean;
  /** Exact matched token text, needed to distinguish `--` from `---`. */
  token?: string;
}

function matchEdgeAt(src: string, i: number): { len: number; type: EdgeType; arrow: boolean } | null {
  for (const cand of EDGE_TOKENS) {
    if (src.startsWith(cand.token, i)) {
      return { len: cand.token.length, type: cand.type, arrow: cand.arrow };
    }
  }
  return null;
}

/**
 * Tokenize a single logical line [lineStart, lineEnd) into ordered segments.
 * Handles `-->`, chained edges, `&` groups, and inline `|labels|`. Inline node
 * definitions (with bracket shapes) are folded into the node segment.
 */
function tokenizeLine(src: string, lineStart: number, lineEnd: number): Seg[] {
  const segs: Seg[] = [];
  let i = lineStart;
  while (i < lineEnd) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }
    if (ch === '&') {
      segs.push({ kind: 'amp', start: i, end: i + 1 });
      i++;
      continue;
    }
    if (ch === '|') {
      const close = src.indexOf('|', i + 1);
      const stop = close === -1 || close >= lineEnd ? lineEnd : close;
      segs.push({
        kind: 'label',
        start: i,
        end: stop + (stop < lineEnd && src[stop] === '|' ? 1 : 0),
        label: src.slice(i + 1, stop),
      });
      i = stop < lineEnd && src[stop] === '|' ? stop + 1 : lineEnd;
      continue;
    }
    // inline node ref (id + optional shape)
    const node = readNodeRef(src, i);
    if (node) {
      segs.push({
        kind: 'node',
        start: i,
        end: i + node.len,
        id: node.id,
        label: node.label,
        shape: node.shape,
      });
      i += node.len;
      continue;
    }
    // edge token
    const edge = matchEdgeAt(src, i);
    if (edge) {
      segs.push({
        kind: 'edge',
        start: i,
        end: i + edge.len,
        edgeType: edge.type,
        arrow: edge.arrow,
        token: src.slice(i, i + edge.len),
      });
      i += edge.len;
      continue;
    }
    // `A:::className` shorthand — model it as a class assignment.
    if (ch === ':' && src.startsWith(':::', i)) {
      const close = src.indexOf(':::', i + 3);
      const stop = close === -1 || close >= lineEnd ? lineEnd : close + 3;
      segs.push({ kind: 'classref', start: i, end: stop });
      i = stop;
      continue;
    }
    i++; // unknown char, skip
  }
  return segs;
}

// ---------------------------------------------------------------------------
// Statement builder: turn segments into node/edge statements
// ---------------------------------------------------------------------------

function buildFromSegments(
  src: string,
  segs: Seg[],
  statements: Statement[],
  nodesById: Map<string, NodeStmt[]>,
  styles: FlowchartModel['styles'],
): boolean {
  void src;
  const nodeSegs = segs.filter((s): s is Seg & { id: string } => s.kind === 'node');
  if (nodeSegs.length === 0) return false;

  // 1. Emit inline node definitions. Refs that carry a label/shape become a
  //    NodeStmt; bare refs (e.g. `A --> B` where B has no label yet) are only
  //    registered by id so the model knows the node exists.
  for (const s of nodeSegs) {
    if (s.label === undefined) {
      if (!nodesById.has(s.id)) {
        nodesById.set(s.id, [
          {
            kind: 'node',
            id: s.id,
            label: s.id,
            shape: 'rect',
            range: { start: s.start, end: s.end },
          },
        ]);
      }
      continue;
    }
    const node: NodeStmt = {
      kind: 'node',
      id: s.id,
      label: s.label,
      shape: s.shape ?? 'rect',
      range: { start: s.start, end: s.end },
    };
    statements.push(node);
    const arr = nodesById.get(s.id) ?? [];
    arr.push(node);
    nodesById.set(s.id, arr);
  }

  const edgeSegs = segs.filter((s) => s.kind === 'edge');
  const classRefSegs = segs.filter((s) => s.kind === 'classref');

  // `A:::className` shorthand. Modelled as a class assignment statement so the
  // text is fully accounted for, but kept out of `styles`: that array mirrors
  // the explicit `style`/`classDef`/`class`/`linkStyle` lines only, which is
  // what the style editor rewrites.
  for (const seg of classRefSegs) {
    const prev = [...nodeSegs].reverse().find((n) => n.end <= seg.start);
    const className = src.slice(seg.start, seg.end).replace(/^:::/, '');
    if (!prev || !className) continue;
    statements.push({
      kind: 'class',
      target: prev.id,
      className,
      range: { start: prev.start, end: seg.end },
    });
  }

  // No edge tokens: bare references only, nothing further to model.
  if (edgeSegs.length === 0) return true;

  // 2. Split the segment stream into `groups.length === edgeSegs.length + 1`
  //    endpoint groups separated by the edge tokens. `&` never splits a group;
  //    it appends another endpoint to the group being built. A `|label|`
  //    binds to the edge token that follows it (`A -- lbl --> B`).
  interface Group {
    /** One entry per endpoint, carrying its full source extent (id + shape). */
    refs: Array<{ id: string; start: number; end: number }>;
  }
  interface Link {
    edgeType: EdgeType;
    arrow: 'arrow' | 'none';
    token: string;
    start: number;
    end: number;
    label: string;
    labelRange?: Position;
  }

  const groups: Group[] = [{ refs: [] }];
  const links: Link[] = [];

  for (const seg of segs) {
    if (seg.kind === 'node') {
      groups[groups.length - 1].refs.push({ id: seg.id!, start: seg.start, end: seg.end });
      continue;
    }
    if (seg.kind === 'amp') {
      // continues the current group
      continue;
    }
    if (seg.kind === 'label') {
      continue;
    }
    if (seg.kind === 'edge') {
      links.push({
        edgeType: seg.edgeType!,
        arrow: seg.arrow ? 'arrow' : 'none',
        token: seg.token ?? '',
        start: seg.start,
        end: seg.end,
        label: '',
      });
      groups.push({ refs: [] });
    }
  }

  // Attach labels. A `|...|` belongs to the nearest edge token: mermaid accepts
  // `A -- lbl --> B`, `A -->|lbl| B` and even `A -- lbl -- B`. Assign each
  // label segment to the edge with the smallest distance to it.
  const labelSegs = segs.filter((s) => s.kind === 'label');
  for (const ls of labelSegs) {
    const text = ls.label ?? '';
    if (!text) continue;
    let best = -1;
    let bestDist = Infinity;
    for (let idx = 0; idx < links.length; idx++) {
      const link = links[idx];
      const dist =
        ls.start >= link.end
          ? ls.start - link.end
          : ls.end <= link.start
            ? link.start - ls.end
            : 0;
      if (dist < bestDist) {
        bestDist = dist;
        best = idx;
      }
    }
    if (best === -1) continue;
    links[best].label = text;
    links[best].labelRange = { start: ls.start + 1, end: ls.end - 1 };
  }

  // 3. Cross-product each adjacent group pair through its link.
  const lineEnd = lineEndOf(src, segs[0]?.start ?? 0);
  for (let k = 0; k < links.length; k++) {
    const fromGroup = groups[k];
    const toGroup = groups[k + 1];
    const link = links[k];
    if (fromGroup.refs.length === 0 || toGroup.refs.length === 0) continue;
    for (const from of fromGroup.refs) {
      for (const to of toGroup.refs) {
        // The range must stay inside its own line: an `&` group on the next
        // line, or a node whose id continues past the newline, must never make
        // an edge range bleed into another statement.
        const end = Math.min(to.end, lineEnd);
        const e: EdgeStmt = {
          kind: 'edge',
          from: from.id,
          to: to.id,
          label: link.label,
          type: link.edgeType,
          arrow: link.arrow,
          // Spans from the left endpoint through the right endpoint (including
          // any inline shape/label) so `source.slice(range)` reproduces the
          // original edge text.
          range: { start: Math.max(from.start, 0), end },
        };
        if (link.labelRange) e.labelRange = link.labelRange;
        statements.push(e);
      }
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Public parse
// ---------------------------------------------------------------------------

export function parseFlowchart(source: string): ParseResult {
  const statements: Statement[] = [];
  const nodesById = new Map<string, NodeStmt[]>();
  const edges: EdgeStmt[] = [];
  const subgraphs: SubgraphStmt[] = [];
  const styles: FlowchartModel['styles'] = [];
  const unknown: { text: string; range: Position }[] = [];

  let direction: FlowchartModel['direction'] = 'TD';
  let directionRange: Position | null = null;
  let bodyStart = 0;

  // ---- header ----
  // The header is line 0. Match `flowchart|graph` + optional direction token
  // on that single line. directionRange covers the whole header line so no
  // character is dropped.
  const nl0 = source.indexOf('\n');
  const headerLineEnd = nl0 === -1 ? source.length : nl0;
  const headerLine = source.slice(0, headerLineEnd);
  const headerMatch = /^\s*(flowchart|graph)\b\s*([A-Za-z]{2})\b/i.exec(headerLine);
  if (headerMatch) {
    const dir = headerMatch[2].toUpperCase();
    if (dir === 'TD' || dir === 'TB' || dir === 'BT' || dir === 'RL' || dir === 'LR') {
      direction = dir;
    }
    directionRange = { start: 0, end: headerLineEnd };
    bodyStart = nl0 === -1 ? source.length : nl0 + 1;
  } else {
    bodyStart = 0;
  }

  // ---- statement scanning ----
  const subgraphStack: SubgraphStmt[] = [];
  let i = bodyStart;

  while (i < source.length) {
    const lineEnd = source.indexOf('\n', i) === -1 ? source.length : source.indexOf('\n', i);
    const line = source.slice(i, lineEnd);
    const trimmed = line.trim();

    if (!trimmed) {
      i = lineEnd < source.length ? lineEnd + 1 : source.length;
      continue;
    }

    if (trimmed.startsWith('%%')) {
      statements.push({ kind: 'comment', range: { start: i, end: lineEnd } });
      i = lineEnd < source.length ? lineEnd + 1 : source.length;
      continue;
    }

    // direction inside subgraph
    const dirStmt = /^direction\s+([A-Za-z]{2})\s*$/.exec(trimmed);
    if (dirStmt) {
      statements.push({
        kind: 'direction',
        value: dirStmt[1].toUpperCase(),
        range: { start: i, end: lineEnd },
      });
      i = lineEnd < source.length ? lineEnd + 1 : source.length;
      continue;
    }

    const classDef = /^classDef\s+([^\s]+)\s+(.*)$/.exec(trimmed);
    if (classDef) {
      const r = { start: i, end: lineEnd };
      const cd: ClassDefStmt = { kind: 'classDef', name: classDef[1], range: r };
      statements.push(cd);
      styles.push(cd);
      i = lineEnd < source.length ? lineEnd + 1 : source.length;
      continue;
    }

    const classAssign = /^class\s+([^\s]+)\s+([^\s]+)\s*$/.exec(trimmed);
    if (classAssign) {
      const r = { start: i, end: lineEnd };
      const ca: ClassAssignStmt = {
        kind: 'class',
        target: classAssign[1],
        className: classAssign[2],
        range: r,
      };
      statements.push(ca);
      styles.push(ca);
      i = lineEnd < source.length ? lineEnd + 1 : source.length;
      continue;
    }

    const styleStmt = /^style\s+([^\s]+)\s+(.*)$/.exec(trimmed);
    if (styleStmt) {
      const r = { start: i, end: lineEnd };
      const s: StyleStmt = { kind: 'style', target: styleStmt[1], range: r };
      statements.push(s);
      styles.push(s);
      i = lineEnd < source.length ? lineEnd + 1 : source.length;
      continue;
    }

    const linkStyle = /^linkStyle\s+([0-9,\s]+?)\s*(?:stroke[^:]*):?.*$/.exec(trimmed);
    if (linkStyle) {
      const r = { start: i, end: lineEnd };
      const indices = linkStyle[1]
        .split(',')
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n));
      const ls: LinkStyleStmt = {
        kind: 'linkStyle',
        index: indices[0] ?? 0,
        indices,
        range: r,
      };
      statements.push(ls);
      styles.push(ls);
      i = lineEnd < source.length ? lineEnd + 1 : source.length;
      continue;
    }

    if (/^subgraph\b/.test(trimmed)) {
      const m = /^subgraph\s+([^\s[]+)(?:\s*\[([^\]]*)\])?\s*$/.exec(trimmed);
      const id = m?.[1] ?? `subgraph_${subgraphs.length}`;
      const label = m?.[2] ?? id;
      const openRange = { start: i, end: i + (m ? m[0].length : trimmed.length) };
      const sg: SubgraphStmt = {
        kind: 'subgraph',
        id,
        label,
        openRange,
        range: { start: i, end: lineEnd },
      };
      statements.push(sg);
      subgraphs.push(sg);
      subgraphStack.push(sg);
      i = lineEnd < source.length ? lineEnd + 1 : source.length;
      continue;
    }

    if (trimmed === 'end') {
      const open = subgraphStack.pop();
      const r = { start: i, end: lineEnd };
      statements.push({
        kind: 'subgraph',
        id: open?.id ?? 'end',
        label: '',
        openRange: open?.openRange ?? r,
        range: r,
      });
      i = lineEnd < source.length ? lineEnd + 1 : source.length;
      continue;
    }

    // node/edge line
    const lineStart = i + (line.length - line.trimStart().length);
    const before = statements.length;
    // A trailing `%% comment` is part of the line but not part of the
    // statement, so it is recorded separately and the code part alone is
    // tokenised. Without this `B[Middle] %% trailing comment` would invent
    // nodes named `trailing` and `comment`.
    let codeEnd = lineEnd;
    const cmt = findTrailingComment(source, lineStart, lineEnd);
    if (cmt !== -1) {
      codeEnd = cmt;
      statements.push({ kind: 'comment', range: { start: cmt, end: lineEnd } });
    }
    const segs = tokenizeLine(source, lineStart, codeEnd);
    const built = buildFromSegments(source, segs, statements, nodesById, styles);
    if (built) {
      for (let k = before; k < statements.length; k++) {
        const st = statements[k];
        if (st.kind === 'edge') edges.push(st);
      }
      // Every modelled statement must cover a contiguous span of the line and
      // nothing outside it may remain unexplained. A malformed line (e.g. an
      // unterminated `A[ `) leaves gaps, so it falls through to `unknown` and
      // its text is preserved verbatim.
      const lineLength = lineEnd - i;
      if (!coversWholeLine(source, i, lineEnd, statements, before)) {
        for (let k = before; k < statements.length; k++) {
          const st = statements[k];
          if (st.kind === 'edge') {
            const at = edges.indexOf(st);
            if (at !== -1) edges.splice(at, 1);
          }
          if (st.kind === 'node') {
            const arr = nodesById.get(st.id);
            if (arr) {
              const at = arr.indexOf(st);
              if (at !== -1) arr.splice(at, 1);
              if (arr.length === 0) nodesById.delete(st.id);
            }
          }
        }
        statements.length = before;
        unknown.push({ text: line, range: { start: i, end: lineEnd } });
        i = lineEnd < source.length ? lineEnd + 1 : source.length;
        continue;
      }
      void lineLength;
      i = lineEnd < source.length ? lineEnd + 1 : source.length;
      continue;
    }

    unknown.push({ text: line, range: { start: i, end: lineEnd } });
    i = lineEnd < source.length ? lineEnd + 1 : source.length;
  }

  // An opening `subgraph` line is recorded with `range` ending at its own
  // newline, but the contract is that a subgraph's range spans its whole block
  // through the matching `end` — that is what makes containment tests like
  // `moveNodeIntoSubgraph` meaningful. Widen each opener here, now that every
  // `end` has been seen. The separate `end` statement keeps its own one-line
  // range, so `source.slice(range)` still round-trips each of them.
  widenSubgraphRanges(source, statements, subgraphs);

  return {
    ok: true,
    model: {
      direction,
      directionRange,
      statements,
      nodesById,
      edges,
      subgraphs,
      styles,
      unknown,
      bodyStart,
      bodyEnd: lastNonSpaceEnd(source),
    },
  };
}

/**
 * Widen each opening `subgraph` statement's range to cover its whole block.
 *
 * The scan records a `subgraph` line with `range` ending at that line's
 * newline, because the line-coverage check runs per line and needs the opener
 * to explain only its own text. By the time this runs, every `end` has been
 * seen, so each opener can be extended to the matching `end`.
 *
 * Nesting is matched by depth: `end` closes the innermost open subgraph. An
 * unterminated subgraph is left alone rather than swallowing the rest of the
 * file, so a half-typed block degrades instead of hiding everything after it.
 *
 * The `end` statements keep their own one-line ranges, so
 * `source.slice(range)` still round-trips both an opener and a closer.
 */
function widenSubgraphRanges(
  source: string,
  statements: Statement[],
  subgraphs: SubgraphStmt[],
): void {
  // Walk statements, tracking which openers are still waiting for their `end`.
  const pending: SubgraphStmt[] = [];
  for (const st of statements) {
    if (st.kind === 'subgraph') {
      // An opener's `openRange` equals its `range` at this point; a closer has
      // the same `openRange` as the opener it matched.
      const isOpening = st.range.start === st.openRange.start;
      if (isOpening && subgraphs.includes(st as SubgraphStmt)) {
        pending.push(st as SubgraphStmt);
      } else if (pending.length > 0) {
        const open = pending.pop()!;
        open.range = { start: open.range.start, end: st.range.end };
      }
    }
  }
  // Unterminated openers keep their original one-line range.
  void source;
}

/**
 * Locate a trailing `%%` comment on a line.
 *
 * `%%` inside a quoted label is label text, not a comment, so the scan tracks
 * quote state. Returns the offset of the comment, or -1 when the line has none.
 */
function findTrailingComment(src: string, start: number, end: number): number {
  let quote = '';
  for (let i = start; i < end; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '%' && src[i + 1] === '%') return i;
  }
  return -1;
}

/**
 * True when the statements produced for [lineStart, from) explain every
 * non-whitespace character of the line. A malformed line leaves gaps, which
 * signals the whole line should be treated as unknown text.
 */
function coversWholeLine(
  src: string,
  lineStart: number,
  lineEnd: number,
  statements: Statement[],
  from: number,
): boolean {
  const covered = new Uint8Array(lineEnd - lineStart);
  for (let k = from; k < statements.length; k++) {
    const r = statements[k].range;
    for (let i = Math.max(lineStart, r.start); i < Math.min(lineEnd, r.end); i++) {
      covered[i - lineStart] = 1;
    }
  }
  for (let i = lineStart; i < lineEnd; i++) {
    if (!covered[i - lineStart] && !/\s/.test(src[i])) return false;
  }
  return true;
}

function lastNonSpaceEnd(src: string): number {
  let e = src.length;
  while (e > 0 && /\s/.test(src[e - 1])) e--;
  return e;
}

export function nodeList(model: FlowchartModel): NodeStmt[] {
  const out: NodeStmt[] = [];
  for (const st of model.statements) if (st.kind === 'node') out.push(st);
  return out;
}

export function uniqueNodes(model: FlowchartModel): NodeStmt[] {
  const seen = new Map<string, NodeStmt>();
  for (const n of nodeList(model)) if (!seen.has(n.id)) seen.set(n.id, n);
  return [...seen.values()];
}

export function nodeRange(model: FlowchartModel, id: string): Position | null {
  const list = model.nodesById.get(id);
  return list && list.length ? list[0].range : null;
}