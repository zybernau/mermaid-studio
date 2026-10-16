import { describe, expect, it } from 'vitest';
import {
  initialHistory,
  pushHistory,
  undo,
  redo,
  canUndo,
  canRedo,
} from '../src/lib/flowchart/history';

describe('history', () => {
  it('starts with nothing to undo or redo', () => {
    const h = initialHistory('a');
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
    expect(h.present).toBe('a');
  });

  it('pushes snapshots onto the past', () => {
    let h = initialHistory('a');
    h = pushHistory(h, 'b', 0);
    h = pushHistory(h, 'c', 1000);
    expect(h.present).toBe('c');
    expect(h.past).toEqual(['a', 'b']);
  });

  it('returns the same object when nothing changed', () => {
    const h = initialHistory('a');
    expect(pushHistory(h, 'a', 0)).toBe(h);
  });

  it('undoes and redoes symmetrically', () => {
    let h = initialHistory('a');
    h = pushHistory(h, 'b', 0);
    h = pushHistory(h, 'c', 1000);

    h = undo(h);
    expect(h.present).toBe('b');
    h = undo(h);
    expect(h.present).toBe('a');
    expect(canUndo(h)).toBe(false);

    h = redo(h);
    expect(h.present).toBe('b');
    h = redo(h);
    expect(h.present).toBe('c');
    expect(canRedo(h)).toBe(false);
  });

  it('undo is a no-op at the bottom, redo at the top', () => {
    const a = initialHistory('a');
    expect(undo(a).present).toBe('a');
    expect(redo(a).present).toBe('a');
  });

  // A colour slider firing every frame must not bury the previous state under
  // 60 near-identical snapshots.
  it('groups rapid pushes into one entry', () => {
    let h = initialHistory('start');
    h = pushHistory(h, 'drag-1', 1000);
    h = pushHistory(h, 'drag-2', 1100);
    h = pushHistory(h, 'drag-3', 1200);
    expect(h.past).toEqual(['start']);
    expect(h.present).toBe('drag-3');

    h = undo(h);
    expect(h.present).toBe('start');
  });

  it('does not group once the gap exceeds the window', () => {
    let h = initialHistory('start');
    h = pushHistory(h, 'a', 1000);
    h = pushHistory(h, 'b', 5000);
    expect(h.past).toEqual(['start', 'a']);
  });

  it('does not group after an undo, so a new edit starts a fresh branch', () => {
    let h = initialHistory('start');
    h = pushHistory(h, 'a', 1000);
    h = undo(h);
    // A new edit 10ms later must not merge into the pre-undo state.
    h = pushHistory(h, 'other', 1010);
    expect(h.past).toEqual(['start']);
    expect(h.present).toBe('other');
    // The abandoned branch is gone.
    expect(canRedo(h)).toBe(false);
  });

  it('honours a custom grouping window', () => {
    let h = initialHistory('start');
    h = pushHistory(h, 'a', 1000, { groupMs: 0 });
    h = pushHistory(h, 'b', 1010, { groupMs: 0 });
    expect(h.past).toEqual(['start', 'a']);
  });

  it('caps the past length, dropping the oldest', () => {
    let h = initialHistory('s0');
    for (let i = 1; i <= 10; i++) {
      h = pushHistory(h, `s${i}`, i * 10_000, { limit: 3 });
    }
    expect(h.past.length).toBe(3);
    expect(h.past).toEqual(['s7', 's8', 's9']);
    expect(h.present).toBe('s10');
  });

  it('a push after undo clears the redo branch', () => {
    let h = initialHistory('a');
    h = pushHistory(h, 'b', 0);
    h = undo(h);
    expect(canRedo(h)).toBe(true);
    h = pushHistory(h, 'c', 9_999_999);
    expect(h.past).toEqual(['a']);
    expect(h.present).toBe('c');
    expect(canRedo(h)).toBe(false);
  });

  it('walks back through a long stack', () => {
    let h = initialHistory('s0');
    for (let i = 1; i <= 20; i++) h = pushHistory(h, `s${i}`, i * 10_000);
    const seen: string[] = [];
    while (canUndo(h)) {
      h = undo(h);
      seen.push(h.present);
    }
    expect(seen).toHaveLength(20);
    expect(seen[seen.length - 1]).toBe('s0');
  });
});
