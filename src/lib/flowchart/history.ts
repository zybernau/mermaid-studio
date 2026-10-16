/**
 * Undo/redo as a single history stack of **text snapshots**.
 *
 * Both typed edits and visual edits funnel through here, so Ctrl+Z walks back
 * across both kinds interchangeably — that is the whole point of storing text
 * rather than "operations". A visual action is just another snapshot.
 *
 * Rapid edits within `groupMs` are merged into one entry so dragging a colour
 * slider does not bury the previous state under 60 near-identical snapshots.
 */

export interface HistoryState {
  past: string[];
  present: string;
  future: string[];
}

export interface HistoryOptions {
  /** Snapshots taken within this window collapse into one. Default 400ms. */
  groupMs?: number;
  /** Hard cap on `past` length; oldest entries are dropped. Default 200. */
  limit?: number;
}

export function initialHistory(present: string): HistoryState {
  return { past: [], present, future: [] };
}

/**
 * Record a new present value.
 *
 * Returns the same object when nothing changed, so callers can memoise on
 * identity. A change arriving inside the grouping window replaces the current
 * present instead of pushing a new entry.
 */
export function pushHistory(
  state: HistoryState,
  next: string,
  now: number,
  opts: HistoryOptions = {},
): HistoryState {
  if (next === state.present) return state;
  const groupMs = opts.groupMs ?? 400;
  const limit = opts.limit ?? 200;

  // Grouping only applies while the future is empty: once the user has undone,
  // a fresh edit starts a new branch and must not merge into the pre-undo state.
  const lastAt = lastPushAt.get(state);
  const canGroup =
    state.future.length === 0 &&
    lastAt !== undefined &&
    now - lastAt < groupMs;

  const nextPast = canGroup
    ? state.past
    : [...state.past, state.present].slice(-limit);
  const out: HistoryState = { past: nextPast, present: next, future: [] };
  lastPushAt.set(out, now);
  return out;
}

/**
 * Timestamp of the most recent push, keyed by state identity.
 *
 * Weak keys keep this from leaking: a discarded history entry is collected and
 * its timestamp goes with it.
 */
const lastPushAt = new WeakMap<HistoryState, number>();

export function canUndo(state: HistoryState): boolean {
  return state.past.length > 0;
}

export function canRedo(state: HistoryState): boolean {
  return state.future.length > 0;
}

/** Step back one snapshot, or return the state unchanged. */
export function undo(state: HistoryState): HistoryState {
  if (state.past.length === 0) return state;
  const past = state.past.slice();
  const present = past.pop()!;
  return { past, present, future: [state.present, ...state.future] };
}

/** Step forward one snapshot, or return the state unchanged. */
export function redo(state: HistoryState): HistoryState {
  if (state.future.length === 0) return state;
  const [present, ...future] = state.future;
  return { past: [...state.past, state.present], present, future };
}

/** Replace the present without touching history (used when loading a file). */
export function resetHistory(present: string): HistoryState {
  return initialHistory(present);
}
