// Mermaid.js ships as ESM and needs a DOM; see vitest.config.ts.
import { describe, expect, it } from 'vitest';
import mermaid from 'mermaid';

describe('mermaid in happy-dom', () => {
  it('rejects a DOM-less parse failure distinct from invalid input', async () => {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
    // Valid input: if the DOM were missing we would get the DOMPurify
    // "addHook is not a function" TypeError instead of a clean parse.
    await expect(mermaid.parse('flowchart TD\n A --> B')).resolves.toBeTruthy();
  });

  it('rejects invalid input', async () => {
    await expect(mermaid.parse('flowchart TD\n A[ --> B[')).rejects.toBeTruthy();
  });
});
