/**
 * Edit-mode interaction logic for the preview.
 *
 * Everything here is pure and DOM-free so it can be unit-tested; App.tsx owns
 * the actual event wiring. Two rules govern this layer:
 *
 *  1. There is exactly one `editMode` flag. No per-tool mode exists — which
 *     operation a gesture performs is derived from what is selected and what
 *     is hovered, never from a mode variable.
 *  2. Every visual gesture maps to a patch-engine call. This module decides
 *     *which* call, given a gesture and a model.
 */

import type { FlowchartModel } from './parser';

/** A resolved click/drag target in the preview. */
export interface Target {
  kind: 'node' | 'edge' | 'subgraph';
  id: string;
}

/** Stable key for a target, matching svg-map's `node:A` / `edge:A->B` form. */
export function targetKey(t: Target): string {
  return t.kind === 'edge' ? `edge:${t.id}` : `${t.kind}:${t.id}`;
}

export function targetFromKey(key: string): Target | null {
  const i = key.indexOf(':');
  if (i === -1) return null;
  const kind = key.slice(0, i);
  const id = key.slice(i + 1);
  if (kind === 'node' || kind === 'edge' || kind === 'subgraph') return { kind, id };
  return null;
}

/**
 * Split an edge key into its endpoints.
 *
 * Edge ids are `from->to`, but a node id may itself contain `->`, so we split
 * on the *last* arrow only when the model confirms it — see `resolveEdgeKey`.
 */
export function edgeEnds(id: string): { from: string; to: string } | null {
  const i = id.lastIndexOf('->');
  if (i === -1) return null;
  return { from: id.slice(0, i), to: id.slice(i + 2) };
}

/** Confirm an edge key exists in the model, resolving ambiguous splits. */
export function resolveEdgeKey(
  model: FlowchartModel,
  id: string,
): { from: string; to: string; index: number } | null {
  for (let i = 0; i < model.edges.length; i++) {
    const e = model.edges[i];
    if (`${e.from}->${e.to}` === id) return { from: e.from, to: e.to, index: i };
  }
  const ends = edgeEnds(id);
  if (!ends) return null;
  const index = model.edges.findIndex((e) => e.from === ends.from && e.to === ends.to);
  return index === -1 ? null : { ...ends, index };
}

/**
 * True when dropping a drag of `movingId` onto `targetId` should reconnect an
 * edge rather than re-parent a node.
 *
 * Dragging a *node* re-parents it (Step 9a). Dragging an edge's *endpoint*
 * handle reconnects that edge (Step 8). The caller decides which it has based
 * on where the drag started, so this only needs to reject the degenerate cases:
 * dropping onto itself, or onto a node that is already the other end.
 */
export function canReconnect(
  model: FlowchartModel,
  edgeIndex: number,
  newEndpointId: string,
): boolean {
  const edge = model.edges[edgeIndex];
  if (!edge) return false;
  if (newEndpointId === edge.from || newEndpointId === edge.to) return false;
  if (!model.nodesById.has(newEndpointId)) return false;
  return true;
}

/**
 * Pick the subgraph a node should move into, given a drop target.
 *
 * Dropping on a cluster moves it there; dropping on empty canvas means "out of
 * any subgraph", which we express as `null` and handle by leaving the node
 * where it is (Mermaid has no explicit "top level" marker to write).
 */
export function dropSubgraphId(
  model: FlowchartModel,
  target: Target | null,
): string | null {
  if (!target || target.kind !== 'subgraph') return null;
  return model.subgraphs.some((s) => s.id === target.id) ? target.id : null;
}

/**
 * Delete key handling for the current selection.
 *
 * Returns the action the UI should take, or null for nothing. A node with many
 * connections is flagged so the UI can confirm first — losing a hub node is
 * the one destructive edit worth interrupting.
 */
export type DeleteAction =
  | { type: 'delete-node'; id: string; confirm: boolean }
  | { type: 'delete-edge'; index: number }
  | null;

export function deleteActionFor(
  model: FlowchartModel,
  selection: Target | null,
): DeleteAction {
  if (!selection) return null;
  if (selection.kind === 'edge') {
    const found = resolveEdgeKey(model, selection.id);
    return found ? { type: 'delete-edge', index: found.index } : null;
  }
  if (selection.kind !== 'node') return null;
  if (!model.nodesById.has(selection.id)) return null;
  const degree = model.edges.filter((e) => e.from === selection.id || e.to === selection.id).length;
  return { type: 'delete-node', id: selection.id, confirm: degree > 3 };
}

/**
 * Decoded label for an inline rename input.
 *
 * The parser stores source text, so an entity-escaped label arrives as
 * `&quot;` — the user must see a real quote. Numeric entities are decoded too,
 * even though we never emit them, because a hand-typed file may contain them.
 */
export function displayLabel(raw: string): string {
  return raw
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

/**
 * Range of the statement a text offset belongs to, for two-way selection.
 *
 * Walk every statement's range and return the narrowest one containing the
 * offset. Narrowest wins because edge ranges intentionally overlap: in a chain
 * `A --> B --> C` the cursor sits in two statements at once, and the one with
 * the tighter span is the one the user is looking at.
 */
export function selectionTargetAt(
  model: FlowchartModel,
  offset: number,
): Target | null {
  let best: Target | null = null;
  let bestSize = Infinity;
  for (const st of model.statements) {
    if (offset < st.range.start || offset >= st.range.end) continue;
    const size = st.range.end - st.range.start;
    if (size >= bestSize) continue;
    if (st.kind === 'node') best = { kind: 'node', id: st.id };
    else if (st.kind === 'edge') best = { kind: 'edge', id: `${st.from}->${st.to}` };
    else if (st.kind === 'subgraph') best = { kind: 'subgraph', id: st.id };
    if (best) bestSize = size;
  }
  return best;
}

/** Range to highlight in the editor when a target is selected in the preview. */
export function selectionRangeOf(
  model: FlowchartModel,
  target: Target,
): { start: number; end: number } | null {
  if (target.kind === 'node') {
    const list = model.nodesById.get(target.id);
    return list?.[0]?.range ?? null;
  }
  if (target.kind === 'edge') {
    const found = resolveEdgeKey(model, target.id);
    return found ? model.edges[found.index].range : null;
  }
  const sg = model.subgraphs.find((s) => s.id === target.id);
  return sg?.openRange ?? null;
}
