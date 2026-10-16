import { describe, expect, it } from 'vitest';
import { parseFlowchart, type FlowchartModel } from '../src/lib/flowchart/parser';
import {
  targetKey,
  targetFromKey,
  resolveEdgeKey,
  canReconnect,
  dropSubgraphId,
  deleteActionFor,
  displayLabel,
  selectionTargetAt,
  selectionRangeOf,
} from '../src/lib/flowchart/interact';

const SRC = `flowchart TD
    A[Start] --> B[Process]
    B -->|go| C[End]
    subgraph one [Frontend]
        D[In group]
    end
    B --> D
`;

function model(src = SRC): FlowchartModel {
  const r = parseFlowchart(src);
  expect(r.ok).toBe(true);
  return r.model!;
}

describe('target keys', () => {
  it('round-trips a node target', () => {
    expect(targetKey({ kind: 'node', id: 'A' })).toBe('node:A');
    expect(targetFromKey('node:A')).toEqual({ kind: 'node', id: 'A' });
  });

  it('round-trips an edge key containing an arrow', () => {
    const key = targetKey({ kind: 'edge', id: 'A->B' });
    expect(key).toBe('edge:A->B');
    expect(targetFromKey(key)).toEqual({ kind: 'edge', id: 'A->B' });
  });

  it('round-trips a subgraph target', () => {
    expect(targetFromKey('subgraph:one')).toEqual({ kind: 'subgraph', id: 'one' });
  });

  it('rejects a key with no separator', () => {
    expect(targetFromKey('nonsense')).toBeNull();
    expect(targetFromKey('')).toBeNull();
  });
});

describe('resolveEdgeKey', () => {
  it('resolves an existing edge to its model index', () => {
    const m = model();
    expect(resolveEdgeKey(m, 'A->B')).toEqual({ from: 'A', to: 'B', index: 0 });
    expect(resolveEdgeKey(m, 'B->C')).toEqual({ from: 'B', to: 'C', index: 1 });
  });

  it('returns null for an edge that is not in the model', () => {
    expect(resolveEdgeKey(model(), 'A->Z')).toBeNull();
    expect(resolveEdgeKey(model(), 'garbage')).toBeNull();
  });

  it('splits on the last arrow when a node id contains one', () => {
    const m = parseFlowchart('flowchart TD\n    A-->B-->C\n').model!;
    // `A->B` is not an edge here, but `B->C` is.
    expect(resolveEdgeKey(m, 'B->C')?.index).toBe(1);
    expect(resolveEdgeKey(m, 'A->B')).toEqual({ from: 'A', to: 'B', index: 0 });
  });
});

describe('canReconnect', () => {
  it('allows a different node as the new endpoint', () => {
    const m = model();
    // Edge 0 is A->B; reconnecting its far end to C is legal.
    expect(canReconnect(m, 0, 'C')).toBe(true);
  });

  it('rejects dropping onto the edge\'s own endpoints', () => {
    const m = model();
    expect(canReconnect(m, 0, 'A')).toBe(false);
    expect(canReconnect(m, 0, 'B')).toBe(false);
  });

  it('rejects an unknown node', () => {
    expect(canReconnect(model(), 0, 'ZZZ')).toBe(false);
  });

  it('rejects an out-of-range edge index', () => {
    expect(canReconnect(model(), 99, 'C')).toBe(false);
  });
});

describe('dropSubgraphId', () => {
  it('returns the subgraph id when a cluster is the target', () => {
    const m = model();
    expect(dropSubgraphId(m, { kind: 'subgraph', id: 'one' })).toBe('one');
  });

  it('returns null for a node target, a null target, or an unknown cluster', () => {
    const m = model();
    expect(dropSubgraphId(m, { kind: 'node', id: 'A' })).toBeNull();
    expect(dropSubgraphId(m, null)).toBeNull();
    expect(dropSubgraphId(m, { kind: 'subgraph', id: 'nope' })).toBeNull();
  });
});

describe('deleteActionFor', () => {
  it('returns null with no selection', () => {
    expect(deleteActionFor(model(), null)).toBeNull();
  });

  it('deletes an edge by its model index', () => {
    expect(deleteActionFor(model(), { kind: 'edge', id: 'B->C' })).toEqual({
      type: 'delete-edge',
      index: 1,
    });
  });

  it('does not confirm for a lightly-connected node', () => {
    // A has one edge.
    expect(deleteActionFor(model(), { kind: 'node', id: 'A' })).toEqual({
      type: 'delete-node',
      id: 'A',
      confirm: false,
    });
  });

  it('confirms before deleting a hub node', () => {
    const hub = parseFlowchart('flowchart TD\n    H-->A\n    H-->B\n    H-->C\n    H-->D\n').model!;
    expect(deleteActionFor(hub, { kind: 'node', id: 'H' })).toEqual({
      type: 'delete-node',
      id: 'H',
      confirm: true,
    });
  });

  it('ignores a node that is not in the model', () => {
    expect(deleteActionFor(model(), { kind: 'node', id: 'ZZZ' })).toBeNull();
  });

  it('ignores subgraph selections', () => {
    expect(deleteActionFor(model(), { kind: 'subgraph', id: 'one' })).toBeNull();
  });
});

describe('displayLabel', () => {
  // The parser stores source text, so an entity-escaped label must be decoded
  // before it goes into the rename input or the user sees `&quot;`.
  it('decodes named entities', () => {
    expect(displayLabel('a &quot;b&quot; c')).toBe('a "b" c');
    expect(displayLabel('a &amp; b')).toBe('a & b');
    expect(displayLabel('&lt;tag&gt;')).toBe('<tag>');
    expect(displayLabel("it&apos;s")).toBe("it's");
  });

  it('decodes numeric entities, which we never emit but a file may contain', () => {
    expect(displayLabel('&#40;paren&#41;')).toBe('(paren)');
    expect(displayLabel('&#x41;')).toBe('A');
  });

  it('decodes &amp; last so &amp;quot; is not decoded twice', () => {
    // `&amp;quot;` in source renders as the literal text `&quot;`.
    expect(displayLabel('&amp;quot;')).toBe('&quot;');
  });

  it('leaves plain labels alone', () => {
    expect(displayLabel('Start')).toBe('Start');
    expect(displayLabel('Ünïcödé')).toBe('Ünïcödé');
  });
});

describe('two-way selection', () => {
  // Editor -> preview: the offset under the caret resolves to the narrowest
  // statement containing it. Narrowest wins because chain edges overlap on
  // purpose: in `A --> B --> C` every offset sits in two edge ranges at once.
  it('resolves a caret inside a node definition to that node', () => {
    const m = model();
    const at = SRC.indexOf('A[Start]') + 2;
    expect(selectionTargetAt(m, at)).toEqual({ kind: 'node', id: 'A' });
  });

  it('resolves a caret on an edge line to that edge', () => {
    const m = model();
    const at = SRC.indexOf('B -->|go| C') + 1;
    expect(selectionTargetAt(m, at)).toEqual({ kind: 'edge', id: 'B->C' });
  });

  it('prefers the narrowest range when statements overlap', () => {
    const m = model();
    // The `B` in `B -->|go| C` belongs to the edge and to a bare node ref;
    // the edge's span is tighter than anything else containing it.
    const at = SRC.indexOf('B -->|go| C');
    expect(selectionTargetAt(m, at)).toEqual({ kind: 'edge', id: 'B->C' });
  });

  it('returns null for whitespace between statements', () => {
    const m = model();
    expect(selectionTargetAt(m, SRC.indexOf('flowchart'))).toBeNull();
  });

  // Preview -> editor: a selected target maps back to a highlightable range.
  it('maps a node selection to its first definition range', () => {
    const m = model();
    const r = selectionRangeOf(m, { kind: 'node', id: 'A' });
    expect(r).not.toBeNull();
    expect(SRC.slice(r!.start, r!.end)).toContain('A[Start]');
  });

  it('maps an edge selection to the edge range', () => {
    const m = model();
    const r = selectionRangeOf(m, { kind: 'edge', id: 'B->C' });
    expect(r).not.toBeNull();
    expect(SRC.slice(r!.start, r!.end)).toContain('B -->|go| C');
  });

  it('maps a subgraph selection to its opening line', () => {
    const m = model();
    const r = selectionRangeOf(m, { kind: 'subgraph', id: 'one' });
    expect(r).not.toBeNull();
    expect(SRC.slice(r!.start, r!.end)).toContain('subgraph one');
  });

  it('returns null for unknown targets', () => {
    const m = model();
    expect(selectionRangeOf(m, { kind: 'node', id: 'ZZZ' })).toBeNull();
    expect(selectionRangeOf(m, { kind: 'edge', id: 'A->ZZZ' })).toBeNull();
    expect(selectionRangeOf(m, { kind: 'subgraph', id: 'nope' })).toBeNull();
  });

  it('round-trips: range of target contains the offset that resolves to it', () => {
    const m = model();
    const at = SRC.indexOf('D[In group]') + 1;
    const t = selectionTargetAt(m, at)!;
    expect(t).toEqual({ kind: 'node', id: 'D' });
    const r = selectionRangeOf(m, t)!;
    expect(at).toBeGreaterThanOrEqual(r.start);
    expect(at).toBeLessThan(r.end);
  });
});
