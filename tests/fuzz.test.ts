import { describe, expect, it } from 'vitest';
import { fixtureNames, readFixture } from './fixtures';
import {
  parseFlowchart,
  type FlowchartModel,
  type NodeShape,
} from '../src/lib/flowchart/parser';
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
} from '../src/lib/flowchart/patch';

/**
 * Deterministic PRNG so a failing fuzz run can be reproduced exactly.
 * (mulberry32)
 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LABELS = [
  'Start',
  'Two words',
  'Hello (world) "x"',
  'a,b',
  'ends with space ',
  'Ünïcödé',
  '50% done',
  '',
  'very '.repeat(30) + 'long',
];

// Typed rather than `as const` so the array stays mutable for `pick`, while
// still being checked against NodeShape.
const SHAPES: NodeShape[] = ['rect', 'round', 'diamond', 'circle', 'stadium', 'hexagon'];
// The verified link vocabulary, so the fuzzer exercises every token the editor
// can emit rather than a hand-picked subset.
const TOKENS = [...ARROW_TOKENS];

type Op =
  | { k: 'rename'; id: string; label: string }
  | { k: 'shape'; id: string; shape: (typeof SHAPES)[number] }
  | { k: 'deleteNode'; id: string }
  | { k: 'addNode'; label: string; id?: string }
  | { k: 'addEdge'; from: string; to: string; token: string; label: string }
  | { k: 'deleteEdge'; index: number }
  | { k: 'edgeLabel'; index: number; label: string }
  | { k: 'edgeToken'; index: number; token: string }
  | { k: 'direction'; dir: 'TD' | 'LR' | 'BT' | 'RL' }
  | { k: 'style'; id: string };

function randomOp(rand: () => number, m: FlowchartModel): Op {
  const nodes = [...m.nodesById.keys()];
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length) % arr.length];
  switch (Math.floor(rand() * 10)) {
    case 0:
    case 1:
      return nodes.length ? { k: 'rename', id: pick(nodes), label: pick(LABELS) } : { k: 'addNode', label: pick(LABELS) };
    case 2:
      return nodes.length ? { k: 'shape', id: pick(nodes), shape: pick(SHAPES) } : { k: 'addNode', label: pick(LABELS) };
    case 3:
      return nodes.length ? { k: 'deleteNode', id: pick(nodes) } : { k: 'addNode', label: pick(LABELS) };
    case 4:
      return { k: 'addNode', label: pick(LABELS) };
    case 5:
      return nodes.length >= 1
        ? { k: 'addEdge', from: pick(nodes), to: pick(nodes), token: pick(TOKENS), label: rand() > 0.5 ? pick(LABELS) : '' }
        : { k: 'addNode', label: pick(LABELS) };
    case 6:
      return m.edges.length ? { k: 'deleteEdge', index: Math.floor(rand() * m.edges.length) } : { k: 'addNode', label: pick(LABELS) };
    case 7:
      return m.edges.length
        ? rand() > 0.5
          ? { k: 'edgeLabel', index: Math.floor(rand() * m.edges.length), label: pick(LABELS) }
          : { k: 'edgeToken', index: Math.floor(rand() * m.edges.length), token: pick(TOKENS) }
        : { k: 'addNode', label: pick(LABELS) };
    case 8:
      return nodes.length ? { k: 'style', id: pick(nodes) } : { k: 'addNode', label: pick(LABELS) };
    default:
      return { k: 'direction', dir: pick(['TD', 'LR', 'BT', 'RL'] as const) };
  }
}

function applyOp(src: string, op: Op): string {
  const m = parseFlowchart(src).model;
  if (!m) return src;
  switch (op.k) {
    case 'rename':
      return renameNode(src, m, op.id, op.label);
    case 'shape':
      return changeShape(src, m, op.id, op.shape);
    case 'deleteNode':
      return deleteNode(src, m, op.id);
    case 'addNode':
      return addNode(src, m, op.label, 'rect', op.id);
    case 'addEdge':
      return addEdge(src, m, op.from, op.to, op.token, op.label);
    case 'deleteEdge':
      return deleteEdge(src, m, op.index);
    case 'edgeLabel':
      return changeEdgeLabel(src, m, op.index, op.label);
    case 'edgeToken':
      return changeEdgeToken(src, m, op.index, op.token);
    case 'direction':
      return setDirection(src, m, op.dir);
    case 'style':
      return setNodeStyle(src, m, op.id, { fill: '#f9f', stroke: '#333' });
  }
}

describe('fuzz: random operation sequences never break the model', () => {
  // `big.mmd` (60 nodes) is excluded: every operation re-parses the document,
  // so fuzzing it 1000x8 times dominates the suite runtime without covering
  // any syntax the smaller fixtures miss.
  const valid = fixtureNames().filter(
    (n) => n !== 'invalid.mmd' && n !== 'big.mmd',
  );

  it('400 random op sequences keep the text parseable', () => {
    const failures: string[] = [];
    for (let seed = 0; seed < 400; seed++) {
      const rand = rng(seed);
      let src = readFixture(valid[seed % valid.length]);
      for (let step = 0; step < 6; step++) {
        const m = parseFlowchart(src).model;
        if (!m) break;
        src = applyOp(src, randomOp(rand, m));
        const after = parseFlowchart(src);
        if (!after.model) {
          failures.push(`seed=${seed} step=${step} produced unparseable text:\n${src}`);
          break;
        }
        if (src.length === 0) {
          failures.push(`seed=${seed} step=${step} produced empty text`);
          break;
        }
      }
    }
    expect(failures.slice(0, 3)).toEqual([]);
  });

  it('applying an op never loses comment lines', () => {
    for (let seed = 0; seed < 100; seed++) {
      const rand = rng(seed + 9999);
      let src = readFixture('comments.mmd');
      const comments = src.split('\n').filter((l) => l.trim().startsWith('%%'));
      for (let step = 0; step < 6; step++) {
        const m = parseFlowchart(src).model;
        if (!m) break;
        const op = randomOp(rand, m);
        src = applyOp(src, op);
        for (const c of comments) {
          if (!src.includes(c)) {
            throw new Error(`seed=${seed} op=${op.k} dropped comment: ${c}\n---\n${src}`);
          }
        }
      }
    }
  });
});