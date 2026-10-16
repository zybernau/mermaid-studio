import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseFlowchart } from '../src/lib/flowchart/parser';
import { moveNodeIntoSubgraph } from '../src/lib/flowchart/patch';

const FIXTURES = join(process.cwd(), 'fixtures');
const read = (n: string) => readFileSync(join(FIXTURES, n), 'utf8');
const model = (src: string) => parseFlowchart(src).model!;

const SRC = `flowchart TD
    subgraph one [Frontend]
        A[Web] --> B[API]
    end
    subgraph two [Backend]
        C[DB] --> D[Cache]
    end
    B --> C
`;

describe('subgraph range spans its whole block', () => {
  // Containment checks (is this node inside that subgraph?) are meaningless
  // unless `range` covers the block, so the parser widens each opener to its
  // matching `end`. Without this, moveNodeIntoSubgraph cannot tell an
  // already-inside node from an outside one.
  it('covers from the subgraph keyword through the end keyword', () => {
    const m = model(SRC);
    const one = m.subgraphs.find((s) => s.id === 'one')!;
    const text = SRC.slice(one.range.start, one.range.end);
    // Ranges are line-based, so indentation is included; compare trimmed.
    expect(text.trimStart().startsWith('subgraph one')).toBe(true);
    expect(text.trimEnd().endsWith('end')).toBe(true);
    expect(text).toContain('A[Web] --> B[API]');
    // The closer is inside, not after.
    expect(one.range.end).toBeGreaterThan(text.indexOf('A[Web]'));
  });

  it('nests correctly: an inner block sits inside the outer one', () => {
    const nested = 'flowchart TD\n    subgraph outer [O]\n        A\n        subgraph inner [I]\n            B\n        end\n    end\n';
    const m = model(nested);
    const outer = m.subgraphs.find((s) => s.id === 'outer')!;
    const inner = m.subgraphs.find((s) => s.id === 'inner')!;
    expect(inner.range.start).toBeGreaterThan(outer.range.start);
    expect(inner.range.end).toBeLessThanOrEqual(outer.range.end);
  });

  it('leaves an unterminated subgraph at one line rather than swallowing the file', () => {
    const open = 'flowchart TD\n    subgraph one [Frontend]\n        A[Web] --> B\n';
    const one = model(open).subgraphs.find((s) => s.id === 'one')!;
    // No `end`, so the range must not run to the end of the source.
    expect(one.range.end).toBeLessThan(open.length);
  });

  it('still round-trips the opener and the closer separately', () => {
    const m = model(SRC);
    const closers = m.statements.filter(
      (s) => s.kind === 'subgraph' && s.range.start !== s.openRange.start,
    );
    expect(closers.length).toBe(2);
    for (const c of closers) {
      expect(SRC.slice(c.range.start, c.range.end).trim()).toBe('end');
    }
  });
});

describe('moveNodeIntoSubgraph', () => {
  // "Move" for v1 is re-parenting, not a canvas drag: Mermaid owns the layout,
  // so translating a rendered node would leave its edges behind.
  it('moves a top-level node into a subgraph', () => {
    const out = moveNodeIntoSubgraph(SRC, model(SRC), 'B', 'two');
    const m = model(out);
    const sg = m.subgraphs.find((s) => s.id === 'two')!;
    const b = m.nodesById.get('B')![0];
    // B now lives inside subgraph two's range.
    expect(b.range.start).toBeGreaterThanOrEqual(sg.range.start);
    expect(b.range.end).toBeLessThanOrEqual(sg.range.end);
  });

  it('keeps the moved node\'s label and shape', () => {
    const out = moveNodeIntoSubgraph(SRC, model(SRC), 'A', 'two');
    const a = model(out).nodesById.get('A')![0];
    expect(a.label).toBe('Web');
  });

  it('leaves every edge intact — the graph changes, not the pixels', () => {
    const before = model(SRC);
    const out = moveNodeIntoSubgraph(SRC, before, 'B', 'two');
    const after = model(out);
    const key = (e: { from: string; to: string }) => `${e.from}->${e.to}`;
    expect(after.edges.map(key).sort()).toEqual(before.edges.map(key).sort());
  });

  it('does not disturb the other subgraph', () => {
    const out = moveNodeIntoSubgraph(SRC, model(SRC), 'A', 'two');
    const m = model(out);
    const two = m.subgraphs.find((s) => s.id === 'two')!;
    const c = m.nodesById.get('C')![0];
    expect(c.range.start).toBeGreaterThan(two.range.start);
  });

  it('is a no-op when the node is already in that subgraph', () => {
    expect(moveNodeIntoSubgraph(SRC, model(SRC), 'A', 'one')).toBe(SRC);
  });

  it('is a no-op for an unknown node or subgraph', () => {
    const m = model(SRC);
    expect(moveNodeIntoSubgraph(SRC, m, 'ZZZ', 'two')).toBe(SRC);
    expect(moveNodeIntoSubgraph(SRC, m, 'A', 'nope')).toBe(SRC);
  });

  it('preserves comments outside the moved line', () => {
    const src = 'flowchart TD\n    %% keep me\n    A[X] --> B\n    subgraph g [G]\n        C\n    end\n';
    const out = moveNodeIntoSubgraph(src, model(src), 'B', 'g');
    expect(out).toContain('%% keep me');
  });

  it('result still parses as valid mermaid on every subgraph fixture', () => {
    for (const name of readdirSync(FIXTURES).filter((f) => f.endsWith('.mmd'))) {
      const src = read(name);
      const m = model(src);
      if (m.subgraphs.length === 0) continue;
      const movable = [...m.nodesById.keys()].find(
        (id) => !m.subgraphs.some((s) => {
          const n = m.nodesById.get(id)![0];
          return n.range.start >= s.range.start && n.range.end <= s.range.end;
        }),
      );
      if (!movable) continue;
      const out = moveNodeIntoSubgraph(src, m, movable, m.subgraphs[0].id);
      expect(parseFlowchart(out).model, `${name}: moving ${movable}`).toBeTruthy();
    }
  });
});
