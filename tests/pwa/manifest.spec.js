import { test, expect } from '@playwright/test';

test('web app manifest is served with installable settings', async ({ page, request }) => {
  const res = await request.get('/manifest.webmanifest');
  expect(res.status()).toBe(200);

  const manifest = await res.json();
  expect(manifest.display).toBe('standalone');
  expect(manifest.name).toContain('Gênesis');
  expect(manifest.icons.length).toBeGreaterThanOrEqual(2);

  for (const icon of manifest.icons) {
    const iconRes = await request.get(icon.src);
    expect(iconRes.status()).toBe(200);
  }
});

test('service worker registers and becomes active', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  const registration = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return null;
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? { scope: reg.scope, active: !!reg.active } : null;
  });

  expect(registration).not.toBeNull();
  expect(registration.active).toBe(true);
});
