import { describe, expect, it } from 'vitest';
import mermaid from 'mermaid';
import { readFixture, fixtureNames } from './fixtures';
import { parseFlowchart, type FlowchartModel } from '../src/lib/flowchart/parser';
import {
  ARROW_TOKENS,
  addEdge,
  addNode,
  changeEdgeLabel,
  changeEdgeToken,
  changeShape,
  deleteEdge,
  deleteNode,
  renameNode,
  setDirection,
  setNodeStyle,
  uniqueNodeId,
} from '../src/lib/flowchart/patch';
import { quoteLabel } from '../src/lib/flowchart/quote';

function model(src: string): FlowchartModel {
  const r = parseFlowchart(src);
  expect(r.ok).toBe(true);
  return r.model!;
}

describe('quoteLabel', () => {
  it('leaves safe bare words unquoted', () => {
    expect(quoteLabel('Start')).toBe('Start');
    expect(quoteLabel('node1')).toBe('node1');
  });

  it('quotes anything with whitespace or brackets', () => {
    expect(quoteLabel('Hello world')).toBe('"Hello world"');
    expect(quoteLabel('a(b)')).toBe('"a(b)"');
    expect(quoteLabel('a,b')).toBe('"a,b"');
  });

  it('escapes quotes as HTML entities rather than backslashes', () => {
    // Mermaid's lexer only tolerates \" as the closing quote, so `A["a \"b\" c"]`
    // is a parse error while `&quot;` renders correctly everywhere.
    expect(quoteLabel('say "hi"')).toBe('"say &quot;hi&quot;"');
  });

  it('leaves a backslash literal, which mermaid accepts', () => {
    expect(quoteLabel('back\\slash')).toBe('"back\\slash"');
  });

  it('quotes labels that would otherwise terminate the shape', () => {
    expect(quoteLabel('a]b')).toBe('"a]b"');
    expect(quoteLabel('a{b')).toBe('"a{b"');
    expect(quoteLabel('a#b')).toBe('"a#b"');
    expect(quoteLabel('a;b')).toBe('"a;b"');
  });

  it('quotes @, which mermaid rejects outside a quoted label', () => {
    expect(quoteLabel('@home')).toBe('"@home"');
  });
});

describe('renameNode', () => {
  it('rewrites only the target node, keeping other lines byte-identical', () => {
    const src = readFixture('simple.mmd');
    const out = renameNode(src, model(src), 'B', 'Renamed');
    expect(out).toContain('B[Renamed]');
    // A and C untouched
    expect(out).toContain('A[Start]');
    expect(out).toContain('C[End]');
    // Line count identical
    expect(out.split('\n').length).toBe(src.split('\n').length);
  });

  it('quotes labels containing spaces or quotes', () => {
    const src = readFixture('simple.mmd');
    const out = renameNode(src, model(src), 'A', 'Hello (world) "x"');
    expect(out).toContain('A["Hello (world) &quot;x&quot;"]');
    // The parser stores the source text verbatim, so the entity survives into
    // the model; Mermaid decodes it for display (pinned by the e2e render test).
    expect(model(out).nodesById.get('A')![0].label).toBe('Hello (world) &quot;x&quot;');
  });

  it('preserves surrounding comments', () => {
    const src = readFixture('comments.mmd');
    const out = renameNode(src, model(src), 'A', 'Renamed');
    expect(out).toContain('%% leading comment');
    expect(out).toContain('%% standalone line');
    expect(out).toContain('%%% multi');
  });

  it('preserves a trailing comment on the edited line', () => {
    // Mermaid rejects this form, but the editor must never lose text the user
    // wrote even when the diagram itself will not render.
    const src = 'flowchart TD\n    A[Start] --> B %% trailing comment\n';
    const out = renameNode(src, model(src), 'A', 'Renamed');
    expect(out).toContain('%% trailing comment');
    expect(out).toContain('Renamed');
  });

  it('is a no-op for an unknown id', () => {
    const src = readFixture('simple.mmd');
    expect(renameNode(src, model(src), 'ZZZ', 'x')).toBe(src);
  });

  it('preserves the shape when renaming', () => {
    const src = readFixture('shapes.mmd');
    const out = renameNode(src, model(src), 'C', 'Stadium');
    expect(out).toContain('C([Stadium])');
  });
});

describe('changeShape', () => {
  it('keeps the label text when the shape changes', () => {
    const src = readFixture('simple.mmd');
    const out = changeShape(src, model(src), 'A', 'diamond');
    expect(out).toContain('A{Start}');
    expect(model(out).nodesById.get('A')![0].label).toBe('Start');
    expect(model(out).nodesById.get('A')![0].shape).toBe('diamond');
  });

  it('changes shape twice without duplicating brackets', () => {
    const src = readFixture('simple.mmd');
    const once = changeShape(src, model(src), 'A', 'circle');
    expect(once).toContain('A((Start))');
    const twice = changeShape(once, model(once), 'A', 'stadium');
    expect(twice).toContain('A([Start])');
    expect(model(twice).nodesById.get('A')![0].shape).toBe('stadium');
    expect(model(twice).nodesById.get('A')![0].label).toBe('Start');
  });

  it('leaves other nodes untouched', () => {
    const src = readFixture('simple.mmd');
    const out = changeShape(src, model(src), 'A', 'hexagon');
    expect(out).toContain('B[Process]');
    expect(out).toContain('C[End]');
  });
});

describe('deleteNode', () => {
  it('removes the node and every edge touching it', () => {
    const src = readFixture('simple.mmd');
    const out = deleteNode(src, model(src), 'B');
    const m = model(out);
    expect(m.nodesById.has('B')).toBe(false);
    expect(m.edges).toHaveLength(0);
    // A and C survive
    expect(m.nodesById.has('A')).toBe(true);
    expect(m.nodesById.has('C')).toBe(true);
  });

  it('leaves no dangling edges', () => {
    const src = readFixture('cycle.mmd');
    const out = deleteNode(src, model(src), 'B');
    for (const e of model(out).edges) {
      expect(e.from === 'B' || e.to === 'B').toBe(false);
    }
  });

  it('keeps comments and blank lines intact', () => {
    const src = readFixture('comments.mmd');
    const out = deleteNode(src, model(src), 'C');
    expect(out).toContain('%% leading comment');
    expect(out).toContain('%% standalone line');
    expect(out).toContain('%% multi');
  });

  it('is a no-op for an unknown id', () => {
    const src = readFixture('simple.mmd');
    expect(deleteNode(src, model(src), 'NOPE')).toBe(src);
  });

  it('removes a style line that targets the deleted node', () => {
    const src = readFixture('styled.mmd');
    const out = deleteNode(src, model(src), 'A');
    expect(out).not.toContain('style A ');
  });
});

describe('addNode', () => {
  it('appends a uniquely-named node', () => {
    const src = readFixture('simple.mmd');
    const out = addNode(src, model(src), 'Fresh');
    const m = model(out);
    expect(m.nodesById.has('Fresh')).toBe(true);
    expect(m.nodesById.get('Fresh')![0].label).toBe('Fresh');
  });

  it('never collides when ids repeat', () => {
    let src = readFixture('empty.mmd');
    for (let i = 0; i < 50; i++) {
      src = addNode(src, model(src), `Node ${i}`, 'rect', 'dup');
    }
    const m = model(src);
    expect(m.nodesById.size).toBe(50);
    const ids = [...m.nodesById.keys()];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('dup');
    expect(ids).toContain('dup49');
  });

  it('quotes labels that need it', () => {
    const src = readFixture('empty.mmd');
    const out = addNode(src, model(src), 'two words', 'rect', 'z');
    expect(out).toContain('z["two words"]');
    expect(model(out).nodesById.get('z')![0].label).toBe('two words');
  });

  it('uniqueNodeId skips taken ids', () => {
    const m = model(readFixture('simple.mmd'));
    expect(uniqueNodeId(m, 'A')).toBe('A1');
    expect(uniqueNodeId(m, 'Z')).toBe('Z');
  });
});

describe('addEdge', () => {
  it('appends a new edge statement', () => {
    const src = readFixture('simple.mmd');
    const out = addEdge(src, model(src), 'C', 'A');
    const m = model(out);
    expect(m.edges.some((e) => e.from === 'C' && e.to === 'A')).toBe(true);
    // original edges preserved
    expect(m.edges.some((e) => e.from === 'A' && e.to === 'B')).toBe(true);
  });

  it('supports an explicit label and token', () => {
    const src = readFixture('simple.mmd');
    const out = addEdge(src, model(src), 'A', 'C', '==>', 'yes');
    const m = model(out);
    const e = m.edges.find((x) => x.from === 'A' && x.to === 'C');
    expect(e!.label).toBe('yes');
    expect(e!.type).toBe('thick');
  });

  it('leaves comments alone', () => {
    const src = readFixture('comments.mmd');
    const out = addEdge(src, model(src), 'A', 'C');
    expect(out).toContain('%% leading comment');
  });
});

describe('deleteEdge', () => {
  it('removes a standalone edge', () => {
    const src = readFixture('simple.mmd');
    const out = deleteEdge(src, model(src), 0);
    const m = model(out);
    expect(m.edges).toHaveLength(1);
    expect(m.edges[0].from).toBe('B');
  });

  it('keeps the other link when deleting one edge from a chain', () => {
    const src = readFixture('chains.mmd');
    // chains.mmd holds two 2-link chains; deleting the first link of the first
    // chain must leave three edges overall.
    const out = deleteEdge(src, model(src), 0);
    const m = model(out);
    expect(m.edges).toHaveLength(3);
    expect(m.edges.some((e) => e.from === 'A' && e.to === 'B')).toBe(false);
    expect(m.edges.some((e) => e.from === 'B' && e.to === 'C')).toBe(true);
    expect(m.edges.some((e) => e.from === 'X' && e.to === 'Y')).toBe(true);
    expect(m.edges.some((e) => e.from === 'Y' && e.to === 'Z')).toBe(true);
  });

  it('drops the whole line when it is the only edge', () => {
    const src = readFixture('simple.mmd');
    const out = deleteEdge(src, model(src), 0);
    expect(out.split('\n').filter((l) => l.includes('-->')).length).toBe(1);
  });

  it('is a no-op for an out-of-range index', () => {
    const src = readFixture('simple.mmd');
    expect(deleteEdge(src, model(src), 99)).toBe(src);
  });
});

describe('changeEdgeLabel', () => {
  it('replaces an existing label', () => {
    const src = readFixture('inline-labels.mmd');
    const idx = model(src).edges.findIndex((e) => e.label === 'yes');
    const out = changeEdgeLabel(src, model(src), idx, 'maybe');
    const e = model(out).edges.find((x) => x.from === 'B' && x.to === 'C');
    expect(e!.label).toBe('maybe');
  });

  it('adds a label to an unlabelled edge', () => {
    const src = readFixture('simple.mmd');
    const out = changeEdgeLabel(src, model(src), 0, 'new');
    const e = model(out).edges.find((x) => x.from === 'A' && x.to === 'B');
    expect(e!.label).toBe('new');
  });

  it('leaves the other edges alone', () => {
    const src = readFixture('inline-labels.mmd');
    const idx = model(src).edges.findIndex((e) => e.label === 'yes');
    const out = changeEdgeLabel(src, model(src), idx, 'maybe');
    const other = model(out).edges.find((x) => x.label === 'no');
    expect(other).toBeTruthy();
  });

  // Regression: setting a blank label used to leave empty pipes behind. The
  // parser tolerates `A -->|| B`, so only a real mermaid.parse fails — which
  // is exactly how the fuzzer caught it.
  it('clears the pipes entirely when the new label is empty', async () => {
    const src = readFixture('inline-labels.mmd');
    const idx = model(src).edges.findIndex((e) => e.label === 'yes');
    const out = changeEdgeLabel(src, model(src), idx, '');
    expect(out).not.toContain('||');
    await expect(mermaid.parse(out)).resolves.toBeTruthy();
  });

  it('treats a whitespace-only label as empty', () => {
    const src = readFixture('inline-labels.mmd');
    const idx = model(src).edges.findIndex((e) => e.label === 'yes');
    expect(changeEdgeLabel(src, model(src), idx, '   ')).toBe(
      changeEdgeLabel(src, model(src), idx, ''),
    );
  });

  // Regression: the inserted `|label|` used to leave the whitespace that
  // already followed the arrow in place. Mermaid only tolerates whitespace
  // *before* a label, never after it, so `C[X] -->   D` became the unparseable
  // `C[X] -->|lbl|   D` and the preview died. The fuzzer found it because the
  // parser itself accepts both, so only a real mermaid.parse catches it.
  it('emits mermaid-valid text for every edge of every fixture', async () => {
    const bad: string[] = [];
    for (const name of fixtureNames()) {
      if (name === 'invalid.mmd') continue;
      const src = readFixture(name);
      const m = model(src);
      for (let i = 0; i < m.edges.length; i++) {
        for (const label of ['yes', 'a b', 'hello (world) "x"']) {
          const out = changeEdgeLabel(src, m, i, label);
          try {
            await mermaid.parse(out);
          } catch (e) {
            bad.push(`${name}[${i}] ${JSON.stringify(label)} -> ${JSON.stringify(out)}: ${String((e as Error).message).split('\n')[0]}`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  }, 120_000);
});

describe('changeEdgeToken', () => {
  it('switches the arrow style while keeping endpoints', () => {
    const src = readFixture('simple.mmd');
    const out = changeEdgeToken(src, model(src), 0, '-.->');
    const e = model(out).edges.find((x) => x.from === 'A' && x.to === 'B');
    expect(e!.type).toBe('dotted');
    expect(e!.from).toBe('A');
    expect(e!.to).toBe('B');
  });

  it.each(ARROW_TOKENS)('rewrites an edge to %s', (token) => {
    // Regression: an arrow matcher that mishandled `-->` silently turned both
    // changeEdgeToken and changeEdgeLabel into no-ops, which no single-token
    // test would catch.
    const src = readFixture('simple.mmd');
    const out = changeEdgeToken(src, model(src), 0, token);
    expect(out).toContain(`A[Start] ${token} B[Process]`);
    // Reversed tokens (`<-->`, `<-.-`) may be modelled as B->A; either way the
    // endpoints must both survive.
    const e = model(out).edges.find(
      (x) => (x.from === 'A' && x.to === 'B') || (x.from === 'B' && x.to === 'A'),
    );
    expect(e, `edge between A and B missing after switching to ${token}`).toBeTruthy();
    // Rewriting to the token it already has is legitimately a no-op.
    if (token !== '-->') expect(out).not.toBe(src);
  });

  it('preserves an edge label through the token change', () => {
    const src = readFixture('inline-labels.mmd');
    const idx = model(src).edges.findIndex((e) => e.label === 'yes');
    const out = changeEdgeToken(src, model(src), idx, '===');
    const e = model(out).edges.find((x) => x.from === 'B' && x.to === 'C');
    expect(e!.label).toBe('yes');
    expect(e!.type).toBe('thickOpen');
  });
});

describe('setDirection', () => {
  it('rewrites the header direction', () => {
    const src = readFixture('simple.mmd');
    const out = setDirection(src, model(src), 'LR');
    expect(out.startsWith('flowchart LR')).toBe(true);
    expect(model(out).direction).toBe('LR');
  });

  it('works on graph headers too', () => {
    const src = readFixture('directions.mmd');
    const out = setDirection(src, model(src), 'LR');
    expect(out.startsWith('graph LR')).toBe(true);
  });

  it('keeps body statements untouched', () => {
    const src = readFixture('simple.mmd');
    const out = setDirection(src, model(src), 'BT');
    expect(out).toContain('A[Start] --> B[Process]');
  });
});

describe('setNodeStyle', () => {
  it('appends a style line when none exists', () => {
    const src = readFixture('simple.mmd');
    const out = setNodeStyle(src, model(src), 'A', { fill: '#f9f', stroke: '#333' });
    expect(out).toContain('style A fill:#f9f,stroke:#333');
  });

  it('replaces an existing style instead of duplicating it', () => {
    const src = readFixture('styled.mmd');
    const once = setNodeStyle(src, model(src), 'A', { fill: '#111' });
    const twice = setNodeStyle(once, model(once), 'A', { fill: '#222' });
    const count = twice.split('\n').filter((l) => l.trim().startsWith('style A')).length;
    expect(count).toBe(1);
    expect(twice).toContain('fill:#222');
  });
});

describe('patch round-trip invariants', () => {
  /** Renaming then renaming back must restore the original byte-for-byte. */
  it('rename is reversible', () => {
    const src = readFixture('simple.mmd');
    const once = renameNode(src, model(src), 'A', 'Changed');
    const back = renameNode(once, model(once), 'A', 'Start');
    expect(back).toBe(src);
  });

  it('delete then re-add leaves the original lines intact', () => {
    const src = readFixture('comments.mmd');
    const del = deleteNode(src, model(src), 'B');
    const restored = addNode(del, model(del), 'Middle', 'rect', 'B');
    expect(restored).toContain('%% leading comment');
    expect(restored).toContain('%% standalone line');
    expect(model(restored).nodesById.has('B')).toBe(true);
  });

  it('every fixture survives a rename with no dropped text', () => {
    for (const name of fixtureNames()) {
      if (name === 'invalid.mmd') continue;
      const src = readFixture(name);
      const m = model(src);
      const first = [...m.nodesById.keys()][0];
      if (!first) continue;
      const out = renameNode(src, m, first, `renamed-${first}`);
      // Comments must survive verbatim.
      for (const line of src.split('\n')) {
        if (line.trim().startsWith('%%')) {
          expect(out.split('\n')).toContain(line);
        }
      }
    }
  });
});