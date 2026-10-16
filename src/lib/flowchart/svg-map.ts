/**
 * Maps rendered SVG elements back to model IDs.
 *
 * Mermaid gives us no editable model, so every visual interaction has to be
 * resolved through the DOM. The id shapes below are pinned by
 * tests/e2e/svg-ids.spec.ts — if a Mermaid upgrade changes them, that test
 * fails loudly on purpose. Do not silently loosen these patterns.
 *
 * Verified against mermaid 11.17.2 (see TESTING.md):
 *
 *   nodes      g#<prefix>flowchart-<id>-<n>   class="node ..."     in g.nodes
 *   edges      path#<prefix>L_<from>_<to>_<n> class="flowchart-link" in g.edgePaths
 *   edge labels g.edgeLabel (NO id) — resolved by document order
 *   subgraphs  g#<prefix>-<subgraphId>        class="cluster"      in g.clusters
 *
 * The `<prefix>` is the render id we passed to `mermaid.render()` (the app uses
 * `mmd-<seq>-<rand>`), so ids are always `<prefix>flowchart-A-0` etc.
 */

import type { FlowchartModel } from './parser';

export type DiagramKind = 'node' | 'edge' | 'subgraph';

export interface SvgBinding {
  /** Model id for nodes/subgraphs; `from->to` for edges. */
  key: string;
  kind: DiagramKind;
  element: SVGElement;
  /** Index within the model's node list, for duplicate edges. */
  index: number;
}

export interface SvgIndex {
  /** Every element we could bind, in document order. */
  bindings: SvgBinding[];
  /** key -> element (first wins). */
  byKey: Map<string, SvgBinding>;
  /** Subgraph id -> element. */
  bySubgraph: Map<string, SVGElement>;
  /** Model ids with no matching SVG element (e.g. inside a collapsed cluster). */
  missing: string[];
  /** The render prefix detected on this SVG, e.g. "mmd-3-mv3q56mt". */
  prefix: string;
}

const NODE_ID_RE = /^(.*)flowchart-(.+)-(\d+)$/;
const EDGE_ID_RE = /^(.*)L_(.+?)_(.+?)_(\d+)$/;
const CLUSTER_ID_RE = /^(.*)-([A-Za-z0-9_][\w-]*)$/;

function q(root: ParentNode, sel: string): Element[] {
  return Array.from(root.querySelectorAll(sel));
}

/**
 * Build the SVG -> model lookup. Safe to call after every render; it is a pure
 * function of the DOM plus the parsed model.
 */
export function buildSvgIndex(svg: SVGElement, model: FlowchartModel): SvgIndex {
  const bindings: SvgBinding[] = [];
  const byKey = new Map<string, SvgBinding>();
  const bySubgraph = new Map<string, SVGElement>();
  const seen = new Set<string>();

  // ---- nodes -------------------------------------------------------------
  // Prefer the `g.nodes` container so cluster labels are never mistaken for
  // node shapes.
  const nodesRoot = svg.querySelector('g.nodes') ?? svg;
  for (const el of q(nodesRoot, 'g.node[id]')) {
    const id = el.getAttribute('id') ?? '';
    const m = NODE_ID_RE.exec(id);
    if (!m) continue;
    const nodeId = m[2];
    const key = `node:${nodeId}`;
    const binding: SvgBinding = { key, kind: 'node', element: el as SVGElement, index: 0 };
    bindings.push(binding);
    if (!seen.has(key)) {
      byKey.set(key, binding);
      seen.add(key);
    }
  }

  // ---- edges -------------------------------------------------------------
  const edgesRoot = svg.querySelector('g.edgePaths') ?? svg;
  const edgeEls = q(edgesRoot, 'path[id]').filter((el) => EDGE_ID_RE.test(el.getAttribute('id') ?? ''));
  // Pair each edge with its label by order: Mermaid emits one `g.edgeLabel`
  // per edge, in the same order as the edge paths.
  const labelEls = q(svg, 'g.edgeLabel');

  const modelEdges = model.edges;
  edgeEls.forEach((el, i) => {
    const id = el.getAttribute('id') ?? '';
    const m = EDGE_ID_RE.exec(id)!;
    const from = m[2];
    const to = m[3];
    const key = `edge:${from}->${to}`;
    const binding: SvgBinding = { key, kind: 'edge', element: el as SVGElement, index: i };
    bindings.push(binding);
    if (!seen.has(key)) {
      byKey.set(key, binding);
      seen.add(key);
    }
    // Attach the corresponding edge label, if any, so double-click-to-edit
    // can target it.
    const label = labelEls[i] as SVGElement | undefined;
    if (label) binding.element.setAttribute('data-model-edge-label', String(i));
  });

  // ---- subgraphs ---------------------------------------------------------
  const clustersRoot = svg.querySelector('g.clusters') ?? svg;
  let prefix = '';
  for (const el of q(clustersRoot, 'g.cluster[id]')) {
    const id = el.getAttribute('id') ?? '';
    const m = CLUSTER_ID_RE.exec(id);
    if (!m) continue;
    if (!prefix) prefix = m[1];
    const sgId = m[2];
    bySubgraph.set(sgId, el as SVGElement);
    const binding: SvgBinding = { key: `subgraph:${sgId}`, kind: 'subgraph', element: el as SVGElement, index: 0 };
    bindings.push(binding);
    if (!seen.has(binding.key)) {
      byKey.set(binding.key, binding);
      seen.add(binding.key);
    }
  }

  if (!prefix) {
    const anyId = bindings[0]?.element.getAttribute('id');
    const m = anyId ? NODE_ID_RE.exec(anyId) ?? EDGE_ID_RE.exec(anyId) : null;
    prefix = m ? m[1] : '';
  }

  // ---- coverage check ----------------------------------------------------
  // A model item with no SVG element means the click layer would silently
  // ignore it; surface it so tests and the UI can warn.
  const missing: string[] = [];
  for (const id of model.nodesById.keys()) {
    if (!byKey.has(`node:${id}`)) missing.push(id);
  }

  return { bindings, byKey, bySubgraph, missing, prefix };
}

/**
 * Find the binding for the deepest SVG element under `target`.
 * Walks up from the actual event target because clicks land on inner
 * `<rect>`/`<span>` elements, not on the `<g class="node">` wrapper.
 *
 * When `prefer` is given, an enclosing element of that kind wins over whatever
 * the walk finds first. A node drag dropping onto a cluster is the case: the
 * drop point often sits on an edge path drawn across the cluster, and without
 * the preference the drop would target the edge instead of the cluster the
 * user visibly aimed at.
 */
export function bindingFromEvent(
  target: EventTarget | null,
  index: SvgIndex,
  prefer?: 'subgraph',
): SvgBinding | null {
  let el = target as Element | null;
  let deferred: SvgBinding | null = null;
  while (el && el !== document.documentElement) {
    if (el instanceof SVGElement) {
      const hit = index.byKey.get(keyForElement(el, index));
      if (hit) {
        if (!prefer || hit.kind === prefer) return hit;
        // Remember the direct hit but keep climbing: an ancestor of the
        // preferred kind still wins.
        deferred ??= hit;
      }
      // cluster labels and shapes are inside their wrapper groups
      const cluster = el.closest('g.cluster[id]');
      if (cluster) {
        const id = cluster.getAttribute('id') ?? '';
        const m = CLUSTER_ID_RE.exec(id);
        if (m) {
          const found = index.byKey.get(`subgraph:${m[2]}`);
          if (found) return found;
        }
      }
    }
    el = el.parentElement;
  }
  return deferred;
}

/** Compute the lookup key for a specific SVG element. */
export function keyForElement(el: Element, index: SvgIndex): string {
  const id = el.getAttribute('id');
  if (id) {
    const n = NODE_ID_RE.exec(id);
    if (n) return `node:${n[2]}`;
    const e = EDGE_ID_RE.exec(id);
    if (e) return `edge:${e[2]}->${e[3]}`;
    const c = CLUSTER_ID_RE.exec(id);
    if (c) return `subgraph:${c[2]}`;
  }
  const cluster = el.closest?.('g.cluster[id]');
  if (cluster) {
    const c = CLUSTER_ID_RE.exec(cluster.getAttribute('id') ?? '');
    if (c) return `subgraph:${c[2]}`;
  }
  void index;
  return '';
}

/** Human-readable label text of a bound node, for the inline rename input. */
export function svgLabelText(el: SVGElement): string {
  const span = el.querySelector('.nodeLabel, .edgeLabel, text');
  return (span?.textContent ?? '').trim();
}

/**
 * The subgraph whose rendered box contains a viewport point, if any.
 *
 * Edge paths are *not* nested inside cluster groups — Mermaid draws all edges
 * in a separate layer — so DOM ancestry cannot resolve "which cluster did the
 * user drop onto". Geometry can: compare viewport rects, which already include
 * every transform Mermaid and the pan/zoom wrapper applied. The smallest
 * containing box wins so nested clusters resolve to the inner one.
 */
export function subgraphAtPoint(index: SvgIndex, x: number, y: number): string | null {
  let best: string | null = null;
  let bestArea = Infinity;
  for (const [id, el] of index.bySubgraph) {
    const r = el.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    const area = r.width * r.height;
    if (area < bestArea) {
      bestArea = area;
      best = id;
    }
  }
  return best;
}