import { expect, test } from '@playwright/test';
import { gotoWithCode } from './helpers';

/**
 * Step 2 guard: Mermaid's SVG id conventions are the single biggest risk in
 * this project (see extend-plan.md "Biggest risks").
 *
 * Verified against the pinned mermaid 11.17.2:
 *   node  `<prefix>flowchart-A-0`   (g.node)
 *   edge  `<prefix>L_A_B_0`          (path.flowchart-link)  <- underscores
 *   cluster `<prefix>-one`           (g.cluster)
 *
 * Note the edge id uses underscores, NOT dashes — `L_A_B_0`, not `L-A-B-0`.
 * A dependency bump that changes any of these must fail this test loudly so
 * src/lib/flowchart/svg-map.ts gets updated rather than silently breaking
 * every visual edit.
 */
const CODE = `flowchart TD
    A[Start] --> B[Process]
    B -->|go| C[End]
    A --> C
`;

test.describe('mermaid SVG id conventions', () => {
  test('node ids are <prefix>flowchart-<id>-<n>', async ({ page }) => {
    await gotoWithCode(page, CODE);

    const nodeIds = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.preview-card svg g.node[id]')).map(
        (n) => (n as SVGElement).getAttribute('id') ?? '',
      ),
    );

    expect(nodeIds.length).toBe(3);
    for (const nodeId of ['A', 'B', 'C']) {
      expect(
        nodeIds.some((id) => new RegExp(`^.+-flowchart-${nodeId}-\\d+$`).test(id)),
        `expected a node id for ${nodeId}, got ${JSON.stringify(nodeIds)}`,
      ).toBe(true);
    }
  });

  test('edge ids are <prefix>L_<from>_<to>_<n> with underscores', async ({ page }) => {
    await gotoWithCode(page, CODE);

    const edgeIds = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.preview-card svg path.flowchart-link[id]')).map(
        (n) => (n as SVGElement).getAttribute('id') ?? '',
      ),
    );

    expect(edgeIds.length).toBe(3);
    for (const [from, to] of [
      ['A', 'B'],
      ['B', 'C'],
      ['A', 'C'],
    ]) {
      expect(
        edgeIds.some((id) => new RegExp(`^.+L_${from}_${to}_\\d+$`).test(id)),
        `expected edge id L_${from}_${to}_n, got ${JSON.stringify(edgeIds)}`,
      ).toBe(true);
    }
  });

  test('subgraph clusters use <prefix>-<id> and carry the title', async ({ page }) => {
    await gotoWithCode(
      page,
      `flowchart TD\n    subgraph one [Frontend]\n        A --> B\n    end\n    B --> C\n`,
    );
    const clusters = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.preview-card svg g.cluster[id]')).map((n) => ({
        id: (n as SVGElement).getAttribute('id') ?? '',
        title: n.querySelector('.cluster-label')?.textContent?.trim() ?? '',
      })),
    );
    expect(clusters.length).toBe(1);
    expect(clusters[0].id).toMatch(/^.+-one$/);
    expect(clusters[0].title).toBe('Frontend');
  });

  test('every model item has a clickable SVG element', async ({ page }) => {
    await gotoWithCode(
      page,
      `flowchart TD\n    A[Start] --> B[Middle]\n    B --> C[End]\n    C --> A\n`,
    );
    const counts = await page.evaluate(() => ({
      nodes: document.querySelectorAll('.preview-card svg g.node[id]').length,
      edges: document.querySelectorAll('.preview-card svg path.flowchart-link[id]').length,
    }));
    expect(counts.nodes).toBe(3);
    expect(counts.edges).toBe(3);
  });
});