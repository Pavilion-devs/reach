import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('complete flow with mouse, receipts, and no browser errors', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/'); await expect(page.getByRole('heading', { name: 'A little more about your work' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/reach-home.png', fullPage: true });
  await page.getByRole('button', { name: 'Prepare a reply' }).click(); await page.getByRole('button', { name: 'Selected work · 2026.pdf' }).click(); await page.locator('.choice').first().click();
  await expect(page.getByRole('heading', { name: 'Does this sound like you?' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/reach-review.png', fullPage: true });
  await page.getByRole('button', { name: 'Create draft + private hold' }).click(); await expect(page.getByRole('heading', { name: 'Your reply is ready.' })).toBeVisible(); await expect(page.locator('.receipt')).toHaveCount(3); expect(errors).toEqual([]);
});
test('single-switch path completes without mouse or another key', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('.choice').first()).toBeVisible();
  await page.keyboard.press('Space'); await expect(page.locator('.scanned')).toContainText('Prepare a reply');
  for (const expected of ['Which work feels right?', 'Make a little room.', 'Does this sound like you?']) { await page.waitForTimeout(300); await page.keyboard.press('Space'); await expect(page.getByRole('heading', { name: expected })).toBeVisible(); }
  // The first reviewed choice is Change, not approval. Scan once to the explicit approval.
  await expect(page.locator('.scanned')).toContainText('Create draft + private hold', { timeout: 5000 });
  await page.keyboard.press('Space'); await expect(page.getByRole('heading', { name: 'Your reply is ready.' })).toBeVisible();
});
test('controls, pause and escape remain reachable by the switch', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('.choice').first()).toBeVisible();
  await page.clock.install(); await page.keyboard.press('Space');
  await page.clock.runFor(4 * 2500); await expect(page.locator('.scanned')).toContainText('Adjust my controls'); await page.keyboard.press('Space');
  await expect(page.getByRole('heading', { name: 'At your pace.' })).toBeVisible();
  await page.clock.runFor(2500); await page.keyboard.press('Space'); await expect(page.getByRole('button', { name: /Scan more slowly · now 4s/ })).toBeVisible();
  await page.clock.runFor(3 * 4000); await expect(page.locator('.scanned')).toContainText('Pause scanning'); await page.keyboard.press('Space'); await expect(page.locator('.scanned')).toHaveCount(0);
  await page.clock.runFor(500); await page.keyboard.press('Space'); await expect(page.locator('.scanned')).toContainText('Back to my task');
});
test('context change is visible and prevents a success screen', async ({ page }) => {
  await page.goto('/?scenario=calendar-changed'); await page.getByRole('button', { name: 'Prepare a reply' }).click(); await page.getByRole('button', { name: 'Selected work · 2026.pdf' }).click(); await page.locator('.choice').first().click(); await page.getByRole('button', { name: 'Create draft + private hold' }).click(); await expect(page.getByRole('heading', { name: 'Let’s check that again.' })).toBeVisible();
});
test('automated accessibility checks on home, review and controls', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('.choice').first()).toBeVisible();
  async function check() { const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze(); expect(result.violations).toEqual([]); }
  await check(); await page.getByRole('button', { name: 'Prepare a reply' }).click(); await page.getByRole('button', { name: 'Selected work · 2026.pdf' }).click(); await page.locator('.choice').first().click(); await check(); await page.getByRole('button', { name: 'Controls', exact: true }).click(); await check();
});
test('mobile viewport has no horizontal overflow and readable task', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/'); await expect(page.locator('.choice').first()).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: 'artifacts/reach-mobile.png', fullPage: true });
});
