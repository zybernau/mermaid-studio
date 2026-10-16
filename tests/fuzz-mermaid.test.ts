import { describe, expect, it } from 'vitest';
import mermaid from 'mermaid';
import { readFixture } from './fixtures';
import { parseFlowchart } from '../src/lib/flowchart/parser';
import {
  addEdge,
  addNode,
  changeEdgeLabel,
  changeEdgeToken,
  changeShape,
  deleteEdge,
  deleteNode,
  renameNode,
  setNodeStyle,
} from '../src/lib/flowchart/patch';

/**
 * Step 4 release gate: "Fuzz run produces zero invalid Mermaid".
 *
 * tests/fuzz.test.ts only re-parses with our own parser, which cannot catch a
 * patch that emits text Mermaid itself rejects (it caught the `\"` quoting bug,
 * the `A |label| --> B` placement bug and the `A[]` empty-label bug). This
 * fuzz asserts the stronger property against real `mermaid.parse`.
 *
 * The PRNG is a fixed seed, so a failure is reproducible from the printed
 * seed/step, and the budget is small because mermaid.parse is ~10x our parser.
 */

// mulberry32: deterministic, no dependency.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
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
  'yes|no',
  '@home',
  'a & b',
  'a;b',
  'a#b',
  'a[b]',
  'a{b}',
  'plain',
  '',
];

const SHAPES = ['rect', 'round', 'diamond', 'circle', 'stadium', 'hexagon'] as const;
const TOKENS = ['-->', '---', '-.->', '==>', '==='];

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });

const FIXTURES = [
  'simple.mmd',
  'chains.mmd',
  'groups.mmd',
  'comments.mmd',
  'inline-labels.mmd',
  'styled.mmd',
  'shapes.mmd',
  'directions.mmd',
  'cycle.mmd',
  'subgraphs.mmd',
  'odd-spacing.mmd',
];

type Op = 'rename' | 'shape' | 'deleteNode' | 'addNode' | 'addEdge' | 'deleteEdge' | 'edgeLabel' | 'edgeToken' | 'style';
const OPS: Op[] = [
  'rename', 'rename', 'shape', 'deleteNode', 'addNode', 'addEdge',
  'deleteEdge', 'edgeLabel', 'edgeToken', 'style',
];

describe('fuzz: patch output is valid mermaid', () => {
  it('300 random op sequences all parse in mermaid', async () => {
    const failures: string[] = [];

    for (let seed = 0; seed < 300; seed++) {
      const rand = rng(seed);
      const fixture = FIXTURES[seed % FIXTURES.length];
      let src = readFixture(fixture);

      for (let step = 0; step < 5; step++) {
        const m = parseFlowchart(src).model;
        if (!m) break;
        const nodes = [...m.nodesById.keys()];
        const pick = <T,>(arr: readonly T[]): T =>
          arr[Math.floor(rand() * arr.length) % arr.length];
        const label = () => pick(LABELS);
        const anyNode = () => (nodes.length ? pick(nodes) : 'A');

        let next = src;
        const op = pick(OPS);
        switch (op) {
          case 'rename':     next = renameNode(src, m, anyNode(), label()); break;
          case 'shape':      next = changeShape(src, m, anyNode(), pick(SHAPES)); break;
          case 'deleteNode': next = deleteNode(src, m, anyNode()); break;
          case 'addNode':    next = addNode(src, m, label()); break;
          case 'addEdge':    next = addEdge(src, m, anyNode(), anyNode(), pick(TOKENS), label()); break;
          case 'deleteEdge': next = deleteEdge(src, m, Math.floor(rand() * Math.max(1, m.edges.length))); break;
          case 'edgeLabel':  next = changeEdgeLabel(src, m, Math.floor(rand() * Math.max(1, m.edges.length)), label()); break;
          case 'edgeToken':  next = changeEdgeToken(src, m, Math.floor(rand() * Math.max(1, m.edges.length)), pick(TOKENS)); break;
          case 'style':      next = setNodeStyle(src, m, anyNode(), { fill: '#f9f', stroke: '#333' }); break;
        }
        src = next;

        try {
          await mermaid.parse(src);
        } catch (err) {
          failures.push(
            `seed=${seed} step=${step} op=${op} fixture=${fixture}\n` +
            `--- source ---\n${src}\n--- error ---\n${String((err as Error).message).split('\n').slice(0, 3).join('\n')}`,
          );
          break; // this seed is done; move on
        }
      }
    }

    if (failures.length) {
      console.log(`\n${failures.length} invalid mermaid output(s):\n\n${failures.slice(0, 5).join('\n\n')}\n`);
    }
    expect(failures).toEqual([]);
  }, 300_000);
});
