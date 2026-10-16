import { describe, expect, it } from 'vitest';
import { parseFlowchart } from '../src/lib/flowchart/parser';
import {
  parseLayout,
  setNodeOffset,
  repairPathD,
} from '../src/lib/flowchart/layout';

const SRC = 'flowchart TD\n    A[Start] --> B[End]\n';
const model = (src: string) => parseFlowchart(src).model!;

describe('parseLayout', () => {
  it('returns no offsets when the source has no layout comment', () => {
    const r = parseLayout(SRC);
    expect(r.offsets.size).toBe(0);
    expect(r.range).toBeNull();
  });

  it('reads ids and signed deltas from the comment', () => {
    const src = 'flowchart TD\n    A --> B\n%% layout: A=10,0 B=-20,30\n';
    const r = parseLayout(src);
    expect(r.offsets.get('A')).toEqual({ dx: 10, dy: 0 });
    expect(r.offsets.get('B')).toEqual({ dx: -20, dy: 30 });
    expect(r.range).not.toBeNull();
    // The range covers exactly the comment line's text.
    expect(src.slice(r.range!.start, r.range!.end)).toBe('%% layout: A=10,0 B=-20,30');
  });

  it('ignores other comments', () => {
    const r = parseLayout('flowchart TD\n    %% just a note\n    A --> B\n');
    expect(r.offsets.size).toBe(0);
    expect(r.range).toBeNull();
  });
});

describe('setNodeOffset', () => {
  it('appends a layout comment on the first nudge', () => {
    const out = setNodeOffset(SRC, model(SRC), 'A', 10, 0);
    expect(out).toBe(SRC + '%% layout: A=10,0\n');
    expect(parseLayout(out).offsets.get('A')).toEqual({ dx: 10, dy: 0 });
  });

  it('accumulates deltas across nudges', () => {
    let src = setNodeOffset(SRC, model(SRC), 'A', 10, 0);
    src = setNodeOffset(src, model(src), 'A', 10, 0);
    src = setNodeOffset(src, model(src), 'A', -5, 30);
    expect(parseLayout(src).offsets.get('A')).toEqual({ dx: 15, dy: 30 });
    // Still exactly one layout comment.
    expect(src.match(/%% layout:/g)).toHaveLength(1);
  });

  it('replaces the line in place rather than appending a second one', () => {
    let src = setNodeOffset(SRC, model(SRC), 'A', 10, 0);
    const firstRange = parseLayout(src).range;
    src = setNodeOffset(src, model(src), 'A', 20, 0);
    expect(parseLayout(src).range).toEqual(firstRange);
    expect(src).toBe('flowchart TD\n    A[Start] --> B[End]\n%% layout: A=30,0\n');
  });

  it('drops the comment entirely when the offset returns to zero', () => {
    let src = setNodeOffset(SRC, model(SRC), 'A', 10, 0);
    src = setNodeOffset(src, model(src), 'A', -10, 0);
    expect(parseLayout(src).range).toBeNull();
    expect(src).toBe(SRC);
  });

  it('prunes deleted nodes while keeping live ones', () => {
    let src = setNodeOffset(SRC, model(SRC), 'A', 10, 0);
    src = setNodeOffset(src, model(src), 'B', 5, 5);
    const deleted = src.replace('    A[Start] --> B[End]\n', '    B[End]\n');
    src = setNodeOffset(deleted, model(deleted), 'B', 5, 5);
    const parsed = parseLayout(src);
    expect(parsed.offsets.has('A')).toBe(false);
    expect(parsed.offsets.get('B')).toEqual({ dx: 10, dy: 10 });
  });

  it('handles a source that does not end with a newline', () => {
    const src = 'flowchart TD\n    A --> B';
    const out = setNodeOffset(src, model(src + '\n'), 'A', 5, 5);
    expect(out).toBe('flowchart TD\n    A --> B\n%% layout: A=5,5\n');
  });

  it('does not mutate the source when nothing changes', () => {
    expect(setNodeOffset(SRC, model(SRC), 'A', 0, 0)).toBe(SRC);
  });
});

describe('repairPathD', () => {
  it('translates only the start anchor', () => {
    expect(repairPathD('M10,20L30,40', { start: { dx: 5, dy: 5 } })).toBe(
      'M15,25L30,40',
    );
  });

  it('translates only the end anchor', () => {
    expect(repairPathD('M10,20L30,40', { end: { dx: 5, dy: 5 } })).toBe(
      'M10,20L35,45',
    );
  });

  it('translates both anchors independently', () => {
    expect(
      repairPathD('M10,20L30,40', { start: { dx: -10, dy: 0 }, end: { dx: 0, dy: 5 } }),
    ).toBe('M0,20L30,45');
  });

  it('leaves interior curve points alone so the join stretches, not rotates', () => {
    expect(
      repairPathD('M0,0C10,10 20,20 30,30', { end: { dx: 5, dy: -5 } }),
    ).toBe('M0,0C10,10 20,20 35,25');
  });

  it('moves every point for a self-loop', () => {
    expect(
      repairPathD('M0,0C10,10 20,20 30,30', { all: { dx: 5, dy: 5 } }),
    ).toBe('M5,5C15,15 25,25 35,35');
  });

  it('moves only the trailing point of an arc, never the flags', () => {
    expect(
      repairPathD('M0,0A5,5 0 0 1 10,10', { end: { dx: 2, dy: 3 } }),
    ).toBe('M0,0A5,5 0 0 1 12,13');
  });

  it('rounds to three decimals without float noise', () => {
    expect(
      repairPathD('M66.992,62L66.992,66.167', { start: { dx: 0.1, dy: -0.2 } }),
    ).toBe('M67.092,61.8L66.992,66.167');
  });

  it('returns the path untouched for zero deltas', () => {
    const d = 'M10,20L30,40';
    expect(repairPathD(d, { start: { dx: 0, dy: 0 }, end: { dx: 0, dy: 0 } })).toBe(d);
  });

  it('handles a real mermaid edge path', () => {
    const d =
      'M66.992,62L66.992,66.167C66.992,70.333,66.992,78.667,66.992,86.333C66.992,94,66.992,101,66.992,105';
    const out = repairPathD(d, { start: { dx: 10, dy: 0 } });
    // First point moved, everything else byte-identical.
    expect(out.startsWith('M76.992,62L66.992,66.167C')).toBe(true);
    expect(out.endsWith('66.992,105')).toBe(true);
  });
});
