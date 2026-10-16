import { expect, type Page } from '@playwright/test';

/**
 * Encode mermaid source the same way the app's share links do (pako deflate +
 * url-safe base64) so a test can boot the app with an exact diagram.
 *
 * We load code through the `#c=` hash rather than typing into CodeMirror,
 * because CodeMirror exposes no <textarea> to drive and its API is awkward to
 * reach from a test.
 */
export async function encodeShare(code: string): Promise<string> {
  const pako = await import('pako');
  const bytes = new TextEncoder().encode(code);
  const deflated = pako.deflate(bytes, { level: 9 });
  let bin = '';
  for (let i = 0; i < deflated.length; i++) bin += String.fromCharCode(deflated[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Navigate to the app with `code` loaded and wait for the diagram to render. */
export async function gotoWithCode(page: Page, code: string): Promise<void> {
  const hash = await encodeShare(code);
  await page.goto(`/#c=${hash}`);
  await expect(page.locator('.preview-card svg')).toBeVisible({ timeout: 30_000 });
  // The render is debounced; wait until the SVG actually contains content.
  await page.waitForFunction(
    () => (document.querySelector('.preview-card svg')?.querySelectorAll('*').length ?? 0) > 3,
    undefined,
    { timeout: 30_000 },
  );
}

/** Read the current editor text (CodeMirror keeps it in a hidden textarea). */
export async function readEditorText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const cm = document.querySelector('.cm-content');
    if (!cm) return '';
    // `.cm-content` only holds the visible viewport; ask CodeMirror directly.
    const view = (window as any).__cmView;
    if (view && typeof view.state?.doc?.toString === 'function') {
      return view.state.doc.toString();
    }
    return cm.textContent ?? '';
  });
}

/** Replace the whole editor content and let the debounced render settle. */
export async function setEditorText(page: Page, code: string): Promise<void> {
  await page.evaluate((c) => {
    const view = (window as any).__cmView;
    if (!view) throw new Error('editor view not exposed');
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: c },
    });
  }, code);
  await page.waitForTimeout(900);
}