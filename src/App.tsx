import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { StreamLanguage } from '@codemirror/language';
import { autocompletion, CompletionContext } from '@codemirror/autocomplete';
import { oneDark } from '@codemirror/theme-one-dark';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { TransformWrapper, TransformComponent, type ReactZoomPanPinchRef } from 'react-zoom-pan-pinch';
import mermaid from 'mermaid';
import {
  AlertTriangle, CheckCircle2, ClipboardCopy, Code2, Copy, Download, Eye, FileDown,
  FileUp, GripVertical, ImageDown, LayoutTemplate, Link2, Maximize2, Minimize2,
  Moon, PanelLeftClose, PanelRightClose, Pencil, Play, Plus, Redo2, RotateCcw, Save,
  Share2, Sun, Trash2, Undo2, Wand2, ZoomIn, ZoomOut,
} from 'lucide-react';
import { DEFAULT_CODE, TEMPLATES, type MermaidThemeId } from './lib/templates';
import { buildShareUrl, readShareFromLocation } from './lib/share';
import { copyPngToClipboard, copySvgToClipboard, downloadPng, downloadSvg, downloadTextFile } from './lib/export';
import { useDebouncedValue, useMediaQuery } from './lib/hooks';
import { useEditMode, targetFromEvent, targetFromPoint } from './lib/useEditMode';
import { displayLabel, selectionRangeOf, selectionTargetAt, targetFromKey, targetKey, type Target } from './lib/flowchart/interact';
import { subgraphAtPoint } from './lib/flowchart/svg-map';
import { ARROW_TOKENS, tokenFor } from './lib/flowchart/patch';
import type { FlowchartModel } from './lib/flowchart/parser';

const STORAGE_KEY = 'mermaid-studio-code-v1';
const UI_KEY = 'mermaid-studio-ui-v1';
const MERMAID_THEME_KEY = 'mermaid-studio-mermaid-theme-v1';

/* ---------- tiny Mermaid highlighting ---------- */
const mermaidHighlight = StreamLanguage.define({
  token(stream) {
    if (stream.sol()) {
      if (stream.match(/^(flowchart|sequenceDiagram|classDiagram|stateDiagram-v2|erDiagram|gantt|pie|mindmap|journey|gitGraph|timeline|quadrantChart|requirementDiagram)\b/)) return 'keyword';
      if (stream.match(/^(title|dateFormat|axisFormat|section|autonumber)\b/)) return 'keyword';
    }
    if (stream.match(/^(participant|actor|create|destroy|as|alt|else|end|opt|loop|par|and|rect|note|activate|deactivate|autonumber)\b/)) return 'keyword';
    if (stream.match(/^%%.*/)) return 'comment';
    if (stream.match(/^[A-Za-z_][\w-]*\(/)) return 'function';
    if (stream.match(/--?>+|--+|==+>|-.->|~~~|-->|---/)) return 'operator';
    if (stream.match(/"[^"]*"|'[^']*'|`[^`]*`/)) return 'string';
    if (stream.match(/\[\[|\]\]|\[|\]|\(\(|\)\)|\(|\)|\{|\}|{{|}}/)) return 'bracket';
    if (stream.match(/:::/)) return 'meta';
    if (stream.match(/#[0-9a-fA-F]{3,8}\b/)) return 'number';
    stream.next();
    return null;
  },
});

const KEYWORDS = [
  'flowchart TD', 'flowchart LR', 'sequenceDiagram', 'classDiagram', 'stateDiagram-v2',
  'erDiagram', 'gantt', 'pie', 'mindmap', 'journey', 'gitGraph', 'timeline',
  'participant', 'actor as', 'autonumber', 'alt', 'else', 'end', 'opt', 'loop',
  'rect', 'note over', 'activate', 'deactivate', 'section', 'title',
];
function mermaidCompletions(ctx: CompletionContext) {
  const word = ctx.matchBefore(/\w*/);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;
  return {
    from: word.from,
    options: KEYWORDS.map((label) => ({ label, type: 'keyword' as const, apply: label })),
  };
}

type UiTheme = 'light' | 'dark';
type ViewMode = 'split' | 'editor-max' | 'preview-max';

function initialCode(): string {
  const shared = readShareFromLocation();
  if (shared) return shared;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return saved;
  } catch { /* ignore */ }
  return DEFAULT_CODE;
}

function extractLine(msg: string): number | null {
  const m = msg.match(/[Ll]ine\s+(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Label editor for one edge.
 *
 * A local draft is kept so typing does not push a history entry per keystroke;
 * the value is committed on blur and on Enter. That also keeps the diagram from
 * re-rendering on every character, which is what makes editing feel laggy.
 */
function EdgeLabelRow({
  model,
  edgeId,
  onChange,
}: {
  model: FlowchartModel;
  edgeId: string;
  onChange: (label: string) => void;
}) {
  const edge = model.edges.find((e) => `${e.from}->${e.to}` === edgeId);
  const [draft, setDraft] = useState(edge?.label ?? '');

  useEffect(() => {
    setDraft(edge?.label ?? '');
  }, [edge?.label]);

  const commit = () => {
    if (draft !== (edge?.label ?? '')) onChange(draft);
  };

  return (
    <label className="property-row">
      <span>Label</span>
      <input
        data-testid="edge-label-input"
        value={draft}
        placeholder="(none)"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
      />
    </label>
  );
}

export default function App() {
  const [code, setCode] = useState(initialCode);
  const [uiTheme, setUiTheme] = useState<UiTheme>(() => {
    try { return (localStorage.getItem(UI_KEY) as UiTheme) || 'light'; } catch { return 'light'; }
  });
  const [mermaidTheme, setMermaidTheme] = useState<MermaidThemeId>(() => {
    try { return ((localStorage.getItem(MERMAID_THEME_KEY) as MermaidThemeId) || 'default'); } catch { return 'default'; }
  });
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [renderTick, setRenderTick] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>('split');
  const [mobileTab, setMobileTab] = useState<'code' | 'preview'>('code');
  const [openMenu, setOpenMenu] = useState<null | 'templates' | 'theme' | 'export'>(null);
  const [renderCount, setRenderCount] = useState(0);

  const isMobile = useMediaQuery('(max-width: 980px)');
  const effectiveView: ViewMode = isMobile ? 'split' : view;
  const fileRef = useRef<HTMLInputElement>(null);
  const renderSeq = useRef(0);
  const zoomRef = useRef<ReactZoomPanPinchRef>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const previewHostRef = useRef<HTMLDivElement>(null);
  // Read inside the CodeMirror `onUpdate` callback, which must not close over
  // the edit-mode flag (that would re-create the editor wiring every toggle).
  const editOnRef = useRef(false);
  const selectAtOffsetRef = useRef<(offset: number) => void>(() => {});
  // Last caret offset forwarded to `selectAtOffset`. CodeMirror fires
  // `onUpdate` for transactions that do not move the caret at all (scroll,
  // viewport, effects); forwarding those would re-resolve the same offset and
  // — worse — a stale head of 0 right after a preview click would clear a
  // selection that was just set. Only genuine caret moves cross this gate.
  const lastForwardedOffsetRef = useRef<number | null>(null);
  // Set on a committed drop; consumed by the click that always follows a
  // drag. Without this, dropping a node onto a cluster would immediately
  // clear (or re-pick) the selection the drop just established.
  const justDraggedRef = useRef(false);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  // Persist UI prefs + autosave
  useEffect(() => {
    document.documentElement.dataset.ui = uiTheme;
    try { localStorage.setItem(UI_KEY, uiTheme); } catch { /* ignore */ }
  }, [uiTheme]);
  useEffect(() => {
    try { localStorage.setItem(MERMAID_THEME_KEY, mermaidTheme); } catch { /* ignore */ }
  }, [mermaidTheme]);
  useEffect(() => {
    const t = setTimeout(() => {
      try { localStorage.setItem(STORAGE_KEY, code); } catch { /* ignore */ }
    }, 500);
    return () => clearTimeout(t);
  }, [code]);

  // Mermaid init on theme change
  useEffect(() => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: mermaidTheme,
      fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
    });
    setRenderTick((t) => t + 1); // re-render with new theme
  }, [mermaidTheme]);

  // Debounced live render (longer debounce for big docs)
  const debounceMs = code.length > 8000 ? 800 : 400;
  const debouncedCode = useDebouncedValue(code, debounceMs);

  useEffect(() => {
    let cancelled = false;
    const seq = ++renderSeq.current;
    async function run() {
      setRendering(true);
      try {
        await mermaid.parse(debouncedCode, { suppressErrors: true } as never);
      } catch {
        // parse errors are surfaced by render below; keep going
      }
      try {
        const id = `mmd-${seq}-${Date.now().toString(36)}`;
        const { svg: out } = await mermaid.render(id, debouncedCode);
        if (cancelled || renderSeq.current !== seq) return;
        setSvg(out);
        setError(null);
        setRenderCount((c) => c + 1);
      } catch (e) {
        if (cancelled || renderSeq.current !== seq) return;
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg.split('\n').slice(0, 3).join('\n'));
      } finally {
        if (!cancelled && renderSeq.current === seq) setRendering(false);
      }
    }
    if (debouncedCode.trim()) run();
    return () => { cancelled = true; };
  }, [debouncedCode, renderTick]);

  const forceRender = useCallback(() => setRenderTick((t) => t + 1), []);
  const lineNo = error ? extractLine(error) : null;
  const charCount = code.length;
  const lineCount = useMemo(() => code.split('\n').length, [code]);

  // Step 5: one edit mode. Everything visual is gated on `edit.on`; there is
  // no per-tool state anywhere in this app.
  const edit = useEditMode(code, setCode, svg, previewHostRef);
  useEffect(() => {
    editOnRef.current = edit.on;
  }, [edit.on]);
  useEffect(() => {
    editOnRef.current = edit.on;
  }, [edit.on]);
  useEffect(() => {
    selectAtOffsetRef.current = edit.selectAtOffset;
  }, [edit.selectAtOffset]);
  // `error` is mermaid's own verdict on the current text, which is stricter
  // than our tolerant parser: it rejects a trailing comment or a bare `@`,
  // for example, while we still model them. Editing a diagram mermaid cannot
  // render would operate on a ghost, so invalid text disables the mode.
  // The last good SVG stays on screen; the banner (rendered below) says why.
  const diagramEditable = edit.on && !error && !!svg;

  useEffect(() => {
    if (error && edit.on) {
      showToast('Fix syntax to edit visually');
    }
    // Only the error transition matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!error]);

  // Step 6: inline rename, driven by a double-click on a node.
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);

  const onPreviewClick = useCallback(
    (ev: React.MouseEvent) => {
      if (!diagramEditable) return;
      // A drag that just ended also fires click. The drag already selected
      // (reconnect) or moved (re-parent) its subject, so a click now would
      // only undo that — e.g. re-selecting the moved node is harmless, but
      // clearing a just-finished drop is not.
      if (justDraggedRef.current) {
        justDraggedRef.current = false;
        return;
      }
      const hit = targetFromEvent(ev, edit.index);
      if (!hit) {
        edit.select(null);
        return;
      }
      if (hit.kind === 'subgraph') {
        // A cluster is only a drop target, not a selectable element: there is
        // nothing to rename or restyle on a subgraph in v1.
        return;
      }
      edit.select(hit);
    },
    [diagramEditable, edit],
  );

  const onPreviewDoubleClick = useCallback(
    (ev: React.MouseEvent) => {
      if (!diagramEditable) return;
      const hit = targetFromEvent(ev, edit.index);
      if (!hit) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (hit.kind === 'node') {
        const node = edit.model?.nodesById.get(hit.id)?.[0];
        setRenaming({ id: hit.id, value: node ? displayLabel(node.label) : hit.id });
        edit.select(hit);
      }
    },
    [diagramEditable, edit],
  );

  const commitRename = useCallback(() => {
    if (!renaming) return;
    const next = renaming.value.trim();
    if (next) edit.actions.renameNode(renaming.id, next);
    setRenaming(null);
  }, [renaming, edit]);

  // Drag state lives here — before the drop-target memo and the highlight
  // effect that both depend on it. (Steps 8 + 9a share one drag path; see the
  // handlers further below for the full comment.)
  const [dragging, setDragging] = useState<
    | { kind: 'edge'; edgeIndex: number; from: { x: number; y: number }; to: { x: number; y: number } }
    | { kind: 'node'; nodeId: string; from: { x: number; y: number }; to: { x: number; y: number } }
    | null
  >(null);

  // Live drop-target feedback, resolved with the exact same helpers as the
  // drop itself so the highlight never promises what the drop won't do.
  // `dragging.to` is card-relative; the resolvers take viewport coords.
  // Declared before the highlight effect so it can depend on it directly.
  const dropTarget: Target | null = useMemo(() => {
    if (!dragging || !diagramEditable || !edit.index || !edit.model) return null;
    const cardBox = previewHostRef.current?.querySelector('.preview-card')?.getBoundingClientRect();
    if (!cardBox) return null;
    const vx = dragging.to.x + cardBox.left;
    const vy = dragging.to.y + cardBox.top;
    if (dragging.kind === 'edge') {
      const hit = targetFromPoint(edit.index, vx, vy);
      if (!hit || hit.kind !== 'node') return null;
      const edge = edit.model.edges[dragging.edgeIndex];
      if (!edge || hit.id === edge.from || hit.id === edge.to) return null;
      if (!edit.model.nodesById.has(hit.id)) return null;
      return hit;
    }
    const sgId = subgraphAtPoint(edit.index, vx, vy);
    if (!sgId || !edit.model.subgraphs.some((s) => s.id === sgId)) return null;
    return { kind: 'subgraph', id: sgId };
  }, [dragging, diagramEditable, edit.index, edit.model]);

  // Step 5: highlight the selected element directly in the rendered SVG.
  //
  // The SVG comes from `dangerouslySetInnerHTML`, so React does not own it and
  // cannot put a class on it. Applying the class imperatively is the honest
  // way to mark it, and it must be redone after every render — the markup is
  // replaced wholesale, so a class set once is gone on the next paint.
  //
  // The drop target gets the same treatment while a drag is in flight, so the
  // user sees where the connector will land before committing.
  useEffect(() => {
    const host = previewHostRef.current;
    if (!host) return;
    host.querySelectorAll<SVGElement>('.mmd-selected').forEach((el) => el.classList.remove('mmd-selected'));
    host.querySelectorAll<SVGElement>('.mmd-drop-target').forEach((el) => el.classList.remove('mmd-drop-target'));
    if (!diagramEditable) return;
    if (edit.selected) {
      const el = edit.index?.byKey.get(targetKey(edit.selected))?.element;
      el?.classList.add('mmd-selected');
    }
    if (dropTarget) {
      const key =
        dropTarget.kind === 'edge'
          ? `edge:${dropTarget.id}`
          : dropTarget.kind === 'node'
            ? `node:${dropTarget.id}`
            : `subgraph:${dropTarget.id}`;
      const el =
        dropTarget.kind === 'subgraph'
          ? edit.index?.bySubgraph.get(dropTarget.id)
          : edit.index?.byKey.get(key)?.element;
      el?.classList.add('mmd-drop-target');
    }
  }, [edit.selected, edit.index, svg, diagramEditable, dropTarget]);

  // Step 5, second direction: selecting a shape highlights its source range in
  // the editor. Applied directly to the live view — waiting for an `onUpdate`
  // to carry it would leave the highlight pending until the next keystroke.
  // The `onUpdate` guard below still skips preview-driven selections, so the
  // two directions never chase each other.
  useEffect(() => {
    const w = window as unknown as {
      __cmView?: { state: { selection: { main: { from: number; to: number } } }; dispatch: (t: unknown) => void };
      __cmCursorRange?: { start: number; end: number } | null;
    };
    if (!edit.on || !edit.selected || !edit.model) {
      w.__cmCursorRange = null;
      return;
    }
    const range = selectionRangeOf(edit.model, edit.selected);
    w.__cmCursorRange = range;
    const view = w.__cmView;
    if (range && view) {
      const sel = view.state.selection.main;
      if (sel.from !== range.start || sel.to !== range.end) {
        lastForwardedOffsetRef.current = range.end;
        view.dispatch({ selection: { anchor: range.start, head: range.end } });
      }
    }
  }, [edit.on, edit.selected, edit.model]);

  // Step 8: dragging an edge endpoint onto another node reconnects it.
  //
  // Mermaid owns the layout, so the drag itself draws nothing into the SVG — a
  // temporary overlay line follows the pointer, and only the drop commits a
  // text change (deleteEdge + addEdge, keeping token and label). A drop on
  // empty canvas, on the edge's own endpoints, or off any node cancels with
  // the text untouched.
  //
  // Step 9a rides the same pointer path: dragging a *node* (not a handle) and
  // dropping it on a cluster re-parents it. The two are distinguished by where
  // the drag started — a handle means reconnect, a node body means move.

  const onHandlePointerDown = useCallback(
    (ev: React.PointerEvent, edgeIndex: number) => {
      if (!diagramEditable) return;
      ev.stopPropagation();
      ev.preventDefault();
      (ev.target as HTMLElement).setPointerCapture?.(ev.pointerId);
      const card = previewHostRef.current?.querySelector('.preview-card');
      const box = card?.getBoundingClientRect();
      if (!box) return;
      const at = { x: ev.clientX - box.left, y: ev.clientY - box.top };
      setDragging({ kind: 'edge', edgeIndex, from: at, to: at });
    },
    [diagramEditable],
  );

  const onNodePointerDown = useCallback(
    (ev: React.PointerEvent, nodeId: string) => {
      if (!diagramEditable) return;
      // A node-body drag only matters when there is a cluster to land in.
      // Without subgraphs there is nothing to re-parent into, so hands off and
      // let the gesture pan like it always has.
      if (!edit.model || edit.model.subgraphs.length === 0) return;
      ev.stopPropagation();
      // Capture the pointer on the card so the drag survives leaving the node:
      // without this, moving fast drops pointermove events and the ghost line
      // freezes mid-gesture. The click-vs-drag threshold below still keeps
      // plain clicks honest.
      (ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId);
      const card = previewHostRef.current?.querySelector('.preview-card');
      const box = card?.getBoundingClientRect();
      if (!box) return;
      const at = { x: ev.clientX - box.left, y: ev.clientY - box.top };
      setDragging({ kind: 'node', nodeId, from: at, to: at });
    },
    [diagramEditable, edit.model],
  );

  // Node-body drags start inside injected SVG, which React does not own, so
  // the listener is delegated on the card and resolves the target the same
  // way clicks do. Handle drags never reach here: they stop propagation.
  const onPreviewPointerDown = useCallback(
    (ev: React.PointerEvent) => {
      if (!diagramEditable || dragging) return;
      if ((ev.target as HTMLElement).closest?.('.mmd-handle')) return;
      const hit = targetFromEvent(ev, edit.index);
      if (!hit || hit.kind !== 'node') return;
      onNodePointerDown(ev, hit.id);
    },
    [diagramEditable, dragging, edit.index, onNodePointerDown],
  );

  const onPreviewPointerMove = useCallback(
    (ev: React.PointerEvent) => {
      setDragging((d) => {
        if (!d) return d;
        const card = previewHostRef.current?.querySelector('.preview-card');
        const box = card?.getBoundingClientRect();
        if (!box) return d;
        const to = { x: ev.clientX - box.left, y: ev.clientY - box.top };
        // A node drag shorter than a few px is a click, not a drag — keep the
        // click handler honest by not claiming the gesture.
        if (d.kind === 'node' && Math.hypot(to.x - d.from.x, to.y - d.from.y) < 6) return d;
        return { ...d, to };
      });
    },
    [],
  );

  const onPreviewPointerUp = useCallback(
    (ev: React.PointerEvent) => {
      if (!dragging) return;
      const done = dragging;
      setDragging(null);
      if (!diagramEditable || !edit.model) return;
      // With pointer capture the up-event retargets to the capture element
      // (the handle), not to whatever is under the pointer — so resolve the
      // drop from coordinates, never from `ev.target`.
      const drop = { x: ev.clientX, y: ev.clientY };
      // A node drag prefers its enclosing cluster: the drop point usually sits
      // on an edge path drawn across the cluster, and resolving the edge would
      // silently cancel a drop the user visibly aimed at the cluster.
      const hit = targetFromPoint(edit.index, drop.x, drop.y, done.kind === 'node' ? 'subgraph' : undefined);
      if (done.kind === 'edge') {
        // Cancel unless the drop lands on a *different* node that actually
        // exists in the model. Anything else leaves the text byte-identical.
        if (!hit || hit.kind !== 'node') return;
        const edge = edit.model.edges[done.edgeIndex];
        if (!edge || hit.id === edge.from || hit.id === edge.to) return;
        if (!edit.model.nodesById.has(hit.id)) return;
        justDraggedRef.current = true;
        edit.actions.reconnect(done.edgeIndex, hit.id);
        return;
      }
      // Node drag: only a cluster drop does anything. Empty canvas, another
      // node, or the far edge of nowhere all cancel silently.
      //
      // Clusters are resolved geometrically, not from the event target:
      // Mermaid draws edges in a separate layer outside the cluster groups,
      // so a drop point sitting on an edge path has no cluster ancestor to
      // walk up to. `subgraphAtPoint` compares viewport rects instead.
      const sgId = edit.index ? subgraphAtPoint(edit.index, ev.clientX, ev.clientY) : null;
      if (!sgId || !edit.model.subgraphs.some((s) => s.id === sgId)) return;
      justDraggedRef.current = true;
      edit.actions.moveIntoSubgraph(done.nodeId, sgId);
    },
    [dragging, diagramEditable, edit],
  );
  const renameBox = useMemo(() => {
    if (!renaming || !diagramEditable) return null;
    const el = edit.index?.byKey.get(`node:${renaming.id}`)?.element;
    if (!el) return null;
    const card = previewHostRef.current?.querySelector('.preview-card');
    if (!card) return null;
    const nodeBox = el.getBoundingClientRect();
    const cardBox = card.getBoundingClientRect();
    return {
      left: nodeBox.left - cardBox.left,
      top: nodeBox.top - cardBox.top,
      width: nodeBox.width,
      height: nodeBox.height,
    };
  }, [renaming, edit.index, diagramEditable, svg]);

  // Step 8: endpoint handle for the selected edge. Positioned over the middle
  // of the rendered edge path, since mermaid gives edges no draggable anatomy
  // of their own. Dragging it starts the reconnect; the handle itself never
  // pans the canvas (see `panning.excluded` below).
  const edgeHandle = useMemo(() => {
    if (!diagramEditable || !edit.selected || edit.selected.kind !== 'edge') return null;
    const binding = edit.index?.byKey.get(`edge:${edit.selected.id}`);
    const el = binding?.element;
    if (!el) return null;
    const card = previewHostRef.current?.querySelector('.preview-card');
    if (!card) return null;
    const path = el.getBoundingClientRect();
    const cardBox = card.getBoundingClientRect();
    return {
      left: path.left + path.width / 2 - cardBox.left,
      top: path.top + path.height / 2 - cardBox.top,
      edgeIndex: binding.index,
    };
  }, [diagramEditable, edit.selected, edit.index, svg]);

  /* ----- actions ----- */
  const onSaveFile = useCallback(() => {
    downloadTextFile('diagram.mmd', code, 'text/vnd.mermaid');
    showToast('Saved diagram.mmd');
  }, [code, showToast]);

  const onOpenFile = useCallback((f: File) => {
    const r = new FileReader();
    r.onload = () => {
      setCode(String(r.result ?? ''));
      showToast(`Opened ${f.name}`);
    };
    r.readAsText(f);
  }, [showToast]);

  const doExportSvg = useCallback(() => {
    if (!svg) return showToast('Nothing to export yet — fix the syntax first');
    downloadSvg(svg);
    showToast('SVG downloaded');
  }, [svg, showToast]);

  const doExportPng = useCallback(async () => {
    if (!svg) return showToast('Nothing to export yet — fix the syntax first');
    try {
      showToast('Rendering PNG at 3×…');
      await downloadPng(svg, 'diagram.png', 3);
      showToast('PNG downloaded (3× sharp)');
    } catch { showToast('PNG export failed in this browser'); }
  }, [svg, showToast]);

  const doCopySvg = useCallback(async () => {
    if (!svg) return showToast('Nothing to copy yet');
    try { await copySvgToClipboard(svg); showToast('SVG copied to clipboard'); }
    catch { showToast('Copy failed — clipboard blocked'); }
  }, [svg, showToast]);

  const doCopyPng = useCallback(async () => {
    if (!svg) return showToast('Nothing to copy yet');
    try { await copyPngToClipboard(svg); showToast('PNG image copied'); }
    catch { showToast('PNG copy not supported — try Download PNG'); }
  }, [svg, showToast]);

  const doShare = useCallback(async () => {
    try {
      const url = buildShareUrl(code);
      window.history.replaceState(null, '', `#c=${url.split('#c=')[1]}`);
      await navigator.clipboard.writeText(url);
      showToast('Share link copied — no server needed');
    } catch { showToast('Share link ready in the address bar'); }
  }, [code, showToast]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        onSaveFile();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        forceRender();
        showToast('Re-rendered');
      }
      // `E` toggles the one edit mode. Ignored while typing so a label
      // containing the letter E does not flip the diagram out from under you.
      const inField =
        e.target instanceof HTMLElement &&
        (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable);
      if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'e' && !inField) {
        edit.toggle();
      }
      // Delete/Backspace removes the selection in edit mode. Also guarded so
      // the editor keeps its own keys.
      if (!inField && diagramEditable && edit.selected && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        if (edit.actions.deleteSelected()) {
          if (window.confirm('Delete this node and its edges?')) {
            edit.actions.deleteSelected({ confirmed: true });
          }
        }
      }
      // Step 11: one history stack, so undo/redo walk across typed and visual
      // edits alike. Guarded so a Ctrl+Z aimed at the editor is left alone.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        if (inField) return;
        e.preventDefault();
        edit.undo();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        if (inField) return;
        e.preventDefault();
        edit.redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSaveFile, forceRender, showToast, edit, diagramEditable]);

  // Close menus on outside click / Escape
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.menu-wrap')) setOpenMenu(null);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenMenu(null); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onEsc);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onEsc); };
  }, []);

  const editorPane = (
    <div className="pane" style={{ flex: 1, minHeight: 0 }}>
      <div className="pane-head">
        <h2><Code2 size={14} /> Editor</h2>
        <div className="meta"><span>{lineCount} lines · {charCount} chars</span></div>
      </div>
      <div className="editor-wrap">
        <CodeMirror
          value={code}
          height="100%"
          theme={uiTheme === 'dark' ? oneDark : 'light'}
          extensions={[mermaidHighlight, autocompletion({ override: [mermaidCompletions] })]}
          basicSetup={{ lineNumbers: true, highlightActiveLine: true, highlightActiveLineGutter: true, foldGutter: true, bracketMatching: true, autocompletion: true }}
          onChange={(v) => setCode(v)}
          // Exposed so the e2e helpers can drive the editor. CodeMirror is not
          // a textarea, so there is no other reliable handle for a test.
          // `onUpdate` keeps the handle fresh: `onCreateEditor` fires once, but
          // the view object is replaced on remounts (e.g. theme switch).
          // It also applies the preview->editor highlight: when a shape is
          // selected in edit mode, the matching source range is selected here.
          // The guard keeps this from fighting the user: while they are typing
          // or moving the caret, hands off.
          onCreateEditor={(view) => {
            (window as unknown as { __cmView?: unknown }).__cmView = view;
          }}
          onUpdate={(viewUpdate) => {
            const w = window as unknown as { __cmView?: unknown; __cmCursorRange?: { start: number; end: number } | null };
            w.__cmView = viewUpdate.view;
            // Editor -> preview: a caret move selects the matching shape.
            // Skipped while text is changing (docChanged). The echo guard is
            // `lastForwardedOffsetRef`, not `selectionSet`: every caret move —
            // keyboard, click, or programmatic — arrives as a selection
            // transaction, so skipping those would silence the feature
            // entirely. When the preview drives the caret, the ref already
            // holds that head and the forward is a no-op.
            // Also skipped when the head has not moved: most `onUpdate` calls
            // are scroll/viewport/effects transactions, and forwarding a stale
            // head would clear a just-made selection. Finally, a genuine caret
            // move needs a focused editor — clicking the preview leaves focus
            // wherever it was, so an unfocused update is always a side effect,
            // never user intent.
            if (editOnRef.current && !viewUpdate.docChanged && viewUpdate.view.hasFocus) {
              const head = viewUpdate.state.selection.main.head;
              if (head !== lastForwardedOffsetRef.current) {
                lastForwardedOffsetRef.current = head;
                selectAtOffsetRef.current(head);
              }
            }
            const range = w.__cmCursorRange;
            if (!range || !editOnRef.current) return;
            if (viewUpdate.docChanged || viewUpdate.selectionSet) return;
            const sel = viewUpdate.state.selection.main;
            if (sel.from !== range.start || sel.to !== range.end) {
              viewUpdate.view.dispatch({ selection: { anchor: range.start, head: range.end } });
            }
          }}
        />
      </div>
      <div className="pane-foot">
        <span><kbd>Ctrl</kbd> + <kbd>S</kbd> save</span>
        <span><kbd>Ctrl</kbd> + <kbd>↵</kbd> render</span>
        <span style={{ marginLeft: 'auto' }} className="mono">.mmd · autosaved</span>
      </div>
    </div>
  );

  const previewPane = (
    <div className="pane" style={{ flex: 1, minHeight: 0 }}>
      <div className="pane-head">
        <h2><Eye size={14} /> Preview</h2>
        <div className="meta" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <div className="zoombar">
            <button className="btn small icon-only" title="Zoom out" onClick={() => zoomRef.current?.zoomOut(0.25)}><ZoomOut size={14} /></button>
            <button className="btn small icon-only" title="Zoom in" onClick={() => zoomRef.current?.zoomIn(0.25)}><ZoomIn size={14} /></button>
            <button className="btn small icon-only" title="Reset view" onClick={() => zoomRef.current?.resetTransform()}><RotateCcw size={14} /></button>
            <button className="btn small" title="Fit to screen" onClick={() => zoomRef.current?.centerView(0.9)}>Fit</button>
          </div>
        </div>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1, color: 'var(--danger)' }} />
          <div>
            <b>Syntax error{lineNo ? ` at line ${lineNo}` : ''}</b> — last good diagram kept below.
            <br /><code>{error}</code>
          </div>
        </div>
      )}
      <div className={`preview-canvas ${edit.on ? 'editing' : ''}`}>
        <TransformWrapper
          ref={zoomRef}
          minScale={0.2}
          maxScale={4}
          initialScale={1}
          centerOnInit
          // Wheel over the diagram card scrolls the card's own overflow
          // natively; wheel over the canvas background zooms. Without the
          // exclusion the zoom handler claims every wheel event and a tall
          // diagram can never be scrolled vertically.
          wheel={{ step: 0.12, excluded: ['preview-card'] }}
          // In edit mode a double-click renames the node under the cursor, so
          // the pan-zoom handler must stand aside. Outside it, zoom is the
          // only sensible interpretation of the gesture.
          doubleClick={{ disabled: diagramEditable }}
          // While a node/edge drag is active the canvas must not pan: RPP
          // listens for mousedown on `window`, which is a *different* event
          // from the React pointerdown that starts our drag, so
          // stopPropagation cannot reach it. Disabling panning for the drag
          // duration is the only reliable arbitration.
          //
          // In edit mode, drags that start on a node or edge never pan either:
          // a node drag is a re-parent attempt and an edge drag is a reconnect
          // (or a click). Background drags still pan, so the canvas never
          // feels stuck.
          panning={{
            velocityDisabled: false,
            excluded: diagramEditable ? ['mmd-handle', 'g.node', 'path.flowchart-link', 'g.edgeLabel'] : ['mmd-handle'],
            disabled: dragging !== null,
          }}
        >
          <TransformComponent wrapperStyle={{ width: '100%', height: '100%' }} contentStyle={{ width: '100%', height: '100%' }}>
            <div className="preview-scroll" ref={previewHostRef}>
              {svg ? (
                <div
                  className="preview-card"
                  onClick={onPreviewClick}
                  onDoubleClick={onPreviewDoubleClick}
                  onPointerDown={onPreviewPointerDown}
                  onPointerMove={onPreviewPointerMove}
                  onPointerUp={onPreviewPointerUp}
                  data-editing={diagramEditable ? 'true' : 'false'}
                >
                  {/* The SVG is injected, so React does not own it — which is
                      why the selection class is applied imperatively above.
                      The rename box is a sibling, not a child, because an
                      element may not mix children with dangerouslySetInnerHTML. */}
                  <div dangerouslySetInnerHTML={{ __html: svg }} />
                  {renameBox && renaming && (
                    <input
                      className="rename-input"
                      data-testid="rename-input"
                      autoFocus
                      value={renaming.value}
                      style={{
                        left: renameBox.left,
                        top: renameBox.top,
                        width: Math.max(renameBox.width, 80),
                        height: renameBox.height,
                      }}
                      onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename();
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                    />
                  )}
                  {/* Step 8: the endpoint handle of the selected edge. A
                      drag from here reconnects; a click alone keeps the
                      selection. `mmd-handle` is excluded from canvas panning
                      so the gesture never moves the viewport instead. */}
                  {edgeHandle && !renaming && (
                    <div
                      className="mmd-handle"
                      data-testid="edge-handle"
                      title="Drag onto another node to reconnect"
                      style={{ left: edgeHandle.left, top: edgeHandle.top }}
                      onPointerDown={(e) => onHandlePointerDown(e, edgeHandle.edgeIndex)}
                    />
                  )}
                  {/* Step 8: the ghost line mirrors the in-progress endpoint
                      drag. Nothing here touches the model — only the drop on a
                      node commits a text change. */}
                  {dragging && (
                    <svg
                      className="drag-ghost"
                      data-testid="drag-ghost"
                      style={{
                        position: 'absolute',
                        inset: 0,
                        width: '100%',
                        height: '100%',
                        pointerEvents: 'none',
                      }}
                    >
                      <line
                        x1={dragging.from.x}
                        y1={dragging.from.y}
                        x2={dragging.to.x}
                        y2={dragging.to.y}
                        stroke="var(--accent)"
                      />
                      <circle
                        cx={dragging.to.x}
                        cy={dragging.to.y}
                        r={5}
                        fill="var(--accent)"
                        className={dropTarget ? 'drop-ok' : undefined}
                      />
                    </svg>
                  )}
                </div>
              ) : (
                <div className="preview-empty">
                  <Wand2 size={28} />
                  <p>{rendering ? 'Rendering…' : 'Start typing Mermaid on the left'}</p>
                </div>
              )}
            </div>
          </TransformComponent>
        </TransformWrapper>
        {rendering && (
          <div className="render-spinner"><span className="spin" /> Rendering…</div>
        )}
      </div>

      {/* Step 10: the property panel appears only when something is selected in
          edit mode. Every control writes through a patch-engine call, so the
          script and the diagram cannot drift apart. */}
      {edit.on && edit.selected && edit.model && (
        <div className="property-panel" data-testid="property-panel">
          <div className="property-head">
            <span className="property-kind">{edit.selected.kind}</span>
            <code>{edit.selected.id}</code>
          </div>

          {edit.selected.kind === 'node' && (
            <div className="property-body">
              <label className="property-row">
                <span>Shape</span>
                <select
                  value={edit.model.nodesById.get(edit.selected.id)?.[0]?.shape ?? 'rect'}
                  onChange={(e) =>
                    edit.actions.setShape(edit.selected!.id, e.target.value as never)
                  }
                >
                  <option value="rect">Rectangle</option>
                  <option value="round">Rounded</option>
                  <option value="diamond">Diamond</option>
                  <option value="circle">Circle</option>
                  <option value="stadium">Stadium</option>
                  <option value="hexagon">Hexagon</option>
                </select>
              </label>
              <label className="property-row">
                <span>Fill</span>
                <input
                  type="color"
                  defaultValue="#e9e6ff"
                  onChange={(e) => edit.actions.setFill(edit.selected!.id, e.target.value)}
                />
              </label>
            </div>
          )}

          {edit.selected.kind === 'edge' && edit.model && (
            <div className="property-body">
              <EdgeLabelRow
                model={edit.model}
                edgeId={edit.selected.id}
                onChange={(label) => {
                  const e = edit.model!.edges.find((x) => `${x.from}->${x.to}` === edit.selected!.id);
                  if (e) edit.actions.setEdgeLabel(edit.model!.edges.indexOf(e), label);
                }}
              />
              <label className="property-row">
                <span>Type</span>
                <select
                  data-testid="edge-type-select"
                  value={(() => {
                    const e = edit.model!.edges.find((x) => `${x.from}->${x.to}` === edit.selected!.id);
                    return e ? tokenFor(e) : '-->';
                  })()}
                  onChange={(ev) => {
                    const e = edit.model!.edges.find((x) => `${x.from}->${x.to}` === edit.selected!.id);
                    if (e) edit.actions.setEdgeToken(edit.model!.edges.indexOf(e), ev.target.value);
                  }}
                >
                  {ARROW_TOKENS.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="app">
      {/* ---------- toolbar ---------- */}
      <header className="toolbar">
        <div className="brand">
          <span className="brand-mark"><Play size={18} /></span>
          <div>
            <h1>Mermaid Live Studio</h1>
            <p><span className="live-dot"><i /> live</span> · type left, see right</p>
          </div>
        </div>

        <div className="tb-sep" />
        <div className="mobile-tabs seg">
          <button className={mobileTab === 'code' ? 'active' : ''} onClick={() => setMobileTab('code')}>Code</button>
          <button className={mobileTab === 'preview' ? 'active' : ''} onClick={() => setMobileTab('preview')}>Preview</button>
        </div>

        <div className="tb-group">
          <div className="menu-wrap">
            <button className="btn" onClick={() => setOpenMenu(openMenu === 'templates' ? null : 'templates')}>
              <LayoutTemplate /> Templates
            </button>
            {openMenu === 'templates' && (
              <div className="menu">
                <h4>Start from a template</h4>
                <div className="template-grid">
                  {TEMPLATES.map((t) => (
                    <button
                      key={t.id}
                      className="template-card"
                      onClick={() => { setCode(t.code); setOpenMenu(null); showToast(`${t.label} template loaded`); }}
                    >
                      <b><span>{t.icon}</span> {t.label}</b>
                      <span>{t.description}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="menu-wrap">
            <button className="btn tb-hide-m" onClick={() => setOpenMenu(openMenu === 'theme' ? null : 'theme')}>
              <Sun /> Theme
            </button>
            {openMenu === 'theme' && (
              <div className="menu">
                <h4>Diagram theme</h4>
                <div className="menu-row">
                  {(['default', 'dark', 'forest', 'neutral'] as MermaidThemeId[]).map((t) => (
                    <button key={t} className={`btn small ${mermaidTheme === t ? 'primary' : ''}`} onClick={() => setMermaidTheme(t)}>
                      {t[0].toUpperCase() + t.slice(1)}
                    </button>
                  ))}
                </div>
                <h4>Interface</h4>
                <div className="menu-row">
                  <button className={`btn small ${uiTheme === 'light' ? 'primary' : ''}`} onClick={() => setUiTheme('light')}><Sun size={14} /> Light</button>
                  <button className={`btn small ${uiTheme === 'dark' ? 'primary' : ''}`} onClick={() => setUiTheme('dark')}><Moon size={14} /> Dark</button>
                </div>
              </div>
            )}
          </div>

          <div className="menu-wrap">
            <button className="btn tb-hide-m" onClick={() => setOpenMenu(openMenu === 'export' ? null : 'export')}>
              <Download /> Export
            </button>
            {openMenu === 'export' && (
              <div className="menu">
                <h4>Download & copy</h4>
                <button className="item" onClick={() => { doExportSvg(); setOpenMenu(null); }}><FileDown size={15} /> Download SVG <small>Vector, infinitely sharp</small></button>
                <button className="item" onClick={() => { doExportPng(); setOpenMenu(null); }}><ImageDown size={15} /> Download PNG <small>3× scale for crisp docs</small></button>
                <button className="item" onClick={() => { doCopySvg(); setOpenMenu(null); }}><Copy size={15} /> Copy SVG markup</button>
                <button className="item" onClick={() => { doCopyPng(); setOpenMenu(null); }}><ClipboardCopy size={15} /> Copy PNG image</button>
              </div>
            )}
          </div>
        </div>

        <div className="tb-spacer" />
        <div className="tb-group">
          {/* Step 5: the single edit-mode switch. Note there is no "tool"
              selector — which operation a gesture performs is derived from what
              is selected, not from a mode variable. */}
          <button
            className={`btn ${edit.on ? 'primary' : 'ghost'}`}
            data-testid="edit-mode-toggle"
            title={edit.on ? 'Leave edit mode (E)' : 'Edit the diagram visually (E)'}
            onClick={edit.toggle}
          >
            <Pencil /> {edit.on ? 'Editing' : 'Edit'}
          </button>
          {edit.on && (
            <div className="tb-group">
              <button
                className="btn ghost"
                data-testid="add-node"
                title="Add a node"
                disabled={!diagramEditable}
                onClick={edit.actions.addNode}
              >
                <Plus /> Node
              </button>
              <button
                className="btn ghost"
                data-testid="delete-selected"
                title="Delete the selection (Del)"
                disabled={!edit.selected}
                onClick={() => {
                  if (edit.actions.deleteSelected()) {
                    const kind = edit.selected?.kind;
                    const what = kind === 'node' ? 'node and its edges' : 'edge';
                    if (window.confirm(`Delete this ${what}?`)) {
                      edit.actions.deleteSelected({ confirmed: true });
                    }
                  }
                }}
              >
                <Trash2 />
              </button>
              <div className="tb-sep" />
              <button
                className="btn ghost"
                data-testid="undo"
                title="Undo (Ctrl+Z)"
                disabled={!edit.canUndo}
                onClick={edit.undo}
              >
                <Undo2 />
              </button>
              <button
                className="btn ghost"
                data-testid="redo"
                title="Redo (Ctrl+Y)"
                disabled={!edit.canRedo}
                onClick={edit.redo}
              >
                <Redo2 />
              </button>
              {/* Step 10: layout direction. Sits with the edit tools because it
                  rewrites the header line through the same patch path. */}
              <div className="seg" role="group" aria-label="Direction">
                <button
                  data-testid="direction-td"
                  className={edit.model?.direction === 'TD' ? 'active' : ''}
                  title="Top-down layout"
                  disabled={!diagramEditable}
                  onClick={() => edit.actions.setDirection('TD')}
                >
                  TD
                </button>
                <button
                  data-testid="direction-lr"
                  className={edit.model?.direction === 'LR' ? 'active' : ''}
                  title="Left-right layout"
                  disabled={!diagramEditable}
                  onClick={() => edit.actions.setDirection('LR')}
                >
                  LR
                </button>
              </div>
            </div>
          )}
          <div className="tb-sep" />
          <button className="btn ghost tb-hide-m" title="Open a .mmd file" onClick={() => fileRef.current?.click()}><FileUp /> Open</button>
          <button className="btn ghost tb-hide-m" title="Save to .mmd file (Ctrl+S)" onClick={onSaveFile}><Save /> Save</button>
          <button className="btn ghost" title="Maximize editor" onClick={() => setView(view === 'editor-max' ? 'split' : 'editor-max')}>
            {view === 'editor-max' ? <Minimize2 /> : <PanelLeftClose />}
          </button>
          <button className="btn ghost" title="Maximize preview" onClick={() => setView(view === 'preview-max' ? 'split' : 'preview-max')}>
            {view === 'preview-max' ? <Minimize2 /> : <PanelRightClose />}
          </button>
          <button className="btn" title="Fit preview" onClick={() => zoomRef.current?.centerView(0.9)}><Maximize2 /></button>
          <button className="btn primary" onClick={doShare}><Share2 /> Share</button>
          <button className="btn ghost" title={uiTheme === 'dark' ? 'Light UI' : 'Dark UI'} onClick={() => setUiTheme(uiTheme === 'dark' ? 'light' : 'dark')}>
            {uiTheme === 'dark' ? <Sun /> : <Moon />}
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".mmd,.mermaid,.txt,.md"
          hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onOpenFile(f); e.target.value = ''; }}
        />
      </header>

      {/* ---------- workspace ---------- */}
      <main className="workspace">
        {isMobile ? (
          mobileTab === 'code' ? editorPane : previewPane
        ) : effectiveView === 'editor-max' ? (
          editorPane
        ) : effectiveView === 'preview-max' ? (
          previewPane
        ) : (
          <PanelGroup direction="horizontal" style={{ width: '100%', height: '100%', display: 'flex' }}>
            <Panel defaultSize={44} minSize={22} style={{ display: 'flex', minWidth: 0 }}>{editorPane}</Panel>
            <PanelResizeHandle className="resize-handle"><GripVertical size={14} /></PanelResizeHandle>
            <Panel defaultSize={56} minSize={30} style={{ display: 'flex', minWidth: 0 }}>{previewPane}</Panel>
          </PanelGroup>
        )}
      </main>

      {/* ---------- status bar ---------- */}
      <footer className="statusbar">
        {error ? (
          <span className="pill bad"><AlertTriangle size={13} /> Error{lineNo ? ` · line ${lineNo}` : ''}</span>
        ) : (
          <span className="pill ok"><CheckCircle2 size={13} /> Parse OK · #{renderCount}</span>
        )}
        <span className="mono tb-hide-m">{mermaidTheme} theme · {uiTheme} UI</span>
        <span className="spacer" />
        <span className="mono tb-hide-m"><Link2 size={11} style={{ verticalAlign: -1 }} /> share via URL hash · no backend</span>
        <span className="mono">{rendering ? 'rendering…' : 'idle'}</span>
      </footer>

      <div className={`toast ${toast ? 'show' : ''}`}><CheckCircle2 size={15} /> {toast}</div>
    </div>
  );
}
