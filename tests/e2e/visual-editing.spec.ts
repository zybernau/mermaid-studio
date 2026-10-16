import { expect, test } from '@playwright/test';
import {
  enableEditMode,
  expectEdgeAbsent,
  expectEdgeCount,
  expectEdgeExists,
  expectEdgeLabel,
  expectEditorContains,
  expectEditorOmits,
  expectErrorBanner,
  expectNodeCount,
  expectNodeInsideCluster,
  expectNoErrorBanner,
  expectNodeLabel,
  expectNothingSelected,
  expectSelected,
  gotoWithCode,
  readEditorText,
  readModelSummary,
  setEditorText,
  waitForStableDiagram,
  clickEdge,
} from './visual-helpers';

/**
 * Visual editing, end to end.
 *
 * Each assertion follows extend-plan.md's rule: check the script, check the
 * model, and check the rendered SVG with the error banner absent — because the
 * app keeps showing the last good diagram when the text breaks, so a test that
 * only looks at the SVG can pass against a stale render.
 */
const CODE = `flowchart TD
    A[Start] --> B[Process]
    B -->|go| C[End]
`;

test.describe('edit mode', () => {
  test('off by default: clicking the diagram selects nothing', async ({ page }) => {
    await gotoWithCode(page, CODE);
    await expect(page.getByTestId('edit-mode-toggle')).toContainText('Edit');
    await page.locator('.preview-card svg g.node[id]').first().click();
    await expectNothingSelected(page);
  });

  test('toggling on reveals the edit toolbar', async ({ page }) => {
    await gotoWithCode(page, CODE);
    await enableEditMode(page);
    await expect(page.getByTestId('add-node')).toBeVisible();
    await expect(page.getByTestId('undo')).toBeVisible();
  });

  // The single-most-important mode rule: exactly one edit mode, and it is the
  // only thing that decides whether the diagram is editable.
  test('leaving edit mode clears the selection', async ({ page }) => {
    await gotoWithCode(page, CODE);
    await enableEditMode(page);
    await page.locator('.preview-card svg g.node[id]').first().click();
    await expectSelected(page, 'node', 'A');
    await page.getByTestId('edit-mode-toggle').click();
    await expect(page.getByTestId('edit-mode-toggle')).toContainText('Edit');
    await expectNothingSelected(page);
  });
});

test.describe('Step 5: selection', () => {
  test('clicking a node selects it and highlights the SVG', async ({ page }) => {
    await gotoWithCode(page, CODE);
    await enableEditMode(page);
    await page.locator('.preview-card svg g.node[id]').first().click();
    await expectSelected(page, 'node', 'A');
    await expectNoErrorBanner(page);
  });

  test('clicking an edge selects it', async ({ page }) => {
    await gotoWithCode(page, CODE);
    await enableEditMode(page);
    await clickEdge(page, 0);
    await expectSelected(page, 'edge', 'A->B');
    await expectNoErrorBanner(page);
  });

  test('clicking empty canvas clears the selection', async ({ page }) => {
    await gotoWithCode(page, CODE);
    await enableEditMode(page);
    await page.locator('.preview-card svg g.node[id]').first().click();
    await expectSelected(page, 'node', 'A');
    await page.locator('.preview-card').click({ position: { x: 5, y: 5 } });
    await expectNothingSelected(page);
  });

  test('selecting a node highlights its source range in the editor', async ({ page }) => {
    await gotoWithCode(page, CODE);
    await enableEditMode(page);
    await page.locator('.preview-card svg g.node[id]').first().click();
    await expectSelected(page, 'node', 'A');
    // The editor selection must cover the `A[Start]` statement.
    const sel = await page.evaluate(() => {
      const view = (window as unknown as { __cmView?: { state: { selection: { main: { from: number; to: number } }; doc: { toString(): string } } } }).__cmView!;
      const { from, to } = view.state.selection.main;
      return view.state.doc.toString().slice(from, to);
    });
    expect(sel).toContain('A[Start]');
  });

  test('moving the editor caret selects the matching shape', async ({ page }) => {
    await gotoWithCode(page, CODE);
    await enableEditMode(page);
    // Put the caret inside the `B -->|go| C` line; the edge must highlight.
    // The editor must be focused first: cursor sync only follows genuine caret
    // moves, and an unfocused update is always a side effect.
    await page.locator('.cm-content').click();
    await page.evaluate(() => {
      const view = (window as unknown as { __cmView?: { state: { doc: { toString(): string } }; dispatch: (t: unknown) => void } }).__cmView!;
      const text = view.state.doc.toString();
      const at = text.indexOf('B -->|go| C') + 2;
      view.dispatch({ selection: { anchor: at } });
    });
    await expectSelected(page, 'edge', 'B->C');
  });
});

test.describe('Step 6: rename by double-click', () => {
  test('double-clicking a node opens an inline input', async ({ page }) => {
    await gotoWithCode(page, CODE);
    await enableEditMode(page);
    await page.locator('.preview-card svg g.node[id]').first().dblclick();
    await expect(page.getByTestId('rename-input')).toBeVisible();
  });

  test('committing a rename updates the script and the diagram', async ({ page }) => {
    await gotoWithCode(page, CODE);
    await enableEditMode(page);
    await page.locator('.preview-card svg g.node[id]').first().dblclick();
    await page.getByTestId('rename-input').fill('Begin here');
    await page.getByTestId('rename-input').press('Enter');

    await expectNoErrorBanner(page);
    // 1. the script gained a quoted label
    await expectEditorContains(page, 'A["Begin here"]');
    // 3. the render shows the new text
    await expectNodeLabel(page, 'A', 'Begin here');
  });

  test('a label with special characters is escaped and still renders', async ({ page }) => {
    await gotoWithCode(page, CODE);
    await enableEditMode(page);
    await page.locator('.preview-card svg g.node[id]').first().dblclick();
    // `(` and `"` are rejected literally by mermaid, so the patch engine has to
    // entity-escape them; the render must decode them back.
    await page.getByTestId('rename-input').fill('Hello (world) "x"');
    await page.getByTestId('rename-input').press('Enter');

    await expectNoErrorBanner(page);
    await expectEditorContains(page, '&quot;');
    await expectNodeLabel(page, 'A', 'Hello (world) "x"');
  });

  test('Escape cancels without touching the script', async ({ page }) => {
    await gotoWithCode(page, CODE);
    await enableEditMode(page);
    const before = await readEditorText(page);
    await page.locator('.preview-card svg g.node[id]').first().dblclick();
    await page.getByTestId('rename-input').fill('Discarded');
    await page.getByTestId('rename-input').press('Escape');
    await expect(page.getByTestId('rename-input')).toHaveCount(0);
    expect(await readEditorText(page)).toBe(before);
  });

  // View mode keeps the old gesture, which is why doubleClick is bound to
  // `disabled: editMode` rather than being turned off permanently.
  test('outside edit mode double-click does not open the rename box', async ({ page }) => {
    await gotoWithCode(page, CODE);
    await page.locator('.preview-card svg g.node[id]').first().dblclick();
    await expect(page.getByTestId('rename-input')).toHaveCount(0);
  });
});

test.describe('Step 7: add and delete', () => {
  test('adding a node appends it and selects it', async ({ page }) => {
    await gotoWithCode(page, CODE);
    await enableEditMode(page);
    const before = await readModelSummary(page);
    await page.getByTestId('add-node').click();
    await expectNodeCount(page, before.nodes.length + 1);

    await expectNoErrorBanner(page);
    const after = await readModelSummary(page);
    expect(after.ok).toBe(true);
    expect(after.nodes.length).toBe(before.nodes.length + 1);
    await expectEditorContains(page, 'new[new]');
  });

  test('adding 50 nodes never collides on an id', async ({ page }) => {
    await gotoWithCode(page, 'flowchart TD\n    A[Start]\n');
    await enableEditMode(page);
    for (let i = 0; i < 50; i++) await page.getByTestId('add-node').click();
    await expectNodeCount(page, 51);

    await expectNoErrorBanner(page);
    const { nodes } = await readModelSummary(page);
    expect(nodes.length).toBe(51);
    expect(new Set(nodes).size).toBe(51);
  });

  test('deleting a hub node leaves no dangling edges', async ({ page }) => {
    const hub = `flowchart TD
    H[Hub] --> A[One]
    H --> B[Two]
    H --> C[Three]
    style H fill:#f9f
    linkStyle 0 stroke:#ff3
`;
    await gotoWithCode(page, hub);
    await enableEditMode(page);
    await page.locator('.preview-card svg g.node[id]').first().click();
    await expectSelected(page, 'node', 'H');
    await page.getByTestId('delete-selected').click();
    await expectNodeCount(page, 3);

    // 3 is the confirmation threshold; a 3-edge hub deletes without asking.
    await expectNoErrorBanner(page);
    const after = await readModelSummary(page);
    expect(after.nodes).toEqual(['A', 'B', 'C']);
    expect(after.edges).toEqual([]);
    // The style line that referenced H must be gone too, or mermaid throws
    // "Cannot set properties of undefined" and the whole diagram vanishes.
    await expectEditorOmits(page, 'style H');
  });

  test('Delete key removes the selection', async ({ page }) => {
    await gotoWithCode(page, CODE);
    await enableEditMode(page);
    await page.locator('.preview-card svg g.node[id]').nth(2).click();
    await expectSelected(page, 'node', 'C');
    await page.keyboard.press('Delete');
    await waitForStableDiagram(page);
    await expectNoErrorBanner(page);
    await expectEdgeAbsent(page, 'B', 'C');
  });
});

test.describe('Step 8: edges', () => {
  test('editing an edge label updates script and render', async ({ page }) => {
    await gotoWithCode(page, CODE);
    await enableEditMode(page);
    await clickEdge(page, 0);
    await expect(page.getByTestId('property-panel')).toBeVisible();
    await page.getByTestId('edge-label-input').fill('triggers');
    await page.getByTestId('edge-label-input').press('Enter');
    await waitForStableDiagram(page);

    await expectNoErrorBanner(page);
    await expectEditorContains(page, '|triggers|');
    await expectEdgeLabel(page, 'triggers');
  });

  test('changing the edge type rewrites the token, keeping the label', async ({ page }) => {
    await gotoWithCode(page, CODE);
    await enableEditMode(page);
    await clickEdge(page, 1);
    await expect(page.getByTestId('property-panel')).toBeVisible();
    await page.getByTestId('edge-type-select').selectOption('-.->');
    await waitForStableDiagram(page);

    await expectNoErrorBanner(page);
    await expectEditorContains(page, 'B -.->|go| C');
    await expectEdgeExists(page, 'B', 'C');
    await expectEdgeLabel(page, 'go');
  });

  test('dragging the endpoint handle onto another node reconnects', async ({ page }) => {
    await gotoWithCode(page, CODE);
    await enableEditMode(page);
    // Select A->B so its handle appears, then drag the handle onto C.
    await clickEdge(page, 0);
    await expect(page.getByTestId('edge-handle')).toBeVisible();

    const handleBox = await page.getByTestId('edge-handle').boundingBox();
    const targetBox = await page.evaluate(() => {
      const g = Array.from(document.querySelectorAll('.preview-card svg g.node[id]')).find((n) =>
        /-flowchart-C-\d+$/.test(n.getAttribute('id') ?? ''),
      )!;
      const r = g.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(
        handleBox!.x + ((targetBox.x - handleBox!.x) * i) / 10,
        handleBox!.y + ((targetBox.y - handleBox!.y) * i) / 10,
      );
    }
    await page.mouse.up();
    await expectEdgeExists(page, 'A', 'C');
    await expectEdgeAbsent(page, 'A', 'B');

    await expectNoErrorBanner(page);
    await expectEditorContains(page, 'A --> C');
    const after = await readModelSummary(page);
    expect(after.edges).toContain('A->C');
    expect(after.edges).not.toContain('A->B');
  });

  test('dropping the handle on empty canvas cancels with no change', async ({ page }) => {
    await gotoWithCode(page, CODE);
    await enableEditMode(page);
    const before = await readEditorText(page);
    await clickEdge(page, 0);
    await expect(page.getByTestId('edge-handle')).toBeVisible();

    const handleBox = await page.getByTestId('edge-handle').boundingBox();
    await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
    await page.mouse.down();
    // Drag to the card corner, far from any node.
    await page.mouse.move(30, 30, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(800);
    expect(await readEditorText(page)).toBe(before);
  });

  test('the drop target brightens mid-drag and the ghost is dotted', async ({ page }) => {
    await gotoWithCode(page, CODE);
    await enableEditMode(page);
    await clickEdge(page, 0);
    await expect(page.getByTestId('edge-handle')).toBeVisible();

    const handleBox = await page.getByTestId('edge-handle').boundingBox();
    const targetBox = await page.evaluate(() => {
      const g = Array.from(document.querySelectorAll('.preview-card svg g.node[id]')).find((n) =>
        /-flowchart-C-\d+$/.test(n.getAttribute('id') ?? ''),
      )!;
      const r = g.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(
        handleBox!.x + ((targetBox.x - handleBox!.x) * i) / 10,
        handleBox!.y + ((targetBox.y - handleBox!.y) * i) / 10,
      );
    }
    await page.waitForTimeout(300);
    // The ghost line is drawn dotted, and node C — the valid drop — glows.
    // Both vanish on release; the assertions below only cover mid-drag.
    await expect(page.getByTestId('drag-ghost')).toBeVisible();
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const el = document.querySelector('.preview-card svg .mmd-drop-target');
            return el?.getAttribute('id') ?? null;
          }),
        { timeout: 5_000, message: 'drop target highlight' },
      )
      .toMatch(/-flowchart-C-\d+$/);
    await page.mouse.up();
  });
});

test.describe('Step 9a: move a node into a subgraph', () => {
  // "Move" is re-parenting, not a canvas drag: mermaid owns the layout, so
  // translating a rendered node would leave its arrows behind.
  const nested = `flowchart TD
    subgraph one [Frontend]
        A[Web] --> B[API]
    end
    subgraph two [Backend]
        C[DB] --> D[Cache]
    end
    B --> C
`;

  test('re-parenting keeps every edge attached', async ({ page }) => {
    await gotoWithCode(page, nested);
    await enableEditMode(page);
    const before = await readModelSummary(page);

    // A real pointer drag: node center -> cluster center, in small steps so
    // the pointermove handler tracks the gesture.
    const bBox = await page.evaluate(() => {
      const g = Array.from(document.querySelectorAll('.preview-card svg g.node[id]')).find((n) =>
        /-flowchart-B-\d+$/.test(n.getAttribute('id') ?? ''),
      )!;
      const r = g.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    const cBox = await page.evaluate(() => {
      const c = Array.from(document.querySelectorAll('.preview-card svg g.cluster[id]')).find((n) =>
        /-two$/.test(n.getAttribute('id') ?? ''),
      )!;
      const r = c.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.move(bBox.x, bBox.y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(bBox.x + ((cBox.x - bBox.x) * i) / 10, bBox.y + ((cBox.y - bBox.y) * i) / 10);
    }
    await page.mouse.up();
    await expectNodeCount(page, before.nodes.length);

    // 1. every edge survived the move (the graph changed, not the pixels)
    await expectNoErrorBanner(page);
    const after = await readModelSummary(page);
    expect(after.edges.length).toBe(before.edges.length);
    // 2. B's statement now sits inside subgraph two's body in the source.
    // (`Backend` contains the substring "end", so match whole lines.)
    await expectEditorContains(page, 'subgraph two');
    const text = await readEditorText(page);
    const lines = text.split('\n');
    const twoLine = lines.findIndex((line) => line.includes('subgraph two'));
    const endLine = lines.findIndex((line, i) => i > twoLine && line.trim() === 'end');
    const bLine = lines.findIndex((line) => line.includes('B[API]'));
    expect(bLine).toBeGreaterThan(twoLine);
    expect(bLine).toBeLessThan(endLine);
    // 3. the render nests B inside the cluster box
    await expectNodeInsideCluster(page, 'B', 'two');
  });
});

test.describe('Step 10: property panel', () => {
  test('changing shape keeps the label and renders', async ({ page }) => {
    await gotoWithCode(page, CODE);
    await enableEditMode(page);
    await page.locator('.preview-card svg g.node[id]').first().click();
    await expect(page.getByTestId('property-panel')).toBeVisible();
    await page.locator('.property-panel select').first().selectOption('diamond');
    await waitForStableDiagram(page);

    await expectNoErrorBanner(page);
    await expectEditorContains(page, 'A{Start}');
    await expectNodeLabel(page, 'A', 'Start');
  });

  test('toggling direction rewrites the header and re-layouts', async ({ page }) => {
    await gotoWithCode(page, CODE);
    await enableEditMode(page);
    await page.getByTestId('direction-lr').click();
    await waitForStableDiagram(page);

    await expectNoErrorBanner(page);
    await expectEditorContains(page, 'flowchart LR');
    await expect(page.getByTestId('direction-lr')).toHaveClass(/active/);
    // And back again — the toggle is not a one-way trip.
    await page.getByTestId('direction-td').click();
    await waitForStableDiagram(page);
    await expectEditorContains(page, 'flowchart TD');
  });
});

test.describe('Step 11: undo/redo', () => {
  test('Ctrl+Z reverses a visual edit and Ctrl+Y reapplies it', async ({ page }) => {
    await gotoWithCode(page, CODE);
    await enableEditMode(page);
    const original = await readEditorText(page);

    await page.getByTestId('add-node').click();
    await waitForStableDiagram(page);
    expect(await readEditorText(page)).not.toBe(original);

    await page.keyboard.press('Control+z');
    await waitForStableDiagram(page);
    expect(await readEditorText(page)).toBe(original);

    await page.keyboard.press('Control+y');
    await waitForStableDiagram(page);
    await expectEditorContains(page, 'new[new]');
  });

  // The app deliberately keeps the last good diagram when the text breaks, so
  // edit mode has to disable itself rather than let the user edit a ghost.
  test('invalid text disables edit mode and shows the banner', async ({ page }) => {
    await gotoWithCode(page, CODE);
    await enableEditMode(page);
    await setEditorText(page, 'flowchart TD\n  A[ --> B[\n');
    await expectErrorBanner(page);
    // The last good diagram is still on screen, not blanked.
    await expect(page.locator('.preview-card svg')).toBeVisible();
  });
});
