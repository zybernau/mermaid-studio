import { expect, test } from '@playwright/test';
import { gotoWithCode } from './helpers';

/**
 * Step 4 guard: the patch engine writes HTML entities into labels because
 * Mermaid's lexer rejects the obvious escapes.
 *
 *  - `A["a \"b\" c"]` is a parse error: `\"` is only tolerated as the closing
 *    quote, so `A["He said \"hi\""]` works but `A["a \"b\" c"]` does not.
 *  - `(`, `)`, `{`, `}`, `@` and `|` are rejected in a bare edge label even
 *    though they look like plain text.
 *
 * Two invariants, both only checkable against a real render:
 *
 *  1. Mermaid must decode the entities back to the real characters, so a
 *     dependency bump that changes entity handling fails here rather than
 *     silently showing `&quot;` on screen.
 *  2. The entities must be **named**, not numeric. Mermaid 11.17.2 mangles
 *     numeric ones: `&#40;` is emitted as a bare `&` with the `;` dropped, so
 *     `a&#40;b` renders as `a&b`. edgeLabelText therefore only emits names.
 */
const CODE = `flowchart TD
    A["Hello (world) &quot;x&quot;"] --> B["a &amp; b"]
    B -->|paren &lpar;ok&rpar;| C[End]
    C -->|pipe &vert; and &commat;sign| D[End2]
`;

test.describe('mermaid renders HTML entities in labels', () => {
  test('decodes named entities into real characters', async ({ page }) => {
    await gotoWithCode(page, CODE);

    const text = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.preview-card svg'))
        .map((svg) => svg.textContent ?? '')
        .join(' '),
    );

    // Quotes, ampersands, parens, pipes and @ come back decoded.
    expect(text).toContain('Hello (world) "x"');
    expect(text).toContain('a & b');
    expect(text).toContain('paren (ok)');
    expect(text).toContain('pipe | and @sign');
    // No entity text leaks through as literal glyphs.
    expect(text).not.toContain('&quot;');
    expect(text).not.toContain('&lpar;');
    expect(text).not.toContain('&vert;');
  });

  // Numeric entities parse, so the lexer is happy, but the glyphs are wrong.
  // This is the failure mode edgeLabelText exists to avoid; pin it so a future
  // "simplification" back to `&#40;` is caught here.
  test('numeric entities are parsed but rendered wrong', async ({ page }) => {
    await gotoWithCode(page, 'flowchart TD\n    A -->|paren &#40;ok&#41;| B\n');

    const text = await page.evaluate(() =>
      document.querySelector('.preview-card svg')?.textContent ?? '',
    );

    // The `;` is lost and the `&` survives: `(` becomes `&`.
    expect(text).toContain('paren &(ok&)');
    expect(text).not.toContain('paren (ok)');
  });
});
