import { describe, expect, it } from 'vitest';
import { parseFlowchart } from '../src/lib/flowchart/parser';
import { allFixtures, readFixture } from './fixtures';

describe('flowchart parser', () => {
  it('parses the simple fixture', () => {
    const r = parseFlowchart(readFixture('simple.mmd'));
    expect(r.ok).toBe(true);
    const m = r.model!;
    expect(m.direction).toBe('TD');
    expect(m.edges.length).toBe(2);
    expect([...m.nodesById.keys()]).toEqual(['A', 'B', 'C']);
  });

  it('records absolute ranges', () => {
    const src = readFixture('simple.mmd');
    const m = parseFlowchart(src).model!;
    const A = m.nodesById.get('A')![0];
    expect(src.slice(A.range.start, A.range.end)).toBe('A[Start]');
    const e = m.edges[0];
    expect(src.slice(e.range.start, e.range.end).replace(/\s+/g, ' ').trim()).toBe(
      'A[Start] --> B[Process]',
    );
  });

  it('handles edge chains A --> B --> C', () => {
    const m = parseFlowchart(readFixture('chains.mmd')).model!;
    expect(m.edges.map((e) => [e.from, e.to])).toEqual([
      ['A', 'B'],
      ['B', 'C'],
      ['X', 'Y'],
      ['Y', 'Z'],
    ]);
    expect([...m.nodesById.keys()]).toEqual(['A', 'B', 'C', 'X', 'Y', 'Z']);
  });

  it('expands & groups', () => {
    const m = parseFlowchart(readFixture('groups.mmd')).model!;
    expect(m.edges.map((e) => [e.from, e.to])).toEqual([
      ['A', 'C'],
      ['B', 'C'],
      ['D', 'G'],
      ['E', 'G'],
      ['F', 'G'],
      ['H', 'I'],
      ['H', 'J'],
    ]);
  });

  it('captures edge labels', () => {
    const m = parseFlowchart(readFixture('inline-labels.mmd')).model!;
    const labeled = m.edges.filter((e) => e.label !== '');
    expect(labeled.length).toBe(2);
    expect(labeled.map((e) => e.label)).toEqual(['yes', 'no']);
  });

  it('parses subgraphs', () => {
    const m = parseFlowchart(readFixture('subgraphs.mmd')).model!;
    expect(m.subgraphs.map((s) => [s.id, s.label])).toEqual([
      ['one', 'Frontend'],
      ['two', 'Backend'],
    ]);
  });

  it('keeps comments as their own statements', () => {
    const m = parseFlowchart(readFixture('comments.mmd')).model!;
    const comments = m.statements.filter((s) => s.kind === 'comment');
    expect(comments.length).toBeGreaterThanOrEqual(3);
    for (const c of comments) {
      if (c.kind === 'comment') expect(c.range.end).toBeGreaterThan(c.range.start);
    }
  });

  it('parses all shapes', () => {
    const m = parseFlowchart(readFixture('shapes.mmd')).model!;
    expect(m.nodesById.get('A')![0].shape).toBe('rect');
    expect(m.nodesById.get('B')![0].shape).toBe('round');
    expect(m.nodesById.get('C')![0].shape).toBe('stadium');
    expect(m.nodesById.get('D')![0].shape).toBe('subroutine');
    expect(m.nodesById.get('E')![0].shape).toBe('cylinder');
    expect(m.nodesById.get('F')![0].shape).toBe('circle');
    expect(m.nodesById.get('G')![0].shape).toBe('asym');
    expect(m.nodesById.get('H')![0].shape).toBe('diamond');
    expect(m.nodesById.get('I')![0].shape).toBe('hexagon');
  });

  it('preserves comments verbatim under odd spacing', () => {
    const src = readFixture('odd-spacing.mmd');
    const m = parseFlowchart(src).model!;
    expect(m.edges.map((e) => [e.from, e.to])).toEqual([
      ['A', 'B'],
      ['C', 'D'],
      ['E', 'F'],
      ['G', 'H'],
    ]);
    // labels survive
    expect(m.nodesById.get('C')![0].label).toBe('  Spaced  ');
  });

  it('parses style statements', () => {
    const m = parseFlowchart(readFixture('styled.mmd')).model!;
    expect(m.styles.map((s) => s.kind)).toEqual([
      'style',
      'classDef',
      'class',
      'linkStyle',
    ]);
  });

  it('reads graph BT direction', () => {
    const m = parseFlowchart(readFixture('directions.mmd')).model!;
    expect(m.direction).toBe('BT');
  });

  it('handles cycles and self-loops', () => {
    const m = parseFlowchart(readFixture('cycle.mmd')).model!;
    expect(m.edges.length).toBe(4);
    expect(m.edges.some((e) => e.from === e.to && e.to === 'C')).toBe(true);
  });

  it('keeps quoted labels intact', () => {
    const m = parseFlowchart(readFixture('long-labels.mmd')).model!;
    const a = m.nodesById.get('A')![0];
    // Single quotes rather than escaped double quotes: Mermaid rejects `\"`
    // inside a `["..."]` label, so the fixture must stay renderable.
    expect(a.label).toBe("Label with (parens) and 'quotes' inside");
  });

  it('parses a 60-node diagram', () => {
    const m = parseFlowchart(readFixture('big.mmd')).model!;
    expect(m.nodesById.size).toBe(60);
    expect(m.edges.length).toBe(60);
  });

  it('handles an empty body', () => {
    const m = parseFlowchart(readFixture('empty.mmd')).model!;
    expect(m.edges.length).toBe(0);
    expect(m.nodesById.size).toBe(0);
  });

  it('no fixture text is silently dropped: ranges tile the source', () => {
    for (const { name, source } of allFixtures()) {
      const m = parseFlowchart(source).model!;
      // Every non-blank character must be covered by some statement range
      // or be an unknown span.
      const covered = new Uint8Array(source.length);
      const cover = (s: number, e: number) => {
        for (let i = Math.max(0, s); i < Math.min(source.length, e); i++) covered[i] = 1;
      };
      if (m.directionRange) cover(m.directionRange.start, m.directionRange.end);
      for (const st of m.statements) cover(st.range.start, st.range.end);
      for (const u of m.unknown) cover(u.range.start, u.range.end);
      for (let i = 0; i < source.length; i++) {
        if (!covered[i]) {
          const line = source.slice(0, i).split('\n').length;
          // Whitespace between statements is allowed to be uncovered, but
          // no *visible* character may be.
          if (!/\s/.test(source[i])) {
            throw new Error(`${name}: uncovered char at ${i} (line ${line}): ${JSON.stringify(source.slice(i, i + 12))}`);
          }
        }
      }
    }
  });
});
