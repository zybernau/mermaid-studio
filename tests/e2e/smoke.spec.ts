import { expect, test } from '@playwright/test';

test('placeholder: dev server serves the app shell', async ({ page }) => {
  await page.goto('/');
  // The editor pane must exist before any mermaid interaction is testable.
  await expect(page.locator('.app')).toBeVisible();
});
