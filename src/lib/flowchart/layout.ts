/**
 * Keyboard-driven node positioning (extend-plan Step 9, keyboard strategy).
 *
 * Mermaid owns the layout, so a "moved" node is stored as a *delta* on top of
 * whatever Mermaid computed, persisted in the source as a trailing comment:
 *
 *     %% layout: A=10,0 B=-20,30
 *
 * Keeping the offsets in the text is what makes this honest rather than a
 * half-version of free positioning: the position survives re-render, undo and
 * share links, and every visual edit flows through the same source of truth.
 *
 * The half-version the plan warns against is "node moves, arrows stay". This
 * module therefore also repairs edge paths after a nudge: each connector's
 * endpoint that touches a moved node is translated by that node's delta, so
 * the line still lands on the node border. Only the anchor point moves — the
 * preceding curve segment stretches, which keeps the join smooth for the
 * small deltas a keyboard nudge produces.
 */

import type { FlowchartModel, Position } from './parser';

export interface LayoutOffset {
  dx: number;
  dy: number;
}

export interface ParsedLayout {
  offsets: Map<string, LayoutOffset>;
  /** Range of the `%% layout:` line's text, when present. */
  range: Position | null;
}

const LAYOUT_LINE_RE = /^%%\s*layout:\s*(.*)$/;
const ENTRY_RE = /^([A-Za-z_][\w-]*)=(-?\d+),(-?\d+)$/;

/** Read the `%% layout:` comment, if the source has one. */
export function parseLayout(src: string): ParsedLayout {
  const lines = src.split('\n');
  let acc = 0;
  for (const line of lines) {
    const m = LAYOUT_LINE_RE.exec(line);
    if (m) {
      const offsets = new Map<string, LayoutOffset>();
      for (const part of m[1].trim().split(/\s+/).filter(Boolean)) {
        const pm = ENTRY_RE.exec(part);
        if (pm) offsets.set(pm[1], { dx: Number(pm[2]), dy: Number(pm[3]) });
      }
      return { offsets, range: { start: acc, end: acc + line.length } };
    }
    acc += line.length + 1;
  }
  return { offsets: new Map(), range: null };
}

const fmt = (n: number): string => String(Math.round(n * 1000) / 1000);

/**
 * Add `(dx, dy)` to node `id`'s stored offset, returning the new source.
 *
 * The line is appended, updated in place, or removed entirely when no offsets
 * remain — a diagram that was never nudged must not grow a layout comment.
 * Entries for nodes that no longer exist are pruned on every write, so
 * deleting a node cannot leave stale offsets behind.
 */
export function setNodeOffset(
  src: string,
  model: FlowchartModel,
  id: string,
  dx: number,
  dy: number,
): string {
  const { offsets, range } = parseLayout(src);

  const prev = offsets.get(id) ?? { dx: 0, dy: 0 };
  const next = { dx: prev.dx + dx, dy: prev.dy + dy };
  if (next.dx === 0 && next.dy === 0) offsets.delete(id);
  else offsets.set(id, next);

  // Offsets for deleted nodes are dead weight; drop them on every write.
  for (const key of [...offsets.keys()]) {
    if (!model.nodesById.has(key)) offsets.delete(key);
  }

  if (offsets.size === 0) {
    if (!range) return src;
    // Remove the whole line, newline included, so no blank residue remains.
    const endWithNl = src[range.end] === '\n' ? range.end + 1 : range.end;
    return src.slice(0, range.start) + src.slice(endWithNl);
  }

  const line =
    '%% layout: ' +
    [...offsets].map(([key, v]) => `${key}=${fmt(v.dx)},${fmt(v.dy)}`).join(' ');

  if (range) return src.slice(0, range.start) + line + src.slice(range.end);
  // Append after the body. A trailing newline keeps the file tidy; if the
  // source does not end with one, add it first so the comment starts a line.
  return src.endsWith('\n') ? `${src}${line}\n` : `${src}\n${line}\n`;
}

/* -------------------------------------------------------------------------- */
/* Edge path repair                                                           */
/* -------------------------------------------------------------------------- */

interface PathCmd {
  cmd: string;
  nums: number[];
  /** Separator used between numbers in the source (`''` for mermaid's commas). */
  sep: string;
}

function tokenizePath(d: string): PathCmd[] {
  const out: PathCmd[] = [];
  const re = /([A-Za-z])([^A-Za-z]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d)) !== null) {
    const raw = m[2];
    const nums = raw
      .split(/[\s,]+/)
      .filter((s) => s.length > 0)
      .map(Number)
      .filter((n) => Number.isFinite(n));
    // Preserve the command's own separator so untouched formatting survives.
    const sep = raw.includes(' ') ? ' ' : ',';
    out.push({ cmd: m[1], nums, sep });
  }
  return out;
}

/**
 * Repair an edge path so its endpoints follow moved nodes.
 *
 * - `start` translates the path's first anchor point (the end touching the
 *   edge's `from` node).
 * - `end` translates the final anchor point (the `to` node's end). For arc
 *   commands only the trailing coordinate pair moves — the radii and flags
 *   must not.
 * - `all` translates every point, for self-loops where both ends sit on the
 *   same moved node.
 *
 * Only anchors move; the surrounding curve segments stretch instead of
 * rotating, which keeps the join at the node border smooth for small deltas.
 */
export function repairPathD(
  d: string,
  opts: { start?: LayoutOffset | null; end?: LayoutOffset | null; all?: LayoutOffset | null },
): string {
  const cmds = tokenizePath(d);
  if (cmds.length === 0) return d;
  const { start, end, all } = opts;

  if (all && (all.dx !== 0 || all.dy !== 0)) {
    for (const c of cmds) {
      if (c.cmd === 'A') {
        // Arcs carry radii/flags before the point; only the point moves.
        if (c.nums.length >= 2) {
          c.nums[c.nums.length - 2] += all.dx;
          c.nums[c.nums.length - 1] += all.dy;
        }
      } else if (c.cmd === 'H') {
        for (let i = 0; i < c.nums.length; i++) c.nums[i] += all.dx;
      } else if (c.cmd === 'V') {
        for (let i = 0; i < c.nums.length; i++) c.nums[i] += all.dy;
      } else {
        for (let i = 0; i + 1 < c.nums.length; i += 2) {
          c.nums[i] += all.dx;
          c.nums[i + 1] += all.dy;
        }
      }
    }
    return cmds.map((c) => c.cmd + c.nums.map(fmt).join(',')).join('');
  }

  // Start anchor: the first command is the move to the `from` border.
  if (start && (start.dx !== 0 || start.dy !== 0) && cmds[0].nums.length >= 2) {
    cmds[0].nums[0] += start.dx;
    cmds[0].nums[1] += start.dy;
  }

  // End anchor: the final coordinate pair of the last command.
  if (end && (end.dx !== 0 || end.dy !== 0)) {
    const c = cmds[cmds.length - 1];
    if (c.cmd === 'A' && c.nums.length >= 2) {
      c.nums[c.nums.length - 2] += end.dx;
      c.nums[c.nums.length - 1] += end.dy;
    } else if (c.cmd === 'H' && c.nums.length > 0) {
      c.nums[c.nums.length - 1] += end.dx;
    } else if (c.cmd === 'V' && c.nums.length > 0) {
      c.nums[c.nums.length - 1] += end.dy;
    } else if (c.nums.length >= 2) {
      c.nums[c.nums.length - 2] += end.dx;
      c.nums[c.nums.length - 1] += end.dy;
    }
  }

  return cmds.map((c) => c.cmd + c.nums.map(fmt).join(',')).join('');
}

/* -------------------------------------------------------------------------- */
/* DOM application                                                            */
/* -------------------------------------------------------------------------- */

// Same id shapes as svg-map; both are pinned by tests/e2e/svg-ids.spec.ts.
const NODE_ID_RE = /^(.*)flowchart-(.+)-(\d+)$/;
const EDGE_ID_RE = /^(.*)L_(.+?)_(.+?)_(\d+)$/;

/**
 * Compose a translate onto an element's existing transform attribute.
 *
 * The pristine attribute is cached in a data attribute on first touch, so
 * re-applying after a React strict-mode double-effect (or any repeat on the
 * same DOM) is idempotent instead of accumulating the delta twice. A fresh
 * render replaces the whole SVG, so the cache is naturally pristine again.
 */
function composeTranslate(el: SVGGraphicsElement, dx: number, dy: number): void {
  if (el.dataset.mmdBaseTransform === undefined) {
    el.dataset.mmdBaseTransform = el.getAttribute('transform') ?? '';
  }
  const base = el.dataset.mmdBaseTransform;
  if (dx === 0 && dy === 0) {
    el.setAttribute('transform', base);
    return;
  }
  el.setAttribute('transform', `${base} translate(${fmt(dx)},${fmt(dy)})`.trim());
}

/**
 * Apply stored offsets to a rendered SVG: translate node groups and repair
 * every edge path touching them so the connectors still land on the border.
 * Edge labels shift by the average of their endpoints' deltas.
 *
 * Safe to call after every render: offsets for unknown ids are ignored, and
 * elements carry their pristine geometry in data attributes so repeated calls
 * never accumulate.
 */
export function applyLayout(
  svg: SVGElement,
  model: FlowchartModel,
  offsets: Map<string, LayoutOffset>,
): void {
  if (offsets.size === 0) return;

  // 1. Node groups.
  const nodeEls = [...svg.querySelectorAll<SVGGraphicsElement>('g.node[id]')];
  const moved = new Map<string, LayoutOffset>();
  for (const [id, off] of offsets) {
    if (!model.nodesById.has(id)) continue;
    if (off.dx === 0 && off.dy === 0) continue;
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const el = nodeEls.find((n) =>
      new RegExp(`flowchart-${esc}-\\d+$`).test(n.getAttribute('id') ?? ''),
    );
    if (!el) continue;
    composeTranslate(el, off.dx, off.dy);
    moved.set(id, off);
  }
  if (moved.size === 0) return;

  // 2. Edge paths touching a moved node, plus their labels (paired by order —
  //    the same assumption svg-map makes: one `g.edgeLabel` per edge).
  const paths = [...svg.querySelectorAll<SVGGraphicsElement>('path.flowchart-link[id]')];
  const labels = [...svg.querySelectorAll<SVGGraphicsElement>('g.edgeLabel')];

  paths.forEach((path, i) => {
    const m = EDGE_ID_RE.exec(path.getAttribute('id') ?? '');
    if (!m) return;
    const from = m[2];
    const to = m[3];
    const start = moved.get(from) ?? null;
    const end = moved.get(to) ?? null;

    if (start && end && from === to) {
      // Self-loop on one moved node: shift the whole path.
      if (path.dataset.mmdBaseD === undefined) path.dataset.mmdBaseD = path.getAttribute('d') ?? '';
      path.setAttribute(
        'd',
        repairPathD(path.dataset.mmdBaseD ?? '', {
          all: { dx: start.dx, dy: start.dy },
        }),
      );
    } else if (start || end) {
      if (path.dataset.mmdBaseD === undefined) path.dataset.mmdBaseD = path.getAttribute('d') ?? '';
      path.setAttribute(
        'd',
        repairPathD(path.dataset.mmdBaseD ?? '', {
          start: from === to ? null : start,
          end: from === to ? null : end,
        }),
      );
    } else {
      return;
    }

    // Label sits at the path midpoint; moving one end shifts it by ~half.
    const label = labels[i];
    if (label) {
      const ldx = ((start?.dx ?? 0) + (end?.dx ?? 0)) / 2;
      const ldy = ((start?.dy ?? 0) + (end?.dy ?? 0)) / 2;
      if (ldx !== 0 || ldy !== 0) composeTranslate(label, ldx, ldy);
    }
  });
}
