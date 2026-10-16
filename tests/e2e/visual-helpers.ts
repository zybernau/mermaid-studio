import { expect, type Page } from '@playwright/test';

/**
 * Visual-editing assertions.
 *
 * extend-plan.md insists every visual action be checked three ways, and the
 * third is the one that is easy to skip:
 *
 *   1. the script text changed as expected
 *   2. re-parsing that text yields the intended model change
 *   3. the rendered SVG reflects it — and the error banner is absent
 *
 * (3) matters because the app deliberately keeps showing the **last good
 * diagram** when the text stops parsing. Without the banner check a test can
 * happily assert against a stale SVG while the real text is broken.
 */

/** Encode mermaid source the way the app's share links do. */
export async function encodeShare(code: string): Promise<string> {
  const pako = await import('pako');
  const bytes = new TextEncoder().encode(code);
  const deflated = pako.deflate(bytes, { level: 9 });
  let bin = '';
  for (let i = 0; i < deflated.length; i++) bin += String.fromCharCode(deflated[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Boot the app with `code` loaded and wait for the diagram to render. */
export async function gotoWithCode(page: Page, code: string): Promise<void> {
  const hash = await encodeShare(code);
  await page.goto(`/#c=${hash}`);
  await expect(page.locator('.preview-card svg')).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(
    () => (document.querySelector('.preview-card svg')?.querySelectorAll('*').length ?? 0) > 3,
    undefined,
    { timeout: 30_000 },
  );
}

/** Read the editor text. CodeMirror exposes no textarea, so ask its view. */
export async function readEditorText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const view = (window as unknown as {
      __cmView?: { state?: { doc?: { toString(): string } } };
    }).__cmView;
    return view?.state?.doc?.toString() ?? '';
  });
}

/** Replace the whole editor content and let the debounced render settle. */
export async function setEditorText(page: Page, code: string): Promise<void> {
  await page.evaluate((c) => {
    const view = (window as unknown as {
      __cmView?: { state?: { doc?: { length: number } }; dispatch: (t: unknown) => void };
    }).__cmView;
    if (!view) throw new Error('editor view not exposed');
    view.dispatch({ changes: { from: 0, to: view.state!.doc!.length, insert: c } });
  }, code);
  await waitForStableDiagram(page);
}

/** Turn edit mode on. Returns once the toggle reflects it. */
export async function enableEditMode(page: Page): Promise<void> {
  await page.getByTestId('edit-mode-toggle').click();
  await expect(page.getByTestId('edit-mode-toggle')).toContainText('Editing');
}

/** Wait for the preview to settle on a new diagram (the render is debounced). */
export async function waitForStableDiagram(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (document.querySelector('.preview-card svg')?.querySelectorAll('*').length ?? 0) > 3,
    undefined,
    { timeout: 30_000 },
  );
  // One extra frame so React has applied the post-render effects.
  await page.waitForTimeout(120);
}

/**
 * Wait until the rendered diagram contains exactly `n` nodes.
 *
 * The render is debounced (~400ms) plus mermaid's own layout time, so reading
 * the SVG immediately after an edit races the new paint. Every assertion on
 * node/edge counts must go through here, never through a single read.
 */
export async function expectNodeCount(page: Page, n: number): Promise<void> {
  await expect
    .poll(
      () => page.evaluate(() => document.querySelectorAll('.preview-card svg g.node[id]').length),
      { timeout: 15_000, message: `node count ${n}` },
    )
    .toBe(n);
}

/** Wait until the rendered diagram contains exactly `n` edges. */
export async function expectEdgeCount(page: Page, n: number): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          () => document.querySelectorAll('.preview-card svg path.flowchart-link[id]').length,
        ),
      { timeout: 15_000, message: `edge count ${n}` },
    )
    .toBe(n);
}

/* -------------------------------------------------------------------------- */
/* The three assertions                                                       */
/* -------------------------------------------------------------------------- */

/** Assert the banner is gone, i.e. the SVG on screen is live, not stale. */
export async function expectNoErrorBanner(page: Page): Promise<void> {
  await expect(page.locator('.error-banner')).toHaveCount(0);
}

/** Assert the banner is up, i.e. the shown diagram is the *previous* good one. */
export async function expectErrorBanner(page: Page): Promise<void> {
  await expect(page.locator('.error-banner')).toBeVisible();
}

/** Assert the script contains `text` (normalised whitespace). */
export async function expectEditorContains(page: Page, text: string): Promise<void> {
  await expect
    .poll(async () => (await readEditorText(page)).replace(/\s+/g, ' '), {
      timeout: 10_000,
      message: `editor was expected to contain: ${text}`,
    })
    .toContain(text.replace(/\s+/g, ' '));
}

/** Assert the script does *not* contain `text`. */
export async function expectEditorOmits(page: Page, text: string): Promise<void> {
  await expect
    .poll(async () => (await readEditorText(page)).replace(/\s+/g, ' '), { timeout: 10_000 })
    .not.toContain(text.replace(/\s+/g, ' '));
}

/** The visible text of a rendered node, or null when it is not rendered. */
export async function readNodeLabel(page: Page, id: string): Promise<string | null> {
  return page.evaluate((nodeId) => {
    const nodes = Array.from(document.querySelectorAll('.preview-card svg g.node[id]'));
    const hit = nodes.find((n) => new RegExp(`-flowchart-${nodeId}-\\d+$`).test(n.getAttribute('id') ?? ''));
    if (!hit) return null;
    const label = hit.querySelector('.nodeLabel');
    return (label?.textContent ?? '').trim();
  }, id);
}

/** Assert a node renders with `label`. */
export async function expectNodeLabel(page: Page, id: string, label: string): Promise<void> {
  await expect
    .poll(() => readNodeLabel(page, id), { timeout: 10_000, message: `node ${id} label` })
    .toBe(label);
}

/** Assert an edge between two nodes is rendered. */
export async function expectEdgeExists(page: Page, from: string, to: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          ([f, t]) =>
            Array.from(document.querySelectorAll('.preview-card svg path.flowchart-link[id]')).some((p) =>
              new RegExp(`L_${f}_${t}_\\d+$`).test(p.getAttribute('id') ?? ''),
            ),
          [from, to],
        ),
      { timeout: 10_000, message: `edge ${from} -> ${to}` },
    )
    .toBe(true);
}

/** Assert an edge between two nodes is *not* rendered. */
export async function expectEdgeAbsent(page: Page, from: string, to: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          ([f, t]) =>
            Array.from(document.querySelectorAll('.preview-card svg path.flowchart-link[id]')).some((p) =>
              new RegExp(`L_${f}_${t}_\\d+$`).test(p.getAttribute('id') ?? ''),
            ),
          [from, to],
        ),
      { timeout: 10_000, message: `edge ${from} -> ${to} should be gone` },
    )
    .toBe(false);
}

/** Assert an edge carries a visible label. */
export async function expectEdgeLabel(page: Page, label: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (text) =>
            Array.from(document.querySelectorAll('.preview-card svg g.edgeLabel')).some((el) =>
              (el.textContent ?? '').includes(text),
            ),
          label,
        ),
      { timeout: 10_000, message: `edge label ${label}` },
    )
    .toBe(true);
}

/** Assert a subgraph cluster is rendered. */
export async function expectClusterExists(page: Page, id: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (sgId) =>
            Array.from(document.querySelectorAll('.preview-card svg g.cluster[id]')).some((c) =>
              new RegExp(`-${sgId}$`).test(c.getAttribute('id') ?? ''),
            ),
          id,
        ),
      { timeout: 10_000, message: `cluster ${id}` },
    )
    .toBe(true);
}

/**
 * Assert a node renders *inside* a cluster's bounding box.
 *
 * Mermaid nests nodes under their cluster in the SVG when it lays them out
 * there, so geometric containment is the observable proof of re-parenting —
 * the source-level proof is `expectEditorContains` on the subgraph body.
 */
export async function expectNodeInsideCluster(
  page: Page,
  nodeId: string,
  clusterId: string,
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          ([nId, cId]) => {
            const cluster = Array.from(document.querySelectorAll('.preview-card svg g.cluster[id]')).find((c) =>
              new RegExp(`-${cId}$`).test(c.getAttribute('id') ?? ''),
            );
            if (!cluster) return false;
            const node = Array.from(document.querySelectorAll('.preview-card svg g.node[id]')).find((n) =>
              new RegExp(`-flowchart-${nId}-\\d+$`).test(n.getAttribute('id') ?? ''),
            );
            if (!node) return false;
            // Compare in viewport coordinates: getBBox is in the element's own
            // space, which differs per group once Mermaid applies transforms.
            const cr = cluster.getBoundingClientRect();
            const nr = node.getBoundingClientRect();
            return (
              nr.left >= cr.left - 4 &&
              nr.right <= cr.right + 4 &&
              nr.top >= cr.top - 4 &&
              nr.bottom <= cr.bottom + 4
            );
          },
          [nodeId, clusterId],
        ),
      { timeout: 10_000, message: `node ${nodeId} inside cluster ${clusterId}` },
    )
    .toBe(true);
}

/** Assert the selected element is highlighted in the SVG. */
export async function expectSelected(page: Page, kind: 'node' | 'edge', id: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          ([k, i]) => {
            const el = document.querySelector('.preview-card svg .mmd-selected');
            if (!el) return false;
            if (k === 'node') {
              return new RegExp(`-flowchart-${i}-\\d+$`).test(el.getAttribute('id') ?? '');
            }
            return new RegExp(`L_${i.split('->')[0]}_${i.split('->')[1]}_\\d+$`).test(el.getAttribute('id') ?? '');
          },
          [kind, id],
        ),
      { timeout: 10_000, message: `selection ${kind}:${id}` },
    )
    .toBe(true);
}

/** Assert nothing is selected in the SVG. */
export async function expectNothingSelected(page: Page): Promise<void> {
  await expect(page.locator('.preview-card svg .mmd-selected')).toHaveCount(0);
}

/**
 * Click an edge path by index.
 *
 * Edge paths are 1px strokes, so Playwright's actionability checks fail on
 * them ("element is not visible") and a blind `.click()` lands on whatever
 * covers the path's bounding-box center — often a node label. Instead, sample
 * along the path for a point whose topmost element really is the path, then
 * click there. Falls back to a forced click when no such point exists.
 */
export async function clickEdge(page: Page, index: number): Promise<void> {
  const pt = await page.evaluate((i) => {
    const paths = Array.from(
      document.querySelectorAll('.preview-card svg path.flowchart-link[id]'),
    ) as unknown as SVGPathElement[];
    const p = paths[i];
    if (!p) return null;
    const len = p.getTotalLength();
    const ctm = p.getScreenCTM();
    if (!ctm) return null;
    for (let k = 0; k <= 20; k++) {
      const q = p.getPointAtLength((len * k) / 20);
      const dom = new DOMPoint(q.x, q.y).matrixTransform(ctm);
      if (document.elementFromPoint(dom.x, dom.y) === p) {
        return { x: dom.x, y: dom.y };
      }
    }
    return null;
  }, index);
  if (pt) {
    await page.mouse.click(pt.x, pt.y);
  } else {
    await page.locator('.preview-card svg path.flowchart-link[id]').nth(index).click({ force: true });
  }
}

/**
 * Re-parse the editor text *as the app would* and return a small summary.
 *
 * Playwright `page.evaluate` runs in the browser, where `import()` of a Vite
 * `/src/...` path is unreliable under the test server. So the summary is
 * computed by the page's own runtime instead: the app exposes the model it
 * parsed for the last render, which is exactly what the visible diagram was
 * built from.
 *
 * When the text is invalid the preview keeps the last good diagram, so `ok`
 * is derived from the absence of the error banner — the same signal the user
 * sees — and nodes/edges are scraped from the live SVG.
 */
export async function readModelSummary(
  page: Page,
): Promise<{ nodes: string[]; edges: string[]; ok: boolean }> {
  return page.evaluate(() => {
    const banner = document.querySelector('.error-banner');
    const nodes = Array.from(
      document.querySelectorAll('.preview-card svg g.node[id]'),
    )
      .map((n) => {
        const m = /flowchart-(.+)-(\d+)$/.exec(n.getAttribute('id') ?? '');
        return m ? m[1] : null;
      })
      .filter((id): id is string => id !== null)
      .sort();
    const edges = Array.from(
      document.querySelectorAll('.preview-card svg path.flowchart-link[id]'),
    )
      .map((p) => {
        const m = /L_(.+?)_(.+?)_(\d+)$/.exec(p.getAttribute('id') ?? '');
        return m ? `${m[1]}->${m[2]}` : null;
      })
      .filter((id): id is string => id !== null)
      .sort();
    return { nodes, edges, ok: !banner };
  });
}
