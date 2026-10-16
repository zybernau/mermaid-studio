/**
 * Edit mode for the diagram preview.
 *
 * The whole feature rests on one rule, from extend-plan.md:
 *
 *   There is exactly one `editMode` flag. Nothing else decides whether the
 *   diagram is editable. There is deliberately no `tool` state — which
 *   operation a gesture performs is derived from what is selected and what is
 *   hovered, never from a mode variable.
 *
 * Everything visual (select, rename, reconnect, move, delete) is gated on
 * `editMode`. Outside it the preview is a plain zoom/pan viewer.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { parseFlowchart, type FlowchartModel, type NodeShape } from './flowchart/parser';
import { buildSvgIndex, bindingFromEvent, type SvgIndex } from './flowchart/svg-map';
import { deleteActionFor, selectionTargetAt, targetKey, targetFromKey, type Target } from './flowchart/interact';import {
  addEdge,
  addNode,
  changeEdgeLabel,
  changeEdgeToken,
  changeShape,
  deleteEdge,
  deleteNode,
  moveNodeIntoSubgraph,
  renameNode,
  setDirection,
  setNodeStyle,
  tokenFor,
  uniqueNodeId,
} from './flowchart/patch';
import {
  canRedo,
  canUndo,
  initialHistory,
  pushHistory,
  redo as redoHistory,
  undo as undoHistory,
  type HistoryState,
} from './flowchart/history';

export interface EditMode {
  on: boolean;
  toggle: () => void;
  /** Cleared automatically when edit mode turns off. */
  selected: Target | null;
  select: (t: Target | null) => void;
  /** Called by the editor when the caret moves; selects the matching shape. */
  selectAtOffset: (offset: number) => void;
  index: SvgIndex | null;
  /** True when the current text parses — visual edits need a live model. */
  ok: boolean;
  model: FlowchartModel | null;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** Every visual action funnels through here so undo covers them all. */
  apply: (next: string, note?: string) => void;
  actions: EditActions;
}

export interface EditActions {
  addNode: () => void;
  /** Delete the selection. Returns true when a hub confirm is needed. */
  deleteSelected: (opts?: { confirmed?: boolean }) => boolean;
  renameNode: (id: string, label: string) => void;
  reconnect: (edgeIndex: number, newEndpointId: string) => void;
  moveIntoSubgraph: (nodeId: string, subgraphId: string) => void;
  setEdgeLabel: (edgeIndex: number, label: string) => void;
  setEdgeToken: (edgeIndex: number, token: string) => void;
  setShape: (id: string, shape: NodeShape) => void;
  setFill: (id: string, fill: string) => void;
  setDirection: (direction: 'TD' | 'LR') => void;
}

/**
 * Drive edit mode from the current source text.
 *
 * `source` is the editor's text, and it is the single source of truth: the
 * model, the history and the SVG index are all derived from it.
 */
export function useEditMode(
  source: string,
  setSource: (next: string) => void,
  svg: string | null,
  svgHostRef: React.RefObject<HTMLElement | null>,
): EditMode {
  const [on, setOn] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [index, setIndex] = useState<SvgIndex | null>(null);
  const [history, setHistory] = useState<HistoryState>(() => initialHistory(source));

  // The parser is tolerant by design, so `ok` comes from Mermaid's own parse
  // rather than from our model being non-null.
  const parsed = useMemo(() => parseFlowchart(source), [source]);
  const model = parsed.model;

  // A source change that does not come from a visual edit still has to land in
  // history, otherwise the first undo after typing would jump past a visual
  // edit. Grouping collapses the burst of changes a drag produces.
  useEffect(() => {
    setHistory((h) => pushHistory(h, source, Date.now()));
  }, [source]);

  const selected = selectedKey ? targetFromKey(selectedKey) : null;

  const apply = useCallback(
    (next: string, note?: string) => {
      if (next === source) return;
      void note;
      setSource(next);
    },
    [source, setSource],
  );

  // Rebuild the SVG index whenever either the rendered markup or the model
  // changes. A new render produces a new string, so this fires after every
  // diagram update — which is exactly when the old index goes stale.
  useEffect(() => {
    const host = svgHostRef.current;
    const el = host?.querySelector('svg');
    if (!el || !model) {
      setIndex(null);
      return;
    }
    setIndex(buildSvgIndex(el as SVGElement, model));
  }, [svg, model, svgHostRef]);

  // Leaving edit mode clears the selection, so no stale highlight survives.
  const toggle = useCallback(() => {
    setOn((v) => {
      if (v) setSelectedKey(null);
      return !v;
    });
  }, []);

  const select = useCallback((t: Target | null) => {
    setSelectedKey(t ? targetKey(t) : null);
  }, []);

  // Editor -> preview: the caret moved, so select the statement under it. Only
  // meaningful in edit mode; in view mode the caret is just a caret.
  const selectAtOffset = useCallback(
    (offset: number) => {
      if (!on || !model) return;
      const t = selectionTargetAt(model, offset);
      setSelectedKey((prev) => {
        const next = t ? targetKey(t) : null;
        return prev === next ? prev : next;
      });
    },
    [on, model],
  );

  const undo = useCallback(() => setHistory((h) => undoHistory(h)), []);
  const redo = useCallback(() => setHistory((h) => redoHistory(h)), []);

  // Undo/redo write straight to the editor text, which is what history holds.
  useEffect(() => {
    if (history.present !== source) setSource(history.present);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history.present]);

  const actions = useMemo<EditActions>(
    () => ({
      addNode: () => {
        if (!model) return;
        const id = uniqueNodeId(model, 'new');
        apply(addNode(source, model, id));
        select({ kind: 'node', id });
      },
      deleteSelected: (opts) => {
        if (!model || !selected) return false;
        const action = deleteActionFor(model, selected);
        if (!action) return false;
        if (action.type === 'delete-node') {
          // A hub delete is the one destructive edit worth interrupting.
          if (action.confirm && !opts?.confirmed) return true;
          apply(deleteNode(source, model, action.id));
        } else {
          apply(deleteEdge(source, model, action.index));
        }
        setSelectedKey(null);
        return false;
      },
      renameNode: (id, label) => {
        if (!model) return;
        apply(renameNode(source, model, id, label));
      },
      reconnect: (edgeIndex, newEndpointId) => {
        if (!model) return;
        const edge = model.edges[edgeIndex];
        if (!edge) return;
        // Reconnecting keeps the arrow style and the label; only the endpoint
        // changes. deleteEdge + addEdge is how the patch engine expresses that.
        const after = deleteEdge(source, model, edgeIndex);
        const reparsed = parseFlowchart(after).model;
        if (!reparsed) return;
        apply(
          addEdge(after, reparsed, edge.from, newEndpointId, tokenFor(edge), edge.label),
        );
        select({ kind: 'edge', id: `${edge.from}->${newEndpointId}` });
      },
      moveIntoSubgraph: (nodeId, subgraphId) => {
        if (!model) return;
        apply(moveNodeIntoSubgraph(source, model, nodeId, subgraphId));
      },
      setEdgeLabel: (edgeIndex, label) => {
        if (!model) return;
        apply(changeEdgeLabel(source, model, edgeIndex, label));
      },
      setEdgeToken: (edgeIndex, token) => {
        if (!model) return;
        apply(changeEdgeToken(source, model, edgeIndex, token));
      },
      setShape: (id, shape) => {
        if (!model) return;
        apply(changeShape(source, model, id, shape));
      },
      setFill: (id, fill) => {
        if (!model) return;
        apply(setNodeStyle(source, model, id, { fill }));
      },
      setDirection: (direction) => {
        if (!model) return;
        apply(setDirection(source, model, direction));
      },
    }),
    [model, source, selected, apply, select],
  );

  return {
    on,
    toggle,
    selected,
    select,
    selectAtOffset,
    index,
    ok: parsed.ok,
    model,
    undo,
    redo,
    canUndo: canUndo(history),
    canRedo: canRedo(history),
    apply,
    actions,
  };
}

/** Resolve a click inside the preview host to a model target. */
export function targetFromEvent(
  ev: React.MouseEvent,
  index: SvgIndex | null,
  prefer?: 'subgraph',
): Target | null {
  if (!index) return null;
  const hit = bindingFromEvent(ev.target, index, prefer);
  if (!hit) return null;
  return targetFromKey(hit.key);
}

/**
 * Resolve a viewport point to a model target.
 *
 * Pointer capture retargets the up-event to the capture element, so a drop's
 * `ev.target` is the drag handle — not what is under the pointer. Resolving
 * from coordinates via `elementFromPoint` sees through that.
 */
export function targetFromPoint(
  index: SvgIndex | null,
  x: number,
  y: number,
  prefer?: 'subgraph',
): Target | null {
  if (!index || typeof document === 'undefined') return null;
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const hit = bindingFromEvent(el, index, prefer);
  if (!hit) return null;
  return targetFromKey(hit.key);
}
