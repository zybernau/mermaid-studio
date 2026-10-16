// The parser's model only earns its keep if Mermaid agrees with it. These
// tests hand every fixture to the real Mermaid parser, so a fixture the
// editor believes is valid cannot silently be something Mermaid rejects.
//
// Mermaid ships as ESM and needs a DOM; see vitest.config.ts.
import { beforeAll, describe, expect, it } from 'vitest';
import mermaid from 'mermaid';
import { fixtureNames, readFixture } from './fixtures';
import { parseFlowchart } from '../src/lib/flowchart/parser';
import { ARROW_TOKENS } from '../src/lib/flowchart/patch';

beforeAll(() => {
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
});

describe('mermaid agrees with the parser', () => {
  it('never invents nodes from a trailing %% comment', () => {
    // Mermaid rejects a trailing comment outright ("Expecting SEMI, NEWLINE,
    // EOF ... got NODE_STRING"), so the fixture set must not use one. The
    // parser is still expected to handle it sanely rather than model the
    // comment words as nodes: inventing nodes is what once made deleteNode
    // loop without bound.
    const src = 'flowchart TD\n    A[Start] --> B[Middle] %% trailing comment\n';
    const m = parseFlowchart(src).model!;
    expect([...m.nodesById.keys()].sort()).toEqual(['A', 'B']);
    expect(m.edges.map((e) => `${e.from}->${e.to}`)).toEqual(['A->B']);
  });

  it('does not treat %% inside a quoted label as a comment', () => {
    const src = 'flowchart TD\n    A["100%% sure"] --> B\n';
    const m = parseFlowchart(src).model!;
    expect([...m.nodesById.keys()].sort()).toEqual(['A', 'B']);
    // The label is kept verbatim; Mermaid does its own unescaping.
    expect(m.nodesById.get('A')![0].label).toBe('100%% sure');
  });

  it.each(fixtureNames().filter((n) => n !== 'invalid.mmd'))(
    'parses %s in mermaid',
    async (name) => {
      await expect(mermaid.parse(readFixture(name))).resolves.toBeTruthy();
    },
  );
});

describe('arrow tokens the editor offers are ones Mermaid accepts', () => {
  it.each(ARROW_TOKENS)('accepts %s', async (token) => {
    await expect(mermaid.parse(`flowchart TD\n    A ${token} B\n`)).resolves.toBeTruthy();
  });

  // These look like links but are not, and are deliberately absent from
  // ARROW_TOKENS. If one ever starts parsing, the list should grow.
  it.each(['--', '==', '<--', '-.--', '->'])('rejects %s', async (token) => {
    await expect(
      mermaid.parse(`flowchart TD\n    A ${token} B\n`),
    ).rejects.toBeTruthy();
  });
});
